import type { AlbumActionSemantic } from '@shared/albumActionContracts';
import type { AlbumActionBeginInput, AlbumActionController, AlbumActionState } from './AlbumActionController';
import type { TrackActionBatchDispatchResult, TrackActionBatchGuard } from './trackActionBatch';

function waitForAction(
	controller: AlbumActionController, requestId: string, terminal: boolean, signal: AbortSignal
): Promise<AlbumActionState> {
	return new Promise((resolve, reject) => {
		let stop: (() => void) | undefined;
		let settled = false;
		const finish = (state?: AlbumActionState): void => {
			if (settled) return;
			settled = true;
			stop?.();
			signal.removeEventListener('abort', abort);
			if (state) resolve(state);
			else reject(new Error('The selected track action was cancelled.'));
		};
		const abort = (): void => finish();
		const observe = (state: AlbumActionState): void => {
			if (state.requestId !== requestId) { finish(); return; }
			if (state.phase === 'resolving' || state.phase === 'executing') return;
			if (terminal && state.phase === 'choosing') return;
			finish(state);
		};
		// A synchronous acknowledgement may already be definitive. Cancellation
		// stops the next action; it must not erase this action's known outcome.
		if (terminal) observe(controller.snapshot());
		if (settled) return;
		if (signal.aborted) { finish(); return; }
		signal.addEventListener('abort', abort, { once: true });
		stop = controller.subscribe(observe);
		if (settled) stop();
	});
}

export async function prepareAlbumBatchAction(
	controller: AlbumActionController, input: AlbumActionBeginInput,
	semantic: AlbumActionSemantic, guard: TrackActionBatchGuard, signal: AbortSignal
): Promise<{ requestId: string; actionId: string }> {
	guard.assertCurrent();
	// Resolve without auto-execution; the batch owns the irreversible boundary.
	const { desiredSemantic: _desired, ...resolveInput } = input;
	const begun = controller.begin(resolveInput);
	if (!begun.started) throw new Error('Could not load actions for the selected track.');
	let state: AlbumActionState;
	try {
		state = await waitForAction(controller, begun.requestId, false, signal);
	} catch (error) {
		// Keep the batch's cancellation sentinel when no playback was issued.
		guard.assertCurrent();
		throw error;
	}
	guard.assertCurrent();
	const choices = state.actions.filter(action => action.semantic === semantic);
	if (state.phase !== 'choosing' || choices.length !== 1) {
		throw new Error(state.error ?? 'This action is not available for the selected track.');
	}
	return { requestId: begun.requestId, actionId: choices[0].actionId };
}

export async function dispatchAlbumBatchAction(
	controller: AlbumActionController, prepared: { requestId: string; actionId: string },
	guard: TrackActionBatchGuard, signal: AbortSignal
): Promise<TrackActionBatchDispatchResult> {
	guard.assertCurrent();
	const current = controller.snapshot();
	if (current.requestId !== prepared.requestId || current.phase !== 'choosing' ||
		!current.actions.some(action => action.actionId === prepared.actionId)) {
		return { status: 'failed', message: 'The selected track action is no longer current.' };
	}
	guard.markIssued();
	if (!controller.execute(prepared.actionId)) return { status: 'failed', message: 'The action was not sent.' };
	const result = await waitForAction(controller, prepared.requestId, true, signal);
	return result.phase === 'executed' ? { status: 'completed' }
		: result.phase === 'outcome-unknown' || result.phase === 'canceled'
			? { status: 'uncertain', message: result.error ?? 'The action outcome is unknown.' }
			: { status: 'failed', message: result.error ?? 'The action failed.' };
}
