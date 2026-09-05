import { Logger } from "pino";

import {
  LibraryAlbumCollectionResolverPort,
  LibraryAlbumCoordinatorPort,
  LibraryAlbumOrigin,
  LibraryAlbumService,
} from "../LibraryAlbumService";
import {
  ActionSessionAccess,
  ActionSessionHandle,
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
} from "../BrowseSessionCoordinator";
import { RoonTimeoutError } from "../errors";
import { CollectionDrillResolution } from "../CollectionDrillResolver";
import {
  COLLECTION_DRILL_SOURCE_CONTRACT,
  CollectionDrillOpenLocator,
} from "../../../shared/collectionDrillContracts";
import {
  LibraryAlbumFailedEvent,
  LibraryAlbumOpenRequest,
  LibraryAlbumResolvedEvent,
  LibraryAlbumVersionFailedEvent,
  LibraryAlbumVersionsEvent,
} from "../../../shared/libraryAlbumContracts";

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

/**
 * The two live reads a collection page makes, faked as one unit — which is
 * how the real port is shaped, and for the same reason: the item key the
 * first returns is only usable inside the session that produced it.
 */
class FakeCollectionResolver implements LibraryAlbumCollectionResolverPort {
  public resolution: CollectionDrillResolution = {
    kind: "resolved",
    hierarchy: "genres",
    itemKey: "live-row-key",
    rendering: { exactTitle: "Harbour Lantern", exactCredit: "The Paper Fleet" },
  };
  public trackTitles: string[] = ["Tideline", "Cable Run"];
  public resolveCalls = 0;
  public detailCalls: { hierarchy: string; itemKey: string; title: string }[] = [];
  public assertCurrentCalls = 0;
  public resolveError: Error | null = null;

  public async resolve(
    _session: CoordinatedBrowseSession,
    _locator: Readonly<CollectionDrillOpenLocator>,
    options: { assertCurrent?: () => void } = {}
  ): Promise<CollectionDrillResolution> {
    this.resolveCalls += 1;
    // Every page boundary in the real resolver is a landing spot; the fake
    // takes exactly one so a test can close the page underneath it.
    options.assertCurrent?.();
    this.assertCurrentCalls += 1;
    if (this.resolveError) throw this.resolveError;
    return this.resolution;
  }

  public async readDetailRows(
    _session: CoordinatedBrowseSession,
    hierarchy: string,
    itemKey: string,
    expectedTitle: string
  ): Promise<string[]> {
    this.detailCalls.push({ hierarchy, itemKey, title: expectedTitle });
    return this.trackTitles;
  }
}

const COLLECTION_LOCATOR: CollectionDrillOpenLocator = {
  sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
  hierarchy: "genres",
  collectionExactName: "Bright Machinery",
  rendering: { exactTitle: "Harbour Lantern", exactCredit: "The Paper Fleet" },
};

const origin: LibraryAlbumOrigin = { coreId: "core-1", socketId: "socket-1" };

function request(
  patch: Partial<LibraryAlbumOpenRequest> = {}
): LibraryAlbumOpenRequest {
  return {
    requestId: "request-1",
    tabId: "tab-1",
    target: { kind: "collection", locator: COLLECTION_LOCATOR },
    generation: 7,
    ...patch,
  };
}

class FakeCoordinator implements LibraryAlbumCoordinatorPort {
  public acquireCalls = 0;
  public releaseCalls = 0;
  public quarantineCalls = 0;
  public runCalls = 0;
  public acquireError?: Error;
  public quarantineError?: Error;

  public acquireAction(): ActionSessionHandle {
    this.acquireCalls += 1;
    if (this.acquireError) throw this.acquireError;
    return { kind: "action", handleId: `handle-${this.acquireCalls}`, generation: 7 };
  }

  public runAction<T>(
    _access: ActionSessionAccess,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    this.runCalls += 1;
    const session: CoordinatedBrowseSession = {
      sessionScope: "action-session",
      browse: () => Promise.resolve({ level: 0, offset: 0, count: 0, items: [] }),
      load: () => Promise.resolve({ level: 0, offset: 0, count: 0, items: [] }),
      pop: () => Promise.resolve({ level: 1, offset: 0, count: 2, items: [] }),
    };
    return work(session);
  }

  public releaseAction(): Promise<void> {
    this.releaseCalls += 1;
    return Promise.resolve();
  }

  public quarantineAction(): void {
    this.quarantineCalls += 1;
    if (this.quarantineError) throw this.quarantineError;
  }
}

describe("LibraryAlbumService", () => {
  let coordinator: FakeCoordinator;
  let service: LibraryAlbumService;
  let versionsEvents: LibraryAlbumVersionsEvent[];
  let resolvedEvents: LibraryAlbumResolvedEvent[];
  let versionFailedEvents: LibraryAlbumVersionFailedEvent[];
  let failedEvents: LibraryAlbumFailedEvent[];
  let collectionResolver: FakeCollectionResolver;

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger;

  const sink = () => ({
    versions: (event: LibraryAlbumVersionsEvent) => versionsEvents.push(event),
    resolved: (event: LibraryAlbumResolvedEvent) => resolvedEvents.push(event),
    versionFailed: (event: LibraryAlbumVersionFailedEvent) =>
      versionFailedEvents.push(event),
    failed: (event: LibraryAlbumFailedEvent) => failedEvents.push(event),
  });

  beforeEach(() => {
    jest.useFakeTimers();
    collectionResolver = new FakeCollectionResolver();
    coordinator = new FakeCoordinator();
    versionsEvents = [];
    resolvedEvents = [];
    versionFailedEvents = [];
    failedEvents = [];
    let nonce = 0;
    service = new LibraryAlbumService(coordinator, logger, {
      resolvingTtlMs: 1_000,
      randomId: () => `opaque-${(nonce += 1)}`,
      collectionResolver,
    });
  });

  afterEach(() => {
    service.shutdown();
    jest.useRealTimers();
  });

  async function openPage(over: Partial<LibraryAlbumOpenRequest> = {}) {
    const reservation = service.open(origin, request(over), sink());
    expect(reservation.ack.success).toBe(true);
    reservation.start?.();
    await flush();
    return reservation;
  }

  async function select(versionId: string) {
    const versions = versionsEvents[versionsEvents.length - 1];
    if (!versions) throw new Error("page not open");
    const reservation = service.select(origin, {
      operationId: versions.operationId,
      versionId,
    });
    expect(reservation.ack.success).toBe(true);
    reservation.start?.();
    await flush();
    return reservation;
  }

  /**
   * Hangs the drill read at its one landing spot, so a test can retire or
   * outlast the page while the walk is genuinely in flight. The landing spot
   * runs on release, which is what makes a retired page stop there.
   */
  function hangingResolve(): { release: () => void } {
    let settle: () => void = () => {};
    collectionResolver.resolve = async (_session, _locator, options = {}) => {
      collectionResolver.resolveCalls += 1;
      await new Promise<void>((resolveFn) => {
        settle = resolveFn;
      });
      options.assertCurrent?.();
      return collectionResolver.resolution;
    };
    return { release: () => settle() };
  }

  describe("a page opened from a collection drill", () => {
    async function openCollection(
      locator: CollectionDrillOpenLocator = COLLECTION_LOCATOR
    ) {
      return openPage({ target: { kind: "collection", locator } });
    }

    it("resolves the locator and reads its detail in ONE session", async () => {
      await openCollection();

      expect(coordinator.runCalls).toBe(1);
      expect(collectionResolver.resolveCalls).toBe(1);
      expect(collectionResolver.detailCalls).toEqual([
        {
          hierarchy: "genres",
          itemKey: "live-row-key",
          title: "Harbour Lantern",
        },
      ]);
    });

    it("publishes exactly one version and answers its select from cache", async () => {
      await openCollection();

      expect(versionsEvents).toHaveLength(1);
      expect(versionsEvents[0].versions).toHaveLength(1);
      expect(versionsEvents[0].title).toBe("Harbour Lantern");
      expect(versionsEvents[0].artist).toBe("The Paper Fleet");

      const before = coordinator.runCalls;
      await select(versionsEvents[0].versions[0].versionId);
      // The drill row IS the version: its detail was read at open time, so a
      // select opens no second session.
      expect(coordinator.runCalls).toBe(before);
      expect(resolvedEvents).toHaveLength(1);
      expect(resolvedEvents[0].orderedTracks.map((track) => track.title)).toEqual([
        "Tideline",
        "Cable Run",
      ]);
    });

    it("carries NO artist when the drill row rendered no credit", async () => {
      collectionResolver.resolution = {
        kind: "resolved",
        hierarchy: "composers",
        itemKey: "live-row-key",
        rendering: { exactTitle: "Harbour Lantern", exactCredit: "" },
      };

      await openCollection({
        ...COLLECTION_LOCATOR,
        hierarchy: "composers",
        rendering: { exactTitle: "Harbour Lantern", exactCredit: "" },
      });

      // Absent, not blank, and above all not the composer's name: a composer
      // is not an artist and nothing may be substituted here.
      expect(versionsEvents[0]).not.toHaveProperty("artist");
      await select(versionsEvents[0].versions[0].versionId);
      expect(resolvedEvents[0]).not.toHaveProperty("artist");
    });

    it("leases actions against its locator, not a live key it does not hold", async () => {
      await openCollection();
      await select(versionsEvents[0].versions[0].versionId);

      // The page CAN act: the resolver re-walks this drill and reads the
      // album's own Play/Queue paths inside the hierarchy the row came from.
      expect(resolvedEvents[0].actionsAvailable).toBe(true);
      const authority = service.claimSelectedVersionAction(origin, {
        pageId: versionsEvents[0].operationId,
        versionId: resolvedEvents[0].versionId,
        tabId: "tab-1",
        generation: 7,
      });
      expect(authority?.source).toEqual({
        kind: "collection",
        source: {
          locator: COLLECTION_LOCATOR,
          detailDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      });
      // No live key travels with the lease: the session that resolved this row
      // was released when the read finished, and the locator is what the
      // action re-walks.
      expect(authority?.retainedItemKey).toBe("");
      expect(authority && service.isSelectedVersionActionCurrent(authority)).toBe(
        true
      );
      // A lease whose track list no longer matches what the page published is
      // not current, whatever else still lines up.
      expect(
        authority &&
          service.isSelectedVersionActionCurrent({
            ...authority,
            source: {
              kind: "collection",
              source: { locator: COLLECTION_LOCATOR, detailDigest: "moved" },
            },
          })
      ).toBe(false);
    });

    it.each([
      ["collection", "missing", 0, "ALBUM_NOT_FOUND"],
      ["collection", "ambiguous", 2, "ALBUM_AMBIGUOUS"],
      ["entry", "missing", 0, "ALBUM_NOT_FOUND"],
      ["entry", "ambiguous", 3, "ALBUM_AMBIGUOUS"],
    ] as const)(
      "reports a %s-stage %s refusal with the count it observed",
      async (stage, kind, matchCount, code) => {
        collectionResolver.resolution = { kind, stage, matchCount };

        await openCollection();

        expect(versionsEvents).toHaveLength(0);
        expect(failedEvents).toHaveLength(1);
        expect(failedEvents[0].code).toBe(code);
        expect(failedEvents[0].collectionFailure).toEqual({
          kind,
          stage,
          matchCount,
        });
      }
    );

    it("stops the walk when the page is cancelled underneath it", async () => {
      const walk = hangingResolve();

      const reservation = service.open(
        origin,
        request({ target: { kind: "collection", locator: COLLECTION_LOCATOR } }),
        sink()
      );
      reservation.start?.();
      await flush();
      service.cancel(origin, { operationId: reservation.ack.success ? reservation.ack.data.operationId : "" });
      walk.release();
      await flush();

      expect(collectionResolver.detailCalls).toEqual([]);
      expect(versionsEvents).toHaveLength(0);
    });

    it("issues action authority only for the current successfully selected version", async () => {
      await openCollection();
      const page = versionsEvents[0];
      const [only] = page.versions;
      const source = (versionId: string) => ({
        pageId: page.operationId,
        versionId,
        tabId: "tab-1",
        generation: 7,
      });

      expect(service.claimSelectedVersionAction(origin, source(only.versionId))).toBeNull();
      await select(only.versionId);
      const authority = service.claimSelectedVersionAction(
        origin,
        source(only.versionId)
      );
      expect(authority).toMatchObject({
        pageId: page.operationId,
        versionId: only.versionId,
        coreId: "core-1",
        socketId: "socket-1",
        generation: 7,
        source: { kind: "collection" },
      });
      expect(authority?.source.source.detailDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(authority && service.isSelectedVersionActionCurrent(authority)).toBe(true);
      if (!authority) throw new Error("Expected selected-version authority");
      expect(
        service.isSelectedVersionActionCurrent({
          ...authority,
          pageId: "foreign-page",
        })
      ).toBe(false);
      expect(
        service.isSelectedVersionActionCurrent({
          ...authority,
          versionId: "not-issued",
        })
      ).toBe(false);
      expect(
        service.isSelectedVersionActionCurrent({
          ...authority,
          coreId: "core-2",
        })
      ).toBe(false);
      expect(
        service.isSelectedVersionActionCurrent({
          ...authority,
          generation: 8,
        })
      ).toBe(false);
      expect(
        service.claimSelectedVersionAction(
          { coreId: "core-1", socketId: "socket-2" },
          source(only.versionId)
        )
      ).toBeNull();
      expect(
        service.claimSelectedVersionAction(origin, {
          ...source(only.versionId),
          tabId: "tab-2",
        })
      ).toBeNull();
      expect(
        service.claimSelectedVersionAction(origin, {
          ...source(only.versionId),
          generation: 8,
        })
      ).toBeNull();

      // A newly scheduled selection retires the outstanding authority the
      // moment it is started, before it settles.
      const next = service.select(origin, {
        operationId: page.operationId,
        versionId: only.versionId,
      });
      expect(next.ack.success).toBe(true);
      next.start?.();
      expect(service.isSelectedVersionActionCurrent(authority)).toBe(false);
      await flush();
      expect(
        service.claimSelectedVersionAction(origin, source(only.versionId))
      ).toMatchObject({ versionId: only.versionId });

      service.cancel(origin, { operationId: page.operationId });
      expect(service.isSelectedVersionActionCurrent(authority)).toBe(false);
    });
  });

  it("expires a selection settling at exactly the resolving deadline (la3-2)", async () => {
    await openPage();
    const page = versionsEvents[0];
    const versionId = page.versions[0].versionId;

    const openedAt = Date.now();
    const reservation = service.select(origin, {
      operationId: page.operationId,
      versionId,
    });
    reservation.start?.();
    // The settlement resumes at the exact millisecond the resolving deadline
    // expires: exact equality must expire the selection, not commit it.
    jest.setSystemTime(openedAt + 1_000);
    await flush();

    expect(resolvedEvents).toEqual([]);
    expect(versionFailedEvents).toHaveLength(1);
    expect(versionFailedEvents[0].code).toBe("RESOLUTION_TIMEOUT");

    // The expired selection did not destroy the page: a retry still answers,
    // and answers from the detail this page read when it opened.
    const runsBeforeRetry = coordinator.runCalls;
    await select(versionId);

    expect(coordinator.runCalls).toBe(runsBeforeRetry);
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({ versionId });
  });

  it("rejects unknown and foreign page-scoped version tokens", async () => {
    await openPage();
    const operationId = versionsEvents[0].operationId;
    expect(
      service.select(origin, { operationId, versionId: "not-issued" }).ack
    ).toMatchObject({ success: false, code: "INVALID_REQUEST" });
    expect(
      service.select(
        { coreId: "core-1", socketId: "socket-2" },
        { operationId, versionId: versionsEvents[0].versions[0].versionId }
      ).ack
    ).toMatchObject({ success: false, code: "SESSION_LOST" });
  });

  it("supersedes the tab's previous retained page", async () => {
    await openPage();
    const second = service.open(
      origin,
      request({ requestId: "request-2" }),
      sink()
    );
    expect(second.ack.success).toBe(true);
    expect(failedEvents[failedEvents.length - 1]).toMatchObject({
      requestId: "request-1",
      code: "SUPERSEDED",
    });
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("maps coordinator backpressure and stale generations onto open acks", () => {
    coordinator.acquireError = new BrowseSessionCoordinatorError("BACKPRESSURE", "full");
    expect(service.open(origin, request(), sink()).ack).toMatchObject({
      success: false,
      code: "BACKPRESSURE",
    });
    coordinator.acquireError = new BrowseSessionCoordinatorError(
      "STALE_GENERATION",
      "stale"
    );
    expect(
      service.open(origin, request({ requestId: "request-2" }), sink()).ack
    ).toMatchObject({ success: false, code: "INVALID_REQUEST" });
  });

  it("quarantines an opening Roon call that times out", async () => {
    collectionResolver.resolveError = new RoonTimeoutError("browse", 1_000);
    await openPage();
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");
    expect(coordinator.quarantineCalls).toBe(1);
  });

  it("expires a hung opening read and suppresses its late result", async () => {
    const walk = hangingResolve();
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");
    expect(coordinator.quarantineCalls).toBe(1);
    walk.release();
    await flush();
    expect(versionsEvents).toEqual([]);
  });

  it("expires a live fulfillment landing exactly on the resolving deadline", async () => {
    const walk = hangingResolve();
    const openedAt = Date.now();
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();

    // The wall clock passes the deadline before the timer callback runs, and
    // the read itself settles first: exact equality must still expire.
    jest.setSystemTime(openedAt + 1_000);
    walk.release();
    await flush();

    expect(versionsEvents).toEqual([]);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");
    // The read had already settled, so nothing about the lease is uncertain
    // and it is returned rather than detached.
    expect(coordinator.quarantineCalls).toBe(0);
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("tolerates a lease already lost at quarantine and still reports the failure", async () => {
    coordinator.quarantineError = new BrowseSessionCoordinatorError(
      "SESSION_LOST",
      "the lease was already lost"
    );
    collectionResolver.resolveError = new RoonTimeoutError("browse", 1_000);

    await openPage();

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");
    expect(coordinator.quarantineCalls).toBe(1);
  });

  it("never disposes a quarantined page's detached access twice", async () => {
    collectionResolver.resolveError = new RoonTimeoutError("browse", 1_000);
    const reservation = await openPage();
    const operationId = reservation.ack.success ? reservation.ack.data.operationId : "";
    expect(coordinator.quarantineCalls).toBe(1);

    service.cancel(origin, { operationId });
    service.disconnectSocket("socket-1");
    service.shutdown();

    expect(coordinator.quarantineCalls).toBe(1);
    expect(coordinator.releaseCalls).toBe(0);
  });

  it("closes retained pages on cancel, disconnect, Core loss, and shutdown", async () => {
    await openPage();
    const operationId = versionsEvents[0].operationId;
    expect(service.cancel(origin, { operationId })).toMatchObject({
      success: true,
      data: { claimed: true },
    });
    expect(failedEvents[failedEvents.length - 1]?.code).toBe("CANCELED");

    await openPage({ requestId: "request-2" });
    service.disconnectSocket("socket-1");
    expect(coordinator.releaseCalls).toBe(2);

    await openPage({ requestId: "request-3" });
    service.invalidateCore("core-1");
    expect(failedEvents[failedEvents.length - 1]?.code).toBe("SESSION_LOST");

    service.shutdown();
    expect(service.open(origin, request({ requestId: "request-4" }), sink()).ack).toMatchObject({
      success: false,
      code: "INVALID_REQUEST",
    });
  });

  const retirements: ReadonlyArray<{
    readonly name: string;
    readonly code: string;
    readonly retire: (operationId: string) => void;
  }> = [
    {
      name: "cancel",
      code: "CANCELED",
      retire: (operationId) => {
        service.cancel(origin, { operationId });
      },
    },
    {
      name: "Core invalidation",
      code: "SESSION_LOST",
      retire: () => service.invalidateCore("core-1"),
    },
    {
      name: "supersede",
      code: "SUPERSEDED",
      retire: () => {
        service.open(origin, request({ requestId: "request-2" }), sink());
      },
    },
  ];

  for (const { name, code, retire } of retirements) {
    it(`emits one terminal outcome when ${name} retires the page mid-read`, async () => {
      const walk = hangingResolve();
      const reservation = service.open(origin, request(), sink());
      if (!reservation.ack.success) throw new Error("the page was not accepted");
      reservation.start?.();
      await flush();

      retire(reservation.ack.data.operationId);
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].code).toBe(code);
      // The read was in flight, so the lease is uncertain and detached once.
      expect(coordinator.quarantineCalls).toBe(1);

      walk.release();
      await flush();

      expect(versionsEvents).toEqual([]);
      expect(failedEvents).toHaveLength(1);
      // The detached access is never disposed a second time.
      expect(coordinator.quarantineCalls).toBe(1);
      expect(coordinator.releaseCalls).toBe(0);
    });
  }
});
