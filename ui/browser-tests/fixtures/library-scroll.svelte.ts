import { mount } from 'svelte';
import { writable } from 'svelte/store';

import '../../src/app.css';
import '../../src/routes/library/unified-surface.css';
import UnifiedLibraryMode from '../../src/routes/library/UnifiedLibraryMode.svelte';
import {
	CATALOG_CAPABILITIES,
	type LibraryAlbumEntry,
	type LibraryArtistEntry,
	type LibraryIndexState,
	type libraryIndexStore
} from '../../src/lib/stores/libraryIndexStore';
import type { NamedCountEntry } from '../../src/lib/stores/unifiedNamedCountsStore';
import type { DrillAlbum } from '../../src/lib/stores/unifiedDrillStore';
import type { ClassicBrowseSessionClaim } from '../../src/lib/stores/classicBrowseSessionStore';
import type { PaletteSearchState } from '../../src/lib/stores/unifiedPaletteSearchStore';
import {
	createUnifiedLibraryPrefsStore,
	type UnifiedLibraryDensity
} from '../../src/lib/stores/unifiedLibraryPrefsStore';
import { setZonesSnapshot } from '../../src/lib/stores/zonesStore';
import { __resetNavigation } from '../../src/test/app-stubs/navigation';
import type { CatalogStatus } from '@shared/catalogContracts';

// Scroll restoration is a LAYOUT behaviour: the browser clamps `scrollTop` to
// the container's current scrollHeight, so a restore that runs before the list
// is laid out silently lands near the top. jsdom has no layout and would pass
// such a test vacuously, which is why this lives in the Chromium suite and
// mounts the whole mode against a library big enough to actually scroll.

const ARTIST_COUNT = 400;
const ALBUM_COUNT = 400;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function letterFor(index: number): string {
	return LETTERS[index % LETTERS.length];
}

const artists: LibraryArtistEntry[] = Array.from({ length: ARTIST_COUNT }, (_, index) => {
	const name = `${letterFor(index)}rtist ${String(index).padStart(3, '0')}`;
	return { id: `artist-${index}`, name, searchKey: name.toLowerCase(), countComplete: true };
});

const albums: LibraryAlbumEntry[] = Array.from({ length: ALBUM_COUNT }, (_, index) => {
	const title = `${letterFor(index)}lbum ${String(index).padStart(3, '0')}`;
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

const indexState: LibraryIndexState = {
	phase: 'ready',
	source: 'catalog',
	coreId: 'browser-fixture-core',
	revision: 1,
	status,
	artists,
	albums,
	artistBuckets: bucketsFor(artists),
	albumBuckets: bucketsFor(albums),
	capabilities: CATALOG_CAPABILITIES,
	truncated: false,
	error: null
};

let claimId = 0;
const sessionClient = {
	claim() {
		claimId += 1;
		return {
			owner: 'unified-mode',
			claimId,
			ready: Promise.resolve({ handleId: `handle-${claimId}`, generation: claimId })
		};
	},
	release() {},
	async recover(activeClaim: ClassicBrowseSessionClaim) {
		return activeClaim.ready;
	},
	connectionLost() {},
	isClaimCurrent() {
		return true;
	}
};

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
const composersStore = namedCountsStore([]);

const drillAlbums: DrillAlbum[] = Array.from({ length: 40 }, (_, index) => ({
	title: `Drill Album ${index}`,
	artist: 'Drill Artist',
	imageKey: null
}));
const drillEmpty = {
	albums: [] as readonly DrillAlbum[],
	totalCount: 0,
	loading: false,
	loaded: false,
	error: null as string | null
};
const drillState = writable(drillEmpty);
const drillStore = {
	subscribe: drillState.subscribe,
	async load() {
		drillState.set({
			albums: drillAlbums,
			totalCount: drillAlbums.length,
			loading: false,
			loaded: true,
			error: null
		});
	},
	reset() {
		drillState.set(drillEmpty);
	}
};

const paletteSearchStore = writable<PaletteSearchState>({
	phase: 'idle',
	query: '',
	groups: [],
	error: null
});

const recentStore = writable({ entries: [], loading: false, loaded: true });
const favoritesStore = writable({ entries: [], loading: false, loaded: true });

const prefsStorage = new Map<string, string>();
const prefsStore = createUnifiedLibraryPrefsStore({
	isBrowser: true,
	getStorage: () => ({
		getItem: (key: string) => prefsStorage.get(key) ?? null,
		setItem: (key: string, value: string) => {
			prefsStorage.set(key, value);
		}
	}),
	addStorageListener: () => () => {}
});

const connectionSocket = {
	connected: false,
	on() {},
	off() {}
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

__resetNavigation(window.location.href);

const target = document.querySelector<HTMLElement>('#app');
if (!target) throw new Error('Missing library scroll fixture target');

mount(UnifiedLibraryMode, {
	target,
	props: {
		sessionClient: sessionClient as never,
		indexStore: writable(indexState) as unknown as typeof libraryIndexStore,
		loadIndex: (async () => {}) as never,
		resetIndex: (() => {}) as never,
		prefsStore,
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
		drillStore: drillStore as never,
		fetchStatus: (async () => status) as never,
		fetchFn: (() => {
			throw new Error('the library scroll fixture must not fetch');
		}) as unknown as typeof fetch,
		getSocketClient: (() => connectionSocket) as never
	}
});

document.documentElement.dataset.fixtureReady = 'true';

const fixture = {
	setPresentation(theme: 'dark' | 'light', density: UnifiedLibraryDensity) {
		document.documentElement.dataset.theme = theme;
		prefsStore.setDensity(density);
	},
	artistCount: ARTIST_COUNT
};

declare global {
	interface Window {
		libraryScrollFixture: typeof fixture;
	}
}

window.libraryScrollFixture = fixture;
