import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	CANVAS_WORKSPACE_MAX_ABSOLUTE_OFFSET,
	canvasWorkspaceStore,
	createCanvasWorkspaceStore,
	fingerprintCanvasWorkspaceModel,
	resetCanvasWorkspaceStore,
	type CanvasWorkspaceCanonicalAlbum,
	type CanvasWorkspaceScope
} from '../canvasWorkspaceStore';

const CORE_A_ARTIST: CanvasWorkspaceScope = {
	coreId: 'core-a',
	artistLocalId: 'artist-a'
};

function album(id: string, x: number, y: number): CanvasWorkspaceCanonicalAlbum {
	return { id, x, y };
}

function commit(
	store: ReturnType<typeof createCanvasWorkspaceStore>,
	albumLocalId: string,
	dx: number,
	dy: number
) {
	const token = store.beginPlacement(albumLocalId);
	if (!token) throw new Error(`could not begin placement for ${albumLocalId}`);
	return store.commitPlacement(token, { dx, dy });
}

afterEach(() => {
	resetCanvasWorkspaceStore();
	vi.restoreAllMocks();
});

describe('canvas workspace tab-memory store', () => {
	it('copies and freezes scope while fingerprinting canonical placements independent of input order', () => {
		const store = createCanvasWorkspaceStore();
		const scope = { ...CORE_A_ARTIST };
		const first = [album('b', 20, -0), album('a', 10, 4)];
		const fingerprint = fingerprintCanvasWorkspaceModel(first);

		expect(store.reconcile(scope, first)).toEqual({
			accepted: true,
			scopeChanged: true,
			modelChanged: true,
			prunedOffsetCount: 0
		});
		const initial = get(store);
		expect(initial).toMatchObject({
			scope: CORE_A_ARTIST,
			workspaceEpoch: 1,
			modelGeneration: 1,
			modelFingerprint: fingerprint,
			albumCount: 2,
			offsets: []
		});
		expect(Object.isFrozen(initial)).toBe(true);
		expect(Object.isFrozen(initial.scope)).toBe(true);
		expect(Object.isFrozen(initial.offsets)).toBe(true);

		scope.coreId = 'mutated';
		expect(get(store).scope).toEqual(CORE_A_ARTIST);
		expect(store.canonicalPositionFor('b')).toEqual({ x: 20, y: 0 });
		expect(store.reconcile({ ...CORE_A_ARTIST }, [...first].reverse())).toEqual({
			accepted: true,
			scopeChanged: false,
			modelChanged: false,
			prunedOffsetCount: 0
		});
		expect(get(store).modelGeneration).toBe(1);
	});

	it('retains and rebases deltas by ID on same-scope replacement while pruning removed IDs', () => {
		const store = createCanvasWorkspaceStore();
		store.reconcile(CORE_A_ARTIST, [album('a', 10, 20), album('b', 40, 50)]);
		expect(commit(store, 'a', 5, -7)).toMatchObject({
			status: 'committed',
			position: { x: 15, y: 13 }
		});
		expect(commit(store, 'b', -2, 8)).toMatchObject({ status: 'committed' });
		const before = get(store);

		expect(
			store.reconcile(CORE_A_ARTIST, [album('a', 100, 200), album('c', 300, 400)])
		).toEqual({
			accepted: true,
			scopeChanged: false,
			modelChanged: true,
			prunedOffsetCount: 1
		});
		expect(get(store)).toMatchObject({
			workspaceEpoch: before.workspaceEpoch,
			modelGeneration: before.modelGeneration + 1,
			albumCount: 2,
			offsets: [{ albumLocalId: 'a', dx: 5, dy: -7 }]
		});
		expect(store.canonicalPositionFor('a')).toEqual({ x: 100, y: 200 });
		expect(store.positionFor('a')).toEqual({ x: 105, y: 193 });
		expect(store.positionFor('c')).toEqual({ x: 300, y: 400 });
		expect(store.positionFor('b')).toBeNull();
	});

	it('clears settled offsets on Core or artist scope change', () => {
		const store = createCanvasWorkspaceStore();
		store.reconcile(CORE_A_ARTIST, [album('same-id', 10, 10)]);
		commit(store, 'same-id', 25, 30);
		const before = get(store);

		expect(
			store.reconcile(
				{ coreId: 'core-b', artistLocalId: CORE_A_ARTIST.artistLocalId },
				[album('same-id', 900, 800)]
			)
		).toMatchObject({ accepted: true, scopeChanged: true, prunedOffsetCount: 1 });
		expect(get(store)).toMatchObject({
			workspaceEpoch: before.workspaceEpoch + 1,
			modelGeneration: before.modelGeneration + 1,
			offsets: []
		});
		expect(store.positionFor('same-id')).toEqual({ x: 900, y: 800 });

		commit(store, 'same-id', 4, 5);
		store.reconcile(
			{ coreId: 'core-b', artistLocalId: 'artist-b' },
			[album('same-id', 2, 3)]
		);
		expect(store.offsetFor('same-id')).toBeNull();
		expect(store.positionFor('same-id')).toEqual({ x: 2, y: 3 });
	});

	it('binds one-use tokens to workspace epoch, model generation, album, and pre-offset', () => {
		const store = createCanvasWorkspaceStore();
		store.reconcile(CORE_A_ARTIST, [album('a', 0, 0), album('b', 5, 5)]);
		commit(store, 'a', 8, -3);
		const token = store.beginPlacement('a')!;

		expect(token).toMatchObject({
			workspaceEpoch: 1,
			modelGeneration: 1,
			albumLocalId: 'a',
			preOffset: { dx: 8, dy: -3 }
		});
		expect(Object.isFrozen(token)).toBe(true);
		expect(Object.isFrozen(token.preOffset)).toBe(true);
		expect(store.beginPlacement('b')).toBeNull();
		expect(
			store.commitPlacement({ ...token }, { dx: 10, dy: 10 })
		).toEqual({ status: 'rejected', reason: 'inactive-token' });
		expect(store.cancelPlacement(token)).toEqual({
			status: 'cancelled',
			preOffset: { dx: 8, dy: -3 }
		});
		expect(store.cancelPlacement(token)).toEqual({
			status: 'rejected',
			reason: 'inactive-token'
		});
		expect(store.offsetFor('a')).toEqual({ dx: 8, dy: -3 });
	});

	it('rejects stale model tokens and never resurrects a removed album', () => {
		const store = createCanvasWorkspaceStore();
		store.reconcile(CORE_A_ARTIST, [album('a', 0, 0), album('b', 10, 10)]);
		const moving = store.beginPlacement('a')!;

		store.reconcile(CORE_A_ARTIST, [album('a', 100, 100), album('b', 10, 10)]);
		expect(store.commitPlacement(moving, { dx: 5, dy: 5 })).toEqual({
			status: 'rejected',
			reason: 'stale-workspace'
		});
		expect(store.positionFor('a')).toEqual({ x: 100, y: 100 });

		const removed = store.beginPlacement('b')!;
		store.reconcile(CORE_A_ARTIST, [album('a', 100, 100)]);
		expect(store.commitPlacement(removed, { dx: 4, dy: 4 })).toEqual({
			status: 'rejected',
			reason: 'stale-workspace'
		});
		expect(store.offsetFor('b')).toBeNull();
		expect(store.beginPlacement('b')).toBeNull();
	});

	it('suspends canonical runtime idempotently while retaining same-scope settled offsets', () => {
		const store = createCanvasWorkspaceStore();
		const albums = [album('a', 10, 20), album('b', 30, 40)];
		store.reconcile(CORE_A_ARTIST, albums);
		commit(store, 'a', 5, -7);
		const pending = store.beginPlacement('b')!;
		const before = get(store);

		store.suspendRuntime();

		expect(get(store)).toMatchObject({
			scope: CORE_A_ARTIST,
			workspaceEpoch: before.workspaceEpoch,
			modelGeneration: before.modelGeneration + 1,
			modelFingerprint: null,
			albumCount: 0,
			offsets: [{ albumLocalId: 'a', dx: 5, dy: -7 }]
		});
		expect(store.canonicalPositionFor('a')).toBeNull();
		expect(store.positionFor('a')).toBeNull();
		expect(store.offsetFor('a')).toEqual({ dx: 5, dy: -7 });
		expect(store.commitPlacement(pending, { dx: 1, dy: 1 })).toEqual({
			status: 'rejected',
			reason: 'stale-workspace'
		});
		const suspended = get(store);
		store.suspendRuntime();
		expect(get(store)).toBe(suspended);

		expect(store.reconcile(CORE_A_ARTIST, albums)).toEqual({
			accepted: true,
			scopeChanged: false,
			modelChanged: true,
			prunedOffsetCount: 0
		});
		expect(store.positionFor('a')).toEqual({ x: 15, y: 13 });
		expect(get(store).modelGeneration).toBe(suspended.modelGeneration + 1);
	});

	it('accepts only finite bounded offsets and consumes an invalid terminal attempt', () => {
		const store = createCanvasWorkspaceStore();
		store.reconcile(CORE_A_ARTIST, [album('a', 1, 2)]);
		const boundary = store.beginPlacement('a')!;
		expect(
			store.commitPlacement(boundary, {
				dx: CANVAS_WORKSPACE_MAX_ABSOLUTE_OFFSET,
				dy: -CANVAS_WORKSPACE_MAX_ABSOLUTE_OFFSET
			})
		).toMatchObject({ status: 'committed' });

		for (const invalid of [
			{ dx: Number.NaN, dy: 0 },
			{ dx: 0, dy: Number.POSITIVE_INFINITY },
			{ dx: CANVAS_WORKSPACE_MAX_ABSOLUTE_OFFSET + 1, dy: 0 }
		]) {
			const token = store.beginPlacement('a')!;
			expect(store.commitPlacement(token, invalid)).toEqual({
				status: 'rejected',
				reason: 'invalid-offset'
			});
			expect(store.commitPlacement(token, { dx: 0, dy: 0 })).toEqual({
				status: 'rejected',
				reason: 'inactive-token'
			});
		}
		expect(store.offsetFor('a')).toEqual({
			dx: CANVAS_WORKSPACE_MAX_ABSOLUTE_OFFSET,
			dy: -CANVAS_WORKSPACE_MAX_ABSOLUTE_OFFSET
		});
	});

	it('deletes zero offsets and publishes defensive immutable snapshots', () => {
		const store = createCanvasWorkspaceStore();
		store.reconcile(CORE_A_ARTIST, [album('a', 5, 6)]);
		commit(store, 'a', 12, 13);
		const withOffset = get(store);
		expect(Object.isFrozen(withOffset.offsets[0])).toBe(true);

		const result = commit(store, 'a', -0, 0);
		expect(result).toEqual({
			status: 'committed',
			changed: true,
			offset: null,
			position: { x: 5, y: 6 }
		});
		expect(get(store).offsets).toEqual([]);
		expect(store.offsetFor('a')).toBeNull();
	});

	it('fails closed on invalid scope or canonical models without disturbing valid state', () => {
		const store = createCanvasWorkspaceStore();
		store.reconcile(CORE_A_ARTIST, [album('a', 1, 2)]);
		commit(store, 'a', 3, 4);
		const before = get(store);

		for (const [scope, albums] of [
			[{ coreId: '', artistLocalId: 'artist-a' }, [album('a', 9, 9)]],
			[CORE_A_ARTIST, [album('a', Number.NaN, 0)]],
			[CORE_A_ARTIST, [album('a', 0, 0), album('a', 1, 1)]]
		] as const) {
			expect(store.reconcile(scope, albums)).toEqual({
				accepted: false,
				scopeChanged: false,
				modelChanged: false,
				prunedOffsetCount: 0
			});
			expect(get(store)).toBe(before);
		}
		expect(store.positionFor('a')).toEqual({ x: 4, y: 6 });
	});

	it('provides an explicitly resettable production singleton with no storage writes', () => {
		const sessionWrite = vi.spyOn(Storage.prototype, 'setItem');
		resetCanvasWorkspaceStore();
		canvasWorkspaceStore.reconcile(CORE_A_ARTIST, [album('a', 10, 20)]);
		const token = canvasWorkspaceStore.beginPlacement('a')!;
		canvasWorkspaceStore.commitPlacement(token, { dx: 2, dy: 3 });
		const beforeReset = get(canvasWorkspaceStore);

		resetCanvasWorkspaceStore();
		expect(get(canvasWorkspaceStore)).toMatchObject({
			scope: null,
			workspaceEpoch: beforeReset.workspaceEpoch + 1,
			modelGeneration: beforeReset.modelGeneration + 1,
			modelFingerprint: null,
			albumCount: 0,
			offsets: []
		});
		expect(sessionWrite).not.toHaveBeenCalled();
		expect(canvasWorkspaceStore.commitPlacement(token, { dx: 4, dy: 5 })).toEqual({
			status: 'rejected',
			reason: 'stale-workspace'
		});
	});
});
