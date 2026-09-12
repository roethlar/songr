import { describe, expect, it } from 'vitest';

import { UNIFIED_FILTER_TEXT_MAX_LENGTH } from '$lib/libraryPageState';
import {
	parseCountFilter,
	parseSmartFilters,
	type SmartCountFilter
} from '$lib/unifiedSmartFilters';

function onlyCount(raw: string): SmartCountFilter {
	const filters = parseSmartFilters(raw);
	expect(filters).toHaveLength(1);
	const filter = filters[0];
	if (filter.kind !== 'count') throw new Error(`expected count filter for ${raw}`);
	return filter;
}

describe('parseSmartFilters — count filter unit table', () => {
	// Ported with the prototype parser (build-v5.mjs parseSmart).
	const table: ReadonlyArray<{
		raw: string;
		label: string;
		accepts: readonly number[];
		rejects: readonly number[];
	}> = [
		{
			raw: 'one album',
			label: 'Artists with exactly one album',
			accepts: [1],
			rejects: [0, 2, 30]
		},
		{
			raw: 'only one album',
			label: 'Artists with exactly one album',
			accepts: [1],
			rejects: [2]
		},
		{
			raw: '1 album',
			label: 'Artists with exactly one album',
			accepts: [1],
			rejects: [11]
		},
		{
			raw: 'one',
			label: 'Artists with exactly one album',
			accepts: [1],
			rejects: [0]
		},
		{
			raw: 'one album by',
			label: 'Artists with exactly one album',
			accepts: [1],
			rejects: [2]
		},
		{
			raw: '>30 albums',
			label: 'Artists with more than 30 albums',
			accepts: [31, 100],
			rejects: [30, 1]
		},
		{
			raw: '> 30 albums',
			label: 'Artists with more than 30 albums',
			accepts: [31],
			rejects: [30]
		},
		{
			raw: '>=5 albums',
			label: 'Artists with at least 5 albums',
			accepts: [5, 6],
			rejects: [4]
		},
		{
			raw: '<3 albums',
			label: 'Artists with fewer than 3 albums',
			accepts: [1, 2],
			rejects: [3]
		},
		{
			raw: '<=2 albums',
			label: 'Artists with at most 2 albums',
			accepts: [0, 2],
			rejects: [3]
		},
		{
			raw: '5+ albums',
			label: 'Artists with at least 5 albums',
			accepts: [5, 50],
			rejects: [4]
		},
		{
			raw: '5+albums',
			label: 'Artists with at least 5 albums',
			accepts: [5],
			rejects: [4]
		},
		{
			raw: '2+ album',
			label: 'Artists with at least 2 albums',
			accepts: [2],
			rejects: [1]
		},
		{
			raw: '3 albums',
			label: 'Artists with exactly 3 albums',
			accepts: [3],
			rejects: [2, 4]
		},
		{
			raw: '  >30   ALBUMS  ',
			label: 'Artists with more than 30 albums',
			accepts: [31],
			rejects: [30]
		}
	];

	for (const row of table) {
		it(`parses ${JSON.stringify(row.raw)}`, () => {
			const filter = onlyCount(row.raw);
			expect(filter.label).toBe(row.label);
			for (const count of row.accepts) expect(filter.test(count)).toBe(true);
			for (const count of row.rejects) expect(filter.test(count)).toBe(false);
		});
	}

	it('canonicalizes persisted filter text (trim + whitespace collapse)', () => {
		expect(onlyCount('  >30   albums ').text).toBe('>30 albums');
	});
});

describe('parseSmartFilters — unsupported date expressions remain plain search', () => {
	const rows: readonly string[] = [
		'1984-1989',
		'1984 - 1989',
		'1984–89',
		'1990 – 1999',
		'80s',
		"80's",
		'1980s',
		'new',
		'newer',
		'newest',
		'recent',
		'new releases',
		'newer release',
		'releases since 1990',
		'release from the 90s'
	];

	for (const raw of rows) {
		it(`leaves ${JSON.stringify(raw)} as ordinary search text`, () => {
			expect(parseSmartFilters(raw)).toEqual([]);
		});
	}

});

describe('parseSmartFilters — non-matches fall through to plain search', () => {
	const rows: readonly string[] = [
		'',
		'   ',
		'bowie',
		'album',
		'albums',
		'thirty albums',
		'>x albums',
		'5 ++ albums',
		'1984-2100x',
		'jazz'
	];

	for (const raw of rows) {
		it(`returns no filters for ${JSON.stringify(raw)}`, () => {
			expect(parseSmartFilters(raw)).toEqual([]);
		});
	}

	it('rejects overlong input instead of scanning it', () => {
		const long = `>30 albums${' '.repeat(UNIFIED_FILTER_TEXT_MAX_LENGTH)}x`;
		expect(long.length).toBeGreaterThan(UNIFIED_FILTER_TEXT_MAX_LENGTH);
		expect(parseSmartFilters(long)).toEqual([]);
	});
});

describe('parseCountFilter', () => {
	it('returns the count filter when present', () => {
		expect(parseCountFilter('>30 albums')?.label).toBe('Artists with more than 30 albums');
	});

	it('returns null for year-only and plain text', () => {
		expect(parseCountFilter('80s')).toBeNull();
		expect(parseCountFilter('bowie')).toBeNull();
	});
});
