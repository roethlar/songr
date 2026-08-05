import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { Logger } from "pino";
import {
  TransportControlRequest,
  SeekRequest,
  VolumeRequest,
  QueueSubscribeRequest,
  QueuePlayFromHereRequest,
  ZonePlaybackSettingsRequest,
  QueueResponse,
  LoopModeRequest,
} from "../../shared/types";
import { TransportService } from "../../core/roon/TransportService";
import { BrowseService } from "../../core/roon/BrowseService";
import { AlbumActionService } from "../../core/roon/AlbumActionService";
import { LibraryAlbumService } from "../../core/roon/LibraryAlbumService";
import { TimelineBrowseService } from "../../core/roon/TimelineBrowseService";
import { BrowseSessionCoordinator } from "../../core/roon/BrowseSessionCoordinator";
import { PublicSongResolverService } from "../../core/roon/PublicSongResolverService";
import { RoonClient } from "../../core/roon/RoonClient";
import type { SongRelationshipFeaturePort } from "../libraryFeatures";
import { errorMessage } from "../util";
import { registerAlbumActionSocket } from "./albumActions";
import { registerLibraryAlbumSocket } from "./libraryAlbum";
import { registerTimelineBrowseSocket } from "./timelineBrowse";
import { registerClassicBrowseSocket } from "./classicBrowse";
import { registerUnifiedSearchSocket } from "./unifiedSearch";
import { registerPublicSongResolverSocket } from "./publicSongResolver";

const VALID_LOOP_VALUES: readonly LoopModeRequest[] = ["disabled", "loop", "loop_one", "next"];

export interface SocketContext {
  io: SocketIOServer;
}

interface SocketDependencies {
  roonClient: RoonClient;
  transportService: TransportService;
  browseService: BrowseService;
  albumActionService: AlbumActionService;
  libraryAlbumService: LibraryAlbumService;
  timelineBrowseService: TimelineBrowseService;
  browseSessionCoordinator: BrowseSessionCoordinator;
  publicSongResolverService: PublicSongResolverService;
  songRelationships: SongRelationshipFeaturePort;
  logger: Logger;
}

/**
 * Standardized ack response shape. Every socket command that accepts an ack
 * callback MUST resolve it with one of these two shapes so the client can
 * inspect success/failure uniformly.
 */
type AckResponse<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string; code?: string };

type AckFn = (response: unknown) => void;

export const attachSocketServer = (
  httpServer: HttpServer,
  deps: SocketDependencies
): SocketContext => {
  // CLIENT_ORIGIN: comma-separated allowlist of allowed origins, or "*" to
  // allow any. Defaults to "*" for LAN-appliance use; tighten this to your
  // SPA origin(s) when running behind a reverse proxy or on the public net.
  const originRaw = process.env.CLIENT_ORIGIN ?? "*";
  const origin: string | string[] =
    originRaw === "*"
      ? "*"
      : originRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin,
      methods: ["GET", "POST"],
    },
  });

  const {
    roonClient,
    transportService,
    browseService,
    albumActionService,
    libraryAlbumService,
    timelineBrowseService,
    browseSessionCoordinator,
    publicSongResolverService,
    songRelationships,
    logger,
  } = deps;

  /**
   * Send an error response. If an ack callback is provided, the error
   * goes through the ack only; otherwise the topic-specific event fires.
   *
   * Sending through both would double-fire the client's feedback toast
   * because `emitWithAck` (for ack-bearing emits) and `register.ts`
   * (for passive event listeners) both push into commandFeedbackStore.
   * Clients that need failure feedback must therefore either pass an
   * ack or rely on the passive event — not both.
   */
  const sendError = (
    socket: Socket,
    topic: "transport:error" | "browse:error" | "queue:error",
    command: string,
    message: string,
    ack?: AckFn,
    code?: string
  ) => {
    if (ack) {
      const ackPayload: AckResponse = code
        ? { success: false, error: message, code }
        : { success: false, error: message };
      ack(ackPayload);
      return;
    }
    socket.emit(topic, { command, error: message, ...(code ? { code } : {}) });
  };

  const sendSuccess = <T>(ack: AckFn | undefined, data?: T) => {
    if (ack) {
      const payload: AckResponse<T> =
        data === undefined ? { success: true } : { success: true, data };
      ack(payload);
    }
  };

  const handleAsync = async <T>(
    socket: Socket,
    topic: "transport:error" | "browse:error" | "queue:error",
    command: string,
    ack: AckFn | undefined,
    fn: () => Promise<T>,
    onSuccess?: (value: T) => void
  ) => {
    try {
      const value = await fn();
      if (onSuccess) onSuccess(value);
      else sendSuccess(ack, value);
    } catch (error) {
      logger.error({ err: error, command }, "Socket command failed");
      sendError(socket, topic, command, errorMessage(error), ack);
    }
  };

  io.on("connection", (socket) => {
    logger.info({ clientId: socket.id }, "WebSocket client connected");
    registerTimelineBrowseSocket(socket, {
      timelineBrowseService,
      getCoreId: () => roonClient.getCoreInfo()?.id ?? null,
      logger,
    });
    registerAlbumActionSocket(socket, {
      actionService: albumActionService,
      coordinator: browseSessionCoordinator,
      getCoreId: () => roonClient.getCoreInfo()?.id ?? null,
      logger,
    });
    registerClassicBrowseSocket(socket, {
      coordinator: browseSessionCoordinator,
      browseService,
      getCoreId: () => roonClient.getCoreInfo()?.id ?? null,
      logger,
    });
    registerUnifiedSearchSocket(socket, {
      coordinator: browseSessionCoordinator,
      browseService,
      zones: transportService,
      songRelationships,
      getCoreId: () => roonClient.getCoreInfo()?.id ?? null,
      logger,
    });
    registerPublicSongResolverSocket(socket, {
      resolver: publicSongResolverService,
      getCoreId: () => roonClient.getCoreInfo()?.id ?? null,
      logger,
    });
    registerLibraryAlbumSocket(socket, {
      libraryAlbumService,
      getCoreId: () => roonClient.getCoreInfo()?.id ?? null,
      logger,
    });

    // Hydrate the new client with current state. Without this, a transient
    // socket disconnect would leave the UI showing stale or empty state until
    // the next Roon push.
    socket.emit("core-status", {
      coreStatus: roonClient.getCoreStatus(),
      coreInfo: roonClient.getCoreInfo() ?? undefined,
    });
    socket.emit("zones", { zones: transportService.getZones() });
    for (const nowPlaying of transportService.getNowPlayingAll()) {
      socket.emit("now-playing-updated", {
        zone_id: nowPlaying.zone_id,
        now_playing: nowPlaying,
      });
    }

    socket.on(
      "transport:play-pause",
      async (payload: TransportControlRequest, ack?: AckFn) => {
        if (!payload?.zone_id) {
          sendError(socket, "transport:error", "transport:play-pause", "zone_id required", ack);
          return;
        }
        await handleAsync(socket, "transport:error", "transport:play-pause", ack, () =>
          transportService.playPause(payload.zone_id)
        );
      }
    );

    socket.on(
      "transport:next",
      async (payload: TransportControlRequest, ack?: AckFn) => {
        if (!payload?.zone_id) {
          sendError(socket, "transport:error", "transport:next", "zone_id required", ack);
          return;
        }
        await handleAsync(socket, "transport:error", "transport:next", ack, () =>
          transportService.next(payload.zone_id)
        );
      }
    );

    socket.on(
      "transport:previous",
      async (payload: TransportControlRequest, ack?: AckFn) => {
        if (!payload?.zone_id) {
          sendError(socket, "transport:error", "transport:previous", "zone_id required", ack);
          return;
        }
        await handleAsync(socket, "transport:error", "transport:previous", ack, () =>
          transportService.previous(payload.zone_id)
        );
      }
    );

    socket.on(
      "transport:stop",
      async (payload: TransportControlRequest, ack?: AckFn) => {
        if (!payload?.zone_id) {
          sendError(socket, "transport:error", "transport:stop", "zone_id required", ack);
          return;
        }
        await handleAsync(socket, "transport:error", "transport:stop", ack, () =>
          transportService.stop(payload.zone_id)
        );
      }
    );

    socket.on(
      "transport:seek",
      async (payload: SeekRequest, ack?: AckFn) => {
        if (
          !payload?.zone_id ||
          typeof payload.seconds !== "number" ||
          !Number.isFinite(payload.seconds) ||
          payload.seconds < 0
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:seek",
            "zone_id and finite, non-negative seconds required",
            ack
          );
          return;
        }
        await handleAsync(socket, "transport:error", "transport:seek", ack, () =>
          transportService.seek(payload.zone_id, payload.seconds)
        );
      }
    );

    socket.on(
      "transport:volume",
      async (payload: VolumeRequest, ack?: AckFn) => {
        if (
          !payload?.output_id ||
          typeof payload.value !== "number" ||
          !Number.isFinite(payload.value)
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:volume",
            "output_id and finite numeric value required",
            ack
          );
          return;
        }
        await handleAsync(socket, "transport:error", "transport:volume", ack, () =>
          transportService.setVolume(payload.output_id, payload.value)
        );
      }
    );

    socket.on(
      "transport:settings",
      async (payload: ZonePlaybackSettingsRequest, ack?: AckFn) => {
        if (!payload?.zone_id) {
          sendError(socket, "transport:error", "transport:settings", "zone_id required", ack);
          return;
        }

        if (
          payload.shuffle === undefined &&
          payload.auto_radio === undefined &&
          payload.loop === undefined
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:settings",
            "at least one of shuffle, auto_radio, or loop must be provided",
            ack
          );
          return;
        }
        if (payload.shuffle !== undefined && typeof payload.shuffle !== "boolean") {
          sendError(socket, "transport:error", "transport:settings", "shuffle must be boolean", ack);
          return;
        }
        if (payload.auto_radio !== undefined && typeof payload.auto_radio !== "boolean") {
          sendError(socket, "transport:error", "transport:settings", "auto_radio must be boolean", ack);
          return;
        }
        if (payload.loop !== undefined && !VALID_LOOP_VALUES.includes(payload.loop)) {
          sendError(
            socket,
            "transport:error",
            "transport:settings",
            `loop must be one of: ${VALID_LOOP_VALUES.join(", ")}`,
            ack
          );
          return;
        }

        await handleAsync(socket, "transport:error", "transport:settings", ack, () =>
          transportService.setPlaybackSettings(payload.zone_id, payload)
        );
      }
    );

    socket.on(
      "transport:group",
      async (
        payload: { output_ids?: unknown },
        ack?: AckFn
      ) => {
        if (
          !payload?.output_ids ||
          !Array.isArray(payload.output_ids) ||
          payload.output_ids.length < 2 ||
          !payload.output_ids.every(
            (id): id is string => typeof id === "string" && id.length > 0
          )
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:group",
            "output_ids must be an array of at least two non-empty strings",
            ack
          );
          return;
        }
        await handleAsync(socket, "transport:error", "transport:group", ack, () =>
          transportService.groupOutputs(payload.output_ids as string[])
        );
      }
    );

    socket.on(
      "transport:ungroup",
      async (
        payload: { output_ids?: unknown },
        ack?: AckFn
      ) => {
        if (
          !payload?.output_ids ||
          !Array.isArray(payload.output_ids) ||
          payload.output_ids.length === 0 ||
          !payload.output_ids.every(
            (id): id is string => typeof id === "string" && id.length > 0
          )
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:ungroup",
            "output_ids must be a non-empty array of strings",
            ack
          );
          return;
        }
        await handleAsync(socket, "transport:error", "transport:ungroup", ack, () =>
          transportService.ungroupOutputs(payload.output_ids as string[])
        );
      }
    );

    socket.on(
      "transport:standby",
      async (
        payload: { output_id?: unknown; control_key?: unknown },
        ack?: AckFn
      ) => {
        // IDEMPOTENT: puts an output into standby. Duplicate /
        // retried / stale call won't wake it. Use
        // transport:toggle-standby for explicit toggle semantics.
        if (
          !payload?.output_id ||
          typeof payload.output_id !== "string"
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:standby",
            "output_id required",
            ack
          );
          return;
        }
        if (
          payload.control_key !== undefined &&
          typeof payload.control_key !== "string"
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:standby",
            "control_key must be a string when provided",
            ack
          );
          return;
        }
        await handleAsync(socket, "transport:error", "transport:standby", ack, () =>
          transportService.standby(
            payload.output_id as string,
            payload.control_key as string | undefined
          )
        );
      }
    );

    socket.on(
      "transport:toggle-standby",
      async (
        payload: { output_id?: unknown; control_key?: unknown },
        ack?: AckFn
      ) => {
        // NOT idempotent: flips the state every call. For "make
        // sure output is asleep" intent use transport:standby.
        if (
          !payload?.output_id ||
          typeof payload.output_id !== "string"
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:toggle-standby",
            "output_id required",
            ack
          );
          return;
        }
        if (
          payload.control_key !== undefined &&
          typeof payload.control_key !== "string"
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:toggle-standby",
            "control_key must be a string when provided",
            ack
          );
          return;
        }
        await handleAsync(
          socket,
          "transport:error",
          "transport:toggle-standby",
          ack,
          () =>
            transportService.toggleStandby(
              payload.output_id as string,
              payload.control_key as string | undefined
            )
        );
      }
    );

    socket.on(
      "transport:wake",
      async (
        payload: { output_id?: unknown; control_key?: unknown },
        ack?: AckFn
      ) => {
        if (
          !payload?.output_id ||
          typeof payload.output_id !== "string"
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:wake",
            "output_id required",
            ack
          );
          return;
        }
        if (
          payload.control_key !== undefined &&
          typeof payload.control_key !== "string"
        ) {
          sendError(
            socket,
            "transport:error",
            "transport:wake",
            "control_key must be a string when provided",
            ack
          );
          return;
        }
        await handleAsync(socket, "transport:error", "transport:wake", ack, () =>
          transportService.convenienceSwitch(
            payload.output_id as string,
            payload.control_key as string | undefined
          )
        );
      }
    );

    socket.on(
      "queue:subscribe",
      (payload: QueueSubscribeRequest, ack?: AckFn) => {
        if (!payload?.zone_id) {
          sendError(socket, "queue:error", "queue:subscribe", "zone_id required", ack);
          return;
        }
        if (
          payload.max_item_count !== undefined &&
          (!Number.isInteger(payload.max_item_count) || payload.max_item_count <= 0)
        ) {
          sendError(
            socket,
            "queue:error",
            "queue:subscribe",
            "max_item_count must be a positive integer",
            ack
          );
          return;
        }
        // M-4: cap at MAX (see TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS).
        if (
          payload.max_item_count !== undefined &&
          payload.max_item_count > TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS
        ) {
          sendError(
            socket,
            "queue:error",
            "queue:subscribe",
            `max_item_count must be ≤ ${TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS}`,
            ack
          );
          return;
        }
        try {
          transportService.subscribeQueue(payload.zone_id, payload.max_item_count);
          const response: QueueResponse = {
            queue: transportService.getQueue(payload.zone_id),
          };
          sendSuccess(ack, response);
        } catch (error) {
          logger.error({ err: error }, "Socket queue subscribe failed");
          sendError(socket, "queue:error", "queue:subscribe", errorMessage(error), ack);
        }
      }
    );

    socket.on(
      "queue:get",
      (payload: QueueSubscribeRequest, ack?: AckFn) => {
        if (!payload?.zone_id) {
          sendError(socket, "queue:error", "queue:get", "zone_id required", ack);
          return;
        }
        try {
          const response: QueueResponse = {
            queue: transportService.getQueue(payload.zone_id),
          };
          sendSuccess(ack, response);
        } catch (error) {
          logger.error({ err: error }, "Socket queue get failed");
          sendError(socket, "queue:error", "queue:get", errorMessage(error), ack);
        }
      }
    );

    socket.on(
      "queue:play-from-here",
      async (payload: QueuePlayFromHereRequest, ack?: AckFn) => {
        if (
          !payload?.zone_id ||
          typeof payload.queue_item_id !== "number" ||
          !Number.isFinite(payload.queue_item_id)
        ) {
          sendError(
            socket,
            "queue:error",
            "queue:play-from-here",
            "zone_id and finite numeric queue_item_id required",
            ack
          );
          return;
        }
        await handleAsync(socket, "queue:error", "queue:play-from-here", ack, () =>
          transportService.playFromHere(payload.zone_id, payload.queue_item_id)
        );
      }
    );

    socket.on("disconnect", (reason) => {
      logger.info({ clientId: socket.id, reason }, "WebSocket client disconnected");
    });
  });

  return { io };
};
