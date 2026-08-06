import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { NowPlaying, Zone } from '@shared/types';
import { createFakeSocket } from '../../../test/fixtures/socket';
import {
	createFakeKeepalive,
	createFakeMediaSession,
	createFakeMetadata,
	type FakeMediaSession
} from '../../../test/fixtures/mediaSession';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import { removeNowPlaying, resetNowPlaying, setNowPlaying } from '$lib/stores/nowPlayingStore';
import { commandFeedbackStore, clearCommandFeedback } from '$lib/stores/commandFeedbackStore';
import { startMediaSessionBinding } from '../mediaSessionBinding';

const socket = createFakeSocket();
let socketAvailable = true;

vi.mock('$lib/socket/client', () => ({
	getSocket: () => (socketAvailable ? socket : null)
}));

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
		seek_position: 5,
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
		seek_position: 5,
		state: 'playing',
		...overrides
	};
}

function start(session: FakeMediaSession) {
	return startMediaSessionBinding({
		mediaSession: session,
		createMetadata: createFakeMetadata,
		keepalive: createFakeKeepalive(),
		origin: 'http://host:3333'
	});
}

describe('startMediaSessionBinding', () => {
	beforeEach(() => {
		socketAvailable = true;
		socket.connected = true;
		socket.emit.mockReset();
		resetNowPlaying();
		setZonesSnapshot([]);
		setSelectedZone('');
		clearCommandFeedback();
	});

	it('is a no-op when the platform exposes no media session', () => {
		const stop = startMediaSessionBinding({ mediaSession: null });
		expect(() => stop()).not.toThrow();
	});

	it('mirrors the selected zone into the session as state arrives', () => {
		const session = createFakeMediaSession();
		const stop = start(session);

		setZonesSnapshot([zone()]);
		setNowPlaying('zone-1', nowPlaying());
		setSelectedZone('zone-1');

		expect(session.metadata?.title).toBe('Placeholder Track One');
		expect(session.metadata?.artwork).toEqual([]);
		expect(session.playbackState).toBe('playing');
		expect(session.registeredActions()).toEqual([
			'pause',
			'previoustrack',
			'nexttrack',
			'seekto'
		]);

		stop();
	});

	it('sends OS actions down the same socket commands as the on-screen buttons', () => {
		const session = createFakeMediaSession();
		const stop = start(session);

		setZonesSnapshot([zone()]);
		setNowPlaying('zone-1', nowPlaying());
		setSelectedZone('zone-1');

		session.invoke('pause');
		session.invoke('nexttrack');
		session.invoke('previoustrack');
		session.invoke('seekto', { seekTime: 61.4 });

		const sent = socket.emit.mock.calls.map((call) => [call[0], call[1]]);
		expect(sent).toEqual([
			['transport:play-pause', { zone_id: 'zone-1' }],
			['transport:next', { zone_id: 'zone-1' }],
			['transport:previous', { zone_id: 'zone-1' }],
			['transport:seek', { zone_id: 'zone-1', seconds: 61 }]
		]);

		stop();
	});

	it('follows a zone change without leaking the previous zone', () => {
		const session = createFakeMediaSession();
		const stop = start(session);

		setZonesSnapshot([zone(), zone({ zone_id: 'zone-2', display_name: 'Study' })]);
		setNowPlaying('zone-1', nowPlaying());
		setNowPlaying('zone-2', nowPlaying({ zone_id: 'zone-2', title: 'Elsewhere' }));
		setSelectedZone('zone-1');
		const registrationsAfterFirstZone = session.handlerCalls.length;

		setSelectedZone('zone-2');

		expect(session.metadata?.title).toBe('Elsewhere');
		// Same action set, so no handler churn — and no duplicate registration.
		expect(session.handlerCalls.length).toBe(registrationsAfterFirstZone);

		session.invoke('nexttrack');
		expect(socket.emit).toHaveBeenCalledTimes(1);
		expect(socket.emit.mock.calls[0][1]).toEqual({ zone_id: 'zone-2' });

		stop();
	});

	it('clears the session when the selected zone stops playing', () => {
		const session = createFakeMediaSession();
		const stop = start(session);

		setZonesSnapshot([zone()]);
		setNowPlaying('zone-1', nowPlaying());
		setSelectedZone('zone-1');
		expect(session.playbackState).toBe('playing');

		removeNowPlaying('zone-1');
		setZonesSnapshot([zone({ state: 'stopped' })]);

		expect(session.playbackState).toBe('none');
		expect(session.metadata).toBeNull();
		expect(session.registeredActions()).toEqual([]);

		stop();
	});

	it('leaves no handlers and stops following stores after teardown', () => {
		const session = createFakeMediaSession();
		const stop = start(session);

		setZonesSnapshot([zone()]);
		setNowPlaying('zone-1', nowPlaying());
		setSelectedZone('zone-1');
		const liveHandlers = [...session.handlers.values()];

		stop();

		expect(session.registeredActions()).toEqual([]);
		expect(session.metadata).toBeNull();
		expect(session.playbackState).toBe('none');

		// Store traffic after teardown must not reach the session…
		setNowPlaying('zone-1', nowPlaying({ title: 'After teardown' }));
		expect(session.metadata).toBeNull();

		// …and a handler the OS still holds must send nothing.
		for (const handler of liveHandlers) handler?.({ seekTime: 3 });
		expect(socket.emit).not.toHaveBeenCalled();
	});

	it('reports a missing realtime connection instead of dispatching', () => {
		const session = createFakeMediaSession();
		const stop = start(session);

		setZonesSnapshot([zone()]);
		setNowPlaying('zone-1', nowPlaying());
		setSelectedZone('zone-1');

		socketAvailable = false;
		session.invoke('pause');

		expect(socket.emit).not.toHaveBeenCalled();
		expect(get(commandFeedbackStore)?.message).toBe('Realtime connection unavailable.');

		stop();
	});

	it('fails fast rather than buffering a command while disconnected', () => {
		const session = createFakeMediaSession();
		const stop = start(session);

		setZonesSnapshot([zone()]);
		setNowPlaying('zone-1', nowPlaying());
		setSelectedZone('zone-1');

		socket.connected = false;
		session.invoke('nexttrack');

		expect(socket.emit).not.toHaveBeenCalled();
		expect(get(commandFeedbackStore)?.message).toBe('Not connected to server');

		stop();
	});
});
