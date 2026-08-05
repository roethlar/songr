import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';

import {
	normalizeCatalogArtistAlbumsResponse,
	normalizeCatalogText,
	type AlbumRef,
	type ArtistRef,
	type CatalogArtistAlbumsResponse,
	type CatalogArtistSearchResponse,
	type CatalogStatus
} from '@shared/timelineCatalogContracts';
import type {
	TimelineAlbumDetailCorrelation,
	TimelineAlbumDetailSnapshot,
	TimelineArtistLoadCorrelation,
	TimelineArtistLoadedEvent
} from '@shared/timelineBrowseContracts';
import { setCoreStatus } from '../coreStore';
import { createTimelineBrowseSessionStore } from '../timelineBrowseSessionStore';

const TRACK_FINGERPRINT = 'a'.repeat(64);

const AT = '2026-07-15T00:00:00.000Z';
const ARTIST_A_ID = '10000000-0000-4000-8000-000000000001';
const ARTIST_B_ID = '10000000-0000-4000-8000-000000000002';
const ALBUM_A_ID = '20000000-0000-4000-8000-000000000001';
const ALBUM_B_ID = '20000000-0000-4000-8000-000000000002';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function status(
	overrides: Partial<CatalogStatus> = {}
): CatalogStatus {
	return {
		coreId: 'core-a',
		freshness: 'fresh',
		persistence: 'healthy',
		refresh: 'idle',
		available: true,
		complete: true,
		revision: 2,
		artistCount: 2,
		albumCount: 2,
		updatedAt: AT,
		lastCompleteScanAt: AT,
		...overrides
	};
}

function artist(localId: string, exactName: string): ArtistRef {
	return {
		localId,
		coreId: 'core-a',
		exactName,
		normalizedName: normalizeCatalogText(exactName),
		firstSeenAt: AT,
		lastSeenAt: AT,
		resolutionStatus: 'resolved'
	};
}

const ARTIST_A = artist(ARTIST_A_ID, 'Björk');
const ARTIST_B = artist(ARTIST_B_ID, 'Fever Ray');

function album(owner: ArtistRef, localId: string, exactTitle: string): AlbumRef {
	return {
		localId,
		coreId: 'core-a',
		artistLocalId: owner.localId,
		exactTitle,
		exactArtist: owner.exactName,
		normalizedTitle: normalizeCatalogText(exactTitle),
		normalizedArtist: owner.normalizedName,
		editionText: '',
		firstSeenAt: AT,
		lastSeenAt: AT,
		resolutionStatus: 'resolved'
	};
}

function detailedAlbum(owner: ArtistRef, localId: string, exactTitle: string): AlbumRef {
	return {
		...album(owner, localId, exactTitle),
		trackTitleFingerprint: TRACK_FINGERPRINT,
		imageKeyHint: `image-${localId}`
	};
}

function discography(
	owner: ArtistRef,
	ownedAlbum: AlbumRef,
	statusValue = status()
): CatalogArtistAlbumsResponse {
	const value = normalizeCatalogArtistAlbumsResponse({
		status: statusValue,
		artist: owner,
		limit: 500,
		total: 1,
		truncated: false,
		albums: [ownedAlbum]
	});
	if (!value) throw new Error('invalid test discography');
	return value;
}

function discographyWithAlbums(
	owner: ArtistRef,
	albums: readonly AlbumRef[]
): CatalogArtistAlbumsResponse {
	const value = normalizeCatalogArtistAlbumsResponse({
		status: status({ albumCount: albums.length }),
		artist: owner,
		limit: 500,
		total: albums.length,
		truncated: false,
		albums
	});
	if (!value) throw new Error('invalid test discography');
	return value;
}

function searchResponse(
	query: string,
	artists: readonly ArtistRef[],
	statusValue = status()
): CatalogArtistSearchResponse {
	return {
		status: statusValue,
		query,
		limit: 40,
		total: artists.length,
		truncated: false,
		artists
	};
}

class FakeSocket {
	public connected = true;
	public readonly ackTimeouts: number[] = [];
	public readonly emissions: Array<{
		event: string;
		value: unknown;
		timeoutMs: number;
		ack: (value: unknown) => void;
		expire: () => void;
		isPending: () => boolean;
	}> = [];
	private readonly handlers = new Map<string, Set<(value: unknown) => void>>();
	private nextEmitError: Error | null = null;

	public on(event: string, handler: (value: unknown) => void): this {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return this;
	}

	public off(event: string, handler: (value: unknown) => void): this {
		this.handlers.get(event)?.delete(handler);
		return this;
	}

	public failNextBoundedEmit(error: Error): void {
		this.nextEmitError = error;
	}

	public timeout(milliseconds: number): {
			emit: (
				event: string,
				value: unknown,
				ack: (error: unknown, response?: unknown) => void
		) => FakeSocket;
	} {
		this.ackTimeouts.push(milliseconds);
		return {
			emit: (event, value, ack) => {
				const emitError = this.nextEmitError;
				this.nextEmitError = null;
				if (emitError) throw emitError;
				let pending = true;
				this.emissions.push({
					event,
					value,
					timeoutMs: milliseconds,
					ack: (response) => {
						if (!pending) return;
						pending = false;
						ack(null, response);
					},
					expire: () => {
						if (!pending) return;
						pending = false;
						ack(new Error('operation has timed out'));
					},
					isPending: () => pending
				});
				return this;
			}
		};
	}

	public pendingAckCount(): number {
		return this.emissions.filter((emission) => emission.isPending()).length;
	}

	public expirePendingAcks(): void {
		for (const emission of this.emissions) emission.expire();
	}

	public acknowledge(index: number, correlation: TimelineArtistLoadCorrelation): void {
		this.emissions[index].ack({ success: true, data: correlation });
	}

	public deliver(event: string, value: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value);
	}

	public handlerCount(): number {
		return [...this.handlers.values()].reduce((total, handlers) => total + handlers.size, 0);
	}
}

class FakeTimers {
	private nextId = 1;
	private readonly callbacks = new Map<number, () => void>();

	public readonly set = (callback: () => void): ReturnType<typeof setTimeout> => {
		const id = this.nextId++;
		this.callbacks.set(id, callback);
		return id as unknown as ReturnType<typeof setTimeout>;
	};

	public readonly clear = (timer: ReturnType<typeof setTimeout>): void => {
		this.callbacks.delete(timer as unknown as number);
	};

	public fireOnly(): void {
		expect(this.callbacks.size).toBe(1);
		const [callback] = this.callbacks.values();
		this.callbacks.clear();
		callback();
	}
}

function correlation(requestId: string, generation: number): TimelineArtistLoadCorrelation {
	return {
		requestId,
		session: { handleId: `handle-${generation}`, generation },
		loadingDeadlineAt: 31_000
	};
}

function loaded(
	value: TimelineArtistLoadCorrelation,
	discographyValue: CatalogArtistAlbumsResponse
): TimelineArtistLoadedEvent {
	return { ...value, discography: discographyValue };
}

function requestIdAt(socket: FakeSocket, index: number): string {
	return (socket.emissions[index].value as { requestId: string }).requestId;
}

function detailCorrelationAt(socket: FakeSocket, index: number): TimelineAlbumDetailCorrelation {
	const request = socket.emissions[index].value as {
		requestId: string;
		session: TimelineAlbumDetailCorrelation['session'];
		artistLocalId: string;
		albumLocalId: string;
	};
	return {
		requestId: request.requestId,
		session: request.session,
		artistLocalId: request.artistLocalId,
		albumLocalId: request.albumLocalId,
		loadingDeadlineAt: 31_000
	};
}

function detailSnapshot(
	owner: ArtistRef,
	ownedAlbum: AlbumRef,
	trackCount = 3
): TimelineAlbumDetailSnapshot {
	return {
		artist: owner,
		album: ownedAlbum,
		orderedTrackTitles: Array.from({ length: trackCount }, (_, index) => `Track ${index + 1}`)
	};
}

async function loadArtist(
	store: ReturnType<typeof createTimelineBrowseSessionStore>,
	socket: FakeSocket,
	owner: ArtistRef,
	ownedAlbum: AlbumRef,
	generation = 1
): Promise<void> {
	const emissionIndex = socket.emissions.length;
	const pending = store.selectArtist(owner);
	const accepted = correlation(requestIdAt(socket, emissionIndex), generation);
	socket.acknowledge(emissionIndex, accepted);
	socket.deliver('timeline-artist:loaded', loaded(accepted, discography(owner, ownedAlbum)));
	await expect(pending).resolves.toMatchObject({ success: true });
}

async function loadAlbumDetail(
	store: ReturnType<typeof createTimelineBrowseSessionStore>,
	socket: FakeSocket,
	ownedAlbum: AlbumRef,
	owner: ArtistRef
): Promise<void> {
	const emissionIndex = socket.emissions.length;
	const pending = store.openAlbum(ownedAlbum.localId);
	const accepted = detailCorrelationAt(socket, emissionIndex);
	socket.emissions[emissionIndex].ack({ success: true, data: accepted });
	socket.deliver('timeline-detail:loaded', {
		...accepted,
		detail: detailSnapshot(owner, ownedAlbum)
	});
	await expect(pending).resolves.toMatchObject({ success: true });
}

describe('Timeline browse session store', () => {
	it('changes no working state and emits nothing when selection is disconnected', async () => {
		const socket = new FakeSocket();
		socket.connected = false;
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => false
		});
		const before = get(store);

		await expect(store.selectArtist(ARTIST_A)).resolves.toEqual({
			success: false,
			reason: 'not-ready'
		});
		expect(get(store)).toEqual(before);
		expect(socket.emissions).toHaveLength(0);
	});

	it('maps the Socket.IO error-first artist ack timeout without retaining its callback', async () => {
		const socket = new FakeSocket();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => 'artist-request',
			ackTimeoutMs: 10
		});

		const pending = store.selectArtist(ARTIST_A);
		expect(socket.emissions[0]).toMatchObject({
			event: 'timeline-artist:begin',
			timeoutMs: 10
		});
		expect(socket.pendingAckCount()).toBe(1);

		socket.emissions[0].expire();
		await expect(pending).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(socket.pendingAckCount()).toBe(0);
	});

	it('discards a late earlier artist-search response', async () => {
		const firstResponse = deferred<CatalogArtistSearchResponse>();
		const secondResponse = deferred<CatalogArtistSearchResponse>();
		const search = vi.fn((_fetch: typeof fetch, query: string) =>
			query === 'Björk' ? firstResponse.promise : secondResponse.promise
		);
		const store = createTimelineBrowseSessionStore({ search });
		const first = store.search('Björk');
		const second = store.search('Fever Ray');

		secondResponse.resolve(searchResponse('Fever Ray', [ARTIST_B]));
		await expect(second).resolves.toBe(true);
		firstResponse.resolve(searchResponse('Björk', [ARTIST_A]));
		await expect(first).resolves.toBe(false);
		expect(get(store)).toMatchObject({
			query: 'Fever Ray',
			candidates: [{ localId: ARTIST_B_ID }]
		});
	});

	it('keeps a failed search visible after it supersedes an in-flight status load', async () => {
		const statusResponse = deferred<CatalogStatus>();
		const store = createTimelineBrowseSessionStore({
			fetchStatus: () => statusResponse.promise,
			search: vi.fn().mockRejectedValue(new Error('artist endpoint unavailable'))
		});
		const loadingStatus = store.loadCatalogStatus();
		expect(get(store).statusPhase).toBe('loading');

		await expect(store.search('Björk')).resolves.toBe(false);
		expect(get(store)).toMatchObject({
			catalogStatus: null,
			statusPhase: 'idle',
			statusError: null,
			searchPhase: 'error',
			searchError: 'artist endpoint unavailable'
		});

		statusResponse.resolve(status());
		await expect(loadingStatus).resolves.toBe(false);
		expect(get(store)).toMatchObject({
			catalogStatus: null,
			statusPhase: 'idle',
			searchPhase: 'error',
			searchError: 'artist endpoint unavailable'
		});
	});

	it('allows only the newest overlapping selection to publish', async () => {
		const socket = new FakeSocket();
		const ids = ['request-a', 'request-b'];
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		const first = store.selectArtist(ARTIST_A);
		const firstRequestId = requestIdAt(socket, 0);
		const second = store.selectArtist(ARTIST_B);
		const secondRequestId = requestIdAt(socket, 1);
		const firstCorrelation = correlation(firstRequestId, 1);
		const secondCorrelation = correlation(secondRequestId, 2);

		socket.acknowledge(0, firstCorrelation);
		socket.acknowledge(1, secondCorrelation);
		socket.deliver(
			'timeline-artist:loaded',
			loaded(secondCorrelation, discography(ARTIST_B, album(ARTIST_B, ALBUM_B_ID, 'Plunge')))
		);
		socket.deliver(
			'timeline-artist:loaded',
			loaded(firstCorrelation, discography(ARTIST_A, album(ARTIST_A, ALBUM_A_ID, 'Homogenic')))
		);

		await expect(first).resolves.toMatchObject({ success: false, reason: 'superseded' });
		await expect(second).resolves.toMatchObject({ success: true });
		expect(get(store)).toMatchObject({
			selectionPhase: 'ready',
			selectedArtist: { localId: ARTIST_B_ID },
			session: { handleId: 'handle-2', generation: 2 }
		});
		expect(get(store).albums.map((value) => value.title)).toEqual(['Plunge']);
		expect(socket.handlerCount()).toBe(0);
	});

	it('uses a local bounded duration instead of subtracting controller and browser clocks', async () => {
		const socket = new FakeSocket();
		const delays: number[] = [];
		const clearTimer = vi.fn();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => 'request-a',
			maximumLoadWaitMs: 35_000,
			setTimer: (_callback, milliseconds) => {
				delays.push(milliseconds);
				return delays.length as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer
		});
		const pending = store.selectArtist(ARTIST_A);
		const accepted = {
			...correlation(requestIdAt(socket, 0), 1),
			loadingDeadlineAt: 1
		};

		socket.acknowledge(0, accepted);
		expect(delays).toEqual([5_000, 35_000]);
		socket.deliver(
			'timeline-artist:loaded',
			loaded(accepted, discography(ARTIST_A, album(ARTIST_A, ALBUM_A_ID, 'Homogenic')))
		);
		await expect(pending).resolves.toMatchObject({ success: true });
		expect(clearTimer).toHaveBeenCalledTimes(2);
		expect(socket.handlerCount()).toBe(0);
	});

	it('cleans listeners and timers after a malformed acknowledgment', async () => {
		const socket = new FakeSocket();
		const clearTimer = vi.fn();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => 'request-a',
			setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
			clearTimer
		});
		const pending = store.selectArtist(ARTIST_A);

		socket.emissions[0].ack({
			success: true,
			data: correlation('request-a', 1),
			extra: 'forbidden'
		});

		await expect(pending).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(socket.handlerCount()).toBe(0);
		expect(clearTimer).toHaveBeenCalledTimes(1);
		expect(get(store).selectionPhase).toBe('error');
	});

	it('refuses to publish a correlated load after socket or Core readiness is lost', async () => {
		const socket = new FakeSocket();
		let ready = true;
		const published = vi.fn();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => ready,
			getTabId: () => 'tab-a',
			createRequestId: () => 'request-a'
		});
		const pending = store.selectArtist(ARTIST_A, published);
		const accepted = correlation(requestIdAt(socket, 0), 1);
		socket.acknowledge(0, accepted);
		ready = false;
		socket.deliver(
			'timeline-artist:loaded',
			loaded(accepted, discography(ARTIST_A, album(ARTIST_A, ALBUM_A_ID, 'Homogenic')))
		);

		await expect(pending).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(published).not.toHaveBeenCalled();
		expect(get(store)).toMatchObject({
			selectionPhase: 'error',
			selectedArtist: null,
			discography: null,
			albums: [],
			session: null
		});
	});

	it('rejects a malformed matching event without replacing the prior timeline', async () => {
		const socket = new FakeSocket();
		const ids = ['request-a', 'request-b', 'release-request'];
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		const first = store.selectArtist(ARTIST_A);
		const firstCorrelation = correlation(requestIdAt(socket, 0), 1);
		socket.acknowledge(0, firstCorrelation);
		socket.deliver(
			'timeline-artist:loaded',
			loaded(firstCorrelation, discography(ARTIST_A, album(ARTIST_A, ALBUM_A_ID, 'Homogenic')))
		);
		await first;
		const priorArtist = get(store).selectedArtist;
		const priorAlbums = get(store).albums;

		const second = store.selectArtist(ARTIST_B);
		const secondCorrelation = correlation(requestIdAt(socket, 1), 2);
		socket.acknowledge(1, secondCorrelation);
		socket.deliver('timeline-artist:loaded', {
			...loaded(
				secondCorrelation,
				discography(ARTIST_B, album(ARTIST_B, ALBUM_B_ID, 'Plunge'))
			),
			itemKey: 'forbidden'
		});

		await expect(second).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(socket.emissions[2]).toMatchObject({
			event: 'timeline-session:release',
			value: {
				requestId: 'release-request',
				tabId: 'tab-a',
				session: { handleId: 'handle-2', generation: 2 }
			}
		});
		expect(get(store).selectionPhase).toBe('error');
		expect(get(store).selectedArtist).toBe(priorArtist);
		expect(get(store).albums).toBe(priorAlbums);
	});

	it('rolls back a newly loaded artist when fitted history publication throws', async () => {
		const socket = new FakeSocket();
		const ids = ['request-a', 'request-b'];
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		const first = store.selectArtist(ARTIST_A);
		const firstCorrelation = correlation(requestIdAt(socket, 0), 1);
		socket.acknowledge(0, firstCorrelation);
		socket.deliver(
			'timeline-artist:loaded',
			loaded(firstCorrelation, discography(ARTIST_A, album(ARTIST_A, ALBUM_A_ID, 'Homogenic')))
		);
		await first;
		const prior = get(store);
		const observedArtistIds: Array<string | null> = [];
		const unsubscribe = store.subscribe((value) => {
			observedArtistIds.push(value.selectedArtist?.localId ?? null);
		});
		observedArtistIds.length = 0;

		const second = store.selectArtist(ARTIST_B, () => {
			throw new Error('history write failed');
		});
		const secondCorrelation = correlation(requestIdAt(socket, 1), 2);
		socket.acknowledge(1, secondCorrelation);
		socket.deliver(
			'timeline-artist:loaded',
			loaded(secondCorrelation, discography(ARTIST_B, album(ARTIST_B, ALBUM_B_ID, 'Plunge')))
		);

		await expect(second).resolves.toMatchObject({
			success: false,
			reason: 'failed',
			error: 'history write failed'
		});
		expect(get(store)).toMatchObject({
			selectionPhase: 'error',
			selectedArtist: { localId: prior.selectedArtist?.localId },
			discography: prior.discography,
			albums: prior.albums,
			session: null,
			sessionPhase: 'none',
			recoveryRequired: true
		});
		expect(observedArtistIds).not.toContain(ARTIST_B_ID);
		unsubscribe();
	});

	it('creates request authority before mutating or canceling the visible state', async () => {
		const socket = new FakeSocket();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			createRequestId: () => {
				throw new Error('crypto unavailable');
			}
		});
		const before = get(store);

		await expect(store.selectArtist(ARTIST_A)).resolves.toEqual({
			success: false,
			reason: 'failed',
			error: 'crypto unavailable'
		});
		expect(get(store)).toEqual(before);
		expect(socket.emissions).toHaveLength(0);
	});

	it('creates production request authority from LAN-safe browser entropy', async () => {
		const socket = new FakeSocket();
		const getRandomValues = vi
			.spyOn(globalThis.crypto, 'getRandomValues')
			.mockImplementation(((bytes: Uint8Array) => {
				bytes.fill(0xaa);
				return bytes;
			}) as Crypto['getRandomValues']);
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a'
		});

		try {
			const pending = store.selectArtist(ARTIST_A);
			expect(socket.emissions[0].value).toMatchObject({
				requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
			});
			expect(getRandomValues).toHaveBeenCalledTimes(1);
			store.quiesce();
			await expect(pending).resolves.toMatchObject({
				success: false,
				reason: 'superseded'
			});
		} finally {
			getRandomValues.mockRestore();
		}
	});

	it('strictly rejects non-opaque generated request authority before mutation', async () => {
		const socket = new FakeSocket();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'shared tab',
			createRequestId: () => '../request'
		});
		const before = get(store);

		await expect(store.selectArtist(ARTIST_A)).resolves.toEqual({
			success: false,
			reason: 'failed',
			error: 'Timeline artist request could not be created'
		});
		expect(get(store)).toEqual(before);
		expect(socket.emissions).toHaveLength(0);
	});

	it('supersedes a pending artist load when a newer search intent starts', async () => {
		const socket = new FakeSocket();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => 'request-a',
			search: vi.fn().mockResolvedValue(searchResponse('Fever Ray', [ARTIST_B]))
		});
		const selection = store.selectArtist(ARTIST_A);

		await store.search('Fever Ray');

		await expect(selection).resolves.toMatchObject({
			success: false,
			reason: 'superseded'
		});
		expect(get(store)).toMatchObject({
			query: 'Fever Ray',
			selectionPhase: 'idle',
			selectedArtist: null
		});
	});

	it('clears an old selection failure when a new artist search starts', async () => {
		const socket = new FakeSocket();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => 'request-a',
			search: vi.fn().mockResolvedValue(searchResponse('Fever Ray', [ARTIST_B]))
		});
		const selection = store.selectArtist(ARTIST_A);
		socket.emissions[0].ack({
			success: false,
			code: 'ARTIST_NOT_FOUND',
			error: 'Artist was removed'
		});
		await selection;
		expect(get(store).selectionPhase).toBe('error');

		await store.search('Fever Ray');
		expect(get(store)).toMatchObject({
			selectionPhase: 'idle',
			selectionError: null,
			searchPhase: 'ready',
			candidates: [{ localId: ARTIST_B_ID }]
		});
	});

	it('fails selection without mutation when the visible catalog is persistence-degraded', async () => {
		const socket = new FakeSocket();
		const degraded = status({
			freshness: 'stale',
			staleReason: 'persistence-failed',
			persistence: 'degraded',
			lastProblem: { code: 'PERSISTENCE_WRITE_FAILED', occurredAt: AT }
		});
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			search: vi.fn().mockResolvedValue(searchResponse('Björk', [ARTIST_A], degraded))
		});
		await store.search('Björk');
		const before = get(store);

		await expect(store.selectArtist(ARTIST_A)).resolves.toEqual({
			success: false,
			reason: 'catalog-degraded'
		});
		expect(get(store)).toEqual(before);
		expect(socket.emissions).toHaveLength(0);
	});

	it('adopts one additive auxiliary hydration without changing the active session or canvas model', async () => {
		const socket = new FakeSocket();
		const pendingStatus = deferred<CatalogStatus>();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => 'request-a',
			fetchStatus: () => pendingStatus.promise
		});
		await loadArtist(
			store,
			socket,
			ARTIST_A,
			album(ARTIST_A, ALBUM_A_ID, 'Homogenic'),
			7
		);
		const before = get(store);
		const lateStatus = store.loadCatalogStatus();
		const hydrated = status({ revision: 3, artistCount: 3, albumCount: 3 });

		expect(store.adoptAuxiliaryArtistHydration(hydrated, 2)).toBe(true);
		const adopted = get(store);
		expect(adopted.catalogStatus).toEqual(hydrated);
		expect(adopted.discography?.status).toEqual(hydrated);
		expect(adopted.discography?.albums).toBe(before.discography?.albums);
		expect(adopted.albums).toBe(before.albums);
		expect(adopted.selectedArtist).toBe(before.selectedArtist);
		expect(adopted.session).toBe(before.session);
		expect(adopted.session?.generation).toBe(7);

		pendingStatus.resolve(status());
		await expect(lateStatus).resolves.toBe(false);
		expect(get(store).catalogStatus?.revision).toBe(3);
	});

	it('adopts hydration from a refreshed catalog when the selected discography still has the prior revision', async () => {
		const socket = new FakeSocket();
		const refreshed = status({ revision: 3, artistCount: 3, albumCount: 3 });
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => 'request-a',
			fetchStatus: vi.fn().mockResolvedValue(refreshed)
		});
		await loadArtist(
			store,
			socket,
			ARTIST_A,
			album(ARTIST_A, ALBUM_A_ID, 'Homogenic'),
			7
		);
		const before = get(store);

		await expect(store.loadCatalogStatus()).resolves.toBe(true);
		expect(get(store).catalogStatus).toEqual(refreshed);
		expect(get(store).discography?.status.revision).toBe(2);

		const hydrated = status({ revision: 4, artistCount: 4, albumCount: 4 });
		expect(store.adoptAuxiliaryArtistHydration(hydrated, 3)).toBe(true);
		const adopted = get(store);
		expect(adopted.catalogStatus).toEqual(hydrated);
		expect(adopted.discography?.status).toEqual(hydrated);
		expect(adopted.discography?.albums).toBe(before.discography?.albums);
		expect(adopted.albums).toBe(before.albums);
		expect(adopted.selectedArtist).toBe(before.selectedArtist);
		expect(adopted.session).toBe(before.session);
	});

	it('rejects auxiliary hydration adoption outside its exact additive revision envelope', async () => {
		for (const hydrated of [
			status({ coreId: 'core-b', revision: 3 }),
			status({ revision: 4 }),
			status({ revision: 3, refresh: 'running' })
		]) {
			const socket = new FakeSocket();
			const store = createTimelineBrowseSessionStore({
				getSocket: () => socket,
				isReady: () => true,
				getTabId: () => 'tab-a',
				createRequestId: () => 'request-a'
			});
			await loadArtist(store, socket, ARTIST_A, album(ARTIST_A, ALBUM_A_ID, 'Homogenic'));
			const before = get(store);
			expect(store.adoptAuxiliaryArtistHydration(hydrated, 2)).toBe(false);
			expect(get(store)).toBe(before);
		}
	});

	it('accepts an exact hydration revision even when reconciliation removes root placeholders', async () => {
		const socket = new FakeSocket();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => 'request-a'
		});
		await loadArtist(store, socket, ARTIST_A, album(ARTIST_A, ALBUM_A_ID, 'Homogenic'));

		const hydrated = status({ revision: 3, albumCount: 1 });
		expect(store.adoptAuxiliaryArtistHydration(hydrated, 2)).toBe(true);
		expect(get(store).catalogStatus).toEqual(hydrated);
		expect(get(store).discography?.status).toEqual(hydrated);
	});

	it('loads first-use status without automatically starting a catalog scan', async () => {
		const unavailable = status({
			freshness: 'empty',
			available: false,
			complete: false,
			revision: 0,
			artistCount: 0,
			albumCount: 0,
			updatedAt: undefined,
			lastCompleteScanAt: undefined
		});
		const fetchStatus = vi.fn().mockResolvedValue(unavailable);
		const refresh = vi.fn();
		const store = createTimelineBrowseSessionStore({ fetchStatus, refresh });

		await expect(store.loadCatalogStatus()).resolves.toBe(true);
		expect(fetchStatus).toHaveBeenCalledTimes(1);
		expect(refresh).not.toHaveBeenCalled();
		expect(get(store).catalogStatus).toEqual(unavailable);
	});

	it('surfaces a catalog-status transport failure and clears it on retry', async () => {
		const fetchStatus = vi
			.fn()
			.mockRejectedValueOnce(new Error('status endpoint unavailable'))
			.mockResolvedValueOnce(status());
		const refresh = vi.fn();
		const store = createTimelineBrowseSessionStore({ fetchStatus, refresh });

		await expect(store.loadCatalogStatus()).resolves.toBe(false);
		expect(get(store)).toMatchObject({
			statusPhase: 'error',
			statusError: 'status endpoint unavailable',
			catalogStatus: null
		});
		await expect(store.loadCatalogStatus()).resolves.toBe(true);
		expect(get(store)).toMatchObject({
			statusPhase: 'ready',
			statusError: null,
			catalogStatus: { freshness: 'fresh' }
		});
		expect(refresh).not.toHaveBeenCalled();
	});

	it('derives and clears local refresh failure state from idle status reloads', async () => {
		const failed = status({
			freshness: 'stale',
			staleReason: 'scan-failed',
			lastProblem: { code: 'SCAN_FAILED', occurredAt: AT }
		});
		const healthy = status();
		const fetchStatus = vi
			.fn()
			.mockResolvedValueOnce(failed)
			.mockResolvedValueOnce(healthy);
		const store = createTimelineBrowseSessionStore({ fetchStatus });

		await expect(store.loadCatalogStatus()).resolves.toBe(false);
		expect(get(store)).toMatchObject({
			refreshPhase: 'error',
			refreshError: expect.stringMatching(/scan failed/i)
		});
		store.quiesce();
		await expect(store.loadCatalogStatus()).resolves.toBe(true);
		expect(get(store)).toMatchObject({
			refreshPhase: 'idle',
			refreshError: null,
			catalogStatus: { freshness: 'fresh' }
		});
	});

	it('resumes bounded polling for a scan another tab already started without posting again', async () => {
		const running = status({ refresh: 'running' });
		const settled = status();
		const fetchStatus = vi
			.fn()
			.mockResolvedValueOnce(running)
			.mockResolvedValueOnce(settled);
		const refresh = vi.fn();
		const store = createTimelineBrowseSessionStore({
			fetchStatus,
			refresh,
			sleep: vi.fn().mockResolvedValue(undefined),
			maximumRefreshPolls: 2
		});

		await expect(store.loadCatalogStatus()).resolves.toBe(true);
		expect(fetchStatus).toHaveBeenCalledTimes(2);
		expect(refresh).not.toHaveBeenCalled();
		expect(get(store)).toMatchObject({
			refreshPhase: 'idle',
			refreshError: null,
			catalogStatus: { refresh: 'idle', available: true }
		});
	});

	it('lets a newer artist selection survive completion of an older refresh', async () => {
		const socket = new FakeSocket();
		const pollGate = deferred<void>();
		const running = status({ refresh: 'running' });
		const settled = status();
		const search = vi.fn().mockResolvedValue(searchResponse('Björk', [ARTIST_A]));
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => 'request-a',
			search,
			refresh: vi.fn().mockResolvedValue({ status: running }),
			fetchStatus: vi.fn().mockResolvedValue(settled),
			sleep: () => pollGate.promise,
			maximumRefreshPolls: 2
		});
		await store.search('Björk');
		const refreshing = store.refreshCatalog();
		await Promise.resolve();
		await Promise.resolve();
		const selection = store.selectArtist(ARTIST_A);
		const accepted = correlation(requestIdAt(socket, 0), 1);
		socket.acknowledge(0, accepted);

		pollGate.resolve();
		await expect(refreshing).resolves.toBe(true);
		expect(get(store).selectionPhase).toBe('loading');
		socket.deliver(
			'timeline-artist:loaded',
			loaded(accepted, discography(ARTIST_A, album(ARTIST_A, ALBUM_A_ID, 'Homogenic')))
		);
		await expect(selection).resolves.toMatchObject({ success: true });
		expect(get(store).selectedArtist?.localId).toBe(ARTIST_A_ID);
		expect(search).toHaveBeenCalledTimes(2);
	});

	it('keeps refresh ownership until its latest-query rerun settles', async () => {
		const rerun = deferred<CatalogArtistSearchResponse>();
		const search = vi
			.fn()
			.mockResolvedValueOnce(searchResponse('Björk', [ARTIST_A]))
			.mockReturnValueOnce(rerun.promise);
		const refresh = vi.fn().mockResolvedValue({ status: status() });
		const store = createTimelineBrowseSessionStore({ search, refresh });
		await store.search('Björk');

		const firstRefresh = store.refreshCatalog();
		await Promise.resolve();
		await Promise.resolve();
		expect(get(store).refreshPhase).toBe('running');
		await expect(store.refreshCatalog()).resolves.toBe(false);
		expect(refresh).toHaveBeenCalledTimes(1);

		rerun.resolve(searchResponse('Björk', [ARTIST_A]));
		await expect(firstRefresh).resolves.toBe(true);
		expect(get(store).refreshPhase).toBe('idle');
	});

	it('fails after the bounded refresh polling window without looping forever', async () => {
		const running = status({ refresh: 'running' });
		const fetchStatus = vi.fn().mockResolvedValue(running);
		const store = createTimelineBrowseSessionStore({
			refresh: vi.fn().mockResolvedValue({ status: running }),
			fetchStatus,
			sleep: vi.fn().mockResolvedValue(undefined),
			maximumRefreshPolls: 2
		});

		await expect(store.refreshCatalog()).resolves.toBe(false);
		expect(fetchStatus).toHaveBeenCalledTimes(2);
		expect(get(store)).toMatchObject({ refreshPhase: 'error' });
		expect(get(store).refreshError).toMatch(/bounded polling window/i);
	});

	it('stops an outstanding refresh poll when the mode quiesces', async () => {
		const running = status({ refresh: 'running' });
		const pollGate = deferred<void>();
		const fetchStatus = vi.fn();
		const store = createTimelineBrowseSessionStore({
			refresh: vi.fn().mockResolvedValue({ status: running }),
			fetchStatus,
			sleep: () => pollGate.promise,
			maximumRefreshPolls: 2
		});
		const pending = store.refreshCatalog();
		await Promise.resolve();
		await Promise.resolve();

		store.quiesce();
		pollGate.resolve();

		await expect(pending).resolves.toBe(false);
		expect(fetchStatus).not.toHaveBeenCalled();
		expect(get(store).refreshPhase).toBe('idle');
	});

	it.each([
		[
			'empty catalog',
			status({
				freshness: 'empty',
				available: false,
				complete: false,
				revision: 0,
				artistCount: 0,
				albumCount: 0,
				updatedAt: undefined,
				lastCompleteScanAt: undefined,
				lastProblem: { code: 'SCAN_FAILED', occurredAt: AT }
			})
		],
		[
			'stale prior snapshot',
			status({
				freshness: 'stale',
				staleReason: 'scan-failed',
				lastProblem: { code: 'SCAN_FAILED', occurredAt: AT }
			})
		]
	] as const)('surfaces a settled scan failure for an %s', async (_label, failedStatus) => {
		const runningStatus = { ...failedStatus, refresh: 'running' as const };
		const store = createTimelineBrowseSessionStore({
			refresh: vi.fn().mockResolvedValue({ status: runningStatus }),
			fetchStatus: vi.fn().mockResolvedValue(failedStatus),
			sleep: vi.fn().mockResolvedValue(undefined),
			maximumRefreshPolls: 2
		});

		await expect(store.refreshCatalog()).resolves.toBe(false);
		expect(get(store)).toMatchObject({
			refreshPhase: 'error',
			catalogStatus: { lastProblem: { code: 'SCAN_FAILED' } }
		});
		expect(get(store).refreshError).toMatch(/scan failed/i);
	});

	it('surfaces a refresh that settles with degraded persistence', async () => {
		const running = status({ refresh: 'running' });
		const degraded = status({
			freshness: 'stale',
			staleReason: 'persistence-failed',
			persistence: 'degraded',
			lastProblem: { code: 'PERSISTENCE_WRITE_FAILED', occurredAt: AT }
		});
		const store = createTimelineBrowseSessionStore({
			refresh: vi.fn().mockResolvedValue({ status: running }),
			fetchStatus: vi.fn().mockResolvedValue(degraded),
			sleep: vi.fn().mockResolvedValue(undefined),
			maximumRefreshPolls: 2
		});

		await expect(store.refreshCatalog()).resolves.toBe(false);
		expect(get(store)).toMatchObject({
			refreshPhase: 'error',
			catalogStatus: { persistence: 'degraded' }
		});
		expect(get(store).refreshError).toMatch(/persisted safely/i);
	});

	it('keeps unavailable distinct from zero matches and reruns the latest query after explicit refresh', async () => {
		const unavailable = status({
			freshness: 'empty',
			available: false,
			complete: false,
			revision: 0,
			artistCount: 0,
			albumCount: 0,
			updatedAt: undefined,
			lastCompleteScanAt: undefined
		});
		const availableEmpty = status({ artistCount: 0, albumCount: 0 });
		const search = vi
			.fn()
			.mockResolvedValueOnce(searchResponse('Björk', [], unavailable))
			.mockResolvedValueOnce(searchResponse('Björk', [], availableEmpty));
		const fetchStatus = vi.fn().mockResolvedValue(availableEmpty);
		const store = createTimelineBrowseSessionStore({
			search,
			refresh: vi.fn().mockResolvedValue({
				status: { ...unavailable, refresh: 'running' }
			}),
			fetchStatus,
			sleep: vi.fn().mockResolvedValue(undefined),
			maximumRefreshPolls: 2
		});

		await store.search('Björk');
		expect(get(store).catalogStatus?.available).toBe(false);
		await expect(store.refreshCatalog()).resolves.toBe(true);

		expect(fetchStatus).toHaveBeenCalledTimes(1);
		expect(search).toHaveBeenCalledTimes(2);
		expect(get(store)).toMatchObject({
			query: 'Björk',
			candidates: [],
			searchPhase: 'ready',
			refreshPhase: 'idle',
			catalogStatus: { available: true, complete: true }
		});
	});

	it('publishes strict album detail only after the semantic history callback succeeds', async () => {
		const socket = new FakeSocket();
		const ids = ['artist-request', 'detail-request'];
		const ownedAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		await loadArtist(store, socket, ARTIST_A, ownedAlbum);
		const observed = vi.fn(() => {
			expect(get(store)).toMatchObject({ detailPhase: 'loading', detail: null });
		});

		const pending = store.openAlbum(ALBUM_A_ID, observed);
		expect(socket.emissions[1].event).toBe('timeline-detail:begin');
		expect(socket.emissions[1].timeoutMs).toBe(5000);
		expect(socket.handlerCount()).toBeGreaterThan(0);
		const accepted = detailCorrelationAt(socket, 1);
		socket.emissions[1].ack({ success: true, data: accepted });
		socket.deliver('timeline-detail:loaded', {
			...accepted,
			detail: detailSnapshot(ARTIST_A, ownedAlbum)
		});

		await expect(pending).resolves.toMatchObject({ success: true });
		expect(observed).toHaveBeenCalledTimes(1);
		expect(get(store)).toMatchObject({
			detailPhase: 'ready',
			selectedAlbumLocalId: ALBUM_A_ID,
			selectedAlbumDescriptor: { localId: ALBUM_A_ID },
			detail: { orderedTrackTitles: ['Track 1', 'Track 2', 'Track 3'] },
			sessionPhase: 'live',
			recoveryRequired: false
		});
		expect(socket.handlerCount()).toBe(0);
	});

	it('treats a missing artist acknowledgment as uncertain authority but retains live authority after explicit rejection', async () => {
		const socket = new FakeSocket();
		const timers = new FakeTimers();
		const ids = ['artist-a', 'artist-b', 'artist-c'];
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected',
			setTimer: timers.set,
			clearTimer: timers.clear
		});
		await loadArtist(store, socket, ARTIST_A, detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic'));

		const rejected = store.selectArtist(ARTIST_B);
		socket.emissions[1].ack({
			success: false,
			code: 'ARTIST_NOT_FOUND',
			error: 'Artist was removed'
		});
		await expect(rejected).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(get(store)).toMatchObject({
			selectedArtist: { localId: ARTIST_A_ID },
			session: { handleId: 'handle-1' },
			sessionPhase: 'live'
		});

		const uncertain = store.selectArtist(ARTIST_B);
		timers.fireOnly();
		await expect(uncertain).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(get(store)).toMatchObject({
			selectedArtist: { localId: ARTIST_A_ID },
			session: null,
			sessionPhase: 'none',
			recoveryRequired: true
		});
	});

	it('stales a live session after an unacknowledged detail request while retaining its semantic marker', async () => {
		const socket = new FakeSocket();
		const timers = new FakeTimers();
		const ids = ['artist-request', 'detail-request'];
		const ownedAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected',
			setTimer: timers.set,
			clearTimer: timers.clear
		});
		await loadArtist(store, socket, ARTIST_A, ownedAlbum);

		const pending = store.openAlbum(ALBUM_A_ID);
		timers.fireOnly();
		await expect(pending).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(get(store)).toMatchObject({
			selectedAlbumLocalId: ALBUM_A_ID,
			selectedAlbumDescriptor: { localId: ALBUM_A_ID },
			detail: null,
			sessionPhase: 'stale',
			recoveryRequired: true
		});
	});

	it('retains live detail authority after a valid explicit detail rejection', async () => {
		const socket = new FakeSocket();
		const ids = ['artist-request', 'detail-request'];
		const ownedAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		await loadArtist(store, socket, ARTIST_A, ownedAlbum);

		const pending = store.openAlbum(ALBUM_A_ID);
		socket.emissions[1].ack({
			success: false,
			code: 'DETAIL_UNAVAILABLE',
			error: 'Detail unavailable'
		});
		await expect(pending).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(get(store)).toMatchObject({
			selectedAlbumLocalId: ALBUM_A_ID,
			sessionPhase: 'live',
			recoveryRequired: false
		});
	});

	it('stales live authority when a detail emit throws after the attempt begins', async () => {
		const socket = new FakeSocket();
		const ids = ['artist-request', 'detail-request'];
		const ownedAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		await loadArtist(store, socket, ARTIST_A, ownedAlbum);
		socket.failNextBoundedEmit(new Error('transport write failed'));

		await expect(store.openAlbum(ALBUM_A_ID)).resolves.toMatchObject({
			success: false,
			reason: 'failed',
			error: 'transport write failed'
		});
		expect(get(store)).toMatchObject({
			selectedAlbumLocalId: ALBUM_A_ID,
			sessionPhase: 'stale',
			recoveryRequired: true
		});
	});

	it('stales close authority after an invalid acknowledgment but retains it after explicit rejection', async () => {
		const makeLoadedStore = async () => {
			const socket = new FakeSocket();
			const ids = ['artist-request', 'detail-request', 'close-request'];
			const ownedAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
			const store = createTimelineBrowseSessionStore({
				getSocket: () => socket,
				isReady: () => true,
				getTabId: () => 'tab-a',
				createRequestId: () => ids.shift() ?? 'unexpected'
			});
			await loadArtist(store, socket, ARTIST_A, ownedAlbum);
			await loadAlbumDetail(store, socket, ownedAlbum, ARTIST_A);
			return { socket, store };
		};

		const invalid = await makeLoadedStore();
		const invalidClose = invalid.store.closeAlbumDetail(ARTIST_A_ID);
		expect(invalid.socket.emissions[2].timeoutMs).toBe(5000);
		invalid.socket.emissions[2].ack({ success: true, data: { forbidden: true } });
		await expect(invalidClose).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(get(invalid.store)).toMatchObject({
			detail: { album: { localId: ALBUM_A_ID } },
			sessionPhase: 'stale',
			recoveryRequired: true
		});

		const rejected = await makeLoadedStore();
		const rejectedClose = rejected.store.closeAlbumDetail(ARTIST_A_ID);
		expect(rejected.socket.emissions[2].timeoutMs).toBe(5000);
		rejected.socket.emissions[2].ack({
			success: false,
			code: 'INTERNAL_ERROR',
			error: 'Close was rejected'
		});
		await expect(rejectedClose).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(get(rejected.store)).toMatchObject({
			detail: { album: { localId: ALBUM_A_ID } },
			sessionPhase: 'live',
			recoveryRequired: false
		});
	});

	it('lets a close intent supersede an auxiliary detail preflight before it can emit', async () => {
		const socket = new FakeSocket();
		const auxiliary = deferred<CatalogArtistAlbumsResponse>();
		const ids = ['artist-request', 'detail-request', 'close-request', 'unexpected-detail'];
		const baseAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		const auxiliaryAlbum = detailedAlbum(ARTIST_B, ALBUM_B_ID, 'Plunge');
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'exhausted',
			fetchArtistAlbums: (_fetch, localId) =>
				localId === ARTIST_B_ID ? auxiliary.promise : Promise.resolve(discography(ARTIST_A, baseAlbum))
		});
		await loadArtist(store, socket, ARTIST_A, baseAlbum);
		await loadAlbumDetail(store, socket, baseAlbum, ARTIST_A);

		const opening = store.openAlbum(ALBUM_B_ID, undefined, ARTIST_B_ID);
		const closing = store.closeAlbumDetail(ARTIST_A_ID);
		expect(socket.emissions[2].event).toBe('timeline-detail:close');
		socket.emissions[2].ack({
			success: false,
			code: 'INTERNAL_ERROR',
			error: 'Close was rejected'
		});
		auxiliary.resolve(discography(ARTIST_B, auxiliaryAlbum));

		await expect(opening).resolves.toMatchObject({ success: false, reason: 'superseded' });
		await expect(closing).resolves.toMatchObject({ success: false, reason: 'failed' });
		expect(socket.emissions.filter((emission) => emission.event === 'timeline-detail:begin')).toHaveLength(1);
	});

	it.each(['artist selection', 'snapshot restore', 'mode quiesce'] as const)(
		'lets %s supersede a deferred auxiliary detail preflight',
		async (supersedingIntent) => {
			const socket = new FakeSocket();
			const auxiliary = deferred<CatalogArtistAlbumsResponse>();
			const ids = ['artist-request', 'detail-request', 'selection-request', 'unexpected-detail'];
			const baseAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
			const auxiliaryAlbum = detailedAlbum(ARTIST_B, ALBUM_B_ID, 'Plunge');
			const store = createTimelineBrowseSessionStore({
				getSocket: () => socket,
				isReady: () => true,
				getTabId: () => 'tab-a',
				createRequestId: () => ids.shift() ?? 'exhausted',
				fetchArtistAlbums: (_fetch, localId) =>
					localId === ARTIST_B_ID
						? auxiliary.promise
						: Promise.resolve(discography(ARTIST_A, baseAlbum))
			});
			await loadArtist(store, socket, ARTIST_A, baseAlbum);
			await loadAlbumDetail(store, socket, baseAlbum, ARTIST_A);
			const opening = store.openAlbum(ALBUM_B_ID, undefined, ARTIST_B_ID);

			if (supersedingIntent === 'artist selection') {
				const selection = store.selectArtist(ARTIST_B);
				expect(socket.emissions[2].event).toBe('timeline-artist:begin');
				socket.emissions[2].ack({
					success: false,
					code: 'ARTIST_NOT_FOUND',
					error: 'Selection rejected'
				});
				await expect(selection).resolves.toMatchObject({ success: false, reason: 'failed' });
			} else if (supersedingIntent === 'snapshot restore') {
				await expect(store.restoreSnapshot({
					artistQuery: '',
					selectedArtistLocalId: null,
					activeSemanticPath: [],
					selectedNode: null,
					camera: { x: 0, y: 0, scale: 1 },
					displayDepth: 0
				})).resolves.toBe(true);
			} else {
				store.quiesce();
			}

			auxiliary.resolve(discography(ARTIST_B, auxiliaryAlbum));
			await expect(opening).resolves.toMatchObject({ success: false, reason: 'superseded' });
			expect(
				socket.emissions.filter((emission) => emission.event === 'timeline-detail:begin')
			).toHaveLength(1);
		}
	);

	it('bounds reconnect acknowledgments with the same session deadline', async () => {
		const socket = new FakeSocket();
		const ids = ['artist-request', 'reconnect-request'];
		const ownedAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		await loadArtist(store, socket, ARTIST_A, ownedAlbum, 7);
		store.connectionLost();

		const reconnecting = store.reconnectSession();
		const emission = socket.emissions[1];
		const request = emission.value as {
			requestId: string;
			session: { handleId: string; generation: number };
		};
		expect(emission).toMatchObject({
			event: 'timeline-session:reconnect',
			timeoutMs: 5000
		});
		emission.ack({
			success: true,
			data: { requestId: request.requestId, session: request.session }
		});

		await expect(reconnecting).resolves.toBe(true);
		expect(socket.pendingAckCount()).toBe(0);
	});

	it('drains bounded release acknowledgments across twenty fresh mode lifecycles', async () => {
		const socket = new FakeSocket();
		const ownedAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		let request = 0;

		for (let cycle = 0; cycle < 20; cycle += 1) {
			const store = createTimelineBrowseSessionStore({
				getSocket: () => socket,
				isReady: () => true,
				getTabId: () => 'tab-a',
				createRequestId: () => `request-${++request}`,
				ackTimeoutMs: 7
			});
			await loadArtist(store, socket, ARTIST_A, ownedAlbum, cycle + 1);
			const begin = socket.emissions[socket.emissions.length - 1];
			expect(begin).toMatchObject({ event: 'timeline-artist:begin', timeoutMs: 7 });

			store.quiesce();
			const release = socket.emissions[socket.emissions.length - 1];
			expect(release).toMatchObject({ event: 'timeline-session:release', timeoutMs: 7 });
			expect(socket.pendingAckCount()).toBe(1);

			socket.expirePendingAcks();
			expect(socket.pendingAckCount()).toBe(0);
			store.destroy();
		}

		expect(socket.ackTimeouts).toHaveLength(40);
		expect(socket.ackTimeouts.every((milliseconds) => milliseconds === 7)).toBe(true);
	});

	it('releases an acknowledged in-flight artist generation exactly once when quiesced', async () => {
		const socket = new FakeSocket();
		const ids = ['artist-request', 'release-request'];
		const onPublished = vi.fn();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		const pending = store.selectArtist(ARTIST_A, onPublished);
		const accepted = correlation(requestIdAt(socket, 0), 7);
		socket.acknowledge(0, accepted);

		store.quiesce();

		await expect(pending).resolves.toMatchObject({ success: false, reason: 'superseded' });
		expect(socket.emissions[1]).toMatchObject({
			event: 'timeline-session:release',
			value: {
				requestId: 'release-request',
				tabId: 'tab-a',
				session: { handleId: 'handle-7', generation: 7 }
			}
		});
		socket.acknowledge(0, accepted);
		socket.deliver(
			'timeline-artist:loaded',
			loaded(accepted, discography(ARTIST_A, detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic')))
		);
		expect(socket.emissions).toHaveLength(2);
		expect(onPublished).not.toHaveBeenCalled();
		expect(get(store)).toMatchObject({
			selectedArtist: null,
			session: null,
			sessionPhase: 'none'
		});
	});

	it('releases a late artist acknowledgment that arrives after quiesce', async () => {
		const socket = new FakeSocket();
		const ids = ['artist-request', 'release-request'];
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		const pending = store.selectArtist(ARTIST_A);
		const accepted = correlation(requestIdAt(socket, 0), 8);

		store.quiesce();
		await expect(pending).resolves.toMatchObject({ success: false, reason: 'superseded' });
		expect(socket.emissions).toHaveLength(1);

		socket.acknowledge(0, accepted);
		expect(socket.emissions[1]).toMatchObject({
			event: 'timeline-session:release',
			value: {
				requestId: 'release-request',
				tabId: 'tab-a',
				session: { handleId: 'handle-8', generation: 8 }
			}
		});
		socket.acknowledge(0, accepted);
		expect(socket.emissions).toHaveLength(2);
		expect(get(store).session).toBeNull();
	});

	it('best-effort releases and immediately discards a settled live session when the mode quiesces', async () => {
		const socket = new FakeSocket();
		const ids = ['artist-request', 'release-request'];
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		await loadArtist(store, socket, ARTIST_A, detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic'));
		store.quiesce();
		expect(socket.emissions[1]).toMatchObject({
			event: 'timeline-session:release',
			value: {
				requestId: 'release-request',
				tabId: 'tab-a',
				session: { handleId: 'handle-1', generation: 1 }
			}
		});
		expect(get(store)).toMatchObject({
			selectedArtist: null,
			albums: [],
			session: null,
			sessionPhase: 'none',
			recoveryRequired: false
		});
		socket.emissions[1].ack({
			success: true,
			data: {
				requestId: 'release-request',
				session: { handleId: 'handle-1', generation: 1 }
			}
		});
		store.quiesce();
		expect(socket.emissions).toHaveLength(2);
		expect(get(store).session).toBeNull();
	});

	it('discards local authority when advisory release identity is unavailable', async () => {
		const socket = new FakeSocket();
		let requestCount = 0;
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => {
				if (requestCount++ === 0) return 'artist-request';
				throw new Error('release identity unavailable');
			}
		});
		await loadArtist(store, socket, ARTIST_A, detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic'));

		store.quiesce();

		expect(socket.emissions).toHaveLength(1);
		expect(get(store)).toMatchObject({
			selectedArtist: null,
			session: null,
			sessionPhase: 'none',
			recoveryRequired: false
		});
	});

	it('releases and forgets authority when quiesce supersedes an emitted detail with no acknowledgment', async () => {
		const socket = new FakeSocket();
		const ids = ['artist-request', 'detail-request', 'release-request'];
		const ownedAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected'
		});
		await loadArtist(store, socket, ARTIST_A, ownedAlbum);
		const pending = store.openAlbum(ALBUM_A_ID);

		store.quiesce();

		await expect(pending).resolves.toMatchObject({ success: false, reason: 'superseded' });
		expect(socket.emissions[2]).toMatchObject({
			event: 'timeline-session:release',
			value: { session: { handleId: 'handle-1', generation: 1 } }
		});
		expect(get(store)).toMatchObject({
			selectedAlbumLocalId: null,
			session: null,
			sessionPhase: 'none',
			recoveryRequired: false
		});
	});

	it('restores an artist through a fresh live session before album activation', async () => {
		setCoreStatus({
			status: 'paired',
			core: { id: 'core-a', displayName: 'Test Core', displayVersion: '1' }
		});
		const socket = new FakeSocket();
		const ids = ['artist-request', 'detail-request'];
		const ownedAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected',
			fetchArtistAlbums: vi.fn().mockResolvedValue(discography(ARTIST_A, ownedAlbum))
		});

		const restoring = store.restoreSnapshot({
			artistQuery: 'Björk',
			selectedArtistLocalId: ARTIST_A_ID,
			activeSemanticPath: [{ kind: 'artist', localId: ARTIST_A_ID }],
			selectedNode: { kind: 'artist', localId: ARTIST_A_ID },
			camera: { x: 0, y: 0, scale: 1 },
			displayDepth: 0
		});
		await vi.waitFor(() => expect(socket.emissions[0]?.event).toBe('timeline-artist:begin'));
		const acceptedArtist = correlation(requestIdAt(socket, 0), 1);
		socket.acknowledge(0, acceptedArtist);
		socket.deliver('timeline-artist:loaded', loaded(acceptedArtist, discography(ARTIST_A, ownedAlbum)));
		await expect(restoring).resolves.toBe(true);
		expect(get(store)).toMatchObject({
			selectedArtist: { localId: ARTIST_A_ID },
			session: { handleId: 'handle-1', generation: 1 },
			sessionPhase: 'live'
		});
		expect(socket.emissions).toHaveLength(1);

		const opening = store.openAlbum(ALBUM_A_ID);
		await vi.waitFor(() => expect(socket.emissions[1]?.event).toBe('timeline-detail:begin'));
		const acceptedDetail = detailCorrelationAt(socket, 1);
		socket.emissions[1].ack({ success: true, data: acceptedDetail });
		socket.deliver('timeline-detail:loaded', {
			...acceptedDetail,
			detail: detailSnapshot(ARTIST_A, ownedAlbum)
		});
		await expect(opening).resolves.toMatchObject({ success: true });
	});

	it('retains only the selected missing album as a Resolve required anchor without acquiring authority', async () => {
		setCoreStatus({
			status: 'paired',
			core: { id: 'core-a', displayName: 'Test Core', displayVersion: '1' }
		});
		const socket = new FakeSocket();
		const missingTarget: AlbumRef = {
			...album(ARTIST_A, ALBUM_A_ID, 'Historical Missing'),
			resolutionStatus: 'missing'
		};
		const otherMissing: AlbumRef = {
			...album(ARTIST_A, ALBUM_B_ID, 'Other Missing'),
			resolutionStatus: 'missing'
		};
		const catalog = discographyWithAlbums(ARTIST_A, [missingTarget, otherMissing]);
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			fetchArtistAlbums: vi.fn().mockResolvedValue(catalog)
		});

		await expect(store.restoreSnapshot({
			artistQuery: 'Björk',
			selectedArtistLocalId: ARTIST_A_ID,
			activeSemanticPath: [
				{ kind: 'artist', localId: ARTIST_A_ID },
				{ kind: 'album', localId: ALBUM_A_ID }
			],
			selectedNode: { kind: 'album', localId: ALBUM_A_ID },
			camera: { x: 0, y: 0, scale: 1 },
			displayDepth: 1
		})).resolves.toBe(false);

		expect(get(store)).toMatchObject({
			selectedArtist: { localId: ARTIST_A_ID },
			selectedAlbumLocalId: ALBUM_A_ID,
			selectedAlbumDescriptor: { localId: ALBUM_A_ID, resolutionStatus: 'missing' },
			detailPhase: 'error',
			detailFailureCode: 'ALBUM_NOT_FOUND',
			session: null,
			sessionPhase: 'none',
			recoveryRequired: false
		});
		expect(get(store).albums.map(({ localId }) => localId)).toEqual([ALBUM_A_ID]);
		expect(socket.emissions).toHaveLength(0);
	});

	it('restores auxiliary album detail without replacing the base canvas artist', async () => {
		setCoreStatus({
			status: 'paired',
			core: { id: 'core-a', displayName: 'Test Core', displayVersion: '1' }
		});
		const socket = new FakeSocket();
		const ids = ['artist-request', 'detail-request'];
		const baseAlbum = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		const auxiliaryAlbum = detailedAlbum(ARTIST_B, ALBUM_B_ID, 'Plunge');
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => ids.shift() ?? 'unexpected',
			fetchArtistAlbums: (_fetch, localId) =>
				Promise.resolve(
					localId === ARTIST_A_ID
						? discography(ARTIST_A, baseAlbum)
						: discography(ARTIST_B, auxiliaryAlbum)
				)
		});
		const restoring = store.restoreSnapshot({
			artistQuery: 'Björk',
			selectedArtistLocalId: ARTIST_A_ID,
			activeSemanticPath: [
				{ kind: 'artist', localId: ARTIST_A_ID },
				{ kind: 'auxiliary-artist', localId: ARTIST_B_ID },
				{ kind: 'album', localId: ALBUM_B_ID }
			],
			selectedNode: { kind: 'album', localId: ALBUM_B_ID },
			camera: { x: 10, y: 20, scale: 0.75 },
			displayDepth: 2
		});

		await vi.waitFor(() => expect(socket.emissions[0]?.event).toBe('timeline-artist:begin'));
		const acceptedArtist = correlation(requestIdAt(socket, 0), 1);
		socket.acknowledge(0, acceptedArtist);
		socket.deliver('timeline-artist:loaded', loaded(acceptedArtist, discography(ARTIST_A, baseAlbum)));
		await vi.waitFor(() => expect(socket.emissions[1]?.event).toBe('timeline-detail:begin'));
		expect(socket.emissions[1].value).toMatchObject({
			artistLocalId: ARTIST_B_ID,
			albumLocalId: ALBUM_B_ID
		});
		expect(get(store).selectedArtist?.localId).toBe(ARTIST_A_ID);
		const acceptedDetail = detailCorrelationAt(socket, 1);
		socket.emissions[1].ack({ success: true, data: acceptedDetail });
		socket.deliver('timeline-detail:loaded', {
			...acceptedDetail,
			detail: detailSnapshot(ARTIST_B, auxiliaryAlbum)
		});

		await expect(restoring).resolves.toBe(true);
		expect(get(store)).toMatchObject({
			selectedArtist: { localId: ARTIST_A_ID },
			detail: { artist: { localId: ARTIST_B_ID }, album: { localId: ALBUM_B_ID } },
			sessionPhase: 'live',
			recoveryRequired: false
		});
	});

	it('prevents an older catalog restore from publishing after a newer target', async () => {
		setCoreStatus({
			status: 'paired',
			core: { id: 'core-a', displayName: 'Test Core', displayVersion: '1' }
		});
		const firstCatalog = deferred<CatalogArtistAlbumsResponse>();
		const socket = new FakeSocket();
		const albumA = detailedAlbum(ARTIST_A, ALBUM_A_ID, 'Homogenic');
		const albumB = detailedAlbum(ARTIST_B, ALBUM_B_ID, 'Plunge');
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			getTabId: () => 'tab-a',
			createRequestId: () => 'artist-b-request',
			fetchArtistAlbums: (_fetch, localId) =>
				localId === ARTIST_A_ID
					? firstCatalog.promise
					: Promise.resolve(discography(ARTIST_B, albumB))
		});
		const snapshotFor = (owner: ArtistRef) => ({
			artistQuery: owner.exactName,
			selectedArtistLocalId: owner.localId,
			activeSemanticPath: [{ kind: 'artist' as const, localId: owner.localId }],
			selectedNode: { kind: 'artist' as const, localId: owner.localId },
			camera: { x: 0, y: 0, scale: 1 },
			displayDepth: 0
		});
		const first = store.restoreSnapshot(snapshotFor(ARTIST_A));
		const second = store.restoreSnapshot(snapshotFor(ARTIST_B));

		await vi.waitFor(() => expect(socket.emissions[0]?.event).toBe('timeline-artist:begin'));
		const accepted = correlation(requestIdAt(socket, 0), 1);
		socket.acknowledge(0, accepted);
		socket.deliver('timeline-artist:loaded', loaded(accepted, discography(ARTIST_B, albumB)));
		await expect(second).resolves.toBe(true);
		firstCatalog.resolve(discography(ARTIST_A, albumA));
		await expect(first).resolves.toBe(false);
		expect(get(store)).toMatchObject({
			query: ARTIST_B.exactName,
			selectedArtist: { localId: ARTIST_B_ID },
			session: { handleId: 'handle-1', generation: 1 }
		});
	});

	it('ignores every public async entry point after destruction', async () => {
		const socket = new FakeSocket();
		const fetchStatus = vi.fn();
		const refresh = vi.fn();
		const search = vi.fn();
		const store = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			fetchStatus,
			refresh,
			search
		});
		store.destroy();
		const before = get(store);

		await expect(store.loadCatalogStatus()).resolves.toBe(false);
		await expect(store.search('Björk')).resolves.toBe(false);
		await expect(store.refreshCatalog()).resolves.toBe(false);
		await expect(store.selectArtist(ARTIST_A)).resolves.toMatchObject({
			success: false,
			reason: 'not-ready'
		});
		expect(get(store)).toEqual(before);
		expect(fetchStatus).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(search).not.toHaveBeenCalled();
		expect(socket.emissions).toHaveLength(0);
	});
});
