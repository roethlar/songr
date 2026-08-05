import { writable } from 'svelte/store';
import type { BrowseItem, BrowseResult } from '@shared/types';
import { withClassicBrowseRoleTransaction } from '../api/client';
import {
	classicBrowseSessionClient,
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim
} from './classicBrowseSessionStore';

/**
 * Left-rail "Explore" data — the top-level Roon browse-hierarchy
 * navigation surfaced as a sidebar nav. Ships with PR1 of the UX
 * overhaul.
 *
 * Resolution strategy (see docs/UX_OVERHAUL_PLAN_2026-05-05.md):
 * runs at layout mount and on `core-status: paired/reconnect`. Uses
 * the coordinator-owned Classic Explore role so the user's main browse
 * session isn't disturbed by the popAll/drill pattern the resolver does.
 *
 * Entry identity is `labelPath: string[]` — stable across Roon
 * Core restarts. `cachedKey` and `cachedAncestorKeys` carry the
 * Roon itemKey chain captured during resolution; the layout's rail
 * click handler walks the chain (popAll + drill each ancestor +
 * drill leaf) instead of doing the label-scan slow path. Browse-command
 * count is the same — Roon's browse session is stack-based so
 * every level must be drilled — but the fast path skips the
 * per-drill title-match scan and uses known-good keys. Stale keys
 * (Core restart) cause the fast-path drill to fail and the handler
 * falls through to the label walk; the resolver re-runs on the
 * next `core-status: paired` and repopulates the cache.
 */

export interface ExploreRailEntry {
	/** The label rendered in the rail. Same as labelPath[labelPath.length-1]. */
	label: string;
	/**
	 * Stable identity: chain of titles drilled through to reach this
	 * entry. ["Genres"] for top-level; ["Library", "Albums"] for
	 * nested.
	 */
	labelPath: string[];
	/** Hint from Roon at the leaf level — used for filtering. */
	hint?: string;
	/** itemType from Roon — currently always undefined at level 0/1. */
	itemType?: string;
	/**
	 * True when the leaf container has zero `hint: 'list'` children.
	 * Detected during resolution by drilling each level-0 list-hint
	 * child once. Renders muted in the rail; click still works (lands
	 * on whatever the empty state is).
	 */
	isEmpty?: boolean;
	/**
	 * Roon itemKeys captured during resolution. The rail click
	 * handler walks `cachedAncestorKeys` then drills `cachedKey`
	 * (matches labelPath positions; `cachedAncestorKeys.length ===
	 * labelPath.length - 1`). Empty ancestors for top-level entries.
	 * Stale keys after a Roon Core restart cause the drill to fail
	 * and the handler falls back to the title-match label walk;
	 * the resolver re-runs on the next `core-status: paired`.
	 */
	cachedKey?: string;
	cachedAncestorKeys?: string[];
}

export interface ExploreRailState {
	entries: ExploreRailEntry[];
	loading: boolean;
	error: string | null;
}

/**
 * Level-0 entries to drill for nested rail items. Today only
 * `Library` is expanded — its children become nested rail items.
 * `Playlists`, `Genres`, `My Live Radio` stay as single rail
 * entries (drilling them would clutter the rail with user-named
 * playlists / 100+ subgenres / provider lists).
 */
const EXPANDED_LEVEL_0 = new Set(['Library']);

/**
 * Level-0 entries to exclude from the rail entirely. None today —
 * `Settings` is surfaced even though our public-API surface can't
 * drive every action it exposes; users want it visible per
 * 2026-05-07 feedback.
 */
const EXCLUDED_LEVEL_0 = new Set<string>();

/**
 * Level-0 entries to surface in the rail but NOT drill for the
 * empty-state check. `Settings` is a special pseudo-list in Roon's
 * browse hierarchy — drilling its item token returns `InvalidItemKey`
 * even from a clean popAll'd session. The catch block downstream
 * handles the failure, but issuing a predictably invalid command still
 * pollutes the server journal and browser feedback.
 *
 * Skip these: rail entry still renders (no isEmpty flag — never
 * muted), click-through still works via the layout's label-walk
 * fallback (cachedKey is also left unset to force the slow path).
 */
const SKIP_DRILL_LEVEL_0 = new Set(['Settings']);

/**
 * Level-1 entries under `Library` to exclude from the rail.
 * `Search` is redundant with the top-bar search input.
 */
const EXCLUDED_LEVEL_1_BY_PARENT: Record<string, Set<string>> = {
	Library: new Set(['Search'])
};

const initialState: ExploreRailState = {
	entries: [],
	loading: false,
	error: null
};

const internalStore = writable<ExploreRailState>(initialState);

/**
 * Monotonic resolve token. `core-status: paired` can fire multiple
 * times in quick succession (e.g. flap during reconnect), and each
 * triggers `resolveExploreRail`. Without a token, a slow-failing
 * earlier call could overwrite a fast-succeeding later one with an
 * error state — preserving the entries it didn't touch but masking
 * them behind a stale error in the layout. Each call captures the
 * token at start and only commits its result if the token is still
 * current at the end.
 */
let resolveToken = 0;

export const exploreRailStore = {
	subscribe: internalStore.subscribe
};

function isListChild(item: BrowseItem): boolean {
	return item.hint === 'list' && !!item.itemKey;
}

function hasListChildren(result: BrowseResult): boolean {
	return result.items.some(isListChild);
}

function requireFreshRootItem(root: BrowseResult, staleItem: BrowseItem): BrowseItem {
	const matches = root.items.filter(
		(item) =>
			isListChild(item) && item.title === staleItem.title && item.hint === staleItem.hint
	);
	if (matches.length !== 1) {
		throw new Error(
			`Explore root changed while resolving ${staleItem.title}: expected one title/hint match, found ${matches.length}`
		);
	}
	return matches[0];
}

/**
 * Resolve the rail's structure by drilling browse root + level-1
 * children of expanded entries. The whole resolver owns the shared
 * Explore role until its final drill so another resolver cannot
 * invalidate an itemKey between steps.
 */
export async function resolveExploreRail(
	_fetchFn: typeof fetch,
	claim: ClassicBrowseSessionClaim
): Promise<void> {
	const myToken = ++resolveToken;
	internalStore.update((s) => ({ ...s, loading: true, error: null }));

	try {
		const entries = await withClassicBrowseRoleTransaction(
			'classic-explore',
			claim,
			async (transaction): Promise<ExploreRailEntry[]> => {
				// Level 0 — fresh session, popAll guarantees we land at the root.
				const root = await transaction.browse({
					hierarchy: 'browse',
					popAll: true
				});

				const resolved: ExploreRailEntry[] = [];

		for (const item of root.items) {
			if (!isListChild(item)) continue;
			if (EXCLUDED_LEVEL_0.has(item.title)) continue;

			// Skip the empty-check drill for items known to fail with
			// InvalidItemKey (currently just `Settings`). Surface them
			// as plain rail entries with no isEmpty flag (so never
			// muted) and no cached itemKey (so click-through walks
			// labels). This stops the 500 spam on every rail resolve.
			if (SKIP_DRILL_LEVEL_0.has(item.title)) {
				resolved.push({
					label: item.title,
					labelPath: [item.title],
					hint: item.hint,
					itemType: item.itemType
				});
				continue;
			}

			// Drill once for empty-state detection AND (if expanded) for
			// nested entries. popAll first because Roon's browse session
			// is stack-based — without it, sibling drills would inherit
			// the prior drill's level.
			const freshRoot = await transaction.browse({
				hierarchy: 'browse',
				popAll: true
			});
			const freshItem = requireFreshRootItem(freshRoot, item);
			const child = await transaction.browse({
				hierarchy: 'browse',
				itemKey: freshItem.itemKey
			});

			const empty = !hasListChildren(child);

			if (EXPANDED_LEVEL_0.has(item.title)) {
				// Nested expansion — surface each level-1 list child
				// (minus the parent-specific exclusion list).
				const excludedChildren =
					EXCLUDED_LEVEL_1_BY_PARENT[item.title] ?? new Set<string>();

				for (const grand of child.items) {
					if (!isListChild(grand)) continue;
					if (excludedChildren.has(grand.title)) continue;

					resolved.push({
						label: grand.title,
						labelPath: [item.title, grand.title],
						hint: grand.hint,
						itemType: grand.itemType,
						// Populate cached itemKeys for the fast-path on
						// click. cachedAncestorKeys carries the path
						// from level-0 down to (but not including) the
						// leaf; cachedKey is the leaf itself. Stale keys
						// (Core restart) make the fast-path fail
						// silently and the label-walk fallback runs.
						cachedKey: grand.itemKey,
						cachedAncestorKeys:
							freshItem.itemKey !== undefined ? [freshItem.itemKey] : []
						// isEmpty for nested entries left undefined —
						// detecting it would require N more drills.
						// Resolved at first click instead.
					});
				}

				// Add the parent itself as a non-clickable section
				// header? Layout decides. For now, the parent label is
				// represented only by its children's labelPath[0]; the
				// layout component renders the section header from the
				// labelPath grouping.
				continue;
			}

			// Top-level entry, not expanded — surface as a single rail
			// item with its empty-state flag set.
			resolved.push({
				label: item.title,
				labelPath: [item.title],
				hint: item.hint,
				itemType: item.itemType,
				isEmpty: empty,
				cachedKey: freshItem.itemKey,
				cachedAncestorKeys: []
			});
		}

				return resolved;
			}
		);

		if (myToken !== resolveToken) return; // newer call superseded us
		if (!classicBrowseSessionClient.isClaimCurrent(claim)) {
			throw new ClassicBrowseSupersededError();
		}
		internalStore.set({ entries, loading: false, error: null });
	} catch (err) {
		if (myToken !== resolveToken) return; // newer call superseded us
		const message =
			err instanceof ClassicBrowseSupersededError
				? null
				: err instanceof Error
					? err.message
					: 'Rail resolution failed';
		internalStore.set({ entries: [], loading: false, error: message });
	}
}

/**
 * Drop entries and reset to loading state. Called when the Roon
 * Core un-pairs (cached itemKeys would all be stale after a Core
 * restart). The layout calls `resolveExploreRail` again on
 * `core-status: paired`.
 */
export function invalidateExploreRail(): void {
	// Bump the token so any in-flight resolve from before the
	// invalidate doesn't trample the cleared state on completion.
	resolveToken++;
	internalStore.set({ ...initialState });
}
