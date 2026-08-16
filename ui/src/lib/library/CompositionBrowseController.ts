import { writable, type Readable } from 'svelte/store';
import type { BrowseItem } from '@shared/types';
import { CLASSIC_BROWSE_PAGE_SIZE_MAX } from '@shared/classicBrowseContracts';
import { withClassicBrowseRoleTransaction } from '../api/client';
import {
	classicBrowseSessionClient,
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim
} from '../stores/classicBrowseSessionStore';

/**
 * The retained `composers`-hierarchy session behind the public
 * composition page (rich-item plan Slice 6, §2.5/§5.2). The composer
 * row is located by UNIQUE label match (the same semantics the drill
 * and breadcrumb restore already use — ambiguity refuses honestly);
 * everything below it is live item authority: composition rows, then
 * the composition's own action and recording rows. The page renders
 * only what the hierarchy supplies, and a composer display label alone
 * is never composition authority.
 */

const PAGE_SIZE = CLASSIC_BROWSE_PAGE_SIZE_MAX;
const MAX_ROWS = 10_000;
const HIERARCHY = 'composers' as const;
// The surface's own classic role (ri8-3): its full composers walk must never
// share a Roon-side list cursor with the palette's named-counts drain, which
// pages the same hierarchy on classic-explore.
const ROLE = 'classic-composition' as const;

export interface CompositionRow {
	readonly title: string;
	readonly subtitle: string;
	readonly itemKey: string | null;
}

export interface CompositionPage {
	readonly title: string;
	/** Action-hint rows the hierarchy supplied (Play Work, …). */
	readonly actions: readonly { title: string; itemKey: string }[];
	readonly recordings: readonly CompositionRow[];
}

export interface CompositionBrowseState {
	readonly phase: 'idle' | 'loading' | 'compositions' | 'page' | 'failed';
	readonly composerLabel: string | null;
	readonly compositions: readonly CompositionRow[];
	/**
	 * The live node stack below the composition list: pages[0] is the
	 * composition's own node (Play Work + recordings); a selected
	 * recording pushes ITS supplied node (its own action rows). Back
	 * pops one level, mirroring the session's hierarchy position.
	 */
	readonly pages: readonly CompositionPage[];
	readonly actionBusy: boolean;
	readonly notice: string | null;
	readonly error: string | null;
}

const INITIAL_STATE: CompositionBrowseState = {
	phase: 'idle',
	composerLabel: null,
	compositions: [],
	pages: [],
	actionBusy: false,
	notice: null,
	error: null
};

/** Transaction subset the controller needs — fakeable in tests. */
export interface CompositionTransaction {
	browse(options: {
		hierarchy: typeof HIERARCHY;
		itemKey?: string;
		zoneId?: string;
		popAll?: boolean;
		pageSize?: number;
	}): Promise<{ totalCount?: number; count: number; items: BrowseItem[] }>;
	browseLoad(options: {
		hierarchy: typeof HIERARCHY;
		offset: number;
		count: number;
	}): Promise<{ items: BrowseItem[] }>;
	browsePop(options: {
		hierarchy: typeof HIERARCHY;
		levels: number;
	}): Promise<unknown>;
}

function isActionItem(item: BrowseItem): boolean {
	return item.hint === 'action' || item.hint === 'action_list';
}

/**
 * Pages one node through browseLoad up to the bounded total (ri6-2);
 * short responses stop honestly rather than looping.
 */
async function drainNode(
	transaction: CompositionTransaction,
	first: { totalCount?: number; count: number; items: BrowseItem[] }
): Promise<BrowseItem[]> {
	const total = Math.min(first.totalCount ?? first.count, MAX_ROWS);
	const collected: BrowseItem[] = [...first.items].slice(0, MAX_ROWS);
	while (collected.length < total) {
		const page = await transaction.browseLoad({
			hierarchy: HIERARCHY,
			offset: collected.length,
			count: Math.min(PAGE_SIZE, total - collected.length)
		});
		if (page.items.length === 0) break;
		collected.push(...page.items);
	}
	return collected.slice(0, total);
}

function asRow(item: BrowseItem): CompositionRow {
	return {
		title: item.title,
		subtitle: item.subtitle ?? '',
		itemKey: item.itemKey ?? null
	};
}

/**
 * Pages the hierarchy root until the label matches EXACTLY ONE row.
 * Zero matches → null; more than one → 'ambiguous' (never a guess).
 */
export async function findUniqueComposerRow(
	transaction: CompositionTransaction,
	label: string,
	shouldAbort: () => boolean = () => false
): Promise<BrowseItem | null | 'ambiguous'> {
	// popAll: the scan starts from the hierarchy root even when an earlier
	// composition open left this session's list a level deep (ri8-3).
	const root = await transaction.browse({ hierarchy: HIERARCHY, popAll: true, pageSize: PAGE_SIZE });
	if (shouldAbort()) throw new ClassicBrowseSupersededError();
	const total = Math.min(root.totalCount ?? root.count, MAX_ROWS);
	const matchesPage = (item: BrowseItem) => item.title === label && item.itemKey;
	const matches: BrowseItem[] = root.items.filter(matchesPage);
	let matchOffset = matches.length > 0 ? 0 : -1;
	let offset = root.items.length;
	while (matches.length < 2 && offset < total) {
		const page = await transaction.browseLoad({
			hierarchy: HIERARCHY,
			offset,
			count: Math.min(PAGE_SIZE, total - offset)
		});
		if (shouldAbort()) throw new ClassicBrowseSupersededError();
		if (page.items.length === 0) break;
		const pageMatches = page.items.filter(matchesPage);
		if (pageMatches.length > 0 && matchOffset < 0) matchOffset = offset;
		matches.push(...pageMatches);
		offset += page.items.length;
	}
	if (matches.length === 0) return null;
	if (matches.length > 1) return 'ambiguous';
	// The ambiguity walk publishes every scanned page's item keys; on a
	// hierarchy larger than the per-role key authority the match's key may
	// already be evicted by the time the walk ends. Reload the match's own
	// page so its key is freshly published (ri8-3).
	const refreshed = await transaction.browseLoad({
		hierarchy: HIERARCHY,
		offset: matchOffset,
		count: Math.min(PAGE_SIZE, Math.max(1, total - matchOffset))
	});
	if (shouldAbort()) throw new ClassicBrowseSupersededError();
	const fresh = refreshed.items.filter(matchesPage);
	if (fresh.length === 1) return fresh[0];
	if (fresh.length > 1) return 'ambiguous';
	// The page no longer holds the row (list shifted mid-walk): the scan's
	// own row is the best remaining answer; a genuinely stale key then
	// fails honestly at the node browse.
	return matches[0];
}

export interface CompositionBrowseController extends Readable<CompositionBrowseState> {
	openForComposer(claim: ClassicBrowseSessionClaim, label: string): Promise<void>;
	openComposition(claim: ClassicBrowseSessionClaim, row: CompositionRow): Promise<void>;
	runAction(
		claim: ClassicBrowseSessionClaim,
		action: { title: string; itemKey: string },
		zoneId: string
	): Promise<void>;
	backToCompositions(claim: ClassicBrowseSessionClaim): Promise<void>;
	reset(): void;
}

export function createCompositionBrowseController(): CompositionBrowseController {
	const internalStore = writable<CompositionBrowseState>(INITIAL_STATE);
	let token = 0;
	/**
	 * Synchronous re-entrancy latch (ri6-3): one navigation transition at
	 * a time — a double-clicked Back must not pop the session twice for
	 * one UI transition.
	 */
	let navigationBusy = false;
	let current: CompositionBrowseState = INITIAL_STATE;
	internalStore.subscribe((state) => {
		current = state;
	});

	function publish(next: CompositionBrowseState): void {
		internalStore.set(next);
	}

	async function guarded(
		claim: ClassicBrowseSessionClaim,
		work: (transaction: CompositionTransaction) => Promise<CompositionBrowseState | null>
	): Promise<void> {
		token += 1;
		const myToken = token;
		try {
			const next = await withClassicBrowseRoleTransaction(ROLE, claim, (transaction) =>
				work(transaction as unknown as CompositionTransaction)
			);
			if (myToken !== token || !classicBrowseSessionClient.isClaimCurrent(claim)) return;
			if (next !== null) publish(next);
		} catch (err) {
			if (myToken !== token) return;
			if (err instanceof ClassicBrowseSupersededError) {
				publish({
					...current,
					phase: current.pages.length > 0 ? 'page' : current.phase,
					actionBusy: false
				});
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			publish({ ...current, phase: 'failed', actionBusy: false, error: message });
		}
	}

	async function openForComposer(
		claim: ClassicBrowseSessionClaim,
		label: string
	): Promise<void> {
		publish({ ...INITIAL_STATE, phase: 'loading', composerLabel: label });
		await guarded(claim, async (transaction) => {
			// Supersession, never a dropped open (ri8-3 reopen): a newer
			// open or a surface reset advances the token, and this walk
			// aborts at its next page instead of racing the winner's
			// cursor — a drop-latch here left the surface wedged at
			// "Loading compositions…" when re-entered mid-walk.
			const walkToken = token;
			const shouldAbort = () => token !== walkToken;
			const composer = await findUniqueComposerRow(transaction, label, shouldAbort);
			if (composer === null) {
				return {
					...INITIAL_STATE,
					phase: 'failed',
					composerLabel: label,
					notice: `“${label}” is not in this library's composer hierarchy.`
				};
			}
			if (composer === 'ambiguous') {
				return {
					...INITIAL_STATE,
					phase: 'failed',
					composerLabel: label,
					notice: `More than one composer is named “${label}”; compositions need an unambiguous row.`
				};
			}
			const node = await transaction.browse({
				hierarchy: HIERARCHY,
				itemKey: composer.itemKey as string,
				pageSize: PAGE_SIZE
			});
			// Composer nodes may present section children; prefer an explicit
			// Compositions child when the hierarchy supplies one, else the
			// node's own non-action rows are the composition list.
			const compositionsChild = node.items.find(
				(item) => item.title === 'Compositions' && item.itemKey
			);
			const list = compositionsChild
				? await transaction.browse({
						hierarchy: HIERARCHY,
						itemKey: compositionsChild.itemKey as string,
						pageSize: PAGE_SIZE
					})
				: node;
			const collected = await drainNode(transaction, list);
			return {
				...INITIAL_STATE,
				phase: 'compositions',
				composerLabel: label,
				compositions: collected
					.filter((item) => !isActionItem(item))
					.map(asRow)
			};
		});
	}

	async function openComposition(
		claim: ClassicBrowseSessionClaim,
		row: CompositionRow
	): Promise<void> {
		if (row.itemKey === null || navigationBusy) return;
		navigationBusy = true;
		try {
			await openCompositionInner(claim, row);
		} finally {
			navigationBusy = false;
		}
	}

	async function openCompositionInner(
		claim: ClassicBrowseSessionClaim,
		row: CompositionRow
	): Promise<void> {
		const from = current;
		publish({ ...from, phase: 'loading' });
		await guarded(claim, async (transaction) => {
			const node = await transaction.browse({
				hierarchy: HIERARCHY,
				itemKey: row.itemKey as string,
				pageSize: PAGE_SIZE
			});
			const rows = await drainNode(transaction, node);
			return {
				...from,
				phase: 'page',
				pages: [
					...from.pages,
					{
						title: row.title,
						actions: rows
							.filter((item) => isActionItem(item) && item.itemKey)
							.map((item) => ({ title: item.title, itemKey: item.itemKey as string })),
						recordings: rows.filter((item) => !isActionItem(item)).map(asRow)
					}
				],
				notice: null,
				error: null
			};
		});
	}

	async function runAction(
		claim: ClassicBrowseSessionClaim,
		action: { title: string; itemKey: string },
		zoneId: string
	): Promise<void> {
		const from = current;
		if (from.phase !== 'page' || from.pages.length === 0) return;
		publish({ ...from, actionBusy: true });
		await guarded(claim, async (transaction) => {
			const result = await transaction.browse({
				hierarchy: HIERARCHY,
				itemKey: action.itemKey,
				zoneId,
				pageSize: PAGE_SIZE
			});
			// An action_list answers with its concrete action rows; execute
			// the exact-titled row, one bounded level (browse-action pattern).
			// Entering that level MUST be undone before completion publishes
			// (ri6-1): the retained hierarchy has to sit where the UI thinks
			// it does, success or failure alike.
			const enteredList = result.items.some((item) => item.hint === 'action');
			if (enteredList) {
				try {
					const follow = result.items.find(
						(item) =>
							item.hint === 'action' && item.title === action.title && item.itemKey
					);
					if (follow?.itemKey) {
						await transaction.browse({
							hierarchy: HIERARCHY,
							itemKey: follow.itemKey,
							zoneId,
							pageSize: PAGE_SIZE
						});
					}
				} finally {
					await transaction.browsePop({ hierarchy: HIERARCHY, levels: 1 });
				}
			}
			return { ...from, actionBusy: false };
		});
	}

	async function backToCompositions(claim: ClassicBrowseSessionClaim): Promise<void> {
		const from = current;
		if (from.phase !== 'page' || from.pages.length === 0 || navigationBusy) return;
		navigationBusy = true;
		try {
			await backToCompositionsInner(claim, from);
		} finally {
			navigationBusy = false;
		}
	}

	async function backToCompositionsInner(
		claim: ClassicBrowseSessionClaim,
		from: CompositionBrowseState
	): Promise<void> {
		await guarded(claim, async (transaction) => {
			await transaction.browsePop({ hierarchy: HIERARCHY, levels: 1 });
			const pages = from.pages.slice(0, -1);
			return {
				...from,
				phase: pages.length > 0 ? 'page' : 'compositions',
				pages
			};
		});
	}

	function reset(): void {
		token += 1;
		publish(INITIAL_STATE);
	}

	return {
		subscribe: internalStore.subscribe,
		openForComposer,
		openComposition,
		runAction,
		backToCompositions,
		reset
	};
}
