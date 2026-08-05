import { describe, expect, it } from 'vitest';
import {
	TIMELINE_ALBUM_WIDTH,
	layoutTimelineAlbums,
	timelineEntityBounds
} from '../layout';
import type { TimelineAlbumLayoutInput } from '../types';
import { calendarAlbum, undatedAlbum } from './fixtures';

function rectanglesOverlap(
	left: ReturnType<typeof timelineEntityBounds>,
	right: ReturnType<typeof timelineEntityBounds>
): boolean {
	return !(
		left.x + left.width <= right.x ||
		right.x + right.width <= left.x ||
		left.y + left.height <= right.y ||
		right.y + right.height <= left.y
	);
}

function expectNoMarkerOverlap(inputs: readonly TimelineAlbumLayoutInput[]): void {
	const bounds = layoutTimelineAlbums(inputs).entities.map(timelineEntityBounds);
	for (let leftIndex = 0; leftIndex < bounds.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < bounds.length; rightIndex += 1) {
			expect(rectanglesOverlap(bounds[leftIndex], bounds[rightIndex])).toBe(false);
		}
	}
}

describe('deterministic Timeline layout', () => {
	it('is input-order independent and alternates ordinary markers across the axis', () => {
		const inputs = [
			calendarAlbum('third', 2002, 2),
			calendarAlbum('first', 2000, 0),
			calendarAlbum('second', 2001, 1)
		];
		const first = layoutTimelineAlbums(inputs).entities.map(({ id, x, y }) => ({ id, x, y }));
		const second = layoutTimelineAlbums([...inputs].reverse()).entities.map(({ id, x, y }) => ({ id, x, y }));

		expect(second).toEqual(first);
		expect(first.map(({ y }) => Math.sign(y))).toEqual([-1, 1, -1]);
	});

	it('stacks same-year releases vertically on their true year anchor', () => {
		const entities = layoutTimelineAlbums([
			calendarAlbum('a', 1999, 0),
			calendarAlbum('b', 1999, 1),
			calendarAlbum('c', 1999, 2),
			calendarAlbum('d', 1999, 3)
		]).entities;
		const positions = entities.map(({ x, y }) => `${x}:${y}`);

		expect(new Set(positions)).toHaveLength(4);
		expect(new Set(entities.map(({ x }) => x))).toEqual(new Set([0]));
		expect(entities.map(({ y }) => Math.sign(y))).toEqual([-1, 1, -1, 1]);
		expect(Math.abs(entities[2].y)).toBeGreaterThan(Math.abs(entities[0].y));
	});

	it('keeps dense and compressed calendar markers pairwise non-overlapping', () => {
		const threeSameYearThenNext = [
			...Array.from({ length: 3 }, (_, index) => calendarAlbum(`three-${index}`, 2000, index)),
			calendarAlbum('three-next', 2001, 3)
		];
		const fifteenSameYearThenNext = [
			...Array.from({ length: 15 }, (_, index) =>
				calendarAlbum(`fifteen-${index}`, 2000, index)
			),
			calendarAlbum('fifteen-next', 2001, 15)
		];
		const annualLongSpan = Array.from({ length: 66 }, (_, index) =>
			calendarAlbum(`annual-${index}`, 1960 + index, index)
		);

		for (const fixture of [threeSameYearThenNext, fifteenSameYearThenNext, annualLongSpan]) {
			expectNoMarkerOverlap(fixture);
			const layout = layoutTimelineAlbums(fixture);
			expect(layout.axis.yearAnchors.map(({ x }) => x)).toEqual(
				[...layout.axis.yearAnchors].map(({ x }) => x).sort((left, right) => left - right)
			);
			for (const entity of layout.entities) {
				const anchor = layout.axis.yearAnchors.find(({ year }) => year === entity.year);
				expect(entity.x).toBe(anchor?.x);
			}
		}
	});

	it('places every unknown original release in a labeled Undated tail', () => {
		const layout = layoutTimelineAlbums([
			undatedAlbum('u2', 3),
			calendarAlbum('known', 2005, 0),
			undatedAlbum('u1', 1)
		]);
		const known = layout.entities.find(({ id }) => id === 'known')!;
		const undated = layout.entities.filter(({ year }) => year === null);
		const knownRight = timelineEntityBounds(known).x + TIMELINE_ALBUM_WIDTH;

		expect(undated.map(({ id }) => id)).toEqual(['u1', 'u2']);
		expect(undated.every(({ chronologyLabel }) => chronologyLabel.startsWith('Undated'))).toBe(true);
		expect(Math.min(...undated.map(({ x }) => x - TIMELINE_ALBUM_WIDTH / 2))).toBeGreaterThan(
			knownRight
		);
		expect(layout.axis.undatedStartX).toBe(undated[0].x);
	});

	it('fails closed on duplicate IDs and forged edition evidence', () => {
		expect(() =>
			layoutTimelineAlbums([calendarAlbum('same', 2000, 0), calendarAlbum('same', 2001, 1)])
		).toThrow(/duplicate/);

		const forged = calendarAlbum('forged', 2000, 0) as TimelineAlbumLayoutInput & {
			placement: { evidence: { field: string } };
		};
		forged.placement.evidence.field = 'edition-release-date';
		expect(() => layoutTimelineAlbums([forged as TimelineAlbumLayoutInput])).toThrow(
			/original-release/
		);
	});

	it('rejects malformed evidence even when its prefix resembles the placement year', () => {
		for (const date of [
			'2000garbage',
			'20e2',
			'2000-1',
			'2000-00',
			'2000-02-30'
		]) {
			const forged = calendarAlbum(`forged-${date}`, 2000, 0) as TimelineAlbumLayoutInput & {
				placement: { evidence: { date: string } };
			};
			forged.placement.evidence.date = date;
			expect(() => layoutTimelineAlbums([forged as TimelineAlbumLayoutInput])).toThrow(
				/original-release/
			);
		}
	});

	it('returns finite content and axis bounds for empty and populated layouts', () => {
		const empty = layoutTimelineAlbums([]);
		expect(empty.bounds).toEqual({ x: -1, y: -1, width: 2, height: 2 });
		expect(empty.axis).toMatchObject({ startX: -160, endX: 160, undatedStartX: null });

		const populated = layoutTimelineAlbums([calendarAlbum('one', 2000, 0)]);
		expect(populated.bounds.width).toBe(TIMELINE_ALBUM_WIDTH);
		expect(populated.axis.startX).toBeLessThan(populated.bounds.x);
		expect(populated.axis.endX).toBeGreaterThan(
			populated.bounds.x + populated.bounds.width
		);
	});
});
