import { describe, expect, it, vi } from 'vitest';

import type { AckResponse } from '$lib/socket/emit';
import type {
	ClassicBrowseSessionClaim,
	ClassicBrowseSessionClient
} from '$lib/stores/classicBrowseSessionStore';
import { ClassicBrowseSessionError, ClassicBrowseSupersededError } from '$lib/stores/classicBrowseSessionStore';
import { createUnifiedSearchClient } from '$lib/unifiedSearchClient';

const claim = {
	owner: 'unified-mode',
	claimId: 1,
	ready: Promise.resolve({ handleId: 'handle-1', generation: 7 })
} as ClassicBrowseSessionClaim;

function makeClient(raw: AckResponse<unknown>) {
	const emit = vi.fn().mockResolvedValue(raw);
	const isGenerationCurrent = vi.fn(() => true);
	const isSessionCurrent = vi.fn(() => true);
	const sessionClient = {
		isClaimCurrent: vi.fn(() => true),
		isGenerationCurrent,
		isSessionCurrent
	} as unknown as ClassicBrowseSessionClient;
	const client = createUnifiedSearchClient({
		getSocket: () => ({ connected: true }) as never,
		getTabId: () => 'tab-1',
		createRequestId: () => 'request-1',
		sessionClient,
		emit
	});
	return { client, emit, sessionClient, isGenerationCurrent, isSessionCurrent };
}

describe('UnifiedSearchClient', () => {
	it('accepts only a correlated opaque song result payload', async () => {
		const { client, emit } = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				query: 'hamilton',
				results: [
					{
						resultId: 'song-opaque-1',
						title: 'Dear Theodosia',
						subtitle: 'Orlando Ballet Chorus',
						imageKey: null
					}
				]
			}
		});

		await expect(client.search(claim, 'hamilton')).resolves.toEqual([
			{
				resultId: 'song-opaque-1',
				title: 'Dear Theodosia',
				subtitle: 'Orlando Ballet Chorus',
				imageKey: null
			}
		]);
		expect(emit).toHaveBeenCalledWith(
			expect.anything(),
			'unified-search:search',
			{
				requestId: 'request-1',
				tabId: 'tab-1',
				session: { handleId: 'handle-1', generation: 7 },
				query: 'hamilton'
			},
			expect.objectContaining({ timeoutMs: expect.any(Number) })
		);
	});

	it('keeps the server session identity separate from the browser lifecycle generation', async () => {
		const { client, isGenerationCurrent, isSessionCurrent } = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				query: 'hamilton',
				results: []
			}
		});
		isGenerationCurrent.mockReturnValue(false);

		await expect(client.search(claim, 'hamilton')).resolves.toEqual([]);
		expect(isSessionCurrent).toHaveBeenCalledWith(claim, {
			handleId: 'handle-1',
			generation: 7
		});
		expect(isGenerationCurrent).not.toHaveBeenCalled();
	});

	it('rejects a malformed success payload instead of accepting missing authority', async () => {
		const { client } = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				query: 'hamilton',
				results: [{ title: 'Dear Theodosia', subtitle: '', imageKey: null }]
			}
		});

		await expect(client.search(claim, 'hamilton')).rejects.toBeInstanceOf(
			ClassicBrowseSessionError
		);
	});

	it('drops a response when the owning mode generation changes', async () => {
		const { client, isSessionCurrent } = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				query: 'hamilton',
				results: []
			}
		});
		isSessionCurrent
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);

		await expect(client.search(claim, 'hamilton')).rejects.toBeInstanceOf(
			ClassicBrowseSupersededError
		);
	});

	it('requests one correlated allowlisted relationship for the retained song', async () => {
		const { client, emit } = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				resultId: 'song-result-1',
				songTitle: 'Dear Theodosia',
				albums: [
					{
						albumLocalId: 'album-1',
						artistLocalId: 'artist-1',
						title: 'Hamilton',
						artist: 'Orlando Ballet Chorus',
						editionText: ''
					}
				],
				composerLabels: ['Lio-Marcus Mendel']
			}
		});

		await expect(client.relationship(claim, 'song-result-1')).resolves.toEqual({
			songTitle: 'Dear Theodosia',
			albums: [
				{
					albumLocalId: 'album-1',
					artistLocalId: 'artist-1',
					title: 'Hamilton',
					artist: 'Orlando Ballet Chorus',
					editionText: ''
				}
			],
			composerLabels: ['Lio-Marcus Mendel']
		});
		expect(emit).toHaveBeenCalledWith(
			expect.anything(),
			'unified-search:relationship',
			{
				requestId: 'request-1',
				tabId: 'tab-1',
				session: { handleId: 'handle-1', generation: 7 },
				resultId: 'song-result-1'
			},
			expect.objectContaining({ timeoutMs: expect.any(Number) })
		);
	});

	it('sends one correlated semantic action for an opaque result', async () => {
		const { client, emit } = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 },
				resultId: 'song-result-1',
				semantic: 'queue',
				outcome: 'executed',
				authorityRetired: false
			}
		});

		await expect(client.action(claim, 'song-result-1', 'zone-1', 'queue')).resolves.toEqual({
			authorityRetired: false
		});
		expect(emit).toHaveBeenCalledWith(
			expect.anything(),
			'unified-search:action',
			{
				requestId: 'request-1',
				tabId: 'tab-1',
				session: { handleId: 'handle-1', generation: 7 },
				resultId: 'song-result-1',
				zoneId: 'zone-1',
				semantic: 'queue'
			},
			expect.objectContaining({ timeoutMs: expect.any(Number) })
		);
	});

	it('preserves the server outcome-unknown code for the controller', async () => {
		const { client } = makeClient({
			success: false,
			error: 'Roon received the action but did not confirm it',
			code: 'OUTCOME_UNKNOWN'
		});

		await expect(
			client.action(claim, 'song-result-1', 'zone-1', 'play-now')
		).rejects.toMatchObject({
			code: 'OUTCOME_UNKNOWN'
		});
	});

	it('explicitly clears the current search authority', async () => {
		const { client, emit } = makeClient({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 7 }
			}
		});

		await expect(client.clear(claim)).resolves.toBeUndefined();
		expect(emit).toHaveBeenCalledWith(
			expect.anything(),
			'unified-search:clear',
			{
				requestId: 'request-1',
				tabId: 'tab-1',
				session: { handleId: 'handle-1', generation: 7 }
			},
			expect.objectContaining({ timeoutMs: expect.any(Number) })
		);
	});
});
