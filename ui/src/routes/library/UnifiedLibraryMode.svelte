<script lang="ts">
	import { getContext, onMount, tick, untrack } from 'svelte';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type CommittedLibraryModeActivation,
		type LibraryModeActivationContext
	} from '$lib/libraryModeActivationContext';
	import {
		buildUnifiedLibraryPageState,
		type UnifiedCollectionDrillTarget,
		type UnifiedItemDetailTarget,
		type UnifiedItemTarget,
		type UnifiedLibraryDrillTarget,
		type UnifiedLibraryScope
	} from '$lib/libraryPageState';
	import { LibraryItemPageController } from '$lib/library/LibraryItemPageController';
	import {
		expectSelfAuthoredLibraryPageState,
		pushLibraryPageState,
		replaceLibraryPageState
	} from '$lib/libraryPageNavigation';
	import { fetchCatalogStatus, loadCatalogArtistAlbums } from '$lib/api/client';
	import {
		classicBrowseSessionClient,
		type ClassicBrowseSessionClaim
	} from '$lib/stores/classicBrowseSessionStore';
	import {
		libraryIndexStore,
		loadLibraryIndex,
		resetLibraryIndex,
		bucketLetterFor,
		compareLibrarySearchKeys,
		groupLibraryAlbums,
		librarySortKey,
		reconcileBrowseAlbumsToCatalog,
		type LetterBucket,
		type LibraryAlbumEntry
	} from '$lib/stores/libraryIndexStore';
	import { unifiedDrillStore } from '$lib/stores/unifiedDrillStore';
	import { openSettingsMenu, settingsMenuOpen } from '$lib/stores/settingsMenuStore';
	import { foldCatalogNameKey, libraryAlbumEntryFromAlbumRef } from '$lib/catalogNameMatch';
	import {
		registerUnifiedLibraryDensityRequestHandler,
		unifiedLibraryPrefsStore,
		type SortableUnifiedScope,
		type UnifiedLibraryDensity
	} from '$lib/stores/unifiedLibraryPrefsStore';
	import {
		albumSortMenu,
		artistDrillSortMenu,
		ARTIST_SORT_MENU,
		genreDrillSortMenu,
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
	import { parseCountFilter } from '$lib/unifiedSmartFilters';
	import { loadRecentlyPlayed, recentlyPlayedStore } from '$lib/stores/recentlyPlayedStore';
	import { libraryScopeSlots, type ResolvedLibraryScopeSlots } from '@libraryFeatures';
	import type { ScopeActionTarget } from '$lib/libraryFeatures/scopeSlotContract';
	import { zonesStore } from '$lib/stores/zonesStore';
	import { getSocket } from '$lib/socket/client';
	import { getTabId } from '$lib/tabId';
	import {
		LibraryAlbumController,
		type LibraryAlbumSocket
	} from '$lib/library/LibraryAlbumController';
	import {
		EditorialItemController,
		type EditorialItemSocket
	} from '$lib/library/EditorialItemController';
	import { createCompositionBrowseController } from '$lib/library/CompositionBrowseController';
	import { UnifiedSongActionController } from '$lib/library/UnifiedSongActionController';
	import { PublicSongActionController } from '$lib/library/PublicSongActionController';
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
	import UnifiedScopeViews from './UnifiedScopeViews.svelte';
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
	 * Most played rides the native play-feature gate; Recently
	 * added (Slice 5) rides the date-feature gate exactly like the
	 * release-year sort; Playlists (Slice 7) rides the BASE native
	 * capability (the playlist snapshot), not the date/play gates. Per the
	 * 2026-07-24 owner correction an unavailable chip is absent, never
	 * rendered disabled. Chip order is the build-v5 order: Most played,
	 * then Playlists, before Surprise me; Recently added last.
	 */
	const MOST_PLAYED_CHIP: ScopeChip = { id: 'most-played', label: 'Most played' };
	const PLAYLISTS_CHIP: ScopeChip = { id: 'playlists', label: 'Playlists' };
	const RECENTLY_ADDED_CHIP: ScopeChip = { id: 'recently-added', label: 'Recently added' };
	const ALL_SCOPE_CHIPS: readonly ScopeChip[] = [
		...LEADING_SCOPE_CHIPS,
		MOST_PLAYED_CHIP,
		PLAYLISTS_CHIP,
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
	/** Header wordmark: runic mark by default, Latin spelling once clicked. */
	let brandShowsLatin = $state(false);
	/** About panel: the only surface in this view carrying version provenance. */
	let aboutOpen = $state(false);
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
		indexStore = libraryIndexStore,
		loadIndex = loadLibraryIndex,
		resetIndex = resetLibraryIndex,
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
		mostPlayedStore = libraryScopeSlots.mostPlayedStore,
		loadMostPlayedData = libraryScopeSlots.loadMostPlayed,
		mostPlayedReset = libraryScopeSlots.resetMostPlayed,
		playlistsStore = libraryScopeSlots.playlistsStore,
		loadPlaylistsData = libraryScopeSlots.loadPlaylists,
		openPlaylistData = libraryScopeSlots.openPlaylist,
		closePlaylistView = libraryScopeSlots.closePlaylist,
		playlistsReset = libraryScopeSlots.resetPlaylists,
		scopeSlots = libraryScopeSlots,
		drillStore = unifiedDrillStore,
		fetchStatus = fetchCatalogStatus,
		hydrateArtistAlbums = loadCatalogArtistAlbums,
		fetchFn = fetch,
		albumController: suppliedAlbumController,
		editorialController: suppliedEditorialController,
		compositionController: suppliedCompositionController,
		songActionController: suppliedSongActionController,
		browseController: suppliedBrowseController,
		browseActionController: suppliedBrowseActionController,
		addFavoriteData = addFavorite,
		songRelationshipClient = unifiedSearchClient,
		albumActionController: suppliedAlbumActionController,
		playlistActionController: suppliedPlaylistActionController,
		getSocketClient = () => getSocket() as UnifiedConnectionSocket | null
	}: {
		sessionClient?: typeof classicBrowseSessionClient;
		indexStore?: typeof libraryIndexStore;
		loadIndex?: typeof loadLibraryIndex;
		resetIndex?: typeof resetLibraryIndex;
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
		mostPlayedStore?: ResolvedLibraryScopeSlots['mostPlayedStore'];
		loadMostPlayedData?: ResolvedLibraryScopeSlots['loadMostPlayed'];
		mostPlayedReset?: ResolvedLibraryScopeSlots['resetMostPlayed'];
		playlistsStore?: ResolvedLibraryScopeSlots['playlistsStore'];
		loadPlaylistsData?: ResolvedLibraryScopeSlots['loadPlaylists'];
		openPlaylistData?: ResolvedLibraryScopeSlots['openPlaylist'];
		closePlaylistView?: ResolvedLibraryScopeSlots['closePlaylist'];
		playlistsReset?: ResolvedLibraryScopeSlots['resetPlaylists'];
		/**
		 * The extended scope views this build carries, forwarded to
		 * UnifiedScopeViews. Injected by tests that need the surface a build
		 * without those views produces.
		 */
		scopeSlots?: Pick<ResolvedLibraryScopeSlots, 'mostPlayedView' | 'playlistsView'>;
		drillStore?: typeof unifiedDrillStore;
		fetchStatus?: typeof fetchCatalogStatus;
		hydrateArtistAlbums?: typeof loadCatalogArtistAlbums;
		fetchFn?: typeof fetch;
		albumController?: LibraryAlbumController;
		editorialController?: EditorialItemController;
		compositionController?: ReturnType<typeof createCompositionBrowseController>;
		songActionController?: UnifiedSongActionController;
		browseController?: UnifiedBrowseController;
		browseActionController?: UnifiedBrowseActionController;
		addFavoriteData?: (fetchFn: typeof fetch, payload: AddFavoriteRequest) => Promise<void>;
		songRelationshipClient?: Pick<UnifiedSearchClient, 'relationship'>;
		albumActionController?: AlbumActionController;
		playlistActionController?: PublicSongActionController;
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
	// Item-page coordination (rich-item plan §5.2): its retirement hook is
	// the single place a replaced or closed page's read/action authority is
	// cancelled.
	const itemPageController = new LibraryItemPageController({
		onRetire: () => retireItemPageAuthority()
	});
	// Optional editorial enrichment for the live item page (plan Slice 3).
	// The page never waits on it; no transport or an unavailable feature
	// simply renders no editorial surface.
	const editorialItemController =
		untrack(() => suppliedEditorialController) ??
		new EditorialItemController({
			getSocket: () => getSocket() as unknown as EditorialItemSocket | null
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
	// Playlist-track actions resolve opaque source selections on demand. This
	// controller is separate from the album sheet's catalog action lease.
	const playlistActionController =
		untrack(() => suppliedPlaylistActionController) ??
		new PublicSongActionController();

	const activationContext = getContext<LibraryModeActivationContext | undefined>(
		LIBRARY_MODE_ACTIVATION_CONTEXT
	);

	let scope = $state<UnifiedLibraryScope>('artists');
	let railTarget = $state<LetterBucket | null>(null);
	/** Genre/composer album-list context (collection navigation). */
	let collectionDrill = $state<UnifiedCollectionDrillTarget | null>(null);
	let collectionRecordedHistory = false;
	/** First-class item page over the scope/collection context. */
	let itemTarget = $state<UnifiedItemTarget | null>(null);
	let itemRecordedHistory = false;
	/**
	 * Live-pushed entry ownership for in-page child closes (ri8-1): a
	 * child that pushed its own entry in this session exits by
	 * traversing back to the parent entry instead of rewriting its own
	 * into a duplicate. Restored children never claim this — their
	 * neighbouring entries are unknown.
	 */
	let trackChildOwnsEntry = false;
	let compositionSurfaceOwnsEntry = false;
	let openCompositionOwnsEntry = false;
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
	/**
	 * Roon-authoritative discography for the drilled artist, loaded through
	 * the binding endpoint (plan: .agents/plans/artist-drill-binding.md).
	 * The local index join is only the instant/offline fallback — display
	 * strings are never the primary artist↔album join.
	 */
	let drillArtistOverlay = $state<{
		artistLocalId: string;
		albums: LibraryAlbumEntry[];
		/** The Core had more albums than one page could carry (cr-1). */
		truncated: boolean;
	} | null>(null);
	let drillArtistOverlayPhase = $state<'idle' | 'loading' | 'failed'>('idle');
	let drillArtistOverlayFor = $state<string | null>(null);
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
	let lifecycleGeneration = 0;
	let resumed = $state(false);
	let connectionSocket: UnifiedConnectionSocket | null = null;
	let connectionListenersAttached = false;
	let recoveryGeneration: number | null = null;
	/** Session generation captured when the album sheet opened its read. */
	let sheetGeneration: number | null = null;
	let hydrationCoreId: string | null = null;
	let hydrationRevision: number | null = null;
	const hydratedAlbumLocalIds = new Set<string>();

	const sheetState = $derived($albumController);
	const songActionState = $derived($songActionController);
	const browseState = $derived($browseController);
	const browseActionState = $derived($browseActionController);
	const playlistActionState = $derived($playlistActionController);
	const sheetZones = $derived(
		$zonesStore.map((zone) => ({ zoneId: zone.zone_id, name: zone.display_name }))
	);

	const prefs = $derived($prefsStore);
	const index = $derived($indexStore);
	const favorites = $derived($favoritesDataStore);
	/**
	 * The native date-feature gate (Slice 4): the capability state machine's
	 * answer, carried on the catalog index. Unavailable means the
	 * release-year entries degrade to their pre-native presentation.
	 */
	const dateFeatureGate = $derived.by((): DateFeatureGate => {
		const capabilities = index.capabilities;
		return {
			available: capabilities.dateFeatures,
			...(capabilities.dateFeaturesDisabledReason !== undefined
				? { reason: capabilities.dateFeaturesDisabledReason }
				: {})
		};
	});
	/**
	 * The native play-feature gate: the capability state machine's
	 * play answer, carried on the catalog index like the date answer.
	 */
	const playFeatureGate = $derived.by((): DateFeatureGate => {
		const capabilities = index.capabilities;
		return {
			available: capabilities.playFeatures,
			...(capabilities.playFeaturesDisabledReason !== undefined
				? { reason: capabilities.playFeaturesDisabledReason }
				: {})
		};
	});
	/**
	 * The native playlist-feature gate (Slice 7): the BASE native
	 * capability answer (a compatible playlist snapshot), carried on the
	 * catalog index like the date/play answers. The date/play gates do
	 * NOT apply to the Playlists chip.
	 */
	const playlistFeatureGate = $derived.by((): DateFeatureGate => {
		const capabilities = index.capabilities;
		return {
			available: capabilities.playlistFeatures,
			...(capabilities.playlistFeaturesDisabledReason !== undefined
				? { reason: capabilities.playlistFeaturesDisabledReason }
				: {})
		};
	});
	/**
	 * The chip row, build-v5 order: Most played exists only while play
	 * features do, Playlists only while the base native capability serves
	 * the playlist snapshot, Recently added only while date features do.
	 */
	const scopeChips = $derived.by((): readonly ScopeChip[] => [
		...LEADING_SCOPE_CHIPS,
		...(playFeatureGate.available ? [MOST_PLAYED_CHIP] : []),
		...(playlistFeatureGate.available ? [PLAYLISTS_CHIP] : []),
		SURPRISE_CHIP,
		...(dateFeatureGate.available ? [RECENTLY_ADDED_CHIP] : [])
	]);
	/**
	 * A persisted chronological sort outlives the feature: when the date
	 * features drop away, rendering falls back to A–Z rather than showing a
	 * blank or dishonest ordering.
	 */
	function resolveAlbumOrder<T extends string>(sort: T): T | 'az' {
		return isChronologicalAlbumSort(sort) && !dateFeatureGate.available ? 'az' : sort;
	}
	const sortMenu = $derived(
		scope === 'albums' ? albumSortMenu(dateFeatureGate) : (SORT_MENUS[scope] ?? null)
	);
	const sortValue = $derived(
		sortMenu ? resolveAlbumOrder(prefs.sorts[scope as SortableUnifiedScope]) : null
	);
	const drillSortMenu = $derived(
		itemTarget?.kind === 'artist'
			? artistDrillSortMenu(dateFeatureGate)
			: collectionDrill?.kind === 'genre'
				? genreDrillSortMenu(dateFeatureGate)
				: null
	);
	const drillSortValue = $derived(
		itemTarget?.kind === 'artist'
			? resolveAlbumOrder(prefs.sorts.artist)
			: collectionDrill?.kind === 'genre'
				? resolveAlbumOrder(prefs.sorts.genre)
				: null
	);
	const drillViewSorts = $derived({
		...prefs.sorts,
		albums:
			itemTarget?.kind === 'artist'
				? resolveAlbumOrder(prefs.sorts.artist)
				: collectionDrill?.kind === 'genre'
					? resolveAlbumOrder(prefs.sorts.genre)
					: resolveAlbumOrder(prefs.sorts.albums)
	});
	const viewSorts = $derived({
		...prefs.sorts,
		albums: resolveAlbumOrder(prefs.sorts.albums)
	});
	const drillState = $derived($drillStore);
	const drillStoreAlbums = $derived.by((): LibraryAlbumEntry[] =>
		reconcileBrowseAlbumsToCatalog(drillState.albums, index.albums)
			.sort((left, right) => compareLibrarySearchKeys(left.searchKey, right.searchKey))
	);
	const drillRailBuckets = $derived.by((): readonly LetterBucket[] => {
		if (
			collectionDrill?.kind !== 'genre' ||
			itemTarget !== null ||
			!drillState.loaded ||
			drillSortValue === 'shuffle' ||
			drillSortValue === null ||
			isChronologicalAlbumSort(drillSortValue)
		) {
			return [];
		}
		const sorted = sortAlbums(drillStoreAlbums, drillSortValue, shuffleSeed);
		const buckets: LetterBucket[] = [];
		for (const [index, album] of sorted.entries()) {
			const searchKey =
				drillSortValue === 'by-artist' ? librarySortKey(album.artist) : album.searchKey;
			const letter = bucketLetterFor(searchKey);
			const last = buckets[buckets.length - 1];
			if (last?.letter === letter) last.count += 1;
			else buckets.push({ letter, start: index, count: 1 });
		}
		return buckets;
	});

	// ---- Most played (Slice 11) ----------------------------------------
	// One all-time snapshot carries native performers/releases by exact
	// listening time and selected-profile tracks by play count.
	const mostPlayed = $derived($mostPlayedStore);

	/** Header count, verbatim per approved prototype `head(...)` calls. */
	const scopeSummary = $derived.by(() => {
		switch (scope) {
			case 'artists':
				return `${index.artists.length.toLocaleString()} TOTAL`;
			case 'albums':
				return `${index.albums.length.toLocaleString()} TOTAL`;
			case 'genres':
				return `${$genresStore.totalCount.toLocaleString()} TOTAL`;
			case 'recently-played':
				return `${$recentStore.entries.length} TRACKS`;
			case 'most-played':
				return '';
			case 'recently-added':
				return `${index.albums.length.toLocaleString()} TOTAL`;
			case 'playlists':
				return `${$playlistsStore.playlists.length.toLocaleString()} TOTAL`;
			case 'surprise':
				return `RANDOM FROM ${index.albums.length.toLocaleString()}`;
			default:
				return '';
		}
	});
	const railBuckets = $derived.by((): readonly LetterBucket[] => {
		if (index.phase !== 'ready') return [];
		if (collectionDrill?.kind === 'genre' && itemTarget === null) return drillRailBuckets;
		if (scope === 'albums' && sortValue === 'by-artist') {
			const buckets: LetterBucket[] = [];
			for (const [position, album] of sortAlbums(index.albums, 'by-artist', shuffleSeed).entries()) {
				const letter = bucketLetterFor(librarySortKey(album.artist));
				const last = buckets[buckets.length - 1];
				if (last?.letter === letter) last.count += 1;
				else buckets.push({ letter, start: position, count: 1 });
			}
			return buckets;
		}
		const base =
			scope === 'artists'
				? index.artistBuckets
				: scope === 'albums'
					? index.albumBuckets
					: scope === 'genres'
						? namedCountBuckets($genresStore.entries)
						: [];
		if (base.length === 0 || sortValue !== 'za') return base;
		// ZA rail reversal: mirror the A–Z buckets onto the reversed list
		// so each letter still addresses exactly its entries (slice 5).
		const total =
			scope === 'artists'
				? index.artists.length
				: scope === 'albums'
					? index.albums.length
					: $genresStore.entries.length;
		return reverseBuckets(base, total);
	});
	const railItemCount = $derived(
		collectionDrill?.kind === 'genre' && itemTarget === null
			? drillStoreAlbums.length
			: scope === 'artists'
			? index.artists.length
			: scope === 'albums'
				? index.albums.length
				: scope === 'genres'
					? $genresStore.entries.length
				: 0
	);
	const railSortCompatible = $derived.by(() => {
		if (collectionDrill?.kind === 'genre' && itemTarget === null)
			return (
				drillSortValue !== null &&
				drillSortValue !== 'shuffle' &&
				!isChronologicalAlbumSort(drillSortValue)
			);
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
			(collectionDrill === null || collectionDrill.kind === 'genre') &&
			filterText === '' &&
			railSortCompatible &&
			railBuckets.length >= RAIL_MIN_LETTERS &&
			railItemCount >= RAIL_MIN_ITEMS
	);

	// ---- Smart-filter page (plan §3.2 slice 7) ------------------------
	// The parsed spec re-derives from persisted text on every render, so
	// a restored page re-validates instead of trusting stale results.
	const filterSpec = $derived(filterText === '' ? null : parseCountFilter(filterText));
	const filterArtists = $derived.by(() => {
		if (!filterSpec || index.phase !== 'ready' || !index.capabilities.countFilters) return [];
		const spec = filterSpec;
		return index.artists
			.filter((entry) => spec.test(entry.albumCount ?? 0))
			.sort(
				(a, b) =>
					(b.albumCount ?? 0) - (a.albumCount ?? 0) ||
					compareLibrarySearchKeys(a.searchKey, b.searchKey)
			);
	});

	// ---- Drills (plan §4 slice 5) -------------------------------------
	// Targets are semantic (artist localId or genre/composer label) per
	// UnifiedLibrarySnapshot; itemKeys are session-scoped and resolved
	// live. Album drills open the slice-6 sheet; inert until then.

	const drillArtist = $derived.by(() => {
		if (itemTarget?.kind !== 'artist' || index.phase !== 'ready') return null;
		const target = itemTarget;
		return index.artists.find((entry) => entry.id === target.localId) ?? null;
	});
	const drillAlbum = $derived.by(() => {
		if (itemTarget?.kind !== 'album' || index.phase !== 'ready') return null;
		const target = itemTarget;
		return (
			index.albums.find(
				(entry) =>
					entry.catalogLocalId === target.localId ||
					entry.id === target.localId ||
					entry.memberLocalIds?.includes(target.localId) === true
			) ?? null
		);
	});
	const drillAlbumArtistId = $derived.by(() => {
		if (!drillAlbum || index.phase !== 'ready') return null;
		if (
			drillAlbum.artistId &&
			index.artists.some((entry) => entry.id === drillAlbum.artistId)
		) {
			return drillAlbum.artistId;
		}
		const artistName = foldCatalogNameKey(drillAlbum.artist);
		if (!artistName) return null;
		return (
			index.artists.find((entry) => foldCatalogNameKey(entry.name) === artistName)?.id ??
			null
		);
	});
	const drillArtistAlbums = $derived.by((): LibraryAlbumEntry[] => {
		if (!drillArtist) return [];
		if (
			drillArtistOverlay !== null &&
			drillArtistOverlay.artistLocalId === drillArtist.catalogLocalId
		) {
			return drillArtistOverlay.albums;
		}
		// Fallback join while the authoritative discography loads (or when it
		// cannot): catalog binding first, folded display names second.
		const artistId = drillArtist.id;
		const artistName = foldCatalogNameKey(drillArtist.name);
		return index.albums.filter(
			(entry) =>
				entry.artistId === artistId ||
				(!entry.artistId && foldCatalogNameKey(entry.artist) === artistName)
		);
	});
	const drillArtistTruncated = $derived(
		drillArtistOverlay !== null &&
			drillArtistOverlay.artistLocalId === drillArtist?.catalogLocalId &&
			drillArtistOverlay.truncated
	);
	const collectionLabel = $derived(collectionDrill?.label ?? '');
	const collectionSummary = $derived(
		collectionDrill !== null && drillState.loaded
			? `${drillState.totalCount.toLocaleString()} ALBUMS`
			: ''
	);
	/**
	 * Back from an item page returns to its invoking context: the palette's
	 * search results, the collection drill, or the owning scope (§4.2).
	 */
	const itemBackLabel = $derived.by(() => {
		if (returnToPalette) return 'Search results';
		if (collectionDrill !== null) return collectionDrill.label;
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

	/** The revision the catalog will accept right now, read per attempt. */
	function expectedCatalogRevision(): number {
		return Math.max(index.revision ?? 1, hydrationRevision ?? index.revision ?? 1);
	}

	async function loadDrillArtistOverlay(artistLocalId: string): Promise<void> {
		const generation = lifecycleGeneration;
		if (hydrationCoreId !== index.coreId) {
			hydrationCoreId = index.coreId;
			hydrationRevision = index.revision;
			hydratedAlbumLocalIds.clear();
		}
		try {
			const response = await queueHydration(async () => {
				try {
					return await hydrateArtistAlbums(
						fetchFn,
						artistLocalId,
						expectedCatalogRevision(),
						// Ask for everything the contract allows; the default page
						// size would silently cut a large discography (cr-1).
						CATALOG_ARTIST_ALBUMS_MAX_LIMIT
					);
				} catch {
					// Something published between reading the revision and using
					// it. When that was an EXTERNAL refresh, neither our own
					// hydrationRevision nor the store's index revision has moved
					// yet, so re-deriving locally would just resend the rejected
					// value. Ask the Core what the revision is now and retry
					// against that (cr-2).
					const current = await fetchStatus(fetchFn);
					if (current.coreId !== index.coreId) throw new Error('Catalog Core changed');
					hydrationRevision = current.revision;
					return await hydrateArtistAlbums(
						fetchFn,
						artistLocalId,
						current.revision,
						CATALOG_ARTIST_ALBUMS_MAX_LIMIT
					);
				}
			});
			if (generation !== lifecycleGeneration || response.status.coreId !== index.coreId) return;
			hydrationRevision = response.status.revision;
			for (const bound of response.albums) {
				if (bound.resolutionStatus === 'resolved') hydratedAlbumLocalIds.add(bound.localId);
			}
			if (drillArtistOverlayFor !== artistLocalId) return;
			drillArtistOverlay = {
				artistLocalId,
				albums: groupLibraryAlbums(response.albums.map(libraryAlbumEntryFromAlbumRef)),
				truncated: response.truncated === true
			};
			drillArtistOverlayPhase = 'idle';
		} catch {
			// The fallback join keeps rendering; the failed phase only stops
			// retries and lets the empty state say "could not load" honestly.
			if (generation !== lifecycleGeneration) return;
			if (drillArtistOverlayFor === artistLocalId) drillArtistOverlayPhase = 'failed';
		}
	}

	// Kick the authoritative discography load whenever an artist drill is
	// open against a ready catalog index and no overlay (or unfinished
	// attempt) exists for that artist. Covers openDrill, semantic
	// restoration, and an index that becomes ready after the drill opened.
	$effect(() => {
		if (itemTarget?.kind !== 'artist' || !drillArtist) return;
		if (index.source !== 'catalog' || index.coreId === null || index.revision === null) return;
		const artistLocalId = drillArtist.catalogLocalId;
		if (artistLocalId === undefined) return;
		if (drillArtistOverlay?.artistLocalId === artistLocalId) return;
		if (drillArtistOverlayFor === artistLocalId && drillArtistOverlayPhase !== 'idle') return;
		drillArtistOverlayFor = artistLocalId;
		drillArtistOverlayPhase = 'loading';
		void loadDrillArtistOverlay(artistLocalId);
	});

	function resetPaneAfterRender(): void {
		void tick().then(() => {
			if (!pane) return;
			pane.style.scrollBehavior = 'auto';
			pane.scrollTop = 0;
			pane.style.removeProperty('scroll-behavior');
		});
	}

	function unifiedSemanticState(density: UnifiedLibraryDensity = prefs.density) {
		return buildUnifiedLibraryPageState({
			scope,
			collectionDrill,
			itemTarget,
			// The exact-track child is reconstructible product semantics
			// (album localId + zero-based index, Slice 8); opaque follow
			// destinations are deliberately never persisted.
			itemDetail:
				itemTarget?.kind === 'album' && editorialTrackIndex !== null
					? { kind: 'track', trackIndex: editorialTrackIndex }
					: null,
			// The composition surface persists by composer context + exact
			// title intent (Slice 8); live browse keys never persist, and
			// nested recording pages restore to their top composition.
			composition:
				collectionDrill?.kind === 'composer' && compositionMode
					? { title: openCompositionTitle }
					: null,
			filterText,
			surpriseSeed: scope === 'surprise' ? shuffleSeed : null,
			density,
			browseHistory: browseState.snapshot
		});
	}

	/** Returns whether a new entry was actually pushed (dedupe may skip). */
	function pushUnifiedSemanticState(density?: UnifiedLibraryDensity): boolean {
		return pushLibraryPageState(unifiedSemanticState(density));
	}

	/**
	 * Routes the legacy drill union: artist/album destinations are item
	 * pages, genre/composer destinations are collection drills (§4.1).
	 * Scope views and the palette still speak the union.
	 */
	async function openDrill(
		target: UnifiedLibraryDrillTarget,
		recordHistory = true,
		albumOptions?: {
			readonly songFocusTitle?: string;
		}
	): Promise<void> {
		// Palette-owned views are nested search views, not semantic history
		// entries; every descendant they navigate to inherits that (ri1-2) —
		// otherwise the palette-return close leaves a phantom entry behind.
		const record = recordHistory && !returnToPalette;
		if (target.kind === 'album' || target.kind === 'artist') {
			await openItemPage(target, record, albumOptions);
			return;
		}
		await openCollectionDrill(target, record);
	}

	/** Each item transition pushes exactly one history entry (§4.2). */
	async function openItemPage(
		target: UnifiedItemTarget,
		recordHistory = true,
		albumOptions?: {
			readonly songFocusTitle?: string;
		}
	): Promise<void> {
		railTarget = null;
		itemRecordedHistory = recordHistory;
		trackChildOwnsEntry = false;
		// Captured for every open: an in-place close (no history entry)
		// returns focus to the invoking row/tile when it is still mounted.
		itemInvoker =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (itemTarget === null) itemReturnScrollTop = pane?.scrollTop ?? 0;
		drillNotice = null;
		if (target.kind === 'album') {
			albumSongFocusTitle = albumOptions?.songFocusTitle ?? null;
			itemTarget = target;
			const pageGeneration = itemPageController.open(target);
			openEditorialForTarget(target, pageGeneration);
			if (recordHistory) pushUnifiedSemanticState();
			resetPaneAfterRender();
			await openAlbumRead(target.localId, pageGeneration);
			return;
		}
		albumSongFocusTitle = null;
		// Validity is derived at render time so restoration can begin
		// before the index is ready; a missing artist renders the
		// missing-entity page state.
		itemTarget = target;
		const pageGeneration = itemPageController.open(target);
		openEditorialForTarget(target, pageGeneration);
		if (recordHistory) pushUnifiedSemanticState();
		resetPaneAfterRender();
	}

	/**
	 * The live opaque follow destination (ri4-3): retained so a failed
	 * follow retries the performer the user asked for, not the parent.
	 * Cleared by every anchor open and by the explicit back control.
	 */
	let editorialFollowTarget = $state<string | null>(null);
	/**
	 * The live exact-track anchor (Slice 5), retained like the follow
	 * target so retry re-reads the track the user asked for.
	 */
	let editorialTrackIndex: number | null = null;

	/**
	 * A restored exact-track child index (Slice 8): consumed once by the
	 * album page when its single-version track order arrives; cleared by
	 * every fresh anchor open.
	 */
	let restoredTrackInfoIndex = $state<number | null>(null);

	/** Starts the optional editorial read for the just-opened item page. */
	function openEditorialForTarget(target: UnifiedItemTarget, generation: number): void {
		editorialFollowTarget = null;
		editorialTrackIndex = null;
		restoredTrackInfoIndex = null;
		void editorialItemController.open({
			anchor:
				target.kind === 'album'
					? { kind: 'album', albumLocalId: target.localId }
					: { kind: 'artist', artistLocalId: target.localId },
			tabId: getTabId(),
			generation
		});
	}

	/** Opens exact-track credits for the live album page (Slice 5). */
	function openEditorialTrack(trackPosition: number): void {
		const target = itemTarget;
		const current = itemPageController.current;
		if (target?.kind !== 'album' || current.target === null) return;
		// A consume of the restored child re-lands on the SAME history
		// entry (Slice 8): it must not push a duplicate chain step.
		const restoredConsume = restoredTrackInfoIndex === trackPosition;
		restoredTrackInfoIndex = null;
		editorialFollowTarget = null;
		editorialTrackIndex = trackPosition;
		void editorialItemController.open({
			anchor: {
				kind: 'track',
				albumLocalId: target.localId,
				trackIndex: trackPosition
			},
			tabId: getTabId(),
			generation: current.generation
		});
		// The exact-track child is a page-chain step (Slice 8): one
		// semantic entry per transition, restored by album + index. A
		// transient parent (palette-opened, ri1-2) owns no semantic entry,
		// so its children must not create one either (ri8-1). A restored
		// child re-landed on an entry whose neighbours are unknown, so it
		// never claims live-pushed ownership. A RETRY of the same child
		// dedupes the push against the child's own entry — claimed
		// ownership survives that (ri8-1 reopen).
		const pushed =
			!restoredConsume && itemRecordedHistory && pushUnifiedSemanticState();
		trackChildOwnsEntry = pushed || (trackChildOwnsEntry && !restoredConsume);
	}


	/** Retries the live editorial destination: follow, track, or anchor. */
	function retryEditorial(): void {
		const target = itemTarget;
		const current = itemPageController.current;
		if (!target || current.target === null) return;
		const followTarget = editorialFollowTarget;
		if (followTarget !== null) {
			void editorialItemController.follow({
				target: followTarget,
				tabId: getTabId(),
				generation: current.generation
			});
			return;
		}
		const trackIndex = editorialTrackIndex;
		if (trackIndex !== null) {
			openEditorialTrack(trackIndex);
			return;
		}
		openEditorialForTarget(target, current.generation);
	}

	/** Follows an opaque editorial child target (plan Slice 4). */
	function followEditorial(target: string): void {
		const current = itemPageController.current;
		if (current.target === null) return;
		editorialFollowTarget = target;
		void editorialItemController.follow({
			target,
			tabId: getTabId(),
			generation: current.generation
		});
	}

	// A terminal (non-retryable) WHOLE-READ follow failure has no
	// destination left: the parent view was cleared when the follow
	// started, no child arrived, and no child Back control can render.
	// Fall back to the reconstructible parent destination instead of
	// stranding the surface (ri7-3). A retained view means the failure was
	// section-scoped on a delivered child — that child stays (ri4-1/ri4-2)
	// — and retryable failures keep the target for target-aware retry
	// (ri4-3).
	$effect(() => {
		const state = $editorialItemController;
		if (
			editorialFollowTarget !== null &&
			state.phase === 'failed' &&
			!state.retryable &&
			state.view === null
		) {
			editorialFollowTarget = null;
			retryEditorial();
		}
	});

	/** Composition surface state (plan Slice 6). */
	const compositionBrowseController =
		untrack(() => suppliedCompositionController) ?? createCompositionBrowseController();
	const compositionState = $derived($compositionBrowseController);
	let compositionMode = $state(false);
	/**
	 * The exact composition title the user asked to open (Slice 8): the
	 * persistable intent, set synchronously at the list click and consumed
	 * by restoration once the composition list arrives. Never a browse key.
	 */
	let openCompositionTitle = $state<string | null>(null);
	let pendingCompositionAction = $state<{ title: string; itemKey: string } | null>(null);

	function toggleCompositionMode(restore: { title: string | null } | null = null): void {
		const drill = collectionDrill;
		if (drill?.kind !== 'composer') return;
		if (compositionMode) {
			// Live-pushed surface/composition entries are traversed away in
			// one step; a restored surface rewrites its entry; a transient
			// drill's base entry stays untouched (ri8-1).
			const traversalSteps =
				(openCompositionOwnsEntry ? 1 : 0) + (compositionSurfaceOwnsEntry ? 1 : 0);
			openCompositionOwnsEntry = false;
			compositionSurfaceOwnsEntry = false;
			compositionMode = false;
			pendingCompositionAction = null;
			openCompositionTitle = null;
			compositionBrowseController.reset();
			if (traversalSteps > 0) {
				expectSelfAuthoredLibraryPageState(unifiedSemanticState());
				window.history.go(-traversalSteps);
			} else if (collectionRecordedHistory) {
				// The current entry no longer describes the surface (Slice 8).
				replaceLibraryPageState(unifiedSemanticState());
			}
			return;
		}
		compositionMode = true;
		openCompositionTitle = null;
		restoreCompositionTitle = restore?.title ?? null;
		const activeClaim = claim;
		if (!activeClaim) return;
		void compositionBrowseController.openForComposer(activeClaim, drill.label);
		// Entering the surface is a page-chain step; a restore re-lands on
		// the entry that already describes it (Slice 8), and a transient
		// drill (palette-opened, ri1-2) records no entries at all (ri8-1).
		compositionSurfaceOwnsEntry =
			restore === null && collectionRecordedHistory && pushUnifiedSemanticState();
	}

	function leaveCompositionSurface(): void {
		compositionMode = false;
		pendingCompositionAction = null;
		openCompositionTitle = null;
		compositionSurfaceOwnsEntry = false;
		openCompositionOwnsEntry = false;
		compositionBrowseController.reset();
	}

	/** A restored composition title awaiting its list (consume-once). */
	let restoreCompositionTitle = $state<string | null>(null);

	// Restoration consume (Slice 8): once the composition list arrives, a
	// restored title opens its composition only when it matches EXACTLY one
	// row — ambiguity or absence keeps the honest list view. The live click
	// path never routes through here.
	$effect(() => {
		const title = restoreCompositionTitle;
		if (!compositionMode || title === null) return;
		if (compositionState.phase !== 'compositions') return;
		const activeClaim = claim;
		if (!activeClaim) return;
		restoreCompositionTitle = null;
		const matches = compositionState.compositions.filter(
			(row) => row.title === title && row.itemKey
		);
		if (matches.length === 1) {
			openCompositionTitle = title;
			void compositionBrowseController.openComposition(activeClaim, matches[0]);
		} else {
			openCompositionTitle = null;
		}
	});

	function beginCompositionAction(action: { title: string; itemKey: string }): void {
		const activeClaim = claim;
		if (!activeClaim || sheetZones.length === 0) return;
		if (sheetZones.length === 1) {
			void compositionBrowseController.runAction(activeClaim, action, sheetZones[0].zoneId);
			pendingCompositionAction = null;
			return;
		}
		pendingCompositionAction = action;
	}

	function chooseCompositionZone(zoneId: string): void {
		const activeClaim = claim;
		const action = pendingCompositionAction;
		if (!activeClaim || !action) return;
		void compositionBrowseController.runAction(activeClaim, action, zoneId);
		pendingCompositionAction = null;
	}

	/**
	 * Leaves a followed performer or track child view: performer backs out
	 * to the surface it was followed FROM (a track's credits when one is
	 * live), a track backs out to the album's own anchor view.
	 */
	function backFromEditorialFollow(): void {
		if (editorialFollowTarget !== null) {
			editorialFollowTarget = null;
		} else {
			editorialTrackIndex = null;
			restoredTrackInfoIndex = null;
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
			} else if (itemRecordedHistory) {
				replaceLibraryPageState(unifiedSemanticState());
			}
		}
		retryEditorial();
	}

	async function openCollectionDrill(
		target: UnifiedCollectionDrillTarget,
		recordHistory = true
	): Promise<void> {
		railTarget = null;
		collectionRecordedHistory = recordHistory;
		// A collection destination replaces any open item page and any
		// live composition surface.
		leaveCompositionSurface();
		if (itemTarget !== null) resetItemPage(false);
		albumSongFocusTitle = null;
		drillNotice = null;
		const activeClaim = claim;
		if (!activeClaim) return;
		const generation = lifecycleGeneration;
		collectionDrill = target;
		if (recordHistory) pushUnifiedSemanticState();
		resetPaneAfterRender();
		const namedStore = target.kind === 'genre' ? genresStore : composersStore;
		let snapshot = target.kind === 'genre' ? $genresStore : $composersStore;
		if (!snapshot.loaded) {
			await namedStore.load(activeClaim);
			if (generation !== lifecycleGeneration) return;
			snapshot = target.kind === 'genre' ? $genresStore : $composersStore;
		}
		const entry = snapshot.entries.find((candidate) => candidate.label === target.label);
		if (!entry) {
			// Semantic restoration rule: zero matches → parent with notice.
			collectionDrill = null;
			drillNotice = `“${target.label}” is not in this library any more.`;
			return;
		}
		void drillStore.load(
			activeClaim,
			target.kind === 'genre' ? 'genres' : 'composers',
			target.label
		);
	}

	/** Cancels the live page's read and action authority. */
	function retireItemPageAuthority(): void {
		albumController.cancel();
		albumController.reset();
		sheetActionController.cancel();
		editorialItemController.cancel();
		sheetGeneration = null;
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
		albumSongFocusTitle = null;
		itemTarget = null;
		itemRecordedHistory = false;
		trackChildOwnsEntry = false;
		drillArtistOverlay = null;
		drillArtistOverlayPhase = 'idle';
		drillArtistOverlayFor = null;
		const invoker = itemInvoker;
		itemInvoker = null;
		const returnScrollTop = itemReturnScrollTop;
		itemReturnScrollTop = 0;
		// In-place closes restore the return context here; pop-backed closes
		// park it instead (backFromItem) and the resume applies it, so this
		// restore must not mask a broken pop path (ri1-4).
		if (!restoreFocus) return;
		void tick().then(() => {
			if (!pane) return;
			pane.style.scrollBehavior = 'auto';
			pane.scrollTop = returnScrollTop;
			pane.style.removeProperty('scroll-behavior');
		});
		void tick().then(() => {
			if (invoker?.isConnected) {
				invoker.focus();
				return;
			}
			pane?.querySelector<HTMLElement>('.ctx h2')?.focus?.();
		});
	}

	function resetCollectionDrill(): void {
		collectionDrill = null;
		collectionRecordedHistory = false;
		drillNotice = null;
		drillStore.reset();
	}

	/** Resets both navigation layers (scope switches, suspend). */
	function resetDrill(): void {
		const resetPane = itemTarget === null;
		resetItemPage(false);
		resetCollectionDrill();
		if (resetPane) resetPaneAfterRender();
	}

	function backFromItem(): void {
		const shouldReturnToPalette = returnToPalette;
		const shouldPopHistory = itemRecordedHistory;
		if (shouldPopHistory) pendingPopReturnScrollTop = itemReturnScrollTop;
		resetItemPage(!shouldPopHistory && !shouldReturnToPalette);
		if (shouldReturnToPalette) {
			returnToPalette = false;
			selectedSong = null;
			resetSongRelationship();
			paletteOpen = true;
			return;
		}
		if (shouldPopHistory) window.history.back();
	}

	function backFromCollection(): void {
		const shouldReturnToPalette = returnToPalette;
		const shouldPopHistory = collectionRecordedHistory;
		resetCollectionDrill();
		resetPaneAfterRender();
		if (shouldReturnToPalette) {
			returnToPalette = false;
			selectedSong = null;
			resetSongRelationship();
			paletteOpen = true;
			return;
		}
		if (shouldPopHistory) window.history.back();
	}

	function openAlbumArtist(): void {
		const artistId = drillAlbumArtistId;
		if (!artistId) return;
		void openItemPage({ kind: 'artist', localId: artistId }, !returnToPalette);
	}

	/**
	 * Opens (or chooser-retries) the album sheet's keyless read against the
	 * live session generation. Stale lifecycles abandon the result unused.
	 */
	async function hydrateUnresolvedAlbum(
		albumLocalId: string,
		generation: number
	): Promise<void> {
		const album = index.albums.find((entry) => entry.catalogLocalId === albumLocalId);
		if (
			!album ||
			album.resolutionStatus !== 'unresolved' ||
			hydratedAlbumLocalIds.has(albumLocalId) ||
			index.source !== 'catalog' ||
			index.coreId === null ||
			index.revision === null
		) {
			return;
		}

		if (hydrationCoreId !== index.coreId) {
			hydrationCoreId = index.coreId;
			hydrationRevision = index.revision;
			hydratedAlbumLocalIds.clear();
		}
		const normalizedArtist = normalizeCatalogText(album.artist);
		const artists = index.artists.filter(
			(entry) =>
				entry.catalogLocalId !== undefined &&
				normalizeCatalogText(entry.name) === normalizedArtist
		);
		// Artist hydration is authoritative only for one exact catalog identity.
		if (normalizedArtist.length === 0 || artists.length !== 1) return;

		try {
			// Same queue as the drill overlay: both gate on the catalog revision
			// and must not race each other (cr-2).
			const response = await queueHydration(() =>
				hydrateArtistAlbums(fetchFn, artists[0].catalogLocalId!, expectedCatalogRevision())
			);
			if (generation !== lifecycleGeneration || response.status.coreId !== index.coreId) return;
			hydrationRevision = response.status.revision;
			for (const resolved of response.albums) {
				if (resolved.resolutionStatus === 'resolved') {
					hydratedAlbumLocalIds.add(resolved.localId);
				}
			}
		} catch {
			// The read protocol will surface its normal fail-closed error.
		}
	}

	async function openAlbumRead(
		albumLocalId: string,
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
		await hydrateUnresolvedAlbum(albumLocalId, generation);
		if (!pageIsCurrent()) return;
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
		sheetGeneration = ref.generation;
		albumController.open({
			albumLocalId,
			tabId,
			generation: ref.generation
		});
	}

	function retryAlbumPage(): void {
		if (itemTarget?.kind !== 'album') return;
		albumController.reset();
		void openAlbumRead(itemTarget.localId, itemPageController.current.generation);
	}

	function beginSheetAction(
		track: { index: number; title: string } | null,
		zoneId: string,
		desiredSemantic: AlbumActionSemantic
	): void {
		if (
			itemTarget?.kind !== 'album' ||
			sheetGeneration === null ||
			!sheetState.operationId ||
			!sheetState.selectedVersionId ||
			!sheetState.actionsAvailable
		) {
			return;
		}
		let tabId: string;
		try {
			tabId = getTabId();
		} catch {
			return;
		}
		sheetActionController.begin({
			pageId: sheetState.operationId,
			versionId: sheetState.selectedVersionId,
			zoneId,
			tabId,
			generation: sheetGeneration,
			...(track ? { track } : {}),
			desiredSemantic
		});
	}

	/**
	 * Playlist and Most Played rows carry the same opaque source authority.
	 * Clearing the palette store synchronously fences any in-flight search
	 * before the resolver's shared classic-search generation is claimed.
	 */
	function beginPublicSongAction(
		target: ScopeActionTarget,
		zoneId: string,
		desiredSemantic: UnifiedSongActionSemantic
	): void {
		const activeClaim = claim;
		if (!activeClaim) return;
		classicSearchOwnerGeneration += 1;
		paletteOpen = false;
		paletteQuery = '';
		paletteSelectedRowId = null;
		selectedSong = null;
		returnToPalette = false;
		songActionController.reset();
		resetSongRelationship();
		resetPaletteSearchData();
		playlistActionController.begin({
			claim: activeClaim,
			authority: target.authority,
			zoneId,
			semantic: desiredSemantic
		});
	}

	function clearPublicSongAction(): void {
		if (playlistActionState.phase !== 'executing') {
			const displacedResolver = playlistActionState.phase !== 'idle';
			playlistActionController.cancel();
			playlistActionController.reset();
			if (displacedResolver) startPaletteAuthorityRetirement();
		}
	}

	function closePlaylistWithResolverCleanup(): void {
		clearPublicSongAction();
		closePlaylistView();
	}

	function openMostPlayedAlbum(albumLocalId: string): void {
		clearPublicSongAction();
		void openDrill({ kind: 'album', localId: albumLocalId }, false);
	}

	function maybeLoadScopeData(next: UnifiedLibraryScope): void {
		// Genres page on the classic-explore role and needs the claim;
		// recently played and most played are plain REST fetches. All are
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
		} else if (next === 'most-played') {
			const stats = $mostPlayedStore;
			if (!stats.loaded && !stats.loading) void loadMostPlayedData(fetchFn);
		} else if (next === 'playlists') {
			const playlists = $playlistsStore;
			if (!playlists.loaded && !playlists.loading) void loadPlaylistsData(fetchFn);
		}
	}

	function setScope(next: UnifiedLibraryScope): void {
		if (next !== scope) clearPublicSongAction();
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
		scope = next;
		railTarget = null;
		filterText = '';
		resetDrill();
		maybeLoadScopeData(next);
		resetPaneAfterRender();
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
		if (!resumed || playlistActionState.phase === 'executing') return;
		browseActionController.reset();
		browseActionFromPalette = false;
		browseFavoriteStatus = null;
		classicSearchOwnerGeneration += 1;
		const displacedResolver = playlistActionState.phase !== 'idle';
		playlistActionController.cancel();
		if (displacedResolver) {
			// Never remount cached song IDs after resolver ownership. The next
			// eligible query must run a fresh palette search generation.
			playlistActionController.reset();
			resetPaletteSearchData();
			startPaletteAuthorityRetirement();
		}
		paletteQuery = seedText;
		paletteSelectedRowId = null;
		selectedSong = null;
		resetSongRelationship();
		returnToPalette = false;
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

	$effect(() => {
		const pending = $pendingLibraryIntentStore;
		if (
			!resumed ||
			!pending ||
			pending.intent.destination !== 'search' ||
			playlistActionState.phase === 'executing'
		) {
			return;
		}
		const intent = claimLibraryIntent(pending.requestId);
		if (intent?.destination === 'search') openPalette(intent.query);
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
			sheetZones[0]?.zoneId
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
					sheetZones[0]?.zoneId
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

	function openSongAlbum(candidate: UnifiedSongAlbumRelationship): void {
		const relationship = songRelationship.relationship;
		if (
			songRelationship.phase !== 'ready' ||
			!relationship ||
			!relationship.albums.some(
				(album) => album.albumLocalId === candidate.albumLocalId
			)
		) {
			return;
		}
		leaveSongPanelForDrill();
		void openDrill(
			{ kind: 'album', localId: candidate.albumLocalId },
			false,
			{
				songFocusTitle: relationship.songTitle
			}
		);
	}

	function openSongArtist(artistLocalId: string): void {
		const relationship = songRelationship.relationship;
		if (
			songRelationship.phase !== 'ready' ||
			!relationship ||
			!relationship.albums.some(
				(album) => album.artistLocalId === artistLocalId
			)
		) {
			return;
		}
		leaveSongPanelForDrill();
		void openDrill({ kind: 'artist', localId: artistLocalId }, false);
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
		if (
			playlistActionState.phase === 'resolving' ||
			playlistActionState.phase === 'choosing' ||
			playlistActionState.phase === 'executing'
		) {
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		const active =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		for (const el of [target, active]) {
			if (!el) continue;
			if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
				return;
			if (el.isContentEditable) return;
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

	function setSort(value: string): void {
		if (!sortMenu) return;
		// A persisted rail target indexes the previous ordering; drop it.
		railTarget = null;
		prefsStore.setSort(scope as SortableUnifiedScope, value);
	}

	function setDrillSort(value: string): void {
		const sortKey =
			itemTarget?.kind === 'artist'
				? 'artist'
				: collectionDrill?.kind === 'genre'
					? 'genre'
					: null;
		if (sortKey === null) return;
		railTarget = null;
		if (value === 'shuffle') shuffleSeed += 1;
		prefsStore.setSort(sortKey, value);
	}

	function setDensity(value: UnifiedLibraryDensity): boolean {
		const previous = prefs.density;
		if (value === previous) return false;
		// The root entry intentionally has no authoritative density. Capture
		// the actual current preference before creating the changed entry so
		// Back can restore it even on the first density change after reload.
		replaceLibraryPageState(unifiedSemanticState(previous));
		if (!prefsStore.setDensity(value)) return false;
		pushUnifiedSemanticState(value);
		return true;
	}

	function railJump(bucket: LetterBucket): void {
		// Scope views (slice 5) consume the jump target; the rule and the
		// target contract are owned here.
		railTarget = bucket;
	}

	async function loadForClaim(activeClaim: ClassicBrowseSessionClaim): Promise<void> {
		const generation = lifecycleGeneration;
		let coreId: string;
		try {
			const status = await fetchStatus(fetchFn);
			coreId = status.coreId;
		} catch {
			return;
		}
		if (generation !== lifecycleGeneration || claim !== activeClaim) return;
		await loadIndex(fetchFn, { coreId, claim: activeClaim });
	}

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
		playlistActionController.abandon();
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

	function resumeUnified(activation: CommittedLibraryModeActivation | null = null): void {
		lifecycleGeneration += 1;
		const pageState = activation?.pageState;
		let restoredCollection: UnifiedCollectionDrillTarget | null = null;
		let restoredItem: UnifiedItemTarget | null = null;
		let restoredDetail: UnifiedItemDetailTarget | null = null;
		let restoredComposition: { title: string | null } | null = null;
		if (pageState && pageState.libraryView === 'unified') {
			scope = pageState.snapshot.scope;
			browseController.reset(pageState.snapshot.browseHistory);
			restoredCollection = pageState.snapshot.collectionDrill;
			restoredItem = pageState.snapshot.itemTarget;
			restoredDetail = pageState.snapshot.itemDetail;
			restoredComposition = pageState.snapshot.composition;
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
		// Restored page state may land directly on a data-owning scope.
		maybeLoadScopeData(scope);
		// Semantic restoration: the collection context first, then the item
		// page over it; labels resolve against live data and zero matches
		// degrade to the parent with a notice.
		if (restoredCollection) {
			const composition = restoredComposition;
			void openCollectionDrill(restoredCollection, false).then(() => {
				// These already own the restored history entry even though
				// resume must not push a duplicate one.
				collectionRecordedHistory = true;
				// The composition surface restores over its composer drill
				// (Slice 8): the toggle re-enters without pushing, and the
				// consume effect resolves the exact title once the list
				// arrives.
				if (composition !== null && collectionDrill?.kind === 'composer') {
					toggleCompositionMode(composition);
				}
			});
		}
		if (restoredItem) {
			void openItemPage(restoredItem, false);
			itemRecordedHistory = true;
			// The exact-track child restores AFTER the album page opens: the
			// page consumes the index once its single-version track order
			// arrives, and a stale index simply keeps the parent (the
			// session-bound restoration rule, Slice 8).
			if (restoredItem.kind === 'album' && restoredDetail?.kind === 'track') {
				restoredTrackInfoIndex = restoredDetail.trackIndex;
			}
		}
		// A Back initiated from an item page returns to this entry: restore
		// the scroll captured at item open instead of the reset-to-top the
		// restoration paths run (ri1-4). Any other resume discards it.
		const parkedScroll = pendingPopReturnScrollTop;
		pendingPopReturnScrollTop = null;
		if (parkedScroll !== null && restoredItem === null) {
			void tick().then(() => {
				if (!pane) return;
				pane.style.scrollBehavior = 'auto';
				pane.scrollTop = parkedScroll;
				pane.style.removeProperty('scroll-behavior');
			});
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
		sheetActionController.cancel();
		albumController.cancel();
		albumController.reset();
		sheetGeneration = null;
		resetIndex();
		// Scope data is claim-scoped; a future resume gets a fresh claim.
		genresStore.reset();
		composersStore.reset();
		drillStore.reset();
		// Most played is snapshot-bound REST data; a future resume re-fetches
		// against the fresh capability answer (possibly a different Core).
		mostPlayedReset();
		// Playlists likewise: snapshot-bound list plus any open contents and
		// a pending playlist-track action.
		playlistsReset();
		playlistActionController.abandon();
		classicSearchOwnerGeneration += 1;
		itemPageController.close();
		itemTarget = null;
		itemRecordedHistory = false;
		trackChildOwnsEntry = false;
		itemInvoker = null;
		collectionDrill = null;
		collectionRecordedHistory = false;
		drillNotice = null;
		leaveCompositionSurface();
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
		<button
			type="button"
			class="findbtn"
			data-testid="unified-find"
			disabled={playlistActionState.phase === 'executing' ||
				browseActionState.phase !== 'idle'}
			onclick={() => openPalette('')}
		>
			<span>⚲</span> Search
			<span class="kbd mono">TYPE ANYWHERE</span>
		</button>
		<div class="spacer"></div>
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
		>
			<p class="ab-name">Sǫngr</p>
			<p class="ab-desc">web-based controller for Roon</p>
			<dl class="ab-rows">
				<dt>Connection</dt>
				<dd
					class:good={connectedGood}
					data-testid="unified-about-connection"
				>{connectedLabel}</dd>
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

	{#snippet drillSortControl()}
		{#if drillSortMenu && drillSortValue}
			<div class="sortc-wrap">
				<button
					type="button"
					class="sortc"
					data-testid="unified-drill-sort"
					aria-haspopup="menu"
					aria-expanded={sortOpen}
					onclick={() => (sortOpen = !sortOpen)}
				>
					Sort:
					<b
						>{drillSortMenu.find((option) => option.id === drillSortValue)?.label ??
							''}</b
					>
					<span style="color:var(--dim)">▾</span>
				</button>
				<div class="smenu" class:open={sortOpen}>
					{#each drillSortMenu as option (option.id)}
						<button
							type="button"
							class="so"
							class:on={option.id === drillSortValue}
							class:dis={option.disabledReason !== undefined}
							disabled={option.disabledReason !== undefined}
							title={option.disabledReason}
							data-testid="unified-drill-sort-option-{option.id}"
							onclick={() => {
								setDrillSort(option.id);
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
	{/snippet}

	{#snippet compositionSurface()}
		{@const composition = compositionState}
		{@const compositionPage = composition.pages[composition.pages.length - 1]}
		{#if composition.phase === 'loading' || composition.phase === 'idle'}
			<p class="status" data-testid="unified-composition-loading">Loading compositions…</p>
		{:else if composition.phase === 'failed'}
			<p class="status error" data-testid="unified-composition-error">
				{composition.notice ?? composition.error ?? 'Compositions could not be loaded.'}
			</p>
		{:else if composition.phase === 'page' && compositionPage}
			<div class="composition-page" data-testid="unified-composition-page">
				<button
					type="button"
					class="back"
					data-testid="unified-composition-back"
					onclick={async () => {
						pendingCompositionAction = null;
						const activeClaim = claim;
						if (!activeClaim) return;
						await compositionBrowseController.backToCompositions(activeClaim);
						// Only a genuine return to the list retires the persisted
						// composition intent; a nested pop keeps the parent page
						// visible and its restore target intact (ri8-2). A
						// live-pushed composition entry is traversed away, a
						// restored one rewritten, a transient drill untouched
						// (ri8-1).
						if (compositionState.phase === 'compositions') {
							openCompositionTitle = null;
							if (openCompositionOwnsEntry) {
								openCompositionOwnsEntry = false;
								expectSelfAuthoredLibraryPageState(unifiedSemanticState());
								window.history.back();
							} else if (collectionRecordedHistory) {
								replaceLibraryPageState(unifiedSemanticState());
							}
						}
					}}
				>
					← Back
				</button>
				<h3 data-testid="unified-composition-title">{compositionPage.title}</h3>
				{#if compositionPage.actions.length > 0}
					<div class="composition-actions" data-testid="unified-composition-actions">
						{#each compositionPage.actions as action, index (action.itemKey)}
							<button
								type="button"
								data-testid="unified-composition-action-{index}"
								disabled={composition.actionBusy || sheetZones.length === 0}
								onclick={() => beginCompositionAction(action)}
							>
								{action.title}
							</button>
						{/each}
					</div>
				{/if}
				{#if pendingCompositionAction && sheetZones.length > 1}
					<div class="zone-picker" data-testid="unified-composition-zone-picker">
						<span class="zone-label">{pendingCompositionAction.title} on</span>
						{#each sheetZones as zone (zone.zoneId)}
							<button type="button" onclick={() => chooseCompositionZone(zone.zoneId)}>{zone.name}</button>
						{/each}
						<button type="button" class="ghost" onclick={() => (pendingCompositionAction = null)}>Cancel</button>
					</div>
				{/if}
				<ul class="composition-rows" data-testid="unified-composition-recordings">
					{#each compositionPage.recordings as recording, index (index)}
						<li>
							{#if recording.itemKey}
								<button
									type="button"
									data-testid="unified-composition-recording-{index}"
									onclick={() => {
										const activeClaim = claim;
										if (activeClaim) void compositionBrowseController.openComposition(activeClaim, recording);
									}}
								>
									<span>{recording.title}</span>
									{#if recording.subtitle}<small>{recording.subtitle}</small>{/if}
								</button>
							{:else}
								<span class="composition-fact"
									>{recording.title}{recording.subtitle ? ` — ${recording.subtitle}` : ''}</span
								>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{:else}
			<ul class="composition-rows" data-testid="unified-composition-list">
				{#each composition.compositions as row, index (index)}
					<li>
						{#if row.itemKey}
							<button
								type="button"
								data-testid="unified-composition-row-{index}"
								onclick={() => {
									const activeClaim = claim;
									if (!activeClaim) return;
									void compositionBrowseController.openComposition(activeClaim, row);
									// The open composition is a persisted page-chain
									// step (Slice 8): exact title, never a browse key.
									// Transient drills record no entries (ri8-1).
									openCompositionTitle = row.title;
									openCompositionOwnsEntry =
										collectionRecordedHistory && pushUnifiedSemanticState();
								}}
							>
								<span>{row.title}</span>
								{#if row.subtitle}<small>{row.subtitle}</small>{/if}
							</button>
						{:else}
							<span class="composition-fact">{row.title}</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/snippet}

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
						class:on={scope === chip.id && !collectionDrill && !itemTarget && !filterText}
						aria-pressed={scope === chip.id}
						data-testid="unified-scope-{chip.id}"
						onclick={() => setScope(chip.id)}
					>
						{chip.label}
					</button>
				{/each}
				<!-- Workspaces this build provides, rendered exactly as given:
				     a build with none provides an empty list and this renders
				     nothing (no placeholder, no disabled chip). -->
				{#each libraryScopeSlots.workspaceLinks as link (link.href)}
					<a
						class="sc workspace-link"
						href={link.href}
						data-testid="unified-workspace-link"
						aria-label={link.description ?? link.label}
					>
						{link.label}
					</a>
				{/each}
			</nav>
			{#if !resumed}
				<p class="status">Suspended.</p>
			{:else if scope === 'browse' && collectionDrill === null && itemTarget === null}
				<UnifiedBrowseView
					state={browseState}
					onBack={browseBack}
					onForward={browseForward}
					onItem={browseItem}
					onLoadMore={browseLoadMore}
					onSearchPrompt={() => openPalette('')}
					/>
			{:else if scope === 'favorites' && collectionDrill === null && itemTarget === null}
				<UnifiedFavoritesView
					state={favorites as FavoritesState}
					busy={favoriteMutationBusy}
					status={favoritesStatus}
					onActivate={activateFavorite}
					onRemove={(favorite) => void removeFavoriteEntry(favorite)}
				/>
			{:else if index.phase === 'loading'}
				<p class="status" data-testid="unified-loading">Loading library…</p>
			{:else if index.phase === 'error'}
				<p class="status error" data-testid="unified-error">
					Could not load the library index{index.error ? `: ${index.error}` : '.'}
				</p>
			{:else if index.phase === 'ready'}
				{#if index.source === 'browse'}
					<p class="notice" data-testid="unified-degraded-notice">
						Showing a limited library listing while the catalog prepares. Counts are
						approximate and album actions are unavailable.
					</p>
				{/if}
				{#if itemTarget?.kind === 'album'}
					<UnifiedAlbumPage
						controller={albumController}
						actionController={sheetActionController}
						zones={sheetZones}
						album={drillAlbum}
						focusSongTitle={albumSongFocusTitle}
						backLabel={itemBackLabel}
						onBack={backFromItem}
						onRetry={retryAlbumPage}
						onBeginAction={beginSheetAction}
						onOpenArtist={drillAlbumArtistId ? openAlbumArtist : undefined}
						editorial={$editorialItemController}
						onEditorialRetry={retryEditorial}
						onEditorialFollow={followEditorial}
						onEditorialBack={backFromEditorialFollow}
						editorialFollowActive={editorialFollowTarget !== null}
						onOpenTrackInfo={openEditorialTrack}
						initialTrackInfoIndex={restoredTrackInfoIndex}
					/>
				{:else if itemTarget?.kind === 'artist'}
					<UnifiedArtistPage
						artist={drillArtist}
						albums={drillArtistAlbums}
						overlayPhase={drillArtistOverlayPhase}
						truncated={drillArtistTruncated}
						backLabel={itemBackLabel}
						onBack={backFromItem}
						editorial={$editorialItemController}
						onEditorialRetry={retryEditorial}
						onEditorialFollow={followEditorial}
						editorialFollowActive={editorialFollowTarget !== null}
						onEditorialBack={backFromEditorialFollow}
					>
						{#snippet headerExtra()}
							{@render drillSortControl()}
						{/snippet}
						{#snippet discography()}
							{#key drillArtist?.id}
								<UnifiedScopeViews
									scope="albums"
									artists={[]}
									albums={drillArtistAlbums}
									sorts={drillViewSorts}
									randomSeed={shuffleSeed}
									groupAlbums={false}
									railTarget={null}
									{dateFeatureGate}
									genres={$genresStore}
									recent={$recentStore}
									onDrill={openDrill}
								/>
							{/key}
						{/snippet}
					</UnifiedArtistPage>
				{/if}
				<!-- The collection context stays MOUNTED but hidden under an
				     open item page, so Back returns to the exact invoking
				     collection with its transient view state (tabs, loaded
				     data) intact (§4.2). -->
				<div class="collection-host" hidden={itemTarget !== null}>
				{#if collectionDrill}
					<div class="ctx">
						<button
							type="button"
							class="back"
							data-testid="unified-drill-back"
							onclick={backFromCollection}
						>
							← {collectionDrill.kind === 'genre' ? 'Genres' : 'Search results'}
						</button>
						<h2 tabindex="-1" data-testid="unified-drill-label">{collectionLabel}</h2>
						{#if collectionSummary}
							<span class="n mono" data-testid="unified-drill-summary">{collectionSummary}</span>
						{/if}
						{#if collectionDrill.kind === 'composer'}
							<!-- The composition surface (plan Slice 6) rides its own
							     retained composers-hierarchy session; the album drill
							     stays the distinct collection destination. -->
							<button
								type="button"
								class="ctab"
								class:on={compositionMode}
								data-testid="unified-drill-compositions-toggle"
								onclick={() => toggleCompositionMode()}
							>
								{compositionMode ? 'Albums' : 'Compositions'}
							</button>
						{/if}
						{@render drillSortControl()}
					</div>
					{#if compositionMode && collectionDrill.kind === 'composer'}
						{@render compositionSurface()}
					{:else if drillState.error}
						<p class="status error" data-testid="unified-drill-error">
							Could not load albums: {drillState.error}
						</p>
					{:else if drillState.loading || !drillState.loaded}
						<p class="status" data-testid="unified-drill-loading">Loading albums…</p>
					{:else}
						{#key collectionLabel}
							<UnifiedScopeViews
								scope="albums"
								artists={[]}
								albums={drillStoreAlbums}
								sorts={drillViewSorts}
								randomSeed={shuffleSeed}
								{railTarget}
								{dateFeatureGate}
								genres={$genresStore}
								recent={$recentStore}
								onDrill={openDrill}
							/>
						{/key}
					{/if}
				{:else if filterText}
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
						{#if filterSpec && index.capabilities.countFilters}
							<span class="n mono" data-testid="unified-filter-summary">
								{filterArtists.length.toLocaleString()} ARTISTS
							</span>
						{/if}
					</div>
					{#if !index.capabilities.countFilters}
						<p class="notice" data-testid="unified-filter-gated">
							{index.capabilities.countFiltersDisabledReason ??
								'Count filters are unavailable.'}
						</p>
					{:else if !filterSpec}
						<p class="notice" data-testid="unified-filter-invalid">
							“{filterText}” is not a filter this library understands any more.
						</p>
					{:else}
						{#if filterArtists.length === 0}
							<div class="hint" data-testid="unified-filter-none">No artists match.</div>
						{:else}
							<div class="alist" data-testid="unified-filter-results">
								{#each filterArtists as artist (artist.id)}
									<button
										type="button"
										class="arow"
										data-testid="unified-filter-artist"
										onclick={() =>
											void openDrill({ kind: 'artist', localId: artist.id })}
									>
										<span class="an">{artist.name}</span><span class="ad"></span><span
											class="ac mono">{artist.albumCount ?? ''}</span
										>
									</button>
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
								{scopeSummary}{index.truncated ? ' (truncated)' : ''}
							</span>
						{/if}
						{#if sortMenu}
							<div class="sortc-wrap">
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
							artists={index.artists}
							albums={index.albums}
							sorts={viewSorts}
							randomSeed={shuffleSeed}
							{railTarget}
							{dateFeatureGate}
							{scopeSlots}
							mostPlayed={{
								gate: playFeatureGate,
								state: mostPlayed,
								actionController: playlistActionController,
								zones: sheetZones,
								onBeginAction: (target, zoneId, desiredSemantic) =>
									void beginPublicSongAction(target, zoneId, desiredSemantic),
								onClearAction: clearPublicSongAction,
								onOpenAlbum: openMostPlayedAlbum,
								fetchFn
							}}
							playlists={{
								gate: playlistFeatureGate,
								store: playlistsStore,
								open: openPlaylistData,
								close: closePlaylistWithResolverCleanup,
								actionController: playlistActionController,
								zones: sheetZones,
								onBeginAction: (target, zoneId, desiredSemantic) =>
									void beginPublicSongAction(target, zoneId, desiredSemantic),
								albums: index.albums,
								fetchFn
							}}
							genres={$genresStore}
							recent={$recentStore}
							onDrill={(target) => void openDrill(target)}
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
			zones={sheetZones}
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
			onOpenAlbum={openSongAlbum}
			onOpenArtist={openSongArtist}
			onOpenComposer={openSongComposer}
		/>
	{:else if paletteOpen}
		<UnifiedPalette
			{index}
			genres={$genresStore}
			composers={$composersStore}
			searchStore={paletteSearchStore}
			bind:query={paletteQuery}
			bind:selectedRowId={paletteSelectedRowId}
			onClose={closePalette}
			onDrill={paletteDrill}
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
			zones={sheetZones}
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
	.composition-page h3 {
		margin: 10px 0 6px;
	}
	.composition-actions,
	.zone-picker {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 8px 0;
	}
	.composition-rows {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		max-width: 72ch;
	}
	.composition-rows li + li {
		margin-top: 4px;
	}
	.composition-rows button {
		display: flex;
		width: 100%;
		flex-direction: column;
		gap: 2px;
		padding: 7px 10px;
		border: 1px solid var(--songr-line);
		border-radius: 6px;
		background: transparent;
		color: var(--unified-fg);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.composition-rows button:hover {
		border-color: var(--unified-accent);
	}
	.composition-rows small,
	.composition-fact {
		color: var(--unified-dim);
		font-size: 12px;
	}
	.zone-label {
		width: 100%;
		color: var(--songr-soft);
		font-size: 12px;
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
