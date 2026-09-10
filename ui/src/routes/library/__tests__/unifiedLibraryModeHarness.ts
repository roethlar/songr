/**
 * Shared mount harness for the `UnifiedLibraryMode` component tests.
 */
import { vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { get, writable, type Writable } from 'svelte/store';
import type { libraryDestinationsStore } from '$lib/stores/libraryDestinationsStore';
import UnifiedLibraryMode from '../UnifiedLibraryMode.svelte';
import type { ArtistView } from '$lib/albumArtistGroups';
import type { LibraryPreviewResponse } from '@shared/libraryPreviewContracts';
import {
	LIBRARY_MODE_ACTIVATION_CONTEXT,
	type CommittedLibraryModeActivation,
	type LibraryModeLifecycle
} from '$lib/libraryModeActivationContext';
import {
	buildLibraryPageStateEnvelope,
	buildUnifiedLibraryPageState,
	buildUnifiedRootPageState
} from '$lib/libraryPageState';
import type { LibraryView } from '$lib/libraryView';
import { compareLibrarySearchKeys, type LetterBucket } from '$lib/libraryEntries';
import type {
	LibraryAlbumController,
	LibraryAlbumState
} from '$lib/library/LibraryAlbumController';
import {
	liveAlbumEntry,
	liveArtistEntry,
	type LibraryRootsState
} from '$lib/stores/libraryRootsStore';
import type { LibraryRootRow, LibraryRowReference } from '@shared/libraryRootsContracts';
import {
	LIBRARY_OPEN_CONTRACT,
	type LibraryLevelRow,
	type LibraryNodeKind,
	type LibraryOpenResponse
} from '@shared/libraryOpenContracts';
import { UnifiedSongActionController } from '$lib/library/UnifiedSongActionController';
import type {
	UnifiedBrowseActionController,
	UnifiedBrowseController
} from '$lib/library/UnifiedBrowseController';
import type { AddFavoriteRequest, CoreStatusResponse } from '@shared/types';
import type { FavoritesState } from '$lib/stores/favoritesStore';
import type { UnifiedSearchClient } from '$lib/unifiedSearchClient';
import type {
	AlbumActionBeginInput,
	AlbumActionController,
	AlbumActionState
} from '$lib/library/AlbumActionController';
import { clearPendingLibraryPageStateWrite } from '$lib/libraryPageNavigation';
import {
	__back,
	__forward,
	__getHistorySnapshot,
	__getNavigationLog,
	__resetNavigation
} from '../../../test/app-stubs/navigation';
import { NO_IMPORT_DATES_REASON, NO_RELEASE_DATES_REASON } from '$lib/unifiedLibrarySorts';
import type {
	unifiedComposersStore,
	unifiedGenresStore,
	NamedCountEntry
} from '$lib/stores/unifiedNamedCountsStore';
import type { recentlyPlayedStore } from '$lib/stores/recentlyPlayedStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import type {
	ClassicBrowseSessionClaim,
	classicBrowseSessionClient
} from '$lib/stores/classicBrowseSessionStore';
import type {
	PaletteSearchState,
	unifiedPaletteSearchStore
} from '$lib/stores/unifiedPaletteSearchStore';
import { createUnifiedLibraryPrefsStore } from '$lib/stores/unifiedLibraryPrefsStore';
import { collectionDrillRenderingOf } from '@shared/collectionDrillContracts';
import { createNavigationSettingsStore, type NavigationSettingsStore } from '$lib/stores/navigationSettingsStore';
import { DEFAULT_NAVIGATION_SETTINGS, type NavigationDestinationId } from '@shared/navigationSettings';

export type SessionClient = typeof classicBrowseSessionClient;

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

export function fakeSessionClient(): {
	client: SessionClient;
	claim: ReturnType<typeof vi.fn>;
	release: ReturnType<typeof vi.fn>;
	recover: ReturnType<typeof vi.fn>;
	connectionLost: ReturnType<typeof vi.fn>;
	invalidate: ReturnType<typeof vi.fn>;
} {
	let claimId = 0;
	// The real client re-acquires after an abandon, so a forgotten session comes
	// back with a new generation. `ready` is a getter for the same reason it is
	// one on the real claim: every read asks the current lifecycle.
	let sessionGeneration = 0;
	const claim = vi.fn(() => {
		claimId += 1;
		sessionGeneration += 1;
		return {
			owner: 'unified-mode',
			claimId,
			get ready() {
				return Promise.resolve({
					handleId: `h-${sessionGeneration}`,
					generation: sessionGeneration
				});
			}
		} as unknown as ClassicBrowseSessionClaim;
	});
	const release = vi.fn();
	const recover = vi.fn(async (activeClaim: ClassicBrowseSessionClaim) => activeClaim.ready);
	const connectionLost = vi.fn();
	const invalidate = vi.fn(() => {
		sessionGeneration += 1;
	});
	return {
		client: {
			claim,
			release,
			recover,
			connectionLost,
			invalidate,
			isClaimCurrent: vi.fn(() => true)
		} as unknown as SessionClient,
		claim,
		release,
		recover,
		connectionLost,
		invalidate
	};
}

export function fakeConnectionSocket() {
	type ConnectionEvent = 'connect' | 'disconnect';
	const listeners = new Map<ConnectionEvent, Set<() => void>>();
	return {
		connected: false,
		on(event: ConnectionEvent, listener: () => void) {
			const current = listeners.get(event) ?? new Set();
			current.add(listener);
			listeners.set(event, current);
		},
		off(event: ConnectionEvent, listener: () => void) {
			listeners.get(event)?.delete(listener);
		},
		emit(event: ConnectionEvent) {
			for (const listener of listeners.get(event) ?? []) listener();
		}
	};
}

// ---- The live view of Roon, as the harness fakes it ------------------
//
// Roon's roots are the ONE description of the fake library since Slice 4
// deleted the saved catalog. A test states the library once, as the rows Roon
// would render, and the harness derives both roots and the levels beneath them
// — so a row click exercises the live path the shipped surface takes, rather
// than a second path invented for tests.

export const HARNESS_LIVE_GENERATION = 'gen-1';

function liveRef(token: string, generation = HARNESS_LIVE_GENERATION): LibraryRowReference {
	return { generation, token };
}

/** One artist's albums in the fake Roon, keyed by the artist's own title. */
export interface HarnessLiveAlbum {
	readonly title: string;
	readonly credit: string;
	/** Roon's own track titles, in Roon's own order. */
	readonly tracks: readonly string[];
	/** Whether Roon renders a whole-album verb row on this album's level. */
	readonly verbRows?: number;
}

export interface HarnessLiveLibrary {
	readonly generation: string;
	readonly artists: readonly {
		readonly name: string;
		readonly albums: readonly HarnessLiveAlbum[];
		/**
		 * What Roon writes on this row, when it differs from the album count.
		 * `null` means Roon wrote no count at all — a row with no subtitle,
		 * which is a different thing from a row Roon counted as zero.
		 */
		readonly albumCount?: number | null;
	}[];
	/** The Albums root, when a test needs one; defaults to every artist's albums. */
	readonly albums?: readonly HarnessLiveAlbum[];
}

function albumToken(artist: string | null, album: HarnessLiveAlbum): string {
	return `album:${artist ?? '*'}:${album.title}:${album.credit}`;
}

export function liveRootsState(library: HarnessLiveLibrary): LibraryRootsState {
	const generation = library.generation;
	const artistRows: LibraryRootRow[] = library.artists.map((artist) => {
		const count = artist.albumCount === undefined ? artist.albums.length : artist.albumCount;
		return {
			ref: liveRef(`artist:${artist.name}`, generation),
			title: artist.name,
			...(count === null ? {} : { subtitle: `${count} Albums` })
		};
	});
	const albumSource =
		library.albums ?? library.artists.flatMap((artist) => artist.albums);
	const albumRows: LibraryRootRow[] = albumSource.map((album) => ({
		ref: liveRef(albumToken(null, album), generation),
		title: album.title,
		subtitle: album.credit
	}));
	// Rendered by the shipped renderers, sorted and bucketed the way the store
	// does it, so a test reads what the surface would actually be handed.
	const artists = [...artistRows]
		.map(liveArtistEntry)
		.sort((left, right) => compareLibrarySearchKeys(left.searchKey, right.searchKey));
	const albums = [...albumRows]
		.map(liveAlbumEntry)
		.sort((left, right) => compareLibrarySearchKeys(left.searchKey, right.searchKey));
	return {
		phase: 'ready',
		generation,
		coreId: 'core-a',
		readAt: '2026-09-03T00:00:00.000Z',
		artists,
		albums,
		artistRows,
		albumRows,
		artistBuckets: harnessBuckets(artists),
		albumBuckets: harnessBuckets(albums),
		artistCount: artistRows.length,
		albumCount: albumRows.length,
		unavailable: null,
		error: null,
		retirementRevision: 0,
		retirementReason: null
	};
}

/** The letter buckets the roots store computes, over the same sort keys. */
function harnessBuckets(entries: readonly { searchKey: string }[]): LetterBucket[] {
	const buckets: LetterBucket[] = [];
	for (const [index, entry] of entries.entries()) {
		const first = entry.searchKey.codePointAt(0);
		const letter =
			first !== undefined && first >= 0x61 && first <= 0x7a
				? String.fromCodePoint(first - 0x20)
				: '#';
		const last = buckets[buckets.length - 1];
		if (last && last.letter === letter) last.count += 1;
		else buckets.push({ letter, start: index, count: 1 });
	}
	return buckets;
}

function levelRow(
	ref: LibraryRowReference,
	title: string,
	kind: LibraryNodeKind,
	subtitle?: string
): LibraryLevelRow {
	return { ref, title, kind, ...(subtitle === undefined ? {} : { subtitle }) };
}

/**
 * The fake Roon's answer to one open, by the token the reference carries.
 *
 * Deliberately keyed by the token and nothing else: the shipped code may only
 * hand back a reference it was given, so a fake that could be satisfied by a
 * reconstructed key would stop proving that.
 */
export function liveOpenResponder(
	library: HarnessLiveLibrary
): (ref: LibraryRowReference) => LibraryOpenResponse {
	return (ref) => {
		if (ref.generation !== library.generation) {
			return { contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' };
		}
		const artistMatch = /^artist:(.*)$/u.exec(ref.token);
		if (artistMatch) {
			const artist = library.artists.find((entry) => entry.name === artistMatch[1]);
			if (!artist) return { contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' };
			const rows = [
				levelRow(liveRef(`verb:${artist.name}`, library.generation), 'Play Artist', 'action'),
				...artist.albums.map((album) =>
					levelRow(
						liveRef(albumToken(artist.name, album), library.generation),
						album.title,
						'album',
						album.credit
					)
				)
			];
			return {
				contract: LIBRARY_OPEN_CONTRACT,
				kind: 'level',
				generation: library.generation,
				title: artist.name,
				count: rows.length,
				rows
			};
		}
		const albumMatch = /^album:([^:]*):([^:]*):(.*)$/u.exec(ref.token);
		if (albumMatch) {
			const [, owner, title, credit] = albumMatch;
			const pool =
				owner === '*'
					? (library.albums ?? library.artists.flatMap((entry) => entry.albums))
					: (library.artists.find((entry) => entry.name === owner)?.albums ?? []);
			const album = pool.find((entry) => entry.title === title && entry.credit === credit);
			if (!album) return { contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' };
			const verbCount = album.verbRows ?? 1;
			const rows = [
				...Array.from({ length: verbCount }, (_unused, index) =>
					levelRow(
						liveRef(`play:${ref.token}:${index}`, library.generation),
						'Play Album',
						'action'
					)
				),
				...album.tracks.map((track, index) =>
					levelRow(
						liveRef(`track:${ref.token}:${index}`, library.generation),
						track,
						'track',
						credit
					)
				)
			];
			return {
				contract: LIBRARY_OPEN_CONTRACT,
				kind: 'level',
				generation: library.generation,
				title: album.title,
				subtitle: album.credit,
				count: rows.length,
				rows
			};
		}
		return { contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' };
	};
}

/**
 * `count` artists as Roon would render them, one album each, named so their
 * initials spread across the alphabet — the A–Z rail and the bucket tests read
 * these initials.
 */
export function harnessArtists(count: number): HarnessLiveLibrary['artists'] {
	const letters = 'abcdefghijklmnopqrstuvwxyz';
	return Array.from({ length: count }, (_unused, i) => {
		const name = `${letters[i % letters.length]} artist ${i}`;
		return {
			name,
			albums: [
				{ title: `Album of ${name}`, credit: name, tracks: ['Track one', 'Track two'] }
			]
		};
	});
}

/**
 * The default populated library: 50 artists with one album apiece. This is the
 * replacement for the old `readyState()` — a mount that wants "a library with
 * things in it" asks for this and says no more.
 */
export function harnessLibrary(over: Partial<HarnessLiveLibrary> = {}): HarnessLiveLibrary {
	return {
		generation: HARNESS_LIVE_GENERATION,
		artists: harnessArtists(50),
		...over
	};
}

export function fakeNamedCountsStore(entries: NamedCountEntry[]) {
	const empty = {
		entries: [] as readonly NamedCountEntry[],
		totalCount: 0,
		loading: false,
		loaded: false,
		error: null as string | null
	};
	const store = writable(empty);
	const load = vi.fn(async () => {
		store.set({ entries, totalCount: entries.length, loading: false, loaded: true, error: null });
	});
	const reset = vi.fn(() => {
		store.set(empty);
	});
	return { subscribe: store.subscribe, load, reset };
}

/**
 * A drill row as a test writes one: title, credit and artwork. The canonical
 * rendering is derived here rather than spelled out at every call site,
 * because it is derived the same way in production — one canonical form, one
 * function, both readers of the level.
 */
export function fakeRecentStore() {
	return writable({
		entries: [
			{
				title: 'A Recent Track',
				artist: 'Reference Artist',
				album: 'Album must not appear',
				zone_id: 'zone-1',
				played_at: '2026-07-24T12:00:00.000Z'
			}
		],
		loading: false,
		loaded: true
	});
}




export interface Harness {
	destinationsStore?: typeof libraryDestinationsStore;
	navigationPrefsStore?: NavigationSettingsStore;
	/** Existing tests address the All-artists surface; null tests a fresh preference. */
	artistViewPreference?: ArtistView | null;
	sessionClient?: SessionClient;
	withContext?: boolean;
	/** The Core's own identity, which is what the live roots load asks for. */
	fetchCoreStatus?: () => Promise<CoreStatusResponse>;
	/**
	 * Pairing readiness. The cold-start retry hangs off this: a load that
	 * bailed while unpaired is re-driven when this flips to `true`.
	 */
	corePairedStore?: Writable<boolean>;
	/** The live roots load, so a test can drive the roots phases by hand. */
	loadRoots?: ReturnType<typeof vi.fn>;
	rootsSource?: { subscribe: Writable<LibraryRootsState>['subscribe'] };
	genresStore?: ReturnType<typeof fakeNamedCountsStore>;
	composersStore?: ReturnType<typeof fakeNamedCountsStore>;
	paletteSearchStore?: Writable<PaletteSearchState>;
	searchPaletteData?: ReturnType<typeof vi.fn>;
	clearPaletteSearchData?: ReturnType<typeof vi.fn>;
	resetPaletteSearchData?: ReturnType<typeof vi.fn>;
	recentStore?: ReturnType<typeof fakeRecentStore>;
	albumController?: LibraryAlbumController;
	songActionController?: UnifiedSongActionController;
	browseController?: UnifiedBrowseController;
	browseActionController?: UnifiedBrowseActionController;
	addFavoriteData?: (fetchFn: typeof fetch, payload: AddFavoriteRequest) => Promise<void>;
	favoritesStore?: Writable<FavoritesState>;
	loadFavoritesData?: (fetchFn: typeof fetch) => Promise<void>;
	removeFavoriteData?: (fetchFn: typeof fetch, id: string) => Promise<void>;
	songRelationshipClient?: Pick<UnifiedSearchClient, 'relationship'>;
	albumActionController?: AlbumActionController;
	getSocketClient?: () => ReturnType<typeof fakeConnectionSocket>;
	/**
	 * The library this mount reads: Roon's roots and the levels beneath them.
	 * Left unset, the mount starts with empty, idle roots — a test that wants a
	 * populated library passes `harnessLibrary()`.
	 */
	liveLibrary?: HarnessLiveLibrary;
	rootsState?: LibraryRootsState;
	openLiveRef?: (fetchFn: typeof fetch, ref: LibraryRowReference) => Promise<LibraryOpenResponse>;
	previewLiveSection?: (fetchFn: typeof fetch, ref: LibraryRowReference, limit: number) => Promise<LibraryPreviewResponse>;
	openLiveRoot?: (
		fetchFn: typeof fetch,
		root: 'genres' | 'composers'
	) => Promise<LibraryOpenResponse>;
}

export function mountMode(options: Harness = {}) {
	const session = fakeSessionClient();
	const liveLibrary =
		options.liveLibrary ?? { generation: HARNESS_LIVE_GENERATION, artists: [] };
	// A mount that named a library means to have it on screen; one that named
	// none starts idle, which is what a surface sees before its first read.
	const rootsStore = writable<LibraryRootsState>(
		options.rootsState ??
			(options.liveLibrary
				? liveRootsState(liveLibrary)
				: { ...liveRootsState(liveLibrary), phase: 'idle' })
	);
	const respond = liveOpenResponder(liveLibrary);
	const openLiveRef = vi.fn(
		options.openLiveRef ?? (async (_fetchFn: typeof fetch, ref: LibraryRowReference) => respond(ref))
	);
	const openLiveRoot = vi.fn(
		options.openLiveRoot ??
			(async () => ({ contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' as const }))
	);
	const previewLiveSection = vi.fn(options.previewLiveSection ?? (async (): Promise<LibraryPreviewResponse> => ({
		contract: 'library-preview-v1', kind: 'unavailable', reason: 'read-failed', message: 'No fixture preview provided.'
	})));
	const loadRoots =
		options.loadRoots ??
		vi.fn(async () => {
			rootsStore.update((state) => ({ ...state, phase: 'ready' }));
		});
	const fetchCoreStatus = vi.fn(
		options.fetchCoreStatus ??
			(async (): Promise<CoreStatusResponse> => ({
				status: 'paired',
				core: { id: 'core-a', displayName: 'Core', displayVersion: '1' }
			}))
	);
	const corePairedStore = options.corePairedStore ?? writable(true);
	// Preserve the existing content-interaction workload using an explicit
	// server configuration; navigation-specific tests can supply real defaults.
	const existingScopes: NavigationDestinationId[] = [
		'artists', 'albums', 'genres', 'tracks', 'recently-played', 'favorites', 'surprise'
	];
	const navigationPrefsStore = options.navigationPrefsStore ?? createNavigationSettingsStore();
	if (!options.navigationPrefsStore) navigationPrefsStore.applySnapshot({
		...DEFAULT_NAVIGATION_SETTINGS,
		order: [...existingScopes, ...DEFAULT_NAVIGATION_SETTINGS.order.filter(id => !existingScopes.includes(id))],
		pinned: existingScopes
	});
	const prefsStorage = new Map<string, string>();
	const prefsStore = createUnifiedLibraryPrefsStore({
		isBrowser: true,
		getStorage: () => ({
			getItem: (key) => prefsStorage.get(key) ?? null,
			setItem: (key, value) => {
				prefsStorage.set(key, value);
			}
		}),
		addStorageListener: () => () => {}
	});
	const artistViewPreference = options.artistViewPreference === undefined ? 'all-artists' : options.artistViewPreference;
	if (artistViewPreference !== null) prefsStore.setArtistView(artistViewPreference);
	const registered: {
		mode: LibraryView | null;
		lifecycle: LibraryModeLifecycle | null;
	} = { mode: null, lifecycle: null };
	let committed: CommittedLibraryModeActivation | null = null;

	// Palette opens kick named-index loads; default to fakes so no
	// test ever reaches the real claim-scoped stores by accident.
	const genresStore = options.genresStore ?? fakeNamedCountsStore([]);
	const composersStore = options.composersStore ?? fakeNamedCountsStore([]);
	const paletteSearchStore =
		options.paletteSearchStore ??
		writable<PaletteSearchState>({ phase: 'idle', query: '', groups: [], error: null });
	const resetPaletteSearchData =
		options.resetPaletteSearchData ??
		vi.fn(() => {
			paletteSearchStore.set({ phase: 'idle', query: '', groups: [], error: null });
		});
	const clearPaletteSearchData =
		options.clearPaletteSearchData ??
		vi.fn(async () => {
			paletteSearchStore.set({ phase: 'idle', query: '', groups: [], error: null });
		});
	const songRelationshipClient =
		options.songRelationshipClient ??
		({
			relationship: vi.fn().mockResolvedValue({
				songTitle: 'Song',
				albums: [],
				composerLabels: []
			})
		} satisfies Pick<UnifiedSearchClient, 'relationship'>);
	const favoritesStore =
		options.favoritesStore ??
		writable<FavoritesState>({ entries: [], loading: false, loaded: true });
	const connectionSocket = fakeConnectionSocket();
	connectionSocket.connected = true;
	const destinationsStore = options.destinationsStore ?? {
		subscribe: writable({ inventory: null, loading: false, error: null }).subscribe,
		load: vi.fn(async () => {}), reset: vi.fn()
	} as typeof libraryDestinationsStore;
	const props = {
		sessionClient: options.sessionClient ?? session.client,
		rootsStore: (options.rootsSource ?? rootsStore) as never,
		loadRoots: loadRoots as never,
		openLiveRef: openLiveRef as never,
		openLiveRoot: openLiveRoot as never,
		previewLiveSection: previewLiveSection as never,
		fetchCoreStatusData: fetchCoreStatus as never,
		corePairedStore: corePairedStore as never,
		prefsStore,
		navigationPrefsStore,
		destinationsStore,
		genresStore: genresStore as unknown as typeof unifiedGenresStore,
		composersStore: composersStore as unknown as typeof unifiedComposersStore,
		paletteSearchStore: paletteSearchStore as unknown as typeof unifiedPaletteSearchStore,
		searchPaletteData: (options.searchPaletteData ?? vi.fn(async () => {})) as never,
		clearPaletteSearchData: clearPaletteSearchData as never,
		resetPaletteSearchData: resetPaletteSearchData as never,
		recentStore: options.recentStore as unknown as typeof recentlyPlayedStore,
		favoritesDataStore: favoritesStore as never,
		loadFavoritesData: (options.loadFavoritesData ?? vi.fn(async () => {})) as never,
		removeFavoriteData: (options.removeFavoriteData ?? vi.fn(async () => {})) as never,
		fetchFn: (() => {
			throw new Error('modes must not fetch directly');
		}) as unknown as typeof fetch,
		...(options.albumController ? { albumController: options.albumController } : {}),
		...(options.songActionController
			? { songActionController: options.songActionController }
			: {}),
		...(options.browseController ? { browseController: options.browseController } : {}),
		...(options.browseActionController
			? { browseActionController: options.browseActionController }
			: {}),
		...(options.addFavoriteData ? { addFavoriteData: options.addFavoriteData } : {}),
		songRelationshipClient,
		...(options.albumActionController
			? { albumActionController: options.albumActionController }
			: {}),
		getSocketClient: options.getSocketClient ?? (() => connectionSocket)
	};

	const renderResult =
		options.withContext === true
			? render(UnifiedLibraryMode, {
					props,
					context: new Map([
						[
							LIBRARY_MODE_ACTIVATION_CONTEXT,
							{
								committedActivation: () => committed,
								registerLifecycle: (
									mode: LibraryView,
									lifecycle: LibraryModeLifecycle
								) => {
									registered.mode = mode;
									registered.lifecycle = lifecycle;
									return () => {
										if (registered.lifecycle === lifecycle) {
											registered.mode = null;
											registered.lifecycle = null;
										}
									};
								}
							}
						]
					])
				})
			: render(UnifiedLibraryMode, { props });

	return {
		...renderResult,
		session,
		rootsStore,
		liveLibrary,
		openLiveRef,
		openLiveRoot,
		previewLiveSection,
		loadRoots,
		fetchCoreStatus,
		corePairedStore,
		prefsStore,
		navigationPrefsStore,
		genresStore,
		composersStore,
		paletteSearchStore,
		clearPaletteSearchData,
		resetPaletteSearchData,
		favoritesStore,
		songRelationshipClient,
		registered,
		setCommitted: (value: CommittedLibraryModeActivation | null) => {
			committed = value;
		}
	};
}

/**
 * One album row as Roon would render it. The credit defaults to the same
 * `Artist of <title>` convention the old catalog fixture used, so the rows a
 * test reads back are worded as they always were.
 */
export function harnessAlbum(title: string, credit = `Artist of ${title}`): HarnessLiveAlbum {
	return { title, credit, tracks: ['Track one', 'Track two'] };
}

export function fakeModeAlbumController(): {
	controller: LibraryAlbumController;
	open: ReturnType<typeof vi.fn>;
	beginLive: ReturnType<typeof vi.fn>;
	adoptLiveLevel: ReturnType<typeof vi.fn>;
	failLive: ReturnType<typeof vi.fn>;
	store: Writable<LibraryAlbumState>;
} {
	const store = writable({
		phase: 'opening',
		activeTab: 'details',
		albumLocalId: 'alb-1',
		generation: 1,
		requestId: 'r-1',
		operationId: null,
		resolvingDeadlineAt: null,
		artist: null,
		title: null,
		versions: [],
		selectedVersionId: null,
		actionsAvailable: false,
		albumActionsAvailable: false,
		orderedTracks: [],
		code: null,
		error: null,
		transitionedAt: 1
	} as unknown as LibraryAlbumState);
	const open = vi.fn();
	// The live arm is part of what an album controller IS (Slice 2). A fake
	// missing it does not stand in for one — it throws the moment a live album
	// page opens, which is a hole in the double, not a finding about the mode.
	const beginLive = vi.fn(() => {
		store.update((state) => ({ ...state, phase: 'opening' }) as LibraryAlbumState);
	});
	const adoptLiveLevel = vi.fn(
		(input: {
			readonly albumRef: LibraryRowReference;
			readonly title: string;
			readonly artist: string | null;
			readonly rows: readonly {
				readonly ref: LibraryRowReference;
				readonly title: string;
				readonly kind: string;
			}[];
		}) => {
			const verbRows = input.rows.filter((row) => row.kind === 'action');
			const trackRows = input.rows.filter((row) => row.kind !== 'action');
			store.update(
				(state) =>
					({
						...state,
						phase: 'details',
						title: input.title,
						artist: input.artist,
						actionsAvailable: trackRows.length > 0,
						albumActionsAvailable: verbRows.length === 1,
						orderedTracks: trackRows.map((row, index) => ({ index, title: row.title })),
						live: {
							albumRef: input.albumRef,
							playRef: verbRows.length === 1 ? verbRows[0].ref : null,
							trackRefs: trackRows.map((row) => row.ref)
						}
					}) as LibraryAlbumState
			);
		}
	);
	const failLive = vi.fn((code: string, error: string) => {
		store.update((state) => ({ ...state, phase: 'failed', code, error }) as LibraryAlbumState);
	});
	return {
		controller: {
			subscribe: store.subscribe,
			open,
			beginLive,
			adoptLiveLevel,
			failLive,
			select: vi.fn(),
			showVersions: vi.fn(),
			showDetails: vi.fn(),
			cancel: vi.fn(),
			reset: vi.fn()
		} as unknown as LibraryAlbumController,
		open,
		beginLive,
		adoptLiveLevel,
		failLive,
		store
	};
}

export function fakeModeActionController(): AlbumActionController {
	const store = writable({ phase: 'idle', actions: [], error: null });
	return {
		subscribe: store.subscribe,
		begin: vi.fn(),
		cancel: vi.fn(),
		reset: vi.fn()
	} as unknown as AlbumActionController;
}

function fakeAlbumActionState(overrides: Partial<AlbumActionState> = {}): AlbumActionState {
	return {
		phase: 'idle',
		pageId: null,
		versionId: null,
		zoneId: null,
		generation: null,
		requestId: null,
		operationId: null,
		resolvingDeadlineAt: null,
		choosingDeadlineAt: null,
		actions: [],
		selectedActionId: null,
		executionAttempted: false,
		code: null,
		error: null,
		transitionedAt: 0,
		...overrides
	};
}

/** Writable action double for host-level request-correlation and recovery tests. */
export function fakeRecoveringModeActionController() {
	const store = writable<AlbumActionState>(fakeAlbumActionState());
	let requestSequence = 0;
	const begin = vi.fn((input: AlbumActionBeginInput) => {
		requestSequence += 1;
		const requestId = `action-${requestSequence}`;
		store.set(
			fakeAlbumActionState({
				phase: 'resolving',
				pageId: 'pageId' in input ? input.pageId : null,
				versionId: 'versionId' in input ? input.versionId : null,
				zoneId: input.zoneId,
				generation: input.generation,
				requestId,
				transitionedAt: requestSequence
			})
		);
		return { started: true as const, requestId };
	});
	const publish = (overrides: Partial<AlbumActionState>): void => {
		store.update((state) => ({
			...state,
			...overrides,
			transitionedAt: state.transitionedAt + 1
		}));
	};
	return {
		controller: {
			subscribe: store.subscribe,
			begin,
			cancel: vi.fn(),
			reset: vi.fn()
		} as unknown as AlbumActionController,
		begin,
		publish,
		store
	};
}
