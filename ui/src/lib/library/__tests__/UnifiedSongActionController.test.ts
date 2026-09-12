import { describe, expect, it, vi } from 'vitest';

import { UnifiedSongActionController } from '../UnifiedSongActionController';
import { createUnifiedSearchClient } from '$lib/unifiedSearchClient';
import {
	ClassicBrowseSessionError,
	type ClassicBrowseSessionClaim,
	type ClassicBrowseSessionClient
} from '$lib/stores/classicBrowseSessionStore';

const claim = {
	owner: 'unified-mode',
	claimId: 1,
	ready: Promise.resolve({ handleId: 'handle-1', generation: 7 })
} as ClassicBrowseSessionClaim;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe('UnifiedSongActionController', () => {
	it('sends the exact selected semantic and publishes execution', async () => {
		const action = vi.fn().mockResolvedValue({ authorityRetired: false });
		const controller = new UnifiedSongActionController({ action });

		await expect(
			controller.execute({
				claim,
				resultId: 'song-result-1',
				semantic: 'add-next',
				zoneId: 'zone-1'
			})
		).resolves.toBe(true);

		expect(action).toHaveBeenCalledWith(claim, 'song-result-1', 'zone-1', 'add-next', undefined);
		expect(controller.snapshot()).toMatchObject({
			phase: 'executed',
			semantic: 'add-next',
			authorityRetired: false
		});
	});

	it('refuses a second local start while the first action is unresolved', async () => {
		const gate = deferred<{ authorityRetired: boolean }>();
		const action = vi.fn(() => gate.promise);
		const controller = new UnifiedSongActionController({ action });

		const first = controller.execute({
			claim,
			resultId: 'song-result-1',
			semantic: 'queue',
			zoneId: 'zone-1'
		});
		await expect(
			controller.execute({
				claim,
				resultId: 'song-result-1',
				semantic: 'play-now',
				zoneId: 'zone-1'
			})
		).resolves.toBe(false);

		expect(action).toHaveBeenCalledTimes(1);
		gate.resolve({ authorityRetired: false });
		await first;
	});

	it('does not send a selected song cancelled while its session is becoming ready', async () => {
		const ready = deferred<Awaited<ClassicBrowseSessionClaim['ready']>>();
		const pendingClaim = { ...claim, ready: ready.promise };
		const emit = vi.fn().mockResolvedValue({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				resultId: 'song-result-2',
				semantic: 'queue',
				outcome: 'executed',
				authorityRetired: false
			}
		});
		const client = createUnifiedSearchClient({
			getSocket: () => ({ connected: true }) as never,
			getTabId: () => 'tab-1',
			createRequestId: () => 'request-1',
			sessionClient: {
				isClaimCurrent: () => true,
				isSessionCurrent: () => true
			} as unknown as ClassicBrowseSessionClient,
			emit
		});
		const controller = new UnifiedSongActionController(client);
		let cancelled = false;
		const beforeDispatch = vi.fn(() => {
			if (cancelled) throw new Error('Selection cancelled before dispatch');
		});
		const input = {
			claim: pendingClaim,
			resultId: 'song-result-2',
			semantic: 'queue' as const,
			zoneId: 'zone-1',
			beforeDispatch
		};
		const execution = controller.execute(input);
		expect(beforeDispatch).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();

		cancelled = true;
		ready.resolve({ handleId: 'handle-1', generation: 7 });
		await execution;

		expect(emit).not.toHaveBeenCalled();
		expect(beforeDispatch).toHaveBeenCalledTimes(1);
		expect(controller.snapshot()).toMatchObject({
			phase: 'failed',
			error: 'Selection cancelled before dispatch'
		});
	});

	it('distinguishes an unknown issued outcome and retires the local result', async () => {
		const action = vi
			.fn()
			.mockRejectedValue(
				new ClassicBrowseSessionError(
					'Roon received the action but did not confirm it',
					'OUTCOME_UNKNOWN'
				)
			);
		const controller = new UnifiedSongActionController({ action });

		await controller.execute({
			claim,
			resultId: 'song-result-1',
			semantic: 'play-now',
			zoneId: 'zone-1'
		});

		expect(controller.snapshot()).toMatchObject({
			phase: 'outcome-unknown',
			code: 'OUTCOME_UNKNOWN',
			authorityRetired: true
		});
	});
});
