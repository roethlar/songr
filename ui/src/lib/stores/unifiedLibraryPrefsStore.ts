import { browser } from '$app/environment';
import { writable, type Readable } from 'svelte/store';

/**
 * Unified Library sort/density preferences (plan §3.2, slice 4).
 * Persisted in localStorage under a versioned key; a `storage` listener
 * reconciles changes across tabs. Sorts remain device preferences. Density is
 * also captured in Unified semantic page state so browser Back/Forward can
 * restore an explicit size change without forfeiting persistence.
 */

export const UNIFIED_LIBRARY_PREFS_VERSION = 3;
export const UNIFIED_LIBRARY_PREFS_STORAGE_KEY = 'roon-controller-unified-library-prefs';

export type UnifiedLibraryDensity = 'compact' | 'normal' | 'pi';
export type UnifiedArtistsSort = 'az' | 'za' | 'most-albums' | 'fewest-albums';
export type UnifiedAlbumsSort = 'az' | 'za' | 'by-artist' | 'shuffle' | 'year-asc' | 'year-desc';
export type UnifiedGenresSort = 'az' | 'za' | 'most-albums';
export type UnifiedArtistDrillSort = 'az' | 'za' | 'shuffle' | 'year-asc' | 'year-desc';
export type UnifiedGenreDrillSort = 'az' | 'za' | 'by-artist' | 'shuffle' | 'year-asc' | 'year-desc';

export interface UnifiedLibrarySorts {
	readonly artists: UnifiedArtistsSort;
	readonly albums: UnifiedAlbumsSort;
	readonly genres: UnifiedGenresSort;
	readonly artist: UnifiedArtistDrillSort;
	readonly genre: UnifiedGenreDrillSort;
}

export type SortableUnifiedScope = keyof UnifiedLibrarySorts;

export interface UnifiedLibraryPrefs {
	readonly density: UnifiedLibraryDensity;
	readonly sorts: UnifiedLibrarySorts;
}

const DENSITIES: readonly string[] = ['compact', 'normal', 'pi'];
const SORT_VALUES: Readonly<Record<SortableUnifiedScope, readonly string[]>> = Object.freeze({
	artists: ['az', 'za', 'most-albums', 'fewest-albums'],
	albums: ['az', 'za', 'by-artist', 'shuffle', 'year-asc', 'year-desc'],
	genres: ['az', 'za', 'most-albums'],
	artist: ['az', 'za', 'shuffle', 'year-asc', 'year-desc'],
	genre: ['az', 'za', 'by-artist', 'shuffle', 'year-asc', 'year-desc']
});
const SORTABLE_SCOPES = Object.keys(SORT_VALUES) as readonly SortableUnifiedScope[];

export const DEFAULT_UNIFIED_LIBRARY_PREFS: UnifiedLibraryPrefs = Object.freeze({
	density: 'normal',
	sorts: Object.freeze({
		artists: 'az',
		albums: 'az',
		genres: 'az',
		artist: 'az',
		genre: 'az'
	}) as UnifiedLibrarySorts
});

interface UnifiedLibraryPrefsStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export type UnifiedLibraryStorageListener = (
	key: string | null,
	newValue: string | null
) => void;

export interface UnifiedLibraryPrefsStore extends Readable<UnifiedLibraryPrefs> {
	setDensity(value: unknown): boolean;
	setSort(scope: SortableUnifiedScope, value: unknown): boolean;
	/** Detach the cross-tab storage listener (tests and teardown). */
	destroy(): void;
}

interface UnifiedLibraryPrefsStoreOptions {
	isBrowser: boolean;
	getStorage?: () => UnifiedLibraryPrefsStorage;
	addStorageListener?: (listener: UnifiedLibraryStorageListener) => () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseUnifiedLibraryPrefs(raw: string | null): UnifiedLibraryPrefs {
	if (raw === null) return DEFAULT_UNIFIED_LIBRARY_PREFS;
	try {
		const value = JSON.parse(raw) as unknown;
		if (!isRecord(value)) return DEFAULT_UNIFIED_LIBRARY_PREFS;
		if (Object.keys(value).sort().join(',') !== 'density,sorts,version') {
			return DEFAULT_UNIFIED_LIBRARY_PREFS;
		}
		if (value.version !== UNIFIED_LIBRARY_PREFS_VERSION) {
			return DEFAULT_UNIFIED_LIBRARY_PREFS;
		}
		if (typeof value.density !== 'string' || !DENSITIES.includes(value.density)) {
			return DEFAULT_UNIFIED_LIBRARY_PREFS;
		}
		const sorts = value.sorts;
		if (!isRecord(sorts)) return DEFAULT_UNIFIED_LIBRARY_PREFS;
		if (Object.keys(sorts).sort().join(',') !== 'albums,artist,artists,genre,genres') {
			return DEFAULT_UNIFIED_LIBRARY_PREFS;
		}
		for (const scope of SORTABLE_SCOPES) {
			const sort = sorts[scope];
			if (typeof sort !== 'string' || !SORT_VALUES[scope].includes(sort)) {
				return DEFAULT_UNIFIED_LIBRARY_PREFS;
			}
		}
		return {
			density: value.density as UnifiedLibraryDensity,
			sorts: {
				artists: sorts.artists as UnifiedArtistsSort,
				albums: sorts.albums as UnifiedAlbumsSort,
				genres: sorts.genres as UnifiedGenresSort,
				artist: sorts.artist as UnifiedArtistDrillSort,
				genre: sorts.genre as UnifiedGenreDrillSort
			}
		};
	} catch {
		return DEFAULT_UNIFIED_LIBRARY_PREFS;
	}
}

function serializePrefs(prefs: UnifiedLibraryPrefs): string {
	return JSON.stringify({
		version: UNIFIED_LIBRARY_PREFS_VERSION,
		density: prefs.density,
		sorts: prefs.sorts
	});
}

export function createUnifiedLibraryPrefsStore({
	isBrowser,
	getStorage = () => window.localStorage,
	addStorageListener = (listener) => {
		const handler = (event: StorageEvent): void => listener(event.key, event.newValue);
		window.addEventListener('storage', handler);
		return () => window.removeEventListener('storage', handler);
	}
}: UnifiedLibraryPrefsStoreOptions): UnifiedLibraryPrefsStore {
	function readPersisted(): UnifiedLibraryPrefs {
		if (!isBrowser) return DEFAULT_UNIFIED_LIBRARY_PREFS;
		try {
			return parseUnifiedLibraryPrefs(getStorage().getItem(UNIFIED_LIBRARY_PREFS_STORAGE_KEY));
		} catch {
			return DEFAULT_UNIFIED_LIBRARY_PREFS;
		}
	}

	const internal = writable<UnifiedLibraryPrefs>(readPersisted());
	let current = readPersisted();

	const detach = isBrowser
		? addStorageListener((key, newValue) => {
				if (key !== UNIFIED_LIBRARY_PREFS_STORAGE_KEY) return;
				current = parseUnifiedLibraryPrefs(newValue);
				internal.set(current);
			})
		: null;

	function commit(next: UnifiedLibraryPrefs): boolean {
		if (!isBrowser) return false;
		// Persist before publishing so a failed write never leaves the
		// published state ahead of the durable state.
		try {
			getStorage().setItem(UNIFIED_LIBRARY_PREFS_STORAGE_KEY, serializePrefs(next));
		} catch {
			return false;
		}
		current = next;
		internal.set(next);
		return true;
	}

	return {
		subscribe: internal.subscribe,
		setDensity(value: unknown): boolean {
			if (typeof value !== 'string' || !DENSITIES.includes(value)) return false;
			return commit({ ...current, density: value as UnifiedLibraryDensity });
		},
		setSort(scope: SortableUnifiedScope, value: unknown): boolean {
			if (!SORTABLE_SCOPES.includes(scope)) return false;
			if (typeof value !== 'string' || !SORT_VALUES[scope].includes(value)) return false;
			return commit({
				...current,
				sorts: { ...current.sorts, [scope]: value }
			});
		},
		destroy(): void {
			detach?.();
		}
	};
}

export const unifiedLibraryPrefsStore = createUnifiedLibraryPrefsStore({ isBrowser: browser });
