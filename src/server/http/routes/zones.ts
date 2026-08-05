import { Router, Request, Response, NextFunction } from 'express';
import { TransportService } from '../../../core/roon/TransportService';
import { ZonesResponse, ZoneResponse } from '../../../shared/types';

/**
 * Create zones router
 * Provides zone information and control
 */
export const createZonesRouter = (transportService: TransportService): Router => {
  const router = Router();

  /**
   * GET /api/zones
   * Returns all available zones
   */
  router.get('/', (req: Request, res: Response, next: NextFunction) => {
    try {
      const zones = transportService.getZones();

      const response: ZonesResponse = { zones };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/zones/:id
   * Returns specific zone by ID
   */
  router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const zone = transportService.getZone(id) || null;

      const response: ZoneResponse = { zone };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
