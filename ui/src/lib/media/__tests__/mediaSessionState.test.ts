import { describe, it, expect } from 'vitest';
import type { NowPlaying, Zone } from '@shared/types';
import {
	actionsEqual,
	deriveMediaSessionSnapshot,
	PAUSED_PLAYBACK_RATE,
	mapPlaybackStatus,
	metadataEquals,
	positionEquals,
	shouldSendPlayPauseToggle
} from '../mediaSessionState';

function zone(overrides: Partial<Zone> = {}): Zone {
	return {
		zone_id: 'zone-1',
		display_name: 'Kitchen',
		state: 'playing',
		is_play_allowed: false,
		is_pause_allowed: true,
		is_previous_allowed: true,
		is_next_allowed: true,
		is_seek_allowed: true,
		seek_position: 30,
		...overrides
	};
}

function nowPlaying(overrides: Partial<NowPlaying> = {}): NowPlaying {
	return {
		zone_id: 'zone-1',
		title: 'Placeholder Track One',
		artist: 'Fixture Ensemble',
		album: 'Synthetic Sessions',
		image_key: 'abc/def?x=1',
		duration: 240,
		seek_position: 12,
		state: 'playing',
		...overrides
	};
}

describe('deriveMediaSessionSnapshot', () => {
	it('maps the selected zone now-playing state onto session metadata', () => {
		const snapshot = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone(),
			nowPlaying: nowPlaying(),
			origin: 'http://host:3333'
		});

		expect(snapshot.zoneId).toBe('zone-1');
		expect(snapshot.metadata).toEqual({
			title: 'Placeholder Track One',
			artist: 'Fixture Ensemble',
			album: 'Synthetic Sessions',
			artwork: [
				{
					src: 'http://host:3333/api/image/abc%2Fdef%3Fx%3D1?scale=fit&width=96&height=96',
					sizes: '96x96'
				},
				{
					src: 'http://host:3333/api/image/abc%2Fdef%3Fx%3D1?scale=fit&width=256&height=256',
					sizes: '256x256'
				},
				{
					src: 'http://host:3333/api/image/abc%2Fdef%3Fx%3D1?scale=fit&width=512&height=512',
					sizes: '512x512'
				}
			]
		});
		expect(snapshot.playbackStatus).toBe('playing');
		expect(snapshot.keepAudioSessionAlive).toBe(true);
	});

	it('encodes the image key rather than interpolating it into the path', () => {
		const snapshot = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone(),
			nowPlaying: nowPlaying({ image_key: 'a/b' })
		});

		expect(snapshot.metadata?.artwork[0].src).toContain('/api/image/a%2Fb');
	});

	it('falls back to the album artist and omits artwork with no image key', () => {
		const snapshot = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone(),
			nowPlaying: nowPlaying({ artist: undefined, album_artist: 'Various', image_key: undefined })
		});

		expect(snapshot.metadata?.artist).toBe('Various');
		expect(snapshot.metadata?.artwork).toEqual([]);
	});

	it('reports position from the zone tick, clamped to the track duration', () => {
		const snapshot = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone({ seek_position: 999 }),
			nowPlaying: nowPlaying({ duration: 240 })
		});

		expect(snapshot.position).toEqual({ duration: 240, position: 240, playbackRate: 1 });
	});

	it('freezes the reported playback rate while paused (dt4-1)', () => {
		const snapshot = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone({ state: 'paused', seek_position: 90 }),
			nowPlaying: nowPlaying({ duration: 240, seek_position: 90, state: 'paused' })
		});

		// Seek ticks stop flowing on pause; a rate-1 position state left behind
		// would keep the OS panel's elapsed time creeping through the pause.
		// Not literally 0: real Chromium throws on a zero rate (proven in the
		// pinned-Chromium media-session spec).
		expect(snapshot.position).toEqual({
			duration: 240,
			position: 90,
			playbackRate: PAUSED_PLAYBACK_RATE
		});
		expect(PAUSED_PLAYBACK_RATE).toBeGreaterThan(0);
		expect(PAUSED_PLAYBACK_RATE).toBeLessThan(1e-3);
	});

	it('drops position and the seek action for a track with no duration', () => {
		const snapshot = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone(),
			nowPlaying: nowPlaying({ duration: undefined })
		});

		expect(snapshot.position).toBeNull();
		expect(snapshot.actions).not.toContain('seekto');
	});

	it('offers only the transport verbs the zone currently allows', () => {
		const playing = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone(),
			nowPlaying: nowPlaying()
		});
		expect(playing.actions).toEqual(['pause', 'previoustrack', 'nexttrack', 'seekto']);

		const paused = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone({
				state: 'paused',
				is_play_allowed: true,
				is_pause_allowed: false,
				is_next_allowed: false,
				is_seek_allowed: false
			}),
			nowPlaying: nowPlaying({ state: 'paused' })
		});
		expect(paused.actions).toEqual(['play', 'previoustrack']);
	});

	it('keeps the session alive while paused so a media key can resume it', () => {
		const snapshot = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone({ state: 'paused', is_play_allowed: true, is_pause_allowed: false }),
			nowPlaying: nowPlaying({ state: 'paused' })
		});

		expect(snapshot.playbackStatus).toBe('paused');
		expect(snapshot.keepAudioSessionAlive).toBe(true);
		expect(snapshot.metadata?.title).toBe('Placeholder Track One');
	});

	it('tears the session down when the zone stops', () => {
		const snapshot = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone({ state: 'stopped' }),
			nowPlaying: nowPlaying({ state: 'stopped' })
		});

		expect(snapshot).toEqual({
			zoneId: 'zone-1',
			metadata: null,
			playbackStatus: 'none',
			position: null,
			actions: [],
			keepAudioSessionAlive: false
		});
	});

	it('yields an empty snapshot with no selected zone or no track', () => {
		expect(deriveMediaSessionSnapshot({ zoneId: '', zone: undefined, nowPlaying: undefined }))
			.toEqual({
				zoneId: null,
				metadata: null,
				playbackStatus: 'none',
				position: null,
				actions: [],
				keepAudioSessionAlive: false
			});

		const noTrack = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: zone(),
			nowPlaying: undefined
		});
		expect(noTrack.metadata).toBeNull();
		expect(noTrack.keepAudioSessionAlive).toBe(false);
	});

	it('uses the now-playing state when the zone list has not caught up', () => {
		const snapshot = deriveMediaSessionSnapshot({
			zoneId: 'zone-1',
			zone: undefined,
			nowPlaying: nowPlaying({ state: 'paused' })
		});

		expect(snapshot.playbackStatus).toBe('paused');
		// No capability information without a zone record: the four universal
		// verbs, and no seek.
		expect(snapshot.actions).toEqual(['play', 'pause', 'previoustrack', 'nexttrack']);
	});
});

describe('mapPlaybackStatus', () => {
	it('treats loading as playing so a start-up race cannot invert a media key', () => {
		expect(mapPlaybackStatus('loading')).toBe('playing');
		expect(mapPlaybackStatus('playing')).toBe('playing');
		expect(mapPlaybackStatus('paused')).toBe('paused');
		expect(mapPlaybackStatus('stopped')).toBe('none');
		expect(mapPlaybackStatus(undefined)).toBe('none');
	});
});

describe('shouldSendPlayPauseToggle', () => {
	it('only sends the toggle when it moves playback the way the OS asked', () => {
		expect(shouldSendPlayPauseToggle('play', 'paused')).toBe(true);
		expect(shouldSendPlayPauseToggle('play', 'playing')).toBe(false);
		expect(shouldSendPlayPauseToggle('pause', 'playing')).toBe(true);
		expect(shouldSendPlayPauseToggle('pause', 'paused')).toBe(false);
		expect(shouldSendPlayPauseToggle('pause', 'none')).toBe(false);
	});
});

describe('snapshot equality helpers', () => {
	it('compares metadata by value, including artwork order', () => {
		const base = {
			title: 't',
			artist: 'a',
			album: 'b',
			artwork: [{ src: 'x', sizes: '96x96' }]
		};
		expect(metadataEquals(base, { ...base })).toBe(true);
		expect(metadataEquals(base, { ...base, title: 'other' })).toBe(false);
		expect(metadataEquals(base, { ...base, artwork: [{ src: 'y', sizes: '96x96' }] })).toBe(false);
		expect(metadataEquals(base, null)).toBe(false);
		expect(metadataEquals(null, null)).toBe(true);
	});

	it('compares position and action lists by value', () => {
		expect(positionEquals({ duration: 1, position: 0, playbackRate: 1 }, { duration: 1, position: 0, playbackRate: 1 })).toBe(true);
		expect(positionEquals({ duration: 1, position: 0, playbackRate: 1 }, { duration: 1, position: 1, playbackRate: 1 })).toBe(false);
		expect(positionEquals(null, { duration: 1, position: 0, playbackRate: 1 })).toBe(false);
		expect(actionsEqual(['play', 'nexttrack'], ['play', 'nexttrack'])).toBe(true);
		expect(actionsEqual(['play', 'nexttrack'], ['nexttrack', 'play'])).toBe(false);
		expect(actionsEqual(['play'], [])).toBe(false);
	});
});
