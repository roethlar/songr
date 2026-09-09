import { mount, tick } from 'svelte';
import type { LibraryPreviewResponse } from '@shared/libraryPreviewContracts';
import { get, writable } from 'svelte/store';

import '../../src/app.css';
import '../../src/routes/library/unified-surface.css';
import UnifiedLibraryMode from '../../src/routes/library/UnifiedLibraryMode.svelte';
import type { LibraryAlbumEntry, LibraryArtistEntry } from '../../src/lib/libraryEntries';
import {
	liveAlbumEntry,
	liveArtistEntry,
	type LibraryRootsState
} from '../../src/lib/stores/libraryRootsStore';
import {
	LIBRARY_SESSION_RETIRED_CONTRACT,
	normalizeLibrarySessionRetiredEvent,
	type LibraryRootRow,
	type LibraryRowReference
} from '@shared/libraryRootsContracts';
import {
	CLASSIC_SESSION_RETIRED_CONTRACT,
	normalizeClassicSessionRetiredEvent,
	type ClassicBrowseSessionRef
} from '@shared/classicBrowseContracts';
import {
	LIBRARY_OPEN_CONTRACT,
	type LibraryLevelRow,
	type LibraryOpenResponse
} from '@shared/libraryOpenContracts';
import type { NamedCountEntry } from '../../src/lib/stores/unifiedNamedCountsStore';
import {
	createClassicBrowseSessionClient
} from '../../src/lib/stores/classicBrowseSessionStore';
import type {
	AlbumActionBeginInput,
	AlbumActionState
} from '../../src/lib/library/AlbumActionController';
import type { PaletteSearchState } from '../../src/lib/stores/unifiedPaletteSearchStore';
import {
	createUnifiedLibraryPrefsStore,
	type UnifiedLibraryDensity
} from '../../src/lib/stores/unifiedLibraryPrefsStore';
import { setSelectedZone } from '../../src/lib/stores/selectedZoneStore';
import { setZonesSnapshot } from '../../src/lib/stores/zonesStore';
import { __getNavigationLog, __resetNavigation } from '../../src/test/app-stubs/navigation';
import type { CatalogStatus } from '@shared/catalogContracts';
import { encodeLibraryRoute } from '../../src/lib/libraryRoute';
import { libraryEntryPageState, libraryRouteFromPageState } from '../../src/lib/libraryRouteState';
import {
	LIBRARY_MODE_ACTIVATION_CONTEXT,
	type LibraryModeActivationContext,
	type LibraryModeLifecycle
} from '../../src/lib/libraryModeActivationContext';
import type { LibraryViewActivationCause } from '../../src/lib/libraryPageState';

// Scroll restoration is a LAYOUT behaviour: the browser clamps `scrollTop` to
// the container's current scrollHeight, so a restore that runs before the list
// is laid out silently lands near the top. jsdom has no layout and would pass
// such a test vacuously, which is why this lives in the Chromium suite and
// mounts the whole mode against a library big enough to actually scroll.

const ARTIST_COUNT = window.libraryScrollFixtureSize?.artists ?? 400;
const ALBUM_COUNT = window.libraryScrollFixtureSize?.albums ?? 400;

const presentation = window.libraryScrollFixturePresentation;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function letterFor(index: number): string {
	return presentation?.singleLetter ? 'A' : LETTERS[index % LETTERS.length];
}

const artists: LibraryArtistEntry[] = Array.from({ length: ARTIST_COUNT }, (_, index) => {
	const name = `${letterFor(index)}rtist ${String(index).padStart(3, '0')}`;
	return { id: `artist-${index}`, name, searchKey: name.toLowerCase(), countComplete: true };
});

const albums: LibraryAlbumEntry[] = Array.from({ length: ALBUM_COUNT }, (_, index) => {
	const title = `${letterFor(index)}lbum ${String(index).padStart(3, '0')}${presentation?.longTitles && index % 3 === 0 ? ' — Live recordings with a much longer title over multiple lines' : ''}`;
	return {
		id: `album-${index}`,
		localId: `album-${index}`,
		title,
		artist: artists[index % artists.length].name,
		artistId: artists[index % artists.length].id,
		searchKey: title.toLowerCase(),
		imageKey: null,
		releaseYear: null
	} as unknown as LibraryAlbumEntry;
});

const creditVariant = window.libraryScrollFixtureVariant === 'album-credits';
const coldStart = window.libraryScrollFixtureColdStart === true;
const longCredit = 'The International Ensemble for Contemporary Music / North and South / Live Recordings and Collaborations';
if (creditVariant) {
	const special = [
		['Solo Record', 'Single Release'], ['Collaboration; One', 'AC/DC / Björk; 100%'],
		['No Credit', ''], ['Literal Unknown', 'Unknown album artist']
	];
	albums.forEach((album, index) => {
		const [title, credit] = special[index] ?? [index >= 398 ? 'Repeated Rendering' : album.title, longCredit];
		album.title = title;
		album.artist = credit;
		album.searchKey = title.toLowerCase();
	});
}

function bucketsFor(names: readonly { name?: string; title?: string }[]) {
	const buckets: { letter: string; start: number; count: number }[] = [];
	names.forEach((entry, index) => {
		const letter = (entry.name ?? entry.title ?? '?').charAt(0).toUpperCase();
		const last = buckets[buckets.length - 1];
		if (last && last.letter === letter) last.count += 1;
		else buckets.push({ letter, start: index, count: 1 });
	});
	return buckets;
}

const status: CatalogStatus = {
	coreId: 'browser-fixture-core',
	freshness: 'fresh',
	persistence: 'healthy',
	refresh: 'idle',
	available: true,
	complete: true,
	revision: 1,
	artistCount: ARTIST_COUNT,
	albumCount: ALBUM_COUNT,
	updatedAt: '2026-08-01T00:00:00.000Z',
	lastCompleteScanAt: '2026-08-01T00:00:00.000Z'
};

// ---- Roon's own two roots, as the fixture serves them ----------------
//
// `.agents/plans/library-live-view.md` Slice 2: the Artists and Albums lists
// are Roon's roots, and every page under them is Roon's own level. The same
// 400 rows the catalog index describes are served here as live rows, so the
// list this fixture scrolls is the one the surface actually renders.

let liveGeneration = 'fixture-gen-1';

function liveRef(token: string, generation = liveGeneration): LibraryRowReference {
	return { generation, token };
}

function artistRowsFor(generation: string): LibraryRootRow[] {
 const counts = new Map<string, number>();
 for (const album of albums) counts.set(album.artist, (counts.get(album.artist) ?? 0) + 1);
	return artists.map((artist) => ({
		ref: liveRef(`artist:${artist.name}`, generation),
		title: artist.name,
		subtitle: `${counts.get(artist.name) ?? 0} Albums`
	}));
}

function albumRowsFor(generation: string): LibraryRootRow[] {
	return albums.map((album, index) => ({
		ref: liveRef(`album:${album.title}${creditVariant && index >= 398 ? `:copy:${index}` : ''}`, generation),
		title: album.title,
		imageKey: presentation?.artwork ? `art-${index}` : undefined,
		subtitle: album.artist
	}));
}

let artistRows = artistRowsFor(liveGeneration);
let albumRows = albumRowsFor(liveGeneration);

function rootsStateFor(retirementRevision: number): LibraryRootsState {
	return {
		phase: 'ready',
		generation: liveGeneration,
		coreId: 'browser-fixture-core',
		readAt: '2026-09-03T00:00:00.000Z',
		artists: artistRows.map(liveArtistEntry),
		albums: albumRows.map(liveAlbumEntry),
		artistRows,
		albumRows,
		artistBuckets: bucketsFor(artistRows.map((row) => ({ name: row.title }))),
		albumBuckets: bucketsFor(albumRows.map((row) => ({ title: row.title }))),
		artistCount: artistRows.length,
		albumCount: albumRows.length,
		unavailable: null,
		error: null,
		retirementRevision,
		retirementReason: retirementRevision === 0 ? null : 'session-lost'
	};
}

const rootsStore = writable<LibraryRootsState>(coldStart ? {
	...rootsStateFor(0), phase: 'loading', generation: null, readAt: null,
	artists: [], albums: [], artistRows: [], albumRows: [],
	artistBuckets: [], albumBuckets: [], artistCount: null, albumCount: null
} : rootsStateFor(0));

const composerName = 'Philip Glass';

function liveLevel(
	title: string,
	rows: readonly LibraryLevelRow[],
	subtitle?: string
): LibraryOpenResponse {
	return {
		contract: LIBRARY_OPEN_CONTRACT,
		kind: 'level',
		generation: liveGeneration,
		title,
		...(subtitle === undefined ? {} : { subtitle }),
		count: rows.length,
		rows
	};
}

function openLiveRoot(
	_fetchFn: typeof fetch,
	root: 'genres' | 'composers'
): Promise<LibraryOpenResponse> {
	if (root === 'composers') {
		return Promise.resolve(
			liveLevel('Composers', [
				levelRow(liveRef(`composer:${composerName}`), composerName, 'composer')
			])
		);
	}
	return Promise.resolve(
		liveLevel(
			'Genres',
			[...Array.from({ length: 60 }, (_unused, index) => {
				const title = `Genre ${String(index).padStart(2, '0')}`;
				return levelRow(liveRef(`genre:${title}`), title, 'genre');
			}), ...['80s', 'Alt. Rock'].map(title => levelRow(liveRef(`genre:${title}`), title, 'genre'))]
		)
	);
}

function levelRow(
	ref: LibraryRowReference,
	title: string,
	kind: LibraryLevelRow['kind'],
	subtitle?: string
): LibraryLevelRow {
	return { ref, title, kind, ...(subtitle === undefined ? {} : { subtitle }) };
}

const liveOpenRefs: LibraryRowReference[] = [];
const livePreviewReads: { ref: LibraryRowReference; limit: number }[] = [];

function genreSection(token: string): { title: string; rows: LibraryLevelRow[] } | null {
	const match = /^section:(genre-00|subgenre-00|80s|Alt\. Rock):(artists|albums)$/u.exec(token);
	if (!match) return null;
	const [, genre, section] = match;
	const kind = section === 'artists' ? 'artist' : 'album';
	const count = genre === 'Alt. Rock' ? 1 : kind === 'artist' ? 4 : genre === '80s' ? 17 : albumRows.length;
	const source = kind === 'artist' ? artistRows : albumRows;
	return { title: kind === 'artist' ? 'Artists' : 'Albums', rows: source.slice(0, count).map((row, index) => ({
		...levelRow(row.ref, row.title, kind, row.subtitle), ...(index === 0 ? { imageKey: 'unavailable-preview-art' } : {})
	})) };
}

function previewLiveSection(_fetchFn: typeof fetch, ref: LibraryRowReference, limit: number): Promise<LibraryPreviewResponse> {
	livePreviewReads.push({ ref: { ...ref }, limit });
	if (ref.generation !== liveGeneration) return Promise.resolve({ contract: 'library-preview-v1', kind: 'stale' });
	const source = genreSection(ref.token);
	if (!source) return Promise.resolve({ contract: 'library-preview-v1', kind: 'unavailable', reason: 'read-failed', message: 'Unknown fixture section' });
	return Promise.resolve({ contract: 'library-preview-v1', kind: 'preview', generation: liveGeneration,
		title: source.title, totalCount: source.rows.length, limit, rows: source.rows.slice(0, limit) });
}

/** What Roon returns for one opened row, keyed by the token it was given. */
function openLiveRef(_fetchFn: typeof fetch, ref: LibraryRowReference): Promise<LibraryOpenResponse> {
	liveOpenRefs.push({ ...ref });
	if (ref.generation !== liveGeneration) {
		return Promise.resolve({ contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' });
	}
	const section = genreSection(ref.token);
	if (section) return Promise.resolve(liveLevel(section.title, section.rows));
	if (ref.token === 'genre:80s' || ref.token === 'genre:Alt. Rock') {
		const title = ref.token.slice('genre:'.length);
		return Promise.resolve(liveLevel(title, [
			levelRow(liveRef(`action:${title}`), 'Play Genre', 'action'),
			levelRow(liveRef(`section:${title}:artists`), 'Artists', 'section'),
			levelRow(liveRef(`section:${title}:albums`), 'Albums', 'section')
		]));
	}
	if (ref.token === 'genre:Genre 00') {
		return Promise.resolve(
			liveLevel('Genre 00', [
				levelRow(liveRef('action:genre-00'), 'Play Genre', 'action'),
				levelRow(liveRef('section:genre-00:albums'), 'Albums', 'section'),
				levelRow(liveRef('genre:Subgenre 00'), 'Subgenre 00', 'genre'),
				levelRow(liveRef('section:genre-00:artists'), 'Artists', 'section')
			])
		);
	}
	if (ref.token === 'genre:Subgenre 00') {
		return Promise.resolve(
			liveLevel('Subgenre 00', [
				levelRow(liveRef('section:subgenre-00:artists'), 'Artists', 'section')
			])
		);
	}
	if (ref.token === `composer:${composerName}`) {
		return Promise.resolve(
			liveLevel(composerName, [
				levelRow(liveRef('action:composer'), 'Play Composer', 'action'),
				levelRow(liveRef('composition:glassworks'), 'Glassworks', 'composition')
			])
		);
	}
	if (ref.token === 'composition:glassworks') {
		return Promise.resolve(
			liveLevel('Glassworks', [
				levelRow(liveRef('action:composition'), 'Play Composition', 'action'),
				levelRow(liveRef('track:opening'), 'Opening', 'track', composerName)
			])
		);
	}
	if (ref.token === 'track:opening') {
		return Promise.resolve(
			liveLevel(
				'Opening',
				[levelRow(liveRef('action:recording'), 'Play Recording', 'action')],
				composerName
			)
		);
	}
	const artistMatch = /^artist:(.*)$/u.exec(ref.token);
	if (artistMatch) {
		const name = artistMatch[1];
		const own = albums.filter((album) => album.artist === name);
		const rows = [
			levelRow(liveRef(`verb:${name}`), 'Play Artist', 'action'),
			...own.map((album) => levelRow(liveRef(`album:${album.title}`), album.title, 'album', name))
		];
		return Promise.resolve({
			contract: LIBRARY_OPEN_CONTRACT,
			kind: 'level',
			generation: liveGeneration,
			title: name,
			count: rows.length,
			rows
		});
	}
	const albumIndex = albumRows.findIndex(row => row.ref.token === ref.token);
	const album = albumIndex < 0 ? undefined : albums[albumIndex];
	if (album) {
		const rows = [
			levelRow(liveRef(`play:${album.title}`), 'Play Album', 'action'),
			...Array.from({ length: 12 }, (_unused, index) =>
				levelRow(
					liveRef(`track:${album.title}:${index}`),
					`Track ${String(index + 1).padStart(2, '0')}`,
					'track',
					album.artist
				)
			)
		];
		return Promise.resolve({
			contract: LIBRARY_OPEN_CONTRACT,
			kind: 'level',
			generation: liveGeneration,
			title: album.title,
			subtitle: album.artist,
			count: rows.length,
			rows
		});
	}
	return Promise.resolve({ contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' });
}

type ConnectionEvent = 'connect' | 'disconnect';
const connectionListeners = new Map<ConnectionEvent, Set<() => void>>();
const connectionSocket = {
	connected: !coldStart,
	on(event: ConnectionEvent, listener: () => void) {
		const listeners = connectionListeners.get(event) ?? new Set();
		listeners.add(listener);
		connectionListeners.set(event, listeners);
	},
	off(event: ConnectionEvent, listener: () => void) {
		connectionListeners.get(event)?.delete(listener);
	},
	fire(event: ConnectionEvent) {
		this.connected = event === 'connect';
		for (const listener of connectionListeners.get(event) ?? []) listener();
	},
	listenerCount(event: ConnectionEvent) {
		return connectionListeners.get(event)?.size ?? 0;
	}
};

let classicRequestSequence = 0;
let classicAcquisitionCount = 0;
const acquiredClassicSessions: ClassicBrowseSessionRef[] = [];
const releasedClassicSessions: ClassicBrowseSessionRef[] = [];
const sessionClient = createClassicBrowseSessionClient({
	getSocket: () => connectionSocket as never,
	getTabId: () => 'browser-fixture-tab',
	createRequestId: () => `classic-request-${++classicRequestSequence}`,
	emit: (async (_socket: unknown, event: string, request: unknown) => {
		if (event === 'classic-session:acquire') {
			classicAcquisitionCount += 1;
			const session = {
				handleId: `handle-${classicAcquisitionCount}`,
				generation: classicAcquisitionCount
			};
			acquiredClassicSessions.push(session);
			return {
				success: true,
				data: {
					requestId: (request as { requestId: string }).requestId,
					session
				}
			};
		}
		if (event === 'classic-session:release') {
			releasedClassicSessions.push(
				(request as { session: ClassicBrowseSessionRef }).session
			);
			return { success: true, data: { released: true } };
		}
		throw new Error(`Unexpected Classic fixture event: ${event}`);
	}) as never
});
let currentClassicSession: ClassicBrowseSessionRef | null = null;
sessionClient.subscribe((state) => {
	currentClassicSession = state.session;
});

function namedCountsStore(entries: NamedCountEntry[]) {
	const empty = {
		entries: [] as readonly NamedCountEntry[],
		totalCount: 0,
		loading: false,
		loaded: false,
		error: null as string | null
	};
	const store = writable(empty);
	return {
		subscribe: store.subscribe,
		async load() {
			store.set({
				entries,
				totalCount: entries.length,
				loading: false,
				loaded: true,
				error: null
			});
		},
		reset() {
			store.set(empty);
		}
	};
}

const genresStore = namedCountsStore(
	Array.from({ length: 60 }, (_, index) => ({
		label: `Genre ${String(index).padStart(2, '0')}`,
		albumCount: 3,
		itemKey: `genre-${index}`,
		imageKey: null
	}))
);
const composersStore = namedCountsStore([
	{ label: composerName, albumCount: 12, itemKey: 'composer-philip-glass', imageKey: null }
]);

const paletteSearchStore = writable<PaletteSearchState>({
	phase: 'idle',
	query: '',
	groups: [],
	error: null
});

const recentStore = writable({ entries: [], loading: false, loaded: true });
const favoritesStore = writable({ entries: [], loading: false, loaded: true });

const prefsStore = createUnifiedLibraryPrefsStore({
	isBrowser: true,
	getStorage: () => window.localStorage
});
// The existing fixture URL explicitly exercises All artists. Real /library
// entry tests use a fresh preference, just like the production host.
if (window.location.pathname === '/fixtures/library-scroll.html') prefsStore.setArtistView('all-artists');
if (presentation?.albumsSort) prefsStore.setSort('albums', presentation.albumsSort);

function fixtureActionState(overrides: Partial<AlbumActionState> = {}): AlbumActionState {
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

type FixtureActionStep =
	| 'choose'
	| 'begin-session-lost'
	| 'hold-resolution'
	| 'outcome-unknown';

const actionState = writable<AlbumActionState>(fixtureActionState());
const actionBegins: Array<{
	readonly requestId: string;
	readonly generation: number;
	readonly input: AlbumActionBeginInput;
}> = [];
let actionScript: FixtureActionStep[] = [];
let actionRequestSequence = 0;
let activeActionRequestId: string | null = null;
let actionExecutions = 0;

function publishActionFailure(requestId: string, error: string): void {
	actionState.update((state) => ({
		...state,
		phase: 'failed',
		requestId,
		actions: [],
		executionAttempted: false,
		code: 'SESSION_LOST',
		error,
		transitionedAt: state.transitionedAt + 1
	}));
}

const albumActionController = {
	subscribe: actionState.subscribe,
	begin(input: AlbumActionBeginInput) {
		actionRequestSequence += 1;
		const requestId = `fixture-request-${actionRequestSequence}`;
		activeActionRequestId = requestId;
		actionBegins.push({ requestId, generation: input.generation, input: { ...input } });
		actionState.set(
			fixtureActionState({
				phase: 'resolving',
				pageId: 'pageId' in input ? input.pageId : null,
				versionId: 'versionId' in input ? input.versionId : null,
				zoneId: input.zoneId,
				generation: input.generation,
				requestId,
				transitionedAt: actionRequestSequence
			})
		);
		const step = actionScript.shift() ?? 'choose';
		queueMicrotask(() => {
			if (activeActionRequestId !== requestId) return;
			if (step === 'begin-session-lost') {
				publishActionFailure(requestId, 'The Classic session retired before begin');
				return;
			}
			if (step === 'outcome-unknown') {
				actionState.update((state) => ({
					...state,
					phase: 'outcome-unknown',
					requestId,
					// Deliberately hostile producer: phase alone must make replay
					// impossible, even if the other fields resemble a safe refusal.
					executionAttempted: false,
					code: 'SESSION_LOST',
					error: 'The action may already have executed',
					transitionedAt: state.transitionedAt + 1
				}));
				return;
			}
			if (step === 'hold-resolution') return;
			actionState.update((state) => ({
				...state,
				phase: 'choosing',
				requestId,
				operationId: `fixture-operation-${actionRequestSequence}`,
				actions: [
					{ actionId: 'fixture-play-now', label: 'Play now', semantic: 'play-now' }
				],
				transitionedAt: state.transitionedAt + 1
			}));
		});
		return { started: true, requestId };
	},
	execute() {
		actionExecutions += 1;
		throw new Error('The read-only browser fixture must never execute playback');
	},
	cancel() {
		activeActionRequestId = null;
		actionState.update((state) => ({
			...state,
			phase: 'canceled',
			actions: [],
			code: 'CANCELED',
			error: null,
			transitionedAt: state.transitionedAt + 1
		}));
		return true;
	},
	reset() {
		activeActionRequestId = null;
		actionState.set(fixtureActionState());
	}
};

setZonesSnapshot([
	{
		zone_id: 'zone-fixture',
		display_name: 'Fixture Zone',
		state: 'paused',
		is_play_allowed: true,
		is_pause_allowed: true,
		is_previous_allowed: true,
		is_next_allowed: true,
		is_seek_allowed: true,
		outputs: []
	}
]);
setSelectedZone('zone-fixture');

__resetNavigation(window.location.href);

const target = document.querySelector<HTMLElement>('#app');
if (!target) throw new Error('Missing library scroll fixture target');

let registeredLifecycle: LibraryModeLifecycle | null = null;
const activationContext: LibraryModeActivationContext = {
	committedActivation: () => null,
	registerLifecycle(_mode, lifecycle) {
		registeredLifecycle = lifecycle;
		return () => {
			if (registeredLifecycle === lifecycle) registeredLifecycle = null;
		};
	}
};

mount(UnifiedLibraryMode, {
	target,
	context: new Map([[LIBRARY_MODE_ACTIVATION_CONTEXT, activationContext]]),
	props: {
		sessionClient: sessionClient as never,
		rootsStore: rootsStore as never,
		loadRoots: (async () => {}) as never,
		openLiveRef: openLiveRef as never,
		openLiveRoot: openLiveRoot as never,
		previewLiveSection: previewLiveSection as never,
		fetchCoreStatusData: (async () => ({
			status: 'paired',
			core: { id: 'browser-fixture-core', displayName: 'Fixture', displayVersion: '1' }
		})) as never,
		prefsStore,
		albumActionController: albumActionController as never,
		genresStore: genresStore as never,
		composersStore: composersStore as never,
		paletteSearchStore: paletteSearchStore as never,
		searchPaletteData: (async () => {}) as never,
		clearPaletteSearchData: (async () => {}) as never,
		resetPaletteSearchData: (() => {}) as never,
		recentStore: recentStore as never,
		loadRecent: (async () => {}) as never,
		favoritesDataStore: favoritesStore as never,
		loadFavoritesData: (async () => {}) as never,
		removeFavoriteData: (async () => {}) as never,
		loadMostPlayedData: (async () => {}) as never,
		loadPlaylistsData: (async () => {}) as never,
		fetchStatus: (async () => status) as never,
		fetchFn: (() => {
			throw new Error('the library scroll fixture must not fetch');
		}) as unknown as typeof fetch,
		getSocketClient: (() => connectionSocket) as never
	}
});

await tick();
if (registeredLifecycle === null) throw new Error('Library fixture lifecycle did not register');
const lifecycle: LibraryModeLifecycle = registeredLifecycle;

function restoreLocation(cause: LibraryViewActivationCause): void {
	const url = new URL(window.location.href);
	const pageState = libraryEntryPageState(url, get(prefsStore).artistView);
	lifecycle.resume({ cause, pageState });
	if (cause === 'initial' && (url.pathname === '/library' || url.pathname === '/library/')) {
		window.history.replaceState({}, '', encodeLibraryRoute(libraryRouteFromPageState(pageState)!));
	}
}

restoreLocation('initial');

// The SvelteKit navigation stub intentionally keeps an in-memory history for
// unit tests. This browser-only fixture mirrors every handled Library write
// into the real History API so Chromium can prove buttons (scope/palette) and
// anchors with the same reload/popstate behavior.
let mirroredNavigationCount = __getNavigationLog().length;
document.addEventListener('click', (event) => {
	if (
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	) {
		return;
	}
	queueMicrotask(() => {
		const navigation = __getNavigationLog();
		for (const entry of navigation.slice(mirroredNavigationCount)) {
			if (entry.operation === 'pushState') window.history.pushState({}, '', entry.url);
			else if (entry.operation === 'replaceState') window.history.replaceState({}, '', entry.url);
		}
		mirroredNavigationCount = navigation.length;
	});
});

window.addEventListener('popstate', () => {
	lifecycle.suspend();
	restoreLocation('history-pop');
});

document.documentElement.dataset.fixtureReady = 'true';

function sendModeRetired(session = currentClassicSession): ClassicBrowseSessionRef {
	if (session === null) throw new Error('No live Classic session to retire');
	const event = normalizeClassicSessionRetiredEvent({
		contract: CLASSIC_SESSION_RETIRED_CONTRACT,
		tabId: 'browser-fixture-tab',
		session,
		reason: 'SESSION_LOST'
	});
	if (event === null) throw new Error('Fixture produced an invalid retirement event');
	sessionClient.retireServerSession(event.session);
	return { ...event.session };
}

let libraryRetirementRevision = 0;
async function replaceRetiredLibraryGeneration(): Promise<{
	readonly retired: string;
	readonly replacement: string;
}> {
	const retired = liveGeneration;
	const event = normalizeLibrarySessionRetiredEvent({
		contract: LIBRARY_SESSION_RETIRED_CONTRACT,
		coreId: 'browser-fixture-core',
		retired,
		reason: 'session-lost'
	});
	if (event === null) throw new Error('Fixture produced an invalid library retirement event');
	libraryRetirementRevision += 1;
	rootsStore.set({
		...rootsStateFor(libraryRetirementRevision),
		phase: 'idle',
		generation: null,
		readAt: null,
		artists: [],
		albums: [],
		artistRows: [],
		albumRows: [],
		artistBuckets: [],
		albumBuckets: [],
		artistCount: null,
		albumCount: null,
		retirementReason: 'session-lost'
	});
	await tick();
	liveGeneration = `fixture-gen-${libraryRetirementRevision + 1}`;
	artistRows = artistRowsFor(liveGeneration);
	albumRows = albumRowsFor(liveGeneration);
	rootsStore.set(rootsStateFor(libraryRetirementRevision));
	await tick();
	return { retired, replacement: liveGeneration };
}

const fixture = {
	async publishInitialRoots() {
		rootsStore.set(rootsStateFor(0));
		await tick();
	},
	longCredit,
	async replaceAlbumCredit(credit: string, replacement: string) {
		for (const album of albums) if (album.artist === credit) album.artist = replacement;
		return replaceRetiredLibraryGeneration();
	},
	setPresentation(theme: 'dark' | 'light', density: UnifiedLibraryDensity) {
		document.documentElement.dataset.theme = theme;
		prefsStore.setDensity(density);
	},
	setActionScript(steps: FixtureActionStep[]) {
		actionScript = [...steps];
	},
	failCurrentResolution() {
		if (activeActionRequestId === null) throw new Error('No action resolution is active');
		publishActionFailure(
			activeActionRequestId,
			'The Classic session retired during resolution'
		);
	},
	sendModeRetired,
	async replaceRetiredLibraryGeneration() {
		return replaceRetiredLibraryGeneration();
	},
	fireConnection(event: ConnectionEvent) {
		connectionSocket.fire(event);
	},
	suspendMode() {
		lifecycle.suspend();
	},
	artistCount: ARTIST_COUNT,
	get socketConnected() {
		return connectionSocket.connected;
	},
	get connectionListenerCounts() {
		return {
			connect: connectionSocket.listenerCount('connect'),
			disconnect: connectionSocket.listenerCount('disconnect')
		};
	},
	get classicAcquisitionCount() {
		return classicAcquisitionCount;
	},
	get classicReleaseCount() {
		return releasedClassicSessions.length;
	},
	get acquiredClassicSessions() {
		return acquiredClassicSessions.map((session) => ({ ...session }));
	},
	get currentClassicSession() {
		return currentClassicSession === null ? null : { ...currentClassicSession };
	},
	get actionBegins() {
		return actionBegins.map(({ requestId, generation, input }) => ({
			requestId,
			generation,
			input: { ...input }
		}));
	},
	get liveGeneration() {
		return liveGeneration;
	},
	get liveOpenRefs() {
		return liveOpenRefs.map((ref) => ({ ...ref }));
	},
	get livePreviewReads() {
		return livePreviewReads.map(read => ({ ref: { ...read.ref }, limit: read.limit }));
	},
	get actionExecutions() {
		return actionExecutions;
	}
};

declare global {
	interface Window {
		libraryScrollFixtureSize?: { artists: number; albums: number };
		libraryScrollFixtureVariant?: 'album-credits';
		libraryScrollFixturePresentation?: { artwork?: boolean; singleLetter?: boolean; longTitles?: boolean; albumsSort?: 'az' | 'shuffle' };
		libraryScrollFixtureColdStart?: boolean;
		libraryScrollFixture: typeof fixture;
	}
}

window.libraryScrollFixture = fixture;
