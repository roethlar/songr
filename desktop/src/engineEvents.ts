/**
 * The slice of the engine's Socket.IO surface the tray uses, and the parsers
 * that turn its payloads into the tray's own model.
 *
 * The desktop workspace compiles on its own and must not pull backend sources
 * into its build, so — exactly like the handshake message mirrored in
 * `engineProcess.ts` — the wire shapes are re-declared here rather than
 * imported from `src/shared/types.ts`. The canonical definitions are:
 *
 *   - `Zone`, `NowPlaying`, `PlaybackState`  — `src/shared/types.ts`
 *   - the event and command names below      — `src/server/socket/index.ts`
 *     and the `transportService.on(...)` wiring in `src/server/server.ts`
 *
 * They are a wire contract: a change there is a change here. Everything in this
 * file is pure, defensive and unit-tested — an unexpected payload yields `null`
 * and is dropped, never a crash in the main process.
 */

import type { TrayPlaybackState, TrayTrack, TrayZone } from './trayModel';

/** Server → client. Full zone snapshot, sent on connect and on unpair. */
export const ZONES_EVENT = 'zones';
/** Server → client. One zone appeared or changed. */
export const ZONE_UPDATED_EVENT = 'zone-updated';
/** Server → client. One zone went away. */
export const ZONE_REMOVED_EVENT = 'zone-removed';
/** Server → client. Track metadata for one zone (`now_playing` may be null). */
export const NOW_PLAYING_EVENT = 'now-playing-updated';

/** Client → server transport commands. Each takes `{ zone_id }`. */
export const PLAY_PAUSE_COMMAND = 'transport:play-pause';
export const NEXT_COMMAND = 'transport:next';
export const PREVIOUS_COMMAND = 'transport:previous';

const PLAYBACK_STATES: readonly TrayPlaybackState[] = [
  'playing',
  'paused',
  'stopped',
  'loading',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

function asPlaybackState(value: unknown): TrayPlaybackState {
  const found = PLAYBACK_STATES.find((state) => state === value);
  // Roon can report a state this build has never heard of. "Stopped" is the
  // safe reading: it never makes the tray claim something is playing.
  return found ?? 'stopped';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse one `Zone` from the wire. Returns null when it is not usable. */
export function parseZone(value: unknown): TrayZone | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const zoneId = asNonEmptyString(record.zone_id);
  if (zoneId === undefined) {
    return null;
  }
  return {
    zoneId,
    displayName: asNonEmptyString(record.display_name) ?? zoneId,
    state: asPlaybackState(record.state),
    // Roon omits the permission flags on a zone it considers unusable, and a
    // menu item that is wrongly greyed out is a better failure than one that
    // sends a command the Core will reject.
    isPlayAllowed: asBool(record.is_play_allowed, false),
    isPauseAllowed: asBool(record.is_pause_allowed, false),
    isNextAllowed: asBool(record.is_next_allowed, false),
    isPreviousAllowed: asBool(record.is_previous_allowed, false),
  };
}

/** Parse the `zones` snapshot payload: `{ zones: Zone[] }`. */
export function parseZonesEvent(payload: unknown): TrayZone[] | null {
  const record = asRecord(payload);
  if (record === null || !Array.isArray(record.zones)) {
    return null;
  }
  const zones: TrayZone[] = [];
  for (const entry of record.zones) {
    const zone = parseZone(entry);
    if (zone !== null) {
      zones.push(zone);
    }
  }
  return zones;
}

/** Parse the `zone-updated` payload: `{ zone: Zone }`. */
export function parseZoneUpdatedEvent(payload: unknown): TrayZone | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }
  return parseZone(record.zone);
}

/** Parse the `zone-removed` payload: `{ zone_id: string }`. */
export function parseZoneRemovedEvent(payload: unknown): string | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }
  return asNonEmptyString(record.zone_id) ?? null;
}

export interface NowPlayingUpdate {
  readonly zoneId: string;
  /** Null when the zone stopped or went away — the track must be cleared. */
  readonly track: TrayTrack | null;
}

/**
 * Parse `now-playing-updated`: `{ zone_id, now_playing: NowPlaying | null }`.
 * A null `now_playing` is meaningful (the server sends it when a zone is
 * removed), so it is preserved rather than treated as a parse failure.
 */
export function parseNowPlayingEvent(payload: unknown): NowPlayingUpdate | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }
  const zoneId = asNonEmptyString(record.zone_id);
  if (zoneId === undefined) {
    return null;
  }
  const nowPlaying = asRecord(record.now_playing);
  if (nowPlaying === null) {
    return { zoneId, track: null };
  }
  const title = asNonEmptyString(nowPlaying.title);
  const artist = asNonEmptyString(nowPlaying.artist);
  if (title === undefined && artist === undefined) {
    return { zoneId, track: null };
  }
  return { zoneId, track: { title, artist } };
}
