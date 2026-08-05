import {
	normalizeLibraryAlbumFailedEvent,
	normalizeLibraryAlbumOpenAck,
	normalizeLibraryAlbumOpenRequest,
	normalizeLibraryAlbumResolvedEvent,
	type LibraryAlbumCandidate,
	type LibraryAlbumCorrelation,
	type LibraryAlbumOpenRequest,
	type LibraryAlbumTrack
} from '@shared/libraryAlbumContracts';
import { emitWithBoundedAck, type BoundedAckSocket } from '$lib/socket/emit';
import { createSecureTimelineOpaqueId } from '$lib/timeline/secureOpaqueId';

export type LibraryAlbumPhase = 'idle' | 'resolving' | 'resolved' | 'failed' | 'canceled';

export interface LibraryAlbumState {
	readonly phase: LibraryAlbumPhase;
	readonly albumLocalId: string | null;
	readonly generation: number | null;
	readonly requestId: string | null;
	readonly operationId: string | null;
	/** Server timestamp retained only as correlation evidence. */
	readonly resolvingDeadlineAt: number | null;
	readonly artist: string | null;
	readonly title: string | null;
	readonly actionsAvailable: boolean;
	readonly orderedTracks: readonly LibraryAlbumTrack[];
	/** Present only after an ALBUM_AMBIGUOUS failure; the chooser option set. */
	readonly candidates: readonly LibraryAlbumCandidate[];
	readonly code: string | null;
	readonly error: string | null;
	readonly transitionedAt: number;
}

export interface LibraryAlbumOpenInput {
	readonly albumLocalId: string;
	readonly tabId: string;
	/** Generation from the live unified session claim. */
	readonly generation: number;
	/** Chooser retry: resolve exactly this previously offered candidate. */
	readonly candidate?: LibraryAlbumCandidate;
}

export type LibraryAlbumOpenResult =
	| { readonly started: true; readonly requestId: string }
	| { readonly started: false; readonly reason: 'disposed' | 'invalid' | 'not-connected' };

export interface LibraryAlbumSocket extends BoundedAckSocket {
	readonly connected: boolean;
	on(event: string, handler: (value: unknown) => void): unknown;
	off(event: string, handler: (value: unknown) => void): unknown;
	emit(event: string, payload: unknown): unknown;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface LibraryAlbumControllerDependencies {
	readonly getSocket: () => LibraryAlbumSocket | null;
	readonly createRequestId?: () => string;
	readonly now?: () => number;
	readonly setTimer?: (callback: () => void, milliseconds: number) => TimerHandle;
	readonly clearTimer?: (timer: TimerHandle) => void;
	readonly ackTimeoutMs?: number;
	readonly resolvingTimeoutMs?: number;
}

interface ActiveAttempt {
	readonly request: LibraryAlbumOpenRequest;
	readonly socket: LibraryAlbumSocket;
	ackSettled: boolean;
	operationId: string | null;
	resolvingDeadlineAt: number | null;
	timer: TimerHandle | null;
	listenersAttached: boolean;
	readonly resolved: (value: unknown) => void;
	readonly failed: (value: unknown) => void;
}

const ACK_TIMEOUT_MS = 5_000;
const RESOLVING_TIMEOUT_MS = 30_000;

function boundedDuration(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > 5 * 60_000) {
		throw new RangeError(`${label} must be a positive bounded integer`);
	}
	return value;
}

function frozenTracks(tracks: readonly LibraryAlbumTrack[]): readonly LibraryAlbumTrack[] {
	return Object.freeze(tracks.map((track) => Object.freeze({ ...track })));
}

function frozenCandidates(
	candidates: readonly LibraryAlbumCandidate[]
): readonly LibraryAlbumCandidate[] {
	return Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate })));
}

/**
 * DOM-independent client state machine for the single-phase library-album
 * read lease. Listeners attach before the open emit so a fast server can
 * never publish an event into a listener gap. A newer open supersedes the
 * previous attempt locally, mirroring the server's per-tab supersede rule.
 * Server deadline timestamps are correlation evidence only; local bounded
 * timers start at acknowledgment so browser and server clocks never need to
 * agree.
 */
export class LibraryAlbumController {
	readonly #getSocket: () => LibraryAlbumSocket | null;
	readonly #createRequestId: () => string;
	readonly #now: () => number;
	readonly #setTimer: (callback: () => void, milliseconds: number) => TimerHandle;
	readonly #clearTimer: (timer: TimerHandle) => void;
	readonly #ackTimeoutMs: number;
	readonly #resolvingTimeoutMs: number;
	readonly #subscribers = new Set<(state: LibraryAlbumState) => void>();
	#state: LibraryAlbumState;
	#attempt: ActiveAttempt | null = null;
	#disposed = false;

	public constructor(dependencies: LibraryAlbumControllerDependencies) {
		this.#getSocket = dependencies.getSocket;
		this.#createRequestId =
			dependencies.createRequestId ?? (() => createSecureTimelineOpaqueId());
		this.#now = dependencies.now ?? Date.now;
		this.#setTimer =
			dependencies.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
		this.#clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));
		this.#ackTimeoutMs = boundedDuration(
			dependencies.ackTimeoutMs ?? ACK_TIMEOUT_MS,
			'ackTimeoutMs'
		);
		this.#resolvingTimeoutMs = boundedDuration(
			dependencies.resolvingTimeoutMs ?? RESOLVING_TIMEOUT_MS,
			'resolvingTimeoutMs'
		);
		this.#state = this.#idleState();
	}

	public subscribe(run: (state: LibraryAlbumState) => void): () => void {
		this.#subscribers.add(run);
		run(this.#state);
		return () => {
			this.#subscribers.delete(run);
		};
	}

	public snapshot(): LibraryAlbumState {
		return this.#state;
	}

	public open(input: LibraryAlbumOpenInput): LibraryAlbumOpenResult {
		if (this.#disposed) return { started: false, reason: 'disposed' };
		const requestId = this.#createRequestId();
		const request = normalizeLibraryAlbumOpenRequest({
			requestId,
			tabId: input.tabId,
			albumLocalId: input.albumLocalId,
			generation: input.generation,
			...(input.candidate ? { candidate: { ...input.candidate } } : {})
		});
		if (!request) return { started: false, reason: 'invalid' };
		const socket = this.#getSocket();
		if (!socket || !socket.connected) return { started: false, reason: 'not-connected' };

		// A newer open supersedes the previous attempt, mirroring the server.
		this.#retireAttempt(true);

		const attempt: ActiveAttempt = {
			request,
			socket,
			ackSettled: false,
			operationId: null,
			resolvingDeadlineAt: null,
			timer: null,
			listenersAttached: false,
			resolved: (value: unknown) => this.#handleResolved(attempt, value),
			failed: (value: unknown) => this.#handleFailed(attempt, value)
		};
		this.#attempt = attempt;
		// Listeners attach before the emit so acceptance can never race a
		// resolution event into a listener gap.
		this.#attachListeners(attempt);
		this.#publish({
			...this.#idleState(),
			phase: 'resolving',
			albumLocalId: request.albumLocalId,
			generation: request.generation,
			requestId: request.requestId
		});
		this.#armTimer(attempt, this.#ackTimeoutMs, () => this.#handleAckTimeout(attempt));
		try {
			emitWithBoundedAck(socket, 'library-album:open', request, this.#ackTimeoutMs, (result) =>
				this.#handleOpenAck(attempt, result.acknowledged ? result.value : null)
			);
		} catch {
			this.#failAttempt(attempt, 'OPEN_FAILED', 'The album read request could not be sent');
			return { started: true, requestId };
		}
		return { started: true, requestId };
	}

	/** Cancels the active read, notifying the server best-effort. */
	public cancel(): void {
		const attempt = this.#attempt;
		if (!attempt) return;
		this.#emitCancel(attempt);
		this.#detachListeners(attempt);
		this.#clearAttemptTimer(attempt);
		this.#attempt = null;
		this.#publish({
			...this.#state,
			phase: 'canceled',
			code: 'CANCELED',
			error: null,
			transitionedAt: this.#now()
		});
	}

	/** Resets a terminal state back to idle. No-op while a read is active. */
	public reset(): void {
		if (this.#attempt || this.#disposed) return;
		if (this.#state.phase === 'idle') return;
		this.#publish(this.#idleState());
	}

	public dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#retireAttempt(true);
		this.#subscribers.clear();
	}

	#idleState(): LibraryAlbumState {
		return Object.freeze({
			phase: 'idle' as const,
			albumLocalId: null,
			generation: null,
			requestId: null,
			operationId: null,
			resolvingDeadlineAt: null,
			artist: null,
			title: null,
			actionsAvailable: false,
			orderedTracks: Object.freeze([]) as readonly LibraryAlbumTrack[],
			candidates: Object.freeze([]) as readonly LibraryAlbumCandidate[],
			code: null,
			error: null,
			transitionedAt: this.#now()
		});
	}

	#publish(state: LibraryAlbumState): void {
		this.#state = Object.freeze({ ...state });
		for (const run of [...this.#subscribers]) {
			try {
				run(this.#state);
			} catch {
				// Subscriber failures must not corrupt controller state.
			}
		}
	}

	#retireAttempt(emitCancel: boolean): void {
		const attempt = this.#attempt;
		if (!attempt) return;
		if (emitCancel) this.#emitCancel(attempt);
		this.#detachListeners(attempt);
		this.#clearAttemptTimer(attempt);
		this.#attempt = null;
	}

	#emitCancel(attempt: ActiveAttempt): void {
		try {
			attempt.socket.emit(
				'library-album:cancel',
				attempt.operationId
					? { operationId: attempt.operationId }
					: { requestId: attempt.request.requestId }
			);
		} catch {
			// Best-effort: the server's own TTL retires unreachable operations.
		}
	}

	#attachListeners(attempt: ActiveAttempt): void {
		if (attempt.listenersAttached) return;
		attempt.socket.on('library-album:resolved', attempt.resolved);
		attempt.socket.on('library-album:failed', attempt.failed);
		attempt.listenersAttached = true;
	}

	#detachListeners(attempt: ActiveAttempt): void {
		if (!attempt.listenersAttached) return;
		attempt.socket.off('library-album:resolved', attempt.resolved);
		attempt.socket.off('library-album:failed', attempt.failed);
		attempt.listenersAttached = false;
	}

	#armTimer(attempt: ActiveAttempt, milliseconds: number, expire: () => void): void {
		this.#clearAttemptTimer(attempt);
		attempt.timer = this.#setTimer(expire, milliseconds);
	}

	#clearAttemptTimer(attempt: ActiveAttempt): void {
		if (attempt.timer !== null) this.#clearTimer(attempt.timer);
		attempt.timer = null;
	}

	#handleOpenAck(attempt: ActiveAttempt, value: unknown): void {
		if (this.#attempt !== attempt || attempt.ackSettled) {
			// A superseded attempt whose open still landed must not leak its
			// server-side lease.
			this.#cancelLateAcceptance(attempt, value);
			return;
		}
		attempt.ackSettled = true;
		const ack = normalizeLibraryAlbumOpenAck(value, attempt.request.requestId);
		if (!ack) {
			this.#failAttempt(attempt, 'OPEN_FAILED', 'The album read was not acknowledged');
			return;
		}
		if (!ack.success) {
			this.#failAttempt(attempt, ack.code, ack.error);
			return;
		}
		attempt.operationId = ack.data.operationId;
		attempt.resolvingDeadlineAt = ack.data.resolvingDeadlineAt;
		this.#publish({
			...this.#state,
			operationId: ack.data.operationId,
			resolvingDeadlineAt: ack.data.resolvingDeadlineAt,
			transitionedAt: this.#now()
		});
		this.#armTimer(attempt, this.#resolvingTimeoutMs, () =>
			this.#handleResolvingTimeout(attempt)
		);
	}

	#cancelLateAcceptance(attempt: ActiveAttempt, value: unknown): void {
		const ack = normalizeLibraryAlbumOpenAck(value, attempt.request.requestId);
		if (ack?.success) {
			try {
				attempt.socket.emit('library-album:cancel', {
					operationId: ack.data.operationId
				});
			} catch {
				// Best-effort: the server's own TTL retires the lease.
			}
		}
	}

	#correlation(attempt: ActiveAttempt): LibraryAlbumCorrelation | null {
		if (attempt.operationId === null || attempt.resolvingDeadlineAt === null) return null;
		return {
			requestId: attempt.request.requestId,
			operationId: attempt.operationId,
			generation: attempt.request.generation,
			resolvingDeadlineAt: attempt.resolvingDeadlineAt
		};
	}

	#handleResolved(attempt: ActiveAttempt, value: unknown): void {
		if (this.#attempt !== attempt) return;
		const expected = this.#correlation(attempt);
		if (!expected) return;
		const event = normalizeLibraryAlbumResolvedEvent(value, expected);
		if (!event) return;
		this.#detachListeners(attempt);
		this.#clearAttemptTimer(attempt);
		this.#attempt = null;
		this.#publish({
			...this.#state,
			phase: 'resolved',
			artist: event.artist,
			title: event.title,
			actionsAvailable: event.actionsAvailable,
			orderedTracks: frozenTracks(event.orderedTracks),
			candidates: Object.freeze([]) as readonly LibraryAlbumCandidate[],
			code: null,
			error: null,
			transitionedAt: this.#now()
		});
	}

	#handleFailed(attempt: ActiveAttempt, value: unknown): void {
		if (this.#attempt !== attempt) return;
		const expected = this.#correlation(attempt);
		if (!expected) return;
		const event = normalizeLibraryAlbumFailedEvent(value, expected);
		if (!event) return;
		this.#detachListeners(attempt);
		this.#clearAttemptTimer(attempt);
		this.#attempt = null;
		this.#publish({
			...this.#state,
			phase: event.code === 'CANCELED' ? 'canceled' : 'failed',
			candidates: event.candidates
				? frozenCandidates(event.candidates)
				: (Object.freeze([]) as readonly LibraryAlbumCandidate[]),
			code: event.code,
			error: event.error,
			transitionedAt: this.#now()
		});
	}

	#handleAckTimeout(attempt: ActiveAttempt): void {
		if (this.#attempt !== attempt || attempt.ackSettled) return;
		attempt.ackSettled = true;
		this.#failAttempt(attempt, 'OPEN_FAILED', 'The album read was not acknowledged in time');
	}

	#handleResolvingTimeout(attempt: ActiveAttempt): void {
		if (this.#attempt !== attempt) return;
		this.#emitCancel(attempt);
		this.#failAttempt(
			attempt,
			'RESOLUTION_TIMEOUT',
			'The album read did not resolve in time'
		);
	}

	#failAttempt(attempt: ActiveAttempt, code: string, error: string): void {
		if (this.#attempt !== attempt) return;
		this.#detachListeners(attempt);
		this.#clearAttemptTimer(attempt);
		this.#attempt = null;
		this.#publish({
			...this.#state,
			phase: 'failed',
			code,
			error,
			transitionedAt: this.#now()
		});
	}
}
