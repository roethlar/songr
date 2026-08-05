import { describe, expect, it } from 'vitest';
import { createScenario } from '../fixtures';
import { createWorkspace } from './workspace';
import {
	SPATIAL_INDEX_CELL_SIZE,
	UniformGridSpatialIndex,
	bruteForceSpatialQuery,
	type SpatialItem
} from './spatial-index';
import type { Rect } from './types';

describe('uniform-grid spatial index', () => {
	it('uses the planned 512-world-pixel cells', () => {
		expect(new UniformGridSpatialIndex().cellSize).toBe(512);
		expect(SPATIAL_INDEX_CELL_SIZE).toBe(512);
	});

	it('matches brute force across the deterministic 4,541-object stress fixture', () => {
		const stress = createScenario('stress');
		const workspace = createWorkspace({ ...stress, branches: [] });
		const items: SpatialItem[] = workspace.entities.map((entity) => ({
			id: entity.id,
			bounds: {
				x: entity.x - entity.width / 2,
				y: entity.y - entity.height / 2,
				width: entity.width,
				height: entity.height
			}
		}));
		const queries: Rect[] = [
			{ x: -1_000, y: -1_000, width: 2_000, height: 2_000 },
			{ x: 3_500, y: -4_000, width: 4_200, height: 8_000 },
			{ x: workspace.bounds.x - 10, y: workspace.bounds.y - 10, width: 740, height: 600 },
			{
				x: workspace.bounds.x,
				y: workspace.bounds.y,
				width: workspace.bounds.width,
				height: workspace.bounds.height
			}
		];

		expect(workspace.scenario.albums).toHaveLength(4_541);
		expect(workspace.entities).toHaveLength(4_541);
		for (const query of queries) {
			expect(workspace.index.query(query).map((item) => item.id)).toEqual(
				bruteForceSpatialQuery(items, query).map((item) => item.id)
			);
		}
	});

	it('supports replacement and removal without leaving stale buckets', () => {
		const index = new UniformGridSpatialIndex<SpatialItem>();
		index.insert({ id: 'one', bounds: { x: 0, y: 0, width: 10, height: 10 } });
		index.insert({ id: 'one', bounds: { x: 2_000, y: 2_000, width: 10, height: 10 } });

		expect(index.query({ x: -20, y: -20, width: 50, height: 50 })).toEqual([]);
		expect(index.query({ x: 1_990, y: 1_990, width: 50, height: 50 }).map((item) => item.id)).toEqual([
			'one'
		]);
		expect(index.remove('one')).toBe(true);
		expect(index.size).toBe(0);
	});
});
