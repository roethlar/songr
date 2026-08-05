import type { Socket } from "socket.io";
import type { Logger } from "pino";

import {
  normalizeClassicBrowseCommandRequest,
  normalizeClassicSessionAcquireRequest,
  normalizeClassicSessionReleaseRequest,
  CLASSIC_BROWSE_ERROR_MAX_LENGTH,
  type ClassicBrowseCommandAck,
  type ClassicBrowseErrorCode,
  type ClassicBrowseLoadOptions,
  type ClassicBrowseOptions,
  type ClassicBrowsePopOptions,
  type ClassicBrowseSearchOptions,
  type ClassicBrowseSessionRef,
  type ClassicSessionAcquireAck,
  type ClassicSessionReleaseAck,
} from "../../shared/classicBrowseContracts";
import type { BrowseResult, SearchResult } from "../../shared/types";
import {
  BrowseSessionCoordinator,
  BrowseSessionCoordinatorError,
  type ModeSessionAccess,
  type ModeSessionHandle,
} from "../../core/roon/BrowseSessionCoordinator";
import type { BrowseService } from "../../core/roon/BrowseService";
import { errorMessage } from "../util";

type Ack = (value: unknown) => void;

export interface ClassicBrowseSocketDependencies {
  readonly coordinator: BrowseSessionCoordinator;
  readonly browseService: BrowseService;
  readonly getCoreId: () => string | null;
  readonly logger: Logger;
}

function sessionRef(handle: ModeSessionHandle): ClassicBrowseSessionRef {
  return { handleId: handle.handleId, generation: handle.generation };
}

function modeHandle(session: ClassicBrowseSessionRef): ModeSessionHandle {
  return { kind: "mode", mode: "classic", ...session };
}

function errorCode(error: unknown): ClassicBrowseErrorCode {
  if (error instanceof BrowseSessionCoordinatorError) {
    if (error.code === "BACKPRESSURE") return "BACKPRESSURE";
    if (error.code === "OWNER_MISMATCH") return "OWNER_MISMATCH";
    if (error.code === "SESSION_LOST") return "SESSION_LOST";
    return "STALE_GENERATION";
  }
  return "INTERNAL_ERROR";
}

function failure(
  code: ClassicBrowseErrorCode,
  error: string
): { success: false; code: ClassicBrowseErrorCode; error: string } {
  const boundedError = (error || "Classic browse command failed").slice(
    0,
    CLASSIC_BROWSE_ERROR_MAX_LENGTH
  );
  return { success: false, code, error: boundedError };
}

function failureFor(error: unknown, internalMessage: string) {
  const code = errorCode(error);
  return failure(code, code === "INTERNAL_ERROR" ? internalMessage : errorMessage(error));
}

export function registerClassicBrowseSocket(
  socket: Socket,
  dependencies: ClassicBrowseSocketDependencies
): void {
  const { coordinator, browseService, getCoreId, logger } = dependencies;

  socket.on("classic-session:acquire", (value: unknown, ack?: Ack) => {
    const request = normalizeClassicSessionAcquireRequest(value);
    if (!request || !ack) {
      ack?.(failure("INVALID_REQUEST", "Invalid Classic session acquire request"));
      return;
    }
    const coreId = getCoreId();
    if (!coreId) {
      ack(failure("CORE_UNAVAILABLE", "Roon Core is unavailable"));
      return;
    }

    let handle: ModeSessionHandle | null = null;
    try {
      handle = coordinator.acquireMode({
        coreId,
        socketId: socket.id,
        tabId: request.tabId,
        mode: "classic",
		replaceDisconnected: true,
      });
      const response: ClassicSessionAcquireAck = {
        success: true,
        data: { requestId: request.requestId, session: sessionRef(handle) },
      };
      try {
        ack(response);
      } catch (error) {
        void coordinator
          .releaseMode({
            coreId,
            socketId: socket.id,
            tabId: request.tabId,
            handle,
          })
          .catch((releaseError: unknown) =>
            logger.warn({ err: releaseError }, "Classic acquire acknowledgment cleanup failed")
          );
        throw error;
      }
    } catch (error) {
      if (handle) {
        logger.warn({ err: error }, "Classic acquire acknowledgment failed");
        return;
      }
      logger.error({ err: error }, "Classic session acquire failed");
      ack(failureFor(error, "Classic session acquire failed"));
    }
  });

  socket.on("classic-session:release", async (value: unknown, ack?: Ack) => {
    const request = normalizeClassicSessionReleaseRequest(value);
    if (!request || !ack) {
      ack?.(failure("INVALID_REQUEST", "Invalid Classic session release request"));
      return;
    }
    const coreId = getCoreId();
    if (!coreId) {
      ack(failure("CORE_UNAVAILABLE", "Roon Core is unavailable"));
      return;
    }
    try {
      await coordinator.releaseMode({
        coreId,
        socketId: socket.id,
        tabId: request.tabId,
        handle: modeHandle(request.session),
      });
      const response: ClassicSessionReleaseAck = {
        success: true,
        data: { requestId: request.requestId },
      };
      ack(response);
    } catch (error) {
      logger.error({ err: error }, "Classic session release failed");
      ack(failureFor(error, "Classic session release failed"));
    }
  });

  const command =
    (expectedOperation: "browse" | "load" | "pop" | "search") =>
    async (value: unknown, ack?: Ack): Promise<void> => {
    const request = normalizeClassicBrowseCommandRequest(value);
    if (!request || request.operation !== expectedOperation || !ack) {
      ack?.(failure("INVALID_REQUEST", "Invalid Classic browse request"));
      return;
    }
    const coreId = getCoreId();
    if (!coreId) {
      ack(failure("CORE_UNAVAILABLE", "Roon Core is unavailable"));
      return;
    }
    const access: ModeSessionAccess = {
      coreId,
      socketId: socket.id,
      tabId: request.tabId,
      handle: modeHandle(request.session),
    };
    try {
      const result = await coordinator.runMode(
        access,
        request.role,
        async (session): Promise<BrowseResult | SearchResult[]> => {
          if (request.operation === "browse") {
            const options = request.options as ClassicBrowseOptions;
            const result = await session.browse({
              ...options,
              ...(options.itemKey
                ? {
                    itemKey: coordinator.resolveClassicItemKey(
                      access,
                      request.role,
                      options.itemKey
                    ),
                  }
                : {}),
            });
            return coordinator.publishClassicBrowseResult(access, request.role, result);
          }
          if (request.operation === "load") {
            const options = request.options as ClassicBrowseLoadOptions;
            const result = await session.load({
              ...options,
              ...(options.itemKey
                ? {
                    itemKey: coordinator.resolveClassicItemKey(
                      access,
                      request.role,
                      options.itemKey
                    ),
                  }
                : {}),
            });
            return coordinator.publishClassicBrowseResult(access, request.role, result);
          }
          if (request.operation === "pop") {
            const result = await session.pop(request.options as ClassicBrowsePopOptions);
            return coordinator.publishClassicBrowseResult(access, request.role, result);
          }
          return browseService.searchCoordinated(
            session,
            request.options as ClassicBrowseSearchOptions
          );
        }
      );
      const response: ClassicBrowseCommandAck = {
        success: true,
        data: {
          requestId: request.requestId,
          session: request.session,
          result,
        },
      };
      ack(response);
    } catch (error) {
      logger.error({ err: error }, "Classic browse command failed");
      ack(failureFor(error, "Classic browse command failed"));
    }
    };

  socket.on("browse:browse", command("browse"));
  socket.on("browse:load", command("load"));
  socket.on("browse:pop", command("pop"));
  socket.on("browse:search", command("search"));
}
