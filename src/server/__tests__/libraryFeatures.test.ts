/**
 * The interface between the application and its optional extended library
 * features, proved from the application's side only.
 *
 * These tests never import the implementation. That is the point: they are the
 * committed regression proof that a build carrying no implementation still
 * starts and still answers, and they must keep passing after the walled
 * directories are deleted.
 */
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import type { Logger } from "pino";

import type { CatalogStatus } from "../../shared/catalogContracts";
import { createErrorHandler } from "../http/middleware/errorHandler";
import {
  isFeatureLayerInstalled,
  LIBRARY_FEATURES_ABSENT_REASON,
  LIBRARY_FEATURES_UNUSABLE_REASON,
  LibraryFeatureError,
  LibraryFeatureRequestError,
  loadLibraryFeatureLayer,
  unavailableLibraryFeatureLayer,
  type LibraryFeatureHost,
  type LibraryFeatureLayer,
} from "../libraryFeatures";
import {
  createCatalogRouter,
  type CatalogHttpRoonClient,
  type CatalogHttpService,
} from "../http/routes/catalog";

/** The specifier the loader assembles at runtime, as this test file sees it. */
const IMPLEMENTATION = "../native/libraryFeatureLayer";
/**
 * Every factory below is registered virtually. A non-virtual mock makes Jest
 * resolve the path on disk, which throws in exactly the build this file exists
 * to test: one that ships no implementation at all.
 */
const VIRTUAL = { virtual: true } as const;

const OBSERVED_AT = "2026-08-04T00:00:00.000Z";
const CORE_ID = "core-a";
const PLAYLIST_ACTIONS_HEADERS = {
  "X-Roon-Controller-Playlist-Actions": "2",
};

function testLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    level: "info",
  } as unknown as jest.Mocked<Logger>;
}

function testHost(logger: Logger): LibraryFeatureHost {
  return {
    config: {} as LibraryFeatureHost["config"],
    logger,
    catalog: {} as LibraryFeatureHost["catalog"],
    selectionRegistry: {} as LibraryFeatureHost["selectionRegistry"],
    getCoreAddress: () => null,
    runCatalogBrowse: () => {
      throw new Error("no browse lease is expected in this test");
    },
  };
}

function catalogStatus(): CatalogStatus {
  return {
    coreId: CORE_ID,
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
  };
}

function catalogSnapshot() {
  return {
    coreId: CORE_ID,
    revision: 1,
    updatedAt: OBSERVED_AT,
    lastCompleteScanAt: OBSERVED_AT,
    artists: [
      {
        localId: "10000000-0000-4000-8000-000000000001",
        coreId: CORE_ID,
        exactName: "Björk",
        normalizedName: "björk",
        firstSeenAt: OBSERVED_AT,
        lastSeenAt: OBSERVED_AT,
        resolutionStatus: "resolved" as const,
      },
    ],
    albums: [
      {
        localId: "20000000-0000-4000-8000-000000000001",
        coreId: CORE_ID,
        artistLocalId: "10000000-0000-4000-8000-000000000001",
        exactTitle: "Homogenic",
        exactArtist: "Björk",
        normalizedTitle: "homogenic",
        normalizedArtist: "björk",
        editionText: "",
        firstSeenAt: OBSERVED_AT,
        lastSeenAt: OBSERVED_AT,
        resolutionStatus: "resolved" as const,
      },
    ],
  };
}

function httpCatalogService(): CatalogHttpService {
  return {
    start: jest.fn(async () => undefined),
    getStatus: jest.fn(() => catalogStatus()),
    getSnapshot: jest.fn(() => catalogSnapshot()),
  } as unknown as CatalogHttpService;
}

function httpRoonClient(): CatalogHttpRoonClient {
  return {
    getCoreInfo: () => ({
      id: CORE_ID,
      displayName: "Test Core",
      displayVersion: "2.0",
    }),
  } as unknown as CatalogHttpRoonClient;
}

/**
 * The catalog routes wired exactly as a build with no implementation wires
 * them: the always-present capability port of the absent layer, and none of
 * the optional feature ports.
 */
async function serveWithoutFeatures(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const logger = testLogger();
  const layer = unavailableLibraryFeatureLayer(LIBRARY_FEATURES_ABSENT_REASON);
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use(
    "/api/catalog",
    createCatalogRouter(
      httpRoonClient(),
      httpCatalogService(),
      logger,
      layer.catalog
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

describe("isFeatureLayerInstalled", () => {
  it("calls every absence stub uninstalled, whatever its reason", () => {
    // This is the discriminator the initial-scan trigger rides (public
    // issue #1): a build whose layer is a stub must fire its own first
    // scan, and both stub flavors mean "nothing owns refresh".
    expect(
      isFeatureLayerInstalled(
        unavailableLibraryFeatureLayer(LIBRARY_FEATURES_ABSENT_REASON)
      )
    ).toBe(false);
    expect(
      isFeatureLayerInstalled(
        unavailableLibraryFeatureLayer(LIBRARY_FEATURES_UNUSABLE_REASON)
      )
    ).toBe(false);
  });

  it("calls any layer it did not manufacture installed", () => {
    const real: LibraryFeatureLayer = {
      catalog: {
        requestRefresh: () => undefined,
        getCapability: () => Promise.reject(new Error("unused")),
        getMostPlayedSnapshot: () => Promise.resolve(null),
        getPlaylistSnapshot: () => Promise.resolve(null),
      },
      songRelationships: { resolve: () => Promise.reject(new Error("unused")) },
      songSourceVerifier: {
        verify: () => Promise.resolve({ state: "unavailable" }),
      },
      stopScheduledRefresh: () => undefined,
    };
    expect(isFeatureLayerInstalled(real)).toBe(true);
  });
});

describe("loading the extended library features", () => {
  afterEach(() => {
    // `jest.dontMock` resolves the path eagerly and would throw in a build
    // that genuinely has no implementation. Clearing the module registry is
    // enough: every test below installs its own factory, and the tests that
    // follow this block never load the implementation at all.
    jest.resetModules();
  });

  it("answers every capability unavailable when the implementation is not part of the build", async () => {
    jest.doMock(IMPLEMENTATION, () => {
      const absent = new Error(
        "Cannot find module './native/libraryFeatureLayer'"
      ) as Error & { code?: string };
      absent.code = "MODULE_NOT_FOUND";
      throw absent;
    }, VIRTUAL);
    const logger = testLogger();

    const layer = loadLibraryFeatureLayer(testHost(logger));

    const capability = await layer.catalog.getCapability(CORE_ID);
    expect(capability).toEqual({
      reason: LIBRARY_FEATURES_ABSENT_REASON,
      dateFeaturesAvailable: false,
      playFeaturesAvailable: false,
      playFeaturesUnavailableReason: LIBRARY_FEATURES_ABSENT_REASON,
      playlistFeaturesAvailable: false,
      playlistFeaturesUnavailableReason: LIBRARY_FEATURES_ABSENT_REASON,
      stateFilterFeaturesAvailable: false,
      stateFilterFeaturesUnavailableReason: LIBRARY_FEATURES_ABSENT_REASON,
    });
    expect(await layer.catalog.getMostPlayedSnapshot(CORE_ID)).toBeNull();
    expect(await layer.catalog.getPlaylistSnapshot(CORE_ID)).toBeNull();
    expect(layer.mostPlayed).toBeUndefined();
    expect(layer.playlistContents).toBeUndefined();
    expect(layer.playlistWrites).toBeUndefined();
    expect(layer.focusPlaylists).toBeUndefined();
    expect(layer.albumDetailFallback).toBeUndefined();
    expect(layer.albumVersionInventory).toBeUndefined();
    // No editorial read port either: the session service then answers
    // every open FEATURE_UNAVAILABLE (its own no-port test) and public
    // item pages render with no editorial sections (Slice 8).
    expect(layer.editorialItems).toBeUndefined();
    // The host stops the layer's own scheduled refresh while shutting down and
    // does not branch on whether the layer has one, so absence has to answer.
    expect(() => layer.stopScheduledRefresh()).not.toThrow();
    // Absence is a normal condition, not a fault: it is reported, not logged
    // as an error.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it("never throws on absence, and refuses feature work with an honest reason", async () => {
    jest.doMock(IMPLEMENTATION, () => {
      const absent = new Error(
        "Cannot find module './native/libraryFeatureLayer'"
      ) as Error & { code?: string };
      absent.code = "MODULE_NOT_FOUND";
      throw absent;
    }, VIRTUAL);

    const layer = loadLibraryFeatureLayer(testHost(testLogger()));

    // The song-relationship read is the one feature call with no capability
    // gate in front of it, so the layer itself has to answer honestly.
    await expect(
      layer.songRelationships.resolve(CORE_ID, "Jóga", "Björk")
    ).rejects.toMatchObject({
      code: "FEATURE_UNAVAILABLE",
      statusCode: 409,
      message: LIBRARY_FEATURES_ABSENT_REASON,
    });
    await expect(
      layer.songRelationships.resolve(CORE_ID, "Jóga", "Björk")
    ).rejects.toBeInstanceOf(LibraryFeatureError);
    await expect(
      layer.songRelationships.resolve(CORE_ID, "Jóga", "Björk")
    ).rejects.toBeInstanceOf(LibraryFeatureRequestError);
    // Play and Queue verify a selection's source before using it; with no
    // source to verify, "unavailable" is the honest verdict.
    await expect(
      layer.songSourceVerifier.verify({
        coreId: CORE_ID,
        selectionId: "selection-1",
        title: "Jóga",
        artist: "Björk",
        albumTitle: "Homogenic",
        lengthSeconds: 305,
        source: {
          kind: "most-played",
          snapshotPulledAt: OBSERVED_AT,
          view: "tracks",
          sourceEntityId: "entity-1",
          nativeTrackId: null,
        },
      } as Parameters<typeof layer.songSourceVerifier.verify>[0])
    ).resolves.toEqual({ state: "unavailable" });
  });

  it("degrades to unavailable, with a different reason, when the implementation loads but exposes no entry point", async () => {
    jest.doMock(IMPLEMENTATION, () => ({}), VIRTUAL);
    const logger = testLogger();

    const layer = loadLibraryFeatureLayer(testHost(logger));

    const capability = await layer.catalog.getCapability(CORE_ID);
    expect(capability.reason).toBe(LIBRARY_FEATURES_UNUSABLE_REASON);
    expect(capability.playlistFeaturesAvailable).toBe(false);
    expect(layer.playlistWrites).toBeUndefined();
    // A present-but-broken implementation is a fault, and is logged as one.
    expect(logger.error).toHaveBeenCalled();
  });

  it("degrades to unavailable when the entry point produces an incomplete layer", async () => {
    jest.doMock(
      IMPLEMENTATION,
      () => ({ createLibraryFeatureLayer: () => ({ catalog: {} }) }),
      VIRTUAL
    );
    const logger = testLogger();

    const layer = loadLibraryFeatureLayer(testHost(logger));

    expect((await layer.catalog.getCapability(CORE_ID)).reason).toBe(
      LIBRARY_FEATURES_UNUSABLE_REASON
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("degrades to unavailable when a layer offers no way to stop its own schedule", async () => {
    // Otherwise the host would wire a layer it cannot stop, and whatever that
    // layer scheduled would outlive the shutdown that was supposed to end it.
    jest.doMock(
      IMPLEMENTATION,
      () => ({
        createLibraryFeatureLayer: () => ({
          catalog: {
            requestRefresh: () => undefined,
            getCapability: () => Promise.resolve({}),
            getMostPlayedSnapshot: () => Promise.resolve(null),
            getPlaylistSnapshot: () => Promise.resolve(null),
          },
          songRelationships: { resolve: () => Promise.resolve({}) },
          songSourceVerifier: { verify: () => Promise.resolve({}) },
        }),
      }),
      VIRTUAL
    );
    const logger = testLogger();

    const layer = loadLibraryFeatureLayer(testHost(logger));

    expect((await layer.catalog.getCapability(CORE_ID)).reason).toBe(
      LIBRARY_FEATURES_UNUSABLE_REASON
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("degrades to unavailable when the entry point throws while starting", async () => {
    jest.doMock(
      IMPLEMENTATION,
      () => ({
        createLibraryFeatureLayer: () => {
          throw new Error("the implementation could not start");
        },
      }),
      VIRTUAL
    );
    const logger = testLogger();

    const layer = loadLibraryFeatureLayer(testHost(logger));

    expect((await layer.catalog.getCapability(CORE_ID)).reason).toBe(
      LIBRARY_FEATURES_UNUSABLE_REASON
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("does not disguise a fault inside the implementation as absence", () => {
    jest.doMock(IMPLEMENTATION, () => {
      const unrelated = new Error(
        "Cannot find module 'some-dependency-of-the-implementation'"
      ) as Error & { code?: string };
      unrelated.code = "MODULE_NOT_FOUND";
      throw unrelated;
    }, VIRTUAL);
    const logger = testLogger();

    const layer = loadLibraryFeatureLayer(testHost(logger));

    expect(logger.error).toHaveBeenCalled();
    return expect(
      layer.catalog.getCapability(CORE_ID)
    ).resolves.toMatchObject({ reason: LIBRARY_FEATURES_UNUSABLE_REASON });
  });
});

describe("the catalog routes of a build without the extended library features", () => {
  it("serves the library index with every extended feature reported absent", async () => {
    const app = await serveWithoutFeatures();
    try {
      const response = await fetch(`${app.url}/api/catalog/index`);
      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as {
        native?: Record<string, unknown>;
      };
      expect(body.native).toEqual({
        dateFeaturesAvailable: false,
        dateFeaturesUnavailableReason: LIBRARY_FEATURES_ABSENT_REASON,
        playFeaturesAvailable: false,
        playFeaturesUnavailableReason: LIBRARY_FEATURES_ABSENT_REASON,
        playlistFeaturesAvailable: false,
        playlistFeaturesUnavailableReason: LIBRARY_FEATURES_ABSENT_REASON,
        stateFilterFeaturesAvailable: false,
        stateFilterFeaturesUnavailableReason: LIBRARY_FEATURES_ABSENT_REASON,
      });
    } finally {
      await app.close();
    }
  });

  it("refuses Most Played with 409 and the absence reason", async () => {
    const app = await serveWithoutFeatures();
    try {
      const response = await fetch(`${app.url}/api/catalog/most-played`);
      expect(response.status).toBe(409);
      expect(JSON.parse(await response.text())).toEqual({
        error: LIBRARY_FEATURES_ABSENT_REASON,
        details: "MOST_PLAYED_UNAVAILABLE",
      });
    } finally {
      await app.close();
    }
  });

  it("cannot serve a Most Played drill at all", async () => {
    const app = await serveWithoutFeatures();
    try {
      const response = await fetch(
        `${app.url}/api/catalog/most-played/performers/selection-1`
      );
      // The drill port is absent, so the read never reaches a capability
      // check; the route answers that the read cannot be served.
      expect(response.status).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("refuses Playlists with 409 and the absence reason", async () => {
    const app = await serveWithoutFeatures();
    try {
      const response = await fetch(`${app.url}/api/catalog/playlists`, {
        headers: PLAYLIST_ACTIONS_HEADERS,
      });
      expect(response.status).toBe(409);
      expect(JSON.parse(await response.text())).toEqual({
        error: LIBRARY_FEATURES_ABSENT_REASON,
        details: "PLAYLISTS_UNAVAILABLE",
      });
    } finally {
      await app.close();
    }
  });
});
