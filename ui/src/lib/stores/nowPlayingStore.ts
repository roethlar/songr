import { derived, writable } from 'svelte/store';
import type { NowPlaying } from '@shared/types';

type NowPlayingState = Record<string, NowPlaying>;

const internalStore = writable<NowPlayingState>({});

export const nowPlayingStore = {
	subscribe: internalStore.subscribe
};

export const nowPlayingList = derived(nowPlayingStore, ($state) => Object.values($state));

export function setNowPlaying(zoneId: string, payload: NowPlaying): void {
	internalStore.update((state) => ({
		...state,
		[zoneId]: payload
	}));
}

export function removeNowPlaying(zoneId: string): void {
	internalStore.update((state) => {
		const next = { ...state };
		delete next[zoneId];
		return next;
	});
}

export function resetNowPlaying(): void {
	internalStore.set({});
}
