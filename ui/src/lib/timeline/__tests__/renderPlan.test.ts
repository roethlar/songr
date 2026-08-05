import { describe, expect, it, vi } from 'vitest';
import { createTimelineCanvasModel, type TimelineCanvasModel } from '../canvasModel';
import { fitCamera } from '../geometry';
import {
	MAX_TIMELINE_ARTWORK_IMAGES,
	MAX_TIMELINE_WORLD_OBJECTS,
	MAX_VISIBLE_TIMELINE_TICKS,
	TimelineRenderPlanner,
	compareTimelineChronology,
	type TimelineRenderPlanOptions
} from '../renderPlan';
import type { Camera, ScreenViewport, TimelineAlbumEntity } from '../types';
import { calendarAlbum, denseAlbums, undatedAlbum } from './fixtures';

function createTimelineRenderPlan(
	model: TimelineCanvasModel,
	camera: Camera,
	viewport: ScreenViewport,
	options: TimelineRenderPlanOptions = {}
) {
	return new TimelineRenderPlanner(model).createPlan(camera, viewport, options);
}

function encompassingViewport(model: ReturnType<typeof createTimelineCanvasModel>): ScreenViewport {
	return {
		x: 0,
		y: 0,
		width: Math.max(1, model.bounds.width + 1_000),
		height: Math.max(1, model.bounds.height + 1_000)
	};
}

function centeredCamera(
	model: ReturnType<typeof createTimelineCanvasModel>,
	scale: number
): Camera {
	return {
		centerX: model.bounds.x + model.bounds.width / 2,
		centerY: model.bounds.y + model.bounds.height / 2,
		scale
	};
}

function objectBounds(plan: ReturnType<typeof createTimelineRenderPlan>) {
	return plan.objects.map((object) => {
		if (object.kind === 'cluster') {
			return {
				x: object.x - object.width / 2,
				y: object.y - object.height / 2,
				width: object.width,
				height: object.height
			};
		}
		return {
			x: object.entity.x - object.entity.width / 2,
			y: object.entity.y - object.entity.height / 2,
			width: object.entity.width,
			height: object.entity.height
		};
	});
}

function expectNoRenderObjectOverlap(plan: ReturnType<typeof createTimelineRenderPlan>): void {
	const bounds = objectBounds(plan);
	for (let leftIndex = 0; leftIndex < bounds.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < bounds.length; rightIndex += 1) {
			const left = bounds[leftIndex];
			const right = bounds[rightIndex];
			const overlaps = !(
				left.x + left.width <= right.x ||
				right.x + right.width <= left.x ||
				left.y + left.height <= right.y ||
				right.y + right.height <= left.y
			);
			expect(overlaps).toBe(false);
		}
	}
}

describe('bounded Timeline render planning', () => {
	it('conserves every one of 4,541 intersecting albums through temporal clusters', () => {
		const model = createTimelineCanvasModel(denseAlbums(4_541));
		const plan = createTimelineRenderPlan(
			model,
			centeredCamera(model, 0.5),
			encompassingViewport(model)
		);
		const representedIds = plan.objects.flatMap((object) => object.memberIds);

		expect(plan.tier).toBe('overview');
		expect(plan.counts.intersectingAlbums).toBe(4_541);
		expect(plan.counts.worldObjects).toBeLessThanOrEqual(MAX_TIMELINE_WORLD_OBJECTS);
		expect(plan.counts.clusterObjects).toBeGreaterThan(0);
		expect(plan.counts.artworkImages).toBe(0);
		expect(plan.artworkIds).toEqual([]);
		expect(plan.accounting).toEqual({
			expectedIntersectingAlbums: 4_541,
			representedIntersectingAlbums: 4_541,
			complete: true
		});
		expect(representedIds).toHaveLength(4_541);
		expect(new Set(representedIds)).toHaveLength(4_541);
	});

	it('caps navigation artwork while clustering every overflow album', () => {
		const model = createTimelineCanvasModel(denseAlbums(400));
		const plan = createTimelineRenderPlan(
			model,
			centeredCamera(model, 1),
			encompassingViewport(model)
		);

		expect(plan.tier).toBe('navigation');
		expect(plan.counts.worldObjects).toBeLessThanOrEqual(MAX_TIMELINE_WORLD_OBJECTS);
		expect(plan.counts.artworkImages).toBe(MAX_TIMELINE_ARTWORK_IMAGES);
		expect(plan.counts.clusteredAlbums).toBeGreaterThan(0);
		expect(plan.accounting.complete).toBe(true);
	});

	it('pins one album outside ordinary viewport culling without double-counting', () => {
		const model = createTimelineCanvasModel(denseAlbums(120));
		const visible = model.entities[0];
		const pinned = model.entities.at(-1)!;
		const viewport: ScreenViewport = { x: 0, y: 0, width: 500, height: 320 };
		const camera: Camera = { centerX: visible.x, centerY: visible.y, scale: 2 };
		const withoutPin = createTimelineRenderPlan(model, camera, viewport);
		const withPin = createTimelineRenderPlan(model, camera, viewport, { pinnedId: pinned.id });

		expect(withoutPin.objects.some(({ id }) => id === pinned.id)).toBe(false);
		expect(withPin.objects.find(({ id }) => id === pinned.id)).toMatchObject({ pinned: true });
		expect(withPin.counts.pinnedOutsideViewport).toBe(1);
		expect(withPin.accounting.complete).toBe(true);
		expect(withPin.counts.worldObjects).toBeLessThanOrEqual(MAX_TIMELINE_WORLD_OBJECTS);
	});

	it('reserves one world-object slot for an attached detail slab', () => {
		const model = createTimelineCanvasModel(denseAlbums(400));
		const plan = createTimelineRenderPlan(
			model,
			centeredCamera(model, 1),
			encompassingViewport(model),
			{ reservedWorldObjects: 1, reservedArtworkImages: 1 }
		);

		expect(plan.counts.worldObjects).toBeLessThanOrEqual(MAX_TIMELINE_WORLD_OBJECTS - 1);
		expect(plan.counts.artworkImages).toBeLessThanOrEqual(MAX_TIMELINE_ARTWORK_IMAGES - 1);
		expect(plan.accounting.complete).toBe(true);
	});

	it('samples only visible axis ticks and keeps the endpoints deterministic', () => {
		const albums = Array.from({ length: 100 }, (_, index) =>
			calendarAlbum(`year-${index}`, 1900 + index, index)
		);
		const model = createTimelineCanvasModel(albums);
		const plan = createTimelineRenderPlan(
			model,
			centeredCamera(model, 1),
			encompassingViewport(model)
		);

		expect(plan.visibleYearAnchors).toHaveLength(MAX_VISIBLE_TIMELINE_TICKS);
		expect(plan.visibleYearAnchors[0].year).toBe(1900);
		expect(plan.visibleYearAnchors.at(-1)?.year).toBe(1999);
	});

	it('autofits a sparse long-span discography without culling every album', () => {
		const model = createTimelineCanvasModel([
			calendarAlbum('early', 1960, 0),
			calendarAlbum('late', 2025, 1)
		]);
		const viewport: ScreenViewport = { x: 0, y: 0, width: 1_400, height: 900 };
		const camera = fitCamera(model.bounds, viewport, { padding: 150, maxScale: 1.18 });
		const plan = createTimelineRenderPlan(model, camera, viewport);

		expect(plan.objects.flatMap((object) => object.memberIds)).toEqual(['early', 'late']);
		expect(plan.accounting.complete).toBe(true);
	});

	it('produces identical clusters for identical model and camera inputs', () => {
		const albums = denseAlbums(500);
		const firstModel = createTimelineCanvasModel(albums);
		const secondModel = createTimelineCanvasModel([...albums].reverse());
		const first = createTimelineRenderPlan(
			firstModel,
			centeredCamera(firstModel, 0.5),
			encompassingViewport(firstModel)
		);
		const second = createTimelineRenderPlan(
			secondModel,
			centeredCamera(secondModel, 0.5),
			encompassingViewport(secondModel)
		);

		expect(second.objects).toEqual(first.objects);
	});

	it('orders cluster members by chronology rather than visual coordinates', () => {
		const inputs = [
			...Array.from({ length: 15 }, (_, index) =>
				calendarAlbum(`same-${String(index).padStart(2, '0')}`, 2000, index)
			),
			calendarAlbum('next-year', 2001, 15),
			undatedAlbum('unknown-year', 16)
		];
		const model = createTimelineCanvasModel([...inputs].reverse());
		const expectedIds = [
			...Array.from({ length: 15 }, (_, index) => `same-${String(index).padStart(2, '0')}`),
			'next-year',
			'unknown-year'
		];
		const visuallyScrambled = model.entities.map((entity, index) => ({
			...entity,
			x: (model.entities.length - index) * 1_000
		})) as TimelineAlbumEntity[];

		expect(visuallyScrambled.sort(compareTimelineChronology).map(({ id }) => id)).toEqual(
			expectedIds
		);

		const plan = createTimelineRenderPlan(
			model,
			centeredCamera(model, 0.5),
			encompassingViewport(model)
		);
		expect(plan.objects.flatMap((object) => object.memberIds)).toEqual(expectedIds);
	});

	it('places overview and navigation clusters without covering other render objects', () => {
		const annual = Array.from({ length: 100 }, (_, index) =>
			calendarAlbum(`annual-${index}`, 1900 + index, index, { image: true })
		);
		const sameYear = Array.from({ length: 240 }, (_, index) =>
			calendarAlbum(`same-year-${index}`, 2000, index, { image: true })
		);

		for (const inputs of [annual, sameYear]) {
			const model = createTimelineCanvasModel(inputs);
			const viewport = encompassingViewport(model);
			const overview = createTimelineRenderPlan(model, centeredCamera(model, 0.5), viewport);
			const navigation = createTimelineRenderPlan(model, centeredCamera(model, 1), viewport);

			expect(overview.counts.clusterObjects).toBeGreaterThan(1);
			expect(navigation.counts.clusterObjects).toBeGreaterThan(0);
			expectNoRenderObjectOverlap(overview);
			expectNoRenderObjectOverlap(navigation);
		}
	});

	it('reuses overscan results until the inner window or hysteretic tier is crossed', () => {
		const model = createTimelineCanvasModel(denseAlbums(120));
		const viewport: ScreenViewport = { x: 0, y: 0, width: 1_400, height: 900 };
		const query = vi.spyOn(model.index, 'query');
		const planner = new TimelineRenderPlanner(model);
		const centered: Camera = { centerX: 0, centerY: 0, scale: 0.5 };

		expect(planner.createPlan(centered, viewport).tier).toBe('overview');
		expect(query).toHaveBeenCalledTimes(1);
		expect(planner.createPlan({ ...centered, centerX: 100 }, viewport).tier).toBe('overview');
		expect(query).toHaveBeenCalledTimes(1);
		expect(planner.createPlan({ ...centered, centerX: 800 }, viewport).tier).toBe('overview');
		expect(query).toHaveBeenCalledTimes(2);

		expect(planner.createPlan({ ...centered, scale: 0.8 }, viewport).tier).toBe('overview');
		expect(planner.createPlan({ ...centered, scale: 0.85 }, viewport).tier).toBe('navigation');
		expect(query).toHaveBeenCalledTimes(3);
	});
});
