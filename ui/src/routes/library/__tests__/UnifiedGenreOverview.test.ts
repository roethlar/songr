import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import UnifiedGenreOverview from '../UnifiedGenreOverview.svelte';
import { GenrePreviewController, type GenrePreviewState } from '$lib/library/GenrePreviewController';
import { genrePage, genrePrefix, genreRow } from '../../../test/fixtures/genrePreviews';
import { genrePreviewMeasurement } from '../../../test/fixtures/genrePreviewMeasurement';

function previews(): GenrePreviewState {
	const controller = new GenrePreviewController({ read: vi.fn(), isCurrent: () => true, canRetry: () => true, onStale: vi.fn() });
	controller.setPage(genrePage(), 'gen-1', 1);
	const base = controller.snapshot();
	return { ...base, artist: { ...base.artist, phase: 'ready', preview: genrePrefix('artist', 5) },
		album: { ...base.album, phase: 'ready', preview: genrePrefix('album', 5, 1) } };
}
function mount(state = previews()) {
	const onCapacity = vi.fn(), onOpen = vi.fn(), onRetry = vi.fn();
	const result = render(UnifiedGenreOverview, { state, density: 'normal', onCapacity, onOpen, onRetry,
		hrefFor: (_source, row) => `/row/${row.ref.token}` });
	return { ...result, onCapacity, onOpen, onRetry };
}
describe('UnifiedGenreOverview', () => {
	let measurement: ReturnType<typeof genrePreviewMeasurement>;
	beforeEach(() => { measurement = genrePreviewMeasurement(); });
	afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
	it('shows Artists then Albums, heading-level More links and only the measured prefix in one capacity grid', async () => {
		const h = mount(); await waitFor(() => expect(screen.getAllByTestId('genre-preview-artist')).toHaveLength(3));
		expect(screen.getAllByRole('heading', { level: 3 }).map(node => node.textContent)).toEqual(['Artists', 'Albums']);
		expect(h.onCapacity).toHaveBeenLastCalledWith(3);
		expect(screen.getByTestId('genre-overview').style.getPropertyValue('--preview-capacity')).toBe('3');
		expect(screen.getAllByTestId('genre-preview-album')).toHaveLength(1);
		expect(screen.getByRole('link', { name: 'More albums' })).toHaveAttribute('href', '/row/albums');
		expect(screen.getByRole('link', { name: 'More artists' })).toHaveAttribute('href', '/row/artists');
		expect(screen.queryByText('artist 3')).toBeNull();
		expect(screen.getByTestId('genre-preview-album')).toHaveAttribute('title', 'album 0 — Exact Credit');
	});
	it('retains native modified and middle clicks; plain clicks use the exact section source', async () => {
		const state = previews(), h = mount(state);
		const item = await screen.findByRole('link', { name: /artist 0/ });
		await fireEvent.click(item, { ctrlKey: true }); await fireEvent.click(item, { metaKey: true }); await fireEvent.click(item, { button: 1 });
		expect(h.onOpen).not.toHaveBeenCalled(); await fireEvent.click(item);
		expect(h.onOpen).toHaveBeenLastCalledWith(state.artist.sourcePath, state.artist.preview!.rows[0]);
		await fireEvent.click(screen.getByRole('link', { name: 'More albums' }));
		expect(h.onOpen).toHaveBeenLastCalledWith(state.owner!.page.path, state.album.candidates[0]);
	});
	it('uses monograms for missing and failed artwork while keeping full names accessible', async () => {
		const state = previews();
		mount({ ...state, artist: { ...state.artist, preview: { ...state.artist.preview!, rows: state.artist.preview!.rows.map(row => ({ ...row, imageKey: 'broken' })) } } });
		const tile = (await screen.findAllByTestId('genre-preview-artist'))[0];
		await fireEvent.error(tile.querySelector('img')!);
		expect(within(tile).getByTestId('genre-preview-placeholder')).toHaveTextContent('A');
		expect(tile).toHaveAttribute('title', 'artist 0');
		expect(within(screen.getByTestId('genre-preview-album')).getByTestId('genre-preview-placeholder')).toBeVisible();
	});
	it('distinguishes loading, failure, empty and omitted without hiding a usable More', async () => {
		const state = previews(); const h = mount({ ...state, artist: { ...state.artist, phase: 'failed', preview: null, error: 'Busy Core' },
			album: { ...state.album, phase: 'loading', preview: null } });
		expect(screen.getByText('Busy Core')).toBeVisible(); expect(screen.queryByText(/No albums/)).toBeNull();
		expect(screen.getByText('Loading albums…')).toBeVisible(); expect(screen.getByRole('link', { name: 'More artists' })).toBeVisible();
		await fireEvent.click(screen.getByRole('button', { name: 'Retry artists preview' })); expect(h.onRetry).toHaveBeenCalledWith('artist');
		await h.rerender({ state: { ...state, artist: { ...state.artist, candidates: [], phase: 'omitted', preview: null },
			album: { ...state.album, preview: genrePrefix('album', 5, 0) } } });
		expect(screen.getByText(/did not provide an Artists/)).toBeVisible(); expect(screen.queryByRole('link', { name: 'More artists' })).toBeNull();
		expect(screen.getByText('No albums in this section.')).toBeVisible(); expect(screen.getByRole('link', { name: 'More albums' })).toBeVisible();
	});
	it('keeps ambiguous candidates, subgenres and factual extras below previews but not action rows', () => {
		const state = previews(); const a = genreRow('album-a', 'Albums', 'section'), b = genreRow('album-b', 'albums', 'section');
		const page = genrePage([a, b, genreRow('sub', 'Subgenre', 'genre'), genreRow('info', 'Roon fact', 'entry'), genreRow('play', 'Play Genre', 'action')]);
		mount({ ...state, owner: { ...state.owner!, page }, album: { ...state.album, phase: 'ambiguous', candidates: [a, b], preview: null } });
		expect(screen.getByText(/more than one Albums/)).toBeVisible();
		expect(screen.getByRole('link', { name: 'Albums' })).toHaveAttribute('href', '/row/album-a');
		expect(screen.getByRole('link', { name: 'albums' })).toHaveAttribute('href', '/row/album-b');
		expect(screen.getByRole('link', { name: 'Subgenre' })).toBeVisible(); expect(screen.getByText(/Roon fact/)).toBeVisible();
		expect(screen.queryByText('Play Genre')).toBeNull();
	});
	it('coalesces resize, observes density and owner changes, and tears down the observer', async () => {
		const h = mount(); await waitFor(() => expect(h.onCapacity).toHaveBeenCalledWith(3)); h.onCapacity.mockClear();
		measurement.resize(900); measurement.resize(700); measurement.resize(380);
		await waitFor(() => expect(h.onCapacity).toHaveBeenCalledTimes(1)); expect(h.onCapacity).toHaveBeenLastCalledWith(2);
		measurement.density(100, 8); await h.rerender({ density: 'compact' });
		await waitFor(() => expect(h.onCapacity).toHaveBeenLastCalledWith(3));
		h.onCapacity.mockClear(); await h.rerender({ state: previews() });
		await waitFor(() => expect(h.onCapacity).toHaveBeenCalledWith(3));
		h.unmount(); expect(measurement.observers.every(observer => observer.disconnected)).toBe(true);
		h.onCapacity.mockClear(); measurement.resize(800); expect(h.onCapacity).not.toHaveBeenCalled();
	});
	it('renders no focusable preview cards at zero width or with retired authority', async () => {
		measurement.resize(0); const state = previews(), h = mount(state);
		await waitFor(() => expect(h.onCapacity).toHaveBeenCalledWith(0)); expect(screen.queryByTestId('genre-preview-artist')).toBeNull();
		measurement.resize(556); await h.rerender({ state: { ...state, stale: true } });
		await waitFor(() => expect(screen.getAllByTestId('genre-preview-artist')).toHaveLength(3));
		expect(screen.queryAllByRole('link')).toHaveLength(0);
	});
});
