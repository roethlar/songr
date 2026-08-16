import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	__getNavigationLog,
	__resetNavigation,
	__setRouterInitialized,
	pushState
} from '../../../test/app-stubs/navigation';
import {
	buildLibraryPageStateEnvelope,
	buildUnifiedLibraryPageState,
	buildUnifiedRootPageState
} from '$lib/libraryPageState';
import { libraryViewHostStore } from '$lib/stores/libraryViewHostStore';

vi.mock('../UnifiedLibraryMode.svelte', async () => ({
	default: (await import('./fixtures/UnifiedHostProbe.svelte')).default
}));

import LibraryPage from '../+page.svelte';

const browseState = () =>
	buildUnifiedLibraryPageState({
		scope: 'browse',
		collectionDrill: null,
		itemTarget: null,
		filterText: 'Bowie',
		surpriseSeed: null
	});

describe('Unified-only Library host', () => {
	beforeEach(() => {
		__resetNavigation('http://localhost/library');
	});

	afterEach(() => {
		cleanup();
	});

	it('mounts Unified directly and publishes it as the active shell mode', async () => {
		const state = browseState();
		__resetNavigation('http://localhost/library', buildLibraryPageStateEnvelope(state));
		const { getByTestId } = render(LibraryPage);

		await waitFor(() => expect(getByTestId('unified-host-probe')).toBeInTheDocument());
		expect(getByTestId('unified-host-probe')).toHaveAttribute('data-scope', 'browse');
		expect(getByTestId('unified-host-probe')).toHaveAttribute('data-cause', 'initial');
		expect(get(libraryViewHostStore)).toEqual({ activeMode: 'unified' });
		expect(__getNavigationLog()).toEqual([]);
	});

	it('replaces retired Classic page state with the Unified root', async () => {
		__resetNavigation('http://localhost/library', {
			library: {
				libraryView: 'classic',
				schemaVersion: 1,
				snapshot: { context: { hierarchy: 'browse' }, history: [], forward: [] }
			}
		} as unknown as App.PageState);
		__setRouterInitialized(false);
		const { getByTestId } = render(LibraryPage);

		await waitFor(() => expect(__getNavigationLog()).toHaveLength(1));
		expect(__getNavigationLog()[0]).toMatchObject({
			operation: 'replaceState',
			state: { library: { libraryView: 'unified', snapshot: { scope: 'artists' } } }
		});
		expect(getByTestId('unified-host-probe')).toHaveAttribute('data-scope', 'artists');
	});

	it('restores a valid shallow Unified entry as a history-pop activation', async () => {
		__resetNavigation(
			'http://localhost/library',
			buildLibraryPageStateEnvelope(buildUnifiedRootPageState('artists'))
		);
		const { getByTestId } = render(LibraryPage);
		await waitFor(() => expect(getByTestId('unified-host-probe')).toBeInTheDocument());

		pushState('', buildLibraryPageStateEnvelope(browseState()));
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
