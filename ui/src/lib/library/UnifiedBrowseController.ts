import { writable, type Readable } from 'svelte/store';

import {
	CLASSIC_BROWSE_PAGE_SIZE_MAX,
	CLASSIC_LOAD_COUNT_MAX,
	type ClassicBrowseRole
} from '@shared/classicBrowseContracts';
import type { BrowseItem, BrowseResult, SearchResult } from '@shared/types';
import {
	normalizeBrowseHistorySnapshot,
	type BrowseBreadcrumb,
	type BrowseHistoryStep,
	type BrowseHistorySnapshot
} from '$lib/libraryPageState';
import {
	browseBreadcrumbFor,
	browseBreadcrumbMatches,
	findBrowseSearchCategoryRow,
	selectBrowseSearchItem
} from '$lib/library/browseSemantics';
import {
	withClassicBrowseRoleTransaction,
	type ClassicBrowseApiTransaction
} from '$lib/api/client';
import {
	classicBrowseSessionClient,
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim
} from '$lib/stores/classicBrowseSessionStore';
import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';

const BROWSE_RESTORE_MAX_ITEMS = 10_000;
const ACTION_MAX_ROWS = 32;
const ACTION_MAX_DEPTH = 4;

export interface UnifiedBrowseState {
	readonly phase: 'idle' | 'loading' | 'ready' | 'error';
	readonly result: BrowseResult | null;
	readonly snapshot: BrowseHistorySnapshot;
	readonly notice: string | null;
	readonly error: string | null;
}

export interface UnifiedBrowseController extends Readable<UnifiedBrowseState> {
	restore(
		claim: ClassicBrowseSessionClaim,
		snapshot: BrowseHistorySnapshot,
		zoneId?: string
	): Promise<boolean>;
	openItem(
		claim: ClassicBrowseSessionClaim,
		item: BrowseItem,
		zoneId?: string
	): Promise<boolean>;
	openSearchCategory(
		claim: ClassicBrowseSessionClaim,
		query: string,
		categoryTitle: string,
		zoneId?: string
	): Promise<boolean>;
	openSearchResult(
		claim: ClassicBrowseSessionClaim,
		query: string,
		result: SearchResult,
		zoneId?: string
	): Promise<boolean>;
	back(claim: ClassicBrowseSessionClaim, zoneId?: string): Promise<boolean>;
	forward(claim: ClassicBrowseSessionClaim, zoneId?: string): Promise<boolean>;
	loadMore(claim: ClassicBrowseSessionClaim, zoneId?: string): Promise<boolean>;
	reset(snapshot?: BrowseHistorySnapshot): void;
}

export interface UnifiedBrowseControllerDependencies {
	readonly transaction?: typeof withClassicBrowseRoleTransaction;
	readonly isClaimCurrent?: (claim: ClassicBrowseSessionClaim) => boolean;
}

function emptyBrowseSnapshot(): BrowseHistorySnapshot {
	return { context: { hierarchy: 'browse' }, history: [], forward: [] };
}

function cloneSnapshot(snapshot: BrowseHistorySnapshot): BrowseHistorySnapshot {
	const normalized = normalizeBrowseHistorySnapshot(snapshot);
	if (!normalized) throw new TypeError('Invalid semantic Browse history');
	return normalized;
}

function roleFor(snapshot: BrowseHistorySnapshot): ClassicBrowseRole {
	return snapshot.context.hierarchy === 'search' ? 'classic-search' : 'classic-browse';
}

function rootOptions(snapshot: BrowseHistorySnapshot, zoneId?: string) {
	return {
		hierarchy: snapshot.context.hierarchy,
		...(snapshot.context.hierarchy === 'search' ? { input: snapshot.context.query } : {}),
		...(zoneId ? { zoneId } : {}),
		popAll: true,
		pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX
	} as const;
}

function mergeResult(base: BrowseResult, items: readonly BrowseItem[]): BrowseResult {
	return {
		...base,
		offset: 0,
		count: items.length,
		items: [...items]
	};
}

async function collectResultItems(
	transaction: ClassicBrowseApiTransaction,
	result: BrowseResult,
	hierarchy: 'browse' | 'search',
	zoneId?: string,
	targetCount?: number
): Promise<BrowseItem[]> {
	const total = result.totalCount ?? result.count;
	if (!Number.isSafeInteger(total) || total < 0) {
		throw new Error('Browse level reported an invalid size');
	}
	if (targetCount === undefined && total > BROWSE_RESTORE_MAX_ITEMS) {
		throw new Error('Browse level is too large to restore unambiguously');
	}
	const desired = Math.min(total, targetCount ?? total);
	const collected = [...result.items];
	let offset = result.offset + result.items.length;
	while (offset < desired) {
		const page = await transaction.browseLoad({
			hierarchy,
			...(zoneId ? { zoneId } : {}),
			offset,
			count: Math.min(CLASSIC_LOAD_COUNT_MAX, desired - offset)
		});
		if (page.items.length === 0) {
			throw new Error('Browse level ended before its reported total');
		}
		collected.push(...page.items);
		offset += page.items.length;
	}
	return collected.slice(0, desired);
}

async function findUniqueBreadcrumb(
	transaction: ClassicBrowseApiTransaction,
	result: BrowseResult,
	breadcrumb: BrowseBreadcrumb,
	hierarchy: 'browse' | 'search',
	zoneId?: string,
	targetCount?: number
): Promise<{ match?: BrowseItem; reason?: string }> {
	const items = await collectResultItems(
		transaction,
		result,
		hierarchy,
		zoneId,
		targetCount
	);
	const matches = items.filter((candidate) => browseBreadcrumbMatches(candidate, breadcrumb));
	if (matches.length === 1 && matches[0].itemKey) return { match: matches[0] };
	return {
		reason:
			matches.length > 1
				? `“${breadcrumb.title}” is ambiguous`
				: `“${breadcrumb.title}” is no longer available`
	};
}

interface PathResolution {
	readonly result: BrowseResult;
	readonly snapshot: BrowseHistorySnapshot;
	readonly notice: string | null;
}

async function resolvePath(
	transaction: ClassicBrowseApiTransaction,
	snapshot: BrowseHistorySnapshot,
	zoneId?: string
): Promise<PathResolution> {
	const normalized = cloneSnapshot(snapshot);
	const hierarchy = normalized.context.hierarchy;
	let result = await transaction.browse(rootOptions(normalized, zoneId));
	const resolved: BrowseHistoryStep[] = [];
	for (const step of normalized.history) {
		const located = await findUniqueBreadcrumb(
			transaction,
			result,
			step.breadcrumb,
			hierarchy,
			zoneId,
			step.restoreCount
		);
		if (!located.match?.itemKey) {
			return {
				result,
				snapshot: { context: normalized.context, history: resolved, forward: [] },
				notice: `Restore stopped: ${located.reason ?? 'the path changed'}.`
			};
		}
		result = await transaction.browse({
			hierarchy,
			itemKey: located.match.itemKey,
			...(zoneId ? { zoneId } : {}),
			pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX
		});
		resolved.push(step);
	}
	return { result, snapshot: normalized, notice: null };
}

export function browseItemOpensActions(item: BrowseItem): boolean {
	return item.hint === 'action' || item.hint === 'action_list' || item.isPlayable;
}

export function createUnifiedBrowseController(
	dependencies: UnifiedBrowseControllerDependencies = {}
): UnifiedBrowseController {
	const runTransaction = dependencies.transaction ?? withClassicBrowseRoleTransaction;
	const isClaimCurrent = dependencies.isClaimCurrent ?? ((claim) =>
		classicBrowseSessionClient.isClaimCurrent(claim));
	let requestFence = 0;
	let state: UnifiedBrowseState = {
		phase: 'idle',
		result: null,
		snapshot: emptyBrowseSnapshot(),
		notice: null,
		error: null
	};
	const internal = writable<UnifiedBrowseState>(state);

	function publish(next: UnifiedBrowseState): void {
		state = next;
		internal.set(next);
	}

	async function restore(
		claim: ClassicBrowseSessionClaim,
		snapshot: BrowseHistorySnapshot,
		zoneId?: string
	): Promise<boolean> {
		const target = cloneSnapshot(snapshot);
		requestFence += 1;
		const token = requestFence;
		const previousSnapshot = state.snapshot;
		publish({
			phase: 'loading',
			result: null,
			snapshot: previousSnapshot,
			notice: null,
			error: null
		});
		try {
			const resolved = await runTransaction(roleFor(target), claim, (transaction) =>
				resolvePath(transaction, target, zoneId)
			);
			if (token !== requestFence || !isClaimCurrent(claim)) return false;
			publish({ phase: 'ready', error: null, ...resolved });
			return true;
		} catch (error) {
			if (token !== requestFence) return false;
			if (error instanceof ClassicBrowseSupersededError) {
				publish({
					phase: 'idle',
					result: null,
					snapshot: previousSnapshot,
					notice: null,
					error: null
				});
				return false;
			}
			publish({
				phase: 'error',
				result: null,
				snapshot: previousSnapshot,
				notice: null,
				error: error instanceof Error ? error.message : 'Browse failed'
			});
			return false;
		}
	}

	async function openItem(
		claim: ClassicBrowseSessionClaim,
		item: BrowseItem,
		zoneId?: string
	): Promise<boolean> {
		const breadcrumb = browseBreadcrumbFor(item);
		if (!breadcrumb || item.inputPrompt || browseItemOpensActions(item)) return false;
		const current = cloneSnapshot(state.snapshot);
		const restoreCount = state.result?.items.length;
		const target: BrowseHistorySnapshot = {
			context: current.context,
			history: [
				...current.history,
				{
					hierarchy: current.context.hierarchy,
					breadcrumb,
					...(restoreCount ? { restoreCount } : {})
				}
			],
			forward: []
		};
		return restore(claim, target, zoneId);
	}

	async function openSearchCategory(
		claim: ClassicBrowseSessionClaim,
		query: string,
		categoryTitle: string,
		zoneId?: string
	): Promise<boolean> {
		const normalizedQuery = query.trim();
		if (!normalizedQuery || !categoryTitle.trim()) return false;
		return restore(
			claim,
			{
				context: { hierarchy: 'search', query: normalizedQuery },
				history: [
					{
						hierarchy: 'search',
						breadcrumb: { title: categoryTitle, searchCategory: true }
					}
				],
				forward: []
			},
			zoneId
		);
	}

	async function openSearchResult(
		claim: ClassicBrowseSessionClaim,
		query: string,
		result: SearchResult,
		zoneId?: string
	): Promise<boolean> {
		if (browseItemOpensActions(result)) return false;
		const breadcrumb = browseBreadcrumbFor(result);
		const normalizedQuery = query.trim();
		if (!breadcrumb || !normalizedQuery) return false;
		const history: BrowseHistoryStep[] = [];
		if (result.categoryTitle) {
			history.push({
				hierarchy: 'search',
				breadcrumb: { title: result.categoryTitle, searchCategory: true }
			});
		}
		history.push({
			hierarchy: 'search',
			breadcrumb,
			restoreCount: CLASSIC_BROWSE_PAGE_SIZE_MAX
		});
		return restore(
			claim,
			{ context: { hierarchy: 'search', query: normalizedQuery }, history, forward: [] },
			zoneId
		);
	}

	async function back(claim: ClassicBrowseSessionClaim, zoneId?: string): Promise<boolean> {
		const current = cloneSnapshot(state.snapshot);
		const popped = current.history.at(-1);
		if (!popped) return false;
		return restore(
			claim,
			{
				context: current.context,
				history: current.history.slice(0, -1),
				forward: [...current.forward, popped]
			},
			zoneId
		);
	}

	async function forward(claim: ClassicBrowseSessionClaim, zoneId?: string): Promise<boolean> {
		const current = cloneSnapshot(state.snapshot);
		const popped = current.forward.at(-1);
		if (!popped) return false;
		return restore(
			claim,
			{
				context: current.context,
				history: [...current.history, popped],
				forward: current.forward.slice(0, -1)
			},
			zoneId
		);
	}

	async function loadMore(
		claim: ClassicBrowseSessionClaim,
		zoneId?: string
	): Promise<boolean> {
		if (!state.result || (state.phase !== 'ready' && state.phase !== 'error')) return false;
		const targetCount = Math.min(
			state.result.items.length + CLASSIC_BROWSE_PAGE_SIZE_MAX,
			state.result.totalCount ?? state.result.count
		);
		if (targetCount <= state.result.items.length) return false;
		const snapshot = cloneSnapshot(state.snapshot);
		requestFence += 1;
		const token = requestFence;
		publish({ ...state, phase: 'loading', notice: null, error: null });
		try {
			const resolved = await runTransaction(roleFor(snapshot), claim, async (transaction) => {
				const path = await resolvePath(transaction, snapshot, zoneId);
				const items = await collectResultItems(
					transaction,
					path.result,
					snapshot.context.hierarchy,
					zoneId,
					targetCount
				);
				return { ...path, result: mergeResult(path.result, items.slice(0, targetCount)) };
			});
			if (token !== requestFence || !isClaimCurrent(claim)) return false;
			publish({ phase: 'ready', error: null, ...resolved });
			return true;
		} catch (error) {
			if (token !== requestFence) return false;
			publish({
				...state,
				phase: error instanceof ClassicBrowseSupersededError ? 'idle' : 'error',
				error:
					error instanceof ClassicBrowseSupersededError
						? null
						: error instanceof Error
							? error.message
							: 'Browse paging failed'
			});
			return false;
		}
	}

	function reset(snapshot: BrowseHistorySnapshot = emptyBrowseSnapshot()): void {
		requestFence += 1;
		publish({
			phase: 'idle',
			result: null,
			snapshot: cloneSnapshot(snapshot),
			notice: null,
			error: null
		});
	}

	return {
		subscribe: internal.subscribe,
		restore,
		openItem,
		openSearchCategory,
		openSearchResult,
		back,
		forward,
		loadMore,
		reset
	};
}

export const unifiedBrowseController = createUnifiedBrowseController();

export type UnifiedBrowseActionSource =
	| {
			readonly kind: 'browse';
			readonly snapshot: BrowseHistorySnapshot;
			readonly item: BrowseItem;
			readonly restoreCount?: number;
	  }
	| {
			readonly kind: 'search';
			readonly query: string;
			readonly item: SearchResult;
	  };

export interface UnifiedBrowseActionState {
	readonly phase: 'idle' | 'loading' | 'ready' | 'executing' | 'success' | 'error';
	readonly source: UnifiedBrowseActionSource | null;
	readonly available: Readonly<Record<UnifiedSongActionSemantic, boolean>>;
	readonly error: string | null;
}

export interface UnifiedBrowseActionController extends Readable<UnifiedBrowseActionState> {
	open(
		claim: ClassicBrowseSessionClaim,
		source: UnifiedBrowseActionSource,
		zoneId?: string
	): Promise<boolean>;
	execute(
		claim: ClassicBrowseSessionClaim,
		semantic: UnifiedSongActionSemantic,
		zoneId: string
	): Promise<boolean>;
	reset(): void;
}

const ACTION_LABELS: Readonly<Record<UnifiedSongActionSemantic, string>> = {
	'play-now': 'Play Now',
	'add-next': 'Add Next',
	queue: 'Queue'
};

function keylessItem<T extends BrowseItem>(item: T): T {
	const descriptor = { ...item };
	delete descriptor.itemKey;
	return descriptor;
}

function keylessSource(source: UnifiedBrowseActionSource): UnifiedBrowseActionSource {
	return source.kind === 'search'
		? { kind: 'search', query: source.query.trim(), item: keylessItem(source.item) }
		: {
				kind: 'browse',
				snapshot: cloneSnapshot(source.snapshot),
				item: keylessItem(source.item),
				...(source.restoreCount ? { restoreCount: source.restoreCount } : {})
			};
}

async function resolveActionSource(
	transaction: ClassicBrowseApiTransaction,
	source: UnifiedBrowseActionSource,
	zoneId?: string
): Promise<BrowseItem & { itemKey: string }> {
	if (source.kind === 'browse') {
		const path = await resolvePath(transaction, source.snapshot, zoneId);
		const breadcrumb = browseBreadcrumbFor(source.item);
		if (!breadcrumb) throw new Error('Browse action target is invalid');
		const located = await findUniqueBreadcrumb(
			transaction,
			path.result,
			breadcrumb,
			source.snapshot.context.hierarchy,
			zoneId,
			source.restoreCount
		);
		if (!located.match?.itemKey) throw new Error(located.reason ?? 'Browse target changed');
		return located.match as BrowseItem & { itemKey: string };
	}

	const query = source.query.trim();
	if (!query) throw new Error('Search action target is missing its query');
	let page = await transaction.browse({
		hierarchy: 'search',
		input: query,
		...(zoneId ? { zoneId } : {}),
		popAll: true,
		pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX
	});
	let target = selectBrowseSearchItem(page.items, source.item);
	if (!target) {
		const category = findBrowseSearchCategoryRow(page.items, source.item);
		if (category?.itemKey) {
			page = await transaction.browse({
				hierarchy: 'search',
				itemKey: category.itemKey,
				...(zoneId ? { zoneId } : {}),
				pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX
			});
			target = selectBrowseSearchItem(
				await collectResultItems(transaction, page, 'search', zoneId),
				source.item
			);
		}
	}
	if (!target?.itemKey) throw new Error(`Search result is no longer available: ${source.item.title}`);
	return target as BrowseItem & { itemKey: string };
}

async function discoverActionRows(
	transaction: ClassicBrowseApiTransaction,
	target: BrowseItem & { itemKey: string },
	hierarchy: 'browse' | 'search',
	zoneId?: string
): Promise<BrowseItem[]> {
	if (target.hint === 'action' && target.isPlayable) return [target];
	let cursor = target;
	for (let depth = 0; depth < ACTION_MAX_DEPTH; depth += 1) {
		const page = await transaction.browse({
			hierarchy,
			itemKey: cursor.itemKey,
			...(zoneId ? { zoneId } : {}),
			pageSize: ACTION_MAX_ROWS + 1
		});
		const total = page.totalCount ?? page.count;
		if (
			page.offset !== 0 ||
			!Number.isSafeInteger(total) ||
			total < 0 ||
			total > ACTION_MAX_ROWS ||
			page.items.length !== total
		) {
			throw new Error('Roon returned an incomplete or oversized action list');
		}
		const actions = page.items.filter(
			(item) => item.hint === 'action' && item.isPlayable && item.itemKey
		);
		if (actions.length > 0) return actions;
		const nested = page.items.filter(
			(item): item is BrowseItem & { itemKey: string } =>
				item.hint === 'action_list' &&
				!item.isPlayable &&
				typeof item.itemKey === 'string' &&
				item.itemKey.length > 0
		);
		if (nested.length !== 1) return [];
		cursor = nested[0];
	}
	throw new Error('The action path exceeded its depth bound');
}

export function createUnifiedBrowseActionController(
	dependencies: UnifiedBrowseControllerDependencies = {}
): UnifiedBrowseActionController {
	const runTransaction = dependencies.transaction ?? withClassicBrowseRoleTransaction;
	const isClaimCurrent = dependencies.isClaimCurrent ?? ((claim) =>
		classicBrowseSessionClient.isClaimCurrent(claim));
	const emptyAvailability = (): Record<UnifiedSongActionSemantic, boolean> => ({
		'play-now': false,
		'add-next': false,
		queue: false
	});
	let fence = 0;
	let state: UnifiedBrowseActionState = {
		phase: 'idle',
		source: null,
		available: emptyAvailability(),
		error: null
	};
	const internal = writable(state);
	const publish = (next: UnifiedBrowseActionState) => {
		state = next;
		internal.set(next);
	};

	async function open(
		claim: ClassicBrowseSessionClaim,
		rawSource: UnifiedBrowseActionSource,
		zoneId?: string
	): Promise<boolean> {
		const source = keylessSource(rawSource);
		fence += 1;
		const token = fence;
		publish({ phase: 'loading', source, available: emptyAvailability(), error: null });
		if (!zoneId) {
			publish({ phase: 'ready', source, available: emptyAvailability(), error: null });
			return true;
		}
		try {
			const role: ClassicBrowseRole =
				source.kind === 'search' || source.snapshot.context.hierarchy === 'search'
					? 'classic-search'
					: 'classic-browse';
			const available = await runTransaction(role, claim, async (transaction) => {
				const target = await resolveActionSource(transaction, source, zoneId);
				const rows = await discoverActionRows(
					transaction,
					target,
					role === 'classic-search' ? 'search' : 'browse',
					zoneId
				);
				return Object.fromEntries(
					Object.entries(ACTION_LABELS).map(([semantic, label]) => [
						semantic,
						rows.filter((row) => row.title === label).length === 1
					])
				) as Record<UnifiedSongActionSemantic, boolean>;
			});
			if (token !== fence || !isClaimCurrent(claim)) return false;
			publish({ phase: 'ready', source, available, error: null });
			return true;
		} catch (error) {
			if (token !== fence) return false;
			publish({
				phase: error instanceof ClassicBrowseSupersededError ? 'idle' : 'error',
				source: error instanceof ClassicBrowseSupersededError ? null : source,
				available: emptyAvailability(),
				error:
					error instanceof ClassicBrowseSupersededError
						? null
						: error instanceof Error
							? error.message
							: 'Actions are unavailable'
			});
			return false;
		}
	}

	async function execute(
		claim: ClassicBrowseSessionClaim,
		semantic: UnifiedSongActionSemantic,
		zoneId: string
	): Promise<boolean> {
		const source = state.source;
		if (!source || state.phase !== 'ready' || !state.available[semantic]) return false;
		fence += 1;
		const token = fence;
		publish({ ...state, phase: 'executing', error: null });
		try {
			const role: ClassicBrowseRole =
				source.kind === 'search' || source.snapshot.context.hierarchy === 'search'
					? 'classic-search'
					: 'classic-browse';
			await runTransaction(role, claim, async (transaction) => {
				const target = await resolveActionSource(transaction, source, zoneId);
				const rows = await discoverActionRows(
					transaction,
					target,
					role === 'classic-search' ? 'search' : 'browse',
					zoneId
				);
				const matches = rows.filter(
					(row) => row.title === ACTION_LABELS[semantic] && row.itemKey && row.isPlayable
				);
				if (matches.length !== 1 || !matches[0].itemKey) {
					throw new Error(`${ACTION_LABELS[semantic]} is no longer available`);
				}
				await transaction.browse({
					hierarchy: role === 'classic-search' ? 'search' : 'browse',
					itemKey: matches[0].itemKey,
					zoneId
				});
			});
			if (token !== fence || !isClaimCurrent(claim)) return false;
			publish({ ...state, phase: 'success', error: null });
			return true;
		} catch (error) {
			if (token !== fence) return false;
			publish({
				...state,
				phase: error instanceof ClassicBrowseSupersededError ? 'idle' : 'error',
				error:
					error instanceof ClassicBrowseSupersededError
						? null
						: error instanceof Error
							? error.message
							: 'Action failed'
			});
			return false;
		}
	}

	function reset(): void {
		fence += 1;
		publish({
			phase: 'idle',
			source: null,
			available: emptyAvailability(),
			error: null
		});
	}

	return { subscribe: internal.subscribe, open, execute, reset };
}

export const unifiedBrowseActionController = createUnifiedBrowseActionController();
