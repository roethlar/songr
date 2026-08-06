import { NextFunction, Request, Response, Router } from "express";
import type { Logger } from "pino";

import {
  CatalogService,
  CatalogServiceError,
} from "../../../core/catalog/CatalogService";
import { CoreUnpairedError, ServiceUnavailableError } from "../../../core/roon/errors";
import type { RoonClient } from "../../../core/roon/RoonClient";
import {
  isCatalogLocalId,
  normalizeCatalogArtistAlbumsResponse,
  normalizeCatalogArtistSearchResponse,
  normalizeCatalogStatus,
  type CatalogRefreshAcceptedResponse,
  type CatalogStatus,
} from "../../../shared/timelineCatalogContracts";
import type { ErrorResponse } from "../../../shared/types";
import { buildCatalogIndexResponse } from "../../../shared/catalogIndexContracts";
import type { CatalogIndexNativeFeatures } from "../../../shared/catalogIndexContracts";
import type {
  MostPlayedPerformerDrillResponse,
  MostPlayedReleaseDrillResponse,
  MostPlayedResponse,
} from "../../../shared/mostPlayedContracts";
import { isPublicSongSelectionId } from "../../../shared/publicSongResolverContracts";
import {
  PLAYLIST_ACTIONS_CONTRACT_HEADER,
  PLAYLIST_ACTIONS_CONTRACT_VERSION,
  PLAYLIST_ACTIONS_RELOAD_REQUIRED_MESSAGE,
  type PlaylistContentsResponse,
  PlaylistsResponse,
} from "../../../shared/playlistContracts";
import {
  normalizeFocusPlaylistAdoptionHttpRequest,
  normalizeFocusPlaylistCreateBootstrapRequest,
  normalizeFocusPlaylistCreateRequest,
  normalizeFocusPlaylistEditBootstrapRequest,
  normalizeFocusPlaylistPickerHttpRequest,
  normalizeFocusPlaylistStateRequest,
  normalizeFocusPlaylistUpdateRequest,
  type FocusPlaylistAdoptionResponse,
  type FocusPlaylistBootstrapResponse,
  type FocusPlaylistCloseResponse,
  type FocusPlaylistPickerResponse,
} from "../../../shared/focusPlaylistContracts";
import {
  normalizeCreateManualPlaylistRequest,
  normalizeInsertPlaylistTracksRequest,
  normalizeMovePlaylistItemRequest,
  normalizeRemovePlaylistItemRequest,
  normalizeRenamePlaylistRequest,
  normalizeSetPlaylistDescriptionRequest,
  type PlaylistAlbumTracksResponse,
  type PlaylistManageResponse,
  type PlaylistMutationResponse,
} from "../../../shared/playlistMutationContracts";
import {
  LibraryFeatureRequestError,
  LibraryFeatureUnavailableError,
  type FocusPlaylistFeaturePort,
  type LibraryFeatureCatalogPort,
  type MostPlayedFeaturePort,
  type PlaylistContentsFeaturePort,
  type PlaylistManageRead,
  type PlaylistWritesFeaturePort,
} from "../../libraryFeatures";

export type CatalogHttpService = Pick<
  CatalogService,
  | "start"
  | "getStatus"
  | "getSnapshot"
  | "scan"
  | "searchArtists"
  | "getArtistAlbums"
  | "loadArtistAlbums"
>;

export type CatalogHttpRoonClient = Pick<RoonClient, "getCoreInfo">;

/**
 * The library-feature slice the catalog routes consume (Slices 3–6): the
 * explicit catalog refresh POST is one of the refresh triggers, the index
 * serves the capability answers, and /most-played serves the pulled stats read
 * model. Optional so the router works without the feature layer.
 */
export type CatalogHttpNative = LibraryFeatureCatalogPort;

/** The Slice-7 contents orchestration the route consumes (test seam). */
export type CatalogHttpPlaylistContents = PlaylistContentsFeaturePort;

/** The Slice-11 mutation surface the routes consume (test seam). */
export type CatalogHttpPlaylistMutations = PlaylistWritesFeaturePort;

export type CatalogHttpFocusPlaylists = FocusPlaylistFeaturePort;

/** Opaque-authority publisher and fresh Most Played drill reads. */
export type CatalogHttpMostPlayedDrills = MostPlayedFeaturePort;

class CatalogRequestError extends Error {
  public readonly statusCode: number;

  public constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "CatalogRequestError";
    this.statusCode = statusCode;
  }
}

function requirePlaylistActionsContract(
  req: Request,
  res: Response
): boolean {
  if (
    req.get(PLAYLIST_ACTIONS_CONTRACT_HEADER) ===
    PLAYLIST_ACTIONS_CONTRACT_VERSION
  ) {
    return true;
  }
  const response: ErrorResponse = {
    error: PLAYLIST_ACTIONS_RELOAD_REQUIRED_MESSAGE,
    details: "PLAYLIST_ACTIONS_RELOAD_REQUIRED",
  };
  res.status(409).json(response);
  return false;
}

function requireCoreId(roonClient: CatalogHttpRoonClient): string {
  const coreId = roonClient.getCoreInfo()?.id;
  if (!coreId) throw new CoreUnpairedError();
  return coreId;
}

function requireMostPlayedSelectionId(value: unknown): string {
  if (!isPublicSongSelectionId(value)) {
    throw new CatalogRequestError("Invalid Most Played selection ID");
  }
  return value;
}

function assertCurrentCore(
  roonClient: CatalogHttpRoonClient,
  expectedCoreId: string
): void {
  if (roonClient.getCoreInfo()?.id !== expectedCoreId) {
    throw new CoreUnpairedError("Roon core changed during catalog request");
  }
}

function assertResponseCore(
  status: CatalogStatus,
  expectedCoreId: string
): void {
  if (status.coreId !== expectedCoreId) {
    throw new Error("Catalog response Core did not match the paired Core");
  }
}

function assertAllowedQuery(
  query: Request["query"],
  allowed: readonly string[]
): void {
  if (Object.keys(query).some((key) => !allowed.includes(key))) {
    throw new CatalogRequestError("Invalid catalog request");
  }
}

function assertEmptyBody(req: Request): void {
  const contentLength = req.get("content-length");
  if (
    req.get("transfer-encoding") !== undefined ||
    (contentLength !== undefined && contentLength !== "0") ||
    req.body !== undefined
  ) {
    throw new CatalogRequestError("Invalid catalog request");
  }
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new CatalogServiceError("INVALID_QUERY", "Catalog limit is invalid");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw new CatalogServiceError("INVALID_QUERY", "Catalog limit is invalid");
  }
  return limit;
}

function requiredRevision(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new CatalogServiceError("INVALID_QUERY", "Catalog revision is invalid");
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) {
    throw new CatalogServiceError("INVALID_QUERY", "Catalog revision is invalid");
  }
  return revision;
}

function sendCatalogServiceError(
  error: CatalogServiceError,
  res: Response
): void {
  const invalid = error.code === "INVALID_QUERY";
  const conflict = error.code === "REVISION_CONFLICT";
  const response: ErrorResponse = {
    error: invalid
      ? "Invalid catalog request"
      : conflict
        ? "Catalog changed; retry request"
        : "Catalog unavailable",
    details: error.code,
  };
  res.status(invalid ? 400 : conflict ? 409 : 503).json(response);
}

export const createCatalogRouter = (
  roonClient: CatalogHttpRoonClient,
  catalogService: CatalogHttpService,
  logger: Logger,
  nativeCatalog?: CatalogHttpNative,
  playlistContents?: CatalogHttpPlaylistContents,
  playlistMutations?: CatalogHttpPlaylistMutations,
  mostPlayedDrills?: CatalogHttpMostPlayedDrills,
  focusPlaylists?: CatalogHttpFocusPlaylists
): Router => {
  const router = Router();

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  const handleError = (
    error: unknown,
    res: Response,
    next: NextFunction
  ): void => {
    if (error instanceof CatalogServiceError) {
      sendCatalogServiceError(error, res);
      return;
    }
    if (error instanceof LibraryFeatureRequestError) {
      // Every honest library-feature failure — a stale Most Played
      // selection, a per-playlist read failure, a refused or unverified
      // write, a feature that is not part of this build — answers with the
      // status the feature chose and the exact reason it gave.
      const response: ErrorResponse = {
        error: error.message,
        details: error.code,
      };
      res.status(error.statusCode).json(response);
      return;
    }
    if (error instanceof CoreUnpairedError || error instanceof CatalogRequestError) {
      next(error);
      return;
    }
    logger.error({ err: error }, "Catalog HTTP request failed");
    next(new ServiceUnavailableError("catalog", "Catalog unavailable"));
  };

  const sendArtistNotFound = (coreId: string, res: Response): void => {
    const status = normalizeCatalogStatus(catalogService.getStatus(coreId));
    if (!status) {
      throw new Error("Catalog produced an invalid status response");
    }
    assertResponseCore(status, coreId);
    if (!status.available || !status.complete) {
      throw new ServiceUnavailableError("catalog", "Catalog unavailable");
    }
    const response: ErrorResponse = {
      error: "Catalog artist not found",
      details: "CATALOG_ARTIST_NOT_FOUND",
    };
    res.status(404).json(response);
  };

  router.get(
    "/status",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAllowedQuery(req.query, []);
        const coreId = requireCoreId(roonClient);
        await catalogService.start(coreId);
        assertCurrentCore(roonClient, coreId);
        const status = normalizeCatalogStatus(catalogService.getStatus(coreId));
        if (!status) throw new Error("Catalog produced an invalid status response");
        assertResponseCore(status, coreId);
        res.json(status);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.get(
    "/index",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAllowedQuery(req.query, []);
        const coreId = requireCoreId(roonClient);
        await catalogService.start(coreId);
        assertCurrentCore(roonClient, coreId);
        const status = normalizeCatalogStatus(catalogService.getStatus(coreId));
        if (!status) throw new Error("Catalog produced an invalid status response");
        assertResponseCore(status, coreId);
        const snapshot = catalogService.getSnapshot(coreId);
        if (!snapshot) {
          if (status.persistence === "degraded") {
            throw new ServiceUnavailableError("catalog", "Catalog unavailable");
          }
          // Honest empty: no crawl has published a catalog for this Core
          // yet. Clients fall back to browse-drain (degraded surface).
          const response: ErrorResponse = {
            error: "catalog empty",
            details: "CATALOG_EMPTY",
          };
          res.status(409).json(response);
          return;
        }
        if (snapshot.coreId !== coreId) {
          throw new Error("Catalog snapshot Core did not match the paired Core");
        }
        // Slices 4+6: the index carries the capability state machine's
        // feature answers so the UI can enable or honestly degrade
        // native-driven features. A capability failure never breaks the
        // index — the client degrades to the disabled presentation.
        let native: CatalogIndexNativeFeatures | undefined;
        if (nativeCatalog) {
          try {
            const capability = await nativeCatalog.getCapability(coreId);
            native = {
              dateFeaturesAvailable: capability.dateFeaturesAvailable,
              ...(capability.dateFeaturesAvailable
                ? {}
                : { dateFeaturesUnavailableReason: capability.reason }),
              playFeaturesAvailable: capability.playFeaturesAvailable,
              ...(capability.playFeaturesAvailable
                ? {}
                : {
                    playFeaturesUnavailableReason:
                      capability.playFeaturesUnavailableReason ??
                      capability.reason,
                  }),
              playlistFeaturesAvailable: capability.playlistFeaturesAvailable,
              ...(capability.playlistFeaturesAvailable
                ? {}
                : {
                    playlistFeaturesUnavailableReason:
                      capability.playlistFeaturesUnavailableReason ??
                      capability.reason,
                  }),
              stateFilterFeaturesAvailable:
                capability.stateFilterFeaturesAvailable,
              ...(capability.stateFilterFeaturesAvailable
                ? {}
                : {
                    stateFilterFeaturesUnavailableReason:
                      capability.stateFilterFeaturesUnavailableReason ??
                      capability.reason,
                  }),
            };
          } catch (error) {
            logger.warn(
              { err: error, coreId },
              "Native capability evaluation failed; index served without it"
            );
          }
        }
        assertCurrentCore(roonClient, coreId);
        res.json(buildCatalogIndexResponse(status, snapshot, native));
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.get(
    "/most-played",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAllowedQuery(req.query, []);
        const coreId = requireCoreId(roonClient);
        await catalogService.start(coreId);
        assertCurrentCore(roonClient, coreId);
        const status = normalizeCatalogStatus(catalogService.getStatus(coreId));
        if (!status) throw new Error("Catalog produced an invalid status response");
        assertResponseCore(status, coreId);
        // Slice 6: the capability state machine answers first; an
        // unavailable play feature carries its exact honest reason.
        if (!nativeCatalog) {
          throw new ServiceUnavailableError("catalog", "Catalog unavailable");
        }
        const capability = await nativeCatalog.getCapability(coreId);
        if (!capability.playFeaturesAvailable) {
          const response: ErrorResponse = {
            error:
              capability.playFeaturesUnavailableReason ??
              "Most played unavailable",
            details: "MOST_PLAYED_UNAVAILABLE",
          };
          res.status(409).json(response);
          return;
        }
        const statsSnapshot = await nativeCatalog.getMostPlayedSnapshot(coreId);
        const snapshot = catalogService.getSnapshot(coreId);
        if (!statsSnapshot || !snapshot) {
          throw new ServiceUnavailableError("catalog", "Catalog unavailable");
        }
        if (snapshot.coreId !== coreId || statsSnapshot.coreId !== coreId) {
          throw new Error("Catalog snapshot Core did not match the paired Core");
        }
        assertCurrentCore(roonClient, coreId);
        if (!mostPlayedDrills) {
          throw new ServiceUnavailableError("catalog", "Catalog unavailable");
        }
        const view = mostPlayedDrills.publishView(statsSnapshot, snapshot);
        const response: MostPlayedResponse = { status, ...view };
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.get(
    "/most-played/performers/:selectionId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAllowedQuery(req.query, []);
        const coreId = requireCoreId(roonClient);
        if (!nativeCatalog || !mostPlayedDrills) {
          throw new ServiceUnavailableError("catalog", "Catalog unavailable");
        }
        const selectionId = requireMostPlayedSelectionId(
          req.params.selectionId
        );
        const capability = await nativeCatalog.getCapability(coreId);
        if (!capability.playFeaturesAvailable) {
          throw new LibraryFeatureUnavailableError(
            capability.playFeaturesUnavailableReason ?? capability.reason,
            "MOST_PLAYED_UNAVAILABLE"
          );
        }
        const response: MostPlayedPerformerDrillResponse =
          await mostPlayedDrills.getPerformer(coreId, selectionId);
        assertCurrentCore(roonClient, coreId);
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.get(
    "/most-played/releases/:selectionId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAllowedQuery(req.query, []);
        const coreId = requireCoreId(roonClient);
        if (!nativeCatalog || !mostPlayedDrills) {
          throw new ServiceUnavailableError("catalog", "Catalog unavailable");
        }
        const selectionId = requireMostPlayedSelectionId(
          req.params.selectionId
        );
        const capability = await nativeCatalog.getCapability(coreId);
        if (!capability.playFeaturesAvailable) {
          throw new LibraryFeatureUnavailableError(
            capability.playFeaturesUnavailableReason ?? capability.reason,
            "MOST_PLAYED_UNAVAILABLE"
          );
        }
        const response: MostPlayedReleaseDrillResponse =
          await mostPlayedDrills.getRelease(coreId, selectionId);
        assertCurrentCore(roonClient, coreId);
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.get(
    "/playlists",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!requirePlaylistActionsContract(req, res)) return;
        assertAllowedQuery(req.query, []);
        const coreId = requireCoreId(roonClient);
        await catalogService.start(coreId);
        assertCurrentCore(roonClient, coreId);
        const status = normalizeCatalogStatus(catalogService.getStatus(coreId));
        if (!status) throw new Error("Catalog produced an invalid status response");
        assertResponseCore(status, coreId);
        // Slice 7: the capability state machine answers first; an
        // unavailable playlist feature carries its exact honest reason.
        if (!nativeCatalog) {
          throw new ServiceUnavailableError("catalog", "Catalog unavailable");
        }
        const capability = await nativeCatalog.getCapability(coreId);
        if (!capability.playlistFeaturesAvailable) {
          const response: ErrorResponse = {
            error:
              capability.playlistFeaturesUnavailableReason ??
              "Playlists unavailable",
            details: "PLAYLISTS_UNAVAILABLE",
          };
          res.status(409).json(response);
          return;
        }
        const playlistSnapshot = await nativeCatalog.getPlaylistSnapshot(coreId);
        if (!playlistSnapshot || playlistSnapshot.coreId !== coreId) {
          throw new ServiceUnavailableError("catalog", "Catalog unavailable");
        }
        // Slice 11: the global write-availability answer. When the write
        // service is not wired, writes are honestly unavailable.
        const writes = playlistMutations
          ? await playlistMutations.describeWrites(coreId)
          : {
              available: false,
              unavailableReason: "the playlist write service is not available",
            };
        assertCurrentCore(roonClient, coreId);
        const response: PlaylistsResponse = {
          status,
          pulledAt: playlistSnapshot.pulledAt,
          playlists: playlistSnapshot.summarize({
            writesAvailable: writes.available,
          }),
          writes: writes.available
            ? { available: true }
            : {
                available: false,
                unavailableReason: writes.unavailableReason as string,
              },
        };
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.get(
    "/playlists/:playlistId/contents",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAllowedQuery(req.query, []);
        const playlistId = req.params.playlistId;
        if (
          typeof playlistId !== "string" ||
          playlistId.length < 1 ||
          playlistId.length > 128 ||
          playlistId.length % 2 !== 0 ||
          !/^[0-9a-f]+$/u.test(playlistId)
        ) {
          throw new CatalogRequestError("Invalid catalog request");
        }
        const coreId = requireCoreId(roonClient);
        await catalogService.start(coreId);
        assertCurrentCore(roonClient, coreId);
        const status = normalizeCatalogStatus(catalogService.getStatus(coreId));
        if (!status) throw new Error("Catalog produced an invalid status response");
        assertResponseCore(status, coreId);
        if (!playlistContents) {
          throw new ServiceUnavailableError("catalog", "Catalog unavailable");
        }
        const contents = await playlistContents.getContents(coreId, playlistId);
        if (contents.playlistId !== playlistId) {
          throw new Error("Playlist contents did not match the requested playlist");
        }
        assertCurrentCore(roonClient, coreId);
        const response: PlaylistContentsResponse = { status, ...contents };
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  // -----------------------------------------------------------------------
  // Playlist mutations (complete Focus create/edit, manual management).
  // Same REST transport as playlist reads. Every route
  // re-validates its body through the shared strict normalizers, runs the
  // capability fence + §2 write policy + live predicates inside the
  // service, and answers with the fresh-read verification result — or the
  // honest conflict/error, never a guessed outcome.
  // -----------------------------------------------------------------------

  const requirePlaylistId = (value: unknown): string => {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 128 ||
      value.length % 2 !== 0 ||
      !/^[0-9a-f]+$/u.test(value)
    ) {
      throw new CatalogRequestError("Invalid catalog request");
    }
    return value;
  };

  const requireCatalogAlbumId = (value: unknown): string => {
    if (typeof value !== "string" || !isCatalogLocalId(value)) {
      throw new CatalogRequestError("Invalid catalog request");
    }
    return value;
  };

  const requireMutationService = (): CatalogHttpPlaylistMutations => {
    if (!playlistMutations) {
      throw new ServiceUnavailableError("catalog", "Catalog unavailable");
    }
    return playlistMutations;
  };

  const requireFocusService = (): CatalogHttpFocusPlaylists => {
    if (!focusPlaylists) {
      throw new ServiceUnavailableError("catalog", "Catalog unavailable");
    }
    return focusPlaylists;
  };

  const mutationPrelude = async (
    req: Request
  ): Promise<{ coreId: string; status: CatalogStatus }> => {
    assertAllowedQuery(req.query, []);
    const coreId = requireCoreId(roonClient);
    await catalogService.start(coreId);
    assertCurrentCore(roonClient, coreId);
    const status = normalizeCatalogStatus(catalogService.getStatus(coreId));
    if (!status) throw new Error("Catalog produced an invalid status response");
    assertResponseCore(status, coreId);
    return { coreId, status };
  };

  const sendMutation = (
    status: CatalogStatus,
    result: { playlistId: string; operationId: string; detail: string },
    res: Response
  ): void => {
    const response: PlaylistMutationResponse = {
      status,
      playlistId: result.playlistId,
      operationId: result.operationId,
      detail: result.detail,
    };
    res.json(response);
  };

  const sendFocusBootstrap = (
    status: CatalogStatus,
    result: Omit<FocusPlaylistBootstrapResponse, "status">,
    res: Response
  ): void => {
    const response: FocusPlaylistBootstrapResponse = {
      status,
      ...result,
    };
    res.json(response);
  };

  router.post(
    "/playlists/focus/bootstrap",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = normalizeFocusPlaylistCreateBootstrapRequest(
          req.body
        );
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireFocusService().bootstrapCreate(
          coreId,
          body.scope,
          {
            ...(body.confirmedTakeover === undefined
              ? {}
              : { confirmedTakeover: body.confirmedTakeover }),
          }
        );
        assertCurrentCore(roonClient, coreId);
        sendFocusBootstrap(status, result, res);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/playlists/:playlistId/focus/bootstrap",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const playlistId = requirePlaylistId(req.params.playlistId);
        const body = normalizeFocusPlaylistEditBootstrapRequest(
          req.body
        );
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireFocusService().bootstrapEdit(
          coreId,
          playlistId,
          {
            ...(body.confirmedTakeover === undefined
              ? {}
              : { confirmedTakeover: body.confirmedTakeover }),
          }
        );
        assertCurrentCore(roonClient, coreId);
        sendFocusBootstrap(status, result, res);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  for (const [path, operation] of [
    [
      "/playlists/focus/document",
      (
        service: CatalogHttpFocusPlaylists,
        coreId: string,
        state: unknown
      ) => service.updateDocument(coreId, state),
    ],
    [
      "/playlists/focus/retry",
      (
        service: CatalogHttpFocusPlaylists,
        coreId: string,
        state: unknown
      ) => service.retry(coreId, state),
    ],
    [
      "/playlists/focus/heartbeat",
      (
        service: CatalogHttpFocusPlaylists,
        coreId: string,
        state: unknown
      ) => service.heartbeat(coreId, state),
    ],
  ] as const) {
    router.post(
      path,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const body = normalizeFocusPlaylistStateRequest(req.body);
          if (!body) {
            throw new CatalogRequestError("Invalid catalog request");
          }
          const { coreId, status } = await mutationPrelude(req);
          const result = await operation(
            requireFocusService(),
            coreId,
            body.state
          );
          assertCurrentCore(roonClient, coreId);
          sendFocusBootstrap(status, result, res);
        } catch (error) {
          handleError(error, res, next);
        }
      }
    );
  }

  router.post(
    "/playlists/focus/pick",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = normalizeFocusPlaylistPickerHttpRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireFocusService().pick(
          coreId,
          body.state,
          {
            axis: body.request.axis,
            textFilter: body.request.textFilter,
          }
        );
        assertCurrentCore(roonClient, coreId);
        if (
          result.generation !== body.request.generation ||
          result.axis !== body.request.axis ||
          result.textFilter !== body.request.textFilter
        ) {
          throw new Error(
            "Focus picker response did not match the requested generation"
          );
        }
        const response: FocusPlaylistPickerResponse = {
          status,
          generation: result.generation,
          axis: body.request.axis,
          textFilter: result.textFilter,
          candidates: result.candidates,
          totalCount: result.totalCount,
          truncated: result.truncated,
        };
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/playlists/focus/adopt",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = normalizeFocusPlaylistAdoptionHttpRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const selections = await requireFocusService().adoptCandidates(
          coreId,
          body.state,
          body.request.axis,
          body.request.candidates
        );
        assertCurrentCore(roonClient, coreId);
        const response: FocusPlaylistAdoptionResponse = {
          status,
          selections,
        };
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/playlists/focus/close",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = normalizeFocusPlaylistStateRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        await requireFocusService().close(coreId, body.state);
        assertCurrentCore(roonClient, coreId);
        const response: FocusPlaylistCloseResponse = {
          status,
          closed: true,
        };
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/playlists/focus",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = normalizeFocusPlaylistCreateRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireFocusService().createSmartPlaylist(
          coreId,
          body.name,
          body.state
        );
        assertCurrentCore(roonClient, coreId);
        sendMutation(status, result, res);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/playlists/manual",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = normalizeCreateManualPlaylistRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireMutationService().createManualPlaylist(
          coreId,
          body.name,
          body.description
        );
        assertCurrentCore(roonClient, coreId);
        sendMutation(status, result, res);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.get(
    "/playlists-native/albums/:albumLocalId/tracks",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const albumLocalId = requireCatalogAlbumId(req.params.albumLocalId);
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireMutationService().listAlbumTracks(
          coreId,
          albumLocalId
        );
        if (result.albumLocalId !== albumLocalId) {
          throw new Error("Album track listing did not match the requested album");
        }
        assertCurrentCore(roonClient, coreId);
        const response: PlaylistAlbumTracksResponse = { status, ...result };
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.get(
    "/playlists/:playlistId/manage",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!requirePlaylistActionsContract(req, res)) return;
        const playlistId = requirePlaylistId(req.params.playlistId);
        const { coreId, status } = await mutationPrelude(req);
        const result: PlaylistManageRead =
          await requireMutationService().getManageRead(coreId, playlistId);
        if (result.playlistId !== playlistId) {
          throw new Error("Manage read did not match the requested playlist");
        }
        assertCurrentCore(roonClient, coreId);
        const smart =
          result.kind === "smart"
            ? await requireFocusService().getManageRead(
                coreId,
                playlistId
              )
            : null;
        if (
          smart !== null &&
          (smart.playlistId !== playlistId || smart.name !== result.name)
        ) {
          throw new Error(
            "Focus manage read did not match the requested playlist"
          );
        }
        assertCurrentCore(roonClient, coreId);
        const response: PlaylistManageResponse = {
          status,
          ...result,
          ...(smart === null
            ? {}
            : {
                smart: {
                  scope: smart.scope,
                  summary: smart.summary,
                  editable: smart.editable,
                  ...(smart.uneditableReasonCode === undefined
                    ? {}
                    : {
                        uneditableReasonCode:
                          smart.uneditableReasonCode,
                      }),
                  capabilities: smart.capabilities,
                },
              }),
        };
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.put(
    "/playlists/:playlistId/focus",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const playlistId = requirePlaylistId(req.params.playlistId);
        const body = normalizeFocusPlaylistUpdateRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireFocusService().updateSmartPlaylist(
          coreId,
          playlistId,
          body.state
        );
        assertCurrentCore(roonClient, coreId);
        sendMutation(status, result, res);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/playlists/:playlistId/rename",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const playlistId = requirePlaylistId(req.params.playlistId);
        const body = normalizeRenamePlaylistRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireMutationService().renamePlaylist(
          coreId,
          playlistId,
          body.name
        );
        assertCurrentCore(roonClient, coreId);
        sendMutation(status, result, res);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/playlists/:playlistId/description",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const playlistId = requirePlaylistId(req.params.playlistId);
        const body = normalizeSetPlaylistDescriptionRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireMutationService().setPlaylistDescription(
          coreId,
          playlistId,
          body.description
        );
        assertCurrentCore(roonClient, coreId);
        sendMutation(status, result, res);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/playlists/:playlistId/items",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const playlistId = requirePlaylistId(req.params.playlistId);
        const body = normalizeInsertPlaylistTracksRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireMutationService().insertTracks(
          coreId,
          playlistId,
          body.picks,
          body.insertionPoint
        );
        assertCurrentCore(roonClient, coreId);
        sendMutation(status, result, res);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/playlists/:playlistId/items/remove",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const playlistId = requirePlaylistId(req.params.playlistId);
        const body = normalizeRemovePlaylistItemRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireMutationService().removeItem(
          coreId,
          playlistId,
          body.position,
          body.title
        );
        assertCurrentCore(roonClient, coreId);
        sendMutation(status, result, res);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/playlists/:playlistId/items/move",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const playlistId = requirePlaylistId(req.params.playlistId);
        const body = normalizeMovePlaylistItemRequest(req.body);
        if (!body) throw new CatalogRequestError("Invalid catalog request");
        const { coreId, status } = await mutationPrelude(req);
        const result = await requireMutationService().moveItem(
          coreId,
          playlistId,
          body.position,
          body.title,
          body.direction
        );
        assertCurrentCore(roonClient, coreId);
        sendMutation(status, result, res);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/refresh",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAllowedQuery(req.query, []);
        assertEmptyBody(req);
        const coreId = requireCoreId(roonClient);
        await catalogService.start(coreId);
        assertCurrentCore(roonClient, coreId);
        if (catalogService.getStatus(coreId).persistence === "degraded") {
          throw new CatalogServiceError(
            "PERSISTENCE_DEGRADED",
            "Catalog persistence is degraded"
          );
        }
        const refresh = catalogService.scan(coreId);
        void refresh.catch((error) => {
          logger.warn({ err: error, coreId }, "Catalog refresh failed in background");
        });
        // The explicit refresh POST is also a native snapshot pull trigger
        // (single-flight with coalescing inside the native service).
        nativeCatalog?.requestRefresh(coreId);
        const status = normalizeCatalogStatus(catalogService.getStatus(coreId));
        if (!status) throw new Error("Catalog produced an invalid status response");
        assertResponseCore(status, coreId);
        const response: CatalogRefreshAcceptedResponse = { status };
        res.status(202).json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.get(
    "/artists",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAllowedQuery(req.query, ["query", "limit"]);
        const coreId = requireCoreId(roonClient);
        const result = await catalogService.searchArtists(
          coreId,
          req.query.query ?? "",
          optionalLimit(req.query.limit)
        );
        assertCurrentCore(roonClient, coreId);
        const response = normalizeCatalogArtistSearchResponse(result);
        if (!response) throw new Error("Catalog produced an invalid search response");
        assertResponseCore(response.status, coreId);
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.get(
    "/artists/:artistLocalId/albums",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAllowedQuery(req.query, ["limit"]);
        const coreId = requireCoreId(roonClient);
        const result = await catalogService.getArtistAlbums(
          coreId,
          req.params.artistLocalId,
          optionalLimit(req.query.limit)
        );
        assertCurrentCore(roonClient, coreId);
        if (!result) {
          sendArtistNotFound(coreId, res);
          return;
        }
        const response = normalizeCatalogArtistAlbumsResponse(result);
        if (!response) throw new Error("Catalog produced an invalid albums response");
        assertResponseCore(response.status, coreId);
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  router.post(
    "/artists/:artistLocalId/albums/load",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAllowedQuery(req.query, ["revision", "limit"]);
        assertEmptyBody(req);
        const coreId = requireCoreId(roonClient);
        const expectedRevision = requiredRevision(req.query.revision);
        const result = await catalogService.loadArtistAlbums(
          coreId,
          req.params.artistLocalId,
          expectedRevision,
          optionalLimit(req.query.limit)
        );
        assertCurrentCore(roonClient, coreId);
        if (!result) {
          sendArtistNotFound(coreId, res);
          return;
        }
        const response = normalizeCatalogArtistAlbumsResponse(result);
        if (
          !response ||
          response.artist.resolutionStatus !== "resolved" ||
          (response.status.revision !== expectedRevision &&
            response.status.revision !== expectedRevision + 1)
        ) {
          throw new Error("Catalog produced an invalid auxiliary albums response");
        }
        assertResponseCore(response.status, coreId);
        res.json(response);
      } catch (error) {
        handleError(error, res, next);
      }
    }
  );

  return router;
};
