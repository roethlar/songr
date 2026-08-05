import { writable, type Readable } from 'svelte/store';
import { normalizeLibraryIntent, type LibraryIntent } from '$lib/libraryIntent';

export interface PendingLibraryIntent {
	readonly requestId: number;
	readonly intent: LibraryIntent;
	readonly historyMutation: 'push' | 'replace';
}

const internalStore = writable<PendingLibraryIntent | null>(null);
let nextRequestId = 0;

export const pendingLibraryIntentStore: Readable<PendingLibraryIntent | null> = {
	subscribe: internalStore.subscribe
};

/** Publish a valid semantic intent. A newer request supersedes an older one. */
export function publishLibraryIntent(
	value: LibraryIntent,
	historyMutation: 'push' | 'replace' = 'replace'
): PendingLibraryIntent | null {
	const intent = normalizeLibraryIntent(value);
	if (!intent) return null;

	const pending = Object.freeze({
		requestId: ++nextRequestId,
		intent,
		historyMutation
	});
	internalStore.set(pending);
	return pending;
}

/**
 * Atomically take the matching request. A stale claimant cannot consume a
 * newer request that replaced the one it observed.
 */
export function claimLibraryIntent(requestId: number): LibraryIntent | null {
	let claimed: LibraryIntent | null = null;
	internalStore.update((pending) => {
		if (pending?.requestId !== requestId) return pending;
		claimed = pending.intent;
		return null;
	});
	return claimed;
}

/** Cancel only the matching request, preserving any newer replacement. */
export function cancelLibraryIntent(requestId: number): boolean {
	let cancelled = false;
	internalStore.update((pending) => {
		if (pending?.requestId !== requestId) return pending;
		cancelled = true;
		return null;
	});
	return cancelled;
}

/** Clear pending state without reusing request identities. */
export function resetLibraryIntentStore(): void {
	internalStore.set(null);
}
