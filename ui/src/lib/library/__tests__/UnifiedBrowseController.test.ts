import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClassicBrowseApiTransaction } from '$lib/api/client';
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
		count: items.length,
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

	it('pages to Roon’s reported total without persisting an offset', async () => {
		const first = Array.from({ length: 100 }, (_, index) => row(`Row ${index}`, `key-${index}`));
		const second = Array.from({ length: 100 }, (_, index) =>
			row(`Row ${index + 100}`, `key-${index + 100}`)
		);
		const transaction = {
			browse: vi.fn(async () => page(first, { totalCount: 54_082 })),
			browseLoad: vi.fn(async () => page(second, { offset: 100, totalCount: 54_082 })),
			browsePop: vi.fn(),
			browseSearch: vi.fn()
		} as unknown as ClassicBrowseApiTransaction;
		const controller = createUnifiedBrowseController(dependencies(transaction));

		await controller.restore(CLAIM, {
			context: { hierarchy: 'browse' },
			history: [],
			forward: []
		});
		await expect(controller.loadMore(CLAIM)).resolves.toBe(true);

		expect(get(controller).result?.items).toHaveLength(200);
		expect(transaction.browseLoad).toHaveBeenCalledWith({
			hierarchy: 'browse',
			offset: 100,
			count: 100
		});
		expect(get(controller).snapshot).toEqual({
			context: { hierarchy: 'browse' },
			history: [],
			forward: []
		});
	});

	it('retains loaded rows and retries after a transient paging failure', async () => {
		const first = Array.from({ length: 100 }, (_, index) => row(`Row ${index}`, `key-${index}`));
		const second = Array.from({ length: 100 }, (_, index) =>
			row(`Row ${index + 100}`, `key-${index + 100}`)
		);
		const transaction = {
			browse: vi.fn(async () => page(first, { totalCount: 300 })),
			browseLoad: vi
				.fn()
				.mockRejectedValueOnce(new Error('temporary timeout'))
				.mockResolvedValueOnce(page(second, { offset: 100, totalCount: 300 })),
			browsePop: vi.fn(),
			browseSearch: vi.fn()
		} as unknown as ClassicBrowseApiTransaction;
		const controller = createUnifiedBrowseController(dependencies(transaction));

		await controller.restore(CLAIM, {
			context: { hierarchy: 'browse' },
			history: [],
			forward: []
		});
		await expect(controller.loadMore(CLAIM)).resolves.toBe(false);

		expect(get(controller)).toMatchObject({
			phase: 'error',
			error: 'temporary timeout',
			result: { items: first }
		});

		await expect(controller.loadMore(CLAIM)).resolves.toBe(true);
		expect(get(controller)).toMatchObject({ phase: 'ready', error: null });
		expect(get(controller).result?.items).toHaveLength(200);
		expect(transaction.browseLoad).toHaveBeenCalledTimes(2);
	});

	it('drills a visible row without scanning the rest of a 54,082-row level', async () => {
		const visible = Array.from({ length: 100 }, (_, index) =>
			row(index === 72 ? 'Target folder' : `Row ${index}`, `key-${index}`, {
				hint: 'list',
				isLoadable: true
			})
		);
		const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async (options) =>
			options.itemKey === 'key-72'
				? page([row('Child', 'child')], { title: 'Target folder', level: 1 })
				: page(visible, { title: 'Tracks', totalCount: 54_082 })
		);
		const transaction = {
			browse,
			browseLoad: vi.fn(),
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
			restoreCount: 100
		});
		expect(transaction.browseLoad).not.toHaveBeenCalled();
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
		const visible = Array.from({ length: 100 }, (_, index) =>
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
