import { describe, expect, it } from 'vitest';
import type { Zone } from '@shared/types';

import {
	deriveOnboardingFlow,
	findLocalZoneId,
	matchesHostname,
	type OnboardingFlowInput
} from '../onboardingFlow';

function zone(overrides: Partial<Zone> & Pick<Zone, 'zone_id' | 'display_name'>): Zone {
	return {
		state: 'stopped',
		is_play_allowed: true,
		is_pause_allowed: false,
		is_previous_allowed: false,
		is_next_allowed: false,
		is_seek_allowed: false,
		outputs: [],
		...overrides
	} as Zone;
}

function input(overrides: Partial<OnboardingFlowInput> = {}): OnboardingFlowInput {
	return {
		everPaired: false,
		coreStatus: 'discovering',
		hostname: 'studio-desk',
		zones: [],
		completed: false,
		...overrides
	};
}

describe('matchesHostname', () => {
	it('matches case-insensitively', () => {
		expect(matchesHostname('Studio-Desk', 'studio-desk')).toBe(true);
		expect(matchesHostname('studio-desk', 'STUDIO-DESK')).toBe(true);
	});

	it('matches across a domain or mDNS suffix on either side', () => {
		expect(matchesHostname('studio-desk', 'studio-desk.local')).toBe(true);
		expect(matchesHostname('studio-desk.local', 'studio-desk')).toBe(true);
		expect(matchesHostname('studio-desk.lan', 'studio-desk.local')).toBe(true);
	});

	it('ignores surrounding whitespace', () => {
		expect(matchesHostname('  studio-desk ', 'studio-desk')).toBe(true);
	});

	it('does not match a different machine, a prefix, or an empty side', () => {
		expect(matchesHostname('kitchen', 'studio-desk')).toBe(false);
		expect(matchesHostname('studio', 'studio-desk')).toBe(false);
		expect(matchesHostname('studio-desk-2', 'studio-desk')).toBe(false);
		expect(matchesHostname('', 'studio-desk')).toBe(false);
		expect(matchesHostname('studio-desk', '')).toBe(false);
		expect(matchesHostname('studio-desk', null)).toBe(false);
	});
});

describe('findLocalZoneId', () => {
	it('finds a zone whose output carries the machine name', () => {
		const zones = [
			zone({ zone_id: 'z-kitchen', display_name: 'Kitchen' }),
			zone({
				zone_id: 'z-local',
				display_name: 'Kitchen + Studio Desk',
				outputs: [
					{ output_id: 'o-kitchen', display_name: 'Kitchen' },
					{ output_id: 'o-local', display_name: 'studio-desk' }
				]
			})
		];
		expect(findLocalZoneId(zones, 'studio-desk')).toBe('z-local');
	});

	it('never matches on zone display names, only outputs (dt5-2)', () => {
		// A zone name is a room name the user typed; a machine called
		// "kitchen" must not adopt somebody's pre-existing Kitchen zone.
		const rooms = [zone({ zone_id: 'z-kitchen', display_name: 'Kitchen' })];
		expect(findLocalZoneId(rooms, 'kitchen')).toBeNull();
		// Even an exact name match without output evidence stays unmatched.
		const named = [zone({ zone_id: 'z-name-only', display_name: 'STUDIO-DESK' })];
		expect(findLocalZoneId(named, 'studio-desk.local')).toBeNull();
	});

	it('returns null when nothing names this machine, or the name is unknown', () => {
		const zones = [zone({ zone_id: 'z-kitchen', display_name: 'Kitchen' })];
		expect(findLocalZoneId(zones, 'studio-desk')).toBeNull();
		expect(findLocalZoneId(zones, null)).toBeNull();
		expect(findLocalZoneId([], 'studio-desk')).toBeNull();
	});
});

describe('deriveOnboardingFlow', () => {
	it('shows the Connect step on a first run that has not paired yet', () => {
		expect(deriveOnboardingFlow(input())).toEqual({
			firstRun: true,
			active: true,
			step: 'connect',
			localZoneId: null
		});
	});

	it('stays hidden while the first-run answer is still unknown', () => {
		expect(deriveOnboardingFlow(input({ everPaired: 'unknown' }))).toEqual({
			firstRun: false,
			active: false,
			step: 'complete',
			localZoneId: null
		});
	});

	it('never shows for an install that has paired before, whatever the Core is doing', () => {
		for (const coreStatus of ['discovering', 'paired', 'unpaired'] as const) {
			const state = deriveOnboardingFlow(input({ everPaired: true, coreStatus }));
			expect(state.active).toBe(false);
			expect(state.firstRun).toBe(false);
		}
	});

	it('advances to the local-playback step by itself when pairing lands', () => {
		const before = deriveOnboardingFlow(input({ coreStatus: 'discovering' }));
		const after = deriveOnboardingFlow(input({ coreStatus: 'paired' }));
		expect(before.step).toBe('connect');
		expect(after).toEqual({
			firstRun: true,
			active: true,
			step: 'local-playback',
			localZoneId: null
		});
	});

	it('holds on the Connect step when a paired Core drops back to unpaired', () => {
		expect(deriveOnboardingFlow(input({ coreStatus: 'unpaired' })).step).toBe('connect');
	});

	it('skips local playback entirely when this computer is already a zone', () => {
		const zones = [
			zone({
				zone_id: 'z-local',
				display_name: 'Studio Desk',
				outputs: [{ output_id: 'o-local', display_name: 'studio-desk' }]
			})
		];
		expect(deriveOnboardingFlow(input({ coreStatus: 'paired', zones }))).toEqual({
			firstRun: true,
			active: false,
			step: 'complete',
			localZoneId: 'z-local'
		});
	});

	it('auto-advances out of the local-playback step when the zone appears', () => {
		const waiting = deriveOnboardingFlow(input({ coreStatus: 'paired', zones: [] }));
		expect(waiting.step).toBe('local-playback');
		expect(waiting.active).toBe(true);

		const arrived = deriveOnboardingFlow(
			input({
				coreStatus: 'paired',
				zones: [
					zone({
						zone_id: 'z-local',
						display_name: 'studio-desk',
						outputs: [{ output_id: 'o-local', display_name: 'studio-desk' }]
					})
				]
			})
		);
		expect(arrived.active).toBe(false);
		expect(arrived.localZoneId).toBe('z-local');
	});

	it('stays closed once completed, and carries no zone to adopt a second time', () => {
		const zones = [zone({ zone_id: 'z-local', display_name: 'studio-desk' })];
		const state = deriveOnboardingFlow(
			input({ coreStatus: 'paired', zones, completed: true })
		);
		expect(state).toEqual({
			firstRun: true,
			active: false,
			step: 'complete',
			localZoneId: null
		});
	});

	it('does not reopen after a skip, nor after the local zone disappears again', () => {
		expect(
			deriveOnboardingFlow(input({ coreStatus: 'paired', zones: [], completed: true })).active
		).toBe(false);
		expect(
			deriveOnboardingFlow(input({ coreStatus: 'discovering', completed: true })).active
		).toBe(false);
	});
});
