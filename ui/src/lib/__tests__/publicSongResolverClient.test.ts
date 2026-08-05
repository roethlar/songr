import { describe, expect, it, vi } from 'vitest';

import type { AckResponse } from '$lib/socket/emit';
import type {
	ClassicBrowseSessionClaim,
	ClassicBrowseSessionClient
} from '$lib/stores/classicBrowseSessionStore';
import {
	ClassicBrowseSessionError,
	ClassicBrowseSupersededError
} from '$lib/stores/classicBrowseSessionStore';
import { createPublicSongResolverClient } from '$lib/publicSongResolverClient';

const claim = {
	owner: 'unified-mode',
	claimId: 1,
	ready: Promise.resolve({ handleId: 'handle-1', generation: 7 })
} as ClassicBrowseSessionClaim;

function makeClient(raw: AckResponse<unknown>) {
	const emit = vi.fn().mockResolvedValue(raw);
	const isSessionCurrent = vi.fn(() => true);
	const sessionClient = {
		isClaimCurrent: vi.fn(() => true),
		isSessionCurrent
	} as unknown as ClassicBrowseSessionClient;
	const client = createPublicSongResolverClient({
		getSocket: () => ({ connected: true }) as never,
		getTabId: () => 'tab-1',
		createRequestId: () => 'request-1',
		sessionClient,
		emit
	});
	return { client, emit, isSessionCurrent };
}

describe('PublicSongResolverClient', () => {
	it('accepts one strictly correlated chooser result', async () => {
		const candidates = [
			{
				candidateId: 'candidate-1',
				title: 'Seven Nation Army',
				subtitle: 'The White Stripes — Elephant',
				imageKey: null
			},
			{
				candidateId: 'candidate-2',
				title: 'Seven Nation Army',
				subtitle: 'The White Stripes — Elephant (Deluxe)',
				imageKey: 'image-2'
			}
		];
		const { client, emit } = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				selectionId: 'selection-1',
				resolution: { kind: 'choice-required', candidates }
			}
		});

		await expect(client.resolve(claim, 'selection-1')).resolves.toEqual({
			kind: 'choice-required',
			candidates
		});
		expect(emit).toHaveBeenCalledWith(
			expect.anything(),
			'public-song:resolve',
			{
				requestId: 'request-1',
				tabId: 'tab-1',
				session: { handleId: 'handle-1', generation: 7 },
				selectionId: 'selection-1'
			},
			expect.objectContaining({ timeoutMs: expect.any(Number) })
		);
	});

	it('sends only the chosen opaque candidate and semantic action', async () => {
		const { client, emit } = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				selectionId: 'selection-1',
				candidateId: 'candidate-2',
				semantic: 'queue',
				outcome: 'executed',
				authorityRetired: true
			}
		});

		await expect(
			client.action(
				claim,
				'selection-1',
				{ candidateId: 'candidate-2' },
				'zone-1',
				'queue'
			)
		).resolves.toEqual({ authorityRetired: true });
		expect(emit).toHaveBeenCalledWith(
			expect.anything(),
			'public-song:action',
			{
				requestId: 'request-1',
				tabId: 'tab-1',
				session: { handleId: 'handle-1', generation: 7 },
				selectionId: 'selection-1',
				candidateId: 'candidate-2',
				zoneId: 'zone-1',
				semantic: 'queue'
			},
			expect.objectContaining({ timeoutMs: expect.any(Number) })
		);
	});

	it('rejects malformed success data and preserves typed server errors', async () => {
		const malformed = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				selectionId: 'selection-1',
				resolution: {
					kind: 'authorized',
					candidate: { candidateId: 'candidate-1', title: 'Song' }
				}
			}
		});
		await expect(malformed.client.resolve(claim, 'selection-1')).rejects.toBeInstanceOf(
			ClassicBrowseSessionError
		);

		const refused = makeClient({
			success: false,
			error: 'the source row changed',
			code: 'SOURCE_CHANGED'
		});
		await expect(refused.client.resolve(claim, 'selection-1')).rejects.toMatchObject({
			code: 'SOURCE_CHANGED'
		});
	});

	it('drops a late acknowledgement after the owning session changes', async () => {
		const { client, isSessionCurrent } = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				selectionId: 'selection-1',
				resolution: {
					kind: 'unavailable',
					reason: {
						code: 'no-exact-match',
						message: 'no exact library track matched this row'
					}
				}
			}
		});
		isSessionCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);

		await expect(client.resolve(claim, 'selection-1')).rejects.toBeInstanceOf(
			ClassicBrowseSupersededError
		);
	});
});
