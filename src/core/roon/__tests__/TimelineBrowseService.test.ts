import type {
  AlbumRef,
  ArtistRef,
  CatalogArtistAlbumsResponse,
  CatalogStatus,
} from "../../../shared/timelineCatalogContracts";
import {
  CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
  normalizeCatalogArtistAlbumsResponse,
  normalizeCatalogText,
} from "../../../shared/timelineCatalogContracts";
import type {
  TimelineAlbumDetailCloseFailedEvent,
  TimelineAlbumDetailCloseRequest,
  TimelineAlbumDetailClosedEvent,
  TimelineAlbumDetailFailedEvent,
  TimelineAlbumDetailLoadedEvent,
  TimelineAlbumDetailRequest,
  TimelineArtistLoadFailedEvent,
  TimelineArtistLoadedEvent,
  TimelineArtistLoadRequest,
  TimelineSessionReleaseRequest,
} from "../../../shared/timelineBrowseContracts";
import {
  CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
  createCatalogTrackTitleFingerprint,
  type SelectedArtistObservation,
} from "../../catalog/CatalogReconciliation";
import type { CatalogSelectedArtistResult } from "../../catalog/CatalogService";
import type {
  CoordinatedBrowseSession,
  ModeSessionAccess,
  ModeSessionHandle,
} from "../BrowseSessionCoordinator";
import {
  TimelineBrowseService,
  type TimelineArtistLoadOrigin,
  type TimelineArtistLoadReservation,
  type TimelineArtistLoadSink,
  type TimelineAlbumDetailCloseReservation,
  type TimelineAlbumDetailCloseSink,
  type TimelineAlbumDetailReservation,
  type TimelineAlbumDetailResolverLike,
  type TimelineAlbumDetailSink,
  type TimelineBrowseCatalog,
  type TimelineBrowseCoordinator,
  type TimelineDiscographyResolverLike,
} from "../TimelineBrowseService";
import {
  TimelineDiscographyResolverError,
  type TimelineDiscographyResolution,
  type TimelineObservedDiscography,
} from "../TimelineDiscographyResolver";
import type { TimelineAlbumDetailResolution } from "../TimelineAlbumDetailResolver";

const CORE_ID = "core-a";
const OTHER_CORE_ID = "core-b";
const ARTIST_A_ID = "10000000-0000-4000-8000-000000000001";
const ARTIST_B_ID = "10000000-0000-4000-8000-000000000002";
const ALBUM_A_ID = "20000000-0000-4000-8000-000000000001";
const ALBUM_B_ID = "20000000-0000-4000-8000-000000000002";
const AT = "2026-07-15T00:00:00.000Z";
const NOW = 2_000_000_000_000;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function catalogStatus(
  albumCount = 1,
  artistCount = 1
): CatalogStatus {
  return {
    coreId: CORE_ID,
    freshness: "fresh",
    persistence: "healthy",
    refresh: "idle",
    available: true,
    complete: true,
    revision: 2,
    artistCount,
    albumCount,
    updatedAt: AT,
    lastCompleteScanAt: AT,
  };
}

function artist(
  localId = ARTIST_A_ID,
  exactName = "Björk"
): ArtistRef {
  return {
    localId,
    coreId: CORE_ID,
    exactName,
    normalizedName: normalizeCatalogText(exactName),
    firstSeenAt: AT,
    lastSeenAt: AT,
    resolutionStatus: "resolved",
  };
}

function album(
  owner: ArtistRef = artist(),
  localId = ALBUM_A_ID,
  exactTitle = "Homogenic"
): AlbumRef {
  return {
    localId,
    coreId: CORE_ID,
    artistLocalId: owner.localId,
    exactTitle,
    exactArtist: owner.exactName,
    normalizedTitle: normalizeCatalogText(exactTitle),
    normalizedArtist: owner.normalizedName,
    editionText: "",
    firstSeenAt: AT,
    lastSeenAt: AT,
    resolutionStatus: "resolved",
  };
}

function discography(
  owner: ArtistRef = artist(),
  ownedAlbums: readonly AlbumRef[] = [album(owner)],
  status = catalogStatus(ownedAlbums.length)
): CatalogArtistAlbumsResponse {
  const normalized = normalizeCatalogArtistAlbumsResponse({
    status,
    artist: owner,
    limit: 500,
    total: ownedAlbums.length,
    truncated: false,
    albums: ownedAlbums,
  });
  if (!normalized) throw new Error("test discography fixture is invalid");
  return normalized;
}

function selectedResult(
  response: CatalogArtistAlbumsResponse = discography()
): CatalogSelectedArtistResult {
  return {
    snapshot: {
      coreId: CORE_ID,
      revision: response.status.revision,
      updatedAt: AT,
      lastCompleteScanAt: AT,
      artists: [response.artist],
      albums: response.albums,
    },
    status: response.status,
    artist: response.artist,
    albums: response.albums,
  };
}

function resolvedResolution(
  response: CatalogArtistAlbumsResponse = discography()
): TimelineDiscographyResolution {
  return {
    kind: "resolved",
    observation: {
      sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
      artist: {
        exactName: response.artist.exactName,
        candidateCount: 1,
      },
      discographyComplete: true,
      albums: response.albums.map((value) => ({
        exactTitle: value.exactTitle,
        exactArtist: value.exactArtist,
        editionText: value.editionText,
      })),
    },
  };
}

function unresolvedResolution(
  kind: "missing" | "ambiguous",
  owner: ArtistRef = artist()
): TimelineDiscographyResolution {
  const observation: SelectedArtistObservation = {
    sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
    artist: {
      exactName: owner.exactName,
      candidateCount: kind === "missing" ? 0 : 2,
    },
  };
  return { kind, observation };
}

class FakeCoordinator implements TimelineBrowseCoordinator {
  public readonly acquireCalls: Array<{
    coreId: string;
    socketId: string;
    tabId: string;
    mode: "timeline";
    replaceDisconnected?: boolean;
  }> = [];
  public readonly runCalls: Array<{
    access: ModeSessionAccess;
    role: "timeline-interactive";
  }> = [];
  public readonly releaseCalls: ModeSessionAccess[] = [];
  public readonly reconnectCalls: Array<{
    coreId: string;
    tabId: string;
    socketId: string;
    handle: ModeSessionHandle;
  }> = [];
  public readonly sessionPop = jest.fn();
  public beforeWork?: (callIndex: number) => void;
  private generation = 0;

  private readonly session: CoordinatedBrowseSession = {
    browse: async () => {
      throw new Error("unexpected direct browse in service test");
    },
    load: async () => {
      throw new Error("unexpected direct load in service test");
    },
    pop: (options) => this.sessionPop(options),
  };

  public constructor(private readonly order: string[]) {}

  public acquireMode(input: {
    coreId: string;
    socketId: string;
    tabId: string;
    mode: "timeline";
    replaceDisconnected?: boolean;
  }): ModeSessionHandle {
    this.acquireCalls.push(input);
    this.order.push("coordinator:acquire");
    this.generation += 1;
    return {
      kind: "mode",
      handleId: `handle-${this.generation}`,
      generation: this.generation,
      mode: "timeline",
    };
  }

  public reconnectMode(input: {
    coreId: string;
    tabId: string;
    socketId: string;
    handle: ModeSessionHandle;
  }): ModeSessionHandle {
    this.reconnectCalls.push(input);
    this.order.push("coordinator:reconnect");
    return input.handle;
  }

  public runMode<T>(
    access: ModeSessionAccess,
    role: "timeline-interactive",
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    this.runCalls.push({ access, role });
    this.order.push(`coordinator:barrier-${this.runCalls.length}`);
    this.beforeWork?.(this.runCalls.length);
    return work(this.session);
  }

  public async releaseMode(access: ModeSessionAccess): Promise<void> {
    this.releaseCalls.push(access);
    this.order.push("coordinator:release");
  }
}

class FakeCatalog implements TimelineBrowseCatalog {
  public readonly getArtistAlbums = jest.fn<
    Promise<CatalogArtistAlbumsResponse | null>,
    [string, unknown, unknown?]
  >();
  public readonly getStatus = jest.fn<CatalogStatus, [string]>();
  public readonly reconcileSelectedArtist = jest.fn<
    Promise<CatalogSelectedArtistResult>,
    [string, unknown, unknown]
  >();
}

class FakeResolver implements TimelineDiscographyResolverLike {
  public readonly resolve = jest.fn<
    Promise<TimelineDiscographyResolution>,
    [CoordinatedBrowseSession, ArtistRef]
  >();
  public readonly observeCurrent = jest.fn<
    Promise<TimelineObservedDiscography>,
    [CoordinatedBrowseSession, ArtistRef, Awaited<ReturnType<CoordinatedBrowseSession["pop"]>>?]
  >();
}

class FakeDetailResolver implements TimelineAlbumDetailResolverLike {
  public readonly resolve = jest.fn<
    Promise<TimelineAlbumDetailResolution>,
    [CoordinatedBrowseSession, ArtistRef, AlbumRef, TimelineObservedDiscography]
  >();
}

function recordingSink(order: string[] = []): TimelineArtistLoadSink & {
  loaded: jest.Mock<void, [TimelineArtistLoadedEvent]>;
  failed: jest.Mock<void, [TimelineArtistLoadFailedEvent]>;
} {
  return {
    loaded: jest.fn((event: TimelineArtistLoadedEvent) => {
      order.push(`sink:loaded:${event.requestId}`);
    }),
    failed: jest.fn((event: TimelineArtistLoadFailedEvent) => {
      order.push(`sink:failed:${event.requestId}:${event.code}`);
    }),
  };
}

function recordingDetailSink(order: string[] = []): TimelineAlbumDetailSink & {
  loaded: jest.Mock<void, [TimelineAlbumDetailLoadedEvent]>;
  failed: jest.Mock<void, [TimelineAlbumDetailFailedEvent]>;
} {
  return {
    loaded: jest.fn((event: TimelineAlbumDetailLoadedEvent) => {
      order.push(`sink:detail-loaded:${event.requestId}`);
    }),
    failed: jest.fn((event: TimelineAlbumDetailFailedEvent) => {
      order.push(`sink:detail-failed:${event.requestId}:${event.code}`);
    }),
  };
}

function recordingCloseSink(order: string[] = []): TimelineAlbumDetailCloseSink & {
  closed: jest.Mock<void, [TimelineAlbumDetailClosedEvent]>;
  failed: jest.Mock<void, [TimelineAlbumDetailCloseFailedEvent]>;
} {
  return {
    closed: jest.fn((event: TimelineAlbumDetailClosedEvent) => {
      order.push(`sink:detail-closed:${event.requestId}`);
    }),
    failed: jest.fn((event: TimelineAlbumDetailCloseFailedEvent) => {
      order.push(`sink:detail-close-failed:${event.requestId}:${event.code}`);
    }),
  };
}

function request(
  requestId: string,
  artistLocalId = ARTIST_A_ID,
  tabId = "timeline-tab"
): TimelineArtistLoadRequest {
  return { requestId, tabId, artistLocalId };
}

function detailRequest(
  requestId: string,
  session: { readonly handleId: string; readonly generation: number },
  artistLocalId = ARTIST_A_ID,
  albumLocalId = ALBUM_A_ID,
  tabId = "timeline-tab"
): TimelineAlbumDetailRequest {
  return { requestId, tabId, session, artistLocalId, albumLocalId };
}

function closeRequest(
  requestId: string,
  session: { readonly handleId: string; readonly generation: number },
  baseArtistLocalId = ARTIST_A_ID,
  detailArtistLocalId = ARTIST_A_ID,
  albumLocalId = ALBUM_A_ID,
  tabId = "timeline-tab"
): TimelineAlbumDetailCloseRequest {
  return {
    requestId,
    tabId,
    session,
    baseArtistLocalId,
    detailArtistLocalId,
    albumLocalId,
  };
}

function releaseRequest(
  session: { readonly handleId: string; readonly generation: number },
  requestId = "timeline-release-1",
  tabId = "timeline-tab"
): TimelineSessionReleaseRequest {
  return { requestId, tabId, session };
}

function observedDiscography(
  response: CatalogArtistAlbumsResponse = discography()
): TimelineObservedDiscography {
  const resolution = resolvedResolution(response);
  if (resolution.kind !== "resolved") throw new Error("expected resolved fixture");
  return {
    observation: resolution.observation,
    liveAlbums: response.albums.map((_value, observationIndex) => ({
      observationIndex,
      itemKey: `live-album-${observationIndex}`,
    })),
  };
}

function detailResolution(
  response: CatalogArtistAlbumsResponse = discography(),
  orderedTrackTitles: readonly string[] = ["Hunter", "Jóga"]
): TimelineAlbumDetailResolution {
  const observed = observedDiscography(response).observation;
  return {
    observation: {
      ...observed,
      albums: observed.albums.map((value, index) =>
        index === 0
          ? {
              ...value,
              detail: {
                sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
                fieldInventoryComplete: true as const,
                headerTitle: value.exactTitle,
                headerSubtitle: value.exactArtist,
                returnedTrackCount: orderedTrackTitles.length,
                totalTrackCount: orderedTrackTitles.length,
                orderedTrackTitles,
                originalReleaseDateField: { status: "not-exposed" as const },
                editionReleaseDateField: { status: "not-exposed" as const },
              },
            }
          : value
      ),
    },
    orderedTrackTitles,
  };
}

function selectedDetailResult(
  response: CatalogArtistAlbumsResponse = discography(),
  orderedTrackTitles: readonly string[] = ["Hunter", "Jóga"]
): CatalogSelectedArtistResult {
  const withFingerprint = response.albums.map((value, index) =>
    index === 0
      ? {
          ...value,
          trackTitleFingerprint:
            createCatalogTrackTitleFingerprint(orderedTrackTitles),
        }
      : value
  );
  return selectedResult(
    discography(response.artist, withFingerprint, response.status)
  );
}

const ORIGIN: TimelineArtistLoadOrigin = {
  coreId: CORE_ID,
  socketId: "socket-a",
};

interface Harness {
  readonly order: string[];
  readonly coordinator: FakeCoordinator;
  readonly catalog: FakeCatalog;
  readonly resolver: FakeResolver;
  readonly detailResolver: FakeDetailResolver;
  readonly service: TimelineBrowseService;
  setCurrentCoreId(coreId: string | null): void;
  setNow(value: number): void;
}

function createHarness(): Harness {
  const order: string[] = [];
  const coordinator = new FakeCoordinator(order);
  const catalog = new FakeCatalog();
  const resolver = new FakeResolver();
  const detailResolver = new FakeDetailResolver();
  const known = discography();
  let currentCoreId: string | null = CORE_ID;
  let now = NOW;

  catalog.getArtistAlbums.mockImplementation(async () => {
    order.push("catalog:get");
    return known;
  });
  catalog.getStatus.mockImplementation(() => {
    order.push("catalog:status");
    return known.status;
  });
  catalog.reconcileSelectedArtist.mockImplementation(async (_coreId, _localId, value) => {
    order.push("catalog:reconcile");
    const observation = value as {
      readonly albums?: readonly {
        readonly detail?: {
          readonly orderedTrackTitles?: readonly string[];
        };
      }[];
    };
    const tracks = observation.albums?.find((entry) => entry.detail)?.detail
      ?.orderedTrackTitles;
    if (tracks) return selectedDetailResult(known, tracks);
    return selectedResult(known);
  });
  resolver.resolve.mockImplementation(async () => {
    order.push("resolver:resolve");
    return resolvedResolution(known);
  });
  resolver.observeCurrent.mockImplementation(async () => {
    order.push("resolver:observe-current");
    return observedDiscography(known);
  });
  detailResolver.resolve.mockImplementation(async () => {
    order.push("detail-resolver:resolve");
    return detailResolution(known);
  });

  const service = new TimelineBrowseService(coordinator, catalog, {
    now: () => now,
    loadTimeoutMs: 30_000,
    resolver,
    detailResolver,
    getCurrentCoreId: () => currentCoreId,
  });
  return {
    order,
    coordinator,
    catalog,
    resolver,
    detailResolver,
    service,
    setCurrentCoreId(coreId) {
      currentCoreId = coreId;
    },
    setNow(value) {
      now = value;
    },
  };
}

function requiredStart(
  reservation:
    | TimelineArtistLoadReservation
    | TimelineAlbumDetailReservation
    | TimelineAlbumDetailCloseReservation
): () => Promise<void> {
  if (!reservation.ack.success || !reservation.start) {
    throw new Error("expected a successful startable reservation");
  }
  return reservation.start;
}

async function loadArtistRuntime(
  harness: Harness,
  artistLocalId = ARTIST_A_ID,
  requestId = `artist-runtime-${artistLocalId}`
): Promise<{ readonly handleId: string; readonly generation: number }> {
  const reservation = harness.service.begin(
    ORIGIN,
    request(requestId, artistLocalId),
    recordingSink()
  );
  await requiredStart(reservation)();
  if (!reservation.ack.success) throw new Error("expected artist runtime");
  return reservation.ack.data.session;
}

describe("TimelineBrowseService", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns its correlation acknowledgment before resolver work can start", async () => {
    const harness = createHarness();
    const sink = recordingSink(harness.order);

    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-load-immediate"),
      sink
    );

    expect(reservation.ack).toEqual({
      success: true,
      data: {
        requestId: "artist-load-immediate",
        session: { handleId: "handle-1", generation: 1 },
        loadingDeadlineAt: NOW + 30_000,
      },
    });
    expect(harness.catalog.getArtistAlbums).not.toHaveBeenCalled();
    expect(harness.resolver.resolve).not.toHaveBeenCalled();
    expect(sink.loaded).not.toHaveBeenCalled();

    await requiredStart(reservation)();
    expect(harness.resolver.resolve).toHaveBeenCalledTimes(1);
    expect(sink.loaded).toHaveBeenCalledTimes(1);
  });

  it("releases only the exact socket-owned generation and forces a fresh successor", async () => {
    const harness = createHarness();
    const session = await loadArtistRuntime(harness);

    expect(
      harness.service.release(
        { ...ORIGIN, socketId: "socket-b" },
        releaseRequest(session, "foreign-release")
      )
    ).toMatchObject({ success: false, code: "STALE_GENERATION" });
    expect(harness.coordinator.releaseCalls).toHaveLength(0);

    expect(harness.service.release(ORIGIN, releaseRequest(session))).toEqual({
      success: true,
      data: { requestId: "timeline-release-1", session },
    });
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
    expect(
      harness.service.beginDetail(
        ORIGIN,
        detailRequest("detail-after-release", session),
        recordingDetailSink()
      ).ack
    ).toMatchObject({ success: false, code: "STALE_GENERATION" });
    expect(
      harness.service.release(ORIGIN, releaseRequest(session, "duplicate-release"))
    ).toMatchObject({ success: false, code: "STALE_GENERATION" });
    expect(harness.coordinator.releaseCalls).toHaveLength(1);

    const successor = await loadArtistRuntime(
      harness,
      ARTIST_A_ID,
      "artist-runtime-successor"
    );
    expect(successor.generation).toBeGreaterThan(session.generation);
    expect(successor.handleId).not.toBe(session.handleId);
  });

  it("terminalizes an in-flight generation before release so late work cannot publish", async () => {
    const harness = createHarness();
    const pending = deferred<TimelineDiscographyResolution>();
    const sink = recordingSink();
    harness.resolver.resolve.mockReturnValueOnce(pending.promise);
    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-release-in-flight"),
      sink
    );
    const running = requiredStart(reservation)();
    if (!reservation.ack.success) throw new Error("expected accepted in-flight release fixture");

    expect(
      harness.service.release(
        ORIGIN,
        releaseRequest(reservation.ack.data.session, "release-in-flight")
      )
    ).toMatchObject({ success: true });
    pending.resolve(resolvedResolution());
    await running;

    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).not.toHaveBeenCalled();
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
  });

  it("fails before starting work when its acknowledged deadline has already passed", async () => {
    const harness = createHarness();
    const sink = recordingSink();
    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-load-expired-before-start"),
      sink
    );
    harness.setNow(NOW + 30_000);

    await requiredStart(reservation)();

    expect(harness.catalog.getArtistAlbums).not.toHaveBeenCalled();
    expect(harness.resolver.resolve).not.toHaveBeenCalled();
    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).toHaveBeenCalledTimes(1);
    expect(sink.failed).toHaveBeenCalledWith({
      ...(reservation.ack.success ? reservation.ack.data : {}),
      code: "SESSION_LOST",
      error: "Timeline artist load timed out",
    });
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
  });

  it("publishes the reconciliation's anchored status after the final coordinator barrier", async () => {
    const harness = createHarness();
    const sink = recordingSink(harness.order);
    harness.catalog.getStatus.mockImplementation(() => {
      harness.order.push("catalog:status");
      return { ...catalogStatus(), revision: 3 };
    });
    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-load-success"),
      sink
    );
    harness.order.length = 0;

    await requiredStart(reservation)();

    expect(harness.order).toEqual([
      "catalog:get",
      "coordinator:barrier-1",
      "resolver:resolve",
      "catalog:reconcile",
      "coordinator:barrier-2",
      "sink:loaded:artist-load-success",
    ]);
    expect(harness.catalog.getStatus).not.toHaveBeenCalled();
    expect(harness.coordinator.runCalls).toHaveLength(2);
    expect(harness.coordinator.runCalls).toEqual([
      expect.objectContaining({ role: "timeline-interactive" }),
      expect.objectContaining({ role: "timeline-interactive" }),
    ]);
    expect(harness.coordinator.releaseCalls).toHaveLength(0);
    expect(sink.failed).not.toHaveBeenCalled();
    expect(sink.loaded.mock.calls[0][0]).toEqual({
      ...(reservation.ack.success ? reservation.ack.data : {}),
      discography: discography(),
    });
  });

  it("releases an abandoned acknowledgment without starting any work", async () => {
    const harness = createHarness();
    const sink = recordingSink();
    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-load-abandon"),
      sink
    );
    if (!reservation.abandon) throw new Error("expected abandon callback");

    await reservation.abandon();
    await requiredStart(reservation)();

    expect(harness.catalog.getArtistAlbums).not.toHaveBeenCalled();
    expect(harness.resolver.resolve).not.toHaveBeenCalled();
    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).not.toHaveBeenCalled();
    expect(harness.coordinator.releaseCalls).toEqual([
      expect.objectContaining({
        coreId: CORE_ID,
        socketId: ORIGIN.socketId,
        tabId: "timeline-tab",
        handle: expect.objectContaining({ handleId: "handle-1", generation: 1 }),
      }),
    ]);
  });

  it("rejects a duplicate request ID without allocating another mode", async () => {
    const harness = createHarness();
    const first = harness.service.begin(
      ORIGIN,
      request("artist-load-duplicate"),
      recordingSink()
    );

    const activeDuplicate = harness.service.begin(
      ORIGIN,
      request("artist-load-duplicate", ARTIST_A_ID, "other-tab"),
      recordingSink()
    );
    expect(activeDuplicate).toEqual({
      ack: {
        success: false,
        code: "REQUEST_ID_CONFLICT",
        error: "Timeline artist request ID was already used",
      },
    });
    expect(harness.coordinator.acquireCalls).toHaveLength(1);

    if (!first.abandon) throw new Error("expected abandon callback");
    await first.abandon();
    const retiredDuplicate = harness.service.begin(
      ORIGIN,
      request("artist-load-duplicate"),
      recordingSink()
    );
    expect(retiredDuplicate.ack).toMatchObject({
      success: false,
      code: "REQUEST_ID_CONFLICT",
    });
    expect(harness.coordinator.acquireCalls).toHaveLength(1);
  });

  it.each([
    ["missing", "ARTIST_NOT_FOUND"],
    ["ambiguous", "ARTIST_AMBIGUOUS"],
  ] as const)(
    "emits a typed %s failure and releases its access",
    async (kind, expectedCode) => {
      const harness = createHarness();
      const sink = recordingSink();
      harness.resolver.resolve.mockResolvedValue(
        unresolvedResolution(kind)
      );
      const reservation = harness.service.begin(
        ORIGIN,
        request(`artist-load-${kind}`),
        sink
      );

      await requiredStart(reservation)();

      expect(harness.catalog.reconcileSelectedArtist).toHaveBeenCalledTimes(1);
      expect(sink.loaded).not.toHaveBeenCalled();
      expect(sink.failed).toHaveBeenCalledWith({
        ...(reservation.ack.success ? reservation.ack.data : {}),
        code: expectedCode,
        error: expect.any(String),
      });
      expect(harness.coordinator.releaseCalls).toHaveLength(1);
    }
  );

  it("never publishes a superseded artist after its reconciliation settles", async () => {
    const harness = createHarness();
    const artistA = artist(ARTIST_A_ID, "Björk");
    const artistB = artist(ARTIST_B_ID, "Fever Ray");
    const knownA = discography(artistA, [album(artistA, ALBUM_A_ID, "Homogenic")]);
    const knownB = discography(artistB, [album(artistB, ALBUM_B_ID, "Plunge")]);
    const selectedA = selectedResult(knownA);
    const selectedB = selectedResult(knownB);
    const reconcileA = deferred<CatalogSelectedArtistResult>();
    const reconcileAStarted = deferred<void>();

    harness.catalog.getArtistAlbums.mockImplementation(async (_coreId, localId) =>
      localId === ARTIST_A_ID ? knownA : knownB
    );
    harness.catalog.getStatus.mockReturnValue(catalogStatus(2, 2));
    harness.resolver.resolve.mockImplementation(async (_session, owner) =>
      owner.localId === ARTIST_A_ID
        ? resolvedResolution(knownA)
        : resolvedResolution(knownB)
    );
    harness.catalog.reconcileSelectedArtist.mockImplementation(
      async (_coreId, localId) => {
        if (localId === ARTIST_A_ID) {
          reconcileAStarted.resolve();
          return reconcileA.promise;
        }
        return selectedB;
      }
    );

    const sinkA = recordingSink();
    const reservationA = harness.service.begin(
      ORIGIN,
      request("artist-load-a", ARTIST_A_ID),
      sinkA
    );
    const runA = requiredStart(reservationA)();
    await reconcileAStarted.promise;

    const sinkB = recordingSink();
    const reservationB = harness.service.begin(
      ORIGIN,
      request("artist-load-b", ARTIST_B_ID),
      sinkB
    );
    await requiredStart(reservationB)();
    expect(sinkB.loaded).toHaveBeenCalledTimes(1);

    reconcileA.resolve(selectedA);
    await runA;

    expect(sinkA.loaded).not.toHaveBeenCalled();
    expect(sinkA.failed).not.toHaveBeenCalled();
    expect(harness.coordinator.runCalls.map((call) => call.access.handle.handleId)).toEqual([
      "handle-1",
      "handle-2",
      "handle-2",
    ]);
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
    expect(harness.coordinator.releaseCalls[0].handle.handleId).toBe("handle-1");
  });

  it.each(["resolver", "reconciliation"] as const)(
    "times out exactly once while %s is pending and ignores its late settlement",
    async (pendingStage) => {
      jest.useFakeTimers();
      const harness = createHarness();
      const sink = recordingSink();
      const pendingStarted = deferred<void>();
      const resolution = deferred<TimelineDiscographyResolution>();
      const reconciliation = deferred<CatalogSelectedArtistResult>();

      if (pendingStage === "resolver") {
        harness.resolver.resolve.mockImplementation(async () => {
          pendingStarted.resolve();
          return resolution.promise;
        });
      } else {
        harness.catalog.reconcileSelectedArtist.mockImplementation(async () => {
          pendingStarted.resolve();
          return reconciliation.promise;
        });
      }

      const reservation = harness.service.begin(
        ORIGIN,
        request(`artist-load-timeout-${pendingStage}`),
        sink
      );
      const run = requiredStart(reservation)();
      await pendingStarted.promise;

      harness.setNow(NOW + 30_000);
      await jest.advanceTimersByTimeAsync(30_000);

      expect(sink.loaded).not.toHaveBeenCalled();
      expect(sink.failed).toHaveBeenCalledTimes(1);
      expect(sink.failed).toHaveBeenCalledWith({
        ...(reservation.ack.success ? reservation.ack.data : {}),
        code: "SESSION_LOST",
        error: "Timeline artist load timed out",
      });
      expect(harness.coordinator.releaseCalls).toHaveLength(1);

      if (pendingStage === "resolver") {
        resolution.resolve(resolvedResolution());
      } else {
        reconciliation.resolve(selectedResult());
      }
      await run;

      expect(sink.loaded).not.toHaveBeenCalled();
      expect(sink.failed).toHaveBeenCalledTimes(1);
      expect(harness.coordinator.releaseCalls).toHaveLength(1);
    }
  );

  it("rejects a delayed publication when the injected deadline passes before its timer runs", async () => {
    jest.useFakeTimers();
    const harness = createHarness();
    const sink = recordingSink();
    const reconciliation = deferred<CatalogSelectedArtistResult>();
    const reconciliationStarted = deferred<void>();
    harness.catalog.reconcileSelectedArtist.mockImplementation(async () => {
      reconciliationStarted.resolve();
      return reconciliation.promise;
    });
    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-load-deadline-authority"),
      sink
    );
    const run = requiredStart(reservation)();
    await reconciliationStarted.promise;

    harness.setNow(NOW + 30_000);
    reconciliation.resolve(selectedResult());
    await run;

    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).toHaveBeenCalledTimes(1);
    expect(sink.failed).toHaveBeenCalledWith({
      ...(reservation.ack.success ? reservation.ack.data : {}),
      code: "SESSION_LOST",
      error: "Timeline artist load timed out",
    });
    expect(harness.coordinator.releaseCalls).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(sink.failed).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
  });

  it("checks the deadline again inside the final publication barrier", async () => {
    const harness = createHarness();
    const sink = recordingSink();
    harness.coordinator.beforeWork = (callIndex) => {
      if (callIndex === 2) harness.setNow(NOW + 30_000);
    };
    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-load-final-deadline-barrier"),
      sink
    );

    await requiredStart(reservation)();

    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).toHaveBeenCalledTimes(1);
    expect(sink.failed).toHaveBeenCalledWith({
      ...(reservation.ack.success ? reservation.ack.data : {}),
      code: "SESSION_LOST",
      error: "Timeline artist load timed out",
    });
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
  });

  it("re-arms an early deadline timer and still expires exactly once", async () => {
    jest.useFakeTimers();
    const harness = createHarness();
    const sink = recordingSink();
    const resolution = deferred<TimelineDiscographyResolution>();
    const resolutionStarted = deferred<void>();
    harness.resolver.resolve.mockImplementation(async () => {
      resolutionStarted.resolve();
      return resolution.promise;
    });
    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-load-early-timer"),
      sink
    );
    const run = requiredStart(reservation)();
    await resolutionStarted.promise;

    await jest.advanceTimersByTimeAsync(30_000);
    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).not.toHaveBeenCalled();
    expect(harness.coordinator.releaseCalls).toHaveLength(0);

    harness.setNow(NOW + 30_000);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(sink.failed).toHaveBeenCalledTimes(1);
    expect(sink.failed).toHaveBeenCalledWith({
      ...(reservation.ack.success ? reservation.ack.data : {}),
      code: "SESSION_LOST",
      error: "Timeline artist load timed out",
    });
    expect(harness.coordinator.releaseCalls).toHaveLength(1);

    resolution.resolve(resolvedResolution());
    await run;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
  });

  it("reports a Core change detected after pending reconciliation without publishing", async () => {
    const harness = createHarness();
    const sink = recordingSink();
    const reconciliation = deferred<CatalogSelectedArtistResult>();
    const reconciliationStarted = deferred<void>();
    harness.catalog.reconcileSelectedArtist.mockImplementation(async () => {
      reconciliationStarted.resolve();
      return reconciliation.promise;
    });
    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-load-pending-core-change"),
      sink
    );
    const run = requiredStart(reservation)();
    await reconciliationStarted.promise;

    harness.setCurrentCoreId(OTHER_CORE_ID);
    reconciliation.resolve(selectedResult());
    await run;

    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).toHaveBeenCalledTimes(1);
    expect(sink.failed).toHaveBeenCalledWith({
      ...(reservation.ack.success ? reservation.ack.data : {}),
      code: "CORE_UNAVAILABLE",
      error: "Roon Core changed during Timeline artist loading",
    });
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
  });

  it.each([
    ["core invalidation", "resolver"],
    ["core invalidation", "reconciliation"],
    ["socket disconnect", "resolver"],
    ["socket disconnect", "reconciliation"],
  ] as const)(
    "does not publish after %s closes a pending %s",
    async (closure, pendingStage) => {
      const harness = createHarness();
      const sink = recordingSink();
      const resolution = deferred<TimelineDiscographyResolution>();
      const reconciliation = deferred<CatalogSelectedArtistResult>();
      const pendingStarted = deferred<void>();
      if (pendingStage === "resolver") {
        harness.resolver.resolve.mockImplementation(async () => {
          pendingStarted.resolve();
          return resolution.promise;
        });
      } else {
        harness.catalog.reconcileSelectedArtist.mockImplementation(async () => {
          pendingStarted.resolve();
          return reconciliation.promise;
        });
      }
      const reservation = harness.service.begin(
        ORIGIN,
        request(
          `artist-load-${closure.replace(" ", "-")}-${pendingStage}`
        ),
        sink
      );
      const run = requiredStart(reservation)();
      await pendingStarted.promise;

      if (closure === "core invalidation") {
        harness.service.invalidateCore(CORE_ID);
      } else {
        harness.service.disconnectSocket(ORIGIN.socketId);
      }
      if (pendingStage === "resolver") {
        resolution.resolve(resolvedResolution());
      } else {
        reconciliation.resolve(selectedResult());
      }
      await run;

      expect(sink.loaded).not.toHaveBeenCalled();
      expect(sink.failed).not.toHaveBeenCalled();
    }
  );

  it("maps a failed discography resolve to a typed failure and releases", async () => {
    const harness = createHarness();
    const sink = recordingSink();
    harness.resolver.resolve.mockRejectedValue(
      new TimelineDiscographyResolverError(
        "INCOMPLETE_DISCOGRAPHY",
        "discography pagination drifted"
      )
    );
    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-load-resolve-failure"),
      sink
    );

    await requiredStart(reservation)();

    expect(harness.catalog.reconcileSelectedArtist).not.toHaveBeenCalled();
    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).toHaveBeenCalledWith({
      ...(reservation.ack.success ? reservation.ack.data : {}),
      code: "DISCOGRAPHY_UNAVAILABLE",
      error: "The selected artist discography could not be loaded completely",
    });
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
  });

  it("loads one attached detail, reconciles its track fingerprint, then coherently pops and refreshes Back", async () => {
    const harness = createHarness();
    const session = await loadArtistRuntime(harness);
    harness.order.length = 0;
    harness.coordinator.runCalls.length = 0;
    harness.resolver.resolve.mockClear();
    harness.resolver.observeCurrent.mockClear();
    harness.detailResolver.resolve.mockClear();
    const detailSink = recordingDetailSink(harness.order);
    const reservation = harness.service.beginDetail(
      ORIGIN,
      detailRequest("detail-success", session),
      detailSink
    );

    expect(reservation.ack).toEqual({
      success: true,
      data: {
        requestId: "detail-success",
        session,
        artistLocalId: ARTIST_A_ID,
        albumLocalId: ALBUM_A_ID,
        loadingDeadlineAt: NOW + 30_000,
      },
    });
    expect(harness.resolver.observeCurrent).not.toHaveBeenCalled();
    expect(harness.detailResolver.resolve).not.toHaveBeenCalled();

    await requiredStart(reservation)();

    expect(harness.resolver.resolve).not.toHaveBeenCalled();
    expect(harness.resolver.observeCurrent).toHaveBeenCalledTimes(1);
    expect(harness.detailResolver.resolve).toHaveBeenCalledTimes(1);
    expect(detailSink.loaded).toHaveBeenCalledTimes(1);
    const loaded = detailSink.loaded.mock.calls[0][0];
    expect(loaded.detail.orderedTrackTitles).toEqual(["Hunter", "Jóga"]);
    expect(loaded.detail.album).toMatchObject({
      localId: ALBUM_A_ID,
      artistLocalId: ARTIST_A_ID,
      resolutionStatus: "resolved",
      trackTitleFingerprint: createCatalogTrackTitleFingerprint([
        "Hunter",
        "Jóga",
      ]),
    });
    expect(harness.coordinator.releaseCalls).toHaveLength(0);

    const parentResult = {
      title: "Björk",
      subtitle: "Albums",
      level: 1,
      offset: 0,
      count: 0,
      totalCount: 0,
      items: [],
    };
    harness.coordinator.sessionPop.mockResolvedValueOnce(parentResult);
    harness.resolver.resolve.mockClear();
    harness.resolver.observeCurrent.mockClear();
    const closeSink = recordingCloseSink();
    const close = harness.service.closeDetail(
      ORIGIN,
      closeRequest("detail-close-success", session),
      closeSink
    );

    await requiredStart(close)();

    expect(harness.coordinator.sessionPop).toHaveBeenCalledWith({
      hierarchy: "artists",
      levels: 1,
      refresh: true,
      pageSize: 100,
    });
    expect(harness.resolver.observeCurrent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ localId: ARTIST_A_ID }),
      parentResult
    );
    expect(harness.resolver.resolve).not.toHaveBeenCalled();
    expect(closeSink.closed).toHaveBeenCalledWith({
      ...(close.ack.success ? close.ack.data : {}),
      discography: discography(),
    });
  });

  it("re-roots an auxiliary detail and its base parent without popping the auxiliary stack", async () => {
    const harness = createHarness();
    const session = await loadArtistRuntime(harness);
    const ownerA = artist();
    const knownA = discography(ownerA, [album(ownerA)]);
    const ownerB = artist(ARTIST_B_ID, "Fever Ray");
    const knownB = discography(ownerB, [album(ownerB, ALBUM_B_ID, "Plunge")]);
    harness.catalog.getArtistAlbums.mockImplementation(async (_coreId, localId) =>
      localId === ARTIST_B_ID ? knownB : knownA
    );
    harness.resolver.resolve.mockImplementation(async (_browseSession, owner) =>
      owner.localId === ARTIST_B_ID
        ? resolvedResolution(knownB)
        : resolvedResolution(knownA)
    );
    harness.resolver.observeCurrent.mockImplementation(async (_session, owner) =>
      observedDiscography(owner.localId === ARTIST_B_ID ? knownB : knownA)
    );
    harness.detailResolver.resolve.mockResolvedValue(
      detailResolution(knownB, ["If I Had A Heart"])
    );
    harness.catalog.reconcileSelectedArtist.mockImplementation(
      async (_coreId, localId, value) => {
        const observation = value as {
          readonly albums?: readonly { readonly detail?: unknown }[];
        };
        if (localId === ARTIST_B_ID) {
          return observation.albums?.some((entry) => entry.detail)
            ? selectedDetailResult(knownB, ["If I Had A Heart"])
            : selectedResult(knownB);
        }
        return selectedResult(knownA);
      }
    );

    const detailSink = recordingDetailSink();
    const opened = harness.service.beginDetail(
      ORIGIN,
      detailRequest(
        "detail-auxiliary",
        session,
        ARTIST_B_ID,
        ALBUM_B_ID
      ),
      detailSink
    );
    await requiredStart(opened)();
    expect(detailSink.loaded).toHaveBeenCalledTimes(1);
    expect(harness.resolver.resolve).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ localId: ARTIST_B_ID })
    );

    harness.coordinator.sessionPop.mockClear();
    harness.resolver.resolve.mockClear();
    const closeSink = recordingCloseSink();
    const close = harness.service.closeDetail(
      ORIGIN,
      closeRequest(
        "detail-auxiliary-close",
        session,
        ARTIST_A_ID,
        ARTIST_B_ID,
        ALBUM_B_ID
      ),
      closeSink
    );
    await requiredStart(close)();

    expect(harness.coordinator.sessionPop).not.toHaveBeenCalled();
    expect(harness.resolver.resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ localId: ARTIST_A_ID })
    );
    expect(closeSink.closed).toHaveBeenCalledTimes(1);
  });

  it("fails detail publication when catalog reconciliation does not preserve its fingerprint", async () => {
    const harness = createHarness();
    const session = await loadArtistRuntime(harness);
    harness.catalog.reconcileSelectedArtist.mockResolvedValueOnce(selectedResult());
    const sink = recordingDetailSink();
    const reservation = harness.service.beginDetail(
      ORIGIN,
      detailRequest("detail-fingerprint-lost", session),
      sink
    );

    await requiredStart(reservation)();

    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).toHaveBeenCalledWith({
      ...(reservation.ack.success ? reservation.ack.data : {}),
      code: "ALBUM_AMBIGUOUS",
      error: "Album detail did not preserve one resolved catalog identity",
    });
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
  });

  it("checks current Core/session authority inside the final detail publication barrier", async () => {
    const harness = createHarness();
    const session = await loadArtistRuntime(harness);
    harness.coordinator.beforeWork = (callIndex) => {
      if (callIndex === 4) harness.service.invalidateCore(CORE_ID);
    };
    const sink = recordingDetailSink();
    const reservation = harness.service.beginDetail(
      ORIGIN,
      detailRequest("detail-final-barrier", session),
      sink
    );

    await requiredStart(reservation)();

    expect(harness.coordinator.runCalls).toHaveLength(4);
    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).not.toHaveBeenCalled();
  });

  it("falls back to stable base-artist re-resolution when coherent Back validation fails", async () => {
    const harness = createHarness();
    const session = await loadArtistRuntime(harness);
    const detailSink = recordingDetailSink();
    const opened = harness.service.beginDetail(
      ORIGIN,
      detailRequest("detail-before-fallback", session),
      detailSink
    );
    await requiredStart(opened)();
    const parentResult = {
      title: "Björk",
      subtitle: "Albums",
      level: 1,
      offset: 0,
      count: 0,
      totalCount: 0,
      items: [],
    };
    harness.coordinator.sessionPop.mockResolvedValueOnce(parentResult);
    harness.resolver.observeCurrent.mockRejectedValueOnce(
      new TimelineDiscographyResolverError(
        "INCOMPLETE_DISCOGRAPHY",
        "parent changed"
      )
    );
    harness.resolver.resolve.mockClear();
    const sink = recordingCloseSink();
    const close = harness.service.closeDetail(
      ORIGIN,
      closeRequest("detail-close-fallback", session),
      sink
    );

    await requiredStart(close)();

    expect(harness.coordinator.sessionPop).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: true })
    );
    expect(harness.resolver.resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ localId: ARTIST_A_ID })
    );
    expect(sink.closed).toHaveBeenCalledTimes(1);
  });

  it("transfers a coherent disconnected runtime to the new socket without changing generation", async () => {
    const harness = createHarness();
    const session = await loadArtistRuntime(harness);
    harness.service.disconnectSocket(ORIGIN.socketId);
    const nextOrigin = { coreId: CORE_ID, socketId: "socket-b" };

    expect(
      harness.service.reconnect(nextOrigin, {
        requestId: "timeline-reconnect",
        tabId: "timeline-tab",
        session,
      })
    ).toEqual({
      success: true,
      data: { requestId: "timeline-reconnect", session },
    });
    expect(harness.coordinator.reconnectCalls).toEqual([
      {
        coreId: CORE_ID,
        tabId: "timeline-tab",
        socketId: "socket-b",
        handle: expect.objectContaining(session),
      },
    ]);

    const accepted = harness.service.beginDetail(
      nextOrigin,
      detailRequest("detail-after-reconnect", session),
      recordingDetailSink()
    );
    expect(accepted.ack.success).toBe(true);
    const staleOwner = harness.service.beginDetail(
      ORIGIN,
      detailRequest("detail-old-owner", session),
      recordingDetailSink()
    );
    expect(staleOwner.ack).toMatchObject({
      success: false,
      code: "STALE_GENERATION",
    });
    await accepted.abandon?.();
  });

  it.each(["disconnect", "core invalidation"] as const)(
    "does not publish a late detail after %s dirties its retained level",
    async (closure) => {
      const harness = createHarness();
      const session = await loadArtistRuntime(harness);
      const pending = deferred<TimelineAlbumDetailResolution>();
      const started = deferred<void>();
      harness.detailResolver.resolve.mockImplementation(async () => {
        started.resolve();
        return pending.promise;
      });
      const sink = recordingDetailSink();
      const reservation = harness.service.beginDetail(
        ORIGIN,
        detailRequest(`detail-pending-${closure.replace(" ", "-")}`, session),
        sink
      );
      const run = requiredStart(reservation)();
      await started.promise;

      if (closure === "disconnect") {
        harness.service.disconnectSocket(ORIGIN.socketId);
        expect(
          harness.service.reconnect(
            { coreId: CORE_ID, socketId: "socket-b" },
            {
              requestId: "dirty-reconnect",
              tabId: "timeline-tab",
              session,
            }
          )
        ).toMatchObject({ success: false, code: "SESSION_LOST" });
      } else {
        harness.service.invalidateCore(CORE_ID);
      }
      pending.resolve(detailResolution());
      await run;

      expect(sink.loaded).not.toHaveBeenCalled();
      expect(sink.failed).not.toHaveBeenCalled();
    }
  );

  it("rejects stale detail handles before catalog or browse work", async () => {
    const harness = createHarness();
    const session = await loadArtistRuntime(harness);
    harness.catalog.getArtistAlbums.mockClear();
    harness.resolver.observeCurrent.mockClear();
    harness.detailResolver.resolve.mockClear();

    const rejected = harness.service.beginDetail(
      ORIGIN,
      detailRequest("detail-stale-handle", {
        ...session,
        generation: session.generation + 1,
      }),
      recordingDetailSink()
    );

    expect(rejected.ack).toMatchObject({
      success: false,
      code: "STALE_GENERATION",
    });
    expect(harness.catalog.getArtistAlbums).not.toHaveBeenCalled();
    expect(harness.resolver.observeCurrent).not.toHaveBeenCalled();
    expect(harness.detailResolver.resolve).not.toHaveBeenCalled();
  });

  it("releases a dirtied runtime when an unacknowledged replacement is abandoned", async () => {
    const harness = createHarness();
    const session = await loadArtistRuntime(harness);
    const first = harness.service.beginDetail(
      ORIGIN,
      detailRequest("detail-before-ack-loss", session),
      recordingDetailSink()
    );
    const replacement = harness.service.beginDetail(
      ORIGIN,
      detailRequest("detail-ack-lost", session, ARTIST_A_ID, ALBUM_A_ID),
      recordingDetailSink()
    );
    expect(replacement.ack.success).toBe(true);

    await replacement.abandon?.();
    await first.abandon?.();

    expect(harness.coordinator.releaseCalls).toHaveLength(1);
    expect(harness.coordinator.releaseCalls[0].handle).toMatchObject(session);
    expect(
      harness.service.beginDetail(
        ORIGIN,
        detailRequest("detail-after-ack-loss", session),
        recordingDetailSink()
      ).ack
    ).toMatchObject({ success: false, code: "STALE_GENERATION" });
  });

  it("rejects a Core change after acknowledgment before reading the catalog", async () => {
    const harness = createHarness();
    const sink = recordingSink();
    const reservation = harness.service.begin(
      ORIGIN,
      request("artist-load-core-change"),
      sink
    );
    harness.setCurrentCoreId(OTHER_CORE_ID);

    await requiredStart(reservation)();

    expect(harness.catalog.getArtistAlbums).not.toHaveBeenCalled();
    expect(harness.resolver.resolve).not.toHaveBeenCalled();
    expect(sink.loaded).not.toHaveBeenCalled();
    expect(sink.failed).toHaveBeenCalledWith({
      ...(reservation.ack.success ? reservation.ack.data : {}),
      code: "CORE_UNAVAILABLE",
      error: "Roon Core changed during Timeline artist loading",
    });
    expect(harness.coordinator.releaseCalls).toHaveLength(1);
  });
});
