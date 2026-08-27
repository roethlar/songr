import { browser } from '$app/environment';
import { writable } from 'svelte/store';

const STORAGE_KEY = 'roon-controller-selected-zone';

function readPersisted(): string {
	if (!browser) return '';
	try {
		return localStorage.getItem(STORAGE_KEY) ?? '';
	} catch {
		return '';
	}
}

function persist(value: string): void {
	if (!browser) return;
	try {
		if (value) {
			localStorage.setItem(STORAGE_KEY, value);
		} else {
			localStorage.removeItem(STORAGE_KEY);
		}
	} catch {
		/* localStorage unavailable */
	}
}

const internalStore = writable<string>(readPersisted());

// The pin is the user's explicit choice (persisted). It can diverge from the
// live store value above, which may hold an in-memory-only fallback when the
// pinned zone is momentarily absent from the zones list (Core reconnect,
// regroup changing zone_id, partial first delivery).
let pinnedZoneId = readPersisted();

export const selectedZoneStore = {
	subscribe: internalStore.subscribe
};

/** Explicit user choice (e.g. a zone-picker click): persists and becomes live. */
export function setSelectedZone(zoneId: string): void {
	pinnedZoneId = zoneId;
	internalStore.set(zoneId);
	persist(zoneId);
}

/**
 * In-memory-only fallback selection. Never touches localStorage or the pin
 * record, so the user's pinned choice survives a temporary absence and wins
 * again once it reappears in the zones list.
 */
export function setEffectiveZone(zoneId: string): void {
	internalStore.set(zoneId);
}

/** The user's persisted pin, independent of whatever is currently live. */
export function getPinnedZone(): string {
	return pinnedZoneId;
}
