import { writable, type Readable } from 'svelte/store';
import type { BrowseItem } from '@shared/types';
import { CLASSIC_BROWSE_PAGE_SIZE_MAX } from '@shared/classicBrowseContracts';
import { withClassicBrowseRoleTransaction } from '../api/client';
import {
	classicBrowseSessionClient,
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim
} from './classicBrowseSessionStore';

/**
 * Genre/composer drill → album list (plan §4 slice 5). Drill targets
 * are semantic (label); the caller resolves the label to a live
 * session itemKey via unifiedNamedCountsStore before loading here,
 * because Roon itemKeys are session-scoped and never persisted.
 * Pages to totalCount — the prototype's genre pages truncated at
 * Roon's first page, which is the limitation this store removes.
 */

export const DRILL_PAGE_SIZE = CLASSIC_BROWSE_PAGE_SIZE_MAX;
export const DRILL_MAX_ITEMS = 10_000;

export type DrillHierarchy = 'genres' | 'composers';

export interface DrillAlbum {
	readonly title: string;
	/** Roon subtitle — the artist line, when present. */
	readonly artist: string;
	readonly imageKey: string | null;
}

export interface UnifiedDrillState {
	readonly albums: readonly DrillAlbum[];
	readonly totalCount: number;
	readonly loading: boolean;
	readonly loaded: boolean;
	readonly error: string | null;
}

const INITIAL_STATE: UnifiedDrillState = {
	albums: [],
	totalCount: 0,
	loading: false,
	loaded: false,
	error: null
};

/** Transaction subset the drain needs — fakeable in tests. */
export interface DrillTransaction {
	browse(options: {
		hierarchy: DrillHierarchy;
		itemKey?: string;
		pageSize: number;
	}): Promise<{ totalCount?: number; count: number; items: BrowseItem[] }>;
	browseLoad(options: {
		hierarchy: DrillHierarchy;
		offset: number;
		count: number;
	}): Promise<{ items: BrowseItem[] }>;
}

/** Play/Shuffle rows and other verbs are not albums. */
function isActionItem(item: BrowseItem): boolean {
	return item.hint === 'action' || item.hint === 'action_list';
}

export async function drainDrillAlbums(
	transaction: DrillTransaction,
	hierarchy: DrillHierarchy,
	itemKey: string
): Promise<BrowseItem[]> {
	const node = await transaction.browse({
		hierarchy,
		itemKey,
		pageSize: DRILL_PAGE_SIZE
	});
	// Genre nodes are section lists (Play Genre / Albums / Artists /
	// subgenres). Prefer the Albums child; composers drill straight to
	// their album list, so a node without one is used as-is.
	const albumsChild = node.items.find((item) => item.title === 'Albums' && item.itemKey);
	const list = albumsChild
		? await transaction.browse({
				hierarchy,
				itemKey: albumsChild.itemKey,
				pageSize: DRILL_PAGE_SIZE
			})
		: node;
	const total = Math.min(list.totalCount ?? list.count, DRILL_MAX_ITEMS);
	const collected: BrowseItem[] = [...list.items].slice(0, DRILL_MAX_ITEMS);
	while (collected.length < total) {
		const page = await transaction.browseLoad({
			hierarchy,
			offset: collected.length,
			count: Math.min(DRILL_PAGE_SIZE, total - collected.length)
		});
		if (page.items.length === 0) break; // Roon returned short; stop honestly.
		collected.push(...page.items);
	}
	return collected.slice(0, total).filter((item) => !isActionItem(item));
}

/**
 * Re-resolve a persisted semantic target and consume its fresh opaque key
 * without releasing the Explore-role transaction between those operations.
 * A key cached by the named-counts view may have been evicted after another
 * large Explore result (notably the complete Composers list) was published.
 */
export async function drainSemanticDrillAlbums(
	transaction: DrillTransaction,
	hierarchy: DrillHierarchy,
	label: string
): Promise<BrowseItem[] | null> {
	const root = await transaction.browse({ hierarchy, pageSize: DRILL_PAGE_SIZE });
	const total = Math.min(root.totalCount ?? root.count, DRILL_MAX_ITEMS);
	let target = root.items.find((item) => item.title === label && item.itemKey);
	let offset = root.items.length;
	while (!target && offset < total) {
		const page = await transaction.browseLoad({
			hierarchy,
			offset,
			count: Math.min(DRILL_PAGE_SIZE, total - offset)
		});
		if (page.items.length === 0) break;
		target = page.items.find((item) => item.title === label && item.itemKey);
		offset += page.items.length;
	}
	if (!target?.itemKey) return null;
	return drainDrillAlbums(transaction, hierarchy, target.itemKey);
}

export interface UnifiedDrillStore extends Readable<UnifiedDrillState> {
	load(
		claim: ClassicBrowseSessionClaim,
		hierarchy: DrillHierarchy,
		label: string
	): Promise<void>;
	reset(): void;
}

export function createUnifiedDrillStore(): UnifiedDrillStore {
	const internalStore = writable<UnifiedDrillState>(INITIAL_STATE);
	let loadToken = 0;

	async function load(
		claim: ClassicBrowseSessionClaim,
		hierarchy: DrillHierarchy,
		label: string
	): Promise<void> {
		loadToken += 1;
		const myToken = loadToken;
		internalStore.set({ ...INITIAL_STATE, loading: true });
		try {
			const items = await withClassicBrowseRoleTransaction('classic-explore', claim, (transaction) =>
				drainSemanticDrillAlbums(transaction, hierarchy, label)
			);
			if (myToken !== loadToken || !classicBrowseSessionClient.isClaimCurrent(claim)) return;
			const resolvedItems = items ?? [];
			internalStore.set({
				albums: resolvedItems.map((item) => ({
					title: item.title,
					artist: item.subtitle ?? '',
					imageKey: item.imageKey ?? null
				})),
				totalCount: resolvedItems.length,
				loading: false,
				loaded: true,
				error: null
			});
		} catch (err) {
			if (myToken !== loadToken) return;
			if (err instanceof ClassicBrowseSupersededError) {
				internalStore.update((state) => ({ ...state, loading: false }));
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			internalStore.update((state) => ({ ...state, loading: false, error: message }));
		}
	}

	function reset(): void {
		loadToken += 1;
		internalStore.set(INITIAL_STATE);
	}

	return { subscribe: internalStore.subscribe, load, reset };
}

export const unifiedDrillStore = createUnifiedDrillStore();
