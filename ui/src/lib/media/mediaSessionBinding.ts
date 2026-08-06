/**
 * Wires the Media Session controller to the app's live stores and to the
 * exact socket commands the on-screen transport buttons already use.
 *
 * The layout starts one binding for the whole app and tears it down on
 * unmount; nothing else should create a second one, because
 * `navigator.mediaSession` is a single per-document object.
 */
import { derived } from 'svelte/store';
import type { SeekRequest, TransportControlRequest } from '@shared/types';
import { getSocket } from '$lib/socket/client';
import { emitWithAck } from '$lib/socket/emit';
import { pushCommandFeedback } from '$lib/stores/commandFeedbackStore';
import { nowPlayingStore } from '$lib/stores/nowPlayingStore';
import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
import { zoneMapStore } from '$lib/stores/zonesStore';
import {
	createMediaSessionController,
	type MediaMetadataLike,
	type MediaSessionLike,
	type MediaSessionTransport
} from './mediaSessionController';
import type { MediaSessionMetadataSnapshot } from './mediaSessionState';
import {
	createSilentAudioKeepalive,
	type MediaSessionKeepalive
} from './silentAudioKeepalive';

/** Same 3 s budget the layout's on-screen transport uses. */
const TRANSPORT_TIMEOUT_MS = 3000;

/**
 * Transport implementation for OS-originated commands. It goes down the same
 * path as the on-screen buttons: `getSocket()` + `emitWithAck` with transport
 * feedback, so a failure raises the same toast the user would see from a
 * click.
 *
 * Readiness is checked before anything else happens (`.agents/decisions.md`
 * 2026-05-11): a missing socket returns after a feedback toast and mutates
 * nothing, and `emitWithAck` itself fails fast rather than letting socket.io
 * buffer a stale transport command across a reconnect.
 */
export function createSocketMediaTransport(): MediaSessionTransport {
	const send = (event: string, payload: TransportControlRequest | SeekRequest): void => {
		const socket = getSocket();
		if (!socket) {
			pushCommandFeedback({
				source: 'transport',
				command: 'socket',
				message: 'Realtime connection unavailable.'
			});
			return;
		}
		void emitWithAck(socket, event, payload, {
			timeoutMs: TRANSPORT_TIMEOUT_MS,
			feedback: { source: 'transport', command: event }
		});
	};

	return {
		playPause: (zoneId) => send('transport:play-pause', { zone_id: zoneId }),
		next: (zoneId) => send('transport:next', { zone_id: zoneId }),
		previous: (zoneId) => send('transport:previous', { zone_id: zoneId }),
		seek: (zoneId, seconds) => send('transport:seek', { zone_id: zoneId, seconds })
	};
}

export interface MediaSessionBindingOptions {
	/** Defaults to `navigator.mediaSession`; null disables the binding. */
	mediaSession?: MediaSessionLike | null;
	/** Defaults to the platform `MediaMetadata` constructor. */
	createMetadata?: (snapshot: MediaSessionMetadataSnapshot) => MediaMetadataLike | null;
	transport?: MediaSessionTransport;
	/** Null opts out of the silent-audio activation (see that module). */
	keepalive?: MediaSessionKeepalive | null;
	/** Defaults to `window.location.origin`. */
	origin?: string;
}

function defaultMediaSession(): MediaSessionLike | null {
	if (typeof navigator === 'undefined') return null;
	const session = (navigator as Navigator & { mediaSession?: MediaSessionLike }).mediaSession;
	return session ?? null;
}

function defaultCreateMetadata(
	snapshot: MediaSessionMetadataSnapshot
): MediaMetadataLike | null {
	const ctor = (globalThis as { MediaMetadata?: new (init: unknown) => MediaMetadataLike })
		.MediaMetadata;
	// Chromium rejects a plain object here, so with no constructor the right
	// answer is no metadata rather than a thrown assignment.
	if (typeof ctor !== 'function') return null;
	return new ctor({
		title: snapshot.title,
		artist: snapshot.artist,
		album: snapshot.album,
		artwork: snapshot.artwork.map((image) => ({ src: image.src, sizes: image.sizes }))
	});
}

function defaultOrigin(): string | undefined {
	if (typeof window === 'undefined') return undefined;
	return window.location?.origin || undefined;
}

/**
 * Start mirroring the selected zone's now-playing state into the OS media
 * controls. Returns the teardown: it unsubscribes, clears every handler this
 * binding registered, and releases the keepalive element.
 *
 * A no-op (returning a no-op teardown) when the platform has no media session,
 * which covers SSR and the jsdom test environment.
 */
export function startMediaSessionBinding(options: MediaSessionBindingOptions = {}): () => void {
	const mediaSession =
		options.mediaSession !== undefined ? options.mediaSession : defaultMediaSession();
	if (!mediaSession) return () => {};

	const keepalive =
		options.keepalive !== undefined ? options.keepalive : createSilentAudioKeepalive();

	const controller = createMediaSessionController({
		mediaSession,
		transport: options.transport ?? createSocketMediaTransport(),
		createMetadata: options.createMetadata ?? defaultCreateMetadata,
		keepalive
	});

	const origin = options.origin !== undefined ? options.origin : defaultOrigin();

	const source = derived(
		[selectedZoneStore, zoneMapStore, nowPlayingStore],
		([$selectedZone, $zoneMap, $nowPlaying]) => ({
			zoneId: $selectedZone || null,
			zone: $selectedZone ? $zoneMap.get($selectedZone) : undefined,
			nowPlaying: $selectedZone ? $nowPlaying[$selectedZone] : undefined,
			origin
		})
	);

	const unsubscribe = source.subscribe((input) => controller.update(input));

	return () => {
		unsubscribe();
		controller.destroy();
	};
}
