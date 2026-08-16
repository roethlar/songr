import { Logger } from "pino";
import { Socket } from "socket.io";

import {
  EditorialItemFailedEvent,
  EditorialItemOpenAck,
  EditorialItemReadyEvent,
  normalizeEditorialItemCancelRequest,
  normalizeEditorialItemFollowRequest,
  normalizeEditorialItemOpenRequest,
} from "../../shared/editorialItemContracts";
import type {
  EditorialItemFollowInput,
  EditorialItemOpenInput,
  EditorialItemOpenReservation,
  EditorialItemSink,
} from "../../core/roon/EditorialItemSessionService";

type EditorialItemAck = (response: EditorialItemOpenAck) => void;
type EditorialCancelAck = (response: { readonly canceled: boolean }) => void;

export interface EditorialItemSocketService {
  open(input: EditorialItemOpenInput): EditorialItemOpenReservation;
  follow(input: EditorialItemFollowInput): EditorialItemOpenReservation;
  cancel(input: {
    readonly socketId: string;
    readonly tabId: string;
    readonly sessionId: string;
  }): boolean;
  disconnectSocket(socketId: string): void;
}

export interface EditorialItemSocketDependencies {
  editorialItemService: EditorialItemSocketService;
  getCoreId(): string | null;
  logger: Logger;
}

/** Registers the per-socket editorial item session protocol (plan §5.3). */
export function registerEditorialItemSocket(
  socket: Socket,
  dependencies: EditorialItemSocketDependencies
): void {
  const { editorialItemService, logger } = dependencies;

  const coreId = (): string | null => {
    try {
      return dependencies.getCoreId();
    } catch (error) {
      logger.warn({ err: error }, "Editorial item Core lookup failed");
      return null;
    }
  };

  const acknowledge = (
    ack: EditorialItemAck | EditorialCancelAck,
    response: EditorialItemOpenAck | { readonly canceled: boolean }
  ): boolean => {
    try {
      (ack as (value: unknown) => void)(response);
      return true;
    } catch (error) {
      logger.warn({ err: error }, "Editorial item acknowledgment callback failed");
      return false;
    }
  };

  const invalid = (): EditorialItemOpenAck => ({
    ok: false,
    code: "INVALID_REQUEST",
    error: "Invalid editorial item request",
  });

  const sink: EditorialItemSink = {
    ready: (event: EditorialItemReadyEvent) => {
      socket.emit("item-editorial:ready", event);
    },
    failed: (event: EditorialItemFailedEvent) => {
      socket.emit("item-editorial:failed", event);
    },
  };

  socket.on("item-editorial:open", (value: unknown, ack?: EditorialItemAck) => {
    // Acceptance creates a session, so a missing acknowledgment callback
    // must create nothing the client cannot correlate or cancel.
    if (typeof ack !== "function") return;
    const request = normalizeEditorialItemOpenRequest(value);
    const requestCoreId = coreId();
    if (!request || !requestCoreId) {
      acknowledge(ack, invalid());
      return;
    }
    const reservation = editorialItemService.open({
      socketId: socket.id,
      coreId: requestCoreId,
      tabId: request.tabId,
      requestId: request.requestId,
      generation: request.generation,
      anchor: request.anchor,
      sink,
    });
    if (!acknowledge(ack, reservation.ack)) {
      reservation.abandon?.();
      return;
    }
    reservation.start?.();
  });

  socket.on("item-editorial:follow", (value: unknown, ack?: EditorialItemAck) => {
    if (typeof ack !== "function") return;
    const request = normalizeEditorialItemFollowRequest(value);
    const requestCoreId = coreId();
    if (!request || !requestCoreId) {
      acknowledge(ack, invalid());
      return;
    }
    const reservation = editorialItemService.follow({
      socketId: socket.id,
      coreId: requestCoreId,
      tabId: request.tabId,
      requestId: request.requestId,
      generation: request.generation,
      sessionId: request.sessionId,
      target: request.target,
      sink,
    });
    if (!acknowledge(ack, reservation.ack)) {
      reservation.abandon?.();
      return;
    }
    reservation.start?.();
  });

  socket.on("item-editorial:cancel", (value: unknown, ack?: EditorialCancelAck) => {
    const request = normalizeEditorialItemCancelRequest(value);
    const canceled =
      request !== null &&
      editorialItemService.cancel({
        socketId: socket.id,
        tabId: request.tabId,
        sessionId: request.sessionId,
      });
    if (typeof ack === "function") acknowledge(ack, { canceled });
  });

  socket.on("disconnect", () => {
    editorialItemService.disconnectSocket(socket.id);
  });
}
