import { pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';
import type { UnifiedLibraryPageState } from '$lib/libraryPageState';
import {
	decodeLibraryRoute,
	encodeLibraryRoute,
	type LibraryRoute
} from '$lib/libraryRoute';
import { libraryRouteFromPageState } from '$lib/libraryRouteState';

/**
 * The Library address the view currently shows, as a canonical route
 * fingerprint. SvelteKit's shallow pushState/replaceState change the address
 * bar and page.state but never page.url, which keeps naming the route that
 * mounted the host until a Back/Forward republishes it. So page.url cannot say
 * where the view is; this record does. Every successful write and every
 * activation the host commits sets it; Back/Forward detection and the push
 * dedupe compare against it.
 */
let shownFingerprint: string | null = null;

function routeFingerprint(url: URL): string | null {
	const route = decodeLibraryRoute(url);
	return route ? encodeLibraryRoute(route) : null;
}

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
	const shown = shownFingerprint ?? routeFingerprint(page.url);
	if (mutation === 'push' && shown === url) return 'deduped';
	if (mutation === 'push') {
		pushState(url, {});
	} else {
		replaceState(url, {});
	}
	shownFingerprint = url;
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

/** The host records the address of every activation it commits. */
export function recordShownLibraryAddress(url: URL): void {
	shownFingerprint = routeFingerprint(url);
}

/**
 * Back/Forward detection. Called when SvelteKit republishes page.url (it does
 * on every history traversal, never on the app's own shallow writes) with the
 * address bar's URL: true when that address is not what the view shows, in
 * which case it becomes the shown address and the caller restores it.
 */
export function libraryAddressNeedsRestore(url: URL): boolean {
	const fingerprint = routeFingerprint(url);
	if (fingerprint === shownFingerprint) return false;
	shownFingerprint = fingerprint;
	return true;
}

export function clearShownLibraryAddress(): void {
	shownFingerprint = null;
}
