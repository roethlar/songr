import { Router } from "express";
import type { Server } from "socket.io";
import {
  PresentationSettingsConflictError,
  PresentationSettingsInputError,
  PresentationSettingsService,
  PresentationSettingsUnavailableError,
} from "../../core/presentation/PresentationSettingsService";
import {
  PRESENTATION_SETTINGS_EVENT,
  type PresentationSettingsSnapshot,
} from "../../shared/presentationSettings";

/** REST is authoritative; broadcasts contain the same complete committed snapshot. */
export function createPresentationSettingsRouter(service: PresentationSettingsService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/", (_req, res, next) => {
    try {
      res.json(service.getSnapshot());
    } catch (error) {
      if (error instanceof PresentationSettingsUnavailableError) {
        res.status(503).json({ error: error.message });
      } else next(error);
    }
  });
  router.put("/", async (req, res, next) => {
    try {
      res.json(await service.update(req.body));
    } catch (error) {
      if (error instanceof PresentationSettingsInputError) {
        res.status(400).json({ error: error.message });
      } else if (error instanceof PresentationSettingsConflictError) {
        res.status(409).json({ error: error.message, current: error.current });
      } else if (error instanceof PresentationSettingsUnavailableError) {
        res.status(503).json({ error: error.message });
      } else next(error);
    }
  });
  return router;
}

export function registerPresentationSettingsBroadcast(
  service: PresentationSettingsService,
  io: Pick<Server, "emit">
): () => void {
  const onUpdated = (snapshot: PresentationSettingsSnapshot): void => {
    io.emit(PRESENTATION_SETTINGS_EVENT, snapshot);
  };
  service.on("updated", onUpdated);
  return () => { service.off("updated", onUpdated); };
}
