import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'roon-controller-library-view';

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();

	get length(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.values.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

function persisted(preferred: string, version = 1): string {
	return JSON.stringify({ version, preferred });
}

async function importStore() {
	vi.resetModules();
	return await import('../libraryViewStore');
}

describe('libraryViewStore', () => {
	let storage: MemoryStorage;
	let originalStorageDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		storage = new MemoryStorage();
		originalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			value: storage
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock('$app/environment');
		if (originalStorageDescriptor) {
			Object.defineProperty(window, 'localStorage', originalStorageDescriptor);
		} else {
			Reflect.deleteProperty(window, 'localStorage');
		}
	});

	it('uses Unified when the preference is missing', async () => {
		const store = await importStore();

		expect(store.DEFAULT_LIBRARY_VIEW).toBe('unified');
		expect(get(store.libraryViewStore)).toBe('unified');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it.each(['classic', 'timeline', 'unified'] as const)(
		'rehydrates a valid current-version %s preference',
		async (preferred) => {
			storage.setItem(STORAGE_KEY, persisted(preferred));
			const store = await importStore();

			expect(get(store.libraryViewStore)).toBe(preferred);
			expect(storage.getItem(STORAGE_KEY)).toBe(persisted(preferred));
		}
	);

	it.each(['classic', 'timeline', 'unified'] as const)(
		'commits and reloads a versioned %s preference',
		async (preferred) => {
			const first = await importStore();
			expect(first.commitPreferredLibraryView(preferred)).toBe(true);
			expect(get(first.libraryViewStore)).toBe(preferred);
			expect(storage.getItem(STORAGE_KEY)).toBe(persisted(preferred));

			const reloaded = await importStore();
			expect(get(reloaded.libraryViewStore)).toBe(preferred);
		}
	);

	it.each([
		['malformed JSON', '{not-json'],
		['a legacy scalar', JSON.stringify('timeline')],
		['an unknown version', persisted('timeline', 2)],
		['an unknown view', persisted('spatial')],
		['an incomplete shape', JSON.stringify({ version: 1 })],
		['an extended shape', JSON.stringify({ version: 1, preferred: 'timeline', extra: true })]
	])('falls back to Unified for %s without rewriting the bytes', async (_label, raw) => {
		storage.setItem(STORAGE_KEY, raw);
		const store = await importStore();

		expect(get(store.libraryViewStore)).toBe('unified');
		expect(storage.getItem(STORAGE_KEY)).toBe(raw);
	});

	it('falls back to Unified when storage cannot be read', async () => {
		vi.spyOn(storage, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});

		const store = await importStore();
		expect(get(store.libraryViewStore)).toBe('unified');
	});

	it('retains the prior committed value and bytes when persistence fails', async () => {
		const store = await importStore();
		expect(store.commitPreferredLibraryView('timeline')).toBe(true);
		const priorBytes = storage.getItem(STORAGE_KEY);
		vi.spyOn(storage, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});

		expect(store.commitPreferredLibraryView('classic')).toBe(false);
		expect(get(store.libraryViewStore)).toBe('timeline');
		expect(storage.getItem(STORAGE_KEY)).toBe(priorBytes);
	});

	it('rejects an invalid runtime preference without changing the prior value or bytes', async () => {
		const store = await importStore();
		expect(store.commitPreferredLibraryView('timeline')).toBe(true);
		const priorBytes = storage.getItem(STORAGE_KEY);
		const write = vi.spyOn(storage, 'setItem');

		expect(store.commitPreferredLibraryView('spatial')).toBe(false);
		expect(get(store.libraryViewStore)).toBe('timeline');
		expect(write).not.toHaveBeenCalled();
		expect(storage.getItem(STORAGE_KEY)).toBe(priorBytes);
	});

	it('does not touch storage when constructed for SSR', async () => {
		const store = await importStore();
		const getStorage = vi.fn(() => {
			throw new Error('must not be called');
		});
		const serverStore = store.createLibraryViewPreferenceStore({
			isBrowser: false,
			getStorage
		});

		expect(get(serverStore)).toBe('unified');
		expect(serverStore.commit('timeline')).toBe(false);
		expect(getStorage).not.toHaveBeenCalled();
	});

	it('initializes the production singleton without touching storage during SSR', async () => {
		vi.doMock('$app/environment', () => ({
			browser: false,
			dev: false,
			building: false,
			version: 'test'
		}));
		const storageRead = vi.fn(() => {
			throw new Error('must not be read during SSR');
		});
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get: storageRead
		});

		const store = await importStore();
		expect(get(store.libraryViewStore)).toBe('unified');
		expect(storageRead).not.toHaveBeenCalled();
	});

	it('keeps a gated Timeline preference while offering Classic and Unified', async () => {
		const raw = persisted('timeline');
		storage.setItem(STORAGE_KEY, raw);
		const store = await importStore();

		expect(store.TIMELINE_LIBRARY_VIEW_AVAILABLE).toBe(false);
		expect(get(store.libraryViewStore)).toBe('timeline');
		expect(store.resolveAvailableLibraryView('timeline')).toBe('classic');
		expect(store.getAvailableLibraryViews({ dev: false })).toEqual(['classic', 'unified']);
		expect(storage.getItem(STORAGE_KEY)).toBe(raw);
	});

	it('reaches Unified in production after the release gate flips', async () => {
		const store = await importStore();

		expect(store.UNIFIED_LIBRARY_VIEW_AVAILABLE).toBe(true);
		expect(store.isUnifiedLibraryViewReachable({ dev: false })).toBe(true);
		expect(store.resolveAvailableLibraryView('unified', { dev: false })).toBe('unified');
		expect(store.getAvailableLibraryViews({ dev: false })).toEqual(['classic', 'unified']);
	});

	it('keeps Unified reachable in dev builds after the release gate flips', async () => {
		const store = await importStore();

		expect(store.UNIFIED_LIBRARY_VIEW_AVAILABLE).toBe(true);
		expect(store.isUnifiedLibraryViewReachable({ dev: true })).toBe(true);
		expect(store.resolveAvailableLibraryView('unified', { dev: true })).toBe('unified');
		expect(store.getAvailableLibraryViews({ dev: true })).toEqual(['classic', 'unified']);
	});

	it('keeps and resolves a persisted Unified production preference', async () => {
		const raw = persisted('unified');
		storage.setItem(STORAGE_KEY, raw);
		const store = await importStore();

		expect(get(store.libraryViewStore)).toBe('unified');
		expect(store.resolveAvailableLibraryView('unified', { dev: false })).toBe('unified');
		expect(storage.getItem(STORAGE_KEY)).toBe(raw);
	});

});
