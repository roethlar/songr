// SvelteKit shallow-navigation stub, modelled on SvelteKit 2's client:
// - pushState/replaceState change the address bar and page.state but never
//   page.url, which keeps naming the route that mounted the page;
// - a Back/Forward moves the address bar and republishes page.url as a fresh
//   URL of the route that mounted that entry, plus the entry's page.state,
//   without afterNavigate for shallow entries;
// - goto is a full navigation: page.url follows it.
import type { AfterNavigate } from '@sveltejs/kit';
import { page, __resetTestPage, __setTestPage, __setTestPageState } from './state.svelte';

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
	/** page.url while this entry was current: the route that mounted it. */
	pageUrl: string;
}

const afterNavigateCallbacks = new Set<(navigation: AfterNavigate) => void>();
let history: InternalHistoryEntry[] = [
	{ url: page.url.href, state: cloneState(page.state), routeGeneration: 0, pageUrl: page.url.href }
];
let historyIndex = 0;
let nextRouteGeneration = 1;
let navigationLog: TestNavigationLogEntry[] = [];
let initialNavigationType: AfterNavigate['type'] = 'enter';
let routerInitialized = true;

function requireRouterInitialized(operation: 'pushState' | 'replaceState'): void {
	if (!routerInitialized) {
		throw new Error(`Cannot call ${operation}(...) before router is initialized`);
	}
}

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

/** Relative to the current entry's address, as the browser resolves it. */
function resolveUrl(url: string | URL): URL {
	const base = history[historyIndex]?.url ?? page.url.href;
	if (url === '') return new URL(base);
	return new URL(url, base);
}

function publish(entry: TestHistoryEntry): void {
	__setTestPage(entry.url, entry.state);
}

/** The address bar, as SvelteKit's history.pushState/replaceState moves it. */
function writeAddress(mutation: 'push' | 'replace', url: string): void {
	if (typeof window === 'undefined' || !window.history) return;
	const target = new URL(url);
	const path = `${target.pathname}${target.search}${target.hash}`;
	if (mutation === 'push') window.history.pushState({}, '', path);
	else window.history.replaceState({}, '', path);
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
	const target = resolveUrl(url).href;
	const entry: InternalHistoryEntry = {
		url: target,
		state: cloneState(options.state ?? {}),
		routeGeneration: nextRouteGeneration++,
		pageUrl: target
	};

	if (options.replaceState) {
		history[historyIndex] = entry;
	} else {
		history = [...history.slice(0, historyIndex + 1), entry];
		historyIndex = history.length - 1;
	}

	navigationLog.push({ operation: 'goto', ...cloneEntry(entry) });
	writeAddress(options.replaceState ? 'replace' : 'push', entry.url);
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
		routerInitialized = true;
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
	requireRouterInitialized('pushState');
	const entry: InternalHistoryEntry = {
		url: resolveUrl(url).href,
		state: cloneState(state),
		routeGeneration: history[historyIndex].routeGeneration,
		pageUrl: page.url.href
	};
	history = [...history.slice(0, historyIndex + 1), entry];
	historyIndex = history.length - 1;
	navigationLog.push({ operation: 'pushState', ...cloneEntry(entry) });
	writeAddress('push', entry.url);
	__setTestPageState(entry.state);
}

export function replaceState(url: string | URL, state: App.PageState): void {
	requireRouterInitialized('replaceState');
	const entry: InternalHistoryEntry = {
		url: resolveUrl(url).href,
		state: cloneState(state),
		routeGeneration: history[historyIndex].routeGeneration,
		pageUrl: page.url.href
	};
	history[historyIndex] = entry;
	navigationLog.push({ operation: 'replaceState', ...cloneEntry(entry) });
	writeAddress('replace', entry.url);
	__setTestPageState(entry.state);
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
	writeAddress('replace', entry.url);
	__setTestPage(entry.pageUrl, entry.state);

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

export function __setRouterInitialized(initialized: boolean): void {
	routerInitialized = initialized;
}

export function __resetNavigation(
	url: string | URL = 'http://localhost/',
	state: App.PageState = {}
): void {
	__resetTestPage(url, state);
	history = [{ url: page.url.href, state: cloneState(page.state), routeGeneration: 0, pageUrl: page.url.href }];
	writeAddress('replace', page.url.href);
	historyIndex = 0;
	nextRouteGeneration = 1;
	navigationLog = [];
	initialNavigationType = 'enter';
	routerInitialized = true;
	afterNavigateCallbacks.clear();
}
