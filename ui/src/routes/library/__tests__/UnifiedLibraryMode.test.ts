import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/svelte';
import { get, writable } from 'svelte/store';
import UnifiedLibraryMode from '../UnifiedLibraryMode.svelte';
import {
	buildLibraryPageStateEnvelope,
	buildUnifiedLibraryPageState,
	buildUnifiedRootPageState,
	UNIFIED_LIBRARY_PAGE_STATE_VERSION,
	type BrowseHistorySnapshot
} from '$lib/libraryPageState';
import {
	CATALOG_CAPABILITIES,
	BROWSE_FALLBACK_CAPABILITIES,
	INCOMPLETE_ARTIST_COUNTS_CAPABILITIES,
	type LibraryAlbumEntry,
	type LibraryArtistEntry,
	type LibraryIndexState
} from '$lib/stores/libraryIndexStore';
import type { LibraryAlbumController, LibraryAlbumState } from '$lib/library/LibraryAlbumController';
import { UnifiedSongActionController } from '$lib/library/UnifiedSongActionController';
import { PublicSongActionController } from '$lib/library/PublicSongActionController';
import type { PublicSongResolverClient } from '$lib/publicSongResolverClient';
import type { UnifiedSearchClient } from '$lib/unifiedSearchClient';
import type { AlbumActionController } from '$lib/library/AlbumActionController';
import type {
	UnifiedBrowseActionController,
	UnifiedBrowseActionSource,
	UnifiedBrowseActionState,
	UnifiedBrowseController,
	UnifiedBrowseState
} from '$lib/library/UnifiedBrowseController';
import type { BrowseItem } from '@shared/types';
import { clearPendingLibraryPageStateWrite } from '$lib/libraryPageNavigation';
import { libraryScopeSlots } from '@libraryFeatures';
import {
	__back,
	__forward,
	__getHistorySnapshot,
	__getNavigationLog,
	__resetNavigation
} from '../../../test/app-stubs/navigation';
import { NO_GENRE_SORT_REASON, NO_IMPORT_DATES_REASON, NO_RELEASE_DATES_REASON } from '$lib/unifiedLibrarySorts';
import type { NamedCountEntry } from '$lib/stores/unifiedNamedCountsStore';
import type { DrillAlbum } from '$lib/stores/unifiedDrillStore';
import type { PublicSongResolution } from '@shared/publicSongResolverContracts';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import { settingsMenuOpen } from '$lib/stores/settingsMenuStore';
import { requestUnifiedLibraryDensity } from '$lib/stores/unifiedLibraryPrefsStore';
import { setCoreStatus } from '$lib/stores/coreStore';
import { setSocketStatus } from '$lib/stores/socketStatusStore';
import type { CommittedLibraryModeActivation } from '$lib/libraryModeActivationContext';
import { syntheticStatus } from '$lib/stores/__tests__/libraryIndexFixtures';
import type { ClassicBrowseSessionClaim } from '$lib/stores/classicBrowseSessionStore';
import type { PaletteSearchState } from '$lib/stores/unifiedPaletteSearchStore';
import {
	pendingLibraryIntentStore,
	publishLibraryIntent,
	resetLibraryIntentStore
} from '$lib/stores/libraryIntentStore';
import type { PlaylistContentsResponse, PlaylistSummaryView } from '@shared/playlistContracts';
import {
	albumEntry,
	artistEntries,
	bucketsFor,
	deferred,
	fakeConnectionSocket,
	fakeDrillStore,
	fakeModeActionController,
	fakeModeAlbumController,
	fakeMostPlayedStore,
	fakeNamedCountsStore,
	fakePlaylistsStore,
	fakePublicSongActionController,
	fakeRecentStore,
	fakeSessionClient,
	idleState,
	mountMode,
	readyState
} from './unifiedLibraryModeHarness';

function fakeBrowseController() {
	const rootSnapshot: BrowseHistorySnapshot = {
		context: { hierarchy: 'browse' },
		history: [],
		forward: []
	};
	const store = writable<UnifiedBrowseState>({
		phase: 'idle',
		result: null,
		snapshot: rootSnapshot,
		notice: null,
		error: null
	});
	const rootResult = {
		title: 'Browse',
		level: 0,
		offset: 0,
		count: 1,
		totalCount: 1,
		items: [
			{
				title: 'Library',
				itemKey: 'live-library-key',
				hint: 'list',
				isLoadable: true,
				isPlayable: false
			}
		]
	};
	const publish = (snapshot = rootSnapshot) => {
		store.set({ phase: 'ready', result: rootResult, snapshot, notice: null, error: null });
	};
	const restore = vi.fn(async (_claim, snapshot) => {
		publish(snapshot);
		return true;
	});
	const openItem = vi.fn(async (_claim, item: BrowseItem) => {
		const current = get(store).snapshot;
		publish({
			context: current.context,
			history: [
				...current.history,
				{ hierarchy: current.context.hierarchy, breadcrumb: { title: item.title } }
			],
			forward: []
		});
		return true;
	});
	const openSearchCategory = vi.fn(async (_claim, query: string, categoryTitle: string) => {
		publish({
			context: { hierarchy: 'search', query },
			history: [
				{
					hierarchy: 'search',
					breadcrumb: { title: categoryTitle, searchCategory: true }
				}
			],
			forward: []
		});
		return true;
	});
	const controller = {
		subscribe: store.subscribe,
		restore,
		openItem,
		openSearchCategory,
		openSearchResult: vi.fn(async () => true),
		back: vi.fn(async () => true),
		forward: vi.fn(async () => true),
		loadMore: vi.fn(async () => true),
		reset: vi.fn((snapshot = rootSnapshot) => {
			store.set({ phase: 'idle', result: null, snapshot, notice: null, error: null });
		})
	} as unknown as UnifiedBrowseController;
	return { controller, store, restore, openItem, openSearchCategory };
}

function fakeBrowseActionController() {
	const idle = (): UnifiedBrowseActionState => ({
		phase: 'idle',
		source: null,
		available: { 'play-now': false, 'add-next': false, queue: false },
		error: null
	});
	const store = writable<UnifiedBrowseActionState>(idle());
	const open = vi.fn(async (_claim, source: UnifiedBrowseActionSource) => {
		store.set({
			phase: 'ready',
			source,
			available: { 'play-now': true, 'add-next': true, queue: true },
			error: null
		});
		return true;
	});
	const execute = vi.fn(async () => true);
	const reset = vi.fn(() => store.set(idle()));
	return {
		controller: { subscribe: store.subscribe, open, execute, reset } as UnifiedBrowseActionController,
		store,
		open,
		execute,
		reset
	};
}

describe('UnifiedLibraryMode — lifecycle', () => {
	it('auto-resumes without a host context: claims unified-mode and loads the index', async () => {
		const harness = mountMode();

		expect(harness.session.claim).toHaveBeenCalledWith('unified-mode');
		await waitFor(() => expect(harness.loadIndex).toHaveBeenCalledTimes(1));
		expect(harness.fetchStatus).toHaveBeenCalledTimes(1);
		const [, loadOptions] = harness.loadIndex.mock.calls[0] as [
			unknown,
			{ coreId: string; claim: ClassicBrowseSessionClaim }
		];
		expect(loadOptions.coreId).toBe('core-a');
		expect(loadOptions.claim).toBe(harness.session.claim.mock.results[0]?.value);

		harness.unmount();
		expect(harness.resetIndex).toHaveBeenCalled();
		expect(harness.session.release).toHaveBeenCalledWith(
			harness.session.claim.mock.results[0]?.value
		);
	});

	it('registers the unified lifecycle and only resumes when the host says so', async () => {
		const harness = mountMode({ withContext: true });

		expect(harness.registered.mode).toBe('unified');
		expect(harness.session.claim).not.toHaveBeenCalled();
		expect(screen.getByText('Suspended.')).toBeInTheDocument();

		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedLibraryPageState({
				scope: 'genres',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await waitFor(() => expect(harness.session.claim).toHaveBeenCalledWith('unified-mode'));
		expect(screen.getByTestId('unified-scope-genres')).toHaveAttribute(
			'aria-pressed',
			'true'
		);

		harness.registered.lifecycle!.suspend();
		// The release and index reset are synchronous; only the DOM flush waits.
		expect(harness.resetIndex).toHaveBeenCalled();
		expect(harness.session.release).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.getByText('Suspended.')).toBeInTheDocument());
	});

	it('drops a status fetch that resolves after suspend', async () => {
		const status = deferred<ReturnType<typeof syntheticStatus>>();
		const harness = mountMode({
			withContext: true,
			fetchStatus: () => status.promise
		});

		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedLibraryPageState({
				scope: 'artists',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await waitFor(() => expect(harness.fetchStatus).toHaveBeenCalledTimes(1));

		harness.registered.lifecycle!.suspend();
		status.resolve(syntheticStatus({ coreId: 'core-a' }));
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.loadIndex).not.toHaveBeenCalled();
	});

	it('retries the initial index load after the socket connects', async () => {
		const socket = fakeConnectionSocket();
		const playlistActionController = fakePublicSongActionController();
		const harness = mountMode({
			getSocketClient: () => socket,
			playlistActionController
		});

		await waitFor(() => expect(harness.loadIndex).toHaveBeenCalledTimes(1));
		socket.connected = true;
		socket.emit('connect');

		await waitFor(() => expect(harness.session.recover).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(harness.loadIndex).toHaveBeenCalledTimes(2));
		expect(harness.session.recover).toHaveBeenCalledWith(
			harness.session.claim.mock.results[0]?.value
		);

		socket.connected = false;
		socket.emit('disconnect');
		expect(harness.session.connectionLost).toHaveBeenCalledWith(
			harness.session.claim.mock.results[0]?.value
		);
		expect(playlistActionController.abandon).toHaveBeenCalledTimes(1);

		harness.unmount();
		socket.connected = true;
		socket.emit('connect');
		expect(harness.session.recover).toHaveBeenCalledTimes(1);
	});
});

describe('UnifiedLibraryMode — shell', () => {
	it('renders load, error, and ready states with the degraded-notice rule', async () => {
		const harness = mountMode({
			indexState: { ...idleState(), phase: 'loading' }
		});
		expect(screen.getByTestId('unified-loading')).toBeInTheDocument();

		harness.indexStore.set({ ...idleState(), phase: 'error', error: 'boom' });
		await waitFor(() =>
			expect(screen.getByTestId('unified-error')).toHaveTextContent('boom')
		);

		harness.indexStore.set(readyState());
		await waitFor(() =>
			expect(screen.getByTestId('unified-summary')).toHaveTextContent('50 TOTAL')
		);
		expect(screen.queryByTestId('unified-degraded-notice')).toBeNull();

		harness.indexStore.set(
			readyState({
				source: 'browse',
				revision: null,
				capabilities: BROWSE_FALLBACK_CAPABILITIES,
				truncated: true
			})
		);
		await waitFor(() =>
			expect(screen.getByTestId('unified-degraded-notice')).toBeInTheDocument()
		);
		expect(screen.getByTestId('unified-summary')).toHaveTextContent('(truncated)');
	});

	it('exposes only working scope chips and reports their totals', async () => {
		const genresStore = fakeNamedCountsStore([
			{ label: 'Jazz', albumCount: 7, itemKey: 'genre:jazz', imageKey: null },
			{ label: 'Rock', albumCount: 9, itemKey: 'genre:rock', imageKey: null }
		]);
		mountMode({
			indexState: readyState({
				albums: [
					albumEntry('alb-1', 'Arrival', 'art-0'),
					albumEntry('alb-2', 'Blue', 'art-1')
				]
			}),
			genresStore
		});

		const scopeNav = screen.getByRole('navigation', { name: 'Library scope' });
		expect(Array.from(scopeNav.querySelectorAll('.sc'), (chip) => chip.textContent)).toEqual([
			'Artists',
			'Albums',
			'Genres',
			'Browse',
			'Recently played',
			'Favorites',
			'Surprise me',
			// Whatever workspace links this build's slot resolution provides
			// render after the chips; a public resolution provides none.
			...libraryScopeSlots.workspaceLinks.map((link) => link.label)
		]);
		expect(screen.queryByText('Most played')).toBeNull();
		expect(screen.queryByText('Recently added')).toBeNull();
		expect(screen.queryByText(/Roon exposes no play counts/)).toBeNull();
		expect(screen.queryByTestId('unified-scope-composers')).toBeNull();
		expect(screen.getByTestId('unified-summary')).toHaveTextContent('50 TOTAL');
		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(screen.getByTestId('unified-summary')).toHaveTextContent('2 TOTAL');

		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await waitFor(() => expect(screen.getByTestId('unified-summary')).toHaveTextContent('2 TOTAL'));
	});

	it('re-homes Favorites listing, search activation, and removal in Unified', async () => {
		const favoritesStore = writable({
			entries: [
				{
					id: 'favorite-1',
					type: 'track' as const,
					title: 'Heroes',
					artist: 'David Bowie',
					added_at: '2026-08-10T00:00:00.000Z'
				}
			],
			loading: false,
			loaded: true
		});
		const removeFavoriteData = vi.fn(async (_fetchFn, id: string) => {
			favoritesStore.update((state) => ({
				...state,
				entries: state.entries.filter((favorite) => favorite.id !== id)
			}));
		});
		mountMode({ indexState: readyState(), favoritesStore, removeFavoriteData });

		await fireEvent.click(screen.getByTestId('unified-scope-favorites'));
		expect(screen.getByTestId('unified-favorites-view')).toHaveTextContent('Heroes');
		await fireEvent.click(screen.getByRole('button', { name: 'Search favorite Heroes' }));
		expect(screen.getByTestId('unified-palette-input')).toHaveValue('Heroes');
		await fireEvent.keyDown(window, { key: 'Escape' });
		await fireEvent.click(screen.getByRole('button', { name: 'Remove Heroes from favorites' }));

		expect(removeFavoriteData).toHaveBeenCalledWith(expect.anything(), 'favorite-1');
		await waitFor(() => expect(screen.getByTestId('unified-favorites-empty')).toBeInTheDocument());
	});

	it('shows the A–Z rail only at 3+ letters and 40+ items, per scope', async () => {
		const genreEntries = Array.from({ length: 42 }, (_, index) => ({
			label: `${'abc'[index % 3]} genre ${index}`,
			albumCount: 1,
			itemKey: `genre:${index}`,
			imageKey: null
		}));
		const harness = mountMode({
			indexState: readyState(),
			genresStore: fakeNamedCountsStore(genreEntries)
		});

		await waitFor(() => expect(screen.getByTestId('unified-rail')).toBeInTheDocument());

		// Genres has its own live-data buckets and preserves the reference rail.
		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await waitFor(() => expect(screen.getByTestId('unified-rail')).toBeInTheDocument());

		// Albums scope has no entries — the rail must hide.
		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(screen.queryByTestId('unified-rail')).toBeNull();

		// Back to artists, but with too few items.
		await fireEvent.click(screen.getByTestId('unified-scope-artists'));
		const few = artistEntries(10);
		harness.indexStore.set(
			readyState({ artists: few, artistBuckets: bucketsFor(few) })
		);
		await waitFor(() => expect(screen.queryByTestId('unified-rail')).toBeNull());

		// Enough items but under 3 letters — still hidden.
		const twoLetters = artistEntries(50).map((entry, i) => {
			const name = `${i % 2 === 0 ? 'a' : 'b'} artist ${i}`;
			return { ...entry, name, searchKey: name };
		});
		const sorted = [...twoLetters].sort((a, b) => (a.searchKey < b.searchKey ? -1 : 1));
		harness.indexStore.set(
			readyState({ artists: sorted, artistBuckets: bucketsFor(sorted) })
		);
		await waitFor(() => expect(screen.queryByTestId('unified-rail')).toBeNull());
	});

	it('wires sort to the persisted prefs store per scope and leaves density out of the bar', async () => {
		const harness = mountMode({ indexState: readyState() });

		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-za'));
		expect(get(harness.prefsStore).sorts.artists).toBe('za');

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-shuffle'));
		expect(get(harness.prefsStore).sorts.albums).toBe('shuffle');
		expect(get(harness.prefsStore).sorts.artists).toBe('za');

		await fireEvent.click(screen.getByTestId('unified-scope-recently-played'));
		expect(screen.queryByTestId('unified-sort')).toBeNull();
		expect(screen.queryByRole('group', { name: 'Density' })).toBeNull();
	});
});

describe('UnifiedLibraryMode — P2 Browse and full-category search', () => {
	beforeEach(() => {
		clearPendingLibraryPageStateWrite();
		__resetNavigation();
		setZonesSnapshot([
			{
				zone_id: 'zone-1',
				display_name: 'Living Room',
				state: 'paused',
				is_play_allowed: true,
				is_pause_allowed: true,
				is_previous_allowed: true,
				is_next_allowed: true,
				is_seek_allowed: true,
				outputs: []
			}
		]);
	});

	it('uses the existing Unified claim and records only semantic Browse history', async () => {
		const browse = fakeBrowseController();
		const harness = mountMode({
			indexState: readyState(),
			browseController: browse.controller
		});

		await fireEvent.click(screen.getByTestId('unified-scope-browse'));
		await waitFor(() => expect(browse.restore).toHaveBeenCalledTimes(1));
		expect(harness.session.claim).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('unified-browse-view')).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Open Library' }));
		await waitFor(() => expect(browse.openItem).toHaveBeenCalledTimes(1));

		const navigation = __getNavigationLog();
		const latest = navigation.at(-1)?.state as {
			library?: { snapshot?: { scope?: string; browseHistory?: unknown } };
		};
		expect(latest.library?.snapshot?.scope).toBe('browse');
		expect(latest.library?.snapshot?.browseHistory).toEqual({
			context: { hierarchy: 'browse' },
			history: [{ hierarchy: 'browse', breadcrumb: { title: 'Library' } }],
			forward: []
		});
		expect(JSON.stringify(latest.library?.snapshot?.browseHistory)).not.toContain(
			'live-library-key'
		);
	});

	it('restores a persisted search hierarchy through the injected semantic controller', async () => {
		const browse = fakeBrowseController();
		const harness = mountMode({
			withContext: true,
			indexState: readyState(),
			browseController: browse.controller
		});
		const browseHistory = {
			context: { hierarchy: 'search' as const, query: 'bowie' },
			history: [
				{
					hierarchy: 'search' as const,
					breadcrumb: { title: 'Albums', searchCategory: true as const }
				}
			],
			forward: []
		};

		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: buildUnifiedLibraryPageState({
				scope: 'browse',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null,
				browseHistory
			})
		} as CommittedLibraryModeActivation);

		await waitFor(() =>
			expect(browse.restore).toHaveBeenCalledWith(
				expect.anything(),
				browseHistory,
				'zone-1'
			)
		);
		expect(screen.getByTestId('unified-scope-browse')).toHaveAttribute('aria-pressed', 'true');
	});

	it('moves See All into the persisted semantic search hierarchy', async () => {
		const browse = fakeBrowseController();
		const paletteSearchStore = writable<PaletteSearchState>({
			phase: 'ready',
			query: 'bowie',
			groups: [],
			browseGroups: [
				{
					title: 'Albums',
					categoryTitle: 'Albums',
					resultType: 'album',
					total: 9,
					rows: [
						{
							title: 'Low',
							subtitle: 'David Bowie',
							hint: 'action_list',
							isLoadable: false,
							isPlayable: false,
							resultType: 'album',
							categoryTitle: 'Albums'
						}
					]
				}
			],
			error: null
		});
		mountMode({
			indexState: readyState(),
			browseController: browse.controller,
			paletteSearchStore,
			clearPaletteSearchData: vi.fn(async () => {})
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'bowie' }
		});
		await fireEvent.click(screen.getByRole('button', { name: /See all Albums/ }));

		await waitFor(() =>
			expect(browse.openSearchCategory).toHaveBeenCalledWith(
				expect.anything(),
				'bowie',
				'Albums',
				'zone-1'
			)
		);
		expect(screen.getByTestId('unified-browse-view')).toBeInTheDocument();
		const latest = __getNavigationLog().at(-1)?.state as {
			library?: { snapshot?: { browseHistory?: unknown } };
		};
		expect(latest.library?.snapshot?.browseHistory).toEqual({
			context: { hierarchy: 'search', query: 'bowie' },
			history: [
				{
					hierarchy: 'search',
					breadcrumb: { title: 'Albums', searchCategory: true }
				}
			],
			forward: []
		});
	});

	it('leaves Browse when a local Genre search result opens its drill', async () => {
		const browse = fakeBrowseController();
		const genresStore = fakeNamedCountsStore([
			{ label: 'Jazz', albumCount: 60, itemKey: 'genre:jazz', imageKey: null }
		]);
		const drillStore = fakeDrillStore([
			{ title: 'Kind of Blue', artist: 'Miles Davis', imageKey: null }
		]);
		mountMode({
			indexState: readyState(),
			browseController: browse.controller,
			genresStore,
			drillStore
		});

		await fireEvent.click(screen.getByTestId('unified-scope-browse'));
		await waitFor(() => expect(screen.getByTestId('unified-browse-view')).toBeInTheDocument());
		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'jazz' }
		});
		await fireEvent.click(await screen.findByRole('button', { name: /Genre: Jazz/ }));

		await waitFor(() =>
			expect(drillStore.load).toHaveBeenCalledWith(expect.anything(), 'genres', 'Jazz')
		);
		expect(screen.queryByTestId('unified-browse-view')).toBeNull();
		expect(screen.getByTestId('unified-scope-browse')).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByTestId('unified-drill-label')).toHaveTextContent('Jazz');
	});

	it('retires palette authority before a keyless category result opens explicit actions', async () => {
		const browse = fakeBrowseController();
		const actions = fakeBrowseActionController();
		const paletteSearchStore = writable<PaletteSearchState>({
			phase: 'ready',
			query: 'bowie',
			groups: [],
			browseGroups: [
				{
					title: 'Albums',
					categoryTitle: 'Albums',
					resultType: 'album',
					total: 1,
					rows: [
						{
							title: 'Low',
							subtitle: 'David Bowie',
							hint: 'action_list',
							isLoadable: false,
							isPlayable: false,
							resultType: 'album',
							categoryTitle: 'Albums'
						}
					]
				}
			],
			error: null
		});
		const clearPaletteSearchData = vi.fn(async () => {});
		mountMode({
			indexState: readyState(),
			browseController: browse.controller,
			browseActionController: actions.controller,
			paletteSearchStore,
			clearPaletteSearchData
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'bowie' }
		});
		await fireEvent.click(screen.getByRole('button', { name: /Low/ }));

		await waitFor(() => expect(actions.open).toHaveBeenCalledTimes(1));
		expect(clearPaletteSearchData.mock.invocationCallOrder[0]).toBeLessThan(
			actions.open.mock.invocationCallOrder[0]
		);
		expect(actions.open).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				kind: 'search',
				query: 'bowie',
				item: expect.objectContaining({ title: 'Low', resultType: 'album' })
			}),
			'zone-1'
		);
		expect(actions.execute).not.toHaveBeenCalled();
		expect(screen.getByTestId('unified-browse-action-sheet')).toBeInTheDocument();

		await fireEvent.click(screen.getByTestId('unified-browse-action-queue'));
		expect(actions.execute).toHaveBeenCalledWith(
			expect.anything(),
			'queue',
			'zone-1'
		);
	});

	it('keeps Favorite available after See All enters a keyless Tracks hierarchy', async () => {
		const actions = fakeBrowseActionController();
		mountMode({
			indexState: readyState(),
			browseActionController: actions.controller
		});

		actions.store.set({
			phase: 'ready',
			source: {
				kind: 'browse',
				snapshot: {
					context: { hierarchy: 'search', query: 'love' },
					history: [
						{
							hierarchy: 'search',
							breadcrumb: { title: 'Tracks', searchCategory: true }
						}
					],
					forward: []
				},
				item: {
					title: 'Sea of Love',
					subtitle: 'Cat Power',
					hint: 'action_list',
					isLoadable: false,
					isPlayable: false
				}
			},
			available: { 'play-now': true, 'add-next': true, queue: true },
			error: null
		});

		await waitFor(() =>
			expect(screen.getByTestId('unified-browse-action-favorite')).toBeEnabled()
		);
	});

	it('shows a named drill failure instead of leaving an endless loading message', async () => {
		const genresStore = fakeNamedCountsStore([
			{ label: 'Jazz', albumCount: 60, itemKey: 'genre:jazz', imageKey: null }
		]);
		const failed = writable({
			albums: [] as readonly DrillAlbum[],
			totalCount: 0,
			loading: false,
			loaded: false,
			error: 'stale target'
		});
		const drillStore = {
			subscribe: failed.subscribe,
			load: vi.fn(async () => {}),
			reset: vi.fn()
		};
		mountMode({ indexState: readyState(), genresStore, drillStore });

		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await fireEvent.click(await screen.findByText('Jazz'));

		expect(screen.getByTestId('unified-drill-error')).toHaveTextContent('stale target');
		expect(screen.queryByTestId('unified-drill-loading')).toBeNull();
	});
});

describe('UnifiedLibraryMode — scope views and drills (slice 5)', () => {
	const renderedTileTitles = (): string[] =>
		screen
			.getAllByTestId('unified-tile')
			.map((tile) => tile.querySelector('.tt')?.textContent ?? '');

	beforeEach(() => {
		__resetNavigation(
			'http://localhost/library',
			buildLibraryPageStateEnvelope(buildUnifiedRootPageState())
		);
		clearPendingLibraryPageStateWrite();
	});

	it('shows one version-count badge for a grouped album tile', async () => {
		const grouped = {
			...albumEntry('alb-group', 'Same Album', 'art-0'),
			catalogLocalId: 'alb-group',
			versionCount: 2
		};
		mountMode({
			indexState: readyState({
				albums: [grouped],
				albumBuckets: bucketsFor([grouped])
			})
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(screen.getAllByTestId('unified-tile')).toHaveLength(1);
		expect(screen.getByTestId('unified-album-version-count')).toHaveTextContent(
			'2 versions'
		);
	});

	it('records scope and drill transitions so browser Back stays inside Library', async () => {
		mountMode({ indexState: readyState() });

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getByTestId('unified-scope-artists'));
		await fireEvent.click(screen.getByText('a artist 0').closest('button')!);

		const enteredDrill = __getHistorySnapshot();
		expect(enteredDrill).toMatchObject({ index: 3 });
		expect(enteredDrill.entries).toHaveLength(4);
		expect(enteredDrill.entries.map((entry) => new URL(entry.url).pathname)).toEqual([
			'/library',
			'/library',
			'/library',
			'/library'
		]);
		expect(enteredDrill.entries[3].state).toMatchObject({
			library: {
				libraryView: 'unified',
				snapshot: {
					scope: 'artists',
					collectionDrill: null,
					itemTarget: { kind: 'artist', localId: 'art-0' },
				}
			}
		});

		expect(__back()).toBe(true);
		expect(__getHistorySnapshot()).toMatchObject({
			index: 2,
			entries: [
				expect.anything(),
				expect.anything(),
				{
					url: 'http://localhost/library',
					state: {
						library: {
							libraryView: 'unified',
							schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
							snapshot: {
								scope: 'artists',
								collectionDrill: null,
								itemTarget: null,
								filterText: '',
								surpriseSeed: null
							}
						}
					}
				},
				expect.anything()
			]
		});
		expect(__forward()).toBe(true);
	});

	it('records density changes and restores the previous size on browser Back', async () => {
		const harness = mountMode({ withContext: true, indexState: readyState() });
		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedRootPageState()
		} as CommittedLibraryModeActivation);
		expect(get(harness.prefsStore).density).toBe('normal');

		expect(requestUnifiedLibraryDensity('pi')).toBe(true);

		expect(get(harness.prefsStore).density).toBe('pi');
		const changed = __getHistorySnapshot();
		expect(changed).toMatchObject({ index: 1 });
		expect(changed.entries).toHaveLength(2);
		expect(changed.entries[0].state).toMatchObject({
			library: { snapshot: { density: 'normal' } }
		});
		expect(changed.entries[1].state).toMatchObject({
			library: { snapshot: { density: 'pi' } }
		});
		expect(__getNavigationLog().map((entry) => entry.operation)).toEqual([
			'replaceState',
			'pushState'
		]);

		harness.registered.lifecycle!.suspend();
		expect(__back()).toBe(true);
		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: changed.entries[0].state.library
		} as CommittedLibraryModeActivation);

		expect(get(harness.prefsStore).density).toBe('normal');
		await waitFor(() =>
			expect(screen.getByTestId('library-mode-target')).toHaveAttribute(
				'data-density',
				'normal'
			)
		);
	});

	it('renders the exact Roon album count on every artist row', () => {
		const artists: LibraryArtistEntry[] = [
			{
				id: 'art-counted',
				name: 'Counted Artist',
				searchKey: 'counted artist',
				albumCount: 27,
				countComplete: true
			},
			{
				id: 'art-zero',
				name: 'Zero Artist',
				searchKey: 'zero artist',
				albumCount: 0,
				countComplete: true
			}
		];
		mountMode({
			indexState: readyState({
				artists,
				artistBuckets: bucketsFor(artists)
			})
		});

		const countedRow = screen.getByText('Counted Artist').closest('button');
		const zeroRow = screen.getByText('Zero Artist').closest('button');
		expect(countedRow?.querySelector('.ac')).toHaveTextContent('27');
		expect(zeroRow?.querySelector('.ac')).toHaveTextContent('0');
	});

	it('redraws Surprise me by re-selecting its chip and renders the prototype hint after the tiles', async () => {
		const albums = Array.from({ length: 40 }, (_, index) =>
			albumEntry(`alb-${index}`, `Album ${index.toString().padStart(2, '0')}`, 'art-0')
		);
		mountMode({ indexState: readyState({ albums }) });

		const surpriseChip = screen.getByTestId('unified-scope-surprise');
		await fireEvent.click(surpriseChip);
		const first = renderedTileTitles();
		expect(first).toHaveLength(24);
		expect(screen.queryByRole('button', { name: 'Redraw' })).toBeNull();
		const hint = screen.getByText(
			'Random, not "unplayed" — nothing knows what you have heard. Re-select the chip to redraw.'
		);
		expect(screen.getByTestId('unified-scope-view').lastElementChild).toBe(hint);

		await fireEvent.click(surpriseChip);
		expect(renderedTileTitles()).not.toEqual(first);
	});

	it('redraws Album Shuffle on chip re-selection without a Surprise hint', async () => {
		const albums = Array.from({ length: 40 }, (_, index) =>
			albumEntry(`alb-${index}`, `Album ${index.toString().padStart(2, '0')}`, 'art-0')
		);
		mountMode({ indexState: readyState({ albums }) });

		const albumsChip = screen.getByTestId('unified-scope-albums');
		await fireEvent.click(albumsChip);
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-shuffle'));
		const first = renderedTileTitles();
		expect(screen.queryByText(/Random, not/)).toBeNull();
		expect(screen.queryByRole('button', { name: 'Redraw' })).toBeNull();

		await fireEvent.click(albumsChip);
		expect(renderedTileTitles()).not.toEqual(first);
		expect(screen.queryByText(/Random, not/)).toBeNull();
	});

	it('renders the reference Recently played subtitle without appending the album', async () => {
		mountMode({ indexState: readyState(), recentStore: fakeRecentStore() });

		await fireEvent.click(screen.getByTestId('unified-scope-recently-played'));
		const tile = screen.getByText('A Recent Track').closest('button');
		expect(tile?.querySelector('.ta')).toHaveTextContent('Reference Artist');
		expect(tile?.querySelector('.ta')).not.toHaveTextContent('Album must not appear');
	});

	it('keeps unavailable album sorts visible and disabled with their verified reasons', async () => {
		mountMode({ indexState: readyState() });

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		const releaseYear = screen.getByTestId(
			'unified-sort-option-release-year'
		) as HTMLOptionElement;
		expect(releaseYear.disabled).toBe(true);
		expect(releaseYear.title).toBe(NO_RELEASE_DATES_REASON);
		const byGenre = screen.getByTestId('unified-sort-option-by-genre') as HTMLOptionElement;
		expect(byGenre.disabled).toBe(true);
		expect(byGenre.title).toBe(NO_GENRE_SORT_REASON);
	});

	it('enables release-year sorting when the native date features are available (Slice 4)', async () => {
		const albums = [
			{
				...albumEntry('alb-mid', 'Middle', 'art-0'),
				originalReleaseDate: { year: 1975, month: 6, day: 1 }
			},
			{
				...albumEntry('alb-old', 'Earliest', 'art-1'),
				originalReleaseDate: { year: 1959, month: 8, day: 17 }
			},
			// ReleaseDate is the fallback key when no original exists.
			{
				...albumEntry('alb-new', 'Latest', 'art-2'),
				releaseDate: { year: 1997, month: 9, day: 22 }
			},
			albumEntry('alb-undated', 'Undated', 'art-3')
		];
		const harness = mountMode({
			indexState: readyState({
				albums,
				capabilities: { ...CATALOG_CAPABILITIES, dateFeatures: true }
			})
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getByTestId('unified-sort'));
		expect(screen.queryByTestId('unified-sort-option-release-year')).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-sort-option-year-asc'));
		expect(get(harness.prefsStore).sorts.albums).toBe('year-asc');
		expect(renderedTileTitles()).toEqual(['Earliest', 'Middle', 'Latest', 'Undated']);

		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-year-desc'));
		expect(get(harness.prefsStore).sorts.albums).toBe('year-desc');
		// Undated albums stay last in both directions.
		expect(renderedTileTitles()).toEqual(['Latest', 'Middle', 'Earliest', 'Undated']);
	});

	it('hides the A–Z rail for the chronological album orders exactly as for Shuffle', async () => {
		const albums = Array.from({ length: 44 }, (_, index) => ({
			...albumEntry(
				`alb-${index}`,
				`${'abcd'[index % 4]} Album ${index.toString().padStart(2, '0')}`,
				`art-${index}`
			),
			originalReleaseDate: { year: 1960 + index, month: 0, day: 0 }
		})).sort((left, right) => (left.searchKey < right.searchKey ? -1 : 1));
		mountMode({
			indexState: readyState({
				albums,
				albumBuckets: bucketsFor(albums),
				capabilities: { ...CATALOG_CAPABILITIES, dateFeatures: true }
			})
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-year-asc'));
		expect(screen.queryByTestId('unified-rail')).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-year-desc'));
		expect(screen.queryByTestId('unified-rail')).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-az'));
		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();
	});

	it('degrades with the carried reason and falls a persisted year sort back to A–Z', async () => {
		const albums = [
			{
				...albumEntry('alb-b', 'Beta', 'art-0'),
				originalReleaseDate: { year: 1975, month: 0, day: 0 }
			},
			{
				...albumEntry('alb-a', 'Alpha', 'art-1'),
				originalReleaseDate: { year: 1959, month: 0, day: 0 }
			}
		];
		const harness = mountMode({
			indexState: readyState({
				albums,
				capabilities: {
					...CATALOG_CAPABILITIES,
					dateFeatures: false,
					dateFeaturesDisabledReason: 'no native catalog snapshot is available'
				}
			})
		});
		// Persisted as if selected while the feature was live.
		harness.prefsStore.setSort('albums', 'year-asc');

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		// Rendering falls back to A–Z and the control says so honestly.
		expect(screen.getByTestId('unified-sort')).toHaveTextContent('Sort: A to Z');
		expect(renderedTileTitles()).toEqual(['Alpha', 'Beta']);

		await fireEvent.click(screen.getByTestId('unified-sort'));
		const releaseYear = screen.getByTestId(
			'unified-sort-option-release-year'
		) as HTMLButtonElement;
		expect(releaseYear.disabled).toBe(true);
		expect(releaseYear.title).toBe('no native catalog snapshot is available');
		expect(screen.queryByTestId('unified-sort-option-year-asc')).toBeNull();
	});

	it('sorts an artist drill chronologically when date features are available', async () => {
		const indexState = readyState({
			capabilities: { ...CATALOG_CAPABILITIES, dateFeatures: true },
			albums: [
				{
					...albumEntry('alb-1', 'Late Work', 'art-0'),
					originalReleaseDate: { year: 1980, month: 0, day: 0 }
				},
				{
					...albumEntry('alb-2', 'Early Work', 'art-0'),
					originalReleaseDate: { year: 1968, month: 0, day: 0 }
				},
				albumEntry('alb-3', 'Undated Work', 'art-0')
			]
		});
		const harness = mountMode({ indexState });

		const rows = screen.getAllByTestId('unified-row');
		await fireEvent.click(rows[0]);
		expect(screen.getByTestId('unified-item-summary')).toHaveTextContent('3 ALBUMS');
		await fireEvent.click(screen.getByTestId('unified-drill-sort'));
		await fireEvent.click(screen.getByTestId('unified-drill-sort-option-year-asc'));
		expect(get(harness.prefsStore).sorts.artist).toBe('year-asc');
		expect(renderedTileTitles()).toEqual(['Early Work', 'Late Work', 'Undated Work']);
	});

	// Artist drills join by catalog binding, never by display name (plan:
	// .agents/plans/artist-drill-binding.md). The three tests below cover
	// the authoritative load, the folded fallback, and the honest loading
	// state — the production defect showed "0 ALBUMS / No albums in this
	// library." for 635 of 1,671 artists.
	const chainz = {
		id: 'art-chainz',
		name: '2 Chainz',
		searchKey: '2 chainz',
		albumCount: 1,
		countComplete: true,
		catalogLocalId: 'art-chainz'
	};
	const collegroveRef = {
		localId: 'alb-collegrove',
		coreId: 'core-a',
		exactTitle: 'Collegrove',
		exactArtist: '2 Chainz & Lil Wayne',
		normalizedTitle: 'collegrove',
		normalizedArtist: '2 chainz & lil wayne',
		editionText: '',
		firstSeenAt: '2026-08-08T00:00:00.000Z',
		lastSeenAt: '2026-08-08T00:00:00.000Z',
		resolutionStatus: 'resolved',
		artistLocalId: 'art-chainz'
	};
	const artistAlbumsResponse = () => ({
		status: { ...syntheticStatus({ coreId: 'core-a' }), revision: 2 },
		artist: { localId: 'art-chainz' },
		limit: 500,
		total: 1,
		truncated: false,
		albums: [collegroveRef]
	});

	it('replaces the display-name fallback with the Roon-authoritative discography', async () => {
		// The credit-string class: the album's artist line matches no artist
		// name, so no string normalization can ever join it.
		const hydrate = vi.fn(async () => artistAlbumsResponse());
		mountMode({
			indexState: readyState({
				artists: [chainz],
				artistBuckets: bucketsFor([chainz]),
				albums: [
					{
						id: 'alb-collegrove',
						title: 'Collegrove',
						artist: '2 Chainz & Lil Wayne',
						searchKey: 'collegrove 2 chainz & lil wayne'
					}
				]
			}),
			hydrateArtistAlbums: hydrate
		});

		await fireEvent.click(screen.getAllByTestId('unified-row')[0]);
		await waitFor(() => expect(renderedTileTitles()).toEqual(['Collegrove']));
		expect(hydrate).toHaveBeenCalledWith(expect.anything(), 'art-chainz', 1, 500);
		expect(screen.getByTestId('unified-item-summary')).toHaveTextContent('1 ALBUMS');
		expect(screen.queryByText('No albums in this library.')).toBeNull();
	});

	it('joins typographic credit variants through folding when the load fails', async () => {
		// The measured 'Til Tuesday case: Artists row U+2019, album credit
		// U+0027, album unbound. With the authoritative load unavailable the
		// folded fallback must still join.
		const tilTuesday = {
			id: 'art-tt',
			name: '’Til Tuesday',
			searchKey: 'til tuesday',
			albumCount: 1,
			countComplete: true,
			catalogLocalId: 'art-tt'
		};
		const hydrate = vi.fn(async () => {
			throw new Error('offline');
		});
		mountMode({
			indexState: readyState({
				artists: [tilTuesday],
				artistBuckets: bucketsFor([tilTuesday]),
				albums: [
					{
						id: 'alb-vc',
						title: 'Voices Carry',
						artist: "'Til Tuesday",
						searchKey: 'voices carry til tuesday'
					}
				]
			}),
			hydrateArtistAlbums: hydrate
		});

		await fireEvent.click(screen.getAllByTestId('unified-row')[0]);
		await waitFor(() => expect(renderedTileTitles()).toEqual(['Voices Carry']));
		expect(screen.getByTestId('unified-item-summary')).toHaveTextContent('1 ALBUMS');
	});

	it('requests the full contract limit and never claims a complete count for a truncated discography', async () => {
		// cr-1: the default page size silently capped a discography at 200 and
		// then reported that cap as an exact count.
		const hydrate = vi.fn(async () => ({ ...artistAlbumsResponse(), truncated: true }));
		mountMode({
			indexState: readyState({
				artists: [chainz],
				artistBuckets: bucketsFor([chainz]),
				albums: []
			}),
			hydrateArtistAlbums: hydrate
		});

		await fireEvent.click(screen.getAllByTestId('unified-row')[0]);
		await waitFor(() => expect(renderedTileTitles()).toEqual(['Collegrove']));
		expect(hydrate).toHaveBeenCalledWith(expect.anything(), 'art-chainz', 1, 500);
		expect(screen.getByTestId('unified-item-summary')).toHaveTextContent('1+ ALBUMS');
	});

	it('retries a revision conflict once so a racing hydration does not strand the open drill', async () => {
		// cr-2: the catalog compares revisions with strict equality, so a load
		// that lost a race was turned into a permanent per-artist failure with
		// no retry while the drill stayed open.
		// The conflict here is an EXTERNAL refresh: the catalog has moved to
		// revision 9 while the mounted index still says 1, so a retry that
		// re-derives the revision locally resends the rejected value and fails
		// again. The stub is revision-sensitive exactly so it cannot pass that
		// way — it accepts only the revision the Core currently reports.
		const CURRENT_REVISION = 9;
		const attempted: number[] = [];
		const hydrate = vi.fn(async (_fetch: unknown, _id: string, revision: number) => {
			attempted.push(revision);
			if (revision !== CURRENT_REVISION) throw new Error('REVISION_CONFLICT');
			return artistAlbumsResponse();
		});
		mountMode({
			indexState: readyState({
				artists: [chainz],
				artistBuckets: bucketsFor([chainz]),
				albums: []
			}),
			hydrateArtistAlbums: hydrate,
			fetchStatus: async () => syntheticStatus({ coreId: 'core-a', revision: CURRENT_REVISION })
		});

		await fireEvent.click(screen.getAllByTestId('unified-row')[0]);
		await waitFor(() => expect(renderedTileTitles()).toEqual(['Collegrove']));
		expect(attempted).toEqual([1, CURRENT_REVISION]);
		expect(screen.queryByTestId('unified-drill-error')).toBeNull();
	});

	it('never claims an empty library while the discography is still loading', async () => {
		const pending = deferred<ReturnType<typeof artistAlbumsResponse>>();
		const hydrate = vi.fn(() => pending.promise);
		mountMode({
			indexState: readyState({
				artists: [chainz],
				artistBuckets: bucketsFor([chainz]),
				albums: []
			}),
			hydrateArtistAlbums: hydrate
		});

		await fireEvent.click(screen.getAllByTestId('unified-row')[0]);
		expect(screen.getByTestId('unified-drill-loading')).toBeInTheDocument();
		expect(screen.queryByText('No albums in this library.')).toBeNull();
		// The summary span renders only with text — no "0 ALBUMS" claim exists.
		expect(screen.queryByTestId('unified-item-summary')).toBeNull();

		pending.resolve(artistAlbumsResponse());
		await waitFor(() => expect(renderedTileTitles()).toEqual(['Collegrove']));
		expect(screen.getByTestId('unified-item-summary')).toHaveTextContent('1 ALBUMS');
	});

	it('orders a genre drill chronologically through reconciled catalog dates', async () => {
		const genresStore = fakeNamedCountsStore([
			{ label: 'Jazz', albumCount: 2, itemKey: 'k:jazz', imageKey: null }
		]);
		const drillStore = fakeDrillStore([
			{ title: 'Alpha Jazz', artist: 'J Artist', imageKey: null },
			{ title: 'Zulu Jazz', artist: 'J Artist', imageKey: null }
		]);
		const harness = mountMode({
			indexState: readyState({
				capabilities: { ...CATALOG_CAPABILITIES, dateFeatures: true },
				albums: [
					{
						id: 'cat-alpha',
						title: 'Alpha Jazz',
						artist: 'J Artist',
						searchKey: 'alpha jazz j artist',
						catalogLocalId: 'cat-alpha',
						resolutionStatus: 'resolved',
						originalReleaseDate: { year: 1975, month: 0, day: 0 }
					},
					{
						id: 'cat-zulu',
						title: 'Zulu Jazz',
						artist: 'J Artist',
						searchKey: 'zulu jazz j artist',
						catalogLocalId: 'cat-zulu',
						resolutionStatus: 'resolved',
						originalReleaseDate: { year: 1959, month: 0, day: 0 }
					}
				]
			}),
			genresStore,
			drillStore
		});

		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await fireEvent.click(await screen.findByText('Jazz'));
		// A–Z order first: Alpha before Zulu.
		await screen.findByText('Alpha Jazz');
		expect(renderedTileTitles()).toEqual(['Alpha Jazz', 'Zulu Jazz']);

		await fireEvent.click(screen.getByTestId('unified-drill-sort'));
		await fireEvent.click(screen.getByTestId('unified-drill-sort-option-year-asc'));
		expect(get(harness.prefsStore).sorts.genre).toBe('year-asc');
		// Chronological order flips it: Zulu (1959) before Alpha (1975).
		expect(renderedTileTitles()).toEqual(['Zulu Jazz', 'Alpha Jazz']);
	});

	it('restores the Recently added chip when date features are available, library-added timestamp descending (Slice 5)', async () => {
		const albums = [
			{
				...albumEntry('alb-tie-b', 'Zebra Tie', 'art-0'),
				importDate: '2026-07-20T10:00:00.000Z'
			},
			{
				...albumEntry('alb-new', 'Newest', 'art-1'),
				importDate: '2026-07-24T09:30:00.000Z'
			},
			{
				...albumEntry('alb-tie-a', 'Alpha Tie', 'art-2'),
				importDate: '2026-07-20T10:00:00.000Z'
			},
			albumEntry('alb-undated', 'Undated', 'art-3'),
			{
				...albumEntry('alb-old', 'Oldest', 'art-4'),
				importDate: '2026-07-18T12:00:00.000Z'
			}
		];
		mountMode({
			indexState: readyState({
				albums,
				capabilities: { ...CATALOG_CAPABILITIES, dateFeatures: true }
			})
		});

		await fireEvent.click(screen.getByTestId('unified-scope-recently-added'));
		// Library-added timestamp descending; equal timestamps break by the normalized
		// title key; the album without an importDate goes last.
		expect(renderedTileTitles()).toEqual([
			'Newest',
			'Alpha Tie',
			'Zebra Tie',
			'Oldest',
			'Undated'
		]);
		expect(screen.getByTestId('unified-summary')).toHaveTextContent('5 TOTAL');
		// The ordering is pinned: no sort control on this scope.
		expect(screen.queryByTestId('unified-sort')).toBeNull();
	});

	it('hides the Recently added chip when date features are unavailable (Slice 5)', async () => {
		mountMode({
			indexState: readyState({
				albums: [albumEntry('alb-1', 'Alpha', 'art-0')],
				capabilities: {
					...CATALOG_CAPABILITIES,
					dateFeatures: false,
					dateFeaturesDisabledReason: 'no native catalog snapshot is available'
				}
			})
		});

		// Absent, never rendered disabled (2026-07-24 owner correction).
		expect(screen.queryByTestId('unified-scope-recently-added')).toBeNull();
		expect(screen.queryByText('Recently added')).toBeNull();
	});

	it('degrades a restored Recently added page to the carried reason when the feature is gone (Slice 5)', async () => {
		const harness = mountMode({
			withContext: true,
			indexState: readyState({
				albums: [
					{
						...albumEntry('alb-1', 'Alpha', 'art-0'),
						importDate: '2026-07-24T09:30:00.000Z'
					}
				],
				capabilities: {
					...CATALOG_CAPABILITIES,
					dateFeatures: false,
					dateFeaturesDisabledReason: 'no native catalog snapshot is available'
				}
			})
		});
		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedLibraryPageState({
				scope: 'recently-added',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);

		await waitFor(() =>
			expect(screen.getByTestId('unified-recently-added-gated')).toHaveTextContent(
				'no native catalog snapshot is available'
			)
		);
		// No guessed ordering is rendered.
		expect(screen.queryByTestId('unified-tile')).toBeNull();
		expect(screen.queryByTestId('unified-scope-recently-added')).toBeNull();
	});

	it('falls a restored Recently added page back to the default honest reason when none is carried (Slice 5)', async () => {
		const harness = mountMode({
			withContext: true,
			indexState: readyState({
				albums: [
					{
						...albumEntry('alb-1', 'Alpha', 'art-0'),
						importDate: '2026-07-24T09:30:00.000Z'
					}
				]
			})
		});
		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedLibraryPageState({
				scope: 'recently-added',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);

		await waitFor(() =>
			expect(screen.getByTestId('unified-recently-added-gated')).toHaveTextContent(
				NO_IMPORT_DATES_REASON
			)
		);
		expect(screen.queryByTestId('unified-tile')).toBeNull();
	});

	it('hides only the Most played chip when play features are unavailable (Slice 6/12)', async () => {
		mountMode({
			indexState: readyState({
				capabilities: {
					...CATALOG_CAPABILITIES,
					dateFeatures: true,
					playFeatures: false,
					playFeaturesDisabledReason:
						'the Core does not report play-statistics support; most played is unavailable',
					playlistFeatures: true
				}
			})
		});

		// Absent, never rendered disabled (2026-07-24 owner correction).
		expect(screen.queryByTestId('unified-scope-most-played')).toBeNull();
		expect(screen.queryByText('Most played')).toBeNull();
		expect(screen.getByTestId('unified-scope-recently-added')).toBeInTheDocument();
		expect(screen.getByTestId('unified-scope-playlists')).toBeInTheDocument();
	});

	it('reverses the rail buckets under za so letters mirror the list', async () => {
		mountMode({ indexState: readyState() });

		const letters = () =>
			Array.from(
				screen.getByTestId('unified-rail').querySelectorAll('button'),
				(button) => button.textContent?.trim()
			);
		const az = letters();
		// `#` is pinned first in the approved prototype rail; `A` follows.
		expect(az[0]).toBe('#');
		expect(az[1]).toBe('A');

		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-za'));
		const za = letters();
		expect(za).toEqual([...az].reverse());
	});

	it('hides the rail whenever the active sort has no letter-grouped result order', async () => {
		const albums = Array.from({ length: 52 }, (_, index) =>
			({
				...albumEntry(
					`alb-${index}`,
					`${'abcd'[index % 4]} Album ${index.toString().padStart(2, '0')}`,
					`art-${index}`
				),
				artist: `${'wxyz'[index % 4]} Artist ${index}`
			})
		).sort((left, right) => (left.searchKey < right.searchKey ? -1 : 1));
		const genresStore = fakeNamedCountsStore(
			Array.from({ length: 42 }, (_, index) => ({
				label: `${'abc'[index % 3]} genre ${index}`,
				albumCount: index + 1,
				itemKey: `genre:${index}`,
				imageKey: null
			}))
		);
		mountMode({
			indexState: readyState({
				albums,
				albumBuckets: bucketsFor(albums)
			}),
			genresStore
		});

		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-most-albums'));
		expect(screen.queryByTestId('unified-rail')).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-fewest-albums'));
		expect(screen.queryByTestId('unified-rail')).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-az'));
		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-by-artist'));
		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();
		expect(
			Array.from(
				screen.getByTestId('unified-rail').querySelectorAll('button:not(.off)'),
				(button) => button.textContent?.trim()
			)
		).toEqual(['W', 'X', 'Y', 'Z']);
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-shuffle'));
		expect(screen.queryByTestId('unified-rail')).toBeNull();

		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await waitFor(() => expect(screen.getByTestId('unified-rail')).toBeInTheDocument());
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-most-albums'));
		expect(screen.queryByTestId('unified-rail')).toBeNull();
	});

	it('switches Albums to the reference article-stripped artist groups without duplicate keys', async () => {
		const albums = [
			{ ...albumEntry('faith', 'Angel Dust', 'faith'), artist: 'Faith No More' },
			{ ...albumEntry('flaming', 'King’s Mouth', 'flaming'), artist: 'The Flaming Lips' },
			{ ...albumEntry('foo', 'There Is Nothing Left to Lose', 'foo'), artist: 'Foo Fighters' },
			{
				...albumEntry('breakfast', 'Soft Sounds', 'breakfast'),
				artist: 'Japanese Breakfast'
			},
			{ ...albumEntry('the', 'Solitude', 'the'), artist: 'The The' },
			{ ...albumEntry('verve', 'Urban Hymns', 'verve'), artist: 'The Verve' }
		].sort((left, right) => (left.searchKey < right.searchKey ? -1 : 1));
		mountMode({
			indexState: readyState({
				albums,
				albumBuckets: bucketsFor(albums)
			})
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-by-artist'));

		expect(
			screen
				.getAllByTestId('unified-tile')
				.map((tile) => tile.querySelector('.ta')?.textContent)
		).toEqual([
			'Faith No More',
			'The Flaming Lips',
			'Foo Fighters',
			'Japanese Breakfast',
			'The The',
			'The Verve'
		]);
		expect(Array.from(document.querySelectorAll('.grp .gl'), (group) => group.textContent)).toEqual([
			'F',
			'J',
			'T',
			'V'
		]);
	});

	it('buckets every non-A–Z genre initial into one reference # group', async () => {
		const genresStore = fakeNamedCountsStore([
			{ label: '60s', albumCount: 1, itemKey: 'genre:60s', imageKey: null },
			{ label: 'Alternative', albumCount: 1, itemKey: 'genre:a', imageKey: null },
			{ label: 'Česká', albumCount: 1, itemKey: 'genre:c', imageKey: null },
			{ label: 'Dance', albumCount: 1, itemKey: 'genre:d', imageKey: null },
			{ label: 'Électronique', albumCount: 1, itemKey: 'genre:e', imageKey: null }
		]);
		mountMode({ indexState: readyState(), genresStore });

		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await waitFor(() =>
			expect(Array.from(document.querySelectorAll('.grp .gl'), (group) => group.textContent)).toEqual([
				'#',
				'A',
				'D'
			])
		);
		expect(
			Array.from(document.querySelectorAll('.grp'), (group) =>
				Array.from(group.querySelectorAll('.gn'), (name) => name.textContent)
			)
		).toEqual([['60s', 'Česká', 'Électronique'], ['Alternative'], ['Dance']]);
	});

	it('loads genres on scope entry, drills a genre to albums, and backs out', async () => {
		const genresStore = fakeNamedCountsStore([
			{ label: 'Blues', albumCount: 75, itemKey: 'k:blues', imageKey: null }
		]);
		const drillAlbums: DrillAlbum[] = [
			{ title: 'Kind of Blue', artist: 'Miles Davis', imageKey: null },
			{ title: 'The Black Rider', artist: 'Tom Waits', imageKey: null },
			{ title: 'Blood Money', artist: 'Tom Waits', imageKey: null },
			...Array.from({ length: 37 }, (_value, index) => ({
				title: `${String.fromCharCode(67 + (index % 3))} Album ${index}`,
				artist: `Artist ${index}`,
				imageKey: null
			}))
		];
		const drillStore = fakeDrillStore(drillAlbums);
		mountMode({ indexState: readyState(), genresStore, drillStore });

		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await waitFor(() => expect(genresStore.load).toHaveBeenCalledTimes(1));
		const row = await screen.findByText('Blues');
		expect(screen.getByText('60+ ALBUMS')).toBeInTheDocument();
		expect(
			screen.getByText("Counts marked + are Roon's page bound, not the full genre.")
		).toBeInTheDocument();

		await fireEvent.click(row.closest('button')!);
		await waitFor(() =>
			expect(drillStore.load).toHaveBeenCalledWith(expect.anything(), 'genres', 'Blues')
		);
		expect(screen.getByTestId('unified-drill-label')).toHaveTextContent('Blues');
		expect(screen.getByTestId('unified-drill-back')).toHaveTextContent('← Genres');
		expect(screen.getByTestId('unified-drill-summary')).toHaveTextContent('40 ALBUMS');
		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();
		expect(screen.getByTestId('unified-drill-sort')).toHaveTextContent('Sort: A to Z');
		expect(screen.getByTestId('unified-drill-sort-option-by-artist')).toBeInTheDocument();
		expect(screen.getByTestId('unified-drill-sort-option-shuffle')).toBeInTheDocument();
		expect(screen.queryByTestId('unified-drill-sort-option-release-year')).toBeNull();
		await screen.findByText('Kind of Blue');
		await screen.findByText('The Black Rider');
		await screen.findByText('Blood Money');

		await fireEvent.click(screen.getByTestId('unified-drill-back'));
		expect(drillStore.reset).toHaveBeenCalled();
		expect(screen.queryByTestId('unified-drill-label')).toBeNull();
		await screen.findByText('Blues');
	});

	it('opens a genre album after its live row reconciles to one catalog identity', async () => {
		const genresStore = fakeNamedCountsStore([
			{ label: 'Blues', albumCount: 1, itemKey: 'k:blues', imageKey: null }
		]);
		const drillStore = fakeDrillStore([
			{ title: 'Kind of Blue', artist: 'Miles Davis', imageKey: 'kind-cover' }
		]);
		const album = fakeModeAlbumController();
		mountMode({
			indexState: readyState({
				albums: [
					{
						id: 'cat-kind',
						title: 'Kind of Blue',
						artist: 'Miles Davis',
						searchKey: 'kind of blue miles davis',
						imageKey: 'kind-cover',
						catalogLocalId: 'cat-kind',
						resolutionStatus: 'resolved'
					}
				]
			}),
			genresStore,
			drillStore,
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await fireEvent.click(await screen.findByText('Blues'));
		const tile = (await screen.findByText('Kind of Blue')).closest('button');
		expect(tile).toBeEnabled();
		await fireEvent.click(tile!);
		await waitFor(() =>
			expect(album.open).toHaveBeenCalledWith(
				expect.objectContaining({ albumLocalId: 'cat-kind' })
			)
		);
	});

	it('drills an artist to exactly the albums bound to it', async () => {
		const indexState = readyState({
			albums: [
				albumEntry('alb-1', 'Bound One', 'art-0'),
				albumEntry('alb-2', 'Bound Two', 'art-0'),
				albumEntry('alb-3', 'Other Artist Album', 'art-1'),
				{
					id: 'alb-name-fallback',
					title: 'Name Fallback',
					artist: 'A ARTIST 0',
					searchKey: 'name fallback — a artist 0'
				},
				{
					id: 'alb-other-unbound',
					title: 'Other Unbound',
					artist: 'a artist 1',
					searchKey: 'other unbound — a artist 1'
				}
			]
		});
		const harness = mountMode({ indexState });

		// First row is the alphabetically-first artist, id art-0. The row
		// itself is the drill button (prototype `.arow`).
		const rows = screen.getAllByTestId('unified-row');
		const pane = screen.getByTestId('unified-pane');
		pane.scrollTop = 450;
		await fireEvent.click(rows[0]);

		await waitFor(() => expect(pane.scrollTop).toBe(0));
		expect(screen.getByTestId('unified-artist-name')).toHaveTextContent('a artist 0');
		expect(screen.getByTestId('unified-artist-name').closest('.ctx')).not.toBeNull();
		expect(screen.getByTestId('unified-item-summary')).toHaveTextContent('3 ALBUMS');
		expect(screen.getByTestId('unified-drill-sort')).toHaveTextContent('Sort: A to Z');
		expect(screen.queryByTestId('unified-drill-sort-option-by-artist')).toBeNull();
		expect(screen.getByTestId('unified-drill-sort-option-release-year')).toBeDisabled();
		expect(
			within(screen.getByTestId('unified-item-page'))
				.getByTestId('unified-scope-view')
				.querySelector('.gl')
		).toBeNull();
		await screen.findByText('Bound One');
		await screen.findByText('Bound Two');
		await screen.findByText('Name Fallback');
		expect(screen.queryByText('Other Artist Album')).toBeNull();
		expect(screen.queryByText('Other Unbound')).toBeNull();

		await fireEvent.click(screen.getByTestId('unified-drill-sort'));
		await fireEvent.click(screen.getByTestId('unified-drill-sort-option-za'));
		expect(get(harness.prefsStore).sorts.artist).toBe('za');
		expect(renderedTileTitles()).toEqual(['Name Fallback', 'Bound Two', 'Bound One']);
	});

	// DELIBERATE SUPERSESSION (rich-item plan §4.1, 2026-08-11): the album
	// used to open as a reference modal over the Albums page; it is now a
	// first-class page that REPLACES the collection contents, with Back
	// returning to the exact invoking collection.
	it('opens an album as a first-class page replacing the collection contents', async () => {
		const albums: LibraryAlbumEntry[] = Array.from({ length: 52 }, (_, index) => {
			const letter = String.fromCharCode(65 + (index % 26));
			const entry = albumEntry(`alb-${index}`, `${letter} Album ${index}`, 'art-0');
			if (index === 0) {
				return {
					id: entry.id,
					title: entry.title,
					artist: 'a artist 0',
					searchKey: entry.searchKey,
					catalogLocalId: entry.id
				};
			}
			return { ...entry, catalogLocalId: entry.id };
		}).sort((a, b) => (a.searchKey < b.searchKey ? -1 : 1));
		const album = fakeModeAlbumController();
		mountMode({
			indexState: readyState({
				albums,
				albumBuckets: bucketsFor(albums)
			}),
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();
		await fireEvent.click(screen.getAllByTestId('unified-tile')[0]);
		await waitFor(() => expect(album.open).toHaveBeenCalled());

		// The page owns the pane: no modal, no scrim; the collection stays
		// mounted but hidden so Back restores its exact transient state.
		expect(screen.getByTestId('unified-album-page')).toBeInTheDocument();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.querySelector('.collection-host')).toHaveAttribute('hidden');
		expect(screen.queryByTestId('unified-rail')).toBeNull();
		expect(screen.getByTestId('unified-scope-albums')).not.toHaveClass('on');
		// Back names the exact invoking collection.
		expect(screen.getByTestId('unified-album-back')).toHaveTextContent('Albums');

		await fireEvent.click(screen.getByTestId('unified-album-artist-link'));
		expect(screen.queryByTestId('unified-album-page')).toBeNull();
		expect(screen.getByTestId('unified-artist-name')).toHaveTextContent('a artist 0');
	});

	it('retries a failed follow against the followed target (ri4-3)', async () => {
		const entry = { ...albumEntry('alb-1', 'Album', 'art-1'), catalogLocalId: 'alb-1' };
		const album = fakeModeAlbumController();
		const editorialStore = writable<
			import('$lib/library/EditorialItemController').EditorialItemState
		>({
			phase: 'ready',
			requestId: 'r-1',
			sessionId: 's-1',
			generation: 1,
			view: {
				kind: 'album',
				title: 'Album',
				sections: {},
				creditGroups: [
					{
						label: 'Album',
						credits: [{ role: 'Producer', name: 'P', followTarget: 'bt-0' }]
					}
				]
			},
			code: null,
			section: null,
			retryable: false,
			error: null
		});
		const editorialOpen = vi.fn().mockResolvedValue(true);
		const editorialFollow = vi.fn().mockResolvedValue(true);
		const editorial = {
			subscribe: editorialStore.subscribe,
			open: editorialOpen,
			follow: editorialFollow,
			cancel: vi.fn(),
			reset: vi.fn()
		} as unknown as import('$lib/library/EditorialItemController').EditorialItemController;
		mountMode({
			indexState: readyState({ albums: [entry], albumBuckets: bucketsFor([entry]) }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
			editorialController: editorial
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getAllByTestId('unified-tile')[0]);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		expect(editorialOpen).toHaveBeenCalledTimes(1);

		// The page reaches single-version Details so the credits render.
		album.store.set({
			phase: 'details',
			activeTab: 'details',
			albumLocalId: 'alb-1',
			generation: 1,
			requestId: 'r-1',
			operationId: null,
			resolvingDeadlineAt: null,
			artist: 'Artist',
			title: 'Album',
			versions: [
				{
					versionId: 'v1',
					editionText: '',
					phase: 'loaded',
					trackCount: 1,
					code: null,
					error: null
				}
			],
			selectedVersionId: 'v1',
			actionsAvailable: false,
			orderedTracks: [{ index: 0, title: 'T1' }],
			code: null,
			error: null,
			transitionedAt: 2
		} as unknown as LibraryAlbumState);
		await waitFor(() => screen.getByTestId('unified-album-credits-follow-0-0'));
		await fireEvent.click(screen.getByTestId('unified-album-credits-follow-0-0'));
		expect(editorialFollow).toHaveBeenCalledTimes(1);
		expect(editorialFollow.mock.calls[0][0].target).toBe('bt-0');

		// The follow fails retryable: Try again must re-follow the exact
		// performer target, never fall back to reopening the anchor.
		editorialStore.set({
			phase: 'failed',
			requestId: 'r-2',
			sessionId: 's-1',
			generation: 1,
			view: null,
			code: 'READ_TIMEOUT',
			section: null,
			retryable: true,
			error: 'The editorial read did not answer in time.'
		});
		await fireEvent.click(await screen.findByTestId('unified-album-review-retry'));
		expect(editorialFollow).toHaveBeenCalledTimes(2);
		expect(editorialFollow.mock.calls[1][0].target).toBe('bt-0');
		expect(editorialOpen).toHaveBeenCalledTimes(1);
	});

	it('falls back to the parent anchor when a follow fails terminally (ri7-3)', async () => {
		const entry = { ...albumEntry('alb-1', 'Album', 'art-1'), catalogLocalId: 'alb-1' };
		const album = fakeModeAlbumController();
		const editorialStore = writable<
			import('$lib/library/EditorialItemController').EditorialItemState
		>({
			phase: 'ready',
			requestId: 'r-1',
			sessionId: 's-1',
			generation: 1,
			view: {
				kind: 'album',
				title: 'Album',
				sections: {},
				relationshipGroups: [
					{
						label: 'Similar albums',
						items: [{ title: 'Spaces', followTarget: 'bt-9' }]
					}
				]
			},
			code: null,
			section: null,
			retryable: false,
			error: null
		});
		const editorialOpen = vi.fn().mockResolvedValue(true);
		const editorialFollow = vi.fn().mockResolvedValue(true);
		const editorial = {
			subscribe: editorialStore.subscribe,
			open: editorialOpen,
			follow: editorialFollow,
			cancel: vi.fn(),
			reset: vi.fn()
		} as unknown as import('$lib/library/EditorialItemController').EditorialItemController;
		mountMode({
			indexState: readyState({ albums: [entry], albumBuckets: bucketsFor([entry]) }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
			editorialController: editorial
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getAllByTestId('unified-tile')[0]);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		expect(editorialOpen).toHaveBeenCalledTimes(1);

		album.store.set({
			phase: 'details',
			activeTab: 'details',
			albumLocalId: 'alb-1',
			generation: 1,
			requestId: 'r-1',
			operationId: null,
			resolvingDeadlineAt: null,
			artist: 'Artist',
			title: 'Album',
			versions: [
				{
					versionId: 'v1',
					editionText: '',
					phase: 'loaded',
					trackCount: 1,
					code: null,
					error: null
				}
			],
			selectedVersionId: 'v1',
			actionsAvailable: false,
			orderedTracks: [{ index: 0, title: 'T1' }],
			code: null,
			error: null,
			transitionedAt: 2
		} as unknown as LibraryAlbumState);
		await waitFor(() => screen.getByTestId('unified-album-related-follow-0-0'));
		await fireEvent.click(screen.getByTestId('unified-album-related-follow-0-0'));
		expect(editorialFollow).toHaveBeenCalledTimes(1);
		expect(editorialFollow.mock.calls[0][0].target).toBe('bt-9');

		// The relationship expired: a terminal ITEM_NOT_FOUND must clear the
		// dead follow destination and reopen the reconstructible parent
		// anchor rather than stranding the editorial surface.
		editorialStore.set({
			phase: 'failed',
			requestId: 'r-2',
			sessionId: 's-1',
			generation: 1,
			view: null,
			code: 'ITEM_NOT_FOUND',
			section: null,
			retryable: false,
			error: 'That related item is not available.'
		});
		await waitFor(() => expect(editorialOpen).toHaveBeenCalledTimes(2));
		expect(editorialOpen.mock.calls[1][0].anchor).toEqual({
			kind: 'album',
			albumLocalId: 'alb-1'
		});
		// The dead target is gone: no follow retry was issued.
		expect(editorialFollow).toHaveBeenCalledTimes(1);

		// A DELIVERED child whose optional section then fails non-retryably
		// is a section-scoped outcome, not a dead destination: the child
		// view (and its follow context) must stay put.
		editorialStore.set({
			phase: 'ready',
			requestId: 'r-3',
			sessionId: 's-1',
			generation: 1,
			view: {
				kind: 'album',
				title: 'Album',
				sections: {},
				relationshipGroups: [
					{
						label: 'Similar albums',
						items: [{ title: 'Spaces', followTarget: 'bt-9' }]
					}
				]
			},
			code: null,
			section: null,
			retryable: false,
			error: null
		});
		await fireEvent.click(await screen.findByTestId('unified-album-related-follow-0-0'));
		expect(editorialFollow).toHaveBeenCalledTimes(2);
		editorialStore.set({
			phase: 'failed',
			requestId: 'r-4',
			sessionId: 's-1',
			generation: 1,
			// The ready child view is retained through the section failure.
			view: { kind: 'album', title: 'Spaces', sections: {} },
			code: 'INVALID_RESPONSE',
			section: 'review',
			retryable: false,
			error: 'The review violated its shape.'
		});
		// No parent fallback fires for a section-scoped failure: the anchor
		// is not reopened again.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(editorialOpen).toHaveBeenCalledTimes(2);
	});

	function trackChildFixture() {
		const entry = { ...albumEntry('alb-1', 'Album', 'art-1'), catalogLocalId: 'alb-1' };
		const album = fakeModeAlbumController();
		const editorialStore = writable<
			import('$lib/library/EditorialItemController').EditorialItemState
		>({
			phase: 'idle',
			requestId: null,
			sessionId: null,
			generation: null,
			view: null,
			code: null,
			section: null,
			retryable: false,
			error: null
		});
		const editorialOpen = vi.fn().mockResolvedValue(true);
		const editorial = {
			subscribe: editorialStore.subscribe,
			open: editorialOpen,
			follow: vi.fn().mockResolvedValue(true),
			cancel: vi.fn(),
			reset: vi.fn()
		} as unknown as import('$lib/library/EditorialItemController').EditorialItemController;
		const detailsState = {
			phase: 'details',
			activeTab: 'details',
			albumLocalId: 'alb-1',
			generation: 1,
			requestId: 'r-1',
			operationId: null,
			resolvingDeadlineAt: null,
			artist: 'Artist',
			title: 'Album',
			versions: [
				{
					versionId: 'v1',
					editionText: '',
					phase: 'loaded',
					trackCount: 1,
					code: null,
					error: null
				}
			],
			selectedVersionId: 'v1',
			actionsAvailable: false,
			orderedTracks: [{ index: 0, title: 'T1' }],
			code: null,
			error: null,
			transitionedAt: 2
		} as unknown as LibraryAlbumState;
		return { entry, album, editorialStore, editorialOpen, detailsState };
	}

	it('persists the exact-track child as a page-chain entry (Slice 8)', async () => {
		const { entry, album, editorialStore, editorialOpen, detailsState } = trackChildFixture();
		mountMode({
			indexState: readyState({ albums: [entry], albumBuckets: bucketsFor([entry]) }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
			editorialController: {
				subscribe: editorialStore.subscribe,
				open: editorialOpen,
				follow: vi.fn().mockResolvedValue(true),
				cancel: vi.fn(),
				reset: vi.fn()
			} as unknown as import('$lib/library/EditorialItemController').EditorialItemController
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getAllByTestId('unified-tile')[0]);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set(detailsState);
		await waitFor(() => screen.getByTestId('unified-track-info-0'));
		await fireEvent.click(screen.getByTestId('unified-track-info-0'));

		// The child transition pushed exactly one semantic entry carrying
		// the reconstructible index — and never editorial content.
		const navigation = __getNavigationLog();
		const latest = navigation.at(-1)?.state as {
			library?: { snapshot?: { itemTarget?: unknown; itemDetail?: unknown } };
		};
		expect(latest.library?.snapshot?.itemTarget).toEqual({
			kind: 'album',
			localId: 'alb-1'
		});
		expect(latest.library?.snapshot?.itemDetail).toEqual({
			kind: 'track',
			trackIndex: 0
		});
		const serialized = JSON.stringify(latest.library);
		expect(serialized).not.toContain('biography');
		expect(serialized).not.toContain('followTarget');
	});

	it('closes a live-pushed track child by traversing to the parent entry (ri8-1)', async () => {
		const { entry, album, editorialStore, editorialOpen, detailsState } = trackChildFixture();
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		mountMode({
			indexState: readyState({ albums: [entry], albumBuckets: bucketsFor([entry]) }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
			editorialController: {
				subscribe: editorialStore.subscribe,
				open: editorialOpen,
				follow: vi.fn().mockResolvedValue(true),
				cancel: vi.fn(),
				reset: vi.fn()
			} as unknown as import('$lib/library/EditorialItemController').EditorialItemController
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getAllByTestId('unified-tile')[0]);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set(detailsState);
		await waitFor(() => screen.getByTestId('unified-track-info-0'));
		await fireEvent.click(screen.getByTestId('unified-track-info-0'));

		// The in-page Back traverses to the parent entry it pushed over —
		// no duplicate rewrite, and the browser Back button stays honest.
		const writesBefore = __getNavigationLog().length;
		await fireEvent.click(screen.getByTestId('unified-album-track-info-back'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(browserBack).toHaveBeenCalledTimes(1);
		const writes = __getNavigationLog()
			.slice(writesBefore)
			.filter((entry_) => entry_.operation === 'pushState' || entry_.operation === 'replaceState');
		expect(writes).toHaveLength(0);
		browserBack.mockRestore();
	});

	it('keeps traversal ownership across a retried track child (ri8-1 reopen)', async () => {
		const { entry, album, editorialStore, editorialOpen, detailsState } = trackChildFixture();
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		mountMode({
			indexState: readyState({ albums: [entry], albumBuckets: bucketsFor([entry]) }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
			editorialController: {
				subscribe: editorialStore.subscribe,
				open: editorialOpen,
				follow: vi.fn().mockResolvedValue(true),
				cancel: vi.fn(),
				reset: vi.fn()
			} as unknown as import('$lib/library/EditorialItemController').EditorialItemController
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getAllByTestId('unified-tile')[0]);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set(detailsState);
		await waitFor(() => screen.getByTestId('unified-track-info-0'));
		await fireEvent.click(screen.getByTestId('unified-track-info-0'));

		// The child read fails retryably; the quiet retry re-opens the same
		// child, and its push deduplicates against the child's own entry.
		editorialStore.set({
			phase: 'failed',
			requestId: 'r-retry',
			sessionId: 's-1',
			generation: 1,
			view: null,
			code: 'READ_TIMEOUT',
			section: null,
			retryable: true,
			error: 'The native read did not answer before its deadline.'
		});
		await fireEvent.click(await screen.findByTestId('unified-album-track-description-retry'));

		// Ownership must survive the deduplicated re-push: the in-page Back
		// still traverses instead of rewriting a duplicate entry.
		const writesBefore = __getNavigationLog().length;
		await fireEvent.click(screen.getByTestId('unified-album-track-info-back'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(browserBack).toHaveBeenCalledTimes(1);
		const writes = __getNavigationLog()
			.slice(writesBefore)
			.filter((entry_) => entry_.operation === 'pushState' || entry_.operation === 'replaceState');
		expect(writes).toHaveLength(0);
		browserBack.mockRestore();
	});

	it('renders exactly the workspace links this build provides', () => {
		// Resolution-independent: whichever slot module the alias picked, the
		// surface renders that list verbatim — one anchor per provided link in
		// a walled checkout, none in a public one, never a placeholder.
		mountMode({ indexState: readyState() });
		const anchors = screen.queryAllByTestId('unified-workspace-link');
		expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual(
			libraryScopeSlots.workspaceLinks.map((link) => link.href)
		);
		expect(anchors.map((anchor) => anchor.textContent?.trim())).toEqual(
			libraryScopeSlots.workspaceLinks.map((link) => link.label)
		);
	});

	it('records no semantic entries for a track child over a palette-opened album (ri8-1)', async () => {
		const { entry, album, editorialStore, editorialOpen, detailsState } = trackChildFixture();
		mountMode({
			indexState: readyState({ albums: [entry], albumBuckets: bucketsFor([entry]) }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
			editorialController: {
				subscribe: editorialStore.subscribe,
				open: editorialOpen,
				follow: vi.fn().mockResolvedValue(true),
				cancel: vi.fn(),
				reset: vi.fn()
			} as unknown as import('$lib/library/EditorialItemController').EditorialItemController
		});

		// The album opens from the palette: a nested search view that owns
		// no semantic history entry (ri1-2).
		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'Album' }
		});
		const paletteRows = await screen.findAllByTestId('unified-palette-row');
		const albumRow = paletteRows.find((row) => row.textContent?.includes('Album'));
		expect(albumRow).toBeDefined();
		const writesBefore = __getNavigationLog().length;
		await fireEvent.click(albumRow!);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set(detailsState);
		await waitFor(() => screen.getByTestId('unified-track-info-0'));
		await fireEvent.click(screen.getByTestId('unified-track-info-0'));
		await fireEvent.click(screen.getByTestId('unified-album-track-info-back'));
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Neither the child open nor its in-page Back may write history:
		// the transient parent's base entry keeps describing the base surface.
		const writes = __getNavigationLog()
			.slice(writesBefore)
			.filter((entry_) => entry_.operation === 'pushState' || entry_.operation === 'replaceState');
		expect(writes).toHaveLength(0);
	});

	it('restores a persisted exact-track child on resume (Slice 8)', async () => {
		const { entry, album, editorialStore, editorialOpen, detailsState } = trackChildFixture();
		const harness = mountMode({
			withContext: true,
			indexState: readyState({ albums: [entry], albumBuckets: bucketsFor([entry]) }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
			editorialController: {
				subscribe: editorialStore.subscribe,
				open: editorialOpen,
				follow: vi.fn().mockResolvedValue(true),
				cancel: vi.fn(),
				reset: vi.fn()
			} as unknown as import('$lib/library/EditorialItemController').EditorialItemController
		});

		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: buildUnifiedLibraryPageState({
				scope: 'albums',
				collectionDrill: null,
				itemTarget: { kind: 'album', localId: 'alb-1' },
				itemDetail: { kind: 'track', trackIndex: 0 },
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set(detailsState);

		// The page consumes the restored index once the track order arrives:
		// the child surface renders and the editorial read targets the track.
		await waitFor(() => screen.getByTestId('unified-album-track-info'));
		await waitFor(() =>
			expect(
				editorialOpen.mock.calls.some(
					(call) =>
						(call[0] as { anchor?: { kind?: string; trackIndex?: number } }).anchor
							?.kind === 'track' &&
						(call[0] as { anchor?: { trackIndex?: number } }).anchor?.trackIndex === 0
				)
			).toBe(true)
		);
	});

	it('keeps the parent page when a restored track index is stale (Slice 8)', async () => {
		const { entry, album, editorialStore, editorialOpen, detailsState } = trackChildFixture();
		const harness = mountMode({
			withContext: true,
			indexState: readyState({ albums: [entry], albumBuckets: bucketsFor([entry]) }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
			editorialController: {
				subscribe: editorialStore.subscribe,
				open: editorialOpen,
				follow: vi.fn().mockResolvedValue(true),
				cancel: vi.fn(),
				reset: vi.fn()
			} as unknown as import('$lib/library/EditorialItemController').EditorialItemController
		});

		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: buildUnifiedLibraryPageState({
				scope: 'albums',
				collectionDrill: null,
				itemTarget: { kind: 'album', localId: 'alb-1' },
				// The album shrank since this entry was pushed: index 7 no
				// longer resolves in the one-track order.
				itemDetail: { kind: 'track', trackIndex: 7 },
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set(detailsState);

		// Session-bound restoration rule: the stale child is dropped and the
		// parent album page stands.
		await waitFor(() => screen.getByTestId('unified-album-page'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(screen.queryByTestId('unified-album-track-info')).toBeNull();
		expect(
			editorialOpen.mock.calls.some(
				(call) =>
					(call[0] as { anchor?: { kind?: string } }).anchor?.kind === 'track'
			)
		).toBe(false);
	});

	function compositionRestoreFixture(
		rows: { title: string; itemKey: string }[],
		restoredComposition: { title: string | null } | null = { title: 'Glassworks: Opening' }
	) {
		const composersStore = fakeNamedCountsStore([
			{ label: 'Philip Glass', albumCount: 12, itemKey: 'composer-philip-glass', imageKey: null }
		]);
		const drillStore = fakeDrillStore([
			{ title: 'Glassworks', artist: 'Philip Glass', imageKey: null }
		]);
		const compositionStore = writable<
			import('$lib/library/CompositionBrowseController').CompositionBrowseState
		>({
			phase: 'idle',
			composerLabel: null,
			compositions: [],
			pages: [],
			actionBusy: false,
			notice: null,
			error: null
		});
		const openForComposer = vi.fn().mockResolvedValue(undefined);
		const openComposition = vi.fn().mockResolvedValue(undefined);
		const backToCompositions = vi.fn().mockResolvedValue(undefined);
		const controller = {
			subscribe: compositionStore.subscribe,
			openForComposer,
			openComposition,
			runAction: vi.fn().mockResolvedValue(undefined),
			backToCompositions,
			reset: vi.fn()
		} as unknown as import('$lib/library/CompositionBrowseController').CompositionBrowseController;
		const harness = mountMode({
			withContext: true,
			indexState: readyState(),
			composersStore,
			drillStore,
			compositionController: controller
		});
		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: buildUnifiedLibraryPageState({
				scope: 'albums',
				collectionDrill: { kind: 'composer', label: 'Philip Glass' },
				itemTarget: null,
				composition: restoredComposition,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		const settle = async () => {
			await waitFor(() =>
				expect(openForComposer).toHaveBeenCalledWith(expect.anything(), 'Philip Glass')
			);
			compositionStore.set({
				phase: 'compositions',
				composerLabel: 'Philip Glass',
				compositions: rows.map((row) => ({ ...row, subtitle: '' })),
				pages: [],
				actionBusy: false,
				notice: null,
				error: null
			});
		};
		return { openComposition, backToCompositions, compositionStore, settle };
	}

	function compositionPageState(
		pages: { title: string }[],
		phase: 'page' | 'compositions' = pages.length > 0 ? 'page' : 'compositions'
	): import('$lib/library/CompositionBrowseController').CompositionBrowseState {
		return {
			phase,
			composerLabel: 'Philip Glass',
			compositions: [{ title: 'Glassworks: Opening', subtitle: '', itemKey: 'k-opening' }],
			pages: pages.map((entry) => ({ title: entry.title, actions: [], recordings: [] })),
			actionBusy: false,
			notice: null,
			error: null
		};
	}

	it('records no semantic entries for the composition surface over a palette-opened drill (ri8-1)', async () => {
		const composersStore = fakeNamedCountsStore([
			{ label: 'Philip Glass', albumCount: 12, itemKey: 'composer-philip-glass', imageKey: null }
		]);
		const drillStore = fakeDrillStore([
			{ title: 'Glassworks', artist: 'Philip Glass', imageKey: null }
		]);
		const compositionStore = writable<
			import('$lib/library/CompositionBrowseController').CompositionBrowseState
		>(compositionPageState([], 'compositions'));
		const controller = {
			subscribe: compositionStore.subscribe,
			openForComposer: vi.fn().mockResolvedValue(undefined),
			openComposition: vi.fn().mockResolvedValue(undefined),
			runAction: vi.fn().mockResolvedValue(undefined),
			backToCompositions: vi.fn().mockResolvedValue(undefined),
			reset: vi.fn()
		} as unknown as import('$lib/library/CompositionBrowseController').CompositionBrowseController;
		mountMode({
			indexState: readyState(),
			composersStore,
			drillStore,
			compositionController: controller
		});

		// The composer drill opens from the palette: transient, no entry.
		await fireEvent.click(screen.getByTestId('unified-find'));
		await waitFor(() => expect(composersStore.load).toHaveBeenCalledTimes(1));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'philip glass' }
		});
		const composerRow = await screen.findByText('Composer: Philip Glass');
		await fireEvent.mouseMove(composerRow.closest('button')!);
		const writesBefore = __getNavigationLog().length;
		await fireEvent.click(composerRow.closest('button')!);
		await waitFor(() => screen.getByTestId('unified-drill-compositions-toggle'));

		// Surface enter, composition open, and surface exit: no history writes.
		await fireEvent.click(screen.getByTestId('unified-drill-compositions-toggle'));
		await fireEvent.click(await screen.findByTestId('unified-composition-row-0'));
		compositionStore.set(compositionPageState([{ title: 'Glassworks: Opening' }]));
		await screen.findByTestId('unified-composition-page');
		await fireEvent.click(screen.getByTestId('unified-drill-compositions-toggle'));
		await new Promise((resolve) => setTimeout(resolve, 0));

		const writes = __getNavigationLog()
			.slice(writesBefore)
			.filter((entry) => entry.operation === 'pushState' || entry.operation === 'replaceState');
		expect(writes).toHaveLength(0);
	});

	it('closes a live-pushed composition by traversing to the surface entry (ri8-1)', async () => {
		const { backToCompositions, compositionStore, settle } = compositionRestoreFixture([
			{ title: 'Glassworks: Opening', itemKey: 'k-opening' }
		]);
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		await settle();
		compositionStore.set(compositionPageState([{ title: 'Glassworks: Opening' }]));
		backToCompositions.mockImplementation(async () => {
			compositionStore.set(compositionPageState([]));
		});

		// The RESTORED composition owns no live-pushed entry: its Back
		// rewrites the entry rather than traversing.
		await fireEvent.click(await screen.findByTestId('unified-composition-back'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(browserBack).not.toHaveBeenCalled();

		// A LIVE open over the entry-owning drill pushes one entry…
		const pushWindow = __getNavigationLog().length;
		await fireEvent.click(await screen.findByTestId('unified-composition-row-0'));
		compositionStore.set(compositionPageState([{ title: 'Glassworks: Opening' }]));
		const pushes = __getNavigationLog()
			.slice(pushWindow)
			.filter((entry) => entry.operation === 'pushState');
		expect(pushes).toHaveLength(1);

		// …and its Back traverses to the surface entry without writing.
		const writesBefore = __getNavigationLog().length;
		await fireEvent.click(await screen.findByTestId('unified-composition-back'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(browserBack).toHaveBeenCalledTimes(1);
		const writes = __getNavigationLog()
			.slice(writesBefore)
			.filter((entry) => entry.operation === 'pushState' || entry.operation === 'replaceState');
		expect(writes).toHaveLength(0);
		browserBack.mockRestore();
	});

	it('leaves a live-pushed composition surface by traversing both entries (ri8-1)', async () => {
		const { compositionStore, settle } = compositionRestoreFixture(
			[{ title: 'Glassworks: Opening', itemKey: 'k-opening' }],
			null
		);
		const browserGo = vi.spyOn(window.history, 'go').mockImplementation(() => {});
		// The restored drill owns its entry but the surface is not entered.
		// The drill's history ownership settles when its restore resolves.
		await waitFor(() => screen.getByTestId('unified-drill-compositions-toggle'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));

		const pushWindow = __getNavigationLog().length;
		await fireEvent.click(screen.getByTestId('unified-drill-compositions-toggle'));
		await settle();
		await fireEvent.click(await screen.findByTestId('unified-composition-row-0'));
		compositionStore.set(compositionPageState([{ title: 'Glassworks: Opening' }]));
		await screen.findByTestId('unified-composition-page');
		const pushes = __getNavigationLog()
			.slice(pushWindow)
			.filter((entry) => entry.operation === 'pushState');
		expect(pushes).toHaveLength(2);

		// Toggle-off unwinds both live-pushed entries in one traversal.
		const writesBefore = __getNavigationLog().length;
		await fireEvent.click(screen.getByTestId('unified-drill-compositions-toggle'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(browserGo).toHaveBeenCalledWith(-2);
		const writes = __getNavigationLog()
			.slice(writesBefore)
			.filter((entry) => entry.operation === 'pushState' || entry.operation === 'replaceState');
		expect(writes).toHaveLength(0);
		browserGo.mockRestore();
	});

	it('keeps the persisted composition when Back pops only a nested recording (ri8-2)', async () => {
		const { backToCompositions, compositionStore, settle } = compositionRestoreFixture([
			{ title: 'Glassworks: Opening', itemKey: 'k-opening' }
		]);
		await settle();
		// The restored composition is open; a recording node was then opened
		// in place (no semantic entry, restore title untouched).
		compositionStore.set(
			compositionPageState([{ title: 'Glassworks: Opening' }, { title: 'Glassworks — CBS' }])
		);
		// The real controller pops one level and stays on the parent page.
		backToCompositions.mockImplementation(async () => {
			compositionStore.set(compositionPageState([{ title: 'Glassworks: Opening' }]));
		});
		const writesBefore = __getNavigationLog().length;
		await fireEvent.click(await screen.findByTestId('unified-composition-back'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(backToCompositions).toHaveBeenCalledTimes(1);
		expect((await screen.findByTestId('unified-composition-title')).textContent).toBe(
			'Glassworks: Opening'
		);
		const writes = __getNavigationLog()
			.slice(writesBefore)
			.filter((entry) => entry.operation === 'pushState' || entry.operation === 'replaceState');
		expect(writes).toHaveLength(0);
	});

	it('retires the persisted composition on a genuine return to the list (ri8-2)', async () => {
		const { backToCompositions, compositionStore, settle } = compositionRestoreFixture([
			{ title: 'Glassworks: Opening', itemKey: 'k-opening' }
		]);
		await settle();
		compositionStore.set(compositionPageState([{ title: 'Glassworks: Opening' }]));
		backToCompositions.mockImplementation(async () => {
			compositionStore.set(compositionPageState([]));
		});
		const writesBefore = __getNavigationLog().length;
		await fireEvent.click(await screen.findByTestId('unified-composition-back'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await screen.findByTestId('unified-composition-list');
		const writes = __getNavigationLog()
			.slice(writesBefore)
			.filter((entry) => entry.operation === 'pushState' || entry.operation === 'replaceState');
		expect(writes.length).toBeGreaterThan(0);
		const latest = writes.at(-1)?.state as {
			library?: { snapshot?: { composition?: { title: string | null } | null } };
		};
		// The surface stays open at the list: persisted as an open surface
		// with no composition title.
		expect(latest.library?.snapshot?.composition).toEqual({ title: null });
	});

	it('restores a persisted composition by its exactly-one title match (Slice 8)', async () => {
		const { openComposition, settle } = compositionRestoreFixture([
			{ title: 'Glassworks: Opening', itemKey: 'k-opening' },
			{ title: 'Another Work', itemKey: 'k-other' }
		]);
		await settle();
		await waitFor(() =>
			expect(openComposition).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ itemKey: 'k-opening' })
			)
		);
		expect(openComposition).toHaveBeenCalledTimes(1);
	});

	it('keeps the composition list when a restored title is ambiguous (Slice 8)', async () => {
		const { openComposition, settle } = compositionRestoreFixture([
			{ title: 'Glassworks: Opening', itemKey: 'k-opening' },
			{ title: 'Glassworks: Opening', itemKey: 'k-duplicate' }
		]);
		await settle();
		await screen.findByTestId('unified-composition-list');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(openComposition).not.toHaveBeenCalled();
	});

	it('begins album and track actions from the exact selected page version', async () => {
		setZonesSnapshot([
			{
				zone_id: 'zone-1',
				display_name: 'Living Room',
				state: 'paused',
				is_play_allowed: true,
				is_pause_allowed: true,
				is_previous_allowed: true,
				is_next_allowed: true,
				is_seek_allowed: true,
				outputs: []
			}
		]);
		const entry = { ...albumEntry('alb-1', 'Album', 'art-1'), catalogLocalId: 'alb-1' };
		const album = fakeModeAlbumController();
		const actions = fakeModeActionController();
		mountMode({
			indexState: readyState({ albums: [entry], albumBuckets: bucketsFor([entry]) }),
			albumController: album.controller,
			albumActionController: actions
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getByTestId('unified-tile'));
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set({
			phase: 'details',
			activeTab: 'details',
			albumLocalId: 'alb-1',
			generation: 1,
			requestId: 'request-1',
			operationId: 'page-1',
			resolvingDeadlineAt: 2,
			artist: 'Artist',
			title: 'Album',
			versions: [
				{
					versionId: 'version-2',
					editionText: '',
					phase: 'loaded',
					trackCount: 1,
					code: null,
					error: null
				}
			],
			selectedVersionId: 'version-2',
			actionsAvailable: true,
			orderedTracks: [{ index: 0, title: 'Exact track' }],
			code: null,
			error: null,
			transitionedAt: 2
		});

		await fireEvent.click(await screen.findByTestId('unified-album-play'));
		expect(actions.begin).toHaveBeenNthCalledWith(1, {
			pageId: 'page-1',
			versionId: 'version-2',
			zoneId: 'zone-1',
			tabId: expect.any(String),
			generation: 1,
			desiredSemantic: 'play-now'
		});

		await fireEvent.click(screen.getByTestId('unified-track-action-0'));
		expect(actions.begin).toHaveBeenNthCalledWith(2, {
			pageId: 'page-1',
			versionId: 'version-2',
			zoneId: 'zone-1',
			tabId: expect.any(String),
			generation: 1,
			track: { index: 0, title: 'Exact track' },
			desiredSemantic: 'play-now'
		});
	});

	it('hydrates an unresolved root album before opening its live sheet', async () => {
		const album = fakeModeAlbumController();
		const hydration = deferred<unknown>();
		const hydrateArtistAlbums = vi.fn(() => hydration.promise);
		const greenDay: LibraryArtistEntry = {
			id: 'art-green-day',
			name: 'Greta Dawn',
			searchKey: 'green day',
			albumCount: 1,
			countComplete: true,
			catalogLocalId: 'art-green-day'
		};
		const uno: LibraryAlbumEntry = {
			id: 'alb-uno',
			title: '¡Uno!',
			artist: 'Greta Dawn',
			searchKey: '¡uno! green day',
			catalogLocalId: 'alb-uno',
			resolutionStatus: 'unresolved'
		};
		mountMode({
			indexState: readyState({
				revision: 7,
				status: syntheticStatus({ revision: 7 }),
				artists: [greenDay],
				albums: [uno],
				artistBuckets: bucketsFor([greenDay]),
				albumBuckets: bucketsFor([uno])
			}),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
			hydrateArtistAlbums
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getByText('¡Uno!').closest('button')!);

		await waitFor(() =>
			expect(hydrateArtistAlbums).toHaveBeenCalledWith(
				expect.any(Function),
				'art-green-day',
				7
			)
		);
		expect(album.open).not.toHaveBeenCalled();

		hydration.resolve({
			status: syntheticStatus({ revision: 8 }),
			artist: {
				localId: 'art-green-day',
				coreId: 'core-a',
				exactName: 'Greta Dawn',
				normalizedName: 'green day',
				firstSeenAt: '2026-07-24T12:00:00.000Z',
				lastSeenAt: '2026-07-24T12:00:00.000Z',
				resolutionStatus: 'resolved'
			},
			limit: 500,
			total: 1,
			truncated: false,
			albums: [
				{
					localId: 'alb-uno',
					coreId: 'core-a',
					exactTitle: '¡Uno!',
					exactArtist: 'Greta Dawn',
					normalizedTitle: '¡uno!',
					normalizedArtist: 'green day',
					editionText: '',
					firstSeenAt: '2026-07-24T12:00:00.000Z',
					lastSeenAt: '2026-07-24T12:00:00.000Z',
					resolutionStatus: 'resolved',
					artistLocalId: 'art-green-day'
				}
			]
		});
		await waitFor(() =>
			expect(album.open).toHaveBeenCalledWith(
				expect.objectContaining({ albumLocalId: 'alb-uno' })
			)
		);
	});

	it('abandons a superseded album open (ri1-1)', async () => {
		const album = fakeModeAlbumController();
		const hydration = deferred<unknown>();
		const hydrateArtistAlbums = vi.fn(() => hydration.promise);
		const artist: LibraryArtistEntry = {
			id: 'art-a',
			name: 'Artist A',
			searchKey: 'artist a',
			albumCount: 1,
			countComplete: true,
			catalogLocalId: 'art-a'
		};
		const unresolved: LibraryAlbumEntry = {
			id: 'alb-a',
			title: 'Pending Album',
			artist: 'Artist A',
			searchKey: 'pending album artist a',
			catalogLocalId: 'alb-a',
			resolutionStatus: 'unresolved'
		};
		mountMode({
			indexState: readyState({
				revision: 7,
				status: syntheticStatus({ revision: 7 }),
				artists: [artist],
				albums: [unresolved],
				artistBuckets: bucketsFor([artist]),
				albumBuckets: bucketsFor([unresolved])
			}),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
			hydrateArtistAlbums
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getByText('Pending Album').closest('button')!);
		await waitFor(() => expect(hydrateArtistAlbums).toHaveBeenCalled());
		expect(album.open).not.toHaveBeenCalled();

		// The page is closed while its hydration is still pending; the stale
		// continuation must not reopen the read over whatever came next.
		await fireEvent.click(screen.getByTestId('unified-album-back'));
		hydration.resolve({
			status: syntheticStatus({ revision: 8 }),
			artist: {
				localId: 'art-a',
				coreId: 'core-a',
				exactName: 'Artist A',
				normalizedName: 'artist a',
				firstSeenAt: '2026-07-24T12:00:00.000Z',
				lastSeenAt: '2026-07-24T12:00:00.000Z',
				resolutionStatus: 'resolved'
			},
			limit: 500,
			total: 1,
			truncated: false,
			albums: []
		});
		// Give the stale continuation a real settle window: under the fault
		// it reaches albumController.open only after the claim-ready await.
		await new Promise((resolve) => setTimeout(resolve, 25));
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(album.open).not.toHaveBeenCalled();
	});

	it('palette-owned pages never push history (ri1-2)', async () => {
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const album = fakeModeAlbumController();
		const composersStore = fakeNamedCountsStore([
			{ label: 'Philip Glass', albumCount: 1, itemKey: 'composer-pg', imageKey: null }
		]);
		const drillStore = fakeDrillStore([
			{ title: 'Glassworks', artist: 'Philip Glass', imageKey: null }
		]);
		const glassworks: LibraryAlbumEntry = {
			id: 'alb-glassworks',
			title: 'Glassworks',
			artist: 'Philip Glass',
			searchKey: 'glassworks philip glass',
			catalogLocalId: 'alb-glassworks',
			resolutionStatus: 'resolved'
		};
		mountMode({
			indexState: readyState({ albums: [glassworks] }),
			composersStore,
			drillStore,
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'philip glass' }
		});
		const composerRow = await screen.findByText('Composer: Philip Glass');
		await fireEvent.mouseMove(composerRow.closest('button')!);
		await fireEvent.click(composerRow.closest('button')!);
		await waitFor(() => expect(drillStore.load).toHaveBeenCalled());

		// An album opened INSIDE the palette-owned view inherits the
		// nested-view rule: no history entry to leave behind (ri1-2).
		await fireEvent.click((await screen.findByText('Glassworks')).closest('button')!);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		expect(
			__getNavigationLog().filter((entry) => entry.operation === 'pushState')
		).toHaveLength(0);

		await fireEvent.click(screen.getByTestId('unified-album-back'));
		expect(browserBack).not.toHaveBeenCalled();
		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect(screen.getByTestId('unified-palette-input')).toHaveValue('philip glass');
		browserBack.mockRestore();
	});

	it('restores collection scroll across a recorded item Back (ri1-4)', async () => {
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const album = fakeModeAlbumController();
		const genresStore = fakeNamedCountsStore([
			{ label: 'Jazz', albumCount: 1, itemKey: 'k:jazz', imageKey: null }
		]);
		const drillStore = fakeDrillStore([
			{ title: 'Kind of Blue', artist: 'Miles Davis', imageKey: null }
		]);
		const kob: LibraryAlbumEntry = {
			id: 'alb-kob',
			title: 'Kind of Blue',
			artist: 'Miles Davis',
			searchKey: 'kind of blue miles davis',
			catalogLocalId: 'alb-kob',
			resolutionStatus: 'resolved'
		};
		const harness = mountMode({
			withContext: true,
			indexState: readyState({ albums: [kob] }),
			genresStore,
			drillStore,
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});
		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedLibraryPageState({
				scope: 'genres',
				collectionDrill: { kind: 'genre', label: 'Jazz' },
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await waitFor(() => expect(drillStore.load).toHaveBeenCalled());
		await screen.findByText('Kind of Blue');

		const pane = screen.getByTestId('unified-pane');
		pane.scrollTop = 640;
		await fireEvent.click(screen.getByText('Kind of Blue').closest('button')!);
		await waitFor(() => expect(album.open).toHaveBeenCalled());

		await fireEvent.click(screen.getByTestId('unified-album-back'));
		expect(browserBack).toHaveBeenCalledTimes(1);
		// The real pop navigation re-renders the pane at the top; model that
		// so a leftover in-place restore cannot mask a broken pop path (the
		// reviewer's ri1-4 vacuity catch).
		await new Promise((resolve) => setTimeout(resolve, 0));
		pane.scrollTop = 0;
		// The host answers the pop by suspending and resuming with the
		// parent collection entry; the parked scroll must survive it.
		harness.registered.lifecycle!.suspend();
		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: buildUnifiedLibraryPageState({
				scope: 'genres',
				collectionDrill: { kind: 'genre', label: 'Jazz' },
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await screen.findByText('Kind of Blue');
		await waitFor(() => expect(pane.scrollTop).toBe(640));
		browserBack.mockRestore();
	});

	it('degrades a vanished genre label to the parent scope with a notice', async () => {
		const genresStore = fakeNamedCountsStore([
			{ label: 'Blues', albumCount: 11, itemKey: 'k:blues', imageKey: null }
		]);
		const drillStore = fakeDrillStore([]);
		const harness = mountMode({
			withContext: true,
			indexState: readyState(),
			genresStore,
			drillStore
		});

		harness.registered.lifecycle?.resume({
			pageState: buildUnifiedLibraryPageState({
				scope: 'genres',
				collectionDrill: { kind: 'genre', label: 'Gone' },
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);

		const notice = await screen.findByTestId('unified-drill-notice');
		expect(notice.textContent).toContain('Gone');
		expect(screen.queryByTestId('unified-drill-label')).toBeNull();
		expect(drillStore.load).not.toHaveBeenCalled();
	});
});

describe('UnifiedLibraryMode — palette capture (plan §3.2 slice 7)', () => {
	beforeEach(() => {
		__resetNavigation('http://localhost/library');
		clearPendingLibraryPageStateWrite();
		resetLibraryIntentStore();
		setZonesSnapshot([]);
	});

	it('typing anywhere in the mounted view opens the palette seeded', async () => {
		mountMode({ indexState: readyState() });

		await fireEvent.keyDown(window, { key: 'b' });

		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect((screen.getByTestId('unified-palette-input') as HTMLInputElement).value).toBe('b');
	});

	it('never captures while a form control has focus', async () => {
		mountMode({ indexState: readyState() });

		// The sort control is a button now (prototype `.sortc`); the capture
		// guard is about text-editing controls, so exercise a real input.
		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();
		const event = new KeyboardEvent('keydown', {
			key: 'b',
			bubbles: true,
			cancelable: true
		});
		input.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(screen.queryByTestId('unified-palette')).toBeNull();
		input.remove();
	});

	it('Cmd/Ctrl-K toggles the palette as an explicit chord', async () => {
		mountMode({ indexState: readyState() });

		await fireEvent.keyDown(window, { key: 'k', metaKey: true });
		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();

		await fireEvent.keyDown(window, { key: 'k', metaKey: true });
		expect(screen.queryByTestId('unified-palette')).toBeNull();
	});

	it('opens from the top-bar Find affordance', async () => {
		mountMode({ indexState: readyState() });

		await fireEvent.click(screen.getByTestId('unified-find'));

		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
	});

	it('claims a semantic Library search intent and opens the Unified palette seeded', async () => {
		mountMode({ indexState: readyState() });

		publishLibraryIntent({
			kind: 'track',
			destination: 'search',
			query: 'A Sort of Homecoming',
			display: { title: 'A Sort of Homecoming', artist: 'U2' }
		});

		await waitFor(() =>
			expect(screen.getByTestId('unified-palette-input')).toHaveValue('A Sort of Homecoming')
		);
		expect(get(pendingLibraryIntentStore)).toBeNull();
	});

	it('serves the composition surface from the composer drill (Slice 6)', async () => {
		setZonesSnapshot([
			{
				zone_id: 'zone-1',
				display_name: 'Living Room',
				state: 'paused',
				is_play_allowed: true,
				is_pause_allowed: true,
				is_previous_allowed: true,
				is_next_allowed: true,
				is_seek_allowed: true,
				outputs: []
			}
		]);
		const composersStore = fakeNamedCountsStore([
			{ label: 'Philip Glass', albumCount: 12, itemKey: 'composer-philip-glass', imageKey: null }
		]);
		const drillStore = fakeDrillStore([
			{ title: 'Glassworks', artist: 'Philip Glass', imageKey: null }
		]);
		const compositionStore = writable<
			import('$lib/library/CompositionBrowseController').CompositionBrowseState
		>({
			phase: 'idle',
			composerLabel: null,
			compositions: [],
			pages: [],
			actionBusy: false,
			notice: null,
			error: null
		});
		const openForComposer = vi.fn().mockResolvedValue(undefined);
		const openComposition = vi.fn().mockResolvedValue(undefined);
		const runAction = vi.fn().mockResolvedValue(undefined);
		const composition = {
			subscribe: compositionStore.subscribe,
			openForComposer,
			openComposition,
			runAction,
			backToCompositions: vi.fn().mockResolvedValue(undefined),
			reset: vi.fn()
		} as unknown as import('$lib/library/CompositionBrowseController').CompositionBrowseController;
		mountMode({
			indexState: readyState(),
			composersStore,
			drillStore,
			compositionController: composition
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await waitFor(() => expect(composersStore.load).toHaveBeenCalledTimes(1));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'philip glass' }
		});
		const composerRow = await screen.findByText('Composer: Philip Glass');
		await fireEvent.mouseMove(composerRow.closest('button')!);
		await fireEvent.click(composerRow.closest('button')!);
		await waitFor(() => screen.getByTestId('unified-drill-compositions-toggle'));

		await fireEvent.click(screen.getByTestId('unified-drill-compositions-toggle'));
		expect(openForComposer).toHaveBeenCalledWith(expect.anything(), 'Philip Glass');
		compositionStore.set({
			phase: 'compositions',
			composerLabel: 'Philip Glass',
			compositions: [{ title: 'Glassworks: Opening', subtitle: '', itemKey: 'k-opening' }],
			pages: [],
			actionBusy: false,
			notice: null,
			error: null
		});
		await fireEvent.click(await screen.findByTestId('unified-composition-row-0'));
		expect(openComposition).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ itemKey: 'k-opening' })
		);
		compositionStore.set({
			phase: 'page',
			composerLabel: 'Philip Glass',
			compositions: [{ title: 'Glassworks: Opening', subtitle: '', itemKey: 'k-opening' }],
			pages: [
				{
					title: 'Glassworks: Opening',
					actions: [{ title: 'Play Work', itemKey: 'k-playwork' }],
					recordings: [{ title: 'Glassworks — CBS', subtitle: 'Philip Glass', itemKey: 'k-rec' }]
				}
			],
			actionBusy: false,
			notice: null,
			error: null
		});
		expect(
			(await screen.findByTestId('unified-composition-title')).textContent
		).toBe('Glassworks: Opening');
		// One zone executes Play Work directly with that zone.
		await fireEvent.click(screen.getByTestId('unified-composition-action-0'));
		expect(runAction).toHaveBeenCalledWith(
			expect.anything(),
			{ title: 'Play Work', itemKey: 'k-playwork' },
			'zone-1'
		);
	});

	it('opens a composer page and Back restores the same query and selected row', async () => {
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const composersStore = fakeNamedCountsStore([
			{
				label: 'Philip Glass',
				albumCount: 12,
				itemKey: 'composer-philip-glass',
				imageKey: null
			}
		]);
		const drillStore = fakeDrillStore([
			{ title: 'Glassworks', artist: 'Philip Glass', imageKey: null }
		]);
		mountMode({
			indexState: readyState(),
			composersStore,
			drillStore
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await waitFor(() => expect(composersStore.load).toHaveBeenCalledTimes(1));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'philip glass' }
		});
		const composerRow = await screen.findByText('Composer: Philip Glass');
		await fireEvent.mouseMove(composerRow.closest('button')!);
		await fireEvent.click(composerRow.closest('button')!);

		await waitFor(() =>
			expect(drillStore.load).toHaveBeenCalledWith(
				expect.anything(),
				'composers',
				'Philip Glass'
			)
		);
		expect(screen.queryByTestId('unified-palette')).toBeNull();
		expect(screen.getByTestId('unified-drill-label')).toHaveTextContent('Philip Glass');

		await fireEvent.click(screen.getByTestId('unified-drill-back'));

		expect(browserBack).not.toHaveBeenCalled();
		expect(
			__getNavigationLog().filter((entry) => entry.operation === 'pushState')
		).toHaveLength(0);
		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect(screen.getByTestId('unified-palette-input')).toHaveValue('philip glass');
		expect(screen.getByText('Composer: Philip Glass').closest('button')).toHaveClass('sel');
		browserBack.mockRestore();
	});

	it('opens a song panel and returns to the same query and song row', async () => {
		const paletteSearchStore = writable<PaletteSearchState>({
			phase: 'ready',
			query: 'dear theodosia',
			groups: [
				{
					title: 'Tracks',
					rows: [
						{
							resultId: 'song-dear-theodosia',
							title: 'Dear Theodosia',
							subtitle: 'Orlando Ballet Chorus',
							imageKey: null
						}
					]
				}
			],
			error: null
		});
		mountMode({
			indexState: readyState(),
			paletteSearchStore
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'dear theodosia' }
		});
		const songRow = screen.getByText('Dear Theodosia').closest('button')!;
		await fireEvent.click(songRow);

		expect(screen.queryByTestId('unified-palette')).toBeNull();
		expect(screen.getByTestId('unified-track-page')).toBeInTheDocument();

		await fireEvent.click(screen.getByTestId('unified-song-back'));

		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect(screen.getByTestId('unified-palette-input')).toHaveValue('dear theodosia');
		expect(screen.getByText('Dear Theodosia').closest('button')).toHaveClass('sel');
	});

	it('starts one background relationship lookup without delaying a song action', async () => {
		setZonesSnapshot([
			{
				zone_id: 'zone-1',
				display_name: 'Living Room',
				state: 'paused',
				is_play_allowed: true,
				is_pause_allowed: true,
				is_previous_allowed: true,
				is_next_allowed: true,
				is_seek_allowed: true,
				outputs: []
			}
		]);
		const paletteSearchStore = writable<PaletteSearchState>({
			phase: 'ready',
			query: 'dear theodosia',
			groups: [
				{
					title: 'Tracks',
					rows: [
						{
							resultId: 'song-dear-theodosia',
							title: 'Dear Theodosia',
							subtitle: 'Orlando Ballet Chorus',
							imageKey: null
						}
					]
				}
			],
			error: null
		});
		const pendingRelationship = deferred<{
			songTitle: string;
			albums: [];
			composerLabels: [];
		}>();
		const relationship = vi.fn(() => pendingRelationship.promise);
		const action = vi.fn().mockResolvedValue({ authorityRetired: false });
		mountMode({
			indexState: readyState(),
			paletteSearchStore,
			songRelationshipClient: { relationship },
			songActionController: new UnifiedSongActionController({ action })
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'dear theodosia' }
		});
		await fireEvent.click(screen.getByText('Dear Theodosia').closest('button')!);

		expect(relationship).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('unified-song-relationship-status')).toHaveTextContent(
			'Finding album'
		);
		await fireEvent.click(screen.getByTestId('unified-song-add-next'));
		await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
		expect(relationship).toHaveBeenCalledTimes(1);

		pendingRelationship.resolve({
			songTitle: 'Dear Theodosia',
			albums: [],
			composerLabels: []
		});
		await waitFor(() =>
			expect(screen.getByTestId('unified-song-relationship-status')).toHaveTextContent(
				'No matching album'
			)
		);
	});

	it('keeps song actions available when the relationship lookup fails', async () => {
		setZonesSnapshot([
			{
				zone_id: 'zone-1',
				display_name: 'Living Room',
				state: 'paused',
				is_play_allowed: true,
				is_pause_allowed: true,
				is_previous_allowed: true,
				is_next_allowed: true,
				is_seek_allowed: true,
				outputs: []
			}
		]);
		const paletteSearchStore = writable<PaletteSearchState>({
			phase: 'ready',
			query: 'dear theodosia',
			groups: [
				{
					title: 'Tracks',
					rows: [
						{
							resultId: 'song-dear-theodosia',
							title: 'Dear Theodosia',
							subtitle: 'Orlando Ballet Chorus',
							imageKey: null
						}
					]
				}
			],
			error: null
		});
		const relationship = vi.fn().mockRejectedValue(new Error('Album links are unavailable'));
		const action = vi.fn().mockResolvedValue({ authorityRetired: false });
		mountMode({
			indexState: readyState(),
			paletteSearchStore,
			songRelationshipClient: { relationship },
			songActionController: new UnifiedSongActionController({ action })
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'dear theodosia' }
		});
		await fireEvent.click(screen.getByText('Dear Theodosia').closest('button')!);

		await waitFor(() =>
			expect(screen.getByTestId('unified-song-relationship-status')).toHaveTextContent(
				'Album links are unavailable'
			)
		);
		expect(screen.getByTestId('unified-song-play-now')).toBeEnabled();
		await fireEvent.click(screen.getByTestId('unified-song-play-now'));
		await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
	});

	it('hides the library pane under the search-track page (ri5-1)', async () => {
		const paletteSearchStore = writable<PaletteSearchState>({
			phase: 'ready',
			query: 'dear theodosia',
			groups: [
				{
					title: 'Tracks',
					rows: [
						{
							resultId: 'song-dear-theodosia',
							title: 'Dear Theodosia',
							subtitle: 'Orlando Ballet Chorus',
							imageKey: null
						}
					]
				}
			],
			error: null
		});
		const relationship = vi.fn().mockRejectedValue(new Error('unavailable'));
		mountMode({
			indexState: readyState(),
			paletteSearchStore,
			songRelationshipClient: { relationship }
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'dear theodosia' }
		});
		await fireEvent.click(screen.getByText('Dear Theodosia').closest('button')!);

		// The track page owns the surface: the library body is mounted but
		// hidden, and Back to the results restores it.
		expect(screen.getByTestId('unified-track-page')).toBeInTheDocument();
		expect(screen.getByTestId('unified-pane').closest('.body')).toHaveAttribute('hidden');
		await fireEvent.click(screen.getByTestId('unified-song-back'));
		expect(screen.getByTestId('unified-pane').closest('.body')).not.toHaveAttribute('hidden');
	});

	it('opens the related album group from the song panel', async () => {
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const paletteSearchStore = writable<PaletteSearchState>({
			phase: 'ready',
			query: 'river',
			groups: [
				{
					title: 'Tracks',
					rows: [
						{
							resultId: 'song-river',
							title: 'River',
							subtitle: 'Joni Mitchell',
							imageKey: null
						}
					]
				}
			],
			error: null
		});
		const relationship = vi.fn().mockResolvedValue({
			songTitle: 'River',
			albums: [
				{
					albumLocalId: 'album-blue',
					artistLocalId: 'artist-joni',
					title: 'Blue',
					artist: 'Joni Mitchell',
					editionText: 'Remaster'
				}
			],
			composerLabels: []
		});
		const albumHarness = fakeModeAlbumController();
		mountMode({
			indexState: readyState({
				albums: [
					{
						...albumEntry('album-blue', 'Blue', 'artist-joni'),
						artist: 'Joni Mitchell',
						catalogLocalId: 'album-blue'
					}
				]
			}),
			paletteSearchStore,
			songRelationshipClient: { relationship },
			albumController: albumHarness.controller,
			albumActionController: fakeModeActionController()
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'river' }
		});
		await fireEvent.click(screen.getByText('River').closest('button')!);
		await waitFor(() =>
			expect(screen.getByTestId('unified-song-album-link')).toBeEnabled()
		);
		await fireEvent.click(screen.getByTestId('unified-song-album-link'));

		expect(albumHarness.open).toHaveBeenCalledWith(
			expect.objectContaining({
				albumLocalId: 'album-blue'
			})
		);
		expect(albumHarness.open.mock.calls[0][0]).not.toHaveProperty('candidate');
		expect(screen.queryByTestId('unified-track-page')).toBeNull();
		expect(screen.getByTestId('unified-album-page')).toBeInTheDocument();

		await fireEvent.click(screen.getByTestId('unified-album-back'));

		expect(browserBack).not.toHaveBeenCalled();
		expect(
			__getNavigationLog().filter((entry) => entry.operation === 'pushState')
		).toHaveLength(0);
		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect(screen.getByTestId('unified-palette-input')).toHaveValue('river');
		expect(screen.getByText('River').closest('button')).toHaveClass('sel');
		browserBack.mockRestore();
	});

	it('does not apply a late relationship from an older song to the new panel', async () => {
		const paletteSearchStore = writable<PaletteSearchState>({
			phase: 'ready',
			query: 'songs',
			groups: [
				{
					title: 'Tracks',
					rows: [
						{
							resultId: 'song-first',
							title: 'First Song',
							subtitle: 'First Artist',
							imageKey: null
						},
						{
							resultId: 'song-second',
							title: 'Second Song',
							subtitle: 'Second Artist',
							imageKey: null
						}
					]
				}
			],
			error: null
		});
		const firstRelationship = deferred<{
			songTitle: string;
			albums: [];
			composerLabels: [];
		}>();
		const relationship = vi
			.fn()
			.mockImplementationOnce(() => firstRelationship.promise)
			.mockResolvedValue({
				songTitle: 'Second Song',
				albums: [
					{
						albumLocalId: 'album-second',
						artistLocalId: 'artist-second',
						title: 'Second Album',
						artist: 'Second Artist',
						editionText: ''
					}
				],
				composerLabels: []
			});
		mountMode({
			indexState: readyState(),
			paletteSearchStore,
			clearPaletteSearchData: vi.fn(async () => {}),
			songRelationshipClient: { relationship }
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'songs' }
		});
		await fireEvent.click(screen.getByText('First Song').closest('button')!);
		await fireEvent.click(screen.getByRole('button', { name: 'Close search' }));

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'songs' }
		});
		await fireEvent.click(screen.getByText('Second Song').closest('button')!);
		await waitFor(() =>
			expect(screen.getByTestId('unified-song-album-link')).toBeEnabled()
		);

		firstRelationship.resolve({
			songTitle: 'First Song',
			albums: [],
			composerLabels: []
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(screen.getByTestId('unified-song-title')).toHaveTextContent('Second Song');
		expect(screen.getByTestId('unified-song-album-link')).toBeEnabled();
		expect(screen.getByTestId('unified-song-relationship-status')).toHaveTextContent(
			'One matching album'
		);
	});

	it('wires a named song action to the retained result and chosen zone', async () => {
		setZonesSnapshot([
			{
				zone_id: 'zone-1',
				display_name: 'Living Room',
				state: 'paused',
				is_play_allowed: true,
				is_pause_allowed: true,
				is_previous_allowed: true,
				is_next_allowed: true,
				is_seek_allowed: true,
				outputs: [{ output_id: 'output-1', display_name: 'Living Room' }]
			}
		]);
		const paletteSearchStore = writable<PaletteSearchState>({
			phase: 'ready',
			query: 'dear theodosia',
			groups: [
				{
					title: 'Tracks',
					rows: [
						{
							resultId: 'song-dear-theodosia',
							title: 'Dear Theodosia',
							subtitle: 'Orlando Ballet Chorus',
							imageKey: null
						}
					]
				}
			],
			error: null
		});
		const action = vi.fn().mockResolvedValue({ authorityRetired: false });
		const songActionController = new UnifiedSongActionController({ action });
		mountMode({
			indexState: readyState(),
			paletteSearchStore,
			songActionController
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'dear theodosia' }
		});
		await fireEvent.click(screen.getByText('Dear Theodosia').closest('button')!);
		await fireEvent.click(screen.getByTestId('unified-song-add-next'));

		await waitFor(() =>
			expect(action).toHaveBeenCalledWith(
				expect.objectContaining({ owner: 'unified-mode' }),
				'song-dear-theodosia',
				'zone-1',
				'add-next'
			)
		);
	});

	it('does not apply a settled old-song action to a newly selected song', async () => {
		setZonesSnapshot([
			{
				zone_id: 'zone-1',
				display_name: 'Living Room',
				state: 'paused',
				is_play_allowed: true,
				is_pause_allowed: true,
				is_previous_allowed: true,
				is_next_allowed: true,
				is_seek_allowed: true,
				outputs: [{ output_id: 'output-1', display_name: 'Living Room' }]
			}
		]);
		const paletteSearchStore = writable<PaletteSearchState>({
			phase: 'ready',
			query: 'songs',
			groups: [
				{
					title: 'Tracks',
					rows: [
						{
							resultId: 'song-first',
							title: 'First Song',
							subtitle: 'Artist',
							imageKey: null
						},
						{
							resultId: 'song-second',
							title: 'Second Song',
							subtitle: 'Artist',
							imageKey: null
						}
					]
				}
			],
			error: null
		});
		const firstAction = deferred<{ authorityRetired: boolean }>();
		const action = vi
			.fn()
			.mockImplementationOnce(() => firstAction.promise)
			.mockResolvedValue({ authorityRetired: false });
		const songActionController = new UnifiedSongActionController({ action });
		mountMode({
			indexState: readyState(),
			paletteSearchStore,
			clearPaletteSearchData: vi.fn(async () => {}),
			songActionController
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'songs' }
		});
		await fireEvent.click(screen.getByText('First Song').closest('button')!);
		await fireEvent.click(screen.getByTestId('unified-song-play-now'));
		await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
		await fireEvent.click(screen.getByRole('button', { name: 'Close search' }));

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'songs' }
		});
		await fireEvent.click(screen.getByText('Second Song').closest('button')!);
		expect(screen.getByTestId('unified-song-action-busy')).toBeInTheDocument();

		firstAction.resolve({ authorityRetired: true });
		await waitFor(() =>
			expect(screen.queryByTestId('unified-song-action-busy')).not.toBeInTheDocument()
		);
		expect(screen.getByTestId('unified-song-play-now')).toBeEnabled();

		await fireEvent.click(screen.getByTestId('unified-song-queue'));
		await waitFor(() =>
			expect(action).toHaveBeenLastCalledWith(
				expect.objectContaining({ owner: 'unified-mode' }),
				'song-second',
				'zone-1',
				'queue'
			)
		);
	});

	it('clears server-owned song authority when search is explicitly closed', async () => {
		const clearPaletteSearchData = vi.fn(async () => {});
		const harness = mountMode({
			indexState: readyState(),
			clearPaletteSearchData
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.keyDown(screen.getByTestId('unified-palette-input'), { key: 'Escape' });

		expect(clearPaletteSearchData).toHaveBeenCalledWith(
			expect.objectContaining({ owner: 'unified-mode' })
		);
		expect(harness.resetPaletteSearchData).not.toHaveBeenCalled();
	});

	it('never captures while the album sheet is open', async () => {
		const album = fakeModeAlbumController();
		const harness = mountMode({
			withContext: true,
			indexState: readyState(),
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		harness.registered.lifecycle!.resume({
			pageState: buildUnifiedLibraryPageState({
				scope: 'artists',
				collectionDrill: null,
				itemTarget: { kind: 'album', localId: 'alb-1' },
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await waitFor(() => expect(album.open).toHaveBeenCalled());

		const event = new KeyboardEvent('keydown', {
			key: 'b',
			bubbles: true,
			cancelable: true
		});
		window.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(screen.queryByTestId('unified-palette')).toBeNull();
	});

	it('capture never leaks after suspend', async () => {
		const harness = mountMode({ withContext: true, indexState: readyState() });
		harness.registered.lifecycle!.resume({
			pageState: null
		} as unknown as CommittedLibraryModeActivation);
		await waitFor(() => expect(harness.session.claim).toHaveBeenCalled());

		await fireEvent.keyDown(window, { key: 'b' });
		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();

		harness.registered.lifecycle!.suspend();
		await waitFor(() => expect(screen.queryByTestId('unified-palette')).toBeNull());

		const event = new KeyboardEvent('keydown', {
			key: 'b',
			bubbles: true,
			cancelable: true
		});
		window.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(screen.queryByTestId('unified-palette')).toBeNull();
	});
});

describe('UnifiedLibraryMode — smart-filter pages (plan §3.2 slice 7)', () => {
	beforeEach(() => {
		__resetNavigation('http://localhost/library');
		clearPendingLibraryPageStateWrite();
	});

	function countedIndex(): LibraryIndexState {
		const artists: LibraryArtistEntry[] = [
			{
				id: 'art-big',
				name: 'Big Cat',
				searchKey: 'big cat',
				albumCount: 40,
				countComplete: true,
				catalogLocalId: 'art-big'
			},
			{
				id: 'art-mid',
				name: 'Mid Cat',
				searchKey: 'mid cat',
				albumCount: 35,
				countComplete: true,
				catalogLocalId: 'art-mid'
			},
			{
				id: 'art-two',
				name: 'Two Cat',
				searchKey: 'two cat',
				albumCount: 2,
				countComplete: true,
				catalogLocalId: 'art-two'
			},
			{
				id: 'art-quoted-one',
				name: '“Weird One”',
				searchKey: '“weird one”',
				albumCount: 1,
				countComplete: true,
				catalogLocalId: 'art-quoted-one'
			},
			{
				id: 'art-numbered-one',
				name: '10cc One',
				searchKey: '10cc one',
				albumCount: 1,
				countComplete: true,
				catalogLocalId: 'art-numbered-one'
			}
		];
		return readyState({ artists, artistBuckets: [] });
	}

	function restoredFilterActivation(filterText: string): CommittedLibraryModeActivation {
		return {
			pageState: buildUnifiedLibraryPageState({
				scope: 'artists',
				collectionDrill: null,
				itemTarget: null,
				filterText,
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation;
	}

	it('applies a palette count filter as a history-backed filter page', async () => {
		mountMode({ indexState: countedIndex() });

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: '>30 albums' }
		});
		const filterRow = screen
			.getAllByTestId('unified-palette-row')
			.find((el) => el.textContent?.includes('more than 30'));
		expect(filterRow?.textContent).toContain('2 artists');
		await fireEvent.click(filterRow!);

		expect(screen.queryByTestId('unified-palette')).toBeNull();
		expect(screen.getByTestId('unified-filter-label').textContent).toContain(
			'Artists with more than 30 albums'
		);
		expect(screen.getByTestId('unified-filter-label').tagName).toBe('H2');
		expect(screen.getByTestId('unified-filter-label').closest('.ctx')).not.toBeNull();
		expect(screen.getByTestId('unified-filter-back')).toHaveClass('back');
		expect(screen.getByTestId('unified-filter-back')).toHaveTextContent('← Artists');
		expect(screen.getByTestId('unified-filter-summary')).toHaveClass('n', 'mono');
		expect(screen.getByTestId('unified-filter-summary')).toHaveTextContent('2 ARTISTS');
		expect(screen.getByTestId('unified-filter-results')).toHaveClass('alist');
		// Count-descending, then key: Big Cat (40) before Mid Cat (35).
		const rows = screen.getAllByTestId('unified-filter-artist');
		expect(rows[0]).toHaveClass('arow');
		expect(rows[0].querySelector('.an')).toHaveTextContent('Big Cat');
		expect(rows[0].querySelector('.ac')).toHaveTextContent('40');
		expect(rows[0].textContent).not.toContain('albums');
		expect(rows.map((el) => el.textContent)).toEqual([
			expect.stringContaining('Big Cat'),
			expect.stringContaining('Mid Cat')
		]);

		const pushes = __getNavigationLog().filter((entry) => entry.operation === 'pushState');
		expect(pushes).toHaveLength(1);
		expect(pushes[0].state).toMatchObject({
			library: {
				libraryView: 'unified',
				snapshot: expect.objectContaining({ scope: 'artists', filterText: '>30 albums' })
			}
		});

		// Filter rows drill to the artist.
		await fireEvent.click(rows[0]);
		expect(screen.getByTestId('unified-artist-name').textContent).toContain('Big Cat');
	});

	it('the Back affordance clears the filter and traverses its history entry', async () => {
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		mountMode({ indexState: countedIndex() });

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: '5+ albums' }
		});
		const filterRow = screen
			.getAllByTestId('unified-palette-row')
			.find((el) => el.textContent?.includes('at least 5'));
		await fireEvent.click(filterRow!);
		expect(screen.getByTestId('unified-filter-label')).toBeInTheDocument();

		await fireEvent.click(screen.getByTestId('unified-filter-back'));

		expect(screen.queryByTestId('unified-filter-label')).toBeNull();
		expect(screen.getByTestId('unified-summary')).toBeInTheDocument();
		const pushes = __getNavigationLog().filter((entry) => entry.operation === 'pushState');
		expect(pushes).toHaveLength(1);
		expect(browserBack).toHaveBeenCalledTimes(1);
		browserBack.mockRestore();
	});

	it('restores a filter page from committed page state without self-pushing', async () => {
		const harness = mountMode({ withContext: true, indexState: countedIndex() });

		harness.registered.lifecycle!.resume(restoredFilterActivation('5+ albums'));

		await waitFor(() =>
			expect(screen.getByTestId('unified-filter-label').textContent).toContain(
				'Artists with at least 5 albums'
			)
		);
		expect(screen.getAllByTestId('unified-filter-artist')).toHaveLength(2);
		expect(
			__getNavigationLog().filter((entry) => entry.operation === 'pushState')
		).toHaveLength(0);
	});

	it('uses the reference library order for tied count-filter rows', async () => {
		const harness = mountMode({ withContext: true, indexState: countedIndex() });

		harness.registered.lifecycle!.resume(restoredFilterActivation('one album'));

		await waitFor(() =>
			expect(screen.getByTestId('unified-filter-summary')).toHaveTextContent('2 ARTISTS')
		);
		expect(
			screen
				.getAllByTestId('unified-filter-artist')
				.map((row) => row.querySelector('.an')?.textContent)
		).toEqual(['“Weird One”', '10cc One']);
	});

	it('gates a restored filter page on incomplete Roon artist-count coverage', async () => {
		const harness = mountMode({
			withContext: true,
			indexState: { ...countedIndex(), capabilities: INCOMPLETE_ARTIST_COUNTS_CAPABILITIES }
		});

		harness.registered.lifecycle!.resume(restoredFilterActivation('>30 albums'));

		await waitFor(() =>
			expect(screen.getByTestId('unified-filter-gated').textContent).toContain(
				'Counts are incomplete'
			)
		);
		expect(screen.queryByTestId('unified-filter-results')).toBeNull();
	});

	it('degrades unparseable restored filter text honestly', async () => {
		const harness = mountMode({ withContext: true, indexState: countedIndex() });

		harness.registered.lifecycle!.resume(restoredFilterActivation('bowie'));

		await waitFor(() =>
			expect(screen.getByTestId('unified-filter-invalid')).toBeInTheDocument()
		);
		expect(screen.queryByTestId('unified-filter-results')).toBeNull();
	});
});

describe('UnifiedLibraryMode — Playlists scope (Slice 7)', () => {
	const SMART_ID = 'aa'.repeat(20);
	const MANUAL_ID = 'bb'.repeat(20);

	const PLAYLIST_ENTRIES: PlaylistSummaryView[] = [
		{
			playlistId: SMART_ID,
			name: 'Last Year',
			kind: 'smart',
			trackCount: 481,
			openable: true
		},
		{
			playlistId: MANUAL_ID,
			name: 'Tidal Picks',
			kind: 'manual',
			trackCount: null,
			openable: false,
			unopenableReason: 'streaming-service playlists are not supported'
		}
	];

	const CONTENTS: Record<string, Omit<PlaylistContentsResponse, 'status'>> = {
		[SMART_ID]: {
			playlistId: SMART_ID,
			name: 'Last Year',
			kind: 'smart',
			totalCount: 481,
			truncated: true,
			items: [
				{
					position: 0,
					title: 'Defying Gravity',
					artist: 'Orlando Ballet Chorus',
					albumTitle: 'Wicked',
					lengthSeconds: 305,
					authority: {
						state: 'resolver-capable',
						selectionId: 'playlist-selection-1'
					}
				},
				{
					position: 1,
					title: 'Off Catalog',
					artist: 'Someone',
					albumTitle: '',
					lengthSeconds: null,
					authority: {
						state: 'unavailable',
						reason: {
							code: 'source-unavailable',
							message: 'this track is not available in the current source'
						}
					}
				}
			]
		}
	};

	beforeEach(() => {
		setZonesSnapshot([]);
	});

	it('hides the Playlists chip when the base native capability is unavailable (no play-gate coupling)', async () => {
		mountMode({
			indexState: readyState({
				capabilities: {
					...CATALOG_CAPABILITIES,
					// Play features up, playlist gate down: the chip rides the BASE
					// native capability, never the play/date gates.
					playFeatures: true,
					playlistFeatures: false,
					playlistFeaturesDisabledReason:
						'the native playlist list has not been pulled yet; it arrives with the next catalog refresh'
				}
			})
		});

		expect(screen.queryByTestId('unified-scope-playlists')).toBeNull();
		expect(screen.queryByText('Playlists')).toBeNull();
		// Most played (play gate) is still present — the gates are independent.
		expect(screen.getByTestId('unified-scope-most-played')).toBeInTheDocument();
	});

	it('degrades a restored Playlists page to the carried reason when the feature is gone', async () => {
		const harness = mountMode({
			withContext: true,
			indexState: readyState({
				capabilities: {
					...CATALOG_CAPABILITIES,
					playlistFeatures: false,
					playlistFeaturesDisabledReason: 'no native catalog snapshot is available'
				}
			}),
			playlistsStore: fakePlaylistsStore(PLAYLIST_ENTRIES)
		});
		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedLibraryPageState({
				scope: 'playlists',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);

		await waitFor(() =>
			expect(screen.getByTestId('unified-playlists-gated')).toHaveTextContent(
				'no native catalog snapshot is available'
			)
		);
		// No guessed data even though a list is loaded; the chip is absent.
		expect(screen.queryByTestId('unified-playlist-openable')).toBeNull();
		expect(screen.queryByTestId('unified-scope-playlists')).toBeNull();
	});

	it('flips every native-derived read feature off together under a protocol-incompatible capability (Slice 8)', async () => {
		// The capability state machine's PROTOCOL_INCOMPATIBLE reason, carried
		// on the index exactly as the Slice-8 backend simulation serves it.
		const pinReason =
			"the Core's protocol is not compatible with this build; the server log has the detail";
		mountMode({
			indexState: readyState({
				albums: [albumEntry('alb-1', 'Alpha', 'art-0')],
				capabilities: {
					...CATALOG_CAPABILITIES,
					dateFeatures: false,
					dateFeaturesDisabledReason: pinReason,
					playFeatures: false,
					playFeaturesDisabledReason: pinReason,
					playlistFeatures: false,
					playlistFeaturesDisabledReason: pinReason
				}
			})
		});

		// All three scope chips are absent together — the exact pre-feature
		// chip row (absent, never rendered disabled).
		expect(screen.queryByTestId('unified-scope-recently-added')).toBeNull();
		expect(screen.queryByTestId('unified-scope-most-played')).toBeNull();
		expect(screen.queryByTestId('unified-scope-playlists')).toBeNull();

		// The album sort menu degrades to the disabled Release-year entry
		// carrying the capability's own reason (the pre-native presentation).
		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		const releaseYear = screen.getByTestId(
			'unified-sort-option-release-year'
		) as HTMLOptionElement;
		expect(releaseYear.disabled).toBe(true);
		expect(releaseYear.title).toBe(pinReason);
		expect(screen.queryByTestId('unified-sort-option-year-asc')).toBeNull();
		expect(screen.queryByTestId('unified-sort-option-year-desc')).toBeNull();
	});

});

describe('UnifiedLibraryMode — a build without the extended scope views', () => {
	/**
	 * The surface with both extended scope slots empty, which is what the
	 * `@libraryFeatures` alias resolves to when the implementation directory is
	 * not in the checkout. These cases must keep passing after that directory is
	 * deleted, so they inject the empty slots rather than relying on how this
	 * checkout happens to resolve — and they mount stores that DO carry data, so
	 * a view sneaking back in would show up as rendered rows.
	 */
	const noScopeViews = { mostPlayedView: null, playlistsView: null };

	beforeEach(() => {
		__resetNavigation();
		clearPendingLibraryPageStateWrite();
		setZonesSnapshot([]);
	});

	it('renders an honest hint for a restored Most played page, never a broken view', async () => {
		const harness = mountMode({
			withContext: true,
			// Capability available on purpose: the empty slot must be the only
			// reason the hint appears, or the case would pass without the slot
			// check and prove nothing.
			indexState: readyState({
				capabilities: { ...CATALOG_CAPABILITIES, dateFeatures: true, playFeatures: true }
			}),
			scopeSlots: noScopeViews,
			mostPlayedStore: fakeMostPlayedStore()
		});
		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedLibraryPageState({
				scope: 'most-played',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);

		await waitFor(() =>
			expect(screen.getByTestId('unified-most-played-gated')).toHaveTextContent(
				'Most played is unavailable.'
			)
		);
		// The hint is the whole surface: no panel, no tabs, nothing disabled.
		expect(screen.queryByTestId('unified-most-played-panel')).toBeNull();
		expect(screen.queryByTestId('unified-most-played-loading')).toBeNull();
	});

	it('renders an honest hint for a restored Playlists page, never a broken view', async () => {
		const harness = mountMode({
			withContext: true,
			// Playlist features available, so the hint cannot come from the gate.
			indexState: readyState({
				capabilities: { ...CATALOG_CAPABILITIES, playlistFeatures: true }
			}),
			scopeSlots: noScopeViews,
			playlistsStore: fakePlaylistsStore([
				{
					playlistId: 'pl-1',
					title: 'Evening',
					kind: 'manual',
					openable: { state: 'openable' }
				} as unknown as PlaylistSummaryView
			])
		});
		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedLibraryPageState({
				scope: 'playlists',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);

		await waitFor(() =>
			expect(screen.getByTestId('unified-playlists-gated')).toHaveTextContent(
				'Playlists are unavailable.'
			)
		);
		// A loaded list is in the store and still nothing from it reaches the DOM.
		expect(screen.queryByTestId('unified-playlist-openable')).toBeNull();
		expect(screen.queryByTestId('unified-playlists-list')).toBeNull();
		expect(screen.queryByText('Evening')).toBeNull();
	});
});

describe('UnifiedLibraryMode — brand wordmark', () => {
	it('shows the runic mark by default and flips to the Latin spelling on click', async () => {
		mountMode({ indexState: readyState() });

		const brand = screen.getByTestId('unified-brand');
		// The accessible name is the Latin spelling in both states, so the runes
		// never reach a screen reader as five separate rune names.
		expect(brand).toHaveAttribute('aria-label', 'S\u01EBngr');
		expect(screen.getByTestId('unified-brand-runes')).toBeTruthy();
		expect(screen.queryByTestId('unified-brand-latin')).toBeNull();

		await fireEvent.click(brand);

		expect(screen.getByTestId('unified-brand-latin').textContent?.trim()).toBe('S\u01EBngr');
		expect(screen.queryByTestId('unified-brand-runes')).toBeNull();

		await fireEvent.click(brand);
		expect(screen.getByTestId('unified-brand-runes')).toBeTruthy();
	});

	it('never renders the Roon trademark as the product wordmark', () => {
		mountMode({ indexState: readyState() });
		expect(screen.getByTestId('unified-brand').textContent ?? '').not.toContain('ROON');
	});
});

describe('UnifiedLibraryMode — About panel', () => {
	it('is closed until opened, then reports interface and Core version provenance', async () => {
		mountMode({ indexState: readyState() });

		expect(screen.queryByTestId('unified-about-panel')).toBeNull();
		const open = screen.getByTestId('unified-about-open');
		expect(open).toHaveAttribute('aria-expanded', 'false');

		await fireEvent.click(open);

		const panel = screen.getByTestId('unified-about-panel');
		expect(panel).toHaveAttribute('role', 'dialog');
		expect(open).toHaveAttribute('aria-expanded', 'true');
		// Version provenance is the reason this surface exists: without it the
		// default view reveals nothing about what build is running.
		expect(screen.getByTestId('unified-about-ui-revision').textContent).toContain('rev');
		expect(screen.getByTestId('unified-about-core-name')).toBeTruthy();
		expect(screen.getByTestId('unified-about-core-version')).toBeTruthy();
		expect(panel.textContent ?? '').toContain('web-based controller for Roon');
		expect(panel.textContent ?? '').toContain('Not affiliated with or endorsed by Roon Labs LLC.');

		await fireEvent.click(screen.getByTestId('unified-about-close'));
		expect(screen.queryByTestId('unified-about-panel')).toBeNull();
	});

	it('reports the Settings System connection labels and good state', async () => {
		setSocketStatus('connecting');
		setCoreStatus({ status: 'discovering' });
		mountMode({ indexState: readyState() });

		await fireEvent.click(screen.getByTestId('unified-about-open'));
		const connection = screen.getByTestId('unified-about-connection');
		expect(connection).toHaveTextContent('Connecting…');
		expect(connection).not.toHaveClass('good');

		setSocketStatus('disconnected');
		await waitFor(() => expect(connection).toHaveTextContent('Disconnected'));
		expect(connection).not.toHaveClass('good');

		setSocketStatus('connected');
		await waitFor(() => expect(connection).toHaveTextContent('Searching for Core…'));
		expect(connection).not.toHaveClass('good');

		setCoreStatus({ status: 'paired' });
		await waitFor(() => expect(connection).toHaveTextContent('Connected'));
		expect(connection).toHaveClass('good');
	});
});

describe('UnifiedLibraryMode — Controller settings trigger', () => {
	// Settings must stay reachable from unified (public issue #1's second
	// finding). The floating gear that used to carry that guarantee was
	// excised by owner ruling 2026-08-08; the bar button is now the only
	// path, so this test is the reachability guard.
	it('docks the settings trigger in the bar, before About, and opens the shared dialog store', async () => {
		settingsMenuOpen.set(false);
		mountMode({ indexState: readyState() });

		const trigger = screen.getByTestId('unified-settings-open');
		expect(trigger).toHaveAttribute('aria-label', 'Open Controller settings');
		expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
		expect(trigger).toHaveAttribute('aria-expanded', 'false');
		const about = screen.getByTestId('unified-about-open');
		expect(
			trigger.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();

		await fireEvent.click(trigger);
		expect(get(settingsMenuOpen)).toBe(true);
		expect(trigger).toHaveAttribute('aria-expanded', 'true');
	});
});
