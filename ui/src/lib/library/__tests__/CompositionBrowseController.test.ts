import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { BrowseItem } from '@shared/types';

const transactionMock = vi.hoisted(() => ({
	run: vi.fn<(role: string, claim: unknown, work: (t: unknown) => Promise<unknown>) => Promise<unknown>>()
}));

vi.mock('../../api/client', () => ({
	withClassicBrowseRoleTransaction: (
		role: string,
		claim: unknown,
		work: (t: unknown) => Promise<unknown>
	) => transactionMock.run(role, claim, work)
}));

vi.mock('../../stores/classicBrowseSessionStore', () => ({
	classicBrowseSessionClient: { isClaimCurrent: () => true },
	ClassicBrowseSupersededError: class extends Error {}
}));

import {
	createCompositionBrowseController,
	findUniqueComposerRow,
	type CompositionTransaction
} from '../CompositionBrowseController';

const CLAIM = { claimId: 'claim-1', owner: 'unified-mode' } as never;

function item(title: string, itemKey: string | null, hint: string | null = null): BrowseItem {
	return {
		title,
		itemKey: itemKey ?? undefined,
		hint: hint ?? undefined,
		isLoadable: true,
		isPlayable: false
	} as unknown as BrowseItem;
}

function fakeTransaction(pages: Record<string, BrowseItem[]>, rootPages: BrowseItem[][]): CompositionTransaction {
	return {
		browse: vi.fn(async (options: { itemKey?: string }) => {
			if (!options.itemKey) {
				const items = rootPages[0] ?? [];
				return {
					totalCount: rootPages.flat().length,
					count: items.length,
					items
				};
			}
			const items = pages[options.itemKey] ?? [];
			return { totalCount: items.length, count: items.length, items };
		}),
		browseLoad: vi.fn(async (options: { offset: number }) => {
			let consumed = 0;
			for (const page of rootPages) {
				if (consumed === options.offset) {
					const index = rootPages.indexOf(page);
					return { items: rootPages[index] === page && index > 0 ? page : rootPages[Math.floor(options.offset / (rootPages[0]?.length || 1))] ?? [] };
				}
				consumed += page.length;
			}
			return { items: rootPages[1] ?? [] };
		}),
		browsePop: vi.fn(async () => ({}))
	} as unknown as CompositionTransaction;
}

beforeEach(() => {
	transactionMock.run.mockReset();
	transactionMock.run.mockImplementation(async (_role, _claim, work) => work(currentTransaction));
});

let currentTransaction: CompositionTransaction;

describe('findUniqueComposerRow', () => {
	it('locates exactly one matching composer row across pages', async () => {
		const rootPages = [
			[item('Arvo Pärt', 'k-arvo'), item('Béla Bartók', 'k-bela')],
			[item('Nils Frahm', 'k-nils')]
		];
		const transaction = {
			browse: vi.fn(async () => ({
				totalCount: 3,
				count: 2,
				items: rootPages[0]
			})),
			browseLoad: vi.fn(async () => ({ items: rootPages[1] })),
			browsePop: vi.fn()
		} as unknown as CompositionTransaction;
		const found = await findUniqueComposerRow(transaction, 'Nils Frahm');
		expect(found).not.toBeNull();
		expect((found as BrowseItem).itemKey).toBe('k-nils');
	});

	it('refuses an ambiguous label instead of guessing', async () => {
		const transaction = {
			browse: vi.fn(async () => ({
				totalCount: 2,
				count: 2,
				items: [item('J. Adams', 'k-1'), item('J. Adams', 'k-2')]
			})),
			browseLoad: vi.fn(async () => ({ items: [] })),
			browsePop: vi.fn()
		} as unknown as CompositionTransaction;
		expect(await findUniqueComposerRow(transaction, 'J. Adams')).toBe('ambiguous');
	});

	it('returns the freshly reloaded row, never a possibly evicted scan token (ri8-3)', async () => {
		// The ambiguity walk can outrun the per-role key authority on large
		// hierarchies; the match must come from its page's fresh reload.
		const transaction = {
			browse: vi.fn(async () => ({
				totalCount: 2,
				count: 2,
				items: [item('Nils Frahm', 'k-stale'), item('Other', 'k-other')]
			})),
			browseLoad: vi.fn(async () => ({
				items: [item('Nils Frahm', 'k-fresh'), item('Other', 'k-other')]
			})),
			browsePop: vi.fn()
		} as unknown as CompositionTransaction;
		const row = await findUniqueComposerRow(transaction, 'Nils Frahm');
		expect(row).toMatchObject({ itemKey: 'k-fresh' });
		expect(
			(transaction as unknown as { browseLoad: ReturnType<typeof vi.fn> }).browseLoad
		).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
	});

	it('returns null when no row carries the label', async () => {
		const transaction = {
			browse: vi.fn(async () => ({ totalCount: 1, count: 1, items: [item('Someone', 'k')] })),
			browseLoad: vi.fn(async () => ({ items: [] })),
			browsePop: vi.fn()
		} as unknown as CompositionTransaction;
		expect(await findUniqueComposerRow(transaction, 'Nobody')).toBeNull();
	});
});

describe('CompositionBrowseController', () => {
	it('serves live composition rows and the composition node stack', async () => {
		currentTransaction = fakeTransaction(
			{
				'k-nils': [item('Play Composer', 'k-play', 'action_list'), item('Says', 'k-says'), item('Ambre', 'k-ambre')],
				'k-says': [
					item('Play Work', 'k-playwork', 'action_list'),
					item('Says — Spaces', 'k-rec-1'),
					item('Says — Live', 'k-rec-2')
				],
				'k-rec-1': [item('Play Now', 'k-playnow', 'action')]
			},
			[[item('Nils Frahm', 'k-nils')]]
		);
		const controller = createCompositionBrowseController();
		await controller.openForComposer(CLAIM, 'Nils Frahm');
		let state = get(controller);
		expect(state.phase).toBe('compositions');
		// Action rows never masquerade as compositions.
		expect(state.compositions.map((row) => row.title)).toEqual(['Says', 'Ambre']);

		await controller.openComposition(CLAIM, state.compositions[0]);
		state = get(controller);
		expect(state.phase).toBe('page');
		expect(state.pages[0].title).toBe('Says');
		expect(state.pages[0].actions).toEqual([{ title: 'Play Work', itemKey: 'k-playwork' }]);
		expect(state.pages[0].recordings.map((row) => row.title)).toEqual([
			'Says — Spaces',
			'Says — Live'
		]);

		// A recording pushes ITS supplied node (its own action rows).
		await controller.openComposition(CLAIM, state.pages[0].recordings[0]);
		state = get(controller);
		expect(state.pages).toHaveLength(2);
		expect(state.pages[1].actions).toEqual([{ title: 'Play Now', itemKey: 'k-playnow' }]);

		await controller.backToCompositions(CLAIM);
		state = get(controller);
		expect(state.phase).toBe('page');
		expect(state.pages).toHaveLength(1);
		await controller.backToCompositions(CLAIM);
		state = get(controller);
		expect(state.phase).toBe('compositions');
	});

	it('ignores a second Back while one is in flight', async () => {
		const popGate = { release: () => {} };
		currentTransaction = fakeTransaction(
			{
				'k-nils': [item('Says', 'k-says')],
				'k-says': [item('Rec 1', 'k-r1')]
			},
			[[item('Nils Frahm', 'k-nils')]]
		);
		const popSpy = vi.fn(
			() =>
				new Promise<unknown>((resolve) => {
					popGate.release = () => resolve({});
				})
		);
		(currentTransaction as unknown as { browsePop: typeof popSpy }).browsePop = popSpy;
		const controller = createCompositionBrowseController();
		await controller.openForComposer(CLAIM, 'Nils Frahm');
		await controller.openComposition(CLAIM, get(controller).compositions[0]);
		const first = controller.backToCompositions(CLAIM);
		const second = controller.backToCompositions(CLAIM);
		popGate.release();
		await Promise.all([first, second]);
		// One transition, one pop (ri6-3).
		expect(popSpy).toHaveBeenCalledTimes(1);
		expect(get(controller).phase).toBe('compositions');
	});

	it('runs on its own classic role, never the named-counts drain channel (ri8-3)', async () => {
		currentTransaction = fakeTransaction({}, [[item('Nils Frahm', 'k-nils')]]);
		const controller = createCompositionBrowseController();
		await controller.openForComposer(CLAIM, 'Nils Frahm');
		expect(transactionMock.run).toHaveBeenCalled();
		for (const call of transactionMock.run.mock.calls) {
			expect(call[0]).toBe('classic-composition');
		}
	});

	it('resets the hierarchy to its root before the composer scan (ri8-3)', async () => {
		currentTransaction = fakeTransaction({}, [[item('Nils Frahm', 'k-nils')]]);
		const controller = createCompositionBrowseController();
		await controller.openForComposer(CLAIM, 'Nils Frahm');
		const rootBrowse = (
			currentTransaction as unknown as { browse: ReturnType<typeof vi.fn> }
		).browse.mock.calls.find((call) => !(call[0] as { itemKey?: string }).itemKey);
		expect(rootBrowse).toBeDefined();
		expect((rootBrowse![0] as { popAll?: boolean }).popAll).toBe(true);
	});

	it('a newer composer open supersedes the in-flight walk, which aborts (ri8-3)', async () => {
		const browseGate = { release: () => {} };
		currentTransaction = fakeTransaction(
			{},
			[[item('Nils Frahm', 'k-nils'), item('Someone Else', 'k-else')]]
		);
		const originalBrowse = (
			currentTransaction as unknown as { browse: (options: unknown) => Promise<unknown> }
		).browse;
		let gatePending = true;
		const gatedBrowse = vi.fn((options: unknown) => {
			if (!gatePending) return originalBrowse(options);
			gatePending = false;
			return new Promise<unknown>((resolve) => {
				browseGate.release = () =>
					resolve({
						totalCount: 2,
						count: 2,
						items: [item('Nils Frahm', 'k-nils'), item('Someone Else', 'k-else')]
					});
			});
		});
		(currentTransaction as unknown as { browse: typeof gatedBrowse }).browse = gatedBrowse;
		const controller = createCompositionBrowseController();
		const first = controller.openForComposer(CLAIM, 'Nils Frahm');
		const second = controller.openForComposer(CLAIM, 'Someone Else');
		await second;
		browseGate.release();
		await first;
		// The newer walk wins and publishes; the superseded walk aborted
		// without publishing over it.
		expect(get(controller).phase).toBe('compositions');
		expect(get(controller).composerLabel).toBe('Someone Else');
	});

	it('re-entering the surface mid-walk recovers instead of wedging on loading (ri8-3 reopen)', async () => {
		const browseGate = { release: () => {} };
		currentTransaction = fakeTransaction(
			{ 'k-nils': [item('Says', 'k-says')] },
			[[item('Nils Frahm', 'k-nils')]]
		);
		const originalBrowse = (
			currentTransaction as unknown as { browse: (options: unknown) => Promise<unknown> }
		).browse;
		let gatePending = true;
		const gatedBrowse = vi.fn((options: unknown) => {
			if (!gatePending) return originalBrowse(options);
			gatePending = false;
			return new Promise<unknown>((resolve) => {
				browseGate.release = () =>
					resolve({ totalCount: 1, count: 1, items: [item('Nils Frahm', 'k-nils')] });
			});
		});
		(currentTransaction as unknown as { browse: typeof gatedBrowse }).browse = gatedBrowse;
		const controller = createCompositionBrowseController();
		const first = controller.openForComposer(CLAIM, 'Nils Frahm');
		// The user leaves the surface (reset) and immediately re-enters.
		controller.reset();
		const second = controller.openForComposer(CLAIM, 'Nils Frahm');
		await second;
		browseGate.release();
		await first;
		// The replacement open completed; nothing is wedged at 'loading'.
		expect(get(controller).phase).toBe('compositions');
		expect(get(controller).compositions.map((row) => row.title)).toEqual(['Says']);
	});

	it('reports an honest notice for a missing or ambiguous composer', async () => {
		currentTransaction = fakeTransaction({}, [[item('Someone Else', 'k-x')]]);
		const controller = createCompositionBrowseController();
		await controller.openForComposer(CLAIM, 'Nils Frahm');
		const state = get(controller);
		expect(state.phase).toBe('failed');
		expect(state.notice).toContain('Nils Frahm');
	});

	it('executes an action through its exact-titled follow row with the chosen zone', async () => {
		const browseCalls: Array<{ itemKey?: string; zoneId?: string }> = [];
		currentTransaction = {
			browse: vi.fn(async (options: { itemKey?: string; zoneId?: string }) => {
				browseCalls.push(options);
				if (!options.itemKey) {
					return { totalCount: 1, count: 1, items: [item('Nils Frahm', 'k-nils')] };
				}
				if (options.itemKey === 'k-nils') {
					return { totalCount: 1, count: 1, items: [item('Says', 'k-says')] };
				}
				if (options.itemKey === 'k-says') {
					return {
						totalCount: 1,
						count: 1,
						items: [item('Play Work', 'k-playwork', 'action_list')]
					};
				}
				if (options.itemKey === 'k-playwork') {
					return {
						totalCount: 1,
						count: 1,
						items: [item('Play Work', 'k-playwork-run', 'action')]
					};
				}
				return { totalCount: 0, count: 0, items: [] };
			}),
			browseLoad: vi.fn(async () => ({ items: [] })),
			browsePop: vi.fn(async () => ({}))
		} as unknown as CompositionTransaction;
		const controller = createCompositionBrowseController();
		await controller.openForComposer(CLAIM, 'Nils Frahm');
		await controller.openComposition(CLAIM, get(controller).compositions[0]);
		await controller.runAction(
			CLAIM,
			{ title: 'Play Work', itemKey: 'k-playwork' },
			'zone-2'
		);
		const actionCalls = browseCalls.filter((call) => call.zoneId === 'zone-2');
		expect(actionCalls.map((call) => call.itemKey)).toEqual(['k-playwork', 'k-playwork-run']);
		// The entered action-list level is restored (ri6-1).
		expect(currentTransaction.browsePop).toHaveBeenCalledTimes(1);
		expect(get(controller).actionBusy).toBe(false);
	});

	it('drains a multi-page composition node', async () => {
		const firstPage = [
			item('Play Work', 'k-playwork', 'action_list'),
			item('Rec 1', 'k-r1')
		];
		const secondPage = [item('Rec 2', 'k-r2'), item('Rec 3', 'k-r3')];
		currentTransaction = {
			browse: vi.fn(async (options: { itemKey?: string }) => {
				if (!options.itemKey) {
					return { totalCount: 1, count: 1, items: [item('Nils Frahm', 'k-nils')] };
				}
				if (options.itemKey === 'k-nils') {
					return { totalCount: 1, count: 1, items: [item('Says', 'k-says')] };
				}
				// The composition node reports MORE rows than the first page.
				return { totalCount: 4, count: 2, items: firstPage };
			}),
			browseLoad: vi.fn(async (options: { offset: number }) =>
				options.offset === 2 ? { items: secondPage } : { items: [] }
			),
			browsePop: vi.fn(async () => ({}))
		} as unknown as CompositionTransaction;
		const controller = createCompositionBrowseController();
		await controller.openForComposer(CLAIM, 'Nils Frahm');
		await controller.openComposition(CLAIM, get(controller).compositions[0]);
		const page = get(controller).pages[0];
		expect(page.recordings.map((row) => row.title)).toEqual(['Rec 1', 'Rec 2', 'Rec 3']);
		expect(page.actions).toEqual([{ title: 'Play Work', itemKey: 'k-playwork' }]);
	});

	it('restores the hierarchy level an action_list entered', async () => {
		currentTransaction = fakeTransaction(
			{
				'k-nils': [item('Says', 'k-says')],
				'k-says': [item('Play Work', 'k-playwork', 'action_list')],
				'k-playwork': [item('Play Work', 'k-run', 'action')]
			},
			[[item('Nils Frahm', 'k-nils')]]
		);
		const controller = createCompositionBrowseController();
		await controller.openForComposer(CLAIM, 'Nils Frahm');
		await controller.openComposition(CLAIM, get(controller).compositions[0]);
		await controller.runAction(CLAIM, { title: 'Play Work', itemKey: 'k-playwork' }, 'z');
		expect(currentTransaction.browsePop).toHaveBeenCalledTimes(1);
	});
});
