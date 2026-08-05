import { describe, expect, it } from 'vitest';
import { createCapSnapshot, percentile, summarizeQueryTimings } from './metrics';

describe('pure prototype metrics helpers', () => {
	it('calculates deterministic percentiles and timing summaries', () => {
		const timings = [9, 1, 4, 2, 8, 3, 7, 5, 6, 10];
		const summary = summarizeQueryTimings(timings);

		expect(percentile(timings, 0)).toBe(1);
		expect(percentile(timings, 50)).toBe(5.5);
		expect(percentile(timings, 100)).toBe(10);
		expect(summary).toEqual({ count: 10, min: 1, max: 10, mean: 5.5, p50: 5.5, p95: 9.549999999999999 });
		expect(summarizeQueryTimings([])).toEqual({ count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0 });
	});

	it('reports world-object, artwork, and optional DOM cap violations', () => {
		expect(createCapSnapshot({ worldObjects: 72, artworkImages: 40 }).withinCaps).toBe(true);
		const failed = createCapSnapshot(
			{ worldObjects: 73, artworkImages: 41, domNodes: 501 },
			{ worldObjects: 72, artworkImages: 40, domNodes: 500 }
		);

		expect(failed.withinCaps).toBe(false);
		expect(failed.violations).toEqual([
			'world objects 73/72',
			'artwork images 41/40',
			'DOM nodes 501/500'
		]);
	});

	it('rejects invalid metric inputs rather than manufacturing evidence', () => {
		expect(() => percentile([1, 2], 101)).toThrow(RangeError);
		expect(() => percentile([1, Number.NaN], 50)).toThrow(TypeError);
		expect(() => summarizeQueryTimings([1, -1])).toThrow(TypeError);
	});
});
