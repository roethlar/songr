import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'roon-controller-selected-zone';

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

async function importStore() {
	vi.resetModules();
	return await import('../selectedZoneStore');
}

describe('selectedZoneStore', () => {
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
		if (originalStorageDescriptor) {
			Object.defineProperty(window, 'localStorage', originalStorageDescriptor);
		} else {
			Reflect.deleteProperty(window, 'localStorage');
		}
	});

	it('rehydrates the persisted zone without rewriting it', async () => {
		storage.setItem(STORAGE_KEY, 'zone-b');
		const write = vi.spyOn(storage, 'setItem');

		const store = await importStore();

		expect(get(store.selectedZoneStore)).toBe('zone-b');
		expect(write).not.toHaveBeenCalled();
	});

	it('persists a selected zone and removes the preference when cleared', async () => {
		const store = await importStore();

		store.setSelectedZone('zone-b');
		expect(get(store.selectedZoneStore)).toBe('zone-b');
		expect(storage.getItem(STORAGE_KEY)).toBe('zone-b');

		store.setSelectedZone('');
		expect(get(store.selectedZoneStore)).toBe('');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('falls back to no selection when persisted storage cannot be read', async () => {
		vi.spyOn(storage, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});

		const store = await importStore();

		expect(get(store.selectedZoneStore)).toBe('');
	});

	it('retains the live selection when persistence is unavailable', async () => {
		const store = await importStore();
		vi.spyOn(storage, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});

		store.setSelectedZone('zone-b');

		expect(get(store.selectedZoneStore)).toBe('zone-b');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});
});
