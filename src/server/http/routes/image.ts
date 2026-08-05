import { Router, Request, Response, NextFunction } from 'express';
import { ImageService, ImageScale } from '../../../core/roon/ImageService';
import { ErrorResponse } from '../../../shared/types';

const VALID_SCALES: readonly ImageScale[] = ['fit', 'fill', 'stretch'] as const;
const MAX_KEY_LENGTH = 256;
const MAX_DIMENSION = 4096;

function parseScale(raw: unknown): { ok: true; value?: ImageScale } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'scale must be a string' };
  if ((VALID_SCALES as readonly string[]).includes(raw)) {
    return { ok: true, value: raw as ImageScale };
  }
  return { ok: false, error: `scale must be one of: ${VALID_SCALES.join(', ')}` };
}

function parseDimension(raw: unknown, name: string):
  | { ok: true; value?: number }
  | { ok: false; error: string }
{
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${name} must be a string` };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_DIMENSION) {
    return { ok: false, error: `${name} must be a positive integer ≤ ${MAX_DIMENSION}` };
  }
  return { ok: true, value: parsed };
}

/**
 * Create image streaming router
 * Provides artwork streaming by image key
 */
export const createImageRouter = (imageService: ImageService): Router => {
  const router = Router();

  /**
   * GET /api/image/:key
   * Stream artwork by Roon image key
   * Optional query params: scale, width, height
   */
  router.get('/:key', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key } = req.params;

      if (!key) {
        const response: ErrorResponse = { error: 'image key required' };
        return res.status(400).json(response);
      }
      if (key.length > MAX_KEY_LENGTH) {
        const response: ErrorResponse = { error: `image key exceeds ${MAX_KEY_LENGTH} characters` };
        return res.status(400).json(response);
      }

      const scaleResult = parseScale(req.query.scale);
      if (!scaleResult.ok) {
        return res.status(400).json({ error: scaleResult.error } satisfies ErrorResponse);
      }
      const widthResult = parseDimension(req.query.width, 'width');
      if (!widthResult.ok) {
        return res.status(400).json({ error: widthResult.error } satisfies ErrorResponse);
      }
      const heightResult = parseDimension(req.query.height, 'height');
      if (!heightResult.ok) {
        return res.status(400).json({ error: heightResult.error } satisfies ErrorResponse);
      }

      const scale = scaleResult.value;
      const width = widthResult.value;
      const height = heightResult.value;

      // Validate width/height requirements when scale is provided
      if (scale && (!width || !height)) {
        const response: ErrorResponse = {
          error: 'width and height required when scale is specified',
        };
        return res.status(400).json(response);
      }

      const { data, contentType } = await imageService.getImage(key, scale, width, height);

      // Set cache headers
      const cacheHeaders = imageService.getCacheHeaders();
      Object.entries(cacheHeaders).forEach(([header, value]) => {
        res.set(header, value);
      });

      res.set('Content-Type', contentType);
      res.send(data);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
