import type { Logger } from "pino";
import type { Socket } from "socket.io";

import type {
  TimelineAlbumDetailBeginAck,
  TimelineAlbumDetailCloseAck,
  TimelineAlbumDetailCloseFailedEvent,
  TimelineAlbumDetailCloseRequest,
  TimelineAlbumDetailClosedEvent,
  TimelineAlbumDetailFailedEvent,
  TimelineAlbumDetailLoadedEvent,
  TimelineAlbumDetailRequest,
  TimelineArtistLoadBeginAck,
  TimelineArtistLoadFailedEvent,
  TimelineArtistLoadedEvent,
  TimelineArtistLoadRequest,
  TimelineSessionReconnectAck,
  TimelineSessionReconnectRequest,
  TimelineSessionReleaseAck,
  TimelineSessionReleaseRequest,
} from "../../shared/timelineBrowseContracts";
import {
  normalizeTimelineAlbumDetailCloseRequest,
  normalizeTimelineAlbumDetailRequest,
  normalizeTimelineArtistLoadRequest,
  normalizeTimelineSessionReconnectRequest,
  normalizeTimelineSessionReleaseRequest,
} from "../../shared/timelineBrowseContracts";
import type {
  TimelineAlbumDetailCloseReservation,
  TimelineAlbumDetailCloseSink,
  TimelineAlbumDetailReservation,
  TimelineAlbumDetailSink,
  TimelineArtistLoadOrigin,
  TimelineArtistLoadReservation,
  TimelineArtistLoadSink,
} from "../../core/roon/TimelineBrowseService";

type TimelineBrowseAck = (
  response:
    | TimelineArtistLoadBeginAck
    | TimelineAlbumDetailBeginAck
    | TimelineAlbumDetailCloseAck
    | TimelineSessionReconnectAck
    | TimelineSessionReleaseAck
) => void;

export interface TimelineBrowseSocketService {
  begin(
    origin: TimelineArtistLoadOrigin,
    request: TimelineArtistLoadRequest,
    sink: TimelineArtistLoadSink
  ): TimelineArtistLoadReservation;
  beginDetail(
    origin: TimelineArtistLoadOrigin,
    request: TimelineAlbumDetailRequest,
    sink: TimelineAlbumDetailSink
  ): TimelineAlbumDetailReservation;
  closeDetail(
    origin: TimelineArtistLoadOrigin,
    request: TimelineAlbumDetailCloseRequest,
    sink: TimelineAlbumDetailCloseSink
  ): TimelineAlbumDetailCloseReservation;
  reconnect(
    origin: TimelineArtistLoadOrigin,
    request: TimelineSessionReconnectRequest
  ): TimelineSessionReconnectAck;
  release(
    origin: TimelineArtistLoadOrigin,
    request: TimelineSessionReleaseRequest
  ): TimelineSessionReleaseAck;
  disconnectSocket(socketId: string): void;
}

export interface TimelineBrowseSocketDependencies {
  timelineBrowseService: TimelineBrowseSocketService;
  getCoreId(): string | null;
  logger: Logger;
}

/** Registers the origin-bound two-phase Timeline artist-load protocol. */
export function registerTimelineBrowseSocket(
  socket: Socket,
  dependencies: TimelineBrowseSocketDependencies
): void {
  const { timelineBrowseService, logger } = dependencies;

  const origin = (): TimelineArtistLoadOrigin | null => {
    try {
      const coreId = dependencies.getCoreId();
      return coreId ? { coreId, socketId: socket.id } : null;
    } catch (error) {
      logger.warn({ err: error }, "Timeline artist-load Core lookup failed");
      return null;
    }
  };

  const acknowledge = (
    ack: TimelineBrowseAck,
    response: Parameters<TimelineBrowseAck>[0]
  ): boolean => {
    try {
      ack(response);
      return true;
    } catch (error) {
      logger.warn(
        { err: error },
        "Timeline artist-load acknowledgment callback failed"
      );
      return false;
    }
  };

  const abandon = (
    reservation:
      | TimelineArtistLoadReservation
      | TimelineAlbumDetailReservation
      | TimelineAlbumDetailCloseReservation
  ): void => {
    try {
      const abandoned = reservation.abandon?.();
      void abandoned?.catch((error: unknown) => {
        logger.warn({ err: error }, "Timeline artist-load abandon failed");
      });
    } catch (error) {
      logger.warn({ err: error }, "Timeline artist-load abandon failed");
    }
  };

  const invalidRequest = (): TimelineArtistLoadBeginAck => ({
    success: false,
    code: "INVALID_REQUEST",
    error: "Invalid Timeline artist load request",
  });
  const coreUnavailable = (): TimelineArtistLoadBeginAck => ({
    success: false,
    code: "CORE_UNAVAILABLE",
    error: "Roon Core is unavailable",
  });
  const internalFailure = (): TimelineArtistLoadBeginAck => ({
    success: false,
    code: "INTERNAL_ERROR",
    error: "Timeline artist loading failed",
  });

  socket.on(
    "timeline-artist:begin",
    (value: unknown, ack?: TimelineBrowseAck) => {
      // Acceptance acquires a mode lease, so an unacknowledged request must
      // create no operation that the client cannot correlate reliably.
      if (typeof ack !== "function") return;

      const request = normalizeTimelineArtistLoadRequest(value);
      if (!request) {
        acknowledge(ack, invalidRequest());
        return;
      }
      const requestOrigin = origin();
      if (!requestOrigin) {
        acknowledge(ack, coreUnavailable());
        return;
      }

      const sink: TimelineArtistLoadSink = {
        loaded: (event: TimelineArtistLoadedEvent) => {
          socket.emit("timeline-artist:loaded", event);
        },
        failed: (event: TimelineArtistLoadFailedEvent) => {
          socket.emit("timeline-artist:failed", event);
        },
      };

      let reservation: TimelineArtistLoadReservation;
      try {
        reservation = timelineBrowseService.begin(
          requestOrigin,
          request,
          sink
        );
      } catch (error) {
        logger.error({ err: error }, "Timeline artist-load begin failed");
        acknowledge(ack, internalFailure());
        return;
      }

      if (!acknowledge(ack, reservation.ack)) {
        abandon(reservation);
        return;
      }
      if (!reservation.ack.success) return;

      try {
        const started = reservation.start?.();
        void started?.catch((error: unknown) => {
          logger.error({ err: error }, "Timeline artist-load start failed");
          abandon(reservation);
        });
      } catch (error) {
        logger.error({ err: error }, "Timeline artist-load start failed");
        abandon(reservation);
      }
    }
  );

  socket.on(
    "timeline-detail:begin",
    (value: unknown, ack?: TimelineBrowseAck) => {
      if (typeof ack !== "function") return;
      const request = normalizeTimelineAlbumDetailRequest(value);
      if (!request) {
        acknowledge(ack, {
          success: false,
          code: "INVALID_REQUEST",
          error: "Invalid Timeline album detail request",
        });
        return;
      }
      const requestOrigin = origin();
      if (!requestOrigin) {
        acknowledge(ack, {
          success: false,
          code: "CORE_UNAVAILABLE",
          error: "Roon Core is unavailable",
        });
        return;
      }
      const sink: TimelineAlbumDetailSink = {
        loaded: (event: TimelineAlbumDetailLoadedEvent) => {
          socket.emit("timeline-detail:loaded", event);
        },
        failed: (event: TimelineAlbumDetailFailedEvent) => {
          socket.emit("timeline-detail:failed", event);
        },
      };
      let reservation: TimelineAlbumDetailReservation;
      try {
        reservation = timelineBrowseService.beginDetail(
          requestOrigin,
          request,
          sink
        );
      } catch (error) {
        logger.error({ err: error }, "Timeline album-detail begin failed");
        acknowledge(ack, {
          success: false,
          code: "INTERNAL_ERROR",
          error: "Timeline album detail loading failed",
        });
        return;
      }
      if (!acknowledge(ack, reservation.ack)) {
        abandon(reservation);
        return;
      }
      if (!reservation.ack.success) return;
      try {
        const started = reservation.start?.();
        void started?.catch((error: unknown) => {
          logger.error({ err: error }, "Timeline album-detail start failed");
          abandon(reservation);
        });
      } catch (error) {
        logger.error({ err: error }, "Timeline album-detail start failed");
        abandon(reservation);
      }
    }
  );

  socket.on(
    "timeline-detail:close",
    (value: unknown, ack?: TimelineBrowseAck) => {
      if (typeof ack !== "function") return;
      const request = normalizeTimelineAlbumDetailCloseRequest(value);
      if (!request) {
        acknowledge(ack, {
          success: false,
          code: "INVALID_REQUEST",
          error: "Invalid Timeline album detail close request",
        });
        return;
      }
      const requestOrigin = origin();
      if (!requestOrigin) {
        acknowledge(ack, {
          success: false,
          code: "CORE_UNAVAILABLE",
          error: "Roon Core is unavailable",
        });
        return;
      }
      const sink: TimelineAlbumDetailCloseSink = {
        closed: (event: TimelineAlbumDetailClosedEvent) => {
          socket.emit("timeline-detail:closed", event);
        },
        failed: (event: TimelineAlbumDetailCloseFailedEvent) => {
          socket.emit("timeline-detail:close-failed", event);
        },
      };
      let reservation: TimelineAlbumDetailCloseReservation;
      try {
        reservation = timelineBrowseService.closeDetail(
          requestOrigin,
          request,
          sink
        );
      } catch (error) {
        logger.error({ err: error }, "Timeline album-detail close begin failed");
        acknowledge(ack, {
          success: false,
          code: "INTERNAL_ERROR",
          error: "Timeline album detail close failed",
        });
        return;
      }
      if (!acknowledge(ack, reservation.ack)) {
        abandon(reservation);
        return;
      }
      if (!reservation.ack.success) return;
      try {
        const started = reservation.start?.();
        void started?.catch((error: unknown) => {
          logger.error({ err: error }, "Timeline album-detail close start failed");
          abandon(reservation);
        });
      } catch (error) {
        logger.error({ err: error }, "Timeline album-detail close start failed");
        abandon(reservation);
      }
    }
  );

  socket.on(
    "timeline-session:reconnect",
    (value: unknown, ack?: TimelineBrowseAck) => {
      if (typeof ack !== "function") return;
      const request = normalizeTimelineSessionReconnectRequest(value);
      if (!request) {
        acknowledge(ack, {
          success: false,
          code: "INVALID_REQUEST",
          error: "Invalid Timeline reconnect request",
        });
        return;
      }
      const requestOrigin = origin();
      if (!requestOrigin) {
        acknowledge(ack, {
          success: false,
          code: "CORE_UNAVAILABLE",
          error: "Roon Core is unavailable",
        });
        return;
      }
      try {
        acknowledge(
          ack,
          timelineBrowseService.reconnect(requestOrigin, request)
        );
      } catch (error) {
        logger.error({ err: error }, "Timeline reconnect failed");
        acknowledge(ack, {
          success: false,
          code: "INTERNAL_ERROR",
          error: "Timeline reconnect failed",
        });
      }
    }
  );

  socket.on(
    "timeline-session:release",
    (value: unknown, ack?: TimelineBrowseAck) => {
      if (typeof ack !== "function") return;
      const request = normalizeTimelineSessionReleaseRequest(value);
      if (!request) {
        acknowledge(ack, {
          success: false,
          code: "INVALID_REQUEST",
          error: "Invalid Timeline release request",
        });
        return;
      }
      const requestOrigin = origin();
      if (!requestOrigin) {
        acknowledge(ack, {
          success: false,
          code: "CORE_UNAVAILABLE",
          error: "Roon Core is unavailable",
        });
        return;
      }
      try {
        acknowledge(ack, timelineBrowseService.release(requestOrigin, request));
      } catch (error) {
        logger.error({ err: error }, "Timeline release failed");
        acknowledge(ack, {
          success: false,
          code: "INTERNAL_ERROR",
          error: "Timeline release failed",
        });
      }
    }
  );

  socket.on("disconnect", () => {
    timelineBrowseService.disconnectSocket(socket.id);
  });
}
