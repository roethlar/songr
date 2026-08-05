import { describe, expect, it } from 'vitest';
import type { BrowseItem } from '@shared/types';
import { CLASSIC_BROWSE_PAGE_SIZE_MAX } from '@shared/classicBrowseContracts';
import {
	DRILL_PAGE_SIZE,
	drainDrillAlbums,
	type DrillTransaction
} from '$lib/stores/unifiedDrillStore';

function album(title: string, subtitle = ''): BrowseItem {
	return { title, subtitle, hint: 'list', itemKey: `k:${title}`, isLoadable: true, isPlayable: true };
}

function action(title: string): BrowseItem {
	return { title, hint: 'action', itemKey: `a:${title}`, isLoadable: false, isPlayable: true };
}

/**
 * Fakes a genre node: [Play Genre, Albums child, Artists child]; the
 * Albums child drills into `albums` with browseLoad paging.
 */
function genreTransaction(albums: BrowseItem[]): {
	transaction: DrillTransaction;
	log: string[];
} {
	const log: string[] = [];
	const albumsChild: BrowseItem = {
		title: 'Albums',
		itemKey: 'k:albums',
		isLoadable: true,
		isPlayable: false
	};
	return {
		log,
		transaction: {
			browse: async ({ itemKey, pageSize }) => {
				log.push(`browse:${itemKey}`);
				if (itemKey === 'k:albums') {
					const items = albums.slice(0, pageSize);
					return { totalCount: albums.length, count: items.length, items };
				}
				const items = [action('Play Genre'), albumsChild, action('Shuffle')];
				return { totalCount: items.length, count: items.length, items };
			},
			browseLoad: async ({ offset, count }) => {
				log.push(`load:${offset}`);
				return { items: albums.slice(offset, offset + count) };
			}
		}
	};
}

describe('drainDrillAlbums', () => {
	it('keeps every request within the Classic browse contract cap', () => {
		expect(DRILL_PAGE_SIZE).toBe(CLASSIC_BROWSE_PAGE_SIZE_MAX);
	});

	it('drills the Albums child of a genre node and filters action rows', async () => {
		const albums = Array.from({ length: 30 }, (_, i) => album(`A${i}`, `Artist ${i}`));
		const { transaction, log } = genreTransaction(albums);
		const items = await drainDrillAlbums(transaction, 'genres', 'k:genre');
		expect(items).toHaveLength(30);
		expect(items.every((item) => item.hint !== 'action')).toBe(true);
		expect(log).toEqual(['browse:k:genre', 'browse:k:albums']);
	});

	it('pages the album list to totalCount (the prototype truncation)', async () => {
		const albums = Array.from({ length: 460 }, (_, i) => album(`A${i}`));
		const { transaction, log } = genreTransaction(albums);
		const items = await drainDrillAlbums(transaction, 'genres', 'k:genre');
		expect(items).toHaveLength(460);
		expect(items[459].title).toBe('A459');
		expect(log).toEqual([
			'browse:k:genre',
			'browse:k:albums',
			...Array.from(
				{ length: Math.ceil(albums.length / DRILL_PAGE_SIZE) - 1 },
				(_value, index) => `load:${DRILL_PAGE_SIZE * (index + 1)}`
			)
		]);
	});

	it('uses the drilled node directly when no Albums child exists (composers)', async () => {
		const albums = Array.from({ length: 5 }, (_, i) => album(`C${i}`));
		const transaction: DrillTransaction = {
			browse: async () => ({ totalCount: 5, count: 5, items: albums }),
			browseLoad: async () => ({ items: [] })
		};
		const items = await drainDrillAlbums(transaction, 'composers', 'k:composer');
		expect(items).toHaveLength(5);
	});

	it('returns empty honestly when the node has neither albums nor children', async () => {
		const transaction: DrillTransaction = {
			browse: async () => ({ totalCount: 1, count: 1, items: [action('Play Genre')] }),
			browseLoad: async () => ({ items: [] })
		};
		const items = await drainDrillAlbums(transaction, 'genres', 'k:genre');
		expect(items).toEqual([]);
	});
});
