import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	createUnifiedLibraryPrefsStore,
	parseUnifiedLibraryPrefs,
	DEFAULT_UNIFIED_LIBRARY_PREFS,
	UNIFIED_LIBRARY_PREFS_STORAGE_KEY,
	UNIFIED_LIBRARY_PREFS_VERSION,
	type SortableUnifiedScope,
	type UnifiedLibraryStorageListener
} from '../unifiedLibraryPrefsStore';

const defaultGrouping = { artists: true, albums: false, genres: false, artist: false, genre: false };

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
		artistView: 'all-artists',
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
	it.each([3, UNIFIED_LIBRARY_PREFS_VERSION])('migrates retired date sorts without resetting v%s preferences', version => {
		const original = JSON.parse(validRaw({ version, ...(version === 3 ? { artistView: undefined } : {}) }));
		original.sorts.albums = 'year-asc';
		original.sorts.artist = 'year-desc';
		original.sorts.genre = 'year-asc';
		expect(parseUnifiedLibraryPrefs(JSON.stringify(original))).toEqual({
			artistView: version === 3 ? 'album-artists' : 'all-artists', density: 'compact',
			sorts: { artists: 'za', albums: 'az', genres: 'most-albums', artist: 'az', genre: 'az' },
			groupByLetter: defaultGrouping
		});
	});

	it('does not accept retired date sorts on scopes that never supported them', () => {
		const original = JSON.parse(validRaw());
		original.sorts.artists = 'year-asc';
		expect(parseUnifiedLibraryPrefs(JSON.stringify(original))).toEqual(DEFAULT_UNIFIED_LIBRARY_PREFS);
	});

	it.each([undefined, null, 'invalid', 1])('defaults an absent/invalid artist view without losing other preferences: %j', artistView => {
		const parsed = parseUnifiedLibraryPrefs(validRaw({ artistView }));
		expect(parsed).toEqual({ ...parseUnifiedLibraryPrefs(validRaw()), artistView: 'album-artists' });
	});

	it('migrates v3 density and sorts without reinterpreting them', () => {
		expect(parseUnifiedLibraryPrefs(validRaw({ version: 3, artistView: undefined })))
			.toEqual({ ...parseUnifiedLibraryPrefs(validRaw()), artistView: 'album-artists' });
	});

	it('round-trips a valid envelope', () => {
		expect(parseUnifiedLibraryPrefs(validRaw())).toEqual({
			artistView: 'all-artists',
			density: 'compact',
			sorts: {
				artists: 'za',
				albums: 'by-artist',
				genres: 'most-albums',
				artist: 'shuffle',
				genre: 'by-artist'
			},
			groupByLetter: defaultGrouping
		});
	});

	it.each([3, UNIFIED_LIBRARY_PREFS_VERSION])('keeps existing v%s preferences with only artist names grouped by default', version => {
		const parsed = parseUnifiedLibraryPrefs(validRaw({ version,
			...(version === 3 ? { artistView: undefined } : {}) }));
		expect(parsed.groupByLetter).toEqual(defaultGrouping);
		expect(parsed.artistView).toBe(version === 3 ? 'album-artists' : 'all-artists');
		expect(parsed.density).toBe('compact');
		expect(parsed.sorts).toEqual(JSON.parse(validRaw()).sorts);
	});

	it('restores explicit letter grouping independently for each scope', () => {
		const groupByLetter = { ...defaultGrouping, artists: false, genre: true };
		expect(parseUnifiedLibraryPrefs(validRaw({ groupByLetter }))).toEqual({
			...parseUnifiedLibraryPrefs(validRaw()), groupByLetter
		});
	});

	it.each([
		['null raw', null],
		['not json', '{'],
		['not an object', '"compact"'],
		['extra key', validRaw({ extra: 1 })],
		['wrong version', validRaw({ version: UNIFIED_LIBRARY_PREFS_VERSION + 1 })],
		['unknown density', validRaw({ density: 'cozy' })],
		['null letter grouping', validRaw({ groupByLetter: null })],
		['missing letter grouping scope', validRaw({ groupByLetter: { albums: true } })],
		['unknown letter grouping scope', validRaw({ groupByLetter: { ...defaultGrouping, tracks: true } })],
		['nonboolean letter grouping', validRaw({ groupByLetter: { ...defaultGrouping, albums: 'true' } })],
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
	it('groups artist names by default while album sorting keeps album lists flat', () => {
		const storage = memoryStorage();
		const store = createUnifiedLibraryPrefsStore({
			isBrowser: true, getStorage: () => storage, addStorageListener: () => () => {}
		});
		expect(get(store).groupByLetter).toEqual(defaultGrouping);
		expect(store.setArtistView('all-artists')).toBe(true);
		expect(get(store).groupByLetter.artists).toBe(true);
		expect(store.setArtistView('album-artists')).toBe(true);
		expect(get(store).groupByLetter.artists).toBe(true);
		expect(store.setSort('artist', 'za')).toBe(true);
		expect(get(store).groupByLetter).toEqual(defaultGrouping);
	});

	it('preserves an explicit artist grouping override across artist views and reloads', () => {
		const storage = memoryStorage();
		const options = { isBrowser: true, getStorage: () => storage, addStorageListener: () => () => {} };
		const store = createUnifiedLibraryPrefsStore(options);
		expect(store.setGroupByLetter('artists', false)).toBe(true);
		expect(store.setArtistView('all-artists')).toBe(true);
		expect(get(store).groupByLetter).toEqual({ ...defaultGrouping, artists: false });
		expect(store.setArtistView('album-artists')).toBe(true);
		expect(get(createUnifiedLibraryPrefsStore(options)).groupByLetter)
			.toEqual({ ...defaultGrouping, artists: false });
	});

	it('persists explicit grouping before publishing and restores it in new tabs', () => {
		const storage = memoryStorage();
		const options = { isBrowser: true, getStorage: () => storage, addStorageListener: () => () => {} };
		const store = createUnifiedLibraryPrefsStore(options);
		let publishing = false;
		const unsubscribe = store.subscribe(prefs => {
			if (publishing) expect(parseUnifiedLibraryPrefs(storage.getItem(UNIFIED_LIBRARY_PREFS_STORAGE_KEY)))
				.toEqual(prefs);
		});
		publishing = true;
		expect(store.setGroupByLetter('artist', true)).toBe(true);
		expect(get(store).groupByLetter).toEqual({ ...defaultGrouping, artist: true });
		expect(get(createUnifiedLibraryPrefsStore(options))).toEqual(get(store));
		expect(store.setGroupByLetter('artist', false)).toBe(true);
		expect(get(store).groupByLetter).toEqual(defaultGrouping);
		unsubscribe();
	});

	it('rejects invalid grouping scopes and values without writing', () => {
		const storage = memoryStorage();
		const write = vi.fn(storage.setItem);
		const store = createUnifiedLibraryPrefsStore({
			isBrowser: true, getStorage: () => ({ ...storage, setItem: write }), addStorageListener: () => () => {}
		});
		for (const value of [null, undefined, 0, 1, 'true', 'false', {}, []]) {
			expect(store.setGroupByLetter('albums', value)).toBe(false);
		}
		for (const scope of ['tracks', '__proto__', '', null]) {
			expect(store.setGroupByLetter(scope as SortableUnifiedScope, true)).toBe(false);
		}
		expect(write).not.toHaveBeenCalled();
		expect(get(store).groupByLetter).toEqual(defaultGrouping);
	});

	it('reads persisted prefs at creation and validates commits', () => {
		const storage = memoryStorage();
		storage.setItem(UNIFIED_LIBRARY_PREFS_STORAGE_KEY, validRaw());
		const store = createUnifiedLibraryPrefsStore({
			isBrowser: true,
			getStorage: () => storage,
			addStorageListener: () => () => {}
		});

		expect(get(store).density).toBe('compact');
		expect(store.setArtistView('album-artists')).toBe(true);
		expect(get(store).artistView).toBe('album-artists');
		expect(store.setArtistView('contributors')).toBe(false);
		expect(get(store).artistView).toBe('album-artists');
		expect(store.setArtistView('all-artists')).toBe(true);

		expect(store.setDensity('pi')).toBe(true);
		expect(get(store).density).toBe('pi');
		expect(store.setDensity('cozy')).toBe(false);
		expect(get(store).density).toBe('pi');

		expect(store.setSort('albums', 'shuffle')).toBe(true);
		expect(get(store).sorts.albums).toBe('shuffle');
		expect(store.setSort('genres', 'shuffle')).toBe(false);
		for (const scope of ['albums', 'artist', 'genre'] as const) {
			expect(store.setSort(scope, 'year-asc')).toBe(false);
			expect(store.setSort(scope, 'year-desc')).toBe(false);
		}
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
		expect(store.setArtistView('all-artists')).toBe(false);
		expect(store.setGroupByLetter('artist', true)).toBe(false);
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
		expect(get(store).artistView).toBe('all-artists');
		listener!(UNIFIED_LIBRARY_PREFS_STORAGE_KEY,
			validRaw({ groupByLetter: { ...defaultGrouping, albums: true } }));
		expect(get(store).groupByLetter).toEqual({ ...defaultGrouping, albums: true });

		const oldSorts = JSON.parse(validRaw());
		oldSorts.sorts.albums = 'year-desc';
		listener!(UNIFIED_LIBRARY_PREFS_STORAGE_KEY, JSON.stringify(oldSorts));
		expect(get(store)).toEqual({ ...parseUnifiedLibraryPrefs(validRaw()),
			sorts: { ...parseUnifiedLibraryPrefs(validRaw()).sorts, albums: 'az' } });

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
		expect(store.setGroupByLetter('albums', true)).toBe(false);
	});
});
