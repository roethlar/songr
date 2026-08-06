/**
 * Imperative applier that writes a derived snapshot into a media session and
 * routes the OS's actions back to the app's transport layer.
 *
 * Everything platform-shaped is injected — the session object, the
 * `MediaMetadata` constructor, the transport, the silent-audio keepalive — so
 * the whole surface runs under Vitest against stubs. The decisions themselves
 * live in `mediaSessionState.ts`; this file only diffs and dispatches.
 */
import {
	actionsEqual,
	deriveMediaSessionSnapshot,
	EMPTY_MEDIA_SESSION_SNAPSHOT,
	metadataEquals,
	positionEquals,
	shouldSendPlayPauseToggle,
	type MediaSessionActionName,
	type MediaSessionDerivationInput,
	type MediaSessionMetadataSnapshot,
	type MediaSessionSnapshot
} from './mediaSessionState';
import type { MediaSessionKeepalive } from './silentAudioKeepalive';

export interface MediaImageLike {
	readonly src: string;
	readonly sizes?: string;
	readonly type?: string;
}

export interface MediaMetadataLike {
	readonly title: string;
	readonly artist: string;
	readonly album: string;
	readonly artwork: readonly MediaImageLike[];
}

export interface MediaPositionStateLike {
	duration: number;
	position?: number;
	playbackRate?: number;
}

export type MediaSessionActionDispatch = (details?: { seekTime?: number | null }) => void;

/** Structural stand-in for `navigator.mediaSession`. */
export interface MediaSessionLike {
	metadata: MediaMetadataLike | null;
	playbackState: 'none' | 'paused' | 'playing';
	setActionHandler(action: string, handler: MediaSessionActionDispatch | null): void;
	setPositionState?(state?: MediaPositionStateLike): void;
}

/**
 * The transport verbs the OS controls map onto. These are the same four socket
 * commands the on-screen transport buttons send; see
 * `createSocketMediaTransport` in `mediaSessionBinding.ts`.
 */
export interface MediaSessionTransport {
	playPause(zoneId: string): void;
	next(zoneId: string): void;
	previous(zoneId: string): void;
	seek(zoneId: string, seconds: number): void;
}

export interface MediaSessionControllerOptions {
	mediaSession: MediaSessionLike;
	transport: MediaSessionTransport;
	/** Builds a platform `MediaMetadata`. Returning null skips metadata. */
	createMetadata: (snapshot: MediaSessionMetadataSnapshot) => MediaMetadataLike | null;
	keepalive?: MediaSessionKeepalive | null;
	/** Injected clock for the toggle suppression window. Tests override it. */
	now?: () => number;
}

/**
 * How long a dispatched play/pause toggle suppresses an identical OS action.
 * The playback status only changes after a socket round trip, and a bounced
 * or re-pressed media key inside that window would send a second toggle that
 * undoes the first (dt4-2). Matches the transport's 3s ack timeout, so a lost
 * toggle cannot suppress the key for longer than its own failure.
 */
const TOGGLE_SUPPRESSION_MS = 3_000;

export interface MediaSessionController {
	/** Derive from live app state and push whatever changed into the session. */
	update(input: MediaSessionDerivationInput): void;
	/** Push an already-derived snapshot. Used by tests and by `update`. */
	apply(snapshot: MediaSessionSnapshot): void;
	getSnapshot(): MediaSessionSnapshot;
	destroy(): void;
}

const ALL_ACTIONS: readonly MediaSessionActionName[] = [
	'play',
	'pause',
	'previoustrack',
	'nexttrack',
	'seekto'
];

export function createMediaSessionController(
	options: MediaSessionControllerOptions
): MediaSessionController {
	const { mediaSession, transport, createMetadata } = options;
	const keepalive = options.keepalive ?? null;
	const now = options.now ?? (() => Date.now());

	let snapshot: MediaSessionSnapshot = EMPTY_MEDIA_SESSION_SNAPSHOT;
	let registered: MediaSessionActionName[] = [];
	let keepaliveRunning = false;
	let destroyed = false;
	let pendingToggle: { action: 'play' | 'pause'; at: number } | null = null;

	/**
	 * Handlers close over the controller, never over a zone id, so a session
	 * that outlives a zone change still acts on the zone the user is looking
	 * at. `destroyed` is checked first: the OS can invoke a handler after
	 * teardown has begun, and a late command must not be sent.
	 */
	function dispatch(action: MediaSessionActionName, details?: { seekTime?: number | null }): void {
		if (destroyed) return;
		const zoneId = snapshot.zoneId;
		if (!zoneId) return;
		switch (action) {
			case 'play':
			case 'pause':
				if (!shouldSendPlayPauseToggle(action, snapshot.playbackStatus)) return;
				// The status the guard just consulted is stale until the store
				// round-trips; an identical action inside the window is a bounce
				// or a re-press, and a second toggle would undo the first (dt4-2).
				if (
					pendingToggle !== null &&
					pendingToggle.action === action &&
					now() - pendingToggle.at < TOGGLE_SUPPRESSION_MS
				) {
					return;
				}
				pendingToggle = { action, at: now() };
				transport.playPause(zoneId);
				return;
			case 'nexttrack':
				transport.next(zoneId);
				return;
			case 'previoustrack':
				transport.previous(zoneId);
				return;
			case 'seekto': {
				const seekTime = details?.seekTime;
				if (typeof seekTime !== 'number' || !Number.isFinite(seekTime) || seekTime < 0) return;
				transport.seek(zoneId, Math.floor(seekTime));
				return;
			}
		}
	}

	const handlers = new Map<MediaSessionActionName, MediaSessionActionDispatch>(
		ALL_ACTIONS.map((action) => [
			action,
			(details?: { seekTime?: number | null }) => dispatch(action, details)
		])
	);

	function setHandler(action: MediaSessionActionName, handler: MediaSessionActionDispatch | null) {
		try {
			mediaSession.setActionHandler(action, handler);
			return true;
		} catch {
			// An engine that does not know the action throws rather than
			// ignoring it. Not fatal: the rest of the session still works.
			return false;
		}
	}

	function applyActions(next: readonly MediaSessionActionName[]): void {
		for (const action of registered) {
			if (!next.includes(action)) setHandler(action, null);
		}
		const accepted: MediaSessionActionName[] = [];
		for (const action of next) {
			if (registered.includes(action)) {
				accepted.push(action);
				continue;
			}
			if (setHandler(action, handlers.get(action) ?? null)) accepted.push(action);
		}
		registered = accepted;
	}

	function applyPosition(next: MediaSessionSnapshot): void {
		if (typeof mediaSession.setPositionState !== 'function') return;
		try {
			if (next.position) {
				mediaSession.setPositionState({
					duration: next.position.duration,
					position: next.position.position,
					playbackRate: next.position.playbackRate
				});
			} else {
				mediaSession.setPositionState();
			}
		} catch {
			// Chromium rejects inconsistent position states outright. The
			// snapshot clamps for that, but a racing update must never take
			// the rest of the session down with it.
		}
	}

	function apply(next: MediaSessionSnapshot): void {
		if (destroyed) return;
		const previous = snapshot;
		// Published before any handler can fire, so a synchronous OS callback
		// during registration sees the state it was registered for.
		snapshot = next;

		if (!metadataEquals(previous.metadata, next.metadata)) {
			mediaSession.metadata = next.metadata ? createMetadata(next.metadata) : null;
		}
		if (previous.playbackStatus !== next.playbackStatus) {
			mediaSession.playbackState = next.playbackStatus;
			// The store caught up with the toggle (or the zone changed state on
			// its own); the suppression window has done its job.
			pendingToggle = null;
		}
		if (previous.zoneId !== next.zoneId) {
			// A toggle sent to one zone must not swallow the next press aimed
			// at another (dt5-1); suppression is scoped to the zone it served.
			pendingToggle = null;
		}
		if (!positionEquals(previous.position, next.position)) {
			applyPosition(next);
		}
		if (!actionsEqual(previous.actions, next.actions)) {
			applyActions(next.actions);
		}

		if (keepalive) {
			if (next.keepAudioSessionAlive && !keepaliveRunning) {
				keepaliveRunning = true;
				keepalive.start();
			} else if (!next.keepAudioSessionAlive && keepaliveRunning) {
				keepaliveRunning = false;
				keepalive.stop();
			}
		}
	}

	return {
		update(input: MediaSessionDerivationInput): void {
			apply(deriveMediaSessionSnapshot(input));
		},
		apply,
		getSnapshot: () => snapshot,
		destroy(): void {
			if (destroyed) return;
			destroyed = true;
			for (const action of registered) {
				setHandler(action, null);
			}
			registered = [];
			mediaSession.metadata = null;
			mediaSession.playbackState = 'none';
			if (typeof mediaSession.setPositionState === 'function') {
				try {
					mediaSession.setPositionState();
				} catch {
					/* nothing left to protect at teardown */
				}
			}
			snapshot = EMPTY_MEDIA_SESSION_SNAPSHOT;
			keepaliveRunning = false;
			keepalive?.destroy();
		}
	};
}
