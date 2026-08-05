import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AfterNavigate } from '@sveltejs/kit';
import { page } from '../../test/app-stubs/state.svelte';
import {
	__back,
	__forward,
	__getHistorySnapshot,
	__getNavigationLog,
	__resetNavigation,
	afterNavigate,
	goto,
	pushState,
	replaceState
} from '../../test/app-stubs/navigation';
import {
	buildClassicRootPageState,
	buildLibraryPageStateEnvelope,
	buildTimelineRootPageState
} from '$lib/libraryPageState';

const classic = () => buildLibraryPageStateEnvelope(buildClassicRootPageState());
const timeline = () => buildLibraryPageStateEnvelope(buildTimelineRootPageState());

describe('SvelteKit shallow-navigation test stubs', () => {
	beforeEach(() => {
		__resetNavigation('http://localhost/library', classic());
	});

	it('models push, replace, Back, and Forward with defensive history snapshots', () => {
		pushState('', timeline());
		replaceState('', classic());

		expect(page.url.pathname).toBe('/library');
		expect(page.state.library?.libraryView).toBe('classic');
		expect(__getHistorySnapshot()).toMatchObject({
			index: 1,
			entries: [
				{ state: { library: { libraryView: 'classic' } } },
				{ state: { library: { libraryView: 'classic' } } }
			]
		});

		expect(__back()).toBe(true);
		expect(page.state.library?.libraryView).toBe('classic');
		expect(__forward()).toBe(true);
		expect(__forward()).toBe(false);

		const snapshot = __getHistorySnapshot();
		snapshot.entries[0].state = timeline();
		expect(__getHistorySnapshot().entries[0].state.library?.libraryView).toBe('classic');
	});

	it('truncates Forward when a new shallow entry is pushed', () => {
		pushState('', timeline());
		expect(__back()).toBe(true);

		pushState('', classic());

		expect(__forward()).toBe(false);
		expect(__getHistorySnapshot()).toMatchObject({ index: 1, entries: [{}, {}] });
	});

	it('updates page.state on shallow pop without firing afterNavigate', async () => {
		const callback = vi.fn();
		afterNavigate(callback);
		await Promise.resolve();
		callback.mockClear();
		pushState('', timeline());

		expect(__back()).toBe(true);
		expect(page.state.library?.libraryView).toBe('classic');
		expect(callback).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(callback).not.toHaveBeenCalled();
		expect(__getNavigationLog().map((entry) => entry.operation)).toEqual([
			'pushState',
			'popstate'
		]);
	});

	it('emits async popstate only when traversal crosses a goto route generation', async () => {
		const callback = vi.fn((_navigation: AfterNavigate) => {});
		afterNavigate(callback);
		await Promise.resolve();
		callback.mockClear();

		pushState('', timeline());
		await goto('/library', { state: classic() });
		callback.mockClear();

		expect(__back()).toBe(true);
		expect(page.url.href).toBe('http://localhost/library');
		expect(page.state.library?.libraryView).toBe('timeline');
		expect(callback).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'popstate',
				delta: -1,
				from: expect.objectContaining({ url: new URL('http://localhost/library') }),
				to: expect.objectContaining({ url: new URL('http://localhost/library') })
			})
		);

		callback.mockClear();
		expect(__forward()).toBe(true);
		expect(page.state.library?.libraryView).toBe('classic');
		expect(callback).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'popstate', delta: 1 })
		);
	});

	it('publishes and records goto state before emitting a full-route navigation', async () => {
		const publishedAtCallback: { url?: string; libraryView?: string } = {};
		let observedNavigation: AfterNavigate | undefined;
		const callback = vi.fn((navigation: AfterNavigate) => {
			observedNavigation = navigation;
			publishedAtCallback.url = page.url.href;
			publishedAtCallback.libraryView = page.state.library?.libraryView;
		});
		afterNavigate(callback);
		await Promise.resolve();
		callback.mockClear();

		const navigation = goto('/queue?from=library', { state: timeline() });
		expect(page.url.pathname).toBe('/queue');
		expect(callback).not.toHaveBeenCalled();
		await navigation;

		expect(page.url.pathname).toBe('/queue');
		expect(page.url.search).toBe('?from=library');
		expect(page.state.library?.libraryView).toBe('timeline');
		expect(__getHistorySnapshot()).toMatchObject({
			index: 1,
			entries: [
				{ url: 'http://localhost/library', state: { library: { libraryView: 'classic' } } },
				{
					url: 'http://localhost/queue?from=library',
					state: { library: { libraryView: 'timeline' } }
				}
			]
		});
		expect(__getNavigationLog()).toMatchObject([
			{
				operation: 'goto',
				url: 'http://localhost/queue?from=library',
				state: { library: { libraryView: 'timeline' } }
			}
		]);
		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'goto',
				from: expect.objectContaining({ url: new URL('http://localhost/library') }),
				to: expect.objectContaining({ url: new URL('http://localhost/queue?from=library') })
			})
		);
		expect(observedNavigation?.to?.url.href).toBe(page.url.href);
		expect(observedNavigation?.to).not.toBeNull();
		expect(publishedAtCallback).toEqual({
			url: 'http://localhost/queue?from=library',
			libraryView: 'timeline'
		});
	});

	it('replaces the current route entry when goto requests replaceState', async () => {
		await goto('/queue', { state: timeline() });
		await goto('/library?restored=true', { replaceState: true, state: classic() });

		expect(__getHistorySnapshot()).toMatchObject({
			index: 1,
			entries: [
				{ url: 'http://localhost/library', state: { library: { libraryView: 'classic' } } },
				{
					url: 'http://localhost/library?restored=true',
					state: { library: { libraryView: 'classic' } }
				}
			]
		});
		expect(page.url.href).toBe('http://localhost/library?restored=true');
		expect(__getNavigationLog().map((entry) => entry.operation)).toEqual(['goto', 'goto']);
	});

	it('does not retain caller mutations in page state or logs', () => {
		const next = timeline();
		pushState('', next);
		next.library.snapshot.artistQuery = 'mutated after push';

		expect(page.state.library?.libraryView).toBe('timeline');
		if (page.state.library?.libraryView === 'timeline') {
			expect(page.state.library.snapshot.artistQuery).toBe('');
		}

		const log = __getNavigationLog();
		log[0].state = classic();
		expect(__getNavigationLog()[0].state.library?.libraryView).toBe('timeline');
	});
});
