import { Logger } from "pino";

import {
  AlbumRef,
  ArtistRef,
  CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
  CATALOG_ARTIST_SEARCH_DEFAULT_LIMIT,
  CATALOG_ARTIST_SEARCH_MAX_LIMIT,
  CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
  CatalogAlbumExtendedFields,
  normalizeCatalogArtistAlbumsResponse,
  normalizeCatalogArtistSearchResponse,
  normalizeCatalogText,
} from "../../../shared/catalogContracts";
import { BrowseItem, BrowseResult } from "../../../shared/types";
import {
  CatalogAuxiliaryArtistResolver,
  CatalogBrowseCoordinator,
  CatalogHierarchy,
  CatalogService,
  CatalogServiceError,
} from "../CatalogService";
import {
  CatalogSessionHandle,
  CoordinatedBrowseSession,
} from "../../roon/BrowseSessionCoordinator";
import { CatalogPersistence } from "../CatalogPersistence";
import {
  CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
  ResolvedSelectedArtistObservation,
} from "../CatalogReconciliation";

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
} as unknown as Logger;

interface CatalogRows {
  artists: BrowseItem[];
  albums: BrowseItem[];
}

interface PageCall {
  coreId: string;
  method: "browse" | "load";
  hierarchy: CatalogHierarchy;
  offset: number;
  count: number;
}

interface PageContext extends PageCall {
  result: BrowseResult;
}

interface DeferredPage {
  reached: Promise<void>;
  release(): void;
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeCatalogCoordinator implements CatalogBrowseCoordinator {
  public readonly acquireCalls: string[] = [];
  public readonly runCalls: string[] = [];
  public readonly releaseCalls: string[] = [];
  public readonly pageCalls: PageCall[] = [];
  public pageTransform?: (context: PageContext) => BrowseResult;
  public postRunError?: Error;
  public releaseError?: Error;

  private readonly rows = new Map<string, CatalogRows>();
  private activeCatalogCore: string | null = null;
  private readonly blockers = new Map<
    string,
    { reached: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> }
  >();
  private handleSequence = 0;

  public constructor(defaultRows: CatalogRows, coreId = "core-a") {
    this.rows.set(coreId, defaultRows);
  }

  public setRows(coreId: string, rows: CatalogRows): void {
    this.rows.set(coreId, rows);
  }

  public blockPage(
    coreId: string,
    hierarchy: CatalogHierarchy,
    offset: number
  ): DeferredPage {
    const reached = deferred();
    const gate = deferred();
    this.blockers.set(this.blockKey(coreId, hierarchy, offset), { reached, gate });
    return {
      reached: reached.promise,
      release: gate.resolve,
    };
  }

  public acquireCatalog(coreId: string): CatalogSessionHandle {
    if (this.activeCatalogCore !== null) {
      throw new Error("overlapping catalog session");
    }
    this.activeCatalogCore = coreId;
    this.acquireCalls.push(coreId);
    this.handleSequence += 1;
    return {
      kind: "catalog",
      handleId: `catalog-${this.handleSequence}`,
      generation: this.handleSequence,
    };
  }

  public async runCatalog<T>(
    coreId: string,
    _handle: CatalogSessionHandle,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    this.runCalls.push(coreId);
    const result = await work(this.session(coreId));
    if (this.postRunError) throw this.postRunError;
    return result;
  }

  public async releaseCatalog(
    coreId: string,
    _handle: CatalogSessionHandle
  ): Promise<void> {
    this.releaseCalls.push(coreId);
    this.activeCatalogCore = null;
    if (this.releaseError) throw this.releaseError;
  }

  private session(coreId: string): CoordinatedBrowseSession {
    return {
      browse: async (options) =>
        this.page(
          coreId,
          "browse",
          options.hierarchy as CatalogHierarchy,
          options.offset ?? 0,
          options.pageSize ?? 100
        ),
      load: async (options) =>
        this.page(
          coreId,
          "load",
          options.hierarchy as CatalogHierarchy,
          options.offset ?? 0,
          options.count ?? 100
        ),
      pop: async () => {
        throw new Error("Catalog scans must not pop or crawl discographies");
      },
    };
  }

  private async page(
    coreId: string,
    method: "browse" | "load",
    hierarchy: CatalogHierarchy,
    offset: number,
    count: number
  ): Promise<BrowseResult> {
    const call = { coreId, method, hierarchy, offset, count };
    this.pageCalls.push(call);
    const blocker = this.blockers.get(this.blockKey(coreId, hierarchy, offset));
    if (blocker) {
      blocker.reached.resolve();
      await blocker.gate.promise;
      this.blockers.delete(this.blockKey(coreId, hierarchy, offset));
    }

    const all = this.rows.get(coreId)?.[hierarchy];
    if (!all) throw new Error(`No ${hierarchy} rows for ${coreId}`);
    const result: BrowseResult = {
      level: 0,
      offset,
      count: all.length,
      totalCount: all.length,
      items: all.slice(offset, offset + count).map((item) => ({ ...item })),
    };
    return this.pageTransform?.({ ...call, result }) ?? result;
  }

  private blockKey(
    coreId: string,
    hierarchy: CatalogHierarchy,
    offset: number
  ): string {
    return `${coreId}:${hierarchy}:${offset}`;
  }
}

class FakeCatalogPersistence implements CatalogPersistence {
  public readonly values = new Map<string, unknown>();
  public readonly reads: string[] = [];
  public readonly writes: Array<{ coreId: string; value: unknown }> = [];
  public readError?: Error;
  public writeError?: Error;
  private writeBlocker?: {
    reached: ReturnType<typeof deferred>;
    gate: ReturnType<typeof deferred>;
  };

  public blockNextWrite(): DeferredPage {
    const reached = deferred();
    const gate = deferred();
    this.writeBlocker = { reached, gate };
    return { reached: reached.promise, release: gate.resolve };
  }

  public async read(coreId: string): Promise<unknown | null> {
    this.reads.push(coreId);
    if (this.readError) throw this.readError;
    return this.values.get(coreId) ?? null;
  }

  public async write(coreId: string, value: unknown): Promise<void> {
    this.writes.push({ coreId, value });
    if (this.writeBlocker) {
      const blocker = this.writeBlocker;
      this.writeBlocker = undefined;
      blocker.reached.resolve();
      await blocker.gate.promise;
    }
    if (this.writeError) throw this.writeError;
    this.values.set(coreId, JSON.parse(JSON.stringify(value)) as unknown);
  }
}

interface MutablePersistedEnvelope {
  version: number;
  coreId: string;
  snapshot: {
    revision: number;
    artists: Array<Record<string, unknown>>;
    albums: Array<Record<string, unknown>>;
  };
}

function mutablePersistedEnvelope(value: unknown): MutablePersistedEnvelope {
  return JSON.parse(JSON.stringify(value)) as MutablePersistedEnvelope;
}

function item(
  title: string,
  itemKey: string | undefined,
  subtitle?: string
): BrowseItem {
  return {
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(itemKey !== undefined ? { itemKey } : {}),
    imageKey: `image-${itemKey ?? "missing"}`,
    hint: "list",
    isLoadable: true,
    isPlayable: false,
  };
}

function rows(artistCount: number, albumCount: number): CatalogRows {
  const artists = Array.from({ length: artistCount }, (_, index) =>
    item(`Artist ${index}`, `artist-${index}`, `${index} albums`)
  );
  const albums = Array.from({ length: albumCount }, (_, index) =>
    item(
      `Album ${index}`,
      `album-${index}`,
      `Artist ${index % Math.max(artistCount, 1)}`
    )
  );
  return { artists, albums };
}

function idFactory(start = 1): () => string {
  let value = start;
  return () => {
    const suffix = value.toString(16).padStart(12, "0");
    value += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  };
}

function service(
  coordinator: FakeCatalogCoordinator,
  options: {
    pageSize?: number;
    maxItemsPerHierarchy?: number;
    now?: () => number;
    createLocalId?: () => string;
    persistence?: CatalogPersistence;
    auxiliaryArtistResolver?: CatalogAuxiliaryArtistResolver;
  } = {}
): CatalogService {
  return new CatalogService(coordinator, logger, {
    pageSize: options.pageSize ?? 100,
    maxItemsPerHierarchy: options.maxItemsPerHierarchy ?? 10_000,
    now: options.now ?? (() => Date.parse("2026-07-15T00:00:00.000Z")),
    createLocalId: options.createLocalId ?? idFactory(),
    persistence: options.persistence,
    auxiliaryArtistResolver: options.auxiliaryArtistResolver,
  });
}

const ARTIST_ID = "10000000-0000-4000-8000-000000000001";
const ALBUM_ID = "20000000-0000-4000-8000-000000000001";
const SECOND_ALBUM_ID = "20000000-0000-4000-8000-000000000002";
const OBSERVED_AT = "2026-07-15T00:00:00.000Z";

function selectedArtist(
  over: Partial<ArtistRef> = {}
): ArtistRef {
  const exactName = over.exactName ?? "Selected Artist";
  return {
    localId: ARTIST_ID,
    coreId: "core-a",
    exactName,
    normalizedName: normalizeCatalogText(exactName),
    firstSeenAt: OBSERVED_AT,
    lastSeenAt: OBSERVED_AT,
    resolutionStatus: "resolved",
    ...over,
  };
}

function selectedAlbum(
  over: Partial<AlbumRef> = {}
): AlbumRef {
  const exactTitle = over.exactTitle ?? "Selected Album";
  const exactArtist = over.exactArtist ?? "Selected Artist";
  return {
    localId: ALBUM_ID,
    coreId: "core-a",
    artistLocalId: ARTIST_ID,
    exactTitle,
    exactArtist,
    normalizedTitle: normalizeCatalogText(exactTitle),
    normalizedArtist: normalizeCatalogText(exactArtist),
    editionText: "",
    firstSeenAt: OBSERVED_AT,
    lastSeenAt: OBSERVED_AT,
    resolutionStatus: "resolved",
    ...over,
  } as AlbumRef;
}

function selectedObservation(
  artistValue: ArtistRef = selectedArtist(),
  albumValues: readonly AlbumRef[] = []
): Record<string, unknown> {
  return {
    sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
    artist: {
      exactName: artistValue.exactName,
      candidateCount: 1,
      ...(artistValue.imageKeyHint
        ? { imageKeyHint: artistValue.imageKeyHint }
        : {}),
    },
    discographyComplete: true,
    albums: albumValues.map((albumValue) => ({
      exactTitle: albumValue.exactTitle,
      exactArtist: albumValue.exactArtist,
      editionText: albumValue.editionText,
      ...(albumValue.imageKeyHint
        ? { imageKeyHint: albumValue.imageKeyHint }
        : {}),
      detail: {
        sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
        fieldInventoryComplete: true,
        headerTitle: albumValue.exactTitle,
        headerSubtitle: albumValue.exactArtist,
        returnedTrackCount: 1,
        totalTrackCount: 1,
        orderedTrackTitles: [`Track for ${albumValue.exactTitle}`],
        originalReleaseDateField: albumValue.originalReleaseYearEvidence
          ? {
              status: "observed",
              date: albumValue.originalReleaseYearEvidence.date,
            }
          : { status: "not-exposed" },
        editionReleaseDateField: albumValue.editionReleaseYearEvidence
          ? {
              status: "observed",
              date: albumValue.editionReleaseYearEvidence.date,
            }
          : { status: "not-exposed" },
      },
    })),
  };
}

function auxiliaryObservation(
  artistValue: Readonly<ArtistRef>,
  albumTitle = "Auxiliary Album"
): ResolvedSelectedArtistObservation {
  return {
    sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
    artist: {
      exactName: artistValue.exactName,
      candidateCount: 1,
    },
    discographyComplete: true,
    albums: [
      {
        exactTitle: albumTitle,
        exactArtist: artistValue.exactName,
        editionText: "",
      },
    ],
  };
}

describe("CatalogService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("pages a 4,541-album catalog exactly once and discards ephemeral authority", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(37, 4_541));
    const catalog = service(coordinator);

    const { snapshot, metrics } = await catalog.scan("core-a");

    expect(snapshot.albums).toHaveLength(4_541);
    expect(snapshot.albums[0].exactTitle).toBe("Album 0");
    expect(snapshot.albums[4_540].exactTitle).toBe("Album 4540");
    expect(new Set(snapshot.albums.map((album) => album.exactTitle)).size).toBe(
      4_541
    );
    expect(snapshot.albums.every((album) => album.resolutionStatus === "unresolved"))
      .toBe(true);
    expect(snapshot.albums.every((album) => album.artistLocalId === undefined)).toBe(
      true
    );
    expect(snapshot.albums.every((album) => album.originalReleaseYear === undefined))
      .toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /itemKey|multiSessionKey|multi_session_key/
    );
    const ephemeralKeys = new Set([
      ...Array.from({ length: 37 }, (_, index) => `artist-${index}`),
      ...Array.from({ length: 4_541 }, (_, index) => `album-${index}`),
    ]);
    expect(
      snapshot.artists.every(
        (artist, index) =>
          artist.imageKeyHint === `image-artist-${index}` &&
          !ephemeralKeys.has(artist.imageKeyHint)
      )
    ).toBe(true);
    expect(
      snapshot.albums.every(
        (album, index) =>
          album.imageKeyHint === `image-album-${index}` &&
          !ephemeralKeys.has(album.imageKeyHint)
      )
    ).toBe(true);

    const albumLoads = coordinator.pageCalls.filter(
      (call) => call.hierarchy === "albums" && call.method === "load"
    );
    expect(albumLoads.map((call) => call.offset)).toEqual(
      Array.from({ length: 45 }, (_, index) => (index + 1) * 100)
    );
    expect(albumLoads[albumLoads.length - 1]).toMatchObject({
      offset: 4_500,
      count: 41,
    });
    expect(coordinator.pageCalls.every((call) =>
      call.hierarchy === "artists" || call.hierarchy === "albums"
    )).toBe(true);
    expect(coordinator.acquireCalls).toEqual(["core-a"]);
    expect(coordinator.runCalls).toEqual(["core-a"]);
    expect(coordinator.releaseCalls).toEqual(["core-a"]);
    expect(metrics.albums).toEqual({
      pages: 46,
      scannedRows: 4_541,
      descriptorRows: 4_541,
    });
    expect(metrics.albumArtistAttribution).toEqual({
      exactUnique: 4_541,
      ambiguous: 0,
      missingOrNonExact: 0,
    });
  });

  it("preserves duplicate semantic rows as separate ambiguous descriptors", async () => {
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Same Artist", "artist-a"), item("Same Artist", "artist-b")],
      albums: [
        item("Same Album", "album-a", "Same Artist"),
        item("Same Album", "album-b", "Same Artist"),
      ],
    });
    const catalog = service(coordinator, { pageSize: 2 });

    const { snapshot, metrics } = await catalog.scan("core-a");

    expect(snapshot.artists).toHaveLength(2);
    expect(snapshot.albums).toHaveLength(2);
    expect(new Set(snapshot.artists.map((artist) => artist.localId)).size).toBe(2);
    expect(new Set(snapshot.albums.map((album) => album.localId)).size).toBe(2);
    expect(snapshot.artists.every((artist) => artist.resolutionStatus === "ambiguous"))
      .toBe(true);
    expect(snapshot.albums.every((album) => album.resolutionStatus === "ambiguous"))
      .toBe(true);
    expect(snapshot.albums.every((album) => album.artistLocalId === undefined)).toBe(
      true
    );
    expect(metrics.albumArtistAttribution).toEqual({
      exactUnique: 0,
      ambiguous: 2,
      missingOrNonExact: 0,
    });
  });

  it("preserves unique root IDs and first-seen timestamps across complete scans", async () => {
    let now = Date.parse("2026-07-15T00:00:00.000Z");
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Stable Artist", "artist-old")],
      albums: [item("Stable Album", "album-old", "Stable Artist")],
    });
    const catalog = service(coordinator, { now: () => now });
    const first = (await catalog.scan("core-a")).snapshot;

    now = Date.parse("2026-07-16T00:00:00.000Z");
    coordinator.setRows("core-a", {
      artists: [item("Stable Artist", "artist-new")],
      albums: [item("Stable Album", "album-new", "Stable Artist")],
    });
    const second = (await catalog.scan("core-a")).snapshot;

    expect(second.artists[0]).toMatchObject({
      localId: first.artists[0].localId,
      firstSeenAt: first.artists[0].firstSeenAt,
      lastSeenAt: "2026-07-16T00:00:00.000Z",
      imageKeyHint: "image-artist-new",
    });
    expect(second.albums[0]).toMatchObject({
      localId: first.albums[0].localId,
      firstSeenAt: first.albums[0].firstSeenAt,
      lastSeenAt: "2026-07-16T00:00:00.000Z",
      imageKeyHint: "image-album-new",
    });
  });

  it("retains duplicate root IDs as an ambiguous set without image or order pairing", async () => {
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Same Artist", "artist-a"), item("Same Artist", "artist-b")],
      albums: [
        item("Same Album", "album-a", "Same Artist"),
        item("Same Album", "album-b", "Same Artist"),
      ],
    });
    const catalog = service(coordinator, { pageSize: 2 });
    const first = (await catalog.scan("core-a")).snapshot;

    coordinator.setRows("core-a", {
      artists: [item("Same Artist", "artist-b-new"), item("Same Artist", "artist-a-new")],
      albums: [
        item("Same Album", "album-b-new", "Same Artist"),
        item("Same Album", "album-a-new", "Same Artist"),
      ],
    });
    const second = (await catalog.scan("core-a")).snapshot;

    expect(new Set(second.artists.map((value) => value.localId))).toEqual(
      new Set(first.artists.map((value) => value.localId))
    );
    expect(new Set(second.albums.map((value) => value.localId))).toEqual(
      new Set(first.albums.map((value) => value.localId))
    );
    expect(second.artists.map((value) => value.imageKeyHint)).toEqual(
      first.artists.map((value) => value.imageKeyHint)
    );
    expect(second.albums.map((value) => value.imageKeyHint)).toEqual(
      first.albums.map((value) => value.imageKeyHint)
    );
    expect(second.albums.every((value) => value.resolutionStatus === "ambiguous"))
      .toBe(true);
  });

  it("measures an unrepresentable album subtitle without fabricating an artist", async () => {
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Known Artist", "artist-a")],
      albums: [
        item("Known", "album-a", "Known Artist"),
        item("Missing subtitle", "album-b"),
        item("Unknown", "album-c", "Not In Artists"),
      ],
    });
    const catalog = service(coordinator);

    const { snapshot, metrics } = await catalog.scan("core-a");

    expect(metrics.albums).toEqual({ pages: 1, scannedRows: 3, descriptorRows: 2 });
    expect(metrics.albumArtistAttribution).toEqual({
      exactUnique: 1,
      ambiguous: 0,
      missingOrNonExact: 2,
    });
    expect(snapshot.albums.map((album) => album.exactTitle)).toEqual([
      "Known",
      "Unknown",
    ]);
    expect(snapshot.albums[1].exactArtist).toBe("Not In Artists");
  });

  it("keeps the prior snapshot visible until both candidate scans complete", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 2));
    const catalog = service(coordinator, { pageSize: 2 });
    const first = (await catalog.scan("core-a")).snapshot;
    coordinator.setRows("core-a", rows(3, 5));
    const blocked = coordinator.blockPage("core-a", "albums", 2);

    const pending = catalog.scan("core-a");
    await blocked.reached;

    expect(catalog.getSnapshot("core-a")).toBe(first);
    expect(catalog.getSnapshot("core-a")?.revision).toBe(1);
    blocked.release();
    const second = (await pending).snapshot;

    expect(second).not.toBe(first);
    expect(second.revision).toBe(2);
    expect(second.artists).toHaveLength(3);
    expect(second.albums).toHaveLength(5);
  });

  it.each([
    [
      "wrong offset",
      (context: PageContext): BrowseResult =>
        context.hierarchy === "albums" && context.offset === 2
          ? { ...context.result, offset: 1 }
          : context.result,
    ],
    [
      "changed total",
      (context: PageContext): BrowseResult =>
        context.hierarchy === "albums" && context.offset === 2
          ? { ...context.result, totalCount: context.result.totalCount! + 1 }
          : context.result,
    ],
    [
      "duplicate ephemeral key",
      (context: PageContext): BrowseResult =>
        context.hierarchy === "albums" && context.offset === 2
          ? {
              ...context.result,
              items: context.result.items.map((entry, index) =>
                index === 0 ? { ...entry, itemKey: "album-0" } : entry
              ),
            }
          : context.result,
    ],
    [
      "missing ephemeral key",
      (context: PageContext): BrowseResult =>
        context.hierarchy === "albums" && context.offset === 2
          ? {
              ...context.result,
              items: context.result.items.map((entry, index) => {
                if (index !== 0) return entry;
                const { itemKey: _discarded, ...withoutKey } = entry;
                return withoutKey;
              }),
            }
          : context.result,
    ],
    [
      "short page",
      (context: PageContext): BrowseResult =>
        context.hierarchy === "albums" && context.offset === 2
          ? { ...context.result, items: context.result.items.slice(0, 1) }
          : context.result,
    ],
  ])("rejects a %s without replacing the last complete snapshot", async (_name, mutate) => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 2));
    const catalog = service(coordinator, { pageSize: 2 });
    const good = (await catalog.scan("core-a")).snapshot;
    coordinator.setRows("core-a", rows(2, 5));
    coordinator.pageTransform = mutate;

    await expect(catalog.scan("core-a")).rejects.toMatchObject({
      code: "INCOMPLETE_SCAN",
    });

    expect(catalog.getSnapshot("core-a")).toBe(good);
    expect(catalog.getSnapshot("core-a")?.revision).toBe(1);
    expect(coordinator.releaseCalls).toHaveLength(2);
  });

  it("rejects a catalog over the configured cap without replacing a good snapshot", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 2));
    const catalog = service(coordinator, {
      pageSize: 2,
      maxItemsPerHierarchy: 5,
    });
    const good = (await catalog.scan("core-a")).snapshot;
    coordinator.setRows("core-a", rows(2, 6));

    await expect(catalog.scan("core-a")).rejects.toMatchObject({
      code: "INCOMPLETE_SCAN",
    });
    expect(catalog.getSnapshot("core-a")).toBe(good);
  });

  it("does not publish a complete candidate rejected by the coordinator as stale", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 2));
    const catalog = service(coordinator, { pageSize: 2 });
    const good = (await catalog.scan("core-a")).snapshot;
    coordinator.setRows("core-a", rows(3, 4));
    coordinator.postRunError = new Error("STALE_GENERATION");

    await expect(catalog.scan("core-a")).rejects.toThrow("STALE_GENERATION");

    expect(catalog.getSnapshot("core-a")).toBe(good);
    expect(coordinator.releaseCalls).toHaveLength(2);
  });

  it("invalidates an in-flight candidate when its Core disconnects", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 2));
    const catalog = service(coordinator, { pageSize: 2 });
    const good = (await catalog.scan("core-a")).snapshot;
    coordinator.setRows("core-a", rows(2, 4));
    const blocked = coordinator.blockPage("core-a", "albums", 2);
    const pending = catalog.scan("core-a");
    await blocked.reached;

    catalog.markCoreDisconnected("core-a");
    blocked.release();

    await expect(pending).rejects.toMatchObject({ code: "INCOMPLETE_SCAN" });
    expect(catalog.getSnapshot("core-a")).toBe(good);
    expect(catalog.getStatus("core-a")).toMatchObject({
      freshness: "stale",
      staleReason: "core-disconnected",
      revision: 1,
    });
  });

  it("coalesces same-Core scans and queues another Core behind the singleton catalog session", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 4));
    coordinator.setRows("core-b", rows(3, 3));
    const catalog = service(coordinator, { pageSize: 2 });
    const blocked = coordinator.blockPage("core-a", "albums", 2);

    const first = catalog.scan("core-a");
    const duplicate = catalog.scan("core-a");
    const otherCore = catalog.scan("core-b");

    expect(duplicate).toBe(first);
    await blocked.reached;
    await Promise.resolve();
    expect(coordinator.acquireCalls).toEqual(["core-a"]);
    expect(coordinator.releaseCalls).toEqual([]);

    blocked.release();
    const [left, right] = await Promise.all([first, otherCore]);
    expect(left.snapshot.coreId).toBe("core-a");
    expect(right.snapshot.coreId).toBe("core-b");
    expect(coordinator.acquireCalls).toEqual(["core-a", "core-b"]);
    expect(coordinator.releaseCalls).toEqual(["core-a", "core-b"]);
    expect(catalog.getSnapshot("core-a")?.coreId).toBe("core-a");
    expect(catalog.getSnapshot("core-b")?.coreId).toBe("core-b");
  });

  it("clears a rejected same-Core scan so a later refresh can retry", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 5));
    const catalog = service(coordinator, { pageSize: 2 });
    coordinator.pageTransform = (context) =>
      context.hierarchy === "albums" && context.offset === 2
        ? { ...context.result, items: context.result.items.slice(0, 1) }
        : context.result;

    await expect(catalog.scan("core-a")).rejects.toMatchObject({
      code: "INCOMPLETE_SCAN",
    });
    expect(catalog.getSnapshot("core-a")).toBeNull();
    coordinator.pageTransform = undefined;

    const retried = await catalog.scan("core-a");
    expect(retried.snapshot.albums).toHaveLength(5);
    expect(retried.snapshot.revision).toBe(1);
    expect(coordinator.acquireCalls).toEqual(["core-a", "core-a"]);
    expect(coordinator.releaseCalls).toEqual(["core-a", "core-a"]);
  });

  it("persists the complete candidate before publishing it in memory", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 5));
    const persistence = new FakeCatalogPersistence();
    const blocked = persistence.blockNextWrite();
    const catalog = service(coordinator, { pageSize: 2, persistence });

    const pending = catalog.scan("core-a");
    await blocked.reached;

    expect(catalog.getSnapshot("core-a")).toBeNull();
    expect(catalog.getLastScanMetrics("core-a")).toBeNull();
    expect(catalog.getStatus("core-a")).toMatchObject({
      freshness: "empty",
      refresh: "running",
      available: false,
      persistence: "healthy",
    });
    expect(persistence.writes).toHaveLength(1);
    expect(persistence.writes[0]).toMatchObject({
      coreId: "core-a",
      value: {
        version: 3,
        coreId: "core-a",
        snapshot: { revision: 1 },
      },
    });
    expect(JSON.stringify(persistence.writes[0].value)).not.toContain("itemKey");

    blocked.release();
    const result = await pending;
    expect(catalog.getSnapshot("core-a")).toBe(result.snapshot);
    expect(persistence.values.get("core-a")).toEqual(
      persistence.writes[0].value
    );
    expect(catalog.getStatus("core-a")).toMatchObject({
      freshness: "fresh",
      available: true,
      complete: true,
      revision: 1,
      artistCount: 2,
      albumCount: 5,
      persistence: "healthy",
    });
  });

  it("publishes a scan as stale when disconnect lands during its disk commit", async () => {
    const persistence = new FakeCatalogPersistence();
    const blocked = persistence.blockNextWrite();
    const catalog = service(new FakeCatalogCoordinator(rows(1, 2)), {
      persistence,
    });

    const pending = catalog.scan("core-a");
    await blocked.reached;
    catalog.markCoreDisconnected("core-a");
    blocked.release();

    const result = await pending;
    expect(catalog.getSnapshot("core-a")).toBe(result.snapshot);
    expect(catalog.getStatus("core-a")).toMatchObject({
      freshness: "stale",
      staleReason: "core-disconnected",
      revision: 1,
      persistence: "healthy",
    });
  });

  it("restores one strictly validated immutable Core snapshot as stale", async () => {
    const persistence = new FakeCatalogPersistence();
    const first = service(new FakeCatalogCoordinator(rows(2, 5)), { persistence });
    const persisted = (await first.scan("core-a")).snapshot;
    const restored = service(new FakeCatalogCoordinator(rows(1, 1)), {
      persistence,
    });

    const firstStart = restored.start("core-a");
    const duplicateStart = restored.start("core-a");
    await Promise.all([firstStart, duplicateStart]);

    expect(persistence.reads).toEqual(["core-a", "core-a"]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(restored.getSnapshot("core-a")).toEqual(persisted);
    expect(restored.getSnapshot("core-a")).not.toBe(persisted);
    expect(Object.isFrozen(restored.getSnapshot("core-a"))).toBe(true);
    expect(Object.isFrozen(restored.getSnapshot("core-a")?.artists)).toBe(true);
    expect(restored.getStatus("core-a")).toMatchObject({
      freshness: "stale",
      staleReason: "restored",
      persistence: "healthy",
      available: true,
      complete: true,
      revision: 1,
    });
  });

  describe("legacy version-1 encoding migration", () => {
    const mojibake = (value: string): string =>
      Buffer.from(value, "utf8").toString("latin1");

    it("repairs version-1 text on load and rewrites once as version 3", async () => {
      const persistence = new FakeCatalogPersistence();
      const seed = service(new FakeCatalogCoordinator(rows(1, 1)), {
        persistence,
      });
      await seed.scan("core-a");

      const legacy = mutablePersistedEnvelope(persistence.values.get("core-a"));
      legacy.version = 1;
      const damagedName = mojibake("Café – Artist");
      legacy.snapshot.artists[0].exactName = damagedName;
      legacy.snapshot.artists[0].normalizedName =
        normalizeCatalogText(damagedName);
      const damagedTitle = mojibake("Don’t Album");
      legacy.snapshot.albums[0].exactTitle = damagedTitle;
      legacy.snapshot.albums[0].normalizedTitle =
        normalizeCatalogText(damagedTitle);
      persistence.values.set("core-a", legacy);
      persistence.writes.length = 0;

      const restored = service(new FakeCatalogCoordinator(rows(1, 1)), {
        persistence,
      });
      await restored.start("core-a");

      const snapshot = restored.getSnapshot("core-a");
      expect(snapshot?.artists[0].exactName).toBe("Café – Artist");
      expect(snapshot?.artists[0].normalizedName).toBe(
        normalizeCatalogText("Café – Artist")
      );
      expect(snapshot?.albums[0].exactTitle).toBe("Don’t Album");
      expect(snapshot?.albums[0].normalizedTitle).toBe(
        normalizeCatalogText("Don’t Album")
      );
      expect(restored.getStatus("core-a")).toMatchObject({
        freshness: "stale",
        staleReason: "restored",
        persistence: "healthy",
      });

      expect(persistence.writes).toHaveLength(1);
      const rewritten = mutablePersistedEnvelope(
        persistence.values.get("core-a")
      );
      expect(rewritten.version).toBe(3);
      expect(rewritten.snapshot.artists[0].exactName).toBe("Café – Artist");
      expect(rewritten.snapshot.albums[0].exactTitle).toBe("Don’t Album");
    });

    it("migrates version-2 snapshots without touching their text", async () => {
      const persistence = new FakeCatalogPersistence();
      const seed = service(new FakeCatalogCoordinator(rows(1, 1)), {
        persistence,
      });
      await seed.scan("core-a");

      const legacy = mutablePersistedEnvelope(
        persistence.values.get("core-a")
      );
      legacy.version = 2;
      // Glyph-only damage: the C1-control variants are unrepresentable in
      // a valid snapshot (contract validators reject control characters).
      // Version 2 is after the encoding repair, so its text is trusted
      // as-is — only the envelope version is migrated.
      const damagedName = mojibake("Café Artist");
      legacy.snapshot.artists[0].exactName = damagedName;
      legacy.snapshot.artists[0].normalizedName =
        normalizeCatalogText(damagedName);
      persistence.values.set("core-a", legacy);
      persistence.writes.length = 0;

      const restored = service(new FakeCatalogCoordinator(rows(1, 1)), {
        persistence,
      });
      await restored.start("core-a");

      expect(restored.getSnapshot("core-a")?.artists[0].exactName).toBe(
        damagedName
      );
      expect(persistence.writes).toHaveLength(1);
      const rewritten = mutablePersistedEnvelope(
        persistence.values.get("core-a")
      );
      expect(rewritten.version).toBe(3);
      expect(rewritten.snapshot.artists[0].exactName).toBe(damagedName);
    });

    it("does not rewrite current version-3 snapshots", async () => {
      const persistence = new FakeCatalogPersistence();
      const seed = service(new FakeCatalogCoordinator(rows(1, 1)), {
        persistence,
      });
      await seed.scan("core-a");

      const current = mutablePersistedEnvelope(
        persistence.values.get("core-a")
      );
      // Glyph-only damage: the C1-control variants are unrepresentable in
      // a valid snapshot (contract validators reject control characters).
      const damagedName = mojibake("Café Artist");
      current.snapshot.artists[0].exactName = damagedName;
      current.snapshot.artists[0].normalizedName =
        normalizeCatalogText(damagedName);
      persistence.values.set("core-a", current);
      persistence.writes.length = 0;

      const restored = service(new FakeCatalogCoordinator(rows(1, 1)), {
        persistence,
      });
      await restored.start("core-a");

      expect(restored.getSnapshot("core-a")?.artists[0].exactName).toBe(
        damagedName
      );
      expect(persistence.writes).toHaveLength(0);
    });
  });

  it.each<[
    string,
    (value: MutablePersistedEnvelope) => void,
  ]>([
    ["unknown version", (value) => (value.version = 4)],
    ["wrong envelope Core", (value) => (value.coreId = "core-b")],
    [
      "authority-bearing artist",
      (value) => (value.snapshot.artists[0].itemKey = "forbidden"),
    ],
    [
      "cross-kind local-ID collision",
      (value) =>
        (value.snapshot.albums[0].localId =
          value.snapshot.artists[0].localId),
    ],
  ])("degrades without overwriting invalid persisted state (%s)", async (_name, mutate) => {
    const persistence = new FakeCatalogPersistence();
    const seed = service(new FakeCatalogCoordinator(rows(1, 1)), { persistence });
    await seed.scan("core-a");
    const invalid = mutablePersistedEnvelope(persistence.values.get("core-a"));
    mutate(invalid);
    persistence.values.set("core-a", invalid);
    persistence.writes.length = 0;
    const coordinator = new FakeCatalogCoordinator(rows(2, 2));
    const catalog = service(coordinator, { persistence });

    await catalog.start("core-a");
    expect(catalog.getSnapshot("core-a")).toBeNull();
    expect(catalog.getStatus("core-a")).toMatchObject({
      freshness: "empty",
      persistence: "degraded",
      available: false,
      lastProblem: { code: "PERSISTENCE_READ_FAILED" },
    });
    await expect(catalog.scan("core-a")).rejects.toMatchObject({
      code: "PERSISTENCE_DEGRADED",
    });
    expect(coordinator.acquireCalls).toEqual([]);
    expect(persistence.writes).toEqual([]);
    expect(persistence.values.get("core-a")).toEqual(invalid);
  });

  it("retains disk, snapshot, revision, and metrics when persistence fails", async () => {
    const persistence = new FakeCatalogPersistence();
    const coordinator = new FakeCatalogCoordinator(rows(1, 1));
    const catalog = service(coordinator, { persistence });
    const first = await catalog.scan("core-a");
    const persisted = structuredClone(persistence.values.get("core-a"));
    coordinator.setRows("core-a", rows(2, 3));
    persistence.writeError = new Error("simulated ENOSPC");

    await expect(catalog.scan("core-a")).rejects.toMatchObject({
      code: "PERSISTENCE_DEGRADED",
    });

    expect(catalog.getSnapshot("core-a")).toBe(first.snapshot);
    expect(catalog.getLastScanMetrics("core-a")).toBe(first.metrics);
    expect(persistence.values.get("core-a")).toEqual(persisted);
    expect(catalog.getStatus("core-a")).toMatchObject({
      freshness: "stale",
      staleReason: "persistence-failed",
      persistence: "degraded",
      revision: 1,
      lastProblem: { code: "PERSISTENCE_WRITE_FAILED" },
    });
  });

  it("serializes selected-artist reconciliation through persistence before publication", async () => {
    const persistence = new FakeCatalogPersistence();
    const catalog = service(new FakeCatalogCoordinator(rows(1, 1)), {
      persistence,
    });
    const first = (await catalog.scan("core-a")).snapshot;
    const blocked = persistence.blockNextWrite();

    const pending = catalog.reconcileSelectedArtist(
      "core-a",
      null,
      selectedObservation(selectedArtist(), [selectedAlbum()])
    );
    await blocked.reached;

    expect(catalog.getSnapshot("core-a")).toBe(first);
    expect(
      catalog.getSnapshot("core-a")?.artists.some(
        (artist) => artist.exactName === "Selected Artist"
      )
    ).toBe(false);

    blocked.release();
    const merged = await pending;
    expect(catalog.getSnapshot("core-a")).toBe(merged.snapshot);
    expect(merged.snapshot.revision).toBe(2);
    expect(mutablePersistedEnvelope(persistence.values.get("core-a")).snapshot)
      .toMatchObject({ revision: 2 });
  });

  it("publishes a disk-committed selected merge as stale after disconnect", async () => {
    const persistence = new FakeCatalogPersistence();
    const blocked = persistence.blockNextWrite();
    const catalog = service(new FakeCatalogCoordinator(rows(1, 1)), {
      persistence,
    });

    const pending = catalog.reconcileSelectedArtist(
      "core-a",
      null,
      selectedObservation(selectedArtist(), [selectedAlbum()])
    );
    await blocked.reached;
    catalog.markCoreDisconnected("core-a");
    blocked.release();

    const merged = await pending;
    expect(catalog.getSnapshot("core-a")).toBe(merged.snapshot);
    expect(catalog.getStatus("core-a")).toMatchObject({
      freshness: "stale",
      staleReason: "core-disconnected",
      revision: 1,
      persistence: "healthy",
    });
  });

  it("publishes a defensive selected-artist working set before any full scan", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(1, 1));
    const catalog = service(coordinator);
    const artist = selectedArtist();
    const album = selectedAlbum({
      originalReleaseYear: 1971,
      originalReleaseYearEvidence: {
        sourceContract: "controller-normalized-browse-album-detail-v1",
        field: "original-release-date",
        date: "1971-11-08",
      },
    });

    const snapshot = (
      await catalog.reconcileSelectedArtist(
        "core-a",
        null,
        selectedObservation(artist, [album])
      )
    ).snapshot;
    artist.exactName = "mutated";
    album.exactTitle = "mutated";
    album.originalReleaseYearEvidence!.date = "2000";

    expect(snapshot.revision).toBe(1);
    expect(snapshot.lastCompleteScanAt).toBeUndefined();
    expect(snapshot.artists[0].exactName).toBe("Selected Artist");
    expect(snapshot.albums[0].exactTitle).toBe("Selected Album");
    expect(snapshot.albums[0].originalReleaseYearEvidence?.date).toBe("1971-11-08");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.artists)).toBe(true);
    expect(Object.isFrozen(snapshot.artists[0])).toBe(true);
    expect(Object.isFrozen(snapshot.albums[0].originalReleaseYearEvidence)).toBe(
      true
    );
  });

  it("rejects a selected overlay when retained missing albums exceed the per-artist bound", async () => {
    const persistence = new FakeCatalogPersistence();
    const catalog = service(new FakeCatalogCoordinator(rows(0, 0)), {
      persistence,
    });
    const albums = (prefix: string) =>
      Array.from({ length: CATALOG_ARTIST_ALBUMS_MAX_LIMIT }, (_, index) =>
        selectedAlbum({ exactTitle: `${prefix} ${index}` })
      );
    const first = await catalog.reconcileSelectedArtist(
      "core-a",
      null,
      selectedObservation(selectedArtist(), albums("First"))
    );
    const writesBefore = persistence.writes.length;

    await expect(
      catalog.reconcileSelectedArtist(
        "core-a",
        first.artist.localId,
        selectedObservation(selectedArtist(), albums("Replacement"))
      )
    ).rejects.toMatchObject({ code: "INVALID_MERGE" });

    expect(catalog.getSnapshot("core-a")).toBe(first.snapshot);
    expect(persistence.writes).toHaveLength(writesBefore);
    expect(first.albums).toHaveLength(CATALOG_ARTIST_ALBUMS_MAX_LIMIT);
  });

  it("keeps immediate selected reconciliation when an older scan commits", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 4));
    const persistence = new FakeCatalogPersistence();
    const catalog = service(coordinator, { pageSize: 2, persistence });
    const blocked = coordinator.blockPage("core-a", "albums", 2);
    const pending = catalog.scan("core-a");
    await blocked.reached;

    const merged = await catalog.reconcileSelectedArtist(
      "core-a",
      null,
      selectedObservation(selectedArtist(), [
        selectedAlbum(),
        selectedAlbum({
          localId: SECOND_ALBUM_ID,
          exactTitle: "Second Selected Album",
          normalizedTitle: normalizeCatalogText("Second Selected Album"),
        }),
      ])
    );
    expect(merged.albums).toHaveLength(2);

    blocked.release();
    const completed = (await pending).snapshot;
    expect(completed.lastCompleteScanAt).toBeDefined();
    expect(
      completed.artists.some(
        (artist) => artist.localId === merged.artist.localId
      )
    ).toBe(true);
    expect(
      completed.albums.filter(
        (album) => album.artistLocalId === merged.artist.localId
      )
    ).toHaveLength(2);
    const persisted = mutablePersistedEnvelope(
      persistence.values.get("core-a")
    );
    expect(persisted.snapshot.revision).toBe(completed.revision);
    expect(
      persisted.snapshot.albums.filter(
        (album) => album.artistLocalId === merged.artist.localId
      )
    ).toHaveLength(2);
  });

  it("preserves reconciled IDs and evidence through restore followed by a root scan", async () => {
    const persistence = new FakeCatalogPersistence();
    const rootRows = {
      artists: [item("Selected Artist", "artist-root")],
      albums: [item("Selected Album", "album-root", "Selected Artist")],
    };
    const writer = service(new FakeCatalogCoordinator(rootRows), { persistence });
    const root = (await writer.scan("core-a")).snapshot;
    const selected = await writer.reconcileSelectedArtist(
      "core-a",
      root.artists[0].localId,
      selectedObservation(selectedArtist(), [
        selectedAlbum({
          originalReleaseYear: 1997,
          originalReleaseYearEvidence: {
            sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
            field: "original-release-date",
            date: "1997-09-22",
          },
        }),
      ])
    );
    const restored = service(new FakeCatalogCoordinator(rootRows), { persistence });

    const rescanned = (await restored.scan("core-a")).snapshot;

    expect(rescanned.artists).toHaveLength(1);
    expect(rescanned.albums).toHaveLength(1);
    expect(rescanned.artists[0].localId).toBe(selected.artist.localId);
    expect(rescanned.albums[0]).toMatchObject({
      localId: selected.albums[0].localId,
      artistLocalId: selected.artist.localId,
      originalReleaseYear: 1997,
      resolutionStatus: "resolved",
    });
    expect(rescanned.albums[0].originalReleaseYearEvidence?.date).toBe(
      "1997-09-22"
    );
  });

  it("does not let a pre-scan overlay mask a later complete-root removal", async () => {
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Selected Artist", "artist-root")],
      albums: [item("Selected Album", "album-root", "Selected Artist")],
    });
    const catalog = service(coordinator);
    const root = (await catalog.scan("core-a")).snapshot;
    const selected = await catalog.reconcileSelectedArtist(
      "core-a",
      root.artists[0].localId,
      selectedObservation(selectedArtist(), [selectedAlbum()])
    );
    coordinator.setRows("core-a", {
      artists: [item("Selected Artist", "artist-root-new")],
      albums: [],
    });

    const rescanned = (await catalog.scan("core-a")).snapshot;

    expect(rescanned.albums).toMatchObject([
      {
        localId: selected.albums[0].localId,
        artistLocalId: selected.artist.localId,
        resolutionStatus: "missing",
      },
    ]);
  });

  it.each([
    [
      "top-level authority",
      () => ({ ...selectedObservation(), itemKey: "forbidden" }),
    ],
    [
      "album authority",
      () => {
        const value = selectedObservation(selectedArtist(), [selectedAlbum()]);
        const albums = value.albums as Array<Record<string, unknown>>;
        albums[0] = { ...albums[0], itemKey: "forbidden" };
        return value;
      },
    ],
    [
      "partial detail",
      () => {
        const value = selectedObservation(selectedArtist(), [selectedAlbum()]);
        const albums = value.albums as Array<Record<string, unknown>>;
        albums[0] = {
          ...albums[0],
          detail: {
            ...(albums[0].detail as Record<string, unknown>),
            returnedTrackCount: 0,
          },
        };
        return value;
      },
    ],
    [
      "album outside selected artist",
      () =>
        selectedObservation(selectedArtist(), [
          selectedAlbum({
            exactArtist: "Another Artist",
            normalizedArtist: normalizeCatalogText("Another Artist"),
          }),
        ]),
    ],
  ])("rejects an invalid selected observation (%s) atomically", async (_name, observation) => {
    const coordinator = new FakeCatalogCoordinator(rows(1, 1));
    const catalog = service(coordinator);
    const good = (await catalog.scan("core-a")).snapshot;

    await expect(
      catalog.reconcileSelectedArtist("core-a", null, observation())
    ).rejects.toBeInstanceOf(CatalogServiceError);
    expect(catalog.getSnapshot("core-a")).toBe(good);
  });

  it("rejects a selected local ID that names another artist", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(1, 1));
    const catalog = service(coordinator);
    const good = (await catalog.scan("core-a")).snapshot;

    await expect(
      catalog.reconcileSelectedArtist(
        "core-a",
        good.artists[0].localId,
        selectedObservation(
          selectedArtist({
            exactName: "Different Artist",
            normalizedName: normalizeCatalogText("Different Artist"),
          })
        )
      )
    ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
    expect(catalog.getSnapshot("core-a")).toBe(good);
  });

  it("rejects malformed or cross-kind selected IDs without changing the snapshot", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(1, 1));
    const catalog = service(coordinator);
    const good = (await catalog.scan("core-a")).snapshot;
    const scannedAlbumId = good.albums[0].localId;
    await expect(
      catalog.reconcileSelectedArtist(
        "core-a",
        scannedAlbumId,
        selectedObservation()
      )
    ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
    await expect(
      catalog.reconcileSelectedArtist("core-a", "not-a-uuid", selectedObservation())
    ).rejects.toMatchObject({ code: "INVALID_MERGE" });
    expect(catalog.getSnapshot("core-a")).toBe(good);
  });

  it("preserves a primary scan error when catalog cleanup also fails", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 5));
    const catalog = service(coordinator, { pageSize: 2 });
    const primary = new Error("primary page failure");
    coordinator.pageTransform = (context) => {
      if (context.hierarchy === "albums" && context.offset === 2) throw primary;
      return context.result;
    };
    coordinator.releaseError = new Error("cleanup failure");

    await expect(catalog.scan("core-a")).rejects.toBe(primary);
    expect(coordinator.releaseCalls).toEqual(["core-a"]);
    expect(catalog.getSnapshot("core-a")).toBeNull();
  });

  it("does not publish when cleanup alone rejects a complete candidate", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(2, 2));
    const catalog = service(coordinator, { pageSize: 2 });
    const first = await catalog.scan("core-a");
    coordinator.setRows("core-a", rows(3, 4));
    coordinator.releaseError = new Error("cleanup lost the catalog generation");

    await expect(catalog.scan("core-a")).rejects.toThrow(
      "cleanup lost the catalog generation"
    );

    expect(catalog.getSnapshot("core-a")).toBe(first.snapshot);
    expect(catalog.getSnapshot("core-a")?.revision).toBe(1);
    expect(catalog.getLastScanMetrics("core-a")).toBe(first.metrics);
    expect(coordinator.releaseCalls).toHaveLength(2);
  });

  it("does not publish when the local-ID generator cannot produce unique UUIDs", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(1, 1));
    const duplicate = "00000000-0000-4000-8000-000000000001";
    const catalog = service(coordinator, { createLocalId: () => duplicate });

    await expect(catalog.scan("core-a")).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
    expect(catalog.getSnapshot("core-a")).toBeNull();
    expect(coordinator.releaseCalls).toEqual(["core-a"]);
  });

  it("records scan timing without choosing a refresh policy", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(1, 1));
    const times = [1_000, 1_275];
    const catalog = service(coordinator, { now: () => times.shift()! });

    const result = await catalog.scan("core-a");

    expect(result.metrics).toMatchObject({
      startedAt: "1970-01-01T00:00:01.000Z",
      completedAt: "1970-01-01T00:00:01.275Z",
      durationMs: 275,
    });
    expect(catalog.getLastScanMetrics("core-a")).toBe(result.metrics);
    expect(Object.isFrozen(result.metrics.albumArtistAttribution)).toBe(true);
  });

  it("ranks exact, prefix, and substring artist matches deterministically without deduping", async () => {
    const coordinator = new FakeCatalogCoordinator({
      artists: [
        item("The Björk Project", "artist-substring"),
        item("Björk", "artist-exact-high"),
        item("FKA moss", "artist-unrelated"),
        item("Björk 😀", "artist-emoji"),
        item("Björk Guðmundsdóttir", "artist-prefix"),
        item("Björk \uE000", "artist-private-use"),
        item("Björk", "artist-exact-low"),
      ],
      albums: [],
    });
    const catalog = service(coordinator);
    await catalog.scan("core-a");

    const result = await catalog.searchArtists("core-a", "  BJO\u0308RK  ");

    expect(result.query).toBe("BJÖRK");
    expect(result.artists.map((artist) => artist.exactName)).toEqual([
      "Björk",
      "Björk",
      "Björk Guðmundsdóttir",
      "Björk \uE000",
      "Björk 😀",
      "The Björk Project",
    ]);
    expect(result.total).toBe(6);
    expect(result.truncated).toBe(false);
    expect(normalizeCatalogArtistSearchResponse(result)).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artists)).toBe(true);
  });

  it("bounds artist search, keeps empty search empty, and isolates Cores", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(45, 0));
    coordinator.setRows("core-b", {
      artists: [item("Only Beta", "beta-artist")],
      albums: [],
    });
    const catalog = service(coordinator, { maxItemsPerHierarchy: 100 });
    await catalog.scan("core-a");
    await catalog.scan("core-b");

    const defaultResult = await catalog.searchArtists("core-a", "Artist");
    const maximumResult = await catalog.searchArtists(
      "core-a",
      "Artist",
      CATALOG_ARTIST_SEARCH_MAX_LIMIT
    );
    const emptyResult = await catalog.searchArtists("core-a", " \t ");

    expect(defaultResult.limit).toBe(CATALOG_ARTIST_SEARCH_DEFAULT_LIMIT);
    expect(defaultResult.artists).toHaveLength(20);
    expect(defaultResult.total).toBe(45);
    expect(defaultResult.truncated).toBe(true);
    expect(maximumResult.artists).toHaveLength(40);
    expect(maximumResult.total).toBe(45);
    expect(maximumResult.truncated).toBe(true);
    expect(emptyResult).toMatchObject({ query: "", total: 0, truncated: false });
    expect(emptyResult.artists).toEqual([]);
    expect(await catalog.searchArtists("core-a", "Only Beta")).toMatchObject({
      total: 0,
      artists: [],
    });
    expect(await catalog.searchArtists("core-b", "Only Beta")).toMatchObject({
      total: 1,
    });
    expect(normalizeCatalogArtistSearchResponse(maximumResult)).toEqual(
      maximumResult
    );

    for (const invalidLimit of [
      0,
      1.5,
      CATALOG_ARTIST_SEARCH_MAX_LIMIT + 1,
      "20",
    ]) {
      await expect(
        catalog.searchArtists("core-a", "Artist", invalidLimit)
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    }
    await expect(
      catalog.searchArtists("core-a", "a".repeat(257))
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(
      catalog.searchArtists("core-a", " ".repeat(257))
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(
      catalog.searchArtists("core-a", "Artist\u0000")
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("keeps the last keyless read model queryable while stale or persistence-degraded", async () => {
    const persistence = new FakeCatalogPersistence();
    const coordinator = new FakeCatalogCoordinator(rows(0, 0));
    const catalog = service(coordinator, { persistence });
    await catalog.reconcileSelectedArtist(
      "core-a",
      null,
      selectedObservation()
    );

    catalog.markCoreDisconnected("core-a");
    const disconnected = await catalog.searchArtists("core-a", "Selected");
    expect(disconnected).toMatchObject({
      total: 1,
      status: {
        freshness: "stale",
        staleReason: "core-disconnected",
        persistence: "healthy",
      },
    });

    persistence.writeError = new Error("disk full");
    await expect(
      catalog.reconcileSelectedArtist(
        "core-a",
        null,
        selectedObservation(
          selectedArtist({
            exactName: "Another Artist",
            normalizedName: normalizeCatalogText("Another Artist"),
          })
        )
      )
    ).rejects.toMatchObject({ code: "PERSISTENCE_DEGRADED" });

    const degraded = await catalog.searchArtists("core-a", "Selected");
    expect(degraded).toMatchObject({
      total: 1,
      status: {
        freshness: "stale",
        staleReason: "persistence-failed",
        persistence: "degraded",
        lastProblem: { code: "PERSISTENCE_WRITE_FAILED" },
      },
    });
    expect(normalizeCatalogArtistSearchResponse(degraded)).toEqual(degraded);
  });

  it("coalesces one auxiliary catalog-session load and keeps resolved cache hits at the same revision", async () => {
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Auxiliary Artist", "artist-live")],
      albums: [],
    });
    const reached = deferred();
    const gate = deferred();
    const resolve = jest.fn(
      async (
        _session: CoordinatedBrowseSession,
        artistValue: Readonly<ArtistRef>
      ) => {
        reached.resolve();
        await gate.promise;
        return {
          kind: "resolved" as const,
          observation: auxiliaryObservation(artistValue),
        };
      }
    );
    const catalog = service(coordinator, {
      auxiliaryArtistResolver: { resolve },
    });
    const scanned = (await catalog.scan("core-a")).snapshot;
    const artistLocalId = scanned.artists[0].localId;
    const acquireBefore = coordinator.acquireCalls.length;
    const runBefore = coordinator.runCalls.length;
    const releaseBefore = coordinator.releaseCalls.length;

    const first = catalog.loadArtistAlbums("core-a", artistLocalId, 1, 1);
    const duplicate = catalog.loadArtistAlbums("core-a", artistLocalId, 1, 8);
    await reached.promise;
    expect(resolve).toHaveBeenCalledTimes(1);
    gate.resolve();

    const [left, right] = await Promise.all([first, duplicate]);
    expect(left).toMatchObject({
      status: { revision: 2 },
      artist: { localId: artistLocalId, resolutionStatus: "resolved" },
      limit: 1,
      total: 1,
      truncated: false,
      albums: [
        {
          artistLocalId,
          exactTitle: "Auxiliary Album",
          resolutionStatus: "resolved",
        },
      ],
    });
    expect(right).toMatchObject({
      status: { revision: 2 },
      artist: { localId: artistLocalId },
      limit: 8,
      total: 1,
    });
    expect(normalizeCatalogArtistAlbumsResponse(left)).toEqual(left);
    expect(JSON.stringify(left)).not.toMatch(
      /itemKey|multiSessionKey|multi_session_key/u
    );
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left?.albums)).toBe(true);
    expect(coordinator.acquireCalls).toHaveLength(acquireBefore + 1);
    expect(coordinator.runCalls).toHaveLength(runBefore + 1);
    expect(coordinator.releaseCalls).toHaveLength(releaseBefore + 1);

    const cached = await catalog.loadArtistAlbums(
      "core-a",
      artistLocalId,
      2,
      1
    );
    expect(cached?.status.revision).toBe(2);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(coordinator.acquireCalls).toHaveLength(acquireBefore + 1);
  });

  it("serializes an auxiliary load behind an active scan on the same catalog session", async () => {
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Auxiliary Artist", "artist-live")],
      albums: [],
    });
    const resolve = jest.fn(
      async (
        _session: CoordinatedBrowseSession,
        artistValue: Readonly<ArtistRef>
      ) => ({
        kind: "resolved" as const,
        observation: auxiliaryObservation(artistValue),
      })
    );
    const catalog = service(coordinator, {
      auxiliaryArtistResolver: { resolve },
    });
    const initial = (await catalog.scan("core-a")).snapshot;
    const blocked = coordinator.blockPage("core-a", "artists", 0);

    const refresh = catalog.scan("core-a");
    await blocked.reached;
    const auxiliary = catalog.loadArtistAlbums(
      "core-a",
      initial.artists[0].localId,
      initial.revision,
      8
    );
    await Promise.resolve();
    expect(coordinator.acquireCalls).toHaveLength(2);

    blocked.release();
    await expect(refresh).resolves.toMatchObject({
      snapshot: { revision: initial.revision + 1 },
    });
    await expect(auxiliary).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(coordinator.acquireCalls).toHaveLength(3);
    expect(coordinator.releaseCalls).toHaveLength(3);
  });

  it("rejects a competing revision before auxiliary persistence or overlay publication", async () => {
    const persistence = new FakeCatalogPersistence();
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Auxiliary Artist", "artist-live")],
      albums: [],
    });
    const reached = deferred();
    const gate = deferred();
    const resolve = jest.fn(
      async (
        _session: CoordinatedBrowseSession,
        artistValue: Readonly<ArtistRef>
      ) => {
        reached.resolve();
        await gate.promise;
        return {
          kind: "resolved" as const,
          observation: auxiliaryObservation(artistValue),
        };
      }
    );
    const catalog = service(coordinator, {
      persistence,
      auxiliaryArtistResolver: { resolve },
    });
    const scanned = (await catalog.scan("core-a")).snapshot;
    const artistLocalId = scanned.artists[0].localId;
    const pending = catalog.loadArtistAlbums(
      "core-a",
      artistLocalId,
      scanned.revision,
      8
    );
    await reached.promise;

    const competingArtist = selectedArtist({
      exactName: "Concurrent Artist",
      normalizedName: normalizeCatalogText("Concurrent Artist"),
    });
    await catalog.reconcileSelectedArtist(
      "core-a",
      null,
      selectedObservation(competingArtist)
    );
    expect(catalog.getSnapshot("core-a")?.revision).toBe(scanned.revision + 1);
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(catalog.getSnapshot("core-a")?.revision).toBe(scanned.revision + 1);
    expect(persistence.writes).toHaveLength(2);
    const target = await catalog.getArtistAlbums("core-a", artistLocalId, 8);
    expect(target).toMatchObject({
      status: { revision: scanned.revision + 1 },
      artist: { resolutionStatus: "unresolved" },
      total: 0,
      albums: [],
    });
    expect(coordinator.releaseCalls).toHaveLength(2);
  });

  it("rejects a disconnected blocked auxiliary resolver without publishing its overlay", async () => {
    const persistence = new FakeCatalogPersistence();
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Auxiliary Artist", "artist-live")],
      albums: [],
    });
    const reached = deferred();
    const gate = deferred();
    const resolve = jest.fn(
      async (
        _session: CoordinatedBrowseSession,
        artistValue: Readonly<ArtistRef>
      ) => {
        reached.resolve();
        await gate.promise;
        return {
          kind: "resolved" as const,
          observation: auxiliaryObservation(artistValue),
        };
      }
    );
    const catalog = service(coordinator, {
      persistence,
      auxiliaryArtistResolver: { resolve },
    });
    const scanned = (await catalog.scan("core-a")).snapshot;
    const artistLocalId = scanned.artists[0].localId;
    const releaseBefore = coordinator.releaseCalls.length;
    const writesBefore = persistence.writes.length;

    const pending = catalog.loadArtistAlbums(
      "core-a",
      artistLocalId,
      scanned.revision,
      8
    );
    await reached.promise;
    catalog.markCoreDisconnected("core-a");
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ code: "INVALID_MERGE" });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(coordinator.releaseCalls).toHaveLength(releaseBefore + 1);
    expect(persistence.writes).toHaveLength(writesBefore);
    expect(catalog.getSnapshot("core-a")).toBe(scanned);
    await expect(
      catalog.getArtistAlbums("core-a", artistLocalId, 8)
    ).resolves.toMatchObject({
      status: {
        revision: scanned.revision,
        freshness: "stale",
        staleReason: "core-disconnected",
      },
      artist: { resolutionStatus: "unresolved" },
      total: 0,
      albums: [],
    });
  });

  it("releases the catalog session and publishes nothing when auxiliary resolution is not unique", async () => {
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Auxiliary Artist", "artist-live")],
      albums: [],
    });
    const resolve = jest.fn(
      async (
        _session: CoordinatedBrowseSession,
        artistValue: Readonly<ArtistRef>
      ) => ({
        kind: "ambiguous" as const,
        observation: {
          sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
          artist: {
            exactName: artistValue.exactName,
            candidateCount: 2,
          },
        },
      })
    );
    const catalog = service(coordinator, {
      auxiliaryArtistResolver: { resolve },
    });
    const scanned = (await catalog.scan("core-a")).snapshot;
    const releaseBefore = coordinator.releaseCalls.length;

    await expect(
      catalog.loadArtistAlbums(
        "core-a",
        scanned.artists[0].localId,
        scanned.revision,
        8
      )
    ).rejects.toMatchObject({ code: "AUXILIARY_ARTIST_UNAVAILABLE" });
    expect(catalog.getSnapshot("core-a")).toBe(scanned);
    expect(coordinator.releaseCalls).toHaveLength(releaseBefore + 1);
  });

  it("returns only albums with the exact artist local-ID binding and preserves evidence", async () => {
    const coordinator = new FakeCatalogCoordinator({
      artists: [item("Selected Artist", "scanned-artist")],
      albums: [item("Text-only Album", "scanned-album", "Selected Artist")],
    });
    const catalog = service(coordinator);
    const scanned = (await catalog.scan("core-a")).snapshot;
    const selected = await catalog.reconcileSelectedArtist(
      "core-a",
      scanned.artists[0].localId,
      selectedObservation(selectedArtist(), [
        selectedAlbum({
          originalReleaseYear: 1997,
          originalReleaseYearEvidence: {
            sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
            field: "original-release-date",
            date: "1997-09-22",
          },
        }),
        selectedAlbum({
          localId: SECOND_ALBUM_ID,
          exactTitle: "Second Selected Album",
        }),
      ])
    );

    const result = await catalog.getArtistAlbums(
      "core-a",
      selected.artist.localId,
      1
    );

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      limit: 1,
      total: 2,
      truncated: true,
      artist: { localId: selected.artist.localId },
    });
    expect(result?.albums.map((album) => album.exactTitle)).toEqual([
      "Selected Album",
    ]);
    expect(result?.albums[0].originalReleaseYearEvidence).toEqual({
      sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
      field: "original-release-date",
      date: "1997-09-22",
    });
    expect(JSON.stringify(result)).not.toContain("Text-only Album");
    expect(normalizeCatalogArtistAlbumsResponse(result)).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.albums)).toBe(true);

    await expect(
      catalog.getArtistAlbums(
        "core-a",
        selected.artist.localId,
        CATALOG_ARTIST_ALBUMS_MAX_LIMIT + 1
      )
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(
      catalog.getArtistAlbums("core-a", "not-a-local-id")
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(
      catalog.getArtistAlbums(
        "core-a",
        "30000000-0000-4000-8000-000000000099"
      )
    ).resolves.toBeNull();
  });

  it("loads persisted-only artist and album queries without an explicit start call", async () => {
    const persistence = new FakeCatalogPersistence();
    const coordinator = new FakeCatalogCoordinator(rows(0, 0));
    const writer = service(coordinator, { persistence });
    const selected = await writer.reconcileSelectedArtist(
      "core-a",
      null,
      selectedObservation(selectedArtist(), [selectedAlbum()])
    );

    const restoredSearch = service(new FakeCatalogCoordinator(rows(0, 0)), {
      persistence,
    });
    const restoredAlbums = service(new FakeCatalogCoordinator(rows(0, 0)), {
      persistence,
    });
    const search = await restoredSearch.searchArtists("core-a", "Selected");
    const albums = await restoredAlbums.getArtistAlbums(
      "core-a",
      selected.artist.localId
    );

    expect(search).toMatchObject({
      total: 1,
      artists: [{ localId: selected.artist.localId }],
      status: { freshness: "stale", staleReason: "restored" },
    });
    expect(albums).toMatchObject({
      total: 1,
      albums: [
        {
          localId: selected.albums[0].localId,
          artistLocalId: selected.artist.localId,
        },
      ],
      status: { freshness: "stale", staleReason: "restored" },
    });
    expect(persistence.reads).toEqual(["core-a", "core-a", "core-a"]);
    expect(normalizeCatalogArtistSearchResponse(search)).toEqual(search);
    expect(normalizeCatalogArtistAlbumsResponse(albums)).toEqual(albums);
  });
});

describe("native enrichment (catalog persistence v3)", () => {
  const NATIVE_FIELDS = {
    extendedAlbumId: "4242",
    extendedRoonAlbumId: "9001",
    originalReleaseDate: { year: 1959, month: 8, day: 17 },
    releaseDate: { year: 1959, month: 0, day: 0 },
    importDate: "2020-01-02T03:04:05.000Z",
    playCount: 7,
    lastPlayedAt: "2026-07-01T00:00:00.000Z",
  } as const;

  it("applies native fields to named albums and strips them from the rest", async () => {
    const persistence = new FakeCatalogPersistence();
    const catalog = service(new FakeCatalogCoordinator(rows(1, 2)), {
      persistence,
    });
    const scanned = (await catalog.scan("core-a")).snapshot;
    const [first, second] = scanned.albums;
    const writesAfterScan = persistence.writes.length;

    await catalog.applyNativeEnrichment(
      "core-a",
      new Map([[first.localId, { ...NATIVE_FIELDS }]])
    );

    const enriched = catalog.getSnapshot("core-a");
    expect(enriched?.revision).toBe(scanned.revision + 1);
    expect(enriched?.albums[0]).toMatchObject({ ...NATIVE_FIELDS });
    expect(enriched?.albums[1]).not.toHaveProperty("extendedAlbumId");
    expect(enriched?.albums[1]).not.toHaveProperty("playCount");
    expect(persistence.writes.length).toBe(writesAfterScan + 1);
    // The persisted v3 envelope carries the fields.
    const persisted = mutablePersistedEnvelope(
      persistence.values.get("core-a")
    );
    expect(persisted.version).toBe(3);
    expect(persisted.snapshot.albums[0]).toMatchObject({
      extendedAlbumId: "4242",
      playCount: 7,
    });

    // A merge naming only the other album strips the first album's
    // fields: enrichment is a pure function of the latest crosswalk.
    await catalog.applyNativeEnrichment(
      "core-a",
      new Map([[second.localId, { playCount: 3 }]])
    );
    const restripped = catalog.getSnapshot("core-a");
    expect(restripped?.albums[0]).not.toHaveProperty("extendedAlbumId");
    expect(restripped?.albums[0]).not.toHaveProperty("playCount");
    expect(restripped?.albums[1]).toMatchObject({ playCount: 3 });
    expect(restripped?.albums[1]).not.toHaveProperty("extendedAlbumId");
  });

  it("is idempotent: an identical merge publishes nothing", async () => {
    const persistence = new FakeCatalogPersistence();
    const catalog = service(new FakeCatalogCoordinator(rows(1, 2)), {
      persistence,
    });
    const scanned = (await catalog.scan("core-a")).snapshot;
    const updates = new Map([
      [scanned.albums[0].localId, { ...NATIVE_FIELDS }],
    ]);
    await catalog.applyNativeEnrichment("core-a", updates);
    const afterFirst = catalog.getSnapshot("core-a");
    const writesAfterFirst = persistence.writes.length;

    await catalog.applyNativeEnrichment("core-a", updates);

    const afterSecond = catalog.getSnapshot("core-a");
    expect(afterSecond?.revision).toBe(afterFirst?.revision);
    expect(persistence.writes.length).toBe(writesAfterFirst);
  });

  it("asserts Core identity before the merge", async () => {
    const catalog = service(new FakeCatalogCoordinator(rows(1, 1)));
    await catalog.scan("core-a");

    await expect(
      catalog.applyNativeEnrichment("core-b", new Map())
    ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
  });

  it("rejects enrichment that would produce an invalid descriptor", async () => {
    const catalog = service(new FakeCatalogCoordinator(rows(1, 1)));
    const scanned = (await catalog.scan("core-a")).snapshot;

    await expect(
      catalog.applyNativeEnrichment(
        "core-a",
        new Map([
          [
            scanned.albums[0].localId,
            { playCount: -1 } as unknown as CatalogAlbumExtendedFields,
          ],
        ])
      )
    ).rejects.toMatchObject({ code: "INVALID_MERGE" });
  });

  it("carries native fields forward across a hierarchy rescan", async () => {
    const coordinator = new FakeCatalogCoordinator(rows(1, 2));
    const catalog = service(coordinator);
    const scanned = (await catalog.scan("core-a")).snapshot;
    await catalog.applyNativeEnrichment(
      "core-a",
      new Map([[scanned.albums[0].localId, { ...NATIVE_FIELDS }]])
    );

    const rescanned = (await catalog.scan("core-a")).snapshot;

    // The rescan recognizes both albums as the same descriptors and the
    // native binding + date/play fields ride that identity forward.
    expect(rescanned.albums[0].localId).toBe(scanned.albums[0].localId);
    expect(rescanned.albums[0]).toMatchObject({ ...NATIVE_FIELDS });
    expect(rescanned.albums[1]).not.toHaveProperty("extendedAlbumId");
  });

  it("migrates a version-2 envelope once and serves it fully without native data", async () => {
    const persistence = new FakeCatalogPersistence();
    const seed = service(new FakeCatalogCoordinator(rows(1, 2)), {
      persistence,
    });
    await seed.scan("core-a");
    const legacy = mutablePersistedEnvelope(persistence.values.get("core-a"));
    legacy.version = 2;
    persistence.values.set("core-a", legacy);
    persistence.writes.length = 0;

    const restored = service(new FakeCatalogCoordinator(rows(1, 1)), {
      persistence,
    });
    await restored.start("core-a");

    // The v2 snapshot is fully functional with native unavailable: every
    // album serves without native fields, status stays honest.
    const snapshot = restored.getSnapshot("core-a");
    expect(snapshot?.albums).toHaveLength(2);
    for (const album of snapshot?.albums ?? []) {
      expect(album).not.toHaveProperty("extendedAlbumId");
      expect(album).not.toHaveProperty("originalReleaseDate");
      expect(album).not.toHaveProperty("importDate");
      expect(album).not.toHaveProperty("playCount");
    }
    expect(restored.getStatus("core-a")).toMatchObject({
      freshness: "stale",
      staleReason: "restored",
      persistence: "healthy",
      available: true,
    });
    // Migrated once: rewritten as v3 exactly one time.
    expect(persistence.writes).toHaveLength(1);
    expect(
      mutablePersistedEnvelope(persistence.values.get("core-a")).version
    ).toBe(3);

    // Idempotent: a second service over the same file migrates nothing.
    const second = service(new FakeCatalogCoordinator(rows(1, 1)), {
      persistence,
    });
    await second.start("core-a");
    expect(persistence.writes).toHaveLength(1);
    expect(second.getSnapshot("core-a")?.albums).toHaveLength(2);
  });

  it("accepts and validates native fields persisted in a v3 envelope", async () => {
    const persistence = new FakeCatalogPersistence();
    const seed = service(new FakeCatalogCoordinator(rows(1, 1)), {
      persistence,
    });
    await seed.scan("core-a");
    const envelope = mutablePersistedEnvelope(
      persistence.values.get("core-a")
    );
    Object.assign(envelope.snapshot.albums[0], { ...NATIVE_FIELDS });
    persistence.values.set("core-a", envelope);

    const restored = service(new FakeCatalogCoordinator(rows(1, 1)), {
      persistence,
    });
    await restored.start("core-a");

    expect(restored.getSnapshot("core-a")?.albums[0]).toMatchObject({
      ...NATIVE_FIELDS,
    });

    // A tampered native field degrades instead of serving.
    const tampered = mutablePersistedEnvelope(
      persistence.values.get("core-a")
    );
    tampered.snapshot.albums[0].playCount = -1;
    persistence.values.set("core-a", tampered);
    const degraded = service(new FakeCatalogCoordinator(rows(1, 1)), {
      persistence,
    });
    await degraded.start("core-a");
    expect(degraded.getSnapshot("core-a")).toBeNull();
    expect(degraded.getStatus("core-a").persistence).toBe("degraded");
  });
});
