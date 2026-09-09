import pino from "pino";

import { BrowseService } from "../../roon/BrowseService";
import {
  BrowseSessionCoordinator,
  BrowseSessionCoordinatorError,
  CatalogCountSessionHandle,
  CatalogSessionHandle,
} from "../../roon/BrowseSessionCoordinator";
import { CoreUnpairedError, RoonBrowseError } from "../../roon/errors";
import type { BrowseItem, BrowseResult } from "../../../shared/types";
import { parseRoonArtistAlbumCount } from "../../../shared/libraryRootsContracts";
import { LibraryReadPacing } from "../LibraryReadPacing";
import { LiveLibrarySession } from "../LiveLibrarySession";
import type { LibraryInvalidation, LibraryLevelHold } from "../LibrarySource";

/**
 * Scripted Roon, in the shape the live Core actually answers with
 * (`.agents/state.md` 2026-09-03): every root row carries an item key and
 * `hint: "list"`, no row carries an `item_type`, no row is playable, every
 * Artists row's subtitle is its own album count, and every Albums row's
 * subtitle is its credit. Names are invented; the owner's library data lives
 * in no test.
 */
const CORE_ID = "core-live-1";

function artistRow(index: number, over: Partial<BrowseItem> = {}): BrowseItem {
  return {
    title: `Invented Artist ${index}`,
    subtitle: `${index} Albums`,
    itemKey: `artist-key-${index}`,
    hint: "list",
    imageKey: `artist-image-${index}`,
    isLoadable: true,
    isPlayable: false,
    ...over,
  };
}

function albumRow(index: number, over: Partial<BrowseItem> = {}): BrowseItem {
  return {
    title: `Invented Album ${index}`,
    subtitle: `Invented Artist ${index}`,
    itemKey: `album-key-${index}`,
    hint: "list",
    imageKey: `album-image-${index}`,
    isLoadable: true,
    isPlayable: false,
    ...over,
  };
}

interface Script {
  artists: BrowseItem[];
  albums: BrowseItem[];
  genres: BrowseItem[];
  composers: BrowseItem[];
  /**
   * What Roon renders under one item key. Keyed by the key, because that is
   * exactly how the live Core answers: a browse carrying an item key continues
   * from that row, and the probe confirmed on 2026-09-03 that a key stays good
   * after the session has been elsewhere.
   */
  levels: Map<string, { title: string; subtitle?: string; items: BrowseItem[] }>;
}

/** Roon's own verb row: `action_list`, no subtitle. Live shape, 2026-09-03. */
function verbRow(title: string): BrowseItem {
  return {
    title,
    itemKey: `verb-key-${title.replace(/\s+/gu, "-").toLowerCase()}`,
    hint: "action_list",
    isLoadable: true,
    isPlayable: false,
  };
}

/** An ordinary navigable row: Roon's `list` hint. */
function listRow(title: string, itemKey: string, subtitle?: string): BrowseItem {
  return {
    title,
    itemKey,
    hint: "list",
    isLoadable: true,
    isPlayable: false,
    ...(subtitle === undefined ? {} : { subtitle }),
  };
}

/** A track row: `action_list` like the verb row, but credited. */
function trackRow(index: number, over: Partial<BrowseItem> = {}): BrowseItem {
  return {
    title: `${index}. Invented Song ${index}`,
    subtitle: "Invented Artist 1",
    itemKey: `track-key-${index}`,
    hint: "action_list",
    isLoadable: true,
    isPlayable: false,
    ...over,
  };
}

function page(
  hierarchy: string,
  rows: readonly BrowseItem[],
  offset: number,
  count: number
): BrowseResult {
  return {
    title: hierarchy,
    level: 0,
    offset,
    count: rows.length,
    totalCount: rows.length,
    items: rows.slice(offset, offset + count),
  };
}

describe("LiveLibrarySession", () => {
  const logger = pino({ level: "silent" });
  let script: Script;
  let service: { browse: jest.Mock; load: jest.Mock; pop: jest.Mock; reRoot: jest.Mock };
  let coordinator: BrowseSessionCoordinator;
  let handle: CatalogSessionHandle;
  let countHandle: CatalogCountSessionHandle;
  let pacing: LibraryReadPacing;
  let timerHandlers: Array<() => void>;
  let now: number;

  beforeEach(() => {
    now = 1_000;
    timerHandlers = [];
    script = {
      artists: [artistRow(1), artistRow(2), artistRow(3)],
      albums: [albumRow(1), albumRow(2)],
      genres: [],
      composers: [],
      levels: new Map(),
    };
    // Roon's browse session has a current level, and `load` continues THAT
    // level rather than a hierarchy. The fake keeps the same state so a level
    // read here has to be as careful about ordering as the real one is.
    let current: { title: string; subtitle?: string; items: BrowseItem[] } = {
      title: "artists",
      items: [],
    };
    const rootOf = (hierarchy: keyof Script): BrowseItem[] => {
      const rows = script[hierarchy];
      return Array.isArray(rows) ? rows : [];
    };
    service = {
      browse: jest.fn(async (options: Record<string, unknown>) => {
        const hierarchy = options.hierarchy as keyof Script;
        const itemKey = options.itemKey as string | undefined;
        if (itemKey !== undefined) {
          const level = script.levels.get(itemKey);
          if (level === undefined) {
            throw new Error(`no level scripted for ${itemKey}`);
          }
          current = level;
        } else {
          current = { title: String(hierarchy), items: rootOf(hierarchy) };
        }
        const size = (options.pageSize as number | undefined) ?? 100;
        const result = page(current.title, current.items, 0, size);
        return current.subtitle === undefined
          ? result
          : { ...result, subtitle: current.subtitle };
      }),
      load: jest.fn(async (options: Record<string, unknown>) => {
        return page(
          current.title,
          current.items,
          options.offset as number,
          options.count as number
        );
      }),
      pop: jest.fn(),
      reRoot: jest.fn().mockResolvedValue(undefined),
    };
    coordinator = new BrowseSessionCoordinator(
      service as unknown as BrowseService
    );
    handle = coordinator.acquireCatalog(CORE_ID);
    countHandle = coordinator.acquireCatalogCount(CORE_ID);
    pacing = new LibraryReadPacing({});
  });

  afterEach(() => {
    coordinator.shutdown();
  });

  function makeSession(
    overrides: { refreshIntervalMs?: number; maxOpenLevels?: number } = {}
  ) {
    return new LiveLibrarySession({
      runBrowse: (coreId, work) =>
        coordinator.runCatalog(coreId, handle, work),
      runCountBrowse: (coreId, work) =>
        coordinator.runCatalogCount(coreId, countHandle, work),
      publication: coordinator,
      pacing,
      logger,
      now: () => now,
      ...(overrides.refreshIntervalMs !== undefined
        ? { refreshIntervalMs: overrides.refreshIntervalMs }
        : {}),
      ...(overrides.maxOpenLevels !== undefined
        ? { maxOpenLevels: overrides.maxOpenLevels }
        : {}),
      timers: {
        setInterval: (handler) => {
          timerHandlers.push(handler);
          return 0 as unknown as NodeJS.Timeout;
        },
        clearInterval: () => undefined,
      },
    });
  }

  it("reads both roots and publishes one reference for every row", async () => {
    const session = makeSession();
    const outcome = await session.roots("first-read");
    expect(outcome.kind).toBe("unavailable");

    session.connect(CORE_ID);
    const ready = await session.roots("first-read");
    if (ready.kind !== "snapshot") throw new Error(ready.message);

    expect(ready.snapshot.artists.count).toBe(3);
    expect(ready.snapshot.albums.count).toBe(2);
    expect(ready.snapshot.artists.rows).toHaveLength(3);
    expect(ready.snapshot.albums.rows).toHaveLength(2);
    // Roon's own text, verbatim, in Roon's own order.
    expect(ready.snapshot.artists.rows.map((row) => row.title)).toEqual([
      "Invented Artist 1",
      "Invented Artist 2",
      "Invented Artist 3",
    ]);
    // Every reference belongs to this snapshot, and no two rows share one.
    const tokens = [
      ...ready.snapshot.artists.rows,
      ...ready.snapshot.albums.rows,
    ].map((row) => {
      expect(row.ref.generation).toBe(ready.snapshot.generation);
      return row.ref.token;
    });
    expect(new Set(tokens).size).toBe(5);
  });

  it("never lets a raw Roon item key reach the snapshot", async () => {
    const session = makeSession();
    session.connect(CORE_ID);
    const ready = await session.roots("first-read");
    if (ready.kind !== "snapshot") throw new Error(ready.message);
    // The whole published object, searched for any key the script minted.
    const serialized = JSON.stringify(ready.snapshot);
    for (const item of [...script.artists, ...script.albums]) {
      expect(serialized).not.toContain(item.itemKey as string);
    }
  });

  it("carries Roon's own subtitle, which is where an artist's count comes from", async () => {
    const session = makeSession();
    session.connect(CORE_ID);
    const ready = await session.roots("first-read");
    if (ready.kind !== "snapshot") throw new Error(ready.message);
    expect(ready.snapshot.artists.rows[2].subtitle).toBe("3 Albums");
    expect(
      parseRoonArtistAlbumCount(ready.snapshot.artists.rows[2].subtitle)
    ).toBe(3);
    // An Albums row's subtitle is a credit, not a count; nothing here
    // interprets it, and nothing joins it to an artist row.
    expect(ready.snapshot.albums.rows[0].subtitle).toBe("Invented Artist 1");
  });

  it("reads both roots inside one serialized transaction", async () => {
    const session = makeSession();
    session.connect(CORE_ID);
    await session.roots("first-read");
    const calls = [...service.browse.mock.calls, ...service.load.mock.calls].map(
      (call) => call[0] as Record<string, unknown>
    );
    expect(calls.length).toBeGreaterThan(1);
    const keys = new Set(calls.map((params) => params.multiSessionKey));
    // One session name across every call of both roots: the reads share one
    // coordinator transaction rather than racing two tails.
    expect(keys.size).toBe(1);
    expect(typeof [...keys][0]).toBe("string");
  });

  it("refuses a reference held from before a refresh, and resolves the new one", async () => {
    const session = makeSession();
    session.connect(CORE_ID);
    const first = await session.roots("first-read");
    if (first.kind !== "snapshot") throw new Error(first.message);
    const heldRow = first.snapshot.artists.rows[0];

    // Before the refresh the reference resolves to the row that minted it.
    expect(session.resolve(heldRow.ref).itemKey).toBe("artist-key-1");

    const second = await session.refresh("user-refresh");
    if (second.kind !== "snapshot") throw new Error(second.message);
    expect(second.snapshot.generation).not.toBe(first.snapshot.generation);

    // Every reference from the retired generation is dead — not just the ones
    // whose rows changed, and not just the first one asked about.
    for (const row of first.snapshot.artists.rows) {
      expect(() => session.resolve(row.ref)).toThrow(
        BrowseSessionCoordinatorError
      );
    }
    expect(() => session.resolve(heldRow.ref)).toThrow(/retired/u);

    // And the fresh reference for the same row resolves.
    expect(session.resolve(second.snapshot.artists.rows[0].ref).itemKey).toBe(
      "artist-key-1"
    );
  });

  // `.agents/plans/library-live-view.md` Slice 2. An action on a live row needs
  // three things the reference alone does not carry: which channel minted the
  // key, which publication it belongs to, and whether that publication is still
  // the live one.
  describe("resolveActionSubject(ref)", () => {
    it("carries the anchor, the hierarchy and the key of the row itself", async () => {
      const session = makeSession();
      session.connect(CORE_ID);
      const first = await session.roots("first-read");
      if (first.kind !== "snapshot") throw new Error(first.message);
      const row = first.snapshot.artists.rows[0];

      const subject = session.resolveActionSubject(row.ref);

      expect(subject).toEqual({
        anchor: {
          sessionScope: expect.any(String),
          authorityGeneration: expect.any(Number),
        },
        generation: first.snapshot.generation,
        hierarchy: "artists",
        itemKey: "artist-key-1",
        title: row.title,
        kind: "artist",
      });
      expect(session.isActionSubjectCurrent(subject)).toBe(true);
    });

    it("refuses a reference from a retired snapshot rather than answering approximately", async () => {
      const session = makeSession();
      session.connect(CORE_ID);
      const first = await session.roots("first-read");
      if (first.kind !== "snapshot") throw new Error(first.message);
      const held = session.resolveActionSubject(first.snapshot.artists.rows[0].ref);

      const second = await session.refresh("user-refresh");
      if (second.kind !== "snapshot") throw new Error(second.message);

      // Both halves matter: a reference held across the refresh cannot be
      // resolved at all, and a subject resolved before it stops being current
      // — which is what stands between a mid-action refresh and playing the
      // wrong album.
      expect(() =>
        session.resolveActionSubject(first.snapshot.artists.rows[0].ref)
      ).toThrow(/retired/u);
      expect(session.isActionSubjectCurrent(held)).toBe(false);
      expect(
        session.isActionSubjectCurrent(
          session.resolveActionSubject(second.snapshot.artists.rows[0].ref)
        )
      ).toBe(true);
    });

    it("refuses a token this generation never published", async () => {
      const session = makeSession();
      session.connect(CORE_ID);
      const first = await session.roots("first-read");
      if (first.kind !== "snapshot") throw new Error(first.message);

      expect(() =>
        session.resolveActionSubject({
          generation: first.snapshot.generation,
          token: "invented-token",
        })
      ).toThrow(BrowseSessionCoordinatorError);
    });

  });

  it("tells listeners which generation died, and why", async () => {
    const session = makeSession();
    const events: LibraryInvalidation[] = [];
    session.onInvalidated((event) => events.push(event));
    session.connect(CORE_ID);
    const first = await session.roots("first-read");
    if (first.kind !== "snapshot") throw new Error(first.message);
    await session.refresh("user-refresh");
    session.disconnect("core-lost");

    expect(events.map((event) => event.reason)).toEqual([
      "connect",
      "refresh",
      "core-lost",
    ]);
    expect(events[1].retired).toBe(first.snapshot.generation);
    expect(session.current()).toBeNull();
  });

  it("stops reading when the Core is under pressure, and keeps what it has", async () => {
    const session = makeSession();
    session.connect(CORE_ID);
    const first = await session.roots("first-read");
    if (first.kind !== "snapshot") throw new Error(first.message);
    const callsBefore = service.browse.mock.calls.length;

    // A breaker trip is how a tripped canary reaches this workload.
    pacing.onCorePaired(CORE_ID);
    pacing.onBreakerOpen(CORE_ID);

    const refused = await session.refresh("timer");
    expect(refused).toEqual({
      kind: "unavailable",
      reason: "core-under-pressure",
      message: expect.any(String),
    });
    expect(service.browse.mock.calls.length).toBe(callsBefore);
    // The snapshot the reader already had is untouched, and so are its
    // references: sparing the Core must not blank the library.
    expect(session.current()?.generation).toBe(first.snapshot.generation);
    expect(session.resolve(first.snapshot.artists.rows[0].ref).itemKey).toBe(
      "artist-key-1"
    );
  });

  it("leaves the previous snapshot whole when a refresh fails", async () => {
    const session = makeSession();
    session.connect(CORE_ID);
    const first = await session.roots("first-read");
    if (first.kind !== "snapshot") throw new Error(first.message);

    // The Albums root goes quiet halfway through the refresh — the exact case
    // that makes retire-first wrong. The Artists root is read first and
    // succeeds, so this is a refresh that has already spent real work when it
    // fails, not one that never started.
    const scripted = service.browse.getMockImplementation();
    service.browse.mockImplementation(async (options: Record<string, unknown>) => {
      if (options.hierarchy === "albums") throw new Error("Roon went quiet");
      return scripted!(options);
    });
    const outcome = await session.refresh("user-refresh");
    service.browse.mockImplementation(scripted!);

    if (outcome.kind !== "snapshot") throw new Error("the old snapshot was lost");
    expect(outcome.snapshot.generation).toBe(first.snapshot.generation);
    expect(session.current()?.generation).toBe(first.snapshot.generation);
    // Still usable: every reference the reader holds still resolves.
    for (const row of first.snapshot.artists.rows) {
      expect(session.resolve(row.ref).itemKey).toMatch(/^artist-key-/u);
    }
  });

  it("drops the snapshot when the browse session itself is gone", async () => {
    const session = makeSession();
    session.connect(CORE_ID);
    await session.roots("first-read");
    service.browse.mockRejectedValueOnce(new CoreUnpairedError("gone"));
    const outcome = await session.refresh("user-refresh");
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "read-failed",
      message: expect.any(String),
    });
    expect(session.current()).toBeNull();
  });

  it("checks the counts before re-reading, and re-reads only when one moved", async () => {
    const session = makeSession();
    session.connect(CORE_ID);
    const first = await session.roots("first-read");
    if (first.kind !== "snapshot") throw new Error(first.message);
    const loadsAfterRead = service.load.mock.calls.length;

    const unchanged = await session.revalidate("timer");
    if (unchanged.kind !== "snapshot") throw new Error(unchanged.message);
    // Same generation, and not one page loaded: the check asked each root for
    // its own count and stopped there.
    expect(unchanged.snapshot.generation).toBe(first.snapshot.generation);
    expect(service.load.mock.calls.length).toBe(loadsAfterRead);

    script.albums = [...script.albums, albumRow(3)];
    const changed = await session.revalidate("timer");
    if (changed.kind !== "snapshot") throw new Error(changed.message);
    expect(changed.snapshot.generation).not.toBe(first.snapshot.generation);
    expect(changed.snapshot.albums.count).toBe(3);
  });

  it("checks counts on a separate session and leaves a published reference openable", async () => {
    // Without `refresh_list` the Core may answer from the list it already had
    // open, and a check that cannot see a change is not a check.
    const session = makeSession();
    session.connect(CORE_ID);
    const first = await session.roots("first-read");
    if (first.kind !== "snapshot") throw new Error(first.message);
    const held = first.snapshot.artists.rows[0].ref;
    const publicationScope = session.resolveActionSubject(held).anchor.sessionScope;
    service.browse.mockClear();
    await session.revalidate("timer");
    // Both flags, on both roots. `popAll` because the catalog session is
    // shared and may be sitting anywhere, so a check without it could report
    // some other level's count; `refresh` because without it the Core may
    // answer from the list it already had open, and a check that cannot see a
    // change is not a check. (`BrowseService` turns the pair into a navigating
    // browse plus a refresh of the list it lands on; that mapping is its own
    // tested behaviour, and this asserts the intent that drives it.)
    for (const hierarchy of ["artists", "albums"]) {
      const calls = service.browse.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((params) => params.hierarchy === hierarchy);
      expect(calls).toHaveLength(1);
      expect(calls[0].popAll).toBe(true);
      expect(calls[0].refresh).toBe(true);
      expect(calls[0].pageSize).toBe(1);
      expect(calls[0].multiSessionKey).not.toBe(publicationScope);
    }

    script.levels.set("artist-key-1", {
      title: "Invented Artist 1",
      items: [verbRow("Play Artist")],
    });
    const opened = await session.open(held);
    expect(opened.kind).toBe("level");
    const openCall = service.browse.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((params) => params.itemKey === "artist-key-1");
    expect(openCall?.multiSessionKey).toBe(publicationScope);
  });

  it("keeps the snapshot when the count check itself fails", async () => {
    const session = makeSession();
    session.connect(CORE_ID);
    const first = await session.roots("first-read");
    if (first.kind !== "snapshot") throw new Error(first.message);
    service.browse.mockRejectedValueOnce(new Error("no answer"));
    const outcome = await session.revalidate("timer");
    if (outcome.kind !== "snapshot") throw new Error(outcome.message);
    expect(outcome.snapshot.generation).toBe(first.snapshot.generation);
  });

  it("revalidates on its own schedule", async () => {
    const session = makeSession({ refreshIntervalMs: 1_000 });
    session.connect(CORE_ID);
    const first = await session.roots("first-read");
    if (first.kind !== "snapshot") throw new Error(first.message);
    expect(timerHandlers).toHaveLength(1);

    script.artists = [...script.artists, artistRow(4)];
    timerHandlers[0]();
    await flush();
    expect(session.current()?.artists.count).toBe(4);
    expect(session.current()?.generation).not.toBe(first.snapshot.generation);
  });

  it("pages a root that does not fit in one load", async () => {
    script.artists = Array.from({ length: 250 }, (_, index) =>
      artistRow(index + 1)
    );
    const session = makeSession();
    session.connect(CORE_ID);
    const ready = await session.roots("first-read");
    if (ready.kind !== "snapshot") throw new Error(ready.message);
    expect(ready.snapshot.artists.count).toBe(250);
    expect(ready.snapshot.artists.rows).toHaveLength(250);
    expect(new Set(ready.snapshot.artists.rows.map((row) => row.ref.token)).size)
      .toBe(250);
    // Rows arrive in Roon's order across page boundaries, not page by page in
    // whatever order the loads settled.
    expect(ready.snapshot.artists.rows[99].title).toBe("Invented Artist 100");
    expect(ready.snapshot.artists.rows[100].title).toBe("Invented Artist 101");
  });

  it("shares one read between callers that ask together", async () => {
    const session = makeSession();
    session.connect(CORE_ID);
    const [a, b] = await Promise.all([
      session.roots("first-read"),
      session.roots("scope-activation"),
    ]);
    if (a.kind !== "snapshot" || b.kind !== "snapshot") {
      throw new Error("expected both callers to get the snapshot");
    }
    expect(a.snapshot.generation).toBe(b.snapshot.generation);
    // One read of each root, not two.
    expect(
      service.browse.mock.calls.filter(
        (call) => (call[0] as Record<string, unknown>).hierarchy === "artists"
      )
    ).toHaveLength(1);
  });

  describe("open(ref)", () => {
    /** Roon's live artist level: a verb row, then the artist's own albums. */
    function scriptArtistLevel(): void {
      script.levels.set("artist-key-1", {
        title: "Invented Artist 1",
        items: [
          verbRow("Play Artist"),
          {
            ...listRow("Invented Album A", "artist-album-key-a", "Invented Artist 1"),
            imageKey: "image-a",
          },
          listRow("Invented Album B", "artist-album-key-b", "Invented Artist 1"),
        ],
      });
      script.levels.set("artist-album-key-a", {
        title: "Invented Album A",
        subtitle: "Invented Artist 1",
        items: [verbRow("Play Album"), trackRow(1), trackRow(2)],
      });
    }

    async function openedArtist(session: LiveLibrarySession) {
      const ready = await session.roots("first-read");
      if (ready.kind !== "snapshot") throw new Error("no snapshot");
      const outcome = await session.open(ready.snapshot.artists.rows[0].ref);
      if (outcome.kind !== "level") {
        throw new Error(`expected a level, got ${outcome.kind}`);
      }
      return { snapshot: ready.snapshot, level: outcome.level };
    }

    it("names a level's own rows as action subjects on the hierarchy they were walked on", async () => {
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const { snapshot, level } = await openedArtist(session);

      // Both the verb row and an album row are subjects in their own right:
      // measured on the owner's Core, each answers with its own action leaves.
      const verb = session.resolveActionSubject(level.rows[0].ref);
      const album = session.resolveActionSubject(level.rows[1].ref);

      expect(verb).toMatchObject({
        hierarchy: "artists",
        kind: "action",
        title: "Play Artist",
      });
      expect(album).toMatchObject({
        hierarchy: "artists",
        kind: "album",
        itemKey: "artist-album-key-a",
        title: "Invented Album A",
        generation: snapshot.generation,
      });
      // A level's rows belong to the same publication as the roots, so one
      // retirement kills them together.
      expect(album.anchor).toEqual(
        session.resolveActionSubject(snapshot.artists.rows[0].ref).anchor
      );
    });

    it("reads the level Roon renders under a row, naming each kind from the path", async () => {
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const { level } = await openedArtist(session);

      // Roon's own heading for the level, not what the client thought it
      // clicked.
      expect(level.title).toBe("Invented Artist 1");
      expect(level.count).toBe(3);
      expect(level.rows.map((row) => row.kind)).toEqual([
        "action",
        "album",
        "album",
      ]);
      expect(level.rows[1].title).toBe("Invented Album A");
      expect(level.rows[1].subtitle).toBe("Invented Artist 1");
      expect(level.rows[1].imageKey).toBe("image-a");
    });

    it("publishes the level into the SAME generation, leaving the roots alive", async () => {
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const { snapshot, level } = await openedArtist(session);

      expect(level.generation).toBe(snapshot.generation);
      // The whole point of appending rather than replacing: the list the
      // reader came from still resolves after they opened something in it.
      for (const row of snapshot.artists.rows) {
        expect(session.resolve(row.ref).itemKey).toContain("artist-key-");
      }
      for (const row of snapshot.albums.rows) {
        expect(() => session.resolve(row.ref)).not.toThrow();
      }
      expect(session.resolve(level.rows[1].ref).itemKey).toBe(
        "artist-album-key-a"
      );
    });

    it("descends: the album row opens onto its own tracks", async () => {
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const { level } = await openedArtist(session);
      const opened = await session.open(level.rows[1].ref);
      if (opened.kind !== "level") throw new Error("expected a level");

      expect(opened.level.title).toBe("Invented Album A");
      expect(opened.level.subtitle).toBe("Invented Artist 1");
      expect(opened.level.rows.map((row) => row.kind)).toEqual([
        "action",
        "track",
        "track",
      ]);
      expect(opened.level.rows[1].title).toBe("1. Invented Song 1");
    });

    it("hands out no Roon item key, on any row of any level", async () => {
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const { level } = await openedArtist(session);
      const serialized = JSON.stringify(level);
      for (const item of script.levels.get("artist-key-1")!.items) {
        expect(serialized).not.toContain(item.itemKey as string);
      }
      expect(serialized).not.toContain("itemKey");
    });

    it("refuses a reference from a retired generation without reading anything", async () => {
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const first = await session.roots("first-read");
      if (first.kind !== "snapshot") throw new Error("no snapshot");
      const held = first.snapshot.artists.rows[0].ref;
      await session.refresh("user-refresh");

      const calls = service.browse.mock.calls.length;
      expect(await session.open(held)).toEqual({ kind: "stale" });
      // Nothing was asked of Roon: the reference was dead before the wire.
      expect(service.browse.mock.calls).toHaveLength(calls);
    });

    it("retires the snapshot when Roon says a held key is no longer valid", async () => {
      // Observed live 2026-09-03: after a pressure trip the Core answered
      // every held key with InvalidItemKey while the snapshot stayed
      // installed, so every row on screen "could not open" indefinitely.
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const first = await session.roots("first-read");
      if (first.kind !== "snapshot") throw new Error("no snapshot");
      const held = first.snapshot.artists.rows[0].ref;

      service.browse.mockRejectedValueOnce(new RoonBrowseError("browse", "InvalidItemKey"));
      const outcome = await session.open(held);

      expect(outcome.kind).not.toBe("level");
      // The generation that published the dead key is gone, so the next read
      // installs a fresh one and the page can re-resolve onto live keys.
      expect(session.current()).toBeNull();
      const again = await session.roots("scope-activation");
      if (again.kind !== "snapshot") throw new Error("no snapshot after retire");
      expect(again.snapshot.generation).not.toBe(first.snapshot.generation);
    });

    it("keeps the snapshot when a level read fails for a reason that says nothing about keys", async () => {
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const first = await session.roots("first-read");
      if (first.kind !== "snapshot") throw new Error("no snapshot");

      service.browse.mockRejectedValueOnce(new RoonBrowseError("browse", "SomethingElse"));
      await session.open(first.snapshot.artists.rows[0].ref);

      expect(session.current()?.generation).toBe(first.snapshot.generation);
    });

    it("refuses a live token carried under a generation that is not its own", async () => {
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const ready = await session.roots("first-read");
      if (ready.kind !== "snapshot") throw new Error("no snapshot");
      const live = ready.snapshot.artists.rows[0].ref;

      // Both halves are required, and the token is not a password that works
      // on whichever generation happens to be current. A reader holding a
      // token from a snapshot it has forgotten the name of is holding nothing.
      const calls = service.browse.mock.calls.length;
      expect(
        await session.open({ generation: "some-other-generation", token: live.token })
      ).toEqual({ kind: "stale" });
      expect(service.browse.mock.calls).toHaveLength(calls);
      // And the same token under its own generation still opens.
      expect((await session.open(live)).kind).toBe("level");
    });

    it("refuses a token that names no row in the generation it claims", async () => {
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const ready = await session.roots("first-read");
      if (ready.kind !== "snapshot") throw new Error("no snapshot");
      expect(
        await session.open({
          generation: ready.snapshot.generation,
          token: "library-row-invented-1",
        })
      ).toEqual({ kind: "stale" });
    });

    it("reads an on-demand root as a level, and its rows open like any other", async () => {
      script.genres = [
        listRow("Invented Genre", "genre-key-1", "12 Artists, 40 Albums"),
      ];
      script.levels.set("genre-key-1", {
        title: "Invented Genre",
        items: [
          verbRow("Play Genre"),
          listRow("Artists", "genre-artists"),
          listRow("Albums", "genre-albums"),
          listRow("Invented Subgenre", "subgenre-key", "3 Artists, 9 Albums"),
        ],
      });
      script.levels.set("genre-albums", {
        title: "Albums",
        items: [
          listRow("Invented Album C", "genre-album-c", "Invented Artist 2"),
        ],
      });
      const session = makeSession();
      session.connect(CORE_ID);
      await session.roots("first-read");

      const root = await session.openRoot("genres");
      if (root.kind !== "level") throw new Error("expected a level");
      expect(root.level.rows[0].kind).toBe("genre");

      const node = await session.open(root.level.rows[0].ref);
      if (node.kind !== "level") throw new Error("expected a level");
      // Roon's own structural children, told apart from the subgenres.
      expect(node.level.rows.map((row) => row.kind)).toEqual([
        "action",
        "section",
        "section",
        "genre",
      ]);

      const albums = await session.open(node.level.rows[2].ref);
      if (albums.kind !== "level") throw new Error("expected a level");
      // The "Albums" section's own label is what says these are albums.
      expect(albums.level.rows[0].kind).toBe("album");
      expect(albums.level.rows[0].title).toBe("Invented Album C");
    });

    it("refuses to read a level while the Core is being spared", async () => {
      scriptArtistLevel();
      const session = makeSession();
      session.connect(CORE_ID);
      const ready = await session.roots("first-read");
      if (ready.kind !== "snapshot") throw new Error("no snapshot");
      pacing.onBreakerOpen(CORE_ID);

      const outcome = await session.open(ready.snapshot.artists.rows[0].ref);
      expect(outcome).toEqual({
        kind: "unavailable",
        reason: "core-under-pressure",
        message:
          "The Roon Core is being given a rest; the library will open again shortly.",
      });
    });

    it("keeps the roots alive while dropping the oldest levels past the bound", async () => {
      // One level per artist row, so the bound can be crossed by opening.
      for (let index = 1; index <= 3; index += 1) {
        script.levels.set(`artist-key-${index}`, {
          title: `Invented Artist ${index}`,
          items: [verbRow("Play Artist"), trackRow(index)],
        });
      }
      const session = makeSession({ maxOpenLevels: 2 });
      session.connect(CORE_ID);
      const ready = await session.roots("first-read");
      if (ready.kind !== "snapshot") throw new Error("no snapshot");

      const levels: LibraryLevelHold[] = [];
      for (const row of ready.snapshot.artists.rows) {
        const outcome = await session.open(row.ref);
        if (outcome.kind !== "level") throw new Error("expected a level");
        levels.push(outcome.level);
      }

      // The oldest opened level is gone; the two most recent are alive.
      expect(() => session.resolve(levels[0].rows[1].ref)).toThrow(
        BrowseSessionCoordinatorError
      );
      expect(session.resolve(levels[1].rows[1].ref).itemKey).toBe("track-key-2");
      expect(session.resolve(levels[2].rows[1].ref).itemKey).toBe("track-key-3");
      // And the roots, which are never evicted, still resolve.
      for (const row of ready.snapshot.artists.rows) {
        expect(() => session.resolve(row.ref)).not.toThrow();
      }
      // A dropped reference is the same news as a dead generation.
      expect(await session.open(levels[0].rows[1].ref)).toEqual({
        kind: "stale",
      });
    });
  });

  describe("preview(ref, limit)", () => {
    async function prepared(title = "Albums", count = 10000, maxOpenLevels = 32) {
      script.genres = [listRow("80s", "genre-80s")];
      script.levels.set("genre-80s", { title: "80s", items: [
        verbRow("Play Genre"), listRow("Artists", "preview-artists"), listRow("Albums", "preview-albums")
      ] });
      script.levels.set("preview-artists", { title: "Artists", items: Array.from({ length: count }, (_, i) => artistRow(i)) });
      script.levels.set("preview-albums", { title: "Albums", items: Array.from({ length: count }, (_, i) => albumRow(i)) });
      const session = makeSession({ maxOpenLevels });
      session.connect(CORE_ID);
      await session.roots("first-read");
      const root = await session.openRoot("genres");
      if (root.kind !== "level") throw new Error("no genre root");
      const genre = await session.open(root.level.rows[0].ref);
      if (genre.kind !== "level") throw new Error("no genre");
      const ref = genre.level.rows.find(row => row.title === title)!.ref;
      service.browse.mockClear(); service.load.mockClear();
      return { session, ref, root, genre };
    }

    it.each([
      ["Albums", 0, 1], ["Albums", 1, 100], ["Albums", 17, 1],
      ["Albums", 10000, 100], ["Artists", 10000, 1], ["Artists", 17, 100]
    ] as const)("reads only a bounded %s prefix (total %i, limit %i)", async (title, count, limit) => {
      const { session, ref } = await prepared(title, count);
      const begin = jest.spyOn(pacing, "begin");
      const settle = jest.spyOn(pacing, "settle");
      const result = await session.preview(ref, limit);
      expect(result.kind).toBe("preview");
      if (result.kind !== "preview") throw new Error("not a preview");
      expect(result.preview.totalCount).toBe(count);
      expect(result.preview.limit).toBe(limit);
      expect(result.preview.rows).toHaveLength(Math.min(count, limit));
      expect(service.browse).toHaveBeenCalledTimes(1);
      expect(service.browse.mock.calls[0][0]).toMatchObject({
        hierarchy: "genres", itemKey: title === "Albums" ? "preview-albums" : "preview-artists", offset: 0, pageSize: limit
      });
      expect(service.load).not.toHaveBeenCalled();
      expect(begin).toHaveBeenCalledWith(CORE_ID, "preview");
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle.mock.calls[0][1]).toBe("answered");
      for (const row of result.preview.rows) {
        expect(row.kind).toBe(title === "Albums" ? "album" : "artist");
        expect(row.ref.generation).toBe(ref.generation);
        expect(session.resolve(row.ref).title).toBe(row.title);
        expect(JSON.stringify(row)).not.toContain("-key-");
      }
    });

    it("More still drains a complete level, and same-title rows stay distinct", async () => {
      const { session, ref } = await prepared("Albums", 250);
      const rows = script.levels.get("preview-albums")!.items;
      rows[1] = { ...rows[1], title: rows[0].title };
      const result = await session.preview(ref, 2);
      if (result.kind !== "preview") throw new Error("not preview");
      expect(result.preview.rows[0].title).toBe(result.preview.rows[1].title);
      expect(result.preview.rows[0].ref.token).not.toBe(result.preview.rows[1].ref.token);
      expect(service.load).not.toHaveBeenCalled();
      const full = await session.open(ref);
      if (full.kind !== "level") throw new Error("not full");
      expect(full.level.rows).toHaveLength(250);
      expect(full.level.count).toBe(250);
      expect(service.load).toHaveBeenCalledTimes(2);
    });

    it.each([
      { totalCount: -1 }, { totalCount: 20001 }, { totalCount: 1.5 }, { totalCount: undefined },
      { offset: 1 }, { items: [albumRow(1)] }, { items: [albumRow(1), albumRow(1)] },
      { items: [albumRow(1), albumRow(2, { itemKey: "" })] },
      { items: [albumRow(1), albumRow(2, { itemKey: undefined })] },
      { items: [albumRow(1), verbRow("Play Album")] },
      { items: [albumRow(1), albumRow(2, { hint: "action" })] }
    ])("refuses corrupt prefix before publication: %j", async over => {
      const { session, ref } = await prepared("Albums", 17);
      const publish = jest.spyOn(coordinator, "appendCatalogPublishedItems");
      const settle = jest.spyOn(pacing, "settle");
      service.browse.mockResolvedValueOnce({ ...page("Albums", [albumRow(1), albumRow(2)], 0, 2), ...over });
      expect(await session.preview(ref, 2)).toMatchObject({ kind: "unavailable", reason: "read-failed" });
      expect(publish).not.toHaveBeenCalled();
      expect(service.load).not.toHaveBeenCalled();
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle.mock.calls[0][1]).toBe("failed");
    });

    it("refuses stale, forged, unsupported subjects and invalid limits before browsing", async () => {
      const { session, ref, root, genre } = await prepared();
      expect(await session.preview({ ...ref, generation: "old" }, 1)).toEqual({ kind: "stale" });
      expect(await session.preview({ ...ref, token: "forged" }, 1)).toEqual({ kind: "stale" });
      for (const subject of [root.level.rows[0].ref, genre.level.rows[0].ref, session.current()!.artists.rows[0].ref]) {
        expect(await session.preview(subject, 1)).toMatchObject({ kind: "unsupported" });
      }
      for (const limit of [0, 101, 1.1]) expect(await session.preview(ref, limit)).toMatchObject({ kind: "unsupported" });
      expect(service.browse).not.toHaveBeenCalled();
    });

    it("refuses under pressure without opening a session or beginning a ticket", async () => {
      const { session, ref } = await prepared();
      const begin = jest.spyOn(pacing, "begin");
      pacing.onBreakerOpen(CORE_ID);
      expect(await session.preview(ref, 1)).toMatchObject({ kind: "unavailable", reason: "core-under-pressure" });
      expect(begin).not.toHaveBeenCalled();
      expect(service.browse).not.toHaveBeenCalled();
    });

    it("checks ownership after the queued transaction is admitted, before any browse", async () => {
      const { session, ref } = await prepared();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const held = coordinator.runCatalog(CORE_ID, handle, async () => { await gate; });
      const result = session.preview(ref, 1);
      session.disconnect("core-lost");
      release(); await held;
      expect(await result).toEqual({ kind: "stale" });
      expect(service.browse).not.toHaveBeenCalled();
    });

    it.each(["disconnect", "authority"] as const)("fences %s loss during the prefix before publication", async loss => {
      const { session, ref } = await prepared();
      let release!: (value: BrowseResult) => void;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      service.browse.mockImplementationOnce(() => { entered(); return new Promise<BrowseResult>(resolve => { release = resolve; }); });
      const publish = jest.spyOn(coordinator, "appendCatalogPublishedItems");
      const settle = jest.spyOn(pacing, "settle");
      const result = session.preview(ref, 1);
      await started;
      if (loss === "disconnect") session.disconnect("core-lost");
      else {
        const scope = session.resolveActionSubject(ref).anchor.sessionScope;
        coordinator.beginCatalogPublication(scope);
      }
      release(page("Albums", [albumRow(1)], 0, 1));
      expect(await result).toEqual({ kind: "stale" });
      expect(publish).not.toHaveBeenCalled();
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it.each(["SESSION_LOST", "InvalidItemKey"] as const)("lost session keys (%s) retire the whole snapshot and settle the failed ticket", async reason => {
      const { session, ref } = await prepared();
      const settle = jest.spyOn(pacing, "settle");
      service.browse.mockRejectedValueOnce(reason === "SESSION_LOST" ?
        new BrowseSessionCoordinatorError("SESSION_LOST", "Gone") : new RoonBrowseError("browse", "InvalidItemKey"));
      expect(await session.preview(ref, 1)).toEqual({ kind: "stale" });
      expect(session.current()).toBeNull();
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it("rechecks ownership before answering even if publication completed", async () => {
      const { session, ref } = await prepared();
      const append = coordinator.appendCatalogPublishedItems.bind(coordinator);
      jest.spyOn(coordinator, "appendCatalogPublishedItems").mockImplementationOnce((...args) => {
        const result = append(...args);
        session.disconnect("core-lost");
        return result;
      });
      const settle = jest.spyOn(pacing, "settle");
      expect(await session.preview(ref, 1)).toEqual({ kind: "stale" });
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it("publication failure settles the ticket without claiming a prefix", async () => {
      const { session, ref } = await prepared();
      jest.spyOn(coordinator, "appendCatalogPublishedItems").mockImplementationOnce(() => { throw new Error("Publication refused"); });
      const settle = jest.spyOn(pacing, "settle");
      expect(await session.preview(ref, 1)).toMatchObject({ kind: "unavailable", reason: "read-failed" });
      expect(settle).toHaveBeenCalledTimes(1);
      expect(session.current()?.generation).toBe(ref.generation);
    });

    it("two prefix requests share the existing FIFO transaction and publication channel", async () => {
      const { session, ref, genre } = await prepared("Albums", 17);
      const artistsRef = genre.level.rows.find(row => row.title === "Artists")!.ref;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const browse = service.browse.getMockImplementation()!;
      service.browse.mockImplementationOnce(async (...args) => { entered(); await gate; return browse(...args); });
      const artists = session.preview(artistsRef, 2);
      await started;
      const albums = session.preview(ref, 2);
      await Promise.resolve();
      expect(service.browse).toHaveBeenCalledTimes(1);
      release();
      expect((await artists).kind).toBe("preview");
      expect((await albums).kind).toBe("preview");
      expect(service.browse.mock.calls.map(call => call[0].itemKey)).toEqual(["preview-artists", "preview-albums"]);
      expect(new Set(service.browse.mock.calls.map(call => call[0].multiSessionKey)).size).toBe(1);
      expect(service.load).not.toHaveBeenCalled();
    });

    it("prefix tokens share complete-level eviction and never open an approximate row", async () => {
      const { session, ref } = await prepared("Albums", 2, 3);
      const result = await session.preview(ref, 1);
      if (result.kind !== "preview") throw new Error("not preview");
      const item = result.preview.rows[0].ref;
      expect(session.resolve(item).itemKey).toBe("album-key-0");
      for (let i = 0; i < 3; i++) await session.openRoot("genres");
      expect(() => session.resolve(item)).toThrow(BrowseSessionCoordinatorError);
      expect(await session.open(item)).toEqual({ kind: "stale" });
      expect(session.resolve(session.current()!.artists.rows[0].ref)).toBeDefined();
    });
  });

  /**
   * The scheduled read is deliberately fire-and-forget — a timer has nobody to
   * hand a promise to — so the test waits for the queue rather than for a
   * handle the production path does not keep.
   */
  async function flush(): Promise<void> {
    for (let turn = 0; turn < 4; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
});
