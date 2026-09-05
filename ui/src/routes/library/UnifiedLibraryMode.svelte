<script lang="ts">
	import { getContext, onMount, tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type CommittedLibraryModeActivation,
		type LibraryModeActivationContext
	} from '$lib/libraryModeActivationContext';
	import {
		buildUnifiedLibraryPageState,
		type BrowseBreadcrumb,
		type UnifiedItemDetailTarget,
		type UnifiedItemTarget,
		type UnifiedLibraryDrillTarget,
		type UnifiedLibraryPageState,
		type UnifiedLibraryScope
	} from '$lib/libraryPageState';
	import { LibraryItemPageController } from '$lib/library/LibraryItemPageController';
	import {
		expectSelfAuthoredLibraryPageState as expectLibraryRoute,
		preflightLibraryPageState as preflightLibraryRoute,
		pushLibraryPageState as pushLibraryRoute,
		replaceLibraryPageState as replaceLibraryRoute,
		shouldHandleLibraryAnchorClick,
		type LibraryPageStateWriteResult
	} from '$lib/libraryPageNavigation';
	import {
		encodeLibraryRoute,
		type LibraryRoute,
		type LibraryRouteAlbum,
		type LibraryRouteBrowseStep
	} from '$lib/libraryRoute';
	import { browseBreadcrumbFor } from '$lib/library/browseSemantics';
	import { libraryParentPageState, libraryRouteFromPageState } from '$lib/libraryRouteState';
	import {
	classicBrowseSessionClient,
	type ClassicBrowseSessionClaim
} from '$lib/stores/classicBrowseSessionStore';
import type { ClassicBrowseSessionRef } from '@shared/classicBrowseContracts';
	import {
		bucketLetterFor,
		compareLibrarySearchKeys,
		librarySortKey,
		type LetterBucket,
		type LibraryAlbumEntry,
		type LibraryArtistEntry
	} from '$lib/libraryEntries';
	import { libraryRootsStore, loadLibraryRoots } from '$lib/stores/libraryRootsStore';
	import { fetchCoreStatus, openLibraryReference, openLibraryRoot } from '$lib/api/client';
	import {
		LiveLibraryPageController,
		type LiveLibraryPageOpenInput
	} from '$lib/library/LiveLibraryPageController';
	import {
		libraryAlbumStep,
		type LibraryPathTarget,
		type LibraryRenderingPath
	} from '$lib/library/liveLibraryPath';
	import type { LibraryRowReference } from '@shared/libraryRootsContracts';
	import { swallowsTypedText } from '$lib/a11y/keyboardOwnership';
	import { claimModalSurface } from '$lib/actions/focusTrap';
	import { openSettingsMenu, settingsMenuOpen } from '$lib/stores/settingsMenuStore';
	import {
		registerUnifiedLibraryDensityRequestHandler,
		unifiedLibraryPrefsStore,
		type SortableUnifiedScope,
		type UnifiedLibraryDensity
	} from '$lib/stores/unifiedLibraryPrefsStore';
	import {
		liveAlbumSortMenu,
		artistDrillSortMenu,
		ARTIST_SORT_MENU,
		GENRE_SORT_MENU,
		isChronologicalAlbumSort,
		namedCountBuckets,
		reverseBuckets,
		sortAlbums,
		type DateFeatureGate,
		type SortMenuEntry
	} from '$lib/unifiedLibrarySorts';
	import {
		unifiedComposersStore,
		unifiedGenresStore
	} from '$lib/stores/unifiedNamedCountsStore';
	import {
		clearPaletteSearch,
		resetPaletteSearch,
		searchPalette,
		unifiedPaletteSearchStore,
		type PaletteSearchRow
	} from '$lib/stores/unifiedPaletteSearchStore';
	import {
		claimLibraryIntent,
		pendingLibraryIntentStore
	} from '$lib/stores/libraryIntentStore';
	import type { LibraryIntent } from '$lib/libraryIntent';
	import { parseCountFilter } from '$lib/unifiedSmartFilters';
	import { loadRecentlyPlayed, recentlyPlayedStore } from '$lib/stores/recentlyPlayedStore';
	import { zonesStore } from '$lib/stores/zonesStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import { getSocket } from '$lib/socket/client';
	import { getTabId } from '$lib/tabId';
	import {
		LibraryAlbumController,
		type LibraryAlbumSocket
	} from '$lib/library/LibraryAlbumController';
	import {
		type CollectionDrillHierarchy,
		type CollectionDrillOpenFailureDetail
	} from '@shared/collectionDrillContracts';
	import type { LibraryAlbumOpenTarget } from '@shared/libraryAlbumContracts';
	import { UnifiedSongActionController } from '$lib/library/UnifiedSongActionController';
	import {
		browseItemOpensActions,
		createUnifiedBrowseActionController,
		createUnifiedBrowseController,
		type UnifiedBrowseActionController,
		type UnifiedBrowseActionSource,
		type UnifiedBrowseController
	} from '$lib/library/UnifiedBrowseController';
	import {
		addFavorite,
		favoritesStore,
		loadFavorites,
		removeFavorite,
		type FavoritesState
	} from '$lib/stores/favoritesStore';
	import {
		unifiedSearchClient,
		type UnifiedSearchClient
	} from '$lib/unifiedSearchClient';
	import {
		AlbumActionController,
		type AlbumActionBeginInput,
		type AlbumActionSocket
	} from '$lib/library/AlbumActionController';
	import type { AlbumActionSemantic } from '@shared/albumActionContracts';
	import {
		CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
		normalizeCatalogText
	} from '@shared/catalogContracts';
	import type {
		UnifiedSongActionSemantic,
		UnifiedSongAlbumRelationship,
		UnifiedSongRelationship
	} from '@shared/unifiedSearchContracts';
	import type {
		AddFavoriteRequest,
		BrowseItem,
		FavoriteEntry,
		FavoriteType,
		SearchResult
	} from '@shared/types';
	import type { LibraryLevelRow } from '@shared/libraryOpenContracts';
	import UnifiedScopeViews from './UnifiedScopeViews.svelte';
	import UnifiedLiveCollectionPage from './UnifiedLiveCollectionPage.svelte';
	import UnifiedAlbumPage from './UnifiedAlbumPage.svelte';
	import UnifiedArtistPage from './UnifiedArtistPage.svelte';
	import UnifiedPalette from './UnifiedPalette.svelte';
	import UnifiedTrackPage from './UnifiedTrackPage.svelte';
	import UnifiedBrowseView from './UnifiedBrowseView.svelte';
	import UnifiedBrowseActionSheet from './UnifiedBrowseActionSheet.svelte';
	import UnifiedFavoritesView from './UnifiedFavoritesView.svelte';
	import './unified-surface.css';
	import { version as uiBuildRevision } from '$app/environment';
	import { coreStore, isCorePaired } from '$lib/stores/coreStore';
	import { socketStatusStore } from '$lib/stores/socketStatusStore';

	interface ScopeChip {
		readonly id: UnifiedLibraryScope;
		readonly label: string;
	}

	interface SongRelationshipViewState {
		readonly phase: 'idle' | 'loading' | 'ready' | 'unavailable';
		readonly resultId: string | null;
		readonly relationship: UnifiedSongRelationship | null;
		readonly error: string | null;
	}

	interface UnifiedConnectionSocket {
		readonly connected: boolean;
		on(event: 'connect' | 'disconnect', listener: () => void): void;
		off(event: 'connect' | 'disconnect', listener: () => void): void;
	}

	/** Owner-approved Unified scopes; P2 adds deep Roon Browse here. */
	const LEADING_SCOPE_CHIPS: readonly ScopeChip[] = [
		{ id: 'artists', label: 'Artists' },
		{ id: 'albums', label: 'Albums' },
		{ id: 'genres', label: 'Genres' },
		{ id: 'browse', label: 'Browse' },
		{ id: 'recently-played', label: 'Recently played' },
		{ id: 'favorites', label: 'Favorites' }
	];
	const SURPRISE_CHIP: ScopeChip = { id: 'surprise', label: 'Surprise me' };

	/**
	 * Recently added (Slice 5) rides the date-feature gate exactly like the
	 * release-year sort. Per the 2026-07-24 owner correction an unavailable
	 * chip is absent, never rendered disabled.
	 */
	const RECENTLY_ADDED_CHIP: ScopeChip = { id: 'recently-added', label: 'Recently added' };
	const ALL_SCOPE_CHIPS: readonly ScopeChip[] = [
		...LEADING_SCOPE_CHIPS,
		SURPRISE_CHIP,
		RECENTLY_ADDED_CHIP
	];

	const SORT_MENUS: Partial<Record<UnifiedLibraryScope, readonly SortMenuEntry[]>> = {
		artists: ARTIST_SORT_MENU,
		genres: GENRE_SORT_MENU
	};

	/** Rail auto-hide rule (owner-binding): under 3 letters or 40 items. */
	const RAIL_MIN_LETTERS = 3;
	const RAIL_MIN_ITEMS = 40;
	/**
	 * How many frames a scroll restore may wait for the list to come back after
	 * a rebuild. Bounded so a genuinely shorter list (a filter, a smaller Core)
	 * settles at its own maximum instead of retrying forever.
	 */
	const PANE_SCROLL_RESTORE_FRAMES = 30;

	/**
	 * Prototype rail: fixed letter order with inactive letters kept dim.
	 * `#` leads (approved prototype pins it at the top), which also keeps
	 * the mirror heuristic in `railLetterEntries` honest: ascending data
	 * leads with the `#` bucket, so `#` must rank below `A`, or the rail
	 * flips to `# Z Y…` the moment a library has a non-letter initial.
	 */
	const RAIL_LETTERS: readonly string[] = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

	function railLetterEntries(
		buckets: readonly LetterBucket[]
	): readonly { letter: string; bucket: LetterBucket | null }[] {
		const byLetter = new Map(buckets.map((bucket) => [bucket.letter, bucket]));
		const first = buckets[0];
		const last = buckets[buckets.length - 1];
		const reversed =
			first !== undefined &&
			last !== undefined &&
			RAIL_LETTERS.indexOf(first.letter) > RAIL_LETTERS.indexOf(last.letter);
		const order = reversed ? [...RAIL_LETTERS].reverse() : RAIL_LETTERS;
		return order.map((letter) => ({ letter, bucket: byLetter.get(letter) ?? null }));
	}

	let sortOpen = $state(false);
	/** Wraps the root collection-scope Sort control for outside-click handling. */
	let collectionSortWrap = $state<HTMLElement | null>(null);
	/** Header wordmark: runic mark by default, Latin spelling once clicked. */
	let brandShowsLatin = $state(false);
	/** About panel: the only surface in this view carrying version provenance. */
	let aboutOpen = $state(false);
	/** About's toggle button and panel are not a shared wrapper (the panel
	 *  renders as a header sibling), so outside-click detection needs both. */
	let aboutButton = $state<HTMLElement | null>(null);
	let aboutPanel = $state<HTMLElement | null>(null);

	// Close Sort on an outside click or Escape, mirroring the zone-picker
	// idiom in +layout.svelte: listeners attach only while open and are torn
	// down by the effect's own cleanup.
	$effect(() => {
		if (!sortOpen) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			const target = event.target as Node;
			if (collectionSortWrap?.contains(target)) return;
			sortOpen = false;
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') sortOpen = false;
		};
		window.addEventListener('pointerdown', closeOnOutsidePointer);
		window.addEventListener('keydown', closeOnEscape);
		return () => {
			window.removeEventListener('pointerdown', closeOnOutsidePointer);
			window.removeEventListener('keydown', closeOnEscape);
		};
	});

	// Same idiom for About; the button and panel are checked separately since
	// neither wraps the other.
	$effect(() => {
		if (!aboutOpen) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			const target = event.target as Node;
			if (aboutButton?.contains(target)) return;
			if (aboutPanel?.contains(target)) return;
			aboutOpen = false;
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') aboutOpen = false;
		};
		window.addEventListener('pointerdown', closeOnOutsidePointer);
		window.addEventListener('keydown', closeOnEscape);
		return () => {
			window.removeEventListener('pointerdown', closeOnOutsidePointer);
			window.removeEventListener('keydown', closeOnEscape);
		};
	});
	const connectedLabel = $derived(
		$socketStatusStore === 'connecting'
			? 'Connecting…'
			: $socketStatusStore === 'disconnected'
				? 'Disconnected'
				: $isCorePaired
					? 'Connected'
					: 'Searching for Core…'
	);
	const connectedGood = $derived($socketStatusStore === 'connected' && $isCorePaired);
	let shuffleSeed = $state(Math.floor(Date.now() / 60_000));

	let {
		sessionClient = classicBrowseSessionClient,
		prefsStore = unifiedLibraryPrefsStore,
		genresStore = unifiedGenresStore,
		composersStore = unifiedComposersStore,
		paletteSearchStore = unifiedPaletteSearchStore,
		searchPaletteData = searchPalette,
		clearPaletteSearchData = clearPaletteSearch,
		resetPaletteSearchData = resetPaletteSearch,
		recentStore = recentlyPlayedStore,
		loadRecent = loadRecentlyPlayed,
		favoritesDataStore = favoritesStore,
		loadFavoritesData = loadFavorites,
		removeFavoriteData = removeFavorite,
		rootsStore = libraryRootsStore,
		loadRoots = loadLibraryRoots,
		openLiveRef = openLibraryReference,
		openLiveRoot = openLibraryRoot,
		fetchCoreStatusData = fetchCoreStatus,
		corePairedStore = isCorePaired,
		fetchFn = fetch,
		albumController: suppliedAlbumController,
		songActionController: suppliedSongActionController,
		browseController: suppliedBrowseController,
		browseActionController: suppliedBrowseActionController,
		addFavoriteData = addFavorite,
		songRelationshipClient = unifiedSearchClient,
		albumActionController: suppliedAlbumActionController,
		getSocketClient = () => getSocket() as UnifiedConnectionSocket | null
	}: {
		sessionClient?: typeof classicBrowseSessionClient;
		prefsStore?: typeof unifiedLibraryPrefsStore;
		genresStore?: typeof unifiedGenresStore;
		composersStore?: typeof unifiedComposersStore;
		paletteSearchStore?: typeof unifiedPaletteSearchStore;
		searchPaletteData?: typeof searchPalette;
		clearPaletteSearchData?: typeof clearPaletteSearch;
		resetPaletteSearchData?: typeof resetPaletteSearch;
		recentStore?: typeof recentlyPlayedStore;
		loadRecent?: typeof loadRecentlyPlayed;
		favoritesDataStore?: typeof favoritesStore;
		loadFavoritesData?: typeof loadFavorites;
		removeFavoriteData?: typeof removeFavorite;
		/** Roon's own two roots, the live view's only list source (Slice 2). */
		rootsStore?: typeof libraryRootsStore;
		loadRoots?: typeof loadLibraryRoots;
		openLiveRef?: typeof openLibraryReference;
		openLiveRoot?: typeof openLibraryRoot;
		fetchCoreStatusData?: typeof fetchCoreStatus;
		/** Pairing readiness, injected so tests can drive the retry. */
		corePairedStore?: typeof isCorePaired;
		fetchFn?: typeof fetch;
		albumController?: LibraryAlbumController;
		songActionController?: UnifiedSongActionController;
		browseController?: UnifiedBrowseController;
		browseActionController?: UnifiedBrowseActionController;
		addFavoriteData?: (fetchFn: typeof fetch, payload: AddFavoriteRequest) => Promise<void>;
		songRelationshipClient?: Pick<UnifiedSearchClient, 'relationship'>;
		albumActionController?: AlbumActionController;
		getSocketClient?: () => UnifiedConnectionSocket | null;
	} = $props();

	const albumController =
		untrack(() => suppliedAlbumController) ??
		new LibraryAlbumController({
			getSocket: () => getSocket() as unknown as LibraryAlbumSocket | null
		});
	const sheetActionController =
		untrack(() => suppliedAlbumActionController) ??
		new AlbumActionController({
			getSocket: () => getSocket() as unknown as AlbumActionSocket | null
		});
	// The live view's open page (`.agents/plans/library-live-view.md` Slice 2).
	// It owns one page at a time — the same discipline `itemTarget` has — and
	// it reads Roon rather than the catalog.
	const livePageController = new LiveLibraryPageController({
		heldRoot: (root) => {
			const held = untrack(() => $rootsStore);
			if (held.phase !== 'ready') return null;
			return root === 'artists' ? held.artistRows : held.albumRows;
		},
		openRef: (ref) => openLiveRef(fetchFn, ref),
		openRoot: (root) => openLiveRoot(fetchFn, root),
		heldGeneration: () => untrack(() => $rootsStore).generation
	});
	// Item-page coordination (rich-item plan §5.2): its retirement hook is
	// the single place a replaced or closed page's read/action authority is
	// cancelled.
	const itemPageController = new LibraryItemPageController({
		onRetire: () => retireItemPageAuthority()
	});
	const songActionController =
		untrack(() => suppliedSongActionController) ?? new UnifiedSongActionController();
	const browseController =
		untrack(() => suppliedBrowseController) ??
		createUnifiedBrowseController({
			isClaimCurrent: (activeClaim) => sessionClient.isClaimCurrent(activeClaim)
		});
	const browseActionController =
		untrack(() => suppliedBrowseActionController) ??
		createUnifiedBrowseActionController({
			isClaimCurrent: (activeClaim) => sessionClient.isClaimCurrent(activeClaim)
		});
	const activationContext = getContext<LibraryModeActivationContext | undefined>(
		LIBRARY_MODE_ACTIVATION_CONTEXT
	);

	let scope = $state<UnifiedLibraryScope>('artists');
	let railTarget = $state<LetterBucket | null>(null);
	/** Genre/composer album-list context (collection navigation). */
	type EntryRelationship = 'owned' | 'restored' | 'transient';
	/** First-class item page over the scope/collection context. */
	let itemTarget = $state<UnifiedItemTarget | null>(null);
	/**
	 * Durable rendering route for a transitional catalog-backed item page.
	 * The route is captured from the row the reader clicked; it never contains
	 * the catalog id that happens to feed the current render.
	 */
	let legacyItemRoute: LibraryRoute | null = null;
	/**
	 * The originating artist's display name when the open item page is an
	 * ALBUM opened from that artist's page (issue #6): `itemBackLabel`
	 * prefers this over the scope/collection fallback because the actual
	 * back target is the artist's page, not the current scope. Cleared by
	 * every open that is not an album-from-artist transition and by
	 * `resetItemPage`, so a stale name never labels an unrelated page.
	 */
	let itemOriginName = $state<string | null>(null);
	let itemEntryRelationship: EntryRelationship = 'transient';
	/**
	 * Live-pushed entry ownership for in-page child closes (ri8-1): a
	 * child that pushed its own entry in this session exits by
	 * traversing back to the parent entry instead of rewriting its own
	 * into a duplicate. Restored children never claim this — their
	 * neighbouring entries are unknown.
	 */
	let trackChildOwnsEntry = false;
	/** The element that opened the live item page; Back refocuses it (§4.3). */
	let itemInvoker: HTMLElement | null = null;
	/** Pane scroll position captured at item open, restored on Back. */
	let itemReturnScrollTop = 0;
	/**
	 * Scroll parked across a recorded item Back: the history pop resumes
	 * the parent entry through the lifecycle, whose restoration would
	 * otherwise reset the pane to 0 (ri1-4). Applied at most once.
	 */
	let pendingPopReturnScrollTop: number | null = null;
	let drillNotice = $state<string | null>(null);
	/** Smart-filter page text (plan §3.2 slice 7); '' means no filter page. */
	let filterText = $state('');
	let paletteOpen = $state(false);
	let paletteQuery = $state('');
	let paletteSelectedRowId = $state<string | null>(null);
	let selectedSong = $state<PaletteSearchRow | null>(null);
	let browseActionFromPalette = $state(false);
	let browseFavoriteBusy = $state(false);
	let browseFavoriteStatus = $state<string | null>(null);
	let songFavoriteBusy = $state(false);
	let songFavoriteStatus = $state<string | null>(null);
	let favoriteMutationBusy = $state(false);
	let favoritesStatus = $state<string | null>(null);
	let returnToPalette = $state(false);
	let classicSearchOwnerGeneration = 0;
	let paletteSearchHandoff: Promise<void> = Promise.resolve();
	let songRelationship = $state<SongRelationshipViewState>({
		phase: 'idle',
		resultId: null,
		relationship: null,
		error: null
	});
	let relationshipFence = 0;
	let albumSongFocusTitle = $state<string | null>(null);
	let pane: HTMLDivElement | null = $state(null);
	let claim: ClassicBrowseSessionClaim | null = null;
	/**
	 * Bumped whenever the claim is taken or dropped.
	 *
	 * `claim` itself stays non-reactive on purpose — it is read all over this
	 * file, and making it a signal would re-run work that has nothing to do with
	 * it. This is the one reactive fact about it: a surface-driven load can wait
	 * for a claim to exist without every other reader waking up.
	 */
	let claimEpoch = $state(0);
	let lifecycleGeneration = 0;
	let activationGeneration = $state(0);
	let resumed = $state(false);
	let connectionSocket: UnifiedConnectionSocket | null = null;
	let connectionListenersAttached = false;
	let recoveryGeneration: number | null = null;
	/**
	 * A load bailed because the engine was not paired yet. The paired-store
	 * effect owns the single retry this arms; `pairingRetryGeneration` records
	 * the lifecycle generation whose retry has already been spent, so a
	 * persistent failure cannot re-arm itself into a loop.
	 */
	let pairingRetryDeferred = $state(false);
	let pairingRetryGeneration: number | null = null;
	/**
	 * Where each scope was left. One pane scrolls every scope, so without this
	 * a tab switch is indistinguishable from starting over.
	 */
	const scopeScrollTops = new Map<UnifiedLibraryScope, number>();
	/** Supersedes an in-flight `restorePaneScrollTop` retry loop. */
	let paneScrollRestoreToken = 0;
	let albumReadSession: ClassicBrowseSessionRef | null = null;
	type SheetActionIntent = Readonly<{
		kind: 'reference' | 'page';
		claim: ClassicBrowseSessionClaim;
		lifecycle: number;
		itemPageGeneration: number;
		zoneId: string;
		tabId: string;
		desiredSemantic: AlbumActionSemantic | null;
		ref?: LibraryRowReference;
		referenceSource?: 'album' | 'live-collection';
		trackIndex?: number | null;
		pageId?: string;
		versionId?: string;
		track?: { readonly index: number; readonly title: string } | null;
	}>;
	type SheetActionAttempt = {
		readonly intent: SheetActionIntent;
		readonly gesture: number;
		readonly session: ClassicBrowseSessionRef;
		readonly requestId: string;
		automaticReissueSpent: boolean;
		reissueInFlight: boolean;
	};
	let sheetActionGesture = 0;
	let sheetActionAttempt: SheetActionAttempt | null = null;
	let retrySheetActionIntent: SheetActionIntent | null = null;
	let sheetActionRetryAvailable = $state(false);
	const sheetState = $derived($albumController);
	const sheetActionState = $derived($sheetActionController);
	const songActionState = $derived($songActionController);
	const browseState = $derived($browseController);
	const browseActionState = $derived($browseActionController);
	const sheetZones = $derived(
		$zonesStore.map((zone) => ({ zoneId: zone.zone_id, name: zone.display_name }))
	);
	/**
	 * The one zone every library playback action targets (public issue #12):
	 * whatever the zone picker currently holds, exactly as the Roon Remote app
	 * behaves. No surface asks which zone any more.
	 *
	 * `+layout.svelte` keeps the selection pointing at a live zone — it returns
	 * to the user's pin the moment that zone reappears and otherwise falls back
	 * in memory only — so the first-zone floor below covers only the window
	 * between zones arriving and that effect settling. No zones at all means
	 * null, and every action button is disabled.
	 */
	const actionZoneId = $derived(
		(sheetZones.some((zone) => zone.zoneId === $selectedZoneStore)
			? $selectedZoneStore
			: sheetZones[0]?.zoneId) ?? null
	);

	const prefs = $derived($prefsStore);
	const roots = $derived($rootsStore);
	const favorites = $derived($favoritesDataStore);

	// ---- Which of the two sources THIS surface reads (Slice 2) ---------
	//
	// `.agents/plans/library-live-view.md` moved the Artists and Albums lists,
	// the pages under them, and the smart-filter page onto Roon's own roots.
	// Everything else — the genre and composer drills, the catalog item pages a
	// restored address can still name — reads the catalog index until its own
	// slice moves it.
	//
	// This is ONE answer, derived once, because the alternative is a surface
	// whose rows come from one source and whose count, rail and readiness come
	// from the other. That is how a list of 1,679 artists ends up under the
	// heading "0 TOTAL": not a wrong number, but two sources disagreeing in
	// public.
	//
	// TYPING DOES NOT CHANGE THE SOURCE. The smart-filter page runs over the
	// live roots this surface already holds, so `filterText` is not a clause
	// here: a reader who types a count filter and clears it again is looking at
	// the same list throughout, and the filter counts what the list shows.
	const liveScopeActive = $derived(
		(scope === 'artists' || scope === 'albums') &&
			(itemTarget === null || itemTarget.kind === 'live')
	);
	/** The rows this surface lists, and the buckets and counts that describe them. */
	const listArtists = $derived(roots.artists);
	const listAlbums = $derived(roots.albums);
	const listArtistBuckets = $derived(roots.artistBuckets);
	const listAlbumBuckets = $derived(roots.albumBuckets);
	const surfacePhase = $derived.by((): 'loading' | 'error' | 'ready' | 'idle' => {
		// A live item page owns its own opening/error/ready state. Do not let
		// either backing list gate hide it while its route is being restored.
		if (itemTarget?.kind === 'live') return 'ready';
		if (roots.phase === 'ready') return 'ready';
		if (roots.phase === 'loading') return 'loading';
		if (roots.phase === 'error' || roots.phase === 'unavailable') return 'error';
		return 'idle';
	});
	const surfaceError = $derived(roots.error);
	/**
	 * The chip row: Recently added exists only while date features do.
	 */
	const scopeChips = $derived.by((): readonly ScopeChip[] => [
		...LEADING_SCOPE_CHIPS,
		SURPRISE_CHIP
	]);
	/**
	 * A persisted chronological sort outlives the surface that could perform it.
	 *
	 * Every album list this mode renders — the Albums scope (Roon's own root,
	 * Slice 2), the artist page and the genre drill — shows rows carrying a
	 * title and a credit line and no date. So a sort saved when one of them
	 * could order by year falls back to A–Z rather than selecting an entry the
	 * menu no longer offers and an order nothing can perform.
	 */
	function resolveAlbumOrder<T extends string>(sort: T): T | 'az' {
		return isChronologicalAlbumSort(sort) ? 'az' : sort;
	}
	const sortMenu = $derived(
		scope === 'albums' ? liveAlbumSortMenu() : (SORT_MENUS[scope] ?? null)
	);
	const sortValue = $derived(
		sortMenu ? resolveAlbumOrder(prefs.sorts[scope as SortableUnifiedScope]) : null
	);
	const viewSorts = $derived({
		...prefs.sorts,
		albums: resolveAlbumOrder(prefs.sorts.albums)
	});
	const liveCollectionSorts = $derived({
		...viewSorts,
		albums: resolveAlbumOrder(prefs.sorts.genre)
	});
	/** Header count, verbatim per approved prototype `head(...)` calls. */
	const scopeSummary = $derived.by(() => {
		switch (scope) {
			case 'artists':
				return `${listArtists.length.toLocaleString()} TOTAL`;
			case 'albums':
				return `${listAlbums.length.toLocaleString()} TOTAL`;
			case 'genres':
				return `${$genresStore.totalCount.toLocaleString()} TOTAL`;
			case 'recently-played':
				return `${$recentStore.entries.length} TRACKS`;
			case 'recently-added':
				return `${listAlbums.length.toLocaleString()} TOTAL`;
			case 'surprise':
				return `RANDOM FROM ${listAlbums.length.toLocaleString()}`;
			default:
				return '';
		}
	});
	const railBuckets = $derived.by((): readonly LetterBucket[] => {
		// The rail addresses the list on screen, so it waits on whichever source
		// produced that list — not on the catalog, which the live scopes no
		// longer read.
		if (surfacePhase !== 'ready') return [];
		if (scope === 'albums' && sortValue === 'by-artist') {
			const buckets: LetterBucket[] = [];
			for (const [position, album] of sortAlbums(listAlbums, 'by-artist', shuffleSeed).entries()) {
				const letter = bucketLetterFor(librarySortKey(album.artist));
				const last = buckets[buckets.length - 1];
				if (last?.letter === letter) last.count += 1;
				else buckets.push({ letter, start: position, count: 1 });
			}
			return buckets;
		}
		const base =
			scope === 'artists'
				? listArtistBuckets
				: scope === 'albums'
					? listAlbumBuckets
					: scope === 'genres'
						? namedCountBuckets($genresStore.entries)
						: [];
		if (base.length === 0 || sortValue !== 'za') return base;
		// ZA rail reversal: mirror the A–Z buckets onto the reversed list
		// so each letter still addresses exactly its entries (slice 5).
		const total =
			scope === 'artists'
				? listArtists.length
				: scope === 'albums'
					? listAlbums.length
					: $genresStore.entries.length;
		return reverseBuckets(base, total);
	});
	const railItemCount = $derived(
		scope === 'artists'
				? listArtists.length
			: scope === 'albums'
				? listAlbums.length
				: scope === 'genres'
					? $genresStore.entries.length
				: 0
	);
	const railSortCompatible = $derived.by(() => {
		if (scope === 'artists') return sortValue === 'az' || sortValue === 'za';
		// Chronological album orders (Oldest/Newest first) hide the rail
		// exactly like the other non-alphabetical orders (Shuffle).
		if (scope === 'albums')
			return sortValue === 'az' || sortValue === 'za' || sortValue === 'by-artist';
		if (scope === 'genres') return sortValue === 'az' || sortValue === 'za';
		return false;
	});
	// Item pages own the pane; the rail serves root scopes and genre drills.
	const railVisible = $derived(
		itemTarget === null &&
			filterText === '' &&
			railSortCompatible &&
			railBuckets.length >= RAIL_MIN_LETTERS &&
			railItemCount >= RAIL_MIN_ITEMS
	);

	// ---- Smart-filter page (plan §3.2 slice 7) ------------------------
	// The parsed spec re-derives from persisted text on every render, so
	// a restored page re-validates instead of trusting stale results.
	//
	// IT RUNS OVER ROON'S OWN ARTISTS ROOT. Each row's count is the number Roon
	// printed in that row's own subtitle ("58 Albums"), parsed once when the
	// root was read — the row talking about itself, never a join and never a
	// stored answer. A row Roon gave no count for is NOT tested: `undefined` is
	// not zero, and matching it against a numeric predicate would put a number
	// on screen the library never said. Those rows are counted separately and
	// declared, so nobody reads a partial answer as a whole one.
	const filterSpec = $derived(filterText === '' ? null : parseCountFilter(filterText));
	const filterArtists = $derived.by(() => {
		if (!filterSpec || roots.phase !== 'ready') return [];
		const spec = filterSpec;
		return roots.artists
			.filter((entry) => entry.albumCount !== undefined && spec.test(entry.albumCount))
			.sort(
				(a, b) =>
					(b.albumCount ?? 0) - (a.albumCount ?? 0) ||
					compareLibrarySearchKeys(a.searchKey, b.searchKey)
			);
	});
	/** How many live Artists rows Roon gave no count for, and so were not tested. */
	const filterUncountedArtists = $derived(
		roots.phase === 'ready'
			? roots.artists.reduce((total, entry) => (entry.albumCount === undefined ? total + 1 : total), 0)
			: 0
	);

	// ---- The live view of Roon (library-live-view Slice 2) ------------
	// Artists and Albums are Roon's own two roots, and every page under them
	// is Roon's own level. Nothing on this path reads the catalog, mints an
	// identifier, or compares a name against another surface.

	const livePage = $derived($livePageController);
	/**
	 * What the OPEN ADDRESS says this page is — the reader's own question,
	 * answered without waiting for a read. Roon's answer arrives with the
	 * level and cannot differ: every step's kind was taken from the row it
	 * names, at the moment that row was rendered.
	 */
	const livePageKind = $derived(
		itemTarget?.kind === 'live'
			? (itemTarget.path.steps[itemTarget.path.steps.length - 1]?.kind ?? 'entry')
			: null
	);
	/** The live artist page's identity, from the row Roon rendered. */
	const liveArtist = $derived.by((): LibraryArtistEntry | null => {
		if (livePageKind !== 'artist' || livePage.target === null) return null;
		const target = livePage.target;
		return {
			id: target.ref.token,
			name: target.title,
			searchKey: librarySortKey(target.title),
			liveRef: target.ref,
			...(target.imageKey === null ? {} : { imageKey: target.imageKey })
		};
	});
	/** The live artist page's discography: Roon's own album rows, in its order. */
	const liveArtistAlbums = $derived.by((): LibraryAlbumEntry[] => {
		const level = livePageKind === 'artist' ? livePage.level : null;
		if (level === null) return [];
		return level.rows
			.filter((row) => row.kind === 'album')
			.map((row) => liveAlbumEntryFromLevelRow(row));
	});
	/** The live album page's hero row, likewise from what Roon rendered. */
	const liveAlbum = $derived.by((): LibraryAlbumEntry | null => {
		if (livePageKind !== 'album' || livePage.target === null) return null;
		return liveAlbumEntryFromLevelRow({
			ref: livePage.target.ref,
			title: livePage.target.title,
			...(livePage.target.subtitle === null ? {} : { subtitle: livePage.target.subtitle }),
			...(livePage.target.imageKey === null ? {} : { imageKey: livePage.target.imageKey })
		});
	});

	function liveAlbumEntryFromLevelRow(row: {
		readonly ref: LibraryRowReference;
		readonly title: string;
		readonly subtitle?: string;
		readonly imageKey?: string;
	}): LibraryAlbumEntry {
		return {
			// The token is this row's whole identity and it dies with its
			// generation; it is used here only as a keyed-each key inside the
			// list that produced it, never written down and never compared.
			id: row.ref.token,
			title: row.title,
			artist: row.subtitle ?? '',
			searchKey: librarySortKey(`${row.title} ${row.subtitle ?? ''}`),
			liveRef: row.ref,
			...(row.imageKey === undefined ? {} : { imageKey: row.imageKey })
		};
	}

	/** The address of one row of a root: Roon's own text, and nothing else. */
	function liveRootPath(
		origin: 'artists' | 'albums',
		row: { readonly title: string; readonly artist?: string }
	): LibraryRenderingPath {
		return origin === 'artists'
			? { origin, steps: [{ kind: 'artist', title: row.title }] }
			: { origin, steps: [libraryAlbumStep(row.title, row.artist ?? '')] };
	}

	/**
	 * Open one row the reader clicked in the live view.
	 *
	 * The reference is what opens it NOW — that click was unambiguous even
	 * where two rows read alike. The address is what the page is, and it is
	 * the only part written down.
	 */
	function openLiveRow(
		path: LibraryRenderingPath,
		row: {
			readonly liveRef?: LibraryRowReference;
			readonly title: string;
			readonly subtitle?: string;
			readonly imageKey?: string;
		},
		recordHistory = true
	): void {
		void openItemPage({ kind: 'live', path }, recordHistory, undefined, {
			path,
			title: row.title,
			...(row.liveRef === undefined ? {} : { ref: row.liveRef }),
			...(row.subtitle === undefined ? {} : { subtitle: row.subtitle }),
			...(row.imageKey === undefined ? {} : { imageKey: row.imageKey })
		});
	}

	function openLiveGroupCandidate(target: LibraryPathTarget): void {
		const group = livePage.group;
		if (group === null) return;
		// A candidate has no invented address of its own. The group URL stays
		// put; this in-session choice opens only the live reference Roon put on
		// the selected row.
		itemTarget = { kind: 'live', path: group.path };
		livePageResolvedUnder = untrack(() => roots.generation);
		livePageController.open({
			path: group.path,
			ref: target.ref,
			title: target.title,
			...(target.subtitle === null ? {} : { subtitle: target.subtitle }),
			...(target.imageKey === null ? {} : { imageKey: target.imageKey })
		});
	}

	function liveChildPath(row: LibraryLevelRow): LibraryRenderingPath | null {
		if (itemTarget?.kind !== 'live') return null;
		const step =
			row.kind === 'album'
				? libraryAlbumStep(row.title, row.subtitle ?? '')
				: { kind: row.kind, title: row.title };
		return { origin: itemTarget.path.origin, steps: [...itemTarget.path.steps, step] };
	}

	function openLiveStructuralRow(row: LibraryLevelRow, recordHistory: boolean): void {
		const path = liveChildPath(row);
		if (path === null) return;
		openLiveRow(
			path,
			{
				liveRef: row.ref,
				title: row.title,
				...(row.subtitle === undefined ? {} : { subtitle: row.subtitle }),
				...(row.imageKey === undefined ? {} : { imageKey: row.imageKey })
			},
			recordHistory
		);
	}

	function hrefForLiveStructuralRow(row: LibraryLevelRow): string | null {
		const path = liveChildPath(row);
		if (path === null) return null;
		const route = libraryRouteFromPageState(
			itemDestinationPageState({ kind: 'live', path })
		);
		if (route === null) return null;
		try {
			return encodeLibraryRoute(route);
		} catch {
			return null;
		}
	}

	/** An artist row of the Artists root. */
	function openLiveArtist(entry: LibraryArtistEntry): void {
		openLiveRow(liveRootPath('artists', { title: entry.name }), {
			title: entry.name,
			...(entry.liveRef === undefined ? {} : { liveRef: entry.liveRef }),
			...(entry.imageKey === undefined ? {} : { imageKey: entry.imageKey })
		});
	}

	/**
	 * An album tile, from the Albums root or from an artist's own page.
	 *
	 * The address it gets depends on where it was rendered, because that is
	 * where it will be looked for again: an album tile on an artist's page is
	 * addressed THROUGH that artist, never as a row of the Albums root, which
	 * is a different list that may render it differently or not at all.
	 */
	function openLiveAlbum(entry: LibraryAlbumEntry): void {
		const path =
			liveAlbumChildPath(entry) ??
			liveRootPath('albums', { title: entry.title, artist: entry.artist });
		openLiveRow(path, {
			title: entry.title,
			subtitle: entry.artist,
			...(entry.liveRef === undefined ? {} : { liveRef: entry.liveRef }),
			...(entry.imageKey === undefined ? {} : { imageKey: entry.imageKey })
		});
	}

	/**
	 * The album page is fed by the same read every live page uses.
	 *
	 * One reader, one fence. A second read on this path would be a second
	 * chance for a level to land under the wrong heading.
	 */
	$effect(() => {
		const page = livePage;
		const kind = livePageKind;
		if (kind !== 'album') return;
		untrack(() => {
			if (page.phase === 'opening') {
				albumController.beginLive();
				return;
			}
			if (page.phase === 'failed') {
				albumController.failLive('LIVE_OPEN_FAILED', page.message ?? 'This album could not be opened.');
				return;
			}
			if (page.phase === 'ready' && page.target && page.level) {
				albumController.adoptLiveLevel({
					albumRef: page.target.ref,
					title: page.target.title,
					artist: page.target.subtitle,
					rows: page.level.rows
				});
			}
		});
	});

	/**
	 * Re-read Roon's roots.
	 *
	 * Cheap when nothing moved — the store sends the generation it holds and the
	 * server answers "still current" from Roon's own root counts — and a whole
	 * replacement when it did. This is the plan's scope-activation trigger and
	 * the first half of recovering a page whose snapshot was retired.
	 */
	function reloadLiveRoots(): void {
		const coreId = untrack(() => roots.coreId) ?? untrack(() => $coreStore.core?.id) ?? null;
		if (coreId === null) return;
		void loadRoots(fetchFn, { coreId });
	}

	/**
	 * The roots generation the open page was last read under.
	 *
	 * Deliberately not reactive: it is the memory that makes re-resolution
	 * happen ONCE per snapshot. Without it a refusal the current snapshot cannot
	 * fix — a row Roon really has dropped — would be retried on every state
	 * change, which is a hot loop against the Core rather than a recovery.
	 */
	let livePageResolvedUnder: string | null = null;
	/** The snapshot a stale refusal has already asked the server to re-read. */
	let liveStaleAskedUnder: string | null = null;
	let handledLibraryRetirementRevision = 0;

	/**
	 * A retired snapshot re-resolves the open page; it never leaves it there.
	 *
	 * This is the whole recovery the plan ships. A refresh, a reconnect or a
	 * server-side session loss retires every reference the browser holds at
	 * once; the open page then re-asks Roon for the row its address names,
	 * under the generation that replaced it, exactly as a reload would.
	 */
	$effect(() => {
		const generation = roots.generation;
		const page = livePage;
		if (generation === null || page.path === null) return;
		if (page.phase === 'opening') return;
		if (page.phase === 'ready' && (page.level?.generation ?? null) === generation) {
			livePageResolvedUnder = generation;
			return;
		}
		if (livePageResolvedUnder === generation) return;
		livePageResolvedUnder = generation;
		untrack(() => livePageController.retry());
	});

	/**
	 * A page refused for a retired snapshot recovers by re-reading the roots.
	 *
	 * Retrying the address against rows that are themselves retired can only be
	 * refused again, so the snapshot has to move first. Once per snapshot: if the
	 * server says the generation it holds is still this one, the refusal was not
	 * about staleness after all and the reader is told, not looped.
	 */
	$effect(() => {
		const generation = roots.generation;
		const page = livePage;
		if (page.phase !== 'failed' || !page.stale) return;
		if (generation === null || liveStaleAskedUnder === generation) return;
		liveStaleAskedUnder = generation;
		untrack(() => reloadLiveRoots());
	});

	$effect(() => {
		const revision = roots.retirementRevision;
		const reason = roots.retirementReason;
		if (revision === handledLibraryRetirementRevision) return;
		handledLibraryRetirementRevision = revision;
		// Other browsers may initiate Refresh/count replacement. The roots store
		// waits only for requests this browser actually owns before recovering.
		if (
			!resumed ||
			(reason !== 'session-lost' && reason !== 'refresh' && reason !== 'count-mismatch')
		) return;
		const activeClaim = untrack(() => claim);
		if (activeClaim === null) return;
		untrack(() => void loadForClaim(activeClaim, revision));
	});

	// ---- Drills (plan §4 slice 5) -------------------------------------
	// Targets are semantic (artist localId or genre/composer label) per
	// UnifiedLibrarySnapshot; itemKeys are session-scoped and resolved
	// live. Album drills open the slice-6 sheet; inert until then.

	/**
	 * What to tell the reader when a collection card could not be opened.
	 *
	 * Two stages, and they are different news. Stage one is the collection
	 * itself: the library no longer carries that genre or composer, or now
	 * carries two rows reading the same name. Stage two is the album inside
	 * it: it left the collection, or it is one of two rows that read exactly
	 * alike — and re-drilling would return the same two, so there is no tie to
	 * break. `null` when the failure was not a locator refusal at all, which
	 * leaves the page's ordinary error prose to speak.
	 *
	 * An artist's discography is one of these drills too, and the reader of an
	 * artist page is not looking at anything they would call a collection. Same
	 * two stages, same two outcomes, said in the words of the surface the reader
	 * is actually on — and worded to match the stored-card message above, since
	 * the two can appear on the same page about the same click.
	 */
	function collectionOpenMessage(
		failure: CollectionDrillOpenFailureDetail | null,
		hierarchy: CollectionDrillHierarchy | null
	): string | null {
		if (failure === null) return null;
		if (hierarchy === 'artists') {
			if (failure.stage === 'collection') {
				return failure.kind === 'missing'
					? 'This artist is no longer in the library, so this album could not be opened.'
					: 'The library now has more than one artist with this name, so this album could not be opened.';
			}
			return failure.kind === 'missing'
				? 'This album is no longer one of this artist’s albums.'
				: 'This artist has more than one album that reads exactly the same, so this one could not be opened.';
		}
		if (failure.stage === 'collection') {
			return failure.kind === 'missing'
				? 'The library no longer carries this collection, so this album could not be opened.'
				: 'The library now carries more than one collection with this name, so this album could not be opened.';
		}
		return failure.kind === 'missing'
			? 'This album is no longer in this collection.'
			: 'This collection carries more than one album that reads exactly the same, so this one could not be opened.';
	}
	const collectionOpenFailureMessage = $derived(
		collectionOpenMessage(
			sheetState.collectionFailure ?? null,
			itemTarget?.kind === 'collection' ? itemTarget.locator.hierarchy : null
		)
	);

	/**
	 * Back from an item page returns to its invoking context: the palette's
	 * search results, the collection drill, or the owning scope (§4.2).
	 */
	const itemBackLabel = $derived.by(() => {
		if (returnToPalette) return 'Search results';
		// An album opened from its artist's page names the artist, since
		// that is the actual back target — not the current scope or
		// collection drill (issue #6).
		if (itemOriginName !== null) return itemOriginName;
		return ALL_SCOPE_CHIPS.find((chip) => chip.id === scope)?.label ?? 'Library';
	});

	/**
	 * Revision-gated auxiliary loads must not overlap (cr-2). They share the
	 * catalog revision and the server compares it with strict equality, so two
	 * in flight at once means the loser is rejected with a revision conflict
	 * even though nothing is wrong with its request.
	 */
	let hydrationChain: Promise<unknown> = Promise.resolve();
	function queueHydration<T>(task: () => Promise<T>): Promise<T> {
		const settled = hydrationChain.then(task, task);
		hydrationChain = settled.then(
			() => undefined,
			() => undefined
		);
		return settled;
	}

	/**
	 * Opens one live drill card, through the drill it came from.
	 *
	 * The card has no catalog identity and none is minted here. What it has is
	 * its own rendering in this drill, and the locator carries exactly that
	 * plus the collection it was rendered in — enough for the server to walk
	 * the same path again and find the same row, unique or nothing.
	 *
	 * Readiness is settled BEFORE anything is mutated: a drill that has not
	 * loaded, a row that carries no usable rendering, or a rendering that
	 * repeats inside this same drill all return here, with no page opened and
	 * no state touched. (The repeated case is already marked non-openable on
	 * the card, so a click cannot normally reach it; the check stands because
	 * this function must be right for the arguments it is handed.)
	 */

	function setPaneScrollTop(top: number): void {
		if (!pane) return;
		// The pane sets `scroll-behavior: smooth`; a restore must be instant or
		// it animates from wherever the rebuild left it.
		pane.style.scrollBehavior = 'auto';
		pane.scrollTop = top;
		pane.style.removeProperty('scroll-behavior');
	}

	/**
	 * Drive the pane to `top`, and keep driving it until the content is
	 * actually tall enough to get there.
	 *
	 * `scrollTop` is clamped to the container's CURRENT `scrollHeight`, and a
	 * history-pop rebuilds this surface from an empty index (`+page.svelte`
	 * commits `history-pop` as suspend→resume, which calls `resetIndex()`).
	 * A single post-`tick()` assignment therefore lands against a nearly empty
	 * pane and silently collapses to the top — which is exactly what "it
	 * reloads and I lose my place" looks like. Retrying across frames lets the
	 * restore land once the list is back, and stops as soon as it does.
	 */
	function restorePaneScrollTop(top: number): void {
		if (top <= 0) {
			void tick().then(() => setPaneScrollTop(0));
			return;
		}
		paneScrollRestoreToken += 1;
		const token = paneScrollRestoreToken;
		let framesLeft = PANE_SCROLL_RESTORE_FRAMES;
		const attempt = (): void => {
			// A newer restore, a teardown, or a user scroll supersedes this one.
			if (token !== paneScrollRestoreToken || !pane) return;
			setPaneScrollTop(top);
			framesLeft -= 1;
			if (pane.scrollTop >= top || framesLeft <= 0) return;
			requestAnimationFrame(attempt);
		};
		void tick().then(attempt);
	}

	function resetPaneAfterRender(): void {
		// Token-guarded like a restore, so a restore issued after this one
		// wins rather than being clobbered by a late zero.
		paneScrollRestoreToken += 1;
		const token = paneScrollRestoreToken;
		void tick().then(() => {
			if (token !== paneScrollRestoreToken) return;
			setPaneScrollTop(0);
		});
	}

	function unifiedSemanticState(density: UnifiedLibraryDensity = prefs.density) {
		const trackTitle =
			editorialTrackIndex === null
				? null
				: (get(albumController).orderedTracks[editorialTrackIndex]?.title ?? null);
		return buildUnifiedLibraryPageState({
			scope,
			collectionDrill: null,
			itemTarget,
			// The exact-track child is reconstructible product semantics
			// (album localId + zero-based index, Slice 8); opaque follow
			// destinations are deliberately never persisted.
			itemDetail:
				(itemTarget?.kind === 'collection' ||
					(itemTarget?.kind === 'live' && livePageKind === 'album')) &&
				trackTitle !== null
					? { kind: 'track', title: trackTitle }
					: null,
			// The composition surface persists by composer context + exact
			// title intent (Slice 8); live browse keys never persist, and
			// nested recording pages restore to their top composition.
			composition: null,
			// The artist-origin label for an open album page (issue #6):
			// persisted so the back button keeps naming the artist after
			// reload/popstate restore instead of falling back to the scope.
			itemOriginName: itemTarget?.kind === 'collection' ? itemOriginName : null,
			filterText,
			surpriseSeed: scope === 'surprise' ? shuffleSeed : null,
			density,
			browseHistory: browseState.snapshot
		});
	}

	function itemDestinationPageState(target: UnifiedItemTarget): UnifiedLibraryPageState {
		return buildUnifiedLibraryPageState({
			...unifiedSemanticState().snapshot,
			itemTarget: target,
			itemDetail: null
		});
	}


	function routeAlbum(entry: LibraryAlbumEntry): LibraryRouteAlbum {
		return { title: entry.title, credit: entry.artist, edition: '' };
	}

	function hrefForArtist(entry: LibraryArtistEntry): string {
		return encodeLibraryRoute({ kind: 'artist', artist: entry.name });
	}

	function hrefForDrill(target: UnifiedLibraryDrillTarget): string {
		return target.kind === 'genre'
			? encodeLibraryRoute({ kind: 'genre', genre: target.label })
			: encodeLibraryRoute({ kind: 'composer', composer: target.label });
	}

	function livePathForDrill(target: UnifiedLibraryDrillTarget): LibraryRenderingPath {
		return target.kind === 'genre'
			? { origin: 'genres', steps: [{ kind: 'genre', title: target.label }] }
			: { origin: 'composers', steps: [{ kind: 'composer', title: target.label }] };
	}

	function hrefForAlbum(entry: LibraryAlbumEntry): string | null {
		const album = routeAlbum(entry);
		const livePath = liveAlbumChildPath(entry);
		if (livePath !== null) {
			const route = libraryRouteFromPageState(
				itemDestinationPageState({ kind: 'live', path: livePath })
			);
			return route === null ? null : encodeLibraryRoute(route);
		}
		return encodeLibraryRoute({ kind: 'album', album });
	}

	function liveAlbumChildPath(entry: LibraryAlbumEntry): LibraryRenderingPath | null {
		if (
			itemTarget?.kind !== 'live' ||
			livePageKind === 'album' ||
			livePageKind === 'track'
		) {
			return null;
		}
		return {
			origin: itemTarget.path.origin,
			steps: [...itemTarget.path.steps, libraryAlbumStep(entry.title, entry.artist)]
		};
	}

	function followAddress(event: MouseEvent, open: () => void): void {
		if (!shouldHandleLibraryAnchorClick(event)) return;
		event.preventDefault();
		open();
	}

	function routeBrowseStep(breadcrumb: BrowseBreadcrumb): LibraryRouteBrowseStep {
		return {
			title: breadcrumb.title,
			...(breadcrumb.subtitle === undefined ? {} : { subtitle: breadcrumb.subtitle }),
			...(breadcrumb.itemType === undefined ? {} : { itemType: breadcrumb.itemType }),
			...(breadcrumb.searchCategory === true ? { searchCategory: true as const } : {})
		};
	}

	function hrefForBrowseItem(item: BrowseItem): string | null {
		if (item.inputPrompt || browseItemOpensActions(item)) return null;
		const breadcrumb = browseBreadcrumbFor(item);
		if (breadcrumb === undefined) return null;
		return encodeLibraryRoute({
			kind: 'browse',
			steps: [
				...browseState.snapshot.history.map((step) => routeBrowseStep(step.breadcrumb)),
				routeBrowseStep(breadcrumb)
			],
			search:
				browseState.snapshot.context.hierarchy === 'search'
					? browseState.snapshot.context.query
					: null
		});
	}

	function routeWithTrack(route: LibraryRoute, track: string | undefined): LibraryRoute {
		if (track === undefined) return route;
		switch (route.kind) {
			case 'artist-album':
				return { ...route, kind: 'artist-album-track', track };
			case 'artist-album-track':
				return { ...route, track };
			case 'album':
				return { ...route, kind: 'album-track', track };
			case 'album-track':
				return { ...route, track };
			case 'genre-album':
				return { ...route, kind: 'genre-album-track', track };
			case 'genre-album-track':
				return { ...route, track };
			case 'live-path':
				return {
					...route,
					path: {
						...route.path,
						steps: [...route.path.steps, { kind: 'track', title: track }]
					}
				};
			default:
				return route;
		}
	}

	function hrefForTrack(track: string): string | null {
		const route = durableRouteForState(unifiedSemanticState());
		return route === undefined ? null : encodeLibraryRoute(routeWithTrack(route, track));
	}

	/**
	 * Transitional catalog pages already have all renderings on screen. Turn
	 * those into the live route they will restore through; never serialize the
	 * controller id that happened to feed the current render.
	 */
	function durableRouteForState(state: UnifiedLibraryPageState): LibraryRoute | undefined {
		return libraryRouteFromPageState(state) ?? undefined;
	}

	function pushLibraryPageState(
		state: UnifiedLibraryPageState,
		routeOverride?: LibraryRoute
	): LibraryPageStateWriteResult {
		return pushLibraryRoute(state, routeOverride ?? durableRouteForState(state));
	}

	function replaceLibraryPageState(state: UnifiedLibraryPageState): LibraryPageStateWriteResult {
		return replaceLibraryRoute(state, durableRouteForState(state));
	}

	function preflightLibraryPageState(
		state: UnifiedLibraryPageState,
		routeOverride?: LibraryRoute
	): boolean {
		return preflightLibraryRoute(state, routeOverride ?? durableRouteForState(state)) !== null;
	}

	function entryRelationshipAfterWrite(
		result: LibraryPageStateWriteResult | null,
		previous: EntryRelationship,
		restoredEntry: boolean
	): EntryRelationship {
		if (restoredEntry) return 'restored';
		if (result === 'pushed') return 'owned';
		if (result === 'deduped') return previous;
		return 'transient';
	}

	function expectSelfAuthoredLibraryPageState(state: UnifiedLibraryPageState): void {
		expectLibraryRoute(state, durableRouteForState(state));
	}

	/** Returns whether a new entry was actually pushed (dedupe may skip). */
	function pushUnifiedSemanticState(density?: UnifiedLibraryDensity): boolean {
		return pushLibraryPageState(unifiedSemanticState(density)) === 'pushed';
	}

	/**
	 * Routes every durable destination through its page owner. Genre and
	 * composer rows use the same live path on click that their URLs restore.
	 * Scope views and the palette still speak the historical target union.
	 */
	async function openDrill(
		target: UnifiedItemTarget | UnifiedLibraryDrillTarget,
		recordHistory = true,
		albumOptions?: {
			readonly songFocusTitle?: string;
			readonly route?: LibraryRoute;
		}
	): Promise<void> {
		// Palette-owned views are nested search views, not semantic history
		// entries; every descendant they navigate to inherits that (ri1-2) —
		// otherwise the palette-return close leaves a phantom entry behind.
		const record = recordHistory && !returnToPalette;
		if (target.kind === 'collection' || target.kind === 'live') {
			await openItemPage(target, record, albumOptions);
			return;
		}
		const path = livePathForDrill(target);
		await openItemPage(
			{ kind: 'live', path },
			record,
			albumOptions,
			{ path, title: target.label }
		);
	}

	/** Each item transition pushes exactly one history entry (§4.2). */
	async function openItemPage(
		target: UnifiedItemTarget,
		recordHistory = true,
		albumOptions?: {
			readonly songFocusTitle?: string;
			readonly route?: LibraryRoute;
		},
		/**
		 * What the reader's own click carried, for a live target: the row's
		 * reference and Roon's own text for it. Absent on a restore, which is
		 * exactly when the address has to do the work alone.
		 */
		liveOpen?: LiveLibraryPageOpenInput,
		restoredEntry = false
	): Promise<void> {
		const candidateState = itemDestinationPageState(target);
		if (!preflightLibraryPageState(candidateState, albumOptions?.route)) return;
		const previousEntryRelationship = itemEntryRelationship;
		railTarget = null;
		trackChildOwnsEntry = false;
		// Captured for every open: an in-place close (no history entry)
		// returns focus to the invoking row/tile when it is still mounted.
		itemInvoker =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (itemTarget === null) itemReturnScrollTop = pane?.scrollTop ?? 0;
		drillNotice = null;
		// An album opened from its artist's page names that artist for the
		// back button (issue #6); every other transition — including a
		// fresh artist open — clears a stale name so it never mislabels an
		// unrelated page. Restoration repopulates this separately (below,
		// in resumeUnified) since itemTarget is null at that call site.
		// A live album opened from a live artist's page names that artist for
		// the back button, from the heading Roon gave it.
		itemOriginName =
			target.kind === 'live' &&
			(target.path.steps[target.path.steps.length - 1]?.kind ?? '') === 'album' &&
			itemTarget?.kind === 'live' &&
			livePageKind === 'artist'
				? (liveArtist?.name ?? null)
				: null;
		if (target.kind === 'live') {
			legacyItemRoute = null;
			albumSongFocusTitle = null;
			// This open IS the attempt under the snapshot the reader holds, so a
			// refusal it produces is an answer, not something to retry against the
			// same rows.
			livePageResolvedUnder = untrack(() => roots.generation);
			itemTarget = target;
			// The live page is its own reader; the item-page controller still
			// owns retirement of whatever it displaced.
			itemPageController.open(target);
			const writeResult = recordHistory ? pushLibraryPageState(unifiedSemanticState()) : null;
			itemEntryRelationship = entryRelationshipAfterWrite(
				writeResult,
				previousEntryRelationship,
				restoredEntry
			);
			resetPaneAfterRender();
			livePageController.open(liveOpen ?? { path: target.path });
			return;
		}
		legacyItemRoute = null;
		albumSongFocusTitle = albumOptions?.songFocusTitle ?? null;
		itemTarget = target;
		const pageGeneration = itemPageController.open(target);
		clearTrackChildAnchor();
		const writeResult = recordHistory
			? pushLibraryPageState(unifiedSemanticState(), albumOptions?.route)
			: null;
		itemEntryRelationship = entryRelationshipAfterWrite(
			writeResult,
			previousEntryRelationship,
			restoredEntry
		);
		resetPaneAfterRender();
		await openAlbumRead({ kind: 'collection', locator: target.locator }, pageGeneration);
	}

	/**
	 * The exact-track child anchor (Slice 5), retained so the page-chain
	 * entry and the address both name the track the reader asked for.
	 */
	let editorialTrackIndex: number | null = null;

	/**
	 * A restored exact-track title, consumed once the album's current track
	 * order arrives; cleared by every fresh anchor open.
	 */
	let restoredTrackInfoTitle = $state<string | null>(null);

	/** Clears the exact-track anchor whenever a fresh item page opens. */
	function clearTrackChildAnchor(): void {
		editorialTrackIndex = null;
		restoredTrackInfoTitle = null;
	}

	/** Opens the exact-track child of the album page (Slice 5). */
	function openEditorialTrack(trackPosition: number): void {
		const target = itemTarget;
		const current = itemPageController.current;
		if (
			(target?.kind !== 'collection' && target?.kind !== 'live') ||
			current.target === null
		) {
			return;
		}
		// A consume of the restored child re-lands on the SAME history
		// entry (Slice 8): it must not push a duplicate chain step.
		const trackTitle = get(albumController).orderedTracks[trackPosition]?.title ?? null;
		const restoredConsume = trackTitle !== null && restoredTrackInfoTitle === trackTitle;
		restoredTrackInfoTitle = null;
		editorialTrackIndex = trackPosition;
		// The exact-track child is a page-chain step (Slice 8): one
		// semantic entry per transition, restored by album + title. A
		// transient parent (palette-opened, ri1-2) owns no semantic entry,
		// so its children must not create one either (ri8-1). A restored
		// child re-landed on an entry whose neighbours are unknown, so it
		// never claims live-pushed ownership. A RETRY of the same child
		// dedupes the push against the child's own entry — claimed
		// ownership survives that (ri8-1 reopen).
		const pushed =
			!restoredConsume &&
			itemEntryRelationship !== 'transient' &&
			pushUnifiedSemanticState();
		trackChildOwnsEntry = pushed || (trackChildOwnsEntry && !restoredConsume);
	}


	/** Composition surface state (plan Slice 6). */
	/** Leaves the exact-track child and returns to the album's own view. */
	function closeTrackChild(): void {
		const currentState = unifiedSemanticState();
		editorialTrackIndex = null;
		restoredTrackInfoTitle = null;
		// The closed child must stop being the restore target (Slice 8).
		// A live-pushed child traverses back to the parent entry — the
		// close stays synchronous and the expected-state mark absorbs
		// the pop without a teardown restore (ri8-1). A restored child
		// rewrites its entry instead (its neighbours are unknown), and
		// a transient parent owns no entry to touch.
		if (trackChildOwnsEntry) {
			trackChildOwnsEntry = false;
			expectSelfAuthoredLibraryPageState(unifiedSemanticState());
			window.history.back();
		} else if (itemEntryRelationship === 'restored') {
			const parent = libraryParentPageState(currentState);
			if (parent !== null) replaceLibraryPageState(parent);
		}
	}

	/** Cancels the live page's read and action authority. */
	function retireItemPageAuthority(): void {
		albumController.cancel();
		albumController.reset();
		sheetActionController.cancel();
		sheetActionGesture += 1;
		sheetActionAttempt = null;
		retrySheetActionIntent = null;
		sheetActionRetryAvailable = false;
		albumReadSession = null;
	}

	/**
	 * Closes the item page in place. Focus returns to the invoking
	 * row/tile when it is still present, otherwise to the pane heading
	 * (§4.3).
	 */
	function resetItemPage(restoreFocus = true): void {
		if (itemTarget === null && itemInvoker === null) return;
		// The controller's retirement hook cancels read/action authority.
		itemPageController.close();
		// A closed live page stops reading: its fence moves, so a level still
		// in flight lands nowhere rather than over whatever opens next.
		livePageController.reset();
		albumSongFocusTitle = null;
		itemTarget = null;
		legacyItemRoute = null;
		itemOriginName = null;
		itemEntryRelationship = 'transient';
		trackChildOwnsEntry = false;
		const invoker = itemInvoker;
		itemInvoker = null;
		const returnScrollTop = itemReturnScrollTop;
		itemReturnScrollTop = 0;
		// In-place closes restore the return context here; pop-backed closes
		// park it instead (backFromItem) and the resume applies it, so this
		// restore must not mask a broken pop path (ri1-4).
		if (!restoreFocus) return;
		restorePaneScrollTop(returnScrollTop);
		void tick().then(() => {
			if (invoker?.isConnected) {
				invoker.focus();
				return;
			}
			pane?.querySelector<HTMLElement>('.ctx h2')?.focus?.();
		});
	}

	/** Resets both navigation layers (scope switches, suspend). */
	function resetDrill(): void {
		const resetPane = itemTarget === null;
		resetItemPage(false);
		if (resetPane) resetPaneAfterRender();
	}

	function replaceRestoredItemWithParent(): boolean {
		const parent = libraryParentPageState(unifiedSemanticState());
		if (parent === null || replaceLibraryPageState(parent) === 'refused') return false;
		const parentTarget = parent.snapshot.itemTarget;
		if (parentTarget !== null) {
			void openItemPage(parentTarget, false, undefined, undefined, true);
			itemOriginName = parent.snapshot.itemOriginName;
		} else {
			resetItemPage(true);
		}
		return true;
	}

	function backFromItem(): void {
		const shouldReturnToPalette = returnToPalette;
		if (shouldReturnToPalette) {
			resetItemPage(false);
			returnToPalette = false;
			selectedSong = null;
			resetSongRelationship();
			paletteOpen = true;
			return;
		}
		if (itemEntryRelationship === 'owned') {
			pendingPopReturnScrollTop = itemReturnScrollTop;
			resetItemPage(false);
			window.history.back();
			return;
		}
		if (itemEntryRelationship === 'restored' && replaceRestoredItemWithParent()) return;
		resetItemPage(true);
	}

	async function openAlbumRead(
		target: LibraryAlbumOpenTarget,
		pageGeneration: number
	): Promise<void> {
		const activeClaim = claim;
		if (!activeClaim) return;
		const generation = lifecycleGeneration;
		// The item-page generation fences every continuation below: a page
		// that was closed or replaced while an await was pending must not
		// reopen its read over the newer page (ri1-1).
		const pageIsCurrent = (): boolean =>
			generation === lifecycleGeneration &&
			itemPageController.isCurrent(pageGeneration);
		let ref;
		try {
			ref = await activeClaim.ready;
		} catch {
			if (pageIsCurrent()) {
				resetItemPage(false);
				drillNotice = 'The library session is unavailable.';
			}
			return;
		}
		if (!pageIsCurrent()) return;
		let tabId: string;
		try {
			tabId = getTabId();
		} catch {
			resetItemPage(false);
			drillNotice = 'Secure library identity is unavailable.';
			return;
		}
		albumReadSession = ref;
		albumController.open({ target, tabId, generation: ref.generation });
	}

	function retryAlbumPage(): void {
		// A live page's retry is a re-resolution of its address, not a reopen
		// of a reference that has already been refused.
		if (itemTarget?.kind === 'live') {
			livePageController.retry();
			return;
		}
		if (itemTarget?.kind !== 'collection') return;
		const activeClaim = claim;
		if (!activeClaim) return;
		const retired = albumReadSession;
		if (retired === null) return;
		// The failed read records the exact Classic handle it used. Retire only
		// that handle: another surface may already have acquired its replacement.
		sessionClient.invalidate(activeClaim, retired);
		albumController.reset();
		void openAlbumRead(
			{ kind: 'collection', locator: itemTarget.locator },
			itemPageController.current.generation
		);
	}

	function sameLibraryRef(
		left: LibraryRowReference | null | undefined,
		right: LibraryRowReference | null | undefined
	): boolean {
		return (
			left !== null &&
			left !== undefined &&
			right !== null &&
			right !== undefined &&
			left.generation === right.generation &&
			left.token === right.token
		);
	}

	function isSheetActionIntentCurrent(intent: SheetActionIntent): boolean {
		if (
			!resumed ||
			claim !== intent.claim ||
			lifecycleGeneration !== intent.lifecycle ||
			!sessionClient.isClaimCurrent(intent.claim) ||
			!itemPageController.isCurrent(intent.itemPageGeneration) ||
			actionZoneId !== intent.zoneId
		) {
			return false;
		}
		if (intent.kind === 'page') {
			return (
				itemTarget?.kind === 'collection' &&
				sheetState.operationId === intent.pageId &&
				sheetState.selectedVersionId === intent.versionId &&
				(intent.track === null
					? sheetState.albumActionsAvailable
					: sheetState.actionsAvailable)
			);
		}
		if (intent.referenceSource === 'live-collection') {
			return (
				itemTarget?.kind === 'live' &&
				livePage.phase === 'ready' &&
				sameLibraryRef(livePage.target?.ref, intent.ref)
			);
		}
		const live = sheetState.live;
		const currentRef =
			intent.trackIndex === null
				? live?.playRef
				: live?.trackRefs[intent.trackIndex ?? -1];
		return (
			itemTarget?.kind === 'live' &&
			live !== null &&
			sameLibraryRef(currentRef, intent.ref) &&
			(intent.trackIndex === null
				? sheetState.albumActionsAvailable
				: sheetState.actionsAvailable)
		);
	}

	function actionInput(
		intent: SheetActionIntent,
		session: ClassicBrowseSessionRef
	): AlbumActionBeginInput | null {
		const common = {
			zoneId: intent.zoneId,
			tabId: intent.tabId,
			generation: session.generation,
			...(intent.desiredSemantic === null
				? {}
				: { desiredSemantic: intent.desiredSemantic })
		};
		if (intent.kind === 'reference') {
			return intent.ref === undefined ? null : { ...common, ref: intent.ref };
		}
		if (intent.pageId === undefined || intent.versionId === undefined) return null;
		return {
			...common,
			pageId: intent.pageId,
			versionId: intent.versionId,
			...(intent.track === null || intent.track === undefined ? {} : { track: intent.track })
		};
	}

	async function issueSheetAction(
		intent: SheetActionIntent,
		gesture: number,
		automaticReissueSpent: boolean
	): Promise<void> {
		let session: ClassicBrowseSessionRef;
		try {
			session = await intent.claim.ready;
		} catch {
			if (gesture === sheetActionGesture && automaticReissueSpent) {
				retrySheetActionIntent = intent;
				sheetActionRetryAvailable = true;
			}
			return;
		}
		if (gesture !== sheetActionGesture || !isSheetActionIntentCurrent(intent)) return;
		const input = actionInput(intent, session);
		if (input === null) return;
		const result = sheetActionController.begin(input);
		if (!result?.started) return;
		sheetActionAttempt = {
			intent,
			gesture,
			session,
			requestId: result.requestId,
			automaticReissueSpent,
			reissueInFlight: false
		};
	}

	function startSheetAction(intent: SheetActionIntent): void {
		sheetActionGesture += 1;
		sheetActionAttempt = null;
		retrySheetActionIntent = null;
		sheetActionRetryAvailable = false;
		void issueSheetAction(intent, sheetActionGesture, false);
	}

	async function reissueSheetAction(attempt: SheetActionAttempt): Promise<void> {
		sessionClient.invalidate(attempt.intent.claim, attempt.session);
		await issueSheetAction(attempt.intent, attempt.gesture, true);
	}

	function retryFailedSheetAction(): void {
		const intent = retrySheetActionIntent;
		if (intent === null || !isSheetActionIntentCurrent(intent)) {
			retrySheetActionIntent = null;
			sheetActionRetryAvailable = false;
			return;
		}
		startSheetAction(intent);
	}

	$effect(() => {
		const state = sheetActionState;
		const attempt = sheetActionAttempt;
		if (attempt === null || state.requestId !== attempt.requestId) return;
		if (state.phase === 'failed') {
			if (
				state.code !== 'SESSION_LOST' ||
				state.executionAttempted ||
				!isSheetActionIntentCurrent(attempt.intent)
			) {
				sheetActionAttempt = null;
				return;
			}
			if (!attempt.automaticReissueSpent && !attempt.reissueInFlight) {
				attempt.automaticReissueSpent = true;
				attempt.reissueInFlight = true;
				void reissueSheetAction(attempt);
				return;
			}
			if (!attempt.reissueInFlight) {
				sessionClient.invalidate(attempt.intent.claim, attempt.session);
				retrySheetActionIntent = attempt.intent;
				sheetActionRetryAvailable = true;
				sheetActionAttempt = null;
			}
			return;
		}
		if (
			state.phase === 'executed' ||
			state.phase === 'canceled' ||
			state.phase === 'outcome-unknown'
		) {
			sheetActionAttempt = null;
			retrySheetActionIntent = null;
			sheetActionRetryAvailable = false;
		}
	});

	function referenceIntent(
		ref: LibraryRowReference,
		zoneId: string,
		desiredSemantic: AlbumActionSemantic | null,
		referenceSource: 'album' | 'live-collection',
		trackIndex: number | null
	): SheetActionIntent | null {
		const activeClaim = claim;
		if (activeClaim === null) return null;
		let tabId: string;
		try {
			tabId = getTabId();
		} catch {
			return null;
		}
		return Object.freeze({
			kind: 'reference',
			claim: activeClaim,
			lifecycle: lifecycleGeneration,
			itemPageGeneration: itemPageController.current.generation,
			zoneId,
			tabId,
			desiredSemantic,
			ref: Object.freeze({ ...ref }),
			referenceSource,
			trackIndex
		});
	}

	function beginSheetAction(
		track: { index: number; title: string } | null,
		zoneId: string,
		desiredSemantic: AlbumActionSemantic
	): void {
		const live = sheetState.live;
		if (itemTarget?.kind === 'live' && live !== null) {
			const ref = track === null ? live.playRef : (live.trackRefs[track.index] ?? null);
			if (ref === null) return;
			if (track === null ? !sheetState.albumActionsAvailable : !sheetState.actionsAvailable) return;
			const intent = referenceIntent(ref, zoneId, desiredSemantic, 'album', track?.index ?? null);
			if (intent !== null) startSheetAction(intent);
			return;
		}
		if (
			itemTarget?.kind !== 'collection' ||
			!sheetState.operationId ||
			!sheetState.selectedVersionId ||
			(track === null ? !sheetState.albumActionsAvailable : !sheetState.actionsAvailable)
		) {
			return;
		}
		const activeClaim = claim;
		if (activeClaim === null) return;
		let tabId: string;
		try {
			tabId = getTabId();
		} catch {
			return;
		}
		startSheetAction(
			Object.freeze({
				kind: 'page',
				claim: activeClaim,
				lifecycle: lifecycleGeneration,
				itemPageGeneration: itemPageController.current.generation,
				zoneId,
				tabId,
				desiredSemantic,
				pageId: sheetState.operationId,
				versionId: sheetState.selectedVersionId,
				track: track === null ? null : Object.freeze({ ...track })
			})
		);
	}

	function beginLiveCollectionActions(): void {
		const ref = livePage.target?.ref;
		if (itemTarget?.kind !== 'live' || ref === undefined || actionZoneId === null) return;
		const intent = referenceIntent(ref, actionZoneId, null, 'live-collection', null);
		if (intent !== null) startSheetAction(intent);
	}

	function maybeLoadScopeData(next: UnifiedLibraryScope): void {
		// Genres page on the classic-explore role and needs the claim;
		// recently played is a plain REST fetch. All are
		// idempotent.
		if (next === 'genres' && claim) {
			const genres = $genresStore;
			if (!genres.loaded && !genres.loading) void genresStore.load(claim);
		} else if (next === 'recently-played') {
			const recent = $recentStore;
			if (!recent.loaded && !recent.loading) void loadRecent(fetchFn);
		} else if (next === 'favorites') {
			const current = $favoritesDataStore;
			if (!current.loaded && !current.loading) void loadFavoritesData(fetchFn);
		}
	}

	function setScope(next: UnifiedLibraryScope): void {
		browseActionController.reset();
		browseActionFromPalette = false;
		browseFavoriteStatus = null;
		favoritesStatus = null;
		if (next === 'surprise' || (next === 'albums' && prefs.sorts.albums === 'shuffle')) {
			shuffleSeed += 1;
		}
		if (returnToPalette) {
			returnToPalette = false;
			paletteQuery = '';
			paletteSelectedRowId = null;
			selectedSong = null;
			resetSongRelationship();
			startPaletteAuthorityRetirement();
		}
		// Remember where this scope was before leaving it, so coming back is a
		// return rather than a restart.
		//
		// With an item page open the live pane shows that page, not the list, so
		// the position worth keeping is the one captured when the user drilled
		// in. The scope chips also scroll away with the content (they are inside
		// the pane and not sticky), which means a switch made from the list
		// itself is necessarily made from the top — honestly nothing to restore.
		if (!filterText) {
			const leavingTop = itemTarget !== null ? itemReturnScrollTop : (pane?.scrollTop ?? 0);
			scopeScrollTops.set(scope, leavingTop);
		}
		const restoreTop = scopeScrollTops.get(next) ?? 0;
		scope = next;
		railTarget = null;
		filterText = '';
		resetDrill();
		// Opening a live scope re-reads its root: the plan's scope-activation
		// trigger (`.agents/plans/library-live-view.md`, refresh contract). It is
		// the cheap confirm when nothing moved, and it is how a reader who came
		// back to the list sees a record added since they last looked. The mode's
		// own activation is not this — that read is `loadForClaim`'s.
		if ((next === 'artists' || next === 'albums') && claim) reloadLiveRoots();
		maybeLoadScopeData(next);
		restorePaneScrollTop(restoreTop);
		if (next === 'browse') {
			const activeClaim = claim;
			if (!activeClaim) return;
			void browseController.restore(activeClaim, browseState.snapshot, sheetZones[0]?.zoneId).then(
				(restored) => {
					if (restored && claim === activeClaim && scope === 'browse') {
						pushUnifiedSemanticState();
					}
				}
			);
			return;
		}
		pushUnifiedSemanticState();
	}

	function activateFavorite(favorite: FavoriteEntry): void {
		openPalette(favorite.title);
	}

	async function removeFavoriteEntry(favorite: FavoriteEntry): Promise<void> {
		if (favoriteMutationBusy) return;
		favoriteMutationBusy = true;
		favoritesStatus = null;
		try {
			await removeFavoriteData(fetchFn, favorite.id);
			favoritesStatus = `Removed “${favorite.title}” from favorites.`;
		} catch (error) {
			favoritesStatus =
				error instanceof Error ? error.message : 'Could not remove this favorite.';
		} finally {
			favoriteMutationBusy = false;
		}
	}

	// ---- Palette + smart-filter pages (plan §3.2 slice 7) -------------

	function resetSongRelationship(): void {
		relationshipFence += 1;
		songRelationship = {
			phase: 'idle',
			resultId: null,
			relationship: null,
			error: null
		};
	}

	function loadSongRelationship(song: PaletteSearchRow): void {
		const activeClaim = claim;
		relationshipFence += 1;
		const token = relationshipFence;
		songRelationship = {
			phase: 'loading',
			resultId: song.resultId,
			relationship: null,
			error: null
		};
		if (!activeClaim) {
			songRelationship = {
				phase: 'unavailable',
				resultId: song.resultId,
				relationship: null,
				error: 'Song relationships are unavailable.'
			};
			return;
		}
		void songRelationshipClient
			.relationship(activeClaim, song.resultId)
			.then((relationship) => {
				if (
					token !== relationshipFence ||
					selectedSong?.resultId !== song.resultId
				) {
					return;
				}
				songRelationship = {
					phase: 'ready',
					resultId: song.resultId,
					relationship,
					error: null
				};
			})
			.catch((error) => {
				if (
					token !== relationshipFence ||
					selectedSong?.resultId !== song.resultId
				) {
					return;
				}
				songRelationship = {
					phase: 'unavailable',
					resultId: song.resultId,
					relationship: null,
					error:
						error instanceof Error
							? error.message
							: 'Song relationships are unavailable.'
				};
			});
	}

	function openPalette(seedText = ''): void {
		if (!resumed) return;
		browseActionController.reset();
		browseActionFromPalette = false;
		browseFavoriteStatus = null;
		classicSearchOwnerGeneration += 1;
		paletteQuery = seedText;
		paletteSelectedRowId = null;
		selectedSong = null;
		resetSongRelationship();
		returnToPalette = false;
		// The app-wide Space shortcut asks `hasOpenModalSurface()` before
		// toggling playback, but the palette's aria-modal dialog only reaches
		// the DOM on the next flush. Typing "a" and hitting Space in that same
		// turn must already belong to the palette, not play/pause — hold a
		// synchronous claim across the render gap (public issue #2 follow-up).
		// Release on both outcomes: if the flush rejects, an unreleased claim
		// would leave hasOpenModalSurface() stuck true and the Space shortcut
		// dead until reload. releaseSurfaceClaim() is idempotent.
		const releaseSurfaceClaim = claimModalSurface();
		void tick().then(releaseSurfaceClaim, releaseSurfaceClaim);
		paletteOpen = true;
		// Named indexes load lazily; kick both so genre and composer
		// results can answer without sharing the live song-search session.
		if (claim) {
			const genres = $genresStore;
			if (!genres.loaded && !genres.loading) void genresStore.load(claim);
			const composers = $composersStore;
			if (!composers.loaded && !composers.loading) void composersStore.load(claim);
		}
	}

	/**
	 * Resolves an artist/album entity intent (issue #10: play-bar and
	 * NowPlayingOverlay name clicks) against Roon's own two roots, ahead of
	 * the palette-search fallback.
	 *
	 * It used to match against the saved catalog index and open the record it
	 * found by local id. It matches the live rows now and opens the row's own
	 * reference — the same row the reader would have clicked in the list.
	 *
	 * ONE MATCH OR NONE. Roon's now-playing strings do not always equal
	 * library names (joined artist lists, remasters), so no match, an
	 * ambiguous match, or roots that are not yet `ready` all return null and
	 * the caller falls back to `openPalette` unchanged. Two rows reading alike
	 * are two rows: picking one of them would be a guess.
	 */
	function resolveEntityIntent(intent: LibraryIntent): (() => void) | null {
		if (roots.phase !== 'ready') return null;
		if (intent.kind === 'artist') {
			const key = librarySortKey(intent.query);
			const matches = roots.artists.filter((entry) => librarySortKey(entry.name) === key);
			return matches.length === 1 ? () => openLiveArtist(matches[0]) : null;
		}
		if (intent.kind === 'album') {
			const title = intent.display?.title;
			const artist = intent.display?.artist;
			if (!title || !artist) return null;
			const key = `${librarySortKey(title)} ${normalizeCatalogText(artist)}`;
			const matches = roots.albums.filter((entry) => entry.searchKey === key);
			return matches.length === 1 ? () => openLiveAlbum(matches[0]) : null;
		}
		return null;
	}

	$effect(() => {
		const pending = $pendingLibraryIntentStore;
		if (!resumed || !pending || pending.intent.destination !== 'search') {
			return;
		}
		const intent = claimLibraryIntent(pending.requestId);
		if (intent?.destination !== 'search') return;
		const open = resolveEntityIntent(intent);
		if (open) {
			// The row is opened from the scope it belongs to, so Back returns to
			// a list rather than to whatever surface the reader came from.
			resetDrill();
			scope = intent.kind === 'artist' ? 'artists' : 'albums';
			railTarget = null;
			filterText = '';
			open();
			return;
		}
		openPalette(intent.query);
	});

	function retirePaletteAuthority(): Promise<void> {
		const activeClaim = claim;
		if (activeClaim) {
			return clearPaletteSearchData(activeClaim).catch(() => {
				// A lost/replaced claim clears the same authority in the
				// coordinator lifecycle.
			});
		}
		resetPaletteSearchData();
		return Promise.resolve();
	}

	function queuePaletteAuthorityRetirement(): Promise<void> {
		const previous = paletteSearchHandoff;
		const current = retirePaletteAuthority();
		paletteSearchHandoff = Promise.all([previous, current]).then(() => undefined);
		return paletteSearchHandoff;
	}

	function startPaletteAuthorityRetirement(): void {
		void queuePaletteAuthorityRetirement();
	}

	function closePalette(): void {
		classicSearchOwnerGeneration += 1;
		paletteOpen = false;
		paletteQuery = '';
		paletteSelectedRowId = null;
		selectedSong = null;
		returnToPalette = false;
		songActionController.reset();
		songFavoriteBusy = false;
		songFavoriteStatus = null;
		resetSongRelationship();
		startPaletteAuthorityRetirement();
	}

	/** Filter pages are history entries (Back/Forward via page state). */
	function applySmartFilter(text: string): void {
		closePalette();
		resetDrill();
		scope = 'artists';
		railTarget = null;
		filterText = text;
		pushUnifiedSemanticState();
	}

	function clearSmartFilter(): void {
		filterText = '';
		window.history.back();
	}

	function paletteDrill(target: UnifiedLibraryDrillTarget): void {
		paletteOpen = false;
		selectedSong = null;
		resetSongRelationship();
		returnToPalette = true;
		// Palette destinations are nested search views, not semantic history
		// entries. Keeping them inside this mounted mode preserves both the
		// query/selection and the server-owned retained song authority.
		void openDrill(target, false);
	}

	/**
	 * A live Artists or Albums row picked out of the palette.
	 *
	 * Unlike a palette-owned search view, a live page IS an address: it has a
	 * URL of its own and a history entry to match (Slice 3). So the palette
	 * closes for good rather than staying behind it, and the page opens exactly
	 * as it would from the list — same reference, same address, same Back.
	 */
	function paletteOpenLiveArtist(entry: LibraryArtistEntry): void {
		closePalette();
		resetDrill();
		scope = 'artists';
		railTarget = null;
		filterText = '';
		openLiveArtist(entry);
	}

	function paletteOpenLiveAlbum(entry: LibraryAlbumEntry): void {
		closePalette();
		resetDrill();
		scope = 'albums';
		railTarget = null;
		filterText = '';
		openLiveAlbum(entry);
	}


	function paletteSong(song: PaletteSearchRow): void {
		songActionController.reset();
		songFavoriteBusy = false;
		songFavoriteStatus = null;
		selectedSong = song;
		loadSongRelationship(song);
	}

	function backToPaletteResults(): void {
		songActionController.reset();
		songFavoriteBusy = false;
		songFavoriteStatus = null;
		selectedSong = null;
		resetSongRelationship();
	}

	function favoriteTypeFor(item: BrowseItem): FavoriteType | null {
		const resultType = (item as BrowseItem & { resultType?: SearchResult['resultType'] })
			.resultType;
		if (resultType === 'track' || resultType === 'album' || resultType === 'artist') {
			return resultType;
		}
		const token = `${item.itemType ?? ''} ${item.hint ?? ''}`.toLowerCase();
		if (token.includes('track') || token.includes('song')) return 'track';
		if (token.includes('album')) return 'album';
		if (token.includes('artist')) return 'artist';
		return null;
	}

	function favoritePayload(item: BrowseItem, type: FavoriteType): AddFavoriteRequest {
		return {
			type,
			title: item.title,
			...(type !== 'artist' && item.subtitle ? { artist: item.subtitle } : {}),
			...(item.imageKey ? { image_key: item.imageKey } : {})
		};
	}

	function favoriteTypeForSource(source: UnifiedBrowseActionSource): FavoriteType | null {
		const direct = favoriteTypeFor(source.item);
		if (direct || source.kind !== 'browse') return direct;
		const category = source.snapshot.history.at(-1)?.breadcrumb.title.trim().toLowerCase();
		if (category === 'tracks' || category === 'songs') return 'track';
		if (category === 'albums') return 'album';
		if (category === 'artists') return 'artist';
		return null;
	}

	async function favoriteBrowseAction(): Promise<void> {
		const source = browseActionState.source;
		const item = source?.item;
		const type = source ? favoriteTypeForSource(source) : null;
		if (!item || !type || browseFavoriteBusy) return;
		browseFavoriteBusy = true;
		browseFavoriteStatus = null;
		try {
			await addFavoriteData(fetchFn, favoritePayload(item, type));
			browseFavoriteStatus = 'Added to favorites.';
		} catch (error) {
			browseFavoriteStatus =
				error instanceof Error ? error.message : 'Could not add this favorite.';
		} finally {
			browseFavoriteBusy = false;
		}
	}

	async function favoriteSong(): Promise<void> {
		const song = selectedSong;
		if (!song || songFavoriteBusy) return;
		songFavoriteBusy = true;
		songFavoriteStatus = null;
		try {
			await addFavoriteData(fetchFn, {
				type: 'track',
				title: song.title,
				...(song.subtitle ? { artist: song.subtitle } : {}),
				...(song.imageKey ? { image_key: song.imageKey } : {})
			});
			songFavoriteStatus = 'Added to favorites.';
		} catch (error) {
			songFavoriteStatus =
				error instanceof Error ? error.message : 'Could not add this favorite.';
		} finally {
			songFavoriteBusy = false;
		}
	}

	function publishBrowseStateAfter(restored: boolean, activeClaim: ClassicBrowseSessionClaim): void {
		if (restored && claim === activeClaim && scope === 'browse') {
			resetPaneAfterRender();
			pushUnifiedSemanticState();
		}
	}

	function replaceBrowseStateAfter(restored: boolean, activeClaim: ClassicBrowseSessionClaim): void {
		if (restored && claim === activeClaim && scope === 'browse') {
			replaceLibraryPageState(unifiedSemanticState());
		}
	}

	function openBrowseAction(item: BrowseItem): void {
		const activeClaim = claim;
		if (!activeClaim) return;
		browseActionFromPalette = false;
		browseFavoriteBusy = false;
		browseFavoriteStatus = null;
		void browseActionController.open(
			activeClaim,
			{
				kind: 'browse',
				snapshot: browseState.snapshot,
				item,
				restoreCount: browseState.result?.items.length
			},
			actionZoneId ?? undefined
		);
	}

	function browseItem(item: BrowseItem): void {
		const activeClaim = claim;
		if (!activeClaim) return;
		if (item.inputPrompt) {
			openPalette('');
			return;
		}
		if (browseItemOpensActions(item)) {
			openBrowseAction(item);
			return;
		}
		void browseController
			.openItem(activeClaim, item, sheetZones[0]?.zoneId)
			.then((restored) => publishBrowseStateAfter(restored, activeClaim));
	}

	function browseBack(): void {
		const activeClaim = claim;
		if (!activeClaim) return;
		void browseController
			.back(activeClaim, sheetZones[0]?.zoneId)
			.then((restored) => publishBrowseStateAfter(restored, activeClaim));
	}

	function browseForward(): void {
		const activeClaim = claim;
		if (!activeClaim) return;
		void browseController
			.forward(activeClaim, sheetZones[0]?.zoneId)
			.then((restored) => publishBrowseStateAfter(restored, activeClaim));
	}

	function browseLoadMore(): void {
		const activeClaim = claim;
		if (!activeClaim) return;
		void browseController.loadMore(activeClaim, sheetZones[0]?.zoneId);
	}

	function closeBrowseAction(): void {
		const cameFromPalette = browseActionFromPalette;
		browseActionController.reset();
		browseActionFromPalette = false;
		browseFavoriteBusy = false;
		browseFavoriteStatus = null;
		if (cameFromPalette) {
			openPalette(paletteQuery);
			return;
		}
		const activeClaim = claim;
		if (activeClaim && scope === 'browse') {
			void browseController
				.restore(activeClaim, browseState.snapshot, sheetZones[0]?.zoneId)
				.then((restored) => replaceBrowseStateAfter(restored, activeClaim));
		}
	}

	function beginBrowseAction(semantic: UnifiedSongActionSemantic, zoneId: string): void {
		const activeClaim = claim;
		if (!activeClaim) return;
		void browseActionController.execute(activeClaim, semantic, zoneId);
	}

	// Which actions Roon offers is a question asked OF a zone, and the answer
	// is what enables these buttons — but the zone picker sits in the layout,
	// outside the sheet's backdrop, and stays clickable while the sheet is up.
	// `+layout.svelte` also re-pins the selection on Core reconnect and moves
	// it in memory when a zone vanishes. So availability probed under one zone
	// can end up gating buttons that will execute on another: a button offered
	// for a zone that never answered for it. A moved zone re-probes; the
	// controller's fence supersedes the in-flight probe, so the buttons flip
	// to loading and then to the truth (public issue #12).
	$effect(() => {
		const zoneId = actionZoneId;
		const state = browseActionState;
		const source = state.source;
		if (state.phase === 'idle' || source === null) return;
		if (state.zoneId === zoneId) return;
		const activeClaim = claim;
		if (!activeClaim) return;
		untrack(() => {
			void browseActionController.open(activeClaim, source, zoneId ?? undefined);
		});
	});

	async function preparePaletteBrowseTransition(): Promise<ClassicBrowseSessionClaim | null> {
		const activeClaim = claim;
		if (!activeClaim || !paletteOpen) return null;
		classicSearchOwnerGeneration += 1;
		paletteOpen = false;
		selectedSong = null;
		resetSongRelationship();
		returnToPalette = false;
		await queuePaletteAuthorityRetirement();
		return claim === activeClaim ? activeClaim : null;
	}

	function paletteBrowseResult(query: string, result: SearchResult): void {
		void preparePaletteBrowseTransition().then((activeClaim) => {
			if (!activeClaim) return;
			if (browseItemOpensActions(result)) {
				browseActionFromPalette = true;
				browseFavoriteBusy = false;
				browseFavoriteStatus = null;
				void browseActionController.open(
					activeClaim,
					{ kind: 'search', query, item: result },
					actionZoneId ?? undefined
				);
				return;
			}
			scope = 'browse';
			railTarget = null;
			filterText = '';
			resetDrill();
			void browseController
				.openSearchResult(activeClaim, query, result, sheetZones[0]?.zoneId)
				.then((restored) => publishBrowseStateAfter(restored, activeClaim));
		});
	}

	function paletteBrowseCategory(query: string, categoryTitle: string): void {
		void preparePaletteBrowseTransition().then((activeClaim) => {
			if (!activeClaim) return;
			scope = 'browse';
			railTarget = null;
			filterText = '';
			resetDrill();
			void browseController
				.openSearchCategory(activeClaim, query, categoryTitle, sheetZones[0]?.zoneId)
				.then((restored) => publishBrowseStateAfter(restored, activeClaim));
		});
	}

	function leaveSongPanelForDrill(): void {
		relationshipFence += 1;
		songActionController.reset();
		paletteOpen = false;
		returnToPalette = true;
	}

	function openSongComposer(label: string): void {
		const relationship = songRelationship.relationship;
		if (
			songRelationship.phase !== 'ready' ||
			!relationship ||
			!relationship.composerLabels.includes(label)
		) {
			return;
		}
		leaveSongPanelForDrill();
		void openDrill({ kind: 'composer', label }, false);
	}

	function beginSongAction(
		semantic: 'play-now' | 'add-next' | 'queue',
		zoneId: string
	): void {
		const activeClaim = claim;
		const song = selectedSong;
		if (
			!activeClaim ||
			!song ||
			(songActionState.resultId === song.resultId && songActionState.authorityRetired)
		)
			return;
		void songActionController.execute({
			claim: activeClaim,
			resultId: song.resultId,
			semantic,
			zoneId
		});
	}

	function paletteSearch(query: string): void {
		const activeClaim = claim;
		if (!activeClaim || !paletteOpen) return;
		const generation = classicSearchOwnerGeneration;
		void paletteSearchHandoff.then(() => {
			if (
				generation !== classicSearchOwnerGeneration ||
				claim !== activeClaim ||
				!paletteOpen
			) {
				return;
			}
			return searchPaletteData(activeClaim, query);
		});
	}

	/**
	 * Scoped capture (plan §3.2): typing anywhere in the mounted view
	 * opens the palette. Never when an input/textarea/editable or the
	 * album sheet has focus; never outside this view — the listener is
	 * attached only while resumed. Cmd/Ctrl-K is an explicit chord and
	 * toggles regardless of focus.
	 */
	function paletteCaptureKeydown(event: KeyboardEvent): void {
		if (browseActionState.phase !== 'idle') return;
		if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
			event.preventDefault();
			if (paletteOpen) closePalette();
			else openPalette('');
			return;
		}
		if (paletteOpen) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target instanceof Element ? event.target : null;
		const active = document.activeElement;
		// `swallowsTypedText` rather than a hand-written tagName check: the
		// volume slider is an `<input>` that no printable key types into, and
		// a bare tagName test left typing dead after a drag (songr #16). One
		// predicate, shared with the Space shortcut, so the two cannot drift.
		for (const el of [target, active]) {
			if (swallowsTypedText(el)) return;
		}
		// A live item page owns reading focus; typing must not yank it into
		// the palette (§4.3, extending the album-sheet protection).
		if (itemTarget !== null) return;
		if (event.key.length === 1 && event.key !== ' ') {
			event.preventDefault();
			openPalette(event.key);
		}
	}

	$effect(() => {
		if (!resumed) return;
		window.addEventListener('keydown', paletteCaptureKeydown);
		return () => window.removeEventListener('keydown', paletteCaptureKeydown);
	});

	// The palette covers the header it opens over, and nothing else unsets
	// these: an open Sort or About menu stayed open and rendered underneath
	// it (songr #15). Same dismissal contract as the outside-pointerdown and
	// Escape effects above — a menu closes when the surface that owns it goes
	// away — with the one trigger those two did not cover.
	$effect(() => {
		if (!paletteOpen) return;
		sortOpen = false;
		aboutOpen = false;
	});

	function setSort(value: string): void {
		if (!sortMenu) return;
		// A persisted rail target indexes the previous ordering; drop it.
		railTarget = null;
		prefsStore.setSort(scope as SortableUnifiedScope, value);
	}

	function setLiveCollectionAlbumSort(value: string): void {
		if (value === 'shuffle') shuffleSeed += 1;
		prefsStore.setSort('genre', value);
	}

	function setDensity(value: UnifiedLibraryDensity): boolean {
		return prefsStore.setDensity(value);
	}

	function railJump(bucket: LetterBucket): void {
		// Scope views (slice 5) consume the jump target; the rule and the
		// target contract are owned here.
		railTarget = bucket;
	}

	async function loadForClaim(
		activeClaim: ClassicBrowseSessionClaim,
		retirementRevision?: number
	): Promise<void> {
		const generation = lifecycleGeneration;
		let coreId: string;
		try {
			// The Core's own identity, not the catalog's account of it: the
			// live view must be able to read the library on a build where the
			// catalog is gone, which is where this plan ends.
			const paired = $coreStore.core?.id;
			if (paired !== undefined) coreId = paired;
			else {
				const status = await fetchCoreStatusData(fetchFn);
				if (status.core === undefined) throw new Error('No paired Core');
				coreId = status.core.id;
			}
		} catch {
			// A cold desktop launch opens the window as soon as the engine's
			// HTTP port is up — up to ~25s before Roon discovery and registry
			// registration finish — so this first status call can lose that
			// race and reject with CoreUnpairedError. Returning silently used
			// to strand the library body on "Idle." for the life of the
			// window: the store never left `idle`, and the socket never
			// dropped, so `handleReconnect` never re-drove it. Defer instead,
			// and let pairing re-drive the load.
			if (pairingRetryGeneration !== generation) pairingRetryDeferred = true;
			return;
		}
		if (generation !== lifecycleGeneration || claim !== activeClaim) return;
		await loadRoots(fetchFn, {
			coreId,
			...(retirementRevision === undefined ? {} : {
				retirement: {
					revision: retirementRevision,
					isCurrent: () => generation === lifecycleGeneration &&
						isCurrentUnifiedClaim(activeClaim) && ($coreStore.core?.id ?? coreId) === coreId
				}
			})
		});
	}

	// Pairing is the readiness signal the deferred load is waiting for, and it
	// already reaches the client: the engine emits `core-status`, the socket
	// registrar feeds `coreStore`, and `corePairedStore` derives from it. One
	// retry per lifecycle generation — enough to cover the cold-start race
	// without turning a persistent failure into a retry loop.
	$effect(() => {
		if (!$corePairedStore || !pairingRetryDeferred) return;
		pairingRetryDeferred = false;
		const activeClaim = untrack(() => claim);
		if (!activeClaim || !untrack(() => resumed)) return;
		pairingRetryGeneration = lifecycleGeneration;
		void loadForClaim(activeClaim);
	});

	function isCurrentUnifiedClaim(activeClaim: ClassicBrowseSessionClaim): boolean {
		return (
			resumed &&
			claim === activeClaim &&
			sessionClient.isClaimCurrent(activeClaim)
		);
	}

	function detachConnectionListeners(): void {
		if (!connectionListenersAttached) return;
		connectionSocket?.off('disconnect', handleConnectionLost);
		connectionSocket?.off('connect', handleReconnect);
		connectionListenersAttached = false;
	}

	function handleConnectionLost(): void {
		const activeClaim = claim;
		if (!activeClaim || !isCurrentUnifiedClaim(activeClaim)) return;
		sessionClient.connectionLost(activeClaim);
		songActionController.reset();
		browseActionController.reset();
		browseActionFromPalette = false;
		browseController.reset(browseState.snapshot);
		selectedSong = null;
		resetSongRelationship();
		resetPaletteSearchData();
	}

	function handleReconnect(): void {
		const generation = lifecycleGeneration;
		const activeClaim = claim;
		if (
			!activeClaim ||
			!isCurrentUnifiedClaim(activeClaim) ||
			recoveryGeneration === generation
		) {
			return;
		}
		recoveryGeneration = generation;
		void sessionClient
			.recover(activeClaim)
			.then(() => {
				if (
					generation !== lifecycleGeneration ||
					!isCurrentUnifiedClaim(activeClaim)
				) {
					return;
				}
				void loadForClaim(activeClaim);
				// A cold scope load can lose the same socket-connect race as the
				// roots. Re-drive the visible scope after the recovered session is
				// current; each loader is idempotent and retries only unloaded data.
				// An addressed live page owns the pane and restores through its own
				// hierarchy, so its hidden classic scope has nothing to retry.
				if (itemTarget?.kind !== 'live') maybeLoadScopeData(scope);
				if (scope === 'browse') {
					void browseController
						.restore(activeClaim, browseState.snapshot, sheetZones[0]?.zoneId)
						.then((restored) => replaceBrowseStateAfter(restored, activeClaim));
				}
				if (paletteOpen) {
					const genres = $genresStore;
					if (!genres.loaded && !genres.loading) void genresStore.load(activeClaim);
					const composers = $composersStore;
					if (!composers.loaded && !composers.loading) {
						void composersStore.load(activeClaim);
					}
					void searchPaletteData(activeClaim, paletteQuery);
				}
			})
			.catch(() => {
				// The next real connect event retries. A superseded lifecycle
				// owns its own claim and needs no error published here.
			})
			.finally(() => {
				if (recoveryGeneration === generation) recoveryGeneration = null;
			});
	}

	function attachConnectionListeners(): void {
		const nextSocket = getSocketClient();
		if (connectionListenersAttached && connectionSocket !== nextSocket) {
			detachConnectionListeners();
		}
		connectionSocket = nextSocket;
		if (!connectionSocket || connectionListenersAttached) return;
		connectionSocket.on('disconnect', handleConnectionLost);
		connectionSocket.on('connect', handleReconnect);
		connectionListenersAttached = true;
	}

	// Cold-start pairing race (proven live 2026-08-17 on the public desktop
	// build): the page mounts as soon as the engine serves, Core pairing
	// lands a beat later, and the mount-time loadForClaim dies unpaired —
	// leaving the library at "Idle." until a manual reload. Re-fire the load
	// when pairing ARRIVES. The first effect run only records the state (the
	// mount-time load owns the already-paired path), and a steady paired
	// state never re-fires, so a genuine catalog error cannot loop.
	let coreWasPaired: boolean | null = null;
	$effect(() => {
		const paired = $isCorePaired;
		const becamePaired = coreWasPaired === false && paired;
		coreWasPaired = paired;
		if (!becamePaired || !resumed || claim === null) return;
		if (roots.phase !== 'idle' && roots.phase !== 'error') return;
		void loadForClaim(claim);
	});

	function resumeUnified(activation: CommittedLibraryModeActivation | null = null): void {
		lifecycleGeneration += 1;
		activationGeneration = lifecycleGeneration;
		const pageState = activation?.pageState;
		let restoredItem: UnifiedItemTarget | null = null;
		let restoredDetail: UnifiedItemDetailTarget | null = null;
		/** Issue #6: the persisted artist-origin label for a restored album page. */
		let restoredOriginName: string | null = null;
		if (pageState && pageState.libraryView === 'unified') {
			scope = pageState.snapshot.scope;
			browseController.reset(pageState.snapshot.browseHistory);
			restoredItem = pageState.snapshot.itemTarget;
			restoredDetail = pageState.snapshot.itemDetail;
			restoredOriginName = pageState.snapshot.itemOriginName;
			shuffleSeed = pageState.snapshot.surpriseSeed ?? 0;
			const restoredDensity = pageState.snapshot.density;
			if (restoredDensity !== null && restoredDensity !== prefs.density) {
				prefsStore.setDensity(restoredDensity);
			}
			// Filter pages restore from persisted text and re-validate at
			// render time (gating may have changed since the entry was
			// pushed); anything else clears a leftover filter page.
			filterText = pageState.snapshot.filterText;
		} else {
			filterText = '';
			browseController.reset();
		}
		const connectedBeforeClaim = Boolean(getSocketClient()?.connected);
		claim = sessionClient.claim('unified-mode');
		claimEpoch += 1;
		resumed = true;
		attachConnectionListeners();
		if (!connectedBeforeClaim && connectionSocket?.connected) handleReconnect();
		void loadForClaim(claim);
		if (scope === 'browse') {
			const activeClaim = claim;
			void browseController
				.restore(activeClaim, browseState.snapshot, sheetZones[0]?.zoneId)
				.then((restored) => replaceBrowseStateAfter(restored, activeClaim));
		}
		// Restored page state may land directly on a data-owning scope. A live
		// item restores through its addressed hierarchy instead; asking the
		// hidden classic scope too only creates competing Core browse traffic.
		if (restoredItem?.kind !== 'live') maybeLoadScopeData(scope);
		// Semantic restoration: the collection context first, then the item
		// page over it; labels resolve against live data and zero matches
		// degrade to the parent with a notice.
		if (restoredItem) {
			void openItemPage(restoredItem, false, undefined, undefined, true);
			// openItemPage's synchronous prefix always clears itemOriginName
			// (it has no way to see the artist-origin transition during
			// restore, since itemTarget is still null at this call site) —
			// re-apply the persisted label immediately after so the back
			// button keeps naming the artist across reload/popstate
			// (issue #6). Safe because that prefix, including the clearing
			// assignment, has already run synchronously by the time control
			// returns here (album targets yield only on the later `await
			// openAlbumRead(...)`).
			itemOriginName = restoredOriginName;
			// The exact-track child restores AFTER the album page opens: the
			// page consumes the index once its single-version track order
			// arrives, and a stale index simply keeps the parent (the
			// session-bound restoration rule, Slice 8).
			if (restoredDetail?.kind === 'track') {
				restoredTrackInfoTitle = restoredDetail.title;
			}
		}
		// A Back initiated from an item page returns to this entry: restore
		// the scroll captured at item open instead of the reset-to-top the
		// restoration paths run (ri1-4). Any other resume discards it.
		const parkedScroll = pendingPopReturnScrollTop;
		pendingPopReturnScrollTop = null;
		if (parkedScroll !== null && restoredItem === null) {
			// This resume follows `resetIndex()`, so the list is rebuilding from
			// empty underneath us; a one-shot assignment here clamps to a nearly
			// empty pane and lands at the top.
			restorePaneScrollTop(parkedScroll);
		}
	}

	function suspendUnified(): void {
		// Synchronous: invalidate generations, drop in-flight index work,
		// cancel album-action and library-album operations, release the
		// claim (plan §3.2 slices 4 and 6).
		lifecycleGeneration += 1;
		resumed = false;
		detachConnectionListeners();
		connectionSocket = null;
		recoveryGeneration = null;
		pairingRetryDeferred = false;
		pairingRetryGeneration = null;
		sheetActionController.cancel();
		albumController.cancel();
		albumController.reset();
		sheetActionGesture += 1;
		sheetActionAttempt = null;
		retrySheetActionIntent = null;
		sheetActionRetryAvailable = false;
		// Scope data is claim-scoped; a future resume gets a fresh claim.
		genresStore.reset();
		composersStore.reset();
		classicSearchOwnerGeneration += 1;
		itemPageController.close();
		itemTarget = null;
		legacyItemRoute = null;
		itemOriginName = null;
		itemEntryRelationship = 'transient';
		trackChildOwnsEntry = false;
		itemInvoker = null;
		drillNotice = null;
		// Palette capture detaches with `resumed`; state resets here so a
		// future resume never inherits a stale overlay or filter page.
		paletteOpen = false;
		paletteQuery = '';
		paletteSelectedRowId = null;
		selectedSong = null;
		returnToPalette = false;
		filterText = '';
		songActionController.reset();
		browseActionController.reset();
		browseActionFromPalette = false;
		browseFavoriteBusy = false;
		browseFavoriteStatus = null;
		songFavoriteBusy = false;
		songFavoriteStatus = null;
		favoriteMutationBusy = false;
		favoritesStatus = null;
		browseController.reset();
		resetSongRelationship();
		resetPaletteSearchData();
		if (claim) {
			sessionClient.release(claim);
			claim = null;
			claimEpoch += 1;
		}
	}

	onMount(() => {
		const unregisterDensityRequest = registerUnifiedLibraryDensityRequestHandler(setDensity);
		const unregister = activationContext?.registerLifecycle?.('unified', {
			resume: (activation) => resumeUnified(activation),
			suspend: suspendUnified
		});
		if (!unregister) resumeUnified(activationContext?.committedActivation?.() ?? null);
		return () => {
			suspendUnified();
			unregister?.();
			unregisterDensityRequest();
		};
	});
</script>

<section
	class="unified-library-mode unified-surface density-{prefs.density}"
	data-testid="library-mode-target"
	data-library-mode="unified"
	data-density={prefs.density}
	data-d={prefs.density}
	aria-label="Unified library"
>
	<header class="bar">
		<button
			type="button"
			class="brand mono"
			data-testid="unified-brand"
			aria-label="Sǫngr"
			aria-pressed={brandShowsLatin}
			title={brandShowsLatin ? 'Sǫngr' : 'Sǫngr — show Latin spelling'}
			onclick={() => (brandShowsLatin = !brandShowsLatin)}
		>
			{#if brandShowsLatin}
				<span class="brand-latin" data-testid="unified-brand-latin">Sǫngr</span>
			{:else}
				<!-- Younger Futhark (long-branch): ᛋᚬᚾᚴᚱ = s o n k r. Inlined rather than
				     linked so `currentColor` applies and no runic font is required. -->
				<svg
					class="brand-runes"
					data-testid="unified-brand-runes"
					viewBox="0 0 320 104"
					aria-hidden="true"
					focusable="false"
				>
					<g
						fill="none"
						stroke="currentColor"
						stroke-width="5"
						stroke-linecap="butt"
						stroke-linejoin="miter"
					>
						<path d="M12 2 L12 56 L36 34 L36 100" />
						<path d="M88 2 L88 100" />
						<path d="M70 22 L124 56" />
						<path d="M70 46 L124 80" />
						<path d="M154 2 L154 100" />
						<path d="M135 35 L186 72" />
						<path d="M212 2 L212 100" />
						<path d="M212 48 L242 10" />
						<path d="M278 2 L278 100" />
						<path d="M278 2 L308 22 L278 44" />
						<path d="M280 42 L310 100" />
					</g>
				</svg>
			{/if}
		</button>
		<div class="spacer"></div>
		<!-- Search demoted to the small-button family and moved to the right
		     cluster (owner ruling 2026-08-17): the 280px input-styled box
		     next to the 15px mark was "ugly, prominent, confusing" — and it
		     impersonated a text field while really opening the palette.
		     The palette itself is unchanged. -->
		<button
			type="button"
			class="findbtn"
			data-testid="unified-find"
			title="Search — or just type anywhere"
			disabled={browseActionState.phase !== 'idle'}
			onclick={() => openPalette('')}
		>
			<span aria-hidden="true">⚲</span> Search
		</button>
		<button
			type="button"
			class="settingsbtn mono"
			data-testid="unified-settings-open"
			aria-label="Open Controller settings"
			aria-haspopup="dialog"
			aria-controls="controller-settings-dialog"
			aria-expanded={$settingsMenuOpen}
			onclick={openSettingsMenu}
		>
			Settings
		</button>
		<button
			type="button"
			class="aboutbtn mono"
			data-testid="unified-about-open"
			aria-haspopup="dialog"
			aria-expanded={aboutOpen}
			bind:this={aboutButton}
			onclick={() => (aboutOpen = !aboutOpen)}
		>
			About
		</button>
	</header>

	{#if aboutOpen}
		<div
			class="aboutpanel"
			role="dialog"
			aria-modal="false"
			aria-label="About Sǫngr"
			data-testid="unified-about-panel"
			bind:this={aboutPanel}
		>
			<p class="ab-name">Sǫngr</p>
			<p class="ab-desc">web-based controller for Roon</p>
			<dl class="ab-rows">
				<dt>Connection</dt>
				<dd
					class:good={connectedGood}
					data-testid="unified-about-connection"
				>{connectedLabel}</dd>
				<dt>Version</dt>
				<dd data-testid="unified-about-app-version">{__APP_VERSION__}</dd>
				<dt>Interface</dt>
				<dd data-testid="unified-about-ui-revision">rev {uiBuildRevision}</dd>
				<dt>Core</dt>
				<dd data-testid="unified-about-core-name">{$coreStore.core?.displayName ?? '—'}</dd>
				<dt>Core version</dt>
				<dd data-testid="unified-about-core-version">
					{$coreStore.core?.displayVersion ?? '—'}
				</dd>
			</dl>
			<p class="ab-legal">Not affiliated with or endorsed by Roon Labs LLC.</p>
			<button
				type="button"
				class="ab-close mono"
				data-testid="unified-about-close"
				onclick={() => (aboutOpen = false)}
			>
				Close
			</button>
		</div>
	{/if}



	<!-- The library body stays MOUNTED but hidden while the search-track
	     page is live (ri5-1) — the same restoration pattern the item
	     pages use for the collection host: Back re-surfaces the exact
	     prior context, transient state intact. -->
	<div class="body" hidden={paletteOpen && selectedSong !== null}>
		{#if railVisible}
			<nav class="rail" aria-label="A to Z index" data-testid="unified-rail">
				{#each railLetterEntries(railBuckets) as entry (entry.letter)}
					<button
						type="button"
						class:on={railTarget?.letter === entry.letter}
						class:off={!entry.bucket}
						disabled={!entry.bucket}
						onclick={() => entry.bucket && railJump(entry.bucket)}
					>
						{entry.letter}
					</button>
				{/each}
			</nav>
		{/if}
		<div
			class="pane u-main"
			data-testid="unified-pane"
			data-scope={scope}
			bind:this={pane}
		>
			<nav class="scopes" aria-label="Library scope">
				{#each scopeChips as chip (chip.id)}
					<button
						type="button"
						class="sc"
					class:on={scope === chip.id && !itemTarget && !filterText}
						aria-pressed={scope === chip.id}
						data-testid="unified-scope-{chip.id}"
						onclick={() => setScope(chip.id)}
					>
						{chip.label}
					</button>
				{/each}
			</nav>
			{#if !resumed}
				<p class="status">Suspended.</p>
			{:else if scope === 'browse' && itemTarget === null}
				<UnifiedBrowseView
					state={browseState}
					onBack={browseBack}
					onForward={browseForward}
				onItem={browseItem}
				onLoadMore={browseLoadMore}
				onSearchPrompt={() => openPalette('')}
				hrefForItem={hrefForBrowseItem}
					/>
			{:else if scope === 'favorites' && itemTarget === null}
				<UnifiedFavoritesView
					state={favorites as FavoritesState}
					busy={favoriteMutationBusy}
					status={favoritesStatus}
					onActivate={activateFavorite}
					onRemove={(favorite) => void removeFavoriteEntry(favorite)}
				/>
			{:else if surfacePhase === 'loading'}
				<p class="status" data-testid="unified-loading">Loading library…</p>
			{:else if surfacePhase === 'error'}
				<p class="status error" data-testid="unified-error">
					Could not load the library{surfaceError ? `: ${surfaceError}` : '.'}
				</p>
			{:else if surfacePhase === 'ready'}
						{#if itemTarget?.kind === 'live' && livePage.phase === 'group' && livePage.group}
					<section class="item-page" data-testid="unified-library-group-page">
						<div class="ctx">
							<button type="button" class="back" onclick={backFromItem}>← {itemBackLabel}</button>
							<h2 tabindex="-1">{livePage.group.at.title}</h2>
						</div>
						<p class="notice" data-testid="unified-library-group-notice">
							{livePage.message}
						</p>
						<div class="alist" data-testid="unified-library-group-candidates">
							{#each livePage.group.targets as target, index (`${target.ref.generation}:${target.ref.token}`)}
								<button
									type="button"
									class="arow"
									data-testid="unified-library-group-candidate-{index}"
									onclick={() => openLiveGroupCandidate(target)}
								>
									<span class="an">{target.title}</span><span class="ad"></span><span
										class="ac mono">{target.subtitle ?? ''}</span
									>
								</button>
							{/each}
						</div>
					</section>
				{:else if itemTarget?.kind === 'collection' || (itemTarget?.kind === 'live' && livePageKind === 'album')}
					<UnifiedAlbumPage
						controller={albumController}
						actionController={sheetActionController}
						zoneId={actionZoneId}
						collectionFailureMessage={collectionOpenFailureMessage}
						album={itemTarget.kind === 'live' ? liveAlbum : null}
						focusSongTitle={albumSongFocusTitle}
						{activationGeneration}
						backLabel={itemBackLabel}
						onBack={backFromItem}
						onRetry={retryAlbumPage}
						actionRetryAvailable={sheetActionRetryAvailable}
						onRetryAction={retryFailedSheetAction}
						onBeginAction={beginSheetAction}
						onOpenTrackInfo={openEditorialTrack}
						onCloseTrackInfo={closeTrackChild}
						{hrefForTrack}
						initialTrackInfoTitle={restoredTrackInfoTitle}
					/>
				{:else if itemTarget?.kind === 'live' && livePageKind === 'artist'}
					<UnifiedArtistPage
						artist={liveArtist}
						albums={liveArtistAlbums}
						overlayPhase={livePage.phase === 'opening'
							? 'loading'
							: livePage.phase === 'failed'
								? 'failed'
								: 'idle'}
						discographyKnown={livePage.phase === 'ready'}
						truncated={false}
						missingMessage={livePage.message}
						backLabel={itemBackLabel}
						onBack={backFromItem}
					>
						{#snippet discography()}
							{#key liveArtist?.name}
								<UnifiedScopeViews
									scope="albums"
									artists={[]}
									albums={liveArtistAlbums}
									sorts={viewSorts}
									randomSeed={shuffleSeed}
									groupAlbums={false}
									railTarget={null}
									genres={$genresStore}
									recent={$recentStore}
									onDrill={openDrill}
									onOpenLiveAlbum={openLiveAlbum}
									{hrefForArtist}
									{hrefForAlbum}
									{hrefForDrill}
								/>
							{/key}
						{/snippet}
					</UnifiedArtistPage>
				{:else if itemTarget?.kind === 'live' && livePageKind !== null}
					<UnifiedLiveCollectionPage
						page={livePage}
						levelKind={livePageKind}
						backLabel={itemBackLabel}
						onBack={backFromItem}
						onRetry={() => livePageController.retry()}
						onOpenRow={(row) => openLiveStructuralRow(row, true)}
						hrefForRow={hrefForLiveStructuralRow}
						onOpenAlbum={openLiveAlbum}
						{hrefForAlbum}
						actionController={sheetActionController}
						actionsEnabled={actionZoneId !== null}
						onBeginActions={beginLiveCollectionActions}
						sorts={liveCollectionSorts}
						randomSeed={shuffleSeed}
						onSetAlbumSort={setLiveCollectionAlbumSort}
					/>
				{/if}
				<!-- The collection context stays MOUNTED but hidden under an
				     open item page, so Back returns to the exact invoking
				     collection with its transient view state (tabs, loaded
				     data) intact (§4.2). -->
				<div class="collection-host" hidden={itemTarget !== null}>
				{#if filterText}
					<div class="ctx">
						<button
							type="button"
							class="back"
							data-testid="unified-filter-back"
							onclick={clearSmartFilter}
						>
							← Artists
						</button>
						<h2 tabindex="-1" data-testid="unified-filter-label">
							{filterSpec ? filterSpec.label : filterText}
						</h2>
						{#if filterSpec}
							<span class="n mono" data-testid="unified-filter-summary">
								{filterArtists.length.toLocaleString()} ARTISTS
							</span>
						{/if}
					</div>
					{#if !filterSpec}
						<p class="notice" data-testid="unified-filter-invalid">
							“{filterText}” is not a filter this library understands any more.
						</p>
					{:else}
						{#if filterUncountedArtists > 0}
							<p class="notice" data-testid="unified-filter-uncounted">
								{filterUncountedArtists.toLocaleString()} of {roots.artists.length.toLocaleString()}
								artists carry no album count in Roon's own list, so they were not tested.
							</p>
						{/if}
						{#if filterArtists.length === 0}
							<div class="hint" data-testid="unified-filter-none">No artists match.</div>
						{:else}
							<div class="alist" data-testid="unified-filter-results">
								{#each filterArtists as artist (artist.id)}
									<a
										class="arow"
										data-testid="unified-filter-artist"
										href={hrefForArtist(artist)}
										onclick={(event) => followAddress(event, () => openLiveArtist(artist))}
									>
										<span class="an">{artist.name}</span><span class="ad"></span><span
											class="ac mono">{artist.albumCount ?? ''}</span
										>
									</a>
								{/each}
							</div>
						{/if}
					{/if}
				{:else}
					{#if drillNotice}
						<p class="notice" data-testid="unified-drill-notice">{drillNotice}</p>
					{/if}
					<div class="ctx">
						<h2 tabindex="-1">{ALL_SCOPE_CHIPS.find((chip) => chip.id === scope)?.label ?? 'Library'}</h2>
						{#if scope !== 'most-played'}
							<span class="n mono" data-testid="unified-summary">
								<!-- No truncation notice: Roon's roots are read whole or not at
								     all, so a partial listing is never published. -->
								{scopeSummary}
							</span>
						{/if}
						{#if sortMenu}
							<div class="sortc-wrap" bind:this={collectionSortWrap}>
								<button
									type="button"
									class="sortc"
									data-testid="unified-sort"
									aria-haspopup="menu"
									aria-expanded={sortOpen}
									onclick={() => (sortOpen = !sortOpen)}
								>
									Sort: <b>{sortMenu.find((option) => option.id === sortValue)?.label ?? ''}</b>
									<span style="color:var(--dim)">▾</span>
								</button>
								<div class="smenu" class:open={sortOpen}>
									{#each sortMenu as option (option.id)}
										<button
											type="button"
											class="so"
											class:on={option.id === sortValue}
											class:dis={option.disabledReason !== undefined}
											disabled={option.disabledReason !== undefined}
											title={option.disabledReason}
											data-testid="unified-sort-option-{option.id}"
											onclick={() => {
												setSort(option.id);
												sortOpen = false;
											}}
										>
											{option.label}{#if option.disabledReason}<span class="why"
												>{option.disabledReason}</span
											>{/if}
										</button>
									{/each}
								</div>
							</div>
						{/if}
					</div>
					{#key `${scope}:${shuffleSeed}`}
						<UnifiedScopeViews
							{scope}
							artists={listArtists}
							albums={listAlbums}
							sorts={viewSorts}
							randomSeed={shuffleSeed}
							{railTarget}
							genres={$genresStore}
							recent={$recentStore}
						onDrill={(target) => void openDrill(target)}
						onOpenLiveArtist={openLiveArtist}
						onOpenLiveAlbum={openLiveAlbum}
						{hrefForArtist}
						{hrefForAlbum}
						{hrefForDrill}
						/>
					{/key}
				{/if}
				</div>
			{:else}
				<p class="status">Idle.</p>
			{/if}
		</div>
	</div>

	{#if paletteOpen && selectedSong}
		<UnifiedTrackPage
			song={selectedSong}
			zoneId={actionZoneId}
			busy={songActionState.phase === 'executing'}
			error={songActionState.resultId === selectedSong.resultId ? songActionState.error : null}
			relationshipPhase={songRelationship.resultId === selectedSong.resultId
				? songRelationship.phase
				: 'idle'}
			relationship={songRelationship.resultId === selectedSong.resultId
				? songRelationship.relationship
				: null}
			relationshipError={songRelationship.resultId === selectedSong.resultId
				? songRelationship.error
				: null}
			onBack={backToPaletteResults}
			onClose={closePalette}
			onAction={songActionState.resultId === selectedSong.resultId &&
			songActionState.authorityRetired
				? undefined
				: beginSongAction}
			onFavorite={() => void favoriteSong()}
			favoriteBusy={songFavoriteBusy}
			favoriteStatus={songFavoriteStatus}
			onOpenComposer={openSongComposer}
		/>
	{:else if paletteOpen}
		<UnifiedPalette
			{roots}
			genres={$genresStore}
			composers={$composersStore}
			searchStore={paletteSearchStore}
			bind:query={paletteQuery}
			bind:selectedRowId={paletteSelectedRowId}
			onClose={closePalette}
			onDrill={paletteDrill}
			onOpenLiveArtist={paletteOpenLiveArtist}
			onOpenLiveAlbum={paletteOpenLiveAlbum}
			onSong={paletteSong}
			onBrowseResult={paletteBrowseResult}
			onBrowseCategory={paletteBrowseCategory}
			onApplyFilter={applySmartFilter}
			onSearch={paletteSearch}
		/>
	{/if}

	{#if browseActionState.phase !== 'idle' && browseActionState.source}
		<UnifiedBrowseActionSheet
			state={browseActionState}
			zoneId={actionZoneId}
			onAction={beginBrowseAction}
			onFavorite={() => void favoriteBrowseAction()}
			favoriteEnabled={!browseFavoriteBusy &&
				favoriteTypeForSource(browseActionState.source) !== null}
			favoriteStatus={browseFavoriteStatus}
			onClose={closeBrowseAction}
		/>
	{/if}
</section>

<style>
	.unified-library-mode {
		--unified-bg: var(--songr-bg);
		--unified-fg: var(--songr-text-high);
		--unified-dim: var(--songr-text-60);
		--unified-accent: var(--songr-unified-accent);
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.status {
		color: var(--unified-dim);
	}

	/* The shared surface sheet sets display on .body; the ri5-1 hidden
	   gate must still win while the search-track page is live. */
	.body[hidden] {
		display: none;
	}

	.ctab {
		padding: 4px 10px;
		border: 1px solid var(--songr-line);
		border-radius: 6px;
		background: transparent;
		color: var(--songr-soft);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.ctab.on {
		border-color: var(--unified-accent);
		color: var(--unified-fg);
	}
	.status.error {
		color: var(--songr-error);
	}

	.notice {
		color: var(--songr-soft);
		background: var(--songr-notice-bg);
		border: 1px solid var(--songr-line);
		border-radius: 8px;
		padding: 8px 12px;
	}

</style>
