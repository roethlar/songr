import { describe, expect, it } from 'vitest';

import { createTimelineCanvasModel } from '../canvasModel';
import {
	TIMELINE_FLOAT_OFFSET_X,
	TIMELINE_FLOAT_OFFSET_Y,
	TIMELINE_MANUAL_NEIGHBOR_GAP,
	reduceTimelineManualPlacement,
	timelineManualPlacementBounds,
	type TimelineManualPlacementContext
} from '../manualPlacement';
import type { ScreenViewport, TimelineAlbumEntity } from '../types';
import { calendarAlbum } from './fixtures';

const viewport: ScreenViewport = { x: 0, y: 0, width: 1_400, height: 900 };

function contextFor(
	albums: readonly TimelineAlbumEntity[],
	albumLocalId: string,
	overrides: Partial<Pick<TimelineManualPlacementContext, 'canonicalBounds' | 'viewport' | 'scale'>> = {}
): TimelineManualPlacementContext {
	const canonicalBounds = createTimelineCanvasModel(
		albums.map((entity) => calendarAlbum(entity.id, entity.year ?? 2000, entity.ordinal))
	).bounds;
	return {
		albumLocalId,
		albums,
		canonicalBounds,
		viewport,
		scale: 1,
		...overrides
	};
}

function modelEntities(): readonly TimelineAlbumEntity[] {
	return createTimelineCanvasModel([
		calendarAlbum('first', 2000, 0),
		calendarAlbum('second', 2001, 1),
		calendarAlbum('third', 2002, 2)
	]).entities;
}

describe('Timeline manual placement', () => {
	it('floats by a fixed x delta and a fixed y delta away from the axis', () => {
		const entities = modelEntities();
		const above = entities.find(({ y }) => y < 0)!;
		const below = entities.find(({ y }) => y > 0)!;

		expect(reduceTimelineManualPlacement(null, { type: 'float' }, contextFor(entities, above.id)))
			.toEqual({ dx: TIMELINE_FLOAT_OFFSET_X, dy: -TIMELINE_FLOAT_OFFSET_Y });
		expect(reduceTimelineManualPlacement(null, { type: 'float' }, contextFor(entities, below.id)))
			.toEqual({ dx: TIMELINE_FLOAT_OFFSET_X, dy: TIMELINE_FLOAT_OFFSET_Y });
		expect(
			reduceTimelineManualPlacement(
				{ dx: 800, dy: 800 },
				{ type: 'float' },
				contextFor(entities, above.id)
			)
		).toEqual({ dx: TIMELINE_FLOAT_OFFSET_X, dy: -TIMELINE_FLOAT_OFFSET_Y });
	});

	it('uses the upper side as the deterministic away-from-axis tie break', () => {
		const [source] = modelEntities();
		const onAxis = Object.freeze({ ...source, anchorY: 0, y: 0 });
		const canonicalBounds = {
			x: onAxis.x - onAxis.width / 2,
			y: onAxis.y - onAxis.height / 2,
			width: onAxis.width,
			height: onAxis.height
		};

		expect(
			reduceTimelineManualPlacement(null, { type: 'float' }, {
				albumLocalId: onAxis.id,
				albums: [onAxis],
				canonicalBounds,
				viewport,
				scale: 1
			})
		).toEqual({ dx: TIMELINE_FLOAT_OFFSET_X, dy: -TIMELINE_FLOAT_OFFSET_Y });
	});

	it('represents Return and a placement snapped within 18 screen pixels as null', () => {
		const entities = modelEntities();
		const placementContext = contextFor(entities, 'second', { scale: 2 });

		expect(
			reduceTimelineManualPlacement({ dx: 300, dy: -80 }, { type: 'return' }, placementContext)
		).toBeNull();
		expect(
			reduceTimelineManualPlacement(null, { type: 'place', offset: { dx: 5.4, dy: 7.2 } }, placementContext)
		).toBeNull();
		expect(
			reduceTimelineManualPlacement(
				null,
				{ type: 'place', offset: { dx: 5.4001, dy: 7.2 } },
				placementContext
			)
		).toEqual({ dx: 5.4001, dy: 7.2 });
		expect(
			reduceTimelineManualPlacement(null, { type: 'place', offset: { dx: 0, dy: 0 } }, placementContext)
		).toBeNull();
	});

	it('moves beside the prior or next chronological neighbor without mutating chronology', () => {
		const canonical = modelEntities();
		const scrambled = Object.freeze([canonical[2], canonical[0], canonical[1]]);
		const beforeSnapshot = structuredClone(scrambled);
		const first = canonical.find(({ id }) => id === 'first')!;
		const second = canonical.find(({ id }) => id === 'second')!;
		const third = canonical.find(({ id }) => id === 'third')!;
		const placementContext = contextFor(scrambled, second.id);

		const before = reduceTimelineManualPlacement(null, { type: 'move', direction: 'before' }, placementContext);
		const after = reduceTimelineManualPlacement(null, { type: 'move', direction: 'after' }, placementContext);

		expect(before).toEqual({
			dx:
				first.anchorX - first.width / 2 - TIMELINE_MANUAL_NEIGHBOR_GAP - second.width / 2 -
				second.anchorX,
			dy: first.anchorY - second.anchorY
		});
		expect(after).toEqual({
			dx:
				third.anchorX + third.width / 2 + TIMELINE_MANUAL_NEIGHBOR_GAP + second.width / 2 -
				second.anchorX,
			dy: third.anchorY - second.anchorY
		});
		expect(scrambled).toEqual(beforeSnapshot);
		expect(scrambled.map(({ id, year, ordinal }) => ({ id, year, ordinal }))).toEqual([
			{ id: 'third', year: 2002, ordinal: 2 },
			{ id: 'first', year: 2000, ordinal: 0 },
			{ id: 'second', year: 2001, ordinal: 1 }
		]);
	});

	it('uses canonical anchors and chronology rather than projected visual positions for Move', () => {
		const canonical = modelEntities();
		const first = canonical.find(({ id }) => id === 'first')!;
		const second = canonical.find(({ id }) => id === 'second')!;
		const third = canonical.find(({ id }) => id === 'third')!;
		const visuallyScrambled = [
			Object.freeze({ ...third, x: -1_000 }),
			Object.freeze({ ...first, x: 1_000 }),
			second
		];
		const visualFirst = visuallyScrambled.find(({ id }) => id === first.id)!;
		const canonicalBounds = {
			x: -1_200,
			y: Math.min(...visuallyScrambled.map(({ y, height }) => y - height / 2)),
			width: 2_400,
			height:
				Math.max(...visuallyScrambled.map(({ y, height }) => y + height / 2)) -
				Math.min(...visuallyScrambled.map(({ y, height }) => y - height / 2))
		};

		const moved = reduceTimelineManualPlacement(null, { type: 'move', direction: 'before' }, {
			albumLocalId: second.id,
			albums: visuallyScrambled,
			canonicalBounds,
			viewport,
			scale: 1
		});

		expect(moved?.dx).toBe(
			visualFirst.anchorX -
				visualFirst.width / 2 -
				TIMELINE_MANUAL_NEIGHBOR_GAP -
				second.width / 2 -
				second.anchorX
		);
	});

	it('keeps the current offset when Move has no chronological neighbor', () => {
		const entities = modelEntities();
		const first = entities.find(({ id }) => id === 'first')!;
		const third = entities.find(({ id }) => id === 'third')!;
		const current = { dx: 300, dy: 80 };

		expect(
			reduceTimelineManualPlacement(current, { type: 'move', direction: 'before' }, contextFor(entities, first.id))
		).toEqual(current);
		expect(
			reduceTimelineManualPlacement(current, { type: 'move', direction: 'after' }, contextFor(entities, third.id))
		).toEqual(current);
	});

	it('clamps the complete marker inside canonical content plus one viewport margin', () => {
		const [source] = modelEntities();
		const marker = Object.freeze({
			...source,
			anchorX: 500,
			anchorY: 250,
			x: 500,
			y: 250,
			width: 100,
			height: 60
		});
		const canonicalBounds = { x: 0, y: 0, width: 1_000, height: 500 };
		const smallViewport = { x: 0, y: 0, width: 400, height: 200 };
		const placementBounds = timelineManualPlacementBounds(canonicalBounds, smallViewport, 2);

		expect(placementBounds).toEqual({ x: -200, y: -100, width: 1_400, height: 700 });
		expect(
			reduceTimelineManualPlacement(null, { type: 'place', offset: { dx: 9_999, dy: -9_999 } }, {
				albumLocalId: marker.id,
				albums: [marker],
				canonicalBounds,
				viewport: smallViewport,
				scale: 2
			})
		).toEqual({ dx: 650, dy: -320 });
	});

	it('rejects non-finite, malformed, missing, duplicate, and impossible inputs', () => {
		const entities = modelEntities();
		const placementContext = contextFor(entities, 'second');

		expect(() =>
			reduceTimelineManualPlacement(null, { type: 'place', offset: { dx: Number.NaN, dy: 0 } }, placementContext)
		).toThrow(/finite/);
		expect(() =>
			reduceTimelineManualPlacement({ dx: 0, dy: Number.POSITIVE_INFINITY }, { type: 'return' }, placementContext)
		).toThrow(/finite/);
		expect(() =>
			reduceTimelineManualPlacement(null, { type: 'float' }, { ...placementContext, scale: 0 })
		).toThrow(/positive/);
		expect(() =>
			reduceTimelineManualPlacement(null, { type: 'float' }, {
				...placementContext,
				viewport: { ...viewport, width: 0 }
			})
		).toThrow(/positive/);
		expect(() =>
			reduceTimelineManualPlacement(null, { type: 'float' }, {
				...placementContext,
				albumLocalId: 'missing'
			})
		).toThrow(/working set/);
		expect(() =>
			reduceTimelineManualPlacement(null, { type: 'float' }, {
				...placementContext,
				albums: [...entities, entities[0]]
			})
		).toThrow(/duplicate/);
		expect(() =>
			reduceTimelineManualPlacement(null, { type: 'float' }, {
				...placementContext,
				albums: [{ ...entities[0], width: -1 }]
			})
		).toThrow(/positive/);
		expect(() =>
			reduceTimelineManualPlacement(null, { type: 'move', direction: 'sideways' } as never, placementContext)
		).toThrow(/direction/);
		expect(() =>
			reduceTimelineManualPlacement(null, { type: 'unknown' } as never, placementContext)
		).toThrow(/unknown/);
	});
});
