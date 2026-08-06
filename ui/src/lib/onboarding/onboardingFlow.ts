import type { Zone } from '@shared/types';

/**
 * First-run flow steps.
 *
 * Exactly one thing is ever named to the user: the Roon Core. The engine
 * this UI is served by is not a concept the flow introduces, mentions, or
 * asks the user to think about.
 */
export type OnboardingStep = 'connect' | 'local-playback' | 'complete';

/**
 * `unknown` is the honest pre-answer state and the fail-closed one: until
 * the server says this install has never paired, the flow stays hidden. A
 * failed status fetch must never conjure onboarding in front of somebody
 * who has been using the app for a year.
 */
export type EverPaired = boolean | 'unknown';

export interface OnboardingFlowInput {
	/** From `GET /api/onboarding`, read once per page load. */
	readonly everPaired: EverPaired;
	/** Live Core status, from the `core-status` socket event / `/api/core`. */
	readonly coreStatus: 'discovering' | 'paired' | 'unpaired';
	/** This machine's `os.hostname()`, or null/empty when unknown. */
	readonly hostname: string | null;
	/** Live zone list. */
	readonly zones: readonly Zone[];
	/** Latched once the flow has finished or been skipped in this session. */
	readonly completed: boolean;
}

export interface OnboardingFlowState {
	/** The server says no Core has ever been paired on this install. */
	readonly firstRun: boolean;
	/** The flow owns the screen right now. */
	readonly active: boolean;
	readonly step: OnboardingStep;
	/**
	 * The zone that plays to this computer, once one exists. Non-null only
	 * on the transition into `complete`, which is the single moment the
	 * flow is entitled to choose a zone on the user's behalf.
	 */
	readonly localZoneId: string | null;
}

function normalizeHostLabel(value: string | null | undefined): string {
	if (typeof value !== 'string') return '';
	return value.trim().toLowerCase();
}

/**
 * The bare machine label: mDNS suffix and any domain part removed, so
 * `studio-desk.local` and `studio-desk.lan` both reduce to `studio-desk`.
 * RoonBridge names its output after the machine, but which form of the
 * name each side reports varies by platform and network.
 */
function shortHostLabel(value: string | null | undefined): string {
	const normalized = normalizeHostLabel(value);
	if (!normalized) return '';
	return normalized.replace(/\.$/, '').split('.')[0] ?? '';
}

/**
 * Does this display name name this computer? Case-insensitive, and
 * tolerant of one side carrying a domain suffix the other does not.
 */
export function matchesHostname(
	displayName: string | null | undefined,
	hostname: string | null | undefined
): boolean {
	const host = normalizeHostLabel(hostname);
	const name = normalizeHostLabel(displayName);
	if (!host || !name) return false;
	if (host === name) return true;
	const hostShort = shortHostLabel(host);
	const nameShort = shortHostLabel(name);
	return hostShort.length > 0 && hostShort === nameShort;
}

/**
 * Find the zone that plays to this computer.
 *
 * ONLY outputs are matched, never zone display names (dt5-2): an output's
 * name is the machine-derived name RoonBridge assigns, but a zone's name is
 * whatever the user called a room — a machine named `kitchen` must not
 * auto-select somebody's pre-existing "Kitchen" zone and silently complete
 * the flow against the wrong room. An ungrouped RoonBridge zone is still
 * found through the output it contains; a zones payload with no output
 * data yields no match, which the flow already handles (the step waits or
 * is skipped) — strictly better than wrong-room playback.
 */
export function findLocalZoneId(
	zones: readonly Zone[],
	hostname: string | null | undefined
): string | null {
	if (!normalizeHostLabel(hostname)) return null;
	for (const zone of zones) {
		for (const output of zone.outputs ?? []) {
			if (matchesHostname(output.display_name, hostname)) return zone.zone_id;
		}
	}
	return null;
}

/**
 * Derive the whole flow from observable state. Pure: no store reads, no
 * side effects, no time. The caller owns the two side effects the flow
 * implies — selecting `localZoneId`, and latching `completed`.
 *
 * Ordering matters and encodes the binding rules:
 *  1. Not a first run → nothing, ever. A paired install whose Core is
 *     momentarily unreachable reports `discovering` exactly like a fresh
 *     one, and must not be dragged through onboarding.
 *  2. Latched complete → nothing. Without the latch, a RoonBridge that
 *     drops off the network mid-session would reopen the flow over a
 *     working app.
 *  3. Not paired yet → the Connect step, which advances by itself the
 *     moment pairing lands.
 *  4. Paired and this computer already plays audio → straight to complete,
 *     carrying the zone to select. Nothing to ask.
 *  5. Otherwise → the skippable local-playback step.
 */
export function deriveOnboardingFlow(input: OnboardingFlowInput): OnboardingFlowState {
	const firstRun = input.everPaired === false;
	if (!firstRun) {
		return { firstRun: false, active: false, step: 'complete', localZoneId: null };
	}
	if (input.completed) {
		return { firstRun: true, active: false, step: 'complete', localZoneId: null };
	}
	if (input.coreStatus !== 'paired') {
		return { firstRun: true, active: true, step: 'connect', localZoneId: null };
	}
	const localZoneId = findLocalZoneId(input.zones, input.hostname);
	if (localZoneId) {
		return { firstRun: true, active: false, step: 'complete', localZoneId };
	}
	return { firstRun: true, active: true, step: 'local-playback', localZoneId: null };
}
