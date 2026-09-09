import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	__getNavigationLog,
	__resetNavigation,
	__setRouterInitialized,
	pushState
} from '../../../test/app-stubs/navigation';
import { __setTestPage } from '../../../test/app-stubs/state.svelte';
import { libraryViewHostStore } from '$lib/stores/libraryViewHostStore';
import { unifiedLibraryPrefsStore } from '$lib/stores/unifiedLibraryPrefsStore';

vi.mock('../UnifiedLibraryMode.svelte', async () => ({
	default: (await import('./fixtures/UnifiedHostProbe.svelte')).default
}));

import LibraryPage from '../+page.svelte';
import DeepLibraryPage from '../[...path]/+page.svelte';

describe('Unified-only Library host', () => {
	beforeEach(() => {
		const preferences = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => preferences.get(key) ?? null,
			setItem: (key: string, value: string) => preferences.set(key, value),
			clear: () => preferences.clear()
		});
		window.history.replaceState({}, '', '/');
		__resetNavigation('http://localhost/library');
		unifiedLibraryPrefsStore.setArtistView('album-artists');
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('mounts Unified directly and publishes it as the active shell mode', async () => {
		__resetNavigation('http://localhost/library/browse?search=Bowie');
		const { getByTestId } = render(LibraryPage);

		await waitFor(() => expect(getByTestId('unified-host-probe')).toBeInTheDocument());
		expect(getByTestId('unified-host-probe')).toHaveAttribute('data-scope', 'browse');
		expect(getByTestId('unified-host-probe')).toHaveAttribute('data-cause', 'initial');
		expect(get(libraryViewHostStore)).toEqual({ activeMode: 'unified' });
		expect(__getNavigationLog()).toEqual([]);
	});

	it('uses the same host for a deep Library address', async () => {
		__resetNavigation('http://localhost/library/artists/Nornir%20Trio');
		const { getByTestId } = render(DeepLibraryPage);

		await waitFor(() => expect(getByTestId('unified-host-probe')).toBeInTheDocument());
		expect(get(libraryViewHostStore).activeMode).toBe('unified');
	});

	it('canonicalizes the Library root alias after router initialization', async () => {
		__resetNavigation('http://localhost/library');
		__setRouterInitialized(false);
		const { getByTestId } = render(LibraryPage);

		await waitFor(() => expect(__getNavigationLog()).toHaveLength(1));
		expect(__getNavigationLog()[0]).toEqual({
			operation: 'replaceState',
			url: 'http://localhost/library/album-artists',
			state: {}
		});
		expect(getByTestId('unified-host-probe')).toHaveAttribute('data-scope', 'artists');
	});

	it('restores a URL-only shallow entry as a history-pop activation', async () => {
		__resetNavigation('http://localhost/library/artists');
		const { getByTestId } = render(LibraryPage);
		await waitFor(() => expect(getByTestId('unified-host-probe')).toBeInTheDocument());

		pushState('/library/browse?search=Bowie', {});
		await waitFor(() =>
			expect(getByTestId('unified-host-probe')).toHaveAttribute('data-cause', 'history-pop')
		);
		expect(getByTestId('unified-host-probe')).toHaveAttribute('data-scope', 'browse');
	});

	it('canonicalizes bare entry to the remembered All artists choice', async () => {
		expect(unifiedLibraryPrefsStore.setArtistView('all-artists')).toBe(true);
		const { getByTestId } = render(LibraryPage);
		await waitFor(() => expect(__getNavigationLog()[0]?.url).toBe('http://localhost/library/artists'));
		expect(getByTestId('unified-host-probe')).toHaveAttribute('data-artist-view', 'all-artists');
	});

	it.each(['all-artists', 'album-artists'] as const)('does not reactively override the addressed view: %s', view => {
		__resetNavigation(`http://localhost/library/${view === 'all-artists' ? 'artists' : view}`);
		const { getByTestId } = render(LibraryPage);
		unifiedLibraryPrefsStore.setArtistView(view === 'all-artists' ? 'album-artists' : 'all-artists');
		return waitFor(() => {
			expect(getByTestId('unified-host-probe')).toHaveAttribute('data-artist-view', view);
			expect(__getNavigationLog()).toEqual([]);
		});
	});

	it('uses the address bar when a shallow pop republishes the mounted route URL', async () => {
		__resetNavigation('http://localhost/library/artists');
		const { getByTestId } = render(LibraryPage);
		await waitFor(() => expect(getByTestId('unified-host-probe')).toBeInTheDocument());

		window.history.replaceState({}, '', '/library/browse?search=Bowie');
		// This is the live static-fallback shape: SvelteKit republishes page
		// state, but page.url still names the route that mounted the host.
		__setTestPage('http://localhost/library/artists', {});

		await waitFor(() =>
			expect(getByTestId('unified-host-probe')).toHaveAttribute('data-cause', 'history-pop')
		);
		expect(getByTestId('unified-host-probe')).toHaveAttribute('data-scope', 'browse');
	});

	it('clears shell ownership when the host unmounts', async () => {
		const view = render(LibraryPage);
		await waitFor(() => expect(get(libraryViewHostStore).activeMode).toBe('unified'));

		view.unmount();
		expect(get(libraryViewHostStore)).toEqual({ activeMode: null });
	});
});
