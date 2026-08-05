/**
 * Shared harness for the collapsed catalog route's test suites.
 *
 * Extracted when `catalog.test.ts` split across the publication wall. The public
 * suite and the walled suite drive the same router through the same fakes, so
 * the fakes live here rather than being duplicated or re-derived.
 *
 * This file is PUBLIC and must stay that way: it imports nothing from a walled
 * root, which is what lets the public suite compile in a tree with the walled
 * roots deleted. The router's feature ports are all declared as public
 * interfaces in `src/server/libraryFeatures.ts`, so every fake here is built
 * from those interfaces alone.
 *
 * Not a suite: jest matches `**\/__tests__/**\/*.test.ts`, so this module is
 * only ever imported.
 */
import express from "express";
import http from "http";
import { AddressInfo } from "net";
import type { Logger } from "pino";

import {
  CatalogServiceError,
} from "../../../../core/catalog/CatalogService";
import {
  CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
  CATALOG_ARTIST_SEARCH_MAX_LIMIT,
  CatalogArtistAlbumsResponse,
  CatalogArtistSearchResponse,
  CatalogStatus,
} from "../../../../shared/timelineCatalogContracts";
import { createErrorHandler } from "../../middleware/errorHandler";
import {
  CatalogHttpFocusPlaylists,
  CatalogHttpNative,
  CatalogHttpMostPlayedDrills,
  CatalogHttpPlaylistContents,
  CatalogHttpPlaylistMutations,
  CatalogHttpRoonClient,
  CatalogHttpService,
  createCatalogRouter,
} from "../catalog";


export const ARTIST_ID = "10000000-0000-4000-8000-000000000001";
export const ALBUM_ID = "20000000-0000-4000-8000-000000000001";
export const ALBUM_ID_2 = "20000000-0000-4000-8000-000000000002";
export const OBSERVED_AT = "2026-07-15T00:00:00.000Z";
export const PLAYLIST_ACTIONS_HEADERS = {
  "X-Roon-Controller-Playlist-Actions": "2",
};

export const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
} as unknown as Logger;

export function status(over: Partial<CatalogStatus> = {}): CatalogStatus {
  return {
    coreId: "core-a",
    freshness: "fresh",
    persistence: "healthy",
    refresh: "idle",
    available: true,
    complete: true,
    revision: 1,
    artistCount: 1,
    albumCount: 1,
    updatedAt: OBSERVED_AT,
    lastCompleteScanAt: OBSERVED_AT,
    ...over,
  };
}

export function artist(coreId = "core-a") {
  return {
    localId: ARTIST_ID,
    coreId,
    exactName: "Björk",
    normalizedName: "björk",
    firstSeenAt: OBSERVED_AT,
    lastSeenAt: OBSERVED_AT,
    resolutionStatus: "resolved" as const,
  };
}

export function album(coreId = "core-a") {
  return {
    localId: ALBUM_ID,
    coreId,
    artistLocalId: ARTIST_ID,
    exactTitle: "Homogenic",
    exactArtist: "Björk",
    normalizedTitle: "homogenic",
    normalizedArtist: "björk",
    editionText: "",
    originalReleaseYear: 1997,
    originalReleaseYearEvidence: {
      sourceContract: "controller-normalized-browse-album-detail-v1" as const,
      field: "original-release-date" as const,
      date: "1997-09-22",
    },
    firstSeenAt: OBSERVED_AT,
    lastSeenAt: OBSERVED_AT,
    resolutionStatus: "resolved" as const,
  };
}

export function snapshot(coreId = "core-a") {
  return {
    coreId,
    revision: 1,
    updatedAt: OBSERVED_AT,
    lastCompleteScanAt: OBSERVED_AT,
    artists: [artist(coreId)],
    albums: [album(coreId)],
  };
}

export function fakeService(): jest.Mocked<CatalogHttpService> {
  const service = {
    start: jest.fn(async () => undefined),
    getStatus: jest.fn(() => status()),
    getSnapshot: jest.fn(() => snapshot()),
    scan: jest.fn(async () => {
      throw new Error("scan result should not be observed by HTTP");
    }),
    searchArtists: jest.fn(
      async (
        _coreId: string,
        queryValue: unknown,
        limitValue: unknown = 20
      ): Promise<CatalogArtistSearchResponse> => {
        if (
          typeof queryValue !== "string" ||
          queryValue.length > 256 ||
          typeof limitValue !== "number" ||
          limitValue > CATALOG_ARTIST_SEARCH_MAX_LIMIT
        ) {
          throw new CatalogServiceError("INVALID_QUERY", "unsafe test detail");
        }
        const query = queryValue.normalize("NFKC").trim().replace(/\s+/gu, " ");
        const matches = query.length > 0 ? [artist()] : [];
        return {
          status: status(),
          query,
          limit: limitValue,
          total: matches.length,
          truncated: false,
          artists: matches,
        };
      }
    ),
    getArtistAlbums: jest.fn(
      async (
        _coreId: string,
        artistLocalId: unknown,
        limitValue: unknown = 200
      ): Promise<CatalogArtistAlbumsResponse | null> => {
        if (
          typeof artistLocalId !== "string" ||
          !/^[0-9a-f-]{36}$/u.test(artistLocalId) ||
          typeof limitValue !== "number" ||
          limitValue > CATALOG_ARTIST_ALBUMS_MAX_LIMIT
        ) {
          throw new CatalogServiceError("INVALID_QUERY", "unsafe test detail");
        }
        if (artistLocalId !== ARTIST_ID) return null;
        return {
          status: status(),
          artist: artist(),
          limit: limitValue,
          total: 1,
          truncated: false,
          albums: [album()],
        };
      }
    ),
    loadArtistAlbums: jest.fn(
      async (
        _coreId: string,
        artistLocalId: unknown,
        expectedRevisionValue: unknown,
        limitValue: unknown = 200
      ): Promise<CatalogArtistAlbumsResponse | null> => {
        if (
          typeof artistLocalId !== "string" ||
          !/^[0-9a-f-]{36}$/u.test(artistLocalId) ||
          typeof expectedRevisionValue !== "number" ||
          !Number.isSafeInteger(expectedRevisionValue) ||
          typeof limitValue !== "number" ||
          limitValue > CATALOG_ARTIST_ALBUMS_MAX_LIMIT
        ) {
          throw new CatalogServiceError("INVALID_QUERY", "unsafe test detail");
        }
        if (artistLocalId !== ARTIST_ID) return null;
        return {
          status: status({ revision: expectedRevisionValue + 1 }),
          artist: artist(),
          limit: limitValue,
          total: 1,
          truncated: false,
          albums: [album()],
        };
      }
    ),
  };
  return service as unknown as jest.Mocked<CatalogHttpService>;
}

export function roonClient(getCoreId: () => string | null): CatalogHttpRoonClient {
  return {
    getCoreInfo: () => {
      const coreId = getCoreId();
      return coreId
        ? {
            id: coreId,
            displayName: "Test Core",
            displayVersion: "2.0",
          }
        : null;
    },
  };
}

export async function serve(
  roon: CatalogHttpRoonClient,
  service: CatalogHttpService,
  nativeCatalog?: CatalogHttpNative,
  playlistContents?: CatalogHttpPlaylistContents,
  playlistMutations?: CatalogHttpPlaylistMutations,
  mostPlayedDrills?: CatalogHttpMostPlayedDrills,
  focusPlaylists?: CatalogHttpFocusPlaylists
): Promise<{ url: string; close(): Promise<void> }> {
  // No default that reaches the extended layer. Building a real Most Played view
  // needs walled code, and this harness is imported by the PUBLIC suite, which
  // must compile with the walled roots deleted. Tests that need a real view pass
  // their own drills; every other test never touches /most-played, so a throwing
  // stub is the honest default rather than a silent one.
  const drills: CatalogHttpMostPlayedDrills =
    mostPlayedDrills ?? {
      publishView: () => {
        throw new Error("most-played view not configured in this test");
      },
      getPerformer: async () => {
        throw new Error("performer drill not configured in this test");
      },
      getRelease: async () => {
        throw new Error("release drill not configured in this test");
      },
    };
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use(
    "/api/catalog",
    createCatalogRouter(
      roon,
      service,
      logger,
      nativeCatalog,
      playlistContents,
      playlistMutations,
      drills,
      focusPlaylists
    )
  );
  app.use(createErrorHandler(logger));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

