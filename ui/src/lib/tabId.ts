import { browser } from '$app/environment';
import { createSecureOpaqueId } from './secureOpaqueId';

export const TAB_STORAGE_KEY = 'roon-controller.tab.v1';
export const TAB_ID_MAX_LENGTH = 128;

const OPAQUE_TAB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export interface TabStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function validTabId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= TAB_ID_MAX_LENGTH &&
		OPAQUE_TAB_ID.test(value)
	);
}

function secureTabId(): string {
	const value = createSecureOpaqueId();
	if (!validTabId(value)) throw new Error('Secure browser tab identity is unavailable');
	return value;
}

/** Creates one stable provider whose value is scoped to this browser tab. */
export function createTabIdProvider(
	storage: TabStorage | null,
	createId: () => string = secureTabId
): () => string {
	let cached: string | null = null;
	return () => {
		if (cached) return cached;
		let stored: string | null = null;
		try {
			stored = storage?.getItem(TAB_STORAGE_KEY) ?? null;
		} catch {
			// Storage can be disabled; the in-memory tab identity still remains stable.
		}
		if (validTabId(stored)) {
			cached = stored;
			return cached;
		}
		const created = createId();
		if (!validTabId(created)) throw new Error('Generated tab identity is invalid');
		cached = created;
		try {
			storage?.setItem(TAB_STORAGE_KEY, created);
		} catch {
			// Keep the in-memory identity when sessionStorage is unavailable.
		}
		return cached;
	};
}

function productionStorage(): TabStorage | null {
	if (!browser) return null;
	try {
		return globalThis.sessionStorage;
	} catch {
		return null;
	}
}

const productionProvider = createTabIdProvider(productionStorage());

export function getTabId(): string {
	return productionProvider();
}
