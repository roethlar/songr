import os from "os";
import { Router, Request, Response, NextFunction } from "express";
import { RoonClient } from "../../../core/roon/RoonClient";
import { OnboardingStatusResponse } from "../../../shared/types";

/**
 * Create the first-run read model router.
 *
 * Two facts the UI cannot derive on its own, and nothing else:
 *  - `everPaired`  — whether a Roon Core has ever been paired on this
 *    install. `/api/core` only reports the live status, which is
 *    `discovering` for a first run AND for a paired install whose Core is
 *    off, so it cannot gate a first-run flow without ambushing existing
 *    users.
 *  - `hostname`    — the machine the engine runs on. The browser has no way
 *    to see it, and the local-playback step matches it against zone and
 *    output names to spot a RoonBridge for this computer.
 *
 * Read-only. Nothing here is a setting, and nothing here starts, stops or
 * reconfigures anything.
 */
export const createOnboardingRouter = (
  roonClient: RoonClient,
  readHostname: () => string = () => os.hostname()
): Router => {
  const router = Router();

  router.get("/", (_req: Request, res: Response, next: NextFunction) => {
    try {
      // A hostname lookup that throws or answers with junk must not take
      // the endpoint down: an empty string is the honest "cannot tell",
      // and the flow degrades to its skippable manual path.
      let hostname = "";
      try {
        const value = readHostname();
        if (typeof value === "string") hostname = value.trim();
      } catch {
        hostname = "";
      }

      const response: OnboardingStatusResponse = {
        everPaired: roonClient.hasEverPaired(),
        hostname,
      };
      res.set("Cache-Control", "no-store");
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
