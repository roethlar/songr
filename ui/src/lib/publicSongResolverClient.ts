import type { Socket } from 'socket.io-client';

import {
	PUBLIC_SONG_ACTION_ACK_TIMEOUT_MS,
	PUBLIC_SONG_RESOLVE_ACK_TIMEOUT_MS,
	normalizePublicSongActionAck,
	normalizePublicSongActionRequest,
	normalizePublicSongResolveAck,
	normalizePublicSongResolveRequest,
	type PublicSongCandidate,
	type PublicSongResolution
} from '@shared/publicSongResolverContracts';
import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';
import { getSocket } from '$lib/socket/client';
import { emitWithAck, type AckResponse } from '$lib/socket/emit';
import {
	classicBrowseSessionClient,
	ClassicBrowseSessionError,
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim,
	type ClassicBrowseSessionClient
} from '$lib/stores/classicBrowseSessionStore';
import { createSecureOpaqueId } from '$lib/secureOpaqueId';
import { getTabId } from '$lib/tabId';

export interface PublicSongResolverClient {
	resolve(
		claim: ClassicBrowseSessionClaim,
		selectionId: string
	): Promise<PublicSongResolution>;
	action(
		claim: ClassicBrowseSessionClaim,
		selectionId: string,
		candidate: Pick<PublicSongCandidate, 'candidateId'>,
		zoneId: string,
		semantic: UnifiedSongActionSemantic
	): Promise<{ readonly authorityRetired: true }>;
}

export interface PublicSongResolverClientDependencies {
	readonly getSocket: () => Socket | null;
	readonly getTabId: () => string;
	readonly createRequestId: () => string;
	readonly sessionClient: ClassicBrowseSessionClient;
	readonly emit: <T>(
		socket: Socket,
		event: string,
		payload: unknown,
		options: { timeoutMs: number }
	) => Promise<AckResponse<T>>;
}

export function createPublicSongResolverClient(
	dependencies: PublicSongResolverClientDependencies
): PublicSongResolverClient {
	async function readyContext(claim: ClassicBrowseSessionClaim) {
		const session = await claim.ready;
		if (
			!dependencies.sessionClient.isClaimCurrent(claim) ||
			!dependencies.sessionClient.isSessionCurrent(claim, session)
		) {
			throw new ClassicBrowseSupersededError();
		}
		const socket = dependencies.getSocket();
		if (!socket?.connected) {
			throw new ClassicBrowseSessionError('Not connected to server');
		}
		return { session, socket };
	}

	function assertCurrent(
		claim: ClassicBrowseSessionClaim,
		session: Awaited<ClassicBrowseSessionClaim['ready']>
	): void {
		if (
			!dependencies.sessionClient.isClaimCurrent(claim) ||
			!dependencies.sessionClient.isSessionCurrent(claim, session)
		) {
			throw new ClassicBrowseSupersededError();
		}
	}

	return {
		async resolve(
			claim: ClassicBrowseSessionClaim,
			selectionId: string
		): Promise<PublicSongResolution> {
			const { session, socket } = await readyContext(claim);
			const request = normalizePublicSongResolveRequest({
				requestId: dependencies.createRequestId(),
				tabId: dependencies.getTabId(),
				session,
				selectionId
			});
			if (!request) {
				throw new ClassicBrowseSessionError(
					'Track resolution request is invalid',
					'INVALID_REQUEST'
				);
			}
			const raw = await dependencies.emit<unknown>(
				socket,
				'public-song:resolve',
				request,
				{ timeoutMs: PUBLIC_SONG_RESOLVE_ACK_TIMEOUT_MS }
			);
			assertCurrent(claim, session);
			const ack = normalizePublicSongResolveAck(raw, request);
			if (!ack) {
				throw new ClassicBrowseSessionError('Track resolution response was invalid');
			}
			if (!ack.success) {
				throw new ClassicBrowseSessionError(ack.error, ack.code);
			}
			return ack.data.resolution;
		},

		async action(
			claim: ClassicBrowseSessionClaim,
			selectionId: string,
			candidate: Pick<PublicSongCandidate, 'candidateId'>,
			zoneId: string,
			semantic: UnifiedSongActionSemantic
		): Promise<{ readonly authorityRetired: true }> {
			const { session, socket } = await readyContext(claim);
			const request = normalizePublicSongActionRequest({
				requestId: dependencies.createRequestId(),
				tabId: dependencies.getTabId(),
				session,
				selectionId,
				candidateId: candidate.candidateId,
				zoneId,
				semantic
			});
			if (!request) {
				throw new ClassicBrowseSessionError(
					'Track action request is invalid',
					'INVALID_REQUEST'
				);
			}
			const raw = await dependencies.emit<unknown>(
				socket,
				'public-song:action',
				request,
				{ timeoutMs: PUBLIC_SONG_ACTION_ACK_TIMEOUT_MS }
			);
			assertCurrent(claim, session);
			const ack = normalizePublicSongActionAck(raw, request);
			if (!ack) {
				throw new ClassicBrowseSessionError('Track action response was invalid');
			}
			if (!ack.success) {
				throw new ClassicBrowseSessionError(ack.error, ack.code);
			}
			return { authorityRetired: true };
		}
	};
}

export const publicSongResolverClient = createPublicSongResolverClient({
	getSocket,
	getTabId: getTabId,
	createRequestId: createSecureOpaqueId,
	sessionClient: classicBrowseSessionClient,
	emit: emitWithAck
});
