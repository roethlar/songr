import { beforeEach, describe, expect, it } from 'vitest';
import {
	__back,
	__getHistorySnapshot,
	__getNavigationLog,
	__resetNavigation
} from '../../test/app-stubs/navigation';
import { page } from '../../test/app-stubs/state.svelte';
import {
	buildClassicRootPageState,
	buildLibraryPageStateEnvelope,
	buildTimelineLibraryPageState
} from '../libraryPageState';
import {
	clearPendingLibraryPageStateWrite,
	consumeSelfAuthoredLibraryPageState,
	pushLibraryPageState,
	replaceLibraryPageState
} from '../libraryPageNavigation';
import { getTimelineSessionPageState } from '../timelinePageSessionState';

describe('libraryPageNavigation', () => {
	beforeEach(() => {
		__resetNavigation('http://localhost/library');
		clearPendingLibraryPageStateWrite();
	});

	it('writes mode-tagged shallow entries through SvelteKit navigation', () => {
		const browse = buildClassicRootPageState({ hierarchy: 'browse' });
		const search = buildClassicRootPageState({ hierarchy: 'search', query: 'Bowie' });

		replaceLibraryPageState(browse);
		pushLibraryPageState(search);

		expect(__getNavigationLog()).toEqual([
			{
				operation: 'replaceState',
				url: 'http://localhost/library',
				state: buildLibraryPageStateEnvelope(browse)
			},
			{
				operation: 'pushState',
				url: 'http://localhost/library',
				state: buildLibraryPageStateEnvelope(search)
			}
		]);
		expect(__getHistorySnapshot().entries).toHaveLength(2);
	});

	it('replaces only a Timeline camera while preserving its semantic target and session mirror', () => {
		const initial = buildTimelineLibraryPageState({
			artistQuery: 'Miles Davis',
			selectedArtistLocalId: 'artist-local-miles',
			activeSemanticPath: [
				{ kind: 'artist', localId: 'artist-local-miles' },
				{ kind: 'album', localId: 'album-local-kind-of-blue' }
			],
			selectedNode: { kind: 'album', localId: 'album-local-kind-of-blue' },
			camera: { x: 0, y: 0, scale: 1 },
			displayDepth: 1
		});
		const replacement = buildTimelineLibraryPageState({
			...initial.snapshot,
			camera: { x: 84, y: -36, scale: 1.5 }
		});
		__resetNavigation(
			'http://localhost/library',
			buildLibraryPageStateEnvelope(initial)
		);
		const before = __getHistorySnapshot();

		expect(replaceLibraryPageState(replacement)).toBe(true);

		const after = __getHistorySnapshot();
		expect(after.entries).toHaveLength(before.entries.length);
		expect(after.index).toBe(before.index);
		expect(__getNavigationLog()).toEqual([
			{
				operation: 'replaceState',
				url: 'http://localhost/library',
				state: buildLibraryPageStateEnvelope(replacement)
			}
		]);
		expect(after.entries[after.index]?.state).toEqual(
			buildLibraryPageStateEnvelope(replacement)
		);
		expect(replacement.snapshot).toEqual({
			...initial.snapshot,
			camera: { x: 84, y: -36, scale: 1.5 }
		});
		expect(getTimelineSessionPageState()).toEqual(replacement);
	});

	it('consumes a self-authored reactive state change exactly once', () => {
		const state = buildClassicRootPageState({ hierarchy: 'search', query: 'Bowie' });
		pushLibraryPageState(state);

		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(false);
	});

	it('does not push an entry equivalent to the current semantic state', () => {
		const state = buildClassicRootPageState({ hierarchy: 'search', query: 'Bowie' });
		replaceLibraryPageState(state);
		clearPendingLibraryPageStateWrite();
		const before = __getHistorySnapshot();

		expect(pushLibraryPageState(state)).toBe(false);

		expect(__getHistorySnapshot()).toEqual(before);
		expect(__getNavigationLog().map((entry) => entry.operation)).toEqual(['replaceState']);
	});

	it('does not consume a browser pop after the authored write was observed', () => {
		const browse = buildClassicRootPageState({ hierarchy: 'browse' });
		const search = buildClassicRootPageState({ hierarchy: 'search', query: 'Bowie' });
		replaceLibraryPageState(browse);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);
		pushLibraryPageState(search);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);

		expect(__back()).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(false);
	});

	it('keeps only the newest rapid authored state pending', () => {
		const first = buildClassicRootPageState({ hierarchy: 'search', query: 'First' });
		const second = buildClassicRootPageState({ hierarchy: 'search', query: 'Second' });
		pushLibraryPageState(first);
		pushLibraryPageState(second);

		expect(
			consumeSelfAuthoredLibraryPageState(buildLibraryPageStateEnvelope(first))
		).toBe(false);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(false);
	});
});
