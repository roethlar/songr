<script lang="ts">
	import { getContext, onMount, tick, untrack } from 'svelte';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type CommittedLibraryModeActivation,
		type LibraryModeActivationContext
	} from '$lib/libraryModeActivationContext';
	import {
		buildUnifiedLibraryPageState,
		type UnifiedLibraryDrillTarget,
		type UnifiedLibraryScope
	} from '$lib/libraryPageState';
	import {
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
		librarySortKey,
		reconcileBrowseAlbumsToCatalog,
		type LetterBucket,
		type LibraryAlbumEntry
	} from '$lib/stores/libraryIndexStore';
	import { unifiedDrillStore } from '$lib/stores/unifiedDrillStore';
	import {
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
	import { parseCountFilter } from '$lib/unifiedSmartFilters';
	import { loadRecentlyPlayed, recentlyPlayedStore } from '$lib/stores/recentlyPlayedStore';
	import { libraryScopeSlots, type ResolvedLibraryScopeSlots } from '@libraryFeatures';
	import type { ScopeActionTarget } from '$lib/libraryFeatures/scopeSlotContract';
	import { zonesStore } from '$lib/stores/zonesStore';
	import { getSocket } from '$lib/socket/client';
	import { getTimelineTabId } from '$lib/timeline/tabId';
	import {
		LibraryAlbumController,
		type LibraryAlbumSocket
	} from '$lib/library/LibraryAlbumController';
	import { UnifiedSongActionController } from '$lib/library/UnifiedSongActionController';
	import { PublicSongActionController } from '$lib/library/PublicSongActionController';
	import {
		unifiedSearchClient,
		type UnifiedSearchClient
	} from '$lib/unifiedSearchClient';
	import {
		TimelineAlbumActionController,
		type TimelineAlbumActionSocket
	} from '$lib/timeline/TimelineAlbumActionController';
	import type { AlbumActionSemantic } from '@shared/albumActionContracts';
	import type { LibraryAlbumCandidate } from '@shared/libraryAlbumContracts';
	import { normalizeCatalogText } from '@shared/timelineCatalogContracts';
	import type {
		UnifiedSongActionSemantic,
		UnifiedSongAlbumRelationship,
		UnifiedSongRelationship
	} from '@shared/unifiedSearchContracts';
	import UnifiedScopeViews from './UnifiedScopeViews.svelte';
	import UnifiedAlbumSheet from './UnifiedAlbumSheet.svelte';
	import UnifiedPalette from './UnifiedPalette.svelte';
	import UnifiedSongPanel from './UnifiedSongPanel.svelte';
	import './unified-surface.css';
	import { version as uiBuildRevision } from '$app/environment';
	import { coreStore } from '$lib/stores/coreStore';

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

	/** Owner-approved build-v5 scopes, without product-surface additions. */
	const LEADING_SCOPE_CHIPS: readonly ScopeChip[] = [
		{ id: 'artists', label: 'Artists' },
		{ id: 'albums', label: 'Albums' },
		{ id: 'genres', label: 'Genres' },
		{ id: 'recently-played', label: 'Recently played' }
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

	const DENSITY_OPTIONS: readonly { id: UnifiedLibraryDensity; label: string }[] = [
		{ id: 'compact', label: 'Compact' },
		{ id: 'normal', label: 'Normal' },
		{ id: 'pi', label: 'Pi' }
	];

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
		songActionController: suppliedSongActionController,
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
		songActionController?: UnifiedSongActionController;
		songRelationshipClient?: Pick<UnifiedSearchClient, 'relationship'>;
		albumActionController?: TimelineAlbumActionController;
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
		new TimelineAlbumActionController({
			getSocket: () => getSocket() as unknown as TimelineAlbumActionSocket | null
		});
	const songActionController =
		untrack(() => suppliedSongActionController) ?? new UnifiedSongActionController();
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
	let drill = $state<UnifiedLibraryDrillTarget | null>(null);
	let drillRecordedHistory = false;
	let drillNotice = $state<string | null>(null);
	/** Smart-filter page text (plan §3.2 slice 7); '' means no filter page. */
	let filterText = $state('');
	let paletteOpen = $state(false);
	let paletteQuery = $state('');
	let paletteSelectedRowId = $state<string | null>(null);
	let selectedSong = $state<PaletteSearchRow | null>(null);
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
	const playlistActionState = $derived($playlistActionController);
	const sheetZones = $derived(
		$zonesStore.map((zone) => ({ zoneId: zone.zone_id, name: zone.display_name }))
	);

	const prefs = $derived($prefsStore);
	const index = $derived($indexStore);
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
		drill?.kind === 'artist'
			? artistDrillSortMenu(dateFeatureGate)
			: drill?.kind === 'genre'
				? genreDrillSortMenu(dateFeatureGate)
				: null
	);
	const drillSortValue = $derived(
		drill?.kind === 'artist'
			? resolveAlbumOrder(prefs.sorts.artist)
			: drill?.kind === 'genre'
				? resolveAlbumOrder(prefs.sorts.genre)
				: null
	);
	const drillViewSorts = $derived({
		...prefs.sorts,
		albums:
			drill?.kind === 'artist'
				? resolveAlbumOrder(prefs.sorts.artist)
				: drill?.kind === 'genre'
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
			drill?.kind !== 'genre' ||
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
		if (drill?.kind === 'genre') return drillRailBuckets;
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
		drill?.kind === 'genre'
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
		if (drill?.kind === 'genre')
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
	const railVisible = $derived(
		(drill === null || drill.kind === 'album' || drill.kind === 'genre') &&
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
		if (!drill || drill.kind !== 'artist' || index.phase !== 'ready') return null;
		const target = drill;
		return index.artists.find((entry) => entry.id === target.localId) ?? null;
	});
	const drillAlbum = $derived.by(() => {
		if (!drill || drill.kind !== 'album' || index.phase !== 'ready') return null;
		const target = drill;
		return (
			index.albums.find(
				(entry) =>
					entry.catalogLocalId === target.localId || entry.id === target.localId
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
		const artistName = drillAlbum.artist.trim().toLocaleLowerCase();
		if (!artistName) return null;
		return (
			index.artists.find((entry) => entry.name.trim().toLocaleLowerCase() === artistName)?.id ??
			null
		);
	});
	const drillArtistAlbums = $derived.by((): LibraryAlbumEntry[] => {
		if (!drillArtist) return [];
		const artistId = drillArtist.id;
		const artistName = drillArtist.name.trim().toLocaleLowerCase();
		return index.albums.filter(
			(entry) =>
				entry.artistId === artistId ||
				(!entry.artistId && entry.artist.trim().toLocaleLowerCase() === artistName)
		);
	});
	const drillLabel = $derived.by(() => {
		if (drill === null) return '';
		if (drill.kind === 'artist') return drillArtist?.name ?? '…';
		if (drill.kind === 'album') return sheetState.title ?? '…';
		return drill.label;
	});
	const drillSummary = $derived.by(() => {
		if (drill?.kind === 'artist' && drillArtist) {
			return `${drillArtistAlbums.length.toLocaleString()} ALBUMS`;
		}
		if ((drill?.kind === 'genre' || drill?.kind === 'composer') && drillState.loaded) {
			return `${drillState.totalCount.toLocaleString()} ALBUMS`;
		}
		return '';
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
			drill,
			filterText,
			openAlbumLocalId: drill?.kind === 'album' ? drill.localId : null,
			surpriseSeed: scope === 'surprise' ? shuffleSeed : null,
			density
		});
	}

	function pushUnifiedSemanticState(density?: UnifiedLibraryDensity): void {
		pushLibraryPageState(unifiedSemanticState(density));
	}

	async function openDrill(
		target: UnifiedLibraryDrillTarget,
		recordHistory = true,
		albumOptions?: {
			readonly candidate?: LibraryAlbumCandidate;
			readonly songFocusTitle?: string;
		}
	): Promise<void> {
		railTarget = null;
		drillRecordedHistory = recordHistory;
		if (target.kind === 'album') {
			albumSongFocusTitle = albumOptions?.songFocusTitle ?? null;
			drillNotice = null;
			drill = target;
			if (recordHistory) pushUnifiedSemanticState();
			await openAlbumRead(target.localId, albumOptions?.candidate);
			return;
		}
		albumSongFocusTitle = null;
		drillNotice = null;
		if (target.kind === 'artist') {
			// Validity is derived at render time so restoration can begin
			// before the index is ready; a missing artist renders the
			// parent-with-notice state.
			drill = target;
			if (recordHistory) pushUnifiedSemanticState();
			resetPaneAfterRender();
			return;
		}
		const activeClaim = claim;
		if (!activeClaim) return;
		const generation = lifecycleGeneration;
		drill = target;
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
		if (!entry?.itemKey) {
			// Semantic restoration rule: zero matches → parent with notice.
			drill = null;
			drillNotice = `“${target.label}” is not in this library any more.`;
			return;
		}
		void drillStore.load(
			activeClaim,
			target.kind === 'genre' ? 'genres' : 'composers',
			entry.itemKey
		);
	}

	function resetDrill(): void {
		const resetPane = drill?.kind !== 'album';
		// Sheet close cancels the read and any in-flight action authority.
		albumController.cancel();
		albumController.reset();
		sheetActionController.cancel();
		sheetGeneration = null;
		albumSongFocusTitle = null;
		drill = null;
		drillRecordedHistory = false;
		drillNotice = null;
		drillStore.reset();
		if (resetPane) resetPaneAfterRender();
	}

	function backFromDrill(): void {
		const shouldReturnToPalette = returnToPalette;
		const shouldPopHistory = drillRecordedHistory;
		resetDrill();
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
		resetDrill();
		void openDrill({ kind: 'artist', localId: artistId }, !returnToPalette);
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
			const response = await hydrateArtistAlbums(
				fetchFn,
				artists[0].catalogLocalId!,
				Math.max(index.revision, hydrationRevision ?? index.revision)
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
		candidate: LibraryAlbumCandidate | undefined
	): Promise<void> {
		const activeClaim = claim;
		if (!activeClaim) return;
		const generation = lifecycleGeneration;
		await hydrateUnresolvedAlbum(albumLocalId, generation);
		if (generation !== lifecycleGeneration) return;
		let ref;
		try {
			ref = await activeClaim.ready;
		} catch {
			if (generation === lifecycleGeneration) {
				drill = null;
				drillNotice = 'The library session is unavailable.';
			}
			return;
		}
		if (generation !== lifecycleGeneration) return;
		let tabId: string;
		try {
			tabId = getTimelineTabId();
		} catch {
			drill = null;
			drillNotice = 'Secure library identity is unavailable.';
			return;
		}
		sheetGeneration = ref.generation;
		albumController.open({
			albumLocalId,
			tabId,
			generation: ref.generation,
			...(candidate ? { candidate } : {})
		});
	}

	function retryAlbumSheet(): void {
		if (drill?.kind !== 'album') return;
		albumController.reset();
		void openAlbumRead(drill.localId, undefined);
	}

	function chooseAlbumCandidate(candidate: LibraryAlbumCandidate): void {
		if (drill?.kind !== 'album') return;
		void openAlbumRead(drill.localId, candidate);
	}

	function beginSheetAction(
		track: { index: number; title: string } | null,
		zoneId: string,
		desiredSemantic: AlbumActionSemantic
	): void {
		if (drill?.kind !== 'album' || sheetGeneration === null) return;
		let tabId: string;
		try {
			tabId = getTimelineTabId();
		} catch {
			return;
		}
		sheetActionController.begin({
			albumLocalId: drill.localId,
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
		pushUnifiedSemanticState();
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

	function startPaletteAuthorityRetirement(): void {
		const previous = paletteSearchHandoff;
		const current = retirePaletteAuthority();
		paletteSearchHandoff = Promise.all([previous, current]).then(() => undefined);
	}

	function closePalette(): void {
		classicSearchOwnerGeneration += 1;
		paletteOpen = false;
		paletteQuery = '';
		paletteSelectedRowId = null;
		selectedSong = null;
		returnToPalette = false;
		songActionController.reset();
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
		selectedSong = song;
		loadSongRelationship(song);
	}

	function backToPaletteResults(): void {
		songActionController.reset();
		selectedSong = null;
		resetSongRelationship();
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
				candidate: {
					title: candidate.title,
					artist: candidate.artist,
					editionText: candidate.editionText
				},
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
		if (drill?.kind === 'album') return;
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
		if (drill?.kind !== 'artist' && drill?.kind !== 'genre') return;
		railTarget = null;
		if (value === 'shuffle') shuffleSeed += 1;
		prefsStore.setSort(drill.kind, value);
	}

	function setDensity(value: UnifiedLibraryDensity): void {
		const previous = prefs.density;
		if (value === previous) return;
		// The root entry intentionally has no authoritative density. Capture
		// the actual current preference before creating the changed entry so
		// Back can restore it even on the first density change after reload.
		replaceLibraryPageState(unifiedSemanticState(previous));
		if (prefsStore.setDensity(value)) pushUnifiedSemanticState(value);
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
		let restoredDrill: UnifiedLibraryDrillTarget | null = null;
		if (pageState && pageState.libraryView === 'unified') {
			scope = pageState.snapshot.scope;
			restoredDrill = pageState.snapshot.drill;
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
		}
		const connectedBeforeClaim = Boolean(getSocketClient()?.connected);
		claim = sessionClient.claim('unified-mode');
		resumed = true;
		attachConnectionListeners();
		if (!connectedBeforeClaim && connectionSocket?.connected) handleReconnect();
		void loadForClaim(claim);
		// Restored page state may land directly on a data-owning scope.
		maybeLoadScopeData(scope);
		// Semantic drill restoration: resolve labels against live data;
		// zero matches degrade to the parent scope with a notice.
		if (restoredDrill) {
			void openDrill(restoredDrill, false);
			// This drill already owns the restored history entry even though
			// resume must not push a duplicate one.
			drillRecordedHistory = true;
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
		drill = null;
		drillRecordedHistory = false;
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
		resetSongRelationship();
		resetPaletteSearchData();
		if (claim) {
			sessionClient.release(claim);
			claim = null;
		}
	}

	onMount(() => {
		const unregister = activationContext?.registerLifecycle?.('unified', {
			resume: (activation) => resumeUnified(activation),
			suspend: suspendUnified
		});
		if (!unregister) resumeUnified(activationContext?.committedActivation?.() ?? null);
		return () => {
			suspendUnified();
			unregister?.();
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
			disabled={playlistActionState.phase === 'executing'}
			onclick={() => openPalette('')}
		>
			<span>⚲</span> Search
			<span class="kbd mono">TYPE ANYWHERE</span>
		</button>
		<div class="spacer"></div>
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
		<div class="seg" role="group" aria-label="Density">
			{#each DENSITY_OPTIONS as option (option.id)}
				<button
					type="button"
					class:on={prefs.density === option.id}
					aria-pressed={prefs.density === option.id}
					data-testid="unified-density-{option.id}"
					onclick={() => setDensity(option.id)}
				>
					{option.label}
				</button>
			{/each}
		</div>
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

	<div class="body">
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
						class:on={scope === chip.id && (!drill || drill.kind === 'album') && !filterText}
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
				{#if drill && drill.kind !== 'album'}
					<div class="ctx">
						<button
							type="button"
							class="back"
							data-testid="unified-drill-back"
							onclick={backFromDrill}
						>
							← {drill.kind === 'genre'
								? 'Genres'
								: drill.kind === 'composer'
									? 'Search results'
									: 'Back'}
						</button>
						<h2 data-testid="unified-drill-label">{drillLabel}</h2>
						{#if drillSummary}
							<span class="n mono" data-testid="unified-drill-summary">{drillSummary}</span>
						{/if}
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
					</div>
					{#if drill.kind === 'artist'}
						{#if !drillArtist}
							<p class="notice" data-testid="unified-drill-missing">
								That artist is no longer in this library.
							</p>
						{:else}
							{#key drillArtist.id}
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
						{/if}
					{:else if drillState.loading || !drillState.loaded}
						<p class="status" data-testid="unified-drill-loading">Loading albums…</p>
					{:else if drillState.error}
						<p class="status error" data-testid="unified-drill-error">
							Could not load albums: {drillState.error}
						</p>
					{:else}
						{#key drillLabel}
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
						<h2 data-testid="unified-filter-label">
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
						<h2>{ALL_SCOPE_CHIPS.find((chip) => chip.id === scope)?.label ?? 'Library'}</h2>
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
				{#if drill?.kind === 'album'}
					<UnifiedAlbumSheet
						controller={albumController}
						actionController={sheetActionController}
						zones={sheetZones}
						album={drillAlbum}
						focusSongTitle={albumSongFocusTitle}
						onClose={backFromDrill}
						onRetry={retryAlbumSheet}
						onChooseCandidate={chooseAlbumCandidate}
						onBeginAction={beginSheetAction}
						onOpenArtist={drillAlbumArtistId ? openAlbumArtist : undefined}
					/>
				{/if}
			{:else}
				<p class="status">Idle.</p>
			{/if}
		</div>
	</div>

	{#if paletteOpen && selectedSong}
		<UnifiedSongPanel
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
			onApplyFilter={applySmartFilter}
			onSearch={paletteSearch}
		/>
	{/if}
</section>

<style>
	.unified-library-mode {
		--unified-bg: #000;
		--unified-fg: rgba(255, 255, 255, 0.92);
		--unified-dim: rgba(255, 255, 255, 0.6);
		--unified-accent: #d4af37;
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.status {
		color: var(--unified-dim);
	}

	.status.error {
		color: #ff8a80;
	}

	.notice {
		color: var(--unified-dim);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 8px;
		padding: 8px 12px;
	}

</style>
