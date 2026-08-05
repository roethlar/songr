import type { LibraryView } from '$lib/stores/libraryViewStore';
import type { UnifiedLibraryDensity } from '$lib/stores/unifiedLibraryPrefsStore';

export type LibraryViewActivationCause =
	| 'initial'
	| 'route-request'
	| 'user-switch'
	| 'history-pop';

export const CLASSIC_LIBRARY_PAGE_STATE_VERSION = 1 as const;
export const TIMELINE_LIBRARY_PAGE_STATE_VERSION = 1 as const;
export const LIBRARY_VIEW_REQUEST_PAGE_STATE_VERSION = 1 as const;

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
}

export interface ClassicHistorySnapshot {
	context: BrowseHistoryContext;
	history: BrowseHistoryStep[];
	forward: BrowseHistoryStep[];
}

export interface ClassicLibraryPageState {
	libraryView: 'classic';
	schemaVersion: typeof CLASSIC_LIBRARY_PAGE_STATE_VERSION;
	snapshot: ClassicHistorySnapshot;
}

export const TIMELINE_ARTIST_QUERY_MAX_LENGTH = 256;
export const TIMELINE_LOCAL_ID_MAX_LENGTH = 256;
export const TIMELINE_SEMANTIC_PATH_MAX_LENGTH = 32;
export const TIMELINE_CAMERA_MIN_SCALE = 0.125;
export const TIMELINE_CAMERA_MAX_SCALE = 8;
export const TIMELINE_DISPLAY_DEPTH_MAX = 8;

export type TimelineSemanticKind = 'artist' | 'album' | 'auxiliary-artist';

export interface TimelineSemanticRef {
	kind: TimelineSemanticKind;
	localId: string;
}

export interface TimelineCameraSnapshot {
	x: number;
	y: number;
	scale: number;
}

export interface TimelineLibrarySnapshot {
	artistQuery: string;
	selectedArtistLocalId: string | null;
	activeSemanticPath: TimelineSemanticRef[];
	selectedNode: TimelineSemanticRef | null;
	camera: TimelineCameraSnapshot;
	displayDepth: number;
}

export interface TimelineLibraryPageState {
	libraryView: 'timeline';
	schemaVersion: typeof TIMELINE_LIBRARY_PAGE_STATE_VERSION;
	snapshot: TimelineLibrarySnapshot;
}

export const UNIFIED_LIBRARY_PAGE_STATE_VERSION = 3 as const;
export const UNIFIED_LOCAL_ID_MAX_LENGTH = 256;
export const UNIFIED_LABEL_MAX_LENGTH = 256;
export const UNIFIED_FILTER_TEXT_MAX_LENGTH = 256;

export type UnifiedLibraryScope =
	| 'artists'
	| 'albums'
	| 'genres'
	| 'recently-played'
	| 'most-played'
	| 'playlists'
	| 'recently-added'
	| 'surprise';

/**
 * Drill targets are semantic: artists and albums restore by catalog localId;
 * genres and composers restore by their normalized display label.
 * Restoration re-navigates and matches, never stores browse keys.
 */
export type UnifiedLibraryDrillTarget =
	| { kind: 'artist'; localId: string }
	| { kind: 'album'; localId: string }
	| { kind: 'genre'; label: string }
	| { kind: 'composer'; label: string };

export interface UnifiedLibrarySnapshot {
	scope: UnifiedLibraryScope;
	drill: UnifiedLibraryDrillTarget | null;
	filterText: string;
	openAlbumLocalId: string | null;
	surpriseSeed: number | null;
	/** Null only for an untagged root; semantic entries capture the live density. */
	density: UnifiedLibraryDensity | null;
}

export interface UnifiedLibraryPageState {
	libraryView: 'unified';
	schemaVersion: typeof UNIFIED_LIBRARY_PAGE_STATE_VERSION;
	snapshot: UnifiedLibrarySnapshot;
}

export type LibraryPageState =
	| ClassicLibraryPageState
	| TimelineLibraryPageState
	| UnifiedLibraryPageState;

export interface LibraryViewRequestPageState {
	libraryView: LibraryView;
	schemaVersion: typeof LIBRARY_VIEW_REQUEST_PAGE_STATE_VERSION;
}

/** SvelteKit requires App.PageState to remain an augmentable interface. */
export interface LibraryPageStateEnvelope {
	library?: LibraryPageState;
	libraryRequest?: LibraryViewRequestPageState;
}

const BREADCRUMB_KEYS = ['title', 'subtitle', 'imageKey', 'itemType', 'searchCategory'] as const;
const HISTORY_STEP_KEYS = ['hierarchy', 'breadcrumb'] as const;
const CLASSIC_SNAPSHOT_KEYS = ['context', 'history', 'forward'] as const;
const LIBRARY_STATE_KEYS = ['libraryView', 'schemaVersion', 'snapshot'] as const;
const LIBRARY_VIEW_REQUEST_STATE_KEYS = ['libraryView', 'schemaVersion'] as const;
const TIMELINE_SNAPSHOT_KEYS = [
	'artistQuery',
	'selectedArtistLocalId',
	'activeSemanticPath',
	'selectedNode',
	'camera',
	'displayDepth'
] as const;
const UNIFIED_SNAPSHOT_KEYS = [
	'scope',
	'drill',
	'filterText',
	'openAlbumLocalId',
	'surpriseSeed',
	'density'
] as const;
const UNIFIED_SCOPES: readonly UnifiedLibraryScope[] = [
	'artists',
	'albums',
	'genres',
	'recently-played',
	'most-played',
	'playlists',
	'recently-added',
	'surprise'
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
	if (!isRecord(value) || !hasExactKeys(value, HISTORY_STEP_KEYS)) return null;
	if (value.hierarchy !== 'browse' && value.hierarchy !== 'search') return null;
	const breadcrumb = normalizeBreadcrumb(value.breadcrumb);
	return breadcrumb ? { hierarchy: value.hierarchy, breadcrumb } : null;
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

export function normalizeClassicHistorySnapshot(value: unknown): ClassicHistorySnapshot | null {
	try {
		if (!isRecord(value) || !hasExactKeys(value, CLASSIC_SNAPSHOT_KEYS)) return null;
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

function normalizeTimelineSemanticRef(value: unknown): TimelineSemanticRef | null {
	if (!isRecord(value) || !hasExactKeys(value, ['kind', 'localId'])) return null;
	if (
		value.kind !== 'artist' &&
		value.kind !== 'album' &&
		value.kind !== 'auxiliary-artist'
	) {
		return null;
	}
	return isNonEmptyString(value.localId, TIMELINE_LOCAL_ID_MAX_LENGTH)
		? { kind: value.kind, localId: value.localId }
		: null;
}

function normalizeTimelineCamera(value: unknown): TimelineCameraSnapshot | null {
	if (!isRecord(value) || !hasExactKeys(value, ['x', 'y', 'scale'])) return null;
	if (
		typeof value.x !== 'number' ||
		!Number.isFinite(value.x) ||
		typeof value.y !== 'number' ||
		!Number.isFinite(value.y) ||
		typeof value.scale !== 'number' ||
		!Number.isFinite(value.scale) ||
		value.scale < TIMELINE_CAMERA_MIN_SCALE ||
		value.scale > TIMELINE_CAMERA_MAX_SCALE
	) {
		return null;
	}
	return { x: value.x, y: value.y, scale: value.scale };
}

function normalizeTimelineSnapshot(value: unknown): TimelineLibrarySnapshot | null {
	if (!isRecord(value) || !hasExactKeys(value, TIMELINE_SNAPSHOT_KEYS)) return null;
	if (
		typeof value.artistQuery !== 'string' ||
		value.artistQuery.length > TIMELINE_ARTIST_QUERY_MAX_LENGTH
	) {
		return null;
	}
	if (
		value.selectedArtistLocalId !== null &&
		!isNonEmptyString(value.selectedArtistLocalId, TIMELINE_LOCAL_ID_MAX_LENGTH)
	) {
		return null;
	}
	if (
		!Array.isArray(value.activeSemanticPath) ||
		value.activeSemanticPath.length > TIMELINE_SEMANTIC_PATH_MAX_LENGTH
	) {
		return null;
	}
	const activeSemanticPath: TimelineSemanticRef[] = [];
	for (const rawRef of value.activeSemanticPath) {
		const ref = normalizeTimelineSemanticRef(rawRef);
		if (!ref) return null;
		activeSemanticPath.push(ref);
	}
	const selectedNode =
		value.selectedNode === null ? null : normalizeTimelineSemanticRef(value.selectedNode);
	if (value.selectedNode !== null && !selectedNode) return null;
	const camera = normalizeTimelineCamera(value.camera);
	if (!camera) return null;
	if (
		typeof value.displayDepth !== 'number' ||
		!Number.isInteger(value.displayDepth) ||
		value.displayDepth < 0 ||
		value.displayDepth > TIMELINE_DISPLAY_DEPTH_MAX
	) {
		return null;
	}
	if (value.selectedArtistLocalId === null) {
		if (activeSemanticPath.length !== 0 || selectedNode !== null || value.displayDepth !== 0) {
			return null;
		}
	} else {
		const root = activeSemanticPath[0];
		const tail = activeSemanticPath.at(-1);
		if (
			!root ||
			root.kind !== 'artist' ||
			root.localId !== value.selectedArtistLocalId ||
			!tail ||
			!selectedNode ||
			selectedNode.kind !== tail.kind ||
			selectedNode.localId !== tail.localId
		) {
			return null;
		}
		const supportedShape =
			(activeSemanticPath.length === 1 &&
				root.kind === 'artist' &&
				value.displayDepth === 0) ||
			(activeSemanticPath.length === 2 &&
				(activeSemanticPath[1].kind === 'album' ||
					activeSemanticPath[1].kind === 'auxiliary-artist') &&
				value.displayDepth === 1) ||
			(activeSemanticPath.length === 3 &&
				activeSemanticPath[1].kind === 'auxiliary-artist' &&
				activeSemanticPath[2].kind === 'album' &&
				value.displayDepth === 2);
		if (!supportedShape) return null;
	}
	return {
		artistQuery: value.artistQuery,
		selectedArtistLocalId: value.selectedArtistLocalId,
		activeSemanticPath,
		selectedNode,
		camera,
		displayDepth: value.displayDepth
	};
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

function normalizeUnifiedSnapshot(value: unknown): UnifiedLibrarySnapshot | null {
	if (!isRecord(value) || !hasExactKeys(value, UNIFIED_SNAPSHOT_KEYS)) return null;
	if (!isUnifiedScope(value.scope)) return null;
	const drill = value.drill === null ? null : normalizeUnifiedDrillTarget(value.drill);
	if (value.drill !== null && !drill) return null;
	if (
		typeof value.filterText !== 'string' ||
		value.filterText.length > UNIFIED_FILTER_TEXT_MAX_LENGTH
	) {
		return null;
	}
	if (
		value.openAlbumLocalId !== null &&
		!isNonEmptyString(value.openAlbumLocalId, UNIFIED_LOCAL_ID_MAX_LENGTH)
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
		scope: value.scope,
		drill,
		filterText: value.filterText,
		openAlbumLocalId: value.openAlbumLocalId,
		surpriseSeed: value.surpriseSeed,
		density: value.density
	};
}

export function normalizeLibraryPageState(value: unknown): LibraryPageState | null {
	try {
		if (!isRecord(value) || !hasExactKeys(value, LIBRARY_STATE_KEYS)) return null;
		if (
			value.libraryView === 'classic' &&
			value.schemaVersion === CLASSIC_LIBRARY_PAGE_STATE_VERSION
		) {
			const snapshot = normalizeClassicHistorySnapshot(value.snapshot);
			return snapshot
				? {
						libraryView: 'classic',
						schemaVersion: CLASSIC_LIBRARY_PAGE_STATE_VERSION,
						snapshot
					}
				: null;
		}
		if (
			value.libraryView === 'timeline' &&
			value.schemaVersion === TIMELINE_LIBRARY_PAGE_STATE_VERSION
		) {
			const snapshot = normalizeTimelineSnapshot(value.snapshot);
			return snapshot
				? {
						libraryView: 'timeline',
						schemaVersion: TIMELINE_LIBRARY_PAGE_STATE_VERSION,
						snapshot
					}
				: null;
		}
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

export function normalizeLibraryViewRequestPageState(
	value: unknown
): LibraryViewRequestPageState | null {
	try {
		if (!isRecord(value) || !hasExactKeys(value, LIBRARY_VIEW_REQUEST_STATE_KEYS)) return null;
		if (
			(value.libraryView !== 'classic' &&
				value.libraryView !== 'timeline' &&
				value.libraryView !== 'unified') ||
			value.schemaVersion !== LIBRARY_VIEW_REQUEST_PAGE_STATE_VERSION
		) return null;
		return {
			libraryView: value.libraryView,
			schemaVersion: LIBRARY_VIEW_REQUEST_PAGE_STATE_VERSION
		};
	} catch {
		return null;
	}
}

export function normalizeLibraryViewRequestPageStateEnvelope(
	value: unknown
): LibraryViewRequestPageState | null {
	try {
		if (!isRecord(value) || !hasExactKeys(value, ['libraryRequest'])) return null;
		return normalizeLibraryViewRequestPageState(value.libraryRequest);
	} catch {
		return null;
	}
}

function requireLibraryPageState(value: unknown): LibraryPageState {
	const normalized = normalizeLibraryPageState(value);
	if (!normalized) throw new TypeError('Invalid Library page state');
	return normalized;
}

export function buildClassicLibraryPageState(
	snapshot: ClassicHistorySnapshot
): ClassicLibraryPageState {
	return requireLibraryPageState({
		libraryView: 'classic',
		schemaVersion: CLASSIC_LIBRARY_PAGE_STATE_VERSION,
		snapshot
	}) as ClassicLibraryPageState;
}

export function buildClassicRootPageState(
	context: BrowseHistoryContext = { hierarchy: 'browse' }
): ClassicLibraryPageState {
	return buildClassicLibraryPageState({ context, history: [], forward: [] });
}

export function buildTimelineLibraryPageState(
	snapshot: TimelineLibrarySnapshot
): TimelineLibraryPageState {
	return requireLibraryPageState({
		libraryView: 'timeline',
		schemaVersion: TIMELINE_LIBRARY_PAGE_STATE_VERSION,
		snapshot
	}) as TimelineLibraryPageState;
}

export function buildTimelineRootPageState(): TimelineLibraryPageState {
	return buildTimelineLibraryPageState({
		artistQuery: '',
		selectedArtistLocalId: null,
		activeSemanticPath: [],
		selectedNode: null,
		camera: { x: 0, y: 0, scale: 1 },
		displayDepth: 0
	});
}

export function buildUnifiedLibraryPageState(
	snapshot: Omit<UnifiedLibrarySnapshot, 'density'> & {
		readonly density?: UnifiedLibraryDensity | null;
	}
): UnifiedLibraryPageState {
	return requireLibraryPageState({
		libraryView: 'unified',
		schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
		snapshot: { density: null, ...snapshot }
	}) as UnifiedLibraryPageState;
}

export function buildUnifiedRootPageState(
	scope: UnifiedLibraryScope = 'artists'
): UnifiedLibraryPageState {
	return buildUnifiedLibraryPageState({
		scope,
		drill: null,
		filterText: '',
		openAlbumLocalId: null,
		surpriseSeed: null,
		density: null
	});
}

export function buildLibraryPageStateEnvelope<State extends LibraryPageState>(
	state: State
): { library: State } {
	return { library: requireLibraryPageState(state) as State };
}

export function buildLibraryViewRequestPageStateEnvelope(
	libraryView: LibraryView
): { libraryRequest: LibraryViewRequestPageState } {
	const request = normalizeLibraryViewRequestPageState({
		libraryView,
		schemaVersion: LIBRARY_VIEW_REQUEST_PAGE_STATE_VERSION
	});
	if (!request) throw new TypeError('Invalid Library view request page state');
	return { libraryRequest: request };
}

export function pageStateForLibraryView(
	libraryView: LibraryView,
	classicSnapshot?: ClassicHistorySnapshot
): LibraryPageState {
	if (libraryView === 'timeline') return buildTimelineRootPageState();
	if (libraryView === 'unified') return buildUnifiedRootPageState();
	return classicSnapshot
		? buildClassicLibraryPageState(classicSnapshot)
		: buildClassicRootPageState();
}
