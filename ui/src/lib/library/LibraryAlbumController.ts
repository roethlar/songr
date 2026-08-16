import {
	normalizeLibraryAlbumFailedEvent,
	normalizeLibraryAlbumOpenAck,
	normalizeLibraryAlbumOpenRequest,
	normalizeLibraryAlbumResolvedEvent,
	normalizeLibraryAlbumSelectAck,
	normalizeLibraryAlbumSelectRequest,
	normalizeLibraryAlbumVersionFailedEvent,
	normalizeLibraryAlbumVersionsEvent,
	type LibraryAlbumCorrelation,
	type LibraryAlbumOpenRequest,
	type LibraryAlbumTrack,
	type LibraryAlbumVersionSummary
} from '@shared/libraryAlbumContracts';
import { emitWithBoundedAck, type BoundedAckSocket } from '$lib/socket/emit';
import { createSecureOpaqueId } from '$lib/secureOpaqueId';

export type LibraryAlbumPhase =
	| 'idle'
	| 'opening'
	| 'versions'
	| 'loading-detail'
	| 'details'
	| 'failed'
	| 'canceled';

export type LibraryAlbumTab = 'versions' | 'details';
export type LibraryAlbumVersionPhase = 'idle' | 'loading' | 'loaded' | 'failed';

export type LibraryAlbumVersionState = Omit<LibraryAlbumVersionSummary, 'trackCount'> & {
	readonly phase: LibraryAlbumVersionPhase;
	readonly trackCount: number | null;
	readonly code: string | null;
	readonly error: string | null;
};

export interface LibraryAlbumState {
	readonly phase: LibraryAlbumPhase;
	readonly activeTab: LibraryAlbumTab;
	readonly albumLocalId: string | null;
	readonly generation: number | null;
	readonly requestId: string | null;
	readonly operationId: string | null;
	/** Server timestamp retained only as correlation evidence. */
	readonly resolvingDeadlineAt: number | null;
	readonly artist: string | null;
	readonly title: string | null;
	readonly versions: readonly LibraryAlbumVersionState[];
	readonly selectedVersionId: string | null;
	readonly actionsAvailable: boolean;
	readonly orderedTracks: readonly LibraryAlbumTrack[];
	readonly code: string | null;
	readonly error: string | null;
	readonly transitionedAt: number;
}

export interface LibraryAlbumOpenInput {
	readonly albumLocalId: string;
	readonly tabId: string;
	/** Generation from the live unified session claim. */
	readonly generation: number;
}

export type LibraryAlbumOpenResult =
	| { readonly started: true; readonly requestId: string }
	| { readonly started: false; readonly reason: 'disposed' | 'invalid' | 'not-connected' };

export type LibraryAlbumSelectResult =
	| { readonly started: true; readonly versionId: string }
	| { readonly started: false; readonly reason: 'disposed' | 'invalid' | 'not-ready' };

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

interface ActivePage {
	readonly request: LibraryAlbumOpenRequest;
	readonly socket: LibraryAlbumSocket;
	openAckSettled: boolean;
	operationId: string | null;
	openDeadlineAt: number | null;
	selectVersionId: string | null;
	selectDeadlineAt: number | null;
	timer: TimerHandle | null;
	listenersAttached: boolean;
	readonly versions: (value: unknown) => void;
	readonly resolved: (value: unknown) => void;
	readonly versionFailed: (value: unknown) => void;
	readonly failed: (value: unknown) => void;
	readonly disconnected: () => void;
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

function frozenVersions(
	versions: readonly LibraryAlbumVersionState[]
): readonly LibraryAlbumVersionState[] {
	return Object.freeze(versions.map((version) => Object.freeze({ ...version })));
}

function initialVersion(summary: LibraryAlbumVersionSummary): LibraryAlbumVersionState {
	return Object.freeze({
		...summary,
		phase: 'idle',
		trackCount: summary.trackCount ?? null,
		code: null,
		error: null
	});
}

/** DOM-independent retained album-page client state machine. */
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
	#page: ActivePage | null = null;
	#disposed = false;

	public constructor(dependencies: LibraryAlbumControllerDependencies) {
		this.#getSocket = dependencies.getSocket;
		this.#createRequestId = dependencies.createRequestId ?? (() => createSecureOpaqueId());
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
		return () => this.#subscribers.delete(run);
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
			generation: input.generation
		});
		if (!request) return { started: false, reason: 'invalid' };
		const socket = this.#getSocket();
		if (!socket || !socket.connected) return { started: false, reason: 'not-connected' };

		this.#retirePage(true);
		const page: ActivePage = {
			request,
			socket,
			openAckSettled: false,
			operationId: null,
			openDeadlineAt: null,
			selectVersionId: null,
			selectDeadlineAt: null,
			timer: null,
			listenersAttached: false,
			versions: (value) => this.#handleVersions(page, value),
			resolved: (value) => this.#handleResolved(page, value),
			versionFailed: (value) => this.#handleVersionFailed(page, value),
			failed: (value) => this.#handleFailed(page, value),
			disconnected: () => this.#handleDisconnect(page)
		};
		this.#page = page;
		this.#attachListeners(page);
		this.#publish({
			...this.#idleState(),
			phase: 'opening',
			albumLocalId: request.albumLocalId,
			generation: request.generation,
			requestId: request.requestId
		});
		this.#armTimer(page, this.#ackTimeoutMs, () => this.#handleOpenAckTimeout(page));
		try {
			emitWithBoundedAck(socket, 'library-album:open', request, this.#ackTimeoutMs, (result) =>
				this.#handleOpenAck(page, result.acknowledged ? result.value : null)
			);
		} catch {
			this.#failPage(page, 'OPEN_FAILED', 'The album page request could not be sent');
		}
		return { started: true, requestId };
	}

	public select(versionId: string): LibraryAlbumSelectResult {
		if (this.#disposed) return { started: false, reason: 'disposed' };
		const page = this.#page;
		if (
			!page ||
			page.operationId === null ||
			!this.#state.versions.some((version) => version.versionId === versionId)
		) {
			return { started: false, reason: 'not-ready' };
		}
		const request = normalizeLibraryAlbumSelectRequest({
			operationId: page.operationId,
			versionId
		});
		if (!request) return { started: false, reason: 'invalid' };

		page.selectVersionId = versionId;
		page.selectDeadlineAt = null;
		this.#publish({
			...this.#state,
			phase: 'loading-detail',
			activeTab: 'details',
			selectedVersionId: versionId,
			actionsAvailable: false,
			orderedTracks: Object.freeze([]) as readonly LibraryAlbumTrack[],
			versions: this.#updateVersion(versionId, {
				phase: 'loading',
				code: null,
				error: null
			}),
			code: null,
			error: null,
			transitionedAt: this.#now()
		});
		this.#armTimer(page, this.#ackTimeoutMs, () => this.#handleSelectAckTimeout(page, versionId));
		try {
			emitWithBoundedAck(
				page.socket,
				'library-album:select',
				request,
				this.#ackTimeoutMs,
				(result) =>
					this.#handleSelectAck(page, versionId, result.acknowledged ? result.value : null)
			);
		} catch {
			this.#failVersion(page, versionId, 'SELECT_FAILED', 'The album version request could not be sent');
		}
		return { started: true, versionId };
	}

	public showVersions(): void {
		if (!this.#page || this.#state.phase === 'opening') return;
		this.#publish({ ...this.#state, activeTab: 'versions', transitionedAt: this.#now() });
	}

	public showDetails(): void {
		if (!this.#page || !this.#state.selectedVersionId) return;
		this.#publish({ ...this.#state, activeTab: 'details', transitionedAt: this.#now() });
	}

	/** Closes the active page, notifying the server best-effort. */
	public cancel(): void {
		const page = this.#page;
		if (!page) return;
		this.#emitCancel(page);
		this.#detachListeners(page);
		this.#clearPageTimer(page);
		this.#page = null;
		this.#publish({
			...this.#state,
			phase: 'canceled',
			code: 'CANCELED',
			error: null,
			transitionedAt: this.#now()
		});
	}

	public reset(): void {
		if (this.#page || this.#disposed || this.#state.phase === 'idle') return;
		this.#publish(this.#idleState());
	}

	public dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#retirePage(true);
		this.#subscribers.clear();
	}

	#idleState(): LibraryAlbumState {
		return Object.freeze({
			phase: 'idle' as const,
			activeTab: 'details' as const,
			albumLocalId: null,
			generation: null,
			requestId: null,
			operationId: null,
			resolvingDeadlineAt: null,
			artist: null,
			title: null,
			versions: Object.freeze([]) as readonly LibraryAlbumVersionState[],
			selectedVersionId: null,
			actionsAvailable: false,
			orderedTracks: Object.freeze([]) as readonly LibraryAlbumTrack[],
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

	#updateVersion(
		versionId: string,
		patch: Partial<LibraryAlbumVersionState>
	): readonly LibraryAlbumVersionState[] {
		return frozenVersions(
			this.#state.versions.map((version) =>
				version.versionId === versionId ? { ...version, ...patch } : version
			)
		);
	}

	#retirePage(emitCancel: boolean): void {
		const page = this.#page;
		if (!page) return;
		if (emitCancel) this.#emitCancel(page);
		this.#detachListeners(page);
		this.#clearPageTimer(page);
		this.#page = null;
	}

	#emitCancel(page: ActivePage): void {
		try {
			page.socket.emit(
				'library-album:cancel',
				page.operationId ? { operationId: page.operationId } : { requestId: page.request.requestId }
			);
		} catch {
			// Best-effort: the server also retires on disconnect and Core loss.
		}
	}

	#attachListeners(page: ActivePage): void {
		if (page.listenersAttached) return;
		page.socket.on('library-album:versions', page.versions);
		page.socket.on('library-album:resolved', page.resolved);
		page.socket.on('library-album:version-failed', page.versionFailed);
		page.socket.on('library-album:failed', page.failed);
		page.socket.on('disconnect', page.disconnected);
		page.listenersAttached = true;
	}

	#detachListeners(page: ActivePage): void {
		if (!page.listenersAttached) return;
		page.socket.off('library-album:versions', page.versions);
		page.socket.off('library-album:resolved', page.resolved);
		page.socket.off('library-album:version-failed', page.versionFailed);
		page.socket.off('library-album:failed', page.failed);
		page.socket.off('disconnect', page.disconnected);
		page.listenersAttached = false;
	}

	#armTimer(page: ActivePage, milliseconds: number, expire: () => void): void {
		this.#clearPageTimer(page);
		page.timer = this.#setTimer(expire, milliseconds);
	}

	#clearPageTimer(page: ActivePage): void {
		if (page.timer !== null) this.#clearTimer(page.timer);
		page.timer = null;
	}

	#handleOpenAck(page: ActivePage, value: unknown): void {
		if (this.#page !== page || page.openAckSettled) {
			this.#cancelLateAcceptance(page, value);
			return;
		}
		page.openAckSettled = true;
		const ack = normalizeLibraryAlbumOpenAck(value, page.request.requestId);
		if (!ack) {
			this.#failPage(page, 'OPEN_FAILED', 'The album page was not acknowledged');
			return;
		}
		if (!ack.success) {
			this.#failPage(page, ack.code, ack.error);
			return;
		}
		page.operationId = ack.data.operationId;
		page.openDeadlineAt = ack.data.resolvingDeadlineAt;
		this.#publish({
			...this.#state,
			operationId: ack.data.operationId,
			resolvingDeadlineAt: ack.data.resolvingDeadlineAt,
			transitionedAt: this.#now()
		});
		this.#armTimer(page, this.#resolvingTimeoutMs, () =>
			this.#failPage(page, 'RESOLUTION_TIMEOUT', 'The album page did not open in time')
		);
	}

	#cancelLateAcceptance(page: ActivePage, value: unknown): void {
		const ack = normalizeLibraryAlbumOpenAck(value, page.request.requestId);
		if (!ack?.success) return;
		try {
			page.socket.emit('library-album:cancel', { operationId: ack.data.operationId });
		} catch {
			// Best-effort.
		}
	}

	#openCorrelation(page: ActivePage): LibraryAlbumCorrelation | null {
		if (page.operationId === null || page.openDeadlineAt === null) return null;
		return {
			requestId: page.request.requestId,
			operationId: page.operationId,
			generation: page.request.generation,
			resolvingDeadlineAt: page.openDeadlineAt
		};
	}

	#selectCorrelation(page: ActivePage): LibraryAlbumCorrelation | null {
		if (page.operationId === null || page.selectDeadlineAt === null) return null;
		return {
			requestId: page.request.requestId,
			operationId: page.operationId,
			generation: page.request.generation,
			resolvingDeadlineAt: page.selectDeadlineAt
		};
	}

	#handleVersions(page: ActivePage, value: unknown): void {
		if (this.#page !== page) return;
		const expected = this.#openCorrelation(page);
		if (!expected) return;
		const event = normalizeLibraryAlbumVersionsEvent(value, expected);
		if (!event) return;
		this.#clearPageTimer(page);
		const versions = frozenVersions(event.versions.map(initialVersion));
		this.#publish({
			...this.#state,
			phase: 'versions',
			activeTab: versions.length === 1 ? 'details' : 'versions',
			artist: event.artist,
			title: event.title,
			versions,
			selectedVersionId: null,
			code: null,
			error: null,
			transitionedAt: this.#now()
		});
		if (versions.length === 1) this.select(versions[0].versionId);
	}

	#handleSelectAck(page: ActivePage, versionId: string, value: unknown): void {
		if (this.#page !== page || page.selectVersionId !== versionId) return;
		const ack = normalizeLibraryAlbumSelectAck(value, {
			operationId: page.operationId ?? '',
			versionId
		});
		if (!ack) {
			this.#failVersion(page, versionId, 'SELECT_FAILED', 'The album version was not acknowledged');
			return;
		}
		if (!ack.success) {
			if (ack.code === 'SESSION_LOST') {
				this.#failPage(page, ack.code, ack.error);
			} else {
				this.#failVersion(page, versionId, ack.code, ack.error);
			}
			return;
		}
		page.selectDeadlineAt = ack.data.resolvingDeadlineAt;
		this.#publish({
			...this.#state,
			resolvingDeadlineAt: ack.data.resolvingDeadlineAt,
			transitionedAt: this.#now()
		});
		this.#armTimer(page, this.#resolvingTimeoutMs, () =>
			this.#failVersion(page, versionId, 'RESOLUTION_TIMEOUT', 'The album version did not load in time')
		);
	}

	#handleResolved(page: ActivePage, value: unknown): void {
		if (this.#page !== page) return;
		const expected = this.#selectCorrelation(page);
		if (!expected) return;
		const event = normalizeLibraryAlbumResolvedEvent(value, expected);
		if (!event || event.versionId !== page.selectVersionId) return;
		const tracks = frozenTracks(event.orderedTracks);
		page.selectVersionId = null;
		page.selectDeadlineAt = null;
		this.#clearPageTimer(page);
		this.#publish({
			...this.#state,
			phase: 'details',
			activeTab: 'details',
			selectedVersionId: event.versionId,
			actionsAvailable: event.actionsAvailable,
			orderedTracks: tracks,
			versions: this.#updateVersion(event.versionId, {
				...event.versionSummary,
				phase: 'loaded',
				trackCount: tracks.length,
				code: null,
				error: null
			}),
			transitionedAt: this.#now()
		});
	}

	#handleVersionFailed(page: ActivePage, value: unknown): void {
		if (this.#page !== page || !page.selectVersionId) return;
		const expected = this.#selectCorrelation(page);
		if (!expected) return;
		const event = normalizeLibraryAlbumVersionFailedEvent(value, {
			...expected,
			versionId: page.selectVersionId
		});
		if (!event) return;
		this.#failVersion(page, event.versionId, event.code, event.error);
	}

	#handleFailed(page: ActivePage, value: unknown): void {
		if (this.#page !== page) return;
		const expected = this.#openCorrelation(page);
		if (!expected) return;
		const event = normalizeLibraryAlbumFailedEvent(value, expected);
		if (!event) return;
		this.#failPage(page, event.code, event.error, event.code === 'CANCELED');
	}

	#handleDisconnect(page: ActivePage): void {
		this.#failPage(page, 'SESSION_LOST', 'The album page connection was lost');
	}

	#handleOpenAckTimeout(page: ActivePage): void {
		if (this.#page !== page || page.openAckSettled) return;
		page.openAckSettled = true;
		this.#failPage(page, 'OPEN_FAILED', 'The album page was not acknowledged in time');
	}

	#handleSelectAckTimeout(page: ActivePage, versionId: string): void {
		if (this.#page !== page || page.selectVersionId !== versionId) return;
		this.#failVersion(page, versionId, 'SELECT_FAILED', 'The album version was not acknowledged in time');
	}

	#failVersion(page: ActivePage, versionId: string, code: string, error: string): void {
		if (this.#page !== page) return;
		page.selectVersionId = null;
		page.selectDeadlineAt = null;
		this.#clearPageTimer(page);
		this.#publish({
			...this.#state,
			phase: 'versions',
			activeTab: 'versions',
			versions: this.#updateVersion(versionId, { phase: 'failed', code, error }),
			code,
			error,
			transitionedAt: this.#now()
		});
	}

	#failPage(page: ActivePage, code: string, error: string, canceled = false): void {
		if (this.#page !== page) return;
		this.#detachListeners(page);
		this.#clearPageTimer(page);
		this.#page = null;
		this.#publish({
			...this.#state,
			phase: canceled ? 'canceled' : 'failed',
			code,
			error,
			transitionedAt: this.#now()
		});
	}
}
