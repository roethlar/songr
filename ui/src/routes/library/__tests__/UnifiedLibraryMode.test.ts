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
import type { LibraryAlbumController, LibraryAlbumState } from '$lib/library/LibraryAlbumController';
import { UnifiedSongActionController } from '$lib/library/UnifiedSongActionController';
import type { UnifiedSearchClient } from '$lib/unifiedSearchClient';
import type { AlbumActionController } from '$lib/library/AlbumActionController';
import type {
	UnifiedBrowseActionController,
	UnifiedBrowseActionSource,
	UnifiedBrowseActionState,
	UnifiedBrowseController,
	UnifiedBrowseState
} from '$lib/library/UnifiedBrowseController';
import type { BrowseItem, CoreStatusResponse } from '@shared/types';
import { LIBRARY_OPEN_CONTRACT, type LibraryNodeKind } from '@shared/libraryOpenContracts';
import { LIBRARY_ROOTS_CONTRACT, LIBRARY_SESSION_RETIRED_CONTRACT } from '@shared/libraryRootsContracts';
import {
	libraryRootsStore,
	loadLibraryRoots,
	refreshLibraryRootsNow,
	resetLibraryRoots,
	retireLibraryGeneration
} from '$lib/stores/libraryRootsStore';
import { clearPendingLibraryPageStateWrite } from '$lib/libraryPageNavigation';
import { decodeLibraryRoute } from '$lib/libraryRoute';
import { libraryPageStateFromRoute } from '$lib/libraryRouteState';
import {
	__back,
	__forward,
	__getHistorySnapshot,
	__getNavigationLog,
	__resetNavigation
} from '../../../test/app-stubs/navigation';
import { NO_GENRE_SORT_REASON, NO_IMPORT_DATES_REASON, NO_RELEASE_DATES_REASON } from '$lib/unifiedLibrarySorts';
import type { NamedCountEntry } from '$lib/stores/unifiedNamedCountsStore';
import { COLLECTION_DRILL_SOURCE_CONTRACT } from '@shared/collectionDrillContracts';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { settingsMenuOpen } from '$lib/stores/settingsMenuStore';
import { requestUnifiedLibraryDensity } from '$lib/stores/unifiedLibraryPrefsStore';
import { setCoreStatus } from '$lib/stores/coreStore';
import { setSocketStatus } from '$lib/stores/socketStatusStore';
import type { CommittedLibraryModeActivation } from '$lib/libraryModeActivationContext';
import type { ClassicBrowseSessionClaim } from '$lib/stores/classicBrowseSessionStore';
import type { PaletteSearchState } from '$lib/stores/unifiedPaletteSearchStore';
import {
	pendingLibraryIntentStore,
	publishLibraryIntent,
	resetLibraryIntentStore
} from '$lib/stores/libraryIntentStore';
import {
	deferred,
	fakeConnectionSocket,
	fakeModeActionController,
	fakeRecoveringModeActionController,
	fakeModeAlbumController,
	fakeNamedCountsStore,
	fakeRecentStore,
	fakeSessionClient,
	harnessAlbum,
	harnessArtists,
	harnessLibrary,
	liveOpenResponder,
	liveRootsState,
	mountMode,
	type HarnessLiveLibrary
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
		zoneId: null,
		available: { 'play-now': false, 'add-next': false, queue: false },
		error: null
	});
	const store = writable<UnifiedBrowseActionState>(idle());
	// Records the probed zone the way the real controller does, so the
	// surface's re-probe effect can tell a stale answer from a current one.
	const open = vi.fn(async (_claim, source: UnifiedBrowseActionSource, zoneId?: string) => {
		store.set({
			phase: 'ready',
			source,
			zoneId: zoneId ?? null,
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

function standaloneLiveLevel(
	title: string,
	rows: readonly {
		readonly token: string;
		readonly title: string;
		readonly kind: LibraryNodeKind;
		readonly subtitle?: string;
	}[]
) {
	return {
		contract: LIBRARY_OPEN_CONTRACT,
		kind: 'level' as const,
		generation: 'gen-1',
		title,
		count: rows.length,
		rows: rows.map((row) => ({
			ref: { generation: 'gen-1', token: row.token },
			title: row.title,
			kind: row.kind,
			...(row.subtitle === undefined ? {} : { subtitle: row.subtitle })
		}))
	};
}

describe('UnifiedLibraryMode — lifecycle', () => {
	it("auto-resumes without a host context: claims unified-mode and reads Roon's roots", async () => {
		const harness = mountMode();

		expect(harness.session.claim).toHaveBeenCalledWith('unified-mode');
		await waitFor(() => expect(harness.loadRoots).toHaveBeenCalledTimes(1));
		const [, loadOptions] = harness.loadRoots.mock.calls[0] as [unknown, { coreId: string }];
		expect(loadOptions.coreId).toBe('core-a');
		// The Core's own identity, not the catalog's account of it: the live view
		// has to read the library on a build where the catalog is gone.
		expect(harness.fetchCoreStatus).toHaveBeenCalledTimes(1);

		harness.unmount();
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
		// The release is synchronous; only the DOM flush waits.
		expect(harness.session.release).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.getByText('Suspended.')).toBeInTheDocument());
	});

	it('drops a Core status fetch that resolves after suspend', async () => {
		const status = deferred<CoreStatusResponse>();
		const harness = mountMode({
			withContext: true,
			fetchCoreStatus: () => status.promise
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
		await waitFor(() => expect(harness.fetchCoreStatus).toHaveBeenCalledTimes(1));

		harness.registered.lifecycle!.suspend();
		status.resolve({
			status: 'paired',
			core: { id: 'core-a', displayName: 'Core', displayVersion: '1' }
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.loadRoots).not.toHaveBeenCalled();
	});

	it('retries the initial roots load after the socket connects', async () => {
		const socket = fakeConnectionSocket();
		const harness = mountMode({
			getSocketClient: () => socket
		});

		await waitFor(() => expect(harness.loadRoots).toHaveBeenCalledTimes(1));
		socket.connected = true;
		socket.emit('connect');

		await waitFor(() => expect(harness.session.recover).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(harness.loadRoots).toHaveBeenCalledTimes(2));
		expect(harness.session.recover).toHaveBeenCalledWith(
			harness.session.claim.mock.results[0]?.value
		);

		socket.connected = false;
		socket.emit('disconnect');
		expect(harness.session.connectionLost).toHaveBeenCalledWith(
			harness.session.claim.mock.results[0]?.value
		);

		harness.unmount();
		socket.connected = true;
		socket.emit('connect');
		expect(harness.session.recover).toHaveBeenCalledTimes(1);
	});

	it('retries the active claim-scoped page load after a cold socket connects', async () => {
		const socket = fakeConnectionSocket();
		const genresStore = fakeNamedCountsStore([
			{ label: 'Jazz', albumCount: 1, itemKey: 'genre:jazz', imageKey: null }
		]);
		const harness = mountMode({ withContext: true, getSocketClient: () => socket, genresStore });

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
		await waitFor(() => expect(genresStore.load).toHaveBeenCalledTimes(1));

		// The disconnected attempt leaves no usable scope data.
		genresStore.reset();
		socket.connected = true;
		socket.emit('connect');

		await waitFor(() => expect(harness.session.recover).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(genresStore.load).toHaveBeenCalledTimes(2));
	});

	it('retries the roots load when the Core pairs after a cold start', async () => {
		// The desktop shell opens the window as soon as the engine's HTTP port
		// is up, which on a cold start can be ~25s before Roon pairing
		// completes. The mount-time status call loses that race and rejects
		// with CoreUnpairedError. Before the retry existed the catch swallowed
		// it, the store never left `idle`, and — because the socket never
		// dropped, so no reconnect fired — the body showed "Idle." forever.
		const corePairedStore = writable(false);
		const harness = mountMode({
			corePairedStore,
			fetchCoreStatus: vi.fn(async () => {
				throw new Error('Roon core not paired');
			}) as never
		});

		await waitFor(() => expect(harness.fetchCoreStatus).toHaveBeenCalledTimes(1));
		expect(harness.loadRoots).not.toHaveBeenCalled();
		expect(screen.getByText('Idle.')).toBeInTheDocument();

		// Pairing arrives on the `core-status` event the socket registrar
		// feeds into `coreStore`; the deferred load rides that signal.
		harness.fetchCoreStatus.mockImplementation(async () => ({
			status: 'paired',
			core: { id: 'core-a', displayName: 'Core', displayVersion: '1' }
		}));
		corePairedStore.set(true);

		await waitFor(() => expect(harness.loadRoots).toHaveBeenCalledTimes(1));
		const [, loadOptions] = harness.loadRoots.mock.calls[0] as [
			unknown,
			{ coreId: string }
		];
		expect(loadOptions.coreId).toBe('core-a');
	});

	it('spends the deferred retry once, so a persistent failure cannot loop', async () => {
		const corePairedStore = writable(false);
		const harness = mountMode({
			corePairedStore,
			fetchCoreStatus: vi.fn(async () => {
				throw new Error('Roon core not paired');
			}) as never
		});

		await waitFor(() => expect(harness.fetchCoreStatus).toHaveBeenCalledTimes(1));
		corePairedStore.set(true);

		// Exactly one retry: the initial attempt plus the deferred one. The
		// retry's own failure must not re-arm the deferral.
		await waitFor(() => expect(harness.fetchCoreStatus).toHaveBeenCalledTimes(2));
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.fetchCoreStatus).toHaveBeenCalledTimes(2);
		expect(harness.loadRoots).not.toHaveBeenCalled();
		expect(screen.getByText('Idle.')).toBeInTheDocument();
	});
});

describe('UnifiedLibraryMode — shell', () => {
	it("renders load, error and ready states from Roon's own roots", async () => {
		// The Artists scope is the live view (Slice 2), so its readiness, its
		// error and its count all come from the roots — never from the catalog
		// index, which this surface no longer reads.
		const library = harnessLibrary();
		const harness = mountMode({
			loadRoots: vi.fn(async () => {}),
			rootsState: { ...liveRootsState(library), phase: 'loading' }
		});
		expect(screen.getByTestId('unified-loading')).toBeInTheDocument();

		harness.rootsStore.set({
			...liveRootsState(library),
			phase: 'error',
			error: 'boom'
		});
		await waitFor(() =>
			expect(screen.getByTestId('unified-error')).toHaveTextContent('boom')
		);

		harness.rootsStore.set(liveRootsState(library));
		await waitFor(() =>
			expect(screen.getByTestId('unified-summary')).toHaveTextContent('50 TOTAL')
		);
		// Roon's roots are read whole or not at all, so a ready list never
		// qualifies its own count: no degraded notice, no truncation marker.
		expect(screen.queryByTestId('unified-degraded-notice')).toBeNull();
		expect(screen.getByTestId('unified-summary')).not.toHaveTextContent('(truncated)');
	});

	it('exposes only working scope chips and reports their totals', async () => {
		const genresStore = fakeNamedCountsStore([
			{ label: 'Jazz', albumCount: 7, itemKey: 'genre:jazz', imageKey: null },
			{ label: 'Rock', albumCount: 9, itemKey: 'genre:rock', imageKey: null }
		]);
		mountMode({
			liveLibrary: harnessLibrary({
				albums: [harnessAlbum('Arrival'), harnessAlbum('Blue')]
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
			'Surprise me'
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
		mountMode({ liveLibrary: harnessLibrary(), favoritesStore, removeFavoriteData });

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
			liveLibrary: harnessLibrary(),
			genresStore: fakeNamedCountsStore(genreEntries)
		});

		await waitFor(() => expect(screen.getByTestId('unified-rail')).toBeInTheDocument());

		// Genres has its own live-data buckets and preserves the reference rail.
		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await waitFor(() => expect(screen.getByTestId('unified-rail')).toBeInTheDocument());

		// Albums scope has no entries — the rail must hide.
		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(screen.queryByTestId('unified-rail')).toBeNull();

		// Back to artists, but with too few items. The rail addresses the list on
		// screen, and that list is Roon's own root (Slice 2).
		await fireEvent.click(screen.getByTestId('unified-scope-artists'));
		harness.rootsStore.set(liveRootsState(harnessLibrary({ artists: harnessArtists(10) })));
		await waitFor(() => expect(screen.queryByTestId('unified-rail')).toBeNull());

		// Enough items but under 3 letters — still hidden.
		const twoLetters = harnessArtists(50).map((entry, i) => ({
			...entry,
			name: `${i % 2 === 0 ? 'a' : 'b'} artist ${i}`
		}));
		harness.rootsStore.set(liveRootsState(harnessLibrary({ artists: twoLetters })));
		await waitFor(() => expect(screen.queryByTestId('unified-rail')).toBeNull());
	});

	it('wires sort to the persisted prefs store per scope and leaves density out of the bar', async () => {
		const harness = mountMode({ liveLibrary: harnessLibrary() });

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
			liveLibrary: harnessLibrary(),
			browseController: browse.controller
		});

		await fireEvent.click(screen.getByTestId('unified-scope-browse'));
		await waitFor(() => expect(browse.restore).toHaveBeenCalledTimes(1));
		expect(harness.session.claim).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('unified-browse-view')).toBeInTheDocument();
		const libraryLink = screen.getByRole('link', { name: 'Open Library' });
		expect(libraryLink).toHaveAttribute('href', '/library/browse/Library;;;0');
		libraryLink.addEventListener('click', (event) => event.preventDefault(), { once: true });
		await fireEvent.click(libraryLink, { ctrlKey: true });
		expect(browse.openItem).not.toHaveBeenCalled();
		await fireEvent.click(libraryLink);
		await waitFor(() => expect(browse.openItem).toHaveBeenCalledTimes(1));

		const latest = __getNavigationLog().at(-1);
		expect(decodeLibraryRoute(new URL(latest!.url))).toEqual({
			kind: 'browse',
			steps: [{ title: 'Library' }],
			search: null
		});
		expect(latest?.state).toEqual({});
	});

	it('restores a persisted search hierarchy through the injected semantic controller', async () => {
		const browse = fakeBrowseController();
		const harness = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary(),
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
			liveLibrary: harnessLibrary(),
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
		const latest = __getNavigationLog().at(-1);
		expect(decodeLibraryRoute(new URL(latest!.url))).toEqual({
			kind: 'browse',
			steps: [{ title: 'Albums', searchCategory: true }],
			search: 'bowie'
		});
		expect(latest?.state).toEqual({});
	});

	it('leaves Browse when a local Genre search result opens its live page', async () => {
		const browse = fakeBrowseController();
		const genresStore = fakeNamedCountsStore([
			{ label: 'Jazz', albumCount: 60, itemKey: 'genre:jazz', imageKey: null }
		]);
		const openLiveRoot = vi.fn(async () =>
			standaloneLiveLevel('Genres', [{ token: 'genre:jazz', title: 'Jazz', kind: 'genre' }])
		);
		const openLiveRef = vi.fn(async () => standaloneLiveLevel('Jazz', []));
		mountMode({
			liveLibrary: harnessLibrary(),
			browseController: browse.controller,
			genresStore,
			openLiveRoot,
			openLiveRef
		});

		await fireEvent.click(screen.getByTestId('unified-scope-browse'));
		await waitFor(() => expect(screen.getByTestId('unified-browse-view')).toBeInTheDocument());
		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'jazz' }
		});
		await fireEvent.click(await screen.findByRole('button', { name: /Genre: Jazz/ }));

		expect(await screen.findByTestId('unified-live-collection-page')).toHaveAttribute(
			'data-level-kind',
			'genre'
		);
		expect(screen.queryByTestId('unified-browse-view')).toBeNull();
		expect(screen.getByTestId('unified-scope-browse')).toHaveAttribute('aria-pressed', 'true');
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
			liveLibrary: harnessLibrary(),
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

	// Issue #12: which actions Roon offers is a question asked OF a zone. The
	// sheet used to probe availability under `sheetZones[0]` while executing
	// on the selected zone, so on a multi-zone Core every button on the sheet
	// was gated by an answer given for a zone it would never act on.
	it('probes browse action availability under the zone it will execute on', async () => {
		const zone = (zone_id: string, display_name: string) => ({
			zone_id,
			display_name,
			state: 'paused' as const,
			is_play_allowed: true,
			is_pause_allowed: true,
			is_previous_allowed: true,
			is_next_allowed: true,
			is_seek_allowed: true,
			outputs: []
		});
		// The user's pick is NOT the first zone — the two only ever agreed
		// because every existing test seeded exactly one.
		setZonesSnapshot([zone('zone-1', 'Living Room'), zone('zone-2', 'Kitchen')]);
		setSelectedZone('zone-2');
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
		mountMode({
			liveLibrary: harnessLibrary(),
			browseActionController: actions.controller,
			paletteSearchStore
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'bowie' }
		});
		await fireEvent.click(screen.getByRole('button', { name: /Low/ }));

		await waitFor(() => expect(actions.open).toHaveBeenCalled());
		expect(actions.open.mock.calls[0][2]).toBe('zone-2');

		await fireEvent.click(screen.getByTestId('unified-browse-action-queue'));
		expect(actions.execute).toHaveBeenCalledWith(expect.anything(), 'queue', 'zone-2');
	});

	// The zone picker lives in the layout, outside the sheet's backdrop, and
	// stays clickable while the sheet is open. A moved selection leaves the
	// buttons gated by an answer for the old zone unless the sheet re-asks.
	it('re-probes availability when the zone moves while the sheet is open', async () => {
		const zone = (zone_id: string, display_name: string) => ({
			zone_id,
			display_name,
			state: 'paused' as const,
			is_play_allowed: true,
			is_pause_allowed: true,
			is_previous_allowed: true,
			is_next_allowed: true,
			is_seek_allowed: true,
			outputs: []
		});
		setZonesSnapshot([zone('zone-1', 'Living Room'), zone('zone-2', 'Kitchen')]);
		setSelectedZone('zone-1');
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
		mountMode({
			liveLibrary: harnessLibrary(),
			browseActionController: actions.controller,
			paletteSearchStore
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'bowie' }
		});
		await fireEvent.click(screen.getByRole('button', { name: /Low/ }));
		await waitFor(() => expect(actions.open).toHaveBeenCalledTimes(1));
		expect(actions.open.mock.calls[0][2]).toBe('zone-1');

		setSelectedZone('zone-2');

		await waitFor(() => expect(actions.open).toHaveBeenCalledTimes(2));
		// Same target, re-asked of the zone the buttons will now act on.
		expect(actions.open.mock.calls[1][1]).toEqual(actions.open.mock.calls[0][1]);
		expect(actions.open.mock.calls[1][2]).toBe('zone-2');
		// And it settles: a re-probe that agreed with the zone must not loop.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(actions.open).toHaveBeenCalledTimes(2);
	});

	it('keeps Favorite available after See All enters a keyless Tracks hierarchy', async () => {
		const actions = fakeBrowseActionController();
		mountMode({
			liveLibrary: harnessLibrary(),
			browseActionController: actions.controller
		});

		actions.store.set({
			phase: 'ready',
			zoneId: 'zone-1',
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

	/**
	 * The locator a collection-opened album page is named by. Since Slice 4 this
	 * is the durable way to address an album page: the drill it came from, plus
	 * the row's own rendering. No catalog identity is minted for it.
	 */
	function albumLocator(title = 'Arrival', credit = 'Artist of Arrival') {
		return {
			sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
			hierarchy: 'genres' as const,
			collectionExactName: 'Bright Machinery',
			rendering: { exactTitle: title, exactCredit: credit }
		};
	}

	/**
	 * Restore an album page from committed page state, the way a reload or a
	 * Back into a recorded entry does. The page's contents come from the
	 * injected album controller, so what this fixes is which page is open —
	 * not what the server said about it.
	 */
	function resumeCollectionAlbum(
		harness: ReturnType<typeof mountMode>,
		locator = albumLocator()
	): void {
		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: buildUnifiedLibraryPageState({
				scope: 'albums',
				collectionDrill: null,
				itemTarget: { kind: 'collection', locator },
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
	}

	function collectionActionState(): LibraryAlbumState {
		return {
			phase: 'details',
			activeTab: 'details',
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
			degraded: false,
			selectedVersionId: 'version-2',
			actionsAvailable: true,
			albumActionsAvailable: true,
			orderedTracks: [{ index: 0, title: 'Exact track' }],
			live: null,
			code: null,
			error: null,
			collectionFailure: null,
			transitionedAt: 2
		};
	}

	async function mountCollectionActionPage(session = fakeSessionClient()) {
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
		setSelectedZone('zone-1');
		const album = fakeModeAlbumController();
		const actions = fakeRecoveringModeActionController();
		const harness = mountMode({
			withContext: true,
			sessionClient: session.client,
			liveLibrary: harnessLibrary(),
			albumController: album.controller,
			albumActionController: actions.controller
		});
		resumeCollectionAlbum(harness);
		await waitFor(() => expect(album.open).toHaveBeenCalledTimes(1));
		album.store.set(collectionActionState());
		await screen.findByTestId('unified-album-play');
		return { session, album, actions, harness };
	}

	it('records scope and drill transitions so browser Back stays inside Library', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getByTestId('unified-scope-artists'));
		await fireEvent.click(screen.getByText('a artist 0').closest('a,button')!);

		const enteredDrill = __getHistorySnapshot();
		expect(enteredDrill).toMatchObject({ index: 3 });
		expect(enteredDrill.entries).toHaveLength(4);
		expect(enteredDrill.entries.map((entry) => new URL(entry.url).pathname)).toEqual([
			'/library',
			'/library/albums',
			'/library/artists',
			'/library/artists/a%20artist%200'
		]);
		// What goes into history is the ADDRESS — the rendering Roon showed on
		// the way to this page — and never the reference that opened it, which
		// is worth exactly one generation (Slice 2).
		expect(enteredDrill.entries[3].state).toEqual({});

		expect(__back()).toBe(true);
		expect(__getHistorySnapshot()).toMatchObject({
			index: 2,
			entries: [
				expect.anything(),
				expect.anything(),
				{
					url: 'http://localhost/library/artists',
					state: {}
				},
				expect.anything()
			]
		});
		expect(__forward()).toBe(true);
	});

	it('changes density without creating a navigation entry', async () => {
		__resetNavigation('http://localhost/library/artists');
		const harness = mountMode({ withContext: true, liveLibrary: harnessLibrary() });
		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedRootPageState()
		} as CommittedLibraryModeActivation);
		expect(get(harness.prefsStore).density).toBe('normal');

		expect(requestUnifiedLibraryDensity('pi')).toBe(true);

		expect(get(harness.prefsStore).density).toBe('pi');
		expect(__getHistorySnapshot()).toMatchObject({ index: 0, entries: [expect.anything()] });
		expect(__getNavigationLog()).toEqual([]);
		expect(requestUnifiedLibraryDensity('pi')).toBe(true);
		expect(__getNavigationLog()).toEqual([]);
		await waitFor(() =>
			expect(screen.getByTestId('library-mode-target')).toHaveAttribute(
				'data-density',
				'pi'
			)
		);
	});

	it('renders the exact Roon album count on every artist row', () => {
		// The count is whatever Roon wrote on its own Artists row, read back off
		// the row's subtitle — not a number this surface totalled up itself.
		mountMode({
			liveLibrary: harnessLibrary({
				artists: [
					{ name: 'Counted Artist', albums: [], albumCount: 27 },
					{ name: 'Zero Artist', albums: [], albumCount: 0 }
				]
			})
		});

		const countedRow = screen.getByText('Counted Artist').closest('a,button');
		const zeroRow = screen.getByText('Zero Artist').closest('a,button');
		expect(countedRow?.querySelector('.ac')).toHaveTextContent('27');
		expect(zeroRow?.querySelector('.ac')).toHaveTextContent('0');
	});

	it('redraws Surprise me by re-selecting its chip and renders the prototype hint after the tiles', async () => {
		const albums = Array.from({ length: 40 }, (_unused, index) =>
			harnessAlbum(`Album ${index.toString().padStart(2, '0')}`)
		);
		mountMode({ liveLibrary: harnessLibrary({ albums }) });

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
		const albums = Array.from({ length: 40 }, (_unused, index) =>
			harnessAlbum(`Album ${index.toString().padStart(2, '0')}`)
		);
		mountMode({ liveLibrary: harnessLibrary({ albums }) });

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
		mountMode({ liveLibrary: harnessLibrary(), recentStore: fakeRecentStore() });

		await fireEvent.click(screen.getByTestId('unified-scope-recently-played'));
		const tile = screen.getByText('A Recent Track').closest('a,button');
		expect(tile?.querySelector('.ta')).toHaveTextContent('Reference Artist');
		expect(tile?.querySelector('.ta')).not.toHaveTextContent('Album must not appear');
	});

	/**
	 * Slice 2: the Albums list is Roon's own root, and one of its rows renders a
	 * title and a credit line — no date and no genre. So the menu offers what it
	 * can perform and nothing else, the same ruling the drill menus carry
	 * (Slice 8d): an offered sort that cannot order is a fabricated affordance,
	 * and here it is structural rather than a matter of timing, because the date
	 * features being present would not put a date on a Roon browse row. A sort
	 * persisted from the catalog listing falls back to A-Z rather than selecting
	 * an entry the menu no longer offers.
	 */
	it('offers the live Albums list no chronological or genre order, date features or not', async () => {
		const harness = mountMode({
			liveLibrary: harnessLibrary({
				albums: [harnessAlbum('Beta'), harnessAlbum('Alpha')]
			})
		});
		// Persisted as if selected while the old catalog listing was on screen.
		harness.prefsStore.setSort('albums', 'year-asc');

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(screen.getByTestId('unified-sort')).toHaveTextContent('Sort: A to Z');
		expect(renderedTileTitles()).toEqual(['Alpha', 'Beta']);

		await fireEvent.click(screen.getByTestId('unified-sort'));
		expect(screen.queryByTestId('unified-sort-option-release-year')).toBeNull();
		expect(screen.queryByTestId('unified-sort-option-year-asc')).toBeNull();
		expect(screen.queryByTestId('unified-sort-option-year-desc')).toBeNull();
		expect(screen.queryByTestId('unified-sort-option-by-genre')).toBeNull();
		// What Roon's rows can be ordered by is offered, and works.
		expect(screen.getByTestId('unified-sort-option-az')).toBeInTheDocument();
		expect(screen.getByTestId('unified-sort-option-by-artist')).toBeInTheDocument();
		await fireEvent.click(screen.getByTestId('unified-sort-option-za'));
		expect(renderedTileTitles()).toEqual(['Beta', 'Alpha']);
	});

	it('hides the A-Z rail for Shuffle over the live Albums list', async () => {
		const albums = Array.from({ length: 44 }, (_unused, index) =>
			harnessAlbum(`${'abcd'[index % 4]} Album ${index.toString().padStart(2, '0')}`)
		);
		mountMode({ liveLibrary: harnessLibrary({ albums }) });

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-shuffle'));
		expect(screen.queryByTestId('unified-rail')).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-sort'));
		await fireEvent.click(screen.getByTestId('unified-sort-option-az'));
		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();
	});

	/**
	 * Slice 8d. Slice 7 deleted the title+artist lookup that used to pin a
	 * catalog identity onto a live drill row, and these cards stopped opening
	 * as a result. They open again here — through the drill they came from,
	 * named by their own rendering and by nothing else.
	 */
	it('renders one live genre page for both a card click and URL restoration', async () => {
		const genresStore = fakeNamedCountsStore([
			{ label: 'Bright Machinery', albumCount: 2, itemKey: 'k:bm', imageKey: null }
		]);
		const openLiveRoot = vi.fn(async () => ({
			contract: LIBRARY_OPEN_CONTRACT,
			kind: 'level' as const,
			generation: 'gen-1',
			title: 'Genres',
			count: 1,
			rows: [
				{
					ref: { generation: 'gen-1', token: 'genre:bright-machinery' },
					title: 'Bright Machinery',
					kind: 'genre' as const
				}
			]
		}));
		const openLiveRef = vi.fn(async () => ({
			contract: LIBRARY_OPEN_CONTRACT,
			kind: 'level' as const,
			generation: 'gen-1',
			title: 'Bright Machinery',
			count: 1,
			rows: [
				{
					ref: { generation: 'gen-1', token: 'section:albums' },
					title: 'Albums',
					kind: 'section' as const
				}
			]
		}));
		const clicked = mountMode({
			liveLibrary: harnessLibrary(),
			genresStore,
			openLiveRoot,
			openLiveRef
		});

		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await fireEvent.click(await screen.findByText('Bright Machinery'));
		expect(await screen.findByTestId('unified-live-collection-page')).toHaveAttribute(
			'data-level-kind',
			'genre'
		);
		expect(screen.queryByTestId('unified-drill-label')).toBeNull();
		const clickedUrl = window.location.href;
		clicked.unmount();

		__resetNavigation(clickedUrl);
		const restored = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary(),
			genresStore,
			openLiveRoot,
			openLiveRef
		});
		restored.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: libraryPageStateFromRoute({ kind: 'genre', genre: 'Bright Machinery' })
		} as CommittedLibraryModeActivation);
		expect(await screen.findByTestId('unified-live-collection-page')).toHaveAttribute(
			'data-level-kind',
			'genre'
		);
		expect(screen.queryByTestId('unified-drill-label')).toBeNull();
	});




	it('never offers the Recently added chip, having no import date to order by', async () => {
		// Roon's public browse API exposes no import date, and Slice 4 deleted
		// the native layer that used to supply one. The chip is therefore gone
		// unconditionally — absent, never rendered disabled (2026-07-24 owner
		// correction).
		mountMode({
			liveLibrary: harnessLibrary({ albums: [harnessAlbum('Alpha')] })
		});

		expect(screen.queryByTestId('unified-scope-recently-added')).toBeNull();
		expect(screen.queryByText('Recently added')).toBeNull();
	});

	it('gates a restored Recently added page on the one honest reason (Slice 5)', async () => {
		// A page state written before the chip was withdrawn still restores, and
		// the surface has exactly one thing left to say about it: Roon does not
		// give it import dates. There is no second, carried reason any more.
		const harness = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary({ albums: [harnessAlbum('Alpha')] })
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

	it('reverses the rail buckets under za so letters mirror the list', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

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
		const albums = Array.from({ length: 52 }, (_unused, index) =>
			harnessAlbum(
				`${'abcd'[index % 4]} Album ${index.toString().padStart(2, '0')}`,
				`${'wxyz'[index % 4]} Artist ${index}`
			)
		);
		const genresStore = fakeNamedCountsStore(
			Array.from({ length: 42 }, (_, index) => ({
				label: `${'abc'[index % 3]} genre ${index}`,
				albumCount: index + 1,
				itemKey: `genre:${index}`,
				imageKey: null
			}))
		);
		mountMode({
			liveLibrary: harnessLibrary({ albums }),
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
			harnessAlbum('Angel Dust', 'Faith No More'),
			harnessAlbum('King’s Mouth', 'The Flaming Lips'),
			harnessAlbum('There Is Nothing Left to Lose', 'Foo Fighters'),
			harnessAlbum('Soft Sounds', 'Japanese Breakfast'),
			harnessAlbum('Solitude', 'The The'),
			harnessAlbum('Urban Hymns', 'The Verve')
		];
		mountMode({ liveLibrary: harnessLibrary({ albums }) });

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
		mountMode({ liveLibrary: harnessLibrary(), genresStore });

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



	it('labels the back button with the artist name when an album opens from the artist page (issue #6)', async () => {
		const album = fakeModeAlbumController();
		mountMode({
			liveLibrary: harnessLibrary({
				artists: [
					{
						name: 'a artist 0',
						albums: [harnessAlbum('Bound One'), harnessAlbum('Bound Two')]
					}
				]
			}),
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		const rows = screen.getAllByTestId('unified-row');
		await fireEvent.click(rows[0]);
		await screen.findByTestId('unified-artist-name');

		await fireEvent.click(screen.getAllByTestId('unified-tile')[0]);

		await waitFor(() => expect(screen.getByTestId('unified-album-page')).toBeInTheDocument());
		// The actual back target is the artist's page, not the "Artists"
		// scope: the label must name the artist (issue #6).
		expect(screen.getByTestId('unified-album-back')).toHaveTextContent('a artist 0');
	});

	// DELIBERATE SUPERSESSION (rich-item plan §4.1, 2026-08-11): the album
	// used to open as a reference modal over the Albums page; it is now a
	// first-class page that REPLACES the collection contents, with Back
	// returning to the exact invoking collection.
	it('opens a live album as a first-class page replacing the collection contents', async () => {
		const albums = Array.from({ length: 52 }, (_unused, index) => {
			const letter = String.fromCharCode(65 + (index % 26));
			return harnessAlbum(`${letter} Album ${index}`, 'a artist 0');
		});
		const album = fakeModeAlbumController();
		mountMode({
			liveLibrary: harnessLibrary({ albums }),
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(screen.getByTestId('unified-rail')).toBeInTheDocument();
		const tiles = screen.getAllByTestId('unified-tile');
		const clickedTitle = tiles[0].querySelector('.tt')?.textContent ?? '';
		expect(clickedTitle).not.toBe('');
		await fireEvent.click(tiles[0]);

		// The tile opened by the reference Roon put on that row (Slice 2), and
		// the page shows the album that row named — not whichever came back.
		await waitFor(() => expect(album.adoptLiveLevel).toHaveBeenCalledTimes(1));
		expect(album.open).not.toHaveBeenCalled();
		expect(
			(album.adoptLiveLevel.mock.calls[0][0] as { title: string }).title
		).toBe(clickedTitle);

		// The page owns the pane: no modal, no scrim; the collection stays
		// mounted but hidden so Back restores its exact transient state.
		expect(screen.getByTestId('unified-album-page')).toBeInTheDocument();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.querySelector('.collection-host')).toHaveAttribute('hidden');
		expect(screen.queryByTestId('unified-rail')).toBeNull();
		expect(screen.getByTestId('unified-scope-albums')).not.toHaveClass('on');
		// Back names the exact invoking collection.
		expect(screen.getByTestId('unified-album-back')).toHaveTextContent('Albums');

		// A Roon browse row carries no cross-surface identity, so there is no
		// artist for this page to walk up to — and since Slice 4 there is no
		// second, catalog-shaped album page that could supply one either. The
		// affordance stays visibly unavailable rather than opening onto a guess.
		expect(screen.getByTestId('unified-album-artist-link')).toBeDisabled();
	});

	function trackChildFixture() {
		const entry = harnessAlbum('Album');
		const album = fakeModeAlbumController();
		const detailsState = {
			phase: 'details',
			activeTab: 'details',
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
			albumActionsAvailable: false,
			orderedTracks: [{ index: 0, title: 'T1' }],
			code: null,
			error: null,
			transitionedAt: 2
		} as unknown as LibraryAlbumState;
		return { entry, album, detailsState };
	}

	it('persists the exact-track child as a page-chain entry (Slice 8)', async () => {
		const { entry, album, detailsState } = trackChildFixture();
		const harness = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary({ albums: [entry] }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
		});

		resumeCollectionAlbum(harness);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set(detailsState);
		await waitFor(() => screen.getByTestId('unified-track-info-0'));
		await fireEvent.click(screen.getByTestId('unified-track-info-0'));

		// The child transition pushed exactly one semantic entry carrying
		// the reconstructible index — and never editorial content.
		const navigation = __getNavigationLog();
		const latest = navigation.at(-1);
		// The page was opened from a genre drill's own locator, so its address
		// names that genre: the route says where the reader actually is.
		expect(decodeLibraryRoute(new URL(latest!.url))).toEqual({
			kind: 'genre-album-track',
			genre: 'Bright Machinery',
			album: { title: 'Arrival', credit: 'Artist of Arrival', edition: '' },
			track: 'T1'
		});
		expect(latest?.state).toEqual({});
	});

	it('closes a live-pushed track child by traversing to the parent entry (ri8-1)', async () => {
		const { entry, album, detailsState } = trackChildFixture();
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const harness = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary({ albums: [entry] }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
		});

		resumeCollectionAlbum(harness);
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
		const { entry, album, detailsState } = trackChildFixture();
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const harness = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary({ albums: [entry] }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
		});

		resumeCollectionAlbum(harness);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set(detailsState);
		await waitFor(() => screen.getByTestId('unified-track-info-0'));
		await fireEvent.click(screen.getByTestId('unified-track-info-0'));

		// Re-opening the same child deduplicates against the child's own entry;
		// ownership must survive that, so the in-page Back still traverses
		// instead of rewriting a duplicate entry.
		await fireEvent.click(screen.getByTestId('unified-track-info-0'));
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

	it('restores a persisted exact-track child on resume (Slice 8)', async () => {
		const { entry, album, detailsState } = trackChildFixture();
		const harness = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary({ albums: [entry] }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
		});

		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: buildUnifiedLibraryPageState({
				scope: 'albums',
				collectionDrill: null,
				itemTarget: { kind: 'collection', locator: albumLocator() },
				itemDetail: { kind: 'track', title: 'T1' },
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set({
			...detailsState,
			orderedTracks: [
				{ index: 0, title: 'New opening track' },
				{ index: 1, title: 'T1' }
			]
		} as LibraryAlbumState);

		// The page resolves the title after a reorder; the child surface
		// names T1 at its new position.
		await waitFor(() => screen.getByTestId('unified-album-track-info'));
		expect(screen.getByTestId('unified-album-track-info').textContent).toContain('T1');
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		await fireEvent.click(screen.getByTestId('unified-album-track-info-back'));
		expect(browserBack).not.toHaveBeenCalled();
		expect(decodeLibraryRoute(new URL(__getNavigationLog().at(-1)!.url))).toEqual({
			kind: 'genre-album',
			genre: 'Bright Machinery',
			album: { title: 'Arrival', credit: 'Artist of Arrival', edition: '' }
		});
		expect(screen.queryByTestId('unified-album-track-info')).toBeNull();
		browserBack.mockRestore();

		// A popstate activation can restore the same album component without
		// publishing a new album sheet. Its parent entry must still close the
		// local exact-track child.
		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: buildUnifiedLibraryPageState({
				scope: 'albums',
				collectionDrill: null,
				itemTarget: { kind: 'collection', locator: albumLocator() },
				itemDetail: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await waitFor(() => expect(screen.queryByTestId('unified-album-track-info')).toBeNull());
	});

	it('keeps the parent page when a restored track title is gone', async () => {
		const { entry, album, detailsState } = trackChildFixture();
		const harness = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary({ albums: [entry] }),
			albumController: album.controller,
			albumActionController: fakeModeActionController(),
		});

		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: buildUnifiedLibraryPageState({
				scope: 'albums',
				collectionDrill: null,
				itemTarget: { kind: 'collection', locator: albumLocator() },
				// The album shrank since this entry was pushed: index 7 no
				// longer resolves in the one-track order.
				itemDetail: { kind: 'track', title: 'Gone track' },
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
	});


	it('reopens a failed album page on a fresh browse session (issue #11)', async () => {
		const album = fakeModeAlbumController();
		const session = fakeSessionClient();
		const harness = mountMode({
			withContext: true,
			sessionClient: session.client,
			liveLibrary: harnessLibrary(),
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		resumeCollectionAlbum(harness);
		await waitFor(() => expect(album.open).toHaveBeenCalledTimes(1));
		expect(album.open.mock.calls[0][0]).toMatchObject({
			target: { kind: 'collection', locator: albumLocator() },
			generation: 1
		});

		// What the reporter sees after leaving the app open overnight: the
		// server retired this tab's mode lease while the socket stayed up.
		album.store.set({
			phase: 'failed',
			activeTab: 'details',
			generation: 1,
			requestId: 'request-1',
			operationId: null,
			resolvingDeadlineAt: null,
			artist: null,
			title: null,
			versions: [],
			degraded: false,
			selectedVersionId: null,
			actionsAvailable: false,
			albumActionsAvailable: false,
			orderedTracks: [],
			code: 'INVALID_REQUEST',
			error: 'The library session is no longer current',
			transitionedAt: 2
		} as unknown as LibraryAlbumState);

		await fireEvent.click(await screen.findByTestId('unified-album-retry'));

		await waitFor(() => expect(album.open).toHaveBeenCalledTimes(2));
		// The load-bearing assertion: without the invalidation the retry
		// replays generation 1 — the exact call the server just refused — and
		// only a page reload recovers.
		expect(album.open.mock.calls[1][0]).toMatchObject({
			target: { kind: 'collection', locator: albumLocator() },
			generation: 2
		});
		expect(session.invalidate).toHaveBeenCalledTimes(1);
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
		const album = fakeModeAlbumController();
		const actions = fakeModeActionController();
		const harness = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary(),
			albumController: album.controller,
			albumActionController: actions
		});

		resumeCollectionAlbum(harness);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set({
			phase: 'details',
			activeTab: 'details',
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
			degraded: false,
			selectedVersionId: 'version-2',
			actionsAvailable: true,
			albumActionsAvailable: true,
			orderedTracks: [{ index: 0, title: 'Exact track' }],
			live: null,
			code: null,
			error: null,
			collectionFailure: null,
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

	it('acquires action authority at click time instead of replaying the page-open generation', async () => {
		const session = fakeSessionClient();
		const { actions } = await mountCollectionActionPage(session);
		const activeClaim = session.claim.mock.results[0].value as ClassicBrowseSessionClaim;

		// The page opened under generation 1, then that exact Classic handle was
		// retired while the page remained visible. The action must ask the claim
		// now and use its replacement, not a generation captured by page open.
		session.client.invalidate(activeClaim, { handleId: 'h-1', generation: 1 });
		await fireEvent.click(screen.getByTestId('unified-album-play'));

		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(1));
		expect(actions.begin).toHaveBeenCalledWith(
			expect.objectContaining({ generation: 2, desiredSemantic: 'play-now' })
		);
	});

	it('invalidates and reissues once when album-action begin refuses a retired session', async () => {
		const { session, actions } = await mountCollectionActionPage();
		const activeClaim = session.claim.mock.results[0].value as ClassicBrowseSessionClaim;

		await fireEvent.click(screen.getByTestId('unified-album-play'));
		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(1));
		actions.publish({
			phase: 'failed',
			requestId: 'action-1',
			code: 'SESSION_LOST',
			error: 'The library session is no longer current',
			executionAttempted: false
		});

		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(2));
		expect(session.invalidate).toHaveBeenCalledTimes(1);
		expect(session.invalidate).toHaveBeenCalledWith(activeClaim, {
			handleId: 'h-1',
			generation: 1
		});
		expect(actions.begin).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ generation: 2, desiredSemantic: 'play-now' })
		);
	});

	it('invalidates and reissues once when action resolution loses its session', async () => {
		const { session, actions } = await mountCollectionActionPage();

		await fireEvent.click(screen.getByTestId('unified-album-play'));
		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(1));
		actions.publish({
			phase: 'choosing',
			requestId: 'action-1',
			operationId: 'operation-1',
			actions: [{ actionId: 'choice-1', label: 'Play now', semantic: 'play-now' }]
		});
		await screen.findByTestId('unified-album-action-choices');
		actions.publish({
			phase: 'failed',
			requestId: 'action-1',
			code: 'SESSION_LOST',
			error: 'The live reference retired during resolution',
			executionAttempted: false,
			actions: []
		});

		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(2));
		expect(session.invalidate).toHaveBeenCalledTimes(1);
		expect(actions.begin).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ generation: 2 })
		);
	});

	it('offers manual Retry after the second refusal and gives it a fresh one-reissue budget', async () => {
		const { session, actions } = await mountCollectionActionPage();

		await fireEvent.click(screen.getByTestId('unified-album-play'));
		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(1));
		actions.publish({
			phase: 'failed',
			requestId: 'action-1',
			code: 'SESSION_LOST',
			error: 'First refusal',
			executionAttempted: false
		});
		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(2));
		actions.publish({
			phase: 'failed',
			requestId: 'action-2',
			code: 'SESSION_LOST',
			error: 'Second refusal',
			executionAttempted: false
		});

		const retry = await screen.findByTestId('unified-album-action-retry');
		expect(retry).toHaveTextContent('Retry action');
		// The second refused handle is forgotten without eagerly acquiring a
		// third one. Acquisition remains tied to the explicit Retry gesture.
		expect(session.invalidate).toHaveBeenNthCalledWith(2, expect.anything(), {
			handleId: 'h-2',
			generation: 2
		});
		expect(actions.begin).toHaveBeenCalledTimes(2);

		await fireEvent.click(retry);
		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(3));
		expect(actions.begin).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({ generation: 3 })
		);

		// A manual retry is a new gesture: its first pre-execution refusal gets
		// exactly one automatic reissue of its own.
		actions.publish({
			phase: 'failed',
			requestId: 'action-3',
			code: 'SESSION_LOST',
			error: 'Retry refused once',
			executionAttempted: false
		});
		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(4));
		expect(actions.begin).toHaveBeenNthCalledWith(
			4,
			expect.objectContaining({ generation: 4 })
		);
		expect(session.invalidate).toHaveBeenCalledTimes(3);
	});

	it('does not begin an action after its page is superseded while claim.ready is pending', async () => {
		const session = fakeSessionClient();
		const actionReady = deferred<{ handleId: string; generation: number }>();
		let readyReads = 0;
		session.claim.mockImplementation(
			() =>
				({
					owner: 'unified-mode',
					claimId: 1,
					get ready() {
						readyReads += 1;
						return readyReads === 1
							? Promise.resolve({ handleId: 'h-1', generation: 1 })
							: actionReady.promise;
					}
				}) as ClassicBrowseSessionClaim
		);
		const { actions } = await mountCollectionActionPage(session);

		await fireEvent.click(screen.getByTestId('unified-album-play'));
		expect(actions.begin).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByTestId('unified-album-back'));
		actionReady.resolve({ handleId: 'h-2', generation: 2 });
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(actions.begin).not.toHaveBeenCalled();
	});

	it('ignores a late failure from the retired request after its replacement begins', async () => {
		const { session, actions } = await mountCollectionActionPage();

		await fireEvent.click(screen.getByTestId('unified-album-play'));
		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(1));
		actions.publish({
			phase: 'failed',
			requestId: 'action-1',
			code: 'SESSION_LOST',
			error: 'Retired',
			executionAttempted: false
		});
		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(2));

		// A stale event cannot spend the replacement request's retry budget or
		// invalidate the replacement handle.
		actions.publish({
			phase: 'failed',
			requestId: 'action-1',
			code: 'SESSION_LOST',
			error: 'Late duplicate',
			executionAttempted: false
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(actions.begin).toHaveBeenCalledTimes(2);
		expect(session.invalidate).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('unified-album-action-retry')).toBeNull();
	});

	it('never reissues or offers Retry after execution may have started', async () => {
		const { session, actions } = await mountCollectionActionPage();

		await fireEvent.click(screen.getByTestId('unified-album-play'));
		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(1));
		actions.publish({
			phase: 'failed',
			requestId: 'action-1',
			code: 'SESSION_LOST',
			error: 'Execution was rejected after claim',
			executionAttempted: true
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(actions.begin).toHaveBeenCalledTimes(1);
		expect(session.invalidate).not.toHaveBeenCalled();
		expect(screen.queryByTestId('unified-album-action-retry')).toBeNull();
	});

	it('never reissues or offers Retry for an outcome-unknown terminal state', async () => {
		const { session, actions } = await mountCollectionActionPage();

		await fireEvent.click(screen.getByTestId('unified-album-play'));
		await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(1));
		actions.publish({
			phase: 'outcome-unknown',
			requestId: 'action-1',
			// Even a malformed producer retaining the refusal code must not make
			// an uncertain outcome eligible for replay.
			code: 'SESSION_LOST',
			error: 'The server may already have executed the action',
			executionAttempted: false
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(actions.begin).toHaveBeenCalledTimes(1);
		expect(session.invalidate).not.toHaveBeenCalled();
		expect(screen.queryByTestId('unified-album-action-retry')).toBeNull();
	});

	it('plays an album on the selected zone without asking which one (issue #12)', async () => {
		const zone = (zone_id: string, display_name: string) => ({
			zone_id,
			display_name,
			state: 'paused' as const,
			is_play_allowed: true,
			is_pause_allowed: true,
			is_previous_allowed: true,
			is_next_allowed: true,
			is_seek_allowed: true,
			outputs: []
		});
		// Two zones, and the user's pick is NOT the first one: the old surface
		// only skipped its prompt at exactly one zone, and its non-prompt path
		// took zones[0].
		setZonesSnapshot([zone('zone-1', 'Living Room'), zone('zone-2', 'Kitchen')]);
		setSelectedZone('zone-2');
		const album = fakeModeAlbumController();
		const actions = fakeModeActionController();
		const harness = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary(),
			albumController: album.controller,
			albumActionController: actions
		});

		resumeCollectionAlbum(harness);
		await waitFor(() => expect(album.open).toHaveBeenCalled());
		album.store.set({
			phase: 'details',
			activeTab: 'details',
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
			degraded: false,
			selectedVersionId: 'version-2',
			actionsAvailable: true,
			albumActionsAvailable: true,
			orderedTracks: [{ index: 0, title: 'Exact track' }],
			code: null,
			error: null,
			transitionedAt: 2
		} as unknown as LibraryAlbumState);

		await fireEvent.click(await screen.findByTestId('unified-album-play'));
		expect(actions.begin).toHaveBeenNthCalledWith(1, {
			pageId: 'page-1',
			versionId: 'version-2',
			zoneId: 'zone-2',
			tabId: expect.any(String),
			generation: 1,
			desiredSemantic: 'play-now'
		});
		expect(screen.queryByTestId('unified-album-zone-picker')).toBeNull();
		setSelectedZone('');
	});

	it('abandons a superseded album open (ri1-1)', async () => {
		const album = fakeModeAlbumController();
		// The one await an album open still makes before it reads: the browse
		// session claim. It used to be catalog hydration, which is deleted; the
		// rule under test is the same one — a page closed while an await is
		// pending must not reopen its read over whatever came next.
		const session = fakeSessionClient();
		const ready = deferred<{ handleId: string; generation: number }>();
		session.claim.mockImplementation(() => ({
			owner: 'unified-mode',
			claimId: 1,
			get ready() {
				return ready.promise;
			}
		}));
		const harness = mountMode({
			withContext: true,
			sessionClient: session.client,
			liveLibrary: harnessLibrary(),
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		resumeCollectionAlbum(harness);
		await waitFor(() => expect(screen.getByTestId('unified-album-back')).toBeTruthy());
		expect(album.open).not.toHaveBeenCalled();

		// The page is closed while its claim is still pending; the stale
		// continuation must not reopen the read over whatever came next.
		await fireEvent.click(screen.getByTestId('unified-album-back'));
		ready.resolve({ handleId: 'h-1', generation: 1 });
		// Give the stale continuation a real settle window: under the fault it
		// reaches albumController.open only after the claim-ready await.
		await new Promise((resolve) => setTimeout(resolve, 25));
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(album.open).not.toHaveBeenCalled();
	});

	it('a palette-opened live page takes its own address (ri1-2)', async () => {
		// The rule this used to prove was that a palette-opened album wrote no
		// history entry, because the palette owned it as a nested search view.
		// That was true of a CATALOG album page, which had no address of its
		// own. A live page does: Slice 3 gave it a URL, so opening one from the
		// palette must push exactly one entry, or the address bar would keep
		// naming the list while an album is on screen.
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const album = fakeModeAlbumController();
		mountMode({
			liveLibrary: harnessLibrary({
				artists: [
					{
						name: 'Philip Glass',
						albums: [
							{ title: 'Glassworks', credit: 'Philip Glass', tracks: ['Opening'] }
						]
					}
				]
			}),
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'glassworks' }
		});
		const paletteRows = await screen.findAllByTestId('unified-palette-row');
		const albumRow = paletteRows.find((row) => row.textContent?.includes('Glassworks'));
		expect(albumRow).toBeDefined();
		await fireEvent.click(albumRow!);
		await waitFor(() => expect(album.adoptLiveLevel).toHaveBeenCalled());

		const pushes = __getNavigationLog().filter((entry) => entry.operation === 'pushState');
		expect(pushes).toHaveLength(1);
		expect(decodeLibraryRoute(new URL(pushes[0].url))).toMatchObject({ kind: 'album' });
		// And the palette is gone rather than waiting behind the page: Back
		// belongs to the address now, not to a nested view.
		expect(screen.queryByTestId('unified-palette')).toBeNull();
		browserBack.mockRestore();
	});


	it('restores list scroll across a recorded item Back (ri1-4)', async () => {
		// This used to park its scroll on a genre drill and open one of that
		// drill's album tiles. Slice 7 stopped a drill's live rows from
		// borrowing a stored album's identity, so those tiles no longer open
		// and that route into an item page is gone. The rule being proved is
		// the scroll parking itself, which belongs to no one scope: it is the
		// Albums list here, opening an album that carries its own identity.
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const album = fakeModeAlbumController();
		const harness = mountMode({
			withContext: true,
			liveLibrary: harnessLibrary({
				artists: [],
				albums: [{ title: 'Kind of Blue', credit: 'Miles Davis', tracks: ['So What'] }]
			}),
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});
		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: buildUnifiedLibraryPageState({
				scope: 'albums',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await screen.findByText('Kind of Blue');

		const pane = screen.getByTestId('unified-pane');
		pane.scrollTop = 640;
		await fireEvent.click(screen.getByText('Kind of Blue').closest('a,button')!);
		// The Albums list is Roon's own root (Slice 2), so the tile opens by the
		// reference it carries; the scroll-parking rule is the same either way.
		await waitFor(() => expect(album.adoptLiveLevel).toHaveBeenCalled());

		await fireEvent.click(screen.getByTestId('unified-album-back'));
		expect(browserBack).toHaveBeenCalledTimes(1);
		// The real pop navigation re-renders the pane at the top; model that
		// so a leftover in-place restore cannot mask a broken pop path (the
		// reviewer's ri1-4 vacuity catch).
		await new Promise((resolve) => setTimeout(resolve, 0));
		pane.scrollTop = 0;
		// The host answers the pop by suspending and resuming with the parent
		// list entry; the parked scroll must survive it.
		harness.registered.lifecycle!.suspend();
		harness.registered.lifecycle!.resume({
			cause: 'history-pop',
			pageState: buildUnifiedLibraryPageState({
				scope: 'albums',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null
			})
		} as CommittedLibraryModeActivation);
		await screen.findByText('Kind of Blue');
		await waitFor(() => expect(pane.scrollTop).toBe(640));
		browserBack.mockRestore();
	});

});

/**
 * The live view of Roon on screen (`.agents/plans/library-live-view.md` Slice 2).
 *
 * These cases are about the SURFACE: which row the reader clicked, what opened,
 * what the browser wrote down, and what happens when the snapshot those rows
 * belong to is retired underneath an open page. The walk itself
 * (`liveLibraryPath.ts`) and the page's own fence (`LiveLibraryPageController`)
 * have their own tests; nothing here re-proves them.
 */
describe('UnifiedLibraryMode — the live view of Roon (Slice 2)', () => {
	const LIVE_LIBRARY: HarnessLiveLibrary = {
		generation: 'gen-1',
		artists: [
			{
				name: 'Alfheim Consort',
				albums: [
					{ title: 'Winter Vespers', credit: 'Alfheim Consort', tracks: ['Kyrie', 'Gloria'] }
				]
			},
			{
				name: 'Nornir Trio',
				albums: [
					{ title: 'Skuld', credit: 'Nornir Trio', tracks: ['First Thread', 'Second Thread'] },
					// Two rows, one title, different credits: the address for one of
					// them has to carry the credit or it names both.
					{ title: 'Skuld', credit: 'Nornir Trio & Guests', tracks: ['Reprise'] }
				]
			}
		]
	};

	beforeEach(() => {
		__resetNavigation(
			'http://localhost/library',
			buildLibraryPageStateEnvelope(buildUnifiedRootPageState())
		);
		clearPendingLibraryPageStateWrite();
		setZonesSnapshot([]);
	});

	function mountLive(over: Parameters<typeof mountMode>[0] = {}) {
		return mountMode({
			liveLibrary: LIVE_LIBRARY,
			rootsState: liveRootsState(LIVE_LIBRARY),
			...over
		});
	}

	function routedLevel(
		title: string,
		rows: readonly {
			readonly token: string;
			readonly title: string;
			readonly kind: LibraryNodeKind;
			readonly subtitle?: string;
		}[]
	) {
		return {
			contract: LIBRARY_OPEN_CONTRACT,
			kind: 'level' as const,
			generation: 'gen-1',
			title,
			count: rows.length,
			rows: rows.map((row) => ({
				ref: { generation: 'gen-1', token: row.token },
				title: row.title,
				kind: row.kind,
				...(row.subtitle === undefined ? {} : { subtitle: row.subtitle })
			}))
		};
	}

	function rowNamed(name: string): HTMLElement {
		const row = screen
			.getAllByTestId('unified-row')
			.find((candidate) => candidate.querySelector('.an')?.textContent === name);
		if (!row) throw new Error(`no Artists row rendered for ${name}`);
		return row;
	}

	function latestRoute() {
		const entry = __getNavigationLog().at(-1);
		return entry === undefined ? null : decodeLibraryRoute(new URL(entry.url));
	}

	it('renders identical URL matches as a group and opens the selected live reference', async () => {
		const duplicateLibrary: HarnessLiveLibrary = {
			generation: 'gen-1',
			artists: [
				{ name: 'Same Artist', albumCount: 2, albums: [] },
				{ name: 'Same Artist', albumCount: 8, albums: [] }
			]
		};
		const base = liveRootsState(duplicateLibrary);
		const artistRows = base.artistRows.map((row, index) => ({
			...row,
			ref: { generation: 'gen-1', token: `duplicate:${index}` }
		}));
		const artists = base.artists.map((artist, index) => ({
			...artist,
			id: `duplicate-${index}`,
			liveRef: artistRows[index].ref
		}));
		const openLiveRef = vi.fn(async () => ({
			contract: LIBRARY_OPEN_CONTRACT,
			kind: 'level' as const,
			generation: 'gen-1',
			title: 'Same Artist',
			count: 0,
			rows: []
		}));
		const harness = mountMode({
			withContext: true,
			liveLibrary: duplicateLibrary,
			rootsState: { ...base, artistRows, artists },
			openLiveRef
		});

		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: libraryPageStateFromRoute({ kind: 'artist', artist: 'Same Artist' })
		} as CommittedLibraryModeActivation);

		expect(await screen.findByTestId('unified-library-group-notice')).toHaveTextContent(
			'Roon lists 2 identical entries — merge them in Roon'
		);
		const candidates = screen.getAllByTestId(/unified-library-group-candidate-/u);
		expect(candidates).toHaveLength(2);
		expect(candidates.every((candidate) => candidate.tagName === 'BUTTON')).toBe(true);
		expect(candidates.every((candidate) => !candidate.hasAttribute('href'))).toBe(true);

		await fireEvent.click(candidates[1]);
		await waitFor(() =>
			expect(openLiveRef).toHaveBeenCalledWith(
				expect.anything(),
				{ generation: 'gen-1', token: 'duplicate:1' }
			)
		);
		expect(await screen.findByTestId('unified-artist-name')).toHaveTextContent('Same Artist');
	});

	it('restores a genre URL, opens its Albums section, and links albums through the genre', async () => {
		const socket = fakeConnectionSocket();
		const openLiveRoot = vi.fn(async (_fetchFn: typeof fetch, root: 'genres' | 'composers') =>
			root === 'genres'
				? routedLevel('Genres', [{ token: 'genre:jazz', title: 'Jazz', kind: 'genre' }])
				: routedLevel('Composers', [])
		);
		const openLiveRef = vi.fn(async (_fetchFn: typeof fetch, ref: { token: string }) => {
			switch (ref.token) {
				case 'genre:jazz':
					return routedLevel('Jazz', [
						{ token: 'section:jazz:albums', title: 'Albums', kind: 'section' }
					]);
				case 'section:jazz:albums':
					return routedLevel('Albums', [
						{
							token: 'album:jazz:kind-of-blue',
							title: 'Kind of Blue',
							subtitle: 'Miles Davis',
							kind: 'album'
						}
					]);
				default:
					return routedLevel('Kind of Blue', [
						{ token: 'track:jazz:so-what', title: 'So What', kind: 'track' }
					]);
			}
		});
		const harness = mountLive({
			withContext: true,
			openLiveRoot,
			openLiveRef,
			getSocketClient: () => socket
		});

		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: libraryPageStateFromRoute({ kind: 'genre', genre: 'Jazz' })
		} as CommittedLibraryModeActivation);

		// The addressed live hierarchy owns this activation. Do not start the
		// hidden classic Genres list alongside it: that duplicate Core browse can
		// contend with the live restore and has no result this page can render.
		expect(harness.genresStore.load).not.toHaveBeenCalled();
		socket.connected = true;
		socket.emit('connect');
		await waitFor(() => expect(harness.session.recover).toHaveBeenCalledTimes(1));
		expect(harness.genresStore.load).not.toHaveBeenCalled();

		const section = await screen.findByTestId('unified-live-section-0');
		expect(section.tagName).toBe('A');
		expect(section).toHaveAttribute(
			'href',
			'/library/genres/path/genre;Jazz;;/section;Albums;;'
		);
		await fireEvent.click(section);
		expect(__getNavigationLog().at(-1)).toMatchObject({
			operation: 'pushState',
			url: 'http://localhost/library/genres/path/genre;Jazz;;/section;Albums;;'
		});
		const album = await screen.findByTestId('unified-live-album');
		expect(album).toHaveAttribute(
			'href',
			'/library/genres/Jazz/Kind%20of%20Blue;Miles%20Davis;'
		);
		await fireEvent.click(album);
		expect(await screen.findByTestId('unified-album-title')).toHaveTextContent('Kind of Blue');
	});

	it('restores composer and composition URLs against the live hierarchy', async () => {
		const openLiveRoot = vi.fn(async () =>
			routedLevel('Composers', [
				{ token: 'composer:glass', title: 'Philip Glass', kind: 'composer' }
			])
		);
		const openLiveRef = vi.fn(async (_fetchFn: typeof fetch, ref: { token: string }) =>
			ref.token === 'composer:glass'
				? routedLevel('Philip Glass', [
						{ token: 'composition:opening', title: 'Glassworks: Opening', kind: 'composition' }
					])
				: routedLevel('Glassworks: Opening', [
						{ token: 'track:opening', title: 'Opening', kind: 'track' }
					])
		);
		const harness = mountLive({ withContext: true, openLiveRoot, openLiveRef });

		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: libraryPageStateFromRoute({
				kind: 'composition',
				composer: 'Philip Glass',
				composition: 'Glassworks: Opening'
			})
		} as CommittedLibraryModeActivation);

		expect(await screen.findByTestId('unified-live-collection-title')).toHaveTextContent(
			'Glassworks: Opening'
		);
		expect(await screen.findByText('Opening')).toBeInTheDocument();
		expect(openLiveRoot).toHaveBeenCalledWith(expect.anything(), 'composers');
		expect(openLiveRef.mock.calls.map((call) => call[1].token)).toEqual([
			'composer:glass',
			'composition:opening'
		]);
	});

	it('presents every live collection row family, album grid, facts, and read-only action choice', async () => {
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
		setSelectedZone('zone-1');
		const actionState = writable<{
			phase: string;
			actions: { actionId: string; label: string; semantic: 'play-now' }[];
			error: null;
		}>({ phase: 'idle', actions: [], error: null });
		const begin = vi.fn(() => {
			actionState.set({
				phase: 'choosing',
				actions: [{ actionId: 'choice-1', label: 'Play now', semantic: 'play-now' }],
				error: null
			});
			return { started: true, requestId: 'request-1' };
		});
		const cancel = vi.fn(() => {
			actionState.set({ phase: 'canceled', actions: [], error: null });
			return true;
		});
		const actions = {
			subscribe: actionState.subscribe,
			begin,
			cancel,
			reset: vi.fn()
		} as unknown as AlbumActionController;
		const openLiveRoot = vi.fn(async () =>
			routedLevel('Composers', [
				{ token: 'composer:glass', title: 'Philip Glass', kind: 'composer' }
			])
		);
		const openLiveRef = vi.fn(async () =>
			routedLevel('Philip Glass', [
				{ token: 'action:composer', title: 'Play Composer', kind: 'action' },
				{ token: 'album:glassworks', title: 'Glassworks', subtitle: 'Philip Glass', kind: 'album' },
				{ token: 'artist:ensemble', title: 'Philip Glass Ensemble', kind: 'artist' },
				{ token: 'composition:opening', title: 'Glassworks: Opening', kind: 'composition' },
				{ token: 'recording:opening', title: 'Opening — CBS', kind: 'track' },
				{ token: 'entry:works', title: 'Works', kind: 'entry' },
				{ token: 'section:albums', title: 'Albums', kind: 'section' },
				{ token: 'fact:control', title: '\u0000', kind: 'entry' }
			])
		);
		const harness = mountLive({
			withContext: true,
			openLiveRoot,
			openLiveRef,
			albumActionController: actions
		});

		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: libraryPageStateFromRoute({ kind: 'composer', composer: 'Philip Glass' })
		} as CommittedLibraryModeActivation);

		expect(await screen.findByTestId('unified-live-album')).toHaveAttribute('href');
		expect(screen.getByTestId('unified-live-artist-0')).toHaveAttribute('href');
		expect(screen.getByTestId('unified-live-composition-1')).toHaveAttribute('href');
		expect(screen.getByTestId('unified-live-recording-2')).toHaveAttribute('href');
		expect(screen.getByTestId('unified-live-list-3')).toHaveAttribute('href');
		expect(screen.getByTestId('unified-live-section-4')).toHaveAttribute('href');
		const fact = screen.getByTestId('unified-live-fact-5');
		expect(fact.tagName).toBe('DIV');
		expect(fact).not.toHaveAttribute('role');
		expect(screen.getByTestId('unified-live-collection-sort')).toBeInTheDocument();

		const actionButton = screen.getByTestId('unified-live-actions');
		await waitFor(() => expect(actionButton).toBeEnabled());
		await fireEvent.click(actionButton);
		expect(begin).toHaveBeenCalledWith(
			expect.objectContaining({
				ref: { generation: 'gen-1', token: 'composer:glass' },
				zoneId: 'zone-1'
			})
		);
		const choices = await screen.findByTestId('unified-live-action-choices');
		await fireEvent.click(within(choices).getByRole('button', { name: 'Cancel' }));
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it('keeps the classic genre album count, sort preference, shuffle, and letter rail on the live page', async () => {
		const albumRows = Array.from({ length: 40 }, (_unused, index) => ({
			token: `album:${index}`,
			title: `${String.fromCharCode(65 + (index % 4))} Album ${index}`,
			subtitle: 'Philip Glass',
			kind: 'album' as const
		}));
		const openLiveRoot = vi.fn(async () =>
			routedLevel('Composers', [
				{ token: 'composer:glass', title: 'Philip Glass', kind: 'composer' }
			])
		);
		const openLiveRef = vi.fn(async () => routedLevel('Philip Glass', albumRows));
		const harness = mountLive({ withContext: true, openLiveRoot, openLiveRef });

		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: libraryPageStateFromRoute({ kind: 'composer', composer: 'Philip Glass' })
		} as CommittedLibraryModeActivation);

		expect(await screen.findByTestId('unified-live-collection-summary')).toHaveTextContent(
			'40 ALBUMS'
		);
		const enabledLetters = [...screen.getByTestId('unified-rail').querySelectorAll('button')]
			.filter((button) => !button.hasAttribute('disabled'))
			.map((button) => button.textContent?.trim());
		expect(enabledLetters).toEqual(['A', 'B', 'C', 'D']);

		await fireEvent.click(screen.getByTestId('unified-live-collection-sort'));
		await fireEvent.click(
			screen.getByTestId('unified-live-collection-sort-option-shuffle')
		);
		expect(get(harness.prefsStore).sorts.genre).toBe('shuffle');
		expect(get(harness.prefsStore).sorts.albums).toBe('az');
		expect(screen.queryByTestId('unified-rail')).toBeNull();
	});

	it('replaces a restored section entry with its semantic parent on Back', async () => {
		__resetNavigation(
			'http://localhost/library/genres/path/genre;Jazz;;/section;Albums;;'
		);
		clearPendingLibraryPageStateWrite();
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const openLiveRoot = vi.fn(async () =>
			routedLevel('Genres', [{ token: 'genre:jazz', title: 'Jazz', kind: 'genre' }])
		);
		const openLiveRef = vi.fn(async (_fetchFn: typeof fetch, ref: { token: string }) =>
			ref.token === 'genre:jazz'
				? routedLevel('Jazz', [
						{ token: 'section:jazz:albums', title: 'Albums', kind: 'section' }
					])
				: routedLevel('Albums', [
						{
							token: 'album:jazz:kind-of-blue',
							title: 'Kind of Blue',
							subtitle: 'Miles Davis',
							kind: 'album'
						}
					])
		);
		const harness = mountLive({ withContext: true, openLiveRoot, openLiveRef });
		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: libraryPageStateFromRoute({
				kind: 'live-path',
				path: {
					origin: 'genres',
					steps: [
						{ kind: 'genre', title: 'Jazz' },
						{ kind: 'section', title: 'Albums' }
					]
				}
			})
		} as CommittedLibraryModeActivation);

		expect(await screen.findByTestId('unified-live-collection-title')).toHaveTextContent(
			'Albums'
		);
		await fireEvent.click(
			within(screen.getByTestId('unified-live-collection-page')).getByRole('button', {
				name: /Genres/u
			})
		);

		expect(browserBack).not.toHaveBeenCalled();
		expect(__getNavigationLog().at(-1)).toMatchObject({
			operation: 'replaceState',
			url: 'http://localhost/library/genres/Jazz'
		});
		expect(__getHistorySnapshot().entries).toHaveLength(1);
		expect(await screen.findByTestId('unified-live-collection-title')).toHaveTextContent('Jazz');
		browserBack.mockRestore();
	});

	it('restores an exact track URL onto the live album child', async () => {
		const album = fakeModeAlbumController();
		const harness = mountLive({
			withContext: true,
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		harness.registered.lifecycle!.resume({
			cause: 'initial',
			pageState: libraryPageStateFromRoute({
				kind: 'album-track',
				album: { title: 'Winter Vespers', credit: 'Alfheim Consort', edition: '' },
				track: 'Gloria'
			})
		} as CommittedLibraryModeActivation);

		await waitFor(() => expect(album.adoptLiveLevel).toHaveBeenCalledTimes(1));
		expect(get(album.store).orderedTracks.map((track) => track.title)).toEqual(['Kyrie', 'Gloria']);
		expect(get(album.store).live).not.toBeNull();
		expect(await screen.findByTestId('unified-album-track-info')).toHaveTextContent('Gloria');
	});

	it('gives live track info a durable address and leaves modified clicks native', async () => {
		const album = fakeModeAlbumController();
		mountLive({
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		await waitFor(() => expect(screen.getAllByTestId('unified-row')).toHaveLength(2));
		await fireEvent.click(rowNamed('Alfheim Consort'));
		await fireEvent.click(await screen.findByTestId('unified-tile'));
		await waitFor(() => expect(album.adoptLiveLevel).toHaveBeenCalledTimes(1));

		const trackLink = await screen.findByTestId('unified-track-info-1');
		expect(trackLink.tagName).toBe('A');
		expect(decodeLibraryRoute(new URL(trackLink.getAttribute('href')!, window.location.href))).toEqual({
			kind: 'artist-album-track',
			artist: 'Alfheim Consort',
			album: {
				title: 'Winter Vespers',
				credit: 'Alfheim Consort',
				edition: ''
			},
			track: 'Gloria'
		});

		trackLink.addEventListener('click', (event) => event.preventDefault(), { once: true });
		await fireEvent.click(trackLink, { ctrlKey: true });
		expect(screen.queryByTestId('unified-album-track-info')).toBeNull();

		await fireEvent.click(trackLink);
		expect(await screen.findByTestId('unified-album-track-info')).toHaveTextContent('Gloria');
	});

	it('opens the artist the reader clicked, by that row\'s own reference', async () => {
		const harness = mountLive();

		await waitFor(() => expect(screen.getAllByTestId('unified-row')).toHaveLength(2));
		const row = rowNamed('Nornir Trio');
		expect(row.tagName).toBe('A');
		expect(row).toHaveAttribute('href', '/library/artists/Nornir%20Trio');
		row.addEventListener('click', (event) => event.preventDefault(), { once: true });
		await fireEvent.click(row, { ctrlKey: true });
		expect(harness.openLiveRef).not.toHaveBeenCalled();
		await fireEvent.click(row);

		// The reference the row carried is what opened it — not a name looked up
		// somewhere else, and not the first row that matched.
		await waitFor(() =>
			expect(screen.getByTestId('unified-artist-name')).toHaveTextContent('Nornir Trio')
		);
		expect(harness.openLiveRef).toHaveBeenCalledTimes(1);
		expect(harness.openLiveRef.mock.calls[0][1]).toEqual({
			generation: 'gen-1',
			token: 'artist:Nornir Trio'
		});
		// Roon's own level is the discography: its two album rows, no verb row.
		const tiles = screen.getAllByTestId('unified-tile');
		expect(tiles.map((tile) => tile.querySelector('.tt')?.textContent)).toEqual([
			'Skuld',
			'Skuld'
		]);
		expect(tiles.map((tile) => tile.querySelector('.ta')?.textContent)).toEqual([
			'Nornir Trio',
			'Nornir Trio & Guests'
		]);
	});

	it('addresses an album on an artist page through that artist, credit and all', async () => {
		const album = fakeModeAlbumController();
		mountLive({ albumController: album.controller, albumActionController: fakeModeActionController() });

		await waitFor(() => expect(screen.getAllByTestId('unified-row')).toHaveLength(2));
		await fireEvent.click(rowNamed('Nornir Trio'));
		await waitFor(() => expect(screen.getAllByTestId('unified-tile')).toHaveLength(2));
		expect(screen.getAllByTestId('unified-tile')[1]).toHaveAttribute(
			'href',
			'/library/artists/Nornir%20Trio/Skuld;Nornir%20Trio%20%26%20Guests;'
		);

		// The SECOND of two rows that read alike apart from their credit.
		await fireEvent.click(screen.getAllByTestId('unified-tile')[1]);
		await waitFor(() => expect(album.adoptLiveLevel).toHaveBeenCalledTimes(1));
		expect(
			(album.adoptLiveLevel.mock.calls[0][0] as { rows: readonly { title: string }[] }).rows.map(
				(row) => row.title
			)
		).toEqual(['Play Album', 'Reprise']);

		// Written down: the path THROUGH the artist, with the credit that tells
		// the two rows apart. Never the reference, which dies with its snapshot,
		// and never the Albums root, which is a different list.
		expect(latestRoute()).toEqual({
			kind: 'artist-album',
			artist: 'Nornir Trio',
			album: { title: 'Skuld', credit: 'Nornir Trio & Guests', edition: '' }
		});
	});

	it('re-resolves the open page onto the same row when the snapshot moves', async () => {
		const harness = mountLive();

		await waitFor(() => expect(screen.getAllByTestId('unified-row')).toHaveLength(2));
		await fireEvent.click(rowNamed('Nornir Trio'));
		await waitFor(() =>
			expect(screen.getByTestId('unified-artist-name')).toHaveTextContent('Nornir Trio')
		);

		// A refresh, a reconnect or a server-side session loss: every reference
		// the browser holds is retired at once.
		const moved: HarnessLiveLibrary = { ...LIVE_LIBRARY, generation: 'gen-2' };
		harness.openLiveRef.mockImplementation(async (_fetchFn, ref) =>
			liveOpenResponder(moved)(ref)
		);
		harness.rootsStore.set(liveRootsState(moved));

		// The page re-asks Roon for the row its ADDRESS names, under the
		// generation that replaced the one it opened in.
		await waitFor(() =>
			expect(harness.openLiveRef.mock.calls.at(-1)?.[1]).toEqual({
				generation: 'gen-2',
				token: 'artist:Nornir Trio'
			})
		);
		await waitFor(() =>
			expect(screen.getByTestId('unified-artist-name')).toHaveTextContent('Nornir Trio')
		);
		expect(screen.queryByTestId('unified-drill-missing')).toBeNull();
		expect(screen.getAllByTestId('unified-tile')).toHaveLength(2);
	});

	function rootsResponse(library: HarnessLiveLibrary): Response {
		const state = liveRootsState(library);
		return new Response(JSON.stringify({
			contract: LIBRARY_ROOTS_CONTRACT, kind: 'snapshot',
			generation: state.generation, coreId: state.coreId, readAt: state.readAt,
			artists: { count: state.artistCount, rows: state.artistRows },
			albums: { count: state.albumCount, rows: state.albumRows }
		}), { headers: { 'content-type': 'application/json' } });
	}

	it.each(['refresh', 'count-mismatch', 'session-lost'] as const)(
		'recovers the same addressed page through the real roots store after external %s',
		async (reason) => {
			resetLibraryRoots();
			const moved = { ...LIVE_LIBRARY, generation: 'gen-2' };
			const fetchFn = vi.fn<typeof fetch>()
				.mockResolvedValueOnce(rootsResponse(LIVE_LIBRARY))
				.mockResolvedValueOnce(rootsResponse(moved));
			const harness = mountLive({
				rootsSource: libraryRootsStore,
				loadRoots: vi.fn((_fetch, options) => loadLibraryRoots(fetchFn, options))
			});
			await waitFor(() => expect(screen.getAllByTestId('unified-row')).toHaveLength(2));
			await fireEvent.click(rowNamed('Nornir Trio'));
			await screen.findByTestId('unified-artist-name');
			const address = __getNavigationLog().at(-1);
			harness.openLiveRef.mockImplementation(async (_fetch, ref) => liveOpenResponder(moved)(ref));
			expect(retireLibraryGeneration({
				contract: LIBRARY_SESSION_RETIRED_CONTRACT, coreId: 'core-a',
				retired: 'gen-1', reason
			})).toBe(true);
			await waitFor(() => expect(harness.openLiveRef.mock.calls.at(-1)?.[1]).toEqual({
				generation: 'gen-2', token: 'artist:Nornir Trio'
			}));
			expect(screen.getByTestId('unified-artist-name')).toHaveTextContent('Nornir Trio');
			expect(__getNavigationLog().at(-1)).toEqual(address);
			expect(fetchFn).toHaveBeenCalledTimes(2);
			expect(fetchFn.mock.calls[1][0]).toBe('/api/library/roots');
		}
	);

	it.each(['suspend', 'supersede'] as const)(
		'does not start recovery after an owned refresh wait crosses %s',
		async (change) => {
			resetLibraryRoots();
			const pending = deferred<Response>();
			const fetchFn = vi.fn<typeof fetch>()
				.mockResolvedValueOnce(rootsResponse(LIVE_LIBRARY))
				.mockImplementationOnce(() => pending.promise);
			const harness = mountLive({
				withContext: true, rootsSource: libraryRootsStore,
				loadRoots: vi.fn((_fetch, options) => loadLibraryRoots(fetchFn, options))
			});
			harness.registered.lifecycle!.resume({
				cause: 'initial', pageState: buildUnifiedRootPageState()
			} as CommittedLibraryModeActivation);
			await waitFor(() => expect(screen.getAllByTestId('unified-row')).toHaveLength(2));
			const owned = refreshLibraryRootsNow(fetchFn, { coreId: 'core-a' });
			retireLibraryGeneration({
				contract: LIBRARY_SESSION_RETIRED_CONTRACT, coreId: 'core-a',
				retired: 'gen-1', reason: 'refresh'
			});
			await waitFor(() => expect(harness.loadRoots).toHaveBeenCalledTimes(2));
			const options = harness.loadRoots.mock.calls[1][1];
			expect(options.retirement.isCurrent()).toBe(true);
			if (change === 'suspend') harness.registered.lifecycle!.suspend();
			else harness.session.client.isClaimCurrent = () => false;
			expect(options.retirement.isCurrent()).toBe(false);
			pending.resolve(rootsResponse(LIVE_LIBRARY));
			await owned;
			await harness.loadRoots.mock.results[1].value;
			expect(fetchFn).toHaveBeenCalledTimes(2);
		}
	);

	it.each(['connect', 'reconnect', 'core-lost', 'shutdown', 'read-failed'] as const)(
		'leaves %s on its lifecycle or error path',
		async (reason) => {
			const harness = mountLive();
			await waitFor(() => expect(harness.loadRoots).toHaveBeenCalledTimes(1));
			harness.rootsStore.update((state) => ({
				...state, retirementRevision: state.retirementRevision + 1,
				retirementReason: reason
			}));
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(harness.loadRoots).toHaveBeenCalledTimes(1);
		}
	);

	it('says a row is gone rather than showing a page, and stays said', async () => {
		const harness = mountLive();

		await waitFor(() => expect(screen.getAllByTestId('unified-row')).toHaveLength(2));
		await fireEvent.click(rowNamed('Nornir Trio'));
		await waitFor(() =>
			expect(screen.getByTestId('unified-artist-name')).toHaveTextContent('Nornir Trio')
		);

		// The artist is gone from the library in the snapshot that replaces this
		// one — the case the whole re-resolution exists for.
		const without: HarnessLiveLibrary = {
			generation: 'gen-2',
			artists: LIVE_LIBRARY.artists.filter((artist) => artist.name !== 'Nornir Trio')
		};
		harness.openLiveRef.mockImplementation(async (_fetchFn, ref) =>
			liveOpenResponder(without)(ref)
		);
		harness.rootsStore.set(liveRootsState(without));

		await waitFor(() =>
			expect(screen.getByTestId('unified-drill-missing')).toHaveTextContent(
				'Roon no longer lists “Nornir Trio”.'
			)
		);
		// And it stops there: a snapshot that cannot answer is not asked again,
		// which is the difference between recovering and hammering the Core.
		const asked = harness.openLiveRef.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.openLiveRef.mock.calls.length).toBe(asked);
		expect(screen.queryByTestId('unified-artist-name')?.textContent ?? '').not.toBe(
			'Alfheim Consort'
		);
	});

	it('asks the server for one fresh snapshot when a page is refused as stale', async () => {
		const harness = mountLive();

		await waitFor(() => expect(screen.getAllByTestId('unified-row')).toHaveLength(2));
		await fireEvent.click(rowNamed('Nornir Trio'));
		await waitFor(() =>
			expect(screen.getByTestId('unified-artist-name')).toHaveTextContent('Nornir Trio')
		);

		// The server retired the publication without the browser hearing: every
		// held reference is refused, and the rows in memory are refused too.
		harness.loadRoots.mockImplementation(async () => {
			// A re-read that finds the server still on this generation touches
			// the store all the same — it went through its loading phase. So
			// "ask once per snapshot" has to mean the snapshot, not the store
			// object, or the answer feeds itself.
			harness.rootsStore.update((state) => ({ ...state }));
		});
		harness.openLiveRef.mockResolvedValue({ contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' });
		const loadsBefore = harness.loadRoots.mock.calls.length;
		await fireEvent.click(rowNamed('Alfheim Consort'));

		// Recovery is a fresh snapshot, asked for exactly once: re-walking the
		// address against rows that are themselves retired can only be refused
		// again, so a second ask under the same snapshot would be a loop.
		await waitFor(() =>
			expect(harness.loadRoots.mock.calls.length).toBe(loadsBefore + 1)
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.loadRoots.mock.calls.length).toBe(loadsBefore + 1);
		expect(screen.getByTestId('unified-drill-missing')).toHaveTextContent(
			'The library has been re-read since this page opened.'
		);
	});

	it("rails the live list by Roon's own rows, never the catalog's", async () => {
		// The catalog index here describes 50 artists across 26 letters; Roon's
		// root has 44 across four. The rail addresses positions in the list on
		// screen, so a rail built from the other source would scroll to the
		// wrong row — or to none.
		const library: HarnessLiveLibrary = {
			generation: 'gen-1',
			artists: Array.from({ length: 44 }, (_, index) => ({
				name: `${['Alfa', 'Bravo', 'Charlie', 'Delta'][index % 4]} performer ${index
					.toString()
					.padStart(2, '0')}`,
				albums: []
			})),
			albums: []
		};
		mountMode({
			liveLibrary: library,
			rootsState: liveRootsState(library)
		});

		await waitFor(() => expect(screen.getAllByTestId('unified-row')).toHaveLength(44));
		expect(screen.getByTestId('unified-summary')).toHaveTextContent('44 TOTAL');
		const letters = [...screen.getByTestId('unified-rail').querySelectorAll('button')]
			.filter((button) => !button.hasAttribute('disabled'))
			.map((button) => button.textContent?.trim());
		expect(letters).toEqual(['A', 'B', 'C', 'D']);
	});

	it('re-reads the root when the reader opens a live scope', async () => {
		const harness = mountLive();
		await waitFor(() => expect(harness.loadRoots).toHaveBeenCalledTimes(1));

		// The plan's scope-activation trigger: coming back to a list re-asks the
		// server, which is the cheap confirm when nothing moved and the only way
		// a record added since the reader last looked appears.
		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await waitFor(() => expect(harness.loadRoots).toHaveBeenCalledTimes(2));
		await fireEvent.click(screen.getByTestId('unified-scope-artists'));
		await waitFor(() => expect(harness.loadRoots).toHaveBeenCalledTimes(3));
		// And a scope that does not read Roon's roots does not re-read them.
		await fireEvent.click(screen.getByTestId('unified-scope-genres'));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(harness.loadRoots).toHaveBeenCalledTimes(3);
	});

	it('acts on the reference the reader clicked, with no selector beside it', async () => {
		const album = fakeModeAlbumController();
		const actions = fakeModeActionController();
		setZonesSnapshot([
			{
				zone_id: 'zone-2',
				display_name: 'Kitchen',
				state: 'paused' as const,
				is_play_allowed: true,
				is_pause_allowed: true,
				is_previous_allowed: true,
				is_next_allowed: true,
				is_seek_allowed: true,
				outputs: []
			}
		]);
		setSelectedZone('zone-2');
		mountLive({ albumController: album.controller, albumActionController: actions });

		await waitFor(() => expect(screen.getAllByTestId('unified-row')).toHaveLength(2));
		await fireEvent.click(rowNamed('Alfheim Consort'));
		await waitFor(() => expect(screen.getAllByTestId('unified-tile')).toHaveLength(1));
		await fireEvent.click(screen.getAllByTestId('unified-tile')[0]);
		await waitFor(() => expect(album.adoptLiveLevel).toHaveBeenCalled());

		// The level as the page holds it: one whole-album verb row and its two
		// track rows, each carrying its own reference. The single-verb-row rule
		// itself is `LibraryAlbumController`'s, and is proved in its own tests.
		const albumRef = { generation: 'gen-1', token: 'album:Alfheim Consort:Winter Vespers:Alfheim Consort' };
		album.store.update((state) => ({
			...state,
			phase: 'details',
			title: 'Winter Vespers',
			artist: 'Alfheim Consort',
			actionsAvailable: true,
			albumActionsAvailable: true,
			orderedTracks: [
				{ index: 0, title: 'Kyrie' },
				{ index: 1, title: 'Gloria' }
			],
			live: {
				albumRef,
				playRef: { generation: 'gen-1', token: `play:${albumRef.token}:0` },
				trackRefs: [
					{ generation: 'gen-1', token: `track:${albumRef.token}:0` },
					{ generation: 'gen-1', token: `track:${albumRef.token}:1` }
				]
			}
		}) as unknown as LibraryAlbumState);

		await fireEvent.click(await screen.findByTestId('unified-album-play'));
		expect(actions.begin).toHaveBeenNthCalledWith(1, {
			ref: { generation: 'gen-1', token: `play:${albumRef.token}:0` },
			zoneId: 'zone-2',
			tabId: expect.any(String),
			generation: 1,
			desiredSemantic: 'play-now'
		});

		await fireEvent.click(screen.getByTestId('unified-track-action-1'));
		// The SECOND track's own reference, and no track selector beside it: the
		// reference names the row, so a selector could only disagree with it.
		expect(actions.begin).toHaveBeenNthCalledWith(2, {
			ref: { generation: 'gen-1', token: `track:${albumRef.token}:1` },
			zoneId: 'zone-2',
			tabId: expect.any(String),
			generation: 1,
			desiredSemantic: 'play-now'
		});
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
		mountMode({ liveLibrary: harnessLibrary() });

		await fireEvent.keyDown(window, { key: 'b' });

		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect((screen.getByTestId('unified-palette-input') as HTMLInputElement).value).toBe('b');
	});

	it('never captures while a form control has focus', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

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

	it('still captures typing after the volume slider has been used (issue #16)', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		// The volume control is an `<input type="range">` and keeps focus
		// after a drag, the way native sliders do. No printable key types
		// into it, so the capture guard must not treat it as a text field.
		const slider = document.createElement('input');
		slider.type = 'range';
		document.body.appendChild(slider);
		slider.focus();
		await fireEvent.keyDown(slider, { key: 'b' });

		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect((screen.getByTestId('unified-palette-input') as HTMLInputElement).value).toBe('b');
		slider.remove();
	});

	it('Cmd/Ctrl-K toggles the palette as an explicit chord', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		await fireEvent.keyDown(window, { key: 'k', metaKey: true });
		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();

		await fireEvent.keyDown(window, { key: 'k', metaKey: true });
		expect(screen.queryByTestId('unified-palette')).toBeNull();
	});

	it('opens from the top-bar Find affordance', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		await fireEvent.click(screen.getByTestId('unified-find'));

		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
	});

	it('claims a semantic Library search intent and opens the Unified palette seeded', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

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

	// Issue #10: play-bar and NowPlayingOverlay artist/album clicks route
	// through this same intent claim. An entity intent whose name uniquely
	// matches the loaded library index should open that item's page
	// directly instead of falling back to a palette search.
	it('claims an artist intent uniquely matching the index and opens the artist page', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		publishLibraryIntent({
			kind: 'artist',
			destination: 'search',
			// Deliberately different case than the index entry ('a artist 0')
			// to prove the match goes through librarySortKey normalization
			// rather than exact string equality.
			query: 'A Artist 0',
			display: { title: 'A Artist 0' }
		});

		await waitFor(() =>
			expect(screen.getByTestId('unified-artist-name')).toHaveTextContent('a artist 0')
		);
		expect(screen.queryByTestId('unified-palette')).toBeNull();
		expect(get(pendingLibraryIntentStore)).toBeNull();
	});

	it('falls back to the palette when an artist intent name has no index match', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		publishLibraryIntent({
			kind: 'artist',
			destination: 'search',
			query: 'Totally Unknown Artist',
			display: { title: 'Totally Unknown Artist' }
		});

		await waitFor(() =>
			expect(screen.getByTestId('unified-palette-input')).toHaveValue('Totally Unknown Artist')
		);
		expect(screen.queryByTestId('unified-artist-name')).toBeNull();
		expect(get(pendingLibraryIntentStore)).toBeNull();
	});


	it('opens a live composer page and Back restores the same palette query and row', async () => {
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const composersStore = fakeNamedCountsStore([
			{
				label: 'Philip Glass',
				albumCount: 12,
				itemKey: 'composer-philip-glass',
				imageKey: null
			}
		]);
		const openLiveRoot = vi.fn(async () =>
			standaloneLiveLevel('Composers', [
				{ token: 'composer:glass', title: 'Philip Glass', kind: 'composer' }
			])
		);
		const openLiveRef = vi.fn(async () => standaloneLiveLevel('Philip Glass', []));
		mountMode({
			liveLibrary: harnessLibrary(),
			composersStore,
			openLiveRoot,
			openLiveRef
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await waitFor(() => expect(composersStore.load).toHaveBeenCalledTimes(1));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'philip glass' }
		});
		const composerRow = await screen.findByText('Composer: Philip Glass');
		await fireEvent.mouseMove(composerRow.closest('a,button')!);
		await fireEvent.click(composerRow.closest('a,button')!);

		expect(await screen.findByTestId('unified-live-collection-page')).toHaveAttribute(
			'data-level-kind',
			'composer'
		);
		expect(openLiveRoot).toHaveBeenCalledWith(expect.anything(), 'composers');
		expect(screen.queryByTestId('unified-palette')).toBeNull();

		await fireEvent.click(
			within(screen.getByTestId('unified-live-collection-page')).getByRole('button', {
				name: /^←/u
			})
		);
		expect(browserBack).not.toHaveBeenCalled();
		expect(
			__getNavigationLog().filter((entry) => entry.operation === 'pushState')
		).toHaveLength(0);
		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect(screen.getByTestId('unified-palette-input')).toHaveValue('philip glass');
		expect(screen.getByText('Composer: Philip Glass')).toBeInTheDocument();
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
			liveLibrary: harnessLibrary(),
			paletteSearchStore
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'dear theodosia' }
		});
		const songRow = screen.getByText('Dear Theodosia').closest('a,button')!;
		await fireEvent.click(songRow);

		expect(screen.queryByTestId('unified-palette')).toBeNull();
		expect(screen.getByTestId('unified-track-page')).toBeInTheDocument();

		await fireEvent.click(screen.getByTestId('unified-song-back'));

		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect(screen.getByTestId('unified-palette-input')).toHaveValue('dear theodosia');
		expect(screen.getByText('Dear Theodosia').closest('a,button')).toHaveClass('sel');
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
			liveLibrary: harnessLibrary(),
			paletteSearchStore,
			songRelationshipClient: { relationship },
			songActionController: new UnifiedSongActionController({ action })
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'dear theodosia' }
		});
		await fireEvent.click(screen.getByText('Dear Theodosia').closest('a,button')!);

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
			liveLibrary: harnessLibrary(),
			paletteSearchStore,
			songRelationshipClient: { relationship },
			songActionController: new UnifiedSongActionController({ action })
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'dear theodosia' }
		});
		await fireEvent.click(screen.getByText('Dear Theodosia').closest('a,button')!);

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
			liveLibrary: harnessLibrary(),
			paletteSearchStore,
			songRelationshipClient: { relationship }
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'dear theodosia' }
		});
		await fireEvent.click(screen.getByText('Dear Theodosia').closest('a,button')!);

		// The track page owns the surface: the library body is mounted but
		// hidden, and Back to the results restores it.
		expect(screen.getByTestId('unified-track-page')).toBeInTheDocument();
		expect(screen.getByTestId('unified-pane').closest('.body')).toHaveAttribute('hidden');
		await fireEvent.click(screen.getByTestId('unified-song-back'));
		expect(screen.getByTestId('unified-pane').closest('.body')).not.toHaveAttribute('hidden');
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
			liveLibrary: harnessLibrary(),
			paletteSearchStore,
			clearPaletteSearchData: vi.fn(async () => {}),
			songRelationshipClient: { relationship }
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'songs' }
		});
		await fireEvent.click(screen.getByText('First Song').closest('a,button')!);
		await fireEvent.click(screen.getByRole('button', { name: 'Close search' }));

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'songs' }
		});
		await fireEvent.click(screen.getByText('Second Song').closest('a,button')!);
		// The panel's own heading is what says which song it is now; the album
		// link is no longer offered here, because there is no catalog album
		// page for it to open.
		await waitFor(() =>
			expect(screen.getByTestId('unified-song-title')).toHaveTextContent('Second Song')
		);

		firstRelationship.resolve({
			songTitle: 'First Song',
			albums: [],
			composerLabels: []
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(screen.getByTestId('unified-song-title')).toHaveTextContent('Second Song');
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
			liveLibrary: harnessLibrary(),
			paletteSearchStore,
			songActionController
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'dear theodosia' }
		});
		await fireEvent.click(screen.getByText('Dear Theodosia').closest('a,button')!);
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
			liveLibrary: harnessLibrary(),
			paletteSearchStore,
			clearPaletteSearchData: vi.fn(async () => {}),
			songActionController
		});

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'songs' }
		});
		await fireEvent.click(screen.getByText('First Song').closest('a,button')!);
		await fireEvent.click(screen.getByTestId('unified-song-play-now'));
		await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
		await fireEvent.click(screen.getByRole('button', { name: 'Close search' }));

		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), {
			target: { value: 'songs' }
		});
		await fireEvent.click(screen.getByText('Second Song').closest('a,button')!);
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
			liveLibrary: harnessLibrary(),
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
			liveLibrary: harnessLibrary(),
			albumController: album.controller,
			albumActionController: fakeModeActionController()
		});

		harness.registered.lifecycle!.resume({
			pageState: buildUnifiedLibraryPageState({
				scope: 'artists',
				collectionDrill: null,
				itemTarget: {
					kind: 'collection',
					locator: {
						sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
						hierarchy: 'genres' as const,
						collectionExactName: 'Bright Machinery',
						rendering: { exactTitle: 'Arrival', exactCredit: 'Artist of Arrival' }
					}
				},
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
		const harness = mountMode({ withContext: true, liveLibrary: harnessLibrary() });
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

	/**
	 * The counted library, as Roon's own Artists root renders it: five rows,
	 * each carrying the count Roon printed in its own subtitle.
	 */
	function countedLibrary(): HarnessLiveLibrary {
		return harnessLibrary({
			artists: [
				{ name: 'Big Cat', albumCount: 40, albums: [] },
				{ name: 'Mid Cat', albumCount: 35, albums: [] },
				{ name: 'Two Cat', albumCount: 2, albums: [] },
				{ name: '\u201CWeird One\u201D', albumCount: 1, albums: [] },
				{ name: '10cc One', albumCount: 1, albums: [] }
			]
		});
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
		mountMode({ liveLibrary: countedLibrary() });

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
		expect(rows[0].tagName).toBe('A');
		expect(rows[0]).toHaveAttribute('href', '/library/artists/Big%20Cat');
		expect(rows[0]).toHaveClass('arow');
		expect(rows[0].querySelector('.an')).toHaveTextContent('Big Cat');
		expect(rows[0].querySelector('.ac')).toHaveTextContent('40');
		expect(rows[0].textContent).not.toContain('albums');
		expect(rows.map((el) => el.textContent)).toEqual([
			expect.stringContaining('Big Cat'),
			expect.stringContaining('Mid Cat')
		]);
		rows[0].addEventListener('click', (event) => event.preventDefault(), { once: true });
		await fireEvent.click(rows[0], { ctrlKey: true });
		expect(screen.getByTestId('unified-filter-results')).toBeInTheDocument();

		const pushes = __getNavigationLog().filter((entry) => entry.operation === 'pushState');
		expect(pushes).toHaveLength(1);
		expect(decodeLibraryRoute(new URL(pushes[0].url))).toEqual({
			kind: 'artist-filter',
			filter: '>30 albums'
		});
		expect(pushes[0].state).toEqual({});

		// Filter rows drill to the artist.
		await fireEvent.click(rows[0]);
		expect(screen.getByTestId('unified-artist-name').textContent).toContain('Big Cat');
	});

	it('the Back affordance clears the filter and traverses its history entry', async () => {
		const browserBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		mountMode({ liveLibrary: countedLibrary() });

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
		const harness = mountMode({ withContext: true, liveLibrary: countedLibrary() });

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
		const harness = mountMode({ withContext: true, liveLibrary: countedLibrary() });

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

	it('counts a filter over Roon\u2019s own Artists root, not the stored index', async () => {
		// The two sources disagree on purpose. The index holds the counts this
		// page used to read; the live roots hold a DIFFERENT library, which is
		// the one on screen. A filter that still read the index would answer
		// about rows the reader cannot see.
		const harness = mountMode({
			withContext: true,
			rootsState: liveRootsState({
				generation: 'gen-live',
				artists: [
					{ name: 'Live Forty', albumCount: 40, albums: [] },
					{ name: 'Live Two', albumCount: 2, albums: [] }
				],
				albums: []
			})
		});

		harness.registered.lifecycle!.resume(restoredFilterActivation('>30 albums'));

		await waitFor(() =>
			expect(screen.getByTestId('unified-filter-summary')).toHaveTextContent('1 ARTISTS')
		);
		expect(
			screen
				.getAllByTestId('unified-filter-artist')
				.map((row) => row.querySelector('.an')?.textContent)
		).toEqual(['Live Forty']);
		// And nothing from the stored index leaks in beside it.
		expect(screen.queryByText('Big Cat')).toBeNull();
	});

	it('does not test an artist Roon gave no album count, and says how many', async () => {
		// `undefined` is not zero. A row Roon printed no count for cannot match
		// a numeric predicate, and inventing a zero for it would put a number on
		// screen the library never said.
		const harness = mountMode({
			withContext: true,
			rootsState: liveRootsState({
				generation: 'gen-live',
				artists: [
					{ name: 'Counted One', albumCount: 1, albums: [] },
					{ name: 'Counted Also One', albumCount: 1, albums: [] },
					{ name: 'No Count At All', albumCount: null, albums: [] }
				],
				albums: []
			})
		});

		harness.registered.lifecycle!.resume(restoredFilterActivation('one album'));

		await waitFor(() =>
			expect(screen.getByTestId('unified-filter-summary')).toHaveTextContent('2 ARTISTS')
		);
		expect(
			screen
				.getAllByTestId('unified-filter-artist')
				.map((row) => row.querySelector('.an')?.textContent)
		).toEqual(['Counted Also One', 'Counted One']);
		expect(screen.getByTestId('unified-filter-uncounted').textContent).toContain(
			'1 of 3'
		);
	});

	it('degrades unparseable restored filter text honestly', async () => {
		const harness = mountMode({ withContext: true, liveLibrary: countedLibrary() });

		harness.registered.lifecycle!.resume(restoredFilterActivation('bowie'));

		await waitFor(() =>
			expect(screen.getByTestId('unified-filter-invalid')).toBeInTheDocument()
		);
		expect(screen.queryByTestId('unified-filter-results')).toBeNull();
	});
});

describe('UnifiedLibraryMode — brand wordmark', () => {
	it('shows the runic mark by default and flips to the Latin spelling on click', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

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
		mountMode({ liveLibrary: harnessLibrary() });
		expect(screen.getByTestId('unified-brand').textContent ?? '').not.toContain('ROON');
	});
});

describe('UnifiedLibraryMode — About panel', () => {
	it('is closed until opened, then reports interface and Core version provenance', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		expect(screen.queryByTestId('unified-about-panel')).toBeNull();
		const open = screen.getByTestId('unified-about-open');
		expect(open).toHaveAttribute('aria-expanded', 'false');

		await fireEvent.click(open);

		const panel = screen.getByTestId('unified-about-panel');
		expect(panel).toHaveAttribute('role', 'dialog');
		expect(open).toHaveAttribute('aria-expanded', 'true');
		// Version provenance is the reason this surface exists: without it the
		// default view reveals nothing about what build is running.
		// The product version, not the build revision. Before this row existed
		// the panel named only an opaque git short SHA, so the release the user
		// was running was nowhere on the surface.
		expect(screen.getByTestId('unified-about-app-version').textContent?.trim()).toMatch(
			/^\d+\.\d+\.\d+/u
		);
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
		mountMode({ liveLibrary: harnessLibrary() });

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

describe('UnifiedLibraryMode — Sort and About dismiss on outside click / Escape (issue #15)', () => {
	// Before this fix the only way to close Sort was its own toggle button,
	// and it stayed open underneath other popups; these guard the outside-
	// pointerdown and Escape dismissal added to close it.
	it('closes Sort on an outside pointerdown, but a pointerdown inside its own menu leaves it open', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		const toggle = screen.getByTestId('unified-sort');
		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-expanded', 'true');

		await fireEvent.pointerDown(screen.getByTestId('unified-sort-option-za'));
		expect(toggle).toHaveAttribute('aria-expanded', 'true');

		await fireEvent.pointerDown(document.body);
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
	});

	it('closes Sort on Escape', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		const toggle = screen.getByTestId('unified-sort');
		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-expanded', 'true');

		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
	});

	// Regression: the collection-drill ("genre") Sort control stays mounted,
	// merely hidden, underneath an open artist page (§4.2 collection-host —
	// `itemTarget?.kind === 'artist'` wins the drillSortMenu/drillSortValue
	// derivation regardless of collectionDrill, so both render sites of the
	// shared `drillSortControl` snippet show the SAME artist sort menu).
	// Both bound the SAME `sortWrap` reference. Landing on the artist page
	// and a genre drill in one navigation creates both Sort controls'
	// elements in the same update; the LATER one in template order (the
	// hidden collection-drill control, which renders after the visible
	// header control) ran its bind:this last and overwrote the reference —
	// a pointerdown inside the VISIBLE artist-page menu was then
	// misclassified as outside the menu and closed it before the click
	// could apply.

	// The palette opens over the header and covers it; nothing unset these
	// booleans when it did, so an open menu rendered underneath the palette.
	it('closes an open Sort menu when the palette opens over it', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		const toggle = screen.getByTestId('unified-sort');
		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-expanded', 'true');

		await fireEvent.keyDown(window, { key: 'b' });

		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect(screen.getByTestId('unified-sort')).toHaveAttribute('aria-expanded', 'false');
	});

	it('closes an open About panel when the palette opens over it', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		await fireEvent.click(screen.getByTestId('unified-about-open'));
		expect(screen.getByTestId('unified-about-panel')).toBeTruthy();

		await fireEvent.keyDown(window, { key: 'b' });

		expect(screen.getByTestId('unified-palette')).toBeInTheDocument();
		expect(screen.queryByTestId('unified-about-panel')).toBeNull();
	});

	it('closes About on an outside pointerdown, but a pointerdown inside its own panel leaves it open', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		await fireEvent.click(screen.getByTestId('unified-about-open'));
		expect(screen.getByTestId('unified-about-panel')).toBeTruthy();

		await fireEvent.pointerDown(screen.getByTestId('unified-about-app-version'));
		expect(screen.queryByTestId('unified-about-panel')).toBeTruthy();

		await fireEvent.pointerDown(document.body);
		expect(screen.queryByTestId('unified-about-panel')).toBeNull();
	});

	it('closes About on Escape', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		await fireEvent.click(screen.getByTestId('unified-about-open'));
		expect(screen.getByTestId('unified-about-panel')).toBeTruthy();

		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByTestId('unified-about-panel')).toBeNull();
	});
});

describe('UnifiedLibraryMode — Controller settings trigger', () => {
	// Settings must stay reachable from unified (public issue #1's second
	// finding). The floating gear that used to carry that guarantee was
	// excised by owner ruling 2026-08-08; the bar button is now the only
	// path, so this test is the reachability guard.
	it('docks the settings trigger in the bar, before About, and opens the shared dialog store', async () => {
		settingsMenuOpen.set(false);
		mountMode({ liveLibrary: harnessLibrary() });

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
