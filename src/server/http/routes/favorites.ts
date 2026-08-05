import { Router, Request, Response, NextFunction } from "express";
import {
  FavoritesService,
  isFavoriteType,
} from "../../../core/favorites/FavoritesService";
import type { AddFavoriteRequest, ErrorResponse } from "../../../shared/types";

/**
 * User-curated favorites (tracks / albums / artists).
 *
 * - GET    /api/favorites      — current list, newest first
 * - POST   /api/favorites      — add one; idempotent on identity
 * - DELETE /api/favorites/:id  — remove one; idempotent
 *
 * All responses carry the full `{ entries }` list so clients can
 * resync state from any mutation response (no socket broadcast for
 * favorites — multiple clients converge on their next fetch).
 */
export const createFavoritesRouter = (service: FavoritesService): Router => {
  const router = Router();

  const guardDegraded = (res: Response): boolean => {
    if (!service.isDegraded()) return false;
    res
      .status(503)
      .json({ error: "Favorites unavailable (persistence degraded)" } satisfies ErrorResponse);
    return true;
  };

  router.get("/", (_req: Request, res: Response) => {
    if (guardDegraded(res)) return;
    res.json({ entries: service.getEntries() });
  });

  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (guardDegraded(res)) return;
      const body = req.body as Partial<AddFavoriteRequest> | undefined;
      const invalid = validateAddRequest(body);
      if (invalid) {
        res.status(400).json({ error: invalid } satisfies ErrorResponse);
        return;
      }
      await service.add({
        type: body!.type!,
        title: body!.title!.trim(),
        artist: optionalField(body!.artist),
        album: optionalField(body!.album),
        image_key: optionalField(body!.image_key),
      });
      res.json({ entries: service.getEntries() });
    } catch (error) {
      next(error);
    }
  });

  router.delete(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (guardDegraded(res)) return;
        await service.remove(req.params.id);
        // Idempotent: removing an unknown id still returns the list.
        res.json({ entries: service.getEntries() });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
};

const MAX_FIELD_LENGTH = 1000;

function optionalField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function validateAddRequest(
  body: Partial<AddFavoriteRequest> | undefined
): string | null {
  if (!body || typeof body !== "object") return "Request body required";
  if (!isFavoriteType(body.type))
    return "type must be one of: track, album, artist";
  if (typeof body.title !== "string" || body.title.trim().length === 0)
    return "title is required";
  for (const field of ["title", "artist", "album", "image_key"] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return `${field} must be a string`;
    if (value.length > MAX_FIELD_LENGTH)
      return `${field} exceeds ${MAX_FIELD_LENGTH} characters`;
  }
  return null;
}
