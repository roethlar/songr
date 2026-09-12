import { describe, expect, it } from 'vitest';
import { CollectionOrderCanceled, prepareCollectionOrder } from '../prepareCollectionOrder';
import { filterSortLibraryCollection, type LibraryCollectionSort } from '../LibraryDestinations';
import type { BrowseItem } from '@shared/types';
import { createTrackSelection } from '$lib/trackSelection';

describe('cooperative complete collection order', () => {
	const source: BrowseItem[] = [
		{ isLoadable: true, isPlayable: false, title: 'Track 10', subtitle: ' Z ', itemKey: 'one' },
		{ isLoadable: true, isPlayable: false, title: 'Track 2', subtitle: 'A', itemKey: 'two' },
		{ isLoadable: true, isPlayable: false, title: 'Track 2', subtitle: 'A', itemKey: 'three' },
		{ isLoadable: true, isPlayable: false, title: 'Track 1', itemKey: 'four' }
	];
	it.each<LibraryCollectionSort>(['original', 'name-asc', 'name-desc', 'artist-asc', 'artist-desc'])(
		'preserves existing %s semantics and exact duplicate objects', async sort => {
			const expected = filterSortLibraryCollection({ complete: true, items: source, totalCount: source.length } as Parameters<typeof filterSortLibraryCollection>[0], { sort });
			const result = await prepareCollectionOrder(source, { sort }, { isCurrent: () => true });
			expect(result.items).toEqual(expected.items);
			result.items.forEach((item, index) => expect(item).toBe(expected.items[index]));
		}
	);
	it('retains the full sorted order for selected rows hidden by a filter', async () => {
		const result = await prepareCollectionOrder(source, { sort: 'name-asc', filter: 'Z' }, { isCurrent: () => true });
		expect(result.items).toEqual([source[0]]);
		expect(result.orderedItems).toEqual([source[3], source[1], source[2], source[0]]);
		expect(result.totalCount).toBe(4);
		expect(result.matchCount).toBe(1);
	});
	it('keeps selectable exact duplicates and hidden selections in the full current order', async () => {
		const result = await prepareCollectionOrder(source, { sort: 'name-asc', filter: 'Track 2' }, {
			isCurrent: () => true,
			isSelectable: item => item !== source[3]
		});
		expect(result.selectableItems).toHaveLength(2);
		expect(result.selectableItems[0]).toBe(source[1]);
		expect(result.selectableItems[1]).toBe(source[2]);
		expect(result.orderedSelectableItems).toHaveLength(3);
		[source[1], source[2], source[0]].forEach((item, index) => {
			expect(result.orderedSelectableItems[index]).toBe(item);
		});
		const selection = createTrackSelection<BrowseItem>();
		selection.retain(source);
		selection.toggle(source[0], source);
		selection.toggle(source[2], source);
		const selected = selection.ordered(result.orderedSelectableItems);
		expect(selected).toHaveLength(2);
		expect(selected[0]).toBe(source[2]);
		expect(selected[1]).toBe(source[0]);
	});
	it('yields and abandons superseded work before publishing an order', async () => {
		let current = true;
		let yields = 0;
		let clock = 0;
		const rows = Array.from({ length: 4096 }, (_, index) => ({ isLoadable: true, isPlayable: false, title: `${4096 - index}` }));
		await expect(prepareCollectionOrder(rows, { sort: 'name-asc' }, {
			isCurrent: () => current,
			now: () => (clock += 5),
			yieldTask: async () => { yields++; current = false; }
		})).rejects.toBeInstanceOf(CollectionOrderCanceled);
		expect(yields).toBe(1);
	});
});
