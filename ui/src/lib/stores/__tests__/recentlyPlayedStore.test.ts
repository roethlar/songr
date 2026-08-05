import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { RecentlyPlayedEntry, RecentlyPlayedSnapshot } from '@shared/types';

const fetchRecentlyPlayed = vi.fn<(_fetch: unknown) => Promise<RecentlyPlayedSnapshot>>();

vi.mock('$lib/api/client', () => ({
	fetchRecentlyPlayed: (...args: any[]) => fetchRecentlyPlayed(...(args as [unknown]))
}));

import {
	recentlyPlayedStore,
	loadRecentlyPlayed,
	applyRecentlyPlayedInserted,
	applyRecentlyPlayedCleared,
	applyClearResponse,
	resetRecentlyPlayed
} from '../recentlyPlayedStore';

function makeEntry(over: Partial<RecentlyPlayedEntry> = {}): RecentlyPlayedEntry {
	return {
		title: 'Track',
		artist: 'Artist',
		album: 'Album',
		duration: 180,
		image_key: 'img',
		zone_id: 'zone-a',
		zone_name: 'Living Room',
		played_at: '2026-05-08T00:00:00.000Z',
		...over
	};
}

// Shared epoch for all single-server tests; cross-epoch behavior is
// covered by the dedicated server-restart test.
const EPOCH = 100;

function snapshot(
	entries: RecentlyPlayedEntry[],
	revision: number,
	epoch = EPOCH
): RecentlyPlayedSnapshot {
	return { entries, revision, epoch };
}

function inserted(entry: RecentlyPlayedEntry, revision: number, epoch = EPOCH) {
	return { entry, revision, epoch };
}

function cleared(revision: number, epoch = EPOCH) {
	return { revision, epoch };
}

beforeEach(() => {
	fetchRecentlyPlayed.mockReset();
	resetRecentlyPlayed();
});

describe('recentlyPlayedStore', () => {
	it('loads entries via REST and marks store as loaded', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(
			snapshot(
				[
					makeEntry({ title: 'A', played_at: '2026-05-08T00:00:00.000Z' }),
					makeEntry({ title: 'B', played_at: '2026-05-08T00:00:00.000Z', album: 'Album B' })
				],
				5
			)
		);

		await loadRecentlyPlayed(fetch);

		const state = get(recentlyPlayedStore);
		expect(state.entries.map((e) => e.title)).toEqual(['A', 'B']);
		expect(state.loading).toBe(false);
		expect(state.loaded).toBe(true);
	});

	it('survives REST failure: keeps existing entries, clears loading', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(snapshot([makeEntry({ title: 'A' })], 1));
		await loadRecentlyPlayed(fetch);
		expect(get(recentlyPlayedStore).entries).toHaveLength(1);

		fetchRecentlyPlayed.mockRejectedValueOnce(new Error('network blip'));
		await loadRecentlyPlayed(fetch);

		const state = get(recentlyPlayedStore);
		expect(state.entries.map((e) => e.title)).toEqual(['A']);
		expect(state.loading).toBe(false);
	});

	it('socket insert unshifts a new entry to the top (newer revision)', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(
			snapshot([makeEntry({ title: 'Older', played_at: '2026-05-07T00:00:00.000Z' })], 1)
		);
		await loadRecentlyPlayed(fetch);

		applyRecentlyPlayedInserted(
			inserted(makeEntry({ title: 'Newer', played_at: '2026-05-08T00:00:00.000Z' }), 2)
		);

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['Newer', 'Older']);
	});

	it('socket insert bubbles a replayed track to the top instead of duplicating', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(
			snapshot(
				[
					makeEntry({ title: 'A', played_at: '2026-05-08T00:00:01.000Z' }),
					makeEntry({ title: 'B', played_at: '2026-05-08T00:00:00.000Z', album: 'Album B' })
				],
				2
			)
		);
		await loadRecentlyPlayed(fetch);

		applyRecentlyPlayedInserted(
			inserted(
				makeEntry({
					title: 'A',
					zone_id: 'zone-b',
					played_at: '2026-05-08T00:00:05.000Z'
				}),
				3
			)
		);

		const entries = get(recentlyPlayedStore).entries;
		expect(entries.map((e) => e.title)).toEqual(['A', 'B']);
		expect(entries[0].zone_id).toBe('zone-b');
	});

	it('socket insert with stale revision is discarded', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(snapshot([makeEntry({ title: 'A' })], 5));
		await loadRecentlyPlayed(fetch);
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['A']);

		applyRecentlyPlayedInserted(inserted(makeEntry({ title: 'Stale' }), 3));

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['A']);
	});

	it('socket cleared with stale revision is discarded (the load-vs-clear race guard)', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(
			snapshot([makeEntry({ title: 'A' }), makeEntry({ title: 'B', album: 'Album B' })], 10)
		);
		await loadRecentlyPlayed(fetch);
		expect(get(recentlyPlayedStore).entries).toHaveLength(2);

		applyRecentlyPlayedCleared(cleared(8));

		expect(get(recentlyPlayedStore).entries).toHaveLength(2);
	});

	it('socket cleared with newer revision empties the list', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(
			snapshot([makeEntry({ title: 'A' }), makeEntry({ title: 'B', album: 'Album B' })], 5)
		);
		await loadRecentlyPlayed(fetch);

		applyRecentlyPlayedCleared(cleared(6));

		const state = get(recentlyPlayedStore);
		expect(state.entries).toEqual([]);
		expect(state.loaded).toBe(true);
	});

	it('socket insert idempotent: replaying the exact same revision is a no-op', () => {
		const entry = makeEntry({ title: 'X', played_at: '2026-05-08T00:00:00.000Z' });
		applyRecentlyPlayedInserted(inserted(entry, 1));
		applyRecentlyPlayedInserted(inserted(entry, 1));

		expect(get(recentlyPlayedStore).entries).toHaveLength(1);
	});

	it('two distinct tracks at consecutive revisions both apply', () => {
		const sharedTs = '2026-05-08T00:00:00.000Z';
		applyRecentlyPlayedInserted(
			inserted(makeEntry({ title: 'First', played_at: sharedTs, zone_id: 'zone-a' }), 1)
		);
		applyRecentlyPlayedInserted(
			inserted(makeEntry({ title: 'Second', played_at: sharedTs, zone_id: 'zone-a' }), 2)
		);

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'Second',
			'First'
		]);
	});

	it('applyClearResponse with newer revision wins over stale socket events', async () => {
		applyRecentlyPlayedCleared(cleared(5));
		expect(get(recentlyPlayedStore).entries).toEqual([]);

		const midClear = makeEntry({ title: 'MidClear' });
		applyClearResponse(snapshot([midClear], 6));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'MidClear'
		]);

		// Duplicate cleared from this op (rev <= 6) must NOT wipe.
		applyRecentlyPlayedCleared(cleared(5));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'MidClear'
		]);
	});

	it('post-clear socket insert applies on top of an applied DELETE snapshot', () => {
		applyClearResponse(snapshot([], 5));
		applyRecentlyPlayedInserted(inserted(makeEntry({ title: 'Post' }), 6));

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'Post'
		]);
	});

	it('snapshot at equal revision still applies (authoritative repair)', () => {
		// A snapshot fully describes state at its revision, so applying
		// it on revision == lastApplied is safe — and necessary when a
		// client missed a `cleared` delta and a follow-up GET arrives
		// at the same revision as the next insert it managed to apply.
		applyRecentlyPlayedInserted(inserted(makeEntry({ title: 'Stale' }), 5));
		// Now a load returns the authoritative state at rev 5 — which
		// happens to be empty (because the user cleared at rev 4 then
		// the insert at rev 5 was missed on the server side too).
		applyClearResponse(snapshot([], 5));
		expect(get(recentlyPlayedStore).entries).toEqual([]);
	});

	it('stale older-epoch payload is rejected after a newer epoch has been adopted', async () => {
		// Client has adopted epoch 200 (post-reconnect after server
		// restart). An in-flight stale payload from epoch 100 (the
		// previous server instance) arrives — must NOT roll the
		// client back. Older epochs are strictly rejected.
		applyClearResponse(snapshot([makeEntry({ title: 'Fresh' })], 0, /* epoch */ 200));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['Fresh']);

		// Stale snapshot from epoch 100 — discard, even with high revision.
		applyClearResponse(snapshot([makeEntry({ title: 'Stale snap' })], 999, /* epoch */ 100));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['Fresh']);

		// Stale delta from epoch 100 — same rule, discard.
		applyRecentlyPlayedInserted(inserted(makeEntry({ title: 'Stale ins' }), 5, /* epoch */ 100));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['Fresh']);

		// Stale cleared from epoch 100 — discard.
		applyRecentlyPlayedCleared(cleared(5, /* epoch */ 100));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['Fresh']);
	});

	it('new-epoch delta clears prior-epoch entries before applying (no mixed state)', async () => {
		// Client has [A, B] from epoch 1. A new server (epoch 2)
		// emits an insert that reaches the client before any GET
		// re-baselines. The new delta must NOT layer on top of stale
		// epoch-1 entries; the prior list is wiped first so the
		// delta is the only entry until a follow-up load arrives.
		applyRecentlyPlayedInserted(inserted(makeEntry({ title: 'A' }), 1, /* epoch */ 1));
		applyRecentlyPlayedInserted(
			inserted(makeEntry({ title: 'B', album: 'Album B' }), 2, /* epoch */ 1)
		);
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['B', 'A']);

		applyRecentlyPlayedInserted(
			inserted(makeEntry({ title: 'New', album: 'Album New' }), 1, /* epoch */ 2)
		);

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['New']);
	});

	it('new-epoch cleared also wipes prior-epoch entries (no leftover stale state)', () => {
		applyRecentlyPlayedInserted(inserted(makeEntry({ title: 'Old' }), 1, /* epoch */ 1));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['Old']);

		applyRecentlyPlayedCleared(cleared(1, /* epoch */ 2));

		expect(get(recentlyPlayedStore).entries).toEqual([]);
	});

	it('different epoch (server restart) adopts the new authority even with lower revision', async () => {
		// Client has applied up to rev=100 from epoch A. The server
		// restarts at epoch B with revision counter reset to 0 and
		// persisted entries [Disk] loaded from disk. A fresh load at
		// epoch B / rev 0 MUST apply — without epoch tracking it'd be
		// rejected as stale and the user would see no Recently Played
		// until the new server caught up to rev 101.
		applyRecentlyPlayedInserted(inserted(makeEntry({ title: 'Old' }), 100, /* epoch */ 1));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['Old']);

		// New server instance — different epoch, lower revision.
		// applyClearResponse exposes the same authoritative-snapshot
		// apply path that load uses; both adopt a new epoch.
		applyClearResponse({
			entries: [makeEntry({ title: 'Disk' })],
			revision: 0,
			epoch: 2
		});
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['Disk']);

		// Subsequent deltas from the new epoch flow normally from rev 0.
		applyRecentlyPlayedInserted(inserted(makeEntry({ title: 'Fresh' }), 1, /* epoch */ 2));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'Fresh',
			'Disk'
		]);
	});

	it('cap: insert applies caps at 50', () => {
		for (let i = 0; i < 51; i++) {
			applyRecentlyPlayedInserted(
				inserted(
					makeEntry({
						title: `T${i}`,
						played_at: `2026-05-08T00:00:${String(i).padStart(2, '0')}.000Z`
					}),
					i + 1
				)
			);
		}
		const entries = get(recentlyPlayedStore).entries;
		expect(entries).toHaveLength(50);
		expect(entries[0].title).toBe('T50');
		expect(entries.map((e) => e.title)).not.toContain('T0');
	});
});
