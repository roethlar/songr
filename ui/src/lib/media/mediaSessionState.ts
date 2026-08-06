/**
 * Pure derivation core for the browser Media Session integration.
 *
 * Nothing in this module touches `navigator`, the DOM, or a socket: it maps
 * the UI's existing zone + now-playing state onto the snapshot the imperative
 * applier (`mediaSessionController.ts`) writes into `navigator.mediaSession`.
 * Keeping the mapping pure is what makes the OS-facing behaviour testable
 * under Vitest with a stubbed media session.
 */
import type { NowPlaying, PlaybackState, Zone } from '@shared/types';
import { imageUrl } from '$lib/imageUrl';

/** The subset of `MediaSessionAction` this controller can service. */
export type MediaSessionActionName =
	| 'play'
	| 'pause'
	| 'nexttrack'
	| 'previoustrack'
	| 'seekto';

/** Mirrors `MediaSessionPlaybackState` without depending on lib.dom at runtime. */
export type MediaPlaybackStatus = 'none' | 'paused' | 'playing';

export interface MediaArtworkImage {
	readonly src: string;
	readonly sizes: string;
}

export interface MediaSessionMetadataSnapshot {
	readonly title: string;
	readonly artist: string;
	readonly album: string;
	readonly artwork: readonly MediaArtworkImage[];
}

export interface MediaPositionSnapshot {
	readonly duration: number;
	readonly position: number;
	readonly playbackRate: number;
}

export interface MediaSessionSnapshot {
	/** Zone the OS controls act on. Null when no session should exist. */
	readonly zoneId: string | null;
	readonly metadata: MediaSessionMetadataSnapshot | null;
	readonly playbackStatus: MediaPlaybackStatus;
	readonly position: MediaPositionSnapshot | null;
	readonly actions: readonly MediaSessionActionName[];
	/**
	 * Whether the silent-audio keepalive must run. See
	 * `silentAudioKeepalive.ts` for why a controller that plays no audio of
	 * its own still needs an audible media element.
	 */
	readonly keepAudioSessionAlive: boolean;
}

export interface MediaSessionDerivationInput {
	readonly zoneId: string | null | undefined;
	readonly zone: Zone | undefined;
	readonly nowPlaying: NowPlaying | undefined;
	/** Absolute page origin, so artwork URLs do not depend on the document base. */
	readonly origin?: string;
}

/**
 * Artwork widths handed to the OS. Roon's image endpoint scales server-side,
 * so offering several sizes costs one extra URL each and lets the platform
 * pick (a Linux MPRIS panel wants something small, macOS Now Playing large).
 *
 * `type` is deliberately omitted from each entry: Roon returns whatever the
 * source image is, and asserting a MIME type we have not checked would be a
 * lie the platform may act on. `type` is optional in `MediaImage`.
 */
const ARTWORK_SIZES = [96, 256, 512] as const;

/**
 * The playback rate reported while paused. Not 0 — real Chromium throws a
 * TypeError on a zero rate — but small enough that position extrapolation is
 * frozen for any human-scale pause (see the position snapshot in
 * `deriveMediaSessionSnapshot`).
 */
export const PAUSED_PLAYBACK_RATE = 1e-6;

export const EMPTY_MEDIA_SESSION_SNAPSHOT: MediaSessionSnapshot = {
	zoneId: null,
	metadata: null,
	playbackStatus: 'none',
	position: null,
	actions: [],
	keepAudioSessionAlive: false
};

/**
 * Roon's four playback states collapse onto the three the Media Session API
 * knows.
 *
 * `loading` maps to `playing` on purpose. It is the transient state Roon
 * reports while a track spins up after a play command, and the OS asking us
 * to "play" something that is already starting must be a no-op — see
 * `shouldSendPlayPauseToggle`. Reporting `paused` there would let a media-key
 * press pause a track the user just started.
 */
export function mapPlaybackStatus(state: PlaybackState | undefined): MediaPlaybackStatus {
	switch (state) {
		case 'playing':
		case 'loading':
			return 'playing';
		case 'paused':
			return 'paused';
		default:
			return 'none';
	}
}

function absoluteUrl(path: string, origin: string | undefined): string {
	if (!origin || !path.startsWith('/')) return path;
	return `${origin}${path}`;
}

function finiteNonNegative(value: number | undefined): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function deriveMediaSessionSnapshot(
	input: MediaSessionDerivationInput
): MediaSessionSnapshot {
	const zoneId = input.zoneId ? input.zoneId : null;
	if (!zoneId) return EMPTY_MEDIA_SESSION_SNAPSHOT;

	const nowPlaying = input.nowPlaying;
	// The zone record is the same source the on-screen transport reads for
	// its play/pause glyph; fall back to the now-playing payload's own state
	// when the zone list has not caught up yet.
	const playbackStatus = mapPlaybackStatus(input.zone?.state ?? nowPlaying?.state);
	if (!nowPlaying || playbackStatus === 'none') {
		// Stopped, or nothing loaded: no OS session at all. Leaving stale
		// metadata behind would keep a dead track in the system panel.
		return { ...EMPTY_MEDIA_SESSION_SNAPSHOT, zoneId };
	}

	const duration = finiteNonNegative(nowPlaying.duration);
	const rawPosition = input.zone?.seek_position ?? nowPlaying.seek_position ?? 0;
	const position: MediaPositionSnapshot | null = duration
		? {
			duration,
			// Chromium throws on a position past the duration, and the 1 Hz
			// seek ticks can land a hair beyond the end of a track.
			position: Math.min(Math.max(finiteNonNegative(rawPosition), 0), duration),
			// Seek ticks stop flowing on pause, so a rate-1 position state
			// left behind would let the OS extrapolate elapsed time through
			// the whole pause (dt4-1). Chromium rejects exactly 0 ("The
			// provided playbackRate cannot be equal to zero" — proven in the
			// pinned-Chromium spec), so paused sessions report an epsilon
			// rate: accepted by the API, and a full hour of pause moves the
			// extrapolated position by mere microseconds.
			playbackRate: playbackStatus === 'playing' ? 1 : PAUSED_PLAYBACK_RATE
		}
		: null;

	const artwork = nowPlaying.image_key
		? ARTWORK_SIZES.map((size) => ({
			src: absoluteUrl(
				imageUrl(nowPlaying.image_key, { width: size, height: size }),
				input.origin
			),
			sizes: `${size}x${size}`
		}))
		: [];

	const metadata: MediaSessionMetadataSnapshot = {
		title: nowPlaying.title ?? '',
		artist: nowPlaying.artist ?? nowPlaying.album_artist ?? '',
		album: nowPlaying.album ?? '',
		artwork
	};

	// Roon reports which transport verbs the zone accepts right now, and the
	// flags are close to mutually exclusive (a playing zone allows pause, not
	// play). Registering only the allowed ones gives the OS panel the same
	// single correct button the on-screen transport shows. With no zone
	// record we have no capability information, so offer the four verbs every
	// Roon zone supports and withhold seek.
	const zone = input.zone;
	const actions: MediaSessionActionName[] = [];
	if (zone ? zone.is_play_allowed : true) actions.push('play');
	if (zone ? zone.is_pause_allowed : true) actions.push('pause');
	if (zone ? zone.is_previous_allowed : true) actions.push('previoustrack');
	if (zone ? zone.is_next_allowed : true) actions.push('nexttrack');
	if (zone?.is_seek_allowed && position) actions.push('seekto');

	return {
		zoneId,
		metadata,
		playbackStatus,
		position,
		actions,
		// Kept alive while a track is loaded, playing *or* paused. Stopping it
		// on pause would tear down the OS media session, and the media key that
		// would resume playback would then have nowhere to land.
		keepAudioSessionAlive: true
	};
}

/**
 * The backend exposes one `transport:play-pause` toggle, not separate play and
 * pause commands, but the OS sends distinct `play` and `pause` actions. Ask
 * the current playback status whether the toggle would move us the way the OS
 * asked; if we are already in the requested state, sending it would do the
 * opposite of what the user pressed.
 */
export function shouldSendPlayPauseToggle(
	action: 'play' | 'pause',
	status: MediaPlaybackStatus
): boolean {
	return action === 'play' ? status !== 'playing' : status === 'playing';
}

export function metadataEquals(
	a: MediaSessionMetadataSnapshot | null,
	b: MediaSessionMetadataSnapshot | null
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.title !== b.title || a.artist !== b.artist || a.album !== b.album) return false;
	if (a.artwork.length !== b.artwork.length) return false;
	return a.artwork.every(
		(image, index) =>
			image.src === b.artwork[index].src && image.sizes === b.artwork[index].sizes
	);
}

export function positionEquals(
	a: MediaPositionSnapshot | null,
	b: MediaPositionSnapshot | null
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.duration === b.duration &&
		a.position === b.position &&
		a.playbackRate === b.playbackRate
	);
}

export function actionsEqual(
	a: readonly MediaSessionActionName[],
	b: readonly MediaSessionActionName[]
): boolean {
	return a.length === b.length && a.every((action, index) => action === b[index]);
}
