import { describe, expect, it, vi } from 'vitest';
import type { BrowseItem, BrowseResult } from '@shared/types';
import { createPublicNavigationDestinationId, MAX_CUSTOM_NAVIGATION_DESTINATIONS } from '@shared/navigationSettings';
import { normalizeBrowseHistorySnapshot, type BrowseHistorySnapshot } from '$lib/libraryPageState';
import {
	discoverLibraryDestinations,
	filterSortLibraryCollection,
	filterRedundantBrowseItems,
	identifyLibraryDestination,
	isLibraryDestinationRoot,
	LibraryCollectionPathError,
	loadCompleteLibraryCollection,
	resolveLibraryDestination,
	type LibraryDestinationTransaction
} from '../LibraryDestinations';

const ROOT: BrowseHistorySnapshot = { context: { hierarchy: 'browse' }, history: [], forward: [] };
function path(...titles: string[]): BrowseHistorySnapshot {
	return { ...ROOT, history: titles.map((title) => ({ hierarchy: 'browse', breadcrumb: { title } })) };
}
function row(title: string, over: Partial<BrowseItem> = {}): BrowseItem {
	return { title, isLoadable: false, isPlayable: false, ...over };
}
function list(title: string, target: string, over: Partial<BrowseItem> = {}): BrowseItem {
	return row(title, { itemKey: target, hint: 'list', ...over });
}
function page(items: BrowseItem[], over: Partial<BrowseResult> = {}): BrowseResult {
	// BrowseService preserves public list.count as the full list count on every page.
	return { action: 'list', level: 0, offset: 0, count: over.totalCount ?? items.length, totalCount: items.length, items, ...over };
}

/** Every root visit invalidates old keys, just as a new public browse session can. */
function tree(nodes: Record<string, BrowseItem[] | BrowseResult>, firstPage = 100) {
	let epoch = 0;
	let current = 'root';
	let level = 0;
	const authority = new Map<string, string>();
	function result(offset = 0, count = firstPage): BrowseResult {
		const node = nodes[current];
		if (!Array.isArray(node)) return node;
		const items = node.slice(offset, offset + count).map((item, index) => {
			if (!item.itemKey) return { ...item };
			const key = `opaque-${epoch}-${current}-${offset + index}`;
			authority.set(key, item.itemKey);
			return { ...item, itemKey: key };
		});
		return page(items, { title: current, level, offset, totalCount: node.length });
	}
	const browse = vi.fn<LibraryDestinationTransaction['browse']>(async (options) => {
		expect(options.hierarchy).toBe('browse');
		if (options.popAll) { current = 'root'; level = 0; epoch++; authority.clear(); }
		else {
			const next = authority.get(options.itemKey!);
			if (!next) throw new Error('Stale or invented item key');
			current = next; level++;
		}
		return result();
	});
	const browseLoad = vi.fn<LibraryDestinationTransaction['browseLoad']>(async (options) =>
		result(options.offset, options.count));
	return { browse, browseLoad };
}

function library(tags: BrowseItem[] | BrowseResult = [list('Night music', 'tag-night')]) {
	return tree({
		root: [list('Library', 'library'), list('Playlists', 'playlists'), list('My Live Radio', 'radio'), list('Settings', 'settings')],
		library: [list('Tracks', 'tracks'), list('Composers', 'composers'), list('Tags', 'tags'), list('Unfamiliar branch', 'unknown')],
		tracks: [row('A song')], composers: [], tags, radio: [row('Example FM')]
	}, 2);
}

describe('public Library destination inventory', () => {
	it('promotes every unique root/Library collection without opening child pages', async () => {
		const transaction = library();
		const inventory = await discoverLibraryDestinations(transaction, { zoneId: 'zone-a' });
		expect(inventory.destinations.filter((destination) => !destination.id.startsWith('public:')).map((destination) => destination.id))
			.toEqual(['tracks', 'composers', 'tags', 'internet-radio']);
		expect(inventory.destinations.map((destination) => destination.label)).toContain('Unfamiliar branch');
		expect(inventory.diagnostics).toEqual([]);
		for (const destination of inventory.destinations) {
			expect(normalizeBrowseHistorySnapshot(destination.snapshot)).toEqual(destination.snapshot);
			expect(JSON.stringify(destination.snapshot)).not.toContain('opaque-');
		}
		expect(transaction.browse).toHaveBeenCalledTimes(2);
		expect(transaction.browse.mock.calls.every(([options]) => options.zoneId === 'zone-a')).toBe(true);
		expect(transaction.browseLoad.mock.calls.every(([options]) => options.zoneId === 'zone-a')).toBe(true);
		expect(transaction.browseLoad).toHaveBeenCalled();
		expect(inventory.destinations.some((destination) => String(destination.id) === 'playlists')).toBe(false);
	});

	it.each([
		['empty', []],
		['action-list rows', page([row('Add a tag', { hint: 'action' })], { listHint: 'action_list' })],
		['Roon error', page([], { action: 'message', message: 'Tags are unavailable.', isError: true })],
		['informational message', page([row('Not collection evidence')], { action: 'message', message: 'Try again later.', isError: false })],
		['no collection action', page([row('Not collection evidence')], { action: 'none' })]
	])('keeps Tags selectable when its page is %s, without making page load a navigation prerequisite', async (_label, tags) => {
		const transaction = library(tags as BrowseItem[] | BrowseResult);
		const inventory = await discoverLibraryDestinations(transaction);
		expect(inventory.destinations.map((destination) => destination.id)).toContain('tags');
		expect(transaction.browse).toHaveBeenCalledTimes(2);
	});

	it('keeps configured known pages when the root is empty or reports a Roon error', async () => {
		for (const root of [[], page([], { action: 'message', message: 'The Core is reconnecting.', isError: true })]) {
			const inventory = await discoverLibraryDestinations(tree({ root }));
			expect(inventory.destinations.map((destination) => destination.id)).toEqual(['tracks', 'composers', 'tags', 'internet-radio']);
		}
	});

	it('accepts public generic hints and promotes unique unfamiliar sources without invoking them', async () => {
		const transaction = tree({ root: [list('Library', 'library', { hint: undefined }),
			list('New source', 'new', { hint: 'future_generic_hint' })],
			library: [list('Tracks', 'tracks', { hint: undefined }), list('Custom collection', 'custom', { hint: undefined })] });
		const inventory = await discoverLibraryDestinations(transaction);
		expect(inventory.destinations.map((destination) => destination.label)).toEqual([
			'Tracks', 'Composers', 'Tags', 'Live radio', 'New source', 'Custom collection'
		]);
		expect(transaction.browse).toHaveBeenCalledTimes(2);
		for (const destination of inventory.destinations.filter((entry) => entry.id.startsWith('public:'))) {
			expect(identifyLibraryDestination(destination.snapshot, inventory)).toBe(destination.id);
			expect(identifyLibraryDestination({ ...destination.snapshot, history: [...destination.snapshot.history,
				{ hierarchy: 'browse', breadcrumb: { title: 'A child' } }] }, inventory)).toBe(destination.id);
		}
	});

	it('never invokes actions, prompts, ambiguous names, or playlists during inventory', async () => {
		const transaction = tree({
			root: [list('Library', 'library'), list('My Live Radio', 'radio', { inputPrompt: 'Station URL' }), list('Playlists', 'playlists')],
			library: [list('Tracks', 'tracks'), list('Tracks', 'other-tracks'), list('Composers', 'composers', { hint: 'action' }),
				list('Tags', 'tags', { inputPrompt: '' }), list('Mutation', 'action', { hint: 'action' })]
		});
		const inventory = await discoverLibraryDestinations(transaction);
		expect(inventory.destinations.map((destination) => destination.id)).toEqual(['tracks', 'composers', 'tags', 'internet-radio']);
		expect(transaction.browse).toHaveBeenCalledTimes(2);
		expect(inventory.diagnostics.some((diagnostic) => diagnostic.branch === 'Tracks')).toBe(true);
	});

	it('retains stable custom paths across fresh keys and distinguishes returned same-title semantics', async () => {
		const transaction = tree({ root: [list('Service', 'one', { subtitle: 'One', imageKey: 'volatile-image-1' }),
			list('Service', 'two', { subtitle: 'Two', imageKey: 'volatile-image-2' }),
			list('Ambiguous', 'a'), list('Ambiguous', 'b')] });
		const first = await discoverLibraryDestinations(transaction);
		const second = await discoverLibraryDestinations(transaction);
		const custom = first.destinations.filter((entry) => entry.id.startsWith('public:'));
		expect(custom).toHaveLength(2);
		expect(new Set(custom.map((entry) => entry.id)).size).toBe(2);
		expect(JSON.stringify(custom)).not.toMatch(/volatile-image|opaque-/);
		expect(second.destinations).toEqual(first.destinations);
		expect(first.diagnostics.some((entry) => entry.branch === 'Ambiguous')).toBe(true);
		for (const destination of custom) {
			expect(resolveLibraryDestination(destination.id)).toEqual(destination);
		}
	});

	it('keeps saved missing custom pages addressable and reports absence on explicit open', async () => {
		const id = createPublicNavigationDestinationId([{ title: 'Library' }, { title: 'A saved collection' }]);
		const destination = resolveLibraryDestination(id)!;
		expect(destination.snapshot).toEqual(path('Library', 'A saved collection'));
		await expect(loadCompleteLibraryCollection(tree({ root: [list('Library', 'library')], library: [] }), destination.snapshot))
			.rejects.toThrow('A saved collection');
		expect(resolveLibraryDestination('tags')?.snapshot).toEqual(path('Library', 'Tags'));
		expect(resolveLibraryDestination('albums')).toBeNull();
	});

	it('bounds custom inventory and diagnoses an unencodable path without losing other pages', async () => {
		const tooLong = 'A'.repeat(257);
		const inventory = await discoverLibraryDestinations(tree({ root: [list(tooLong, 'too-long'),
			...Array.from({ length: MAX_CUSTOM_NAVIGATION_DESTINATIONS + 1 }, (_, index) => list(`Source ${index}`, `source-${index}`))] }));
		expect(inventory.destinations.filter((entry) => entry.id.startsWith('public:'))).toHaveLength(MAX_CUSTOM_NAVIGATION_DESTINATIONS);
		expect(inventory.diagnostics.map((entry) => entry.branch)).toEqual([tooLong, `Source ${MAX_CUSTOM_NAVIGATION_DESTINATIONS}`]);
		expect(inventory.destinations.some((entry) => entry.id === 'tags')).toBe(true);
	});

	it('identifies known and unique public descendants while ignoring unrelated search paths', async () => {
		const inventory = await discoverLibraryDestinations(library());
		const tracks = inventory.destinations.find((entry) => entry.id === 'tracks')!;
		const custom = inventory.destinations.find((entry) => entry.label === 'Unfamiliar branch')!;
		expect(identifyLibraryDestination(path('Library', 'Tracks'), inventory)).toBe('tracks');
		expect(identifyLibraryDestination(path('Library', 'Tracks', 'A song'), inventory)).toBe('tracks');
		expect(identifyLibraryDestination(path('Library', 'Unfamiliar branch'), inventory)).toBe(custom.id);
		expect(identifyLibraryDestination({ context: { hierarchy: 'search', query: 'Tracks' }, history: [], forward: [] }, inventory)).toBe('browse');
		expect(isLibraryDestinationRoot(path('Library', 'Tracks'), tracks)).toBe(true);
		expect(isLibraryDestinationRoot(path('Library', 'Tracks', 'A song'), tracks)).toBe(false);
	});
});

describe('complete public collection models', () => {
	it('loads a real public Tracks response larger than the first 100 rows, including its short final page', async () => {
		const tracks = Array.from({ length: 275 }, (_, index) => row(`Track ${String(index).padStart(3, '0')}`,
			{ subtitle: index === 274 ? 'Needle performer' : 'Performer' }));
		const transaction = tree({ root: [list('Tracks', 'tracks')], tracks }, 100);
		const originalLoad = transaction.browseLoad.getMockImplementation()!;
		// Roon may deliver short pages. The list count remains 275 on every
		// load response even though the final response only carries 75 rows.
		transaction.browseLoad.mockImplementation((options) => originalLoad({ ...options, count: Math.min(options.count ?? 100, 100) }));
		const model = await loadCompleteLibraryCollection(transaction, path('Tracks'));
		expect(model.complete).toBe(true);
		expect(model.result).toMatchObject({ offset: 0, count: 275, totalCount: 275 });
		expect(model.items).toHaveLength(275);
		expect(transaction.browseLoad.mock.calls.map(([options]) => options.offset)).toEqual([100, 200]);
		const pages = await Promise.all(transaction.browseLoad.mock.results.map((result) => result.value));
		expect(pages.map((result) => [result.count, result.totalCount, result.items.length])).toEqual([[275, 275, 100], [275, 275, 75]]);
		expect(filterSortLibraryCollection(model, { filter: 'Needle performer', sort: 'name-desc' }).items.map((item) => item.title))
			.toEqual(['Track 274']);
	});

	it.each([
		['page-sized count conflicting with its total', { count: 1 }],
		['negative count', { count: -1 }],
		['fractional count', { count: 3.5 }],
		['nonzero first-page offset', { offset: 1 }],
		['items beyond the collection total', { count: 0, totalCount: 0 }]
	])('rejects a genuinely inconsistent initial collection: %s', async (_label, overrides) => {
		const transaction = tree({ root: page([row('First')], { totalCount: 3, ...overrides }) });
		const model = await loadCompleteLibraryCollection(transaction, ROOT);
		expect(model.complete).toBe(false);
		expect(model.diagnostic?.message).toBe('Roon returned an inconsistent collection page.');
		expect(transaction.browseLoad).not.toHaveBeenCalled();
	});

	it('loads every page before stable name sorting/filtering, preserving source rows and total', async () => {
		const transaction = tree({ root: [list('Tracks', 'tracks')], tracks: [
			row('Zulu'), row('Echo', { subtitle: 'First performer' }), row('echo', { subtitle: 'Second performer' }),
			row('A track'), row('Needle', { subtitle: 'Distant performer' })
		] }, 2);
		const model = await loadCompleteLibraryCollection(transaction, path('Tracks'));
		expect(model.complete).toBe(true);
		expect(model.items).toHaveLength(5);
		expect(model.result).toMatchObject({ offset: 0, count: 5, totalCount: 5 });
		expect(model.snapshot).toEqual(path('Tracks'));
		expect(filterSortLibraryCollection(model, { filter: 'distant' })).toMatchObject({ totalCount: 5, matchCount: 1, items: [row('Needle', { subtitle: 'Distant performer' })] });
		expect(filterSortLibraryCollection(model, { sort: 'name-asc' }).items.map((item) => item.title)).toEqual(['A track', 'Echo', 'echo', 'Needle', 'Zulu']);
		expect(filterSortLibraryCollection(model, { sort: 'name-desc' }).items.map((item) => item.title)).toEqual(['Zulu', 'Needle', 'Echo', 'echo', 'A track']);
		expect(model.items[0].title).toBe('Zulu');
		expect(transaction.browseLoad.mock.calls.map(([options]) => options.offset)).toEqual([2]);
	});

	it('sorts full displayed artist credits in both directions, with title ties and missing credits last', async () => {
		const original = [
			row('A song', { subtitle: 'Zulu, Guest' }),
			row('Unknown A'),
			row('Z song', { subtitle: 'Alpha, Guest' }),
			row('B song', { subtitle: 'Alpha, Guest' }),
			row('Unknown B', { subtitle: '  ' }),
			row('Middle song', { subtitle: 'Beta' })
		];
		const model = await loadCompleteLibraryCollection(tree({ root: original }, 2), ROOT);
		expect(filterSortLibraryCollection(model, { sort: 'artist-asc' }).items.map(item => item.title))
			.toEqual(['B song', 'Z song', 'Middle song', 'A song', 'Unknown A', 'Unknown B']);
		expect(filterSortLibraryCollection(model, { sort: 'artist-desc' }).items.map(item => item.title))
			.toEqual(['A song', 'Middle song', 'B song', 'Z song', 'Unknown A', 'Unknown B']);
		expect(filterSortLibraryCollection(model, { sort: 'artist-asc', filter: 'Guest' }).items.map(item => item.title))
			.toEqual(['B song', 'Z song', 'A song']);
		expect(model.items).toEqual(original);
		expect(filterSortLibraryCollection(model, { sort: 'original' }).items).toEqual(original);
	});

	it.each([
		['changed total', { totalCount: 4 }],
		['wrong offset', { offset: 0 }],
		['short empty page', { items: [], count: 0 }],
		['different level', { level: 2 }],
		['different collection', { title: 'Elsewhere' }],
		['inconsistent count', { count: 99 }]
	])('refuses local transforms after %s', async (_label, overrides) => {
		const transaction = tree({ root: [row('First'), row('Second'), row('Third')] }, 1);
		transaction.browseLoad.mockResolvedValueOnce(page([row('Second'), row('Third')], { title: 'root', offset: 1, totalCount: 3, ...overrides }));
		const model = await loadCompleteLibraryCollection(transaction, ROOT);
		expect(model.complete).toBe(false);
		expect(model.diagnostic?.isError).toBe(true);
		expect(() => filterSortLibraryCollection(model, { filter: 'Third' })).toThrow('complete collection');
	});

	it('preserves a mid-pagination Roon message and never treats missing totals as completion', async () => {
		const transaction = tree({ root: [row('First'), row('Second')] }, 1);
		transaction.browseLoad.mockResolvedValueOnce(page([], { action: 'message', message: 'Please reconnect.', isError: false }));
		const model = await loadCompleteLibraryCollection(transaction, ROOT);
		expect(model.complete).toBe(false);
		expect(model.diagnostic).toEqual({ action: 'message', message: 'Please reconnect.', isError: false });
		expect(model.items.map((item) => item.title)).toEqual(['First']);
		const noTotal = tree({ root: page([], { totalCount: undefined }) });
		expect((await loadCompleteLibraryCollection(noTotal, ROOT)).complete).toBe(false);
	});

	it('rejects over-limit collections before fetching, while a proven empty collection is complete', async () => {
		const transaction = tree({ root: [row('First'), row('Second')] }, 1);
		const model = await loadCompleteLibraryCollection(transaction, ROOT, { maxItems: 1 });
		expect(model.complete).toBe(false);
		expect(transaction.browseLoad).not.toHaveBeenCalled();
		const empty = await loadCompleteLibraryCollection(tree({ root: [] }), ROOT);
		expect(filterSortLibraryCollection(empty)).toEqual({ items: [], totalCount: 0, matchCount: 0 });
	});

	it('re-resolves a generic public row only when the user opens its collection', async () => {
		const transaction = tree({ root: [list('Source', 'source', { hint: undefined })], source: [row('An album')] });
		const inventory = await discoverLibraryDestinations(transaction);
		expect(transaction.browse).toHaveBeenCalledTimes(1);
		const source = inventory.destinations.find((entry) => entry.label === 'Source')!;
		const collection = await loadCompleteLibraryCollection(transaction, source.snapshot);
		expect(collection.complete).toBe(true);
		expect(collection.items.map((entry) => entry.title)).toEqual(['An album']);
	});

	it('throws on stale/unsafe semantic paths and preserves callback failures', async () => {
		await expect(loadCompleteLibraryCollection(tree({ root: [] }), path('Missing'))).rejects.toBeInstanceOf(LibraryCollectionPathError);
		await expect(loadCompleteLibraryCollection(tree({ root: [list('Tracks', 'tracks', { hint: 'action' })] }), path('Tracks'))).rejects.toBeInstanceOf(LibraryCollectionPathError);
		const transaction = tree({ root: [] });
		transaction.browse.mockRejectedValueOnce(new Error('Core disconnected'));
		await expect(loadCompleteLibraryCollection(transaction, ROOT)).rejects.toThrow('Core disconnected');
	});
});


describe('legacy Browse excludes promoted peers and known duplicate branches', () => {
	it('removes known root duplicates and ineligible Playlists while preserving Library and unknown sources', async () => {
		const inventory = await discoverLibraryDestinations(library());
		const rows = [list('Library', 'library'), list('Settings', 'settings'), list('Genres', 'genres'),
			list('Playlists', 'playlists'), list('My Live Radio', 'radio'), list('New source', 'new-source')];
		expect(filterRedundantBrowseItems(ROOT, rows, inventory).map((item) => item.title)).toEqual(['Library', 'New source']);
		expect(rows).toHaveLength(6);
	});

	it('removes known peers even when their collections are empty', async () => {
		const inventory = await discoverLibraryDestinations(library([]));
		const rows = [list('Search', 'search', { inputPrompt: 'Search' }), list('Artists', 'artists'), list('Albums', 'albums'),
			list('Tracks', 'tracks'), list('Composers', 'composers'), list('Tags', 'tags'), list('New collection', 'new')];
		expect(filterRedundantBrowseItems(path('Library'), rows, inventory).map((item) => item.title)).toEqual(['New collection']);
		expect(filterRedundantBrowseItems(ROOT, [list('My Live Radio', 'radio')], null)).toHaveLength(1);
		expect(filterRedundantBrowseItems(path('Library'), [list('Tracks', 'tracks')], null)).toHaveLength(1);
	});

	it('does not hide names in search, unknown parents, or deeper collections', async () => {
		const inventory = await discoverLibraryDestinations(library());
		const rows = [list('Settings', 'settings'), list('Artists', 'artists'), list('Playlists', 'playlists'), list('Tracks', 'tracks')];
		for (const snapshot of [path('New source'), path('Library', 'Tags'),
			{ context: { hierarchy: 'search', query: 'music' }, history: [], forward: [] } as BrowseHistorySnapshot]) {
			expect(filterRedundantBrowseItems(snapshot, rows, inventory)).toEqual(rows);
		}
		expect(filterRedundantBrowseItems(ROOT, [row('Genres', { hint: 'header' })], inventory)).toEqual([row('Genres', { hint: 'header' })]);
	});
});


describe('complete-list identity validation', () => {
	it('rejects a repeated opaque row even when offsets and totals look complete', async () => {
		const repeated = list('Same row', 'same-key');
		const transaction: LibraryDestinationTransaction = {
			browse: async () => page([repeated], { title: 'Tracks', totalCount: 2 }),
			browseLoad: async () => page([repeated], { title: 'Tracks', offset: 1, totalCount: 2 })
		};
		const model = await loadCompleteLibraryCollection(transaction, ROOT);
		expect(model.complete).toBe(false);
		expect(model.diagnostic?.message).toContain('repeated an item');
	});
});
