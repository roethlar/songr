import { beforeEach, describe, expect, it } from 'vitest';
import {
	__back,
	__getHistorySnapshot,
	__getNavigationLog,
	__resetNavigation
} from '../../test/app-stubs/navigation';
import { page } from '../../test/app-stubs/state.svelte';
import { buildUnifiedLibraryPageState, buildUnifiedRootPageState } from '../libraryPageState';
import {
	clearPendingLibraryPageStateWrite,
	consumeSelfAuthoredLibraryPageState,
	expectSelfAuthoredLibraryPageState,
	preflightLibraryPageState,
	pushLibraryPageState,
	replaceLibraryPageState,
	shouldHandleLibraryAnchorClick
} from '../libraryPageNavigation';

const artists = () => buildUnifiedRootPageState('artists');
const browse = (filterText = '') =>
	buildUnifiedLibraryPageState({
		scope: 'browse',
		collectionDrill: null,
		itemTarget: null,
		filterText: '',
		surpriseSeed: null,
		browseHistory: {
			context: filterText ? { hierarchy: 'search', query: filterText } : { hierarchy: 'browse' },
			history: [],
			forward: []
		}
	});

describe('libraryPageNavigation', () => {
	beforeEach(() => {
		__resetNavigation('http://localhost/library/albums');
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
		expect(page.url.pathname).toBe('/library/browse');
		expect(page.url.search).toBe('?search=Bowie');
		expect(page.state).toEqual({});
	});

	it('replaces in place and does not push an equivalent state', () => {
		const state = browse('Miles');
		__resetNavigation('http://localhost/library/artists');
		expect(replaceLibraryPageState(state)).toBe('pushed');
		clearPendingLibraryPageStateWrite();
		const before = __getHistorySnapshot();

		expect(pushLibraryPageState(state)).toBe('deduped');
		expect(__getHistorySnapshot()).toEqual(before);
	});

	it('refuses an unaddressable state without writing or arming observation', () => {
		const state = buildUnifiedLibraryPageState({
			scope: 'artists',
			collectionDrill: null,
			itemTarget: {
				kind: 'live',
				path: {
					origin: 'artists',
					steps: [
						{ kind: 'artist', title: 'Miles Davis' },
						{ kind: 'section', title: 'Albums' }
					]
				}
			},
			filterText: '',
			surpriseSeed: null
		});
		const before = __getHistorySnapshot();

		expect(preflightLibraryPageState(state)).toBeNull();
		expect(pushLibraryPageState(state)).toBe('refused');
		expect(__getHistorySnapshot()).toEqual(before);
		expect(__getNavigationLog()).toEqual([]);
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(false);
	});

	it('consumes a self-authored reactive state change exactly once', () => {
		pushLibraryPageState(browse('Bowie'));
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(false);
	});

	it('does not consume a browser pop after authored writes were observed', () => {
		replaceLibraryPageState(artists());
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(true);
		pushLibraryPageState(browse('Bowie'));
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(true);

		expect(__back()).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(false);
	});

	it('keeps only the newest rapid authored state pending', () => {
		const first = browse('First');
		const second = browse('Second');
		pushLibraryPageState(first);
		pushLibraryPageState(second);

		expect(
			consumeSelfAuthoredLibraryPageState(new URL('/library/browse?search=First', page.url))
		).toBe(false);
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(false);
	});

	it('consumes an expected self-authored traversal exactly once (ri8-1)', () => {
		const parent = artists();
		pushLibraryPageState(parent);
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(true);
		pushLibraryPageState(browse('Child'));
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(true);

		expectSelfAuthoredLibraryPageState(parent);
		expect(__back()).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(false);
	});

	it('falls through to the pop path when the traversal expectation mismatches (ri8-1)', () => {
		pushLibraryPageState(artists());
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(true);
		pushLibraryPageState(browse('Child'));
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(true);

		expectSelfAuthoredLibraryPageState(browse('Somewhere else'));
		expect(__back()).toBe(true);
		expect(consumeSelfAuthoredLibraryPageState(page.url)).toBe(false);
	});

	it('handles only an unmodified primary anchor click in-app', () => {
		expect(shouldHandleLibraryAnchorClick(new MouseEvent('click', { button: 0 }))).toBe(true);
		for (const event of [
			new MouseEvent('click', { button: 1 }),
			new MouseEvent('click', { button: 0, metaKey: true }),
			new MouseEvent('click', { button: 0, ctrlKey: true }),
			new MouseEvent('click', { button: 0, shiftKey: true }),
			new MouseEvent('click', { button: 0, altKey: true })
		]) {
			expect(shouldHandleLibraryAnchorClick(event)).toBe(false);
		}
		const prevented = new MouseEvent('click', { button: 0, cancelable: true });
		prevented.preventDefault();
		expect(shouldHandleLibraryAnchorClick(prevented)).toBe(false);
	});
});
