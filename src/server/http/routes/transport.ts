import { Router, Request, Response, NextFunction } from 'express';
import { TransportService } from '../../../core/roon/TransportService';
import {
  TransportControlRequest,
  SeekRequest,
  VolumeRequest,
  QueueSubscribeRequest,
  QueuePlayFromHereRequest,
  ZonePlaybackSettingsRequest,
  QueueResponse,
  SuccessResponse,
  ErrorResponse,
  LoopModeRequest,
} from '../../../shared/types';

const VALID_LOOP_VALUES: readonly LoopModeRequest[] = ['disabled', 'loop', 'loop_one', 'next'];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Create transport control router
 * Provides playback control endpoints
 */
export const createTransportRouter = (transportService: TransportService): Router => {
  const router = Router();

  /**
   * POST /api/transport/play-pause
   * Toggle play/pause for a zone
   */
  router.post('/play-pause', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id } = req.body as TransportControlRequest;

      if (!zone_id || typeof zone_id !== 'string') {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }

      await transportService.playPause(zone_id);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/next
   * Skip to next track
   */
  router.post('/next', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id } = req.body as TransportControlRequest;

      if (!zone_id || typeof zone_id !== 'string') {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }

      await transportService.next(zone_id);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/previous
   * Skip to previous track
   */
  router.post('/previous', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id } = req.body as TransportControlRequest;

      if (!zone_id || typeof zone_id !== 'string') {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }

      await transportService.previous(zone_id);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/stop
   * Stop playback
   */
  router.post('/stop', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id } = req.body as TransportControlRequest;

      if (!zone_id || typeof zone_id !== 'string') {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }

      await transportService.stop(zone_id);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/seek
   * Seek to position in current track
   */
  router.post('/seek', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id, seconds } = req.body as SeekRequest;

      if (!zone_id || typeof zone_id !== 'string') {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }
      if (!isFiniteNumber(seconds) || seconds < 0) {
        const response: ErrorResponse = { error: 'seconds must be a finite, non-negative number' };
        return res.status(400).json(response);
      }

      await transportService.seek(zone_id, seconds);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/volume
   * Set volume for an output
   */
  router.post('/volume', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { output_id, value } = req.body as VolumeRequest;

      if (!output_id || typeof output_id !== 'string') {
        const response: ErrorResponse = { error: 'output_id required' };
        return res.status(400).json(response);
      }
      if (!isFiniteNumber(value)) {
        const response: ErrorResponse = { error: 'value must be a finite number' };
        return res.status(400).json(response);
      }

      await transportService.setVolume(output_id, value);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/settings
   * Update zone playback settings (shuffle/loop/auto-radio)
   */
  router.post('/settings', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id, shuffle, auto_radio, loop } = req.body as ZonePlaybackSettingsRequest;

      if (!zone_id || typeof zone_id !== 'string') {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }

      if (shuffle === undefined && auto_radio === undefined && loop === undefined) {
        const response: ErrorResponse = {
          error: 'at least one of shuffle, auto_radio, or loop must be provided',
        };
        return res.status(400).json(response);
      }

      if (shuffle !== undefined && typeof shuffle !== 'boolean') {
        return res.status(400).json({ error: 'shuffle must be boolean' } satisfies ErrorResponse);
      }
      if (auto_radio !== undefined && typeof auto_radio !== 'boolean') {
        return res.status(400).json({ error: 'auto_radio must be boolean' } satisfies ErrorResponse);
      }
      if (loop !== undefined && !VALID_LOOP_VALUES.includes(loop)) {
        return res.status(400).json({
          error: `loop must be one of: ${VALID_LOOP_VALUES.join(', ')}`,
        } satisfies ErrorResponse);
      }

      await transportService.setPlaybackSettings(zone_id, { shuffle, auto_radio, loop });

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/transport/queue/:zoneId
   * Subscribe to queue updates for zone and return current queue snapshot
   */
  router.get('/queue/:zoneId', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zoneId } = req.params;
      const maxItemsRaw = req.query.maxItems;
      const maxItems =
        typeof maxItemsRaw === 'string' && Number.isInteger(Number(maxItemsRaw)) && Number(maxItemsRaw) > 0
          ? Number(maxItemsRaw)
          : undefined;

      if (!zoneId) {
        const response: ErrorResponse = { error: 'zoneId required' };
        return res.status(400).json(response);
      }
      // M-4: cap at MAX so a query like ?maxItems=999999999 doesn't
      // turn into a giant Roon subscription + snapshot + broadcast.
      if (
        maxItems !== undefined &&
        maxItems > TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS
      ) {
        const response: ErrorResponse = {
          error: `maxItems must be ≤ ${TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS}`,
        };
        return res.status(400).json(response);
      }

      transportService.subscribeQueue(zoneId, maxItems);
      const response: QueueResponse = { queue: transportService.getQueue(zoneId) };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/queue/subscribe
   * Subscribe to queue updates for a zone
   */
  router.post('/queue/subscribe', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id, max_item_count } = req.body as QueueSubscribeRequest;

      if (!zone_id || typeof zone_id !== 'string') {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }
      if (max_item_count !== undefined && (!Number.isInteger(max_item_count) || max_item_count <= 0)) {
        const response: ErrorResponse = { error: 'max_item_count must be a positive integer' };
        return res.status(400).json(response);
      }
      // M-4: cap at MAX (see TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS).
      if (
        max_item_count !== undefined &&
        max_item_count > TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS
      ) {
        const response: ErrorResponse = {
          error: `max_item_count must be ≤ ${TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS}`,
        };
        return res.status(400).json(response);
      }

      transportService.subscribeQueue(zone_id, max_item_count);
      const response: QueueResponse = { queue: transportService.getQueue(zone_id) };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/queue/play-from-here
   * Jump playback to a queue item
   */
  router.post('/queue/play-from-here', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id, queue_item_id } = req.body as QueuePlayFromHereRequest;

      if (!zone_id || typeof zone_id !== 'string') {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }
      if (!isFiniteNumber(queue_item_id)) {
        const response: ErrorResponse = { error: 'queue_item_id must be a finite number' };
        return res.status(400).json(response);
      }

      await transportService.playFromHere(zone_id, queue_item_id);
      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
