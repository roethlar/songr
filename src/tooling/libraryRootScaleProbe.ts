/**
 * Read-only live measurement for `.agents/plans/library-live-view.md` Slice 0 —
 * the plan's evidence gate before any of the live view is built. It writes
 * nothing anywhere and mutates nothing on the Core.
 *
 * Slice 0 asks four questions, and this command is the answer to all four:
 *
 *  (1) WHAT THE ALBUMS ROOT COSTS. The plan budgets the Artists root from a
 *      measurement that already exists (1,679 rows, 17 loads, well under a
 *      second) and budgets the Albums root from an expectation ("~40 loads,
 *      expect ~1 s") that nobody has run. A session model that reads both roots
 *      on connect is sized by the larger one, so the Albums root is measured
 *      here: its own `count`, the rows actually paged back, the wall clock, and
 *      the Roon round trips.
 *
 *  (2) WHAT HOLDING BOTH ROOTS COSTS IN MEMORY. The plan estimates 2-3 MB for
 *      ~5,600 rows. That estimate decides whether a session-scoped snapshot is
 *      a reasonable thing for a server to hold, so it is measured rather than
 *      trusted: resident set and heap are sampled before the roots are read,
 *      after the Artists root is held, and after both are held, with the rows
 *      kept alive in exactly the shape the session model will hold them in.
 *
 *  (3) HOW OFTEN ROON ITSELF RENDERS TWO IDENTICAL ROWS. The plan's group page
 *      exists for rows a reader cannot tell apart, and its evidence so far
 *      comes from the controller's own stored copy of the library rather than
 *      from Roon. This counts them live, in both roots, by exact rendering:
 *      the Artists root by title and again by title+subtitle, the Albums root
 *      by title+subtitle (the credit). Counts go to stdout; the names go to
 *      stderr under PROBE_SHOW_LABELS=1, for an owner who wants to merge them
 *      in Roon.
 *
 *  (4) WHETHER `refresh_list` ON AN OPEN LEVEL BEATS A FULL RE-READ. The plan
 *      labels this an assumption to verify in Slice 0, and the answer decides
 *      how the periodic refresh and the count-mismatch trigger are built. Three
 *      shapes are timed against the same root: a full re-read, a refresh in
 *      place that asks only for the level's own count, and a plain re-browse
 *      that asks only for the count without requesting a refresh.
 *
 * WHY ROUND TRIPS ARE MODELLED, NOT COUNTED. `BrowseService.browse()` is not
 * one Roon call: it issues a Roon `browse()` and then a Roon `load()` for the
 * items the browse response does not carry, and a navigating browse that also
 * asks for a refresh issues a third (BrowseService.ts:75-90). The probe reuses
 * the cost model the artist-walk probe already established
 * (`browseRoundTripCost`, below) rather than writing a second one, and it keeps every
 * browse at a single page so the model stays exact.
 *
 * OUTPUT HYGIENE (hard rule, inherited from the artist-walk probe): stdout
 * carries counts, booleans and error CODES only — never an artist name, an
 * album title, a credit, an image key, or an item key. Names print to stderr
 * under PROBE_SHOW_LABELS=1 and belong in no committed artifact.
 *
 * THE CONTROLLER MUST BE STOPPED WHILE THIS RUNS, for the same reason the
 * artist-walk probe says so: this registers with the Core under the SAME
 * hard-coded extension id as the controller itself, and Roon treats one
 * extension id as one extension.
 *
 * Run (controller stopped):
 *   ROON_TOKEN_PATH=<path to roon-token.json> npx ts-node src/tooling/libraryRootScaleProbe.ts
 *
 * Optional: PROBE_PAGE_SIZE (default 100), PROBE_PAIR_TIMEOUT_MS (default
 * 120000), PROBE_LOG_LEVEL (default "warn"), PROBE_SHOW_LABELS (1 to print
 * identical renderings to stderr), PROBE_MAX_ROOT_ROWS (default 200000),
 * CONFIG_DIR (only used to derive the default token path).
 */
import path from "path";

import { destination, pino } from "pino";

import { BrowseService } from "../core/roon/BrowseService";
import {
  BrowseSessionCoordinator,
  CatalogSessionHandle,
  CoordinatedBrowseLoadOptions,
  CoordinatedBrowseOptions,
  CoordinatedBrowseSession,
} from "../core/roon/BrowseSessionCoordinator";
import { readCompleteBrowseLevel } from "../core/roon/browseLevelReader";
import { RoonClient, RoonCoreInfo, RoonEvents } from "../core/roon/RoonClient";
import type { AllowedBrowseHierarchy } from "../shared/browseHierarchies";
import { BrowseItem, BrowseResult } from "../shared/types";

/**
 * What one `CoordinatedBrowseSession.browse()` actually costs in Roon round
 * trips. `BrowseService.browse()` issues a Roon browse and then a Roon load,
 * because the browse response carries list metadata but no items; a navigating
 * browse that also asks for a refresh issues a third (BrowseService.ts:70).
 * `load()` is always one. Counting facade calls alone would understate a
 * read's real cost against the Core by a factor of two.
 *
 * Lifted here verbatim when the artist-walk probe died with the saved catalog
 * model (`.agents/plans/library-live-view.md` Slice 4); this probe was its only
 * other caller.
 */
export function browseRoundTripCost(options: {
  itemKey?: string;
  popAll?: boolean;
  refresh?: boolean;
}): number {
  const navigating = options.itemKey !== undefined || options.popAll === true;
  return options.refresh === true && navigating ? 3 : 2;
}

/** A stable, bounded label for whatever a failed call threw. */
export function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) {
      return `${error.name}:${code}`;
    }
    return `error:${error.name}`;
  }
  return "unknown";
}


/** The two roots the session model reads on connect. */
export const LIBRARY_ROOT_HIERARCHIES = ["artists", "albums"] as const;
export type LibraryRootHierarchy = (typeof LIBRARY_ROOT_HIERARCHIES)[number];

function progress(message: string): void {
  process.stderr.write(`library root scale probe: ${message}\n`);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

/**
 * The pairing token the controller itself uses, read the same way the
 * artist-walk probe reads it: straight from `ROON_TOKEN_PATH`, else the
 * `CONFIG_DIR`-relative default `src/config/env.ts` computes. Going through
 * `loadConfig()` would let an unrelated variable fail the measurement.
 */
function resolveTokenPath(): string {
  const configured = process.env.ROON_TOKEN_PATH?.trim();
  if (configured !== undefined && configured.length > 0) {
    return path.resolve(configured);
  }
  const configDir = process.env.CONFIG_DIR?.trim();
  return path.resolve(
    configDir !== undefined && configDir.length > 0 ? configDir : "./config",
    "roon-token.json"
  );
}

// ---------------------------------------------------------------------------
// Pure logic. Everything below this line is decided without a Core, and is
// exercised by src/tooling/__tests__/libraryRootScaleProbe.test.ts.
// ---------------------------------------------------------------------------

/**
 * The row shape the live session model will hold: what Roon rendered, plus the
 * key that reopens it. Held here in exactly that shape so the memory sample
 * describes the thing being sized rather than the probe's own scratch copy.
 */
export interface HeldRootRow {
  readonly itemKey: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly imageKey?: string;
  readonly hint?: string;
}

export function holdRow(item: BrowseItem): HeldRootRow {
  return {
    itemKey: item.itemKey as string,
    title: item.title,
    ...(item.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
    ...(item.imageKey !== undefined ? { imageKey: item.imageKey } : {}),
    ...(item.hint !== undefined ? { hint: item.hint } : {}),
  };
}

/** Joins rendering fields; no display string carries a NUL. */
const FIELD_SEPARATOR = "\u0000";

/** Stands in for a field Roon did not send, so absence is not empty text. */
const ABSENT_FIELD = "\u0001";

/**
 * One rendering, as a comparison key. Exact bytes, joined by a separator no
 * Roon field can contain, with absence distinguished from empty: a row with no
 * subtitle and a row whose subtitle is the empty string are different rows, and
 * a key that conflated them would undercount the very thing being measured.
 */
export function renderingKey(parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => (part === undefined ? ABSENT_FIELD : part))
    .join(FIELD_SEPARATOR);
}

export interface IdenticalRenderingCensus {
  /** Rows the census considered. */
  readonly rows: number;
  /** Distinct renderings among them. */
  readonly distinct: number;
  /** Renderings carried by two or more rows. */
  readonly sharedRenderings: number;
  /** How many rows sit inside those shared renderings. */
  readonly rowsSharingARendering: number;
  /** The largest number of rows any one rendering carries. */
  readonly largestGroup: number;
}

/**
 * Counts rows that Roon renders identically. The census is the number the
 * plan's group-page notice would show, so it counts rows rather than groups
 * and reports both.
 */
export function censusIdenticalRenderings(
  keys: readonly string[]
): IdenticalRenderingCensus {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  let sharedRenderings = 0;
  let rowsSharingARendering = 0;
  let largestGroup = 0;
  for (const count of counts.values()) {
    if (count > largestGroup) largestGroup = count;
    if (count < 2) continue;
    sharedRenderings += 1;
    rowsSharingARendering += count;
  }
  return {
    rows: keys.length,
    distinct: counts.size,
    sharedRenderings,
    rowsSharingARendering,
    largestGroup,
  };
}

/** The keys, in first-seen order, that two or more rows share. */
export function sharedRenderingKeys(keys: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
}

export interface RootRowShape {
  readonly rows: number;
  readonly withItemKey: number;
  readonly hintList: number;
  readonly hintActionList: number;
  readonly hintOther: number;
  readonly hintAbsent: number;
  readonly withSubtitle: number;
  readonly emptySubtitle: number;
  readonly withImageKey: number;
  readonly withItemType: number;
  readonly playable: number;
}

/**
 * What the root's rows actually are, structurally. The live view's promise is
 * that no navigable item fails to open, so the first thing to establish about a
 * root is whether every row it renders carries a key and a list hint at all.
 */
export function summarizeRootRowShape(
  items: readonly BrowseItem[]
): RootRowShape {
  let withItemKey = 0;
  let hintList = 0;
  let hintActionList = 0;
  let hintOther = 0;
  let hintAbsent = 0;
  let withSubtitle = 0;
  let emptySubtitle = 0;
  let withImageKey = 0;
  let withItemType = 0;
  let playable = 0;
  for (const item of items) {
    if (typeof item.itemKey === "string" && item.itemKey.length > 0) {
      withItemKey += 1;
    }
    if (item.hint === undefined) hintAbsent += 1;
    else if (item.hint === "list") hintList += 1;
    else if (item.hint === "action_list") hintActionList += 1;
    else hintOther += 1;
    if (item.subtitle !== undefined) {
      withSubtitle += 1;
      if (item.subtitle.length === 0) emptySubtitle += 1;
    }
    if (item.imageKey !== undefined) withImageKey += 1;
    if (item.itemType !== undefined) withItemType += 1;
    if (item.isPlayable) playable += 1;
  }
  return {
    rows: items.length,
    withItemKey,
    hintList,
    hintActionList,
    hintOther,
    hintAbsent,
    withSubtitle,
    emptySubtitle,
    withImageKey,
    withItemType,
    playable,
  };
}

export interface SubtitleDigitCensus {
  readonly rows: number;
  readonly absent: number;
  readonly empty: number;
  readonly withDigits: number;
  readonly withoutDigits: number;
}

/**
 * How many Artists-root rows carry a subtitle with a digit in it.
 *
 * Deliberately NOT a count parser. The live view will read each artist's album
 * count from Roon's own subtitle, and that parse is a contract that belongs in
 * one shared place with one test suite. This is a measurement of what Roon
 * sends — how many rows could carry a count at all — and it exists so Slice 1
 * knows whether "the count comes from the subtitle" is a rule with exceptions.
 */
export function censusSubtitleDigits(
  items: readonly BrowseItem[]
): SubtitleDigitCensus {
  let absent = 0;
  let empty = 0;
  let withDigits = 0;
  let withoutDigits = 0;
  for (const item of items) {
    const subtitle = item.subtitle;
    if (subtitle === undefined) {
      absent += 1;
      continue;
    }
    if (subtitle.length === 0) {
      empty += 1;
      continue;
    }
    if (/\d/u.test(subtitle)) withDigits += 1;
    else withoutDigits += 1;
  }
  return {
    rows: items.length,
    absent,
    empty,
    withDigits,
    withoutDigits,
  };
}

export interface MemorySample {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
}

export function memoryDelta(
  before: MemorySample,
  after: MemorySample
): MemorySample {
  return {
    rssBytes: after.rssBytes - before.rssBytes,
    heapUsedBytes: after.heapUsedBytes - before.heapUsedBytes,
    externalBytes: after.externalBytes - before.externalBytes,
  };
}

// ---------------------------------------------------------------------------
// Live measurement.
// ---------------------------------------------------------------------------

export interface CallTally {
  facadeCalls: number;
  browseCalls: number;
  loadCalls: number;
  roonRoundTrips: number;
}

/**
 * The measuring instrument, same shape the artist-walk probe used: every call
 * the session model would make passes through here, so cost is counted at the
 * exact seam the real reader sits on rather than inferred from a page count.
 */
class CountingSession implements CoordinatedBrowseSession {
  public readonly sessionScope: string;

  private browseCalls = 0;
  private loadCalls = 0;
  private roonRoundTrips = 0;

  public constructor(private readonly inner: CoordinatedBrowseSession) {
    this.sessionScope = inner.sessionScope;
  }

  public browse(options: CoordinatedBrowseOptions): Promise<BrowseResult> {
    this.browseCalls += 1;
    this.roonRoundTrips += browseRoundTripCost(options);
    return this.inner.browse(options);
  }

  public load(options: CoordinatedBrowseLoadOptions): Promise<BrowseResult> {
    this.loadCalls += 1;
    this.roonRoundTrips += 1;
    return this.inner.load(options);
  }

  public pop(options: Parameters<CoordinatedBrowseSession["pop"]>[0]) {
    this.browseCalls += 1;
    this.roonRoundTrips += 2;
    return this.inner.pop(options);
  }

  public snapshot(): CallTally {
    return {
      facadeCalls: this.browseCalls + this.loadCalls,
      browseCalls: this.browseCalls,
      loadCalls: this.loadCalls,
      roonRoundTrips: this.roonRoundTrips,
    };
  }
}

function tallyDelta(before: CallTally, after: CallTally): CallTally {
  return {
    facadeCalls: after.facadeCalls - before.facadeCalls,
    browseCalls: after.browseCalls - before.browseCalls,
    loadCalls: after.loadCalls - before.loadCalls,
    roonRoundTrips: after.roonRoundTrips - before.roonRoundTrips,
  };
}

function sampleMemory(): MemorySample {
  // A forced collection makes the sample a statement about retained bytes
  // rather than about when V8 last felt like collecting. It is only available
  // under --expose-gc, and the report says whether it was.
  (globalThis as { gc?: () => void }).gc?.();
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
  };
}

interface RootRead {
  readonly hierarchy: LibraryRootHierarchy;
  readonly totalCount: number | null;
  readonly rows: HeldRootRow[];
  readonly items: BrowseItem[];
  readonly elapsedMs: number;
  readonly calls: CallTally;
  readonly refusal: string | null;
}

/**
 * Read one root completely, through the shipped level reader rather than a
 * private paging loop. The reader is what the session model will use, and its
 * five integrity rules (every page at the offset and total asked for, every row
 * keyed, no key repeated) are themselves part of what this measurement is
 * establishing about the roots.
 */
async function readRoot(
  session: CountingSession,
  hierarchy: LibraryRootHierarchy,
  pageSize: number,
  maxRows: number
): Promise<RootRead> {
  const before = session.snapshot();
  const startedAt = Date.now();
  let totalCount: number | null = null;
  let items: BrowseItem[] = [];
  let refusal: string | null = null;
  try {
    const first = await session.browse({
      hierarchy,
      offset: 0,
      pageSize,
      popAll: true,
      refresh: true,
    });
    totalCount = first.totalCount ?? null;
    items = await readCompleteBrowseLevel(session, first, {
      hierarchy: hierarchy as AllowedBrowseHierarchy,
      label: `${hierarchy} root`,
      pageSize,
      maxRows,
      maxPages: Math.ceil(maxRows / pageSize) + 1,
      refuse: (message) => new Error(message),
    });
  } catch (error) {
    refusal = errorCode(error);
  }
  return {
    hierarchy,
    totalCount,
    rows: items.map(holdRow),
    items,
    elapsedMs: Date.now() - startedAt,
    calls: tallyDelta(before, session.snapshot()),
    refusal,
  };
}

/** One timed shape of "ask the Core about this root again". */
interface RefreshProbe {
  readonly elapsedMs: number;
  readonly calls: CallTally;
  readonly totalCount: number | null;
  readonly rowsReturned: number;
  readonly refusal: string | null;
}

async function timeRefreshShape(
  session: CountingSession,
  options: CoordinatedBrowseOptions
): Promise<RefreshProbe> {
  const before = session.snapshot();
  const startedAt = Date.now();
  try {
    const page = await session.browse(options);
    return {
      elapsedMs: Date.now() - startedAt,
      calls: tallyDelta(before, session.snapshot()),
      totalCount: page.totalCount ?? null,
      rowsReturned: page.items.length,
      refusal: null,
    };
  } catch (error) {
    return {
      elapsedMs: Date.now() - startedAt,
      calls: tallyDelta(before, session.snapshot()),
      totalCount: null,
      rowsReturned: 0,
      refusal: errorCode(error),
    };
  }
}

/**
 * Wait for the Core to pair before measuring anything: discovery is
 * asynchronous, and reading a root through an unpaired client fails in a way
 * that looks like a Core problem rather than a timing one.
 */
function waitForPairing(
  roonClient: RoonClient,
  timeoutMs: number
): Promise<RoonCoreInfo> {
  const existing = roonClient.getCoreInfo();
  if (existing !== null) return Promise.resolve(existing);
  return new Promise<RoonCoreInfo>((resolve, reject) => {
    const onStatus = (event: RoonEvents): void => {
      if (event.coreStatus !== "paired" || event.coreInfo === undefined) return;
      cleanup();
      resolve(event.coreInfo);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `no Roon Core paired within ${timeoutMs}ms; is the Core running, and is this extension enabled in Roon Settings > Extensions?`
        )
      );
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      roonClient.off("core-status", onStatus);
    };
    roonClient.on("core-status", onStatus);
  });
}

async function writeReport(payload: unknown): Promise<void> {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

function showSharedRenderings(
  label: string,
  keys: readonly string[],
  rows: readonly HeldRootRow[],
  keyOf: (row: HeldRootRow) => string
): void {
  const shared = new Set(sharedRenderingKeys(keys));
  if (shared.size === 0) {
    process.stderr.write(`  ${label}: no identical renderings\n`);
    return;
  }
  process.stderr.write(
    `  ${label}: ${shared.size} renderings carried by more than one row\n`
  );
  const grouped = new Map<string, HeldRootRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!shared.has(key)) continue;
    const members = grouped.get(key);
    if (members) members.push(row);
    else grouped.set(key, [row]);
  }
  for (const members of grouped.values()) {
    const first = members[0];
    process.stderr.write(
      `    ${members.length}x  ${first.title}${
        first.subtitle !== undefined ? `  —  ${first.subtitle}` : ""
      }\n`
    );
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const showLabels = process.env.PROBE_SHOW_LABELS === "1";
  const pageSize = envInt("PROBE_PAGE_SIZE", 100, 1, 1_000);
  const maxRootRows = envInt("PROBE_MAX_ROOT_ROWS", 200_000, 1, 5_000_000);
  const pairTimeoutMs = envInt("PROBE_PAIR_TIMEOUT_MS", 120_000, 1_000, 900_000);
  const tokenPath = resolveTokenPath();

  progress(
    "STOP THE CONTROLLER FIRST. This probe registers under the controller's own extension id (app.songr.controller); running both at once makes them fight over one registration and one pairing token."
  );
  progress(`using the pairing token at ${tokenPath}`);

  // pino defaults to stdout; stdout is the report. Everything human goes to fd 2.
  const logger = pino(
    { level: process.env.PROBE_LOG_LEVEL ?? "warn" },
    destination(2)
  );
  const roonClient = new RoonClient({ tokenPath, logger });
  const browseService = new BrowseService(roonClient, logger);
  const coordinator = new BrowseSessionCoordinator(browseService);

  progress("starting Roon discovery and waiting for a paired Core");
  const pairStartedAt = Date.now();
  roonClient.start();
  const core = await waitForPairing(roonClient, pairTimeoutMs);
  const pairSeconds = Math.round((Date.now() - pairStartedAt) / 1000);
  progress(`paired after ${pairSeconds}s`);

  const gcAvailable =
    typeof (globalThis as { gc?: () => void }).gc === "function";
  const handle: CatalogSessionHandle = coordinator.acquireCatalog(core.id);
  try {
    await coordinator.runCatalog(core.id, handle, async (raw) => {
      const session = new CountingSession(raw);

      // ---- Question 2, first sample: nothing held yet --------------------
      const beforeRoots = sampleMemory();

      // ---- Question 1 and 3: the two roots -------------------------------
      progress("reading the Artists root");
      const artists = await readRoot(session, "artists", pageSize, maxRootRows);
      progress(
        `artists root: totalCount=${artists.totalCount ?? "unknown"}, rows=${
          artists.rows.length
        }, ${artists.elapsedMs}ms, ${artists.calls.roonRoundTrips} round trips${
          artists.refusal ? `, REFUSED ${artists.refusal}` : ""
        }`
      );
      const afterArtists = sampleMemory();

      progress("reading the Albums root");
      const albums = await readRoot(session, "albums", pageSize, maxRootRows);
      progress(
        `albums root: totalCount=${albums.totalCount ?? "unknown"}, rows=${
          albums.rows.length
        }, ${albums.elapsedMs}ms, ${albums.calls.roonRoundTrips} round trips${
          albums.refusal ? `, REFUSED ${albums.refusal}` : ""
        }`
      );
      const afterBoth = sampleMemory();

      const artistTitleKeys = artists.rows.map((row) => renderingKey([row.title]));
      const artistFullKeys = artists.rows.map((row) =>
        renderingKey([row.title, row.subtitle])
      );
      const albumFullKeys = albums.rows.map((row) =>
        renderingKey([row.title, row.subtitle])
      );

      if (showLabels) {
        process.stderr.write("identical renderings (owner's data, stderr only):\n");
        showSharedRenderings("artists by title", artistTitleKeys, artists.rows, (row) =>
          renderingKey([row.title])
        );
        showSharedRenderings(
          "artists by title+subtitle",
          artistFullKeys,
          artists.rows,
          (row) => renderingKey([row.title, row.subtitle])
        );
        showSharedRenderings(
          "albums by title+credit",
          albumFullKeys,
          albums.rows,
          (row) => renderingKey([row.title, row.subtitle])
        );
      }

      // ---- Question 4: what a refresh of an open level costs --------------
      // Measured on the Albums root, the larger of the two, and measured while
      // that root is the session's current level — which is the state a
      // periodic refresh would actually find the session in.
      progress("timing refresh shapes against the Albums root");
      const refreshInPlace = await timeRefreshShape(session, {
        hierarchy: "albums",
        offset: 0,
        pageSize: 1,
        refresh: true,
      });
      const plainCountOnly = await timeRefreshShape(session, {
        hierarchy: "albums",
        offset: 0,
        pageSize: 1,
      });
      const fullReread = await readRoot(session, "albums", pageSize, maxRootRows);
      progress(
        `refresh shapes: in-place=${refreshInPlace.elapsedMs}ms, plain=${plainCountOnly.elapsedMs}ms, full re-read=${fullReread.elapsedMs}ms`
      );

      await writeReport({
        probe: "library-root-scale",
        planSlice: "library-live-view.md Slice 0",
        mutationInvokes: 0,
        measuredAt: new Date(startedAt).toISOString(),
        elapsedSeconds: {
          total: Math.round((Date.now() - startedAt) / 1000),
          pairing: pairSeconds,
        },
        config: {
          pageSize,
          maxRootRows,
          pairTimeoutMs,
          labelsShown: showLabels,
          forcedGcAvailable: gcAvailable,
        },
        /** Question 1, for both roots rather than only the unmeasured one. */
        roots: {
          artists: {
            totalCount: artists.totalCount,
            rowsRead: artists.rows.length,
            pagesAgreeWithTotal:
              artists.totalCount !== null &&
              artists.rows.length === artists.totalCount,
            readRefusal: artists.refusal,
            elapsedMs: artists.elapsedMs,
            calls: artists.calls,
            shape: summarizeRootRowShape(artists.items),
            subtitles: censusSubtitleDigits(artists.items),
          },
          albums: {
            totalCount: albums.totalCount,
            rowsRead: albums.rows.length,
            pagesAgreeWithTotal:
              albums.totalCount !== null &&
              albums.rows.length === albums.totalCount,
            readRefusal: albums.refusal,
            elapsedMs: albums.elapsedMs,
            calls: albums.calls,
            shape: summarizeRootRowShape(albums.items),
            subtitles: censusSubtitleDigits(albums.items),
          },
        },
        /** Question 2. Deltas beside the raw samples; neither alone is honest. */
        memory: {
          forcedGcAvailable: gcAvailable,
          beforeRoots,
          afterArtistsRoot: afterArtists,
          afterBothRoots: afterBoth,
          artistsRootDelta: memoryDelta(beforeRoots, afterArtists),
          albumsRootDelta: memoryDelta(afterArtists, afterBoth),
          bothRootsDelta: memoryDelta(beforeRoots, afterBoth),
          rowsHeld: artists.rows.length + albums.rows.length,
        },
        /** Question 3. The number the group-page notice would show today. */
        identicalRenderings: {
          artistsByTitle: censusIdenticalRenderings(artistTitleKeys),
          artistsByTitleAndSubtitle: censusIdenticalRenderings(artistFullKeys),
          albumsByTitleAndCredit: censusIdenticalRenderings(albumFullKeys),
        },
        /** Question 4. Same root, three shapes, same session. */
        refreshCost: {
          refreshInPlaceCountOnly: refreshInPlace,
          plainBrowseCountOnly: plainCountOnly,
          fullReread: {
            elapsedMs: fullReread.elapsedMs,
            calls: fullReread.calls,
            totalCount: fullReread.totalCount,
            rowsRead: fullReread.rows.length,
            refusal: fullReread.refusal,
          },
          countsAgreeAcrossShapes:
            refreshInPlace.totalCount === albums.totalCount &&
            plainCountOnly.totalCount === albums.totalCount &&
            fullReread.totalCount === albums.totalCount,
        },
      });
    });
  } finally {
    // A release that fails must not replace the measurement's own failure with
    // a cleanup error: the reason the read stopped is the reportable fact.
    try {
      await coordinator.releaseCatalog(core.id, handle);
    } catch (error) {
      progress(`catalog session release failed: ${errorCode(error)}`);
    }
    coordinator.shutdown();
  }
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(
        `library root scale probe failed: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }\n`
      );
      process.exitCode = 1;
    })
    .finally(() => {
      // node-roon-api keeps its discovery sockets open and RoonClient exposes
      // no stop, so the probe ends the process itself once the report on stdout
      // has flushed. Without this the command hangs after printing.
      process.exit(process.exitCode ?? 0);
    });
}
