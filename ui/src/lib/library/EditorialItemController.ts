import {
	normalizeEditorialItemFailedEvent,
	normalizeEditorialItemOpenAck,
	normalizeEditorialItemReadyEvent,
	type EditorialFailureCode,
	type EditorialItemAnchor,
	type EditorialItemView,
	type EditorialProseSectionName
} from '@shared/editorialItemContracts';
import {
	emitWithBoundedAck,
	type BoundedAckResult,
	type BoundedAckSocket
} from '$lib/socket/emit';
import { createSecureOpaqueId } from '$lib/secureOpaqueId';

/**
 * Client side of the editorial item session (rich-item plan §5.3). One
 * controller instance follows one item page: open binds a session to the
 * page's anchor and generation, ready/failed events are accepted only with
 * the exact expected correlation, and cancel/disconnect retire everything.
 *
 * The controller supplies OPTIONAL page sections only. It never decides
 * whether the page exists and never carries action authority; a
 * FEATURE_UNAVAILABLE answer leaves the state 'unavailable' and the page
 * renders no editorial surface at all (no placeholder, no teaser).
 */
export type EditorialItemPhase =
	| 'idle'
	| 'opening'
	| 'ready'
	| 'failed'
	| 'unavailable'
	| 'canceled';

export interface EditorialItemState {
	readonly phase: EditorialItemPhase;
	readonly requestId: string | null;
	readonly sessionId: string | null;
	readonly generation: number | null;
	readonly view: EditorialItemView | null;
	readonly code: EditorialFailureCode | null;
	readonly section: EditorialProseSectionName | null;
	readonly retryable: boolean;
	readonly error: string | null;
}

export interface EditorialItemOpenInput {
	readonly anchor: EditorialItemAnchor;
	readonly tabId: string;
	readonly generation: number;
}

export interface EditorialItemFollowInput {
	readonly target: string;
	readonly tabId: string;
	readonly generation: number;
}

export interface EditorialItemSocket extends BoundedAckSocket {
	readonly connected: boolean;
	on(event: string, handler: (value: unknown) => void): unknown;
	off(event: string, handler: (value: unknown) => void): unknown;
	emit(event: string, payload: unknown): unknown;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface EditorialItemControllerDependencies {
	readonly getSocket: () => EditorialItemSocket | null;
	readonly createRequestId?: () => string;
	readonly ackTimeoutMs?: number;
	/** Watchdog for a lost terminal event after a successful ack (ri2-2). */
	readonly readTimeoutMs?: number;
	readonly setTimer?: (callback: () => void, milliseconds: number) => TimerHandle;
	readonly clearTimer?: (timer: TimerHandle) => void;
}

const ACK_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 40_000;

const IDLE_STATE: EditorialItemState = Object.freeze({
	phase: 'idle',
	requestId: null,
	sessionId: null,
	generation: null,
	view: null,
	code: null,
	section: null,
	retryable: false,
	error: null
});

type Subscriber = (state: EditorialItemState) => void;

interface ActiveSession {
	/** Mutable: a follow moves the expected correlation to its request. */
	requestId: string;
	readonly sessionId: string;
	readonly socket: EditorialItemSocket;
	readonly tabId: string;
	listenersAttached: boolean;
	watchdog: TimerHandle | null;
	readonly ready: (value: unknown) => void;
	readonly failed: (value: unknown) => void;
	readonly disconnected: () => void;
}

export class EditorialItemController {
	private readonly deps: EditorialItemControllerDependencies;
	private state: EditorialItemState = IDLE_STATE;
	private readonly subscribers = new Set<Subscriber>();
	private active: ActiveSession | null = null;

	public constructor(deps: EditorialItemControllerDependencies) {
		this.deps = deps;
	}

	public subscribe(run: Subscriber): () => void {
		this.subscribers.add(run);
		run(this.state);
		return () => {
			this.subscribers.delete(run);
		};
	}

	public async open(input: EditorialItemOpenInput): Promise<boolean> {
		this.retireActive();
		const socket = this.deps.getSocket();
		if (!socket || !socket.connected) {
			// No transport is not an editorial failure: stay idle so the page
			// simply renders without an editorial surface.
			this.publish(IDLE_STATE);
			return false;
		}
		const requestId = (this.deps.createRequestId ?? createSecureOpaqueId)();
		this.publish({
			...IDLE_STATE,
			phase: 'opening',
			requestId,
			generation: input.generation
		});
		const outcome = await new Promise<BoundedAckResult>((resolve) =>
			emitWithBoundedAck(
				socket,
				'item-editorial:open',
				{
					requestId,
					tabId: input.tabId,
					generation: input.generation,
					anchor: input.anchor
				},
				this.deps.ackTimeoutMs ?? ACK_TIMEOUT_MS,
				resolve
			)
		);
		if (this.state.requestId !== requestId || this.state.phase !== 'opening') {
			// Superseded while awaiting the ack: a successful late ack still
			// created a server session nobody owns — cancel it rather than
			// leaving it to idle expiry (ri2-3).
			if (outcome.acknowledged) {
				const late = normalizeEditorialItemOpenAck(outcome.value, requestId);
				if (late?.ok) {
					try {
						socket.emit('item-editorial:cancel', {
							sessionId: late.data.sessionId,
							tabId: input.tabId
						});
					} catch {
						// Best-effort; the server's idle expiry remains the backstop.
					}
				}
			}
			return false;
		}
		if (!outcome.acknowledged) {
			this.publish({
				...IDLE_STATE,
				phase: 'failed',
				requestId,
				generation: input.generation,
				code: 'SESSION_LOST',
				retryable: true,
				error: 'The editorial request was not acknowledged.'
			});
			return false;
		}
		const ack = normalizeEditorialItemOpenAck(outcome.value, requestId);
		if (!ack) {
			this.publish({
				...IDLE_STATE,
				phase: 'failed',
				requestId,
				generation: input.generation,
				code: 'INVALID_RESPONSE',
				retryable: false,
				error: 'The editorial acknowledgment violated the contract.'
			});
			return false;
		}
		if (!ack.ok) {
			this.publish({
				...IDLE_STATE,
				phase: ack.code === 'FEATURE_UNAVAILABLE' ? 'unavailable' : 'failed',
				requestId,
				generation: input.generation,
				code: ack.code,
				retryable: ack.code === 'READ_TIMEOUT' || ack.code === 'BACKPRESSURE',
				error: ack.error
			});
			return false;
		}
		this.attachSession(socket, requestId, ack.data.sessionId, input);
		return true;
	}

	public async follow(input: EditorialItemFollowInput): Promise<boolean> {
		const current = this.active;
		if (!current || this.state.sessionId === null) return false;
		const socket = current.socket;
		const requestId = (this.deps.createRequestId ?? createSecureOpaqueId)();
		const previous = this.state;
		this.publish({
			...previous,
			phase: 'opening',
			requestId,
			view: null,
			code: null,
			section: null,
			retryable: false,
			error: null
		});
		const outcome = await new Promise<BoundedAckResult>((resolve) =>
			emitWithBoundedAck(
				socket,
				'item-editorial:follow',
				{
					requestId,
					tabId: input.tabId,
					generation: input.generation,
					sessionId: current.sessionId,
					target: input.target
				},
				this.deps.ackTimeoutMs ?? ACK_TIMEOUT_MS,
				resolve
			)
		);
		if (this.state.requestId !== requestId || this.active !== current) {
			return false;
		}
		if (!outcome.acknowledged) {
			this.publish({
				...this.state,
				phase: 'failed',
				code: 'SESSION_LOST',
				retryable: true,
				error: 'The editorial request was not acknowledged.'
			});
			return false;
		}
		const ack = normalizeEditorialItemOpenAck(outcome.value, requestId);
		if (!ack) {
			this.publish({
				...this.state,
				phase: 'failed',
				code: 'INVALID_RESPONSE',
				retryable: false,
				error: 'The editorial acknowledgment violated the contract.'
			});
			return false;
		}
		if (!ack.ok) {
			this.publish({
				...this.state,
				phase: ack.code === 'FEATURE_UNAVAILABLE' ? 'unavailable' : 'failed',
				code: ack.code,
				retryable: ack.code === 'READ_TIMEOUT' || ack.code === 'BACKPRESSURE',
				error: ack.error
			});
			return false;
		}
		// The follow rides the same session; the expected correlation moves
		// to its request and the state carries the destination page
		// generation the session was atomically rebound to (ri2-4).
		current.requestId = requestId;
		this.armWatchdog(current);
		this.publish({ ...this.state, generation: input.generation });
		return true;
	}

	public cancel(): void {
		const current = this.active;
		if (current) {
			try {
				current.socket.emit('item-editorial:cancel', {
					sessionId: current.sessionId,
					tabId: current.tabId
				});
			} catch {
				// Cancellation is best-effort; retirement below is what matters.
			}
		}
		this.retireActive();
		if (this.state.phase !== 'idle') {
			this.publish({ ...IDLE_STATE, phase: 'canceled' });
		}
	}

	public reset(): void {
		this.retireActive();
		this.publish(IDLE_STATE);
	}

	private attachSession(
		socket: EditorialItemSocket,
		requestId: string,
		sessionId: string,
		input: EditorialItemOpenInput
	): void {
		const session: ActiveSession = {
			requestId,
			sessionId,
			socket,
			tabId: input.tabId,
			listenersAttached: false,
			watchdog: null,
			ready: (value: unknown) => {
				const event = normalizeEditorialItemReadyEvent(value, {
					requestId: session.requestId,
					sessionId: session.sessionId
				});
				if (!event || this.active !== session) return;
				this.clearWatchdog(session);
				this.publish({
					...this.state,
					phase: 'ready',
					sessionId: session.sessionId,
					view: event.view,
					code: null,
					section: null,
					retryable: false,
					error: null
				});
			},
			failed: (value: unknown) => {
				const event = normalizeEditorialItemFailedEvent(value, {
					requestId: session.requestId,
					sessionId: session.sessionId
				});
				if (!event || this.active !== session) return;
				this.clearWatchdog(session);
				this.publish({
					...this.state,
					phase: event.code === 'FEATURE_UNAVAILABLE' ? 'unavailable' : 'failed',
					sessionId: session.sessionId,
					code: event.code,
					section: event.section,
					retryable: event.retryable,
					error: event.error
				});
			},
			disconnected: () => {
				if (this.active !== session) return;
				this.retireActive();
				this.publish({
					...IDLE_STATE,
					phase: 'failed',
					code: 'SESSION_LOST',
					retryable: true,
					error: 'The connection to the server was lost.'
				});
			}
		};
		socket.on('item-editorial:ready', session.ready);
		socket.on('item-editorial:failed', session.failed);
		socket.on('disconnect', session.disconnected);
		session.listenersAttached = true;
		this.active = session;
		this.armWatchdog(session);
		this.publish({
			...this.state,
			phase: 'opening',
			requestId,
			sessionId
		});
	}

	/**
	 * A lost terminal event must not strand the page in 'opening' (ri2-2):
	 * the watchdog turns silence after a successful ack into a retryable
	 * READ_TIMEOUT. Cleared by ready, failed, cancel, supersession, and
	 * disconnect.
	 */
	private armWatchdog(session: ActiveSession): void {
		this.clearWatchdog(session);
		const setTimer = this.deps.setTimer ?? setTimeout;
		session.watchdog = setTimer(() => {
			if (this.active !== session || this.state.phase !== 'opening') return;
			this.publish({
				...this.state,
				phase: 'failed',
				code: 'READ_TIMEOUT',
				section: null,
				retryable: true,
				error: 'The editorial read did not answer in time.'
			});
		}, this.deps.readTimeoutMs ?? READ_TIMEOUT_MS);
	}

	private clearWatchdog(session: ActiveSession): void {
		if (session.watchdog === null) return;
		(this.deps.clearTimer ?? clearTimeout)(session.watchdog);
		session.watchdog = null;
	}

	private retireActive(): void {
		const current = this.active;
		if (!current) return;
		this.active = null;
		this.clearWatchdog(current);
		if (current.listenersAttached) {
			current.socket.off('item-editorial:ready', current.ready);
			current.socket.off('item-editorial:failed', current.failed);
			current.socket.off('disconnect', current.disconnected);
		}
	}

	private publish(next: EditorialItemState): void {
		this.state = Object.freeze(next);
		for (const run of [...this.subscribers]) {
			run(this.state);
		}
	}
}
