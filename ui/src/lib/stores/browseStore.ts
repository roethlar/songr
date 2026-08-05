import { writable } from 'svelte/store';
import type { BrowseItem, BrowseResult, SearchResult } from '@shared/types';

export interface BrowseState {
	current: BrowseResult | null;
	hierarchy: string;
	lastSearch: SearchResult[] | null;
	lastSearchQuery: string | null;
	searchLoading: boolean;
	searchError: string | null;
	loading: boolean;
	error: string | null;
	/**
	 * True when the user explicitly opened the search interface (e.g.
	 * clicked Roon's Library > Search input-prompt item). Renders the
	 * search panel with its own input even before any query has run.
	 */
	searchOpen: boolean;
}

const initialState: BrowseState = {
	current: null,
	hierarchy: 'browse',
	lastSearch: null,
	lastSearchQuery: null,
	searchLoading: false,
	searchError: null,
	loading: false,
	error: null,
	searchOpen: false
};

const internalStore = writable<BrowseState>(initialState);

export const browseStore = {
	subscribe: internalStore.subscribe
};

export function setBrowseResult(result: BrowseResult, hierarchy?: string): void {
	internalStore.update((state) => ({
		current: result,
		hierarchy: hierarchy ?? state.hierarchy,
		lastSearch: state.lastSearch,
		lastSearchQuery: state.lastSearchQuery,
		searchLoading: false,
		searchError: null,
		loading: false,
		error: null,
		searchOpen: state.searchOpen
	}));
}

/**
 * Show the search interface (panel with its own input). Used when the
 * user clicks an input-prompt browse item (Roon's Library > Search) —
 * drilling such an item without input would land on an empty
 * "No results" list (BUGS.md 2026-06-09).
 */
export function openSearchPanel(): void {
	internalStore.update((state) => ({ ...state, searchOpen: true }));
}

export function closeSearchPanel(): void {
	internalStore.update((state) => ({ ...state, searchOpen: false }));
}

/**
 * Append more items to the currently displayed browse result. Used by
 * "Load more" pagination — preserves list/title/totalCount metadata while
 * extending the items array. Duplicates (same itemKey) are skipped.
 */
export function appendBrowseItems(items: BrowseItem[]): void {
	internalStore.update((state) => {
		if (!state.current) return state;
		const existing = new Set(
			state.current.items.map((i) => i.itemKey).filter((k): k is string => Boolean(k))
		);
		const additions = items.filter((i) => !i.itemKey || !existing.has(i.itemKey));
		const merged: BrowseResult = {
			...state.current,
			items: [...state.current.items, ...additions],
			count: state.current.items.length + additions.length
		};
		return { ...state, current: merged };
	});
}

export function setSearchResults(results: SearchResult[]): void {
	internalStore.update((state) => ({
		...state,
		lastSearch: results,
		searchLoading: false,
		searchError: null,
		loading: false,
		error: null
	}));
}

export function setSearchLoading(query?: string): void {
	internalStore.update((state) => ({
		...state,
		lastSearchQuery: query ?? state.lastSearchQuery,
		searchLoading: true,
		searchError: null
	}));
}

export function setSearchError(message: string): void {
	internalStore.update((state) => ({
		...state,
		searchLoading: false,
		searchError: message
	}));
}

export function clearSearchResults(): void {
	internalStore.update((state) => ({
		...state,
		lastSearch: null,
		lastSearchQuery: null,
		searchLoading: false,
		searchError: null
	}));
}

export function setBrowseLoading(hierarchy?: string): void {
	internalStore.update((state) => ({
		...state,
		hierarchy: hierarchy ?? state.hierarchy,
		searchLoading: false,
		loading: true,
		error: null
	}));
}

/**
 * Clear the loading flag without touching `current` or `hierarchy`.
 * Used when an optimistically-set loading state needs to be undone
 * because the underlying request never went out (e.g. socket
 * disconnected before emit).
 */
export function clearBrowseLoading(): void {
	internalStore.update((state) => ({ ...state, loading: false }));
}

export function setBrowseError(message: string): void {
	internalStore.update((state) => ({
		...state,
		loading: false,
		error: message
	}));
}

/**
 * Full snapshot of BrowseState — captures every field. Used by the
 * failure-rollback paths in rail / play-bar navigation together
 * with `restoreBrowseStateIfUnchanged` to undo only what the
 * navigation actually mutated, not what an independent writer
 * (e.g. a `setSearchResults` socket handler firing mid-await)
 * has changed since.
 *
 * Two snapshots are taken at the call site: `prior` (before any
 * mutation) and `afterMutation` (immediately after the optimistic
 * setter call). On rollback, each field is restored only if its
 * current value is still equal to the post-mutation snapshot —
 * i.e. nothing else has touched it.
 */
export type BrowseStateSnapshot = BrowseState;

export function snapshotBrowseState(state: BrowseState): BrowseStateSnapshot {
	return { ...state };
}

/**
 * Slice-aware conditional restore. Used by failure-rollback paths.
 *
 * Fields are grouped into two slices that correspond to the two
 * UI surfaces:
 *   - **browse** pane: `current`, `hierarchy`, `loading`, `error`.
 *   - **search** pane: `lastSearch`, `lastSearchQuery`,
 *     `searchLoading`, `searchError`.
 *
 * For each slice, restore the whole slice from `prior` IF every
 * field in the slice still equals `afterMutation`. If ANY field in
 * the slice was independently changed (curr !== afterMutation —
 * detected via Object.is, which catches reference and primitive
 * inequality), the entire slice is left as-is.
 *
 * Why slice-level: an independent writer that updates one search
 * field (e.g. `setSearchResults` sets `lastSearch` AND
 * `searchLoading=false`) signals "this whole slice is mine now."
 * Per-field restore can't disambiguate idempotent writes (setter
 * wrote the same primitive value the optimistic mutation set —
 * Object.is says equal, but it WAS a write). Treating the slice
 * atomically respects writer intent without needing per-field
 * write tracking.
 *
 * History: M-1 reopen #1 → needed `error` rolled back. Reopen #2
 * → needed `searchLoading` rolled back. Reopen #3 → full-state
 * restore wiped a live `setSearchResults` update mid-rail-await;
 * narrower-than-full was needed. This slice-aware shape satisfies
 * all three.
 */
export function restoreBrowseStateIfUnchanged(
	prior: BrowseStateSnapshot,
	afterMutation: BrowseStateSnapshot
): void {
	const slices: ReadonlyArray<ReadonlyArray<keyof BrowseState>> = [
		['current', 'hierarchy', 'loading', 'error'],
		['lastSearch', 'lastSearchQuery', 'searchLoading', 'searchError']
	];
	internalStore.update((curr) => {
		const out: BrowseState = { ...curr };
		for (const slice of slices) {
			const anyIndependentlyChanged = slice.some(
				(k) => !Object.is(curr[k], afterMutation[k])
			);
			if (anyIndependentlyChanged) continue;
			for (const k of slice) {
				(out as Record<keyof BrowseState, unknown>)[k] = prior[k];
			}
		}
		return out;
	});
}

export function resetBrowse(): void {
	internalStore.set(initialState);
}
