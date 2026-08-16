import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'roon-controller-library-view';

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();
	get length(): number { return this.values.size; }
	clear(): void { this.values.clear(); }
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
	removeItem(key: string): void { this.values.delete(key); }
	setItem(key: string, value: string): void { this.values.set(key, value); }
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
		Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
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

	it('uses and exposes only Unified when the preference is missing', async () => {
		const store = await importStore();

		expect(store.DEFAULT_LIBRARY_VIEW).toBe('unified');
		expect(get(store.libraryViewStore)).toBe('unified');
		expect(store.getAvailableLibraryViews()).toEqual(['unified']);
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it.each(['classic', 'timeline', 'spatial'])(
		'retires a persisted %s preference without rewriting its bytes',
		async (preferred) => {
			const raw = persisted(preferred);
			storage.setItem(STORAGE_KEY, raw);
			const store = await importStore();

			expect(get(store.libraryViewStore)).toBe('unified');
			expect(store.resolveAvailableLibraryView(preferred)).toBe('unified');
			expect(store.commitPreferredLibraryView(preferred)).toBe(false);
			expect(storage.getItem(STORAGE_KEY)).toBe(raw);
		}
	);

	it('rehydrates and commits the sole Unified preference', async () => {
		storage.setItem(STORAGE_KEY, persisted('unified'));
		const store = await importStore();
		expect(get(store.libraryViewStore)).toBe('unified');

		expect(store.commitPreferredLibraryView('unified')).toBe(true);
		expect(storage.getItem(STORAGE_KEY)).toBe(persisted('unified'));
	});

	it.each([
		['malformed JSON', '{not-json'],
		['an unknown version', persisted('unified', 2)],
		['an incomplete shape', JSON.stringify({ version: 1 })],
		['an extended shape', JSON.stringify({ version: 1, preferred: 'unified', extra: true })]
	])('falls back to Unified for %s without rewriting the bytes', async (_label, raw) => {
		storage.setItem(STORAGE_KEY, raw);
		const store = await importStore();

		expect(get(store.libraryViewStore)).toBe('unified');
		expect(storage.getItem(STORAGE_KEY)).toBe(raw);
	});

	it('fails closed when storage cannot be read or written', async () => {
		vi.spyOn(storage, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		const store = await importStore();
		expect(get(store.libraryViewStore)).toBe('unified');

		vi.spyOn(storage, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		expect(store.commitPreferredLibraryView('unified')).toBe(false);
		expect(get(store.libraryViewStore)).toBe('unified');
	});

	it('does not touch storage when constructed for SSR', async () => {
		const store = await importStore();
		const getStorage = vi.fn(() => storage);
		const serverStore = store.createLibraryViewPreferenceStore({ isBrowser: false, getStorage });

		expect(get(serverStore)).toBe('unified');
		expect(serverStore.commit('unified')).toBe(false);
		expect(getStorage).not.toHaveBeenCalled();
	});
});
