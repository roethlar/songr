import { pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';
import type { UnifiedLibraryPageState } from '$lib/libraryPageState';
import {
	decodeLibraryRoute,
	encodeLibraryRoute,
	type LibraryRoute
} from '$lib/libraryRoute';
import { libraryRouteFromPageState } from '$lib/libraryRouteState';

let pendingSelfAuthoredFingerprint: string | null = null;

export type LibraryPageStateWriteResult = 'pushed' | 'deduped' | 'refused';

/** Plain primary clicks stay in-app; every native link gesture stays native. */
export function shouldHandleLibraryAnchorClick(event: MouseEvent): boolean {
	return (
		!event.defaultPrevented &&
		event.button === 0 &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey
	);
}

export function preflightLibraryPageState(
	state: UnifiedLibraryPageState,
	routeOverride?: LibraryRoute
): string | null {
	const route = routeOverride ?? libraryRouteFromPageState(state);
	if (route === null) return null;
	try {
		return encodeLibraryRoute(route);
	} catch {
		return null;
	}
}

function writeLibraryPageState(
	mutation: 'push' | 'replace',
	state: UnifiedLibraryPageState,
	routeOverride?: LibraryRoute
): LibraryPageStateWriteResult {
	const url = preflightLibraryPageState(state, routeOverride);
	if (url === null) return 'refused';
	const current = decodeLibraryRoute(page.url);
	if (mutation === 'push' && current && encodeLibraryRoute(current) === url) {
		return 'deduped';
	}
	pendingSelfAuthoredFingerprint = url;
	try {
		if (mutation === 'push') {
			pushState(url, {});
		} else {
			replaceState(url, {});
		}
	} catch (reason) {
		pendingSelfAuthoredFingerprint = null;
		throw reason;
	}
	return 'pushed';
}

export function pushLibraryPageState(
	state: UnifiedLibraryPageState,
	routeOverride?: LibraryRoute
): LibraryPageStateWriteResult {
	return writeLibraryPageState('push', state, routeOverride);
}

export function replaceLibraryPageState(
	state: UnifiedLibraryPageState,
	routeOverride?: LibraryRoute
): LibraryPageStateWriteResult {
	return writeLibraryPageState('replace', state, routeOverride);
}

/**
 * SvelteKit shallow writes and shallow browser traversal both surface through
 * reactive page.url. The host calls this once for each observed change so a
 * write it just authored is not mistaken for Back/Forward. Only the newest
 * local write remains pending, which also makes rapid writes followed by Back
 * resolve to the actual popped entry rather than a stale suppression token.
 */
export function consumeSelfAuthoredLibraryPageState(url: URL): boolean {
	const route = decodeLibraryRoute(url);
	const observedFingerprint = route ? encodeLibraryRoute(route) : null;
	const matched =
		pendingSelfAuthoredFingerprint !== null &&
		observedFingerprint === pendingSelfAuthoredFingerprint;
	pendingSelfAuthoredFingerprint = null;
	return matched;
}

export function clearPendingLibraryPageStateWrite(): void {
	pendingSelfAuthoredFingerprint = null;
}
