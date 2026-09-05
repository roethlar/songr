import { NextFunction, Request, Response, Router } from "express";

import type {
  LibraryLevelHold,
  LibraryOnDemandRoot,
  LibraryOpenOutcome,
  LibraryReadTrigger,
  LibraryRootHold,
  LibraryRootsOutcome,
  LibrarySnapshot,
} from "../../../core/library/LibrarySource";
import {
  LIBRARY_OPAQUE_MAX_LENGTH,
  LIBRARY_ROOTS_CONTRACT,
  type LibraryRootView,
  type LibraryRootsResponse,
  type LibraryRootsUnavailable,
} from "../../../shared/libraryRootsContracts";
import {
  LIBRARY_OPEN_CONTRACT,
  normalizeLibraryOpenRequest,
  type LibraryOpenResponse,
} from "../../../shared/libraryOpenContracts";

/**
 * The live library's read surface.
 *
 * `.agents/plans/library-live-view.md` Slice 1.
 *
 *   GET  /api/library/roots[?generation=G]  — the current snapshot
 *   POST /api/library/roots/refresh         — re-read both roots now
 *
 * WHAT THE `generation` PARAMETER IS FOR. A reader that already holds a
 * snapshot does not want a megabyte back to be told nothing changed, and it
 * does want to know whether the references it is holding are still alive. So a
 * GET carrying the generation the caller holds is the plan's scope-activation
 * check: the server confirms the generation against Roon's own root counts —
 * about 250 ms, against 1.7 s for a re-read — and answers `current` when it
 * still stands. A generation the server no longer has gets the whole current
 * snapshot instead, which is what "the page re-resolves" means in practice.
 *
 * WHAT NEVER LEAVES HERE: a Roon item key, a controller-minted id, or any
 * normalized text. Rows carry Roon's own strings and an opaque
 * `{ generation, token }` that dies with its snapshot.
 */

/** What the router needs from the live session; the session satisfies it. */
export interface LibraryRootsPort {
  current(): LibrarySnapshot | null;
  roots(trigger: LibraryReadTrigger): Promise<LibraryRootsOutcome>;
  refresh(trigger: LibraryReadTrigger): Promise<LibraryRootsOutcome>;
  revalidate(trigger: LibraryReadTrigger): Promise<LibraryRootsOutcome>;
  open(ref: {
    generation: string;
    token: string;
  }): Promise<LibraryOpenOutcome>;
  openRoot(root: LibraryOnDemandRoot): Promise<LibraryOpenOutcome>;
}

const UNAVAILABLE_WITHOUT_PORT: LibraryRootsUnavailable = Object.freeze({
  contract: LIBRARY_ROOTS_CONTRACT,
  kind: "unavailable",
  reason: "no-core",
  message: "This build has no live library session.",
});

function viewOf(root: LibraryRootHold): LibraryRootView {
  return {
    count: root.count,
    rows: root.rows.map((row) => ({
      ref: { generation: row.ref.generation, token: row.ref.token },
      title: row.title,
      ...(row.subtitle !== undefined ? { subtitle: row.subtitle } : {}),
      ...(row.imageKey !== undefined ? { imageKey: row.imageKey } : {}),
    })),
  };
}

export function libraryRootsSnapshotResponse(
  snapshot: LibrarySnapshot
): LibraryRootsResponse {
  return {
    contract: LIBRARY_ROOTS_CONTRACT,
    kind: "snapshot",
    generation: snapshot.generation,
    coreId: snapshot.coreId,
    readAt: new Date(snapshot.readAt).toISOString(),
    artists: viewOf(snapshot.artists),
    albums: viewOf(snapshot.albums),
  };
}

/**
 * A generation the caller claims to hold.
 *
 * Bounded and character-checked before it is compared, so a hostile query
 * string is refused as malformed rather than compared as text.
 */
function heldGeneration(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > LIBRARY_OPAQUE_MAX_LENGTH) return null;
  return /^[A-Za-z0-9._:-]+$/u.test(value) ? value : null;
}

function answer(res: Response, outcome: LibraryRootsOutcome): void {
  if (outcome.kind === "snapshot") {
    res.json(libraryRootsSnapshotResponse(outcome.snapshot));
    return;
  }
  res.status(503).json({
    contract: LIBRARY_ROOTS_CONTRACT,
    kind: "unavailable",
    reason: outcome.reason,
    message: outcome.message,
  } satisfies LibraryRootsUnavailable);
}

export function libraryLevelResponse(level: LibraryLevelHold): LibraryOpenResponse {
  return {
    contract: LIBRARY_OPEN_CONTRACT,
    kind: "level",
    generation: level.generation,
    title: level.title,
    count: level.count,
    rows: level.rows.map((row) => ({
      ref: { generation: row.ref.generation, token: row.ref.token },
      title: row.title,
      kind: row.kind,
      ...(row.subtitle !== undefined ? { subtitle: row.subtitle } : {}),
      ...(row.imageKey !== undefined ? { imageKey: row.imageKey } : {}),
    })),
    ...(level.subtitle !== undefined ? { subtitle: level.subtitle } : {}),
  };
}

/**
 * One open outcome, in the three shapes a reader has to tell apart.
 *
 * `stale` is a 409 rather than a 404 or a 503 on purpose: it is not "no such
 * thing" and not "come back later", it is "what you are holding has been
 * replaced" — a conflict between the snapshot the reader has and the one the
 * server has, and the reader's answer to it is to re-read, not to retry.
 */
function answerOpen(res: Response, outcome: LibraryOpenOutcome): void {
  if (outcome.kind === "level") {
    res.json(libraryLevelResponse(outcome.level));
    return;
  }
  if (outcome.kind === "stale") {
    res
      .status(409)
      .json({ contract: LIBRARY_OPEN_CONTRACT, kind: "stale" } satisfies LibraryOpenResponse);
    return;
  }
  res.status(503).json({
    contract: LIBRARY_OPEN_CONTRACT,
    kind: "unavailable",
    reason: outcome.reason,
    message: outcome.message,
  } satisfies LibraryOpenResponse);
}

export const createLibraryRouter = (library?: LibraryRootsPort): Router => {
  const router = Router();

  // Mounted in every build, with or without a live session, so a build that
  // cannot answer says so in this contract's own words rather than falling
  // through to the SPA's HTML.
  if (!library) {
    router.all("/roots", (_req: Request, res: Response) => {
      res.status(503).json(UNAVAILABLE_WITHOUT_PORT);
    });
    router.all("/roots/refresh", (_req: Request, res: Response) => {
      res.status(503).json(UNAVAILABLE_WITHOUT_PORT);
    });
    router.all("/open", (_req: Request, res: Response) => {
      res.status(503).json({
        contract: LIBRARY_OPEN_CONTRACT,
        kind: "unavailable",
        reason: "no-core",
        message: "This build has no live library session.",
      } satisfies LibraryOpenResponse);
    });
    return router;
  }

  router.get("/roots", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const claimed =
        req.query.generation === undefined
          ? null
          : heldGeneration(req.query.generation);
      if (req.query.generation !== undefined && claimed === null) {
        res.status(400).json({
          contract: LIBRARY_ROOTS_CONTRACT,
          kind: "unavailable",
          reason: "read-failed",
          message: "The generation in this request is not a generation.",
        } satisfies LibraryRootsUnavailable);
        return;
      }
      if (claimed !== null && library.current()?.generation === claimed) {
        // The caller holds what the server holds. Check it against Roon
        // cheaply — this is the scope-activation trigger — and answer
        // `current` only if it is still true afterwards.
        const outcome = await library.revalidate("scope-activation");
        if (
          outcome.kind === "snapshot" &&
          outcome.snapshot.generation === claimed
        ) {
          res.json({
            contract: LIBRARY_ROOTS_CONTRACT,
            kind: "current",
            generation: claimed,
            coreId: outcome.snapshot.coreId,
          } satisfies LibraryRootsResponse);
          return;
        }
        answer(res, outcome);
        return;
      }
      answer(res, await library.roots(claimed === null ? "first-read" : "scope-activation"));
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/roots/refresh",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        answer(res, await library.refresh("user-refresh"));
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * Open one published reference, or one of the on-demand roots.
   *
   * A POST rather than a GET because a reference is not a name for a place:
   * it is worth one generation, it belongs in a body rather than in a URL that
   * something might keep, and there is nothing here for a cache to do.
   */
  router.post("/open", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: unknown = req.body;
      const root = (body as { root?: unknown } | null)?.root;
      if (root !== undefined) {
        if (root !== "genres" && root !== "composers") {
          res.status(400).json({
            contract: LIBRARY_OPEN_CONTRACT,
            kind: "unavailable",
            reason: "read-failed",
            message: "That is not a library root.",
          } satisfies LibraryOpenResponse);
          return;
        }
        answerOpen(res, await library.openRoot(root));
        return;
      }
      const request = normalizeLibraryOpenRequest(body);
      if (request === null) {
        res.status(400).json({
          contract: LIBRARY_OPEN_CONTRACT,
          kind: "unavailable",
          reason: "read-failed",
          message: "The reference in this request is not a reference.",
        } satisfies LibraryOpenResponse);
        return;
      }
      answerOpen(res, await library.open(request.ref));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
