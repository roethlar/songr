import { writable } from 'svelte/store';
import type { HealthResponse } from '@shared/types';
import { fetchHealth } from '../api/client';

/**
 * Latest /api/health snapshot, or null before the first successful
 * fetch. Refreshed by `initializeStores` (initial load + every socket
 * reconnect), so a subsystem that degrades while the app is open is
 * surfaced no later than the next reconnect or full page load.
 *
 * A failed health fetch leaves the previous snapshot in place rather
 * than clearing it: the health check itself failing (server restart
 * mid-poll, transient network) is reported through the socket status
 * pill, not this banner.
 */
const internal = writable<HealthResponse | null>(null);

export const healthStore = {
	subscribe: internal.subscribe
};

export async function loadHealth(fetchFn: typeof fetch): Promise<void> {
	try {
		internal.set(await fetchHealth(fetchFn));
	} catch {
		/* keep the previous snapshot; see doc comment */
	}
}

export function setHealth(health: HealthResponse | null): void {
	internal.set(health);
}
