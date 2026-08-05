import { Router, Request, Response, NextFunction } from 'express';
import { RoonClient } from '../../../core/roon/RoonClient';
import { CoreStatusResponse } from '../../../shared/types';

/**
 * Create core status router
 * Provides Roon core connection status
 */
export const createCoreRouter = (roonClient: RoonClient): Router => {
  const router = Router();

  /**
   * GET /api/core
   * Returns current Roon core connection status
   */
  router.get('/', (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = roonClient.getCoreStatus();
      const coreInfo = roonClient.getCoreInfo();

      const response: CoreStatusResponse = {
        status,
        core: coreInfo
          ? {
              id: coreInfo.id,
              displayName: coreInfo.displayName,
              displayVersion: coreInfo.displayVersion,
            }
          : undefined,
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
