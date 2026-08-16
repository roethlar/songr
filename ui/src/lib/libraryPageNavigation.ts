import { pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';
import {
	buildLibraryPageStateEnvelope,
	normalizeLibraryPageStateEnvelope,
	type LibraryPageState
} from '$lib/libraryPageState';

let pendingSelfAuthoredFingerprint: string | null = null;

function fingerprint(state: LibraryPageState): string {
	return JSON.stringify(buildLibraryPageStateEnvelope(state));
}

function writeLibraryPageState(mutation: 'push' | 'replace', state: LibraryPageState): boolean {
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
	return true;
}

export function pushLibraryPageState(state: LibraryPageState): boolean {
	return writeLibraryPageState('push', state);
}

export function replaceLibraryPageState(state: LibraryPageState): boolean {
	return writeLibraryPageState('replace', state);
}

/**
 * Arms the same one-shot suppression for a self-initiated history
 * TRAVERSAL: an in-page Back over an entry the mode pushed calls
 * `history.back()` while it already shows the destination state, so the
 * arriving pop must not trigger a teardown restore (ri8-1). A
 * fingerprint mismatch — entry noise drifted since the push — falls
 * through to the normal pop path, which restores the same destination
 * the slow way.
 */
export function expectSelfAuthoredLibraryPageState(state: LibraryPageState): void {
	pendingSelfAuthoredFingerprint = fingerprint(state);
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
