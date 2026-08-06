import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { CatalogIndexResponse } from '@shared/catalogIndexContracts';
import { normalizeClassicBrowseCommandRequest } from '@shared/classicBrowseContracts';
import type { BrowseItem } from '@shared/types';
import { makeSyntheticIndex, syntheticStatus } from './libraryIndexFixtures';

const fetchCatalogIndexMock = vi.fn<() => Promise<unknown>>();
const roleTransaction = vi.fn<
	(role: string, claim: unknown, work: (transaction: unknown) => Promise<unknown>) => Promise<unknown>
>();

vi.mock('$lib/api/client', () => ({
	fetchCatalogIndex: (..._args: unknown[]) => fetchCatalogIndexMock(),
	withClassicBrowseRoleTransaction: (...args: unknown[]) =>
		roleTransaction(
			...(args as [string, unknown, (transaction: unknown) => Promise<unknown>])
		)
}));

import {
	libraryIndexStore,
	loadLibraryIndex,
	resetLibraryIndex,
	bucketLetterFor,
	BROWSE_DRAIN_PAGE_SIZE,
	BROWSE_DRAIN_MAX_ITEMS,
	BROWSE_FALLBACK_CAPABILITIES,
	CATALOG_CAPABILITIES,
	INCOMPLETE_ARTIST_COUNTS_CAPABILITIES,
	parseRoonArtistAlbumCount,
	reconcileBrowseAlbumsToCatalog
} from '../libraryIndexStore';
import type { ClassicBrowseSessionClaim } from '../classicBrowseSessionStore';

const TEST_CLAIM = {
	owner: 'normal-shell',
	claimId: 1,
	ready: Promise.resolve({ handleId: 'test', generation: 1 })
} as unknown as ClassicBrowseSessionClaim;

const fetchFn = (() => {
	throw new Error('store must go through the api client, not raw fetch');
}) as unknown as typeof fetch;

describe('reconcileBrowseAlbumsToCatalog', () => {
	it('uses unique title/artist identities and cover keys without guessing at ambiguity', () => {
		const catalog = [
			{
				id: 'kind',
				title: 'Kind of Blue',
				artist: 'Miles Davis',
				searchKey: 'kind of blue miles davis',
				imageKey: 'kind-cover',
				catalogLocalId: 'kind',
				resolutionStatus: 'resolved' as const
			},
			{
				id: 'duplicate-a',
				title: 'Same Album',
				artist: 'Same Artist',
				searchKey: 'same album same artist',
				imageKey: 'cover-a',
				catalogLocalId: 'duplicate-a',
				resolutionStatus: 'ambiguous' as const
			},
			{
				id: 'duplicate-b',
				title: 'Same Album',
				artist: 'Same Artist',
				searchKey: 'same album same artist',
				imageKey: 'cover-b',
				catalogLocalId: 'duplicate-b',
				resolutionStatus: 'ambiguous' as const
			}
		];

		const reconciled = reconcileBrowseAlbumsToCatalog(
			[
				{ title: ' Kind of Blue ', artist: 'MILES DAVIS', imageKey: null },
				{ title: 'Same Album', artist: 'Same Artist', imageKey: 'cover-b' },
				{ title: 'Same Album', artist: 'Same Artist', imageKey: null },
				{ title: 'Missing Album', artist: 'Missing Artist', imageKey: null }
			],
			catalog
		);

		expect(reconciled.map((album) => album.catalogLocalId)).toEqual([
			'kind',
			'duplicate-b',
			undefined,
			undefined
		]);
		expect(reconciled[0]).toMatchObject({
			title: ' Kind of Blue ',
			artist: 'MILES DAVIS',
			imageKey: 'kind-cover',
			resolutionStatus: 'resolved'
		});
		expect(reconciled[2].id).toBe('drill:2:Same Album');
	});

	it('carries the matched catalog entry native release dates onto the browse row (Slice 4)', () => {
		const catalog = [
			{
				id: 'kind',
				title: 'Kind of Blue',
				artist: 'Miles Davis',
				searchKey: 'kind of blue miles davis',
				catalogLocalId: 'kind',
				resolutionStatus: 'resolved' as const,
				originalReleaseDate: { year: 1959, month: 8, day: 17 }
			}
		];

		const [reconciled] = reconcileBrowseAlbumsToCatalog(
			[{ title: 'Kind of Blue', artist: 'Miles Davis', imageKey: null }],
			catalog
		);

		expect(reconciled.originalReleaseDate).toEqual({ year: 1959, month: 8, day: 17 });
	});
});

function smallIndex(over: Partial<CatalogIndexResponse['status']> = {}): CatalogIndexResponse {
	return {
		status: syntheticStatus({ artistCount: 2, albumCount: 3, ...over }),
		artists: [
			{ localId: 'art-b', name: 'Zebra Trio', knownAlbumCount: 1, countComplete: true },
			{ localId: 'art-a', name: 'alpha band', knownAlbumCount: 2, countComplete: true }
		],
		albums: [
			{
				localId: 'alb-2',
				artistLocalId: 'art-a',
				resolutionStatus: 'resolved',
				title: 'Middle',
				artist: 'alpha band'
			},
			{
				localId: 'alb-1',
				artistLocalId: 'art-a',
				resolutionStatus: 'resolved',
				title: 'Alpha',
				artist: 'alpha band',
				imageKeyHint: 'img-1'
			},
			{
				localId: 'alb-3',
				artistLocalId: 'art-b',
				resolutionStatus: 'ambiguous',
				title: '99 Songs',
				artist: 'Zebra Trio'
			}
		]
	};
}

function browseItem(title: string, subtitle?: string, imageKey?: string): BrowseItem {
	return {
		title,
		...(subtitle !== undefined ? { subtitle } : {}),
		...(imageKey !== undefined ? { imageKey } : {}),
		isLoadable: true,
		isPlayable: false
	};
}

function mockArtistCountDrain(
	root: BrowseItem[],
	options: { totalCount?: number; loads?: BrowseItem[][] } = {}
) {
	const loads = [...(options.loads ?? [])];
	const transaction = {
		browse: vi.fn(async () => ({
			items: root,
			totalCount: options.totalCount ?? root.length,
			count: root.length
		})),
		browseLoad: vi.fn(async () => ({ items: loads.shift() ?? [] }))
	};
	roleTransaction.mockImplementation(async (_role, _claim, work) =>
		work(transaction as unknown)
	);
	return transaction;
}

beforeEach(() => {
	vi.clearAllMocks();
	resetLibraryIndex();
});

describe('libraryIndexStore — catalog source', () => {
	it('publishes sorted entries, buckets, and full capabilities', async () => {
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: smallIndex() });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('ready');
		expect(state.source).toBe('catalog');
		expect(state.coreId).toBe('core-a');
		expect(state.revision).toBe(1);
		expect(state.capabilities).toEqual(CATALOG_CAPABILITIES);
		expect(state.artists.map((a) => a.name)).toEqual(['alpha band', 'Zebra Trio']);
		expect(state.albums.map((a) => a.title)).toEqual(['99 Songs', 'Alpha', 'Middle']);
		expect(state.albums[1].imageKey).toBe('img-1');
		expect(state.albums[0].resolutionStatus).toBe('ambiguous');
		expect(state.albums.every((a) => a.catalogLocalId !== undefined)).toBe(true);
		expect(state.albumBuckets).toEqual([
			{ letter: '#', start: 0, count: 1 },
			{ letter: 'A', start: 1, count: 1 },
			{ letter: 'M', start: 2, count: 1 }
		]);
		expect(state.artistBuckets).toEqual([
			{ letter: 'A', start: 0, count: 1 },
			{ letter: 'Z', start: 1, count: 1 }
		]);
	});

	it('carries native release dates onto entries and the capability answer onto capabilities (Slice 4)', async () => {
		const index = smallIndex();
		index.albums[0] = {
			...index.albums[0],
			originalReleaseDate: { year: 1975, month: 6, day: 1 },
			releaseDate: { year: 1976, month: 0, day: 0 }
		};
		index.native = {
			dateFeaturesAvailable: true,
			playFeaturesAvailable: true,
			playlistFeaturesAvailable: true,
			stateFilterFeaturesAvailable: true
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.capabilities.dateFeatures).toBe(true);
		expect(state.capabilities.dateFeaturesDisabledReason).toBeUndefined();
		expect(state.capabilities.playFeatures).toBe(true);
		expect(state.capabilities.playFeaturesDisabledReason).toBeUndefined();
		const middle = state.albums.find((entry) => entry.title === 'Middle');
		expect(middle?.originalReleaseDate).toEqual({ year: 1975, month: 6, day: 1 });
		expect(middle?.releaseDate).toEqual({ year: 1976, month: 0, day: 0 });
		// Albums without native fields carry none of them.
		const alpha = state.albums.find((entry) => entry.title === 'Alpha');
		expect(alpha?.originalReleaseDate).toBeUndefined();
		expect(alpha?.releaseDate).toBeUndefined();
	});

	it('carries native importDate onto entries (Slice 5)', async () => {
		const index = smallIndex();
		index.albums[0] = { ...index.albums[0], importDate: '2026-07-24T09:30:00.000Z' };
		index.native = {
			dateFeaturesAvailable: true,
			playFeaturesAvailable: true,
			playlistFeaturesAvailable: true,
			stateFilterFeaturesAvailable: true
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		const middle = state.albums.find((entry) => entry.title === 'Middle');
		expect(middle?.importDate).toBe('2026-07-24T09:30:00.000Z');
		// Albums without the native field carry none.
		const alpha = state.albums.find((entry) => entry.title === 'Alpha');
		expect(alpha?.importDate).toBeUndefined();
	});

	it('degrades to the disabled gate with the capability reason when date features are unavailable', async () => {
		const index = smallIndex();
		index.native = {
			dateFeaturesAvailable: false,
			dateFeaturesUnavailableReason: 'no native catalog snapshot is available',
			playFeaturesAvailable: false,
			playFeaturesUnavailableReason: 'no native catalog snapshot is available',
			playlistFeaturesAvailable: false,
			playlistFeaturesUnavailableReason: 'no native catalog snapshot is available',
			stateFilterFeaturesAvailable: false,
			stateFilterFeaturesUnavailableReason: 'no native catalog snapshot is available'
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.capabilities.dateFeatures).toBe(false);
		expect(state.capabilities.dateFeaturesDisabledReason).toBe(
			'no native catalog snapshot is available'
		);
	});

	it('carries the play-feature gate and its honest reason (Slice 6)', async () => {
		const index = smallIndex();
		index.native = {
			dateFeaturesAvailable: true,
			playFeaturesAvailable: false,
			playFeaturesUnavailableReason:
				'the Core does not report play-statistics support; most played is unavailable',
			playlistFeaturesAvailable: true,
			stateFilterFeaturesAvailable: true
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.capabilities.playFeatures).toBe(false);
		expect(state.capabilities.playFeaturesDisabledReason).toBe(
			'the Core does not report play-statistics support; most played is unavailable'
		);
	});

	it('carries the playlist-feature gate and its honest reason (Slice 7)', async () => {
		const index = smallIndex();
		index.native = {
			dateFeaturesAvailable: true,
			playFeaturesAvailable: true,
			playlistFeaturesAvailable: false,
			playlistFeaturesUnavailableReason:
				'the native playlist list has not been pulled yet; it arrives with the next catalog refresh',
			stateFilterFeaturesAvailable: true
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.capabilities.playlistFeatures).toBe(false);
		expect(state.capabilities.playlistFeaturesDisabledReason).toBe(
			'the native playlist list has not been pulled yet; it arrives with the next catalog refresh'
		);
	});

	it('defaults the playlist gate to unavailable without the capability answer', async () => {
		const index = smallIndex();
		delete index.native;
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		expect(get(libraryIndexStore).capabilities.playlistFeatures).toBe(false);
	});

	it('keeps the conservative disabled gate when the index carries no capability answer', async () => {
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: smallIndex() });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.capabilities).toEqual(CATALOG_CAPABILITIES);
		expect(state.capabilities.dateFeatures).toBe(false);
	});

	it('folds accented initials into the single leading # bucket (no duplicate letters)', async () => {
		// Regression: `normalizeCatalogText` lowercases but keeps diacritics,
		// so `č`/`é`/`ó` sort above `z` in code-point order. Before the
		// bucket-rank sort this opened a second `#` bucket after Z, and the
		// letter-keyed each blocks in the unified scope views crashed with
		// Svelte's each_key_duplicate (real-library names: Česká filharmonie,
		// Éric Le Sage, Ólafur Arnalds).
		const index = smallIndex();
		const accented: CatalogIndexResponse = {
			...index,
			artists: [
				...index.artists,
				{ localId: 'art-c', name: 'Česká filharmonie', knownAlbumCount: 1, countComplete: true },
				{ localId: 'art-d', name: 'Ólafur Arnalds', knownAlbumCount: 1, countComplete: true },
				{ localId: 'art-e', name: '311', knownAlbumCount: 1, countComplete: true }
			]
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: accented });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('ready');
		// Within `#`, ICU (en-US) collation — the owner-approved prototype
		// order: digits first, then č before ó (not code-point order).
		expect(state.artists.map((a) => a.name)).toEqual([
			'311',
			'Česká filharmonie',
			'Ólafur Arnalds',
			'alpha band',
			'Zebra Trio'
		]);
		expect(state.artistBuckets).toEqual([
			{ letter: '#', start: 0, count: 3 },
			{ letter: 'A', start: 3, count: 1 },
			{ letter: 'Z', start: 4, count: 1 }
		]);
		// The invariant the scope views key on: bucket letters are unique.
		const letters = state.artistBuckets.map((bucket) => bucket.letter);
		expect(new Set(letters).size).toBe(letters.length);
	});

	it('strips one leading article for sorting and bucketing (approved prototype rule)', async () => {
		const index = smallIndex();
		const withArticles: CatalogIndexResponse = {
			...index,
			artists: [
				...index.artists,
				{ localId: 'art-f', name: 'The 1975', knownAlbumCount: 1, countComplete: true },
				{ localId: 'art-g', name: 'The Beatles', knownAlbumCount: 1, countComplete: true },
				{ localId: 'art-h', name: 'A Winged Victory', knownAlbumCount: 1, countComplete: true }
			]
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: withArticles });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('ready');
		// 'The 1975' keys as '1975' (`#`), 'The Beatles' as 'beatles' (B),
		// 'A Winged Victory' as 'winged victory' (W).
		expect(state.artists.map((a) => a.name)).toEqual([
			'The 1975',
			'alpha band',
			'The Beatles',
			'A Winged Victory',
			'Zebra Trio'
		]);
		expect(state.artistBuckets).toEqual([
			{ letter: '#', start: 0, count: 1 },
			{ letter: 'A', start: 1, count: 1 },
			{ letter: 'B', start: 2, count: 1 },
			{ letter: 'W', start: 3, count: 1 },
			{ letter: 'Z', start: 4, count: 1 }
		]);
	});

	it('keeps artist text searchable while sorting albums by an article-stripped title', async () => {
		const index = smallIndex();
		const withArticleAlbum: CatalogIndexResponse = {
			...index,
			albums: [
				...index.albums,
				{
					localId: 'alb-wall',
					artistLocalId: 'art-a',
					resolutionStatus: 'resolved',
					title: 'The Wall',
					artist: 'Pink Floyd'
				}
			]
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: withArticleAlbum });

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('ready');
		const wall = state.albums.find((entry) => entry.id === 'alb-wall');
		expect(wall?.searchKey).toBe('wall pink floyd');
		expect(state.albums.filter((entry) => entry.searchKey.includes('pink floyd'))).toEqual([wall]);
		expect(bucketLetterFor(wall?.searchKey ?? '')).toBe('W');
	});

	it('parses the album counts exposed in Roon Artists subtitles', () => {
		expect(parseRoonArtistAlbumCount('12 albums')).toBe(12);
		expect(parseRoonArtistAlbumCount('1 album')).toBe(1);
		expect(parseRoonArtistAlbumCount('1,234 albums')).toBe(1234);
		expect(parseRoonArtistAlbumCount(undefined)).toBeNull();
		expect(parseRoonArtistAlbumCount('Albums')).toBeNull();
	});

	it('hydrates prototype-faithful counts from Roon instead of catalog bindings', async () => {
		const index = smallIndex();
		const incomplete: CatalogIndexResponse = {
			...index,
			artists: index.artists.map((artist) => ({
				...artist,
				knownAlbumCount: 0,
				countComplete: false
			}))
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: incomplete });
		mockArtistCountDrain([
			browseItem('Zebra Trio', '11 albums'),
			browseItem('alpha band', '27 albums')
		]);

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('ready');
		expect(state.source).toBe('catalog');
		expect(roleTransaction).toHaveBeenCalledWith(
			'classic-explore',
			TEST_CLAIM,
			expect.any(Function)
		);
		expect(Object.fromEntries(state.artists.map((artist) => [artist.name, artist.albumCount]))).toEqual({
			'alpha band': 27,
			'Zebra Trio': 11
		});
		expect(state.artists.every((artist) => artist.countComplete)).toBe(true);
		expect(state.capabilities).toEqual(CATALOG_CAPABILITIES);
		expect(state.capabilities.countFilters).toBe(true);
	});

	it('preserves separate Roon counts for duplicate normalized artist names', async () => {
		const index = smallIndex();
		const duplicates: CatalogIndexResponse = {
			...index,
			artists: [
				{ localId: 'art-bjork-1', name: 'Björk', knownAlbumCount: 0, countComplete: false },
				{ localId: 'art-bjork-2', name: 'BJÖRK', knownAlbumCount: 0, countComplete: false }
			]
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: duplicates });
		mockArtistCountDrain([
			browseItem('Björk', '7 albums'),
			browseItem('BJÖRK', '3 albums')
		]);

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.artists.map((artist) => [artist.id, artist.albumCount])).toEqual([
			['art-bjork-1', 7],
			['art-bjork-2', 3]
		]);
		expect(state.capabilities).toEqual(CATALOG_CAPABILITIES);
	});

	it('gates count filters when the Roon Artists list is incomplete', async () => {
		const index = smallIndex();
		const incomplete: CatalogIndexResponse = {
			...index,
			artists: index.artists.map((artist) => ({ ...artist, countComplete: false }))
		};
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: incomplete });
		mockArtistCountDrain([browseItem('alpha band', '27 albums')]);

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('ready');
		expect(state.capabilities).toEqual(INCOMPLETE_ARTIST_COUNTS_CAPABILITIES);
		expect(state.capabilities.countFilters).toBe(false);
		expect(state.artists.find((artist) => artist.name === 'alpha band')?.albumCount).toBe(27);
		expect(state.artists.find((artist) => artist.name === 'Zebra Trio')?.albumCount).toBeUndefined();
		expect(state.capabilities.albumActions).toBe(true);
		expect(state.capabilities.durableRestoration).toBe(true);
	});

	it('fails visibly when required Roon counts cannot be loaded', async () => {
		const index = smallIndex();
		fetchCatalogIndexMock.mockResolvedValue({
			kind: 'index',
			index: {
				...index,
				artists: index.artists.map((artist) => ({ ...artist, countComplete: false }))
			}
		});
		roleTransaction.mockRejectedValue(new Error('count browse failed'));

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('error');
		expect(state.error).toBe('Could not load artist album counts: count browse failed');
	});

	it('drops Roon artist counts that arrive after the store is fenced', async () => {
		const index = smallIndex();
		fetchCatalogIndexMock.mockResolvedValue({
			kind: 'index',
			index: {
				...index,
				artists: index.artists.map((artist) => ({ ...artist, countComplete: false }))
			}
		});
		let resolveCounts!: (value: { items: BrowseItem[]; truncated: boolean }) => void;
		roleTransaction.mockReturnValue(
			new Promise((resolve) => {
				resolveCounts = resolve;
			})
		);

		const pending = loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });
		await vi.waitFor(() => expect(roleTransaction).toHaveBeenCalledTimes(1));
		resetLibraryIndex();
		resolveCounts({
			items: [browseItem('Zebra Trio', '11 albums'), browseItem('alpha band', '27 albums')],
			truncated: false
		});
		await pending;

		expect(get(libraryIndexStore).phase).toBe('idle');
		expect(get(libraryIndexStore).artists).toEqual([]);
	});

	it('reuses prepared entries for a repeated coreId+revision', async () => {
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: smallIndex() });
		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });
		const first = get(libraryIndexStore);

		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: smallIndex() });
		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });
		const second = get(libraryIndexStore);

		expect(fetchCatalogIndexMock).toHaveBeenCalledTimes(2);
		expect(second.artists).toBe(first.artists);
		expect(second.albums).toBe(first.albums);
		expect(second.albumBuckets).toBe(first.albumBuckets);
	});

	it('rebuilds prepared entries when the revision advances', async () => {
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: smallIndex() });
		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });
		const first = get(libraryIndexStore);

		fetchCatalogIndexMock.mockResolvedValue({
			kind: 'index',
			index: smallIndex({ revision: 2 })
		});
		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });
		const second = get(libraryIndexStore);

		expect(second.revision).toBe(2);
		expect(second.albums).not.toBe(first.albums);
	});

	it('drops an in-flight load once the store is fenced', async () => {
		let resolveFetch!: (value: unknown) => void;
		fetchCatalogIndexMock.mockReturnValue(
			new Promise((resolve) => {
				resolveFetch = resolve;
			})
		);
		const pending = loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		resetLibraryIndex();
		resolveFetch({ kind: 'index', index: smallIndex() });
		await pending;

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('idle');
		expect(state.artists).toEqual([]);
	});

	it('rejects an index that arrives for a different Core', async () => {
		fetchCatalogIndexMock.mockResolvedValue({
			kind: 'index',
			index: smallIndex({ coreId: 'core-b' })
		});

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('error');
		expect(state.artists).toEqual([]);
		expect(state.error).toContain('different Core');
	});

	it('publishes an error state when the index fetch fails', async () => {
		fetchCatalogIndexMock.mockRejectedValue(new Error('boom'));

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		expect(get(libraryIndexStore).phase).toBe('error');
		expect(get(libraryIndexStore).error).toBe('boom');
	});
});

describe('libraryIndexStore — browse-drain fallback', () => {
	function drainTransaction(pages: {
		albums: { root: BrowseItem[]; totalCount: number; loads: BrowseItem[][] };
		artists: { root: BrowseItem[]; totalCount: number; loads: BrowseItem[][] };
	}) {
		const browseCalls: unknown[] = [];
		const loadCalls: Array<{ hierarchy: string; offset: number; count: number }> = [];
		const loadQueues = {
			albums: [...pages.albums.loads],
			artists: [...pages.artists.loads]
		};
		const transaction = {
			browse: vi.fn(async (options: { hierarchy: 'albums' | 'artists' }) => {
				browseCalls.push(options);
				const page = pages[options.hierarchy];
				return {
					items: page.root,
					totalCount: page.totalCount,
					count: page.root.length,
					title: options.hierarchy,
					level: 0,
					offset: 0
				};
			}),
			browseLoad: vi.fn(
				async (options: { hierarchy: 'albums' | 'artists'; offset: number; count: number }) => {
					loadCalls.push(options);
					return { items: loadQueues[options.hierarchy].shift() ?? [] };
				}
			)
		};
		roleTransaction.mockImplementation(async (_role, _claim, work) =>
			work(transaction as unknown)
		);
		return { transaction, browseCalls, loadCalls };
	}

	it('drains pages and publishes the degraded capability matrix', async () => {
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'empty' });
		const { loadCalls } = drainTransaction({
			albums: {
				root: [browseItem('Album One', 'Artist A', 'img-a'), browseItem('Album Two', 'Artist B')],
				totalCount: 3,
				loads: [[browseItem('Album Three', 'Artist C')]]
			},
			artists: {
				root: [browseItem('Artist A', '2 albums'), browseItem('Artist B', '1 album')],
				totalCount: 2,
				loads: []
			}
		});

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(roleTransaction).toHaveBeenCalledWith(
			'classic-explore',
			TEST_CLAIM,
			expect.any(Function)
		);
		expect(state.phase).toBe('ready');
		expect(state.source).toBe('browse');
		expect(state.revision).toBeNull();
		expect(state.capabilities).toEqual(BROWSE_FALLBACK_CAPABILITIES);
		expect(state.capabilities.albumActions).toBe(false);
		expect(state.capabilities.countFiltersDisabledReason).toBeTruthy();
		expect(state.capabilities.countsApproximate).toBe(false);
		expect(state.truncated).toBe(false);
		expect(loadCalls).toEqual([{ hierarchy: 'albums', offset: 2, count: 1 }]);
		expect(state.albums.map((a) => a.title)).toEqual(['Album One', 'Album Three', 'Album Two']);
		expect(state.albums.every((a) => a.catalogLocalId === undefined)).toBe(true);
		expect(state.artists.map((a) => a.albumCount)).toEqual([2, 1]);
		expect(state.artists.every((a) => a.countComplete)).toBe(true);
	});

	it('stops on an empty page and reports truncation honestly', async () => {
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'empty' });
		drainTransaction({
			albums: {
				root: [browseItem('Album One', 'Artist A')],
				totalCount: 50,
				loads: [[]]
			},
			artists: { root: [browseItem('Artist A')], totalCount: 1, loads: [] }
		});

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('ready');
		expect(state.albums).toHaveLength(1);
		expect(state.truncated).toBe(true);
	});

	it('never drains past the hard cap', async () => {
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'empty' });
		const bigPage = Array.from({ length: BROWSE_DRAIN_PAGE_SIZE }, (_, i) =>
			browseItem(`Album ${i}`)
		);
		const { loadCalls } = drainTransaction({
			albums: {
				root: bigPage,
				totalCount: BROWSE_DRAIN_MAX_ITEMS * 2,
				loads: Array.from({ length: 200 }, () => bigPage)
			},
			artists: { root: [browseItem('Artist A')], totalCount: 1, loads: [] }
		});

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		expect(state.albums).toHaveLength(BROWSE_DRAIN_MAX_ITEMS);
		expect(state.truncated).toBe(true);
		expect(loadCalls.length).toBe(BROWSE_DRAIN_MAX_ITEMS / BROWSE_DRAIN_PAGE_SIZE - 1);
	});

	it('drops a fenced drain result', async () => {
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'empty' });
		let releaseDrain!: () => void;
		roleTransaction.mockImplementation(async (_role, _claim, work) => {
			await new Promise<void>((resolve) => {
				releaseDrain = resolve;
			});
			return work({
				browse: async (options: { hierarchy: string }) => ({
					items: [browseItem(`${options.hierarchy} item`)],
					totalCount: 1,
					count: 1
				}),
				browseLoad: async () => ({ items: [] })
			} as unknown);
		});

		const pending = loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });
		await Promise.resolve();
		resetLibraryIndex();
		releaseDrain();
		await pending;

		expect(get(libraryIndexStore).phase).toBe('idle');
	});
});

describe('libraryIndexStore — scale scaffolding (40k albums)', () => {
	it('prepares 40k albums with buckets inside the responsiveness budget', async () => {
		const index = makeSyntheticIndex({
			albumCount: 40_000,
			artistCount: 4_000,
			bigArtistAlbums: 500
		});
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index });

		const started = performance.now();
		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });
		const prepareMs = performance.now() - started;

		const state = get(libraryIndexStore);
		expect(state.phase).toBe('ready');
		expect(state.albums).toHaveLength(40_000);
		expect(state.artists).toHaveLength(4_000);
		expect(state.artists.reduce((max, a) => Math.max(max, a.albumCount ?? 0), 0)).toBeGreaterThanOrEqual(500);
		// Buckets must cover every entry exactly once.
		expect(state.albumBuckets.reduce((sum, b) => sum + b.count, 0)).toBe(40_000);
		expect(state.artistBuckets.reduce((sum, b) => sum + b.count, 0)).toBe(4_000);
		// Generous CI budget; the point is catching accidental O(n^2) work.
		expect(prepareMs).toBeLessThan(2_000);

		// Palette-keystroke-shaped scan stays linear and fast.
		const scanStart = performance.now();
		const hits = state.albums.filter((album) => album.searchKey.includes('zephyr'));
		const scanMs = performance.now() - scanStart;
		expect(hits.length).toBeGreaterThan(0);
		expect(scanMs).toBeLessThan(250);
	});

	it('sorted order and buckets agree at scale', async () => {
		const index = makeSyntheticIndex({ albumCount: 5_000, artistCount: 500 });
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index });
		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const state = get(libraryIndexStore);
		for (let i = 1; i < state.albums.length; i += 1) {
			expect(
				state.albums[i - 1].searchKey <= state.albums[i].searchKey
			).toBe(true);
		}
		for (const bucket of state.albumBuckets) {
			expect(bucketLetterFor(state.albums[bucket.start].searchKey)).toBe(bucket.letter);
		}
	});
});

describe('drain payloads honor the real classic browse contract', () => {
	// The drain tests above stub the role transaction, so nothing there ever
	// runs the shared normalizer. This guard feeds the exact option shapes
	// `drainHierarchy` emits through the real contract, so a drift like
	// BROWSE_DRAIN_PAGE_SIZE > CLASSIC_BROWSE_PAGE_SIZE_MAX (which shipped,
	// and made every fallback drain die with "Classic browse request is
	// invalid") fails here instead of on a live Core.
	const session = { handleId: 'session-1', generation: 1 };

	it('accepts the drain browse page request', () => {
		for (const hierarchy of ['albums', 'artists'] as const) {
			expect(
				normalizeClassicBrowseCommandRequest({
					requestId: 'req-1',
					tabId: 'tab-1',
					session,
					role: 'classic-explore',
					operation: 'browse',
					options: { hierarchy, pageSize: BROWSE_DRAIN_PAGE_SIZE }
				})
			).not.toBeNull();
		}
	});

	it('accepts the drain load page request', () => {
		expect(
			normalizeClassicBrowseCommandRequest({
				requestId: 'req-1',
				tabId: 'tab-1',
				session,
				role: 'classic-explore',
				operation: 'load',
				options: { hierarchy: 'albums', offset: 0, count: BROWSE_DRAIN_PAGE_SIZE }
			})
		).not.toBeNull();
	});
});
