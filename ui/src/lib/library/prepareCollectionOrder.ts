import type { BrowseItem } from '@shared/types';
import type { LibraryCollectionSort } from './LibraryDestinations';

export class CollectionOrderCanceled extends Error {}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const nextTask = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Prepare the whole order cooperatively; results retain the original live objects. */
export async function prepareCollectionOrder(
	source: readonly BrowseItem[],
	choice: { filter?: string; sort?: LibraryCollectionSort },
	options: { isCurrent: () => boolean; isSelectable?: (item: BrowseItem) => boolean; yieldTask?: () => Promise<void>; now?: () => number }
): Promise<{ items: BrowseItem[]; orderedItems: BrowseItem[]; selectableItems: BrowseItem[]; orderedSelectableItems: BrowseItem[]; totalCount: number; matchCount: number }> {
	const now = options.now ?? (() => performance.now());
	const yieldTask = options.yieldTask ?? nextTask;
	let deadline = now() + 4;
	let work = 0;
	const check = (): void => {
		if (!options.isCurrent()) throw new CollectionOrderCanceled();
	};
	const cooperate = async (): Promise<void> => {
		check();
		if (now() >= deadline) {
			await yieldTask();
			check();
			deadline = now() + 4;
		}
	};
	check();
	const query = (choice.filter ?? '').trim().toLocaleLowerCase();
	const sort = choice.sort ?? 'original';
	type Entry = { item: BrowseItem; artist: string };
	let order: Entry[] = [];
	for (const item of source) {
		order.push({ item, artist: item.subtitle?.trim() ?? '' });
		if (++work % 256 === 0) await cooperate();
	}
	if (sort !== 'original') {
		const direction = sort === 'name-desc' || sort === 'artist-desc' ? -1 : 1;
		const byArtist = sort === 'artist-asc' || sort === 'artist-desc';
		const compare = (a: Entry, b: Entry): number => {
			if (!byArtist) return direction * collator.compare(a.item.title, b.item.title);
			if (Boolean(a.artist) !== Boolean(b.artist)) return a.artist ? -1 : 1;
			return direction * collator.compare(a.artist, b.artist) || collator.compare(a.item.title, b.item.title);
		};
		// Stable merge passes can yield; native Array.sort cannot be interrupted.
		let scratch: Entry[] = new Array(order.length);
		for (let width = 1; width < order.length; width *= 2) {
			for (let start = 0; start < order.length; start += width * 2) {
				let left = start;
				const middle = Math.min(start + width, order.length);
				let right = middle;
				const end = Math.min(start + width * 2, order.length);
				for (let target = start; target < end; target++) {
					scratch[target] = left < middle && (right >= end || compare(order[left], order[right]) <= 0)
						? order[left++] : order[right++];
					if (++work % 256 === 0) await cooperate();
				}
			}
			[order, scratch] = [scratch, order];
		}
	}
	const orderedItems: BrowseItem[] = [];
	const items: BrowseItem[] = [];
	const selectableItems: BrowseItem[] = [];
	const orderedSelectableItems: BrowseItem[] = [];
	for (const entry of order) {
		const item = entry.item;
		orderedItems.push(item);
		const selectable = options.isSelectable?.(item) ?? false;
		if (selectable) orderedSelectableItems.push(item);
		if (!query || `${item.title}\n${item.subtitle ?? ''}`.toLocaleLowerCase().includes(query)) {
			items.push(item);
			if (selectable) selectableItems.push(item);
		}
		if (++work % 256 === 0) await cooperate();
	}
	check();
	return { items, orderedItems, selectableItems, orderedSelectableItems, totalCount: source.length, matchCount: items.length };
}
