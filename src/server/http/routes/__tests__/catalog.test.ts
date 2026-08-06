/**
 * The collapsed catalog route, proven through the §3 interface alone.
 *
 * This suite is PUBLIC: it imports nothing from a walled root, so it compiles and
 * runs in a tree with the extended-feature layer deleted. That is the point of
 * the split — the route behaviour a public build actually serves, including the
 * error mapping, has to stay guarded in a build carrying no extended features.
 *
 * The extended-feature cases — the Most Played view and drills, the playlist
 * list, the contents failure mapping, and the mutation and Focus editor surface —
 * live in the walled counterpart suite, `catalogRoutesNative.test.ts`, alongside
 * the layer it exercises. They assert content the walled layer computes or
 * statuses walled error classes choose, so they belong that side of the wall.
 * Nothing was dropped in the move. Deliberately named without its directory:
 * this suite must carry no path into a walled root, not even in prose.
 */
import {
  CatalogBrowseCoordinator,
  CatalogService,
  CatalogServiceError,
} from "../../../../core/catalog/CatalogService";
import type { CatalogSessionHandle } from "../../../../core/roon/BrowseSessionCoordinator";
import {
  CatalogArtistSearchResponse,
  CatalogStatus,
  normalizeCatalogArtistAlbumsResponse,
  normalizeCatalogArtistSearchResponse,
  normalizeCatalogRefreshAcceptedResponse,
  normalizeCatalogStatus,
} from "../../../../shared/timelineCatalogContracts";
import {
  normalizeCatalogIndexResponse,
} from "../../../../shared/catalogIndexContracts";
import {
  normalizePlaylistContentsResponse,
} from "../../../../shared/playlistContracts";
import {
  buildApiRequestInit,
} from "../../../../shared/apiRequest";
import {
  LIBRARY_FEATURES_ABSENT_REASON,
  LibraryFeatureRequestError,
  LibraryFeatureUnavailableError,
} from "../../../libraryFeatures";
import {
  CatalogHttpNative,
  CatalogHttpPlaylistContents,
} from "../catalog";
import {
  ARTIST_ID,
  ALBUM_ID,
  ALBUM_ID_2,
  OBSERVED_AT,
  logger,
  status,
  artist,
  album,
  snapshot,
  fakeService,
  roonClient,
  serve,
  deferred,
} from "./catalogRouteHarness";

describe("catalog HTTP routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it("loads strict status for the server-derived Core and rejects Core input", async () => {
    const service = fakeService();
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const response = await fetch(`${app.url}/api/catalog/status`);
      const body = JSON.parse(await response.text()) as unknown;
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(normalizeCatalogStatus(body)).toEqual(status());
      expect(service.start).toHaveBeenCalledWith("core-a");
      expect(service.getStatus).toHaveBeenCalledWith("core-a");

      const injected = await fetch(
        `${app.url}/api/catalog/status?coreId=core-b`
      );
      expect(injected.status).toBe(400);
      expect(service.start).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("serves the bulk index without year fields and with real bound counts", async () => {
    const service = fakeService();
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const response = await fetch(`${app.url}/api/catalog/index`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as {
        status: CatalogStatus;
        artists: Array<Record<string, unknown>>;
        albums: Array<Record<string, unknown>>;
      };
      expect(service.start).toHaveBeenCalledWith("core-a");
      expect(body.status).toEqual(status());
      expect(body.artists).toEqual([
        {
          localId: ARTIST_ID,
          name: "Björk",
          knownAlbumCount: 1,
          countComplete: true,
        },
      ]);
      expect(body.albums).toEqual([
        {
          localId: ALBUM_ID,
          artistLocalId: ARTIST_ID,
          resolutionStatus: "resolved",
          title: "Homogenic",
          artist: "Björk",
        },
      ]);
      // The snapshot fixture carries year evidence; the index must not.
      expect("originalReleaseYear" in body.albums[0]).toBe(false);
      expect("originalReleaseYearEvidence" in body.albums[0]).toBe(false);
      // No native module wired: the capability field is omitted.
      expect("native" in body).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("serves the native date-feature capability on the index", async () => {
    const service = fakeService();
    const capability = {
      state: "COMPATIBLE_FRESH",
      reason: "native snapshot is compatible and fresh",
      pulledAt: "2026-07-25T00:00:00.000Z",
      profileSooid: "ab12",
      stale: false,
      dateFeaturesAvailable: true,
      playFeaturesAvailable: true,
      playFeaturesUnavailableReason: null,
      playlistFeaturesAvailable: true,
      playlistFeaturesUnavailableReason: null,
      stateFilterFeaturesAvailable: true,
      stateFilterFeaturesUnavailableReason: null,
    } as const;
    const nativeCatalog: CatalogHttpNative = {
      requestRefresh: jest.fn(),
      getCapability: jest.fn(async () => capability),
      getMostPlayedSnapshot: jest.fn(async () => null),
      getPlaylistSnapshot: jest.fn(async () => null),
    };
    const app = await serve(roonClient(() => "core-a"), service, nativeCatalog);
    try {
      const response = await fetch(`${app.url}/api/catalog/index`);
      expect(response.status).toBe(200);
      // Parse via text: undici's response.json() returns host-realm objects,
      // which the strict plain-record contract rejects inside the jest vm.
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(nativeCatalog.getCapability).toHaveBeenCalledWith("core-a");
      expect(body.native).toEqual({
        dateFeaturesAvailable: true,
        playFeaturesAvailable: true,
        playlistFeaturesAvailable: true,
        stateFilterFeaturesAvailable: true,
      });
      // The wire payload passes the strict client-side contract.
      expect(normalizeCatalogIndexResponse(body)).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("serves the honest capability reason when date features are unavailable", async () => {
    const service = fakeService();
    const capability = {
      state: "NO_SNAPSHOT",
      reason: "no native catalog snapshot is available",
      pulledAt: null,
      profileSooid: null,
      stale: false,
      dateFeaturesAvailable: false,
      playFeaturesAvailable: false,
      playFeaturesUnavailableReason: "no native catalog snapshot is available",
      playlistFeaturesAvailable: false,
      playlistFeaturesUnavailableReason: "no native catalog snapshot is available",
      stateFilterFeaturesAvailable: false,
      stateFilterFeaturesUnavailableReason:
        "no native catalog snapshot is available",
    } as const;
    const nativeCatalog: CatalogHttpNative = {
      requestRefresh: jest.fn(),
      getCapability: jest.fn(async () => capability),
      getMostPlayedSnapshot: jest.fn(async () => null),
      getPlaylistSnapshot: jest.fn(async () => null),
    };
    const app = await serve(roonClient(() => "core-a"), service, nativeCatalog);
    try {
      const response = await fetch(`${app.url}/api/catalog/index`);
      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(body.native).toEqual({
        dateFeaturesAvailable: false,
        dateFeaturesUnavailableReason:
          "no native catalog snapshot is available",
        playFeaturesAvailable: false,
        playFeaturesUnavailableReason:
          "no native catalog snapshot is available",
        playlistFeaturesAvailable: false,
        playlistFeaturesUnavailableReason:
          "no native catalog snapshot is available",
        stateFilterFeaturesAvailable: false,
        stateFilterFeaturesUnavailableReason:
          "no native catalog snapshot is available",
      });
      expect(normalizeCatalogIndexResponse(body)).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("serves the index without the capability field when evaluation fails", async () => {
    const service = fakeService();
    const nativeCatalog: CatalogHttpNative = {
      requestRefresh: jest.fn(),
      getCapability: jest.fn(async () => {
        throw new Error("snapshot store unreadable");
      }),
      getMostPlayedSnapshot: jest.fn(async () => null),
      getPlaylistSnapshot: jest.fn(async () => null),
    };
    const app = await serve(roonClient(() => "core-a"), service, nativeCatalog);
    try {
      const response = await fetch(`${app.url}/api/catalog/index`);
      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect("native" in body).toBe(false);
      expect(normalizeCatalogIndexResponse(body)).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("preserves unbound and ambiguous albums and reports incomplete counts", async () => {
    const service = fakeService();
    const unbound = {
      ...album(),
      localId: ALBUM_ID_2,
      artistLocalId: undefined,
      exactTitle: "Mystery",
      normalizedTitle: "mystery",
      resolutionStatus: "ambiguous" as const,
    };
    delete (unbound as Record<string, unknown>).artistLocalId;
    service.getSnapshot.mockReturnValue({
      ...snapshot(),
      albums: [album(), unbound],
    } as ReturnType<typeof snapshot>);
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const response = await fetch(`${app.url}/api/catalog/index`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        artists: Array<Record<string, unknown>>;
        albums: Array<Record<string, unknown>>;
      };
      expect(body.albums).toHaveLength(2);
      expect(body.albums[1]).toEqual({
        localId: ALBUM_ID_2,
        resolutionStatus: "ambiguous",
        title: "Mystery",
        artist: "Björk",
      });
      expect("artistLocalId" in body.albums[1]).toBe(false);
      expect(body.artists[0]).toMatchObject({
        knownAlbumCount: 1,
        countComplete: false,
      });
    } finally {
      await app.close();
    }
  });

  it("returns an honest 409 when the catalog is empty and 503 when degraded", async () => {
    const service = fakeService();
    service.getSnapshot.mockReturnValue(null);
    // The status contract is strict: empty means available false,
    // revision 0, zero counts, and no timestamp keys at all.
    const emptyStatus: CatalogStatus = {
      coreId: "core-a",
      freshness: "empty",
      persistence: "healthy",
      refresh: "idle",
      available: false,
      complete: false,
      revision: 0,
      artistCount: 0,
      albumCount: 0,
    };
    service.getStatus.mockReturnValue(emptyStatus);
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const empty = await fetch(`${app.url}/api/catalog/index`);
      expect(empty.status).toBe(409);
      expect(await empty.json()).toEqual({
        error: "catalog empty",
        details: "CATALOG_EMPTY",
      });

      service.getStatus.mockReturnValue({
        ...emptyStatus,
        persistence: "degraded",
        lastProblem: {
          code: "PERSISTENCE_READ_FAILED",
          occurredAt: OBSERVED_AT,
        },
      });
      const degraded = await fetch(`${app.url}/api/catalog/index`);
      expect(degraded.status).toBe(503);
      expect(await degraded.json()).toEqual({
        error: "Catalog unavailable",
        details: "SERVICE_UNAVAILABLE",
      });

      const badQuery = await fetch(`${app.url}/api/catalog/index?x=1`);
      expect(badQuery.status).toBe(400);
      expect(await badQuery.json()).toEqual({
        error: "Invalid catalog request",
      });
    } finally {
      await app.close();
    }
  });

  it("returns fixed 503 responses for every endpoint while unpaired", async () => {
    const service = fakeService();
    const app = await serve(roonClient(() => null), service);
    try {
      const requests: Array<[string, RequestInit | undefined]> = [
        ["/api/catalog/status", undefined],
        ["/api/catalog/index", undefined],
        ["/api/catalog/refresh", { method: "POST" }],
        ["/api/catalog/artists?query=Bj%C3%B6rk", undefined],
        [`/api/catalog/artists/${ARTIST_ID}/albums`, undefined],
      ];
      for (const [path, init] of requests) {
        const response = await fetch(`${app.url}${path}`, init);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: "Roon core not paired",
          details: "CORE_UNPAIRED",
        });
      }
      expect(service.start).not.toHaveBeenCalled();
      expect(service.scan).not.toHaveBeenCalled();
      expect(service.searchArtists).not.toHaveBeenCalled();
      expect(service.getArtistAlbums).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects client-owned Core input and every refresh request body", async () => {
    const service = fakeService();
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const requests: RequestInit[] = [
        { method: "POST" },
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ coreId: "core-b" }),
        },
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "core-b",
        },
      ];
      const paths = [
        "/api/catalog/refresh?coreId=core-b",
        "/api/catalog/refresh",
        "/api/catalog/refresh",
      ];
      for (let index = 0; index < requests.length; index += 1) {
        const response = await fetch(`${app.url}${paths[index]}`, requests[index]);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "Invalid catalog request",
        });
      }
      expect(service.start).not.toHaveBeenCalled();
      expect(service.scan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects valid service responses for a Core other than the paired Core", async () => {
    const service = fakeService();
    const wrongStatus = status({ coreId: "core-b" });
    service.getStatus.mockReturnValue(wrongStatus);
    service.searchArtists.mockResolvedValue({
      status: wrongStatus,
      query: "Björk",
      limit: 20,
      total: 1,
      truncated: false,
      artists: [artist("core-b")],
    });
    service.getArtistAlbums.mockResolvedValue({
      status: wrongStatus,
      artist: artist("core-b"),
      limit: 200,
      total: 1,
      truncated: false,
      albums: [album("core-b")],
    });
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const requests: Array<[string, RequestInit | undefined]> = [
        ["/api/catalog/status", undefined],
        ["/api/catalog/index", undefined],
        ["/api/catalog/refresh", { method: "POST" }],
        ["/api/catalog/artists?query=Bj%C3%B6rk", undefined],
        [`/api/catalog/artists/${ARTIST_ID}/albums`, undefined],
      ];
      for (const [path, init] of requests) {
        const response = await fetch(`${app.url}${path}`, init);
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({
          error: "Catalog unavailable",
          details: "SERVICE_UNAVAILABLE",
        });
      }
    } finally {
      await app.close();
    }
  });

  it("returns bounded strict search and rejects malformed limits", async () => {
    const service = fakeService();
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const response = await fetch(
        `${app.url}/api/catalog/artists?query=Bj%C3%B6rk&limit=40`
      );
      const body = JSON.parse(await response.text()) as unknown;
      expect(response.status).toBe(200);
      expect(normalizeCatalogArtistSearchResponse(body)).not.toBeNull();
      expect(service.searchArtists).toHaveBeenCalledWith(
        "core-a",
        "Björk",
        40
      );

      const empty = await fetch(`${app.url}/api/catalog/artists`);
      expect(await empty.json()).toMatchObject({ query: "", total: 0, artists: [] });

      for (const query of ["limit=0", "limit=41", "limit=1.5", "limit=1&limit=2"]) {
        const invalid = await fetch(`${app.url}/api/catalog/artists?${query}`);
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({
          error: "Invalid catalog request",
          details: "INVALID_QUERY",
        });
      }
    } finally {
      await app.close();
    }
  });

  it("rejects an old-Core search response after the paired Core changes", async () => {
    let coreId = "core-a";
    const pending = deferred<CatalogArtistSearchResponse>();
    const service = fakeService();
    service.searchArtists.mockReturnValueOnce(pending.promise);
    const app = await serve(roonClient(() => coreId), service);
    try {
      const request = fetch(`${app.url}/api/catalog/artists?query=Bj%C3%B6rk`);
      while (service.searchArtists.mock.calls.length === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      coreId = "core-b";
      pending.resolve({
        status: status(),
        query: "Björk",
        limit: 20,
        total: 1,
        truncated: false,
        artists: [artist()],
      });

      const response = await request;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Roon core changed during catalog request",
        details: "CORE_UNPAIRED",
      });
    } finally {
      await app.close();
    }
  });

  it("returns exact-bound albums, fixed 404, and sanitized query errors", async () => {
    const service = fakeService();
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const response = await fetch(
        `${app.url}/api/catalog/artists/${ARTIST_ID}/albums?limit=1`
      );
      const body = JSON.parse(await response.text()) as unknown;
      expect(response.status).toBe(200);
      const normalized = normalizeCatalogArtistAlbumsResponse(body);
      expect(normalized).not.toBeNull();
      expect(normalized?.albums[0].originalReleaseYearEvidence).toEqual({
        sourceContract: "controller-normalized-browse-album-detail-v1",
        field: "original-release-date",
        date: "1997-09-22",
      });
      expect(JSON.stringify(body)).not.toMatch(
        /itemKey|multiSessionKey|multi_session_key|actionId|filesystem/u
      );
      expect(service.getArtistAlbums).toHaveBeenCalledWith(
        "core-a",
        ARTIST_ID,
        1
      );
      expect(service.loadArtistAlbums).not.toHaveBeenCalled();

      const missing = await fetch(
        `${app.url}/api/catalog/artists/30000000-0000-4000-8000-000000000099/albums`
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: "Catalog artist not found",
        details: "CATALOG_ARTIST_NOT_FOUND",
      });

      service.getStatus.mockReturnValueOnce({
        coreId: "core-a",
        freshness: "empty",
        persistence: "healthy",
        refresh: "idle",
        available: false,
        complete: false,
        revision: 0,
        artistCount: 0,
        albumCount: 0,
      });
      const unavailable = await fetch(
        `${app.url}/api/catalog/artists/30000000-0000-4000-8000-000000000099/albums`
      );
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({
        error: "Catalog unavailable",
        details: "SERVICE_UNAVAILABLE",
      });

      service.getStatus.mockReturnValueOnce({
        coreId: "core-a",
        freshness: "fresh",
        persistence: "healthy",
        refresh: "idle",
        available: true,
        complete: false,
        revision: 1,
        artistCount: 1,
        albumCount: 1,
        updatedAt: OBSERVED_AT,
      });
      const partial = await fetch(
        `${app.url}/api/catalog/artists/30000000-0000-4000-8000-000000000099/albums`
      );
      expect(partial.status).toBe(503);
      expect(await partial.json()).toEqual({
        error: "Catalog unavailable",
        details: "SERVICE_UNAVAILABLE",
      });

      const invalid = await fetch(
        `${app.url}/api/catalog/artists/not-a-uuid/albums`
      );
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(await invalid.json())).not.toContain("unsafe test detail");
    } finally {
      await app.close();
    }
  });

  it("loads auxiliary albums only through revision-gated POST and rejects conflicts or revision leaps", async () => {
    const service = fakeService();
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const loaded = await fetch(
        `${app.url}/api/catalog/artists/${ARTIST_ID}/albums/load?revision=1&limit=1`,
        buildApiRequestInit({ method: "POST" })
      );
      expect(loaded.status).toBe(200);
      const rawLoaded = JSON.parse(await loaded.text()) as unknown;
      const body = normalizeCatalogArtistAlbumsResponse(rawLoaded);
      expect(body).toMatchObject({
        status: { revision: 2 },
        artist: { localId: ARTIST_ID, resolutionStatus: "resolved" },
        limit: 1,
      });
      expect(service.loadArtistAlbums).toHaveBeenCalledWith(
        "core-a",
        ARTIST_ID,
        1,
        1
      );
      expect(service.getArtistAlbums).not.toHaveBeenCalled();

      service.loadArtistAlbums.mockRejectedValueOnce(
        new CatalogServiceError("REVISION_CONFLICT", "/private/unsafe/revision")
      );
      const conflict = await fetch(
        `${app.url}/api/catalog/artists/${ARTIST_ID}/albums/load?revision=1&limit=1`,
        { method: "POST" }
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({
        error: "Catalog changed; retry request",
        details: "REVISION_CONFLICT",
      });

      service.loadArtistAlbums.mockResolvedValueOnce({
        status: status({ revision: 3 }),
        artist: artist(),
        limit: 1,
        total: 1,
        truncated: false,
        albums: [album()],
      });
      const leap = await fetch(
        `${app.url}/api/catalog/artists/${ARTIST_ID}/albums/load?revision=1&limit=1`,
        { method: "POST" }
      );
      expect(leap.status).toBe(503);
      expect(await leap.json()).toEqual({
        error: "Catalog unavailable",
        details: "SERVICE_UNAVAILABLE",
      });

      const invalid = await fetch(
        `${app.url}/api/catalog/artists/${ARTIST_ID}/albums/load?revision=0&limit=1`,
        { method: "POST" }
      );
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(await invalid.json())).not.toContain("unsafe");
    } finally {
      await app.close();
    }
  });

  it("coalesces pending real refreshes and returns status only", async () => {
    const gate = deferred<void>();
    let blocked = false;
    const acquireCatalog = jest.fn(
      (): CatalogSessionHandle => ({
        kind: "catalog",
        handleId: "catalog-1",
        generation: 1,
      })
    );
    const coordinator: CatalogBrowseCoordinator = {
      acquireCatalog,
      runCatalog: async (_coreId, _handle, work) =>
        work({
          browse: async () => {
            if (!blocked) {
              blocked = true;
              await gate.promise;
            }
            return {
              level: 0,
              offset: 0,
              count: 0,
              totalCount: 0,
              items: [],
            };
          },
          load: async () => {
            throw new Error("empty catalog must not load another page");
          },
          pop: async () => {
            throw new Error("catalog scan must not pop");
          },
        }),
      releaseCatalog: async () => undefined,
    };
    const service = new CatalogService(coordinator, logger);
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const first = await fetch(`${app.url}/api/catalog/refresh`, {
        method: "POST",
      });
      const second = await fetch(`${app.url}/api/catalog/refresh`, {
        method: "POST",
      });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      const firstBody = JSON.parse(await first.text()) as Record<string, unknown>;
      const secondBody = JSON.parse(await second.text()) as Record<string, unknown>;
      expect(Object.keys(firstBody)).toEqual(["status"]);
      expect(Object.keys(secondBody)).toEqual(["status"]);
      const firstAccepted = normalizeCatalogRefreshAcceptedResponse(firstBody);
      const secondAccepted = normalizeCatalogRefreshAcceptedResponse(secondBody);
      expect(firstAccepted?.status.refresh).toBe("running");
      expect(secondAccepted?.status.refresh).toBe("running");
      expect(firstBody).not.toHaveProperty("snapshot");
      expect(secondBody).not.toHaveProperty("snapshot");
      expect(acquireCatalog).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      for (
        let attempt = 0;
        attempt < 20 && service.getStatus("core-a").refresh === "running";
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(service.getStatus("core-a").refresh).toBe("idle");
      await app.close();
    }
  });

  it("triggers the native snapshot pull on the explicit refresh POST", async () => {
    const service = fakeService();
    const nativeCatalog: CatalogHttpNative = {
      requestRefresh: jest.fn(),
      getCapability: jest.fn(),
      getMostPlayedSnapshot: jest.fn(async () => null),
      getPlaylistSnapshot: jest.fn(async () => null),
    };
    const app = await serve(
      roonClient(() => "core-a"),
      service,
      nativeCatalog
    );
    try {
      const refresh = await fetch(`${app.url}/api/catalog/refresh`, {
        method: "POST",
      });
      expect(refresh.status).toBe(202);
      expect(service.scan).toHaveBeenCalledWith("core-a");
      expect(nativeCatalog.requestRefresh).toHaveBeenCalledWith("core-a");
    } finally {
      await app.close();
    }
  });

  it("handles rejected refreshes and unexpected failures without leaking details", async () => {
    const service = fakeService();
    service.scan.mockReturnValueOnce(
      Promise.reject(new Error("/private/secret/catalog.json"))
    );
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const refresh = await fetch(`${app.url}/api/catalog/refresh`, {
        method: "POST",
      });
      expect(refresh.status).toBe(202);
      expect(JSON.stringify(await refresh.json())).not.toContain("/private/secret");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ coreId: "core-a" }),
        "Catalog refresh failed in background"
      );

      service.searchArtists.mockRejectedValueOnce(
        new Error("/private/secret/catalog.json")
      );
      const failed = await fetch(
        `${app.url}/api/catalog/artists?query=Bj%C3%B6rk`
      );
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({
        error: "Catalog unavailable",
        details: "SERVICE_UNAVAILABLE",
      });
    } finally {
      await app.close();
    }
  });

  it("refuses refresh while persistence is degraded", async () => {
    const service = fakeService();
    service.getStatus.mockReturnValue(
      status({
        freshness: "stale",
        staleReason: "persistence-failed",
        persistence: "degraded",
        lastProblem: {
          code: "PERSISTENCE_WRITE_FAILED",
          occurredAt: OBSERVED_AT,
        },
      })
    );
    const app = await serve(roonClient(() => "core-a"), service);
    try {
      const response = await fetch(`${app.url}/api/catalog/refresh`, {
        method: "POST",
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Catalog unavailable",
        details: "PERSISTENCE_DEGRADED",
      });
      expect(service.scan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("serves playlist contents through the orchestration service", async () => {
    const service = fakeService();
    const playlistContents: CatalogHttpPlaylistContents = {
      getContents: jest.fn(async (coreId: string, playlistId: string) => ({
        playlistId,
        name: "Last Year",
        kind: "smart" as const,
        totalCount: 481,
        truncated: true,
        items: [
          {
            position: 0,
            title: "Defying Gravity",
            artist: "Orlando Ballet Chorus",
            albumTitle: "Wicked",
            lengthSeconds: 305,
            authority: {
              state: "resolver-capable" as const,
              selectionId: "playlist-selection-1",
            },
          },
          {
            position: 1,
            title: "Off Catalog",
            artist: "Someone",
            albumTitle: "",
            lengthSeconds: null,
            authority: {
              state: "unavailable" as const,
              reason: {
                code: "source-unavailable" as const,
                message: "this track is not available in the current source" as const,
              },
            },
          },
        ],
      })),
    };
    const app = await serve(
      roonClient(() => "core-a"),
      service,
      undefined,
      playlistContents
    );
    try {
      const response = await fetch(
        `${app.url}/api/catalog/playlists/${"aa".repeat(20)}/contents`
      );
      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(playlistContents.getContents).toHaveBeenCalledWith(
        "core-a",
        "aa".repeat(20)
      );
      expect(body.kind).toBe("smart");
      expect(body.truncated).toBe(true);
      expect(normalizePlaylistContentsResponse(body)).not.toBeNull();
    } finally {
      await app.close();
    }
  });


  // ---------------------------------------------------------------------------
  // The §3 error mapping. This is the branch that ships publicly: whatever the
  // feature layer raises, the route answers with the status the layer chose and
  // the exact reason it gave. Before the split this was only ever exercised
  // through walled error classes, so a public build had no guard on it at all.
  //
  // Driven entirely through public types: LibraryFeatureRequestError is abstract
  // in src/server/libraryFeatures.ts, LibraryFeatureUnavailableError is a public
  // concrete subclass, and the router takes its ports as public interfaces.
  // ---------------------------------------------------------------------------
  it("answers a feature failure with the layer's own status, code, and reason", async () => {
    // A public subclass standing in for any walled failure: the mapping must not
    // care which class it was, only what statusCode and code it carries.
    class TestFeatureFailure extends LibraryFeatureRequestError {
      public readonly code = "CONTENTS_UNREADABLE";
      public readonly statusCode = 422;
    }
    const playlistContents: CatalogHttpPlaylistContents = {
      getContents: jest.fn(async () => {
        throw new TestFeatureFailure("the playlist could not be read honestly");
      }),
    };
    const app = await serve(
      roonClient(() => "core-a"),
      fakeService(),
      undefined,
      playlistContents
    );
    try {
      const response = await fetch(
        `${app.url}/api/catalog/playlists/${"aa".repeat(20)}/contents`
      );
      expect(response.status).toBe(422);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(body).toEqual({
        error: "the playlist could not be read honestly",
        details: "CONTENTS_UNREADABLE",
      });
    } finally {
      await app.close();
    }
  });

  it("answers the honest 409 when a feature is not part of this build", async () => {
    // The absence answer §3 mandates and slice 2 proved, reached through the
    // public unavailable error rather than through anything walled.
    const playlistContents: CatalogHttpPlaylistContents = {
      getContents: jest.fn(async () => {
        throw new LibraryFeatureUnavailableError(
          LIBRARY_FEATURES_ABSENT_REASON,
          "PLAYLIST_CONTENTS_UNAVAILABLE"
        );
      }),
    };
    const app = await serve(
      roonClient(() => "core-a"),
      fakeService(),
      undefined,
      playlistContents
    );
    try {
      const response = await fetch(
        `${app.url}/api/catalog/playlists/${"aa".repeat(20)}/contents`
      );
      expect(response.status).toBe(409);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(body).toEqual({
        error: LIBRARY_FEATURES_ABSENT_REASON,
        details: "PLAYLIST_CONTENTS_UNAVAILABLE",
      });
    } finally {
      await app.close();
    }
  });
});
