import { describe, expect, it, vi } from 'vitest';

import type { PublicSongResolution } from '@shared/publicSongResolverContracts';
import { PublicSongActionController } from '$lib/library/PublicSongActionController';
import type { PublicSongResolverClient } from '$lib/publicSongResolverClient';
import {
	ClassicBrowseSessionError,
	type ClassicBrowseSessionClaim
} from '$lib/stores/classicBrowseSessionStore';

const claim = {
	owner: 'unified-mode',
	claimId: 1,
	ready: Promise.resolve({ handleId: 'handle-1', generation: 7 })
} as ClassicBrowseSessionClaim;

const firstCandidate = {
	candidateId: 'candidate-1',
	title: 'Seven Nation Army',
	subtitle: 'The White Stripes — Elephant',
	imageKey: null
};
const secondCandidate = {
	candidateId: 'candidate-2',
	title: 'Seven Nation Army',
	subtitle: 'The White Stripes — Elephant (Deluxe)',
	imageKey: null
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeController(resolution: Promise<PublicSongResolution>) {
	const resolve = vi.fn(() => resolution);
	const action = vi.fn().mockResolvedValue({ authorityRetired: true as const });
	const client = { resolve, action } satisfies PublicSongResolverClient;
	return { controller: new PublicSongActionController(client), resolve, action };
}

function begin(controller: PublicSongActionController, selectionId = 'selection-1') {
	return controller.begin({
		claim,
		authority: { state: 'resolver-capable', selectionId },
		zoneId: 'zone-1',
		semantic: 'play-now'
	});
}

describe('PublicSongActionController', () => {
	it('executes one affirmatively authorized candidate without a chooser', async () => {
		const { controller, resolve, action } = makeController(
			Promise.resolve({ kind: 'authorized', candidate: firstCandidate })
		);

		expect(begin(controller)).toEqual({ started: true });
		expect(controller.snapshot().phase).toBe('resolving');
		await vi.waitFor(() => expect(controller.snapshot().phase).toBe('executed'));

		expect(resolve).toHaveBeenCalledWith(claim, 'selection-1');
		expect(action).toHaveBeenCalledWith(
			claim,
			'selection-1',
			firstCandidate,
			'zone-1',
			'play-now'
		);
		expect(controller.snapshot()).toMatchObject({
			selectionId: 'selection-1',
			selectedCandidateId: 'candidate-1',
			authorityRetired: true
		});
	});

	it('publishes only returned choices and executes only an exact chosen ID', async () => {
		const { controller, action } = makeController(
			Promise.resolve({
				kind: 'choice-required',
				candidates: [firstCandidate, secondCandidate]
			})
		);
		begin(controller);
		await vi.waitFor(() => expect(controller.snapshot().phase).toBe('choosing'));

		expect(controller.snapshot().candidates).toEqual([firstCandidate, secondCandidate]);
		expect(action).not.toHaveBeenCalled();
		expect(controller.choose('invented')).toBe(false);
		expect(controller.choose('candidate-2')).toBe(true);
		expect(controller.snapshot().phase).toBe('executing');
		await vi.waitFor(() => expect(controller.snapshot().phase).toBe('executed'));
		expect(action).toHaveBeenCalledWith(
			claim,
			'selection-1',
			secondCandidate,
			'zone-1',
			'play-now'
		);
	});

	it('drops a late resolver result after cancel or replacement', async () => {
		const first = deferred<PublicSongResolution>();
		const second = deferred<PublicSongResolution>();
		const resolve = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);
		const action = vi.fn().mockResolvedValue({ authorityRetired: true as const });
		const controller = new PublicSongActionController({ resolve, action });

		begin(controller, 'selection-1');
		expect(controller.cancel()).toBe(true);
		first.resolve({ kind: 'choice-required', candidates: [firstCandidate, secondCandidate] });
		await Promise.resolve();
		expect(controller.snapshot().phase).toBe('canceled');
		expect(controller.snapshot().candidates).toEqual([]);

		begin(controller, 'selection-2');
		second.resolve({ kind: 'authorized', candidate: secondCandidate });
		await vi.waitFor(() => expect(controller.snapshot().phase).toBe('executed'));
		expect(action).toHaveBeenCalledTimes(1);
		expect(action).toHaveBeenCalledWith(
			claim,
			'selection-2',
			secondCandidate,
			'zone-1',
			'play-now'
		);
	});

	it('fails closed on an unavailable resolution and preserves outcome unknown', async () => {
		const unavailable = makeController(
			Promise.resolve({
				kind: 'unavailable',
				reason: {
					code: 'no-exact-match',
					message: 'no exact library track matched this row'
				}
			})
		);
		begin(unavailable.controller);
		await vi.waitFor(() => expect(unavailable.controller.snapshot().phase).toBe('failed'));
		expect(unavailable.controller.snapshot()).toMatchObject({
			code: 'no-exact-match',
			error: 'no exact library track matched this row'
		});
		expect(unavailable.action).not.toHaveBeenCalled();

		const unknown = makeController(
			Promise.resolve({ kind: 'authorized', candidate: firstCandidate })
		);
		unknown.action.mockRejectedValue(
			new ClassicBrowseSessionError('Roon did not confirm the action', 'OUTCOME_UNKNOWN')
		);
		begin(unknown.controller);
		await vi.waitFor(() => expect(unknown.controller.snapshot().phase).toBe('outcome-unknown'));
		expect(unknown.controller.snapshot().authorityRetired).toBe(true);
	});

	it('does not let a second begin replace an executing action', async () => {
		const pendingAction = deferred<{ authorityRetired: true }>();
		const resolve = vi.fn().mockResolvedValue({
			kind: 'authorized' as const,
			candidate: firstCandidate
		});
		const action = vi.fn(() => pendingAction.promise);
		const controller = new PublicSongActionController({ resolve, action });

		begin(controller, 'selection-1');
		await vi.waitFor(() => expect(controller.snapshot().phase).toBe('executing'));
		expect(begin(controller, 'selection-2')).toEqual({ started: false, reason: 'busy' });
		expect(controller.snapshot().selectionId).toBe('selection-1');

		pendingAction.resolve({ authorityRetired: true });
		await vi.waitFor(() => expect(controller.snapshot().phase).toBe('executed'));
	});

	it('abandons an executing claim and ignores its late acknowledgement', async () => {
		const pendingAction = deferred<{ authorityRetired: true }>();
		const controller = new PublicSongActionController({
			resolve: vi.fn().mockResolvedValue({
				kind: 'authorized',
				candidate: firstCandidate
			}),
			action: vi.fn(() => pendingAction.promise)
		});
		begin(controller);
		await vi.waitFor(() => expect(controller.snapshot().phase).toBe('executing'));

		controller.abandon();
		expect(controller.snapshot().phase).toBe('idle');
		pendingAction.resolve({ authorityRetired: true });
		await Promise.resolve();
		expect(controller.snapshot().phase).toBe('idle');
	});
});
