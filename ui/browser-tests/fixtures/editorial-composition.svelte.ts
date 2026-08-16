import { mount } from 'svelte';
import { writable } from 'svelte/store';

import '../../src/app.css';
import '../../src/routes/library/unified-surface.css';
import UnifiedLibraryMode from '../../src/routes/library/UnifiedLibraryMode.svelte';
import {
	CATALOG_CAPABILITIES,
	type LibraryArtistEntry,
	type LibraryIndexState,
	type libraryIndexStore
} from '../../src/lib/stores/libraryIndexStore';
import type {
	CompositionBrowseController,
	CompositionBrowseState,
	CompositionPage,
	CompositionRow
} from '../../src/lib/library/CompositionBrowseController';
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

// The composition surface lives inside UnifiedLibraryMode (plan Slice 6),
// so this fixture mounts the whole mode with deterministic injected
// collaborators — the same seam set the Vitest harness uses — and drives
// the real composer-drill path in Chromium.

const status: CatalogStatus = {
	coreId: 'browser-fixture-core',
	freshness: 'fresh',
	persistence: 'healthy',
	refresh: 'idle',
	available: true,
	complete: true,
	revision: 1,
	artistCount: 3,
	albumCount: 2,
	updatedAt: '2026-08-01T00:00:00.000Z',
	lastCompleteScanAt: '2026-08-01T00:00:00.000Z'
};

const artists: LibraryArtistEntry[] = [
	{ id: 'artist-a', name: 'Alpha Artist', searchKey: 'alpha artist', countComplete: true },
	{ id: 'artist-b', name: 'Beta Artist', searchKey: 'beta artist', countComplete: true },
	{ id: 'artist-c', name: 'Gamma Artist', searchKey: 'gamma artist', countComplete: true }
];

const indexState: LibraryIndexState = {
	phase: 'ready',
	source: 'catalog',
	coreId: 'browser-fixture-core',
	revision: 1,
	status,
	artists,
	albums: [],
	artistBuckets: [
		{ letter: 'A', start: 0, count: 1 },
		{ letter: 'B', start: 1, count: 1 },
		{ letter: 'G', start: 2, count: 1 }
	],
	albumBuckets: [],
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

const composersStore = namedCountsStore([
	{ label: 'Fixture Composer', albumCount: 2, itemKey: 'composer-fixture', imageKey: null }
]);
const genresStore = namedCountsStore([]);

const drillAlbums: DrillAlbum[] = [
	{ title: 'Composed Album', artist: 'Fixture Composer', imageKey: null }
];
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

const compositionList: CompositionRow[] = [
	{ title: 'Evening Study No. 1', subtitle: '2 recordings', itemKey: 'k-composition-1' },
	{ title: 'Evening Study No. 2', subtitle: '', itemKey: 'k-composition-2' }
];
const compositionNode: CompositionPage = {
	title: 'Evening Study No. 1',
	actions: [{ title: 'Play Work', itemKey: 'k-play-work' }],
	recordings: [
		{ title: 'Evening Study — Hall Recording', subtitle: 'Fixture Ensemble', itemKey: 'k-recording-1' },
		{ title: 'Composed by Fixture Composer', subtitle: '', itemKey: null }
	]
};
const recordingNode: CompositionPage = {
	title: 'Evening Study — Hall Recording',
	actions: [{ title: 'Play Now', itemKey: 'k-play-now' }],
	recordings: [{ title: 'Fixture Ensemble, 2020', subtitle: '', itemKey: null }]
};

const compositionIdle: CompositionBrowseState = {
	phase: 'idle',
	composerLabel: null,
	compositions: [],
	pages: [],
	actionBusy: false,
	notice: null,
	error: null
};
const compositionStore = writable<CompositionBrowseState>(compositionIdle);
let compositionCurrent = compositionIdle;
function setComposition(next: CompositionBrowseState): void {
	compositionCurrent = next;
	compositionStore.set(next);
}
const actionLog: string[] = [];
const compositionController = {
	subscribe: compositionStore.subscribe,
	async openForComposer(_claim: unknown, label: string) {
		setComposition({
			phase: 'compositions',
			composerLabel: label,
			compositions: compositionList,
			pages: [],
			actionBusy: false,
			notice: null,
			error: null
		});
	},
	async openComposition(_claim: unknown, row: CompositionRow) {
		if (row.itemKey === 'k-composition-1') {
			setComposition({ ...compositionCurrent, phase: 'page', pages: [compositionNode] });
		} else if (row.itemKey === 'k-recording-1') {
			setComposition({
				...compositionCurrent,
				phase: 'page',
				pages: [...compositionCurrent.pages, recordingNode]
			});
		}
	},
	async backToCompositions() {
		const pages = compositionCurrent.pages.slice(0, -1);
		setComposition({
			...compositionCurrent,
			phase: pages.length > 0 ? 'page' : 'compositions',
			pages
		});
	},
	async runAction(_claim: unknown, action: { title: string; itemKey: string }, zoneId: string) {
		actionLog.push(`${action.title}@${zoneId}`);
	},
	reset() {
		setComposition(compositionIdle);
	}
} as unknown as CompositionBrowseController;

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
if (!target) throw new Error('Missing editorial composition fixture target');

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
		clearPaletteSearchData: (async () => {
			paletteSearchStore.set({ phase: 'idle', query: '', groups: [], error: null });
		}) as never,
		resetPaletteSearchData: (() => {
			paletteSearchStore.set({ phase: 'idle', query: '', groups: [], error: null });
		}) as never,
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
			throw new Error('the composition fixture must not fetch');
		}) as unknown as typeof fetch,
		compositionController,
		getSocketClient: (() => connectionSocket) as never
	}
});

document.documentElement.dataset.fixtureReady = 'true';

const fixture = {
	setPresentation(theme: 'dark' | 'light', density: UnifiedLibraryDensity) {
		document.documentElement.dataset.theme = theme;
		prefsStore.setDensity(density);
	},
	actionLog(): string[] {
		return [...actionLog];
	}
};

declare global {
	interface Window {
		editorialCompositionFixture: typeof fixture;
	}
}

window.editorialCompositionFixture = fixture;
