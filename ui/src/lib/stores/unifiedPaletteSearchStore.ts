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
import type { SearchResult } from '@shared/types';
import { browseSearch } from '$lib/api/client';
import { unifiedSearchClient, type UnifiedSearchClient } from '$lib/unifiedSearchClient';
import {
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim
} from '$lib/stores/classicBrowseSessionStore';

/** Below this many characters the palette stays local-only. */
export const PALETTE_SEARCH_MIN_QUERY = 2;
/** The reference SONGS group shows at most six rows. */
export const PALETTE_SEARCH_GROUP_ROW_LIMIT = 6;
/** Browse categories show a bounded preview; See All reaches the full hierarchy. */
export const PALETTE_BROWSE_GROUP_ROW_LIMIT = 4;

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

export interface PaletteBrowseSearchGroup {
	/** Display label: Roon's category title or a stable synthetic taxonomy label. */
	readonly title: string;
	/** Exact Roon category address; null means this group cannot offer See All. */
	readonly categoryTitle: string | null;
	readonly resultType: SearchResult['resultType'];
	readonly total: number;
	readonly rows: readonly SearchResult[];
}

export interface PaletteSearchState {
	readonly phase: 'idle' | 'searching' | 'ready' | 'error';
	readonly query: string;
	readonly groups: readonly PaletteSearchGroup[];
	/** Optional only so injected pre-P2 test stores degrade safely. */
	readonly browseGroups?: readonly PaletteBrowseSearchGroup[];
	readonly error: string | null;
	/** One authority can fail while the other still returns useful rows. */
	readonly partialError?: string | null;
}

const IDLE_STATE: PaletteSearchState = {
	phase: 'idle',
	query: '',
	groups: [],
	browseGroups: [],
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

function keylessSearchResult(result: SearchResult): SearchResult {
	const descriptor = { ...result };
	delete descriptor.itemKey;
	return descriptor;
}

function fallbackCategoryTitle(resultType: SearchResult['resultType']): string {
	const labels: Record<SearchResult['resultType'], string> = {
		artist: 'Artists',
		album: 'Albums',
		track: 'Tracks',
		playlist: 'Playlists',
		genre: 'Genres',
		composer: 'Composers',
		label: 'Labels',
		radio: 'Radio',
		unknown: 'Other'
	};
	return labels[resultType];
}

export function groupBrowseSearchResults(
	results: readonly SearchResult[]
): PaletteBrowseSearchGroup[] {
	const grouped = new Map<
		string,
		{
			title: string;
			categoryTitle: string | null;
			resultType: SearchResult['resultType'];
			observed: number;
			total: number;
			rows: SearchResult[];
		}
	>();
	for (const raw of results) {
		const row = keylessSearchResult(raw);
		const categoryTitle = row.categoryTitle?.trim() || null;
		const title = categoryTitle ?? fallbackCategoryTitle(row.resultType);
		const key = `${row.resultType}:${categoryTitle ?? ''}`;
		const current = grouped.get(key) ?? {
			title,
			categoryTitle,
			resultType: row.resultType,
			observed: 0,
			total: 0,
			rows: []
		};
		current.observed += 1;
		current.total = Math.max(current.total, row.categoryTotal ?? current.observed);
		if (current.rows.length < PALETTE_BROWSE_GROUP_ROW_LIMIT) current.rows.push(row);
		grouped.set(key, current);
	}
	return [...grouped.values()].map(({ observed, ...group }) => ({
		...group,
		total: Math.max(group.total, observed, group.rows.length)
	}));
}

export type PaletteBrowseSearch = (
	claim: ClassicBrowseSessionClaim,
	query: string
) => Promise<readonly SearchResult[]>;

const defaultBrowseSearch: PaletteBrowseSearch = (claim, query) =>
	browseSearch(fetch, { input: query, popAll: true }, claim, 'classic-search');

/**
 * Runs one bounded coordinated search. Later calls fence earlier ones;
 * a stale response is dropped whole.
 */
export async function searchPalette(
	claim: ClassicBrowseSessionClaim,
	query: string,
	client: UnifiedSearchClient = unifiedSearchClient,
	searchBrowse: PaletteBrowseSearch = defaultBrowseSearch
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
		browseGroups: [],
		error: null,
		partialError: null
	});
	let browseGroups: PaletteBrowseSearchGroup[] = [];
	let browseFailure: string | null = null;
	try {
		browseGroups = groupBrowseSearchResults(await searchBrowse(claim, trimmed));
		if (token !== fence) return;
	} catch (error) {
		if (token !== fence) return;
		if (error instanceof ClassicBrowseSupersededError) {
			internalStore.set(IDLE_STATE);
			return;
		}
		browseFailure = error instanceof Error ? error.message : 'Category search failed';
	}

	let groups: PaletteSearchGroup[] = [];
	let songFailure: string | null = null;
	try {
		// Deliberately last: this leaves the coordinated search role on the
		// retained Tracks page that owns every opaque song result ID.
		groups = groupResults(await client.search(claim, trimmed));
		if (token !== fence) return;
	} catch (error) {
		if (token !== fence) return;
		if (error instanceof ClassicBrowseSupersededError) {
			internalStore.set(IDLE_STATE);
			return;
		}
		songFailure = error instanceof Error ? error.message : 'Song search failed';
	}

	if (
		(browseFailure && songFailure) ||
		((browseFailure || songFailure) && browseGroups.length === 0 && groups.length === 0)
	) {
		internalStore.set({
			phase: 'error',
			query: trimmed,
			groups: [],
			browseGroups: [],
			error: [browseFailure, songFailure].filter(Boolean).join('; '),
			partialError: null
		});
		return;
	}
	internalStore.set({
		phase: 'ready',
		query: trimmed,
		groups,
		browseGroups,
		error: null,
		partialError: browseFailure ?? songFailure
	});
}
