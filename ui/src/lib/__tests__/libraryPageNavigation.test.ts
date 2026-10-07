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
	clearShownLibraryAddress,
	libraryAddressNeedsRestore,
	preflightLibraryPageState,
	pushLibraryPageState,
	recordShownLibraryAddress,
	replaceLibraryPageState,
	shouldHandleLibraryAnchorClick
} from '../libraryPageNavigation';

const address = () => new URL(window.location.href);

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
		clearShownLibraryAddress();
		recordShownLibraryAddress(address());
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
		// As in SvelteKit: the address bar moves, page.url keeps the mount route.
		expect(address().pathname).toBe('/library/browse');
		expect(address().search).toBe('?search=Bowie');
		expect(page.url.pathname).toBe('/library/albums');
		expect(page.state).toEqual({});
	});

	it('replaces in place and does not push an equivalent state', () => {
		const state = browse('Miles');
		__resetNavigation('http://localhost/library/artists');
		recordShownLibraryAddress(address());
		expect(replaceLibraryPageState(state)).toBe('pushed');
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
		expect(libraryAddressNeedsRestore(address())).toBe(false);
	});

	it('treats its own writes as shown and a history move as needing restore', () => {
		pushLibraryPageState(browse('Bowie'));
		expect(libraryAddressNeedsRestore(address())).toBe(false);

		expect(__back()).toBe(true);
		expect(libraryAddressNeedsRestore(address())).toBe(true);
		// Restoring records it: the same address is not restored twice.
		expect(libraryAddressNeedsRestore(address())).toBe(false);
	});

	it('detects the second Back after returning to an entry by Back and pushing again (#22)', () => {
		pushLibraryPageState(browse('Artist page'));
		pushLibraryPageState(browse('Album page'));
		expect(__back()).toBe(true);
		expect(libraryAddressNeedsRestore(address())).toBe(true);

		pushLibraryPageState(browse('Album page'));
		expect(__back()).toBe(true);
		expect(address().searchParams.get('search')).toBe('Artist page');
		expect(libraryAddressNeedsRestore(address())).toBe(true);
	});

	it('pushes, rather than dedupes, a return to the mount address', () => {
		expect(pushLibraryPageState(artists())).toBe('pushed');
		// page.url still names the mounted /library/albums.
		expect(page.url.pathname).toBe('/library/albums');
		expect(pushLibraryPageState(buildUnifiedRootPageState('albums'))).toBe('pushed');
		expect(__getHistorySnapshot().entries).toHaveLength(3);
		expect(pushLibraryPageState(buildUnifiedRootPageState('albums'))).toBe('deduped');
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
