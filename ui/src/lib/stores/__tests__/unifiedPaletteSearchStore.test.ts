import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';

import type { UnifiedSongSearchResult } from '@shared/unifiedSearchContracts';
import type { SearchResult } from '@shared/types';
import type { UnifiedSearchClient } from '$lib/unifiedSearchClient';

import {
	PALETTE_SEARCH_GROUP_ROW_LIMIT,
	PALETTE_SEARCH_MIN_QUERY,
	clearPaletteSearch,
	groupBrowseSearchResults,
	resetPaletteSearch,
	searchPalette,
	unifiedPaletteSearchStore,
	type PaletteBrowseSearch
} from '../unifiedPaletteSearchStore';
import {
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim
} from '../classicBrowseSessionStore';

const TEST_CLAIM = {
	owner: 'unified-mode',
	claimId: 1,
	ready: Promise.resolve({ handleId: 'test', generation: 1 })
} as unknown as ClassicBrowseSessionClaim;

const search = vi.fn<UnifiedSearchClient['search']>();
const action = vi.fn<UnifiedSearchClient['action']>();
const relationship = vi.fn<UnifiedSearchClient['relationship']>();
const clear = vi.fn<UnifiedSearchClient['clear']>().mockResolvedValue();
const browseCategories = vi.fn<PaletteBrowseSearch>().mockResolvedValue([]);
const TEST_CLIENT: UnifiedSearchClient = {
	search,
	action,
	relationship,
	clear
};

function songResult(
	title: string,
	over: Partial<UnifiedSongSearchResult> = {}
): UnifiedSongSearchResult {
	return {
		resultId: `song-${title.replaceAll(' ', '-').toLowerCase()}`,
		title,
		subtitle: 'Some Artist',
		imageKey: null,
		...over
	};
}

function mockSearchResolving(results: UnifiedSongSearchResult[]): void {
	search.mockResolvedValue(results);
}

beforeEach(() => {
	search.mockReset();
	action.mockReset();
	relationship.mockReset();
	clear.mockReset().mockResolvedValue();
	browseCategories.mockReset();
	browseCategories.mockResolvedValue([]);
	resetPaletteSearch();
});

describe('unifiedPaletteSearchStore', () => {
	it('keeps every server-authorized song and its opaque result id', async () => {
		mockSearchResolving([
			songResult('Ashes to Ashes', { imageKey: 'ashes-image' }),
			songResult('Fame')
		]);

		await searchPalette(TEST_CLAIM, 'ashes', TEST_CLIENT, browseCategories);

		expect(search).toHaveBeenCalledWith(TEST_CLAIM, 'ashes');
		const state = get(unifiedPaletteSearchStore);
		expect(state.phase).toBe('ready');
		expect(state.query).toBe('ashes');
		expect(state.groups).toEqual([
			{
				title: 'Tracks',
				rows: [
					{
						resultId: 'song-ashes-to-ashes',
						title: 'Ashes to Ashes',
						subtitle: 'Some Artist',
						imageKey: 'ashes-image'
					},
					{
						resultId: 'song-fame',
						title: 'Fame',
						subtitle: 'Some Artist',
						imageKey: null
					}
				]
			}
		]);
		expect(state.browseGroups).toEqual([]);
	});

	it('adds every Browse-search category as keyless groups before retaining songs', async () => {
		const resultTypes: readonly SearchResult['resultType'][] = [
			'artist',
			'album',
			'track',
			'playlist',
			'genre',
			'composer',
			'label',
			'radio'
		];
		browseCategories.mockResolvedValue(
			resultTypes.map((resultType, index) => ({
				title: `${resultType} result`,
				subtitle: `${index}`,
				itemKey: `must-not-cross-${index}`,
				hint: resultType === 'track' ? 'action_list' : 'list',
				isLoadable: false,
				isPlayable: false,
				resultType,
				categoryTotal: 12
			}))
		);
		mockSearchResolving([songResult('Authoritative Track')]);

		await searchPalette(TEST_CLAIM, 'all', TEST_CLIENT, browseCategories);

		const state = get(unifiedPaletteSearchStore);
		expect(state.browseGroups?.map((group) => group.resultType)).toEqual(resultTypes);
		expect(JSON.stringify(state.browseGroups)).not.toContain('must-not-cross');
		expect(browseCategories.mock.invocationCallOrder[0]).toBeLessThan(
			search.mock.invocationCallOrder[0]
		);
		expect(state.groups[0].rows[0].title).toBe('Authoritative Track');
	});

	it('counts every observed synthetic result without inventing category authority', () => {
		const groups = groupBrowseSearchResults(
			Array.from({ length: 20 }, (_, index) => ({
				title: `Unknown ${index}`,
				hint: 'list',
				isLoadable: false,
				isPlayable: false,
				resultType: 'unknown' as const
			}))
		);

		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({
			title: 'Other',
			categoryTitle: null,
			resultType: 'unknown',
			total: 20
		});
		expect(groups[0].rows).toHaveLength(4);
	});

	it('keeps successful songs visible when category search alone fails', async () => {
		browseCategories.mockRejectedValue(new Error('categories unavailable'));
		mockSearchResolving([songResult('Heroes')]);

		await searchPalette(TEST_CLAIM, 'heroes', TEST_CLIENT, browseCategories);

		expect(get(unifiedPaletteSearchStore)).toMatchObject({
			phase: 'ready',
			groups: [{ title: 'Tracks' }],
			browseGroups: [],
			partialError: 'categories unavailable'
		});
	});

	it('bounds the single songs group to the prototype row limit', async () => {
		mockSearchResolving(
			Array.from({ length: PALETTE_SEARCH_GROUP_ROW_LIMIT + 4 }, (_, i) =>
				songResult(`Bowie Track ${i}`)
			)
		);

		await searchPalette(TEST_CLAIM, 'bowie', TEST_CLIENT, browseCategories);

		const state = get(unifiedPaletteSearchStore);
		expect(state.groups).toHaveLength(1);
		expect(state.groups[0].rows).toHaveLength(PALETTE_SEARCH_GROUP_ROW_LIMIT);
	});

	it('stays idle below the minimum query length', async () => {
		await searchPalette(
			TEST_CLAIM,
			'b'.repeat(PALETTE_SEARCH_MIN_QUERY - 1),
			TEST_CLIENT,
			browseCategories
		);

		expect(search).not.toHaveBeenCalled();
		expect(clear).toHaveBeenCalledWith(TEST_CLAIM);
		expect(get(unifiedPaletteSearchStore).phase).toBe('idle');
	});

	it('explicit close resets local rows and clears server authority', async () => {
		mockSearchResolving([songResult('Old Result')]);
		await searchPalette(TEST_CLAIM, 'old query', TEST_CLIENT, browseCategories);

		await clearPaletteSearch(TEST_CLAIM, TEST_CLIENT);

		expect(clear).toHaveBeenCalledWith(TEST_CLAIM);
		expect(get(unifiedPaletteSearchStore).phase).toBe('idle');
	});

	it('drops stale responses whole — the newer search wins', async () => {
		let releaseFirst: (results: readonly UnifiedSongSearchResult[]) => void = () => {};
		search.mockImplementationOnce(
			() =>
				new Promise<readonly UnifiedSongSearchResult[]>((resolve) => {
					releaseFirst = resolve;
				})
		);
		const first = searchPalette(TEST_CLAIM, 'slow', TEST_CLIENT, browseCategories);
		await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));

		mockSearchResolving([songResult('Fast Result')]);
		await searchPalette(TEST_CLAIM, 'fast', TEST_CLIENT, browseCategories);

		releaseFirst([songResult('Slow Result')]);
		await first;

		const state = get(unifiedPaletteSearchStore);
		expect(state.phase).toBe('ready');
		expect(state.query).toBe('fast');
		expect(state.groups[0]?.rows.map((row) => row.title)).toEqual(['Fast Result']);
	});

	it('removes the prior query songs as soon as a new query starts', async () => {
		mockSearchResolving([songResult('Old Result')]);
		await searchPalette(TEST_CLAIM, 'old query', TEST_CLIENT, browseCategories);
		expect(get(unifiedPaletteSearchStore).groups).toHaveLength(1);

		let release: (results: readonly UnifiedSongSearchResult[]) => void = () => {};
		search.mockImplementationOnce(
			() =>
				new Promise<readonly UnifiedSongSearchResult[]>((resolve) => {
					release = resolve;
				})
		);
		const pending = searchPalette(TEST_CLAIM, 'new query', TEST_CLIENT, browseCategories);
		await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));

		expect(get(unifiedPaletteSearchStore)).toMatchObject({
			phase: 'searching',
			query: 'new query',
			groups: []
		});
		release([songResult('New Result')]);
		await pending;
	});

	it('a later reset fences an in-flight search', async () => {
		let release: (results: readonly UnifiedSongSearchResult[]) => void = () => {};
		search.mockImplementationOnce(
			() =>
				new Promise<readonly UnifiedSongSearchResult[]>((resolve) => {
					release = resolve;
				})
		);
		const pending = searchPalette(TEST_CLAIM, 'bowie', TEST_CLIENT, browseCategories);
		await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
		resetPaletteSearch();
		release([songResult('Late Result')]);
		await pending;

		expect(get(unifiedPaletteSearchStore).phase).toBe('idle');
	});

	it('publishes an honest error state on failure', async () => {
		search.mockRejectedValue(new Error('search exploded'));

		await searchPalette(TEST_CLAIM, 'bowie', TEST_CLIENT, browseCategories);

		const state = get(unifiedPaletteSearchStore);
		expect(state.phase).toBe('error');
		expect(state.error).toBe('search exploded');
		expect(state.groups).toEqual([]);
	});

	it('resets to idle when the session is superseded', async () => {
		search.mockRejectedValue(new ClassicBrowseSupersededError());

		await searchPalette(TEST_CLAIM, 'bowie', TEST_CLIENT, browseCategories);

		expect(get(unifiedPaletteSearchStore).phase).toBe('idle');
	});
});
