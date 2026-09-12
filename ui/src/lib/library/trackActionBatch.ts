/** A selection is ordered by its current list before constructing these steps. */
export interface TrackActionBatchStep<T, S extends string = string> {
	readonly item: T;
	readonly semantic: S;
}

export type TrackActionBatchStatus = 'completed' | 'failed' | 'uncertain' | 'unattempted';
export type TrackActionBatchStopReason = 'completed' | 'cancelled' | 'failed' | 'uncertain';

export interface TrackActionBatchDispatchResult {
	readonly status: 'completed' | 'failed' | 'uncertain';
	readonly message?: string;
}

export interface TrackActionBatchGuard {
	/** Check again after waits and before using retained row/action authority. */
	assertCurrent(): void;
	/** Call immediately before the one irreversible handoff; also checks authority. */
	markIssued(): void;
}

export interface TrackActionBatchOutcome<T, S extends string = string>
	extends TrackActionBatchStep<T, S> {
	readonly index: number;
	readonly status: TrackActionBatchStatus;
	readonly message?: string;
}

export interface TrackActionBatchProgress<T, S extends string = string> {
	readonly total: number;
	readonly completed: number;
	readonly failed: number;
	readonly uncertain: number;
	readonly unattempted: number;
	readonly current: TrackActionBatchStep<T, S> | null;
}

export interface TrackActionBatchResult<T, S extends string = string>
	extends TrackActionBatchProgress<T, S> {
	readonly outcomes: readonly TrackActionBatchOutcome<T, S>[];
	readonly stoppedReason: TrackActionBatchStopReason;
}

export interface TrackActionBatchOptions<T, P, S extends string = string> {
	readonly steps: readonly TrackActionBatchStep<T, S>[];
	/** Includes the original claim, result generation, zone and local cancellation. */
	readonly isCurrent: () => boolean;
	readonly signal?: AbortSignal;
	/** Resolve the exact selected item; this phase must not execute playback. */
	readonly prepare: (item: T, semantic: S, guard: TrackActionBatchGuard) => Promise<P>;
	/**
	 * Call guard.markIssued() immediately before sending. A definitive rejection
	 * may return failed; a timeout/lost acknowledgement must return uncertain.
	 * A thrown error after markIssued is conservatively uncertain. Never retry.
	 */
	readonly dispatch: (
		prepared: P, item: T, semantic: S, guard: TrackActionBatchGuard
	) => Promise<TrackActionBatchDispatchResult>;
	/** Constant-size progress; a full outcomes array is returned only at the end. */
	readonly onProgress?: (progress: TrackActionBatchProgress<T, S>) => void;
}

class BatchCancelled extends Error {
	constructor() { super('The selection or playback authority changed.'); }
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'The track action failed.';
}

/**
 * Run exact selected objects once, sequentially. Snapshot step order/semantics
 * synchronously, but preserve the original item references as playback authority.
 * Cancellation stops future dispatches; it cannot undo an already issued action.
 */
export async function runTrackActionBatch<T, P, S extends string = string>(
	options: TrackActionBatchOptions<T, P, S>
): Promise<TrackActionBatchResult<T, S>> {
	const steps = options.steps.map(({ item, semantic }) => Object.freeze({ item, semantic }));
	const outcomes: TrackActionBatchOutcome<T, S>[] = steps.map((step, index) => ({
		...step, index, status: 'unattempted'
	}));
	let completed = 0;
	let failed = 0;
	let uncertain = 0;
	let cancelled = false;
	let stoppedReason: TrackActionBatchStopReason = 'completed';

	const progress = (current: TrackActionBatchStep<T, S> | null): TrackActionBatchProgress<T, S> =>
		Object.freeze({
			total: steps.length, completed, failed, uncertain,
			unattempted: steps.length - completed - failed - uncertain, current
		});
	const notify = (current: TrackActionBatchStep<T, S> | null): void => {
		// A presentation observer must not turn an acknowledged action into a retry.
		try { options.onProgress?.(progress(current)); } catch { /* outcome stays authoritative */ }
	};
	const assertCurrent = (): void => {
		if (cancelled || options.signal?.aborted || !options.isCurrent()) {
			cancelled = true;
			throw new BatchCancelled();
		}
	};

	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index];
		let issued = false;
		let active = true;
		const guard: TrackActionBatchGuard = Object.freeze({
			assertCurrent: () => {
				if (!active) throw new BatchCancelled();
				assertCurrent();
			},
			markIssued: () => {
				if (!active) throw new BatchCancelled();
				assertCurrent();
				if (phase !== 'dispatching') throw new Error('Preparation cannot issue playback.');
				if (issued) throw new Error('This selected track action was already issued.');
				issued = true;
			}
		});
		let phase: 'preparing' | 'dispatching' = 'preparing';
		try {
			notify(step);
			guard.assertCurrent();
			const prepared = await options.prepare(step.item, step.semantic, guard);
			guard.assertCurrent();
			phase = 'dispatching';
			const result = await options.dispatch(prepared, step.item, step.semantic, guard);
			const status = result.status === 'completed' && !issued ? 'uncertain' : result.status;
			outcomes[index] = {
				...step, index, status,
				...(result.status === 'completed' && !issued
					? { message: 'The action completed without a recorded dispatch boundary.' }
					: result.message ? { message: result.message } : {})
			};
			if (status === 'completed') completed += 1;
			else if (status === 'failed') failed += 1;
			else uncertain += 1;
			if (status !== 'completed') {
				stoppedReason = status;
				break;
			}
		} catch (error) {
			if (!issued && error instanceof BatchCancelled) {
				stoppedReason = 'cancelled';
			} else {
				const status = phase === 'dispatching' && issued ? 'uncertain' : 'failed';
				outcomes[index] = { ...step, index, status, message: errorMessage(error) };
				if (status === 'uncertain') uncertain += 1;
				else failed += 1;
				stoppedReason = status;
			}
			break;
		} finally {
			active = false;
		}
		try { assertCurrent(); } catch {
			stoppedReason = 'cancelled';
			break;
		}
	}
	notify(null);
	return Object.freeze({
		...progress(null), stoppedReason,
		outcomes: Object.freeze(outcomes.map((outcome) => Object.freeze(outcome)))
	});
}
