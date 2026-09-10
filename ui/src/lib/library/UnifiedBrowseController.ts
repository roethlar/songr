import { writable, type Readable } from 'svelte/store';
import { collectLibraryCollectionLevel, loadCompleteLibraryCollection } from './LibraryDestinations';

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
		zoneId?: string,
		options?: { complete?: boolean }
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

/** Validate and drain one current public list; no action or prompt is entered. */
async function collectResultItems(
	transaction: ClassicBrowseApiTransaction,
	result: BrowseResult,
	hierarchy: 'browse' | 'search',
	zoneId?: string
): Promise<BrowseItem[]> {
	const snapshot: BrowseHistorySnapshot = hierarchy === 'search'
		? { context: { hierarchy: 'search', query: '' }, history: [], forward: [] }
		: emptyBrowseSnapshot();
	const model = await collectLibraryCollectionLevel(transaction, result, snapshot, { zoneId });
	if (!model.complete) throw new Error(model.diagnostic?.message ?? 'The complete list could not be loaded.');
	return model.items;
}

async function completeResolution(
	transaction: ClassicBrowseApiTransaction,
	resolved: PathResolution,
	zoneId?: string
): Promise<PathResolution> {
	const result = resolved.result;
	if (result.action === 'message' || result.message !== undefined || result.isError || result.listHint === 'action_list'
		|| (result.action !== undefined && result.action !== 'list')) return resolved;
	const items = await collectResultItems(transaction, result, resolved.snapshot.context.hierarchy, zoneId);
	return { ...resolved, result: { ...result, offset: 0, items } };
}

async function findUniqueBreadcrumb(
	transaction: ClassicBrowseApiTransaction,
	result: BrowseResult,
	breadcrumb: BrowseBreadcrumb,
	hierarchy: 'browse' | 'search',
	zoneId?: string
): Promise<{ match?: BrowseItem; reason?: string }> {
	const items = await collectResultItems(
		transaction,
		result,
		hierarchy,
		zoneId
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
			zoneId
		);
		if (!located.match?.itemKey || located.match.inputPrompt || browseItemOpensActions(located.match)) {
			return {
				result,
				snapshot: { context: normalized.context, history: resolved, forward: [] },
				notice: `Restore stopped: ${located.reason ?? 'this row requires an explicit action'}.`
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
	const isClaimCurrent =
		dependencies.isClaimCurrent ?? ((claim) => classicBrowseSessionClient.isClaimCurrent(claim));
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
		zoneId?: string,
		options?: { complete?: boolean }
	): Promise<boolean> {
		const target = cloneSnapshot(snapshot);
		requestFence += 1;
		const token = requestFence;
		const previousSnapshot = state.snapshot;
		let admitted = false;
		try {
			const resolved = await runTransaction(roleFor(target), claim, async (transaction) => {
				if (token !== requestFence || !isClaimCurrent(claim)) throw new ClassicBrowseSupersededError();
				publish({ phase: 'loading', result: null, snapshot: previousSnapshot, notice: null, error: null });
				const assertCurrent = (): void => {
					if (token !== requestFence || !isClaimCurrent(claim)) throw new ClassicBrowseSupersededError();
				};
				const readTransaction: ClassicBrowseApiTransaction = { ...transaction,
					browse: async request => {
						assertCurrent();
						const result = await transaction.browse(request);
						assertCurrent();
						if (!admitted) {
							admitted = true;
							publish({ phase: 'loading', result: null, snapshot: target, notice: null, error: null });
						}
						return result;
					},
					browseLoad: async request => {
						assertCurrent();
						const result = await transaction.browseLoad(request);
						assertCurrent();
						return result;
					}
				};
				if (!options?.complete || target.context.hierarchy === 'search') return completeResolution(readTransaction, await resolvePath(readTransaction, target, zoneId), zoneId);
				const model = await loadCompleteLibraryCollection(readTransaction, target, { zoneId });
				if (!model.complete && !(model.result.action === 'message' || model.result.message !== undefined || model.result.isError === true)) {
					throw new Error(model.diagnostic?.message ?? 'The complete collection could not be loaded.');
				}
				return { result: model.result, snapshot: target, notice: null };
			});
			if (token !== requestFence || !isClaimCurrent(claim)) return false;
			publish({ phase: 'ready', error: null, ...resolved });
			return true;
		} catch (error) {
			if (token !== requestFence) return false;
			if (error instanceof ClassicBrowseSupersededError) {
				publish({
					phase: 'idle',
					result: null,
					snapshot: admitted ? target : previousSnapshot,
					notice: null,
					error: null
				});
				return false;
			}
			publish({
				phase: 'error',
				result: null,
				snapshot: admitted ? target : previousSnapshot,
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
	/**
	 * The zone `available` was probed under, so a caller can tell whether the
	 * answer on screen still describes the zone the buttons would act on.
	 * `null` while idle, and when the sheet opened with no zone at all.
	 */
	readonly zoneId: string | null;
	readonly available: Readonly<Record<UnifiedSongActionSemantic, boolean>>;
	/** Keyless choices from the current result; pass these exact objects back to the controller. */
	readonly actions?: readonly BrowseItem[];
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
	executeItem(
		claim: ClassicBrowseSessionClaim,
		item: BrowseItem,
		zoneId: string
	): Promise<boolean>;
	openActionList(
		claim: ClassicBrowseSessionClaim,
		item: BrowseItem,
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

async function resolveSearchActionSource(
	transaction: ClassicBrowseApiTransaction,
	source: Extract<UnifiedBrowseActionSource, { kind: 'search' }>,
	zoneId?: string
): Promise<BrowseItem & { itemKey: string }> {
	const query = source.query.trim();
	if (!query) throw new Error('Search action target is missing its query');
	let page = await transaction.browse({
		hierarchy: 'search',
		input: query,
		...(zoneId ? { zoneId } : {}),
		popAll: true,
		pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX
	});
	const rootItems = await collectResultItems(transaction, page, 'search', zoneId);
	let target = selectBrowseSearchItem(rootItems, source.item);
	if (!target) {
		const category = findBrowseSearchCategoryRow(rootItems, source.item);
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

type ExactBrowseActionItem = BrowseItem & { itemKey: string };

function isActionLeaf(item: BrowseItem): item is ExactBrowseActionItem {
	return item.hint === 'action' && item.isPlayable &&
		typeof item.itemKey === 'string' && item.itemKey.length > 0;
}

function isNestedActionList(item: BrowseItem): item is ExactBrowseActionItem {
	return item.hint === 'action_list' && !item.isPlayable &&
		typeof item.itemKey === 'string' && item.itemKey.length > 0;
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
		const choices = page.items.filter((item) => isActionLeaf(item) || isNestedActionList(item));
		const nested = choices.filter(isNestedActionList);
		// A single navigation-only link keeps the established bounded discovery
		// path. Multiple or mixed choices require an explicit selection in the UI.
		if (choices.some(isActionLeaf) || nested.length !== 1) return choices;
		cursor = nested[0];
	}
	throw new Error('The action path exceeded its depth bound');
}

export function createUnifiedBrowseActionController(
	dependencies: UnifiedBrowseControllerDependencies = {}
): UnifiedBrowseActionController {
	const runTransaction = dependencies.transaction ?? withClassicBrowseRoleTransaction;
	const isClaimCurrent =
		dependencies.isClaimCurrent ?? ((claim) => classicBrowseSessionClient.isClaimCurrent(claim));
	const emptyAvailability = (): Record<UnifiedSongActionSemantic, boolean> => ({
		'play-now': false,
		'add-next': false,
		queue: false
	});
	type ExactItem = ExactBrowseActionItem;
	type BrowseSource = Extract<UnifiedBrowseActionSource, { kind: 'browse' }>;
	type ActionRows = Partial<Record<UnifiedSongActionSemantic, ExactItem>>;
	let fence = 0;
	let actionClaim: ClassicBrowseSessionClaim | null = null;
	// These server-issued opaque capabilities belong only to this open sheet.
	// Published source/URL state stays keyless. Backend session/role/publication
	// validation rejects retired capabilities; display text is never a fallback.
	let exactSelection: {
		source: BrowseSource;
		claim: ClassicBrowseSessionClaim;
		item: ExactItem;
	} | null = null;
	let advertisedActions: {
		source: UnifiedBrowseActionSource;
		claim: ClassicBrowseSessionClaim;
		zoneId: string;
		rows: ActionRows;
		choices: ReadonlyMap<BrowseItem, ExactItem>;
		semanticSearchReplay: boolean;
	} | null = null;
	let state: UnifiedBrowseActionState = {
		phase: 'idle',
		source: null,
		zoneId: null,
		available: emptyAvailability(),
		actions: [],
		error: null
	};
	const internal = writable(state);
	const publish = (next: UnifiedBrowseActionState) => {
		state = next;
		internal.set(next);
	};

	function clearAuthority(): void {
		exactSelection = null;
		advertisedActions = null;
		actionClaim = null;
	}

	function fencedTransaction(
		transaction: ClassicBrowseApiTransaction,
		claim: ClassicBrowseSessionClaim,
		source: UnifiedBrowseActionSource,
		token: number
	): ClassicBrowseApiTransaction {
		const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
			if (
				token !== fence ||
				actionClaim !== claim ||
				state.source !== source ||
				!isClaimCurrent(claim)
			) {
				throw new ClassicBrowseSupersededError();
			}
			const result = await work();
			if (
				token !== fence ||
				actionClaim !== claim ||
				state.source !== source ||
				!isClaimCurrent(claim)
			) {
				throw new ClassicBrowseSupersededError();
			}
			return result;
		};
		return {
			...transaction,
			browse: (options) => guarded(() => transaction.browse(options)),
			browseLoad: (options) => guarded(() => transaction.browseLoad(options))
		};
	}

	function actionRows(rows: readonly BrowseItem[]): ActionRows {
		const result: ActionRows = {};
		for (const [semantic, label] of Object.entries(ACTION_LABELS)) {
			const matches = rows.filter((row) => row.title === label && isActionLeaf(row));
			if (matches.length === 1) {
				result[semantic as UnifiedSongActionSemantic] = { ...matches[0] } as ExactItem;
			}
		}
		return result;
	}

	function currentActions(claim: ClassicBrowseSessionClaim, zoneId: string) {
		const retained = advertisedActions;
		return retained && state.phase === 'ready' && state.source === retained.source &&
			state.zoneId === zoneId && retained.zoneId === zoneId &&
			actionClaim === claim && retained.claim === claim && isClaimCurrent(claim)
			? retained : null;
	}

	function publishActions(
		claim: ClassicBrowseSessionClaim,
		source: UnifiedBrowseActionSource,
		zoneId: string,
		items: readonly BrowseItem[],
		semanticSearchReplay = true
	): void {
		const choices = new Map<BrowseItem, ExactItem>();
		for (const item of items) {
			if (!isActionLeaf(item) && !isNestedActionList(item)) continue;
			choices.set(Object.freeze(keylessItem(item)), Object.freeze({ ...item }));
		}
		const rows = actionRows([...choices.values()]);
		advertisedActions = { source, claim, zoneId, rows, choices, semanticSearchReplay };
		const available = Object.fromEntries(
			Object.keys(ACTION_LABELS).map((semantic) => [
				semantic, rows[semantic as UnifiedSongActionSemantic] !== undefined
			])
		) as Record<UnifiedSongActionSemantic, boolean>;
		publish({ phase: 'ready', source, zoneId, available,
			actions: Object.freeze([...choices.keys()]), error: null });
	}

	async function open(
		claim: ClassicBrowseSessionClaim,
		rawSource: UnifiedBrowseActionSource,
		zoneId?: string
	): Promise<boolean> {
		if (!isClaimCurrent(claim)) return false;
		const selected =
			rawSource.kind === 'browse'
				? rawSource === exactSelection?.source && exactSelection.claim === claim
					? exactSelection.item
					: rawSource.item.itemKey
						? ({ ...rawSource.item } as ExactItem)
						: null
				: null;
		const source = keylessSource(rawSource);
		fence += 1;
		const token = fence;
		clearAuthority();
		actionClaim = claim;
		if (source.kind === 'browse' && selected) {
			exactSelection = { source, claim, item: selected };
		}
		const probedZoneId = zoneId ?? null;
		publish({
			phase: 'loading',
			source,
			zoneId: probedZoneId,
			available: emptyAvailability(),
			actions: [],
			error: null
		});
		if (source.kind === 'browse' && !selected) {
			publish({
				...state,
				phase: 'error',
				error: 'Select this item again to load its current actions.'
			});
			return false;
		}
		if (!zoneId) {
			publish({ ...state, phase: 'ready' });
			return true;
		}
		try {
			const role: ClassicBrowseRole =
				source.kind === 'search' || source.snapshot.context.hierarchy === 'search'
					? 'classic-search'
					: 'classic-browse';
			const rows = await runTransaction(role, claim, async (transaction) => {
				const current = fencedTransaction(transaction, claim, source, token);
				const target =
					source.kind === 'browse'
						? selected!
						: await resolveSearchActionSource(current, source, zoneId);
				return discoverActionRows(
					current, target, role === 'classic-search' ? 'search' : 'browse', zoneId
				);
			});
			if (token !== fence || actionClaim !== claim || !isClaimCurrent(claim)) return false;
			publishActions(claim, source, zoneId, rows);
			return true;
		} catch (error) {
			if (token !== fence) return false;
			clearAuthority();
			publish({
				phase: error instanceof ClassicBrowseSupersededError ? 'idle' : 'error',
				source: error instanceof ClassicBrowseSupersededError ? null : source,
				zoneId: error instanceof ClassicBrowseSupersededError ? null : probedZoneId,
				available: emptyAvailability(),
				actions: [],
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

	async function openActionList(
		claim: ClassicBrowseSessionClaim,
		item: BrowseItem,
		zoneId: string
	): Promise<boolean> {
		const retained = currentActions(claim, zoneId);
		const target = retained?.choices.get(item);
		if (!retained || !target || !isNestedActionList(target)) return false;
		const source = retained.source;
		fence += 1;
		const token = fence;
		publish({ ...state, phase: 'loading', available: emptyAvailability(), actions: [], error: null });
		try {
			const role: ClassicBrowseRole = source.kind === 'search' || source.snapshot.context.hierarchy === 'search'
				? 'classic-search' : 'classic-browse';
			const choices = await runTransaction(role, claim, (transaction) => discoverActionRows(
				fencedTransaction(transaction, claim, source, token), target,
				role === 'classic-search' ? 'search' : 'browse', zoneId
			));
			if (token !== fence || actionClaim !== claim || !isClaimCurrent(claim)) return false;
			publishActions(claim, source, zoneId, choices, false);
			return true;
		} catch (error) {
			if (token !== fence) return false;
			clearAuthority();
			publish({ ...state,
				phase: error instanceof ClassicBrowseSupersededError ? 'idle' : 'error',
				available: emptyAvailability(), actions: [],
				error: error instanceof ClassicBrowseSupersededError ? null
					: error instanceof Error ? error.message : 'Actions are unavailable' });
			return false;
		}
	}

	async function execute(
		claim: ClassicBrowseSessionClaim,
		semantic: UnifiedSongActionSemantic,
		zoneId: string
	): Promise<boolean> {
		const retained = currentActions(claim, zoneId);
		const exactAction = retained?.rows[semantic];
		if (!retained || !state.available[semantic] || !exactAction) return false;
		const source = retained.source;
		return executeAction(claim, source, zoneId, async (current) => {
			if (source.kind !== 'search' || !retained.semanticSearchReplay) return exactAction;
			// Preserve the established semantic search path. Explicit choice
			// execution and explicitly selected nested lists retain their exact
			// capability; replaying the parent would lose that explicit choice.
			const target = await resolveSearchActionSource(current, source, zoneId);
			const action = actionRows(await discoverActionRows(current, target, 'search', zoneId))[semantic];
			if (!action) throw new Error(`${ACTION_LABELS[semantic]} is no longer available`);
			return action;
		});
	}

	async function executeItem(
		claim: ClassicBrowseSessionClaim,
		item: BrowseItem,
		zoneId: string
	): Promise<boolean> {
		const retained = currentActions(claim, zoneId);
		const action = retained?.choices.get(item);
		if (!retained || !action || !isActionLeaf(action)) return false;
		return executeAction(claim, retained.source, zoneId, async () => action);
	}

	async function executeAction(
		claim: ClassicBrowseSessionClaim,
		source: UnifiedBrowseActionSource,
		zoneId: string,
		resolveAction: (transaction: ClassicBrowseApiTransaction) => Promise<ExactItem>
	): Promise<boolean> {
		fence += 1;
		const token = fence;
		publish({ ...state, phase: 'executing', error: null });
		try {
			const role: ClassicBrowseRole =
				source.kind === 'search' || source.snapshot.context.hierarchy === 'search'
					? 'classic-search'
					: 'classic-browse';
			await runTransaction(role, claim, async (transaction) => {
				const current = fencedTransaction(transaction, claim, source, token);
				const action = await resolveAction(current);
				await current.browse({
					hierarchy: role === 'classic-search' ? 'search' : 'browse',
					itemKey: action.itemKey,
					zoneId
				});
			});
			if (token !== fence || actionClaim !== claim || !isClaimCurrent(claim)) return false;
			clearAuthority();
			publish({
				...state,
				phase: 'success',
				available: emptyAvailability(),
				actions: [],
				error: null
			});
			return true;
		} catch (error) {
			if (token !== fence) return false;
			clearAuthority();
			publish({
				...state,
				phase: error instanceof ClassicBrowseSupersededError ? 'idle' : 'error',
				available: emptyAvailability(),
				actions: [],
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
		clearAuthority();
		publish({
			phase: 'idle',
			source: null,
			zoneId: null,
			available: emptyAvailability(),
			actions: [],
			error: null
		});
	}

	return { subscribe: internal.subscribe, open, execute, executeItem, openActionList, reset };
}

export const unifiedBrowseActionController = createUnifiedBrowseActionController();
