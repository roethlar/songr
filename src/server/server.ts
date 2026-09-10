import http from "http";
import { Application } from "express";
import { AppConfig } from "../config/env";
import { Logger } from "pino";
import { createHttpApp } from "./http/app";
import { attachSocketServer, SocketContext } from "./socket";
import { RoonClient } from "../core/roon/RoonClient";

import { TransportService } from "../core/roon/TransportService";
import { BrowseService } from "../core/roon/BrowseService";
import {
  BrowseCanaryService,
  browseCanaryProbeHealth,
  type CoreHealthVerdict,
} from "../core/roon/BrowseCanaryService";
import { CorePressureBreaker } from "../core/roon/CorePressureBreaker";
import { ImageService } from "../core/roon/ImageService";
import { RecentlyPlayedService } from "../core/recently-played/RecentlyPlayedService";
import { NavigationSettingsService } from "../core/navigation/NavigationSettingsService";
import { registerNavigationSettingsBroadcast } from "./routes/navigationSettings";
import { FavoritesService } from "../core/favorites/FavoritesService";
import { BrowseSessionCoordinator } from "../core/roon/BrowseSessionCoordinator";
import { AlbumActionResolver } from "../core/roon/AlbumActionResolver";
import { AlbumActionService } from "../core/roon/AlbumActionService";
import { LibraryAlbumService } from "../core/roon/LibraryAlbumService";
import { LibraryBrowseSession } from "../core/library/LibraryBrowseSession";
import { LibraryReadPacing } from "../core/library/LibraryReadPacing";
import { LiveLibrarySession } from "../core/library/LiveLibrarySession";
import { CoreLifecycle } from "./CoreLifecycle";
import { attachListeningHandshake } from "./listeningHandshake";

export interface ServerContext {
  readonly httpServer: http.Server;
  readonly socketContext: SocketContext;
  readonly roonClient: RoonClient;
  readonly transportService: TransportService;
  readonly recentlyPlayedService: RecentlyPlayedService;
  readonly albumActionService: AlbumActionService;
  readonly libraryAlbumService: LibraryAlbumService;
  readonly coreLifecycle: CoreLifecycle;
  /** The live view of Roon's library; holds nothing on disk. */
  readonly liveLibrary: LiveLibrarySession;
  /** The post-connect load trial's canary, or null when it is switched off. */
  readonly browseCanary: BrowseCanaryService | null;
  /** The B5 admission gate over background Core work; always present. */
  readonly corePressureBreaker: CorePressureBreaker;
  /**
   * httpServer.listen() waits for persisted services to load, so clients
   * cannot read defaults while saved state is still being restored.
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
  // The post-connect load trial's wedge detector
  // (`.agents/plans/core-wedge-postconnect.md` §A0). It ships on, so an
  // ordinary install has one; `ROON_BROWSE_CANARY=0` is the emergency valve
  // and leaves no canary object at all rather than a dormant one that could be
  // started by mistake.
  // B5's shared admission gate over background Core work
  // (`.agents/plans/core-wedge-postconnect.md`). Built unconditionally, unlike
  // the canary: an install that switched the canary off still needs its
  // background workloads shed when the Core stops answering them.
  const corePressureBreaker = new CorePressureBreaker({
    probe: browseService,
    logger,
    baselineP95Ms: config.browseCanaryBaselineP95Ms,
  });
  // Rate control needs an authority that is not its own samples before it
  // will freeze a latency baseline, and it needs to tell a re-pair of the
  // same Core from a different one. Both facts live out here, so both are
  // handed out as registrations. A build with no canary registers nothing
  // and the verdict stays `unknown` forever, which is the conservative
  // answer. The walk's pacing controller is the listener today; the binding
  // sweep's governor was the other one, and it went with the sweep.
  const coreHealthListeners: Array<
    (coreId: string, health: CoreHealthVerdict) => void
  > = [];
  const corePairingListeners: Array<(coreId: string | null) => void> = [];
  const announceCoreHealth = (
    coreId: string,
    health: CoreHealthVerdict
  ): void => {
    for (const listener of coreHealthListeners) listener(coreId, health);
  };
  const announceCorePairing = (coreId: string | null): void => {
    for (const listener of corePairingListeners) listener(coreId);
  };
  const browseCanary = config.browseCanaryEnabled
    ? new BrowseCanaryService({
        browse: browseService,
        logger,
        baselineP95Ms: config.browseCanaryBaselineP95Ms,
        // The canary is the breaker's latency and timeout evidence. It stays
        // ignorant of the breaker; the wiring is here.
        onProbeSettled: (result) => {
          const coreId = roonClient.getCoreInfo()?.id;
          if (coreId === undefined || coreId === null) return;
          // The same probe, read twice: the breaker wants evidence for its
          // trip rule, the governor wants a verdict about right now. They read
          // one threshold, so they cannot disagree about what "slow" means.
          announceCoreHealth(
            coreId,
            browseCanaryProbeHealth(result, browseCanary?.thresholdMs() ?? null)
          );
          if (result.outcome === "answered") {
            corePressureBreaker.reportLatency(coreId, {
              source: "browse-canary",
              latencyMs: result.latencyMs,
            });
            return;
          }
          corePressureBreaker.reportPressure(coreId, {
            source: "browse-canary",
            kind: result.outcome === "timed-out" ? "timeout" : "connection-lost",
          });
        },
      })
    : null;
  if (browseCanary) {
    // Handed to the breaker rather than the other way round: the breaker
    // owns the half-open probe, so it is the breaker that has to be able to
    // silence the fixed-rate one for the whole open interval.
    corePressureBreaker.attachCanary(browseCanary);
  }
  const browseSessionCoordinator = new BrowseSessionCoordinator(browseService);
  // Every in-process library consumer shares one FIFO and one singleton lease
  // instead of racing a second tail. This used to belong to the catalog
  // service, which happened to own the mechanism the live view actually needed;
  // it was lifted out whole when the catalog was deleted
  // (`.agents/plans/library-live-view.md` Slice 4).
  const libraryBrowseSession = new LibraryBrowseSession(
    browseSessionCoordinator,
    logger
  );
  // The live view of Roon's own library (`.agents/plans/library-live-view.md`
  // Slice 1). Roots and opens use the publication session; count checks use a
  // second retained session because re-rooting either hierarchy invalidates
  // that session's keys. It holds nothing on disk.
  const libraryReadPacing = new LibraryReadPacing({ logger });
  const liveLibrary = new LiveLibrarySession({
    runBrowse: (coreId, work) => libraryBrowseSession.run(coreId, work),
    runCountBrowse: (coreId, work) =>
      libraryBrowseSession.runCount(coreId, work),
    publication: browseSessionCoordinator,
    pacing: libraryReadPacing,
    logger,
  });
  coreHealthListeners.push((coreId, health) => {
    libraryReadPacing.noteHealth(coreId, health);
  });
  corePairingListeners.push((coreId) => {
    if (coreId === null) {
      libraryReadPacing.onCoreUnpaired();
      return;
    }
    libraryReadPacing.onCorePaired(coreId);
  });
  // Registered before the read that it governs: on a trip the admission is
  // revoked before anything else unwinds, so a recovery cannot let a read
  // straight back in at the rate that tripped it.
  corePressureBreaker.register({
    workload: "library-roots",
    suspend: (coreId) => libraryReadPacing.onBreakerOpen(coreId),
    resume: (coreId) => libraryReadPacing.onBreakerClose(coreId),
  });
  const libraryAlbumService = new LibraryAlbumService(
    browseSessionCoordinator,
    logger
  );
  const albumActionService = new AlbumActionService(
    browseSessionCoordinator,
    libraryAlbumService,
    transportService,
    new AlbumActionResolver(),
    logger,
    liveLibrary
  );
  const coreLifecycle = new CoreLifecycle(
    browseSessionCoordinator,
    logger,
    albumActionService,
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

  const navigationSettingsService = new NavigationSettingsService(logger, {
    filePath: config.navigationSettingsPath,
  });

  // Create HTTP app with services
  const app: Application = createHttpApp(
    roonClient,
    transportService,
    imageService,
    recentlyPlayedService,
    favoritesService,
    logger,
    liveLibrary,
    navigationSettingsService
  );
  const httpServer = http.createServer(app);

  // Answer the parent process's port question once bound. No-op unless this
  // process was forked with an IPC channel (see listeningHandshake.ts).
  attachListeningHandshake(httpServer, logger);

  const socketContext = attachSocketServer(httpServer, {
    roonClient,
    transportService,
    browseService,
    albumActionService,
    libraryAlbumService,
    liveLibrary,
    browseSessionCoordinator,
    logger,
  });

  const stopNavigationBroadcast = registerNavigationSettingsBroadcast(
    navigationSettingsService, socketContext.io
  );
  httpServer.once("close", stopNavigationBroadcast);

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
  roonClient.on("core-discovery", (event) => {
    socketContext.io.emit("core-discovery", event);
  });
  roonClient.on("core-status", (event) => {
    logger.info(event, "Roon core status update");
    socketContext.io.emit("core-status", event);

    if (event.coreStatus === "paired") {
      const eventCoreId = event.coreInfo?.id;
      const currentCoreId = roonClient.getCoreInfo()?.id;
      if (eventCoreId && currentCoreId && eventCoreId !== currentCoreId) {
        logger.warn(
          { eventCoreId, currentCoreId },
          "Ignoring mismatched paired Core event for the Core lifecycle"
        );
        return;
      }
      const coreId = currentCoreId ?? eventCoreId;
      if (coreId) {
        // Stage boundary at default level: pairing is where the
        // post-connect burst the trial measures begins
        // (`.agents/plans/core-wedge-postconnect.md` §A0).
        logger.info(
          { stage: "pairing", coreId },
          "Post-connect stage: Core paired"
        );
        // Before anything is triggered. A re-pair to the SAME Core keeps an
        // open breaker open (the known failure mode includes pressure-induced
        // unpairs, so a re-pair is evidence for the open state, not against
        // it); a different Core starts clean. Either way the answer has to
        // exist before the refresh and scan triggers below ask it.
        corePressureBreaker.onCorePaired(coreId);
        announceCorePairing(coreId);
        coreLifecycle.corePaired(coreId);
        // The live library reads Roon's roots here, and only here, for the
        // connect case. A re-pair to the same Core is still a new browse
        // session, so every reference published under the old one is retired
        // rather than carried across.
        liveLibrary.connect(coreId);
      } else {
        logger.warn("Paired Core event omitted its Core identity");
      }
      transportService.start();
      imageService.start();
      // The canary's run starts where the trial's clock does — a probe
      // issued before there is a Core to answer it would only put an
      // unpaired slot at the head of every window.
      browseCanary?.start();
      zonesSubscribed = false;
      trySubscribeZones();
    }

    if (event.coreStatus === "unpaired") {
      browseCanary?.stop();
      // Probing stops — there is nothing to probe — but the open state and
      // the backoff level are kept for the re-pair.
      corePressureBreaker.onCoreUnpaired();
      announceCorePairing(null);
      coreLifecycle.coreUnpaired();
      // Nothing about a Core that is gone may still be on offer: the snapshot
      // is dropped and every published reference dies with it.
      liveLibrary.disconnect("core-lost");
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
    // Navigation must load before any client can read or overwrite defaults.
    navigationSettingsService.start(),
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
        const address = httpServer.address();
        // With PORT=0 the configured port is 0; the bound address carries
        // the port the OS actually handed out.
        const boundPort =
          address !== null && typeof address !== "string"
            ? address.port
            : config.port;
        logger.info(
          { host: config.host, port: boundPort },
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
    albumActionService,
    libraryAlbumService,
    coreLifecycle,
    liveLibrary,
    browseCanary,
    corePressureBreaker,
    requestShutdown: () => {
      shutdownRequested = true;
    },
    isListening: () => listening,
  };
};
