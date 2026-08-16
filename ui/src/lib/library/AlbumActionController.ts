import {
	normalizeAlbumActionBeginAck,
	normalizeAlbumActionBeginRequest,
	normalizeAlbumActionCancelAck,
	normalizeAlbumActionCancelRequest,
	normalizeAlbumActionExecuteAck,
	normalizeAlbumActionExecuteRequest,
	normalizeAlbumActionFailedEvent,
	normalizeAlbumActionResolvedEvent,
	type AlbumActionBeginRequest,
	type AlbumActionChoice,
	type AlbumActionResolutionCorrelation,
	type AlbumActionSemantic,
	type AlbumActionTrackSelector
} from '@shared/albumActionContracts';
import { emitWithBoundedAck, type BoundedAckSocket } from '$lib/socket/emit';
import { createSecureOpaqueId } from '$lib/secureOpaqueId';

export type AlbumActionPhase =
	| 'idle'
	| 'resolving'
	| 'choosing'
	| 'executing'
	| 'executed'
	| 'failed'
	| 'canceled'
	| 'outcome-unknown';

export interface AlbumActionState {
	readonly phase: AlbumActionPhase;
	readonly pageId: string | null;
	readonly versionId: string | null;
	readonly zoneId: string | null;
	readonly generation: number | null;
	readonly requestId: string | null;
	readonly operationId: string | null;
	/** Server timestamp retained only as correlation evidence. */
	readonly resolvingDeadlineAt: number | null;
	/** Server timestamp retained only as correlation evidence. */
	readonly choosingDeadlineAt: number | null;
	readonly actions: readonly AlbumActionChoice[];
	readonly selectedActionId: string | null;
	readonly code: string | null;
	readonly error: string | null;
	readonly transitionedAt: number;
}

export interface AlbumActionBeginInput {
	readonly pageId: string;
	readonly versionId: string;
	readonly zoneId: string;
	readonly tabId: string;
	/** Generation from the current live browse session. */
	readonly generation: number;
	/** Optional track scope; the server verifies index and title together. */
	readonly track?: AlbumActionTrackSelector;
	/**
	 * Optional client-only intent. It is never sent as server authority; the
	 * controller waits for the server's opaque choices and executes only one
	 * exact semantic match.
	 */
	readonly desiredSemantic?: AlbumActionSemantic;
}

export type AlbumActionBeginResult =
	| { readonly started: true; readonly requestId: string }
	| {
			readonly started: false;
			readonly reason: 'busy' | 'disposed' | 'invalid' | 'not-connected';
	  };

export interface AlbumActionSocket extends BoundedAckSocket {
	readonly connected: boolean;
	on(event: string, handler: (value: unknown) => void): unknown;
	off(event: string, handler: (value: unknown) => void): unknown;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface AlbumActionControllerDependencies {
	readonly getSocket: () => AlbumActionSocket | null;
	readonly createRequestId?: () => string;
	readonly now?: () => number;
	readonly setTimer?: (callback: () => void, milliseconds: number) => TimerHandle;
	readonly clearTimer?: (timer: TimerHandle) => void;
	readonly ackTimeoutMs?: number;
	readonly resolvingTimeoutMs?: number;
	readonly choosingTimeoutMs?: number;
	readonly executeAckTimeoutMs?: number;
}

type ActivePhase = 'resolving' | 'choosing' | 'executing';

interface ActiveAttempt {
	readonly request: AlbumActionBeginRequest;
	readonly socket: AlbumActionSocket;
	readonly desiredSemantic: AlbumActionSemantic | null;
	phase: ActivePhase;
	ackSettled: boolean;
	operationId: string | null;
	resolvingDeadlineAt: number | null;
	choosingDeadlineAt: number | null;
	actions: readonly AlbumActionChoice[];
	timer: TimerHandle | null;
	listenersAttached: boolean;
	readonly resolved: (value: unknown) => void;
	readonly failed: (value: unknown) => void;
}

const ACK_TIMEOUT_MS = 5_000;
const RESOLVING_TIMEOUT_MS = 30_000;
const CHOOSING_TIMEOUT_MS = 30_000;
const EXECUTE_ACK_TIMEOUT_MS = 35_000;

function boundedDuration(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > 5 * 60_000) {
		throw new RangeError(`${label} must be a positive bounded integer`);
	}
	return value;
}

function frozenActions(actions: readonly AlbumActionChoice[]): readonly AlbumActionChoice[] {
	return Object.freeze(actions.map((action) => Object.freeze({ ...action })));
}

/**
 * DOM-independent client state machine for the two-phase album-action
 * lease. Server deadline timestamps are correlation evidence; local bounded
 * timers deliberately start at acknowledgment/event publication so browser and
 * server clocks never need to agree.
 */
export class AlbumActionController {
	readonly #getSocket: () => AlbumActionSocket | null;
	readonly #createRequestId: () => string;
	readonly #now: () => number;
	readonly #setTimer: (callback: () => void, milliseconds: number) => TimerHandle;
	readonly #clearTimer: (timer: TimerHandle) => void;
	readonly #ackTimeoutMs: number;
	readonly #resolvingTimeoutMs: number;
	readonly #choosingTimeoutMs: number;
	readonly #executeAckTimeoutMs: number;
	readonly #subscribers = new Set<(state: AlbumActionState) => void>();

	#state: AlbumActionState;
	#attempt: ActiveAttempt | null = null;
	#disposed = false;

	constructor(dependencies: AlbumActionControllerDependencies) {
		this.#getSocket = dependencies.getSocket;
		this.#createRequestId = dependencies.createRequestId ?? createSecureOpaqueId;
		this.#now = dependencies.now ?? Date.now;
		this.#setTimer = dependencies.setTimer ?? setTimeout;
		this.#clearTimer = dependencies.clearTimer ?? clearTimeout;
		this.#ackTimeoutMs = boundedDuration(
			dependencies.ackTimeoutMs ?? ACK_TIMEOUT_MS,
			'ackTimeoutMs'
		);
		this.#resolvingTimeoutMs = boundedDuration(
			dependencies.resolvingTimeoutMs ?? RESOLVING_TIMEOUT_MS,
			'resolvingTimeoutMs'
		);
		this.#choosingTimeoutMs = boundedDuration(
			dependencies.choosingTimeoutMs ?? CHOOSING_TIMEOUT_MS,
			'choosingTimeoutMs'
		);
		this.#executeAckTimeoutMs = boundedDuration(
			dependencies.executeAckTimeoutMs ?? EXECUTE_ACK_TIMEOUT_MS,
			'executeAckTimeoutMs'
		);
		this.#state = this.#idleState();
	}

	subscribe(run: (state: AlbumActionState) => void): () => void {
		this.#subscribers.add(run);
		run(this.#state);
		return () => this.#subscribers.delete(run);
	}

	snapshot(): AlbumActionState {
		return this.#state;
	}

	begin(input: AlbumActionBeginInput): AlbumActionBeginResult {
		if (this.#disposed) return { started: false, reason: 'disposed' };
		if (this.#attempt?.phase === 'executing') return { started: false, reason: 'busy' };
		if (this.#attempt) this.#cancelAttempt(this.#attempt, 'SUPERSEDED', 'Album action superseded');

		const socket = this.#getSocket();
		if (!socket?.connected) {
			this.#publishTerminal('failed', null, 'NOT_CONNECTED', 'Roon is not connected');
			return { started: false, reason: 'not-connected' };
		}

		let requestId: string;
		try {
			requestId = this.#createRequestId();
		} catch {
			this.#publishTerminal(
				'failed',
				null,
				'INVALID_REQUEST',
				'Secure album-action identity is unavailable'
			);
			return { started: false, reason: 'invalid' };
		}
		const { desiredSemantic = null, ...wireInput } = input;
		const request = normalizeAlbumActionBeginRequest({ requestId, ...wireInput });
		if (!request) {
			this.#publishTerminal(
				'failed',
				null,
				'INVALID_REQUEST',
				'The album action request is invalid'
			);
			return { started: false, reason: 'invalid' };
		}

		let attempt!: ActiveAttempt;
		attempt = {
			request,
			socket,
			desiredSemantic,
			phase: 'resolving',
			ackSettled: false,
			operationId: null,
			resolvingDeadlineAt: null,
			choosingDeadlineAt: null,
			actions: Object.freeze([]),
			timer: null,
			listenersAttached: false,
			resolved: (value) => this.#handleResolved(attempt, value),
			failed: (value) => this.#handleFailed(attempt, value)
		};
		this.#attempt = attempt;
		this.#attachListeners(attempt);
		this.#publish({
			phase: 'resolving',
			pageId: request.pageId,
			versionId: request.versionId,
			zoneId: request.zoneId,
			generation: request.generation,
			requestId: request.requestId,
			operationId: null,
			resolvingDeadlineAt: null,
			choosingDeadlineAt: null,
			actions: Object.freeze([]),
			selectedActionId: null,
			code: null,
			error: null
		});
		this.#armTimer(attempt, this.#ackTimeoutMs, () => this.#handleBeginTimeout(attempt));

		try {
			emitWithBoundedAck(socket, 'album-action:begin', request, this.#ackTimeoutMs, (result) => {
				if (!result.acknowledged) {
					this.#handleBeginTimeout(attempt);
					return;
				}
				this.#handleBeginAck(attempt, result.value);
			});
		} catch {
			this.#finish(attempt, 'failed', 'BEGIN_FAILED', 'Album action could not be sent');
			this.#emitCancel(attempt);
			return { started: false, reason: 'not-connected' };
		}
		return { started: true, requestId: request.requestId };
	}

	cancel(): boolean {
		const attempt = this.#attempt;
		if (!attempt || (attempt.phase !== 'resolving' && attempt.phase !== 'choosing')) return false;
		this.#cancelAttempt(attempt, 'CANCELED', 'Album action canceled');
		return true;
	}

	execute(actionId: string): boolean {
		const attempt = this.#attempt;
		if (!attempt || attempt.phase !== 'choosing') return false;
		const choice = attempt.actions.find((candidate) => candidate.actionId === actionId);
		const request = normalizeAlbumActionExecuteRequest({ actionId });
		if (!choice || !request) return false;

		// Claim locally before emitting. A double click or sibling click observes
		// executing synchronously and cannot send a second command.
		attempt.phase = 'executing';
		attempt.actions = Object.freeze([]);
		this.#clearAttemptTimer(attempt);
		this.#detachListeners(attempt);
		this.#publish({
			phase: 'executing',
			actions: Object.freeze([]),
			selectedActionId: choice.actionId,
			code: null,
			error: null
		});

		if (!attempt.socket.connected) {
			this.#finish(attempt, 'failed', 'NOT_CONNECTED', 'Roon disconnected before execution');
			return true;
		}
		this.#armTimer(attempt, this.#executeAckTimeoutMs, () =>
			this.#handleExecuteTimeout(attempt)
		);
		try {
			emitWithBoundedAck(
				attempt.socket,
				'album-action:execute',
				request,
				this.#executeAckTimeoutMs,
				(result) => {
					if (!result.acknowledged) {
						this.#handleExecuteTimeout(attempt);
						return;
					}
					this.#handleExecuteAck(attempt, result.value);
				}
			);
		} catch {
			this.#finish(
				attempt,
				'outcome-unknown',
				'EXECUTE_FAILED',
				'The album action outcome is unknown; it will not be retried'
			);
		}
		return true;
	}

	/**
	 * Resolving/choosing authority is canceled. An already claimed execute is
	 * never canceled; local observation ends as outcome unknown instead.
	 */
	quiesce(): void {
		const attempt = this.#attempt;
		if (!attempt) return;
		if (attempt.phase === 'resolving' || attempt.phase === 'choosing') {
			this.#cancelAttempt(attempt, 'QUIESCED', 'Album action canceled while the surface quiesced');
			return;
		}
		this.#finish(
			attempt,
			'outcome-unknown',
			'EXECUTION_UNOBSERVED',
			'Execution remains server-owned after the surface quiesced'
		);
	}

	reset(): boolean {
		if (this.#attempt || this.#disposed) return false;
		this.#state = this.#idleState();
		this.#notify();
		return true;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.quiesce();
		this.#disposed = true;
		this.#subscribers.clear();
	}

	#handleBeginTimeout(attempt: ActiveAttempt): void {
		if (!this.#isCurrent(attempt, 'resolving') || attempt.ackSettled) return;
		this.#finish(attempt, 'failed', 'BEGIN_TIMEOUT', 'Album action was not acknowledged');
		this.#emitCancel(attempt);
	}

	#handleBeginAck(attempt: ActiveAttempt, value: unknown): void {
		if (!this.#isCurrent(attempt, 'resolving') || attempt.ackSettled) return;
		attempt.ackSettled = true;
		this.#clearAttemptTimer(attempt);
		const ack = normalizeAlbumActionBeginAck(value, attempt.request.requestId);
		if (!ack) {
			this.#finish(
				attempt,
				'failed',
				'MALFORMED_BEGIN_ACK',
				'The album-action acknowledgment was invalid'
			);
			this.#emitCancel(attempt);
			return;
		}
		if (!ack.success) {
			this.#finish(attempt, 'failed', ack.code, ack.error);
			return;
		}
		attempt.operationId = ack.data.operationId;
		attempt.resolvingDeadlineAt = ack.data.resolvingDeadlineAt;
		this.#publish({
			operationId: ack.data.operationId,
			resolvingDeadlineAt: ack.data.resolvingDeadlineAt
		});
		this.#armTimer(attempt, this.#resolvingTimeoutMs, () => {
			if (!this.#isCurrent(attempt, 'resolving')) return;
			this.#finish(
				attempt,
				'failed',
				'RESOLUTION_TIMEOUT',
				'Album action resolution timed out'
			);
			this.#emitCancel(attempt);
		});
	}

	#handleResolved(attempt: ActiveAttempt, value: unknown): void {
		const correlation = this.#correlation(attempt);
		if (!this.#isCurrent(attempt, 'resolving') || !correlation) return;
		const event = normalizeAlbumActionResolvedEvent(value, correlation);
		if (!event) return;
		this.#clearAttemptTimer(attempt);
		const actions = frozenActions(event.actions);
		if (attempt.desiredSemantic !== null) {
			const matches = actions.filter(
				(choice) => choice.semantic === attempt.desiredSemantic
			);
			if (matches.length !== 1) {
				const missing = matches.length === 0;
				this.#finish(
					attempt,
					'failed',
					missing ? 'DESIRED_SEMANTIC_MISSING' : 'DESIRED_SEMANTIC_AMBIGUOUS',
					missing
						? `The requested ${attempt.desiredSemantic} action is unavailable`
						: `The requested ${attempt.desiredSemantic} action is ambiguous`
				);
				this.#emitCancel(attempt);
				return;
			}
			// The server remains authoritative: only its one-use opaque action ID
			// crosses the execute boundary. The client semantic is discarded here.
			attempt.phase = 'choosing';
			attempt.choosingDeadlineAt = event.choosingDeadlineAt;
			attempt.actions = actions;
			if (!this.execute(matches[0].actionId)) {
				this.#finish(
					attempt,
					'failed',
					'DESIRED_SEMANTIC_UNAVAILABLE',
					'The requested album action could not be claimed'
				);
				this.#emitCancel(attempt);
			}
			return;
		}
		attempt.phase = 'choosing';
		attempt.choosingDeadlineAt = event.choosingDeadlineAt;
		attempt.actions = actions;
		this.#publish({
			phase: 'choosing',
			choosingDeadlineAt: event.choosingDeadlineAt,
			actions: attempt.actions,
			selectedActionId: null,
			code: null,
			error: null
		});
		this.#armTimer(attempt, this.#choosingTimeoutMs, () => {
			if (!this.#isCurrent(attempt, 'choosing')) return;
			this.#finish(attempt, 'failed', 'CHOOSER_EXPIRED', 'Album action choices expired');
			this.#emitCancel(attempt);
		});
	}

	#handleFailed(attempt: ActiveAttempt, value: unknown): void {
		if (!this.#isCurrent(attempt) || attempt.phase === 'executing') return;
		const correlation = this.#correlation(attempt);
		if (!correlation) return;
		const event = normalizeAlbumActionFailedEvent(value, correlation);
		if (!event) return;
		this.#finish(attempt, 'failed', event.code, event.error);
	}

	#handleExecuteAck(attempt: ActiveAttempt, value: unknown): void {
		if (!this.#isCurrent(attempt, 'executing')) return;
		const ack = normalizeAlbumActionExecuteAck(value);
		if (!ack) {
			this.#finish(
				attempt,
				'outcome-unknown',
				'MALFORMED_EXECUTE_ACK',
				'The album action outcome is unknown; it will not be retried'
			);
			return;
		}
		if (!ack.success) {
			this.#finish(attempt, 'failed', ack.code, ack.error);
			return;
		}
		if (!ack.data.claimed) {
			this.#finish(attempt, 'failed', 'ACTION_NOT_CLAIMED', 'The album action was no longer available');
			return;
		}
		if (ack.data.outcome === 'executed') {
			this.#finish(attempt, 'executed', null, null);
			return;
		}
		if (ack.data.outcome === 'rejected') {
			this.#finish(attempt, 'failed', ack.data.code, ack.data.error);
			return;
		}
		this.#finish(attempt, 'outcome-unknown', 'OUTCOME_UNKNOWN', ack.data.error);
	}

	#handleExecuteTimeout(attempt: ActiveAttempt): void {
		if (!this.#isCurrent(attempt, 'executing')) return;
		this.#finish(
			attempt,
			'outcome-unknown',
			'EXECUTE_TIMEOUT',
			'The album action outcome is unknown; it will not be retried'
		);
	}

	#correlation(attempt: ActiveAttempt): AlbumActionResolutionCorrelation | null {
		return attempt.operationId && attempt.resolvingDeadlineAt
			? {
					requestId: attempt.request.requestId,
					operationId: attempt.operationId,
					generation: attempt.request.generation,
					resolvingDeadlineAt: attempt.resolvingDeadlineAt
			  }
			: null;
	}

	#cancelAttempt(attempt: ActiveAttempt, code: string, error: string): void {
		if (!this.#isCurrent(attempt) || attempt.phase === 'executing') return;
		this.#finish(attempt, 'canceled', code, error);
		this.#emitCancel(attempt);
	}

	#emitCancel(attempt: ActiveAttempt): void {
		if (!attempt.socket.connected) return;
		const request = normalizeAlbumActionCancelRequest(
			attempt.operationId
				? { operationId: attempt.operationId }
				: { requestId: attempt.request.requestId }
		);
		if (!request) return;
		try {
			emitWithBoundedAck(
				attempt.socket,
				'album-action:cancel',
				request,
				this.#ackTimeoutMs,
				(result) => {
					if (result.acknowledged) normalizeAlbumActionCancelAck(result.value);
				}
			);
		} catch {
			// Local authority is still invalidated. Disconnect cleanup and the server
			// phase deadline remain the correctness backstops.
		}
	}

	#finish(
		attempt: ActiveAttempt,
		phase: Extract<AlbumActionPhase, 'executed' | 'failed' | 'canceled' | 'outcome-unknown'>,
		code: string | null,
		error: string | null
	): void {
		if (!this.#isCurrent(attempt)) return;
		this.#clearAttemptTimer(attempt);
		this.#detachListeners(attempt);
		this.#attempt = null;
		this.#publish({
			phase,
			actions: Object.freeze([]),
			code,
			error
		});
	}

	#publishTerminal(
		phase: Extract<AlbumActionPhase, 'failed' | 'canceled' | 'outcome-unknown'>,
		selectedActionId: string | null,
		code: string,
		error: string
	): void {
		this.#publish({
			phase,
			pageId: null,
			versionId: null,
			zoneId: null,
			generation: null,
			requestId: null,
			operationId: null,
			resolvingDeadlineAt: null,
			choosingDeadlineAt: null,
			actions: Object.freeze([]),
			selectedActionId,
			code,
			error
		});
	}

	#attachListeners(attempt: ActiveAttempt): void {
		if (attempt.listenersAttached) return;
		attempt.listenersAttached = true;
		attempt.socket.on('album-action:resolved', attempt.resolved);
		attempt.socket.on('album-action:failed', attempt.failed);
	}

	#detachListeners(attempt: ActiveAttempt): void {
		if (!attempt.listenersAttached) return;
		attempt.listenersAttached = false;
		attempt.socket.off('album-action:resolved', attempt.resolved);
		attempt.socket.off('album-action:failed', attempt.failed);
	}

	#armTimer(attempt: ActiveAttempt, milliseconds: number, callback: () => void): void {
		this.#clearAttemptTimer(attempt);
		const setTimer = this.#setTimer;
		attempt.timer = setTimer(() => {
			attempt.timer = null;
			callback();
		}, milliseconds);
	}

	#clearAttemptTimer(attempt: ActiveAttempt): void {
		if (attempt.timer === null) return;
		const clearTimer = this.#clearTimer;
		clearTimer(attempt.timer);
		attempt.timer = null;
	}

	#isCurrent(attempt: ActiveAttempt, phase?: ActivePhase): boolean {
		return this.#attempt === attempt && (phase === undefined || attempt.phase === phase);
	}

	#idleState(): AlbumActionState {
		return Object.freeze({
			phase: 'idle',
			pageId: null,
			versionId: null,
			zoneId: null,
			generation: null,
			requestId: null,
			operationId: null,
			resolvingDeadlineAt: null,
			choosingDeadlineAt: null,
			actions: Object.freeze([]),
			selectedActionId: null,
			code: null,
			error: null,
			transitionedAt: this.#now()
		});
	}

	#publish(values: Partial<AlbumActionState>): void {
		this.#state = Object.freeze({
			...this.#state,
			...values,
			transitionedAt: this.#now()
		});
		this.#notify();
	}

	#notify(): void {
		for (const subscriber of this.#subscribers) subscriber(this.#state);
	}
}
