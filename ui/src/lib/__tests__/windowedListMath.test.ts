import { describe, expect, it } from 'vitest';
import { computeWindow, scrollTopForIndex } from '$lib/windowedListMath';

const base = {
	total: 1000,
	rowHeight: 100,
	columns: 4,
	viewportHeight: 600,
	scrollTop: 0,
	overscan: 2
};

describe('computeWindow', () => {
	it('renders the top slice plus overscan at scroll 0', () => {
		const spec = computeWindow(base);
		expect(spec.start).toBe(0);
		// 6 visible rows + 2 overscan = 8 rows * 4 columns.
		expect(spec.end).toBe(32);
		expect(spec.topPad).toBe(0);
		expect(spec.totalHeight).toBe(250 * 100);
		expect(spec.bottomPad).toBe(spec.totalHeight - 8 * 100);
	});

	it('pads symmetrically mid-scroll and keeps indexes column-aligned', () => {
		const spec = computeWindow({ ...base, scrollTop: 5030 });
		// Row 50 first visible; overscan pulls back to row 48.
		expect(spec.start).toBe(48 * 4);
		expect(spec.end).toBe((50 + 6 + 2) * 4);
		expect(spec.topPad).toBe(48 * 100);
		expect(spec.start % base.columns).toBe(0);
		expect(spec.topPad + (spec.end / 4 - 48) * 100 + spec.bottomPad).toBe(spec.totalHeight);
	});

	it('clamps overscroll past the end without overflowing total', () => {
		const spec = computeWindow({ ...base, scrollTop: 10_000_000 });
		expect(spec.end).toBe(1000);
		expect(spec.bottomPad).toBe(0);
		expect(spec.start).toBeLessThan(1000);
	});

	it('handles ragged final rows', () => {
		const spec = computeWindow({ ...base, total: 1001, scrollTop: 10_000_000 });
		expect(spec.totalHeight).toBe(251 * 100);
		expect(spec.end).toBe(1001);
	});

	it('returns the empty window for zero totals or bad geometry', () => {
		expect(computeWindow({ ...base, total: 0 }).end).toBe(0);
		expect(computeWindow({ ...base, rowHeight: 0 }).totalHeight).toBe(0);
		expect(computeWindow({ ...base, columns: 0 }).end).toBe(0);
	});

	it('never renders negative padding for viewports taller than content', () => {
		const spec = computeWindow({ ...base, total: 8, viewportHeight: 2000 });
		expect(spec.topPad).toBe(0);
		expect(spec.bottomPad).toBe(0);
		expect(spec.end).toBe(8);
	});
});

describe('scrollTopForIndex', () => {
	it('maps an entry index to its row offset', () => {
		expect(scrollTopForIndex(0, base)).toBe(0);
		expect(scrollTopForIndex(3, base)).toBe(0);
		expect(scrollTopForIndex(4, base)).toBe(100);
		expect(scrollTopForIndex(203, base)).toBe(50 * 100);
	});

	it('is safe on degenerate geometry', () => {
		expect(scrollTopForIndex(10, { rowHeight: 0, columns: 4 })).toBe(0);
	});
});
