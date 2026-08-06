import { describe, it, expect, beforeEach } from 'vitest';
import type { NowPlaying, Zone } from '@shared/types';
import {
	createFakeKeepalive,
	createFakeMediaSession,
	createFakeMediaTransport,
	createFakeMetadata,
	type FakeKeepalive,
	type FakeMediaSession,
	type FakeMediaTransport
} from '../../../test/fixtures/mediaSession';
import {
	createMediaSessionController,
	type MediaSessionController
} from '../mediaSessionController';

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
		seek_position: 10,
		...overrides
	};
}

function nowPlaying(overrides: Partial<NowPlaying> = {}): NowPlaying {
	return {
		zone_id: 'zone-1',
		title: 'Placeholder Track One',
		artist: 'Fixture Ensemble',
		album: 'Synthetic Sessions',
		duration: 240,
		seek_position: 10,
		state: 'playing',
		...overrides
	};
}

describe('createMediaSessionController', () => {
	let session: FakeMediaSession;
	let transport: FakeMediaTransport;
	let keepalive: FakeKeepalive;
	let controller: MediaSessionController;

	beforeEach(() => {
		session = createFakeMediaSession();
		transport = createFakeMediaTransport();
		keepalive = createFakeKeepalive();
		controller = createMediaSessionController({
			mediaSession: session,
			transport,
			createMetadata: createFakeMetadata,
			keepalive
		});
	});

	it('publishes metadata, playback state, position and handlers for a playing zone', () => {
		controller.update({ zoneId: 'zone-1', zone: zone(), nowPlaying: nowPlaying() });

		expect(session.metadata?.title).toBe('Placeholder Track One');
		expect(session.metadata?.album).toBe('Synthetic Sessions');
		expect(session.playbackState).toBe('playing');
		expect(session.positionStates.at(-1)).toEqual({
			duration: 240,
			position: 10,
			playbackRate: 1
		});
		expect(session.registeredActions()).toEqual([
			'pause',
			'previoustrack',
			'nexttrack',
			'seekto'
		]);
		expect(keepalive.start).toHaveBeenCalledTimes(1);
	});

	it('dispatches OS actions to the transport for the current zone', () => {
		controller.update({ zoneId: 'zone-1', zone: zone(), nowPlaying: nowPlaying() });

		session.invoke('pause');
		session.invoke('nexttrack');
		session.invoke('previoustrack');
		session.invoke('seekto', { seekTime: 42.7 });

		expect(transport.playPause).toHaveBeenCalledWith('zone-1');
		expect(transport.next).toHaveBeenCalledWith('zone-1');
		expect(transport.previous).toHaveBeenCalledWith('zone-1');
		expect(transport.seek).toHaveBeenCalledWith('zone-1', 42);
	});

	it('ignores a seek with no usable seekTime', () => {
		controller.update({ zoneId: 'zone-1', zone: zone(), nowPlaying: nowPlaying() });

		session.invoke('seekto');
		session.invoke('seekto', { seekTime: null });
		session.invoke('seekto', { seekTime: Number.NaN });
		session.invoke('seekto', { seekTime: -1 });

		expect(transport.seek).not.toHaveBeenCalled();
	});

	it('suppresses an identical toggle inside the in-flight window (dt4-2)', () => {
		let clock = 1_000;
		controller = createMediaSessionController({
			mediaSession: session,
			transport,
			createMetadata: createFakeMetadata,
			keepalive,
			now: () => clock
		});
		controller.update({
			zoneId: 'zone-1',
			zone: zone({ state: 'paused', is_play_allowed: true, is_pause_allowed: true }),
			nowPlaying: nowPlaying({ state: 'paused' })
		});

		// A bounced or re-pressed play key: the status is stale until the socket
		// round-trips, and a second toggle would pause the track just starting.
		session.invoke('play');
		clock += 200;
		session.invoke('play');
		expect(transport.playPause).toHaveBeenCalledTimes(1);

		// The store catches up; the suppression clears with it, so the opposite
		// action goes through.
		controller.update({
			zoneId: 'zone-1',
			zone: zone({ state: 'playing', is_play_allowed: true, is_pause_allowed: true }),
			nowPlaying: nowPlaying({ state: 'playing' })
		});
		session.invoke('pause');
		expect(transport.playPause).toHaveBeenCalledTimes(2);
	});

	it('clears the suppression record on a zone switch (dt5-1)', () => {
		let clock = 1_000;
		controller = createMediaSessionController({
			mediaSession: session,
			transport,
			createMetadata: createFakeMetadata,
			keepalive,
			now: () => clock
		});
		controller.update({
			zoneId: 'zone-1',
			zone: zone({ state: 'playing', is_play_allowed: true, is_pause_allowed: true }),
			nowPlaying: nowPlaying({ state: 'playing' })
		});
		session.invoke('pause');
		expect(transport.playPause).toHaveBeenCalledTimes(1);

		// Same playback status, different zone: a pause aimed at zone B must
		// not be swallowed by zone A's pending record.
		clock += 200;
		controller.update({
			zoneId: 'zone-2',
			zone: zone({
				zone_id: 'zone-2',
				state: 'playing',
				is_play_allowed: true,
				is_pause_allowed: true
			}),
			nowPlaying: nowPlaying({ zone_id: 'zone-2', state: 'playing' })
		});
		session.invoke('pause');
		expect(transport.playPause).toHaveBeenCalledTimes(2);
		expect(transport.playPause).toHaveBeenLastCalledWith('zone-2');
	});

	it('lets an identical toggle through once the suppression window expires (dt4-2)', () => {
		let clock = 1_000;
		controller = createMediaSessionController({
			mediaSession: session,
			transport,
			createMetadata: createFakeMetadata,
			keepalive,
			now: () => clock
		});
		controller.update({
			zoneId: 'zone-1',
			zone: zone({ state: 'paused', is_play_allowed: true, is_pause_allowed: true }),
			nowPlaying: nowPlaying({ state: 'paused' })
		});

		// A lost toggle must not suppress the key forever: past the window (the
		// transport's own ack timeout) the user's press counts again.
		session.invoke('play');
		clock += 3_100;
		session.invoke('play');
		expect(transport.playPause).toHaveBeenCalledTimes(2);
	});

	it('does not toggle when the OS asks for the state playback is already in', () => {
		// A paused zone: the OS shows "play", and the only registered toggle
		// action is play. Firing pause anyway (a stale OS view, or a panel that
		// sends both) must not start playback.
		controller.update({
			zoneId: 'zone-1',
			zone: zone({ state: 'paused', is_play_allowed: true, is_pause_allowed: true }),
			nowPlaying: nowPlaying({ state: 'paused' })
		});

		session.invoke('pause');
		expect(transport.playPause).not.toHaveBeenCalled();

		session.invoke('play');
		expect(transport.playPause).toHaveBeenCalledTimes(1);
	});

	it('does not re-send a play toggle while the zone is still spinning up', () => {
		controller.update({
			zoneId: 'zone-1',
			zone: zone({ state: 'loading', is_play_allowed: true, is_pause_allowed: true }),
			nowPlaying: nowPlaying({ state: 'loading' })
		});

		session.invoke('play');

		expect(transport.playPause).not.toHaveBeenCalled();
	});

	it('acts on the newly selected zone after a zone change, without re-registering handlers', () => {
		controller.update({ zoneId: 'zone-1', zone: zone(), nowPlaying: nowPlaying() });
		const registrationsAfterFirst = session.handlerCalls.length;

		controller.update({
			zoneId: 'zone-2',
			zone: zone({ zone_id: 'zone-2', display_name: 'Study' }),
			nowPlaying: nowPlaying({ zone_id: 'zone-2', title: 'Other' })
		});

		expect(session.handlerCalls.length).toBe(registrationsAfterFirst);
		expect(session.registeredActions()).toEqual([
			'pause',
			'previoustrack',
			'nexttrack',
			'seekto'
		]);

		session.invoke('nexttrack');
		expect(transport.next).toHaveBeenCalledExactlyOnceWith('zone-2');
	});

	it('follows playbackState transitions and retires actions the zone no longer allows', () => {
		controller.update({ zoneId: 'zone-1', zone: zone(), nowPlaying: nowPlaying() });
		expect(session.playbackState).toBe('playing');

		controller.update({
			zoneId: 'zone-1',
			zone: zone({ state: 'paused', is_play_allowed: true, is_pause_allowed: false }),
			nowPlaying: nowPlaying({ state: 'paused' })
		});
		expect(session.playbackState).toBe('paused');
		expect(session.registeredActions()).toEqual([
			'previoustrack',
			'nexttrack',
			'seekto',
			'play'
		]);
		// Paused is still a live session — the keepalive must not stop, or the
		// media key that resumes playback would have no session to reach.
		expect(keepalive.stop).not.toHaveBeenCalled();

		controller.update({
			zoneId: 'zone-1',
			zone: zone({ state: 'stopped' }),
			nowPlaying: undefined
		});
		expect(session.playbackState).toBe('none');
		expect(session.metadata).toBeNull();
		expect(session.registeredActions()).toEqual([]);
		expect(session.positionStates.at(-1)).toBeUndefined();
		expect(keepalive.stop).toHaveBeenCalledTimes(1);
	});

	it('writes each section only when it changes', () => {
		controller.update({ zoneId: 'zone-1', zone: zone(), nowPlaying: nowPlaying() });
		const positionWrites = session.positionStates.length;
		const handlerWrites = session.handlerCalls.length;

		controller.update({ zoneId: 'zone-1', zone: zone(), nowPlaying: nowPlaying() });

		expect(session.positionStates.length).toBe(positionWrites);
		expect(session.handlerCalls.length).toBe(handlerWrites);
		expect(keepalive.start).toHaveBeenCalledTimes(1);
	});

	it('clears every handler it registered on teardown and stops dispatching', () => {
		controller.update({ zoneId: 'zone-1', zone: zone(), nowPlaying: nowPlaying() });
		const live = [...session.handlers.entries()];
		expect(live.length).toBeGreaterThan(0);

		controller.destroy();

		expect(session.registeredActions()).toEqual([]);
		expect(session.metadata).toBeNull();
		expect(session.playbackState).toBe('none');
		expect(keepalive.destroy).toHaveBeenCalledTimes(1);

		// A handler the OS still holds a reference to must go quiet rather than
		// command a zone the app is no longer showing.
		for (const [, handler] of live) handler?.({ seekTime: 5 });
		expect(transport.playPause).not.toHaveBeenCalled();
		expect(transport.next).not.toHaveBeenCalled();
		expect(transport.previous).not.toHaveBeenCalled();
		expect(transport.seek).not.toHaveBeenCalled();
	});

	it('survives an engine that rejects an action it does not know', () => {
		const strict = createFakeMediaSession();
		const setActionHandler = strict.setActionHandler.bind(strict);
		strict.setActionHandler = (action, handler) => {
			if (action === 'seekto') throw new Error('NotSupportedError');
			setActionHandler(action, handler);
		};
		const strictController = createMediaSessionController({
			mediaSession: strict,
			transport,
			createMetadata: createFakeMetadata,
			keepalive
		});

		strictController.update({ zoneId: 'zone-1', zone: zone(), nowPlaying: nowPlaying() });

		expect(strict.registeredActions()).toEqual(['pause', 'previoustrack', 'nexttrack']);
		strict.invoke('nexttrack');
		expect(transport.next).toHaveBeenCalledWith('zone-1');
	});

	it('skips position state on an engine without setPositionState', () => {
		const legacy = createFakeMediaSession();
		delete (legacy as { setPositionState?: unknown }).setPositionState;
		const legacyController = createMediaSessionController({
			mediaSession: legacy,
			transport,
			createMetadata: createFakeMetadata,
			keepalive: null
		});

		expect(() =>
			legacyController.update({ zoneId: 'zone-1', zone: zone(), nowPlaying: nowPlaying() })
		).not.toThrow();
		expect(legacy.playbackState).toBe('playing');
		legacyController.destroy();
	});
});
