import { Logger } from "pino";
import { Socket } from "socket.io";

import {
  LibraryAlbumCancelAck,
  LibraryAlbumFailedEvent,
  LibraryAlbumOpenAck,
  LibraryAlbumResolvedEvent,
  LibraryAlbumSelectAck,
  LibraryAlbumVersionFailedEvent,
  LibraryAlbumVersionsEvent,
  normalizeLibraryAlbumCancelRequest,
  normalizeLibraryAlbumOpenRequest,
  normalizeLibraryAlbumSelectRequest,
} from "../../shared/libraryAlbumContracts";
import {
  LibraryAlbumEventSink,
  LibraryAlbumOpenReservation,
  LibraryAlbumOrigin,
  LibraryAlbumSelectReservation,
} from "../../core/roon/LibraryAlbumService";

type LibraryAlbumAck = (
  response: LibraryAlbumOpenAck | LibraryAlbumSelectAck | LibraryAlbumCancelAck
) => void;

export interface LibraryAlbumSocketService {
  open(
    origin: LibraryAlbumOrigin,
    value: unknown,
    sink: LibraryAlbumEventSink
  ): LibraryAlbumOpenReservation;
  select(origin: LibraryAlbumOrigin, value: unknown): LibraryAlbumSelectReservation;
  cancel(origin: LibraryAlbumOrigin, value: unknown): LibraryAlbumCancelAck;
  disconnectSocket(socketId: string): void;
}

export interface LibraryAlbumSocketDependencies {
  libraryAlbumService: LibraryAlbumSocketService;
  getCoreId(): string | null;
  logger: Logger;
}

/** Registers the origin-bound retained library-album page protocol. */
export function registerLibraryAlbumSocket(
  socket: Socket,
  dependencies: LibraryAlbumSocketDependencies
): void {
  const { libraryAlbumService, logger } = dependencies;

  const origin = (): LibraryAlbumOrigin | null => {
    try {
      const coreId = dependencies.getCoreId();
      return coreId ? { coreId, socketId: socket.id } : null;
    } catch (error) {
      logger.warn({ err: error }, "Library album Core lookup failed");
      return null;
    }
  };

  const acknowledge = (
    ack: LibraryAlbumAck,
    response: LibraryAlbumOpenAck | LibraryAlbumSelectAck | LibraryAlbumCancelAck
  ): boolean => {
    try {
      ack(response);
      return true;
    } catch (error) {
      logger.warn({ err: error }, "Library album acknowledgment callback failed");
      return false;
    }
  };

  const invalidOpen = (): LibraryAlbumOpenAck => ({
    success: false,
    code: "INVALID_REQUEST",
    error: "Invalid library album open request",
  });
  const invalidCancel = (): LibraryAlbumCancelAck => ({
    success: false,
    code: "INVALID_REQUEST",
    error: "Invalid library album cancel request",
  });
  const invalidSelect = (): LibraryAlbumSelectAck => ({
    success: false,
    code: "INVALID_REQUEST",
    error: "Invalid library album version request",
  });

  socket.on("library-album:open", (value: unknown, ack?: LibraryAlbumAck) => {
    // Acceptance creates a lease, so a missing acknowledgment callback must
    // create no operation the client cannot correlate or cancel reliably.
    if (typeof ack !== "function") return;
    const request = normalizeLibraryAlbumOpenRequest(value);
    const requestOrigin = origin();
    if (!request || !requestOrigin) {
      acknowledge(ack, invalidOpen());
      return;
    }
    const sink: LibraryAlbumEventSink = {
      versions: (event: LibraryAlbumVersionsEvent) => {
        socket.emit("library-album:versions", event);
      },
      resolved: (event: LibraryAlbumResolvedEvent) => {
        socket.emit("library-album:resolved", event);
      },
      versionFailed: (event: LibraryAlbumVersionFailedEvent) => {
        socket.emit("library-album:version-failed", event);
      },
      failed: (event: LibraryAlbumFailedEvent) => {
        socket.emit("library-album:failed", event);
      },
    };
    const reservation = libraryAlbumService.open(requestOrigin, request, sink);
    if (!acknowledge(ack, reservation.ack)) {
      if (reservation.ack.success) {
        libraryAlbumService.cancel(requestOrigin, {
          operationId: reservation.ack.data.operationId,
        });
      }
      return;
    }
    reservation.start?.();
  });

  socket.on("library-album:select", (value: unknown, ack?: LibraryAlbumAck) => {
    if (typeof ack !== "function") return;
    const request = normalizeLibraryAlbumSelectRequest(value);
    const requestOrigin = origin();
    if (!request || !requestOrigin) {
      acknowledge(ack, invalidSelect());
      return;
    }
    const reservation = libraryAlbumService.select(requestOrigin, request);
    if (!acknowledge(ack, reservation.ack)) return;
    reservation.start?.();
  });

  socket.on("library-album:cancel", (value: unknown, ack?: LibraryAlbumAck) => {
    if (typeof ack !== "function") return;
    const request = normalizeLibraryAlbumCancelRequest(value);
    const requestOrigin = origin();
    acknowledge(
      ack,
      request && requestOrigin
        ? libraryAlbumService.cancel(requestOrigin, request)
        : invalidCancel()
    );
  });

  socket.on("disconnect", () => {
    // The service owns cancellation of in-flight reads and must run before
    // the coordinator disconnects the owning mode generation.
    libraryAlbumService.disconnectSocket(socket.id);
  });
}
