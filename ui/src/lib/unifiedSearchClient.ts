import type { Socket } from 'socket.io-client';

import {
	UNIFIED_SEARCH_ACK_TIMEOUT_MS,
	UNIFIED_SONG_ACTION_ACK_TIMEOUT_MS,
	UNIFIED_SONG_RELATIONSHIP_ACK_TIMEOUT_MS,
	normalizeUnifiedSearchClearAck,
	normalizeUnifiedSearchClearRequest,
	normalizeUnifiedSongActionAck,
	normalizeUnifiedSongActionRequest,
	normalizeUnifiedSongRelationshipAck,
	normalizeUnifiedSongRelationshipRequest,
	normalizeUnifiedSongSearchAck,
	normalizeUnifiedSongSearchRequest,
	type UnifiedSongActionSemantic,
	type UnifiedSongRelationship,
	type UnifiedSongSearchResult
} from '@shared/unifiedSearchContracts';
import { getSocket } from '$lib/socket/client';
import { emitWithAck, type AckResponse } from '$lib/socket/emit';
import {
	classicBrowseSessionClient,
	ClassicBrowseSessionError,
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim,
	type ClassicBrowseSessionClient
} from '$lib/stores/classicBrowseSessionStore';
import { createSecureTimelineOpaqueId } from '$lib/timeline/secureOpaqueId';
import { getTimelineTabId } from '$lib/timeline/tabId';

export interface UnifiedSearchClient {
	search(
		claim: ClassicBrowseSessionClaim,
		query: string
	): Promise<readonly UnifiedSongSearchResult[]>;
	action(
		claim: ClassicBrowseSessionClaim,
		resultId: string,
		zoneId: string,
		semantic: UnifiedSongActionSemantic
	): Promise<{ readonly authorityRetired: boolean }>;
	relationship(
		claim: ClassicBrowseSessionClaim,
		resultId: string
	): Promise<UnifiedSongRelationship>;
	clear(claim: ClassicBrowseSessionClaim): Promise<void>;
}

export interface UnifiedSearchClientDependencies {
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

export function createUnifiedSearchClient(
	dependencies: UnifiedSearchClientDependencies
): UnifiedSearchClient {
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
		async search(
			claim: ClassicBrowseSessionClaim,
			query: string
		): Promise<readonly UnifiedSongSearchResult[]> {
			const { session, socket } = await readyContext(claim);
			const request = normalizeUnifiedSongSearchRequest({
				requestId: dependencies.createRequestId(),
				tabId: dependencies.getTabId(),
				session,
				query
			});
			if (!request) {
				throw new ClassicBrowseSessionError('Song search request is invalid', 'INVALID_REQUEST');
			}
			const raw = await dependencies.emit<unknown>(
				socket,
				'unified-search:search',
				request,
				{ timeoutMs: UNIFIED_SEARCH_ACK_TIMEOUT_MS }
			);
			assertCurrent(claim, session);
			const ack = normalizeUnifiedSongSearchAck(raw, request);
			if (!ack) {
				throw new ClassicBrowseSessionError('Song search response was invalid');
			}
			if (!ack.success) {
				throw new ClassicBrowseSessionError(ack.error, ack.code);
			}
			return ack.data.results;
		},

		async relationship(
			claim: ClassicBrowseSessionClaim,
			resultId: string
		): Promise<UnifiedSongRelationship> {
			const { session, socket } = await readyContext(claim);
			const request = normalizeUnifiedSongRelationshipRequest({
				requestId: dependencies.createRequestId(),
				tabId: dependencies.getTabId(),
				session,
				resultId
			});
			if (!request) {
				throw new ClassicBrowseSessionError(
					'Song relationship request is invalid',
					'INVALID_REQUEST'
				);
			}
			const raw = await dependencies.emit<unknown>(
				socket,
				'unified-search:relationship',
				request,
				{ timeoutMs: UNIFIED_SONG_RELATIONSHIP_ACK_TIMEOUT_MS }
			);
			assertCurrent(claim, session);
			const ack = normalizeUnifiedSongRelationshipAck(raw, request);
			if (!ack) {
				throw new ClassicBrowseSessionError('Song relationship response was invalid');
			}
			if (!ack.success) {
				throw new ClassicBrowseSessionError(ack.error, ack.code);
			}
			return {
				songTitle: ack.data.songTitle,
				albums: ack.data.albums,
				composerLabels: ack.data.composerLabels
			};
		},

		async action(
			claim: ClassicBrowseSessionClaim,
			resultId: string,
			zoneId: string,
			semantic: UnifiedSongActionSemantic
		): Promise<{ readonly authorityRetired: boolean }> {
			const { session, socket } = await readyContext(claim);
			const request = normalizeUnifiedSongActionRequest({
				requestId: dependencies.createRequestId(),
				tabId: dependencies.getTabId(),
				session,
				resultId,
				zoneId,
				semantic
			});
			if (!request) {
				throw new ClassicBrowseSessionError('Song action request is invalid', 'INVALID_REQUEST');
			}
			const raw = await dependencies.emit<unknown>(
				socket,
				'unified-search:action',
				request,
				{ timeoutMs: UNIFIED_SONG_ACTION_ACK_TIMEOUT_MS }
			);
			assertCurrent(claim, session);
			const ack = normalizeUnifiedSongActionAck(raw, request);
			if (!ack) {
				throw new ClassicBrowseSessionError('Song action response was invalid');
			}
			if (!ack.success) {
				throw new ClassicBrowseSessionError(ack.error, ack.code);
			}
			return { authorityRetired: ack.data.authorityRetired };
		},

		async clear(claim: ClassicBrowseSessionClaim): Promise<void> {
			const { session, socket } = await readyContext(claim);
			const request = normalizeUnifiedSearchClearRequest({
				requestId: dependencies.createRequestId(),
				tabId: dependencies.getTabId(),
				session
			});
			if (!request) {
				throw new ClassicBrowseSessionError('Search close request is invalid', 'INVALID_REQUEST');
			}
			const raw = await dependencies.emit<unknown>(
				socket,
				'unified-search:clear',
				request,
				{ timeoutMs: UNIFIED_SEARCH_ACK_TIMEOUT_MS }
			);
			assertCurrent(claim, session);
			const ack = normalizeUnifiedSearchClearAck(raw, request);
			if (!ack) {
				throw new ClassicBrowseSessionError('Search close response was invalid');
			}
			if (!ack.success) {
				throw new ClassicBrowseSessionError(ack.error, ack.code);
			}
		}
	};
}

export const unifiedSearchClient = createUnifiedSearchClient({
	getSocket,
	getTabId: getTimelineTabId,
	createRequestId: createSecureTimelineOpaqueId,
	sessionClient: classicBrowseSessionClient,
	emit: emitWithAck
});
