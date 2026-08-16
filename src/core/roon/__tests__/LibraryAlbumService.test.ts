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
  LibraryAlbumInventoryDetail,
  LibraryAlbumInventoryVersion,
  LibraryAlbumOrigin,
  LibraryAlbumResolution,
  LibraryAlbumResolver,
  LibraryAlbumResolverPort,
  LibraryAlbumService,
  LibraryAlbumVersionInventoryPort,
} from "../LibraryAlbumService";
import {
  ActionSessionAccess,
  ActionSessionHandle,
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
} from "../BrowseSessionCoordinator";
import { RoonTimeoutError } from "../errors";
import {
  DiscographyResolver,
  DiscographyResolverError,
  ObservedDiscography,
} from "../DiscographyResolver";
import {
  LibraryAlbumFailedEvent,
  LibraryAlbumOpenRequest,
  LibraryAlbumResolvedEvent,
  LibraryAlbumVersionFailedEvent,
  LibraryAlbumVersionsEvent,
} from "../../../shared/libraryAlbumContracts";
import {
  AlbumRef,
  ArtistRef,
  CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
} from "../../../shared/catalogContracts";

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
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
  return {
    localId: ALBUM_LOCAL_ID,
    coreId: "core-1",
    artistLocalId: ARTIST_LOCAL_ID,
    exactTitle: "Album",
    exactArtist: "Artist",
    normalizedTitle: "album",
    normalizedArtist: "artist",
    editionText: "",
    trackTitleFingerprint: createCatalogTrackTitleFingerprint(["First", "Second"]),
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

function observedDiscography(
  rows: ReadonlyArray<{
    itemKey: string;
    editionText?: string;
    imageKeyHint?: string;
  }> = [{ itemKey: "row-a" }, { itemKey: "row-b" }]
): ObservedDiscography {
  return {
    observation: {
      sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
      artist: { exactName: "Artist", candidateCount: 1 },
      discographyComplete: true,
      albums: rows.map((row) => ({
        exactTitle: "Album",
        exactArtist: "Artist",
        editionText: row.editionText ?? "",
        ...(row.imageKeyHint ? { imageKeyHint: row.imageKeyHint } : {}),
      })),
    },
    liveAlbums: rows.map((row, observationIndex) => ({
      observationIndex,
      itemKey: row.itemKey,
    })),
  };
}

function resolution(
  orderedTrackTitles: readonly string[]
): LibraryAlbumResolution {
  return {
    observation: {
      sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
      artist: { exactName: "Artist", candidateCount: 1 },
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

describe("LibraryAlbumResolver", () => {
  it("drills a fresh action session before observing its current discography", async () => {
    const artistValue = artist();
    const session = {
      browse: jest.fn(),
      load: jest.fn(),
      pop: jest.fn(),
    } as unknown as CoordinatedBrowseSession;
    const discography = observedDiscography();
    const resolve = jest.fn().mockResolvedValue({ kind: "resolved", observation: {} });
    const observeCurrent = jest.fn().mockResolvedValue(discography);
    const resolver = new LibraryAlbumResolver({
      resolve,
      observeCurrent,
    } as unknown as DiscographyResolver);

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
  public releaseCalls = 0;
  public quarantineCalls = 0;
  public acquireError?: Error;
  public popCalls: unknown[] = [];

  public acquireAction(): ActionSessionHandle {
    this.acquireCalls += 1;
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
      pop: (options) => {
        this.popCalls.push(options);
        return Promise.resolve({ level: 1, offset: 0, count: 2, items: [] });
      },
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
  public current = observedDiscography();
  public observeCalls = 0;
  public observeCurrentCalls = 0;
  public detailCalls: number[] = [];
  public observeImpl: () => Promise<ObservedDiscography> = () =>
    Promise.resolve(this.current);
  public observeCurrentImpl: () => Promise<ObservedDiscography> = () =>
    Promise.resolve(this.current);
  public detailImpl: (observationIndex: number) => Promise<LibraryAlbumResolution> =
    (observationIndex) =>
      Promise.resolve(
        resolution(
          observationIndex === 0
            ? ["Version A 1", "Version A 2"]
            : ["Version B 1", "Version B 2", "Version B 3"]
        )
      );

  public observe(): Promise<ObservedDiscography> {
    this.observeCalls += 1;
    return this.observeImpl();
  }

  public observeCurrent(): Promise<ObservedDiscography> {
    this.observeCurrentCalls += 1;
    return this.observeCurrentImpl();
  }

  public observeCandidates(
    discography: ObservedDiscography
  ): ReadonlyArray<{
    observationIndex: number;
    title: string;
    artist: string;
    editionText: string;
  }> {
    return discography.observation.albums.map((row, observationIndex) => ({
      observationIndex,
      title: row.exactTitle,
      artist: row.exactArtist,
      editionText: row.editionText,
    }));
  }

  public resolveObservedCandidate(
    _session: CoordinatedBrowseSession,
    _artist: Readonly<ArtistRef>,
    _album: Readonly<AlbumRef>,
    _discography: ObservedDiscography,
    observationIndex: number
  ): Promise<LibraryAlbumResolution> {
    this.detailCalls.push(observationIndex);
    return this.detailImpl(observationIndex);
  }
}

class FakeFallbackResolver implements LibraryAlbumFallbackResolverPort {
  public calls: Array<{ coreId: string; album: Readonly<AlbumRef> }> = [];
  public resolveImpl: () => Promise<LibraryAlbumFallbackResolution> = () =>
    Promise.resolve({ orderedTrackTitles: ["First", "Second"] });

  public resolve(
    coreId: string,
    albumValue: Readonly<AlbumRef>
  ): Promise<LibraryAlbumFallbackResolution> {
    this.calls.push({ coreId, album: albumValue });
    return this.resolveImpl();
  }
}

class FakeVersionInventory implements LibraryAlbumVersionInventoryPort {
  public listCalls: Array<{ coreId: string; title: string; artist: string }> = [];
  public readCalls: Array<{ coreId: string; stableKeys: readonly string[] }> = [];
  public listImpl: () => Promise<readonly LibraryAlbumInventoryVersion[] | null> =
    () => Promise.resolve(null);
  public readImpl: (
    stableKeys: readonly string[]
  ) => Promise<readonly LibraryAlbumInventoryDetail[] | null> = () =>
    Promise.resolve(null);

  public list(
    coreId: string,
    group: { readonly title: string; readonly artist: string }
  ): Promise<readonly LibraryAlbumInventoryVersion[] | null> {
    this.listCalls.push({ coreId, ...group });
    return this.listImpl();
  }

  public read(
    coreId: string,
    stableKeys: readonly string[]
  ): Promise<readonly LibraryAlbumInventoryDetail[] | null> {
    this.readCalls.push({ coreId, stableKeys: [...stableKeys] });
    return this.readImpl(stableKeys);
  }
}

function inventoryVersion(
  stableKey: string,
  editionText: string,
  patch: Partial<LibraryAlbumInventoryVersion> = {}
): LibraryAlbumInventoryVersion {
  return {
    stableKey,
    title: "Album",
    artist: "Artist",
    editionText,
    sourceLabel: "Local",
    releaseDate: "2003",
    isFavorite: false,
    isListenLater: false,
    isBanned: false,
    ...patch,
  };
}

function inventoryDetail(
  stableKey: string,
  titles: readonly string[]
): LibraryAlbumInventoryDetail {
  return {
    stableKey,
    tracks: titles.map((title, index) => ({
      title,
      trackNumber: index + 1,
      mediaNumber: 1,
      lengthSeconds: 200 + index,
      available: true,
    })),
  };
}

describe("LibraryAlbumService", () => {
  let coordinator: FakeCoordinator;
  let resolver: FakeResolver;
  let fallbackResolver: FakeFallbackResolver;
  let versionInventory: FakeVersionInventory;
  let catalogSnapshot: CatalogSnapshot | null;
  let service: LibraryAlbumService;
  let versionsEvents: LibraryAlbumVersionsEvent[];
  let resolvedEvents: LibraryAlbumResolvedEvent[];
  let versionFailedEvents: LibraryAlbumVersionFailedEvent[];
  let failedEvents: LibraryAlbumFailedEvent[];

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
    coordinator = new FakeCoordinator();
    resolver = new FakeResolver();
    fallbackResolver = new FakeFallbackResolver();
    versionInventory = new FakeVersionInventory();
    catalogSnapshot = snapshot();
    versionsEvents = [];
    resolvedEvents = [];
    versionFailedEvents = [];
    failedEvents = [];
    let nonce = 0;
    service = new LibraryAlbumService(
      coordinator,
      {
        getSnapshot: () => catalogSnapshot,
        reconcileSelectedArtist: jest.fn(),
      } as LibraryAlbumCatalogPort,
      resolver,
      logger,
      {
        resolvingTtlMs: 1_000,
        randomId: () => `opaque-${(nonce += 1)}`,
        fallbackResolver,
        versionInventory,
      }
    );
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

  it("publishes every identical blank-edition row without reading details", async () => {
    resolver.current = observedDiscography([
      { itemKey: "row-a", imageKeyHint: "same-art" },
      { itemKey: "row-b", imageKeyHint: "same-art" },
    ]);

    await openPage();

    expect(resolver.observeCalls).toBe(1);
    expect(resolver.detailCalls).toEqual([]);
    expect(versionsEvents).toHaveLength(1);
    expect(versionsEvents[0].versions).toHaveLength(2);
    expect(versionsEvents[0].versions[0].editionText).toBe("");
    expect(versionsEvents[0].versions[1].editionText).toBe("");
    expect(versionsEvents[0].versions[0].versionId).not.toBe(
      versionsEvents[0].versions[1].versionId
    );
    expect(JSON.stringify(versionsEvents[0])).not.toMatch(/row-a|row-b|itemKey/u);
    expect(coordinator.releaseCalls).toBe(0);
  });

  it("merges unique edition metadata one-to-one without publishing stable keys", async () => {
    resolver.current = observedDiscography([
      { itemKey: "row-a", editionText: "Standard" },
      { itemKey: "row-b", editionText: "Deluxe" },
    ]);
    versionInventory.listImpl = async () => [
      inventoryVersion("10", "Deluxe"),
      inventoryVersion("20", "Standard", { playCount: 4, isFavorite: true }),
    ];
    versionInventory.readImpl = async (stableKeys) =>
      stableKeys.map((stableKey) =>
        inventoryDetail(
          stableKey,
          stableKey === "20" ? ["Version A 1", "Version A 2"] : ["Other"]
        )
      );

    await openPage();

    expect(versionsEvents[0].versions).toEqual([
      expect.objectContaining({
        editionText: "Standard",
        sourceLabel: "Local",
        playCount: 4,
        isFavorite: true,
      }),
      expect.objectContaining({ editionText: "Deluxe", sourceLabel: "Local" }),
    ]);
    expect(JSON.stringify(versionsEvents[0])).not.toMatch(/stableKey|"10"|"20"/u);

    await select(versionsEvents[0].versions[0].versionId);

    expect(resolvedEvents[0]).toMatchObject({
      actionsAvailable: true,
      versionSummary: {
        editionText: "Standard",
        trackCount: 2,
        durationSeconds: 401,
        sourceLabel: "Local",
      },
      orderedTracks: [
        expect.objectContaining({ title: "Version A 1", trackNumber: 1 }),
        expect.objectContaining({ title: "Version A 2", trackNumber: 2 }),
      ],
    });
    expect(JSON.stringify(resolvedEvents[0])).not.toMatch(/stableKey/u);
  });

  it("enriches a blank public row only after one complete track sequence matches", async () => {
    versionInventory.listImpl = async () => [
      inventoryVersion("10", "Deluxe"),
      inventoryVersion("20", "Standard"),
    ];
    versionInventory.readImpl = async () => [
      inventoryDetail("10", ["Version A 1", "Version A 2"]),
      inventoryDetail("20", ["Version A 1", "Different"]),
    ];

    await openPage();
    expect(versionsEvents[0].versions).toHaveLength(2);
    expect(versionsEvents[0].versions.every((version) => version.editionText === "")).toBe(
      true
    );

    await select(versionsEvents[0].versions[0].versionId);

    expect(resolvedEvents[0].versionSummary).toMatchObject({
      editionText: "Deluxe",
      sourceLabel: "Local",
      trackCount: 2,
    });
    expect(versionInventory.readCalls[0].stableKeys).toEqual(["10", "20"]);
  });

  it("refuses private enrichment when two versions have the same complete track sequence", async () => {
    versionInventory.listImpl = async () => [
      inventoryVersion("10", "Deluxe"),
      inventoryVersion("20", "Standard"),
    ];
    versionInventory.readImpl = async () => [
      inventoryDetail("10", ["Version A 1", "Version A 2"]),
      inventoryDetail("20", ["Version A 1", "Version A 2"]),
    ];

    await openPage();
    await select(versionsEvents[0].versions[0].versionId);

    expect(resolvedEvents[0].versionSummary).toEqual(
      expect.objectContaining({ editionText: "" })
    );
    expect(resolvedEvents[0].versionSummary).not.toHaveProperty("sourceLabel");
    expect(resolvedEvents[0].actionsAvailable).toBe(true);
  });

  it("publishes a proven unmatched inventory version as honest read-only detail", async () => {
    resolver.current = observedDiscography([
      { itemKey: "row-a", editionText: "Standard" },
    ]);
    versionInventory.listImpl = async () => [
      inventoryVersion("10", "Standard"),
      inventoryVersion("20", "Deluxe"),
    ];
    versionInventory.readImpl = async (stableKeys) =>
      stableKeys.includes("20") ? [inventoryDetail("20", ["Only Native"])] : [];

    await openPage();

    expect(versionsEvents[0].versions).toHaveLength(2);
    const featureOnly = versionsEvents[0].versions.find(
      (version) => version.editionText === "Deluxe"
    );
    if (!featureOnly) throw new Error("Expected read-only inventory version");
    await select(featureOnly.versionId);

    expect(resolver.detailCalls).toEqual([]);
    expect(resolvedEvents[0]).toMatchObject({
      actionsAvailable: false,
      versionSummary: { editionText: "Deluxe", trackCount: 1 },
      orderedTracks: [expect.objectContaining({ title: "Only Native" })],
    });
  });

  it("loads the exact retained row selected by each opaque version token", async () => {
    await openPage();
    const [first, second] = versionsEvents[0].versions;

    await select(first.versionId);
    await select(second.versionId);

    expect(resolver.detailCalls).toEqual([0, 1]);
    expect(resolvedEvents.map((event) => event.versionId)).toEqual([
      first.versionId,
      second.versionId,
    ]);
    expect(resolvedEvents[0].orderedTracks).toHaveLength(2);
    expect(resolvedEvents[1].orderedTracks).toHaveLength(3);
    expect(coordinator.popCalls).toEqual([
      expect.objectContaining({ levels: 1, refresh: false }),
    ]);
  });

  it("issues action authority only for the current successfully selected public version", async () => {
    await openPage();
    const page = versionsEvents[0];
    const [first, second] = page.versions;
    const source = (versionId: string) => ({
      pageId: page.operationId,
      versionId,
      tabId: "tab-1",
      generation: 7,
    });

    expect(service.claimSelectedVersionAction(origin, source(first.versionId))).toBeNull();
    await select(first.versionId);
    const firstAuthority = service.claimSelectedVersionAction(
      origin,
      source(first.versionId)
    );
    expect(firstAuthority).toMatchObject({
      pageId: page.operationId,
      versionId: first.versionId,
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      generation: 7,
      retainedItemKey: "row-a",
      source: { versionCount: 2 },
    });
    expect(firstAuthority?.source.detailDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(firstAuthority && service.isSelectedVersionActionCurrent(firstAuthority)).toBe(true);
    if (!firstAuthority) throw new Error("Expected selected-version authority");
    expect(
      service.isSelectedVersionActionCurrent({
        ...firstAuthority,
        pageId: "foreign-page",
      })
    ).toBe(false);
    expect(
      service.isSelectedVersionActionCurrent({
        ...firstAuthority,
        versionId: second.versionId,
      })
    ).toBe(false);
    expect(
      service.isSelectedVersionActionCurrent({
        ...firstAuthority,
        coreId: "core-2",
      })
    ).toBe(false);
    expect(
      service.isSelectedVersionActionCurrent({
        ...firstAuthority,
        generation: 8,
      })
    ).toBe(false);
    expect(
      service.isSelectedVersionActionCurrent({
        ...firstAuthority,
        retainedItemKey: "row-b",
      })
    ).toBe(false);
    expect(
      service.isSelectedVersionActionCurrent({
        ...firstAuthority,
        source: { ...firstAuthority.source, detailDigest: "changed" },
      })
    ).toBe(false);
    expect(
      service.claimSelectedVersionAction(
        { coreId: "core-1", socketId: "socket-2" },
        source(first.versionId)
      )
    ).toBeNull();
    expect(
      service.claimSelectedVersionAction(origin, {
        ...source(first.versionId),
        tabId: "tab-2",
      })
    ).toBeNull();
    expect(
      service.claimSelectedVersionAction(origin, {
        ...source(first.versionId),
        generation: 8,
      })
    ).toBeNull();

    const next = service.select(origin, {
      operationId: page.operationId,
      versionId: second.versionId,
    });
    expect(next.ack.success).toBe(true);
    next.start?.();
    expect(firstAuthority && service.isSelectedVersionActionCurrent(firstAuthority)).toBe(false);
    await flush();
    expect(service.claimSelectedVersionAction(origin, source(first.versionId))).toBeNull();
    const secondAuthority = service.claimSelectedVersionAction(
      origin,
      source(second.versionId)
    );
    expect(secondAuthority?.retainedItemKey).toBe("row-b");

    service.cancel(origin, { operationId: page.operationId });
    expect(secondAuthority && service.isSelectedVersionActionCurrent(secondAuthority)).toBe(false);
  });

  it("keeps identical track sequences as two separately selectable versions", async () => {
    resolver.detailImpl = () => Promise.resolve(resolution(["Same 1", "Same 2"]));
    await openPage();
    const [first, second] = versionsEvents[0].versions;

    await select(first.versionId);
    await select(second.versionId);

    expect(resolver.detailCalls).toEqual([0, 1]);
    expect(resolvedEvents.map((event) => event.versionId)).toEqual([
      first.versionId,
      second.versionId,
    ]);
  });

  it("restores exact action authority when revisiting a version from the page cache", async () => {
    await openPage();
    const page = versionsEvents[0];
    const [first, second] = page.versions;
    const source = (versionId: string) => ({
      pageId: page.operationId,
      versionId,
      tabId: "tab-1",
      generation: 7,
    });

    await select(first.versionId);
    await select(second.versionId);
    await select(first.versionId);

    expect(resolver.detailCalls).toEqual([0, 1]);
    expect(resolvedEvents.map((event) => event.versionId)).toEqual([
      first.versionId,
      second.versionId,
      first.versionId,
    ]);
    expect(
      service.claimSelectedVersionAction(origin, source(second.versionId))
    ).toBeNull();
    expect(
      service.claimSelectedVersionAction(origin, source(first.versionId))
    ).toMatchObject({
      versionId: first.versionId,
      retainedItemKey: "row-a",
    });
  });

  it("opens an ambiguous catalog anchor when it is bound to one resolved artist", async () => {
    catalogSnapshot = snapshot(album({ resolutionStatus: "ambiguous" }));
    await openPage();

    expect(versionsEvents[0].versions).toHaveLength(2);
    expect(failedEvents).toEqual([]);
  });

  it("publishes native fallback as one version and resolves it without actions", async () => {
    catalogSnapshot = {
      ...snapshot(
        album({
          artistLocalId: undefined,
          resolutionStatus: "unresolved",
          extendedAlbumId: "123456789",
        })
      ),
      artists: [],
    };
    await openPage();
    expect(versionsEvents[0].versions).toHaveLength(1);
    expect(resolver.observeCalls).toBe(0);

    await select(versionsEvents[0].versions[0].versionId);

    expect(fallbackResolver.calls).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({
      actionsAvailable: false,
      orderedTracks: [
        { index: 0, title: "First" },
        { index: 1, title: "Second" },
      ],
    });
  });

  it("returns a per-version failure without destroying other versions", async () => {
    resolver.detailImpl = (index) =>
      index === 0
        ? Promise.reject(new Error("broken row"))
        : Promise.resolve(resolution(["Working"]));
    await openPage();
    const [first, second] = versionsEvents[0].versions;

    await select(first.versionId);
    expect(versionFailedEvents).toHaveLength(1);
    expect(versionFailedEvents[0]).toMatchObject({
      versionId: first.versionId,
      code: "INTERNAL_ERROR",
    });

    await select(second.versionId);
    expect(resolvedEvents[0].versionId).toBe(second.versionId);
  });

  it("retries from the retained parent after re-observation fails", async () => {
    await openPage();
    const [first, second] = versionsEvents[0].versions;
    await select(first.versionId);

    let observationAttempts = 0;
    resolver.observeCurrentImpl = () => {
      observationAttempts += 1;
      return observationAttempts === 1
        ? Promise.reject(
            new DiscographyResolverError(
              "INCOMPLETE_DISCOGRAPHY",
              "transient parent read failure"
            )
          )
        : Promise.resolve(resolver.current);
    };

    await select(second.versionId);
    expect(versionFailedEvents).toHaveLength(1);
    expect(versionFailedEvents[0]).toMatchObject({
      versionId: second.versionId,
      code: "DETAIL_INCOMPLETE",
    });
    expect(coordinator.popCalls).toHaveLength(1);

    await select(second.versionId);
    expect(coordinator.popCalls).toHaveLength(1);
    expect(resolver.observeCurrentCalls).toBe(1);
    expect(resolver.detailCalls).toEqual([0, 1]);
    expect(resolvedEvents.map((event) => event.versionId)).toEqual([
      first.versionId,
      second.versionId,
    ]);
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

  it("fails closed when catalog identity changes during detail selection", async () => {
    await openPage();
    resolver.detailImpl = async () => {
      catalogSnapshot = snapshot(
        album({ exactTitle: "Renamed", normalizedTitle: "renamed" })
      );
      return resolution(["First"]);
    };
    await select(versionsEvents[0].versions[0].versionId);

    expect(resolvedEvents).toEqual([]);
    expect(versionFailedEvents[0].code).toBe("ALBUM_NOT_FOUND");
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
    resolver.observeImpl = () => Promise.reject(new RoonTimeoutError("browse", 1_000));
    await openPage();
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");
    expect(coordinator.quarantineCalls).toBe(1);
  });

  it("expires a hung opening read and suppresses its late result", async () => {
    let releaseObservation: () => void = () => {};
    resolver.observeImpl = () =>
      new Promise((resolve) => {
        releaseObservation = () => resolve(resolver.current);
      });
    const reservation = service.open(origin, request(), sink());
    reservation.start?.();
    await flush();

    jest.advanceTimersByTime(1_000);
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");
    expect(coordinator.quarantineCalls).toBe(1);
    releaseObservation();
    await flush();
    expect(versionsEvents).toEqual([]);
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
});
