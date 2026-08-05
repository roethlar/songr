import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	createUnifiedLibraryPrefsStore,
	parseUnifiedLibraryPrefs,
	DEFAULT_UNIFIED_LIBRARY_PREFS,
	UNIFIED_LIBRARY_PREFS_STORAGE_KEY,
	UNIFIED_LIBRARY_PREFS_VERSION,
	type UnifiedLibraryStorageListener
} from '../unifiedLibraryPrefsStore';

function memoryStorage(): {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	map: Map<string, string>;
} {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		}
	};
}

function validRaw(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: UNIFIED_LIBRARY_PREFS_VERSION,
		density: 'compact',
		sorts: {
			artists: 'za',
			albums: 'by-artist',
			genres: 'most-albums',
			artist: 'shuffle',
			genre: 'by-artist'
		},
		...over
	});
}

describe('parseUnifiedLibraryPrefs', () => {
	it('round-trips a valid envelope', () => {
		expect(parseUnifiedLibraryPrefs(validRaw())).toEqual({
			density: 'compact',
			sorts: {
				artists: 'za',
				albums: 'by-artist',
				genres: 'most-albums',
				artist: 'shuffle',
				genre: 'by-artist'
			}
		});
	});

	it.each([
		['null raw', null],
		['not json', '{'],
		['not an object', '"compact"'],
		['extra key', validRaw({ extra: 1 })],
		['wrong version', validRaw({ version: UNIFIED_LIBRARY_PREFS_VERSION + 1 })],
		['unknown density', validRaw({ density: 'cozy' })],
		['missing sort scope', validRaw({ sorts: { artists: 'az' } })],
		[
			'sort value from another scope',
			validRaw({
				sorts: {
					artists: 'shuffle',
					albums: 'az',
					genres: 'az',
					artist: 'az',
					genre: 'az'
				}
			})
		],
		[
			'removed composer sort scope',
			validRaw({
				sorts: {
					artists: 'az',
					albums: 'az',
					genres: 'az',
					artist: 'az',
					genre: 'az',
					composers: 'az'
				}
			})
		]
	])('falls back to defaults on %s', (_name, raw) => {
		expect(parseUnifiedLibraryPrefs(raw)).toEqual(DEFAULT_UNIFIED_LIBRARY_PREFS);
	});
});

describe('unifiedLibraryPrefsStore', () => {
	it('reads persisted prefs at creation and validates commits', () => {
		const storage = memoryStorage();
		storage.setItem(UNIFIED_LIBRARY_PREFS_STORAGE_KEY, validRaw());
		const store = createUnifiedLibraryPrefsStore({
			isBrowser: true,
			getStorage: () => storage,
			addStorageListener: () => () => {}
		});

		expect(get(store).density).toBe('compact');

		expect(store.setDensity('pi')).toBe(true);
		expect(get(store).density).toBe('pi');
		expect(store.setDensity('cozy')).toBe(false);
		expect(get(store).density).toBe('pi');

		expect(store.setSort('albums', 'shuffle')).toBe(true);
		expect(get(store).sorts.albums).toBe('shuffle');
		expect(store.setSort('genres', 'shuffle')).toBe(false);
		expect(get(store).sorts.genres).toBe('most-albums');
		expect(store.setSort('artist', 'za')).toBe(true);
		expect(get(store).sorts.artist).toBe('za');
		expect(store.setSort('genre', 'by-artist')).toBe(true);
		expect(get(store).sorts.genre).toBe('by-artist');

		const persisted = parseUnifiedLibraryPrefs(
			storage.getItem(UNIFIED_LIBRARY_PREFS_STORAGE_KEY)
		);
		expect(persisted).toEqual(get(store));
	});

	it('never publishes a state it could not persist', () => {
		const storage = memoryStorage();
		const store = createUnifiedLibraryPrefsStore({
			isBrowser: true,
			getStorage: () => ({
				getItem: storage.getItem,
				setItem: () => {
					throw new Error('quota');
				}
			}),
			addStorageListener: () => () => {}
		});

		expect(store.setDensity('compact')).toBe(false);
		expect(get(store)).toEqual(DEFAULT_UNIFIED_LIBRARY_PREFS);
	});

	it('reconciles cross-tab storage events for its own key only', () => {
		const storage = memoryStorage();
		let listener: UnifiedLibraryStorageListener | null = null;
		const detach = vi.fn();
		const store = createUnifiedLibraryPrefsStore({
			isBrowser: true,
			getStorage: () => storage,
			addStorageListener: (handler) => {
				listener = handler;
				return detach;
			}
		});

		expect(get(store)).toEqual(DEFAULT_UNIFIED_LIBRARY_PREFS);

		listener!('some-other-key', validRaw());
		expect(get(store)).toEqual(DEFAULT_UNIFIED_LIBRARY_PREFS);

		listener!(UNIFIED_LIBRARY_PREFS_STORAGE_KEY, validRaw());
		expect(get(store).density).toBe('compact');
		expect(get(store).sorts.genres).toBe('most-albums');

		// A hostile or cleared value falls back to defaults, never throws.
		listener!(UNIFIED_LIBRARY_PREFS_STORAGE_KEY, null);
		expect(get(store)).toEqual(DEFAULT_UNIFIED_LIBRARY_PREFS);

		store.destroy();
		expect(detach).toHaveBeenCalledTimes(1);
	});

	it('stays on defaults outside the browser and rejects commits', () => {
		const store = createUnifiedLibraryPrefsStore({
			isBrowser: false,
			getStorage: () => {
				throw new Error('no storage on the server');
			},
			addStorageListener: () => {
				throw new Error('no window on the server');
			}
		});

		expect(get(store)).toEqual(DEFAULT_UNIFIED_LIBRARY_PREFS);
		expect(store.setDensity('compact')).toBe(false);
		expect(store.setSort('artists', 'za')).toBe(false);
	});
});
