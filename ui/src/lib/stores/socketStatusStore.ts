import { writable } from 'svelte/store';

/**
 * Tracks the WebSocket connection lifecycle independently of the Roon
 * core pairing state. The play-bar status pill combines this with
 * `isCorePaired` to distinguish:
 *   - "Connecting…"       — socket is trying to connect / reconnect
 *   - "Disconnected"      — socket is down (possibly transient)
 *   - "Searching for Core…" — socket up, Roon core unpaired
 *   - "Connected"          — socket up, core paired
 */
export type SocketStatus = 'connecting' | 'connected' | 'disconnected';

const internal = writable<SocketStatus>('connecting');

export const socketStatusStore = {
	subscribe: internal.subscribe
};

export function setSocketStatus(status: SocketStatus): void {
	internal.set(status);
}
