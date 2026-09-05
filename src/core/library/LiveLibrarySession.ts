/**
 * Roon's library, held as a session-scoped snapshot and nothing else.
 *
 * `.agents/plans/library-live-view.md` Slice 1, and the invariant the whole
 * plan turns on: **Roon is the only source of truth for library structure, and
 * this controller stores nothing about the library on disk.** What lives here
 * is a generation-stamped point-in-time copy of the two lists Roon renders,
 * built from Roon on connect, thrown away on disconnect, and re-read from
 * Roon. It is never edited, reconciled, merged or matched, and no name is ever
 * compared across surfaces.
 *
 * THE SNAPSHOT IS FOR DISPLAY AND FILTERING. It is not an identity store and
 * it is not an open path. Every row the UI sees is named by an opaque
 * `{ generation, token }` reference the coordinator minted; the raw Roon key
 * stays on the server, bound to the browse session that produced it. When a
 * generation is retired every one of its references dies at once, and a
 * request carrying one is refused `STALE_GENERATION` rather than answered
 * approximately.
 *
 * WHY THE SWAP HAPPENS AT THE END OF A READ, NOT AT THE START. Retiring the
 * old generation first would mean that a refresh which fails — a Core that
 * went quiet halfway through the Albums root — leaves the reader holding
 * references to nothing and a screen it cannot use. So the roots are read
 * first, and only then, in two synchronous statements with no await between
 * them, is the old generation retired and the new one installed. A failed
 * refresh therefore changes nothing at all: the previous snapshot stays whole
 * and every reference in it still resolves. The atomicity the plan asks for is
 * kept — there is no instant in which a reader could observe a half-swapped
 * library — and the failure mode is the harmless one.
 *
 * WHY A COUNT CHECK EXISTS AT ALL. Measured on the owner's Core 2026-09-03
 * (`.agents/state.md`): reading both roots costs ~1.7 s and 61 Roon round
 * trips; asking each root for its own count costs ~125 ms and one call.
 * Re-reading the whole library every five minutes to discover that nothing
 * changed would be sixty times the traffic for the same answer. So the timer
 * checks the counts and only re-reads when they move. What that cannot catch
 * is a change that leaves both counts identical — an album replaced by another
 * album. The plan says so plainly rather than claiming a coherence Roon gives
 * nobody: there is no library-changed push in the extension API, the snapshot
 * is point-in-time, and no open ever trusts it.
 */
import { randomUUID } from "crypto";

import type { Logger } from "pino";

import type { AllowedBrowseHierarchy } from "../../shared/browseHierarchies";
import type { BrowseItem, BrowseResult } from "../../shared/types";
import type { CoordinatedBrowseSession } from "../roon/BrowseSessionCoordinator";
import { BrowseSessionCoordinatorError } from "../roon/BrowseSessionCoordinator";
import { readCompleteBrowseLevel } from "../roon/browseLevelReader";
import {
  CoreUnpairedError,
  RoonBrowseError,
  RoonTimeoutError,
} from "../roon/errors";
import type { GovernedCallOutcome } from "../pacing/CallAdmissionController";

import type { LibraryReadPacing } from "./LibraryReadPacing";
import type { LibraryRowReference } from "../../shared/libraryRootsContracts";
import {
  LIBRARY_LEVEL_ROWS_MAX,
  libraryImpliedChildKind,
  libraryRowKind,
  type LibraryNodeKind,
} from "../../shared/libraryOpenContracts";
import type {
  LibraryActionSubject,
  LibraryBrowseRunner,
  LibraryInvalidation,
  LibraryInvalidationReason,
  LibraryLevelHold,
  LibraryLevelRowHold,
  LibraryOnDemandRoot,
  LibraryOpenOutcome,
  LibraryPublicationPort,
  LibraryReadTrigger,
  LibraryRootHold,
  LibraryRootRowHold,
  LibraryRootsOutcome,
  LibrarySnapshot,
  LibrarySource,
} from "./LibrarySource";

/** The two hierarchies that make up the library's roots. */
export const LIBRARY_ROOT_HIERARCHIES = ["artists", "albums"] as const;
export type LibraryRootHierarchy = (typeof LIBRARY_ROOT_HIERARCHIES)[number];

/** Rows per Roon `load`. Matches what the probe measured the roots at. */
export const LIBRARY_ROOT_PAGE_SIZE = 100;

/**
 * Most rows one root may hold, matching the coordinator's publication bound so
 * a read that would be refused at publication is refused before it is paged.
 */
export const LIBRARY_ROOT_MAX_ROWS = 100_000;

/** The plan's default: re-check the roots every five minutes. */
export const LIBRARY_ROOT_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

/** The roots that exist but are read only when a reader asks for one. */
export const LIBRARY_ON_DEMAND_ROOTS = ["genres", "composers"] as const;

/** Rows per Roon `load` inside an opened level. */
export const LIBRARY_LEVEL_PAGE_SIZE = 100;

/**
 * How many opened levels one generation keeps alive, oldest evicted first.
 *
 * WHY THERE IS A BOUND AT ALL. A generation can live for hours — it survives
 * every count check and dies only on a refresh, a reconnect or a lost session —
 * and every page a reader opens inside it adds a level to the same authority.
 * Unbounded, a long browsing session would grow the published set without
 * limit, and the coordinator's own hard bound would eventually refuse an open,
 * which is the one failure a reader must never meet.
 *
 * WHY EVICTION IS SAFE, AND WHY IT IS NOT A CACHE. Losing a level's references
 * is not losing data: it is the same event as losing the whole generation, it
 * produces the same `stale` answer, and it is recovered the same way. Levels
 * are evicted oldest-first, so what a reader is actually looking at — and
 * everything on the path back to it — stays alive: a chain of artist, album and
 * track is three levels, and thirty-two is far more than any reader is inside
 * at once.
 *
 * The roots are NEVER evicted. They are the one level every other reference was
 * reached through, and a reader whose lists went dead under them would have
 * nothing left to re-resolve from.
 */
export const LIBRARY_OPEN_MAX_LEVELS = 32;

/** Total rows held across all opened levels of one generation. */
export const LIBRARY_OPEN_MAX_HELD_ROWS = 40_000;

export interface LiveLibrarySessionOptions {
  readonly runBrowse: LibraryBrowseRunner;
  /**
   * Count checks re-root their multi-session. They must use a session that
   * never published references, or a cheap check destroys the key space it is
   * meant to validate.
   */
  readonly runCountBrowse: LibraryBrowseRunner;
  readonly publication: LibraryPublicationPort;
  readonly pacing: LibraryReadPacing;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly refreshIntervalMs?: number;
  /** Injected so tests cross the level bound without opening thirty-two. */
  readonly maxOpenLevels?: number;
  readonly maxHeldLevelRows?: number;
  /** Injected so tests drive the timer instead of waiting five minutes. */
  readonly timers?: {
    setInterval: (handler: () => void, ms: number) => NodeJS.Timeout;
    clearInterval: (handle: NodeJS.Timeout) => void;
  };
}

/**
 * What one published token names, and how to reach it again.
 *
 * The kind is assigned from the path the server walked to publish the row, and
 * the title is kept for the one case where a row's own label decides what its
 * children are: Roon's "Albums" and "Artists" sections inside a genre.
 */
interface LibraryNodeHold {
  readonly hierarchy: AllowedBrowseHierarchy;
  readonly kind: LibraryNodeKind;
  readonly title: string;
}

interface HeldSnapshot extends LibrarySnapshot {
  /** Which channel published these references. */
  readonly sessionScope: string;
  /** The coordinator's own authority generation behind them. */
  readonly authorityGeneration: number;
  /** Every token this generation has published, and what it names. */
  readonly nodes: Map<string, LibraryNodeHold>;
  /**
   * The levels opened inside this generation, oldest first. The roots are not
   * in here: they are never evicted.
   */
  readonly levels: string[][];
}

function isNotFoundOutcome(error: unknown): boolean {
  return (
    error instanceof CoreUnpairedError ||
    (error instanceof BrowseSessionCoordinatorError &&
      (error.code === "SESSION_LOST" || error.code === "STALE_GENERATION")) ||
    // Roon no longer knows the key this reference names. Observed live
    // 2026-09-03: after a pressure trip the Core answered every held key
    // with InvalidItemKey while the snapshot stayed installed, so every row
    // on screen "could not open" until something else retired it.
    (error instanceof RoonBrowseError && error.invalidatesItemKeys)
  );
}

/**
 * How a failed read is reported to the rate controller.
 *
 * A timeout and a lost connection are hard signals about the Core and must
 * reach the breaker; everything else — a refused read, a root that failed its
 * integrity rules — is a failure that says nothing about Core latency and must
 * not be measured as one.
 */
export function classifyReadFailure(error: unknown): GovernedCallOutcome {
  if (error instanceof RoonTimeoutError) return "timed-out";
  if (error instanceof CoreUnpairedError) return "connection-lost";
  return "failed";
}

export class LiveLibrarySession implements LibrarySource {
  public readonly kind = "roon";

  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly timers: NonNullable<LiveLibrarySessionOptions["timers"]>;
  private readonly listeners = new Set<
    (event: LibraryInvalidation) => void
  >();

  private coreId: string | null = null;
  private snapshot: HeldSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  /**
   * The read currently in flight, so two triggers landing together — the
   * connect read and the first page load, say — share one read instead of
   * queueing two full library reads behind each other on the shared FIFO.
   */
  private inFlight: Promise<LibraryRootsOutcome> | null = null;

  public constructor(private readonly options: LiveLibrarySessionOptions) {
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? LIBRARY_ROOT_REFRESH_INTERVAL_MS;
    this.timers = options.timers ?? {
      setInterval: (handler, ms) => {
        const handle = setInterval(handler, ms);
        // A refresh schedule must never be the reason a process refuses to
        // exit; shutdown clears it too, and this is the belt for that braces.
        handle.unref?.();
        return handle;
      },
      clearInterval: (handle) => clearInterval(handle),
    };
  }

  public connect(coreId: string, trigger: LibraryReadTrigger = "connect"): void {
    if (this.closed) return;
    const previous = this.coreId;
    if (previous !== null && previous !== coreId) {
      // A different Core is a different library. Nothing about the old one may
      // survive the change, least of all a reference into its browse session.
      this.retire("core-lost");
    } else if (previous === coreId) {
      // Same Core, fresh pairing: the browse session behind every published
      // reference is gone even though the library is the same one.
      this.retire("reconnect");
    }
    this.coreId = coreId;
    this.startTimer();
    void this.read(trigger === "connect" ? "connect" : trigger, "connect").catch(
      (error: unknown) => {
        this.options.logger.warn(
          { err: error, coreId },
          "Live library roots read failed on connect"
        );
      }
    );
  }

  public disconnect(reason: LibraryInvalidationReason = "core-lost"): void {
    this.stopTimer();
    this.retire(reason);
    this.coreId = null;
  }

  public current(): LibrarySnapshot | null {
    return this.snapshot;
  }

  public roots(trigger: LibraryReadTrigger): Promise<LibraryRootsOutcome> {
    const held = this.snapshot;
    if (held !== null) {
      return Promise.resolve({ kind: "snapshot", snapshot: held });
    }
    return this.read(trigger, "connect");
  }

  public refresh(trigger: LibraryReadTrigger): Promise<LibraryRootsOutcome> {
    return this.read(trigger, "refresh");
  }

  public async revalidate(
    trigger: LibraryReadTrigger
  ): Promise<LibraryRootsOutcome> {
    const held = this.snapshot;
    const coreId = this.coreId;
    if (held === null || coreId === null) return this.read(trigger, "connect");
    if (!this.options.pacing.admits(coreId)) return this.underPressure();

    const ticket = this.options.pacing.begin(coreId, "count");
    const startedAt = this.now();
    let counts: { artists: number | null; albums: number | null };
    try {
      counts = await this.options.runCountBrowse(
        coreId,
        async (session) => ({
          artists: await this.readRootCount(session, "artists"),
          albums: await this.readRootCount(session, "albums"),
        }),
      );
    } catch (error) {
      this.options.pacing.settle(
        ticket,
        classifyReadFailure(error),
        this.now() - startedAt
      );
      this.options.logger.warn(
        { err: error, coreId, trigger },
        "Live library count check failed"
      );
      // The check failed; the snapshot did not. Nothing is retired, and the
      // caller keeps the library it already had.
      return { kind: "snapshot", snapshot: held };
    }
    this.options.pacing.settle(ticket, "answered", this.now() - startedAt);

    if (
      counts.artists === held.artists.count &&
      counts.albums === held.albums.count
    ) {
      return { kind: "snapshot", snapshot: held };
    }
    this.options.logger.info(
      {
        coreId,
        trigger,
        heldArtists: held.artists.count,
        heldAlbums: held.albums.count,
        liveArtists: counts.artists,
        liveAlbums: counts.albums,
      },
      "Live library root counts moved; re-reading"
    );
    return this.read(trigger, "count-mismatch");
  }

  /**
   * One published reference, back to the row that minted it.
   *
   * Both halves are checked, and against the snapshot in hand rather than
   * against the coordinator alone: the generation must be the one this session
   * is currently publishing, and the token must be one that generation carries.
   * A reference from a retired snapshot is refused here before it reaches the
   * coordinator, and the coordinator refuses it again on its own account. Two
   * checks, because this one knows the opaque generation and that one knows the
   * browse session, and neither can speak for the other.
   */
  public resolve(ref: LibraryRowReference): BrowseItem & { itemKey: string } {
    const held = this.snapshot;
    if (held === null || held.generation !== ref.generation) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The library snapshot that published this reference has been retired"
      );
    }
    return this.options.publication.resolveCatalogPublishedItem(
      held.sessionScope,
      held.authorityGeneration,
      ref.token
    );
  }

  /**
   * One published reference, resolved into everything an action needs.
   *
   * `.agents/plans/library-live-view.md` Slice 2. The reference the reader
   * clicked is the whole of the subject: measured on the owner's Core
   * 2026-09-03, browsing an album's `Play Album` row or a track row with a zone
   * bound answers with the action leaves for that exact row, including for both
   * halves of a Roon-duplicated pair. So nothing here selects by index, title or
   * digest, and nothing is compared against another surface.
   *
   * The three facts that travel are the three an action cannot be safe without:
   * which channel minted the key, which publication it belongs to, and the
   * library generation the reader was holding. All three are re-checked before
   * anything is dispatched.
   */
  public resolveActionSubject(ref: LibraryRowReference): LibraryActionSubject {
    const held = this.snapshot;
    if (held === null || held.generation !== ref.generation) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The library snapshot that published this reference has been retired"
      );
    }
    const node = held.nodes.get(ref.token);
    if (node === undefined) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "That reference is no longer part of the current library snapshot"
      );
    }
    const item = this.options.publication.resolveCatalogPublishedItem(
      held.sessionScope,
      held.authorityGeneration,
      ref.token
    );
    return {
      anchor: {
        sessionScope: held.sessionScope,
        authorityGeneration: held.authorityGeneration,
      },
      generation: held.generation,
      hierarchy: node.hierarchy,
      itemKey: item.itemKey,
      title: node.title,
      kind: node.kind,
    };
  }

  public isActionSubjectCurrent(
    subject: Readonly<LibraryActionSubject>
  ): boolean {
    const held = this.snapshot;
    return (
      held !== null &&
      held.generation === subject.generation &&
      held.sessionScope === subject.anchor.sessionScope &&
      held.authorityGeneration === subject.anchor.authorityGeneration
    );
  }

  public open(ref: LibraryRowReference): Promise<LibraryOpenOutcome> {
    const held = this.snapshot;
    // Both halves are checked before anything is read: the generation, so a
    // reference from a retired snapshot never reaches Roon, and the token, so a
    // generation-shaped guess never does either.
    if (held === null || held.generation !== ref.generation) {
      return Promise.resolve({ kind: "stale" });
    }
    const node = held.nodes.get(ref.token);
    if (node === undefined) return Promise.resolve({ kind: "stale" });
    return this.readLevel(held, {
      node,
      resolveItemKey: () =>
        this.options.publication.resolveCatalogPublishedItem(
          held.sessionScope,
          held.authorityGeneration,
          ref.token
        ).itemKey,
    });
  }

  public openRoot(root: LibraryOnDemandRoot): Promise<LibraryOpenOutcome> {
    const held = this.snapshot;
    // An on-demand root still belongs to a generation: its rows are published
    // into the snapshot that is current, so they die with it like everything
    // else. Without one there is nothing to publish into, and the reader is
    // told to read the roots first rather than handed a level that outlives
    // every reference around it.
    if (held === null) return Promise.resolve({ kind: "stale" });
    return this.readLevel(held, {
      node: {
        hierarchy: root,
        // The root itself is not a row, so its kind is only a label for logs;
        // what its rows are is stated outright below rather than inferred.
        kind: "section",
        title: root === "genres" ? "Genres" : "Composers",
      },
      impliedOverride: root === "genres" ? "genre" : "composer",
      resolveItemKey: () => null,
    });
  }

  /**
   * The one read behind both open paths.
   *
   * Written once rather than twice for the same reason `replacePublishedItems`
   * is: the properties that make an opened level safe — the level read whole
   * under the shipped integrity rules, published into the generation that is
   * still current, and refused outright when that generation moved — are not
   * properties a second copy would keep by accident.
   */
  private async readLevel(
    held: HeldSnapshot,
    input: {
      readonly node: LibraryNodeHold;
      readonly impliedOverride?: LibraryNodeKind;
      /** The row's live Roon key, or `null` to read a hierarchy root. */
      readonly resolveItemKey: () => string | null;
    }
  ): Promise<LibraryOpenOutcome> {
    const coreId = this.coreId;
    if (this.closed || coreId === null) {
      return {
        kind: "unavailable",
        reason: "no-core",
        message: "No Roon Core is paired.",
      };
    }
    if (!this.options.pacing.admits(coreId)) {
      return {
        kind: "unavailable",
        reason: "core-under-pressure",
        message:
          "The Roon Core is being given a rest; the library will open again shortly.",
      };
    }
    const { node } = input;
    const ticket = this.options.pacing.begin(coreId, "open");
    const startedAt = this.now();
    try {
      const level = await this.options.runBrowse(
        coreId,
        async (session) => {
          // The references were minted on one browse session. A different one
          // cannot resolve them, and using its keys would open some other row.
          if (session.sessionScope !== held.sessionScope) {
            throw new BrowseSessionCoordinatorError(
              "SESSION_LOST",
              "The browse session that published this reference is gone"
            );
          }
          const itemKey = input.resolveItemKey();
          const first = await session.browse({
            hierarchy: node.hierarchy,
            ...(itemKey === null
              ? { popAll: true, refresh: true }
              : { itemKey }),
            offset: 0,
            pageSize: LIBRARY_LEVEL_PAGE_SIZE,
          });
          const items = await readCompleteBrowseLevel(session, first, {
            hierarchy: node.hierarchy,
            label: "library level",
            pageSize: LIBRARY_LEVEL_PAGE_SIZE,
            maxRows: LIBRARY_LEVEL_ROWS_MAX,
            maxPages:
              Math.ceil(LIBRARY_LEVEL_ROWS_MAX / LIBRARY_LEVEL_PAGE_SIZE) + 1,
            refuse: (message) => new Error(`[LiveLibrarySession] ${message}`),
          });
          const published = this.options.publication.appendCatalogPublishedItems(
            held.sessionScope,
            held.authorityGeneration,
            items
          );
          const implied =
            input.impliedOverride ?? libraryImpliedChildKind(node);
          const rows = items.map((item, index): LibraryLevelRowHold => {
            const kind = libraryRowKind(implied, {
              title: item.title,
              ...(item.subtitle !== undefined
                ? { subtitle: item.subtitle }
                : {}),
              ...(item.hint !== undefined ? { hint: item.hint } : {}),
              ...(item.itemType !== undefined
                ? { itemType: item.itemType }
                : {}),
            });
            const token = published[index].token;
            held.nodes.set(token, {
              hierarchy: node.hierarchy,
              kind,
              title: item.title,
            });
            return {
              ref: { generation: held.generation, token },
              title: item.title,
              kind,
              ...(item.subtitle !== undefined
                ? { subtitle: item.subtitle }
                : {}),
              ...(item.imageKey !== undefined
                ? { imageKey: item.imageKey }
                : {}),
            };
          });
          held.levels.push(published.map((entry) => entry.token));
          return {
            generation: held.generation,
            // Roon's own heading for the level, so a page states what it
            // opened rather than repeating what the client thought it clicked.
            title: first.title ?? node.title,
            count: rows.length,
            rows,
            ...(first.subtitle !== undefined
              ? { subtitle: first.subtitle }
              : {}),
          } satisfies LibraryLevelHold;
        }
      );
      this.options.pacing.settle(ticket, "answered", this.now() - startedAt);
      // The snapshot may have been retired while the level was being read. The
      // level is then about a library nobody is holding any more, and its
      // references were minted into an authority that is gone.
      if (this.snapshot !== held || this.coreId !== coreId) {
        return { kind: "stale" };
      }
      this.pruneLevels(held);
      return { kind: "level", level };
    } catch (error) {
      this.options.pacing.settle(
        ticket,
        classifyReadFailure(error),
        this.now() - startedAt
      );
      if (isNotFoundOutcome(error)) {
        // Either the reference died under the read or the session behind every
        // reference is gone. Both are the same news to the reader, and the
        // second means the snapshot is worthless whatever it still looks like.
        if (
          (error instanceof BrowseSessionCoordinatorError &&
            error.code === "SESSION_LOST") ||
          (error instanceof RoonBrowseError && error.invalidatesItemKeys)
        ) {
          this.retire("session-lost");
        }
        return { kind: "stale" };
      }
      this.options.logger.warn(
        { err: error, coreId, kind: node.kind },
        "Live library level read failed"
      );
      return {
        kind: "unavailable",
        reason: "read-failed",
        message: "Roon could not open that just now.",
      };
    }
  }

  /**
   * Drop the oldest opened levels until the generation is back inside its
   * bound. The roots are not in `levels` and are never considered.
   */
  private pruneLevels(held: HeldSnapshot): void {
    const maxLevels = this.options.maxOpenLevels ?? LIBRARY_OPEN_MAX_LEVELS;
    const maxRows = this.options.maxHeldLevelRows ?? LIBRARY_OPEN_MAX_HELD_ROWS;
    let heldRows = held.levels.reduce((total, level) => total + level.length, 0);
    while (
      held.levels.length > maxLevels ||
      (heldRows > maxRows && held.levels.length > 1)
    ) {
      const oldest = held.levels.shift();
      if (oldest === undefined) return;
      heldRows -= oldest.length;
      for (const token of oldest) held.nodes.delete(token);
      this.options.publication.retireCatalogPublishedTokens(
        held.sessionScope,
        held.authorityGeneration,
        oldest
      );
    }
  }

  public onInvalidated(
    listener: (event: LibraryInvalidation) => void
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    this.retire("shutdown");
    this.coreId = null;
    this.listeners.clear();
  }

  // ── Reading ──────────────────────────────────────────────────────────

  private read(
    trigger: LibraryReadTrigger,
    reason: LibraryInvalidationReason
  ): Promise<LibraryRootsOutcome> {
    const existing = this.inFlight;
    if (existing !== null) return existing;
    const attempt = this.readRoots(trigger, reason).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = attempt;
    return attempt;
  }

  private async readRoots(
    trigger: LibraryReadTrigger,
    reason: LibraryInvalidationReason
  ): Promise<LibraryRootsOutcome> {
    const coreId = this.coreId;
    if (this.closed || coreId === null) {
      return {
        kind: "unavailable",
        reason: "no-core",
        message: "No Roon Core is paired.",
      };
    }
    if (!this.options.pacing.admits(coreId)) return this.underPressure();

    const ticket = this.options.pacing.begin(coreId, "roots");
    const startedAt = this.now();
    try {
      const snapshot = await this.options.runBrowse(
        coreId,
        async (session) => {
          const artists = await this.readRootRows(session, "artists");
          const albums = await this.readRootRows(session, "albums");
          // The swap. Both statements are synchronous and nothing awaits
          // between them, so no reader can observe a retired generation with
          // no successor, and no request can be answered from a half-built
          // snapshot.
          const authorityGeneration =
            this.options.publication.beginCatalogPublication(
              session.sessionScope
            );
          const published =
            this.options.publication.replaceCatalogPublishedItems(
              session.sessionScope,
              authorityGeneration,
              [...artists.items, ...albums.items]
            );
          const generation = randomUUID();
          const artistsHold = holdRoot(
            artists,
            published.slice(0, artists.items.length),
            generation
          );
          const albumsHold = holdRoot(
            albums,
            published.slice(artists.items.length),
            generation
          );
          // Every root row is named by the root it came from, and by nothing
          // about its own text. An Artists row is an artist because it is on
          // the Artists root.
          const nodes = new Map<string, LibraryNodeHold>();
          for (const row of artistsHold.rows) {
            nodes.set(row.ref.token, {
              hierarchy: "artists",
              kind: "artist",
              title: row.title,
            });
          }
          for (const row of albumsHold.rows) {
            nodes.set(row.ref.token, {
              hierarchy: "albums",
              kind: "album",
              title: row.title,
            });
          }
          return {
            generation,
            coreId,
            readAt: this.now(),
            sessionScope: session.sessionScope,
            authorityGeneration,
            nodes,
            levels: [],
            artists: artistsHold,
            albums: albumsHold,
          } satisfies HeldSnapshot;
        }
      );
      this.options.pacing.settle(ticket, "answered", this.now() - startedAt);

      // The Core may have changed under a read that takes a second or two. A
      // snapshot of a library nobody is looking at any more is discarded
      // rather than installed.
      if (this.closed || this.coreId !== coreId) {
        return {
          kind: "unavailable",
          reason: "no-core",
          message: "The Roon Core changed while the library was being read.",
        };
      }
      const retired = this.snapshot?.generation ?? null;
      this.snapshot = snapshot;
      this.announce({ reason, retired, coreId });
      this.options.logger.info(
        {
          coreId,
          trigger,
          generation: snapshot.generation,
          artists: snapshot.artists.count,
          albums: snapshot.albums.count,
          elapsedMs: this.now() - startedAt,
        },
        "Live library roots read"
      );
      return { kind: "snapshot", snapshot };
    } catch (error) {
      this.options.pacing.settle(
        ticket,
        classifyReadFailure(error),
        this.now() - startedAt
      );
      this.options.logger.warn(
        { err: error, coreId, trigger },
        "Live library roots read failed"
      );
      if (isNotFoundOutcome(error)) {
        // The browse session that owns every published reference is gone, so
        // the snapshot built on it is gone too, whatever it still looks like.
        this.retire("session-lost");
      }
      const held = this.snapshot;
      if (held !== null) return { kind: "snapshot", snapshot: held };
      return {
        kind: "unavailable",
        reason: "read-failed",
        message: "Roon did not answer the library read.",
      };
    }
  }

  /** One root, read completely, through the shipped level reader. */
  private async readRootRows(
    session: CoordinatedBrowseSession,
    hierarchy: LibraryRootHierarchy
  ): Promise<{ count: number; items: BrowseItem[] }> {
    const first = await session.browse({
      hierarchy,
      offset: 0,
      pageSize: LIBRARY_ROOT_PAGE_SIZE,
      popAll: true,
      refresh: true,
    });
    const items = await readCompleteBrowseLevel(session, first, {
      hierarchy: hierarchy as AllowedBrowseHierarchy,
      label: `${hierarchy} root`,
      pageSize: LIBRARY_ROOT_PAGE_SIZE,
      maxRows: LIBRARY_ROOT_MAX_ROWS,
      maxPages: Math.ceil(LIBRARY_ROOT_MAX_ROWS / LIBRARY_ROOT_PAGE_SIZE) + 1,
      refuse: (message) => new Error(`[LiveLibrarySession] ${message}`),
    });
    return { count: items.length, items };
  }

  /**
   * One root's own count, without reading its rows.
   *
   * `refresh: true` is not decoration: without it the Core is entitled to
   * answer from the list it already had open, and a check that cannot see a
   * change is not a check. The probe measured the difference — 125 ms
   * refreshing against 3 ms not — and 125 ms is the price of an answer that
   * means something.
   */
  private async readRootCount(
    session: CoordinatedBrowseSession,
    hierarchy: LibraryRootHierarchy
  ): Promise<number | null> {
    const page = await session.browse({
      hierarchy,
      offset: 0,
      pageSize: 1,
      popAll: true,
      refresh: true,
    });
    return countOf(page);
  }

  // ── Generations ──────────────────────────────────────────────────────

  private retire(reason: LibraryInvalidationReason): void {
    const held = this.snapshot;
    this.snapshot = null;
    // Told even when there was nothing to retire: a listener that only hears
    // about generations it happened to have seen cannot tell "gone" from
    // "never arrived", and both mean re-read.
    this.announce({
      reason,
      retired: held?.generation ?? null,
      coreId: this.coreId,
    });
  }

  private announce(event: LibraryInvalidation): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger.warn(
          { err: error, reason: event.reason },
          "Live library invalidation listener threw"
        );
      }
    }
  }

  private underPressure(): LibraryRootsOutcome {
    return {
      kind: "unavailable",
      reason: "core-under-pressure",
      message: "Waiting for the Roon Core to answer promptly again.",
    };
  }

  // ── The refresh schedule ─────────────────────────────────────────────

  private startTimer(): void {
    if (this.timer !== null || this.refreshIntervalMs <= 0) return;
    this.timer = this.timers.setInterval(() => {
      void this.revalidate("timer").catch((error: unknown) => {
        this.options.logger.warn(
          { err: error },
          "Scheduled live library revalidation failed"
        );
      });
    }, this.refreshIntervalMs);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    this.timers.clearInterval(this.timer);
    this.timer = null;
  }
}

/** A level's own count, when Roon reported a usable one. */
function countOf(page: BrowseResult): number | null {
  const total = page.totalCount;
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0
    ? total
    : null;
}

/**
 * Pairs each row Roon returned with the reference minted for it.
 *
 * The two arrays are the same length and in the same order by construction —
 * the publication returns one entry per item it was given — and this asserts
 * it rather than trusting it, because a misalignment here would hand every row
 * its neighbour's reference and no later check would catch it.
 */
function holdRoot(
  root: { count: number; items: readonly BrowseItem[] },
  published: ReadonlyArray<{ token: string; item: BrowseItem }>,
  generation: string
): LibraryRootHold {
  if (published.length !== root.items.length) {
    throw new Error(
      "[LiveLibrarySession] published references do not match the rows read"
    );
  }
  const rows: LibraryRootRowHold[] = root.items.map((item, index) => {
    const entry = published[index];
    if (entry.item.title !== item.title) {
      throw new Error(
        "[LiveLibrarySession] a published reference does not name its own row"
      );
    }
    return {
      ref: { generation, token: entry.token },
      title: item.title,
      ...(item.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
      ...(item.imageKey !== undefined ? { imageKey: item.imageKey } : {}),
    };
  });
  return { count: root.count, rows };
}
