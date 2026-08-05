import { Logger } from "pino";

import {
  CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
  createCatalogTrackTitleFingerprint,
} from "../../catalog/CatalogReconciliation";
import { CatalogSnapshot } from "../../catalog/CatalogService";
import {
  LibraryAlbumCatalogPort,
  LibraryAlbumCoordinatorPort,
  LibraryAlbumFallbackResolution,
  LibraryAlbumFallbackResolverPort,
  LibraryAlbumOrigin,
  LibraryAlbumResolution,
  LibraryAlbumResolver,
  LibraryAlbumResolverPort,
  LibraryAlbumService,
} from "../LibraryAlbumService";
import {
  ActionSessionAccess,
  ActionSessionHandle,
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
} from "../BrowseSessionCoordinator";
import { RoonTimeoutError } from "../errors";
import { TimelineAlbumDetailResolverError } from "../TimelineAlbumDetailResolver";
import {
  TimelineDiscographyResolver,
  TimelineObservedDiscography,
} from "../TimelineDiscographyResolver";
import {
  LibraryAlbumFailedEvent,
  LibraryAlbumOpenRequest,
  LibraryAlbumResolvedEvent,
} from "../../../shared/libraryAlbumContracts";
import {
  AlbumRef,
  ArtistRef,
  CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
} from "../../../shared/timelineCatalogContracts";

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

const ALBUM_LOCAL_ID = "018f0f64-3f31-7a9b-8c2d-8f572cb18a12";
const ARTIST_LOCAL_ID = "018f0f64-3f31-7a9b-8c2d-8f572cb18a13";

function artist(patch: Partial<ArtistRef> = {}): ArtistRef {
  return {
    localId: ARTIST_LOCAL_ID,
    coreId: "core-1",
    exactName: "Artist",
    normalizedName: "artist",
    firstSeenAt: "2026-07-14T00:00:00.000Z",
    lastSeenAt: "2026-07-14T00:00:00.000Z",
    resolutionStatus: "resolved",
    ...patch,
  } as ArtistRef;
}

function album(patch: Partial<AlbumRef> = {}): AlbumRef {
  const tracks = ["First", "Second"];
  return {
    localId: ALBUM_LOCAL_ID,
    coreId: "core-1",
    artistLocalId: ARTIST_LOCAL_ID,
    exactTitle: "Album",
    exactArtist: "Artist",
    normalizedTitle: "album",
    normalizedArtist: "artist",
    editionText: "",
    trackTitleFingerprint: createCatalogTrackTitleFingerprint(tracks),
    firstSeenAt: "2026-07-14T00:00:00.000Z",
    lastSeenAt: "2026-07-14T00:00:00.000Z",
    resolutionStatus: "resolved",
    ...patch,
  } as AlbumRef;
}

function snapshot(
  albumValue: AlbumRef = album(),
  artistValue: ArtistRef = artist()
): CatalogSnapshot {
  return {
    coreId: "core-1",
    revision: 1,
    updatedAt: "2026-07-14T00:00:00.000Z",
    lastCompleteScanAt: "2026-07-14T00:00:00.000Z",
    artists: [artistValue],
    albums: [albumValue],
  };
}

function resolution(
  orderedTrackTitles: readonly string[] = ["First", "Second"]
): LibraryAlbumResolution {
  return {
    observation: {
      sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
      artist: {
        exactName: "Artist",
        candidateCount: 1,
      },
      discographyComplete: true,
      albums: [
        {
          exactTitle: "Album",
          exactArtist: "Artist",
          editionText: "",
          detail: {
            sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
            fieldInventoryComplete: true,
            headerTitle: "Album",
            headerSubtitle: "Artist",
            returnedTrackCount: orderedTrackTitles.length,
            totalTrackCount: orderedTrackTitles.length,
            orderedTrackTitles,
            originalReleaseDateField: { status: "not-exposed" },
            editionReleaseDateField: { status: "not-exposed" },
          },
        },
      ],
    },
    orderedTrackTitles,
  };
}

const origin: LibraryAlbumOrigin = { coreId: "core-1", socketId: "socket-1" };

function request(
  patch: Partial<LibraryAlbumOpenRequest> = {}
): LibraryAlbumOpenRequest {
  return {
    requestId: "request-1",
    tabId: "tab-1",
    albumLocalId: ALBUM_LOCAL_ID,
    generation: 7,
    ...patch,
  };
}

const discography = {} as TimelineObservedDiscography;

describe("LibraryAlbumResolver", () => {
  it("drills a fresh action session before observing its current discography", async () => {
    const artistValue = artist();
    const session = {
      browse: jest.fn(),
      load: jest.fn(),
      pop: jest.fn(),
    } as unknown as CoordinatedBrowseSession;
    const resolve = jest.fn().mockResolvedValue({
      kind: "resolved",
      observation: {},
    });
    const observeCurrent = jest.fn().mockResolvedValue(discography);
    const resolver = new LibraryAlbumResolver({
      resolve,
      observeCurrent,
    } as unknown as TimelineDiscographyResolver);

    await expect(resolver.observe(session, artistValue)).resolves.toBe(discography);

    expect(resolve).toHaveBeenCalledWith(session, artistValue);
    expect(observeCurrent).toHaveBeenCalledWith(session, artistValue);
    expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(
      observeCurrent.mock.invocationCallOrder[0]
    );
  });
});

class FakeCoordinator implements LibraryAlbumCoordinatorPort {
  public acquireCalls = 0;
  public acquireInputs: Array<{
    coreId: string;
    socketId: string;
    tabId: string;
    leaseId: string;
    generation: number;
  }> = [];
  public releaseCalls = 0;
  public quarantineCalls = 0;
  public acquireError?: Error;

  public acquireAction(input: {
    coreId: string;
    socketId: string;
    tabId: string;
    leaseId: string;
    generation: number;
  }): ActionSessionHandle {
    this.acquireCalls += 1;
    this.acquireInputs.push(input);
    if (this.acquireError) throw this.acquireError;
    return { kind: "action", handleId: `handle-${this.acquireCalls}`, generation: 7 };
  }

  public runAction<T>(
    _access: ActionSessionAccess,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    const session: CoordinatedBrowseSession = {
      browse: () => Promise.resolve({ level: 0, offset: 0, count: 0, items: [] }),
      load: () => Promise.resolve({ level: 0, offset: 0, count: 0, items: [] }),
      pop: () => Promise.resolve({ level: 0, offset: 0, count: 0, items: [] }),
    };
    return work(session);
  }

  public releaseAction(): Promise<void> {
    this.releaseCalls += 1;
    return Promise.resolve();
  }

  public quarantineAction(): void {
    this.quarantineCalls += 1;
  }
}

class FakeResolver implements LibraryAlbumResolverPort {
  public observeCalls = 0;
  public resolveCalls: Array<Readonly<AlbumRef>> = [];
  public candidateCalls: Array<{
    album: Readonly<AlbumRef>;
    descriptor: { title: string; artist: string; editionText: string };
  }> = [];
  public observeImpl: () => Promise<TimelineObservedDiscography> = () =>
    Promise.resolve(discography);
  public resolveImpl: () => Promise<LibraryAlbumResolution> = () =>
    Promise.resolve(resolution());
  public resolveCandidateImpl: () => Promise<LibraryAlbumResolution> = () =>
    Promise.resolve(resolution(["First (2011)", "Second (2011)"]));
  public candidates: Array<{
    observationIndex: number;
    title: string;
    artist: string;
    editionText: string;
  }> = [];

  public observe(): Promise<TimelineObservedDiscography> {
    this.observeCalls += 1;
    return this.observeImpl();
  }

  public observeCandidates(): readonly {
    observationIndex: number;
    title: string;
    artist: string;
    editionText: string;
  }[] {
    return this.candidates;
  }

  public resolve(
    _session: CoordinatedBrowseSession,
    _artist: Readonly<ArtistRef>,
    albumValue: Readonly<AlbumRef>
  ): Promise<LibraryAlbumResolution> {
    this.resolveCalls.push(albumValue);
    return this.resolveImpl();
  }

  public resolveCandidate(
    _session: CoordinatedBrowseSession,
    _artist: Readonly<ArtistRef>,
    albumValue: Readonly<AlbumRef>,
    _discography: TimelineObservedDiscography,
    descriptor: { title: string; artist: string; editionText: string }
  ): Promise<LibraryAlbumResolution> {
    this.candidateCalls.push({ album: albumValue, descriptor });
    return this.resolveCandidateImpl();
  }
}

class FakeFallbackResolver implements LibraryAlbumFallbackResolverPort {
  public calls: Array<{ coreId: string; album: Readonly<AlbumRef> }> = [];
  public resolveImpl: (
    coreId: string,
    album: Readonly<AlbumRef>
  ) => Promise<LibraryAlbumFallbackResolution> = () =>
    Promise.resolve({ orderedTrackTitles: ["First", "Second"] });

  public resolve(
    coreId: string,
    albumValue: Readonly<AlbumRef>
  ): Promise<LibraryAlbumFallbackResolution> {
    this.calls.push({ coreId, album: albumValue });
    return this.resolveImpl(coreId, albumValue);
  }
}

describe("LibraryAlbumService", () => {
  let coordinator: FakeCoordinator;
  let resolver: FakeResolver;
  let fallbackResolver: FakeFallbackResolver;
  let catalogSnapshot: CatalogSnapshot | null;
  let reconcileSelectedArtist: jest.Mock<
    ReturnType<LibraryAlbumCatalogPort["reconcileSelectedArtist"]>,
    Parameters<LibraryAlbumCatalogPort["reconcileSelectedArtist"]>
  >;
  let service: LibraryAlbumService;
  let resolvedEvents: LibraryAlbumResolvedEvent[];
  let failedEvents: LibraryAlbumFailedEvent[];

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger;

  const sink = () => ({
    resolved: (event: LibraryAlbumResolvedEvent) => resolvedEvents.push(event),
    failed: (event: LibraryAlbumFailedEvent) => failedEvents.push(event),
  });

  beforeEach(() => {
    jest.useFakeTimers();
    coordinator = new FakeCoordinator();
    resolver = new FakeResolver();
    fallbackResolver = new FakeFallbackResolver();
    catalogSnapshot = snapshot();
    reconcileSelectedArtist = jest.fn(async (_coreId, _artistLocalId, observation) => {
      if (!catalogSnapshot) throw new Error("catalog unavailable");
      const detailed = observation.albums.filter((value) => value.detail);
      if (detailed.length !== 1 || !detailed[0].detail) {
        throw new Error("detail observation unavailable");
      }
      const publishedAlbum = {
        ...catalogSnapshot.albums[0],
        trackTitleFingerprint: createCatalogTrackTitleFingerprint(
          detailed[0].detail.orderedTrackTitles
        ),
      };
      catalogSnapshot = {
        ...catalogSnapshot,
        revision: catalogSnapshot.revision + 1,
        albums: [publishedAlbum],
      };
      return {
        artist: catalogSnapshot.artists[0],
        albums: catalogSnapshot.albums,
      };
    });
    resolvedEvents = [];
    failedEvents = [];
    let nonce = 0;
    service = new LibraryAlbumService(
      coordinator,
      {
        getSnapshot: () => catalogSnapshot,
        reconcileSelectedArtist,
      },
      resolver,
      logger,
      {
        resolvingTtlMs: 1_000,
        randomId: () => `op-${(nonce += 1)}`,
        fallbackResolver,
      }
    );
  });

  afterEach(() => {
    service.shutdown();
    jest.useRealTimers();
  });

  it("resolves an album into keyless ordered tracks", async () => {
    const reservation = service.open(origin, request(), sink());
    expect(reservation.ack.success).toBe(true);
    reservation.start?.();
    await flush();

    expect(resolver.observeCalls).toBe(1);
    expect(resolver.resolveCalls).toHaveLength(1);
    expect(failedEvents).toHaveLength(0);
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({
      requestId: "request-1",
      generation: 7,
      artist: "Artist",
      title: "Album",
      actionsAvailable: true,
      orderedTracks: [
        { index: 0, title: "First" },
        { index: 1, title: "Second" },
      ],
    });
    expect(coordinator.releaseCalls).toBe(1);
    expect(JSON.stringify(resolvedEvents[0])).not.toContain("itemKey");
  });

  it("resolves an unresolved native-bound album into non-actionable tracks", async () => {
    const unresolvedAlbum = album({
      artistLocalId: undefined,
      resolutionStatus: "unresolved",
      extendedAlbumId: "123456789",
    });
    catalogSnapshot = {
      ...snapshot(unresolvedAlbum),
      artists: [],
    };
    const reservation = service.open(
      origin,
      request({
        candidate: {
          title: "Album",
          artist: "Artist",
          editionText: "",
        },
      }),
      sink()
    );
    reservation.start?.();
    await flush();

    expect(fallbackResolver.calls).toHaveLength(1);
    expect(fallbackResolver.calls[0]).toMatchObject({
      coreId: "core-1",
      album: { localId: ALBUM_LOCAL_ID, extendedAlbumId: "123456789" },
    });
    expect(resolver.observeCalls).toBe(0);
    expect(reconcileSelectedArtist).not.toHaveBeenCalled();
    expect(failedEvents).toEqual([]);
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({
      artist: "Artist",
      title: "Album",
      actionsAvailable: false,
      orderedTracks: [
        { index: 0, title: "First" },
        { index: 1, title: "Second" },
      ],
    });
  });

  it("rejects a song candidate that no longer matches the native-bound album", async () => {
    const unresolvedAlbum = album({
      artistLocalId: undefined,
      resolutionStatus: "unresolved",
      extendedAlbumId: "123456789",
    });
    catalogSnapshot = {
      ...snapshot(unresolvedAlbum),
      artists: [],
    };
    const reservation = service.open(
      origin,
      request({
        candidate: {
          title: "Different Album",
          artist: "Artist",
          editionText: "",
        },
      }),
      sink()
    );
    reservation.start?.();
    await flush();

    expect(fallbackResolver.calls).toHaveLength(0);
    expect(resolvedEvents).toEqual([]);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("DETAIL_MISMATCH");
  });

  it("fails closed when catalog identity changes during a native fallback read", async () => {
    const unresolvedAlbum = album({
      artistLocalId: undefined,
      resolutionStatus: "unresolved",
      extendedAlbumId: "123456789",
    });
    catalogSnapshot = {
      ...snapshot(unresolvedAlbum),
      artists: [],
    };
    fallbackResolver.resolveImpl = async () => {
      catalogSnapshot = {
        ...catalogSnapshot!,
        revision: 2,
        albums: [
          album({
            artistLocalId: undefined,
            exactTitle: "Renamed",
            normalizedTitle: "renamed",
            resolutionStatus: "unresolved",
            extendedAlbumId: "123456789",
          }),
        ],
      };
      return { orderedTrackTitles: ["First", "Second"] };
    };
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();

    expect(resolvedEvents).toEqual([]);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("ALBUM_NOT_FOUND");
  });

  it("publishes exact album-detail evidence before resolving a fingerprint-less album", async () => {
    catalogSnapshot = snapshot(album({ trackTitleFingerprint: undefined }));
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();

    expect(reconcileSelectedArtist).toHaveBeenCalledWith(
      "core-1",
      ARTIST_LOCAL_ID,
      resolution().observation
    );
    expect(catalogSnapshot?.albums[0].trackTitleFingerprint).toBe(
      createCatalogTrackTitleFingerprint(["First", "Second"])
    );
    expect(failedEvents).toHaveLength(0);
    expect(resolvedEvents).toHaveLength(1);
  });

  it("rejects a reused request ID for the same socket", async () => {
    const first = service.open(origin, request(), sink());
    expect(first.ack.success).toBe(true);
    first.start?.();
    await flush();

    const second = service.open(origin, request({ tabId: "tab-2" }), sink());
    expect(second.ack).toMatchObject({ success: false, code: "REQUEST_ID_CONFLICT" });
  });

  it("supersedes the tab's previous read on a newer open", async () => {
    const first = service.open(origin, request(), sink());
    expect(first.ack.success).toBe(true);

    const second = service.open(origin, request({ requestId: "request-2" }), sink());
    expect(second.ack.success).toBe(true);

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      requestId: "request-1",
      code: "SUPERSEDED",
    });
    expect(coordinator.releaseCalls).toBe(1);

    second.start?.();
    await flush();
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0].requestId).toBe("request-2");
  });

  it("maps coordinator backpressure onto the open ack", () => {
    coordinator.acquireError = new BrowseSessionCoordinatorError(
      "BACKPRESSURE",
      "full"
    );
    const reservation = service.open(origin, request(), sink());
    expect(reservation.ack).toMatchObject({ success: false, code: "BACKPRESSURE" });
  });

  it("rejects stale generations as invalid opens", () => {
    coordinator.acquireError = new BrowseSessionCoordinatorError(
      "STALE_GENERATION",
      "stale"
    );
    const reservation = service.open(origin, request(), sink());
    expect(reservation.ack).toMatchObject({ success: false, code: "INVALID_REQUEST" });
  });

  it("fails when the album is not in the resolved catalog", async () => {
    catalogSnapshot = null;
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("ALBUM_NOT_FOUND");
  });

  it("fails when the album identity changes mid-resolution", async () => {
    resolver.observeImpl = () => {
      catalogSnapshot = snapshot(album({ exactTitle: "Renamed", normalizedTitle: "renamed" }));
      return Promise.resolve(discography);
    };
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();
    expect(resolvedEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("ALBUM_NOT_FOUND");
  });

  it("offers distinguishable edition candidates on ambiguity", async () => {
    resolver.resolveImpl = () =>
      Promise.reject(
        new TimelineAlbumDetailResolverError("ALBUM_AMBIGUOUS", "ambiguous")
      );
    resolver.candidates = [
      { observationIndex: 0, title: "Album", artist: "Artist", editionText: "" },
      {
        observationIndex: 1,
        title: "Album",
        artist: "Artist",
        editionText: "2011 Remaster",
      },
    ];
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("ALBUM_AMBIGUOUS");
    expect(failedEvents[0].candidates).toEqual([
      { title: "Album", artist: "Artist", editionText: "" },
      { title: "Album", artist: "Artist", editionText: "2011 Remaster" },
    ]);
  });

  it("omits candidates a retry could not re-bind uniquely", async () => {
    resolver.resolveImpl = () =>
      Promise.reject(
        new TimelineAlbumDetailResolverError("ALBUM_AMBIGUOUS", "ambiguous")
      );
    resolver.candidates = [
      { observationIndex: 0, title: "Album", artist: "Artist", editionText: "" },
      { observationIndex: 1, title: "Album", artist: "Artist", editionText: "" },
    ];
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("ALBUM_AMBIGUOUS");
    expect(failedEvents[0].candidates).toBeUndefined();
  });

  it("routes a chooser candidate through candidate resolution", async () => {
    const reservation = service.open(
      origin,
      request({
        candidate: { title: "Album", artist: "Artist", editionText: "2011 Remaster" },
      }),
      sink()
    );
    reservation.start?.();
    await flush();

    expect(resolver.resolveCalls).toHaveLength(0);
    expect(resolver.candidateCalls).toHaveLength(1);
    expect(resolver.candidateCalls[0].descriptor).toEqual({
      title: "Album",
      artist: "Artist",
      editionText: "2011 Remaster",
    });
    expect(failedEvents).toEqual([]);
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0].orderedTracks[0].title).toBe("First (2011)");
  });

  it("cancels an active read by request ID", async () => {
    const reservation = service.open(origin, request(), sink());
    expect(reservation.ack.success).toBe(true);

    const ack = service.cancel(origin, { requestId: "request-1" });
    expect(ack).toMatchObject({ success: true, data: { claimed: true } });
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("CANCELED");
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("refuses to cancel a foreign origin's operation", () => {
    const reservation = service.open(origin, request(), sink());
    expect(reservation.ack.success).toBe(true);
    const ack = service.cancel(
      { coreId: "core-1", socketId: "socket-2" },
      { requestId: "request-1" }
    );
    expect(ack).toMatchObject({ success: true, data: { claimed: false } });
    expect(failedEvents).toHaveLength(0);
  });

  it("expires unresolved reads with RESOLUTION_TIMEOUT", async () => {
    let releaseObservation: () => void = () => {};
    resolver.observeImpl = () =>
      new Promise((resolve) => {
        releaseObservation = () => resolve(discography);
      });
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();

    jest.advanceTimersByTime(1_000);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");
    // In-flight Roon work is quarantined, never silently reused.
    expect(coordinator.quarantineCalls).toBe(1);
    releaseObservation();
    await flush();
    expect(resolvedEvents).toHaveLength(0);
  });

  it("quarantines timed-out Roon calls", async () => {
    resolver.observeImpl = () =>
      Promise.reject(new RoonTimeoutError("browse", 1_000));
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");
    expect(coordinator.quarantineCalls).toBe(1);
  });

  it("closes reads for a disconnecting socket without events", async () => {
    const reservation = service.open(origin, request(), sink());
    expect(reservation.ack.success).toBe(true);
    service.disconnectSocket("socket-1");
    expect(failedEvents).toHaveLength(0);
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("fails active reads when the Core is invalidated", async () => {
    const reservation = service.open(origin, request(), sink());
    expect(reservation.ack.success).toBe(true);
    service.invalidateCore("core-1");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("SESSION_LOST");
  });

  it("rejects opens after shutdown", () => {
    service.shutdown();
    const reservation = service.open(origin, request(), sink());
    expect(reservation.ack).toMatchObject({ success: false, code: "INVALID_REQUEST" });
  });
});
