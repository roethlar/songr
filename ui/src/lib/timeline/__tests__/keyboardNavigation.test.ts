import { describe, expect, it } from 'vitest';
import { createTimelineCanvasModel } from '../canvasModel';
import {
	TIMELINE_LIST_PAGE_SIZE,
	boundedTimelineListPage,
	orderedTimelineAlbums,
	resolveTimelineRovingId,
	timelineListPageCount,
	timelineListPageForId,
	timelineKeyboardTarget
} from '../keyboardNavigation';
import { calendarAlbum, undatedAlbum } from './fixtures';

function albums() {
	return createTimelineCanvasModel([
		undatedAlbum('undated', 1),
		calendarAlbum('later-same-year', 2001, 2),
		calendarAlbum('first', 1995, 0),
		calendarAlbum('earlier-same-year', 2001, 1)
	]).entities;
}

describe('Timeline keyboard navigation', () => {
	it('uses canonical chronology for Left, Right, Home, and End', () => {
		const entities = [...albums()].reverse();
		expect(orderedTimelineAlbums(entities).map(({ id }) => id)).toEqual([
			'first',
			'earlier-same-year',
			'later-same-year',
			'undated'
		]);
		expect(timelineKeyboardTarget({
			albums: entities,
			currentId: 'earlier-same-year',
			direction: 'right'
		})).toBe('later-same-year');
		expect(timelineKeyboardTarget({
			albums: entities,
			currentId: 'later-same-year',
			direction: 'left'
		})).toBe('earlier-same-year');
		expect(timelineKeyboardTarget({ albums: entities, currentId: null, direction: 'home' }))
			.toBe('first');
		expect(timelineKeyboardTarget({ albums: entities, currentId: null, direction: 'end' }))
			.toBe('undated');
		expect(timelineKeyboardTarget({ albums: entities, currentId: 'gone', direction: 'right' }))
			.toBe('first');
		expect(timelineKeyboardTarget({ albums: entities, currentId: 'gone', direction: 'left' }))
			.toBe('undated');
	});

	it('chooses the geometrically nearest eligible branch in the requested vertical half-plane', () => {
		const current = albums().find(({ id }) => id === 'first')!;
		const branchNodes = [
			{ id: 'far-up', x: current.x + 400, y: current.y - 10 },
			{ id: 'near-up', x: current.x + 20, y: current.y - 40 },
			{ id: 'down', x: current.x, y: current.y + 30 }
		];

		expect(timelineKeyboardTarget({
			albums: albums(),
			currentId: current.id,
			direction: 'up',
			branchNodes
		})).toBe('near-up');
		expect(timelineKeyboardTarget({
			albums: albums(),
			currentId: current.id,
			direction: 'down',
			branchNodes
		})).toBe('down');
	});

	it('keeps focus on the current album when no branch exists in that direction', () => {
		expect(timelineKeyboardTarget({
			albums: albums(),
			currentId: 'first',
			direction: 'up'
		})).toBe('first');
	});

	it('keeps branch Left/Right among siblings and uses Up/Down for topology', () => {
		const entities = albums();
		const source = entities.find(({ id }) => id === 'first')!;
		const branchNodes = [
			{
				id: 'parent-left',
				branchId: 'parent',
				sourceId: source.id,
				siblingOrder: 0,
				x: source.x - 100,
				y: source.y - 300
			},
			{
				id: 'parent-right',
				branchId: 'parent',
				sourceId: source.id,
				siblingOrder: 1,
				x: source.x + 100,
				y: source.y - 300
			},
			{
				id: 'child',
				branchId: 'child-branch',
				sourceId: 'parent-left',
				siblingOrder: 0,
				x: source.x - 90,
				y: source.y - 600
			}
		];

		expect(timelineKeyboardTarget({
			albums: entities,
			currentId: 'parent-left',
			direction: 'right',
			branchNodes
		})).toBe('parent-right');
		expect(timelineKeyboardTarget({
			albums: entities,
			currentId: 'parent-right',
			direction: 'left',
			branchNodes
		})).toBe('parent-left');
		expect(timelineKeyboardTarget({
			albums: entities,
			currentId: 'parent-left',
			direction: 'down',
			branchNodes
		})).toBe(source.id);
		expect(timelineKeyboardTarget({
			albums: entities,
			currentId: 'parent-left',
			direction: 'up',
			branchNodes
		})).toBe('child');
		expect(timelineKeyboardTarget({
			albums: entities,
			currentId: 'child',
			direction: 'down',
			branchNodes
		})).toBe('parent-left');
		expect(timelineKeyboardTarget({
			albums: entities,
			currentId: 'child',
			direction: 'home',
			branchNodes
		})).toBe('first');
		expect(timelineKeyboardTarget({
			albums: entities,
			currentId: 'child',
			direction: 'end',
			branchNodes
		})).toBe('undated');
	});

	it('prefers a valid requested or selected ID and otherwise falls back chronologically', () => {
		const entities = albums();
		expect(resolveTimelineRovingId(entities, 'later-same-year', 'first')).toBe(
			'later-same-year'
		);
		expect(resolveTimelineRovingId(entities, 'gone', 'undated')).toBe('undated');
		expect(resolveTimelineRovingId(entities, 'gone', 'also-gone')).toBe('first');
		expect(resolveTimelineRovingId([], null, null)).toBeNull();
	});

	it('pages the full working set without mounting more than 40 rows', () => {
		const entities = createTimelineCanvasModel(
			Array.from({ length: 81 }, (_, index) =>
				calendarAlbum(`album-${String(index).padStart(2, '0')}`, 1900 + index, index)
			)
		).entities;

		expect(TIMELINE_LIST_PAGE_SIZE).toBe(40);
		expect(timelineListPageCount(entities)).toBe(3);
		expect(boundedTimelineListPage(entities, 0)).toHaveLength(40);
		expect(boundedTimelineListPage(entities, 1)).toHaveLength(40);
		expect(boundedTimelineListPage(entities, 2)).toHaveLength(1);
		expect(timelineListPageForId(entities, 'album-80')).toBe(2);
		expect(() => boundedTimelineListPage(entities, -1)).toThrow(RangeError);
	});
});
