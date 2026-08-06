/**
 * What the tray controls, and what its menu says. Pure — no Electron, no
 * socket, no clock — so both halves are unit-testable.
 *
 * Two pieces:
 *
 *   `TrayZoneTracker`   keeps the zone/track state the engine pushes, and
 *                       answers the one question the tray has: *which* zone
 *                       do these five menu items act on.
 *   `deriveTrayMenuState`  turns that answer plus window visibility into the
 *                       labels and enabled flags the menu renders.
 *
 * ## Zone heuristic
 *
 * A Roon setup has many zones and the tray has one Play/Pause button, so it
 * must pick one. Deliberately simple, in this order:
 *
 *   1. A zone that is playing right now. If several are, the one that started
 *      playing most recently — tracked by a counter bumped only on the
 *      *transition* into `playing`, so seek ticks and volume changes from the
 *      other playing zones cannot steal the selection out from under you.
 *   2. Otherwise the zone that most recently played during this connection,
 *      even though it is now paused or stopped. Without this the tray would
 *      disable its own Pause button the instant you pressed it, and there
 *      would be no way to resume.
 *   3. Otherwise nothing: transport items are disabled and the tooltip reads
 *      "Nothing playing".
 *
 * Nothing here persists. A reconnect starts from the snapshot the engine
 * sends on connect, and zones already playing at that moment are ordered by
 * their position in that snapshot — arbitrary, but deterministic.
 */

export type TrayPlaybackState = 'playing' | 'paused' | 'stopped' | 'loading';

/** The fields of a Roon zone the tray actually uses. */
export interface TrayZone {
  readonly zoneId: string;
  readonly displayName: string;
  readonly state: TrayPlaybackState;
  readonly isPlayAllowed: boolean;
  readonly isPauseAllowed: boolean;
  readonly isNextAllowed: boolean;
  readonly isPreviousAllowed: boolean;
}

/** The fields of a now-playing record the tooltip uses. */
export interface TrayTrack {
  readonly title?: string;
  readonly artist?: string;
}

/** The selected zone and whatever is loaded in it. */
export interface TrayTarget {
  readonly zone: TrayZone;
  readonly track: TrayTrack | null;
}

export const NOTHING_PLAYING = 'Nothing playing';

export class TrayZoneTracker {
  readonly #zones = new Map<string, TrayZone>();
  readonly #tracks = new Map<string, TrayTrack>();
  /** Zone id → the tick at which it was last observed to *start* playing. */
  readonly #startedPlayingAt = new Map<string, number>();
  #tick = 0;

  /** Replace the whole zone set — the engine's `zones` snapshot. */
  replaceZones(zones: readonly TrayZone[]): void {
    const incoming = new Set(zones.map((zone) => zone.zoneId));
    for (const zoneId of [...this.#zones.keys()]) {
      if (!incoming.has(zoneId)) {
        this.removeZone(zoneId);
      }
    }
    for (const zone of zones) {
      this.upsertZone(zone);
    }
  }

  /** Add or update one zone. */
  upsertZone(zone: TrayZone): void {
    const previous = this.#zones.get(zone.zoneId);
    this.#zones.set(zone.zoneId, zone);
    if (zone.state === 'playing' && previous?.state !== 'playing') {
      this.#tick += 1;
      this.#startedPlayingAt.set(zone.zoneId, this.#tick);
    }
  }

  removeZone(zoneId: string): void {
    this.#zones.delete(zoneId);
    this.#tracks.delete(zoneId);
    this.#startedPlayingAt.delete(zoneId);
  }

  /** Record (or clear) the track loaded in a zone. */
  setTrack(zoneId: string, track: TrayTrack | null): void {
    if (track === null) {
      this.#tracks.delete(zoneId);
      return;
    }
    this.#tracks.set(zoneId, track);
  }

  /** Forget everything — used when the engine connection drops. */
  clear(): void {
    this.#zones.clear();
    this.#tracks.clear();
    this.#startedPlayingAt.clear();
    this.#tick = 0;
  }

  /** The zone the tray's transport items act on, or null. */
  get targetZoneId(): string | null {
    return this.target?.zone.zoneId ?? null;
  }

  /** The selected zone and its track, per the heuristic documented above. */
  get target(): TrayTarget | null {
    const zone =
      this.#mostRecentlyStartedPlaying((candidate) => candidate.state === 'playing') ??
      this.#mostRecentlyStartedPlaying(() => true);
    if (zone === undefined) {
      return null;
    }
    return { zone, track: this.#tracks.get(zone.zoneId) ?? null };
  }

  #mostRecentlyStartedPlaying(
    accept: (zone: TrayZone) => boolean,
  ): TrayZone | undefined {
    let best: TrayZone | undefined;
    let bestTick = -1;
    for (const zone of this.#zones.values()) {
      const startedAt = this.#startedPlayingAt.get(zone.zoneId);
      // A zone that has never played this session is not a candidate: the tray
      // must not hijack an idle bedroom speaker just because it exists.
      if (startedAt === undefined || !accept(zone)) {
        continue;
      }
      if (startedAt > bestTick) {
        best = zone;
        bestTick = startedAt;
      }
    }
    return best;
  }
}

export interface TrayMenuItemState {
  readonly label: string;
  readonly enabled: boolean;
}

export interface TrayMenuState {
  /** Hover text on the tray icon. */
  readonly tooltip: string;
  /** The zone the transport items act on, for the caller to send commands to. */
  readonly targetZoneId: string | null;
  readonly windowItem: TrayMenuItemState;
  readonly playPause: TrayMenuItemState;
  readonly next: TrayMenuItemState;
  readonly previous: TrayMenuItemState;
}

export interface TrayMenuInput {
  readonly target: TrayTarget | null;
  /** Whether the main window is on screen right now. */
  readonly windowVisible: boolean;
}

/** "Artist — Title", degrading to whichever half exists. */
function describeTrack(track: TrayTrack | null): string {
  const artist = track?.artist;
  const title = track?.title;
  if (artist !== undefined && title !== undefined) {
    return `${artist} — ${title}`;
  }
  return title ?? artist ?? NOTHING_PLAYING;
}

/** Derive every label and enabled flag the tray menu needs. */
export function deriveTrayMenuState(input: TrayMenuInput): TrayMenuState {
  const { target } = input;
  const zone = target?.zone ?? null;
  const playing = zone?.state === 'playing';

  return {
    tooltip: target === null ? NOTHING_PLAYING : describeTrack(target.track),
    targetZoneId: zone?.zoneId ?? null,
    windowItem: {
      label: input.windowVisible ? 'Hide Window' : 'Show Window',
      enabled: true,
    },
    playPause: {
      // One item, because that is what Roon's own transport call is: a toggle.
      label: playing ? 'Pause' : 'Play',
      enabled:
        zone === null ? false : playing ? zone.isPauseAllowed : zone.isPlayAllowed,
    },
    next: { label: 'Next', enabled: zone?.isNextAllowed ?? false },
    previous: { label: 'Previous', enabled: zone?.isPreviousAllowed ?? false },
  };
}
