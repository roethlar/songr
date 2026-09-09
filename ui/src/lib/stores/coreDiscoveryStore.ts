import { writable } from 'svelte/store';
import { normalizeCoreDiscoveryStatus, type CoreDiscoveryStatus } from '@shared/coreDiscovery';
import { fetchCoreDiscovery } from '../api/client';

const internal = writable<CoreDiscoveryStatus | null>(null);
export const coreDiscoveryStore = { subscribe: internal.subscribe };
// A push, disconnect, or newer read supersedes every older HTTP answer.
let revision = 0;

export function setCoreDiscovery(value: unknown): void {
	const status = normalizeCoreDiscoveryStatus(value);
	if (!status) return;
	revision += 1;
	internal.set(status);
}

export function resetCoreDiscovery(): void {
	revision += 1;
	internal.set(null);
}

export async function loadCoreDiscovery(fetchFn: typeof fetch): Promise<void> {
	const readRevision = ++revision;
	try {
		const status = await fetchCoreDiscovery(fetchFn);
		if (readRevision === revision) setCoreDiscovery(status);
	} catch {
		// No observation is not evidence that discovery found no Core.
		// Live socket hydration can still supply the current snapshot.
	}
}
