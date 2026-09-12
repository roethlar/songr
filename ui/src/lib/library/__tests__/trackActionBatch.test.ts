import { describe, expect, it, vi } from 'vitest';
import {
	runTrackActionBatch,
	type TrackActionBatchGuard,
	type TrackActionBatchStep
} from '../trackActionBatch';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

const first = Object.freeze({ title: 'Duplicate title', itemKey: 'exact-first' });
const second = Object.freeze({ title: 'Duplicate title', itemKey: 'exact-second' });
const third = Object.freeze({ title: 'Third', itemKey: 'exact-third' });
type Item = { readonly title: string; readonly itemKey: string };
const steps = () => [first, second, third].map((item) => ({ item, semantic: 'queue' }));
const prepare = async (item: Item) => item;
const complete = async (_prepared: Item, _item: Item, _semantic: string, guard: TrackActionBatchGuard) => {
	guard.markIssued();
	return { status: 'completed' as const };
};

describe('sequential exact track action batches', () => {
	it('freezes displayed order and action semantics while retaining duplicate-title item identity', async () => {
		const input: TrackActionBatchStep<Item>[] = steps();
		const pending = deferred<Item>();
		const order: unknown[] = [];
		const run = runTrackActionBatch({
			steps: input, isCurrent: () => true,
			prepare: async (item, semantic) => {
				order.push([item, semantic]);
				return item === first ? pending.promise : item;
			}, dispatch: complete
		});
		input.reverse();
		input[0] = { item: { ...third, itemKey: 'substitute' }, semantic: 'play-now' };
		pending.resolve(first);
		const result = await run;
		expect(order).toEqual([[first, 'queue'], [second, 'queue'], [third, 'queue']]);
		expect(result.outcomes.map((row) => row.item)).toEqual([first, second, third]);
		expect(result.outcomes[0].item).toBe(first);
		expect(result.outcomes[1].item).toBe(second);
		expect(result).toMatchObject({ completed: 3, failed: 0, uncertain: 0, unattempted: 0, stoppedReason: 'completed' });
	});

	it('waits for each dispatch acknowledgement before preparing the next item', async () => {
		const started = deferred<void>();
		const acknowledgement = deferred<void>();
		const resolve = vi.fn(prepare);
		const issue = vi.fn(async (prepared: Item, item: Item, semantic: string, guard: TrackActionBatchGuard) => {
			guard.markIssued();
			if (item === first) { started.resolve(); await acknowledgement.promise; }
			return { status: 'completed' as const };
		});
		const run = runTrackActionBatch({ steps: steps(), isCurrent: () => true, prepare: resolve, dispatch: issue });
		await started.promise;
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(issue).toHaveBeenCalledTimes(1);
		acknowledgement.resolve();
		expect((await run).completed).toBe(3);
	});

	it('never resolves or dispatches an already cancelled selection', async () => {
		const abort = new AbortController();
		abort.abort();
		const resolve = vi.fn(prepare);
		const issue = vi.fn(complete);
		const result = await runTrackActionBatch({ steps: steps(), signal: abort.signal, isCurrent: () => true, prepare: resolve, dispatch: issue });
		expect(resolve).not.toHaveBeenCalled();
		expect(issue).not.toHaveBeenCalled();
		expect(result).toMatchObject({ completed: 0, unattempted: 3, stoppedReason: 'cancelled' });
	});

	it.each(['signal', 'authority'])('rechecks %s after preparation before dispatch', async (kind) => {
		const abort = new AbortController();
		let current = true;
		const issue = vi.fn(complete);
		const result = await runTrackActionBatch({
			steps: steps(), signal: abort.signal, isCurrent: () => current,
			prepare: async (item) => {
				if (kind === 'signal') abort.abort(); else current = false;
				return item;
			}, dispatch: issue
		});
		expect(issue).not.toHaveBeenCalled();
		expect(result).toMatchObject({ failed: 0, uncertain: 0, unattempted: 3, stoppedReason: 'cancelled' });
	});

	it('guards the actual handoff after a dispatch callback waits for its channel', async () => {
		let current = true;
		const sent: Item[] = [];
		const result = await runTrackActionBatch({
			steps: steps(), isCurrent: () => current, prepare,
			dispatch: async (_prepared, item, _semantic, guard) => {
				await Promise.resolve();
				current = false;
				guard.markIssued();
				sent.push(item);
				return { status: 'completed' };
			}
		});
		expect(sent).toEqual([]);
		expect(result).toMatchObject({ completed: 0, failed: 0, unattempted: 3, stoppedReason: 'cancelled' });
	});

	it('counts an acknowledged in-flight action after cancellation and leaves the rest untouched', async () => {
		const abort = new AbortController();
		const resolve = vi.fn(prepare);
		const issue = vi.fn(async (_prepared: Item, _item: Item, _semantic: string, guard: TrackActionBatchGuard) => {
			guard.markIssued();
			abort.abort();
			return { status: 'completed' as const };
		});
		const result = await runTrackActionBatch({ steps: steps(), signal: abort.signal, isCurrent: () => true, prepare: resolve, dispatch: issue });
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(issue).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ completed: 1, uncertain: 0, unattempted: 2, stoppedReason: 'cancelled' });
	});

	it('reports a lost acknowledgement as uncertain, never retries, and never starts later tracks', async () => {
		const issue = vi.fn(async (_prepared: Item, _item: Item, _semantic: string, guard: TrackActionBatchGuard) => {
			guard.markIssued();
			throw new Error('Acknowledgement timed out');
		});
		const result = await runTrackActionBatch({ steps: steps(), isCurrent: () => true, prepare, dispatch: issue });
		expect(issue).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ completed: 0, failed: 0, uncertain: 1, unattempted: 2, stoppedReason: 'uncertain' });
		expect(result.outcomes[0]).toMatchObject({ item: first, status: 'uncertain', message: 'Acknowledgement timed out' });
	});

	it('preserves completed progress when later exact resolution fails', async () => {
		const issue = vi.fn(complete);
		const result = await runTrackActionBatch({
			steps: steps(), isCurrent: () => true,
			prepare: async (item) => {
				if (item === second) throw new Error('Selected token retired');
				return item;
			}, dispatch: issue
		});
		expect(issue).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ completed: 1, failed: 1, uncertain: 0, unattempted: 1, stoppedReason: 'failed' });
		expect(result.outcomes.map((row) => row.status)).toEqual(['completed', 'failed', 'unattempted']);
	});

	it.each(['failed', 'uncertain'] as const)('honors an explicit %s dispatch outcome and stops', async (status) => {
		const issue = vi.fn(async (_prepared: Item, _item: Item, _semantic: string, guard: TrackActionBatchGuard) => {
			guard.markIssued();
			return { status, message: 'Roon outcome' };
		});
		const result = await runTrackActionBatch({ steps: steps(), isCurrent: () => true, prepare, dispatch: issue });
		expect(result.stoppedReason).toBe(status);
		expect(result[status]).toBe(1);
		expect(result.unattempted).toBe(2);
		expect(issue).toHaveBeenCalledTimes(1);
	});

	it('never treats an unrecorded handoff as confirmed success', async () => {
		const result = await runTrackActionBatch({
			steps: steps(), isCurrent: () => true, prepare,
			dispatch: async () => ({ status: 'completed' })
		});
		expect(result).toMatchObject({ completed: 0, uncertain: 1, unattempted: 2, stoppedReason: 'uncertain' });
	});

	it('prohibits playback while preparing and closes guards after each step', async () => {
		let retainedGuard: TrackActionBatchGuard | undefined;
		const issue = vi.fn(complete);
		const result = await runTrackActionBatch({
			steps: steps(), isCurrent: () => true,
			prepare: async (item, _semantic, guard) => {
				retainedGuard = guard;
				guard.markIssued();
				return item;
			}, dispatch: issue
		});
		expect(issue).not.toHaveBeenCalled();
		expect(result).toMatchObject({ failed: 1, unattempted: 2, stoppedReason: 'failed' });
		expect(() => retainedGuard!.markIssued()).toThrow();
	});

	it('refuses a second irreversible handoff on the same step without replay', async () => {
		const sent: Item[] = [];
		const result = await runTrackActionBatch({
			steps: steps(), isCurrent: () => true, prepare,
			dispatch: async (_prepared, item, _semantic, guard) => {
				guard.markIssued(); sent.push(item);
				guard.markIssued(); sent.push(item);
				return { status: 'completed' };
			}
		});
		expect(sent).toEqual([first]);
		expect(result).toMatchObject({ uncertain: 1, unattempted: 2, stoppedReason: 'uncertain' });
	});

	it('accepts an explicit mixed action plan without repeating Play Now', async () => {
		const issue = vi.fn(complete);
		const result = await runTrackActionBatch({
			steps: [{ item: first, semantic: 'play-now' }, { item: second, semantic: 'queue' }, { item: third, semantic: 'queue' }],
			isCurrent: () => true, prepare, dispatch: issue
		});
		expect(issue.mock.calls.map((call) => call[2])).toEqual(['play-now', 'queue', 'queue']);
		expect(result.completed).toBe(3);
	});

	it('publishes bounded progress and ignores observer errors without losing dispatch outcomes', async () => {
		const progress: unknown[] = [];
		const result = await runTrackActionBatch({
			steps: steps(), isCurrent: () => true, prepare, dispatch: complete,
			onProgress: (state) => { progress.push(state); throw new Error('View was removed'); }
		});
		expect(result.completed).toBe(3);
		expect(progress).toHaveLength(4);
		expect(progress[1]).toMatchObject({ completed: 1, unattempted: 2 });
		for (const state of progress) expect(state).not.toHaveProperty('outcomes');
	});

	it('does nothing for an empty selection', async () => {
		const issue = vi.fn(complete);
		const result = await runTrackActionBatch({ steps: [], isCurrent: () => true, prepare, dispatch: issue });
		expect(issue).not.toHaveBeenCalled();
		expect(result).toMatchObject({ total: 0, completed: 0, unattempted: 0, stoppedReason: 'completed' });
	});
});
