import { Logger } from "pino";
import { Socket } from "socket.io";

import {
  AlbumActionBeginAck,
  AlbumActionCancelAck,
  AlbumActionExecuteAck,
  AlbumActionFailedEvent,
  AlbumActionResolvedEvent,
  normalizeAlbumActionBeginRequest,
  normalizeAlbumActionCancelRequest,
  normalizeAlbumActionExecuteRequest,
} from "../../shared/albumActionContracts";
import {
  AlbumActionBeginReservation,
  AlbumActionEventSink,
  AlbumActionOrigin,
} from "../../core/roon/AlbumActionService";

type AlbumActionAck = (
  response: AlbumActionBeginAck | AlbumActionCancelAck | AlbumActionExecuteAck
) => void;

export interface AlbumActionSocketService {
  begin(
    origin: AlbumActionOrigin,
    value: unknown,
    sink: AlbumActionEventSink
  ): AlbumActionBeginReservation;
  cancel(origin: AlbumActionOrigin, value: unknown): AlbumActionCancelAck;
  execute(
    origin: AlbumActionOrigin,
    value: unknown
  ): Promise<AlbumActionExecuteAck>;
  disconnectSocket(socketId: string): void;
}

export interface AlbumActionSocketCoordinator {
  disconnectSocket(coreId: string, socketId: string): void;
}

export interface AlbumActionSocketDependencies {
  actionService: AlbumActionSocketService;
  coordinator: AlbumActionSocketCoordinator;
  getCoreId(): string | null;
  logger: Logger;
}

/** Registers the origin-bound two-phase album-action protocol on one socket. */
export function registerAlbumActionSocket(
  socket: Socket,
  dependencies: AlbumActionSocketDependencies
): void {
  const { actionService, coordinator, logger } = dependencies;

  const origin = (): AlbumActionOrigin | null => {
    try {
      const coreId = dependencies.getCoreId();
      return coreId ? { coreId, socketId: socket.id } : null;
    } catch (error) {
      logger.warn({ err: error }, "Album action Core lookup failed");
      return null;
    }
  };

  const acknowledge = (
    ack: AlbumActionAck,
    response: AlbumActionBeginAck | AlbumActionCancelAck | AlbumActionExecuteAck
  ): boolean => {
    try {
      ack(response);
      return true;
    } catch (error) {
      logger.warn({ err: error }, "Album action acknowledgment callback failed");
      return false;
    }
  };

  const invalidBegin = (): AlbumActionBeginAck => ({
    success: false,
    code: "INVALID_REQUEST",
    error: "Invalid album action begin request",
  });
  const invalidCancel = (): AlbumActionCancelAck => ({
    success: false,
    code: "INVALID_REQUEST",
    error: "Invalid album action cancel request",
  });
  const invalidExecute = (): AlbumActionExecuteAck => ({
    success: false,
    code: "INVALID_REQUEST",
    error: "Invalid album action execute request",
  });

  socket.on("album-action:begin", (value: unknown, ack?: AlbumActionAck) => {
    // Acceptance creates a lease, so a missing acknowledgment callback must
    // create no operation the client cannot correlate or cancel reliably.
    if (typeof ack !== "function") return;
    const request = normalizeAlbumActionBeginRequest(value);
    const requestOrigin = origin();
    if (!request || !requestOrigin) {
      acknowledge(ack, invalidBegin());
      return;
    }
    const sink: AlbumActionEventSink = {
      resolved: (event: AlbumActionResolvedEvent) => {
        socket.emit("album-action:resolved", event);
      },
      failed: (event: AlbumActionFailedEvent) => {
        socket.emit("album-action:failed", event);
      },
    };
    const reservation = actionService.begin(requestOrigin, request, sink);
    if (!acknowledge(ack, reservation.ack)) {
      if (reservation.ack.success) {
        actionService.cancel(requestOrigin, {
          operationId: reservation.ack.data.operationId,
        });
      }
      return;
    }
    reservation.start?.();
  });

  socket.on("album-action:cancel", (value: unknown, ack?: AlbumActionAck) => {
    if (typeof ack !== "function") return;
    const request = normalizeAlbumActionCancelRequest(value);
    const requestOrigin = origin();
    acknowledge(
      ack,
      request && requestOrigin
        ? actionService.cancel(requestOrigin, request)
        : invalidCancel()
    );
  });

  socket.on("album-action:execute", (value: unknown, ack?: AlbumActionAck) => {
    if (typeof ack !== "function") return;
    const request = normalizeAlbumActionExecuteRequest(value);
    const requestOrigin = origin();
    if (!request || !requestOrigin) {
      acknowledge(ack, invalidExecute());
      return;
    }
    void actionService.execute(requestOrigin, request).then(
      (response) => {
        acknowledge(ack, response);
      },
      (error: unknown) => {
        logger.error({ err: error }, "Album action execute handler failed");
        acknowledge(ack, invalidExecute());
      }
    );
  });

  socket.on("disconnect", () => {
    // The service owns the resolving/choosing cancellation claim and must run
    // before the coordinator disconnects the owning Timeline generation.
    actionService.disconnectSocket(socket.id);
    const coreId = origin()?.coreId;
    if (coreId) coordinator.disconnectSocket(coreId, socket.id);
  });
}
