import type { UnifiedLibraryDensity } from '$lib/stores/unifiedLibraryPrefsStore';

export type LibraryViewActivationCause =
	| 'initial'
	| 'route-request'
	| 'user-switch'
	| 'history-pop';

export interface BrowseBreadcrumb {
	title: string;
	subtitle?: string;
	imageKey?: string;
	itemType?: string;
	searchCategory?: true;
}

export type BrowseHistoryContext =
	| { hierarchy: 'browse' }
	| { hierarchy: 'search'; query: string };

export interface BrowseHistoryStep {
	hierarchy: 'browse' | 'search';
	breadcrumb: BrowseBreadcrumb;
	/** Number of rows visible when this semantic target was selected. */
	restoreCount?: number;
}

export interface BrowseHistorySnapshot {
	context: BrowseHistoryContext;
	history: BrowseHistoryStep[];
	forward: BrowseHistoryStep[];
}

export const UNIFIED_LIBRARY_PAGE_STATE_VERSION = 7 as const;
const LEGACY_UNIFIED_LIBRARY_ITEM_SPLIT_VERSION = 6 as const;
const LEGACY_UNIFIED_LIBRARY_DRILL_VERSION = 5 as const;
const LEGACY_UNIFIED_LIBRARY_PAGE_STATE_VERSION = 4 as const;
const LEGACY_UNIFIED_LIBRARY_PAGE_STATE_WITHOUT_BROWSE_VERSION = 3 as const;
export const UNIFIED_LOCAL_ID_MAX_LENGTH = 256;
export const UNIFIED_LABEL_MAX_LENGTH = 256;
export const UNIFIED_FILTER_TEXT_MAX_LENGTH = 256;
export const UNIFIED_BROWSE_RESTORE_COUNT_MAX = 100_000;
/** Mirrors the editorial contract's zero-based track-anchor bound. */
export const UNIFIED_TRACK_INDEX_MAX = 500;

export type UnifiedLibraryScope =
	| 'artists'
	| 'albums'
	| 'genres'
	| 'favorites'
	| 'recently-played'
	| 'most-played'
	| 'playlists'
	| 'recently-added'
	| 'surprise'
	| 'browse';

/**
 * Legacy (v5 and earlier) drill targets: one union carried both collection
 * contexts and item destinations. Kept only to normalize old history
 * entries forward; v6 splits collection drills from item targets.
 */
export type UnifiedLibraryDrillTarget =
	| { kind: 'artist'; localId: string }
	| { kind: 'album'; localId: string }
	| { kind: 'genre'; label: string }
	| { kind: 'composer'; label: string };

/**
 * Collection drills are album-list contexts, restored by their normalized
 * display label. Restoration re-navigates and matches, never stores
 * browse keys.
 */
export type UnifiedCollectionDrillTarget =
	| { kind: 'genre'; label: string }
	| { kind: 'composer'; label: string };

/**
 * Item targets are first-class entity pages, restored by catalog localId
 * (reconstructible product semantics only; opaque live-session targets are
 * never persisted here).
 */
export type UnifiedItemTarget =
	| { kind: 'album'; localId: string }
	| { kind: 'artist'; localId: string };

/**
 * A reconstructible child surface over an open item page (Slice 8): the
 * exact-track view is the album's zero-based track index — pure product
 * semantics. Opaque live-session destinations (followed performers,
 * similar albums) are deliberately NOT representable here: they restore
 * to the parent, which is the session-bound restoration rule.
 */
export type UnifiedItemDetailTarget = { kind: 'track'; trackIndex: number };

/**
 * The composition surface over a composer collection drill (Slice 8):
 * restored by the composer context plus an exact composition title; a
 * null title restores the composition list itself.
 */
export interface UnifiedCompositionSurface {
	title: string | null;
}

export interface UnifiedLibrarySnapshot {
	scope: UnifiedLibraryScope;
	/** Optional genre/composer album-list context. */
	collectionDrill: UnifiedCollectionDrillTarget | null;
	/**
	 * Optional item page over the scope/collection context. Both fields may
	 * be present: an album opened from a genre drill restores its parent
	 * context with it.
	 */
	itemTarget: UnifiedItemTarget | null;
	/** Optional child surface over an ALBUM item page (v7). */
	itemDetail: UnifiedItemDetailTarget | null;
	/** Optional composition surface over a COMPOSER collection drill (v7). */
	composition: UnifiedCompositionSurface | null;
	filterText: string;
	surpriseSeed: number | null;
	/** Null only for an untagged root; semantic entries capture the live density. */
	density: UnifiedLibraryDensity | null;
	/**
	 * Keyless deep-Browse/search path. Every restoration re-resolves this
	 * semantic path against the live browse-session generation.
	 */
	browseHistory: BrowseHistorySnapshot;
}

export interface UnifiedLibraryPageState {
	libraryView: 'unified';
	schemaVersion: typeof UNIFIED_LIBRARY_PAGE_STATE_VERSION;
	snapshot: UnifiedLibrarySnapshot;
}

export type LibraryPageState = UnifiedLibraryPageState;

/** SvelteKit requires App.PageState to remain an augmentable interface. */
export interface LibraryPageStateEnvelope {
	library?: LibraryPageState;
}

const BREADCRUMB_KEYS = ['title', 'subtitle', 'imageKey', 'itemType', 'searchCategory'] as const;
const HISTORY_STEP_KEYS = ['hierarchy', 'breadcrumb', 'restoreCount'] as const;
const BROWSE_SNAPSHOT_KEYS = ['context', 'history', 'forward'] as const;
const LIBRARY_STATE_KEYS = ['libraryView', 'schemaVersion', 'snapshot'] as const;
const UNIFIED_SNAPSHOT_KEYS = [
	'scope',
	'collectionDrill',
	'itemTarget',
	'itemDetail',
	'composition',
	'filterText',
	'surpriseSeed',
	'density',
	'browseHistory'
] as const;
/** v6 predates the item-detail and composition surfaces. */
const LEGACY_V6_UNIFIED_SNAPSHOT_KEYS = UNIFIED_SNAPSHOT_KEYS.filter(
	(key) => key !== 'itemDetail' && key !== 'composition'
);
const LEGACY_UNIFIED_SNAPSHOT_KEYS = [
	'scope',
	'drill',
	'filterText',
	'openAlbumLocalId',
	'surpriseSeed',
	'density',
	'browseHistory'
] as const;
const LEGACY_UNIFIED_SNAPSHOT_WITHOUT_BROWSE_KEYS = LEGACY_UNIFIED_SNAPSHOT_KEYS.filter(
	(key) => key !== 'browseHistory'
);
const UNIFIED_SCOPES: readonly UnifiedLibraryScope[] = [
	'artists',
	'albums',
	'genres',
	'favorites',
	'recently-played',
	'most-played',
	'playlists',
	'recently-added',
	'surprise',
	'browse'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = Reflect.ownKeys(record);
	return (
		keys.length === allowed.length &&
		keys.every((key) => typeof key === 'string' && allowed.includes(key))
	);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Reflect.ownKeys(record).every(
		(key) => typeof key === 'string' && allowed.includes(key)
	);
}

function isNonEmptyString(value: unknown, maxLength = Number.POSITIVE_INFINITY): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function normalizeBreadcrumb(value: unknown): BrowseBreadcrumb | null {
	if (!isRecord(value) || !hasOnlyKeys(value, BREADCRUMB_KEYS)) return null;
	if (!isNonEmptyString(value.title)) return null;

	const breadcrumb: BrowseBreadcrumb = { title: value.title };
	for (const key of ['subtitle', 'imageKey', 'itemType'] as const) {
		const field = value[key];
		if (field === undefined) continue;
		if (!isNonEmptyString(field)) return null;
		breadcrumb[key] = field;
	}
	if (value.searchCategory !== undefined) {
		if (value.searchCategory !== true) return null;
		breadcrumb.searchCategory = true;
	}
	return breadcrumb;
}

function normalizeHistoryStep(value: unknown): BrowseHistoryStep | null {
	if (!isRecord(value) || !hasOnlyKeys(value, HISTORY_STEP_KEYS)) return null;
	if (value.hierarchy !== 'browse' && value.hierarchy !== 'search') return null;
	const breadcrumb = normalizeBreadcrumb(value.breadcrumb);
	if (!breadcrumb) return null;
	if (
		value.restoreCount !== undefined &&
		(!Number.isSafeInteger(value.restoreCount) ||
			(value.restoreCount as number) < 1 ||
			(value.restoreCount as number) > UNIFIED_BROWSE_RESTORE_COUNT_MAX)
	) {
		return null;
	}
	return {
		hierarchy: value.hierarchy,
		breadcrumb,
		...(value.restoreCount !== undefined
			? { restoreCount: value.restoreCount as number }
			: {})
	};
}

function normalizeHistoryStack(value: unknown): BrowseHistoryStep[] | null {
	if (!Array.isArray(value)) return null;
	const stack: BrowseHistoryStep[] = [];
	for (const rawStep of value) {
		const step = normalizeHistoryStep(rawStep);
		if (!step) return null;
		stack.push(step);
	}
	return stack;
}

function normalizeHistoryContext(value: unknown): BrowseHistoryContext | null {
	if (!isRecord(value)) return null;
	if (value.hierarchy === 'browse') {
		return hasExactKeys(value, ['hierarchy']) ? { hierarchy: 'browse' } : null;
	}
	if (value.hierarchy === 'search') {
		return hasExactKeys(value, ['hierarchy', 'query']) && isNonEmptyString(value.query)
			? { hierarchy: 'search', query: value.query }
			: null;
	}
	return null;
}

export function normalizeBrowseHistorySnapshot(value: unknown): BrowseHistorySnapshot | null {
	try {
		if (!isRecord(value) || !hasExactKeys(value, BROWSE_SNAPSHOT_KEYS)) return null;
		const context = normalizeHistoryContext(value.context);
		const history = normalizeHistoryStack(value.history);
		const forward = normalizeHistoryStack(value.forward);
		if (!context || !history || !forward) return null;
		if (
			history.some((step) => step.hierarchy !== context.hierarchy) ||
			forward.some((step) => step.hierarchy !== context.hierarchy)
		) {
			return null;
		}
		return { context, history, forward };
	} catch {
		return null;
	}
}

function isUnifiedScope(value: unknown): value is UnifiedLibraryScope {
	return (
		typeof value === 'string' && (UNIFIED_SCOPES as readonly string[]).includes(value)
	);
}

function isUnifiedDensity(value: unknown): value is UnifiedLibraryDensity {
	return value === 'compact' || value === 'normal' || value === 'pi';
}

function normalizeUnifiedDrillTarget(value: unknown): UnifiedLibraryDrillTarget | null {
	if (!isRecord(value)) return null;
	if (value.kind === 'artist' || value.kind === 'album') {
		return hasExactKeys(value, ['kind', 'localId']) &&
			isNonEmptyString(value.localId, UNIFIED_LOCAL_ID_MAX_LENGTH)
			? { kind: value.kind, localId: value.localId }
			: null;
	}
	if (value.kind === 'genre' || value.kind === 'composer') {
		return hasExactKeys(value, ['kind', 'label']) &&
			isNonEmptyString(value.label, UNIFIED_LABEL_MAX_LENGTH)
			? { kind: value.kind, label: value.label }
			: null;
	}
	return null;
}

function emptyBrowseHistory(): BrowseHistorySnapshot {
	return { context: { hierarchy: 'browse' }, history: [], forward: [] };
}

function normalizeCollectionDrillTarget(
	value: unknown
): UnifiedCollectionDrillTarget | null {
	if (!isRecord(value)) return null;
	if (value.kind === 'genre' || value.kind === 'composer') {
		return hasExactKeys(value, ['kind', 'label']) &&
			isNonEmptyString(value.label, UNIFIED_LABEL_MAX_LENGTH)
			? { kind: value.kind, label: value.label }
			: null;
	}
	return null;
}

function normalizeItemTarget(value: unknown): UnifiedItemTarget | null {
	if (!isRecord(value)) return null;
	if (value.kind === 'album' || value.kind === 'artist') {
		return hasExactKeys(value, ['kind', 'localId']) &&
			isNonEmptyString(value.localId, UNIFIED_LOCAL_ID_MAX_LENGTH)
			? { kind: value.kind, localId: value.localId }
			: null;
	}
	return null;
}

function normalizeItemDetail(value: unknown): UnifiedItemDetailTarget | null {
	if (!isRecord(value)) return null;
	if (value.kind !== 'track') return null;
	return hasExactKeys(value, ['kind', 'trackIndex']) &&
		Number.isSafeInteger(value.trackIndex) &&
		(value.trackIndex as number) >= 0 &&
		(value.trackIndex as number) < UNIFIED_TRACK_INDEX_MAX
		? { kind: 'track', trackIndex: value.trackIndex as number }
		: null;
}

function normalizeCompositionSurface(
	value: unknown
): UnifiedCompositionSurface | null {
	if (!isRecord(value) || !hasExactKeys(value, ['title'])) return null;
	if (value.title === null) return { title: null };
	return isNonEmptyString(value.title, UNIFIED_LABEL_MAX_LENGTH)
		? { title: value.title }
		: null;
}

function normalizeSharedSnapshotFields(value: Record<string, unknown>): {
	filterText: string;
	surpriseSeed: number | null;
	density: UnifiedLibraryDensity | null;
} | null {
	if (
		typeof value.filterText !== 'string' ||
		value.filterText.length > UNIFIED_FILTER_TEXT_MAX_LENGTH
	) {
		return null;
	}
	if (
		value.surpriseSeed !== null &&
		(typeof value.surpriseSeed !== 'number' ||
			!Number.isSafeInteger(value.surpriseSeed) ||
			value.surpriseSeed < 0)
	) {
		return null;
	}
	if (value.density !== null && !isUnifiedDensity(value.density)) return null;
	return {
		filterText: value.filterText,
		surpriseSeed: value.surpriseSeed as number | null,
		density: value.density as UnifiedLibraryDensity | null
	};
}

function normalizeUnifiedSnapshot(
	value: unknown,
	legacyV6 = false
): UnifiedLibrarySnapshot | null {
	const keys = legacyV6 ? LEGACY_V6_UNIFIED_SNAPSHOT_KEYS : UNIFIED_SNAPSHOT_KEYS;
	if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
	if (!isUnifiedScope(value.scope)) return null;
	const collectionDrill =
		value.collectionDrill === null
			? null
			: normalizeCollectionDrillTarget(value.collectionDrill);
	if (value.collectionDrill !== null && !collectionDrill) return null;
	const itemTarget =
		value.itemTarget === null ? null : normalizeItemTarget(value.itemTarget);
	if (value.itemTarget !== null && !itemTarget) return null;
	let itemDetail: UnifiedItemDetailTarget | null = null;
	let composition: UnifiedCompositionSurface | null = null;
	if (!legacyV6) {
		itemDetail =
			value.itemDetail === null ? null : normalizeItemDetail(value.itemDetail);
		if (value.itemDetail !== null && !itemDetail) return null;
		// A child surface without its exact parent context is not
		// reconstructible: reject rather than restore something else.
		if (itemDetail !== null && itemTarget?.kind !== 'album') return null;
		composition =
			value.composition === null
				? null
				: normalizeCompositionSurface(value.composition);
		if (value.composition !== null && !composition) return null;
		if (composition !== null && collectionDrill?.kind !== 'composer') return null;
	}
	const shared = normalizeSharedSnapshotFields(value);
	if (!shared) return null;
	const browseHistory = normalizeBrowseHistorySnapshot(value.browseHistory);
	if (!browseHistory) return null;
	return {
		scope: value.scope,
		collectionDrill,
		itemTarget,
		itemDetail,
		composition,
		...shared,
		browseHistory
	};
}

/**
 * v5-and-earlier snapshots carried one `drill` union plus a redundant
 * `openAlbumLocalId`. They normalize forward: artist/album drills become
 * item targets, genre/composer drills become collection drills, and a
 * dangling `openAlbumLocalId` without an album drill still restores its
 * album page.
 */
function normalizeLegacyUnifiedSnapshot(
	value: unknown,
	withoutBrowse = false
): UnifiedLibrarySnapshot | null {
	const expectedKeys = withoutBrowse
		? LEGACY_UNIFIED_SNAPSHOT_WITHOUT_BROWSE_KEYS
		: LEGACY_UNIFIED_SNAPSHOT_KEYS;
	if (!isRecord(value) || !hasExactKeys(value, expectedKeys)) return null;
	if (!isUnifiedScope(value.scope)) return null;
	const drill = value.drill === null ? null : normalizeUnifiedDrillTarget(value.drill);
	if (value.drill !== null && !drill) return null;
	if (
		value.openAlbumLocalId !== null &&
		!isNonEmptyString(value.openAlbumLocalId, UNIFIED_LOCAL_ID_MAX_LENGTH)
	) {
		return null;
	}
	const shared = normalizeSharedSnapshotFields(value);
	if (!shared) return null;
	const browseHistory = withoutBrowse
		? emptyBrowseHistory()
		: normalizeBrowseHistorySnapshot(value.browseHistory);
	if (!browseHistory) return null;

	let collectionDrill: UnifiedCollectionDrillTarget | null = null;
	let itemTarget: UnifiedItemTarget | null = null;
	if (drill) {
		if (drill.kind === 'artist' || drill.kind === 'album') {
			itemTarget = { kind: drill.kind, localId: drill.localId };
		} else {
			collectionDrill = { kind: drill.kind, label: drill.label };
		}
	}
	if (itemTarget === null && value.openAlbumLocalId !== null) {
		itemTarget = { kind: 'album', localId: value.openAlbumLocalId as string };
	}
	return {
		scope: value.scope,
		collectionDrill,
		itemTarget,
		itemDetail: null,
		composition: null,
		...shared,
		browseHistory
	};
}

export function normalizeLibraryPageState(value: unknown): LibraryPageState | null {
	try {
		if (!isRecord(value) || !hasExactKeys(value, LIBRARY_STATE_KEYS)) return null;
		if (
			value.libraryView === 'unified' &&
			value.schemaVersion === UNIFIED_LIBRARY_PAGE_STATE_VERSION
		) {
			const snapshot = normalizeUnifiedSnapshot(value.snapshot);
			return snapshot
				? {
						libraryView: 'unified',
						schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
						snapshot
					}
				: null;
		}
		if (
			value.libraryView === 'unified' &&
			value.schemaVersion === LEGACY_UNIFIED_LIBRARY_ITEM_SPLIT_VERSION
		) {
			const snapshot = normalizeUnifiedSnapshot(value.snapshot, true);
			return snapshot
				? {
						libraryView: 'unified',
						schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
						snapshot
					}
				: null;
		}
		if (
			value.libraryView === 'unified' &&
			(value.schemaVersion === LEGACY_UNIFIED_LIBRARY_DRILL_VERSION ||
				value.schemaVersion === LEGACY_UNIFIED_LIBRARY_PAGE_STATE_VERSION)
		) {
			const snapshot = normalizeLegacyUnifiedSnapshot(value.snapshot);
			return snapshot
				? {
						libraryView: 'unified',
						schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
						snapshot
					}
				: null;
		}
		if (
			value.libraryView === 'unified' &&
			value.schemaVersion === LEGACY_UNIFIED_LIBRARY_PAGE_STATE_WITHOUT_BROWSE_VERSION
		) {
			const snapshot = normalizeLegacyUnifiedSnapshot(value.snapshot, true);
			return snapshot
				? {
						libraryView: 'unified',
						schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
						snapshot
					}
				: null;
		}
		return null;
	} catch {
		return null;
	}
}

export function normalizeLibraryPageStateEnvelope(value: unknown): LibraryPageState | null {
	try {
		if (!isRecord(value) || !hasExactKeys(value, ['library'])) return null;
		return normalizeLibraryPageState(value.library);
	} catch {
		return null;
	}
}

function requireLibraryPageState(value: unknown): LibraryPageState {
	const normalized = normalizeLibraryPageState(value);
	if (!normalized) throw new TypeError('Invalid Library page state');
	return normalized;
}

export function buildUnifiedLibraryPageState(
	snapshot: Omit<
		UnifiedLibrarySnapshot,
		'density' | 'browseHistory' | 'itemDetail' | 'composition'
	> & {
		readonly density?: UnifiedLibraryDensity | null;
		readonly browseHistory?: BrowseHistorySnapshot;
		readonly itemDetail?: UnifiedItemDetailTarget | null;
		readonly composition?: UnifiedCompositionSurface | null;
	}
): UnifiedLibraryPageState {
	return requireLibraryPageState({
		libraryView: 'unified',
		schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
		snapshot: {
			density: null,
			browseHistory: emptyBrowseHistory(),
			itemDetail: null,
			composition: null,
			...snapshot
		}
	}) as UnifiedLibraryPageState;
}

export function buildUnifiedRootPageState(
	scope: UnifiedLibraryScope = 'artists'
): UnifiedLibraryPageState {
	return buildUnifiedLibraryPageState({
		scope,
		collectionDrill: null,
		itemTarget: null,
		filterText: '',
		surpriseSeed: null,
		density: null,
		browseHistory: emptyBrowseHistory()
	});
}

export function buildLibraryPageStateEnvelope<State extends LibraryPageState>(
	state: State
): { library: State } {
	return { library: requireLibraryPageState(state) as State };
}
