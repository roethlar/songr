import { describe, expect, it } from 'vitest';
import type { BrowseItem } from '@shared/types';
import { CLASSIC_BROWSE_PAGE_SIZE_MAX } from '@shared/classicBrowseContracts';
import {
	formatGenreAlbumCount,
	GENRE_PAGE_BOUND,
	NAMED_COUNTS_MAX_ITEMS,
	NAMED_COUNTS_PAGE_SIZE,
	drainNamedCounts,
	parseAlbumCount,
	type NamedCountsTransaction
} from '$lib/stores/unifiedNamedCountsStore';

function item(title: string): BrowseItem {
	return { title, isLoadable: true, isPlayable: false };
}

function fakeTransaction(total: number, options?: { shortAfter?: number }): {
	transaction: NamedCountsTransaction;
	calls: { offsets: number[]; counts: number[] };
} {
	const all = Array.from({ length: total }, (_, i) => item(`G${i}`));
	const calls = { offsets: [] as number[], counts: [] as number[] };
	return {
		calls,
		transaction: {
			browse: async ({ pageSize }) => {
				const items = all.slice(0, pageSize);
				return { level: 0, offset: 0, title: 'Named', totalCount: total, count: total, items };
			},
			browseLoad: async ({ offset, count }) => {
				calls.offsets.push(offset);
				calls.counts.push(count);
				if (options?.shortAfter !== undefined && offset >= options.shortAfter) {
					return { level: 0, offset, title: 'Named', totalCount: total, count: total, items: [] };
				}
				return { level: 0, offset, title: 'Named', totalCount: total, count: total, items: all.slice(offset, offset + Math.min(count, 100)) };
			}
		}
	};
}

describe('parseAlbumCount', () => {
	it('parses Roon subtitles', () => {
		expect(parseAlbumCount('123 Albums')).toBe(123);
		expect(parseAlbumCount('1 Album')).toBe(1);
		expect(parseAlbumCount('1,039 Albums')).toBe(1039);
		expect(parseAlbumCount('12 Artists, 25 Albums')).toBe(25);
		expect(parseAlbumCount('60+ Albums')).toBe(60);
	});

	it('returns 0 for absent or unnumbered subtitles', () => {
		expect(parseAlbumCount(undefined)).toBe(0);
		expect(parseAlbumCount('Albums')).toBe(0);
		expect(parseAlbumCount('')).toBe(0);
	});
});

describe('formatGenreAlbumCount', () => {
	it('matches the prototype page-bound genre labels', () => {
		expect(formatGenreAlbumCount(GENRE_PAGE_BOUND - 1)).toBe('59 ALBUMS');
		expect(formatGenreAlbumCount(GENRE_PAGE_BOUND)).toBe('60+ ALBUMS');
		expect(formatGenreAlbumCount(2_574)).toBe('60+ ALBUMS');
		expect(formatGenreAlbumCount(0)).toBe('');
	});

	it('pluralizes the album noun on the count', () => {
		expect(formatGenreAlbumCount(1)).toBe('1 ALBUM');
		expect(formatGenreAlbumCount(2)).toBe('2 ALBUMS');
	});

	it('keeps the bounded ("60+") form plural, since it means "at least 60"', () => {
		expect(formatGenreAlbumCount(GENRE_PAGE_BOUND)).toBe(`${GENRE_PAGE_BOUND}+ ALBUMS`);
	});

	it('returns an empty string for non-positive or non-safe-integer input', () => {
		expect(formatGenreAlbumCount(0)).toBe('');
		expect(formatGenreAlbumCount(-1)).toBe('');
		expect(formatGenreAlbumCount(Number.NaN)).toBe('');
		expect(formatGenreAlbumCount(Number.POSITIVE_INFINITY)).toBe('');
	});
});

describe('drainNamedCounts', () => {
	it('keeps every request within the Classic browse contract cap', () => {
		expect(NAMED_COUNTS_PAGE_SIZE).toBe(CLASSIC_BROWSE_PAGE_SIZE_MAX);
	});

	it('returns a single page untouched when it covers the total', async () => {
		const { transaction, calls } = fakeTransaction(60);
		const items = await drainNamedCounts(transaction, 'genres');
		expect(items).toHaveLength(60);
		expect(calls.offsets).toEqual([]);
	});

	it('pages to totalCount past the first page (the prototype truncation)', async () => {
		const { transaction, calls } = fakeTransaction(730);
		const items = await drainNamedCounts(transaction, 'composers');
		expect(items).toHaveLength(730);
		expect(items[729].title).toBe('G729');
		expect(calls.offsets).toEqual([100, 200, 300, 400, 500, 600, 700]);
		// Final page asks only for the remainder.
		expect(calls.counts).toEqual([630, 530, 430, 330, 230, 130, 30]);
		expect(new Set(items.map((i) => i.title)).size).toBe(730);
	});

	it('refuses incomplete responses instead of calling their prefix complete', async () => {
		const { transaction } = fakeTransaction(730, { shortAfter: 400 });
		await expect(drainNamedCounts(transaction, 'genres')).rejects.toThrow('before every item was loaded');
	});

	it('refuses oversized collections without publishing a truncated prefix', async () => {
		const { transaction } = fakeTransaction(NAMED_COUNTS_MAX_ITEMS + NAMED_COUNTS_PAGE_SIZE);
		await expect(drainNamedCounts(transaction, 'genres')).rejects.toThrow('too large');
	});
});
