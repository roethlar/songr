/**
 * Bounded async palette search for the unified library view (plan §3.2,
 * slice 7).
 *
 * The palette's instant sections come straight from local indexes. This
 * store supplies its one async section: a bounded Roon song search whose
 * raw result handles remain on the server behind opaque result IDs.
 *
 * Every request is fenced by token and Core: stale responses are dropped
 * whole, never merged. A superseded session resets to idle — the claim is
 * going away with the whole view.
 */
import { writable } from 'svelte/store';

import type { UnifiedSongSearchResult } from '@shared/unifiedSearchContracts';
import { unifiedSearchClient, type UnifiedSearchClient } from '$lib/unifiedSearchClient';
import {
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim
} from '$lib/stores/classicBrowseSessionStore';

/** Below this many characters the palette stays local-only. */
export const PALETTE_SEARCH_MIN_QUERY = 2;
/** The reference SONGS group shows at most six rows. */
export const PALETTE_SEARCH_GROUP_ROW_LIMIT = 6;

export interface PaletteSearchRow {
	readonly resultId: string;
	readonly title: string;
	readonly subtitle: string;
	readonly imageKey: string | null;
}

export interface PaletteSearchGroup {
	/** Roon's category row title, e.g. "Tracks". */
	readonly title: string;
	readonly rows: readonly PaletteSearchRow[];
}

export interface PaletteSearchState {
	readonly phase: 'idle' | 'searching' | 'ready' | 'error';
	readonly query: string;
	readonly groups: readonly PaletteSearchGroup[];
	readonly error: string | null;
}

const IDLE_STATE: PaletteSearchState = {
	phase: 'idle',
	query: '',
	groups: [],
	error: null
};

const internalStore = writable<PaletteSearchState>(IDLE_STATE);

export const unifiedPaletteSearchStore = {
	subscribe: internalStore.subscribe
};

let fence = 0;

export function resetPaletteSearch(): void {
	fence += 1;
	internalStore.set(IDLE_STATE);
}

/** Explicit palette close also retires the server-owned result handles. */
export async function clearPaletteSearch(
	claim: ClassicBrowseSessionClaim,
	client: UnifiedSearchClient = unifiedSearchClient
): Promise<void> {
	resetPaletteSearch();
	await client.clear(claim);
}

function groupResults(results: readonly UnifiedSongSearchResult[]): PaletteSearchGroup[] {
	const rows = results
		.slice(0, PALETTE_SEARCH_GROUP_ROW_LIMIT)
		.map((result) => ({
			resultId: result.resultId,
			title: result.title,
			subtitle: result.subtitle,
			imageKey: result.imageKey
		}));
	return rows.length > 0 ? [{ title: 'Tracks', rows }] : [];
}

/**
 * Runs one bounded coordinated search. Later calls fence earlier ones;
 * a stale response is dropped whole.
 */
export async function searchPalette(
	claim: ClassicBrowseSessionClaim,
	query: string,
	client: UnifiedSearchClient = unifiedSearchClient
): Promise<void> {
	const trimmed = query.trim();
	fence += 1;
	const token = fence;
	if (trimmed.length < PALETTE_SEARCH_MIN_QUERY) {
		internalStore.set(IDLE_STATE);
		try {
			await client.clear(claim);
		} catch {
			// A lost or replaced claim retires the same authority at the
			// coordinator lifecycle boundary.
		}
		return;
	}
	internalStore.set({
		phase: 'searching',
		query: trimmed,
		groups: [],
		error: null
	});
	try {
		const results = await client.search(claim, trimmed);
		if (token !== fence) return;
		internalStore.set({
			phase: 'ready',
			query: trimmed,
			groups: groupResults(results),
			error: null
		});
	} catch (error) {
		if (token !== fence) return;
		if (error instanceof ClassicBrowseSupersededError) {
			internalStore.set(IDLE_STATE);
			return;
		}
		internalStore.set({
			phase: 'error',
			query: trimmed,
			groups: [],
			error: error instanceof Error ? error.message : 'Search failed'
		});
	}
}
