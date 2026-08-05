import { writable } from 'svelte/store';

/**
 * Open/close state for the zone-grouping modal. Triggered from the
 * play-bar "Group" button; reads `zonesStore` directly to enumerate
 * available outputs so it always reflects live state.
 */
const internalStore = writable<boolean>(false);

export const zoneGroupingStore = {
	subscribe: internalStore.subscribe
};

export function openZoneGrouping(): void {
	internalStore.set(true);
}

export function closeZoneGrouping(): void {
	internalStore.set(false);
}
