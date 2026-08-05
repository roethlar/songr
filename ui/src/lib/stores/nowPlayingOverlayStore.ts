import { writable } from 'svelte/store';

/**
 * Now-playing overlay open/close state.
 *
 * The overlay is mounted at the layout level and toggled via this
 * store rather than via local component state so any surface (play
 * bar, keyboard shortcut, mobile-nav future hooks) can trigger it
 * without prop-drilling.
 *
 * Per UX overhaul plan (PR2): overlay/sheet on top of the current
 * page, full-screen on mobile breakpoints, closing returns the user
 * to the underlying page in its prior state. The store deliberately
 * carries no payload — the overlay reads `nowPlayingStore` /
 * `selectedZoneStore` directly so it always shows live state.
 */
const internalStore = writable<boolean>(false);

export const nowPlayingOverlayStore = {
	subscribe: internalStore.subscribe
};

export function openNowPlayingOverlay(): void {
	internalStore.set(true);
}

export function closeNowPlayingOverlay(): void {
	internalStore.set(false);
}

export function toggleNowPlayingOverlay(): void {
	internalStore.update((v) => !v);
}
