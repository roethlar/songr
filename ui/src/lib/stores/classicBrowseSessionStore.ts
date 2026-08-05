import { writable, type Readable } from 'svelte/store';
import type { Socket } from 'socket.io-client';

import {
	CLASSIC_BROWSE_ACK_TIMEOUT_MS,
	CLASSIC_LOAD_ACK_TIMEOUT_MS,
	CLASSIC_SESSION_ACK_TIMEOUT_MS,
	CLASSIC_SEARCH_ACK_TIMEOUT_MS,
	normalizeClassicBrowseCommandAck,
	normalizeClassicBrowseCommandRequest,
	normalizeClassicSessionAcquireAck,
	normalizeClassicSessionAcquireRequest,
	normalizeClassicSessionReleaseRequest,
	type ClassicBrowseCommandOptions,
	type ClassicBrowseOperation,
	type ClassicBrowseRole,
	type ClassicBrowseSessionRef
} from '@shared/classicBrowseContracts';
import type { BrowseResult, SearchResult } from '@shared/types';
import { getSocket } from '$lib/socket/client';
import { emitWithAck } from '$lib/socket/emit';
import { getTimelineTabId } from '$lib/timeline/tabId';
import { createSecureTimelineOpaqueId } from '$lib/timeline/secureOpaqueId';

export type ClassicBrowseSessionPhase = 'none' | 'acquiring' | 'live';
export type ClassicBrowseSessionOwner =
	| 'inactive'
	| 'normal-shell'
	| 'classic-mode'
	| 'unified-mode';
export type ActiveClassicBrowseSessionOwner = Exclude<ClassicBrowseSessionOwner, 'inactive'>;

export interface ClassicBrowseSessionClaim {
	readonly owner: ActiveClassicBrowseSessionOwner;
	readonly claimId: number;
	readonly ready: Promise<ClassicBrowseSessionRef>;
}

export interface ClassicBrowseSessionState {
	readonly phase: ClassicBrowseSessionPhase;
	readonly session: ClassicBrowseSessionRef | null;
	readonly lifecycleGeneration: number;
	readonly owner: ClassicBrowseSessionOwner;
	readonly ownerEpoch: number;
}

export class ClassicBrowseSessionError extends Error {
	constructor(
		message: string,
		readonly code: string = 'SESSION_LOST'
	) {
		super(message);
		this.name = 'ClassicBrowseSessionError';
	}
}

export class ClassicBrowseSupersededError extends ClassicBrowseSessionError {
	constructor() {
		super('Classic browse interaction was superseded.', 'STALE_GENERATION');
		this.name = 'ClassicBrowseSupersededError';
	}
}

export interface ClassicBrowseSessionClientDependencies {
	readonly getSocket: () => Socket | null;
	readonly getTabId: () => string;
	readonly createRequestId: () => string;
	readonly emit: typeof emitWithAck;
}

export interface ClassicBrowseRoleTransaction {
	request<T extends BrowseResult | readonly SearchResult[]>(
		operation: ClassicBrowseOperation,
		options: ClassicBrowseCommandOptions
	): Promise<T>;
}

export interface ClassicBrowseSessionClient extends Readable<ClassicBrowseSessionState> {
	claim(owner: ActiveClassicBrowseSessionOwner): ClassicBrowseSessionClaim;
	release(claim: ClassicBrowseSessionClaim): void;
	connectionLost(claim: ClassicBrowseSessionClaim): void;
	recover(claim: ClassicBrowseSessionClaim): Promise<ClassicBrowseSessionRef>;
	isClaimCurrent(claim: ClassicBrowseSessionClaim): boolean;
	isSessionCurrent(
		claim: ClassicBrowseSessionClaim,
		session: ClassicBrowseSessionRef
	): boolean;
	isGenerationCurrent(claim: ClassicBrowseSessionClaim, generation: number): boolean;
	generation(): number;
	request<T extends BrowseResult | readonly SearchResult[]>(
		claim: ClassicBrowseSessionClaim,
		operation: ClassicBrowseOperation,
		role: ClassicBrowseRole,
		options: ClassicBrowseCommandOptions
	): Promise<T>;
	transaction<T>(
		claim: ClassicBrowseSessionClaim,
		role: ClassicBrowseRole,
		work: (transaction: ClassicBrowseRoleTransaction) => Promise<T>
	): Promise<T>;
}

const initialState: ClassicBrowseSessionState = {
	phase: 'none',
	session: null,
	lifecycleGeneration: 0,
	owner: 'inactive',
	ownerEpoch: 0
};

export function createClassicBrowseSessionClient(
	dependencies: ClassicBrowseSessionClientDependencies
): ClassicBrowseSessionClient {
	let state = initialState;
	let acquirePromise: Promise<ClassicBrowseSessionRef> | null = null;
	let lifecycleEpoch = 0;
	let ownerEpoch = 0;
	let activeClaimId: number | null = null;
	let activeOwner: ActiveClassicBrowseSessionOwner | null = null;
	const roleQueues = new Map<ClassicBrowseRole, Promise<void>>();
	const internal = writable(state);

	const publish = (next: ClassicBrowseSessionState): void => {
		state = next;
		internal.set(state);
	};
	const publishLifecycle = (
		next: Pick<ClassicBrowseSessionState, 'phase' | 'session' | 'lifecycleGeneration'>
	): void => {
		publish({
			...next,
			owner: activeOwner ?? 'inactive',
			ownerEpoch
		});
	};
	const ownsClaim = (
		claim: Pick<ClassicBrowseSessionClaim, 'owner' | 'claimId'>
	): boolean =>
		activeClaimId === claim.claimId && activeOwner === claim.owner;

	const release = (session: ClassicBrowseSessionRef): void => {
		const socket = dependencies.getSocket();
		if (!socket?.connected) return;
		const request = normalizeClassicSessionReleaseRequest({
			requestId: dependencies.createRequestId(),
			tabId: dependencies.getTabId(),
			session
		});
		if (!request) return;
		void dependencies
			.emit(socket, 'classic-session:release', request, {
				timeoutMs: CLASSIC_SESSION_ACK_TIMEOUT_MS
			})
			.catch(() => undefined);
	};

	const abandon = (
		session: ClassicBrowseSessionRef | null,
		options: { release?: boolean } = {}
	): void => {
		if (
			session &&
			state.session &&
			(session.handleId !== state.session.handleId ||
				session.generation !== state.session.generation)
		) return;
		lifecycleEpoch++;
		roleQueues.clear();
		acquirePromise = null;
		const retired = state.session;
		publishLifecycle({
			phase: 'none',
			session: null,
			lifecycleGeneration: state.lifecycleGeneration + 1
		});
		if (options.release && retired) release(retired);
	};

	const startAcquire = (): Promise<ClassicBrowseSessionRef> => {
		const generation = state.lifecycleGeneration + 1;
		publishLifecycle({ phase: 'acquiring', session: null, lifecycleGeneration: generation });
		const socket = dependencies.getSocket();
		if (!socket?.connected) {
			publishLifecycle({ phase: 'none', session: null, lifecycleGeneration: generation });
			return Promise.reject(new ClassicBrowseSessionError('Not connected to server'));
		}
		const request = normalizeClassicSessionAcquireRequest({
			requestId: dependencies.createRequestId(),
			tabId: dependencies.getTabId()
		});
		if (!request) {
			publishLifecycle({ phase: 'none', session: null, lifecycleGeneration: generation });
			return Promise.reject(new ClassicBrowseSessionError('Classic session request is invalid'));
		}

		const pending = dependencies
			.emit(socket, 'classic-session:acquire', request, {
				timeoutMs: CLASSIC_SESSION_ACK_TIMEOUT_MS
			})
			.then((raw) => {
				if (!raw.success) throw new ClassicBrowseSessionError(raw.error, raw.code);
				const ack = normalizeClassicSessionAcquireAck(raw, request);
				if (!ack?.success) throw new ClassicBrowseSessionError('Malformed Classic session response');
				if (state.lifecycleGeneration !== generation || state.phase !== 'acquiring') {
					release(ack.data.session);
					throw new ClassicBrowseSupersededError();
				}
				publishLifecycle({
					phase: 'live',
					session: ack.data.session,
					lifecycleGeneration: generation
				});
				return ack.data.session;
			})
			.catch((error) => {
				if (state.lifecycleGeneration === generation && state.phase === 'acquiring') {
					publishLifecycle({ phase: 'none', session: null, lifecycleGeneration: generation });
				}
				throw error;
			})
			.finally(() => {
				if (acquirePromise === pending) acquirePromise = null;
			});
		acquirePromise = pending;
		return pending;
	};

	const ensureActive = (
		claim: Pick<ClassicBrowseSessionClaim, 'owner' | 'claimId'>
	): Promise<ClassicBrowseSessionRef> => {
		if (!ownsClaim(claim)) {
			return Promise.reject(new ClassicBrowseSupersededError());
		}
		if (state.phase === 'live' && state.session) return Promise.resolve(state.session);
		if (state.phase === 'acquiring' && acquirePromise) return acquirePromise;
		return startAcquire();
	};

	const enqueue = <T>(
		role: ClassicBrowseRole,
		claim: ClassicBrowseSessionClaim,
		expectedEpoch: number,
		work: () => Promise<T>
	): Promise<T> => {
		const previous = roleQueues.get(role) ?? Promise.resolve();
		const queued = previous.catch(() => undefined).then(async () => {
			if (!ownsClaim(claim) || lifecycleEpoch !== expectedEpoch) {
				throw new ClassicBrowseSupersededError();
			}
			const result = await work();
			if (!ownsClaim(claim) || lifecycleEpoch !== expectedEpoch) {
				throw new ClassicBrowseSupersededError();
			}
			return result;
		});
		const tail = queued.then(
			() => undefined,
			() => undefined
		);
		roleQueues.set(role, tail);
		void tail.then(() => {
			if (roleQueues.get(role) === tail) roleQueues.delete(role);
		});
		return queued;
	};

	const requestNow = async <T extends BrowseResult | readonly SearchResult[]>(
		claim: ClassicBrowseSessionClaim,
		operation: ClassicBrowseOperation,
		role: ClassicBrowseRole,
		options: ClassicBrowseCommandOptions,
		expectedEpoch: number
	): Promise<T> => {
		if (!ownsClaim(claim) || lifecycleEpoch !== expectedEpoch) {
			throw new ClassicBrowseSupersededError();
		}
		const session = await ensureActive(claim);
		const generation = state.lifecycleGeneration;
		const socket = dependencies.getSocket();
		if (
			!socket?.connected ||
			state.phase !== 'live' ||
			!ownsClaim(claim) ||
			lifecycleEpoch !== expectedEpoch
		) {
			throw new ClassicBrowseSupersededError();
		}
		const request = normalizeClassicBrowseCommandRequest({
			requestId: dependencies.createRequestId(),
			tabId: dependencies.getTabId(),
			session,
			role,
			operation,
			options
		});
		if (!request) throw new ClassicBrowseSessionError('Classic browse request is invalid');
		let raw;
		try {
			raw = await dependencies.emit(socket, `browse:${operation}`, request, {
				timeoutMs:
					operation === 'search'
						? CLASSIC_SEARCH_ACK_TIMEOUT_MS
						: operation === 'load'
							? CLASSIC_LOAD_ACK_TIMEOUT_MS
							: CLASSIC_BROWSE_ACK_TIMEOUT_MS
			});
		} catch (error) {
			if (
				state.session?.handleId === session.handleId &&
				state.session.generation === session.generation
			) abandon(session, { release: true });
			throw error;
		}
		if (
			state.phase !== 'live' ||
			!state.session ||
			state.lifecycleGeneration !== generation ||
			!ownsClaim(claim) ||
			lifecycleEpoch !== expectedEpoch
		) {
			throw new ClassicBrowseSupersededError();
		}
		if (!raw.success) {
			abandon(session, {
				release: raw.code !== 'STALE_GENERATION' && raw.code !== 'SESSION_LOST'
			});
			throw new ClassicBrowseSessionError(raw.error, raw.code);
		}
		const ack = normalizeClassicBrowseCommandAck<T>(raw, request);
		if (!ack?.success) {
			abandon(session, { release: true });
			throw new ClassicBrowseSessionError('Malformed Classic browse response');
		}
		if (
			state.phase !== 'live' ||
			!state.session ||
			state.lifecycleGeneration !== generation ||
			!ownsClaim(claim) ||
			lifecycleEpoch !== expectedEpoch
		) {
			throw new ClassicBrowseSupersededError();
		}
		return ack.data.result;
	};
	const claim = (owner: ActiveClassicBrowseSessionOwner): ClassicBrowseSessionClaim => {
		ownerEpoch += 1;
		const claimId = ownerEpoch;
		activeClaimId = claimId;
		activeOwner = owner;
		// Every ownership handoff is a hard generation boundary, including a
		// keyed same-owner replacement. A late cleanup only holds its old token
		// and therefore cannot retire the new owner's session.
		abandon(state.session, { release: true });
		const identity = { owner, claimId };
		const initialReady = ensureActive(identity);
		// A claim begins acquisition immediately, but a first connection race
		// must not permanently poison its public readiness promise. Every later
		// read asks the current lifecycle for its live or recovering session.
		void initialReady.catch(() => undefined);
		return Object.freeze({
			owner,
			claimId,
			get ready() {
				return ensureActive(identity);
			}
		});
	};
	const releaseClaim = (claim: ClassicBrowseSessionClaim): void => {
		if (!ownsClaim(claim)) return;
		activeClaimId = null;
		activeOwner = null;
		ownerEpoch += 1;
		abandon(state.session, { release: true });
	};
	const connectionLost = (claim: ClassicBrowseSessionClaim): void => {
		if (!ownsClaim(claim) || state.phase === 'none') return;
		abandon(state.session);
	};
	const recover = (claim: ClassicBrowseSessionClaim): Promise<ClassicBrowseSessionRef> => {
		if (!ownsClaim(claim)) return Promise.reject(new ClassicBrowseSupersededError());
		return ensureActive(claim);
	};

	return {
		subscribe: internal.subscribe,
		claim,
		release: releaseClaim,
		connectionLost,
		recover,
		generation: () => state.lifecycleGeneration,
		isClaimCurrent: ownsClaim,
		isSessionCurrent: (claim, session) =>
			ownsClaim(claim) &&
			state.phase === 'live' &&
			state.session?.handleId === session.handleId &&
			state.session.generation === session.generation,
		isGenerationCurrent: (claim, generation) =>
			ownsClaim(claim) &&
			state.phase === 'live' &&
			generation === state.lifecycleGeneration,
		request: async <T extends BrowseResult | readonly SearchResult[]>(
			claim: ClassicBrowseSessionClaim,
			operation: ClassicBrowseOperation,
			role: ClassicBrowseRole,
			options: ClassicBrowseCommandOptions
		): Promise<T> => {
			const expectedEpoch = lifecycleEpoch;
			return enqueue(role, claim, expectedEpoch, () =>
				requestNow<T>(claim, operation, role, options, expectedEpoch)
			);
		},
		transaction: <T>(
			claim: ClassicBrowseSessionClaim,
			role: ClassicBrowseRole,
			work: (transaction: ClassicBrowseRoleTransaction) => Promise<T>
		): Promise<T> => {
			const expectedEpoch = lifecycleEpoch;
			return enqueue(role, claim, expectedEpoch, () =>
				work({
					request: <R extends BrowseResult | readonly SearchResult[]>(
						operation: ClassicBrowseOperation,
						options: ClassicBrowseCommandOptions
					): Promise<R> => requestNow<R>(claim, operation, role, options, expectedEpoch)
				})
			);
		}
	};
}

export const classicBrowseSessionClient = createClassicBrowseSessionClient({
	getSocket,
	getTabId: getTimelineTabId,
	createRequestId: createSecureTimelineOpaqueId,
	emit: emitWithAck
});
