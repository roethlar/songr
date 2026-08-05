import { derived, writable } from 'svelte/store';
import type { Zone } from '@shared/types';
import { fetchZones } from '../api/client';

const internalStore = writable<Zone[]>([]);

export const zonesStore = {
	subscribe: internalStore.subscribe
};

export const zoneMapStore = derived(zonesStore, ($zones) => {
	return new Map($zones.map((zone) => [zone.zone_id, zone]));
});

export async function loadZones(fetchFn: typeof fetch): Promise<void> {
	const zones = await fetchZones(fetchFn);
	internalStore.set(zones);
}

export function setZonesSnapshot(zones: Zone[]): void {
	internalStore.set(zones);
}

export function upsertZone(zone: Zone): void {
	internalStore.update((current) => {
		const next = [...current];
		const index = next.findIndex((z) => z.zone_id === zone.zone_id);
		if (index >= 0) {
			next[index] = zone;
		} else {
			next.push(zone);
		}
		return next;
	});
}

export function removeZone(zoneId: string): void {
	internalStore.update((current) => current.filter((zone) => zone.zone_id !== zoneId));
}

export function updateSeekPosition(zoneId: string, seekPosition: number): void {
	internalStore.update((current) => {
		const index = current.findIndex((z) => z.zone_id === zoneId);
		if (index < 0) return current;
		const next = [...current];
		next[index] = { ...next[index], seek_position: seekPosition };
		return next;
	});
}
