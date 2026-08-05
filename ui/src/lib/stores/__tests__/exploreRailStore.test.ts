import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { BrowseResult, BrowseItem } from '@shared/types';

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
	exploreRailStore,
	resolveExploreRail,
	invalidateExploreRail
} from '../exploreRailStore';

function listResult(over: Partial<BrowseResult> = {}): BrowseResult {
	return {
		title: over.title ?? 'Browse',
		subtitle: over.subtitle,
		level: over.level ?? 0,
		offset: over.offset ?? 0,
		count: over.count ?? (over.items?.length ?? 0),
		totalCount: over.totalCount ?? (over.items?.length ?? 0),
		items: over.items ?? []
	};
}

function makeItem(over: Partial<BrowseItem> = {}): BrowseItem {
	return {
		title: over.title ?? 'Item',
		subtitle: over.subtitle,
		itemKey: over.itemKey ?? 'k',
		hint: over.hint ?? 'list',
		imageKey: over.imageKey,
		isLoadable: over.isLoadable ?? true,
		isPlayable: over.isPlayable ?? false,
		itemType: over.itemType
	};
}

function freshRoot(title: string, itemKey: string, hint = 'list'): BrowseResult {
	return listResult({
		title: 'Explore',
		items: [makeItem({ title, itemKey, hint })]
	});
}

beforeEach(() => {
	apiBrowse.mockReset();
	roleTransaction.mockReset();
	roleTransaction.mockImplementation(async (_role, _claim, work) =>
		work({ browse: (options) => apiBrowse(undefined, options) })
	);
	isClaimCurrentMock.mockReset().mockReturnValue(true);
	invalidateExploreRail();
});

describe('exploreRailStore — resolveExploreRail', () => {
	it('captures level-0 list children, surfaces nested Library children, excludes Search under Library', async () => {
		// Mirrors the live capture: 5 items at level 0.
		const root = listResult({
			title: 'Explore',
			items: [
				makeItem({ title: 'Library', itemKey: 'lib' }),
				makeItem({ title: 'Playlists', itemKey: 'pl' }),
				makeItem({ title: 'My Live Radio', itemKey: 'mlr' }),
				makeItem({ title: 'Genres', itemKey: 'gen' }),
				makeItem({ title: 'Settings', itemKey: 'set' })
			]
		});
		// Library children, including Search which the rail filters out.
		const library = listResult({
			items: [
				makeItem({ title: 'Search', itemKey: 's-key' }),
				makeItem({ title: 'Artists', itemKey: 'art' }),
				makeItem({ title: 'Albums', itemKey: 'alb' }),
				makeItem({ title: 'Tracks', itemKey: 'trk' }),
				makeItem({ title: 'Composers', itemKey: 'comp' }),
				makeItem({ title: 'Tags', itemKey: 'tag' })
			]
		});
		// Playlists has 2 user playlists.
		const playlists = listResult({
			items: [makeItem({ title: 'Mix A' }), makeItem({ title: 'Mix B' })]
		});
		// My Live Radio empty container — Roon's "No Results" placeholder
		// has hint other than 'list' (matches live capture's '—' / null).
		const liveRadio = listResult({
			items: [makeItem({ title: 'No Results', hint: 'header' })]
		});
		// Genres non-empty.
		const genres = listResult({
			items: [makeItem({ title: 'Rock' }), makeItem({ title: 'Jazz' })]
		});

		// Settings is surfaced but deliberately not drilled. Each other
		// list-hint level-0 child gets a popAll + drill for empty-state
		// detection, and each popAll mints a fresh item token.
		// Order: root, popAll, lib, popAll, pl, popAll, mlr, popAll, gen.
		apiBrowse.mockResolvedValueOnce(root);
		apiBrowse.mockResolvedValueOnce(freshRoot('Library', 'lib-fresh')); // popAll before lib
		apiBrowse.mockResolvedValueOnce(library);
		apiBrowse.mockResolvedValueOnce(freshRoot('Playlists', 'pl-fresh')); // popAll before pl
		apiBrowse.mockResolvedValueOnce(playlists);
		apiBrowse.mockResolvedValueOnce(freshRoot('My Live Radio', 'mlr-fresh')); // popAll before mlr
		apiBrowse.mockResolvedValueOnce(liveRadio);
		apiBrowse.mockResolvedValueOnce(freshRoot('Genres', 'gen-fresh')); // popAll before gen
		apiBrowse.mockResolvedValueOnce(genres);

		await resolveExploreRail(fetch, TEST_CLAIM);

		const state = get(exploreRailStore);
		expect(state.loading).toBe(false);
		expect(state.error).toBeNull();

		const labels = state.entries.map((e) => e.label);
		// Library expanded into its non-Search children, then top-level
		// containers (including Settings).
		expect(labels).toEqual([
			'Artists',
			'Albums',
			'Tracks',
			'Composers',
			'Tags',
			'Playlists',
			'My Live Radio',
			'Genres',
			'Settings'
		]);

		// Search still excluded from Library expansion.
		expect(labels).not.toContain('Search');

		// Library children carry the parent in labelPath.
		const albums = state.entries.find((e) => e.label === 'Albums');
		expect(albums?.labelPath).toEqual(['Library', 'Albums']);
		expect(albums?.cachedAncestorKeys).toEqual(['lib-fresh']);

		// Top-level entries have single-element labelPath.
		const playlistsEntry = state.entries.find((e) => e.label === 'Playlists');
		expect(playlistsEntry?.labelPath).toEqual(['Playlists']);
		expect(playlistsEntry?.cachedKey).toBe('pl-fresh');

		// Each drill uses the token minted by the immediately preceding
		// popAll, never the token captured from the initial root.
		expect(apiBrowse.mock.calls[2]?.[1]).toMatchObject({ itemKey: 'lib-fresh' });
		expect(apiBrowse.mock.calls[4]?.[1]).toMatchObject({ itemKey: 'pl-fresh' });
		expect(apiBrowse.mock.calls[6]?.[1]).toMatchObject({ itemKey: 'mlr-fresh' });
		expect(apiBrowse.mock.calls[8]?.[1]).toMatchObject({ itemKey: 'gen-fresh' });

		// Empty-state detection: My Live Radio container had no list-hint
		// children, so it's marked muted.
		const liveRadioEntry = state.entries.find((e) => e.label === 'My Live Radio');
		expect(liveRadioEntry?.isEmpty).toBe(true);

		// Non-empty top-level container is not marked muted.
		expect(playlistsEntry?.isEmpty).toBe(false);
	});

	it('holds the complete resolver in one classic-explore role transaction', async () => {
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Library', itemKey: 'lib' })] })
		);
		apiBrowse.mockResolvedValueOnce(freshRoot('Library', 'lib-fresh')); // popAll
		apiBrowse.mockResolvedValueOnce(listResult({ items: [] })); // empty Library

		await resolveExploreRail(fetch, TEST_CLAIM);

		expect(roleTransaction).toHaveBeenCalledTimes(1);
		expect(roleTransaction.mock.calls[0]?.[0]).toBe('classic-explore');
		// The session client owns the opaque key; callers never manufacture
		// or forward one in their browse payloads.
		for (const call of apiBrowse.mock.calls) {
			expect(call[1]).not.toHaveProperty('multiSessionKey');
		}
	});

	it('records error state on failure', async () => {
		apiBrowse.mockRejectedValueOnce(new Error('Roon timed out'));
		await resolveExploreRail(fetch, TEST_CLAIM);

		const state = get(exploreRailStore);
		expect(state.loading).toBe(false);
		expect(state.error).toBe('Roon timed out');
		expect(state.entries).toEqual([]);
	});

	it('skips the empty-check drill for Settings entirely (no apiBrowse for it)', async () => {
		// Verified live (2026-05-17): drilling Settings via Roon's
		// public browse API consistently returns InvalidItemKey,
		// issuing a predictably invalid browse command on every page load.
		// The catch block downstream handled it functionally, but the
		// predictable failure polluted both server journal and browser feedback.
		// Settings is in SKIP_DRILL_LEVEL_0 — the resolver now
		// pushes the entry without attempting the drill.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				items: [
					makeItem({ title: 'Library', itemKey: 'lib' }),
					makeItem({ title: 'Settings', itemKey: 'set' })
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(freshRoot('Library', 'lib-fresh')); // popAll before lib
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Albums', itemKey: 'alb' })] })
		); // Library drill
		// Settings should NOT generate any popAll or drill calls.

		await resolveExploreRail(fetch, TEST_CLAIM);

		const state = get(exploreRailStore);
		expect(state.error).toBeNull();
		const labels = state.entries.map((e) => e.label);
		expect(labels).toContain('Settings');
		expect(labels).toContain('Albums'); // Library still expanded

		// Settings entry shape: no isEmpty (never muted), no cachedKey
		// (forces label-walk on click).
		const settings = state.entries.find((e) => e.label === 'Settings');
		expect(settings?.isEmpty).toBeUndefined();
		expect(settings?.cachedKey).toBeUndefined();

		// Verify the call count: root + popAll + library drill = 3.
		// No popAll + Settings drill (would be 5 with Settings drilled).
		expect(apiBrowse).toHaveBeenCalledTimes(3);
	});

	it('clears all cached keys when a later child drill fails', async () => {
		apiBrowse.mockResolvedValueOnce(
			listResult({
				items: [
					makeItem({ title: 'Library', itemKey: 'lib' }),
					makeItem({ title: 'Genres', itemKey: 'gen' }),
					makeItem({ title: 'Playlists', itemKey: 'playlists' })
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(freshRoot('Library', 'lib-fresh')); // popAll
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Albums', itemKey: 'alb' })] })
		); // Library OK
		apiBrowse.mockResolvedValueOnce(freshRoot('Genres', 'gen-fresh')); // popAll
		apiBrowse.mockRejectedValueOnce(new Error('blip')); // Genres drill fails

		await resolveExploreRail(fetch, TEST_CLAIM);

		const state = get(exploreRailStore);
		expect(state.error).toBe('blip');
		expect(state.entries).toEqual([]);
		// Root + successful Library pop/drill + failing Genres pop/drill.
		// The later Playlists sibling is never attempted after authority loss.
		expect(apiBrowse).toHaveBeenCalledTimes(5);
	});
});

describe('exploreRailStore — resolve token (race protection)', () => {
	it('ignores a stale failed completion that arrives after a newer succeeded one', async () => {
		// Call A: starts, awaits forever-pending root fetch (will fail later).
		// Call B: starts after A, succeeds quickly.
		// When A's failure arrives, the store must not overwrite B's success.
		let resolveA: (r: BrowseResult) => void = () => {};
		let rejectA: (e: Error) => void = () => {};
		const aRoot = new Promise<BrowseResult>((resolve, reject) => {
			resolveA = resolve;
			rejectA = reject;
		});

		// First call (A) — its root fetch is the controllable promise.
		apiBrowse.mockReturnValueOnce(aRoot);
		const callA = resolveExploreRail(fetch, TEST_CLAIM);

		// Second call (B) — completes immediately with one entry.
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Genres', itemKey: 'g' })] })
		);
		apiBrowse.mockResolvedValueOnce(freshRoot('Genres', 'g-fresh')); // popAll
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Rock', itemKey: 'r' })] })
		); // drill Genres (non-empty)

		await resolveExploreRail(fetch, TEST_CLAIM);

		// B succeeded — store should reflect it.
		const afterB = get(exploreRailStore);
		expect(afterB.error).toBeNull();
		expect(afterB.entries.map((e) => e.label)).toEqual(['Genres']);

		// Now A fails (stale completion). Must NOT clobber the store.
		rejectA(new Error('A timed out'));
		await callA;

		const final = get(exploreRailStore);
		expect(final.error).toBeNull();
		expect(final.entries.map((e) => e.label)).toEqual(['Genres']);

		// Tag-along: silence the "unused" warning for resolveA.
		void resolveA;
	});

	it('invalidate bumps the token so an in-flight resolve cannot rehydrate cleared state', async () => {
		// Start a resolve A whose root we control.
		let resolveA: (r: BrowseResult) => void = () => {};
		const aRoot = new Promise<BrowseResult>((resolve) => {
			resolveA = resolve;
		});
		apiBrowse.mockReturnValueOnce(aRoot);
		const callA = resolveExploreRail(fetch, TEST_CLAIM);

		// Invalidate while A is in flight.
		invalidateExploreRail();
		expect(get(exploreRailStore).entries).toEqual([]);

		// A finishes successfully — but its token is now stale.
		resolveA(listResult({ items: [makeItem({ title: 'Genres', itemKey: 'g' })] }));
		await callA;

		// Store remains cleared.
		expect(get(exploreRailStore).entries).toEqual([]);
	});
});

describe('exploreRailStore — invalidateExploreRail', () => {
	it('clears entries and error', async () => {
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Genres', itemKey: 'g' })] })
		);
		apiBrowse.mockResolvedValueOnce(freshRoot('Genres', 'g-fresh')); // popAll
		apiBrowse.mockResolvedValueOnce(listResult()); // drill

		await resolveExploreRail(fetch, TEST_CLAIM);
		expect(get(exploreRailStore).entries.length).toBe(1);

		invalidateExploreRail();
		const state = get(exploreRailStore);
		expect(state.entries).toEqual([]);
		expect(state.error).toBeNull();
		expect(state.loading).toBe(false);
	});
});
