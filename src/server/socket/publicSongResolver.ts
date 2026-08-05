import type { Logger } from "pino";
import type { Socket } from "socket.io";

import {
  BrowseSessionCoordinatorError,
  ModeSessionAccess,
  ModeSessionHandle,
} from "../../core/roon/BrowseSessionCoordinator";
import {
  PublicSongResolverError,
  PublicSongResolverService,
} from "../../core/roon/PublicSongResolverService";
import {
  normalizePublicSongActionRequest,
  normalizePublicSongResolveRequest,
  PUBLIC_SONG_ACTION_ERROR_CODES,
  PUBLIC_SONG_ERROR_MAX_LENGTH,
  PUBLIC_SONG_RESOLVE_ERROR_CODES,
  PublicSongActionAck,
  PublicSongActionErrorCode,
  PublicSongResolveAck,
  PublicSongResolveErrorCode,
} from "../../shared/publicSongResolverContracts";

const USED_ACTION_REQUEST_LIMIT = 256;

type ResolveAck = (value: PublicSongResolveAck) => void;
type ActionAck = (value: PublicSongActionAck) => void;

export interface PublicSongResolverSocketDependencies {
  resolver: Pick<PublicSongResolverService, "resolve" | "execute">;
  getCoreId: () => string | null;
  logger: Logger;
}

function modeHandle(session: {
  handleId: string;
  generation: number;
}): ModeSessionHandle {
  return { kind: "mode", mode: "classic", ...session };
}

function modeAccess(
  coreId: string,
  socketId: string,
  request: {
    tabId: string;
    session: { handleId: string; generation: number };
  }
): ModeSessionAccess {
  return {
    coreId,
    socketId,
    tabId: request.tabId,
    handle: modeHandle(request.session),
  };
}

function boundedError(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : fallback;
  return message.slice(0, PUBLIC_SONG_ERROR_MAX_LENGTH) || fallback;
}

function resolveErrorCode(error: unknown): PublicSongResolveErrorCode {
  if (
    error instanceof PublicSongResolverError &&
    PUBLIC_SONG_RESOLVE_ERROR_CODES.includes(
      error.code as PublicSongResolveErrorCode
    )
  ) {
    return error.code as PublicSongResolveErrorCode;
  }
  if (error instanceof BrowseSessionCoordinatorError) {
    if (
      error.code === "BACKPRESSURE" ||
      error.code === "OWNER_MISMATCH" ||
      error.code === "SESSION_LOST"
    ) {
      return error.code;
    }
    return "STALE_GENERATION";
  }
  return "INTERNAL_ERROR";
}

function actionErrorCode(error: unknown): PublicSongActionErrorCode {
  if (
    error instanceof PublicSongResolverError &&
    PUBLIC_SONG_ACTION_ERROR_CODES.includes(error.code)
  ) {
    return error.code;
  }
  if (error instanceof BrowseSessionCoordinatorError) {
    if (
      error.code === "BACKPRESSURE" ||
      error.code === "OWNER_MISMATCH" ||
      error.code === "SESSION_LOST"
    ) {
      return error.code;
    }
    return "STALE_CANDIDATE";
  }
  return "PRE_ISSUE_FAILED";
}

function rememberRequestId(
  used: Map<string, true>,
  requestId: string
): boolean {
  if (used.has(requestId)) return false;
  used.set(requestId, true);
  while (used.size > USED_ACTION_REQUEST_LIMIT) {
    const oldest = used.keys().next().value;
    if (typeof oldest !== "string") break;
    used.delete(oldest);
  }
  return true;
}

export function registerPublicSongResolverSocket(
  socket: Socket,
  dependencies: PublicSongResolverSocketDependencies
): void {
  const { resolver, getCoreId, logger } = dependencies;
  const usedActionRequestIds = new Map<string, true>();

  socket.on(
    "public-song:resolve",
    async (value: unknown, ack?: ResolveAck): Promise<void> => {
      const request = normalizePublicSongResolveRequest(value);
      if (!request || !ack) {
        ack?.({
          success: false,
          code: "INVALID_REQUEST",
          error: "Invalid public song resolve request",
        });
        return;
      }
      const coreId = getCoreId();
      if (!coreId) {
        ack({
          success: false,
          code: "CORE_UNAVAILABLE",
          error: "Roon Core is unavailable",
        });
        return;
      }
      try {
        const resolution = await resolver.resolve({
          access: modeAccess(coreId, socket.id, request),
          selectionId: request.selectionId,
        });
        ack({
          success: true,
          data: {
            requestId: request.requestId,
            session: request.session,
            selectionId: request.selectionId,
            resolution,
          },
        });
      } catch (error) {
        const code = resolveErrorCode(error);
        if (code === "INTERNAL_ERROR") {
          logger.error({ err: error }, "Public song resolution failed");
        }
        ack({
          success: false,
          code,
          error: boundedError(error, "Public song resolution failed"),
        });
      }
    }
  );

  socket.on(
    "public-song:action",
    async (value: unknown, ack?: ActionAck): Promise<void> => {
      const request = normalizePublicSongActionRequest(value);
      if (!request || !ack) {
        ack?.({
          success: false,
          code: "INVALID_REQUEST",
          error: "Invalid public song action request",
        });
        return;
      }
      if (!rememberRequestId(usedActionRequestIds, request.requestId)) {
        ack({
          success: false,
          code: "REQUEST_ID_CONFLICT",
          error: "The public song action request ID was already used",
        });
        return;
      }
      const coreId = getCoreId();
      if (!coreId) {
        ack({
          success: false,
          code: "CORE_UNAVAILABLE",
          error: "Roon Core is unavailable",
        });
        return;
      }
      try {
        const result = await resolver.execute({
          access: modeAccess(coreId, socket.id, request),
          selectionId: request.selectionId,
          candidateId: request.candidateId,
          zoneId: request.zoneId,
          semantic: request.semantic,
        });
        ack({
          success: true,
          data: {
            requestId: request.requestId,
            session: request.session,
            selectionId: request.selectionId,
            candidateId: request.candidateId,
            semantic: request.semantic,
            outcome: "executed",
            authorityRetired: result.authorityRetired,
          },
        });
      } catch (error) {
        const code = actionErrorCode(error);
        logger.error(
          { err: error, code },
          code === "OUTCOME_UNKNOWN"
            ? "Public song action outcome is unknown"
            : "Public song action failed before issue"
        );
        ack({
          success: false,
          code,
          error: boundedError(error, "Public song action failed"),
        });
      }
    }
  );
}
