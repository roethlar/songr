import { describe, expect, it } from 'vitest';
import {
	createTimelineCanvasModel,
	projectTimelineCanvasModel,
	type TimelineCanvasModel
} from '../canvasModel';
import { timelineEntityBounds } from '../layout';
import { calendarAlbum } from './fixtures';

function canonicalProjectionFields(model: TimelineCanvasModel): string {
	return JSON.stringify(model.entities.map((entity) => ({
		id: entity.id,
		anchorX: entity.anchorX,
		anchorY: entity.anchorY,
		width: entity.width,
		height: entity.height,
		title: entity.title,
		artist: entity.artist,
		chronologyLabel: entity.chronologyLabel,
		year: entity.year,
		ordinal: entity.ordinal,
		imageKeyHint: entity.imageKeyHint ?? null
	})));
}

describe('Timeline canvas manual-placement projection', () => {
	it('projects display coordinates while preserving immutable chronology anchors', () => {
		const canonical = createTimelineCanvasModel([
			calendarAlbum('first', 2000, 0),
			calendarAlbum('second', 2001, 1)
		]);
		const before = canonical.entityById.get('second')!;
		const projected = projectTimelineCanvasModel(
			canonical,
			new Map([['second', { x: 240, y: -90 }]])
		);
		const after = projected.entityById.get('second')!;

		expect(before).toMatchObject({
			x: before.anchorX,
			y: before.anchorY
		});
		expect(after).toMatchObject({
			x: before.anchorX + 240,
			y: before.anchorY - 90,
			anchorX: before.anchorX,
			anchorY: before.anchorY,
			year: before.year,
			ordinal: before.ordinal,
			chronologyLabel: before.chronologyLabel
		});
		expect(canonicalProjectionFields(projected)).toBe(
			canonicalProjectionFields(canonical)
		);
		expect(projected.axis).toBe(canonical.axis);
	});

	it('indexes effective positions and fits the union of canonical and projected bounds', () => {
		const canonical = createTimelineCanvasModel([calendarAlbum('moved', 2000, 0)]);
		const anchor = canonical.entityById.get('moved')!;
		const projected = projectTimelineCanvasModel(
			canonical,
			new Map([['moved', { x: 2_000, y: 1_200 }]])
		);
		const moved = projected.entityById.get('moved')!;

		expect(
			projected.index.query(timelineEntityBounds(moved)).map(({ id }) => id)
		).toEqual(['moved']);
		expect(projected.index.query(timelineEntityBounds(anchor))).toEqual([]);
		expect(projected.bounds.x).toBeLessThanOrEqual(canonical.bounds.x);
		expect(projected.bounds.y).toBeLessThanOrEqual(canonical.bounds.y);
		expect(projected.bounds.x + projected.bounds.width).toBeGreaterThanOrEqual(
			timelineEntityBounds(moved).x + moved.width
		);
		expect(projected.bounds.y + projected.bounds.height).toBeGreaterThanOrEqual(
			timelineEntityBounds(moved).y + moved.height
		);
	});

	it('fails closed on unknown, non-finite, overflowing, or double-projected input', () => {
		const canonical = createTimelineCanvasModel([calendarAlbum('kept', 2000, 0)]);
		expect(() =>
			projectTimelineCanvasModel(canonical, new Map([['unknown', { x: 1, y: 2 }]]))
		).toThrow(/unknown/);
		expect(() =>
			projectTimelineCanvasModel(canonical, new Map([['kept', { x: Number.NaN, y: 2 }]]))
		).toThrow(/finite/);
		expect(() =>
			projectTimelineCanvasModel(canonical, new Map([['kept', { x: Number.MAX_VALUE, y: 0 }]]))
		).toThrow(/safe|finite/);
		const projected = projectTimelineCanvasModel(
			canonical,
			new Map([['kept', { x: 20, y: 30 }]])
		);
		expect(() => projectTimelineCanvasModel(projected, new Map())).toThrow(/canonical/);
	});
});
