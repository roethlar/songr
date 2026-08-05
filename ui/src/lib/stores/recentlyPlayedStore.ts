import { writable } from 'svelte/store';
import type {
	RecentlyPlayedEntry,
	RecentlyPlayedInsertedPayload,
	RecentlyPlayedClearedPayload,
	RecentlyPlayedSnapshot
} from '@shared/types';
import { recentlyPlayedDedupeKey } from '@shared/recentlyPlayed';
import { fetchRecentlyPlayed } from '../api/client';

/**
 * "Recently played on this controller" — populated by the backend
 * RecentlyPlayedService. Loaded once via REST at first mount, then
 * kept fresh via socket events (`recently-played-inserted` and
 * `recently-played-cleared`), each carrying a monotonic revision.
 *
 * Out-of-order delivery (socket events vs. REST responses, or socket
 * events vs. each other) used to corrupt state in narrow races —
 * e.g. a slow DELETE response arriving after a post-clear socket
 * insert would wipe the legitimate new entry. The revision check
 * below (`if revision <= lastApplied: discard`) makes every apply
 * path idempotent against stale signals, so server, disk, and all
 * clients converge regardless of arrival order.
 *
 * Honest scope: only reflects plays that happened while this
 * controller's backend was running and subscribed to Roon. Plays
 * during downtime are missed. The welcome view labels this honestly.
 */

export interface RecentlyPlayedState {
	entries: RecentlyPlayedEntry[];
	loading: boolean;
	loaded: boolean;
}

const initialState: RecentlyPlayedState = {
	entries: [],
	loading: false,
	loaded: false
};

const internalStore = writable<RecentlyPlayedState>(initialState);

export const recentlyPlayedStore = {
	subscribe: internalStore.subscribe
};

const CAP = 50;

/**
 * Sync state we track from the server. `epoch` is a STRICTLY MONOTONIC
 * per-server-process generation (persisted on the backend, incremented
 * on each start). Older epochs from in-flight stale payloads MUST be
 * rejected — if we adopted them blindly the store would roll back to
 * an obsolete server's view. `revision` orders within an epoch.
 *
 * Sentinel `lastAppliedEpoch = 0` is less than any real persisted
 * generation (epochs start at 1 — see RecentlyPlayedService.loadFromDisk),
 * so the first real payload always wins.
 */
let lastAppliedEpoch = 0;
let lastAppliedRevision = 0;

/**
 * Snapshots are AUTHORITATIVE: apply on equal revision too (a snapshot
 * fully describes state at its revision and can repair drift from
 * missed deltas). A strictly-newer epoch means a new server instance —
 * adopt its revision baseline. Strictly-older epoch is stale and gets
 * rejected.
 */
function applySnapshot(snapshot: RecentlyPlayedSnapshot): void {
	if (snapshot.epoch < lastAppliedEpoch) return;
	if (snapshot.epoch === lastAppliedEpoch && snapshot.revision < lastAppliedRevision) return;
	lastAppliedEpoch = snapshot.epoch;
	lastAppliedRevision = snapshot.revision;
	internalStore.update((s) => ({
		...s,
		entries: snapshot.entries.slice(0, CAP),
		loaded: true
	}));
}

/**
 * Deltas (insert / cleared) need to be both newer AND in-order:
 *   - Strictly-newer revision within the same epoch (equal would
 *     double-apply).
 *   - Strictly-newer epoch (a new server instance).
 * Older epochs are rejected (stale).
 */
function shouldApplyDelta(sync: { revision: number; epoch: number }): boolean {
	if (sync.epoch < lastAppliedEpoch) return false;
	if (sync.epoch > lastAppliedEpoch) return true;
	return sync.revision > lastAppliedRevision;
}

/**
 * Adopt a delta. If the epoch advanced, CLEAR the local entries
 * first — the delta represents a change against the new server's
 * state, not on top of the prior server's. Without this clear, an
 * `inserted` from a fresh server would land on top of stale entries
 * and stay mixed until a follow-up load arrived (or worse, never).
 * The next load will baseline any prior-epoch entries we drop here.
 */
function adoptDelta(sync: { revision: number; epoch: number }): void {
	if (sync.epoch > lastAppliedEpoch) {
		internalStore.update((s) => ({ ...s, entries: [] }));
	}
	lastAppliedEpoch = sync.epoch;
	lastAppliedRevision = sync.revision;
}

export async function loadRecentlyPlayed(fetchFn: typeof fetch): Promise<void> {
	internalStore.update((s) => ({ ...s, loading: true }));
	try {
		const snapshot = await fetchRecentlyPlayed(fetchFn);
		applySnapshot(snapshot);
		internalStore.update((s) => ({ ...s, loading: false }));
	} catch {
		// Network or REST hiccup — leave any previously-loaded list
		// visible, just clear the loading flag. UI shows whatever
		// entries it had (possibly empty on first mount).
		internalStore.update((s) => ({ ...s, loading: false }));
	}
}

/**
 * Apply a `recently-played-inserted` socket event. Discards stale
 * events (revision not strictly newer than the last applied), then
 * mirrors the backend's bubble-to-front: drops any prior occurrence
 * of the same track (by shared dedupe key) before unshifting, so a
 * replayed track moves to the top instead of duplicating.
 */
export function applyRecentlyPlayedInserted(
	payload: RecentlyPlayedInsertedPayload
): void {
	if (!shouldApplyDelta(payload)) return;
	adoptDelta(payload);
	const { entry } = payload;
	internalStore.update((s) => {
		const key = recentlyPlayedDedupeKey(entry);
		const deduped = s.entries.filter((e) => recentlyPlayedDedupeKey(e) !== key);
		const entries = [entry, ...deduped].slice(0, CAP);
		return { ...s, entries, loaded: true };
	});
}

/**
 * Apply a `recently-played-cleared` socket event. Same ordering
 * rules as the insert path: strictly newer revision in the same
 * epoch, or any payload from a new epoch.
 */
export function applyRecentlyPlayedCleared(
	payload: RecentlyPlayedClearedPayload
): void {
	if (!shouldApplyDelta(payload)) return;
	adoptDelta(payload);
	internalStore.update((s) => ({ ...s, entries: [], loaded: true }));
}

/**
 * Apply the authoritative snapshot returned by a DELETE response.
 * Wraps `applySnapshot` so the UI handler has a clear name for the
 * "after the user clicked Clear, here's the server's truth" path.
 */
export function applyClearResponse(snapshot: RecentlyPlayedSnapshot): void {
	applySnapshot(snapshot);
}

/**
 * Wipe local store + revision tracking. Used by tests and any future
 * full-reset path. Note: this does NOT contact the server — for a
 * user-initiated wipe use the DELETE flow.
 */
export function resetRecentlyPlayed(): void {
	lastAppliedEpoch = 0;
	lastAppliedRevision = 0;
	internalStore.set({ ...initialState });
}
