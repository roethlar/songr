import http from "http";
import { Application } from "express";
import { AppConfig } from "../config/env";
import { Logger } from "pino";
import { createHttpApp } from "./http/app";
import { attachSocketServer, SocketContext } from "./socket";
import { RoonClient } from "../core/roon/RoonClient";

import { TransportService } from "../core/roon/TransportService";
import { BrowseService } from "../core/roon/BrowseService";
import { ImageService } from "../core/roon/ImageService";
import { RecentlyPlayedService } from "../core/recently-played/RecentlyPlayedService";
import { FavoritesService } from "../core/favorites/FavoritesService";
import { BrowseSessionCoordinator } from "../core/roon/BrowseSessionCoordinator";
import { PublicSongResolverService } from "../core/roon/PublicSongResolverService";
import { PublicSongSelectionRegistry } from "../core/roon/PublicSongSelectionRegistry";
import { AlbumActionResolver } from "../core/roon/AlbumActionResolver";
import { AlbumActionService } from "../core/roon/AlbumActionService";
import {
  LibraryAlbumResolver,
  LibraryAlbumService,
} from "../core/roon/LibraryAlbumService";
import { TimelineBrowseService } from "../core/roon/TimelineBrowseService";
import { FileCatalogPersistence } from "../core/catalog/CatalogPersistence";
import { CatalogService } from "../core/catalog/CatalogService";
import { CatalogLifecycle } from "./CatalogLifecycle";
import {
  loadLibraryFeatureLayer,
  type LibraryFeatureLayer,
} from "./libraryFeatures";
import type { CoordinatedBrowseSession } from "../core/roon/BrowseSessionCoordinator";

export interface ServerContext {
  readonly httpServer: http.Server;
  readonly socketContext: SocketContext;
  readonly roonClient: RoonClient;
  readonly transportService: TransportService;
  readonly recentlyPlayedService: RecentlyPlayedService;
  readonly catalogService: CatalogService;
  readonly libraryFeatures: LibraryFeatureLayer;
  readonly albumActionService: AlbumActionService;
  readonly libraryAlbumService: LibraryAlbumService;
  readonly timelineBrowseService: TimelineBrowseService;
  readonly catalogLifecycle: CatalogLifecycle;
  /**
   * httpServer.listen() is deferred until RecentlyPlayedService.start
   * resolves (so the API can't serve epoch-0 sentinel snapshots).
   * If shutdown is requested during that window, callers MUST signal
   * it via `requestShutdown()` so the listen call is skipped — and
   * MUST check `isListening()` before calling `httpServer.close()`,
   * which Node reports as an error when the server never bound.
   */
  requestShutdown(): void;
  isListening(): boolean;
}

export const startServer = (
  config: AppConfig,
  logger: Logger
): ServerContext => {
  // Instantiate RoonClient
  const roonClient = new RoonClient({
    tokenPath: config.roonTokenPath,
    logger,
  });

  // Instantiate services
  const transportService = new TransportService(roonClient, logger);
  const browseService = new BrowseService(roonClient, logger);
  const browseSessionCoordinator = new BrowseSessionCoordinator(browseService);
  const catalogService = new CatalogService(browseSessionCoordinator, logger, {
    persistence: new FileCatalogPersistence({ directory: config.catalogPath }),
  });
  const albumActionService = new AlbumActionService(
    browseSessionCoordinator,
    catalogService,
    transportService,
    new AlbumActionResolver(),
    logger
  );
  const timelineBrowseService = new TimelineBrowseService(
    browseSessionCoordinator,
    catalogService,
    { getCurrentCoreId: () => roonClient.getCoreInfo()?.id ?? null }
  );
  const publicSongSelectionRegistry = new PublicSongSelectionRegistry();
  // Manual playlist reads ride the public Browse playlist path on a
  // serialized server-driven catalog-lease session. The tail keeps those
  // reads one at a time; it belongs to the application, not to the feature
  // layer, because the lease it serializes is the application's.
  let catalogBrowseTail: Promise<void> = Promise.resolve();
  const runCatalogBrowse = <T,>(
    coreId: string,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> => {
    const run = catalogBrowseTail.then(async () => {
      const handle = browseSessionCoordinator.acquireCatalog(coreId);
      try {
        return await browseSessionCoordinator.runCatalog(coreId, handle, work);
      } finally {
        await browseSessionCoordinator.releaseCatalog(coreId, handle);
      }
    });
    catalogBrowseTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  // The extended library features (Playlists, Most Played, library date
  // ordering, album detail fallback, song relationships) live behind one
  // interface and are loaded once, here. A build that does not carry them
  // still starts: every capability answer then reports the features as
  // absent, with the reason, and the library serves without them.
  const libraryFeatures = loadLibraryFeatureLayer({
    config,
    logger,
    catalog: catalogService,
    selectionRegistry: publicSongSelectionRegistry,
    getCoreAddress: () => roonClient.getCoreAddress(),
    runCatalogBrowse,
  });
  const publicSongResolverService = new PublicSongResolverService({
    coordinator: browseSessionCoordinator,
    browseService,
    selectionRegistry: publicSongSelectionRegistry,
    sourceVerifier: libraryFeatures.songSourceVerifier,
    zones: transportService,
  });
  const libraryAlbumService = new LibraryAlbumService(
    browseSessionCoordinator,
    catalogService,
    new LibraryAlbumResolver(),
    logger,
    libraryFeatures.albumDetailFallback
      ? { fallbackResolver: libraryFeatures.albumDetailFallback }
      : {}
  );
  const catalogLifecycle = new CatalogLifecycle(
    catalogService,
    browseSessionCoordinator,
    logger,
    albumActionService,
    timelineBrowseService,
    libraryAlbumService
  );
  const imageService = new ImageService(
    roonClient,
    logger,
    config.imageCachePath,
    config.imageCacheMaxBytes
  );
  const recentlyPlayedService = new RecentlyPlayedService(
    transportService,
    logger,
    {
      filePath: config.recentlyPlayedPath,
      cap: config.recentlyPlayedCap,
    }
  );
  recentlyPlayedService.setZoneNameLookup((zoneId) => {
    return transportService
      .getZones()
      .find((z) => z.zone_id === zoneId)?.display_name;
  });
  const favoritesService = new FavoritesService(logger, {
    filePath: config.favoritesPath,
  });

  // Create HTTP app with services
  const app: Application = createHttpApp(
    roonClient,
    transportService,
    imageService,
    recentlyPlayedService,
    favoritesService,
    logger,
    {
      catalogService,
      getDiagnosticCoreId: () => catalogLifecycle.getDiagnosticCoreId(),
      nativeCatalog: libraryFeatures.catalog,
      ...(libraryFeatures.mostPlayed
        ? { mostPlayedDrills: libraryFeatures.mostPlayed }
        : {}),
      ...(libraryFeatures.playlistContents
        ? { playlistContents: libraryFeatures.playlistContents }
        : {}),
      ...(libraryFeatures.playlistWrites
        ? { playlistMutations: libraryFeatures.playlistWrites }
        : {}),
      ...(libraryFeatures.focusPlaylists
        ? { focusPlaylists: libraryFeatures.focusPlaylists }
        : {}),
    }
  );
  const httpServer = http.createServer(app);

  const socketContext = attachSocketServer(httpServer, {
    roonClient,
    transportService,
    browseService,
    albumActionService,
    libraryAlbumService,
    timelineBrowseService,
    browseSessionCoordinator,
    publicSongResolverService,
    songRelationships: libraryFeatures.songRelationships,
    logger,
  });

  let zonesSubscribed = false;

  const trySubscribeZones = () => {
    if (zonesSubscribed) {
      return;
    }

    try {
      transportService.subscribeZones();
      zonesSubscribed = true;
      logger.info("Subscribed to Roon transport zones");
    } catch (error) {
      logger.warn({ err: error }, "Zone subscription deferred until core pairing completes");
    }
  };

  // Wire RoonClient events to Socket.IO
  roonClient.on("core-status", (event) => {
    logger.info(event, "Roon core status update");
    socketContext.io.emit("core-status", event);

    if (event.coreStatus === "paired") {
      const eventCoreId = event.coreInfo?.id;
      const currentCoreId = roonClient.getCoreInfo()?.id;
      if (eventCoreId && currentCoreId && eventCoreId !== currentCoreId) {
        logger.warn(
          { eventCoreId, currentCoreId },
          "Ignoring mismatched paired Core event for catalog lifecycle"
        );
        return;
      }
      const coreId = currentCoreId ?? eventCoreId;
      if (coreId) {
        catalogLifecycle.corePaired(coreId);
        // Backend startup is one of the two extended-library refresh
        // triggers (the other is the explicit catalog-refresh POST). It is
        // single-flight inside the feature layer, failures land in the
        // capability answer, and it is a no-op when the layer is absent.
        libraryFeatures.catalog.requestRefresh(coreId);
      } else {
        logger.warn("Paired Core event omitted its Core identity");
      }
      transportService.start();
      imageService.start();
      zonesSubscribed = false;
      trySubscribeZones();
    }

    if (event.coreStatus === "unpaired") {
      catalogLifecycle.coreUnpaired();
      zonesSubscribed = false;
      transportService.resetState();
      socketContext.io.emit("zones", { zones: [] });
    }
  });

  // Wire TransportService events to Socket.IO. The per-zone events
  // (`zone-updated`, `zone-removed`) are sufficient for the client to keep
  // its zone list in sync — `register.ts` calls upsertZone/removeZone on
  // them. We do NOT also emit a full `zones` snapshot per per-zone update,
  // because (a) it's quadratic broadcast traffic on Roon batches that
  // touch every zone (e.g. seek ticks), and (b) the initial snapshot is
  // already emitted on socket `connection`.
  transportService.on("zone-updated", (data) => {
    try {
      transportService.subscribeQueue(data.zone.zone_id);
    } catch (error) {
      logger.warn(
        { err: error, zone_id: data.zone.zone_id },
        "Queue subscription deferred for zone"
      );
    }

    socketContext.io.emit("zone-updated", data);
  });

  transportService.on("zone-removed", (data) => {
    socketContext.io.emit("zone-removed", data);
    socketContext.io.emit("now-playing-updated", {
      zone_id: data.zone_id,
      now_playing: null,
    });
  });

  transportService.on("now-playing-updated", (data) => {
    socketContext.io.emit("now-playing-updated", data);
  });

  // Broadcast recently-played updates with the post-mutation revision.
  // Clients track the highest revision they've applied and discard
  // anything not strictly newer — closes races where socket events
  // and REST responses arrive out of server-emit order.
  //
  // Suppressed in degraded mode (eager generation persist failed):
  // emitting with an uncommitted epoch would let clients adopt state
  // that can't survive a restart without epoch reuse.
  recentlyPlayedService.on("inserted", (entry) => {
    if (recentlyPlayedService.isDegraded()) return;
    socketContext.io.emit("recently-played-inserted", {
      entry,
      revision: recentlyPlayedService.getRevision(),
      epoch: recentlyPlayedService.getEpoch(),
    });
  });

  // A user-initiated wipe — broadcast so every client's list empties,
  // not just the one that issued the DELETE.
  recentlyPlayedService.on("cleared", () => {
    if (recentlyPlayedService.isDegraded()) return;
    socketContext.io.emit("recently-played-cleared", {
      revision: recentlyPlayedService.getRevision(),
      epoch: recentlyPlayedService.getEpoch(),
    });
  });

  transportService.on("queue-updated", (data) => {
    socketContext.io.emit("queue-updated", data);
  });

  transportService.on("seek-changed", (data) => {
    socketContext.io.emit("seek-changed", data);
  });

  // Classic Browse results are returned only through their correlated
  // per-socket acknowledgments; they are never broadcast into another
  // client's navigation state.

  // Start the sync services immediately; defer httpServer.listen until
  // RP has finished its async startup (loadFromDisk + eager generation
  // persist). Without this, GET /api/recently-played served during the
  // startup window would return the sentinel { entries: [], revision:
  // 0, epoch: 0 } and a DELETE in the same window would race the
  // load + clobber persisted history with empty epoch-0 state.
  roonClient.start();
  transportService.start();
  imageService.start();

  // Lifecycle state for the deferred-listen window. SIGTERM during
  // that window calls `requestShutdown()`; the pending startup then
  // skips listen() and `isListening()` reports false so the shutdown
  // handler can avoid `httpServer.close()` (which errors on a
  // never-bound server).
  let shutdownRequested = false;
  let listening = false;

  void Promise.all([
    recentlyPlayedService.start(),
    // Favorites loads alongside RP behind the same deferred-listen
    // gate so the API can't serve an empty list mid-load.
    favoritesService.start(),
  ]).then(
    () => {
      if (shutdownRequested) {
        logger.info(
          "Shutdown requested before RP startup completed; skipping httpServer.listen"
        );
        return;
      }
      httpServer.listen(config.port, config.host, () => {
        listening = true;
        logger.info(
          { host: config.host, port: config.port },
          "HTTP server listening"
        );
      });
    },
    (err) => {
      // Shouldn't happen — RecentlyPlayedService.start swallows all
      // failure modes internally (load errors recover as empty;
      // eager-persist failures set degraded mode). Defensive: log,
      // exit. Without this, an unexpected throw would silently leave
      // the HTTP server never starting.
      logger.error(
        { err },
        "RecentlyPlayedService.start unexpectedly rejected; HTTP server not started"
      );
      process.exit(1);
    }
  );

  return {
    httpServer,
    socketContext,
    roonClient,
    transportService,
    recentlyPlayedService,
    catalogService,
    libraryFeatures,
    albumActionService,
    libraryAlbumService,
    timelineBrowseService,
    catalogLifecycle,
    requestShutdown: () => {
      shutdownRequested = true;
    },
    isListening: () => listening,
  };
};
