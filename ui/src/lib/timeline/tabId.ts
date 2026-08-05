import { browser } from '$app/environment';
import { createSecureTimelineOpaqueId } from './secureOpaqueId';

export const TIMELINE_TAB_STORAGE_KEY = 'roon-controller.timeline-tab.v1';
export const TIMELINE_TAB_ID_MAX_LENGTH = 128;

const OPAQUE_TAB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export interface TimelineTabStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function validTabId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= TIMELINE_TAB_ID_MAX_LENGTH &&
		OPAQUE_TAB_ID.test(value)
	);
}

function secureTabId(): string {
	const value = createSecureTimelineOpaqueId();
	if (!validTabId(value)) throw new Error('Secure browser tab identity is unavailable');
	return value;
}

/** Creates one stable provider whose value is scoped to this browser tab. */
export function createTimelineTabIdProvider(
	storage: TimelineTabStorage | null,
	createId: () => string = secureTabId
): () => string {
	let cached: string | null = null;
	return () => {
		if (cached) return cached;
		let stored: string | null = null;
		try {
			stored = storage?.getItem(TIMELINE_TAB_STORAGE_KEY) ?? null;
		} catch {
			// Storage can be disabled; the in-memory tab identity still remains stable.
		}
		if (validTabId(stored)) {
			cached = stored;
			return cached;
		}
		const created = createId();
		if (!validTabId(created)) throw new Error('Generated Timeline tab identity is invalid');
		cached = created;
		try {
			storage?.setItem(TIMELINE_TAB_STORAGE_KEY, created);
		} catch {
			// Keep the in-memory identity when sessionStorage is unavailable.
		}
		return cached;
	};
}

function productionStorage(): TimelineTabStorage | null {
	if (!browser) return null;
	try {
		return globalThis.sessionStorage;
	} catch {
		return null;
	}
}

const productionProvider = createTimelineTabIdProvider(productionStorage());

export function getTimelineTabId(): string {
	return productionProvider();
}
