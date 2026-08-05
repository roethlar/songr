import { describe, expect, it } from 'vitest';
import {
	RuntimeResourceLedger,
	appendTimingSample,
	classifyHeapPrecision,
	maxDomBudgets,
	percentile,
	sampleDomBudgets,
	summarizeFrames
} from './browserMetrics';

describe('browser metrics', () => {
	it('rejects Chromium-style quantized heap samples as coarse evidence', () => {
		expect(classifyHeapPrecision(10_000_000, 10_000_000)).toBe('coarse');
		expect(classifyHeapPrecision(10_234_567, 12_345_678)).toBe('precise');
	});

	it('keeps the whole timing history during a trace and bounds idle samples', () => {
		const samples = Array.from({ length: 300 }, (_, index) => index);
		expect(appendTimingSample(samples, 300, true)).toHaveLength(301);
		expect(appendTimingSample(samples, 300, false)).toEqual(samples.slice(-239).concat(300));
	});

	it('uses nearest-rank percentiles and reports long frames', () => {
		expect(percentile([20, 5, 15, 10], 0.5)).toBe(10);
		expect(percentile([20, 5, 15, 10], 0.95)).toBe(20);
		expect(summarizeFrames([16, 18, 120])).toMatchObject({
			sampleCount: 3,
			p50Ms: 18,
			p95Ms: 120,
			maxMs: 120,
			over100Ms: 1
		});
	});

	it('counts only mounted world objects and artwork with assigned sources', () => {
		const root = document.createElement('div');
		root.innerHTML = `
			<article data-world-object></article>
			<article data-world-object></article>
			<img data-artwork src="/artwork/cover-01.png" alt="" />
			<img data-artwork alt="" />
			<path data-connector></path>
		`;

		expect(sampleDomBudgets(root)).toMatchObject({
			worldObjects: 2,
			artworkImages: 1,
			connectors: 1
		});
	});

	it('tracks peak DOM budgets and idempotent resource release', () => {
		expect(
			maxDomBudgets([
				{ worldObjects: 4, artworkImages: 3, connectors: 1, totalElements: 20 },
				{ worldObjects: 7, artworkImages: 2, connectors: 4, totalElements: 18 }
			])
		).toEqual({ worldObjects: 7, artworkImages: 3, connectors: 4, totalElements: 20 });

		const ledger = new RuntimeResourceLedger();
		const release = ledger.acquire('observers');
		expect(ledger.hasRetainedResources()).toBe(true);
		release();
		release();
		expect(ledger.snapshot().observers).toBe(0);
		expect(ledger.hasRetainedResources()).toBe(false);
	});
});
