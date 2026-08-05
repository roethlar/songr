import { Router, Request, Response, NextFunction } from "express";
import type { RecentlyPlayedService } from "../../../core/recently-played/RecentlyPlayedService";

/**
 * Routes for the rolling list of plays observed by this controller's
 * backend. Caveat: only what's been observed while the service was
 * running. UI should label this honestly.
 *
 * - GET    /api/recently-played  — current list
 * - DELETE /api/recently-played  — wipe the list (user-initiated)
 */
export const createRecentlyPlayedRouter = (
  service: RecentlyPlayedService
): Router => {
  const router = Router();

  // Degraded mode: the eager generation persist at startup failed,
  // so the in-memory epoch isn't durable. Serving in this state
  // risks an epoch reuse on the next restart, which would let
  // clients reject the new server's events as stale. 503 is the
  // clear signal — the frontend's fetch error path leaves the
  // existing store contents alone.
  const guardDegraded = (res: Response): boolean => {
    if (!service.isDegraded()) return false;
    res
      .status(503)
      .json({ error: "Recently played unavailable (persistence degraded)" });
    return true;
  };

  router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (guardDegraded(res)) return;
      // M-3 reopen P2: getEntries() / getRevision() expose
      // mid-operation state — an insert mutates entries + bumps
      // revision before its persist resolves, and a persist failure
      // rolls both back. Serving that uncommitted snapshot would
      // hand the client a revision that later vanishes with no
      // socket event to undo it. Await the insert+write chains so
      // every entry in the response is durable on disk.
      await service.flush();
      // Re-check degraded after flush — an in-flight start could
      // have flipped the flag while we were waiting.
      if (guardDegraded(res)) return;
      res.json({
        entries: service.getEntries(),
        revision: service.getRevision(),
        epoch: service.getEpoch(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (guardDegraded(res)) return;
      // Await durability: the service only emits `cleared` (which
      // triggers the socket broadcast) after the file write commits.
      // A 200 here means the clear committed and the file survived,
      // and the response body reflects the post-drain state — which
      // may be NON-EMPTY if a now-playing event landed during the
      // clear's persist window and was drained onto the empty list
      // before this line runs. The revision + epoch let the client
      // filter or rebase any socket events still in flight.
      await service.clear();
      res.json({
        entries: service.getEntries(),
        revision: service.getRevision(),
        epoch: service.getEpoch(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
