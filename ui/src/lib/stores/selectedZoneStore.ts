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

export const selectedZoneStore = {
	subscribe: internalStore.subscribe
};

export function setSelectedZone(zoneId: string): void {
	internalStore.set(zoneId);
	persist(zoneId);
}
