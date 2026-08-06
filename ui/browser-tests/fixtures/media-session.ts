/**
 * Media Session fixture — the half of the integration jsdom cannot judge.
 *
 * The unit suites prove the derivation and the dispatch logic against a stubbed
 * session. What they cannot prove is that a real engine accepts what we hand
 * it: that Chromium decodes the generated silent clip and reports it as media
 * of a usable length, that `MediaMetadata` accepts our artwork array, that
 * `setPositionState` accepts our numbers (it throws on inconsistent ones), and
 * that every action we register is one this engine knows.
 *
 * It also drives the keepalive through a real user gesture, which is the only
 * way autoplay lets playback start in a normal tab.
 *
 * Every name on this page is invented. No library content may appear here.
 */
import type { NowPlaying, Zone } from '../../../src/shared/types';
import {
	createMediaSessionController,
	type MediaMetadataLike,
	type MediaSessionLike
} from '../../src/lib/media/mediaSessionController';
import type { MediaSessionMetadataSnapshot } from '../../src/lib/media/mediaSessionState';
import {
	createSilentAudioElement,
	createSilentAudioKeepalive
} from '../../src/lib/media/silentAudioKeepalive';

const ZONE_ID = 'fixture-zone';

function zone(overrides: Partial<Zone> = {}): Zone {
	return {
		zone_id: ZONE_ID,
		display_name: 'Fixture Zone',
		state: 'playing',
		is_play_allowed: true,
		is_pause_allowed: true,
		is_previous_allowed: true,
		is_next_allowed: true,
		is_seek_allowed: true,
		seek_position: 12,
		...overrides
	};
}

function nowPlaying(overrides: Partial<NowPlaying> = {}): NowPlaying {
	return {
		zone_id: ZONE_ID,
		title: 'Placeholder Track One',
		artist: 'Fixture Ensemble',
		album: 'Synthetic Sessions',
		image_key: 'fixture-image-key',
		duration: 240,
		seek_position: 12,
		state: 'playing',
		...overrides
	};
}

const commands: string[] = [];
const commandsOutput = document.querySelector('[data-testid="media-session-commands"]');
function record(command: string): void {
	commands.push(command);
	if (commandsOutput) commandsOutput.textContent = commands.join(',');
}

let audioElement: HTMLAudioElement | null = null;
const keepalive = createSilentAudioKeepalive({
	createAudio: () => {
		audioElement = createSilentAudioElement();
		// Hostile defaults on purpose: whatever the spec then observes is the
		// keepalive's own policy, not an HTMLAudioElement default.
		audioElement.muted = true;
		audioElement.volume = 0;
		return audioElement;
	}
});

const engineErrors: string[] = [];
const session = navigator.mediaSession as unknown as MediaSessionLike;
const guardedSession: MediaSessionLike = {
	get metadata() {
		return session.metadata;
	},
	set metadata(value: MediaMetadataLike | null) {
		session.metadata = value;
	},
	get playbackState() {
		return session.playbackState;
	},
	set playbackState(value: 'none' | 'paused' | 'playing') {
		session.playbackState = value;
	},
	setActionHandler(action, handler) {
		try {
			session.setActionHandler(action, handler);
		} catch (error) {
			engineErrors.push(`setActionHandler(${action}): ${String(error)}`);
			throw error;
		}
	},
	setPositionState(state) {
		try {
			session.setPositionState?.(state);
		} catch (error) {
			// The controller swallows this to protect the rest of the session,
			// so record it here or the fixture would report a false all-clear.
			engineErrors.push(`setPositionState: ${String(error)}`);
			throw error;
		}
	}
};

const controller = createMediaSessionController({
	mediaSession: guardedSession,
	transport: {
		playPause: (zoneId) => record(`play-pause:${zoneId}`),
		next: (zoneId) => record(`next:${zoneId}`),
		previous: (zoneId) => record(`previous:${zoneId}`),
		seek: (zoneId, seconds) => record(`seek:${zoneId}:${seconds}`)
	},
	createMetadata: (snapshot: MediaSessionMetadataSnapshot) =>
		new MediaMetadata({
			title: snapshot.title,
			artist: snapshot.artist,
			album: snapshot.album,
			artwork: snapshot.artwork.map((image) => ({ src: image.src, sizes: image.sizes }))
		}) as unknown as MediaMetadataLike,
	keepalive
});

document.querySelector('[data-testid="media-session-play"]')?.addEventListener('click', () => {
	controller.update({ zoneId: ZONE_ID, zone: zone(), nowPlaying: nowPlaying() });
});
document.querySelector('[data-testid="media-session-pause"]')?.addEventListener('click', () => {
	controller.update({
		zoneId: ZONE_ID,
		zone: zone({ state: 'paused' }),
		nowPlaying: nowPlaying({ state: 'paused' })
	});
});
document.querySelector('[data-testid="media-session-stop"]')?.addEventListener('click', () => {
	controller.update({ zoneId: ZONE_ID, zone: zone({ state: 'stopped' }), nowPlaying: undefined });
});
document.querySelector('[data-testid="media-session-teardown"]')?.addEventListener('click', () => {
	controller.destroy();
});

declare global {
	interface Window {
		mediaSessionFixture: {
			engineErrors: string[];
			keepaliveState(): {
				exists: boolean;
				paused: boolean;
				muted: boolean;
				volume: number;
				loop: boolean;
				duration: number;
				currentTime: number;
				readyState: number;
				error: number | null;
			};
			sessionState(): {
				title: string | null;
				artist: string | null;
				album: string | null;
				artworkCount: number;
				playbackState: string;
			};
		};
	}
}

window.mediaSessionFixture = {
	engineErrors,
	keepaliveState() {
		const element = audioElement;
		return {
			exists: element !== null,
			paused: element?.paused ?? true,
			muted: element?.muted ?? false,
			volume: element?.volume ?? 0,
			loop: element?.loop ?? false,
			duration: element && Number.isFinite(element.duration) ? element.duration : 0,
			currentTime: element?.currentTime ?? 0,
			readyState: element?.readyState ?? 0,
			error: element?.error?.code ?? null
		};
	},
	sessionState() {
		const metadata = navigator.mediaSession.metadata;
		return {
			title: metadata?.title ?? null,
			artist: metadata?.artist ?? null,
			album: metadata?.album ?? null,
			artworkCount: metadata?.artwork.length ?? 0,
			playbackState: navigator.mediaSession.playbackState
		};
	}
};
