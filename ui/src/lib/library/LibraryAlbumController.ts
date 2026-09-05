import {
	normalizeLibraryAlbumFailedEvent,
	normalizeLibraryAlbumOpenAck,
	normalizeLibraryAlbumOpenRequest,
	normalizeLibraryAlbumResolvedEvent,
	normalizeLibraryAlbumSelectAck,
	normalizeLibraryAlbumSelectRequest,
	normalizeLibraryAlbumVersionFailedEvent,
	normalizeLibraryAlbumVersionsEvent,
	DEGRADE_WINDOW_MS,
	type LibraryAlbumCorrelation,
	type LibraryAlbumOpenRequest,
	type LibraryAlbumOpenTarget,
	type LibraryAlbumTrack,
	type LibraryAlbumVersionSummary
} from '@shared/libraryAlbumContracts';
import type { CollectionDrillOpenFailureDetail } from '@shared/collectionDrillContracts';
import type { LibraryRowReference } from '@shared/libraryRootsContracts';
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

/**
 * What a live album page acts by: Roon's own rows, named by their references.
 *
 * `albumRef` is the row the page IS. `playRef` is the level's single verb row —
 * Roon renders "Play Album" as an ordinary row, and browsing that row with a
 * zone bound is what yields the four action leaves (measured on the owner's
 * Core, `.agents/state.md` 2026-09-03). It is null unless there is exactly one
 * such row, because two would make "Play album" a guess.
 */
export interface LibraryAlbumLiveBinding {
	readonly albumRef: LibraryRowReference;
	readonly playRef: LibraryRowReference | null;
	readonly trackRefs: readonly LibraryRowReference[];
}

export interface LibraryAlbumState {
	readonly phase: LibraryAlbumPhase;
	readonly activeTab: LibraryAlbumTab;
	readonly generation: number | null;
	readonly requestId: string | null;
	readonly operationId: string | null;
	/** Server timestamp retained only as correlation evidence. */
	readonly resolvingDeadlineAt: number | null;
	readonly artist: string | null;
	readonly title: string | null;
	readonly versions: readonly LibraryAlbumVersionState[];
	/** True when the server built this page from catalog data, not live browse. */
	readonly degraded: boolean;
	readonly selectedVersionId: string | null;
	readonly actionsAvailable: boolean;
	/**
	 * Whether the WHOLE-ALBUM verbs can act, separately from the track rows.
	 *
	 * The two are one answer on a catalog page and may differ on a live one:
	 * Roon renders the album's Play as a row of the level like any other, and a
	 * level that carries no such row — or two — leaves nothing unambiguous for
	 * "Play album" to be, while every track row still carries its own reference
	 * and still works. Rather than disable a working track list to describe a
	 * missing header button, the page is told about the two separately, so
	 * neither ever renders an enabled control that cannot act.
	 */
	readonly albumActionsAvailable: boolean;
	readonly orderedTracks: readonly LibraryAlbumTrack[];
	/**
	 * The live references this page's controls act by, or null on a catalog
	 * page (`.agents/plans/library-live-view.md` Slice 2).
	 *
	 * `trackRefs` is parallel to `orderedTracks` by position, not by the
	 * track's `index`: both come from the same level read, in the same order,
	 * and pairing them any other way would be a second statement about which
	 * row is which — the only way the two could ever disagree.
	 */
	readonly live: LibraryAlbumLiveBinding | null;
	readonly code: string | null;
	readonly error: string | null;
	/**
	 * Set only when a collection-opened page could not find its row again:
	 * which half of the locator refused, why, and how many rows it saw. The
	 * surface words these two halves differently — a missing collection means
	 * the library no longer carries that genre or composer, a missing entry
	 * means the album left it — so the structured answer travels rather than
	 * one sentence for both.
	 */
	readonly collectionFailure: CollectionDrillOpenFailureDetail | null;
	readonly transitionedAt: number;
}

export interface LibraryAlbumOpenInput {
	/**
	 * What to open: a catalog album by local id, or a genre/composer drill row
	 * by its own keyless locator. A collection row has no catalog identity and
	 * one is never minted for it, so the page it opens is named by the locator
	 * and by nothing else.
	 */
	readonly target: LibraryAlbumOpenTarget;
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
export const RESOLVING_TIMEOUT_MS = 30_000;
/**
 * Transport slack only, never used by the server. The backend's worst-case
 * terminal event lands by `resolvingDeadlineAt + DEGRADE_WINDOW_MS`; arming
 * the client's open safety timer beyond that keeps listeners attached long
 * enough for a degraded publication emitted just under the cap to arrive.
 */
export const DEGRADE_DELIVERY_SLACK_MS = 2_000;

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
			target: input.target,
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
			albumActionsAvailable: false,
			orderedTracks: Object.freeze([]) as readonly LibraryAlbumTrack[],
			versions: this.#updateVersion(versionId, {
				phase: 'loading',
				code: null,
				error: null
			}),
			code: null,
			error: null,
			collectionFailure: null,
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

	/**
	 * The live arm (`.agents/plans/library-live-view.md` Slice 2).
	 *
	 * WHY THIS PRODUCES THE SAME STATE THE SOCKET PATH DOES, rather than a
	 * second shape beside it. `UnifiedAlbumPage` is the album page — its
	 * pagination, its focus handling, its action wiring, its hero. A live page
	 * that carried a different shape would have to be a second album page, and
	 * a second album page is where the two quietly stop agreeing about what an
	 * album looks like. So the level Roon returned is turned into the state
	 * this controller already publishes, and the page never learns which arm
	 * it is rendering.
	 *
	 * WHAT IS DELIBERATELY ABSENT ON A LIVE PAGE. There is no version list: the
	 * reference names one album, and Roon's other editions of it are other rows
	 * with their own references, not versions of this one. `versions` is
	 * therefore empty rather than carrying an invented single entry — which is
	 * also what keeps the version-exact editorial surface, bound to a catalog
	 * identity this page does not have, off a page that could not back it.
	 */
	public beginLive(): void {
		if (this.#disposed) return;
		// A live open displaces any retained catalog page, and displacing one
		// means telling the server, not dropping the handle on the floor.
		this.#retirePage(false);
		this.#publish({
			...this.#idleState(),
			phase: 'opening',
			transitionedAt: this.#now()
		});
	}

	/**
	 * Publish one opened level as this page.
	 *
	 * Pure: it reads nothing and awaits nothing, so there is no window here in
	 * which a level could arrive over a page that has already moved on. The
	 * caller owns that fence, because the caller owns the read.
	 */
	public adoptLiveLevel(input: {
		readonly albumRef: LibraryRowReference;
		readonly title: string;
		readonly artist: string | null;
		readonly rows: readonly {
			readonly ref: LibraryRowReference;
			readonly title: string;
			readonly kind: string;
		}[];
	}): void {
		if (this.#disposed) return;
		this.#retirePage(false);
		const verbRows = input.rows.filter((row) => row.kind === 'action');
		const trackRows = input.rows.filter((row) => row.kind !== 'action');
		const orderedTracks: LibraryAlbumTrack[] = trackRows.map((row, position) => ({
			// Roon's own order IS the album's play order, and the position in
			// it is the only index there is. Nothing here reads a track number
			// out of the title: a title is text, and this is a position.
			index: position,
			title: row.title
		}));
		const live: LibraryAlbumLiveBinding = Object.freeze({
			albumRef: input.albumRef,
			// Exactly one, or none. Two verb rows would make the header's
			// "Play album" a choice between them that nobody can make, and the
			// honest answer is a disabled button, not an arbitrary one.
			playRef: verbRows.length === 1 ? verbRows[0].ref : null,
			trackRefs: Object.freeze(trackRows.map((row) => row.ref))
		});
		this.#publish({
			...this.#idleState(),
			phase: 'details',
			activeTab: 'details',
			title: input.title,
			artist: input.artist,
			actionsAvailable: orderedTracks.length > 0,
			albumActionsAvailable: live.playRef !== null,
			orderedTracks: frozenTracks(orderedTracks),
			live,
			transitionedAt: this.#now()
		});
	}

	/** The live read had no page to give, in the reader's own words. */
	public failLive(code: string, error: string): void {
		if (this.#disposed) return;
		this.#retirePage(false);
		this.#publish({
			...this.#idleState(),
			phase: 'failed',
			code,
			error,
			transitionedAt: this.#now()
		});
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
			generation: null,
			requestId: null,
			operationId: null,
			resolvingDeadlineAt: null,
			artist: null,
			title: null,
			versions: Object.freeze([]) as readonly LibraryAlbumVersionState[],
			degraded: false,
			selectedVersionId: null,
			actionsAvailable: false,
			orderedTracks: Object.freeze([]) as readonly LibraryAlbumTrack[],
			albumActionsAvailable: false,
			live: null,
			code: null,
			error: null,
			collectionFailure: null,
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
		// The server may spend one bounded degrade window past its own
		// deadline building a catalog-backed page, so the client safety net
		// must outlast that plus delivery. It stays a safety net: the backend
		// remains the source of the terminal outcome.
		this.#armTimer(
			page,
			this.#resolvingTimeoutMs + DEGRADE_WINDOW_MS + DEGRADE_DELIVERY_SLACK_MS,
			() => this.#handleOpenTimeout(page)
		);
	}

	#handleOpenTimeout(page: ActivePage): void {
		if (this.#page !== page) return;
		// A page published server-side but never delivered here would stay
		// retained; retire it before #failPage detaches the listeners.
		if (page.operationId !== null) this.#emitCancel(page);
		this.#failPage(page, 'RESOLUTION_TIMEOUT', 'The album page did not open in time');
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
			// A page with no artist keeps null here rather than an empty string:
			// the surface renders no artist line at all, and every
			// artist-dependent affordance reads the null and stands down.
			artist: event.artist ?? null,
			title: event.title,
			versions,
			degraded: event.degraded === true,
			selectedVersionId: null,
			code: null,
			error: null,
			collectionFailure: null,
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
			// A catalog page's two answers are one answer: the same retained
			// version authority backs the header verbs and the track rows.
			albumActionsAvailable: event.actionsAvailable,
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
		this.#failPage(
			page,
			event.code,
			event.error,
			event.code === 'CANCELED',
			event.collectionFailure ?? null
		);
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

	#failPage(
		page: ActivePage,
		code: string,
		error: string,
		canceled = false,
		collectionFailure: CollectionDrillOpenFailureDetail | null = null
	): void {
		if (this.#page !== page) return;
		this.#detachListeners(page);
		this.#clearPageTimer(page);
		this.#page = null;
		this.#publish({
			...this.#state,
			phase: canceled ? 'canceled' : 'failed',
			code,
			error,
			collectionFailure,
			transitionedAt: this.#now()
		});
	}
}
