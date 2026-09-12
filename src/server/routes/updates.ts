import { Router } from "express";
import type { ReleaseUpdateService } from "../../core/updates/ReleaseUpdateService";

export function createUpdatesRouter(service: Pick<ReleaseUpdateService, "getVersion" | "check">): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/", (_req, res) => {
    res.json({ currentVersion: service.getVersion() });
  });
  router.post("/check", async (_req, res, next) => {
    try {
      // Request data cannot choose a destination or the installed server version.
      const result = await service.check();
      res.status(result.status === "unavailable" ? 503 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
