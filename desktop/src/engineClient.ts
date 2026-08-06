/**
 * The tray's read-mostly connection to the engine.
 *
 * It is an ordinary Socket.IO client pointed at the same loopback origin the
 * window loads, using the surface the browser UI already uses: it listens to
 * the zone and now-playing broadcasts and sends the three transport commands.
 * No new backend endpoint exists for the tray, and none is needed.
 *
 * All parsing lives in `engineEvents.ts` and all state in `trayModel.ts`; this
 * file is the socket glue between them. The socket factory is injected so the
 * routing can be tested without a server.
 */

import { io } from 'socket.io-client';

import {
  NEXT_COMMAND,
  NOW_PLAYING_EVENT,
  PLAY_PAUSE_COMMAND,
  PREVIOUS_COMMAND,
  ZONES_EVENT,
  ZONE_REMOVED_EVENT,
  ZONE_UPDATED_EVENT,
  parseNowPlayingEvent,
  parseZoneRemovedEvent,
  parseZoneUpdatedEvent,
  parseZonesEvent,
} from './engineEvents';
import type { TrayZoneTracker } from './trayModel';

/** The part of a Socket.IO client this module uses. */
export interface TraySocket {
  on(event: string, listener: (payload: unknown) => void): unknown;
  emit(event: string, payload: unknown): unknown;
  disconnect(): unknown;
}

export type TraySocketFactory = (url: string) => TraySocket;

const defaultSocketFactory: TraySocketFactory = (url) =>
  io(url, {
    // The engine is on loopback and speaks WebSocket; skipping the HTTP
    // long-polling upgrade dance keeps this to one connection.
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelayMax: 5_000,
    // The shell may reconnect to a *different* engine process after a
    // relaunch, so never reuse a cached manager.
    forceNew: true,
  });

export interface EngineTrayClientOptions {
  readonly tracker: TrayZoneTracker;
  /** Called after anything the tray renders may have changed. */
  readonly onChange: () => void;
  readonly createSocket?: TraySocketFactory;
  readonly log?: (line: string) => void;
}

export class EngineTrayClient {
  readonly #tracker: TrayZoneTracker;
  readonly #onChange: () => void;
  readonly #createSocket: TraySocketFactory;
  readonly #log: (line: string) => void;
  #socket: TraySocket | null = null;

  constructor(options: EngineTrayClientOptions) {
    this.#tracker = options.tracker;
    this.#onChange = options.onChange;
    this.#createSocket = options.createSocket ?? defaultSocketFactory;
    this.#log = options.log ?? (() => undefined);
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  /**
   * Point the client at an engine. Reconnecting to a new port drops the old
   * socket first, so a relaunched engine never leaves a second one running.
   */
  connect(url: string): void {
    this.disconnect();
    const socket = this.#createSocket(url);
    this.#socket = socket;

    socket.on('connect', () => {
      this.#log(`tray connected to engine at ${url}`);
    });

    socket.on('disconnect', () => {
      // Whatever we knew about the zones is now unverifiable. Drop it rather
      // than leave the tray offering transport for a zone list that may have
      // changed while we were away; the reconnect resends the full snapshot.
      this.#tracker.clear();
      this.#onChange();
    });

    socket.on(ZONES_EVENT, (payload) => {
      const zones = parseZonesEvent(payload);
      if (zones === null) {
        return;
      }
      this.#tracker.replaceZones(zones);
      this.#onChange();
    });

    socket.on(ZONE_UPDATED_EVENT, (payload) => {
      const zone = parseZoneUpdatedEvent(payload);
      if (zone === null) {
        return;
      }
      this.#tracker.upsertZone(zone);
      this.#onChange();
    });

    socket.on(ZONE_REMOVED_EVENT, (payload) => {
      const zoneId = parseZoneRemovedEvent(payload);
      if (zoneId === null) {
        return;
      }
      this.#tracker.removeZone(zoneId);
      this.#onChange();
    });

    socket.on(NOW_PLAYING_EVENT, (payload) => {
      const update = parseNowPlayingEvent(payload);
      if (update === null) {
        return;
      }
      this.#tracker.setTrack(update.zoneId, update.track);
      this.#onChange();
    });
  }

  disconnect(): void {
    const socket = this.#socket;
    this.#socket = null;
    if (socket === null) {
      return;
    }
    socket.disconnect();
    this.#tracker.clear();
    this.#onChange();
  }

  playPause(): void {
    this.#send(PLAY_PAUSE_COMMAND);
  }

  next(): void {
    this.#send(NEXT_COMMAND);
  }

  previous(): void {
    this.#send(PREVIOUS_COMMAND);
  }

  #send(command: string): void {
    const zoneId = this.#tracker.targetZoneId;
    if (this.#socket === null || zoneId === null) {
      // The menu items are disabled in this state; a stale click is a no-op
      // rather than a command with no zone, which the server would reject.
      return;
    }
    this.#log(`tray ${command} -> ${zoneId}`);
    this.#socket.emit(command, { zone_id: zoneId });
  }
}
