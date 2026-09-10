import { Router } from "express";
import type { Server } from "socket.io";
import {
  NavigationSettingsConflictError,
  NavigationSettingsInputError,
  NavigationSettingsService,
  NavigationSettingsUnavailableError,
} from "../../core/navigation/NavigationSettingsService";
import {
  NAVIGATION_SETTINGS_EVENT,
  type NavigationSettingsSnapshot,
} from "../../shared/navigationSettings";

/** REST is authoritative; broadcasts contain the same complete committed snapshot. */
export function createNavigationSettingsRouter(service: NavigationSettingsService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/", (_req, res, next) => {
    try {
      res.json(service.getSnapshot());
    } catch (error) {
      if (error instanceof NavigationSettingsUnavailableError) {
        res.status(503).json({ error: error.message });
      } else next(error);
    }
  });
  router.put("/", async (req, res, next) => {
    try {
      res.json(await service.update(req.body));
    } catch (error) {
      if (error instanceof NavigationSettingsInputError) {
        res.status(400).json({ error: error.message });
      } else if (error instanceof NavigationSettingsConflictError) {
        res.status(409).json({ error: error.message, current: error.current });
      } else if (error instanceof NavigationSettingsUnavailableError) {
        res.status(503).json({ error: error.message });
      } else next(error);
    }
  });
  return router;
}

export function registerNavigationSettingsBroadcast(
  service: NavigationSettingsService,
  io: Pick<Server, "emit">
): () => void {
  const onUpdated = (snapshot: NavigationSettingsSnapshot): void => {
    io.emit(NAVIGATION_SETTINGS_EVENT, snapshot);
  };
  service.on("updated", onUpdated);
  return () => { service.off("updated", onUpdated); };
}
