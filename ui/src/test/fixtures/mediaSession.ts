import { vi, type Mock } from 'vitest';
import type {
	MediaMetadataLike,
	MediaPositionStateLike,
	MediaSessionActionDispatch,
	MediaSessionLike,
	MediaSessionTransport
} from '$lib/media/mediaSessionController';
import type { MediaSessionKeepalive } from '$lib/media/silentAudioKeepalive';

/**
 * Stub for `navigator.mediaSession`. jsdom implements no media session at all,
 * so every media-session test drives this instead: it records handler
 * registration in call order and lets a test fire an action the way the OS
 * would.
 */
export interface FakeMediaSession extends MediaSessionLike {
	readonly handlers: Map<string, MediaSessionActionDispatch | null>;
	readonly handlerCalls: Array<{ action: string; handler: MediaSessionActionDispatch | null }>;
	readonly positionStates: Array<MediaPositionStateLike | undefined>;
	/** Actions with a live handler, in registration order. */
	registeredActions(): string[];
	/** Invoke a registered handler the way the platform would. */
	invoke(action: string, details?: { seekTime?: number | null }): void;
	setPositionState(state?: MediaPositionStateLike): void;
}

export function createFakeMediaSession(): FakeMediaSession {
	const handlers = new Map<string, MediaSessionActionDispatch | null>();
	const handlerCalls: Array<{ action: string; handler: MediaSessionActionDispatch | null }> = [];
	const positionStates: Array<MediaPositionStateLike | undefined> = [];

	return {
		metadata: null,
		playbackState: 'none',
		handlers,
		handlerCalls,
		positionStates,
		setActionHandler(action: string, handler: MediaSessionActionDispatch | null) {
			handlerCalls.push({ action, handler });
			if (handler) handlers.set(action, handler);
			else handlers.delete(action);
		},
		setPositionState(state?: MediaPositionStateLike) {
			positionStates.push(state);
		},
		registeredActions() {
			return [...handlers.keys()];
		},
		invoke(action: string, details?: { seekTime?: number | null }) {
			const handler = handlers.get(action);
			if (!handler) throw new Error(`no handler registered for "${action}"`);
			handler(details);
		}
	};
}

/** Plain-object stand-in for the platform `MediaMetadata` constructor. */
export function createFakeMetadata(snapshot: {
	title: string;
	artist: string;
	album: string;
	artwork: readonly { src: string; sizes: string }[];
}): MediaMetadataLike {
	return {
		title: snapshot.title,
		artist: snapshot.artist,
		album: snapshot.album,
		artwork: snapshot.artwork.map((image) => ({ src: image.src, sizes: image.sizes }))
	};
}

export interface FakeMediaTransport extends MediaSessionTransport {
	playPause: Mock<(zoneId: string) => void>;
	next: Mock<(zoneId: string) => void>;
	previous: Mock<(zoneId: string) => void>;
	seek: Mock<(zoneId: string, seconds: number) => void>;
}

export function createFakeMediaTransport(): FakeMediaTransport {
	return {
		playPause: vi.fn<(zoneId: string) => void>(),
		next: vi.fn<(zoneId: string) => void>(),
		previous: vi.fn<(zoneId: string) => void>(),
		seek: vi.fn<(zoneId: string, seconds: number) => void>()
	};
}

export interface FakeKeepalive extends MediaSessionKeepalive {
	start: Mock<() => void>;
	stop: Mock<() => void>;
	destroy: Mock<() => void>;
}

export function createFakeKeepalive(): FakeKeepalive {
	return {
		start: vi.fn<() => void>(),
		stop: vi.fn<() => void>(),
		destroy: vi.fn<() => void>()
	};
}
