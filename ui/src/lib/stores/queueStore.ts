import { writable } from 'svelte/store';
import type { ZoneQueue } from '@shared/types';

type QueueByZone = Record<string, ZoneQueue>;

const internalStore = writable<QueueByZone>({});

export const queueStore = {
	subscribe: internalStore.subscribe
};

export function setQueueSnapshot(queue: ZoneQueue): void {
	internalStore.update((state) => ({
		...state,
		[queue.zone_id]: queue
	}));
}

export function clearQueue(zoneId: string): void {
	internalStore.update((state) => {
		const next = { ...state };
		delete next[zoneId];
		return next;
	});
}

export function resetQueue(): void {
	internalStore.set({});
}
