import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { writable } from 'svelte/store';

import UnifiedPalette from '../UnifiedPalette.svelte';
import {
	CATALOG_CAPABILITIES,
	INCOMPLETE_ARTIST_COUNTS_CAPABILITIES,
	type LibraryArtistEntry,
	type LibraryAlbumEntry,
	type LibraryIndexState
} from '$lib/stores/libraryIndexStore';
import type { NamedCountsState } from '$lib/stores/unifiedNamedCountsStore';
import type {
	PaletteSearchState,
	unifiedPaletteSearchStore
} from '$lib/stores/unifiedPaletteSearchStore';
import { NO_RELEASE_DATES_REASON } from '$lib/unifiedLibrarySorts';
import { syntheticStatus } from '$lib/stores/__tests__/libraryIndexFixtures';

function artist(name: string, albumCount: number, i: number): LibraryArtistEntry {
	return {
		id: `art-${i}`,
		name,
		searchKey: name.toLowerCase(),
		albumCount,
		countComplete: true,
		catalogLocalId: `art-${i}`
	};
}

function album(title: string, artistName: string, i: number): LibraryAlbumEntry {
	return {
		id: `alb-${i}`,
		title,
		artist: artistName,
		searchKey: `${title.toLowerCase()} ${artistName.toLowerCase()}`,
		catalogLocalId: `alb-${i}`
	};
}

function readyIndex(over: Partial<LibraryIndexState> = {}): LibraryIndexState {
	const artists = [
		artist('Bowie Prime', 40, 0),
		artist('Bowie Second', 2, 1),
		...Array.from({ length: 10 }, (_, i) => artist(`Bowie Extra ${i}`, 1, i + 2)),
		artist('Someone Else', 5, 20)
	];
	return {
		phase: 'ready',
		source: 'catalog',
		coreId: 'core-a',
		revision: 1,
		status: syntheticStatus(),
		artists,
		albums: [album('Bowie Tribute', 'Someone Else', 0), album('Quiet Album', 'Someone Else', 1)],
		artistBuckets: [],
		albumBuckets: [],
		capabilities: CATALOG_CAPABILITIES,
		truncated: false,
		error: null,
		...over
	};
}

function namedCounts(labels: readonly string[]): NamedCountsState {
	return {
		entries: labels.map((label) => ({
			label,
			albumCount: 7,
			itemKey: `key-${label}`,
			imageKey: null
		})),
		totalCount: labels.length,
		loading: false,
		loaded: true,
		error: null
	};
}

const EMPTY_NAMED: NamedCountsState = {
	entries: [],
	totalCount: 0,
	loading: false,
	loaded: false,
	error: null
};

function idleSearch(): PaletteSearchState {
	return { phase: 'idle', query: '', groups: [], error: null };
}

function mountPalette(options: {
	index?: LibraryIndexState;
	genres?: NamedCountsState;
	composers?: NamedCountsState;
	search?: PaletteSearchState;
	seed?: string;
} = {}) {
	const searchStore = writable<PaletteSearchState>(options.search ?? idleSearch());
	const onClose = vi.fn();
	const onDrill = vi.fn();
	const onSong = vi.fn();
	const onApplyFilter = vi.fn();
	const onSearch = vi.fn();
	const result = render(UnifiedPalette, {
		props: {
			index: options.index ?? readyIndex(),
			genres: options.genres ?? EMPTY_NAMED,
			composers: options.composers ?? EMPTY_NAMED,
			searchStore: searchStore as unknown as typeof unifiedPaletteSearchStore,
			query: options.seed ?? '',
			selectedRowId: null,
			onClose,
			onDrill,
			onSong,
			onApplyFilter,
			onSearch
		}
	});
	return { ...result, searchStore, onClose, onDrill, onSong, onApplyFilter, onSearch };
}

function input(): HTMLInputElement {
	return screen.getByTestId('unified-palette-input') as HTMLInputElement;
}

describe('UnifiedPalette — instant sections', () => {
	it('emits the literal prototype palette frame, row classes, icons, and key hint', () => {
		mountPalette({ seed: 'bowie' });

		const palette = screen.getByTestId('unified-palette');
		expect(palette).toHaveClass('pal', 'open');
		expect(palette.querySelector('.palbox')).toHaveAttribute('role', 'dialog');
		expect(screen.getByTestId('unified-palette-results')).toHaveClass('pres');
		expect(screen.getAllByTestId('unified-palette-group')[0]).toHaveClass('pgl');

		const firstRow = screen.getAllByTestId('unified-palette-row')[0];
		expect(firstRow).toHaveClass('prow', 'sel');
		expect(firstRow.querySelector('.ic')).toHaveTextContent('♪');
		expect(firstRow.querySelector('.p1')).toHaveTextContent('Bowie Prime');
		expect(firstRow.querySelector('.p2')).toHaveTextContent('40 albums');
		expect(palette.querySelector('.palhint')).toHaveTextContent(
			'↑↓ SELECT · ⏎ OPEN · ESC CLOSE'
		);
	});

	it('renders TRY seeds when empty and seeds the query on click', async () => {
		mountPalette();

		const seeds = screen.getAllByTestId('unified-palette-seed');
		expect(seeds.map((el) => el.querySelector('.p1')?.textContent?.trim())).toEqual([
			'bowie',
			'>30 albums',
			'one album',
			'jazz',
			'1984-1989'
		]);

		await fireEvent.click(seeds[0]);
		expect(input().value).toBe('bowie');
		await waitFor(() => {
			expect(screen.getAllByTestId('unified-palette-group').length).toBeGreaterThan(0);
		});
	});

	it('labels truncated artist sections with FIRST N OF M and drills on activation', async () => {
		const harness = mountPalette({ seed: 'bowie' });

		const groups = screen.getAllByTestId('unified-palette-group');
		const artistGroup = groups.find((el) => el.textContent?.startsWith('ARTISTS'));
		expect(artistGroup?.textContent).toBe('ARTISTS — FIRST 8 OF 12');

		const rows = screen.getAllByTestId('unified-palette-row');
		const bowieRow = rows.find((el) => el.textContent?.includes('Bowie Prime'));
		expect(bowieRow).toBeDefined();
		expect(bowieRow?.textContent).toContain('40 albums');
		await fireEvent.click(bowieRow!);
		expect(harness.onDrill).toHaveBeenCalledWith({ kind: 'artist', localId: 'art-0' });
	});

	it('pluralizes artist album counts on the count, not on a fixed noun', async () => {
		mountPalette({ seed: 'bowie' });

		const rows = screen.getAllByTestId('unified-palette-row');
		const singularRow = rows.find((el) => el.textContent?.includes('Bowie Extra 0'));
		expect(singularRow?.querySelector('.p2')).toHaveTextContent('1 album');
		expect(singularRow?.querySelector('.p2')?.textContent).not.toContain('albums');

		const pluralRow = rows.find((el) => el.textContent?.includes('Bowie Second'));
		expect(pluralRow?.querySelector('.p2')).toHaveTextContent('2 albums');
	});

	it('pluralizes genre-card album counts the same way (1 ALBUM, not 1 ALBUMS)', () => {
		mountPalette({
			seed: 'jazz',
			genres: {
				entries: [{ label: 'Jazz Solo', albumCount: 1, itemKey: 'key-1', imageKey: null }],
				totalCount: 1,
				loading: false,
				loaded: true,
				error: null
			}
		});

		const genreRow = screen
			.getAllByTestId('unified-palette-row')
			.find((el) => el.textContent?.includes('Jazz Solo'));
		expect(genreRow?.querySelector('.p2')).toHaveTextContent('1 ALBUM');
		expect(genreRow?.querySelector('.p2')?.textContent).not.toContain('ALBUMS');
	});

	it('matches albums, genres, and composers through their semantic destinations', async () => {
		const harness = mountPalette({
			seed: 'jazz',
			genres: namedCounts(['Jazz', 'Jazz Fusion', 'Jazz Pop', 'Jazz Rock', 'Jazz Vocal']),
			composers: namedCounts(['Jazz Composer'])
		});

		const groups = screen.getAllByTestId('unified-palette-group');
		expect(groups.map((el) => el.textContent)).toContain('GENRES');
		expect(groups.some((el) => el.textContent?.startsWith('GENRES —'))).toBe(false);
		expect(groups.map((el) => el.textContent)).toContain('COMPOSERS');
		const rows = screen.getAllByTestId('unified-palette-row');
		const genreRow = rows.find((el) => el.textContent?.includes('Jazz Fusion'));
		expect(genreRow?.querySelector('.p1')).toHaveTextContent('Genre: Jazz Fusion');
		expect(genreRow?.querySelector('.p2')).toHaveTextContent('7 ALBUMS');
		await fireEvent.click(genreRow!);
		expect(harness.onDrill).toHaveBeenCalledWith({ kind: 'genre', label: 'Jazz Fusion' });

		const composerRow = rows.find((el) => el.textContent?.includes('Jazz Composer'));
		expect(composerRow?.querySelector('.p1')).toHaveTextContent('Composer: Jazz Composer');
		await fireEvent.click(composerRow!);
		expect(harness.onDrill).toHaveBeenCalledWith({
			kind: 'composer',
			label: 'Jazz Composer'
		});
	});

	it('keeps large instant-result totals ungrouped like the prototype', () => {
		mountPalette({
			seed: 'matching',
			index: readyIndex({
				albums: Array.from({ length: 1_001 }, (_, i) =>
					album(`Matching Album ${i}`, 'Someone Else', i)
				)
			})
		});

		const groups = screen.getAllByTestId('unified-palette-group');
		const albumGroup = groups.find((el) => el.textContent?.startsWith('ALBUMS'));
		expect(albumGroup?.textContent).toBe('ALBUMS — FIRST 8 OF 1001');
	});

	it('opens an album drill from an album row', async () => {
		const harness = mountPalette({ seed: 'quiet' });

		const rows = screen.getAllByTestId('unified-palette-row');
		const albumRow = rows.find((el) => el.textContent?.includes('Quiet Album'));
		await fireEvent.click(albumRow!);
		expect(harness.onDrill).toHaveBeenCalledWith({ kind: 'album', localId: 'alb-1' });
	});
});

describe('UnifiedPalette — smart filters', () => {
	it('shows a live count-filter row and applies canonical text', async () => {
		const harness = mountPalette({ seed: '>30   albums' });

		const rows = screen.getAllByTestId('unified-palette-row');
		const filterRow = rows.find((el) =>
			el.textContent?.includes('Artists with more than 30 albums')
		);
		expect(filterRow).toBeDefined();
		// Exactly one artist (Bowie Prime, 40) exceeds 30 albums.
		expect(filterRow?.textContent).toContain('1 artists');
		await fireEvent.click(filterRow!);
		expect(harness.onApplyFilter).toHaveBeenCalledWith('>30 albums');
	});

	it('gates count filters on incomplete Roon artist-count coverage', () => {
		mountPalette({
			seed: 'one album',
			index: readyIndex({ capabilities: INCOMPLETE_ARTIST_COUNTS_CAPABILITIES })
		});

		const rows = screen.getAllByTestId('unified-palette-row');
		const filterRow = rows.find((el) =>
			el.textContent?.includes('Artists with exactly one album')
		);
		expect(filterRow).toBeDefined();
		expect(filterRow).toBeDisabled();
		expect(filterRow?.textContent).toContain(
			INCOMPLETE_ARTIST_COUNTS_CAPABILITIES.countFiltersDisabledReason
		);
	});

	it('always renders year expressions disabled with the no-release-dates reason', () => {
		mountPalette({ seed: '1984-1989' });

		const rows = screen.getAllByTestId('unified-palette-row');
		const yearRow = rows.find((el) => el.textContent?.includes('Release years'));
		expect(yearRow).toBeDefined();
		expect(yearRow).toBeDisabled();
		expect(yearRow?.textContent).toContain(NO_RELEASE_DATES_REASON);
	});
});

describe('UnifiedPalette — async coordinated section', () => {
	it('renders every song as an actionable opaque row without artwork matching', async () => {
		const harness = mountPalette({
			seed: 'bowie',
			index: readyIndex({
				albums: [
					{
						...album('Scary Monsters', 'David Bowie', 0),
						imageKey: 'scary-monsters-image'
					}
				]
			}),
			search: {
				phase: 'ready',
				query: 'bowie',
				groups: [
					{
						title: 'Tracks',
						rows: [
									{
										resultId: 'song-ashes',
										title: 'Ashes to Ashes',
								subtitle: 'David Bowie',
								imageKey: 'scary-monsters-image'
							},
									{
										resultId: 'song-fame',
										title: 'Fame',
										subtitle: 'David Bowie',
										imageKey: null
									}
						]
					}
				],
				error: null
			}
		});

		const groups = screen.getAllByTestId('unified-palette-group');
		const asyncGroup = groups.find((el) => el.textContent?.startsWith('SONGS'));
		expect(asyncGroup?.textContent).toBe('SONGS');
		const rows = screen.getAllByTestId('unified-palette-row');
		const trackRow = rows.find((el) => el.textContent?.includes('Ashes to Ashes'));
		expect(trackRow).toBeEnabled();
		expect(trackRow?.querySelector('.ic')).toHaveTextContent('♬');
		expect(trackRow?.querySelector('.p2')).toHaveTextContent('David Bowie');
		await fireEvent.click(trackRow!);
		expect(harness.onSong).toHaveBeenCalledWith(
			expect.objectContaining({ resultId: 'song-ashes', title: 'Ashes to Ashes' })
		);

		const unmatchedTrack = rows.find((el) => el.textContent?.includes('Fame'));
		expect(unmatchedTrack).toBeEnabled();
		await fireEvent.click(unmatchedTrack!);
		expect(harness.onSong).toHaveBeenCalledWith(
			expect.objectContaining({ resultId: 'song-fame', title: 'Fame' })
		);
	});

	it('keeps the selected row when live song results arrive later', async () => {
		const harness = mountPalette({
			seed: 'bowie',
			search: { phase: 'searching', query: 'bowie', groups: [], error: null }
		});
		const artistRow = screen
			.getAllByTestId('unified-palette-row')
			.find((row) => row.textContent?.includes('Bowie Second'))!;
		await fireEvent.mouseMove(artistRow);
		expect(artistRow).toHaveClass('sel');

		harness.searchStore.set({
			phase: 'ready',
			query: 'bowie',
			groups: [
				{
					title: 'Tracks',
					rows: [
						{
							resultId: 'song-new',
							title: 'New Song',
							subtitle: 'David Bowie',
							imageKey: null
						}
					]
				}
			],
			error: null
		});

		await waitFor(() => expect(screen.getByText('New Song')).toBeInTheDocument());
		expect(artistRow).toHaveClass('sel');
	});

	it('shows searching and error states honestly', async () => {
		const harness = mountPalette({
			seed: 'zz-no-local-match',
			search: { phase: 'searching', query: 'zz', groups: [], error: null }
		});
		expect(screen.getByTestId('unified-palette-searching')).toBeInTheDocument();

		harness.searchStore.set({
			phase: 'error',
			query: 'zz',
			groups: [],
			error: 'socket down'
		});
		await waitFor(() => {
			expect(screen.getByTestId('unified-palette-search-error').textContent).toContain(
				'socket down'
			);
		});
	});

	it('debounces query changes into onSearch', async () => {
		const harness = mountPalette();

		await fireEvent.input(input(), { target: { value: 'bowie' } });
		await waitFor(() => expect(harness.onSearch).toHaveBeenCalledWith('bowie'), {
			timeout: 2000
		});
	});

	it('does not repeat a retained song search when the same query remounts', async () => {
		const harness = mountPalette({
			seed: 'bowie',
			search: {
				phase: 'ready',
				query: 'bowie',
				groups: [
					{
						title: 'Tracks',
						rows: [
							{
								resultId: 'song-ashes',
								title: 'Ashes to Ashes',
								subtitle: 'David Bowie',
								imageKey: null
							}
						]
					}
				],
				error: null
			}
		});

		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(harness.onSearch).not.toHaveBeenCalled();
		expect(screen.getByText('Ashes to Ashes')).toBeInTheDocument();
	});
});

describe('UnifiedPalette — keyboard', () => {
	it('ArrowDown skips disabled rows and Enter activates the selection', async () => {
		const harness = mountPalette({ seed: '1984-1989' });
		// Rows: disabled year filter first, then no instant matches — add
		// an artist match by typing a real query instead.
		await fireEvent.input(input(), { target: { value: 'bowie second' } });

		await fireEvent.keyDown(input(), { key: 'ArrowDown' });
		await fireEvent.keyDown(input(), { key: 'Enter' });
		expect(harness.onDrill).toHaveBeenCalled();
	});

	it('Enter with no explicit selection activates the first enabled row', async () => {
		const harness = mountPalette({ seed: 'quiet album' });

		await fireEvent.keyDown(input(), { key: 'Enter' });
		expect(harness.onDrill).toHaveBeenCalledWith({ kind: 'album', localId: 'alb-1' });
	});

	it('Escape closes; backdrop click closes; palette click does not', async () => {
		const harness = mountPalette({ seed: 'bowie' });

		await fireEvent.keyDown(input(), { key: 'Escape' });
		expect(harness.onClose).toHaveBeenCalledTimes(1);

		await fireEvent.click(screen.getByTestId('unified-palette'));
		expect(harness.onClose).toHaveBeenCalledTimes(2);

		await fireEvent.click(input());
		expect(harness.onClose).toHaveBeenCalledTimes(2);
	});
});

describe('UnifiedPalette — keystroke budget at 40k entries (plan §3.2)', () => {
	it('renders instant results against 40k artists + 40k albums inside the budget', async () => {
		const artists = Array.from({ length: 40_000 }, (_, i) =>
			artist(`Artist ${i}${i % 500 === 0 ? ' zephyr' : ''}`, (i % 50) + 1, i)
		);
		const albums = Array.from({ length: 40_000 }, (_, i) =>
			album(`Album ${i}${i % 500 === 0 ? ' zephyr' : ''}`, `Artist ${i}`, i)
		);
		mountPalette({ index: readyIndex({ artists, albums }) });

		const started = performance.now();
		await fireEvent.input(input(), { target: { value: 'zephyr' } });
		const keystrokeMs = performance.now() - started;

		const groups = screen.getAllByTestId('unified-palette-group');
		const artistGroup = groups.find((el) => el.textContent?.startsWith('ARTISTS'));
		expect(artistGroup?.textContent).toBe('ARTISTS — FIRST 8 OF 80');
		// Generous CI budget; the point is catching accidental
		// super-linear work per keystroke, not micro-benchmarks.
		expect(keystrokeMs).toBeLessThan(1_000);
	});
});
