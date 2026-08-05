import { describe, expect, it } from 'vitest';
import { createScenario } from '../fixtures';
import type { Camera, ScreenViewport } from './types';
import {
	MAX_PINNED_OBJECTS,
	MAX_RENDERED_ARTWORK_IMAGES,
	MAX_RENDERED_WORLD_OBJECTS,
	createRenderPlan
} from './render-planner';
import { createWorkspace } from './workspace';

function encompassingViewport(width: number, height: number): ScreenViewport {
	return { x: 0, y: 0, width: Math.max(1, width + 500), height: Math.max(1, height + 500) };
}

describe('bounded render planner', () => {
	it('conserves every intersecting stress entity through individuals or count-bearing clusters', () => {
		const stress = createScenario('stress');
		const workspace = createWorkspace({ ...stress, branches: [] });
		const viewport = encompassingViewport(workspace.bounds.width, workspace.bounds.height);
		const camera: Camera = {
			centerX: workspace.bounds.x + workspace.bounds.width / 2,
			centerY: workspace.bounds.y + workspace.bounds.height / 2,
			scale: 1
		};
		const plan = createRenderPlan(workspace, camera, viewport, []);
		const representedIds = plan.objects.flatMap((object) => object.memberIds);

		expect(plan.counts.intersectingEntities).toBe(4_541);
		expect(MAX_RENDERED_WORLD_OBJECTS).toBe(72);
		expect(MAX_RENDERED_ARTWORK_IMAGES).toBe(40);
		expect(plan.counts.worldObjects).toBeLessThanOrEqual(72);
		expect(plan.counts.artworkImages).toBeLessThanOrEqual(40);
		expect(plan.counts.clusterObjects).toBeGreaterThan(0);
		expect(plan.accounting).toEqual({
			expectedIntersectingEntities: 4_541,
			representedIntersectingEntities: 4_541,
			complete: true
		});
		expect(representedIds).toHaveLength(4_541);
		expect(new Set(representedIds)).toHaveLength(4_541);
	});

	it('requests no artwork at overview tier while retaining complete accounting', () => {
		const workspace = createWorkspace('large');
		const viewport = encompassingViewport(workspace.bounds.width, workspace.bounds.height);
		const plan = createRenderPlan(
			workspace,
			{
				centerX: workspace.bounds.x + workspace.bounds.width / 2,
				centerY: workspace.bounds.y + workspace.bounds.height / 2,
				scale: 0.5
			},
			viewport,
			[]
		);

		expect(plan.tier).toBe('overview');
		expect(plan.artworkIds).toEqual([]);
		expect(plan.counts.artworkImages).toBe(0);
		expect(plan.accounting.complete).toBe(true);
	});

	it('pins one selected, focused, or dragged object outside ordinary culling', () => {
		const workspace = createWorkspace('large');
		const visible = workspace.entities[0];
		const pinned = workspace.entities.at(-1)!;
		const viewport: ScreenViewport = { x: 0, y: 0, width: 500, height: 320 };
		const camera: Camera = { centerX: visible.x, centerY: visible.y, scale: 2 };
		const withoutPin = createRenderPlan(workspace, camera, viewport, []);
		const withPin = createRenderPlan(workspace, camera, viewport, [pinned.id]);

		expect(MAX_PINNED_OBJECTS).toBe(1);
		expect(withoutPin.objects.some((object) => object.id === pinned.id)).toBe(false);
		expect(withPin.objects.find((object) => object.id === pinned.id)?.pinned).toBe(true);
		expect(withPin.counts.pinnedOutsideViewport).toBe(1);
		expect(withPin.accounting.complete).toBe(true);
		expect(() => createRenderPlan(workspace, camera, viewport, [visible.id, pinned.id])).toThrow(
			/At most 1/
		);
	});

	it('lays out identical fixture inputs deterministically', () => {
		const first = createWorkspace('large').entities.map(({ id, x, y, year }) => ({ id, x, y, year }));
		const second = createWorkspace('large').entities.map(({ id, x, y, year }) => ({ id, x, y, year }));

		expect(second).toEqual(first);
	});

	it('places missing original-release evidence in an explicit Undated tail', () => {
		const baseAlbums = createWorkspace('medium').entities.filter((entity) => entity.kind === 'album');
		const known = baseAlbums.filter((entity) => entity.year !== null);
		const undated = baseAlbums.filter((entity) => entity.year === null);

		expect(undated.length).toBeGreaterThan(0);
		expect(undated.every((entity) => entity.subtitle === 'Undated')).toBe(true);
		expect(Math.min(...undated.map((entity) => entity.x))).toBeGreaterThan(
			Math.max(...known.map((entity) => entity.x))
		);
	});

	it('exposes the recorded logical catalog counts independently of visible working-set size', () => {
		const workspace = createWorkspace('small');

		expect(workspace.logicalCatalogCounts).toEqual({ artists: 1_671, albums: 3_896 });
		expect(workspace.scenario.albums).toHaveLength(1);
	});
});
