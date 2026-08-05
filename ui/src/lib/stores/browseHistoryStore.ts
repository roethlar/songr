import { browser } from '$app/environment';
import {
	normalizeClassicHistorySnapshot,
	type BrowseBreadcrumb,
	type BrowseHistoryContext,
	type BrowseHistoryStep,
	type ClassicHistorySnapshot
} from '$lib/libraryPageState';
import { get, writable, type Readable } from 'svelte/store';

export {
	normalizeClassicHistorySnapshot,
	type BrowseBreadcrumb,
	type BrowseHistoryContext,
	type BrowseHistoryStep,
	type ClassicHistorySnapshot
} from '$lib/libraryPageState';

/** Compatibility name for Classic callers while the v4 boundary lands. */
export type BrowseHistoryState = ClassicHistorySnapshot;

export const CLASSIC_HISTORY_SCHEMA_VERSION = 4 as const;
export const CLASSIC_HISTORY_STORAGE_KEY = 'roon-controller-browse-history-v4';
const LEGACY_HISTORY_STORAGE_KEY = 'roon-controller-browse-history-v3';

const ENVELOPE_KEYS = ['schemaVersion', 'snapshot'] as const;
const LEGACY_STATE_KEYS = ['history', 'forward', 'searchQuery'] as const;
const LEGACY_STEP_KEYS = [
	'hierarchy',
	'zoneId',
	'itemKey',
	'input',
	'offset',
	'setDisplayOffset',
	'refresh',
	'multiSessionKey',
	'popAll',
	'pageSize',
	'breadcrumb'
] as const;

interface PersistedClassicHistoryEnvelope {
	schemaVersion: typeof CLASSIC_HISTORY_SCHEMA_VERSION;
	snapshot: ClassicHistorySnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Reflect.ownKeys(record);
	return (
		keys.length === expected.length &&
		keys.every((key) => typeof key === 'string' && expected.includes(key))
	);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Reflect.ownKeys(record).every(
		(key) => typeof key === 'string' && allowed.includes(key)
	);
}

function browseRoot(): ClassicHistorySnapshot {
	return { context: { hierarchy: 'browse' }, history: [], forward: [] };
}

function cloneSnapshot(snapshot: ClassicHistorySnapshot): ClassicHistorySnapshot {
	const cloned = normalizeClassicHistorySnapshot(snapshot);
	if (!cloned) throw new TypeError('Invalid internal Classic history snapshot');
	return cloned;
}

function cloneStep(step: BrowseHistoryStep): BrowseHistoryStep {
	return {
		hierarchy: step.hierarchy,
		breadcrumb: { ...step.breadcrumb }
	};
}

function sameContext(left: BrowseHistoryContext, right: BrowseHistoryContext): boolean {
	return (
		left.hierarchy === right.hierarchy &&
		(left.hierarchy === 'browse' ||
			(right.hierarchy === 'search' && left.query === right.query))
	);
}

function normalizeEnvelope(value: unknown): ClassicHistorySnapshot | null {
	if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS)) return null;
	if (value.schemaVersion !== CLASSIC_HISTORY_SCHEMA_VERSION) return null;
	return normalizeClassicHistorySnapshot(value.snapshot);
}

function persist(snapshot: ClassicHistorySnapshot): void {
	if (!browser) return;
	try {
		const envelope: PersistedClassicHistoryEnvelope = {
			schemaVersion: CLASSIC_HISTORY_SCHEMA_VERSION,
			snapshot: cloneSnapshot(snapshot)
		};
		sessionStorage.setItem(CLASSIC_HISTORY_STORAGE_KEY, JSON.stringify(envelope));
	} catch {
		/* sessionStorage unavailable */
	}
}

function legacyStepHierarchy(value: unknown): 'browse' | 'search' | null {
	if (!isRecord(value) || !hasOnlyKeys(value, LEGACY_STEP_KEYS)) return null;
	return value.hierarchy === 'browse' || value.hierarchy === 'search'
		? value.hierarchy
		: null;
}

function projectLegacyStack(
	value: unknown[],
	hierarchy: 'browse' | 'search'
): Array<{ hierarchy: 'browse' | 'search'; breadcrumb: unknown }> | null {
	const projected: Array<{ hierarchy: 'browse' | 'search'; breadcrumb: unknown }> = [];
	for (const rawStep of value) {
		if (!isRecord(rawStep) || !hasOnlyKeys(rawStep, LEGACY_STEP_KEYS)) return null;
		if (rawStep.hierarchy !== hierarchy || !Object.hasOwn(rawStep, 'breadcrumb')) return null;
		projected.push({ hierarchy, breadcrumb: rawStep.breadcrumb });
	}
	return projected;
}

/**
 * Project a legacy v3 entry through semantic metadata only. Roon item keys,
 * zone IDs, and multi-session keys are deliberately neither read nor copied.
 * An unreconstructible active path becomes its explicit safe root; an invalid
 * forward path is discarded independently.
 */
function projectLegacySnapshot(value: unknown): ClassicHistorySnapshot | null {
	if (!isRecord(value) || !hasExactKeys(value, LEGACY_STATE_KEYS)) return null;
	if (!Array.isArray(value.history) || !Array.isArray(value.forward)) return null;
	if (value.searchQuery !== null && typeof value.searchQuery !== 'string') return null;

	const tail = value.history.at(-1) ?? value.forward.at(-1);
	const inferredHierarchy =
		legacyStepHierarchy(tail) ??
		(typeof value.searchQuery === 'string' && value.searchQuery.length > 0 ? 'search' : 'browse');
	const context: BrowseHistoryContext =
		inferredHierarchy === 'search' &&
		typeof value.searchQuery === 'string' &&
		value.searchQuery.length > 0
			? { hierarchy: 'search', query: value.searchQuery }
			: { hierarchy: 'browse' };
	const safeRoot: ClassicHistorySnapshot = { context, history: [], forward: [] };

	const history = projectLegacyStack(value.history, context.hierarchy);
	if (!history) return safeRoot;
	const normalizedHistory = normalizeClassicHistorySnapshot({ context, history, forward: [] });
	if (!normalizedHistory) return safeRoot;

	const forward = projectLegacyStack(value.forward, context.hierarchy);
	if (!forward) return normalizedHistory;
	return (
		normalizeClassicHistorySnapshot({
			context,
			history: normalizedHistory.history,
			forward
		}) ?? normalizedHistory
	);
}

function readPersisted(): ClassicHistorySnapshot {
	if (!browser) return browseRoot();
	try {
		const current = sessionStorage.getItem(CLASSIC_HISTORY_STORAGE_KEY);
		if (current !== null) {
			return normalizeEnvelope(JSON.parse(current)) ?? browseRoot();
		}

		const legacy = sessionStorage.getItem(LEGACY_HISTORY_STORAGE_KEY);
		if (legacy === null) return browseRoot();
		const migrated = projectLegacySnapshot(JSON.parse(legacy));
		if (!migrated) return browseRoot();
		persist(migrated);
		return migrated;
	} catch {
		return browseRoot();
	}
}

const internal = writable<ClassicHistorySnapshot>(readPersisted());

/** Public subscribers receive copies, so they cannot mutate store state by reference. */
export const browseHistoryStore: Readable<ClassicHistorySnapshot> = {
	subscribe(run, invalidate) {
		return internal.subscribe(
			(snapshot) => run(cloneSnapshot(snapshot)),
			() => invalidate?.()
		);
	}
};

export function getClassicHistorySnapshot(): ClassicHistorySnapshot {
	return cloneSnapshot(get(internal));
}

/**
 * Record one reconstructible semantic transition. Changing hierarchy or search
 * query starts a distinct context and clears both navigation stacks.
 */
export function pushHistory(
	context: BrowseHistoryContext,
	breadcrumb: BrowseBreadcrumb
): boolean {
	const candidate = normalizeClassicHistorySnapshot({
		context,
		history: [{ hierarchy: context.hierarchy, breadcrumb }],
		forward: []
	});
	if (!candidate) return false;
	const cleanContext = candidate.context;
	const step = candidate.history[0];

	internal.update((state) => {
		const next = normalizeClassicHistorySnapshot({
			context: cleanContext,
			history: sameContext(state.context, cleanContext)
				? [...state.history, step]
				: [step],
			forward: []
		});
		if (!next) throw new TypeError('Invalid Classic history transition');
		persist(next);
		return next;
	});
	return true;
}

export function popHistory(): BrowseHistoryStep | undefined {
	let popped: BrowseHistoryStep | undefined;
	internal.update((state) => {
		if (state.history.length === 0) return state;
		const last = state.history[state.history.length - 1];
		popped = cloneStep(last);
		const next: ClassicHistorySnapshot = {
			context: state.context,
			history: state.history.slice(0, -1),
			forward: [...state.forward, last]
		};
		persist(next);
		return next;
	});
	return popped;
}

export function popForward(): BrowseHistoryStep | undefined {
	let popped: BrowseHistoryStep | undefined;
	internal.update((state) => {
		if (state.forward.length === 0) return state;
		const last = state.forward[state.forward.length - 1];
		popped = cloneStep(last);
		const next: ClassicHistorySnapshot = {
			context: state.context,
			history: [...state.history, last],
			forward: state.forward.slice(0, -1)
		};
		persist(next);
		return next;
	});
	return popped;
}

export function resetHistory(context: BrowseHistoryContext = { hierarchy: 'browse' }): void {
	const next = normalizeClassicHistorySnapshot({ context, history: [], forward: [] });
	if (!next) return;
	internal.set(next);
	persist(next);
}

/** Atomically replace all Classic semantic history, including its root context. */
export function replaceHistory(snapshot: ClassicHistorySnapshot): boolean {
	const next = normalizeClassicHistorySnapshot(snapshot);
	if (!next) return false;
	internal.set(next);
	persist(next);
	return true;
}
