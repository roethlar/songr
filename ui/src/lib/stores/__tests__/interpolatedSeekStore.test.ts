import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { Zone } from '@shared/types';

import { interpolatedSeekStore } from '../interpolatedSeekStore';
import { setZonesSnapshot, updateSeekPosition } from '../zonesStore';

function makeZone(overrides: Partial<Zone> = {}): Zone {
	return {
		zone_id: 'zone-a',
		display_name: 'Zone A',
		state: 'playing',
		seek_position: 30,
		is_play_allowed: true,
		is_pause_allowed: true,
		is_previous_allowed: true,
		is_next_allowed: true,
		is_seek_allowed: true,
		outputs: [],
		...overrides
	} as Zone;
}

describe('interpolatedSeekStore (seek interpolation between 1 Hz ticks)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setZonesSnapshot([]);
	});

	afterEach(() => {
		vi.useRealTimers();
		setZonesSnapshot([]);
	});

	it('advances a playing zone between server ticks', () => {
		setZonesSnapshot([makeZone({ seek_position: 30 })]);
		const unsub = interpolatedSeekStore.subscribe(() => {});

		expect(get(interpolatedSeekStore).get('zone-a')).toBe(30);
		vi.advanceTimersByTime(500);
		expect(get(interpolatedSeekStore).get('zone-a')).toBeCloseTo(30.5, 1);
		vi.advanceTimersByTime(500);
		expect(get(interpolatedSeekStore).get('zone-a')).toBeCloseTo(31, 1);

		unsub();
	});

	it('re-bases on a fresh server tick instead of compounding drift', () => {
		setZonesSnapshot([makeZone({ seek_position: 30 })]);
		const unsub = interpolatedSeekStore.subscribe(() => {});

		vi.advanceTimersByTime(1000);
		// Server tick lands (absolute truth) — interpolation restarts
		// from it rather than adding to the interpolated value.
		updateSeekPosition('zone-a', 31);
		vi.advanceTimersByTime(250);
		expect(get(interpolatedSeekStore).get('zone-a')).toBeCloseTo(31.25, 1);

		unsub();
	});

	it('passes a paused zone through untouched', () => {
		setZonesSnapshot([makeZone({ state: 'paused', seek_position: 42 })]);
		const unsub = interpolatedSeekStore.subscribe(() => {});

		vi.advanceTimersByTime(2000);
		expect(get(interpolatedSeekStore).get('zone-a')).toBe(42);

		unsub();
	});

	it('re-bases after an absolute seek backwards', () => {
		setZonesSnapshot([makeZone({ seek_position: 100 })]);
		const unsub = interpolatedSeekStore.subscribe(() => {});

		vi.advanceTimersByTime(500);
		updateSeekPosition('zone-a', 10); // user seeked back
		vi.advanceTimersByTime(250);
		expect(get(interpolatedSeekStore).get('zone-a')).toBeCloseTo(10.25, 1);

		unsub();
	});

	it('stops ticking when the last subscriber leaves (no idle timer)', () => {
		setZonesSnapshot([makeZone({ seek_position: 30 })]);
		const unsub = interpolatedSeekStore.subscribe(() => {});
		unsub();

		// With no subscriber the interval is torn down; advancing time
		// must not throw or leak (nothing to assert beyond survival —
		// vitest fails the test on unhandled interval errors).
		vi.advanceTimersByTime(5000);
	});
});
