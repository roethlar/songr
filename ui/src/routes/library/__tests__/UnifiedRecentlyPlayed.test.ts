import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { get, writable } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { activeLibraryScreen } from '../../../test/activeLibraryQueries';
import { UnifiedSongActionController } from '$lib/library/UnifiedSongActionController';
import type { PaletteSearchState } from '$lib/stores/unifiedPaletteSearchStore';
import UnifiedScopeViews from '../UnifiedScopeViews.svelte';
import { fakeRecentStore, harnessLibrary, mountMode } from './unifiedLibraryModeHarness';

describe('Recently played navigation', () => {
	it('finds the recorded title and opens the selected current song without starting playback', async () => {
		const paletteSearchStore = writable<PaletteSearchState>({ phase: 'idle', query: '', groups: [], error: null });
		const search = vi.fn(async (_claim, query: string) => {
			paletteSearchStore.set({ phase: 'ready', query, groups: [{ title: 'Tracks', rows: [{
				resultId: 'current-public-result', title: 'A Recent Track', subtitle: 'Reference Artist', imageKey: null
			}] }], error: null });
		});
		const action = vi.fn().mockResolvedValue({ authorityRetired: false });
		const relationship = vi.fn().mockResolvedValue({ songTitle: 'A Recent Track', albums: [], composerLabels: [] });
		const harness = mountMode({ liveLibrary: harnessLibrary(), recentStore: fakeRecentStore(), paletteSearchStore,
			searchPaletteData: search, songRelationshipClient: { relationship },
			songActionController: new UnifiedSongActionController({ action }) });
		await fireEvent.click(screen.getByTestId('unified-scope-recently-played'));
		const card = activeLibraryScreen.getByText('A Recent Track').closest('button')!;
		expect(card).toBeEnabled();
		await fireEvent.click(card);
		expect(screen.getByTestId('unified-palette-input')).toHaveValue('A Recent Track');
		await waitFor(() => expect(search).toHaveBeenCalledWith(expect.anything(), 'A Recent Track'));
		expect(action).not.toHaveBeenCalled();
		expect(relationship).not.toHaveBeenCalled();
		expect(harness.openLiveRef).not.toHaveBeenCalled();
		const result = within(screen.getByTestId('unified-palette')).getByText('A Recent Track').closest('a,button')!;
		await fireEvent.click(result);
		await waitFor(() => expect(screen.getByTestId('unified-song-title')).toHaveTextContent('A Recent Track'));
		expect(relationship).toHaveBeenCalledWith(expect.anything(), 'current-public-result');
		expect(action).not.toHaveBeenCalled();
		expect(harness.openLiveRef).not.toHaveBeenCalled();
	});

	it('uses the recorded artist only when the title is absent', async () => {
		const recentStore = fakeRecentStore();
		recentStore.update(state => ({ ...state, entries: state.entries.map(entry => ({ ...entry, title: '  ' })) }));
		const search = vi.fn(async () => {});
		mountMode({ liveLibrary: harnessLibrary(), recentStore, searchPaletteData: search });
		await fireEvent.click(screen.getByTestId('unified-scope-recently-played'));
		const card = activeLibraryScreen.getByText('Reference Artist').closest('button')!;
		expect(card).toBeEnabled();
		await fireEvent.click(card);
		expect(screen.getByTestId('unified-palette-input')).toHaveValue('Reference Artist');
		await waitFor(() => expect(search).toHaveBeenCalledWith(expect.anything(), 'Reference Artist'));
	});

	it('does not invent a track or album target when both title and artist are absent', async () => {
		const recentStore = fakeRecentStore();
		recentStore.update(state => ({ ...state, entries: state.entries.map(entry => ({ ...entry, title: '', artist: '' })) }));
		const search = vi.fn(async () => {});
		mountMode({ liveLibrary: harnessLibrary(), recentStore, searchPaletteData: search });
		await fireEvent.click(screen.getByTestId('unified-scope-recently-played'));
		const card = activeLibraryScreen.getByText('Unknown track').closest('button')!;
		expect(card).toBeDisabled();
		await fireEvent.click(card);
		expect(screen.queryByTestId('unified-palette')).toBeNull();
		expect(search).not.toHaveBeenCalled();
	});

	it('keeps scope captions free of implementation notes and explains partial counts briefly', async () => {
		const rendered = render(UnifiedScopeViews, { scope: 'recently-played', artists: [],
			albums: [{ id: 'fixture-album', title: 'Fixture Album', artist: 'Fixture Artist', searchKey: 'fixture album' }],
			sorts: { artists: 'az', albums: 'az', genres: 'az' }, railTarget: null,
			recent: get(fakeRecentStore()), genres: { entries: [{ label: 'Jazz', albumCount: 200,
				itemKey: 'genre-jazz', imageKey: null }], totalCount: 1, loading: false, loaded: true, error: null } });
		expect(screen.queryByText(/Only what this controller watched|Roon does not share/)).toBeNull();
		await rendered.rerender({ scope: 'recently-played', recent: { entries: [], loading: false, loaded: true } });
		expect(screen.getByText('No recent plays yet.')).toBeInTheDocument();
		expect(screen.queryByText(/controller is running/)).toBeNull();
		await rendered.rerender({ scope: 'surprise' });
		expect(screen.getByText('Fixture Album')).toBeInTheDocument();
		expect(screen.queryByText(/nothing knows what you have heard|Re-select the chip/)).toBeNull();
		await rendered.rerender({ scope: 'genres' });
		expect(screen.queryByText(/Roon.s page bound|not the full genre/)).toBeNull();
		expect(screen.getByText('60+ ALBUMS')).toBeInTheDocument();
		expect(screen.getByText('+ means at least this many albums.')).toBeInTheDocument();
		await rendered.rerender({ genres: { entries: [{ label: 'Jazz', albumCount: 12, itemKey: 'genre-jazz', imageKey: null }],
			totalCount: 1, loading: false, loaded: true, error: null } });
		expect(screen.queryByText('+ means at least this many albums.')).toBeNull();
	});
});
