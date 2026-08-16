import { Router, Request, Response, NextFunction } from 'express';
import { RoonClient } from '../../../core/roon/RoonClient';
import {
  CoreStatusResponse,
  CoreSwitchRequest,
  CoreSwitchResponse,
  ErrorResponse,
} from '../../../shared/types';

function isConfirmedCoreSwitch(value: unknown): value is CoreSwitchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'confirmed' &&
    (value as Record<string, unknown>).confirmed === true;
}

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

  /**
   * POST /api/core/switch
   * Retires the selected Core only after an exact destructive confirmation.
   */
  router.post('/switch', (req: Request, res: Response, next: NextFunction) => {
    if (!isConfirmedCoreSwitch(req.body)) {
      const response: ErrorResponse = {
        error: 'confirmed must be true and must be the only request field',
      };
      res.status(400).json(response);
      return;
    }

    try {
      roonClient.switchCore();
      const response: CoreSwitchResponse = { accepted: true, status: 'discovering' };
      res.status(202).json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
