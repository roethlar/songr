import { writable, type Readable } from 'svelte/store';
import type { BrowseItem } from '@shared/types';
import { CLASSIC_BROWSE_PAGE_SIZE_MAX } from '@shared/classicBrowseContracts';
import { withClassicBrowseRoleTransaction } from '../api/client';
import { pluralize } from '../pluralize';
import {
	classicBrowseSessionClient,
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim
} from './classicBrowseSessionStore';

/**
 * Unified Library "Genres" and "Composers" scopes (plan §4 slice 5).
 * Both are real Roon hierarchies, paged to totalCount — the prototype
 * truncated at Roon's first page, which is exactly the limitation this
 * store removes. Runs on the coordinator-owned classic-explore role so
 * the user's Classic browse session is never disturbed.
 */

export const NAMED_COUNTS_PAGE_SIZE = CLASSIC_BROWSE_PAGE_SIZE_MAX;
export const NAMED_COUNTS_MAX_ITEMS = 10_000;
/** The literal build-v5 genre-card display bound. */
export const GENRE_PAGE_BOUND = 60;

export interface NamedCountEntry {
	readonly label: string;
	/** Parsed from Roon's subtitle ("123 Albums"); 0 when absent. */
	readonly albumCount: number;
	readonly itemKey: string | null;
	readonly imageKey: string | null;
}

export interface NamedCountsState {
	readonly entries: readonly NamedCountEntry[];
	readonly totalCount: number;
	readonly loading: boolean;
	readonly loaded: boolean;
	readonly error: string | null;
}

const INITIAL_STATE: NamedCountsState = {
	entries: [],
	totalCount: 0,
	loading: false,
	loaded: false,
	error: null
};

/** "12 Artists, 123 Albums" → 123. Exposed for tests. */
export function parseAlbumCount(subtitle: string | undefined): number {
	if (typeof subtitle !== 'string') return 0;
	const match = subtitle.match(/([\d,\s ]+)\+?\s+Albums?\b/i);
	if (!match) return 0;
	const parsed = Number.parseInt(match[1].replace(/[,\s ]/g, ''), 10);
	return Number.isSafeInteger(parsed) ? parsed : 0;
}

export function formatGenreAlbumCount(albumCount: number): string {
	if (!Number.isSafeInteger(albumCount) || albumCount <= 0) return '';
	const bounded = albumCount >= GENRE_PAGE_BOUND;
	const label = bounded ? `${GENRE_PAGE_BOUND}+` : `${albumCount}`;
	// The bounded ("60+") form means "at least 60" and always stays plural.
	const noun = bounded ? 'ALBUMS' : pluralize(albumCount, 'ALBUM', 'ALBUMS');
	return `${label} ${noun}`;
}

function toEntry(item: BrowseItem): NamedCountEntry {
	return {
		label: item.title,
		albumCount: parseAlbumCount(item.subtitle),
		itemKey: item.itemKey ?? null,
		imageKey: item.imageKey ?? null
	};
}

/** Transaction subset the drain needs — fakeable in tests. */
export interface NamedCountsTransaction {
	browse(options: {
		hierarchy: 'genres' | 'composers';
		pageSize: number;
	}): Promise<{ totalCount?: number; count: number; items: BrowseItem[] }>;
	browseLoad(options: {
		hierarchy: 'genres' | 'composers';
		offset: number;
		count: number;
	}): Promise<{ items: BrowseItem[] }>;
}

export async function drainNamedCounts(
	transaction: NamedCountsTransaction,
	hierarchy: 'genres' | 'composers'
): Promise<BrowseItem[]> {
	const root = await transaction.browse({
		hierarchy,
		pageSize: NAMED_COUNTS_PAGE_SIZE
	});
	const total = Math.min(root.totalCount ?? root.count, NAMED_COUNTS_MAX_ITEMS);
	const collected: BrowseItem[] = [...root.items].slice(0, NAMED_COUNTS_MAX_ITEMS);
	while (collected.length < total) {
		const page = await transaction.browseLoad({
			hierarchy,
			offset: collected.length,
			count: Math.min(NAMED_COUNTS_PAGE_SIZE, total - collected.length)
		});
		if (page.items.length === 0) break; // Roon returned short; stop honestly.
		collected.push(...page.items);
	}
	return collected.slice(0, total);
}

export interface NamedCountsStore extends Readable<NamedCountsState> {
	load(claim: ClassicBrowseSessionClaim): Promise<void>;
	reset(): void;
}

export function createNamedCountsStore(hierarchy: 'genres' | 'composers'): NamedCountsStore {
	const internalStore = writable<NamedCountsState>(INITIAL_STATE);
	let loadToken = 0;

	async function load(claim: ClassicBrowseSessionClaim): Promise<void> {
		loadToken += 1;
		const myToken = loadToken;
		internalStore.update((state) => ({ ...state, loading: true, error: null }));
		try {
			const items = await withClassicBrowseRoleTransaction('classic-explore', claim, (transaction) =>
				drainNamedCounts(transaction, hierarchy)
			);
			if (myToken !== loadToken || !classicBrowseSessionClient.isClaimCurrent(claim)) return;
			internalStore.set({
				entries: items.map(toEntry),
				totalCount: items.length,
				loading: false,
				loaded: true,
				error: null
			});
		} catch (err) {
			if (myToken !== loadToken) return;
			if (err instanceof ClassicBrowseSupersededError) {
				// A newer claim owns the session; drop quietly, keep prior data.
				internalStore.update((state) => ({ ...state, loading: false }));
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			internalStore.update((state) => ({
				...state,
				loading: false,
				error: message
			}));
		}
	}

	function reset(): void {
		loadToken += 1;
		internalStore.set(INITIAL_STATE);
	}

	return { subscribe: internalStore.subscribe, load, reset };
}

export const unifiedGenresStore = createNamedCountsStore('genres');
export const unifiedComposersStore = createNamedCountsStore('composers');
