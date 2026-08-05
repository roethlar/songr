/**
 * Shared mount harness for the `UnifiedLibraryMode` component tests.
 *
 * Extracted so the public suite (`__tests__/UnifiedLibraryMode.test.ts`) and the
 * extended-scope suite that lives behind the wall
 * (`../native/__tests__/UnifiedLibraryModeExtendedScopes.test.ts`) mount the
 * component exactly the same way. The harness itself names nothing behind the
 * wall: it is part of the application proper and survives the extended library
 * views being absent from a build.
 */
import { vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { get, writable, type Writable } from 'svelte/store';
import UnifiedLibraryMode from '../UnifiedLibraryMode.svelte';
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
import type { LibraryView } from '$lib/stores/libraryViewStore';
import {
	CATALOG_CAPABILITIES,
	BROWSE_FALLBACK_CAPABILITIES,
	INCOMPLETE_ARTIST_COUNTS_CAPABILITIES,
	type LibraryAlbumEntry,
	type LibraryArtistEntry,
	type LibraryIndexState,
	type libraryIndexStore
} from '$lib/stores/libraryIndexStore';
import type {
	LibraryAlbumController,
	LibraryAlbumState
} from '$lib/library/LibraryAlbumController';
import { UnifiedSongActionController } from '$lib/library/UnifiedSongActionController';
import { PublicSongActionController } from '$lib/library/PublicSongActionController';
import type { PublicSongResolverClient } from '$lib/publicSongResolverClient';
import type { UnifiedSearchClient } from '$lib/unifiedSearchClient';
import type { TimelineAlbumActionController } from '$lib/timeline/TimelineAlbumActionController';
import { clearPendingLibraryPageStateWrite } from '$lib/libraryPageNavigation';
import {
	__back,
	__forward,
	__getHistorySnapshot,
	__getNavigationLog,
	__resetNavigation
} from '../../../test/app-stubs/navigation';
import { NO_GENRE_SORT_REASON, NO_IMPORT_DATES_REASON, NO_RELEASE_DATES_REASON } from '$lib/unifiedLibrarySorts';
import type {
	unifiedComposersStore,
	unifiedGenresStore,
	NamedCountEntry
} from '$lib/stores/unifiedNamedCountsStore';
import type { unifiedDrillStore, DrillAlbum } from '$lib/stores/unifiedDrillStore';
import type { recentlyPlayedStore } from '$lib/stores/recentlyPlayedStore';
import type {
	MostPlayedState,
	PlaylistsState,
	ResolvedLibraryScopeSlots
} from '@libraryFeatures';
import type {
	PlaylistContentsResponse,
	PlaylistSummaryView
} from '@shared/playlistContracts';
import type { PublicSongResolution } from '@shared/publicSongResolverContracts';
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
import { syntheticStatus } from '$lib/stores/__tests__/libraryIndexFixtures';

export type SessionClient = typeof classicBrowseSessionClient;
export type IndexStore = typeof libraryIndexStore;

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
} {
	let claimId = 0;
	const claim = vi.fn(() => {
		claimId += 1;
		return {
			owner: 'unified-mode',
			claimId,
			ready: Promise.resolve({ handleId: `h-${claimId}`, generation: claimId })
		} as unknown as ClassicBrowseSessionClaim;
	});
	const release = vi.fn();
	const recover = vi.fn(async (activeClaim: ClassicBrowseSessionClaim) => activeClaim.ready);
	const connectionLost = vi.fn();
	return {
		client: {
			claim,
			release,
			recover,
			connectionLost,
			isClaimCurrent: vi.fn(() => true)
		} as unknown as SessionClient,
		claim,
		release,
		recover,
		connectionLost
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

export function artistEntries(count: number): LibraryArtistEntry[] {
	const letters = 'abcdefghijklmnopqrstuvwxyz';
	return Array.from({ length: count }, (_, i) => {
		const name = `${letters[i % letters.length]} artist ${i}`;
		return {
			id: `art-${i}`,
			name,
			searchKey: name,
			albumCount: 1,
			countComplete: true,
			catalogLocalId: `art-${i}`
		};
	});
}

export function bucketsFor(entries: readonly { searchKey: string }[]): {
	letter: string;
	start: number;
	count: number;
}[] {
	const buckets: { letter: string; start: number; count: number }[] = [];
	entries.forEach((entry, i) => {
		const letter = entry.searchKey[0].toUpperCase();
		const last = buckets.at(-1);
		if (last && last.letter === letter) last.count += 1;
		else buckets.push({ letter, start: i, count: 1 });
	});
	return buckets;
}

export function idleState(): LibraryIndexState {
	return {
		phase: 'idle',
		source: null,
		coreId: null,
		revision: null,
		status: null,
		artists: [],
		albums: [],
		artistBuckets: [],
		albumBuckets: [],
		capabilities: CATALOG_CAPABILITIES,
		truncated: false,
		error: null
	};
}

export function readyState(over: Partial<LibraryIndexState> = {}): LibraryIndexState {
	const artists = artistEntries(50);
	const sorted = [...artists].sort((a, b) => (a.searchKey < b.searchKey ? -1 : 1));
	return {
		...idleState(),
		phase: 'ready',
		source: 'catalog',
		coreId: 'core-a',
		revision: 1,
		status: syntheticStatus(),
		artists: sorted,
		albums: [],
		artistBuckets: bucketsFor(sorted),
		albumBuckets: [],
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

export function fakeDrillStore(albums: DrillAlbum[]) {
	const empty = {
		albums: [] as readonly DrillAlbum[],
		totalCount: 0,
		loading: false,
		loaded: false,
		error: null as string | null
	};
	const store = writable(empty);
	const load = vi.fn(async (_claim: unknown, _hierarchy: string, _itemKey: string) => {
		store.set({ albums, totalCount: albums.length, loading: false, loaded: true, error: null });
	});
	const reset = vi.fn(() => {
		store.set(empty);
	});
	return { subscribe: store.subscribe, load, reset };
}

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

export function fakeMostPlayedStore(over: Partial<MostPlayedState> = {}) {
	return writable<MostPlayedState>({
		topPerformers: [],
		topReleases: [],
		topTracks: [],
		pulledAt: '2026-07-26T12:00:00.000Z',
		loading: false,
		loaded: true,
		error: null,
		...over
	});
}

export function fakePlaylistsStore(
	playlists: PlaylistSummaryView[],
	over: Partial<PlaylistsState> = {}
) {
	return writable<PlaylistsState>({
		playlists,
		pulledAt: '2026-07-26T12:00:00.000Z',
		writes: null,
		loading: false,
		loaded: true,
		error: null,
		contents: {
			playlistId: null,
			data: null,
			loading: false,
			loaded: false,
			error: null
		},
		mutation: {
			busy: false,
			error: null,
			conflict: false,
			code: null,
			outcomeUnknown: false,
			detail: null
		},
		...over
	});
}

/** Fake open that lands canned contents in the store, like the real one. */
export function fakeOpenPlaylistData(
	store: ReturnType<typeof fakePlaylistsStore>,
	contentsById: Record<string, Omit<PlaylistContentsResponse, 'status'>>
) {
	return vi.fn(async (_fetchFn: typeof fetch, playlistId: string) => {
		store.update((s) => ({
			...s,
			contents: {
				playlistId,
				data: contentsById[playlistId] ?? null,
				loading: false,
				loaded: true,
				error: null
			}
		}));
	});
}

export interface Harness {
	sessionClient?: SessionClient;
	indexState?: LibraryIndexState;
	withContext?: boolean;
	fetchStatus?: () => Promise<ReturnType<typeof syntheticStatus>>;
	loadIndex?: ReturnType<typeof vi.fn>;
	genresStore?: ReturnType<typeof fakeNamedCountsStore>;
	composersStore?: ReturnType<typeof fakeNamedCountsStore>;
	paletteSearchStore?: Writable<PaletteSearchState>;
	searchPaletteData?: ReturnType<typeof vi.fn>;
	clearPaletteSearchData?: ReturnType<typeof vi.fn>;
	resetPaletteSearchData?: ReturnType<typeof vi.fn>;
	recentStore?: ReturnType<typeof fakeRecentStore>;
	mostPlayedStore?: ReturnType<typeof fakeMostPlayedStore>;
	loadMostPlayedData?: ReturnType<typeof vi.fn>;
	mostPlayedReset?: ReturnType<typeof vi.fn>;
	playlistsStore?: ReturnType<typeof fakePlaylistsStore>;
	loadPlaylistsData?: ReturnType<typeof vi.fn>;
	openPlaylistData?: ReturnType<typeof vi.fn>;
	closePlaylistView?: ReturnType<typeof vi.fn>;
	playlistsReset?: ReturnType<typeof vi.fn>;
	/**
	 * The extended scope views the mounted build carries. Left unset, the
	 * surface uses whatever the `@libraryFeatures` alias resolved to; set to a
	 * pair of nulls, it renders what a build without those views renders.
	 */
	scopeSlots?: Pick<ResolvedLibraryScopeSlots, 'mostPlayedView' | 'playlistsView'>;
	playlistActionController?: PublicSongActionController;
	drillStore?: ReturnType<typeof fakeDrillStore>;
	albumController?: LibraryAlbumController;
	songActionController?: UnifiedSongActionController;
	songRelationshipClient?: Pick<UnifiedSearchClient, 'relationship'>;
	albumActionController?: TimelineAlbumActionController;
	hydrateArtistAlbums?: ReturnType<typeof vi.fn>;
	getSocketClient?: () => ReturnType<typeof fakeConnectionSocket>;
}

export function mountMode(options: Harness = {}) {
	const session = fakeSessionClient();
	const indexStore = writable<LibraryIndexState>(options.indexState ?? idleState());
	const loadIndex = options.loadIndex ?? vi.fn(async () => {});
	const resetIndex = vi.fn();
	const fetchStatus = vi.fn(
		options.fetchStatus ?? (async () => syntheticStatus({ coreId: 'core-a' }))
	);
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
	const props = {
		sessionClient: options.sessionClient ?? session.client,
		indexStore: indexStore as unknown as IndexStore,
		loadIndex: loadIndex as never,
		resetIndex,
		prefsStore,
		genresStore: genresStore as unknown as typeof unifiedGenresStore,
		composersStore: composersStore as unknown as typeof unifiedComposersStore,
		paletteSearchStore: paletteSearchStore as unknown as typeof unifiedPaletteSearchStore,
		searchPaletteData: (options.searchPaletteData ?? vi.fn(async () => {})) as never,
		clearPaletteSearchData: clearPaletteSearchData as never,
		resetPaletteSearchData: resetPaletteSearchData as never,
		recentStore: options.recentStore as unknown as typeof recentlyPlayedStore,
		mostPlayedStore: options.mostPlayedStore as unknown as ResolvedLibraryScopeSlots['mostPlayedStore'],
		loadMostPlayedData: (options.loadMostPlayedData ?? vi.fn(async () => {})) as never,
		mostPlayedReset: (options.mostPlayedReset ?? vi.fn()) as never,
		playlistsStore: (options.playlistsStore ??
			fakePlaylistsStore([])) as unknown as ResolvedLibraryScopeSlots['playlistsStore'],
		...(options.scopeSlots ? { scopeSlots: options.scopeSlots } : {}),
		loadPlaylistsData: (options.loadPlaylistsData ?? vi.fn(async () => {})) as never,
		openPlaylistData: (options.openPlaylistData ?? vi.fn(async () => {})) as never,
		closePlaylistView: (options.closePlaylistView ?? vi.fn()) as never,
		playlistsReset: (options.playlistsReset ?? vi.fn()) as never,
		...(options.playlistActionController
			? { playlistActionController: options.playlistActionController }
			: {}),
		drillStore: options.drillStore as unknown as typeof unifiedDrillStore,
		fetchStatus: fetchStatus as never,
		fetchFn: (() => {
			throw new Error('modes must not fetch directly');
		}) as unknown as typeof fetch,
		...(options.hydrateArtistAlbums
			? { hydrateArtistAlbums: options.hydrateArtistAlbums as never }
			: {}),
		...(options.albumController ? { albumController: options.albumController } : {}),
		...(options.songActionController
			? { songActionController: options.songActionController }
			: {}),
		songRelationshipClient,
		...(options.albumActionController
			? { albumActionController: options.albumActionController }
			: {}),
		...(options.getSocketClient ? { getSocketClient: options.getSocketClient } : {})
	};

	const renderResult =
		options.withContext === true
			? render(UnifiedLibraryMode, {
					props,
					context: new Map([
						[
							LIBRARY_MODE_ACTIVATION_CONTEXT,
							{
								classicTruncationHistoryPolicy: () => 'preserve' as const,
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
		indexStore,
		loadIndex,
		resetIndex,
		fetchStatus,
		prefsStore,
		genresStore,
		composersStore,
		paletteSearchStore,
		clearPaletteSearchData,
		resetPaletteSearchData,
		songRelationshipClient,
		registered,
		setCommitted: (value: CommittedLibraryModeActivation | null) => {
			committed = value;
		}
	};
}

export function albumEntry(id: string, title: string, artistId: string): LibraryAlbumEntry {
	return {
		id,
		title,
		artist: `Artist of ${title}`,
		searchKey: `${title.toLowerCase()} — artist`,
		artistId
	};
}

export function fakeModeAlbumController(): {
	controller: LibraryAlbumController;
	open: ReturnType<typeof vi.fn>;
} {
	const store = writable({
		phase: 'resolving',
		albumLocalId: 'alb-1',
		generation: 1,
		requestId: 'r-1',
		operationId: null,
		resolvingDeadlineAt: null,
		artist: null,
		title: null,
		actionsAvailable: false,
		orderedTracks: [],
		candidates: [],
		code: null,
		error: null,
		transitionedAt: 1
	} as unknown as LibraryAlbumState);
	const open = vi.fn();
	return {
		controller: {
			subscribe: store.subscribe,
			open,
			cancel: vi.fn(),
			reset: vi.fn()
		} as unknown as LibraryAlbumController,
		open
	};
}

export function fakeModeActionController(): TimelineAlbumActionController {
	const store = writable({ phase: 'idle', actions: [], error: null });
	return {
		subscribe: store.subscribe,
		begin: vi.fn(),
		cancel: vi.fn()
	} as unknown as TimelineAlbumActionController;
}

export function fakePublicSongActionController(): PublicSongActionController {
	const store = writable({
		phase: 'idle',
		selectionId: null,
		semantic: null,
		zoneId: null,
		candidates: [],
		selectedCandidateId: null,
		code: null,
		error: null,
		authorityRetired: false
	});
	return {
		subscribe: store.subscribe,
		begin: vi.fn(),
		choose: vi.fn(),
		cancel: vi.fn(),
		reset: vi.fn(),
		abandon: vi.fn()
	} as unknown as PublicSongActionController;
}
