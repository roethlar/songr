/**
 * Wide artist portraits.
 *
 * A route of its own, deliberately, rather than another shape of the artwork
 * route: the keys served here come from a different namespace than the
 * artwork keys `/api/image` accepts, and neither resolves in the other's
 * source. A separate path is the first guard. The second is that what
 * travels this path is a namespace-tagged reference rather than a bare key
 * (wh-3), which is what lets the feature below refuse a foreign key outright
 * — the two namespaces look alike enough that no validator could tell a bare
 * one from a real one.
 *
 * The shape lives in the path, not in a query parameter, so a caller cannot
 * ask for a key under a shape it did not arrive with — the only shape this
 * router mints is the one its own path segment declares.
 *
 * The portrait port is optional. A build without the extended library
 * features still mounts this router; it answers every request with the same
 * honest "not part of this build" the rest of the feature surface gives, and
 * the artist page keeps whatever header it already had.
 */

import { Router, Request, Response, NextFunction } from "express";

import {
  isArtistPortraitWidth,
  LibraryFeatureRequestError,
  LibraryFeatureUnavailableError,
  type ArtistPortraitFeaturePort,
  type ArtistPortraitImage,
  type ArtistPortraitShape,
  type ArtistPortraitWidth,
} from "../../libraryFeatures";
import { ErrorResponse } from "../../../shared/types";

/** Served when nothing larger is asked for. The library caps at its master. */
const DEFAULT_WIDTH: ArtistPortraitWidth = 2048;

/**
 * How long a browser may hold a portrait.
 *
 * A portrait's bytes are static for as long as its key is, but **this URL
 * carries no Core identity**, so what the URL means changes when the paired
 * library changes: the same key names a different photograph on a different
 * Core. `immutable` promised the opposite and was wrong — it tells a browser
 * not to revalidate at all, so a re-pair left the previous library's portrait
 * on screen for a day with no request that could correct it.
 *
 * Chosen instead: `private`, so a shared proxy never hands one household's
 * portrait to another, and a short max-age, so a re-pair corrects itself
 * within minutes without a request per image. The heavy lifting was never the
 * browser's anyway — the service holds these in memory, now keyed by the Core
 * that answered, so a reload after expiry costs a local cache hit, not a read
 * from the library. Deliberately NOT a Core-scoped URL: that would change the
 * contract slice 2 established and is a decision of its own.
 *
 * Any answer that is not a portrait is never cached: a key that has no
 * portrait today may simply be a key the library has since re-issued, and a
 * cached negative would outlive the reason for it.
 */
const PORTRAIT_CACHE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, max-age=300",
  Vary: "Accept-Encoding",
};

function parseWidth(
  raw: unknown
): { ok: true; value: ArtistPortraitWidth } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: DEFAULT_WIDTH };
  if (typeof raw !== "string" || !/^\d{1,5}$/u.test(raw)) {
    return { ok: false, error: "width is not a width portraits are served at" };
  }
  const parsed = Number(raw);
  if (!isArtistPortraitWidth(parsed)) {
    return { ok: false, error: "width is not a width portraits are served at" };
  }
  return { ok: true, value: parsed };
}

/**
 * Creates the artist-portrait router. `portraits` is the optional feature
 * port; omit it and the router fails closed.
 */
export const createArtistPortraitRouter = (
  portraits?: ArtistPortraitFeaturePort
): Router => {
  const router = Router();

  const send = (res: Response, image: ArtistPortraitImage): void => {
    for (const [header, value] of Object.entries(PORTRAIT_CACHE_HEADERS)) {
      res.set(header, value);
    }
    res.set("Content-Type", image.contentType);
    res.send(image.data);
  };

  const sendNoPortrait = (res: Response): void => {
    res.set("Cache-Control", "no-store");
    const response: ErrorResponse = {
      error: "this artist has no wide portrait",
      details: "ARTIST_PORTRAIT_NOT_FOUND",
    };
    res.status(404).json(response);
  };

  const handle = async (
    shape: ArtistPortraitShape,
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      // Nothing but width is understood here. An unrecognized parameter is a
      // request this route does not answer, not one it answers loosely.
      const unexpected = Object.keys(req.query).filter((name) => name !== "width");
      if (unexpected.length > 0) {
        res.set("Cache-Control", "no-store");
        res.status(400).json({
          error: "unrecognized artist portrait request",
          details: "INVALID_ARTIST_PORTRAIT_REQUEST",
        } satisfies ErrorResponse);
        return;
      }

      const width = parseWidth(req.query.width);
      if (!width.ok) {
        res.set("Cache-Control", "no-store");
        res.status(400).json({
          error: width.error,
          details: "INVALID_ARTIST_PORTRAIT_REQUEST",
        } satisfies ErrorResponse);
        return;
      }

      if (!portraits) {
        throw new LibraryFeatureUnavailableError(
          "wide artist portraits are not part of this build",
          "FEATURE_UNAVAILABLE"
        );
      }

      const key = req.params.key ?? "";
      const image = await portraits.read({ key, shape }, width.value);
      if (!image) {
        sendNoPortrait(res);
        return;
      }
      send(res, image);
    } catch (error) {
      if (error instanceof LibraryFeatureRequestError) {
        // The feature chose the status and the reason; both are served
        // verbatim, so a caller can tell an unreadable library from an
        // artist who simply has no wide portrait.
        res.set("Cache-Control", "no-store");
        const response: ErrorResponse = {
          error: error.message,
          details: error.code,
        };
        res.status(error.statusCode).json(response);
        return;
      }
      next(error);
    }
  };

  /**
   * GET /api/artist-portrait/wide/:key
   * Optional query parameter: width.
   */
  router.get("/wide/:key", (req: Request, res: Response, next: NextFunction) => {
    void handle("wide", req, res, next);
  });

  return router;
};
