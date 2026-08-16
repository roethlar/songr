import { beforeEach, describe, expect, it } from 'vitest';
import {
	__back,
	__getHistorySnapshot,
	__getNavigationLog,
	__resetNavigation
} from '../../test/app-stubs/navigation';
import { page } from '../../test/app-stubs/state.svelte';
import {
	buildLibraryPageStateEnvelope,
	buildUnifiedLibraryPageState,
	buildUnifiedRootPageState
} from '../libraryPageState';
import {
	clearPendingLibraryPageStateWrite,
	consumeSelfAuthoredLibraryPageState,
	expectSelfAuthoredLibraryPageState,
	pushLibraryPageState,
	replaceLibraryPageState
} from '../libraryPageNavigation';

const artists = () => buildUnifiedRootPageState('artists');
const browse = (filterText = '') =>
	buildUnifiedLibraryPageState({
		scope: 'browse',
		collectionDrill: null,
		itemTarget: null,
		filterText,
		surpriseSeed: null
	});

describe('libraryPageNavigation', () => {
	beforeEach(() => {
		__resetNavigation('http://localhost/library');
		clearPendingLibraryPageStateWrite();
	});

	it('writes Unified shallow entries through SvelteKit navigation', () => {
		const initial = artists();
		const next = browse('Bowie');
		replaceLibraryPageState(initial);
		pushLibraryPageState(next);

		expect(__getNavigationLog().map((entry) => entry.operation)).toEqual([
			'replaceState',
			'pushState'
		]);
		expect(__getHistorySnapshot().entries).toHaveLength(2);
		expect(page.state).toEqual(buildLibraryPageStateEnvelope(next));
	});

	it('replaces in place and does not push an equivalent state', () => {
		const state = browse('Miles');
		__resetNavigation('http://localhost/library', buildLibraryPageStateEnvelope(artists()));
		expect(replaceLibraryPageState(state)).toBe(true);
		clearPendingLibraryPageStateWrite();
		const before = __getHistorySnapshot();

		expect(pushLibraryPageState(state)).toBe(false);
		expect(__getHistorySnapshot()).toEqual(before);
	});

	it('consumes a self-authored reactive state change exactly once', () => {
		pushLibraryPageState(browse('Bowie'));
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(false);
	});

	it('does not consume a browser pop after authored writes were observed', () => {
		replaceLibraryPageState(artists());
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);
		pushLibraryPageState(browse('Bowie'));
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);

		expect(__back()).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(false);
	});

	it('keeps only the newest rapid authored state pending', () => {
		const first = browse('First');
		const second = browse('Second');
		pushLibraryPageState(first);
		pushLibraryPageState(second);

		expect(consumeSelfAuthoredLibraryPageState(buildLibraryPageStateEnvelope(first))).toBe(false);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(false);
	});

	it('consumes an expected self-authored traversal exactly once (ri8-1)', () => {
		const parent = artists();
		pushLibraryPageState(parent);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);
		pushLibraryPageState(browse('Child'));
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);

		expectSelfAuthoredLibraryPageState(parent);
		expect(__back()).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(false);
	});

	it('falls through to the pop path when the traversal expectation mismatches (ri8-1)', () => {
		pushLibraryPageState(artists());
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);
		pushLibraryPageState(browse('Child'));
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(true);

		expectSelfAuthoredLibraryPageState(browse('Somewhere else'));
		expect(__back()).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.state)).toBe(false);
	});
});
