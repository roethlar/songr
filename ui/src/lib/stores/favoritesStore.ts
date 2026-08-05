import { writable } from 'svelte/store';
import type { AddFavoriteRequest, FavoriteEntry } from '@shared/types';
import {
	fetchFavorites,
	addFavorite as apiAddFavorite,
	removeFavorite as apiRemoveFavorite
} from '../api/client';

/**
 * User-curated favorites (tracks / albums / artists). REST-only: every
 * mutation response carries the authoritative full list, which simply
 * replaces local state — no socket deltas, no revision ordering.
 * Other open clients converge on their next load.
 */

export interface FavoritesState {
	entries: FavoriteEntry[];
	loading: boolean;
	loaded: boolean;
}

const initialState: FavoritesState = {
	entries: [],
	loading: false,
	loaded: false
};

const internalStore = writable<FavoritesState>(initialState);

export const favoritesStore = {
	subscribe: internalStore.subscribe
};

export async function loadFavorites(fetchFn: typeof fetch): Promise<void> {
	internalStore.update((s) => ({ ...s, loading: true }));
	try {
		const { entries } = await fetchFavorites(fetchFn);
		internalStore.set({ entries, loading: false, loaded: true });
	} catch {
		// Leave whatever was loaded visible; just clear the flag.
		internalStore.update((s) => ({ ...s, loading: false }));
	}
}

/** Add a favorite. Errors propagate so callers can toast. */
export async function addFavorite(
	fetchFn: typeof fetch,
	payload: AddFavoriteRequest
): Promise<void> {
	const { entries } = await apiAddFavorite(fetchFn, payload);
	internalStore.set({ entries, loading: false, loaded: true });
}

/** Remove a favorite by id. Errors propagate so callers can toast. */
export async function removeFavorite(fetchFn: typeof fetch, id: string): Promise<void> {
	const { entries } = await apiRemoveFavorite(fetchFn, id);
	internalStore.set({ entries, loading: false, loaded: true });
}

export function resetFavorites(): void {
	internalStore.set({ ...initialState });
}
