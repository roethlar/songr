import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NowPlaying, Zone } from '@shared/types';
import { setCoreStatus } from '$lib/stores/coreStore';
import { resetNowPlaying, setNowPlaying, removeNowPlaying } from '$lib/stores/nowPlayingStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import {
	APP_TITLE,
	formatDocumentTitle,
	startDocumentTitleBinding
} from '../documentTitle';

const DEFAULT_TITLE = 'Songr';

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

function pairCore(): void {
	setCoreStatus({
		status: 'paired',
		core: { id: 'core-1', displayName: 'Fixture Core', displayVersion: '2.0' }
	});
}

function playTrack(overrides: Partial<NowPlaying> = {}): void {
	setZonesSnapshot([zone()]);
	setNowPlaying('zone-1', nowPlaying(overrides));
	setSelectedZone('zone-1');
}

let stop: (() => void) | null = null;

describe('formatDocumentTitle', () => {
	const playing = { corePaired: true, zone: zone(), nowPlaying: nowPlaying() };

	it('reads Track – Artist · Songr while playing', () => {
		expect(formatDocumentTitle(playing, DEFAULT_TITLE)).toBe(
			'Placeholder Track One – Fixture Ensemble · Songr'
		);
	});

	it('falls back to the album artist when the track has no artist', () => {
		expect(
			formatDocumentTitle(
				{ ...playing, nowPlaying: nowPlaying({ artist: undefined, album_artist: 'Fixture Choir' }) },
				DEFAULT_TITLE
			)
		).toBe('Placeholder Track One – Fixture Choir · Songr');
	});

	it('drops the artist half rather than leaving it empty', () => {
		expect(
			formatDocumentTitle(
				{ ...playing, nowPlaying: nowPlaying({ artist: '  ', album_artist: undefined }) },
				DEFAULT_TITLE
			)
		).toBe('Placeholder Track One · Songr');
	});

	it('keeps the track name through the transient loading state', () => {
		expect(
			formatDocumentTitle({ ...playing, zone: zone({ state: 'loading' }) }, DEFAULT_TITLE)
		).toBe('Placeholder Track One – Fixture Ensemble · Songr');
	});

	it.each([['paused' as const], ['stopped' as const]])(
		'restores the default title while %s',
		(state) => {
			expect(
				formatDocumentTitle({ ...playing, zone: zone({ state }) }, DEFAULT_TITLE)
			).toBe(DEFAULT_TITLE);
		}
	);

	it('restores the default title when the Core is not paired', () => {
		expect(formatDocumentTitle({ ...playing, corePaired: false }, DEFAULT_TITLE)).toBe(
			DEFAULT_TITLE
		);
	});

	it('restores the default title when the track has no name', () => {
		expect(
			formatDocumentTitle({ ...playing, nowPlaying: nowPlaying({ title: '   ' }) }, DEFAULT_TITLE)
		).toBe(DEFAULT_TITLE);
	});
});

describe('startDocumentTitleBinding', () => {
	beforeEach(() => {
		document.title = DEFAULT_TITLE;
		resetNowPlaying();
		setZonesSnapshot([]);
		setSelectedZone('');
		pairCore();
	});

	afterEach(() => {
		stop?.();
		stop = null;
		setSelectedZone('');
		document.title = '';
	});

	it('writes the playing track into the tab as state arrives', () => {
		stop = startDocumentTitleBinding();

		playTrack();

		expect(document.title).toBe('Placeholder Track One – Fixture Ensemble · Songr');
	});

	it('follows a zone change', () => {
		stop = startDocumentTitleBinding();
		playTrack();
		setZonesSnapshot([zone(), zone({ zone_id: 'zone-2', display_name: 'Study' })]);
		setNowPlaying('zone-2', nowPlaying({ zone_id: 'zone-2', title: 'Elsewhere' }));

		setSelectedZone('zone-2');

		expect(document.title).toBe('Elsewhere – Fixture Ensemble · Songr');
	});

	it('leaves no stale track name when the zone stops', () => {
		stop = startDocumentTitleBinding();
		playTrack();

		// The payload stays behind in Roon, so only the state says it stopped.
		setZonesSnapshot([zone({ state: 'stopped' })]);

		expect(document.title).toBe(DEFAULT_TITLE);
	});

	it('leaves no stale track name when the now-playing payload goes away', () => {
		stop = startDocumentTitleBinding();
		playTrack();

		removeNowPlaying('zone-1');

		expect(document.title).toBe(DEFAULT_TITLE);
	});

	it('leaves no stale track name when the Core is lost', () => {
		stop = startDocumentTitleBinding();
		playTrack();

		setCoreStatus({ status: 'discovering' });

		expect(document.title).toBe(DEFAULT_TITLE);
	});

	it('leaves no stale track name after teardown', () => {
		stop = startDocumentTitleBinding();
		playTrack();

		stop();
		stop = null;

		expect(document.title).toBe(DEFAULT_TITLE);

		// …and store traffic after teardown must not reach the tab.
		setNowPlaying('zone-1', nowPlaying({ title: 'After teardown' }));
		expect(document.title).toBe(DEFAULT_TITLE);
	});

	it('comes back to the title the document loaded with, not the product name', () => {
		// A route that titles its own page keeps that title when playback ends.
		document.title = 'Fixture Page — Songr';
		stop = startDocumentTitleBinding();
		playTrack();
		expect(document.title).toBe('Placeholder Track One – Fixture Ensemble · Songr');

		setZonesSnapshot([zone({ state: 'paused' })]);

		expect(document.title).toBe('Fixture Page — Songr');
	});

	it('falls back to the product name when the document has no title', () => {
		document.title = '';

		stop = startDocumentTitleBinding();

		expect(document.title).toBe(APP_TITLE);
	});
});
