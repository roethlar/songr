import type { UnifiedLibraryDensity } from '$lib/stores/unifiedLibraryPrefsStore';
import { LIBRARY_DISPLAY_TEXT_MAX_LENGTH } from '@shared/libraryText';
import {
	normalizeCollectionDrillOpenLocator,
	type CollectionDrillOpenLocator
} from '@shared/collectionDrillContracts';
import { LIBRARY_NODE_KINDS, type LibraryNodeKind } from '@shared/libraryOpenContracts';
import type { LibraryPathStep, LibraryRenderingPath } from '$lib/library/liveLibraryPath';
import {
	albumCreditMatches, normalizeAlbumCreditSelector,
	type AlbumCreditSelector, type ArtistView
} from '$lib/albumArtistGroups';

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

export const UNIFIED_LIBRARY_PAGE_STATE_VERSION = 11 as const;

const LEGACY_UNIFIED_LIBRARY_ARTIST_VIEW_VERSION = 10 as const;
const LEGACY_UNIFIED_LIBRARY_LIVE_TARGET_VERSION = 9 as const;
/** v8 predates the collection-opened album item target (Slice 8d). */
const LEGACY_UNIFIED_LIBRARY_COLLECTION_TARGET_VERSION = 8 as const;
/** v7 predates the item origin name (issue #6). */
const LEGACY_UNIFIED_LIBRARY_ITEM_ORIGIN_VERSION = 7 as const;
const LEGACY_UNIFIED_LIBRARY_ITEM_SPLIT_VERSION = 6 as const;
const LEGACY_UNIFIED_LIBRARY_DRILL_VERSION = 5 as const;
const LEGACY_UNIFIED_LIBRARY_PAGE_STATE_VERSION = 4 as const;
const LEGACY_UNIFIED_LIBRARY_PAGE_STATE_WITHOUT_BROWSE_VERSION = 3 as const;
export const UNIFIED_LOCAL_ID_MAX_LENGTH = 256;
export const UNIFIED_LABEL_MAX_LENGTH = 256;
export const UNIFIED_FILTER_TEXT_MAX_LENGTH = 256;
// The origin name is a raw catalog display name; accept exactly the catalog's
// own display-text domain so a name valid upstream can never be rejected on
// restore (finding gh6-1).
export const UNIFIED_ITEM_ORIGIN_NAME_MAX_LENGTH = LIBRARY_DISPLAY_TEXT_MAX_LENGTH;
export const UNIFIED_BROWSE_RESTORE_COUNT_MAX = 100_000;
/** Mirrors the editorial contract's zero-based track-anchor bound. */

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
 * What a card in a scope view or a palette row can send the mode to.
 *
 * It carried `artist` and `album` arms naming a saved catalog record by local
 * id; those died with the catalog (`.agents/plans/library-live-view.md` Slice
 * 4). Artists and albums are opened by their live reference now, through
 * `onOpenLiveArtist` / `onOpenLiveAlbum`, and never by an identifier the
 * controller minted.
 */
export type UnifiedLibraryDrillTarget =
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
 * Item targets are first-class entity pages. Two kinds remain, and neither
 * names a stored record: the `album` and `artist` arms restored a saved
 * catalog album or artist by controller-minted local id, and died with the
 * catalog (`.agents/plans/library-live-view.md` Slice 4).
 */
export type UnifiedItemTarget =
	/**
	 * An album opened from a genre or composer drill (v9). It is named by the
	 * drill's own keyless locator and by nothing else: such a row has no
	 * catalog identity, and minting one for it is the cross-surface text join
	 * `.agents/plans/library-walk-binding.md` deleted.
	 *
	 * Durable for the same reason the locator is durable — it contains nothing
	 * session-bound. Restoring it re-walks the drill and re-finds the row by
	 * its rendering, unique or nothing, exactly as the first open did.
	 */
	| { kind: 'collection'; locator: CollectionDrillOpenLocator }
	/**
	 * A page in the live view of Roon (v10,
	 * `.agents/plans/library-live-view.md` Slice 2), named by the renderings
	 * Roon showed on the way to it and by nothing else.
	 *
	 * WHY THE REFERENCE IS NOT HERE, AND MUST NEVER BE. A live reference is
	 * worth exactly one generation; page state outlives generations by design
	 * — it survives a reload, a reconnect, a refresh. Writing one down would
	 * put a dead handle in the browser's history and call it an address. What
	 * is written down is what the reader saw, which is the same question their
	 * click asked, and Roon can be asked it again.
	 */
	| { kind: 'live'; path: LibraryRenderingPath };

/**
 * A reconstructible child surface over an open album page, named by the exact
 * track title Roon rendered. Position is not identity: a reorder must still
 * find the same track, while duplicate titles must resolve to candidates.
 */
export type UnifiedItemDetailTarget = { kind: 'track'; title: string };

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
	artistView: ArtistView;
	/** Songr's exact credit filter over Albums, never a fabricated Roon path. */
	albumCredit: AlbumCreditSelector | null;
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
	/**
	 * Optional display-name label for an album item page's origin (v8):
	 * set when the album was opened from its artist's page, so the back
	 * button can keep naming the artist after reload/popstate restore
	 * (issue #6). Only meaningful over an ALBUM item page.
	 */
	itemOriginName: string | null;
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
	'artistView',
	'albumCredit',
	'collectionDrill',
	'itemTarget',
	'itemDetail',
	'composition',
	'itemOriginName',
	'filterText',
	'surpriseSeed',
	'density',
	'browseHistory'
] as const;
const LEGACY_V10_UNIFIED_SNAPSHOT_KEYS = UNIFIED_SNAPSHOT_KEYS.filter(
	(key) => key !== 'artistView' && key !== 'albumCredit'
);
/** v6 predates the item-detail and composition surfaces (and v7's origin name). */
const LEGACY_V6_UNIFIED_SNAPSHOT_KEYS = LEGACY_V10_UNIFIED_SNAPSHOT_KEYS.filter(
	(key) => key !== 'itemDetail' && key !== 'composition' && key !== 'itemOriginName'
);
/** v7 predates the item origin name (issue #6). */
const LEGACY_V7_UNIFIED_SNAPSHOT_KEYS = LEGACY_V10_UNIFIED_SNAPSHOT_KEYS.filter(
	(key) => key !== 'itemOriginName'
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

/** Bounds one persisted rendering: Roon's strings are far shorter than this. */
const LIVE_PATH_TEXT_MAX = 1_024;
/** Bounds one persisted path. Roon's deepest surface here is four rows down. */
const LIVE_PATH_STEPS_MAX = 8;

function isPathText(value: unknown): value is string {
	return typeof value === 'string' && value.length <= LIVE_PATH_TEXT_MAX;
}

function normalizeLibraryPathStep(value: unknown): LibraryPathStep | null {
	if (!isRecord(value)) return null;
	const hasCredit = 'credit' in value;
	const hasEdition = 'edition' in value;
	if (
		hasEdition &&
		!hasCredit
	) {
		return null;
	}
	if (
		!hasExactKeys(
			value,
			hasCredit
				? hasEdition
					? ['kind', 'title', 'credit', 'edition']
					: ['kind', 'title', 'credit']
				: ['kind', 'title']
		)
	) {
		return null;
	}
	if (!(LIBRARY_NODE_KINDS as readonly string[]).includes(value.kind as string)) return null;
	// A title is the whole of what a step names, so an empty one names nothing
	// and would match whichever row Roon happens to render without a title.
	if (!isPathText(value.title) || value.title.length === 0) return null;
	if (hasCredit && !isPathText(value.credit)) return null;
	if (hasEdition && !isPathText(value.edition)) return null;
	return {
		kind: value.kind as LibraryNodeKind,
		title: value.title,
		// An empty credit is a real answer — Roon renders album rows with no
		// credit line — and is kept, distinct from carrying no credit at all.
		...(hasCredit ? { credit: value.credit as string } : {}),
		...(hasEdition ? { edition: value.edition as string } : {})
	};
}

/**
 * One persisted address into the live view.
 *
 * Rejected rather than repaired, like every other persisted shape here: a
 * partially-understood address would resolve to a partially-right page, and
 * this whole arm exists so that cannot happen.
 */
export function normalizeLibraryRenderingPath(value: unknown): LibraryRenderingPath | null {
	if (!isRecord(value) || !hasExactKeys(value, ['origin', 'steps'])) return null;
	if (
		value.origin !== 'artists' &&
		value.origin !== 'albums' &&
		value.origin !== 'genres' &&
		value.origin !== 'composers'
	) {
		return null;
	}
	if (!Array.isArray(value.steps)) return null;
	if (value.steps.length === 0 || value.steps.length > LIVE_PATH_STEPS_MAX) return null;
	const steps: LibraryPathStep[] = [];
	for (const entry of value.steps) {
		const step = normalizeLibraryPathStep(entry);
		if (step === null) return null;
		steps.push(step);
	}
	return { origin: value.origin, steps };
}

function normalizeItemTarget(
	value: unknown,
	/** v8 and earlier could not carry a collection target; one there is corrupt. */
	allowCollection = true,
	/** v9 and earlier could not carry a live target; one there is corrupt. */
	allowLive = true
): UnifiedItemTarget | null {
	if (!isRecord(value)) return null;
	if (value.kind === 'live' && allowLive) {
		if (!hasExactKeys(value, ['kind', 'path'])) return null;
		const path = normalizeLibraryRenderingPath(value.path);
		return path ? { kind: 'live', path } : null;
	}
	if (value.kind === 'collection' && allowCollection) {
		if (!hasExactKeys(value, ['kind', 'locator'])) return null;
		// The locator's own normalizer is the authority on its shape; this
		// file keeps no second copy of those rules.
		const locator = normalizeCollectionDrillOpenLocator(value.locator);
		return locator ? { kind: 'collection', locator } : null;
	}
	return null;
}

function normalizeItemDetail(value: unknown): UnifiedItemDetailTarget | null {
	if (!isRecord(value)) return null;
	if (value.kind !== 'track') return null;
	return hasExactKeys(value, ['kind', 'title']) && isNonEmptyString(value.title, LIVE_PATH_TEXT_MAX)
		? { kind: 'track', title: value.title }
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

function normalizeItemOriginName(value: unknown): string | null {
	return isNonEmptyString(value, UNIFIED_ITEM_ORIGIN_NAME_MAX_LENGTH) ? value : null;
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
	legacyTier: 'v6' | 'v7' | 'v8' | 'v9' | 'v10' | null = null
): UnifiedLibrarySnapshot | null {
	const keys =
		legacyTier === 'v6'
			? LEGACY_V6_UNIFIED_SNAPSHOT_KEYS
			: legacyTier === 'v7'
				? LEGACY_V7_UNIFIED_SNAPSHOT_KEYS
				: legacyTier === null ? UNIFIED_SNAPSHOT_KEYS : LEGACY_V10_UNIFIED_SNAPSHOT_KEYS;
	if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
	if (!isUnifiedScope(value.scope)) return null;
	const collectionDrill =
		value.collectionDrill === null
			? null
			: normalizeCollectionDrillTarget(value.collectionDrill);
	if (value.collectionDrill !== null && !collectionDrill) return null;
	const itemTarget =
		value.itemTarget === null
			? null
			: normalizeItemTarget(
					value.itemTarget,
					legacyTier === null || legacyTier === 'v10' || legacyTier === 'v9',
					legacyTier === null || legacyTier === 'v10'
				);
	if (value.itemTarget !== null && !itemTarget) return null;
	let itemDetail: UnifiedItemDetailTarget | null = null;
	let composition: UnifiedCompositionSurface | null = null;
	if (legacyTier !== 'v6') {
		itemDetail =
			value.itemDetail === null ? null : normalizeItemDetail(value.itemDetail);
		if (value.itemDetail !== null && !itemDetail) return null;
		// A child surface without its exact parent context is not
		// reconstructible: reject rather than restore something else.
		if (
			itemDetail !== null &&
			itemTarget?.kind !== 'collection' &&
			!(
				itemTarget?.kind === 'live' &&
				itemTarget.path.steps.at(-1)?.kind === 'album'
			)
		) {
			return null;
		}
		composition =
			value.composition === null
				? null
				: normalizeCompositionSurface(value.composition);
		if (value.composition !== null && !composition) return null;
		if (composition !== null && collectionDrill?.kind !== 'composer') return null;
	}
	let itemOriginName: string | null = null;
	if (legacyTier === null || legacyTier === 'v10') {
		itemOriginName =
			value.itemOriginName === null ? null : normalizeItemOriginName(value.itemOriginName);
		if (value.itemOriginName !== null && itemOriginName === null) return null;
		// The origin label only makes sense over an open album page
		// (issue #6): without one, it is not a reconstructible back target.
		if (itemOriginName !== null && itemTarget?.kind !== 'collection') {
			return null;
		}
	}
	const shared = normalizeSharedSnapshotFields(value);
	if (!shared) return null;
	const browseHistory = normalizeBrowseHistorySnapshot(value.browseHistory);
	if (!browseHistory) return null;
	const artistView = legacyTier === null ? value.artistView : 'all-artists';
	if (artistView !== 'album-artists' && artistView !== 'all-artists') return null;
	const albumCredit = legacyTier !== null || value.albumCredit === null
		? null : normalizeAlbumCreditSelector(value.albumCredit);
	if (legacyTier === null && value.albumCredit !== null && albumCredit === null) return null;
	if (artistView === 'all-artists' && albumCredit !== null) return null;
	if (artistView === 'album-artists') {
		if (value.scope !== 'artists' || collectionDrill !== null || composition !== null ||
			itemOriginName !== null || shared.filterText !== '' ||
			browseHistory.context.hierarchy !== 'browse' || browseHistory.history.length !== 0 ||
			browseHistory.forward.length !== 0) return null;
		if (itemTarget !== null) {
			if (albumCredit === null || itemTarget.kind !== 'live' ||
				itemTarget.path.origin !== 'albums' || itemTarget.path.steps.length !== 1) return null;
			const album = itemTarget.path.steps[0];
			if (album.kind !== 'album' || album.credit === undefined ||
				!albumCreditMatches(albumCredit, album.credit)) return null;
		}
	}
	return {
		scope: value.scope,
		artistView,
		albumCredit,
		collectionDrill,
		itemTarget,
		itemDetail,
		composition,
		itemOriginName,
		...shared,
		browseHistory
	};
}

/**
 * v5-and-earlier snapshots carried one `drill` union plus a redundant
 * `openAlbumLocalId`. They normalize forward: genre/composer drills become
 * collection drills.
 *
 * Their artist and album arms named a saved catalog record by
 * controller-minted local id, and both are now REFUSED rather than migrated:
 * the catalog is gone (`.agents/plans/library-live-view.md` Slice 4), so there
 * is nothing such an id could name. A refused legacy snapshot restores the
 * scope it belonged to, which is the honest answer — never a page pointing at
 * a record that no longer exists.
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
	// A legacy snapshot that named a catalog album has nothing left to name.
	if (value.openAlbumLocalId !== null) return null;
	const shared = normalizeSharedSnapshotFields(value);
	if (!shared) return null;
	const browseHistory = withoutBrowse
		? emptyBrowseHistory()
		: normalizeBrowseHistorySnapshot(value.browseHistory);
	if (!browseHistory) return null;

	const collectionDrill: UnifiedCollectionDrillTarget | null = drill
		? { kind: drill.kind, label: drill.label }
		: null;
	return {
		scope: value.scope,
		artistView: 'all-artists',
		albumCredit: null,
		collectionDrill,
		itemTarget: null,
		itemDetail: null,
		composition: null,
		itemOriginName: null,
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
			value.schemaVersion === LEGACY_UNIFIED_LIBRARY_ARTIST_VIEW_VERSION
		) {
			const snapshot = normalizeUnifiedSnapshot(value.snapshot, 'v10');
			return snapshot ? {
				libraryView: 'unified', schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION, snapshot
			} : null;
		}
		if (
			value.libraryView === 'unified' &&
			value.schemaVersion === LEGACY_UNIFIED_LIBRARY_LIVE_TARGET_VERSION
		) {
			// v9 carries every key v10 does; only the item-target union widened,
			// so a v9 snapshot normalizes forward unchanged — with the live arm
			// refused, because v9 could never have written one.
			const snapshot = normalizeUnifiedSnapshot(value.snapshot, 'v9');
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
			value.schemaVersion === LEGACY_UNIFIED_LIBRARY_COLLECTION_TARGET_VERSION
		) {
			// v8 carries every key v10 does; only the item-target union widened,
			// so a v8 snapshot normalizes forward unchanged — with the
			// collection arm refused, because v8 could never have written one.
			const snapshot = normalizeUnifiedSnapshot(value.snapshot, 'v8');
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
			value.schemaVersion === LEGACY_UNIFIED_LIBRARY_ITEM_ORIGIN_VERSION
		) {
			const snapshot = normalizeUnifiedSnapshot(value.snapshot, 'v7');
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
			const snapshot = normalizeUnifiedSnapshot(value.snapshot, 'v6');
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
		'density' | 'browseHistory' | 'itemDetail' | 'composition' | 'itemOriginName' | 'artistView' | 'albumCredit'
	> & {
		readonly artistView?: ArtistView;
		readonly albumCredit?: AlbumCreditSelector | null;
		readonly density?: UnifiedLibraryDensity | null;
		readonly browseHistory?: BrowseHistorySnapshot;
		readonly itemDetail?: UnifiedItemDetailTarget | null;
		readonly composition?: UnifiedCompositionSurface | null;
		readonly itemOriginName?: string | null;
	}
): UnifiedLibraryPageState {
	return requireLibraryPageState({
		libraryView: 'unified',
		schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
		snapshot: {
			artistView: 'all-artists',
			albumCredit: null,
			density: null,
			browseHistory: emptyBrowseHistory(),
			itemDetail: null,
			composition: null,
			itemOriginName: null,
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
