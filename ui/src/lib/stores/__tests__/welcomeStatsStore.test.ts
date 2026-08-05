import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { BrowseItem, BrowseResult } from '@shared/types';

const { isClaimCurrentMock } = vi.hoisted(() => ({
	isClaimCurrentMock: vi.fn(() => true)
}));

vi.mock('../classicBrowseSessionStore', async (importOriginal) => {
	const original = await importOriginal<typeof import('../classicBrowseSessionStore')>();
	return {
		...original,
		classicBrowseSessionClient: {
			...original.classicBrowseSessionClient,
			isClaimCurrent: isClaimCurrentMock
		}
	};
});

const TEST_CLAIM = {
	owner: 'classic-mode' as const,
	claimId: 1,
	ready: Promise.resolve({ handleId: 'test', generation: 1 })
};

const apiBrowse = vi.fn<(_fetch: unknown, opts: any) => Promise<BrowseResult>>();
const roleTransaction = vi.fn<
	(
		role: string,
		claim: typeof TEST_CLAIM,
		work: (transaction: { browse: (options: any) => Promise<BrowseResult> }) => Promise<unknown>
	) => Promise<unknown>
>();

vi.mock('$lib/api/client', () => ({
	browse: (...args: any[]) => apiBrowse(...(args as [unknown, any])),
	withClassicBrowseRoleTransaction: (...args: any[]) =>
		roleTransaction(
			...(args as [
				string,
				typeof TEST_CLAIM,
				(transaction: { browse: (options: any) => Promise<BrowseResult> }) => Promise<unknown>
			])
		)
}));

import {
	welcomeStatsStore,
	loadWelcomeStats,
	invalidateWelcomeStats
} from '../welcomeStatsStore';

function listResult(over: Partial<BrowseResult> = {}): BrowseResult {
	return {
		title: over.title ?? 'Browse',
		subtitle: over.subtitle,
		level: over.level ?? 0,
		offset: over.offset ?? 0,
		count: over.count ?? 0,
		totalCount: over.totalCount ?? 0,
		items: over.items ?? []
	};
}

function listItem(title: string, itemKey: string): BrowseItem {
	return {
		title,
		itemKey,
		hint: 'list',
		isLoadable: true,
		isPlayable: false
	};
}

function supportedStatsResult(
	opts: Record<string, unknown>,
	totals: { artists: number; albums: number; composers: number; tracks: number }
): BrowseResult {
	if (opts.hierarchy === 'artists') return listResult({ totalCount: totals.artists });
	if (opts.hierarchy === 'albums') return listResult({ totalCount: totals.albums });
	if (opts.hierarchy === 'composers') return listResult({ totalCount: totals.composers });
	if (opts.hierarchy === 'browse' && opts.popAll === true) {
		return listResult({ items: [listItem('Library', 'lib-key')] });
	}
	if (opts.hierarchy === 'browse' && opts.itemKey === 'lib-key') {
		return listResult({ items: [listItem('Tracks', 'tracks-key')] });
	}
	if (opts.hierarchy === 'browse' && opts.itemKey === 'tracks-key') {
		return listResult({ totalCount: totals.tracks });
	}
	throw new Error(`Unexpected welcome-stats request: ${JSON.stringify(opts)}`);
}

beforeEach(() => {
	apiBrowse.mockReset();
	roleTransaction.mockReset();
	roleTransaction.mockImplementation(async (_role, _claim, work) =>
		work({ browse: (options) => apiBrowse(undefined, options) })
	);
	isClaimCurrentMock.mockReset().mockReturnValue(true);
	invalidateWelcomeStats();
});

describe('welcomeStatsStore — loadWelcomeStats', () => {
	it('loads Tracks only through the supported browse → Library → Tracks path', async () => {
		apiBrowse.mockImplementation(async (_f, opts) =>
			supportedStatsResult(opts, {
				artists: 1667,
				albums: 3962,
				composers: 9455,
				tracks: 57583
			})
		);

		await loadWelcomeStats(fetch, TEST_CLAIM);

		const state = get(welcomeStatsStore);
		expect(state).toEqual({
			artists: 1667,
			albums: 3962,
			composers: 9455,
			tracks: 57583,
			loading: false,
			loaded: true
		});

		expect(apiBrowse.mock.calls.map(([, options]) => options)).toEqual([
			{ hierarchy: 'artists', popAll: true },
			{ hierarchy: 'albums', popAll: true },
			{ hierarchy: 'composers', popAll: true },
			{ hierarchy: 'browse', popAll: true },
			{ hierarchy: 'browse', itemKey: 'lib-key' },
			{ hierarchy: 'browse', itemKey: 'tracks-key' }
		]);
		expect(roleTransaction).toHaveBeenCalledTimes(4);
		for (const call of roleTransaction.mock.calls) {
			expect(call[0]).toBe('classic-explore');
			expect(call[1]).toBe(TEST_CLAIM);
		}
		for (const [, opts] of apiBrowse.mock.calls) {
			expect(opts).not.toHaveProperty('multiSessionKey');
		}
	});

	it('records null for any stat whose fetch fails — others still load', async () => {
		apiBrowse.mockImplementation(async (_f, opts) => {
			if (opts.hierarchy === 'artists') return listResult({ totalCount: 100 });
			if (opts.hierarchy === 'albums') throw new Error('roon nope');
			if (opts.hierarchy === 'composers') return listResult({ totalCount: 300 });
			if (opts.hierarchy === 'browse') throw new Error('tracks unavailable');
			throw new Error(`Unexpected: ${JSON.stringify(opts)}`);
		});

		await loadWelcomeStats(fetch, TEST_CLAIM);

		const state = get(welcomeStatsStore);
		expect(state.artists).toBe(100);
		expect(state.albums).toBeNull();
		expect(state.composers).toBe(300);
		expect(state.tracks).toBeNull();
		expect(state.loaded).toBe(true);
	});

	it('falls back to count when totalCount is missing', async () => {
		apiBrowse.mockImplementation(async (_f, opts) => {
			if (opts.hierarchy === 'artists')
				return { ...listResult(), count: 42, totalCount: undefined as any };
			return listResult({ totalCount: 0 });
		});

		await loadWelcomeStats(fetch, TEST_CLAIM);

		expect(get(welcomeStatsStore).artists).toBe(42);
	});

	it('stays retryable when its exact claim is superseded', async () => {
		roleTransaction.mockRejectedValue(new Error('session superseded'));
		isClaimCurrentMock.mockReturnValue(false);

		await expect(loadWelcomeStats(fetch, TEST_CLAIM)).resolves.toBeUndefined();
		expect(get(welcomeStatsStore)).toEqual({
			artists: null,
			albums: null,
			tracks: null,
			composers: null,
			loading: false,
			loaded: false
		});

		roleTransaction.mockReset();
		roleTransaction.mockImplementation(async (_role, _claim, work) =>
			work({ browse: (options) => apiBrowse(undefined, options) })
		);
		isClaimCurrentMock.mockReturnValue(true);
		apiBrowse.mockImplementation(async (_f, opts) =>
			supportedStatsResult(opts, { artists: 5, albums: 5, composers: 5, tracks: 5 })
		);
		await loadWelcomeStats(fetch, TEST_CLAIM);
		expect(get(welcomeStatsStore)).toMatchObject({
			artists: 5,
			albums: 5,
			tracks: 5,
			composers: 5,
			loading: false,
			loaded: true
		});
	});
});

describe('welcomeStatsStore — race protection', () => {
	it('ignores a stale completion that arrives after a newer one', async () => {
		// Call A is slow and returns wrong values; call B finishes first.
		let resolveA: () => void = () => {};
		const aGate = new Promise<void>((resolve) => {
			resolveA = resolve;
		});

		apiBrowse.mockImplementationOnce(async () => {
			await aGate;
			return listResult({ totalCount: 999 });
		});
		apiBrowse.mockImplementation(async () => listResult({ totalCount: 999 }));

		const callA = loadWelcomeStats(fetch, TEST_CLAIM);

		// Now reset and run a second loadWelcomeStats (B) that completes
		// quickly with the correct values.
		apiBrowse.mockReset();
		apiBrowse.mockImplementation(async (_f, opts) =>
			supportedStatsResult(opts, { artists: 7, albums: 8, composers: 9, tracks: 10 })
		);
		await loadWelcomeStats(fetch, TEST_CLAIM);

		// B's values committed.
		expect(get(welcomeStatsStore)).toEqual({
			artists: 7,
			albums: 8,
			composers: 9,
			tracks: 10,
			loading: false,
			loaded: true
		});

		// Now release A. Its completion is stale — must not overwrite.
		resolveA();
		await callA;

		expect(get(welcomeStatsStore)).toEqual({
			artists: 7,
			albums: 8,
			composers: 9,
			tracks: 10,
			loading: false,
			loaded: true
		});
	});

	it('invalidate clears the store', async () => {
		apiBrowse.mockImplementation(async (_f, opts) =>
			supportedStatsResult(opts, { artists: 5, albums: 5, composers: 5, tracks: 5 })
		);
		await loadWelcomeStats(fetch, TEST_CLAIM);
		expect(get(welcomeStatsStore).loaded).toBe(true);

		invalidateWelcomeStats();
		expect(get(welcomeStatsStore)).toEqual({
			artists: null,
			albums: null,
			composers: null,
			tracks: null,
			loading: false,
			loaded: false
		});
	});
});
