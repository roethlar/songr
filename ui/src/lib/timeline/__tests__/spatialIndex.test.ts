import { describe, expect, it } from 'vitest';
import {
	TIMELINE_SPATIAL_CELL_SIZE,
	UniformGridSpatialIndex,
	type SpatialItem
} from '../spatialIndex';
import type { Rect } from '../types';

function bruteForceSpatialQuery(items: readonly SpatialItem[], bounds: Rect): SpatialItem[] {
	return items
		.filter((item) => (
			item.bounds.x <= bounds.x + bounds.width &&
			item.bounds.x + item.bounds.width >= bounds.x &&
			item.bounds.y <= bounds.y + bounds.height &&
			item.bounds.y + item.bounds.height >= bounds.y
		))
		.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function stressItems(): SpatialItem[] {
	return Array.from({ length: 4_541 }, (_, index) => ({
		id: `item-${String(index).padStart(5, '0')}`,
		bounds: {
			x: (index % 97) * 143 - 4_000,
			y: Math.floor(index / 97) * 119 - 2_500,
			width: 132,
			height: 104
		}
	}));
}

describe('production Timeline uniform-grid spatial index', () => {
	it('uses the planned 512-world-pixel cells', () => {
		expect(TIMELINE_SPATIAL_CELL_SIZE).toBe(512);
		expect(new UniformGridSpatialIndex().cellSize).toBe(512);
	});

	it('matches brute force across a deterministic 4,541-item fixture', () => {
		const items = stressItems();
		const index = new UniformGridSpatialIndex<SpatialItem>();
		for (const item of items) index.insert(item);
		const queries: Rect[] = [
			{ x: -1_000, y: -1_000, width: 2_000, height: 2_000 },
			{ x: 3_500, y: -4_000, width: 4_200, height: 8_000 },
			{ x: -4_010, y: -2_510, width: 740, height: 600 },
			{ x: -4_000, y: -2_500, width: 15_000, height: 8_000 }
		];

		expect(index.size).toBe(4_541);
		for (const query of queries) {
			expect(index.query(query).map(({ id }) => id)).toEqual(
				bruteForceSpatialQuery(items, query).map(({ id }) => id)
			);
		}
	});

	it('snapshots inserted bounds and removes replacement buckets exactly', () => {
		const mutable: SpatialItem = { id: 'one', bounds: { x: 0, y: 0, width: 10, height: 10 } };
		const index = new UniformGridSpatialIndex<SpatialItem>();
		index.insert(mutable);
		mutable.bounds.x = 3_000;

		expect(index.query({ x: -20, y: -20, width: 50, height: 50 }).map(({ id }) => id)).toEqual([
			'one'
		]);
		index.insert({ id: 'one', bounds: { x: 2_000, y: 2_000, width: 10, height: 10 } });
		expect(index.query({ x: -20, y: -20, width: 50, height: 50 })).toEqual([]);
		expect(index.query({ x: 1_990, y: 1_990, width: 50, height: 50 }).map(({ id }) => id)).toEqual([
			'one'
		]);
		expect(index.remove('one')).toBe(true);
		expect(index.size).toBe(0);
	});

	it('falls back to bounded linear filtering for enormous queries', () => {
		const index = new UniformGridSpatialIndex<SpatialItem>();
		index.insert({ id: 'left', bounds: { x: -10, y: -10, width: 20, height: 20 } });
		index.insert({ id: 'right', bounds: { x: 10_000, y: 10_000, width: 20, height: 20 } });

		expect(
			index
				.query({ x: -20_000_000, y: -20_000_000, width: 40_000_000, height: 40_000_000 })
				.map(({ id }) => id)
		).toEqual(['left', 'right']);
	});

	it('rejects invalid cell and item geometry before replacing good state', () => {
		expect(() => new UniformGridSpatialIndex(0)).toThrow(/positive/);
		const index = new UniformGridSpatialIndex<SpatialItem>();
		index.insert({ id: 'kept', bounds: { x: 0, y: 0, width: 10, height: 10 } });
		expect(() =>
			index.insert({ id: 'kept', bounds: { x: 0, y: 0, width: 512 * 300, height: 10 } })
		).toThrow(/at most/);
		expect(index.get('kept')).toBeDefined();
	});

	it('rejects huge finite coordinates before a cell loop can stop advancing', () => {
		const index = new UniformGridSpatialIndex<SpatialItem>();
		const huge = (Number.MAX_SAFE_INTEGER + 1) * TIMELINE_SPATIAL_CELL_SIZE;

		expect(() =>
			index.insert({ id: 'unsafe-cell', bounds: { x: huge, y: 0, width: 10, height: 10 } })
		).toThrow(/safe integers/);
		expect(() => index.query({ x: -huge, y: 0, width: 10, height: 10 })).toThrow(
			/safe integers/
		);
		expect(index.size).toBe(0);
	});
});
