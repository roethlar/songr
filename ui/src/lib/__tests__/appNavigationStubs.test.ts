import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AfterNavigate } from '@sveltejs/kit';
import { page } from '../../test/app-stubs/state.svelte';
import {
	__back,
	__forward,
	__getHistorySnapshot,
	__getNavigationLog,
	__resetNavigation,
	__setRouterInitialized,
	afterNavigate,
	goto,
	pushState,
	replaceState
} from '../../test/app-stubs/navigation';
import {
	buildLibraryPageStateEnvelope,
	buildUnifiedLibraryPageState,
	buildUnifiedRootPageState
} from '$lib/libraryPageState';

const artists = () => buildLibraryPageStateEnvelope(buildUnifiedRootPageState('artists'));
const browse = (filterText = '') =>
	buildLibraryPageStateEnvelope(
		buildUnifiedLibraryPageState({
			scope: 'browse',
			collectionDrill: null,
			itemTarget: null,
			filterText,
			surpriseSeed: null
		})
	);

describe('SvelteKit shallow-navigation test stubs', () => {
	beforeEach(() => {
		__resetNavigation('http://localhost/library', artists());
	});

	it('models push, replace, Back, and Forward with defensive snapshots', () => {
		pushState('', browse('first'));
		replaceState('', browse('second'));

		expect(page.state.library?.snapshot.filterText).toBe('second');
		expect(__back()).toBe(true);
		expect(page.state.library?.snapshot.scope).toBe('artists');
		expect(__forward()).toBe(true);
		expect(__forward()).toBe(false);

		const snapshot = __getHistorySnapshot();
		snapshot.entries[0].state = browse('mutated');
		expect(__getHistorySnapshot().entries[0].state.library?.snapshot.scope).toBe('artists');
	});

	it('truncates Forward when a new shallow entry is pushed', () => {
		pushState('', browse('first'));
		expect(__back()).toBe(true);
		pushState('', browse('replacement'));

		expect(__forward()).toBe(false);
		expect(__getHistorySnapshot()).toMatchObject({ index: 1, entries: [{}, {}] });
	});

	it('updates page.state on shallow pop without firing afterNavigate', async () => {
		const callback = vi.fn();
		afterNavigate(callback);
		await Promise.resolve();
		callback.mockClear();
		pushState('', browse());

		expect(__back()).toBe(true);
		expect(callback).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(callback).not.toHaveBeenCalled();
	});

	it('emits async popstate when traversal crosses a goto route generation', async () => {
		const callback = vi.fn((_navigation: AfterNavigate) => {});
		afterNavigate(callback);
		await Promise.resolve();
		callback.mockClear();

		pushState('', browse());
		await goto('/library?generation=2', { state: artists() });
		callback.mockClear();
		expect(__back()).toBe(true);
		expect(callback).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(callback).toHaveBeenCalledWith(expect.objectContaining({ type: 'popstate', delta: -1 }));
	});

	it('publishes and records goto state before the navigation callback', async () => {
		const observed = vi.fn((_navigation: AfterNavigate) => ({
			search: page.url.search,
			scope: page.state.library?.snapshot.scope
		}));
		afterNavigate(observed);
		await Promise.resolve();
		observed.mockClear();

		await goto('/library?from=browse', { state: browse() });
		expect(observed).toHaveBeenCalledOnce();
		expect(observed.mock.results[0].value).toEqual({ search: '?from=browse', scope: 'browse' });
		expect(__getNavigationLog()).toMatchObject([
			{ operation: 'goto', url: 'http://localhost/library?from=browse' }
		]);
	});

	it('rejects shallow writes until the initial navigation callback initializes the router', async () => {
		__setRouterInitialized(false);
		expect(() => replaceState('', browse())).toThrow(
			'Cannot call replaceState(...) before router is initialized'
		);

		const callback = vi.fn(() => replaceState('', browse()));
		afterNavigate(callback);
		await Promise.resolve();

		expect(callback).toHaveBeenCalledOnce();
		expect(__getNavigationLog()).toMatchObject([{ operation: 'replaceState' }]);
	});

	it('does not retain caller mutations in page state or logs', () => {
		const next = browse();
		pushState('', next);
		next.library.snapshot.filterText = 'mutated after push';

		expect(page.state.library?.snapshot.filterText).toBe('');
		const log = __getNavigationLog();
		log[0].state = artists();
		expect(__getNavigationLog()[0].state.library?.snapshot.scope).toBe('browse');
	});
});
