import { Request, Response, Router } from "express";
import type { RecentlyPlayedService } from "../../../core/recently-played/RecentlyPlayedService";
import type { FavoritesService } from "../../../core/favorites/FavoritesService";
// Response shape is shared with the UI (src/shared/) so the client can
// consume /api/health without duplicating the contract. Historical
// note: pre-L-1 the response was just `{ status: "ok" }`, which masked
// degraded RP state entirely; favorites degradation makes
// /api/favorites return 503, and health must surface that too.
import type {
  HealthResponse,
  RecentlyPlayedHealth,
} from "../../../shared/types";

export const createHealthRouter = (
  recentlyPlayedService?: RecentlyPlayedService,
  favoritesService?: FavoritesService
): Router => {
  const router = Router();

  const handler = (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const subsystems: HealthResponse["subsystems"] = {};
    let ready = true;

    if (recentlyPlayedService) {
      const degraded = recentlyPlayedService.isDegraded();
      const rpReady = !degraded;
      ready = ready && rpReady;
      const rpHealth: RecentlyPlayedHealth = {
        ready: rpReady,
        degraded,
        epoch: recentlyPlayedService.getEpoch(),
        revision: recentlyPlayedService.getRevision(),
        entry_count: recentlyPlayedService.getEntries().length,
      };
      const lastErr = recentlyPlayedService.getLastPersistError();
      if (lastErr) rpHealth.last_persist_error = lastErr;
      subsystems.recently_played = rpHealth;
    }

    if (favoritesService) {
      const degraded = favoritesService.isDegraded();
      const favReady = !degraded;
      ready = ready && favReady;
      subsystems.favorites = {
        ready: favReady,
        degraded,
        entry_count: favoritesService.getEntries().length,
      };
    }

    const body: HealthResponse = {
      status: ready ? "ok" : "degraded",
      ready,
      timestamp: new Date().toISOString(),
      subsystems,
    };
    res.status(ready ? 200 : 503).json(body);
  };

  router.get("/health", handler);
  router.get("/api/health", handler);

  return router;
};
