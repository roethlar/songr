import { pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';
import {
	buildLibraryPageStateEnvelope,
	normalizeLibraryPageStateEnvelope,
	type LibraryPageState
} from '$lib/libraryPageState';
import { persistTimelineSessionPageState } from '$lib/timelinePageSessionState';

let pendingSelfAuthoredFingerprint: string | null = null;

function fingerprint(state: LibraryPageState): string {
	return JSON.stringify(buildLibraryPageStateEnvelope(state));
}

function writeLibraryPageState(
	mutation: 'push' | 'replace',
	state: LibraryPageState,
	options: { readonly persistTimelineSession?: boolean } = {}
): boolean {
	const envelope = buildLibraryPageStateEnvelope(state);
	const current = normalizeLibraryPageStateEnvelope(page.state);
	if (mutation === 'push' && current && fingerprint(current) === fingerprint(state)) {
		return false;
	}
	pendingSelfAuthoredFingerprint = JSON.stringify(envelope);
	try {
		if (mutation === 'push') {
			pushState('', envelope);
		} else {
			replaceState('', envelope);
		}
	} catch (reason) {
		pendingSelfAuthoredFingerprint = null;
		throw reason;
	}
	if (state.libraryView === 'timeline' && options.persistTimelineSession !== false) {
		persistTimelineSessionPageState(state);
	}
	return true;
}

export function pushLibraryPageState(
	state: LibraryPageState,
	options?: { readonly persistTimelineSession?: boolean }
): boolean {
	return writeLibraryPageState('push', state, options);
}

export function replaceLibraryPageState(
	state: LibraryPageState,
	options?: { readonly persistTimelineSession?: boolean }
): boolean {
	return writeLibraryPageState('replace', state, options);
}

/**
 * SvelteKit shallow writes and shallow browser traversal both surface through
 * reactive page.state. The host calls this once for each observed change so a
 * write it just authored is not mistaken for Back/Forward. Only the newest
 * local write remains pending, which also makes rapid writes followed by Back
 * resolve to the actual popped entry rather than a stale suppression token.
 */
export function consumeSelfAuthoredLibraryPageState(value: unknown): boolean {
	const state = normalizeLibraryPageStateEnvelope(value);
	const observedFingerprint = state ? fingerprint(state) : null;
	const matched =
		pendingSelfAuthoredFingerprint !== null &&
		observedFingerprint === pendingSelfAuthoredFingerprint;
	pendingSelfAuthoredFingerprint = null;
	return matched;
}

export function clearPendingLibraryPageStateWrite(): void {
	pendingSelfAuthoredFingerprint = null;
}
