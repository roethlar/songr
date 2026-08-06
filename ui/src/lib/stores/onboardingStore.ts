import { writable } from 'svelte/store';
import type { OnboardingStatusResponse } from '@shared/types';
import type { EverPaired } from '$lib/onboarding/onboardingFlow';
import { fetchOnboardingStatus } from '../api/client';

export interface OnboardingStatusState {
	readonly everPaired: EverPaired;
	readonly hostname: string | null;
}

const initialState: OnboardingStatusState = { everPaired: 'unknown', hostname: null };

const internalStore = writable<OnboardingStatusState>(initialState);

export const onboardingStatusStore = {
	subscribe: internalStore.subscribe
};

/**
 * Latched after the first SUCCESSFUL read, and this is load-bearing rather
 * than an optimisation. `everPaired` flips false → true the instant pairing
 * completes; re-reading it — on a reconnect, say, the way
 * `initializeStores` re-reads everything — would yank the flow off the
 * screen mid-run, between "your Core is connected" and the local-playback
 * step the user has not answered yet. The first-run decision is made once
 * per page load, from the state the page loaded into.
 */
let settled = false;
let inFlight: Promise<void> | null = null;

/**
 * Read `GET /api/onboarding`. Safe to call repeatedly: after one success it
 * is a no-op, and while a read is outstanding callers share it.
 *
 * A failed read leaves `everPaired` at `unknown`, which keeps the flow
 * hidden, and does not latch — so a later call may retry. Failing closed is
 * the point: the cost of missing onboarding on a genuinely new install is a
 * user who has to find Settings → Extensions themselves; the cost of the
 * opposite error is an established install taken over by a wizard.
 */
export function loadOnboardingStatus(fetchFn: typeof fetch): Promise<void> {
	if (settled) return Promise.resolve();
	if (inFlight) return inFlight;
	let read: Promise<OnboardingStatusResponse>;
	try {
		read = fetchOnboardingStatus(fetchFn);
	} catch {
		// A synchronous throw is the same answer as a rejection: unknown.
		// This runs from onMount, where an escaping error takes the app
		// shell down with it — and the flow is the least important thing
		// on the screen.
		return Promise.resolve();
	}
	inFlight = read
		.then((status) => {
			settled = true;
			internalStore.set({
				everPaired: status.everPaired,
				hostname: status.hostname ? status.hostname : null
			});
		})
		.catch(() => {
			/* stays `unknown`; the flow stays hidden. */
		})
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

/** Test seam: drops the latch and the cached answer. */
export function resetOnboardingStatus(): void {
	settled = false;
	inFlight = null;
	internalStore.set(initialState);
}
