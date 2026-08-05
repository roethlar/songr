import { get, writable, type Readable } from 'svelte/store';

import {
	CATALOG_ARTIST_SEARCH_MAX_LIMIT,
	type AlbumRef,
	type ArtistRef,
	type CatalogArtistAlbumsResponse,
	type CatalogArtistSearchResponse,
	type CatalogRefreshAcceptedResponse,
	type CatalogStatus
} from '@shared/timelineCatalogContracts';
import {
	normalizeTimelineArtistLoadBeginAck,
	normalizeTimelineArtistLoadedEvent,
	normalizeTimelineArtistLoadFailedEvent,
	normalizeTimelineArtistLoadRequest,
	normalizeTimelineAlbumDetailBeginAck,
	normalizeTimelineAlbumDetailCloseAck,
	normalizeTimelineAlbumDetailCloseFailedEvent,
	normalizeTimelineAlbumDetailCloseRequest,
	normalizeTimelineAlbumDetailClosedEvent,
	normalizeTimelineAlbumDetailFailedEvent,
	normalizeTimelineAlbumDetailLoadedEvent,
	normalizeTimelineAlbumDetailRequest,
	normalizeTimelineSessionReconnectAck,
	normalizeTimelineSessionReconnectRequest,
	normalizeTimelineSessionReleaseRequest,
	type TimelineAlbumDetailCloseCorrelation,
	type TimelineAlbumDetailCloseRequest,
	type TimelineAlbumDetailCorrelation,
	type TimelineAlbumDetailErrorCode,
	type TimelineAlbumDetailRequest,
	type TimelineAlbumDetailSnapshot,
	type TimelineArtistLoadCorrelation,
	type TimelineArtistLoadRequest,
	type TimelineBrowseSessionRef,
	type TimelineSessionReconnectRequest,
	type TimelineSessionReleaseRequest
} from '@shared/timelineBrowseContracts';
import {
	fetchCatalogArtistAlbums,
	fetchCatalogStatus,
	refreshCatalog,
	searchCatalogArtists
} from '$lib/api/client';
import { getSocket } from '$lib/socket/client';
import { emitWithBoundedAck, type BoundedAckSocket } from '$lib/socket/emit';
import { coreStore, isCorePaired } from './coreStore';
import { socketStatusStore } from './socketStatusStore';
import {
	mapCatalogArtistAlbumsToTimelineInputs,
	type TimelineCatalogMappingOptions
} from '$lib/timeline/catalog';
import { createSecureTimelineOpaqueId } from '$lib/timeline/secureOpaqueId';
import { getTimelineTabId } from '$lib/timeline/tabId';
import type { TimelineAlbumLayoutInput } from '$lib/timeline';
import {
	buildTimelineLibraryPageState,
	type TimelineLibrarySnapshot
} from '$lib/libraryPageState';

export type TimelineBrowsePhase = 'idle' | 'loading' | 'ready' | 'error';
export type TimelineCatalogRefreshPhase = 'idle' | 'running' | 'error';
export type TimelineSessionPhase = 'none' | 'live' | 'stale' | 'reconnecting';

export interface TimelineBrowseSessionState {
	readonly query: string;
	readonly candidates: readonly ArtistRef[];
	readonly catalogStatus: CatalogStatus | null;
	readonly statusPhase: TimelineBrowsePhase;
	readonly statusError: string | null;
	readonly searchPhase: TimelineBrowsePhase;
	readonly searchError: string | null;
	readonly refreshPhase: TimelineCatalogRefreshPhase;
	readonly refreshError: string | null;
	readonly selectionPhase: TimelineBrowsePhase;
	readonly selectionError: string | null;
	readonly selectedArtist: ArtistRef | null;
	readonly discography: CatalogArtistAlbumsResponse | null;
	readonly albums: readonly TimelineAlbumLayoutInput[];
	readonly session: TimelineBrowseSessionRef | null;
	readonly sessionPhase: TimelineSessionPhase;
	readonly detailPhase: TimelineBrowsePhase;
	readonly detailError: string | null;
	readonly detailFailureCode: TimelineAlbumDetailErrorCode | null;
	readonly selectedAlbumLocalId: string | null;
	readonly selectedAlbumDescriptor: AlbumRef | null;
	readonly detail: TimelineAlbumDetailSnapshot | null;
	readonly recoveryRequired: boolean;
}

export interface TimelineSelectionPublication {
	readonly query: string;
	readonly artist: ArtistRef;
	readonly discography: CatalogArtistAlbumsResponse;
	readonly albums: readonly TimelineAlbumLayoutInput[];
	readonly session: TimelineBrowseSessionRef;
}

export type TimelineSelectionResult =
	| { readonly success: true; readonly publication: TimelineSelectionPublication }
	| {
			readonly success: false;
			readonly reason: 'not-ready' | 'catalog-degraded' | 'superseded' | 'failed';
			readonly error?: string;
	  };

export interface TimelineDetailPublication {
	readonly detail: TimelineAlbumDetailSnapshot;
	readonly session: TimelineBrowseSessionRef;
}

export interface TimelineDetailClosePublication {
	readonly discography: CatalogArtistAlbumsResponse;
	readonly albums: readonly TimelineAlbumLayoutInput[];
	readonly session: TimelineBrowseSessionRef;
}

export type TimelineDetailResult<Publication> =
	| { readonly success: true; readonly publication: Publication }
	| {
			readonly success: false;
			readonly reason: 'not-ready' | 'superseded' | 'failed';
			readonly error?: string;
			readonly code?: string;
	  };

interface TimelineSocket extends BoundedAckSocket {
	readonly connected: boolean;
	on(event: string, handler: (value: unknown) => void): TimelineSocket;
	off(event: string, handler: (value: unknown) => void): TimelineSocket;
}

export interface TimelineBrowseSessionDependencies {
	readonly fetchFn?: typeof fetch;
	readonly getSocket?: () => TimelineSocket | null;
	readonly isReady?: (socket: TimelineSocket | null) => boolean;
	readonly getTabId?: () => string;
	readonly createRequestId?: () => string;
	readonly sleep?: (milliseconds: number) => Promise<void>;
	readonly setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
	readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	readonly fetchStatus?: (fetchFn: typeof fetch) => Promise<CatalogStatus>;
	readonly refresh?: (fetchFn: typeof fetch) => Promise<CatalogRefreshAcceptedResponse>;
	readonly search?: (
		fetchFn: typeof fetch,
		query: string,
		limit: number
	) => Promise<CatalogArtistSearchResponse>;
	readonly fetchArtistAlbums?: (
		fetchFn: typeof fetch,
		artistLocalId: string
	) => Promise<CatalogArtistAlbumsResponse>;
	readonly mapAlbums?: (
		response: CatalogArtistAlbumsResponse,
		options?: TimelineCatalogMappingOptions
	) => TimelineAlbumLayoutInput[];
	readonly ackTimeoutMs?: number;
	readonly maximumLoadWaitMs?: number;
	readonly refreshPollMs?: number;
	readonly maximumRefreshPolls?: number;
}

export interface TimelineBrowseSessionStore extends Readable<TimelineBrowseSessionState> {
	loadCatalogStatus(): Promise<boolean>;
	adoptAuxiliaryArtistHydration(status: CatalogStatus, expectedRevision: number): boolean;
	search(query: string): Promise<boolean>;
	refreshCatalog(): Promise<boolean>;
	selectArtist(
		artist: ArtistRef,
		onPublished?: (publication: TimelineSelectionPublication) => void
	): Promise<TimelineSelectionResult>;
	openAlbum(
		albumLocalId: string,
		onPublished?: (publication: TimelineDetailPublication) => void,
		detailArtistLocalId?: string
	): Promise<TimelineDetailResult<TimelineDetailPublication>>;
	closeAlbumDetail(
		baseArtistLocalId: string,
		onPublished?: (publication: TimelineDetailClosePublication) => void
	): Promise<TimelineDetailResult<TimelineDetailClosePublication>>;
	reconnectSession(): Promise<boolean>;
	restoreSnapshot(snapshot: TimelineLibrarySnapshot): Promise<boolean>;
	connectionLost(): void;
	quiesce(): void;
	destroy(): void;
}

const ACK_TIMEOUT_MS = 5_000;
const MAXIMUM_LOAD_WAIT_MS = 35_000;
const REFRESH_POLL_MS = 1_000;
const MAXIMUM_REFRESH_POLLS = 120;

const initialState = (): TimelineBrowseSessionState => ({
	query: '',
	candidates: [],
	catalogStatus: null,
	statusPhase: 'idle',
	statusError: null,
	searchPhase: 'idle',
	searchError: null,
	refreshPhase: 'idle',
	refreshError: null,
	selectionPhase: 'idle',
	selectionError: null,
	selectedArtist: null,
	discography: null,
	albums: [],
	session: null,
	sessionPhase: 'none',
	detailPhase: 'idle',
	detailError: null,
	detailFailureCode: null,
	selectedAlbumLocalId: null,
	selectedAlbumDescriptor: null,
	detail: null,
	recoveryRequired: false
});

function errorText(reason: unknown, fallback: string): string {
	return reason instanceof Error && reason.message.trim().length > 0 ? reason.message : fallback;
}

function catalogRefreshFailure(status: CatalogStatus): string | null {
	if (status.lastProblem?.code === 'SCAN_FAILED') {
		return status.available
			? 'Catalog scan failed; the prior snapshot remains available'
			: 'Catalog scan failed before a snapshot became available';
	}
	if (status.persistence === 'degraded') {
		return 'Catalog refresh could not be persisted safely';
	}
	return null;
}

function requestIdOf(value: unknown): string | null {
	try {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, 'requestId');
		return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
			? descriptor.value
			: null;
	} catch {
		return null;
	}
}

function productionRequestId(): string {
	try {
		return createSecureTimelineOpaqueId();
	} catch {
		throw new Error('Secure Timeline request identity is unavailable');
	}
}

function productionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return globalThis.fetch(input, init);
}

function productionReady(socket: TimelineSocket | null): boolean {
	return (
		socket?.connected === true &&
		get(socketStatusStore) === 'connected' &&
		get(isCorePaired)
	);
}

export function createTimelineBrowseSessionStore(
	dependencies: TimelineBrowseSessionDependencies = {}
): TimelineBrowseSessionStore {
	const store = writable<TimelineBrowseSessionState>(initialState());
	const fetchFn = dependencies.fetchFn ?? productionFetch;
	const socketForRequest = dependencies.getSocket ?? (() => getSocket() as TimelineSocket | null);
	const isReady = dependencies.isReady ?? productionReady;
	const getTabId = dependencies.getTabId ?? getTimelineTabId;
	const createRequestId = dependencies.createRequestId ?? productionRequestId;
	const sleep =
		dependencies.sleep ??
		((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const setTimer = dependencies.setTimer ?? setTimeout;
	const clearTimer = dependencies.clearTimer ?? clearTimeout;
	const fetchStatus = dependencies.fetchStatus ?? fetchCatalogStatus;
	const refresh = dependencies.refresh ?? refreshCatalog;
	const searchArtists = dependencies.search ?? searchCatalogArtists;
	const fetchArtistAlbums = dependencies.fetchArtistAlbums ?? fetchCatalogArtistAlbums;
	const mapAlbums = dependencies.mapAlbums ?? mapCatalogArtistAlbumsToTimelineInputs;
	const ackTimeoutMs = dependencies.ackTimeoutMs ?? ACK_TIMEOUT_MS;
	const maximumLoadWaitMs = dependencies.maximumLoadWaitMs ?? MAXIMUM_LOAD_WAIT_MS;
	const refreshPollMs = dependencies.refreshPollMs ?? REFRESH_POLL_MS;
	const maximumRefreshPolls = dependencies.maximumRefreshPolls ?? MAXIMUM_REFRESH_POLLS;

	let destroyed = false;
	let statusGeneration = 0;
	let searchGeneration = 0;
	let refreshGeneration = 0;
	let selectionGeneration = 0;
	let detailGeneration = 0;
	let detailIntentGeneration = 0;
	let closeGeneration = 0;
	let reconnectGeneration = 0;
	let restoreGeneration = 0;
	let cancelActiveSelection: (() => void) | null = null;
	let cancelActiveDetail: (() => void) | null = null;
	let cancelActiveClose: (() => void) | null = null;
	let cancelActiveReconnect: (() => void) | null = null;

	function patch(values: Partial<TimelineBrowseSessionState>): void {
		store.update((state) => ({ ...state, ...values }));
	}

	async function loadCatalogStatus(): Promise<boolean> {
		if (destroyed) return false;
		const generation = ++statusGeneration;
		patch({ statusPhase: 'loading', statusError: null });
		try {
			const status = await fetchStatus(fetchFn);
			if (destroyed || generation !== statusGeneration) return false;
			patch({ catalogStatus: status, statusPhase: 'ready', statusError: null });
			if (status.refresh === 'running') {
				const refreshToken = ++refreshGeneration;
				patch({ refreshPhase: 'running', refreshError: null });
				return monitorRefresh(status, refreshToken);
			}
			const failure = catalogRefreshFailure(status);
			patch({
				refreshPhase: failure ? 'error' : 'idle',
				refreshError: failure
			});
			return failure === null;
		} catch (reason) {
			if (!destroyed && generation === statusGeneration) {
				patch({
					statusPhase: 'error',
					statusError: errorText(reason, 'Catalog status could not be loaded')
				});
			}
			return false;
		}
	}

	function adoptAuxiliaryArtistHydration(
		status: CatalogStatus,
		expectedRevision: number
	): boolean {
		if (
			destroyed ||
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 1 ||
			status.revision !== expectedRevision + 1 ||
			!status.available ||
			status.refresh !== 'idle'
		) return false;
		const before = get(store);
		const currentStatus = before.catalogStatus;
		const discography = before.discography;
		if (
			!currentStatus ||
			!discography ||
			!before.selectedArtist ||
			before.refreshPhase === 'running' ||
			currentStatus.refresh !== 'idle' ||
			currentStatus.coreId !== status.coreId ||
			currentStatus.revision !== expectedRevision ||
			discography.status.coreId !== status.coreId ||
			discography.artist.coreId !== status.coreId ||
			before.selectedArtist.coreId !== status.coreId
		) return false;

		statusGeneration += 1;
		patch({
			catalogStatus: status,
			statusPhase: 'ready',
			statusError: null,
			discography: { ...discography, status }
		});
		return true;
	}

	async function searchArtistsForQuery(
		queryValue: string,
		supersedeSelection: boolean
	): Promise<boolean> {
		if (destroyed) return false;
		statusGeneration += 1;
		const statusState = get(store);
		if (statusState.statusPhase === 'loading') {
			patch({
				statusPhase: statusState.catalogStatus ? 'ready' : 'idle',
				statusError: null
			});
		}
		const query = queryValue.normalize('NFKC').trim().replace(/\s+/gu, ' ');
		const generation = ++searchGeneration;
		if (supersedeSelection) {
			cancelActiveSelection?.();
			cancelActiveSelection = null;
			selectionGeneration += 1;
			const selectionState = get(store);
			if (
				selectionState.selectionPhase === 'loading' ||
				selectionState.selectionPhase === 'error'
			) {
				patch({ selectionPhase: 'idle', selectionError: null });
			}
		}
		if (query.length === 0) {
			patch({ query, candidates: [], searchPhase: 'idle', searchError: null });
			return true;
		}
		patch({ query, searchPhase: 'loading', searchError: null });
		try {
			const response = await searchArtists(fetchFn, query, CATALOG_ARTIST_SEARCH_MAX_LIMIT);
			if (destroyed || generation !== searchGeneration) return false;
			patch({
				query: response.query,
				candidates: response.artists,
				catalogStatus: response.status,
				statusPhase: 'ready',
				statusError: null,
				searchPhase: 'ready',
				searchError: null
			});
			return true;
		} catch (reason) {
			if (destroyed || generation !== searchGeneration) return false;
			patch({
				candidates: [],
				searchPhase: 'error',
				searchError: errorText(reason, 'Artist search failed')
			});
			return false;
		}
	}

	function search(queryValue: string): Promise<boolean> {
		return searchArtistsForQuery(queryValue, true);
	}

	async function monitorRefresh(
		initialStatus: CatalogStatus,
		generation: number
	): Promise<boolean> {
		try {
			let status = initialStatus;
			let polls = 0;
			while (status.refresh === 'running' && polls < maximumRefreshPolls) {
				await sleep(refreshPollMs);
				if (destroyed || generation !== refreshGeneration) return false;
				status = await fetchStatus(fetchFn);
				if (destroyed || generation !== refreshGeneration) return false;
				patch({ catalogStatus: status, statusPhase: 'ready', statusError: null });
				polls += 1;
			}
			if (status.refresh === 'running') {
				throw new Error('Catalog refresh did not settle within the bounded polling window');
			}
			const failure = catalogRefreshFailure(status);
			if (failure) throw new Error(failure);
			const latestQuery = get(store).query;
			if (latestQuery.length > 0) {
				await searchArtistsForQuery(latestQuery, false);
			}
			if (destroyed || generation !== refreshGeneration) return false;
			patch({ refreshPhase: 'idle', refreshError: null });
			return true;
		} catch (reason) {
			if (destroyed || generation !== refreshGeneration) return false;
			patch({
				refreshPhase: 'error',
				refreshError: errorText(reason, 'Catalog refresh failed')
			});
			return false;
		}
	}

	async function runRefresh(): Promise<boolean> {
		if (
			destroyed ||
			get(store).refreshPhase === 'running' ||
			get(store).selectionPhase === 'loading'
		) return false;
		statusGeneration += 1;
		const generation = ++refreshGeneration;
		patch({ refreshPhase: 'running', refreshError: null });
		try {
			const accepted = await refresh(fetchFn);
			if (destroyed || generation !== refreshGeneration) return false;
			patch({
				catalogStatus: accepted.status,
				statusPhase: 'ready',
				statusError: null
			});
			return monitorRefresh(accepted.status, generation);
		} catch (reason) {
			if (destroyed || generation !== refreshGeneration) return false;
			patch({
				refreshPhase: 'error',
				refreshError: errorText(reason, 'Catalog refresh failed')
			});
			return false;
		}
	}

	function selectArtist(
		artist: ArtistRef,
		onPublished?: (publication: TimelineSelectionPublication) => void,
		preserveDetailIntent = false
	): Promise<TimelineSelectionResult> {
		if (destroyed) return Promise.resolve({ success: false, reason: 'not-ready' });
		const socket = socketForRequest();
		if (!isReady(socket)) return Promise.resolve({ success: false, reason: 'not-ready' });
		const before = get(store);
		const selectionQuery = before.query;
		if (before.catalogStatus?.persistence === 'degraded') {
			return Promise.resolve({ success: false, reason: 'catalog-degraded' });
		}
		let request: TimelineArtistLoadRequest | null;
		try {
			request = normalizeTimelineArtistLoadRequest({
				requestId: createRequestId(),
				tabId: getTabId(),
				artistLocalId: artist.localId
			});
		} catch (reason) {
			return Promise.resolve({
				success: false,
				reason: 'failed',
				error: errorText(reason, 'Timeline artist request could not be created')
			});
		}
		if (!request) {
			return Promise.resolve({
				success: false,
				reason: 'failed',
				error: 'Timeline artist request could not be created'
			});
		}

		cancelActiveSelection?.();
		selectionGeneration += 1;
		const generation = selectionGeneration;
		cancelActiveDetail?.();
		cancelActiveClose?.();
		cancelActiveReconnect?.();
		if (!preserveDetailIntent) detailIntentGeneration += 1;
		detailGeneration += 1;
		closeGeneration += 1;
		reconnectGeneration += 1;
		patch({ selectionPhase: 'loading', selectionError: null });

		return new Promise<TimelineSelectionResult>((resolve) => {
			if (!socket) {
				resolve({ success: false, reason: 'not-ready' });
				return;
			}
			let settled = false;
			let correlation: TimelineArtistLoadCorrelation | null = null;
			let acknowledgedSession: TimelineBrowseSessionRef | null = null;
			let acknowledgedSessionReleased = false;
			let acknowledgedSessionPublished = false;
			let authorityUncertain = false;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const releaseAcknowledgedSession = () => {
				if (
					!acknowledgedSession ||
					acknowledgedSessionReleased ||
					acknowledgedSessionPublished
				) return;
				acknowledgedSessionReleased = true;
				releaseSessionBestEffort(acknowledgedSession, socket);
			};
			const cleanup = () => {
				if (timer !== null) clearTimer(timer);
				timer = null;
				socket.off('timeline-artist:loaded', loaded);
				socket.off('timeline-artist:failed', failed);
				if (cancelActiveSelection === cancel) cancelActiveSelection = null;
			};
			const settle = (result: TimelineSelectionResult) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};
			const fail = (message: string) => {
				releaseAcknowledgedSession();
				if (generation === selectionGeneration && !destroyed) {
					patch({
						selectionPhase: 'error',
						selectionError: message,
						...(authorityUncertain
							? {
									session: null,
									sessionPhase: 'none' as const,
									recoveryRequired: get(store).selectedArtist !== null
								}
							: {})
					});
				}
				settle({ success: false, reason: 'failed', error: message });
			};
			const cancel = () => {
				releaseAcknowledgedSession();
				if (authorityUncertain && generation === selectionGeneration && !destroyed) {
					patch({
						session: null,
						sessionPhase: 'none',
						recoveryRequired: get(store).selectedArtist !== null
					});
				}
				settle({ success: false, reason: 'superseded' });
			};
			const loaded = (value: unknown) => {
				if (requestIdOf(value) !== request.requestId || !correlation) return;
				const event = normalizeTimelineArtistLoadedEvent(value, correlation);
				if (!event || event.discography.artist.localId !== artist.localId) {
					fail('Timeline artist response was invalid');
					return;
				}
				if (destroyed || generation !== selectionGeneration) {
					cancel();
					return;
				}
				if (!isReady(socket)) {
					fail('Timeline artist loading lost its Core connection');
					return;
				}
				let albums: TimelineAlbumLayoutInput[];
				try {
					albums = mapAlbums(event.discography);
				} catch {
					fail('Timeline artist response was invalid');
					return;
				}
				const publication: TimelineSelectionPublication = {
					query: selectionQuery,
					artist: event.discography.artist,
					discography: event.discography,
					albums,
					session: event.session
				};
				try {
					onPublished?.(publication);
				} catch (reason) {
					fail(errorText(reason, 'Timeline publication failed'));
					return;
				}
				if (destroyed || generation !== selectionGeneration || !isReady(socket)) {
					fail('Timeline artist loading lost its publication authority');
					return;
				}
				patch({
					catalogStatus: event.discography.status,
					statusPhase: 'ready',
					statusError: null,
					candidates: [],
					searchPhase: 'idle',
					selectionPhase: 'ready',
					selectionError: null,
					selectedArtist: publication.artist,
					discography: publication.discography,
					albums: publication.albums,
					session: publication.session,
					sessionPhase: 'live',
					detailPhase: 'idle',
					detailError: null,
					detailFailureCode: null,
					selectedAlbumLocalId: null,
					selectedAlbumDescriptor: null,
					detail: null,
					recoveryRequired: false
				});
				acknowledgedSessionPublished = true;
				settle({ success: true, publication });
			};
			const failed = (value: unknown) => {
				if (requestIdOf(value) !== request.requestId || !correlation) return;
				const event = normalizeTimelineArtistLoadFailedEvent(value, correlation);
				fail(event?.error ?? 'Timeline artist failure response was invalid');
			};

			cancelActiveSelection = cancel;
			socket.on('timeline-artist:loaded', loaded);
			socket.on('timeline-artist:failed', failed);
			timer = setTimer(() => fail('Timeline artist request was not acknowledged'), ackTimeoutMs);
			try {
				authorityUncertain = true;
				emitWithBoundedAck(socket, 'timeline-artist:begin', request, ackTimeoutMs, (result) => {
					if (!result.acknowledged) {
						if (!settled) fail('Timeline artist request was not acknowledged');
						return;
					}
					const value = result.value;
					const ack = normalizeTimelineArtistLoadBeginAck(value, request.requestId);
					if (settled || destroyed || generation !== selectionGeneration) {
						if (ack?.success) {
							acknowledgedSession = ack.data.session;
							releaseAcknowledgedSession();
						}
						return;
					}
					if (!ack) {
						fail('Timeline artist acknowledgment was invalid');
						return;
					}
					if (!ack.success) {
						authorityUncertain = false;
						fail(ack.error);
						return;
					}
					correlation = ack.data;
					acknowledgedSession = ack.data.session;
					if (timer !== null) clearTimer(timer);
					// The controller and browser may be on different machines with
					// unrelated wall clocks. The server deadline remains correlation
					// evidence; this local duration is only a bounded delivery backstop.
					timer = setTimer(
						() => fail('Timeline artist loading timed out'),
						maximumLoadWaitMs
					);
				});
			} catch (reason) {
				fail(errorText(reason, 'Timeline artist request failed'));
			}
		});
	}

	async function openAlbum(
		albumLocalId: string,
		onPublished?: (publication: TimelineDetailPublication) => void,
		detailArtistLocalId?: string
	): Promise<TimelineDetailResult<TimelineDetailPublication>> {
		if (destroyed) return { success: false, reason: 'not-ready' };
		const intentGeneration = ++detailIntentGeneration;
		cancelActiveDetail?.();
		detailGeneration += 1;
		let socket = socketForRequest();
		let before = get(store);
		const baseArtist = before.selectedArtist;
		const targetArtistLocalId = detailArtistLocalId ?? baseArtist?.localId;
		if (!isReady(socket) || !baseArtist || !targetArtistLocalId) {
			return { success: false, reason: 'not-ready' };
		}

		let knownAlbum: AlbumRef | undefined;
		if (targetArtistLocalId === baseArtist.localId) {
			knownAlbum = before.discography?.albums.find((album) => album.localId === albumLocalId);
		} else {
			try {
				const auxiliary = await fetchArtistAlbums(fetchFn, targetArtistLocalId);
				if (destroyed || intentGeneration !== detailIntentGeneration) {
					return { success: false, reason: 'superseded' };
				}
				knownAlbum = auxiliary.albums.find((album) => album.localId === albumLocalId);
			} catch {
				return { success: false, reason: 'failed', error: 'Resolve required', code: 'ALBUM_NOT_FOUND' };
			}
		}
		if (!knownAlbum) {
			return { success: false, reason: 'failed', error: 'Resolve required', code: 'ALBUM_NOT_FOUND' };
		}
		if (knownAlbum.resolutionStatus === 'missing' || knownAlbum.resolutionStatus === 'ambiguous') {
			const code: TimelineAlbumDetailErrorCode =
				knownAlbum.resolutionStatus === 'missing' ? 'ALBUM_NOT_FOUND' : 'ALBUM_AMBIGUOUS';
			patch({
				detailPhase: 'error',
				detailError: 'Resolve required',
				detailFailureCode: code,
				selectedAlbumLocalId: albumLocalId,
				selectedAlbumDescriptor: knownAlbum,
				detail: null,
				recoveryRequired: false
			});
			return { success: false, reason: 'failed', error: 'Resolve required', code };
		}

		if (before.sessionPhase === 'stale') await reconnectSession();
		if (destroyed || intentGeneration !== detailIntentGeneration) {
			return { success: false, reason: 'superseded' };
		}
		before = get(store);
		if (before.sessionPhase !== 'live' || !before.session) {
			const selected = await selectArtist(baseArtist, undefined, true);
			if (destroyed || intentGeneration !== detailIntentGeneration) {
				return { success: false, reason: 'superseded' };
			}
			if (!selected.success) {
				return {
					success: false,
					reason:
						selected.reason === 'superseded'
							? 'superseded'
							: selected.reason === 'not-ready'
								? 'not-ready'
								: 'failed',
					...(selected.error ? { error: selected.error } : {})
				};
			}
			before = get(store);
		}
		socket = socketForRequest();
		const session = before.session;
		if (!isReady(socket) || !session || before.sessionPhase !== 'live') {
			return { success: false, reason: 'not-ready' };
		}
		let request: TimelineAlbumDetailRequest | null;
		try {
			request = normalizeTimelineAlbumDetailRequest({
				requestId: createRequestId(),
				tabId: getTabId(),
				session,
				artistLocalId: targetArtistLocalId,
				albumLocalId
			});
		} catch (reason) {
			return {
				success: false,
				reason: 'failed',
				error: errorText(reason, 'Timeline album request could not be created')
			};
		}
		if (!request) {
			return {
				success: false,
				reason: 'failed',
				error: 'Timeline album request could not be created'
			};
		}

		cancelActiveDetail?.();
		const generation = ++detailGeneration;
		cancelActiveClose?.();
		closeGeneration += 1;
		patch({
			detailPhase: 'loading',
			detailError: null,
			detailFailureCode: null,
			selectedAlbumLocalId: albumLocalId,
			selectedAlbumDescriptor: knownAlbum,
			detail: null
		});

		return new Promise((resolve) => {
			if (!socket) {
				resolve({ success: false, reason: 'not-ready' });
				return;
			}
			let settled = false;
			let correlation: TimelineAlbumDetailCorrelation | null = null;
			let authorityUncertain = false;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const cleanup = () => {
				if (timer !== null) clearTimer(timer);
				timer = null;
				socket.off('timeline-detail:loaded', loaded);
				socket.off('timeline-detail:failed', failed);
				if (cancelActiveDetail === cancel) cancelActiveDetail = null;
			};
			const settle = (result: TimelineDetailResult<TimelineDetailPublication>) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};
			const fail = (message: string, code?: TimelineAlbumDetailErrorCode) => {
				if (
					generation === detailGeneration &&
					intentGeneration === detailIntentGeneration &&
					!destroyed
				) {
					patch({
						detailPhase: 'error',
						detailError: message,
						detailFailureCode: code ?? null,
						...(authorityUncertain ||
						code === 'SESSION_LOST' ||
						code === 'STALE_GENERATION' ||
						code === 'ALBUM_NOT_FOUND' ||
						code === 'ALBUM_AMBIGUOUS'
							? { sessionPhase: 'stale' as const, recoveryRequired: true }
							: {})
					});
				}
				settle({ success: false, reason: 'failed', error: message, ...(code ? { code } : {}) });
			};
			const cancel = () => {
				if (authorityUncertain && generation === detailGeneration && !destroyed) {
					patch({ sessionPhase: 'stale', recoveryRequired: true });
				}
				settle({ success: false, reason: 'superseded' });
			};
			const loaded = (value: unknown) => {
				if (requestIdOf(value) !== request.requestId || !correlation) return;
				const event = normalizeTimelineAlbumDetailLoadedEvent(value, correlation);
				if (!event) {
					fail('Timeline album detail response was invalid');
					return;
				}
				if (
					destroyed ||
					generation !== detailGeneration ||
					intentGeneration !== detailIntentGeneration
				) {
					cancel();
					return;
				}
				if (!isReady(socket)) {
					fail('Timeline album detail lost its Core connection', 'SESSION_LOST');
					return;
				}
				const publication: TimelineDetailPublication = {
					detail: event.detail,
					session: event.session
				};
				try {
					onPublished?.(publication);
				} catch (reason) {
					fail(errorText(reason, 'Timeline detail publication failed'));
					return;
				}
				if (
					destroyed ||
					generation !== detailGeneration ||
					intentGeneration !== detailIntentGeneration ||
					!isReady(socket)
				) {
					fail('Timeline album detail lost its publication authority', 'SESSION_LOST');
					return;
				}
				patch({
					detailPhase: 'ready',
					detailError: null,
					detailFailureCode: null,
					selectedAlbumLocalId: albumLocalId,
					selectedAlbumDescriptor: event.detail.album,
					detail: event.detail,
					session: event.session,
					sessionPhase: 'live',
					recoveryRequired: false
				});
				settle({ success: true, publication });
			};
			const failed = (value: unknown) => {
				if (requestIdOf(value) !== request.requestId || !correlation) return;
				const event = normalizeTimelineAlbumDetailFailedEvent(value, correlation);
				if (!event) {
					fail('Timeline album detail failure response was invalid');
					return;
				}
				fail(event.error, event.code);
			};

			cancelActiveDetail = cancel;
			socket.on('timeline-detail:loaded', loaded);
			socket.on('timeline-detail:failed', failed);
			timer = setTimer(() => fail('Timeline album detail request was not acknowledged'), ackTimeoutMs);
			try {
				authorityUncertain = true;
				emitWithBoundedAck(socket, 'timeline-detail:begin', request, ackTimeoutMs, (result) => {
					if (
						settled ||
						destroyed ||
						generation !== detailGeneration ||
						intentGeneration !== detailIntentGeneration
					) return;
					if (!result.acknowledged) {
						fail('Timeline album detail request was not acknowledged');
						return;
					}
					const value = result.value;
					const ack = normalizeTimelineAlbumDetailBeginAck(value, request);
					if (!ack) {
						fail('Timeline album detail acknowledgment was invalid');
						return;
					}
					if (!ack.success) {
						authorityUncertain = false;
						fail(ack.error, ack.code);
						return;
					}
					correlation = ack.data;
					if (timer !== null) clearTimer(timer);
					timer = setTimer(() => fail('Timeline album detail loading timed out'), maximumLoadWaitMs);
				});
			} catch (reason) {
				fail(errorText(reason, 'Timeline album detail request failed'));
			}
		});
	}

	function closeAlbumDetail(
		baseArtistLocalId: string,
		onPublished?: (publication: TimelineDetailClosePublication) => void
	): Promise<TimelineDetailResult<TimelineDetailClosePublication>> {
		if (destroyed) return Promise.resolve({ success: false, reason: 'not-ready' });
		cancelActiveClose?.();
		const generation = ++closeGeneration;
		detailIntentGeneration += 1;
		cancelActiveDetail?.();
		detailGeneration += 1;
		const socket = socketForRequest();
		const before = get(store);
		if (
			!isReady(socket) ||
			!before.session ||
			before.sessionPhase !== 'live' ||
			!before.detail ||
			!before.selectedAlbumLocalId
		) {
			return Promise.resolve({ success: false, reason: 'not-ready' });
		}
		let request: TimelineAlbumDetailCloseRequest | null;
		try {
			request = normalizeTimelineAlbumDetailCloseRequest({
				requestId: createRequestId(),
				tabId: getTabId(),
				session: before.session,
				baseArtistLocalId,
				detailArtistLocalId: before.detail.artist.localId,
				albumLocalId: before.selectedAlbumLocalId
			});
		} catch (reason) {
			return Promise.resolve({
				success: false,
				reason: 'failed',
				error: errorText(reason, 'Timeline detail-close request could not be created')
			});
		}
		if (!request) {
			return Promise.resolve({
				success: false,
				reason: 'failed',
				error: 'Timeline detail-close request could not be created'
			});
		}

		patch({ detailPhase: 'loading', detailError: null, detailFailureCode: null });

		return new Promise((resolve) => {
			if (!socket) {
				resolve({ success: false, reason: 'not-ready' });
				return;
			}
			let settled = false;
			let correlation: TimelineAlbumDetailCloseCorrelation | null = null;
			let authorityUncertain = false;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const cleanup = () => {
				if (timer !== null) clearTimer(timer);
				timer = null;
				socket.off('timeline-detail:closed', closed);
				socket.off('timeline-detail:close-failed', failed);
				if (cancelActiveClose === cancel) cancelActiveClose = null;
			};
			const settle = (result: TimelineDetailResult<TimelineDetailClosePublication>) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};
			const fail = (message: string, code?: string) => {
				if (generation === closeGeneration && !destroyed) {
					patch({
						detailPhase: 'error',
						detailError: message,
						...(authorityUncertain || code === 'SESSION_LOST' || code === 'STALE_GENERATION'
							? { sessionPhase: 'stale' as const, recoveryRequired: true }
							: {})
					});
				}
				settle({ success: false, reason: 'failed', error: message, ...(code ? { code } : {}) });
			};
			const cancel = () => {
				if (authorityUncertain && generation === closeGeneration && !destroyed) {
					patch({ sessionPhase: 'stale', recoveryRequired: true });
				}
				settle({ success: false, reason: 'superseded' });
			};
			const closed = (value: unknown) => {
				if (requestIdOf(value) !== request.requestId || !correlation) return;
				const event = normalizeTimelineAlbumDetailClosedEvent(value, correlation);
				if (!event) {
					fail('Timeline detail-close response was invalid');
					return;
				}
				if (destroyed || generation !== closeGeneration) {
					cancel();
					return;
				}
				let albums: TimelineAlbumLayoutInput[];
				try {
					albums = mapAlbums(event.discography);
				} catch {
					fail('Timeline detail-close response was invalid');
					return;
				}
				const publication: TimelineDetailClosePublication = {
					discography: event.discography,
					albums,
					session: event.session
				};
				try {
					onPublished?.(publication);
				} catch (reason) {
					fail(errorText(reason, 'Timeline detail-close publication failed'));
					return;
				}
				if (destroyed || generation !== closeGeneration || !isReady(socket)) {
					fail('Timeline detail-close lost its publication authority', 'SESSION_LOST');
					return;
				}
				patch({
					catalogStatus: event.discography.status,
					selectedArtist: event.discography.artist,
					discography: event.discography,
					albums,
					session: event.session,
					sessionPhase: 'live',
					detailPhase: 'idle',
					detailError: null,
					detailFailureCode: null,
					selectedAlbumLocalId: null,
					selectedAlbumDescriptor: null,
					detail: null,
					recoveryRequired: false
				});
				settle({ success: true, publication });
			};
			const failed = (value: unknown) => {
				if (requestIdOf(value) !== request.requestId || !correlation) return;
				const event = normalizeTimelineAlbumDetailCloseFailedEvent(value, correlation);
				if (!event) {
					fail('Timeline detail-close failure response was invalid');
					return;
				}
				fail(event.error, event.code);
			};

			cancelActiveClose = cancel;
			socket.on('timeline-detail:closed', closed);
			socket.on('timeline-detail:close-failed', failed);
			timer = setTimer(() => fail('Timeline detail-close request was not acknowledged'), ackTimeoutMs);
			try {
				authorityUncertain = true;
				emitWithBoundedAck(socket, 'timeline-detail:close', request, ackTimeoutMs, (result) => {
					if (settled || destroyed || generation !== closeGeneration) return;
					if (!result.acknowledged) {
						fail('Timeline detail-close request was not acknowledged');
						return;
					}
					const value = result.value;
					const ack = normalizeTimelineAlbumDetailCloseAck(value, request);
					if (!ack) {
						fail('Timeline detail-close acknowledgment was invalid');
						return;
					}
					if (!ack.success) {
						authorityUncertain = false;
						fail(ack.error, ack.code);
						return;
					}
					correlation = ack.data;
					if (timer !== null) clearTimer(timer);
					timer = setTimer(() => fail('Timeline detail closing timed out'), maximumLoadWaitMs);
				});
			} catch (reason) {
				fail(errorText(reason, 'Timeline detail-close request failed'));
			}
		});
	}

	function reconnectSession(): Promise<boolean> {
		if (destroyed) return Promise.resolve(false);
		const socket = socketForRequest();
		const before = get(store);
		if (before.sessionPhase === 'live' && before.session) return Promise.resolve(true);
		if (!isReady(socket) || !before.session || before.sessionPhase !== 'stale') {
			return Promise.resolve(false);
		}
		let request: TimelineSessionReconnectRequest | null;
		try {
			request = normalizeTimelineSessionReconnectRequest({
				requestId: createRequestId(),
				tabId: getTabId(),
				session: before.session
			});
		} catch {
			request = null;
		}
		if (!request) return Promise.resolve(false);

		cancelActiveReconnect?.();
		const generation = ++reconnectGeneration;
		patch({ sessionPhase: 'reconnecting' });
		return new Promise((resolve) => {
			if (!socket) {
				resolve(false);
				return;
			}
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const settle = (success: boolean) => {
				if (settled) return;
				settled = true;
				if (timer !== null) clearTimer(timer);
				timer = null;
				if (cancelActiveReconnect === cancel) cancelActiveReconnect = null;
				resolve(success);
			};
			const fail = () => {
				if (generation === reconnectGeneration && !destroyed) patch({ sessionPhase: 'stale' });
				settle(false);
			};
			const cancel = () => settle(false);
			cancelActiveReconnect = cancel;
			timer = setTimer(fail, ackTimeoutMs);
			try {
				emitWithBoundedAck(socket, 'timeline-session:reconnect', request, ackTimeoutMs, (result) => {
					if (settled || destroyed || generation !== reconnectGeneration) return;
					if (!result.acknowledged) {
						fail();
						return;
					}
					const value = result.value;
					const ack = normalizeTimelineSessionReconnectAck(value, request);
					if (!ack?.success || !isReady(socket)) {
						fail();
						return;
					}
					patch({ session: ack.data.session, sessionPhase: 'live' });
					settle(true);
				});
			} catch {
				fail();
			}
		});
	}

	function clearToLens(query: string, error: string | null = null): void {
		patch({
			query,
			candidates: [],
			selectionPhase: error ? 'error' : 'idle',
			selectionError: error,
			selectedArtist: null,
			discography: null,
			albums: [],
			session: null,
			sessionPhase: 'none',
			detailPhase: 'idle',
			detailError: null,
			detailFailureCode: null,
			selectedAlbumLocalId: null,
			selectedAlbumDescriptor: null,
			detail: null,
			recoveryRequired: false
		});
	}

	async function restoreSnapshot(snapshotValue: TimelineLibrarySnapshot): Promise<boolean> {
		if (destroyed) return false;
		let snapshot: TimelineLibrarySnapshot;
		try {
			snapshot = buildTimelineLibraryPageState(snapshotValue).snapshot;
		} catch {
			return false;
		}
		const generation = ++restoreGeneration;
		cancelActiveSelection?.();
		cancelActiveDetail?.();
		cancelActiveClose?.();
		cancelActiveReconnect?.();
		selectionGeneration += 1;
		detailGeneration += 1;
		detailIntentGeneration += 1;
		closeGeneration += 1;
		reconnectGeneration += 1;
		patch({ query: snapshot.artistQuery });
		if (!snapshot.selectedArtistLocalId) {
			clearToLens(snapshot.artistQuery);
			return true;
		}

		const targetAlbum =
			snapshot.selectedNode?.kind === 'album' ? snapshot.selectedNode.localId : null;
		const targetDetailArtistLocalId = targetAlbum
			? [...snapshot.activeSemanticPath]
					.reverse()
					.find((ref) => ref.kind === 'auxiliary-artist')?.localId ?? snapshot.selectedArtistLocalId
			: snapshot.selectedArtistLocalId;
		let catalogDiscography: CatalogArtistAlbumsResponse;
		try {
			catalogDiscography = await fetchArtistAlbums(fetchFn, snapshot.selectedArtistLocalId);
		} catch (reason) {
			if (destroyed || generation !== restoreGeneration) return false;
			clearToLens(
				snapshot.artistQuery,
				errorText(reason, 'The saved Timeline artist is no longer available')
			);
			return false;
		}
		if (destroyed || generation !== restoreGeneration) return false;
		const core = get(coreStore);
		const activeCoreId = core.status === 'paired' ? core.core?.id : null;
		if (!activeCoreId || catalogDiscography.status.coreId !== activeCoreId) {
			clearToLens(snapshot.artistQuery, 'The saved Timeline belongs to a different Roon Core');
			return false;
		}
		let catalogAlbums: TimelineAlbumLayoutInput[];
		try {
			catalogAlbums = mapAlbums(catalogDiscography, {
				...(targetAlbum && targetDetailArtistLocalId === snapshot.selectedArtistLocalId
					? { retainMissingLocalId: targetAlbum }
					: {})
			});
		} catch {
			clearToLens(snapshot.artistQuery, 'The saved Timeline artist could not be restored');
			return false;
		}
		patch({
			catalogStatus: catalogDiscography.status,
			statusPhase: 'ready',
			statusError: null,
			selectionPhase: 'ready',
			selectionError: null,
			selectedArtist: catalogDiscography.artist,
			discography: catalogDiscography,
			albums: catalogAlbums,
			session: null,
			sessionPhase: 'none',
			selectedAlbumLocalId: targetAlbum,
			selectedAlbumDescriptor:
				targetDetailArtistLocalId === snapshot.selectedArtistLocalId
					? catalogDiscography.albums.find((album) => album.localId === targetAlbum) ?? null
					: null,
			detail: null,
			detailPhase: targetAlbum ? 'loading' : 'idle',
			detailError: null,
			detailFailureCode: null,
			recoveryRequired: targetAlbum !== null
		});
		const primaryTargetDescriptor =
			targetDetailArtistLocalId === snapshot.selectedArtistLocalId
				? catalogDiscography.albums.find((album) => album.localId === targetAlbum) ?? null
				: null;
		if (
			targetAlbum &&
			targetDetailArtistLocalId === snapshot.selectedArtistLocalId &&
			!primaryTargetDescriptor
		) {
			patch({
				detailPhase: 'error',
				detailError: 'Resolve required',
				detailFailureCode: 'ALBUM_NOT_FOUND',
				recoveryRequired: false
			});
			return false;
		}
		if (
			targetAlbum &&
			(primaryTargetDescriptor?.resolutionStatus === 'missing' ||
				primaryTargetDescriptor?.resolutionStatus === 'ambiguous')
		) {
			patch({
				detailPhase: 'error',
				detailError: 'Resolve required',
				detailFailureCode:
					primaryTargetDescriptor.resolutionStatus === 'missing'
						? 'ALBUM_NOT_FOUND'
						: 'ALBUM_AMBIGUOUS',
				recoveryRequired: false
			});
			return false;
		}

		const selected = await selectArtist(catalogDiscography.artist, undefined, true);
		if (destroyed || generation !== restoreGeneration) return false;
		if (!selected.success) return false;
		if (!targetAlbum) return true;
		const opened = await openAlbum(targetAlbum, undefined, targetDetailArtistLocalId);
		if (
			!opened.success &&
			generation === restoreGeneration &&
			(opened.code === 'ALBUM_NOT_FOUND' || opened.code === 'ALBUM_AMBIGUOUS')
		) {
			patch({
				detailPhase: 'error',
				detailError: 'Resolve required',
				detailFailureCode: opened.code
			});
		}
		return !destroyed && generation === restoreGeneration && opened.success;
	}

	function connectionLost(): void {
		if (destroyed) return;
		cancelActiveSelection?.();
		cancelActiveDetail?.();
		cancelActiveClose?.();
		cancelActiveReconnect?.();
		selectionGeneration += 1;
		detailGeneration += 1;
		detailIntentGeneration += 1;
		closeGeneration += 1;
		reconnectGeneration += 1;
		restoreGeneration += 1;
		const state = get(store);
		patch({
			selectionPhase: state.selectionPhase === 'loading' ? 'idle' : state.selectionPhase,
			detailPhase: state.detailPhase === 'loading' ? (state.detail ? 'ready' : 'idle') : state.detailPhase,
			sessionPhase: state.session ? 'stale' : 'none',
			recoveryRequired: state.selectedArtist !== null
		});
	}

	function releaseSessionBestEffort(
		session: TimelineBrowseSessionRef | null,
		requestSocket: TimelineSocket | null = socketForRequest()
	): void {
		if (!session) return;
		const socket = requestSocket;
		if (!socket || !isReady(socket)) return;
		let request: TimelineSessionReleaseRequest | null;
		try {
			request = normalizeTimelineSessionReleaseRequest({
				requestId: createRequestId(),
				tabId: getTabId(),
				session
			});
		} catch {
			return;
		}
		if (!request) return;
		try {
			emitWithBoundedAck(socket, 'timeline-session:release', request, ackTimeoutMs, () => undefined);
		} catch {
			// Release is advisory. Local authority is discarded unconditionally below.
		}
	}

	function quiesce(): void {
		if (destroyed) return;
		const sessionToRelease = get(store).session;
		cancelActiveSelection?.();
		cancelActiveSelection = null;
		cancelActiveDetail?.();
		cancelActiveDetail = null;
		cancelActiveClose?.();
		cancelActiveClose = null;
		cancelActiveReconnect?.();
		cancelActiveReconnect = null;
		searchGeneration += 1;
		statusGeneration += 1;
		refreshGeneration += 1;
		selectionGeneration += 1;
		detailGeneration += 1;
		detailIntentGeneration += 1;
		closeGeneration += 1;
		reconnectGeneration += 1;
		restoreGeneration += 1;
		const state = get(store);
		releaseSessionBestEffort(sessionToRelease);
		patch({
			statusPhase: state.statusPhase === 'loading' ? 'idle' : state.statusPhase,
			candidates: [],
			searchPhase: 'idle',
			searchError: null,
			refreshPhase: 'idle',
			refreshError: null,
			selectionPhase: 'idle',
			selectionError: null,
			selectedArtist: null,
			discography: null,
			albums: [],
			session: null,
			sessionPhase: 'none',
			detailPhase: 'idle',
			detailError: null,
			detailFailureCode: null,
			selectedAlbumLocalId: null,
			selectedAlbumDescriptor: null,
			detail: null,
			recoveryRequired: false
		});
	}

	return {
		subscribe: store.subscribe,
		loadCatalogStatus,
		adoptAuxiliaryArtistHydration,
		search,
		refreshCatalog: runRefresh,
		selectArtist,
		openAlbum,
		closeAlbumDetail,
		reconnectSession,
		restoreSnapshot,
		connectionLost,
		quiesce,
		destroy() {
			if (destroyed) return;
			quiesce();
			destroyed = true;
		}
	};
}

export const timelineBrowseSessionStore = createTimelineBrowseSessionStore();
