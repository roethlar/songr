import { beforeEach, describe, expect, it } from 'vitest';

import {
	buildTimelineLibraryPageState,
	buildTimelineRootPageState
} from '$lib/libraryPageState';
import {
	getTimelineSessionPageState,
	persistTimelineSessionPageState,
	readTimelineSessionPageState,
	TIMELINE_PAGE_SESSION_STORAGE_KEY
} from '$lib/timelinePageSessionState';

describe('Timeline tab session state', () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it('round-trips only a defensive keyless Timeline PageState', () => {
		const state = buildTimelineLibraryPageState({
			artistQuery: 'Björk',
			selectedArtistLocalId: 'artist-local-1',
			activeSemanticPath: [
				{ kind: 'artist', localId: 'artist-local-1' },
				{ kind: 'album', localId: 'album-local-1' }
			],
			selectedNode: { kind: 'album', localId: 'album-local-1' },
			camera: { x: 42, y: -7, scale: 1.25 },
			displayDepth: 1
		});

		expect(persistTimelineSessionPageState(state)).toBe(true);
		expect(getTimelineSessionPageState()).toEqual(state);
		expect(readTimelineSessionPageState()).toEqual({ status: 'valid', pageState: state });
		expect(sessionStorage.getItem(TIMELINE_PAGE_SESSION_STORAGE_KEY)).not.toContain('itemKey');
	});

	it('fails closed without altering corrupt or authority-bearing bytes', () => {
		const raw = '{"libraryView":"timeline","itemKey":"live"}';
		sessionStorage.setItem(TIMELINE_PAGE_SESSION_STORAGE_KEY, raw);

		expect(getTimelineSessionPageState()).toBeNull();
		expect(readTimelineSessionPageState()).toEqual({ status: 'invalid' });
		expect(sessionStorage.getItem(TIMELINE_PAGE_SESSION_STORAGE_KEY)).toBe(raw);
		expect(persistTimelineSessionPageState({ ...buildTimelineRootPageState(), itemKey: 'live' })).toBe(false);
		expect(sessionStorage.getItem(TIMELINE_PAGE_SESSION_STORAGE_KEY)).toBe(raw);
	});

	it('rejects Classic and internally contradictory Timeline states', () => {
		expect(persistTimelineSessionPageState({
			libraryView: 'classic',
			schemaVersion: 1,
			snapshot: { context: { hierarchy: 'browse' }, history: [], forward: [] }
		})).toBe(false);
		expect(persistTimelineSessionPageState({
			...buildTimelineRootPageState(),
			snapshot: {
				...buildTimelineRootPageState().snapshot,
				selectedArtistLocalId: 'artist-local-1'
			}
		})).toBe(false);
		expect(getTimelineSessionPageState()).toBeNull();
	});
});
