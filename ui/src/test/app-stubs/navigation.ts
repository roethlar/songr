// SvelteKit shallow-navigation stub. It deliberately models page.state
// traversal separately from route navigation: a shallow Back/Forward updates
// `$app/state.page.state` without invoking afterNavigate callbacks.
import type { AfterNavigate } from '@sveltejs/kit';
import { page, __resetTestPage, __setTestPage } from './state.svelte';

export type TestNavigationOperation = 'goto' | 'pushState' | 'replaceState' | 'popstate';

export interface TestNavigationLogEntry {
	operation: TestNavigationOperation;
	url: string;
	state: App.PageState;
	delta?: number;
}

export interface TestHistoryEntry {
	url: string;
	state: App.PageState;
}

export interface TestHistorySnapshot {
	entries: TestHistoryEntry[];
	index: number;
}

interface InternalHistoryEntry extends TestHistoryEntry {
	routeGeneration: number;
}

const afterNavigateCallbacks = new Set<(navigation: AfterNavigate) => void>();
let history: InternalHistoryEntry[] = [
	{ url: page.url.href, state: cloneState(page.state), routeGeneration: 0 }
];
let historyIndex = 0;
let nextRouteGeneration = 1;
let navigationLog: TestNavigationLogEntry[] = [];
let initialNavigationType: AfterNavigate['type'] = 'enter';

function cloneState(state: App.PageState): App.PageState {
	if (typeof structuredClone === 'function') {
		try {
			return structuredClone(state);
		} catch {
			// `$app/state` is a Svelte deep proxy in this test environment.
		}
	}
	return JSON.parse(JSON.stringify(state)) as App.PageState;
}

function cloneEntry(entry: TestHistoryEntry): TestHistoryEntry {
	return { url: entry.url, state: cloneState(entry.state) };
}

function resolveUrl(url: string | URL): URL {
	if (url === '') return new URL(page.url);
	return new URL(url, page.url);
}

function publish(entry: TestHistoryEntry): void {
	__setTestPage(entry.url, entry.state);
}

function buildNavigationTarget(entry: TestHistoryEntry) {
	return {
		params: {},
		route: { id: null },
		url: new URL(entry.url),
		scroll: { x: 0, y: 0 }
	};
}

export async function goto(
	url: string | URL,
	options: {
		replaceState?: boolean;
		noScroll?: boolean;
		keepFocus?: boolean;
		invalidateAll?: boolean;
		invalidate?: (string | URL | ((url: URL) => boolean))[];
		state?: App.PageState;
	} = {}
): Promise<void> {
	const from = cloneEntry(history[historyIndex]);
	const entry: InternalHistoryEntry = {
		url: resolveUrl(url).href,
		state: cloneState(options.state ?? {}),
		routeGeneration: nextRouteGeneration++
	};

	if (options.replaceState) {
		history[historyIndex] = entry;
	} else {
		history = [...history.slice(0, historyIndex + 1), entry];
		historyIndex = history.length - 1;
	}

	navigationLog.push({ operation: 'goto', ...cloneEntry(entry) });
	publish(entry);
	await Promise.resolve();

	const navigation = {
		from: buildNavigationTarget(from),
		to: buildNavigationTarget(entry),
		type: 'goto',
		willUnload: false,
		complete: Promise.resolve()
	} as AfterNavigate;
	for (const callback of afterNavigateCallbacks) callback(navigation);
}
export const invalidate = async (_url?: string): Promise<void> => {};
export const invalidateAll = async (): Promise<void> => {};
export const beforeNavigate = (_fn: () => void): void => {};

export function afterNavigate(callback: (navigation: AfterNavigate) => void): void {
	afterNavigateCallbacks.add(callback);
	queueMicrotask(() => {
		if (!afterNavigateCallbacks.has(callback)) return;
		callback({
			from: null,
			to: {
				params: {},
				route: { id: null },
				url: new URL(page.url)
			},
			type: initialNavigationType,
			willUnload: false,
			complete: Promise.resolve()
		} as AfterNavigate);
	});
}

export function pushState(url: string | URL, state: App.PageState): void {
	const entry: InternalHistoryEntry = {
		url: resolveUrl(url).href,
		state: cloneState(state),
		routeGeneration: history[historyIndex].routeGeneration
	};
	history = [...history.slice(0, historyIndex + 1), entry];
	historyIndex = history.length - 1;
	navigationLog.push({ operation: 'pushState', ...cloneEntry(entry) });
	publish(entry);
}

export function replaceState(url: string | URL, state: App.PageState): void {
	const entry: InternalHistoryEntry = {
		url: resolveUrl(url).href,
		state: cloneState(state),
		routeGeneration: history[historyIndex].routeGeneration
	};
	history[historyIndex] = entry;
	navigationLog.push({ operation: 'replaceState', ...cloneEntry(entry) });
	publish(entry);
}

/** Move through history, distinguishing shallow state from full route entries. */
export function __go(delta: number): boolean {
	if (!Number.isInteger(delta) || delta === 0) return false;
	const targetIndex = historyIndex + delta;
	if (targetIndex < 0 || targetIndex >= history.length) return false;
	const from = history[historyIndex];
	historyIndex = targetIndex;
	const entry = history[historyIndex];
	navigationLog.push({ operation: 'popstate', ...cloneEntry(entry), delta });
	publish(entry);

	if (from.routeGeneration !== entry.routeGeneration) {
		const navigation = {
			from: buildNavigationTarget(from),
			to: buildNavigationTarget(entry),
			type: 'popstate',
			delta,
			event: new PopStateEvent('popstate'),
			willUnload: false,
			complete: Promise.resolve()
		} as AfterNavigate;
		const callbacks = [...afterNavigateCallbacks];
		queueMicrotask(() => {
			for (const callback of callbacks) {
				if (afterNavigateCallbacks.has(callback)) callback(navigation);
			}
		});
	}
	return true;
}

export function __back(): boolean {
	return __go(-1);
}

export function __forward(): boolean {
	return __go(1);
}

export function __getNavigationLog(): TestNavigationLogEntry[] {
	return navigationLog.map((entry) => ({ ...entry, state: cloneState(entry.state) }));
}

export function __getHistorySnapshot(): TestHistorySnapshot {
	return { entries: history.map(cloneEntry), index: historyIndex };
}

/** Explicit helper for tests of full route navigation only. */
export function __emitAfterNavigate(navigation: AfterNavigate): void {
	for (const callback of afterNavigateCallbacks) callback(navigation);
}

export function __setInitialNavigationType(type: AfterNavigate['type']): void {
	initialNavigationType = type;
}

export function __resetNavigation(
	url: string | URL = 'http://localhost/',
	state: App.PageState = {}
): void {
	__resetTestPage(url, state);
	history = [{ url: page.url.href, state: cloneState(page.state), routeGeneration: 0 }];
	historyIndex = 0;
	nextRouteGeneration = 1;
	navigationLog = [];
	initialNavigationType = 'enter';
	afterNavigateCallbacks.clear();
}
