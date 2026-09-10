import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClassicBrowseApiTransaction } from '$lib/api/client';
import type { BrowseHistorySnapshot } from '$lib/libraryPageState';
import type { ClassicBrowseSessionClaim } from '$lib/stores/classicBrowseSessionStore';
import type { BrowseItem, BrowseResult, SearchResult } from '@shared/types';
import {
	createUnifiedBrowseActionController,
	createUnifiedBrowseController
} from '../UnifiedBrowseController';

const CLAIM = {
	owner: 'unified-mode',
	claimId: 9,
	ready: Promise.resolve({ handleId: 'browse-test', generation: 1 })
} as unknown as ClassicBrowseSessionClaim;

function row(title: string, itemKey?: string, over: Partial<BrowseItem> = {}): BrowseItem {
	return {
		title,
		...(itemKey ? { itemKey } : {}),
		isLoadable: false,
		isPlayable: false,
		...over
	};
}

function page(
	items: BrowseItem[],
	over: Partial<Omit<BrowseResult, 'items'>> = {}
): BrowseResult {
	return {
		level: 0,
		offset: 0,
		count: over.totalCount ?? items.length,
		totalCount: items.length,
		items,
		...over
	};
}

function dependencies(transaction: ClassicBrowseApiTransaction) {
	return {
		transaction: vi.fn(async (_role, _claim, work) => work(transaction)),
		isClaimCurrent: vi.fn(() => true)
	};
}

describe('UnifiedBrowseController', () => {
 it('commits a complete 275-row collection only after every page is loaded', async () => {
  const items = Array.from({ length: 275 }, (_, index) => row(`Track ${index}`, `track-${index}`, { itemType: 'track' }));
  let resolveLast!: (value: BrowseResult) => void;
  const lastPage = new Promise<BrowseResult>(resolve => { resolveLast = resolve; });
  const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async options => options.itemKey
   ? page(items.slice(0, 100), { title: 'Tracks', level: 1, totalCount: items.length })
   : page([row('Tracks', 'fresh-tracks', { hint: 'list' })], { title: 'Browse' }));
  const browseLoad = vi.fn<ClassicBrowseApiTransaction['browseLoad']>(async options => options.offset === 100
   ? page(items.slice(100, 200), { title: 'Tracks', level: 1, offset: 100, totalCount: items.length })
   : lastPage);
  const transaction = { browse, browseLoad } as unknown as ClassicBrowseApiTransaction;
  const deps = dependencies(transaction);
  const controller = createUnifiedBrowseController(deps);
  const snapshot: BrowseHistorySnapshot = { context: { hierarchy: 'browse' }, history: [{ hierarchy: 'browse', breadcrumb: { title: 'Tracks' } }], forward: [] };
  const loading = controller.restore(CLAIM, snapshot, 'zone-1', { complete: true });
  await vi.waitFor(() => expect(browseLoad).toHaveBeenCalledTimes(2));
  expect(get(controller)).toMatchObject({ phase: 'loading', result: null, snapshot });
  resolveLast(page(items.slice(200), { title: 'Tracks', level: 1, offset: 200, totalCount: items.length }));
  await expect(loading).resolves.toBe(true);
  expect(get(controller)).toMatchObject({ phase: 'ready', result: { items, count: 275, totalCount: 275, offset: 0 }, snapshot, error: null });
  expect(deps.transaction).toHaveBeenCalledTimes(1);
  expect(deps.transaction).toHaveBeenCalledWith('classic-browse', CLAIM, expect.any(Function));
  expect(browseLoad.mock.calls.map(([options]) => options)).toEqual([
   { hierarchy: 'browse', zoneId: 'zone-1', offset: 100, count: 175 },
   { hierarchy: 'browse', zoneId: 'zone-1', offset: 200, count: 75 }
  ]);
  expect(JSON.stringify(get(controller).snapshot)).not.toContain('fresh-tracks');
 });

 it('stops a superseded complete read at the next batch boundary', async () => {
  const items = Array.from({ length: 275 }, (_, index) => row(`Track ${index}`, `track-${index}`));
  let release!: (result: BrowseResult) => void;
  const delayed = new Promise<BrowseResult>(resolve => { release = resolve; });
  const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async () => page(items.slice(0, 100), { totalCount: 275 }));
  const browseLoad = vi.fn<ClassicBrowseApiTransaction['browseLoad']>(async options => options.offset === 100 ? delayed : page(items.slice(200), { offset: 200, totalCount: 275 }));
  const controller = createUnifiedBrowseController(dependencies({ browse, browseLoad } as unknown as ClassicBrowseApiTransaction));
  const loading = controller.restore(CLAIM, { context: { hierarchy: 'browse' }, history: [], forward: [] }, undefined, { complete: true });
  await vi.waitFor(() => expect(browseLoad).toHaveBeenCalledTimes(1));
  controller.reset();
  release(page(items.slice(100, 200), { offset: 100, totalCount: 275 }));
  await expect(loading).resolves.toBe(false);
  expect(browseLoad).toHaveBeenCalledTimes(1);
  expect(get(controller).phase).toBe('idle');
 });

 it('does not publish a partial collection after an incomplete page', async () => {
  const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async options => options.itemKey
   ? page(Array.from({ length: 100 }, (_, index) => row(`Track ${index}`, `track-${index}`)), { title: 'Tracks', level: 1, totalCount: 150 })
   : page([row('Tracks', 'fresh-tracks', { hint: 'list' })], { title: 'Browse' }));
  const browseLoad = vi.fn<ClassicBrowseApiTransaction['browseLoad']>(async () =>
   page([], { title: 'Tracks', offset: 100, level: 1, totalCount: 150 }));
  const controller = createUnifiedBrowseController(dependencies({ browse, browseLoad } as unknown as ClassicBrowseApiTransaction));
  await expect(controller.restore(CLAIM, {
   context: { hierarchy: 'browse' }, history: [{ hierarchy: 'browse', breadcrumb: { title: 'Tracks' } }], forward: []
  }, 'zone-1', { complete: true })).resolves.toBe(false);
  expect(get(controller)).toMatchObject({ phase: 'error', result: null, snapshot: { history: [{ hierarchy: 'browse', breadcrumb: { title: 'Tracks' } }] }, notice: null });
  expect(get(controller).error).toBe('The collection changed or ended before every item was loaded.');
  expect(browseLoad).toHaveBeenCalledTimes(1);
 });

 it.each([false, true])('preserves a complete-collection Roon message with isError=%s', async isError => {
  const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async options => options.itemKey
   ? page(Array.from({ length: 100 }, (_, index) => row(`Track ${index}`, `track-${index}`)), { title: 'Tracks', level: 1, totalCount: 150 })
   : page([row('Tracks', 'fresh-tracks', { hint: 'list' })], { title: 'Browse' }));
  const diagnostic = page([], { action: 'message', message: 'This collection is temporarily unavailable.', isError, offset: 100, level: 1 });
  const browseLoad = vi.fn<ClassicBrowseApiTransaction['browseLoad']>(async () => diagnostic);
  const controller = createUnifiedBrowseController(dependencies({ browse, browseLoad } as unknown as ClassicBrowseApiTransaction));
  const snapshot: BrowseHistorySnapshot = {
   context: { hierarchy: 'browse' }, history: [{ hierarchy: 'browse', breadcrumb: { title: 'Tracks' } }], forward: []
  };
  await expect(controller.restore(CLAIM, snapshot, 'zone-1', { complete: true })).resolves.toBe(true);
  expect(get(controller)).toEqual({ phase: 'ready', result: diagnostic, snapshot, notice: null, error: null });
  expect(get(controller).result!.items).toEqual([]);
  expect(browseLoad).toHaveBeenCalledTimes(1);
 });

	it('re-resolves every semantic breadcrumb from a fresh root', async () => {
		const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async (options) => {
			if (!options.itemKey) return page([row('Library', 'fresh-library')], { title: 'Browse' });
			if (options.itemKey === 'fresh-library') {
				return page([row('Tracks', 'fresh-tracks')], { title: 'Library', level: 1 });
			}
			return page([row('A Song', 'live-song')], { title: 'Tracks', level: 2 });
		});
		const transaction = {
			browse,
			browseLoad: vi.fn(),
			browsePop: vi.fn(),
			browseSearch: vi.fn()
		} as unknown as ClassicBrowseApiTransaction;
		const controller = createUnifiedBrowseController(dependencies(transaction));

		await expect(
			controller.restore(CLAIM, {
				context: { hierarchy: 'browse' },
				history: [
					{ hierarchy: 'browse', breadcrumb: { title: 'Library' } },
					{ hierarchy: 'browse', breadcrumb: { title: 'Tracks' } }
				],
				forward: []
			})
		).resolves.toBe(true);

		const state = get(controller);
		expect(state.phase).toBe('ready');
		expect(state.result?.title).toBe('Tracks');
		expect(browse.mock.calls.map(([options]) => options.itemKey ?? 'root')).toEqual([
			'root',
			'fresh-library',
			'fresh-tracks'
		]);
		expect(JSON.stringify(state.snapshot)).not.toContain('fresh-');
	});

	it('matches a restored search category when its result count changed', async () => {
		const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async (options) =>
			options.itemKey
				? page([row('Ashes to Ashes', 'song')], { title: 'Tracks', level: 1 })
				: page([
						row('Tracks', 'tracks-category', {
							hint: 'list',
							subtitle: '99 Results'
						})
					])
		);
		const transaction = {
			browse,
			browseLoad: vi.fn(),
			browsePop: vi.fn(),
			browseSearch: vi.fn()
		} as unknown as ClassicBrowseApiTransaction;
		const controller = createUnifiedBrowseController(dependencies(transaction));

		await controller.restore(CLAIM, {
			context: { hierarchy: 'search', query: 'bowie' },
			history: [
				{
					hierarchy: 'search',
					breadcrumb: { title: 'Tracks', subtitle: '2 Results', searchCategory: true }
				}
			],
			forward: []
		});

		expect(get(controller).result?.title).toBe('Tracks');
		expect(browse.mock.calls[0][0]).toMatchObject({
			hierarchy: 'search',
			input: 'bowie',
			popAll: true
		});
	});

	it('does not commit a requested path when readiness fails', async () => {
		const transaction = {
			browse: vi.fn().mockRejectedValue(new Error('offline')),
			browseLoad: vi.fn(),
			browsePop: vi.fn(),
			browseSearch: vi.fn()
		} as unknown as ClassicBrowseApiTransaction;
		const controller = createUnifiedBrowseController(dependencies(transaction));

		await controller.restore(CLAIM, {
			context: { hierarchy: 'browse' },
			history: [{ hierarchy: 'browse', breadcrumb: { title: 'Library' } }],
			forward: []
		});

		expect(get(controller)).toMatchObject({
			phase: 'error',
			snapshot: { context: { hierarchy: 'browse' }, history: [], forward: [] }
		});
	});

	it('fails closed at the last unambiguous parent', async () => {
		const transaction = {
			browse: vi.fn(async () =>
				page([row('Library', 'one'), row('Library', 'two')], { title: 'Browse' })
			),
			browseLoad: vi.fn(),
			browsePop: vi.fn(),
			browseSearch: vi.fn()
		} as unknown as ClassicBrowseApiTransaction;
		const controller = createUnifiedBrowseController(dependencies(transaction));

		await controller.restore(CLAIM, {
			context: { hierarchy: 'browse' },
			history: [{ hierarchy: 'browse', breadcrumb: { title: 'Library' } }],
			forward: []
		});

		expect(get(controller)).toMatchObject({
			phase: 'ready',
			snapshot: { history: [] }
		});
		expect(get(controller).notice).toContain('ambiguous');
	});

	it.each(['browse', 'search'] as const)('loads the complete %s list before ready, preserving tail identity', async hierarchy => {
		const items = Array.from({ length: 275 }, (_, index) => row(`Row ${index}`, `key-${index}`));
		const transaction = {
			browse: vi.fn(async () => page(items.slice(0, 100), { title: 'Results', totalCount: 275 })),
			browseLoad: vi.fn(async (options: Parameters<ClassicBrowseApiTransaction['browseLoad']>[0]) => {
				const offset = options.offset ?? 0;
				return page(items.slice(offset, offset + 100), { title: 'Results', offset, totalCount: 275 });
			})
		} as unknown as ClassicBrowseApiTransaction;
		const controller = createUnifiedBrowseController(dependencies(transaction));
		const snapshot: BrowseHistorySnapshot = { context: hierarchy === 'search' ? { hierarchy, query: 'needle' } : { hierarchy }, history: [], forward: [] };
		await expect(controller.restore(CLAIM, snapshot)).resolves.toBe(true);
		expect(get(controller).result?.items).toEqual(items);
		expect(get(controller).result?.items[274]).toBe(items[274]);
		expect(transaction.browseLoad).toHaveBeenLastCalledWith({ hierarchy, offset: 200, count: 75 });
		expect(get(controller).snapshot).toEqual(snapshot);
	});

	it('fails a complete read atomically and retries from a fresh root', async () => {
		const items = Array.from({ length: 200 }, (_, index) => row(`Row ${index}`, `key-${index}`));
		const transaction = {
			browse: vi.fn(async () => page(items.slice(0, 100), { title: 'Results', totalCount: 200 })),
			browseLoad: vi.fn().mockRejectedValueOnce(new Error('temporary timeout'))
				.mockResolvedValueOnce(page(items.slice(100), { title: 'Results', offset: 100, totalCount: 200 }))
		} as unknown as ClassicBrowseApiTransaction;
		const controller = createUnifiedBrowseController(dependencies(transaction));
		const snapshot: BrowseHistorySnapshot = { context: { hierarchy: 'browse' }, history: [], forward: [] };
		await expect(controller.restore(CLAIM, snapshot)).resolves.toBe(false);
		expect(get(controller)).toMatchObject({ phase: 'error', error: 'temporary timeout', result: null });
		await expect(controller.restore(CLAIM, snapshot)).resolves.toBe(true);
		expect(get(controller).result?.items).toEqual(items);
		expect(transaction.browse).toHaveBeenCalledTimes(2);
	});

	it('drills a row after validating the complete parent list', async () => {
		const visible = Array.from({ length: 54_082 }, (_, index) =>
			row(index === 72 ? 'Target folder' : `Row ${index}`, `key-${index}`, {
				hint: 'list',
				isLoadable: true
			})
		);
		const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async (options) =>
			options.itemKey === 'key-72'
				? page([row('Child', 'child')], { title: 'Target folder', level: 1 })
				: page(visible.slice(0, 100), { title: 'Tracks', totalCount: 54_082 })
		);
		const transaction = {
			browse,
			browseLoad: vi.fn(async (options: Parameters<ClassicBrowseApiTransaction['browseLoad']>[0]) => { const offset = options.offset ?? 0; return page(visible.slice(offset, offset + (options.count ?? 100)), { title: 'Tracks', offset, totalCount: 54_082 }); }),
			browsePop: vi.fn(),
			browseSearch: vi.fn()
		} as unknown as ClassicBrowseApiTransaction;
		const controller = createUnifiedBrowseController(dependencies(transaction));

		await controller.restore(CLAIM, {
			context: { hierarchy: 'browse' },
			history: [],
			forward: []
		});
		await expect(controller.openItem(CLAIM, visible[72])).resolves.toBe(true);

		expect(get(controller).result?.title).toBe('Target folder');
		expect(get(controller).snapshot.history[0]).toMatchObject({
			breadcrumb: { title: 'Target folder' },
			restoreCount: 54_082
		});
		expect(get(controller).result?.items).toHaveLength(1);
	});
});

describe('UnifiedBrowseActionController', () => {
	let issued: string[];
	let transaction: ClassicBrowseApiTransaction;

	beforeEach(() => {
		issued = [];
		transaction = {
			browse: vi.fn(async (options) => {
				if (options.input) {
					return page([
						row('Tracks', 'category-key', {
							hint: 'list',
							subtitle: '8 Results'
						})
					]);
				}
				if (options.itemKey === 'category-key') {
					return page([
						row('Heroes', 'fresh-song', {
							hint: 'action_list',
							subtitle: 'David Bowie',
							itemType: 'track'
						})
					]);
				}
				if (options.itemKey === 'fresh-song') {
					return page([
						row('Play Now', 'play-key', { hint: 'action', isPlayable: true }),
						row('Add Next', 'next-key', { hint: 'action', isPlayable: true }),
						row('Queue', 'queue-key', { hint: 'action', isPlayable: true })
					]);
				}
				issued.push(options.itemKey ?? 'missing');
				return page([]);
			}),
			browseLoad: vi.fn(),
			browsePop: vi.fn(),
			browseSearch: vi.fn()
		} as unknown as ClassicBrowseApiTransaction;
	});

	it('discovers actions from a freshly resolved keyless search row', async () => {
		const controller = createUnifiedBrowseActionController(dependencies(transaction));
		const result: SearchResult = {
			...row('Heroes', 'stale-key', {
				hint: 'action_list',
				subtitle: 'David Bowie',
				itemType: 'track'
			}),
			resultType: 'track',
			categoryTitle: 'Tracks',
			categoryTotal: 8
		};

		await expect(
			controller.open(CLAIM, { kind: 'search', query: 'heroes', item: result }, 'zone-a')
		).resolves.toBe(true);

		const state = get(controller);
		expect(state.phase).toBe('ready');
		expect(state.available).toEqual({ 'play-now': true, 'add-next': true, queue: true });
		expect(JSON.stringify(state.source)).not.toContain('stale-key');
	});

	it('re-resolves again before issuing the selected action', async () => {
		const controller = createUnifiedBrowseActionController(dependencies(transaction));
		const result: SearchResult = {
			...row('Heroes', undefined, {
				hint: 'action_list',
				subtitle: 'David Bowie',
				itemType: 'track'
			}),
			resultType: 'track',
			categoryTitle: 'Tracks'
		};
		await controller.open(CLAIM, { kind: 'search', query: 'heroes', item: result }, 'zone-a');

		await expect(controller.execute(CLAIM, 'add-next', 'zone-a')).resolves.toBe(true);

		expect(issued).toEqual(['next-key']);
		expect(get(controller).phase).toBe('success');
	});

	it('resolves actions for a visible row in a 54,082-row level', async () => {
		const visible = Array.from({ length: 54_082 }, (_, index) =>
			row(index === 37 ? 'Heroes' : `Track ${index}`, `track-${index}`, {
				hint: 'action_list',
				itemType: 'track'
			})
		);
		const largeTransaction = {
			browse: vi.fn(async (options) => {
				if (options.itemKey === 'track-37') {
					return page([
						row('Play Now', 'play-key', { hint: 'action', isPlayable: true }),
						row('Add Next', 'next-key', { hint: 'action', isPlayable: true }),
						row('Queue', 'queue-key', { hint: 'action', isPlayable: true })
					]);
				}
				return page(visible, { title: 'Tracks', totalCount: 54_082 });
			}),
			browseLoad: vi.fn(),
			browsePop: vi.fn(),
			browseSearch: vi.fn()
		} as unknown as ClassicBrowseApiTransaction;
		const controller = createUnifiedBrowseActionController(dependencies(largeTransaction));

		await expect(
			controller.open(
				CLAIM,
				{
					kind: 'browse',
					snapshot: { context: { hierarchy: 'browse' }, history: [], forward: [] },
					item: visible[37],
					restoreCount: 100
				},
				'zone-a'
			)
		).resolves.toBe(true);

		expect(get(controller)).toMatchObject({
			phase: 'ready',
			available: { 'play-now': true, 'add-next': true, queue: true }
		});
		expect(largeTransaction.browseLoad).not.toHaveBeenCalled();
	});
});


describe('exact public Browse action selection', () => {
	function fixture() {
		const copies = ['copy-one', 'copy-two'].map(itemKey => row('(Coffee’s for Closers)', itemKey,
			{ subtitle: 'Fall Out Boy', hint: 'action_list', itemType: 'track' }));
		const issued: string[] = [];
		let expired = false;
		const transaction = {
			browse: vi.fn(async (options) => {
				if (options.popAll) return page(copies, { title: 'Tracks' });
				const key = options.itemKey ?? '';
				if (expired) throw new Error('The selected item key has expired.');
				if (copies.some(item => item.itemKey === key)) return page([
					row('Play Now', `${key}:${options.zoneId}:play`, { hint: 'action', isPlayable: true }),
					row('Add Next', `${key}:${options.zoneId}:next`, { hint: 'action', isPlayable: true }),
					row('Queue', `${key}:${options.zoneId}:queue`, { hint: 'action', isPlayable: true })
				], { title: 'Actions', level: 1 });
				issued.push(key);
				return page([]);
			}),
			browseLoad: vi.fn(), browsePop: vi.fn(), browseSearch: vi.fn()
		} as unknown as ClassicBrowseApiTransaction;
		const deps = dependencies(transaction);
		const controller = createUnifiedBrowseActionController(deps);
		const source = { kind: 'browse' as const,
			snapshot: { context: { hierarchy: 'browse' as const }, history: [], forward: [] },
			item: copies[1], restoreCount: copies.length };
		return { controller, source, transaction, deps, issued, expire: () => { expired = true; } };
	}

	it('opens the exact second identical track and executes only its advertised leaf without replay', async () => {
		const { controller, source, transaction, issued } = fixture();
		expect(await controller.open(CLAIM, source, 'zone-a')).toBe(true);
		expect(get(controller).available).toEqual({ 'play-now': true, 'add-next': true, queue: true });
		expect(issued).toEqual([]);
		expect(JSON.stringify(get(controller).source)).not.toContain('copy-two');
		expect(await controller.execute(CLAIM, 'add-next', 'zone-a')).toBe(true);
		expect(issued).toEqual(['copy-two:zone-a:next']);
		expect(vi.mocked(transaction.browse).mock.calls.map(([options]) => options.itemKey)).toEqual(['copy-two', 'copy-two:zone-a:next']);
		expect(transaction.browseLoad).not.toHaveBeenCalled();
		expect(transaction.browsePop).not.toHaveBeenCalled();
	});

	it('keeps the exact selection when the same published source is reprobed for a new zone', async () => {
		const { controller, source, transaction, issued } = fixture();
		await controller.open(CLAIM, source, 'zone-a');
		const published = get(controller).source!;
		expect(await controller.open(CLAIM, published, 'zone-b')).toBe(true);
		expect(await controller.execute(CLAIM, 'play-now', 'zone-a')).toBe(false);
		expect(issued).toEqual([]);
		expect(await controller.execute(CLAIM, 'play-now', 'zone-b')).toBe(true);
		expect(issued).toEqual(['copy-two:zone-b:play']);
		expect(vi.mocked(transaction.browse).mock.calls.map(([options]) => options.itemKey)).toEqual(['copy-two', 'copy-two', 'copy-two:zone-b:play']);
	});

	it('refuses an expired exact row without falling back to matching display text', async () => {
		const { controller, source, transaction, issued, expire } = fixture();
		expire();
		expect(await controller.open(CLAIM, source, 'zone-a')).toBe(false);
		expect(get(controller).error).toContain('expired');
		expect(vi.mocked(transaction.browse).mock.calls.map(([options]) => options.itemKey)).toEqual(['copy-two']);
		expect(issued).toEqual([]);
	});

	it('refuses an expired advertised leaf without reopening the track or issuing a replacement', async () => {
		const { controller, source, transaction, issued, expire } = fixture();
		await controller.open(CLAIM, source, 'zone-a');
		expire();
		expect(await controller.execute(CLAIM, 'queue', 'zone-a')).toBe(false);
		expect(get(controller).error).toContain('expired');
		expect(vi.mocked(transaction.browse).mock.calls.map(([options]) => options.itemKey)).toEqual(['copy-two', 'copy-two:zone-a:queue']);
		expect(issued).toEqual([]);
	});

	it('refuses a changed claim and clears private selection on reset', async () => {
		const { controller, source, transaction, issued } = fixture();
		await controller.open(CLAIM, source, 'zone-a');
		const published = get(controller).source!;
		expect(await controller.execute({ ...CLAIM, claimId: CLAIM.claimId + 1 }, 'queue', 'zone-a')).toBe(false);
		controller.reset();
		expect(await controller.open(CLAIM, published, 'zone-a')).toBe(false);
		expect(get(controller).error).toMatch(/select.*again/i);
		expect(transaction.browse).toHaveBeenCalledTimes(1);
		expect(issued).toEqual([]);
	});

	it('retains initial exact selection until a zone is selected', async () => {
		const { controller, source, transaction } = fixture();
		expect(await controller.open(CLAIM, source)).toBe(true);
		expect(transaction.browse).not.toHaveBeenCalled();
		expect(await controller.open(CLAIM, get(controller).source!, 'zone-a')).toBe(true);
		expect(vi.mocked(transaction.browse).mock.calls[0][0].itemKey).toBe('copy-two');
	});

	it('does not issue an obsolete probe after reset while its transaction is queued', async () => {
		const { controller, source, transaction, deps } = fixture();
		let release!: () => Promise<void>;
		deps.transaction.mockImplementationOnce((_role, _claim, work) => new Promise((resolve, reject) => {
			release = async () => { try { resolve(await work(transaction)); } catch (error) { reject(error); } };
		}));
		const pending = controller.open(CLAIM, source, 'zone-a');
		controller.reset();
		await release();
		expect(await pending).toBe(false);
		expect(transaction.browse).not.toHaveBeenCalled();
		expect(get(controller).phase).toBe('idle');
	});

	it('does not issue an advertised leaf after reset while execution is queued', async () => {
		const { controller, source, transaction, deps, issued } = fixture();
		await controller.open(CLAIM, source, 'zone-a');
		let release!: () => Promise<void>;
		deps.transaction.mockImplementationOnce((_role, _claim, work) => new Promise((resolve, reject) => {
			release = async () => { try { resolve(await work(transaction)); } catch (error) { reject(error); } };
		}));
		const pending = controller.execute(CLAIM, 'queue', 'zone-a');
		controller.reset();
		await release();
		expect(await pending).toBe(false);
		expect(transaction.browse).toHaveBeenCalledTimes(1);
		expect(issued).toEqual([]);
	});
});


describe('search action ambiguity across the complete root', () => {
	it('refuses an equally matching tail duplicate before probing either action menu', async () => {
		const original = row('Same track', undefined, { subtitle: 'Same artist', hint: 'action_list', itemType: 'track' });
		const rows = Array.from({ length: 275 }, (_, index) => row(`Other ${index}`, `other-${index}`));
		rows[3] = { ...original, itemKey: 'first-duplicate' };
		rows[274] = { ...original, itemKey: 'tail-duplicate' };
		const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async options => options.itemKey
			? page([row('Queue', 'wrong-queue', { hint: 'action', isPlayable: true })])
			: page(rows.slice(0, 100), { totalCount: 275 }));
		const browseLoad = vi.fn<ClassicBrowseApiTransaction['browseLoad']>(async options => {
			const offset = options.offset ?? 0;
			return page(rows.slice(offset, offset + 100), { offset, totalCount: 275 });
		});
		const controller = createUnifiedBrowseActionController(dependencies({ browse, browseLoad } as unknown as ClassicBrowseApiTransaction));
		await expect(controller.open(CLAIM, { kind: 'search', query: 'Same track', item: { ...original, resultType: 'track' } }, 'zone-a')).resolves.toBe(false);
		expect(browseLoad).toHaveBeenCalledTimes(2);
		expect(browse.mock.calls.some(([options]) => options.itemKey !== undefined)).toBe(false);
		expect(get(controller).available.queue).toBe(false);
	});
});

describe('complete track list after an inline action', () => {
	it('keeps every exact row loaded while an inline action changes the cursor', async () => {
		const tracks = Array.from({ length: 350 }, (_, index) => row(`Track ${index}`, `track-${index}`, { itemType: 'track', hint: 'action_list' }));
		let cursor = 'root';
		const loads: number[] = [];
		const transaction = {
			browse: vi.fn(async (options: Parameters<ClassicBrowseApiTransaction['browse']>[0]) => {
				if (options.popAll) cursor = 'root';
				if (options.itemKey === 'list') cursor = 'tracks';
				if (options.itemKey?.startsWith('track-')) cursor = 'actions';
				if (options.itemKey === 'queue-leaf') return page([], { action: 'none' });
				if (cursor === 'root') return page([row('Recordings', 'list', { hint: 'list' })]);
				if (cursor === 'actions') return page([row('Queue', 'queue-leaf', { hint: 'action', isPlayable: true })], { title: 'Actions', level: 2 });
				return page(tracks.slice(0, 100), { title: 'Recordings', level: 1, totalCount: 350 });
			}),
			browseLoad: vi.fn(async (options: Parameters<ClassicBrowseApiTransaction['browseLoad']>[0]) => {
				if (cursor !== 'tracks') throw new Error('Load used the action cursor');
				const offset = options.offset ?? 0;
				loads.push(offset);
				return page(tracks.slice(offset, offset + Math.min(options.count ?? 100, 100)), { title: 'Recordings', level: 1, offset, totalCount: 350 });
			})
		} as unknown as ClassicBrowseApiTransaction;
		const deps = dependencies(transaction);
		const controller = createUnifiedBrowseController(deps);
		const actions = createUnifiedBrowseActionController(deps);
		const snapshot: BrowseHistorySnapshot = { context: { hierarchy: 'browse' }, history: [{ hierarchy: 'browse', breadcrumb: { title: 'Recordings' } }], forward: [] };
		await controller.restore(CLAIM, snapshot, 'zone-a');
		const selected = get(controller).result!.items[137];
		await actions.open(CLAIM, { kind: 'browse', snapshot, item: selected }, 'zone-a');
		await actions.execute(CLAIM, 'queue', 'zone-a');
		expect(cursor).toBe('actions');
		expect(get(controller).result?.items).toEqual(tracks);
		expect(get(controller).result?.count).toBe(350);
		expect(get(controller).result?.items).toEqual(tracks);
		expect(loads).toEqual([100, 200, 300]);
	});
});
