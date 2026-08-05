import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { get, writable } from 'svelte/store';
import {
	CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
	normalizeCatalogArtistAlbumsResponse,
	normalizeCatalogArtistSearchResponse,
	normalizeCatalogText,
	type AlbumRef,
	type ArtistRef,
	type CatalogArtistAlbumsResponse,
	type CatalogStatus
} from '@shared/timelineCatalogContracts';
import type { Zone } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cameraCssTransform,
	createTimelineCanvasModel,
	fitCamera,
	projectTimelineCanvasModel,
	zoomCameraAtPoint,
	type TimelineAlbumLayoutInput
} from '$lib/timeline';
import {
	pushLibraryPageState,
	replaceLibraryPageState
} from '$lib/libraryPageNavigation';
import { ApiError } from '$lib/api/client';
import {
	buildLibraryPageStateEnvelope,
	buildTimelineLibraryPageState
} from '$lib/libraryPageState';
import type { LibraryIntent } from '$lib/libraryIntent';
import {
	LIBRARY_MODE_ACTIVATION_CONTEXT,
	type LibraryModeActivationContext,
	type LibraryModeLifecycle
} from '$lib/libraryModeActivationContext';
import { setCoreStatus } from '$lib/stores/coreStore';
import { setSocketStatus } from '$lib/stores/socketStatusStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import {
	clearCommandFeedback,
	commandFeedbackStore
} from '$lib/stores/commandFeedbackStore';
import {
	publishLibraryIntent,
	pendingLibraryIntentStore,
	resetLibraryIntentStore
} from '$lib/stores/libraryIntentStore';
import {
	claimLibraryViewHost,
	libraryViewHostStore,
	type LibraryViewHostActivationOutcome,
	type LibraryViewHostPublisher
} from '$lib/stores/libraryViewHostStore';
import {
	createCanvasWorkspaceStore,
	resetCanvasWorkspaceStore
} from '$lib/stores/canvasWorkspaceStore';
import type {
	TimelineBrowseSessionState,
	TimelineBrowseSessionStore,
	TimelineDetailPublication,
	TimelineSelectionPublication
} from '$lib/stores/timelineBrowseSessionStore';
import { createTimelineBrowseSessionStore } from '$lib/stores/timelineBrowseSessionStore';
import {
	createTimelineBranchStore,
	type TimelineBranchStore
} from '$lib/stores/timelineBranchStore';
import {
	TimelineAlbumActionController,
	type TimelineAlbumActionSocket
} from '$lib/timeline/TimelineAlbumActionController';
import TimelineLibraryMode from '../TimelineLibraryMode.svelte';
import TimelineModeActivationHost from './fixtures/TimelineModeActivationHost.svelte';
import {
	__resetTestPage,
	__setTestPage
} from '../../../test/app-stubs/state.svelte';

vi.mock('$lib/libraryPageNavigation', () => ({
	pushLibraryPageState: vi.fn(() => true),
	replaceLibraryPageState: vi.fn(() => true)
}));

const AT = '2026-07-15T00:00:00.000Z';
const ARTIST_ID = '10000000-0000-4000-8000-000000000001';
const ALBUM_ID = '20000000-0000-4000-8000-000000000001';
const AUX_ARTIST_ID = '10000000-0000-4000-8000-000000000002';
const AUX_ALBUM_ID = '20000000-0000-4000-8000-000000000002';
const TRACK_FINGERPRINT = 'b'.repeat(64);

type ManualAnimationFrames = {
	flush(): void;
	invokeCancelled(): void;
	readonly pending: number;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function installManualAnimationFrames(): ManualAnimationFrames {
	let nextHandle = 1;
	const pending = new Map<number, FrameRequestCallback>();
	const retained = new Map<number, FrameRequestCallback>();
	vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
		const handle = nextHandle++;
		pending.set(handle, callback);
		retained.set(handle, callback);
		return handle;
	}));
	vi.stubGlobal('cancelAnimationFrame', vi.fn((handle: number) => {
		pending.delete(handle);
	}));
	return {
		flush() {
			const callbacks = [...pending.values()];
			pending.clear();
			for (const callback of callbacks) callback(0);
		},
		invokeCancelled() {
			const callbacks = [...retained.values()];
			retained.clear();
			for (const callback of callbacks) callback(0);
		},
		get pending() {
			return pending.size;
		}
	};
}

function installSynchronousPointerCapture(viewport: HTMLElement) {
	const captured = new Set<number>();
	const dispatchLost = (pointerId: number) => {
		if (!captured.delete(pointerId)) return;
		const event = new Event('lostpointercapture');
		Object.defineProperty(event, 'pointerId', { value: pointerId });
		viewport.dispatchEvent(event);
	};
	const setPointerCapture = vi.fn((pointerId: number) => captured.add(pointerId));
	const releasePointerCapture = vi.fn((pointerId: number) => dispatchLost(pointerId));
	const hasPointerCapture = vi.fn((pointerId: number) => captured.has(pointerId));
	Object.defineProperties(viewport, {
		setPointerCapture: { configurable: true, value: setPointerCapture },
		releasePointerCapture: { configurable: true, value: releasePointerCapture },
		hasPointerCapture: { configurable: true, value: hasPointerCapture }
	});
	return {
		captured,
		lose: dispatchLost,
		setPointerCapture,
		releasePointerCapture
	};
}

interface AlbumActionEmission {
	readonly event: string;
	readonly value: unknown;
	readonly timeoutMs: number;
	readonly ack: (value: unknown) => void;
}

class TimelineAlbumActionTestSocket implements TimelineAlbumActionSocket {
	connected = true;
	readonly emissions: AlbumActionEmission[] = [];
	readonly ackTimeouts: number[] = [];
	onEmission: ((emission: AlbumActionEmission) => void) | null = null;
	readonly #handlers = new Map<string, Set<(value: unknown) => void>>();

	on(event: string, handler: (value: unknown) => void): this {
		const handlers = this.#handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.#handlers.set(event, handlers);
		return this;
	}

	off(event: string, handler: (value: unknown) => void): this {
		this.#handlers.get(event)?.delete(handler);
		return this;
	}

	timeout(milliseconds: number): {
			emit: (
				event: string,
				value: unknown,
				ack: (error: unknown, response?: unknown) => void
		) => TimelineAlbumActionTestSocket;
	} {
		this.ackTimeouts.push(milliseconds);
		return {
			emit: (event, value, ack) => {
				let pending = true;
				const emission: AlbumActionEmission = {
					event,
					value,
					timeoutMs: milliseconds,
					ack: (response) => {
						if (!pending) return;
						pending = false;
						ack(null, response);
					}
				};
				this.emissions.push(emission);
				this.onEmission?.(emission);
				return this;
			}
		};
	}

	serverEmit(event: string, value: unknown): void {
		for (const handler of [...(this.#handlers.get(event) ?? [])]) handler(value);
	}

	emission(event: string, index = 0): AlbumActionEmission {
		const emission = this.emissions.filter((candidate) => candidate.event === event)[index];
		if (!emission) throw new Error(`Missing ${event} emission ${index}`);
		return emission;
	}

	count(event: string): number {
		return this.emissions.filter((candidate) => candidate.event === event).length;
	}
}

function timelineActionController(
	socket: TimelineAlbumActionTestSocket,
	requestId = 'timeline-mode-request'
): TimelineAlbumActionController {
	return new TimelineAlbumActionController({
		getSocket: () => socket,
		createRequestId: () => requestId,
		now: () => 1_000
	});
}

function acceptTimelineAlbumAction(
	socket: TimelineAlbumActionTestSocket,
	requestId = 'timeline-mode-request',
	operationId = 'timeline-mode-operation'
): void {
	socket.emission('album-action:begin').ack({
		success: true,
		data: { requestId, operationId, resolvingDeadlineAt: 50_000 }
	});
}

function resolveTimelineAlbumActions(
	socket: TimelineAlbumActionTestSocket,
	requestId = 'timeline-mode-request',
	operationId = 'timeline-mode-operation'
): void {
	socket.serverEmit('album-action:resolved', {
		requestId,
		operationId,
		generation: 7,
		choosingDeadlineAt: 80_000,
		actions: [
			{ actionId: 'opaque-play', label: 'Play Now', semantic: 'play-now' },
			{ actionId: 'opaque-queue', label: 'Queue', semantic: 'queue' }
		]
	});
}

function timelineZone(
	id: string,
	name: string,
	outputIds: readonly string[] = [`${id}-output`]
): Zone {
	return {
		zone_id: id,
		display_name: name,
		state: 'stopped',
		is_play_allowed: true,
		is_pause_allowed: false,
		is_previous_allowed: false,
		is_next_allowed: false,
		is_seek_allowed: false,
		outputs: outputIds.map((outputId) => ({
			output_id: outputId,
			display_name: outputId
		}))
	};
}

function testRect(left: number, top: number, right: number, bottom: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		right,
		bottom,
		width: right - left,
		height: bottom - top,
		toJSON: () => ({ left, top, right, bottom })
	} as DOMRect;
}

function installZoneDockGeometry(zoneId: string) {
	const dock = screen.getByRole('complementary', { name: 'Roon zones' });
	const list = screen.getByRole('list', { name: 'Available Roon zones' });
	const port = [...dock.querySelectorAll<HTMLElement>('[data-timeline-zone-port]')].find(
		(candidate) => candidate.dataset.zoneId === zoneId
	);
	if (!port) throw new Error(`Missing zone port ${zoneId}`);
	const dockRect = vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue(
		testRect(900, 80, 1_120, 340)
	);
	vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(testRect(910, 100, 1_110, 330));
	vi.spyOn(port, 'getBoundingClientRect').mockReturnValue(testRect(920, 110, 1_100, 170));
	return { dock, port, dockRect };
}

function strictArtistPageState(camera = { x: 0, y: 0, scale: 1 }) {
	const value = buildTimelineLibraryPageState({
		artistQuery: 'Björk',
		selectedArtistLocalId: ARTIST_ID,
		activeSemanticPath: [{ kind: 'artist', localId: ARTIST_ID }],
		selectedNode: { kind: 'artist', localId: ARTIST_ID },
		camera,
		displayDepth: 0
	});
	__resetTestPage('http://localhost/library', buildLibraryPageStateEnvelope(value));
	return value;
}

function catalogStatus(overrides: Partial<CatalogStatus> = {}): CatalogStatus {
	return {
		coreId: 'core-a',
		freshness: 'fresh',
		persistence: 'healthy',
		refresh: 'idle',
		available: true,
		complete: true,
		revision: 1,
		artistCount: 1,
		albumCount: 1,
		updatedAt: AT,
		lastCompleteScanAt: AT,
		...overrides
	};
}

function candidate(index = 0): ArtistRef {
	const exactName = index === 0 ? 'Björk' : `Artist ${index}`;
	return {
		localId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
		coreId: 'core-a',
		exactName,
		normalizedName: normalizeCatalogText(exactName),
		firstSeenAt: AT,
		lastSeenAt: AT,
		resolutionStatus: 'resolved'
	};
}

function browseState(
	overrides: Partial<TimelineBrowseSessionState> = {}
): TimelineBrowseSessionState {
	return {
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
		recoveryRequired: false,
		...overrides
	};
}

function fakeBrowseStore(
	initial: TimelineBrowseSessionState,
	selectPublication?: TimelineSelectionPublication
): TimelineBrowseSessionStore & { setState(value: TimelineBrowseSessionState): void } {
	const state = writable(initial);
	const search = vi.fn().mockResolvedValue(true);
	const refreshCatalog = vi.fn().mockResolvedValue(true);
	const adoptAuxiliaryArtistHydration = vi.fn((status: CatalogStatus, expectedRevision: number) => {
		let adopted = false;
		state.update((value) => {
			if (
				!value.discography ||
				value.refreshPhase === 'running' ||
				!status.available ||
				status.refresh !== 'idle' ||
				value.catalogStatus?.revision !== expectedRevision ||
				value.catalogStatus.coreId !== status.coreId ||
				status.revision !== expectedRevision + 1
			) return value;
			adopted = true;
			return {
				...value,
				catalogStatus: status,
				discography: { ...value.discography, status }
			};
		});
		return adopted;
	});
	const selectArtist = vi.fn(
		async (_artist: ArtistRef, onPublished?: (value: TimelineSelectionPublication) => void) => {
			if (!selectPublication) return { success: false as const, reason: 'failed' as const };
			state.update((value) => ({
				...value,
				candidates: [],
				searchPhase: 'idle',
				selectionPhase: 'ready',
				selectedArtist: selectPublication.artist,
				discography: selectPublication.discography,
				albums: selectPublication.albums,
				session: selectPublication.session
			}));
			onPublished?.(selectPublication);
			return { success: true as const, publication: selectPublication };
		}
	);
	return {
		subscribe: state.subscribe,
		setState: (value) => state.set(value),
		loadCatalogStatus: vi.fn().mockResolvedValue(true),
		adoptAuxiliaryArtistHydration,
		search,
		refreshCatalog,
		selectArtist,
		openAlbum: vi.fn().mockResolvedValue({ success: false, reason: 'not-ready' }),
		closeAlbumDetail: vi.fn().mockResolvedValue({ success: false, reason: 'not-ready' }),
		reconnectSession: vi.fn().mockResolvedValue(false),
		restoreSnapshot: vi.fn().mockResolvedValue(false),
		connectionLost: vi.fn(),
		quiesce: vi.fn(),
		destroy: vi.fn()
	};
}

function calendarAlbum(
	id: string,
	year: number,
	ordinal: number,
	image = false
): TimelineAlbumLayoutInput {
	return {
		localId: id,
		title: `Album ${id}`,
		artist: 'Shell Artist',
		placement: {
			kind: 'calendar',
			ordinal,
			year,
			evidence: {
				sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
				field: 'original-release-date',
				date: String(year)
			}
		},
		...(image ? { imageKeyHint: `image/${id}?safe` } : {})
	};
}

function undatedAlbum(id: string, ordinal: number): TimelineAlbumLayoutInput {
	return {
		localId: id,
		title: `Album ${id}`,
		artist: 'Shell Artist',
		placement: {
			kind: 'undated',
			ordinal,
			label: 'Undated',
			reason: 'no-proven-original-release-date'
		}
	};
}

function selectionPublication(): TimelineSelectionPublication {
	const owner = candidate();
	const albums: TimelineAlbumLayoutInput[] = [
		{
			localId: ALBUM_ID,
			title: 'Homogenic',
			artist: owner.exactName,
			placement: {
				kind: 'undated',
				ordinal: 0,
				label: 'Undated',
				reason: 'no-proven-original-release-date'
			}
		}
	];
	const discography: CatalogArtistAlbumsResponse = {
		status: catalogStatus(),
		artist: owner,
		limit: 500,
		total: 1,
		truncated: false,
		albums: [
			{
				localId: ALBUM_ID,
				coreId: 'core-a',
				artistLocalId: ARTIST_ID,
				exactTitle: 'Homogenic',
				exactArtist: owner.exactName,
				normalizedTitle: normalizeCatalogText('Homogenic'),
				normalizedArtist: owner.normalizedName,
				editionText: '',
				firstSeenAt: AT,
				lastSeenAt: AT,
				resolutionStatus: 'resolved'
			}
		]
	};
	return {
		query: 'Björk',
		artist: owner,
		discography,
		albums,
		session: { handleId: 'opaque-handle', generation: 7 }
	};
}

function auxiliaryArtist(): ArtistRef {
	return {
		localId: AUX_ARTIST_ID,
		coreId: 'core-a',
		exactName: 'Auxiliary Artist',
		normalizedName: normalizeCatalogText('Auxiliary Artist'),
		firstSeenAt: AT,
		lastSeenAt: AT,
		resolutionStatus: 'resolved'
	};
}

function auxiliarySearchResponse(query = 'Auxiliary') {
	const response = normalizeCatalogArtistSearchResponse({
		status: catalogStatus({ artistCount: 2, albumCount: 2 }),
		query,
		limit: 8,
		total: 1,
		truncated: false,
		artists: [auxiliaryArtist()]
	});
	if (!response) throw new Error('invalid auxiliary artist-search fixture');
	return response;
}

function auxiliaryAlbumsResponse() {
	const artist = auxiliaryArtist();
	const response = normalizeCatalogArtistAlbumsResponse({
		status: catalogStatus({ artistCount: 2, albumCount: 2 }),
		artist,
		limit: 8,
		total: 1,
		truncated: false,
		albums: [
			{
				localId: AUX_ALBUM_ID,
				coreId: 'core-a',
				artistLocalId: AUX_ARTIST_ID,
				exactTitle: 'Branch Album',
				exactArtist: artist.exactName,
				normalizedTitle: normalizeCatalogText('Branch Album'),
				normalizedArtist: artist.normalizedName,
				editionText: '',
				imageKeyHint: 'branch-image',
				firstSeenAt: AT,
				lastSeenAt: AT,
				resolutionStatus: 'resolved'
			}
		]
	});
	if (!response) throw new Error('invalid auxiliary album fixture');
	return response;
}

function auxiliaryDatedAlbumsResponse(): CatalogArtistAlbumsResponse {
	const artist = auxiliaryArtist();
	const template = auxiliaryAlbumsResponse().albums[0];
	const response = normalizeCatalogArtistAlbumsResponse({
		status: catalogStatus({ artistCount: 2, albumCount: 3 }),
		artist,
		limit: 8,
		total: 2,
		truncated: false,
		albums: [
			{
				...template,
				localId: AUX_ALBUM_ID,
				exactTitle: 'Future Branch',
				normalizedTitle: normalizeCatalogText('Future Branch'),
				originalReleaseYear: 2010,
				originalReleaseYearEvidence: {
					sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
					field: 'original-release-date',
					date: '2010'
				}
			},
			{
				...template,
				localId: '20000000-0000-4000-8000-000000000003',
				exactTitle: 'Past Branch',
				normalizedTitle: normalizeCatalogText('Past Branch'),
				originalReleaseYear: 1990,
				originalReleaseYearEvidence: {
					sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
					field: 'original-release-date',
					date: '1990'
				}
			}
		]
	});
	if (!response) throw new Error('invalid dated auxiliary album fixture');
	return response;
}

function branchStoreFixture(options: {
	failFirstAlbumLoad?: boolean;
	revisionConflictFirstAlbumLoad?: boolean;
	albumResponse?: Promise<CatalogArtistAlbumsResponse>;
} = {}): {
	readonly branchStore: TimelineBranchStore;
	readonly search: ReturnType<typeof vi.fn>;
	readonly fetchAlbums: ReturnType<typeof vi.fn>;
} {
	const search = vi.fn(async (_fetch: typeof fetch, query: string) =>
		auxiliarySearchResponse(query)
	);
	let loadCount = 0;
	const fetchAlbums = vi.fn(async () => {
		loadCount += 1;
		if (options.failFirstAlbumLoad && loadCount === 1) {
			throw new Error('Auxiliary catalog unavailable');
		}
		if (options.revisionConflictFirstAlbumLoad && loadCount === 1) {
			throw new ApiError('Catalog changed; retry request', 409, {
				error: 'Catalog changed; retry request',
				details: 'REVISION_CONFLICT'
			});
		}
		if (options.albumResponse) return options.albumResponse;
		return auxiliaryAlbumsResponse();
	});
	return {
		branchStore: createTimelineBranchStore({ search, fetchArtistAlbums: fetchAlbums }),
		search,
		fetchAlbums
	};
}

async function attachAuxiliaryBranchFromBase(
	albumName: RegExp = /Branch Album.*Auxiliary Artist/i
): Promise<HTMLButtonElement> {
	const base = await screen.findByRole('button', { name: /Homogenic, Undated/i });
	await fireEvent.contextMenu(base);
	await fireEvent.click(screen.getByRole('menuitem', { name: /Attach artist branch/i }));
	const searchbox = screen.getByRole('searchbox', { name: 'Artist name' });
	await fireEvent.input(searchbox, { target: { value: 'Auxiliary' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
	await fireEvent.click(await screen.findByRole('button', { name: /Auxiliary Artist/ }));
	return screen.findByRole('button', { name: albumName });
}

function connectTestCore(): void {
	setSocketStatus('connected');
	setCoreStatus({
		status: 'paired',
		core: { id: 'core-a', displayName: 'Test Core', displayVersion: '1' }
	});
}

function activeArtistState(
	albums: readonly TimelineAlbumLayoutInput[],
	overrides: Partial<TimelineBrowseSessionState> = {}
): TimelineBrowseSessionState {
	const publication = selectionPublication();
	return browseState({
		query: publication.query,
		catalogStatus: publication.discography.status,
		selectedArtist: publication.artist,
		discography: publication.discography,
		albums,
		session: publication.session,
		sessionPhase: 'live',
		...overrides
	});
}

function detailAlbum(image = true) {
	const base = selectionPublication().discography.albums[0];
	return {
		...base,
		trackTitleFingerprint: TRACK_FINGERPRINT,
		...(image ? { imageKeyHint: 'timeline-detail-image' } : {})
	};
}

function missingCatalogAlbum(): AlbumRef {
	return {
		...selectionPublication().discography.albums[0],
		exactTitle: 'Historical Missing',
		normalizedTitle: normalizeCatalogText('Historical Missing'),
		resolutionStatus: 'missing'
	};
}

function missingCatalogResponse(): CatalogArtistAlbumsResponse {
	const owner = candidate();
	const value = normalizeCatalogArtistAlbumsResponse({
		status: catalogStatus(),
		artist: owner,
		limit: 500,
		total: 1,
		truncated: false,
		albums: [missingCatalogAlbum()]
	});
	if (!value) throw new Error('invalid missing catalog fixture');
	return value;
}

let libraryViewHostOwner: LibraryViewHostPublisher | null = null;

type OpenClassicHandler = (
	intent: LibraryIntent
) => Promise<LibraryViewHostActivationOutcome>;

function captureOpenClassicRequests(
	handler: OpenClassicHandler = vi.fn(async () => 'activated' as const)
): OpenClassicHandler {
	libraryViewHostOwner?.release();
	libraryViewHostOwner = claimLibraryViewHost();
	libraryViewHostOwner.handleOpenClassicRequests(handler);
	return handler;
}

afterEach(() => {
	libraryViewHostOwner?.release();
	libraryViewHostOwner = null;
	resetLibraryIntentStore();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('production Timeline Library shell', () => {
	beforeEach(() => {
		vi.mocked(pushLibraryPageState).mockClear();
		vi.mocked(replaceLibraryPageState).mockClear();
		resetCanvasWorkspaceStore();
		setZonesSnapshot([]);
		setSelectedZone('');
		clearCommandFeedback();
		setSocketStatus('connecting');
		setCoreStatus({ status: 'discovering' });
		__resetTestPage('http://localhost/library', {});
		resetLibraryIntentStore();
		sessionStorage.clear();
	});

	it('renders one labeled full-bleed canvas shell with an actionable artist-picker landing', async () => {
		const browseStore = fakeBrowseStore(browseState());
		render(TimelineLibraryMode, { props: { browseStore } });

		const region = screen.getByRole('region', { name: 'Timeline library canvas' });
		expect(region).toHaveAttribute(
			'data-library-mode',
			'timeline'
		);
		const picker = screen.getByRole('region', { name: 'Start with an artist' });
		expect(picker).toHaveAttribute('data-artist-picker-state', 'landing');
		expect(within(picker).getByText('Artist origin')).toBeInTheDocument();
		expect(within(picker).getByText(
			'Search your Roon library, then choose an artist to map their releases in chronological order.'
		)).toBeInTheDocument();
		const search = within(picker).getByRole('searchbox', { name: 'Artist name' });
		expect(search).toBeEnabled();
		expect(search).toHaveAttribute('maxlength', '256');
		expect(within(picker).getByRole('button', { name: 'Search' })).toBeDisabled();
		expect(screen.getAllByRole('searchbox', { name: 'Artist name' })).toHaveLength(1);
		expect(within(picker).getByText('Timeline connection unavailable')).toHaveAttribute('role', 'status');
		expect(within(region).queryByText('0 releases')).toBeNull();
		setSocketStatus('connected');
		await tick();
		expect(within(picker).getByText('Waiting for Roon Core')).toHaveAttribute('role', 'status');
		expect(browseStore.loadCatalogStatus).toHaveBeenCalledTimes(1);
		expect(browseStore.refreshCatalog).not.toHaveBeenCalled();
		const world = screen.getByTestId('timeline-canvas-world');
		expect(document.querySelectorAll('[data-testid="timeline-canvas-world"]')).toHaveLength(1);
		expect(world.style.transform).toMatch(/^translate3d\(.+\) scale\(.+\)$/);
		expect(
			[...region.querySelectorAll<HTMLElement>('*')].filter(
				(element) => element.style.transform.length > 0
			)
		).toEqual([world]);
		expect(document.querySelector('[role="application"]')).toBeNull();

		const zoom = screen.getByLabelText('Current zoom');
		const before = zoom.textContent;
		await fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
		expect(zoom.textContent).not.toBe(before);
	});

	it('preserves an in-progress landing query while catalog status publishes', async () => {
		const initial = browseState();
		const browseStore = fakeBrowseStore(initial);
		render(TimelineLibraryMode, { props: { browseStore } });
		const search = screen.getByRole('searchbox', { name: 'Artist name' });

		await fireEvent.input(search, { target: { value: 'Miles Davis' } });
		browseStore.setState({
			...initial,
			catalogStatus: catalogStatus(),
			statusPhase: 'ready'
		});
		await tick();

		expect(search).toHaveValue('Miles Davis');
	});

	it.each([
		{
			kind: 'artist search',
			intent: {
				kind: 'artist' as const,
				destination: 'search' as const,
				query: 'Björk',
				display: { title: 'Björk' }
			}
		},
		{
			kind: 'general search',
			intent: {
				kind: 'general' as const,
				destination: 'search' as const,
				query: 'Blue Note',
				display: { title: 'Blue Note' }
			}
		}
	])('claims an incoming $kind intent into bounded native artist search', async ({ intent }) => {
		const browseStore = fakeBrowseStore(browseState());
		const pending = publishLibraryIntent(intent, 'push');
		expect(pending).not.toBeNull();

		render(TimelineLibraryMode, { props: { browseStore } });

		await waitFor(() => expect(browseStore.search).toHaveBeenCalledWith(intent.query));
		expect(screen.getByPlaceholderText('Search artists')).toHaveValue(intent.query);
		expect(get(pendingLibraryIntentStore)).toBeNull();
		expect(screen.queryByRole('dialog', { name: /Open .* in Classic/i })).toBeNull();
	});

	it.each([
		{
			name: 'a dynamic Explore path',
			intent: {
				kind: 'general' as const,
				destination: 'explore-path' as const,
				labelPath: ['Browse', 'Genres']
			},
			dialogName: /Open Genres in Classic/i
		},
		{
			name: 'a grouped-search category',
			intent: {
				kind: 'general' as const,
				destination: 'search-category' as const,
				query: 'Miles',
				categoryTitle: 'Composers'
			},
			dialogName: /Open Composers results in Classic/i
		}
	])('confirms $name before relaying its exact keyless intent to Classic', async ({
		intent,
		dialogName
	}) => {
		const openClassic = captureOpenClassicRequests();
		const browseStore = fakeBrowseStore(browseState());
		const pending = publishLibraryIntent(intent, 'replace');
		expect(pending).not.toBeNull();

		render(TimelineLibraryMode, { props: { browseStore } });

		expect(await screen.findByRole('dialog', { name: dialogName })).toBeInTheDocument();
		expect(browseStore.search).not.toHaveBeenCalled();
		expect(openClassic).not.toHaveBeenCalled();
		expect(get(pendingLibraryIntentStore)).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));
		expect(openClassic).toHaveBeenCalledTimes(1);
		expect(openClassic).toHaveBeenCalledWith(intent);
	});

	it('offers the current general query as an explicit Classic grouped-search handoff', async () => {
		const openClassic = captureOpenClassicRequests();
		const browseStore = fakeBrowseStore(browseState({
			catalogStatus: catalogStatus(),
			searchPhase: 'ready'
		}));
		render(TimelineLibraryMode, { props: { browseStore } });
		const search = screen.getByPlaceholderText('Search artists');
		await fireEvent.input(search, { target: { value: '  Miles Davis  ' } });

		await fireEvent.click(screen.getByRole('button', { name: 'Search everything in Classic' }));
		expect(screen.getByRole('dialog', {
			name: /Open all results for “Miles Davis” in Classic/i
		})).toBeInTheDocument();
		expect(openClassic).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));

		expect(openClassic).toHaveBeenCalledWith({
			kind: 'general',
			destination: 'search',
			query: 'Miles Davis',
			display: { title: 'Miles Davis' }
		});
	});

	it.each([
		{ section: 'favorites' as const, label: 'Favorites' },
		{ section: 'recently-played' as const, label: 'Recently Played' }
	])('offers the exact $label Classic welcome destination', async ({ section, label }) => {
		const openClassic = captureOpenClassicRequests();
		const browseStore = fakeBrowseStore(browseState());
		render(TimelineLibraryMode, { props: { browseStore } });

		await fireEvent.click(screen.getByText('Classic Library'));
		await fireEvent.click(screen.getByRole('button', { name: `Open ${label} in Classic` }));
		expect(screen.getByRole('dialog', {
			name: new RegExp(`Open ${label} in Classic`, 'i')
		})).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));

		expect(openClassic).toHaveBeenCalledWith({
			kind: 'general',
			destination: 'welcome-section',
			section
		});
	});

	it('offers the active artist as a stable, selection-required Classic handoff', async () => {
		connectTestCore();
		const openClassic = captureOpenClassicRequests();
		const publication = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums));
		render(TimelineLibraryMode, { props: { browseStore } });

		await fireEvent.click(screen.getByText('Classic Library'));
		await fireEvent.click(screen.getByRole('button', {
			name: 'Open current artist in Classic'
		}));
		const dialog = screen.getByRole('dialog', {
			name: /Open artist “Björk” in Classic/i
		});
		expect(dialog).toHaveTextContent('Choose the matching result there');
		expect(dialog).toHaveTextContent('no live Roon item is transferred');
		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));

		expect(openClassic).toHaveBeenCalledWith({
			kind: 'artist',
			destination: 'search',
			query: 'Björk',
			localDescriptorId: ARTIST_ID,
			display: { title: 'Björk' }
		});
	});

	it('keeps confirmation open and reports feedback when the Library host is unavailable', async () => {
		const browseStore = fakeBrowseStore(browseState({
			catalogStatus: catalogStatus(),
			searchPhase: 'ready'
		}));
		render(TimelineLibraryMode, { props: { browseStore } });
		await fireEvent.input(screen.getByPlaceholderText('Search artists'), {
			target: { value: 'Alice Coltrane' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Search everything in Classic' }));
		const dialog = screen.getByRole('dialog', {
			name: /Open all results for “Alice Coltrane” in Classic/i
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));

		expect(dialog).toBeInTheDocument();
		expect(get(commandFeedbackStore)).toMatchObject({
			source: 'browse',
			command: 'open-in-classic',
			message: 'Classic Library view is not ready to open this destination.'
		});
	});

	it.each([
		{
			outcome: 'failed' as const,
			message: 'Classic Library view could not open this destination. Try again.'
		},
		{
			outcome: 'superseded' as const,
			message: 'Open in Classic was superseded by a newer Library view request.'
		}
	])('keeps confirmation pending and reports an honest $outcome activation outcome', async ({
		outcome,
		message
	}) => {
		const completion = deferred<LibraryViewHostActivationOutcome>();
		const openClassic = captureOpenClassicRequests(vi.fn(() => completion.promise));
		const browseStore = fakeBrowseStore(browseState({
			catalogStatus: catalogStatus(),
			searchPhase: 'ready'
		}));
		render(TimelineLibraryMode, { props: { browseStore } });
		await fireEvent.input(screen.getByPlaceholderText('Search artists'), {
			target: { value: 'Alice Coltrane' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Search everything in Classic' }));
		const dialog = screen.getByRole('dialog', {
			name: /Open all results for “Alice Coltrane” in Classic/i
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));

		expect(openClassic).toHaveBeenCalledTimes(1);
		expect(dialog).toHaveAttribute('aria-busy', 'true');
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
		expect(document.querySelector('[aria-live="polite"]')).not.toHaveTextContent(
			'Opening all results for “Alice Coltrane”'
		);

		completion.resolve(outcome);

		await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'false'));
		expect(dialog).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Open in Classic' })).toBeEnabled();
		expect(get(commandFeedbackStore)).toMatchObject({
			source: 'browse',
			command: 'open-in-classic',
			message
		});
		expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(message);
	});

	it('dismisses confirmation and announces success only after Classic activates', async () => {
		const completion = deferred<LibraryViewHostActivationOutcome>();
		captureOpenClassicRequests(vi.fn(() => completion.promise));
		const browseStore = fakeBrowseStore(browseState({
			catalogStatus: catalogStatus(),
			searchPhase: 'ready'
		}));
		render(TimelineLibraryMode, { props: { browseStore } });
		await fireEvent.input(screen.getByPlaceholderText('Search artists'), {
			target: { value: 'Alice Coltrane' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Search everything in Classic' }));
		const dialog = screen.getByRole('dialog', {
			name: /Open all results for “Alice Coltrane” in Classic/i
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));

		expect(dialog).toHaveAttribute('aria-busy', 'true');
		expect(document.querySelector('[aria-live="polite"]')).not.toHaveTextContent(
			'Opening all results for “Alice Coltrane”'
		);
		completion.resolve('activated');

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
			'Opening all results for “Alice Coltrane” in Classic Library view.'
		);
	});

	it('ignores a pending Open in Classic outcome after Timeline unmounts', async () => {
		const completion = deferred<LibraryViewHostActivationOutcome>();
		captureOpenClassicRequests(vi.fn(() => completion.promise));
		const browseStore = fakeBrowseStore(browseState({
			catalogStatus: catalogStatus(),
			searchPhase: 'ready'
		}));
		const view = render(TimelineLibraryMode, { props: { browseStore } });
		await fireEvent.input(screen.getByPlaceholderText('Search artists'), {
			target: { value: 'Alice Coltrane' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Search everything in Classic' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));
		expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');

		view.unmount();
		expect(get(commandFeedbackStore)).toBeNull();
		completion.resolve('failed');
		await Promise.resolve();
		await tick();

		expect(get(commandFeedbackStore)).toBeNull();
		expect(document.querySelector('[aria-live="polite"]')).toBeNull();
	});

	it('defers an incoming Classic-only intent until the current action menu closes', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums));
		render(TimelineLibraryMode, { props: { browseStore } });
		const marker = await screen.findByRole('button', { name: /Homogenic, Undated/i });
		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		const menu = screen.getByRole('menu', { name: 'Homogenic actions' });
		const pending = publishLibraryIntent({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Browse', 'Genres']
		});
		expect(pending).not.toBeNull();
		await tick();
		expect(get(pendingLibraryIntentStore)?.requestId).toBe(pending?.requestId);
		expect(screen.queryByRole('dialog', { name: /Open Genres in Classic/i })).toBeNull();

		await fireEvent.keyDown(menu, { key: 'Escape' });

		expect(await screen.findByRole('dialog', {
			name: /Open Genres in Classic/i
		})).toBeInTheDocument();
		expect(get(pendingLibraryIntentStore)).toBeNull();
	});

	it('parks a newer Classic-only intent behind the open fallback confirmation', async () => {
		const browseStore = fakeBrowseStore(browseState());
		const first = publishLibraryIntent({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Browse', 'Genres']
		});
		expect(first).not.toBeNull();
		render(TimelineLibraryMode, { props: { browseStore } });
		expect(await screen.findByRole('dialog', {
			name: /Open Genres in Classic/i
		})).toBeInTheDocument();

		const second = publishLibraryIntent({
			kind: 'general',
			destination: 'welcome-section',
			section: 'favorites'
		});
		expect(second).not.toBeNull();
		await tick();

		expect(screen.getByRole('dialog', {
			name: /Open Genres in Classic/i
		})).toBeInTheDocument();
		expect(screen.queryByRole('dialog', {
			name: /Open Favorites in Classic/i
		})).toBeNull();
		expect(get(pendingLibraryIntentStore)?.requestId).toBe(second?.requestId);

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		const queuedDialog = await screen.findByRole('dialog', {
			name: /Open Favorites in Classic/i
		});
		expect(queuedDialog).toBeInTheDocument();
		expect(get(pendingLibraryIntentStore)).toBeNull();
		await waitFor(() => expect(
			within(queuedDialog).getByRole('button', { name: 'Cancel' })
		).toHaveFocus());
	});

	it('keeps a newer intent parked while outgoing Timeline is transitioning', async () => {
		const openClassic = captureOpenClassicRequests(vi.fn(async () => {
			libraryViewHostOwner?.publishActiveMode('timeline', {
				fromMode: 'timeline',
				toMode: 'classic'
			});
			return 'activated' as const;
		}));
		libraryViewHostOwner?.publishActiveMode('timeline');
		const browseStore = fakeBrowseStore(browseState());
		const first = publishLibraryIntent({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Browse', 'Genres']
		});
		expect(first).not.toBeNull();
		render(TimelineLibraryMode, { props: { browseStore } });
		expect(await screen.findByRole('dialog', {
			name: /Open Genres in Classic/i
		})).toBeInTheDocument();

		const second = publishLibraryIntent({
			kind: 'general',
			destination: 'welcome-section',
			section: 'favorites'
		});
		expect(second).not.toBeNull();
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));

		expect(openClassic).toHaveBeenCalledWith(first?.intent);
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: 'timeline',
			pendingMode: 'classic',
			transition: {
				fromMode: 'timeline',
				toMode: 'classic'
			}
		});
		expect(screen.queryByRole('dialog', {
			name: /Open Favorites in Classic/i
		})).toBeNull();
		expect(get(pendingLibraryIntentStore)?.requestId).toBe(second?.requestId);

		libraryViewHostOwner?.publishActiveMode('timeline');
		expect(await screen.findByRole('dialog', {
			name: /Open Favorites in Classic/i
		})).toBeInTheDocument();
		expect(get(pendingLibraryIntentStore)).toBeNull();
	});

	it('offers an exact stable album descriptor and restores marker focus when cancelled', async () => {
		connectTestCore();
		const openClassic = captureOpenClassicRequests();
		const publication = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums));
		render(TimelineLibraryMode, { props: { browseStore } });
		const marker = await screen.findByRole('button', { name: /Homogenic, Undated/i });

		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(screen.getByRole('menuitem', { name: /Open album in Classic/i }));
		expect(screen.getByRole('dialog', {
			name: /Open album “Homogenic” in Classic/i
		})).toHaveTextContent('Choose the matching result there');
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(marker).toHaveFocus());
		expect(openClassic).not.toHaveBeenCalled();

		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(screen.getByRole('menuitem', { name: /Open album in Classic/i }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));
		expect(openClassic).toHaveBeenCalledWith({
			kind: 'album',
			destination: 'search',
			query: 'Homogenic',
			localDescriptorId: ALBUM_ID,
			display: { title: 'Homogenic', artist: 'Björk' }
		});
	});

	it('offers a displayed track as a keyless Classic search intent', async () => {
		connectTestCore();
		const openClassic = captureOpenClassicRequests();
		const publication = selectionPublication();
		const descriptor = detailAlbum(false);
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums, {
			discography: { ...publication.discography, albums: [descriptor] },
			detailPhase: 'ready',
			selectedAlbumLocalId: ALBUM_ID,
			selectedAlbumDescriptor: descriptor,
			detail: {
				artist: publication.artist,
				album: descriptor,
				orderedTrackTitles: ['Hunter']
			}
		}));
		render(TimelineLibraryMode, { props: { browseStore } });

		await fireEvent.click(await screen.findByRole('button', {
			name: 'Open Hunter in Classic'
		}));
		expect(screen.getByRole('dialog', {
			name: /Open track “Hunter” in Classic/i
		})).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));

		expect(openClassic).toHaveBeenCalledWith({
			kind: 'track',
			destination: 'search',
			query: 'Hunter',
			display: { title: 'Hunter', artist: 'Björk', album: 'Homogenic' }
		});
	});

	it('offers a status-only retry when the catalog status request fails', async () => {
		const browseStore = fakeBrowseStore(
			browseState({
				statusPhase: 'error',
				statusError: 'Catalog status could not be loaded.'
			})
		);
		render(TimelineLibraryMode, { props: { browseStore } });

		expect(screen.getByRole('alert')).toHaveTextContent('Catalog status could not be loaded.');
		expect(browseStore.loadCatalogStatus).toHaveBeenCalledTimes(1);
		expect(browseStore.refreshCatalog).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Retry catalog status' }));
		expect(browseStore.loadCatalogStatus).toHaveBeenCalledTimes(2);
		expect(browseStore.refreshCatalog).not.toHaveBeenCalled();
	});

	it('offers an explicit first-use scan without pretending an unavailable catalog has no matches', async () => {
		const unavailable = catalogStatus({
			freshness: 'empty',
			available: false,
			complete: false,
			revision: 0,
			artistCount: 0,
			albumCount: 0,
			updatedAt: undefined,
			lastCompleteScanAt: undefined
		});
		const browseStore = fakeBrowseStore(
			browseState({ query: 'Björk', searchPhase: 'ready', catalogStatus: unavailable })
		);
		render(TimelineLibraryMode, { props: { browseStore } });

		expect(screen.getByText('The artist catalog is not ready yet.')).toBeInTheDocument();
		expect(screen.queryByText('No matching artists.')).toBeNull();
		expect(browseStore.loadCatalogStatus).toHaveBeenCalledTimes(1);
		expect(browseStore.refreshCatalog).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Scan library' }));
		expect(browseStore.refreshCatalog).toHaveBeenCalledTimes(1);
	});

	it('bounds pointer-selectable artist choices and publishes one fitted semantic history entry', async () => {
		const publication = selectionPublication();
		const candidates = Array.from({ length: 45 }, (_, index) => candidate(index));
		const browseStore = fakeBrowseStore(
			browseState({
				query: 'Björk',
				searchPhase: 'ready',
				catalogStatus: catalogStatus({ artistCount: candidates.length }),
				candidates
			}),
			publication
		);
		render(TimelineLibraryMode, { props: { browseStore } });

		const picker = screen.getByRole('region', { name: 'Start with an artist' });
		const resultList = within(picker).getByRole('list', { name: 'Artist matches' });
		expect(resultList.querySelectorAll('li > button')).toHaveLength(40);
		await fireEvent.click(within(resultList).getByRole('button', { name: /Björk Open timeline/i }));

		expect(await screen.findByText('Homogenic')).toBeInTheDocument();
		expect(browseStore.selectArtist).toHaveBeenCalledTimes(1);
		expect(pushLibraryPageState).toHaveBeenCalledTimes(1);
		const historyState = vi.mocked(pushLibraryPageState).mock.calls[0][0];
		expect(historyState).toMatchObject({
			libraryView: 'timeline',
			snapshot: {
				artistQuery: 'Björk',
				selectedArtistLocalId: ARTIST_ID,
				activeSemanticPath: [{ kind: 'artist', localId: ARTIST_ID }],
				selectedNode: { kind: 'artist', localId: ARTIST_ID }
			}
		});
		if (historyState.libraryView !== 'timeline') throw new Error('expected Timeline history state');
		const expectedCamera = fitCamera(
			createTimelineCanvasModel(publication.albums).bounds,
			{ x: 0, y: 0, width: 1_400, height: 900 },
			{ padding: 250, maxScale: 1.18 }
		);
		expect(historyState.snapshot.camera).toEqual({
			x: expectedCamera.centerX,
			y: expectedCamera.centerY,
			scale: expectedCamera.scale
		});
		expect(JSON.stringify(historyState)).not.toMatch(/opaque-handle|handleId|itemKey/);
		expect(document.querySelectorAll('[data-world-object]')).toHaveLength(1);
		expect(screen.queryByRole('region', { name: 'Start with an artist' })).toBeNull();
		expect(screen.queryByRole('region', { name: 'Artist search results' })).toBeNull();
	});

	it('moves from the artist field into matches and opens a discography with the keyboard', async () => {
		const publication = selectionPublication();
		const browseStore = fakeBrowseStore(
			browseState({
				query: 'Björk',
				searchPhase: 'ready',
				catalogStatus: catalogStatus({ artistCount: 2 }),
				candidates: [candidate(), candidate(1)]
			}),
			publication
		);
		render(TimelineLibraryMode, { props: { browseStore } });
		const picker = screen.getByRole('region', { name: 'Start with an artist' });
		const search = within(picker).getByRole('searchbox', { name: 'Artist name' });
		const firstMatch = within(picker).getByRole('button', { name: /Björk Open timeline/i });
		const user = userEvent.setup();

		search.focus();
		await user.keyboard('{ArrowDown}');
		expect(firstMatch).toHaveFocus();
		await user.keyboard('{ArrowUp}');
		expect(search).toHaveFocus();
		await user.keyboard('{ArrowDown}');
		expect(firstMatch).toHaveFocus();
		await user.keyboard('{Enter}');

		expect(await screen.findByText('Homogenic')).toBeInTheDocument();
		expect(browseStore.selectArtist).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole('region', { name: 'Start with an artist' })).toBeNull();
	});

	it('opens one selected album through the navigation coordinator', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const descriptor = detailAlbum();
		const browseStore = fakeBrowseStore(browseState({
			query: publication.query,
			catalogStatus: publication.discography.status,
			selectedArtist: publication.artist,
			discography: { ...publication.discography, albums: [descriptor] },
			albums: publication.albums,
			session: publication.session,
			sessionPhase: 'live'
		}));
		render(TimelineLibraryMode, { props: { browseStore } });

		await fireEvent.click(screen.getByRole('button', { name: /Homogenic, Undated/i }));
		expect(browseStore.openAlbum).toHaveBeenCalledTimes(1);
		expect(browseStore.openAlbum).toHaveBeenCalledWith(ALBUM_ID, expect.any(Function));
	});

	it('attaches one honest bounded artist-search branch without replacing the base artist', async () => {
		connectTestCore();
		strictArtistPageState();
		const publication = selectionPublication();
		const status = catalogStatus({ artistCount: 2, albumCount: 2 });
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums, {
			catalogStatus: status,
			discography: { ...publication.discography, status }
		}));
		vi.mocked(browseStore.openAlbum).mockImplementation(async (
			_albumLocalId,
			onPublished
		) => {
			const detailPublication = {} as TimelineDetailPublication;
			onPublished?.(detailPublication);
			return { success: true, publication: detailPublication };
		});
		const { branchStore, search, fetchAlbums } = branchStoreFixture();
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });

		const branchNode = await attachAuxiliaryBranchFromBase();
		expect(screen.getByText('Artist search · Auxiliary Artist')).toBeInTheDocument();
		expect(screen.getByText('User-attached branch')).toBeInTheDocument();
		expect(document.body).not.toHaveTextContent(/Similar|Recommended/i);
		expect(search).toHaveBeenCalledWith(expect.any(Function), 'Auxiliary', 8);
		expect(fetchAlbums).toHaveBeenCalledWith(expect.any(Function), AUX_ARTIST_ID, 1, 8);
		expect(browseStore.selectArtist).not.toHaveBeenCalled();
		expect(browseStore.openAlbum).not.toHaveBeenCalled();

		let attachHistory: Parameters<typeof pushLibraryPageState>[0] | undefined;
		await waitFor(() => {
			attachHistory = vi.mocked(pushLibraryPageState).mock.calls.find(
				([entry]) => entry.libraryView === 'timeline' && entry.snapshot.selectedNode?.kind === 'auxiliary-artist'
			)?.[0];
			expect(attachHistory).toBeDefined();
		});
		expect(attachHistory).toMatchObject({
			snapshot: {
				selectedArtistLocalId: ARTIST_ID,
				activeSemanticPath: [
					{ kind: 'artist', localId: ARTIST_ID },
					{ kind: 'auxiliary-artist', localId: AUX_ARTIST_ID }
				],
				displayDepth: 1
			}
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Browse as list' }));
		const list = screen.getByRole('dialog', { name: 'Browse active set as list' });
		expect(within(list).getByText(/Artist search · Auxiliary Artist/)).toBeInTheDocument();
		expect(list.querySelectorAll('[data-timeline-list-row]').length).toBeLessThanOrEqual(40);
		await fireEvent.click(within(list).getByRole('button', { name: 'Close' }));

		await fireEvent.click(branchNode);
		expect(browseStore.openAlbum).toHaveBeenCalledWith(
			AUX_ALBUM_ID,
			expect.any(Function),
			AUX_ARTIST_ID
		);
		const detailHistory = vi.mocked(pushLibraryPageState).mock.calls.find(
			([entry]) => entry.libraryView === 'timeline' && entry.snapshot.displayDepth === 2
		)?.[0];
		expect(detailHistory).toMatchObject({
			snapshot: {
				activeSemanticPath: [
					{ kind: 'artist', localId: ARTIST_ID },
					{ kind: 'auxiliary-artist', localId: AUX_ARTIST_ID },
					{ kind: 'album', localId: AUX_ALBUM_ID }
				]
			}
		});
		const viewport = document.querySelector<HTMLElement>('[data-rendered-world-objects]')!;
		expect(Number(viewport.dataset.renderedWorldObjects)).toBeLessThanOrEqual(72);
		expect(Number(viewport.dataset.renderedArtworkImages)).toBeLessThanOrEqual(40);
		expect(document.querySelectorAll('[data-world-object]').length).toBe(
			Number(viewport.dataset.renderedWorldObjects)
		);
	});

	it('adopts an additive hydration revision before exposing its ready branch', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const baseStatus = catalogStatus({ artistCount: 2, albumCount: 2 });
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums, {
			catalogStatus: baseStatus,
			discography: { ...publication.discography, status: baseStatus }
		}));
		const originalSession = get(browseStore).session;
		const hydratedResponse = {
			...auxiliaryAlbumsResponse(),
			status: catalogStatus({ revision: 2, artistCount: 2, albumCount: 2 })
		};
		const { branchStore } = branchStoreFixture({
			albumResponse: Promise.resolve(hydratedResponse)
		});
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });

		expect(await attachAuxiliaryBranchFromBase()).toBeInTheDocument();
		await waitFor(() => {
			expect(get(browseStore).catalogStatus?.revision).toBe(2);
			expect(get(browseStore).discography?.status.revision).toBe(2);
			expect(get(branchStore).scope?.catalogRevision).toBe(2);
			expect(get(branchStore).branches[0]).toMatchObject({ phase: 'ready' });
		});
		expect(get(browseStore).session).toBe(originalSession);
		expect(browseStore.adoptAuxiliaryArtistHydration).toHaveBeenCalledWith(
			expect.objectContaining({ revision: 2 }),
			1
		);
	});

	it('refreshes a stale branch scope after a server revision conflict instead of offering a doomed retry', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const baseStatus = catalogStatus({ artistCount: 2, albumCount: 2 });
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums, {
			catalogStatus: baseStatus,
			discography: { ...publication.discography, status: baseStatus }
		}));
		const { branchStore } = branchStoreFixture({ revisionConflictFirstAlbumLoad: true });
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });

		await waitFor(() => expect(browseStore.loadCatalogStatus).toHaveBeenCalledTimes(1));
		vi.mocked(browseStore.loadCatalogStatus).mockClear().mockImplementation(async () => {
			browseStore.setState({
				...get(browseStore),
				catalogStatus: catalogStatus({ revision: 2, artistCount: 2, albumCount: 2 }),
				statusPhase: 'ready',
				statusError: null
			});
			return true;
		});

		const base = await screen.findByRole('button', { name: /Homogenic, Undated/i });
		await fireEvent.contextMenu(base);
		await fireEvent.click(screen.getByRole('menuitem', { name: /Attach artist branch/i }));
		await fireEvent.input(screen.getByRole('searchbox', { name: 'Artist name' }), {
			target: { value: 'Auxiliary' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		await fireEvent.click(await screen.findByRole('button', { name: /Auxiliary Artist/ }));

		await waitFor(() => expect(browseStore.loadCatalogStatus).toHaveBeenCalledTimes(1));
		expect(await screen.findByText(
			'The music library changed. Open artist branch search again to use the latest catalog.'
		)).toBeInTheDocument();
		await waitFor(() => {
			expect(get(branchStore).scope?.catalogRevision).toBe(2);
			expect(get(branchStore).branches).toEqual([]);
		});
		expect(screen.queryByRole('button', { name: 'Retry artist branch' })).toBeNull();
		expect(vi.mocked(pushLibraryPageState).mock.calls.some(
			([entry]) => entry.libraryView === 'timeline' && entry.snapshot.displayDepth === 1
		)).toBe(false);
	});

	it('refreshes the branch scope when a next-revision hydration is refused during a catalog scan', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const baseStatus = catalogStatus({ artistCount: 2, albumCount: 2 });
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums, {
			catalogStatus: baseStatus,
			discography: { ...publication.discography, status: baseStatus }
		}));
		const runningHydration = {
			...auxiliaryAlbumsResponse(),
			status: catalogStatus({
				revision: 2,
				artistCount: 2,
				albumCount: 2,
				refresh: 'running'
			})
		};
		const { branchStore } = branchStoreFixture({
			albumResponse: Promise.resolve(runningHydration)
		});
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });

		await waitFor(() => expect(browseStore.loadCatalogStatus).toHaveBeenCalledTimes(1));
		vi.mocked(browseStore.loadCatalogStatus).mockClear().mockImplementation(async () => {
			browseStore.setState({
				...get(browseStore),
				catalogStatus: catalogStatus({ revision: 2, artistCount: 2, albumCount: 2 }),
				statusPhase: 'ready',
				statusError: null
			});
			return true;
		});

		const base = await screen.findByRole('button', { name: /Homogenic, Undated/i });
		await fireEvent.contextMenu(base);
		await fireEvent.click(screen.getByRole('menuitem', { name: /Attach artist branch/i }));
		await fireEvent.input(screen.getByRole('searchbox', { name: 'Artist name' }), {
			target: { value: 'Auxiliary' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		await fireEvent.click(await screen.findByRole('button', { name: /Auxiliary Artist/ }));

		await waitFor(() => expect(browseStore.loadCatalogStatus).toHaveBeenCalledTimes(1));
		expect(await screen.findByText(
			'The music library changed. Open artist branch search again to use the latest catalog.'
		)).toBeInTheDocument();
		await waitFor(() => {
			expect(get(branchStore).scope?.catalogRevision).toBe(2);
			expect(get(branchStore).branches).toEqual([]);
		});
		expect(screen.queryByRole('button', { name: 'Retry artist branch' })).toBeNull();
	});

	it('commits the chosen branch immediately while its bounded album read settles', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const status = catalogStatus({ artistCount: 2, albumCount: 2 });
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums, {
			catalogStatus: status,
			discography: { ...publication.discography, status }
		}));
		const pendingAlbums = deferred<CatalogArtistAlbumsResponse>();
		const { branchStore } = branchStoreFixture({ albumResponse: pendingAlbums.promise });
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });

		const base = await screen.findByRole('button', { name: /Homogenic, Undated/i });
		await fireEvent.contextMenu(base);
		await fireEvent.click(screen.getByRole('menuitem', { name: /Attach artist branch/i }));
		await fireEvent.input(screen.getByRole('searchbox', { name: 'Artist name' }), {
			target: { value: 'Auxiliary' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		await fireEvent.click(await screen.findByRole('button', { name: /Auxiliary Artist/ }));

		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Attach artist branch' })).toBeNull();
			expect(screen.getByRole('group', { name: 'Artist branch for Auxiliary Artist' }))
				.toHaveTextContent('Loading artist albums…');
		});
		expect(vi.mocked(pushLibraryPageState).mock.calls.some(
			([entry]) => entry.libraryView === 'timeline' && entry.snapshot.displayDepth === 1
		)).toBe(false);

		pendingAlbums.resolve(auxiliaryAlbumsResponse());
		expect(await screen.findByRole('button', { name: /Branch Album.*Auxiliary Artist/i }))
			.toBeInTheDocument();
		await waitFor(() => expect(vi.mocked(pushLibraryPageState).mock.calls.some(
			([entry]) => entry.libraryView === 'timeline' && entry.snapshot.displayDepth === 1
		)).toBe(true));
	});

	it('closes branch search when its session source changes or Timeline disconnects', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const state = activeArtistState(publication.albums);
		const browseStore = fakeBrowseStore(state);
		const { branchStore } = branchStoreFixture();
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });
		const base = await screen.findByRole('button', { name: /Homogenic, Undated/i });

		await fireEvent.contextMenu(base);
		await fireEvent.click(screen.getByRole('menuitem', { name: /Attach artist branch/i }));
		expect(screen.getByRole('dialog', { name: 'Attach artist branch' })).toBeInTheDocument();
		browseStore.setState({
			...state,
			session: { ...publication.session, generation: publication.session.generation + 1 }
		});
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Attach artist branch' })).toBeNull();
			expect(base).toHaveFocus();
		});

		await fireEvent.contextMenu(base);
		await fireEvent.click(screen.getByRole('menuitem', { name: /Attach artist branch/i }));
		expect(screen.getByRole('dialog', { name: 'Attach artist branch' })).toBeInTheDocument();
		setSocketStatus('disconnected');
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Attach artist branch' })).toBeNull();
			expect(base).toHaveFocus();
		});
	});

	it('hides incompatible branch topology before a replacement base artist can be laid out', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const state = activeArtistState(publication.albums);
		const browseStore = fakeBrowseStore(state);
		const { branchStore } = branchStoreFixture();
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });
		await attachAuxiliaryBranchFromBase();
		expect(screen.getByText('Artist search · Auxiliary Artist')).toBeInTheDocument();

		const replacementAlbum = undatedAlbum(
			'20000000-0000-4000-8000-000000000009',
			0
		);
		browseStore.setState({
			...state,
			selectedArtist: candidate(2),
			albums: [replacementAlbum]
		});

		expect(await screen.findByRole('button', {
			name: /Album 20000000-0000-4000-8000-000000000009, Undated/i
		})).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.queryByText('Artist search · Auxiliary Artist')).toBeNull();
			expect(screen.queryByRole('button', { name: /Branch Album/ })).toBeNull();
		});
	});

	it('moves branch Left and Right in visible chronology rather than catalog order', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums));
		const { branchStore } = branchStoreFixture({
			albumResponse: Promise.resolve(auxiliaryDatedAlbumsResponse())
		});
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });

		const past = await attachAuxiliaryBranchFromBase(/Past Branch, 1990, Auxiliary Artist/i);
		const future = screen.getByRole('button', { name: /Future Branch, 2010, Auxiliary Artist/i });
		past.focus();
		await fireEvent.keyDown(past, { key: 'ArrowRight' });
		await waitFor(() => expect(future).toHaveFocus());
	});

	it('invalidates a pending auxiliary detail before closing its branch', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums));
		let publishDetail: ((publication: TimelineDetailPublication) => void) | undefined;
		let settleDetail!: (value: {
			success: true;
			publication: TimelineDetailPublication;
		}) => void;
		vi.mocked(browseStore.openAlbum).mockImplementation((
			_albumLocalId,
			onPublished
		) => {
			publishDetail = onPublished;
			return new Promise((resolve) => {
				settleDetail = resolve;
			});
		});
		const { branchStore } = branchStoreFixture();
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });
		const branchNode = await attachAuxiliaryBranchFromBase();
		await waitFor(() => expect(branchNode).toHaveFocus());
		vi.mocked(pushLibraryPageState).mockClear();

		await fireEvent.click(branchNode);
		expect(browseStore.openAlbum).toHaveBeenCalledWith(
			AUX_ALBUM_ID,
			expect.any(Function),
			AUX_ARTIST_ID
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Close artist branch' }));
		await waitFor(() => expect(screen.queryByRole('button', { name: /Branch Album/ })).toBeNull());
		expect(browseStore.closeAlbumDetail).toHaveBeenCalledWith(ARTIST_ID);
		expect(() => publishDetail?.({} as TimelineDetailPublication)).toThrow(
			'Timeline detail was superseded'
		);
		settleDetail({ success: true, publication: {} as TimelineDetailPublication });
		await tick();
		expect(vi.mocked(pushLibraryPageState).mock.calls.some(
			([entry]) => entry.libraryView === 'timeline' && entry.snapshot.displayDepth === 2
		)).toBe(false);
	});

	it('keeps one global culling pin when a base drag arms under branch focus', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums));
		const { branchStore } = branchStoreFixture();
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });
		const branchNode = await attachAuxiliaryBranchFromBase();
		await waitFor(() => expect(branchNode).toHaveFocus());
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		installSynchronousPointerCapture(viewport);
		const base = screen.getByRole('button', { name: /Homogenic, Undated/i });
		expect(viewport).toHaveAttribute('data-pinned-node-count', '1');

		await fireEvent.pointerDown(base, {
			pointerId: 61,
			pointerType: 'mouse',
			button: 0,
			isPrimary: true,
			clientX: 700,
			clientY: 450
		});
		await waitFor(() => expect(viewport).toHaveAttribute('data-gesture-kind', 'album-armed'));
		await waitFor(() => expect(viewport).toHaveAttribute('data-pinned-node-count', '1'));
		await fireEvent.pointerCancel(viewport, { pointerId: 61, pointerType: 'mouse' });
	});

	it('preserves a settled keyless branch offline while disabling detail authority and allowing Close', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const status = catalogStatus({ artistCount: 2, albumCount: 2 });
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums, {
			catalogStatus: status,
			discography: { ...publication.discography, status }
		}));
		const { branchStore } = branchStoreFixture();
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });
		const branchNode = await attachAuxiliaryBranchFromBase();

		setSocketStatus('disconnected');
		await waitFor(() => expect(branchNode).toHaveAccessibleName(/Album detail unavailable/));
		expect(screen.getByText('Artist search · Auxiliary Artist')).toBeInTheDocument();
		await fireEvent.click(branchNode);
		expect(browseStore.openAlbum).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Close artist branch' }));
		await waitFor(() => {
			expect(screen.queryByText('Artist search · Auxiliary Artist')).toBeNull();
			expect(screen.queryByRole('button', { name: /Branch Album/ })).toBeNull();
		});
	});

	it('keeps a failed branch local and pushes history only after explicit Retry succeeds', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const status = catalogStatus({ artistCount: 2, albumCount: 2 });
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums, {
			catalogStatus: status,
			discography: { ...publication.discography, status }
		}));
		const { branchStore, fetchAlbums } = branchStoreFixture({ failFirstAlbumLoad: true });
		render(TimelineLibraryMode, { props: { browseStore, branchStore } });

		const base = await screen.findByRole('button', { name: /Homogenic, Undated/i });
		await fireEvent.contextMenu(base);
		await fireEvent.click(screen.getByRole('menuitem', { name: /Attach artist branch/i }));
		await fireEvent.input(screen.getByRole('searchbox', { name: 'Artist name' }), {
			target: { value: 'Auxiliary' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		await fireEvent.click(await screen.findByRole('button', { name: /Auxiliary Artist/ }));

		expect(await screen.findByRole('alert')).toHaveTextContent('Auxiliary catalog unavailable');
		const retry = screen.getByRole('button', { name: 'Retry artist branch' });
		const close = screen.getByRole('button', { name: 'Close artist branch' });
		await waitFor(() => expect(retry).toHaveFocus());
		expect(vi.mocked(pushLibraryPageState).mock.calls.some(
			([entry]) => entry.libraryView === 'timeline' && entry.snapshot.displayDepth === 1
		)).toBe(false);

		setSocketStatus('disconnected');
		await waitFor(() => {
			expect(retry).toBeDisabled();
			expect(close).toBeEnabled();
		});
		setSocketStatus('connected');
		await waitFor(() => expect(retry).toBeEnabled());
		await fireEvent.click(retry);
		expect(await screen.findByRole('button', { name: /Branch Album/ })).toBeInTheDocument();
		expect(fetchAlbums).toHaveBeenCalledTimes(2);
		await waitFor(() => expect(vi.mocked(pushLibraryPageState).mock.calls.some(
			([entry]) => entry.libraryView === 'timeline' && entry.snapshot.displayDepth === 1
		)).toBe(true));
	});

	it('uses one roving marker and pans, mounts, pins, then focuses a culled End target', async () => {
		connectTestCore();
		const albums = Array.from({ length: 81 }, (_, index) =>
			calendarAlbum(`keyboard-${String(index).padStart(3, '0')}`, 1940 + index, index, true)
		);
		const browseStore = fakeBrowseStore(activeArtistState(albums));
		render(TimelineLibraryMode, { props: { browseStore } });

		const initial = await screen.findByRole('button', { name: /Album keyboard-000, 1940/ });
		expect(initial).toHaveAttribute('aria-haspopup', 'menu');
		expect(initial).toHaveAttribute('aria-keyshortcuts', 'Enter Shift+F10');
		const world = screen.getByTestId('timeline-canvas-world');
		const beforeTransform = world.style.transform;
		const mountedMarkers = () =>
			Array.from(document.querySelectorAll<HTMLButtonElement>('[data-album-id]'));
		expect(mountedMarkers().filter((marker) => marker.tabIndex === 0)).toEqual([initial]);
		expect(document.querySelector('[role="application"]')).toBeNull();

		initial.focus();
		await fireEvent.keyDown(initial, { key: 'End' });

		await waitFor(() => {
			const target = document.querySelector<HTMLButtonElement>('[data-album-id="keyboard-080"]');
			expect(target).not.toBeNull();
			expect(target).toHaveFocus();
			expect(target).toHaveAttribute('tabindex', '0');
			expect(target).toHaveClass('pinned');
		});
		expect(world.style.transform).not.toBe(beforeTransform);
		expect(mountedMarkers().filter((marker) => marker.tabIndex === 0)).toHaveLength(1);
		expect(document.querySelectorAll('[data-world-object]').length).toBeLessThanOrEqual(72);
		expect(document.querySelectorAll('[data-timeline-artwork]').length).toBeLessThanOrEqual(40);
		expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
			'Album keyboard-080, 2020'
		);
	});

	it('keeps the latest synchronous spatial focus intent and camera target', async () => {
		connectTestCore();
		const albums = Array.from({ length: 81 }, (_, index) =>
			calendarAlbum(`race-${String(index).padStart(3, '0')}`, 1940 + index, index)
		);
		const browseStore = fakeBrowseStore(activeArtistState(albums));
		render(TimelineLibraryMode, { props: { browseStore } });
		const initial = await screen.findByRole('button', { name: /Album race-000, 1940/ });
		const nearby = screen.getByRole('button', { name: /Album race-001, 1941/ });
		const world = screen.getByTestId('timeline-canvas-world');

		initial.focus();
		await waitFor(() => expect(initial).toHaveFocus());
		const initialTransform = world.style.transform;
		initial.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'End', bubbles: true, cancelable: true
		}));
		initial.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Home', bubbles: true, cancelable: true
		}));
		await waitFor(() => {
			expect(initial).toHaveFocus();
			expect(world.style.transform).toBe(initialTransform);
		});

		nearby.focus();
		await waitFor(() => expect(nearby).toHaveFocus());
		const nearbyTransform = world.style.transform;
		initial.focus();
		initial.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'End', bubbles: true, cancelable: true
		}));
		nearby.focus();
		await waitFor(() => {
			expect(nearby).toHaveFocus();
			expect(world.style.transform).toBe(nearbyTransform);
		});

		initial.focus();
		initial.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'End', bubbles: true, cancelable: true
		}));
		initial.dispatchEvent(new KeyboardEvent('keydown', {
			key: '/', bubbles: true, cancelable: true
		}));
		await waitFor(() =>
			expect(screen.getByPlaceholderText('Search artists')).toHaveFocus()
		);
	});

	it('re-resolves a pending focus target after the same album moves in a replacement model', async () => {
		connectTestCore();
		const albums = Array.from({ length: 81 }, (_, index) =>
			calendarAlbum(`reflow-${String(index).padStart(3, '0')}`, 1940 + index, index)
		);
		const initialState = activeArtistState(albums);
		const browseStore = fakeBrowseStore(initialState);
		render(TimelineLibraryMode, { props: { browseStore } });
		const initial = await screen.findByRole('button', { name: /Album reflow-000, 1940/ });
		initial.focus();

		initial.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'End', bubbles: true, cancelable: true
		}));
		const movedTarget = calendarAlbum('reflow-080', 1930, 80);
		const replacementAlbums = [movedTarget, ...albums.slice(0, 80)];
		browseStore.setState({ ...initialState, albums: replacementAlbums });
		const replacementEntity = createTimelineCanvasModel(replacementAlbums).entityById.get(
			'reflow-080'
		)!;
		const scale = Number(screen.getByLabelText('Current zoom').textContent?.replace('%', '')) / 100;
		const expectedTransform = cameraCssTransform(
			{ centerX: replacementEntity.x, centerY: replacementEntity.y, scale },
			{ x: 0, y: 0, width: 1_400, height: 900 }
		);

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Album reflow-080, 1930/ })).toHaveFocus();
			expect(screen.getByTestId('timeline-canvas-world').style.transform).toBe(
				expectedTransform
			);
		});
	});

	it('focuses artist search with Slash without stealing the key inside an editable control', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum('slash', 2000, 0)]));
		render(TimelineLibraryMode, { props: { browseStore } });
		const marker = await screen.findByRole('button', { name: /Album slash, 2000/ });
		const search = screen.getByPlaceholderText('Search artists');

		marker.focus();
		await fireEvent.keyDown(marker, { key: '/' });
		expect(search).toHaveFocus();
		expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
			'Artist search focused.'
		);

		await fireEvent.input(search, { target: { value: 'Bj' } });
		const user = userEvent.setup();
		await user.keyboard('/');
		expect(search).toHaveFocus();
		expect(search).toHaveValue('Bj/');
	});

	it('focuses artist search from neutral body and nonmodal shared-shell focus', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum('global-slash', 2000, 0)]));
		render(TimelineLibraryMode, { props: { browseStore } });
		const marker = await screen.findByRole('button', { name: /Album global-slash, 2000/ });
		const search = screen.getByPlaceholderText('Search artists');

		marker.focus();
		marker.blur();
		expect(document.body).toHaveFocus();
		await fireEvent.keyDown(document.body, { key: '/' });
		expect(search).toHaveFocus();

		const sharedControl = document.createElement('button');
		sharedControl.textContent = 'Shared nonmodal control';
		document.body.appendChild(sharedControl);
		sharedControl.focus();
		await fireEvent.keyDown(sharedControl, { key: '/' });
		expect(search).toHaveFocus();
		sharedControl.remove();
	});

	it('does not steal Slash focus from a shared shell overlay outside the Timeline region', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum('modal-slash', 2000, 0)]));
		render(TimelineLibraryMode, { props: { browseStore } });
		const externalDialog = document.createElement('div');
		externalDialog.setAttribute('role', 'dialog');
		externalDialog.setAttribute('aria-modal', 'true');
		const externalButton = document.createElement('button');
		externalButton.textContent = 'Shared overlay control';
		externalDialog.appendChild(externalButton);
		document.body.appendChild(externalDialog);
		externalButton.focus();

		await fireEvent.keyDown(externalButton, { key: '/' });
		expect(externalButton).toHaveFocus();
		expect(screen.getByPlaceholderText('Search artists')).not.toHaveFocus();
		externalDialog.remove();
	});

	it('opens the same focus-managed album menu from Shift+F10 and the visible button', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum('menu', 2001, 0)]));
		render(TimelineLibraryMode, { props: { browseStore } });
		const marker = await screen.findByRole('button', { name: /Album menu, 2001/ });

		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		let menu = screen.getByRole('menu', { name: 'Album menu actions' });
		expect(screen.getByRole('dialog', { name: 'Album actions for Album menu' })).toBeInTheDocument();
		const underlay = screen.getByTestId('timeline-spatial-underlay');
		expect(underlay).toHaveAttribute('inert');
		expect(underlay).toHaveAttribute('aria-hidden', 'true');
		expect(within(menu).getByRole('menuitem', { name: /Open album detail/ })).toHaveFocus();
		expect(within(menu).getByRole('menuitem', { name: /Float from timeline/ })).toBeEnabled();
		expect(within(menu).queryByText(/Send to|Return to timeline/)).toBeNull();

		await fireEvent.keyDown(menu, { key: 'Escape' });
		await waitFor(() => expect(marker).toHaveFocus());
		expect(screen.queryByRole('menu')).toBeNull();
		expect(underlay).not.toHaveAttribute('inert');
		expect(underlay).not.toHaveAttribute('aria-hidden');

		const toolbarTrigger = screen.getByRole('button', { name: 'Album actions' });
		await fireEvent.click(toolbarTrigger);
		menu = screen.getByRole('menu', { name: 'Album menu actions' });
		const openDetail = within(menu).getByRole('menuitem', { name: /Open album detail/ });
		expect(openDetail).toHaveFocus();
		await fireEvent.click(openDetail);
		await waitFor(() => expect(browseStore.openAlbum).toHaveBeenCalledTimes(1));
		expect(screen.queryByRole('menu')).toBeNull();
		await waitFor(() => expect(toolbarTrigger).toHaveFocus());
	});

	it('keeps Float and Return usable offline without history or browser-storage writes', async () => {
		const albums = [
			calendarAlbum('offline-float', 2001, 0),
			calendarAlbum('offline-neighbor', 2002, 1)
		];
		const workspaceStore = createCanvasWorkspaceStore();
		const browseStore = fakeBrowseStore(browseState());
		const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
		render(TimelineLibraryMode, {
			props: {
				artistName: 'Offline Artist',
				albums,
				browseStore,
				workspaceStore
			}
		});
		let marker = await screen.findByRole('button', {
			name: /Album offline-float, 2001/
		});
		expect(marker).not.toHaveAttribute('aria-disabled');
		expect(marker).toHaveAccessibleName(
			/Album detail unavailable; layout actions remain available with Shift\+F10/
		);

		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		let menu = screen.getByRole('menu', { name: 'Album offline-float actions' });
		const openDetail = within(menu).getByRole('menuitem', { name: /Open album detail/ });
		const float = within(menu).getByRole('menuitem', { name: /Float from timeline/ });
		expect(openDetail).toBeDisabled();
		expect(float).toHaveFocus();

		await fireEvent.click(float);
		const canonical = createTimelineCanvasModel(albums).entityById.get('offline-float')!;
		const expectedOffset = {
			dx: 46,
			dy: canonical.y <= 0 ? -42 : 42
		};
		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Album offline-float, 2001/ });
			const tether = document.querySelector('[data-timeline-tether="offline-float"]');
			expect(marker).toHaveClass('floating');
			expect(marker).toHaveAttribute('data-manual-offset-x', String(expectedOffset.dx));
			expect(marker).toHaveAttribute('data-manual-offset-y', String(expectedOffset.dy));
			expect(tether).toHaveAttribute('x1', String(canonical.anchorX));
			expect(tether).toHaveAttribute('y1', String(canonical.anchorY));
			expect(tether).toHaveAttribute('x2', String(canonical.anchorX + expectedOffset.dx));
			expect(tether).toHaveAttribute('y2', String(canonical.anchorY + expectedOffset.dy));
		});
		expect(workspaceStore.offsetFor('offline-float')).toEqual(expectedOffset);
		expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
			'Album offline-float floated for this tab only.'
		);
		expect(document.querySelector('[role="application"]')).toBeNull();
		expect(document.querySelectorAll('[data-world-object]').length).toBeLessThanOrEqual(72);
		expect(document.querySelectorAll('[data-timeline-artwork]').length).toBeLessThanOrEqual(40);
		expect(browseStore.openAlbum).not.toHaveBeenCalled();
		expect(pushLibraryPageState).not.toHaveBeenCalled();
		expect(storageWrite).not.toHaveBeenCalled();

		await waitFor(() => expect(marker).toHaveFocus());
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		menu = screen.getByRole('menu', { name: 'Album offline-float actions' });
		const returnToTimeline = within(menu).getByRole('menuitem', {
			name: /Return to timeline/
		});
		expect(returnToTimeline).toHaveFocus();
		await fireEvent.click(returnToTimeline);

		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Album offline-float, 2001/ });
			expect(marker).not.toHaveClass('floating');
			expect(marker).toHaveAttribute('data-manual-offset-x', '0');
			expect(marker).toHaveAttribute('data-manual-offset-y', '0');
			expect(document.querySelector('[data-timeline-tether="offline-float"]')).toBeNull();
		});
		expect(workspaceStore.offsetFor('offline-float')).toBeNull();
		expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
			'Album offline-float returned to its canonical timeline anchor.'
		);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
		expect(storageWrite).not.toHaveBeenCalled();
	});

	it('routes Move before and Move after through tab memory without changing chronology order', async () => {
		const albums = [
			calendarAlbum('move-a', 2000, 0),
			calendarAlbum('move-b', 2001, 1),
			calendarAlbum('move-c', 2002, 2)
		];
		const workspaceStore = createCanvasWorkspaceStore();
		render(TimelineLibraryMode, {
			props: { artistName: 'Move Artist', albums, workspaceStore }
		});
		let marker = await screen.findByRole('button', { name: /Album move-b, 2001/ });

		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		let menu = screen.getByRole('menu', { name: 'Album move-b actions' });
		const moveBefore = within(menu).getByRole('menuitem', { name: /Move before/ });
		const moveAfter = within(menu).getByRole('menuitem', { name: /Move after/ });
		expect(moveBefore).toBeEnabled();
		expect(moveAfter).toBeEnabled();
		await fireEvent.click(moveBefore);
		const beforeOffset = workspaceStore.offsetFor('move-b');
		expect(beforeOffset).not.toBeNull();

		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Album move-b, 2001/ });
			expect(marker).toHaveFocus();
		});
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		menu = screen.getByRole('menu', { name: 'Album move-b actions' });
		await fireEvent.click(within(menu).getByRole('menuitem', { name: /Move after/ }));
		const afterOffset = workspaceStore.offsetFor('move-b');
		expect(afterOffset).not.toBeNull();
		expect(afterOffset).not.toEqual(beforeOffset);
			expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
			'Album move-b moved after its chronological neighbor visually; release order is unchanged.'
		);
		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Album move-b, 2001/ });
			expect(marker).toHaveFocus();
		});
		await fireEvent.keyDown(marker, { key: 'ArrowRight' });
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /Album move-c, 2002/ })).toHaveFocus()
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Browse as list' }));
		const dialog = screen.getByRole('dialog', { name: 'Browse active set as list' });
		expect(
			Array.from(dialog.querySelectorAll('[data-timeline-list-row] strong'), (node) =>
				node.textContent
			)
		).toEqual(['Album move-a', 'Album move-b', 'Album move-c']);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
	});

	it('rebases same-scope offsets onto replacement anchors and prunes removed albums', async () => {
		connectTestCore();
		const initialAlbums = [
			calendarAlbum('rebase-anchor', 2000, 0),
			calendarAlbum('rebase-target', 2001, 1)
		];
		const initialState = activeArtistState(initialAlbums);
		const browseStore = fakeBrowseStore(initialState);
		const workspaceStore = createCanvasWorkspaceStore();
		render(TimelineLibraryMode, { props: { browseStore, workspaceStore } });
		let marker = await screen.findByRole('button', { name: /Album rebase-target, 2001/ });

		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(
			within(screen.getByRole('menu')).getByRole('menuitem', { name: /Float from timeline/ })
		);
		await waitFor(() => expect(workspaceStore.offsetFor('rebase-target')).not.toBeNull());
		const retainedOffset = workspaceStore.offsetFor('rebase-target')!;
		const replacementAlbums = [
			calendarAlbum('rebase-anchor', 2000, 0),
			calendarAlbum('rebase-target', 2010, 1)
		];
		browseStore.setState({ ...initialState, albums: replacementAlbums });
		const replacementAnchor = createTimelineCanvasModel(replacementAlbums).entityById.get(
			'rebase-target'
		)!;

		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Album rebase-target, 2010/ });
			expect(marker).toHaveAttribute('data-manual-offset-x', String(retainedOffset.dx));
			expect(marker).toHaveAttribute('data-manual-offset-y', String(retainedOffset.dy));
			expect(marker.style.left).toBe(`${replacementAnchor.anchorX + retainedOffset.dx}px`);
			expect(marker.style.top).toBe(`${replacementAnchor.anchorY + retainedOffset.dy}px`);
		});
		expect(workspaceStore.offsetFor('rebase-target')).toEqual(retainedOffset);
		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(
			within(screen.getByRole('menu')).getByRole('menuitem', { name: /Return to timeline/ })
		);
		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Album rebase-target, 2010/ });
			expect(marker).not.toHaveClass('floating');
			expect(marker.style.left).toBe(`${replacementAnchor.anchorX}px`);
			expect(marker.style.top).toBe(`${replacementAnchor.anchorY}px`);
			expect(document.querySelector('[data-timeline-tether="rebase-target"]')).toBeNull();
		});
		expect(workspaceStore.offsetFor('rebase-target')).toBeNull();

		await waitFor(() => expect(marker).toHaveFocus());
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(
			within(screen.getByRole('menu')).getByRole('menuitem', { name: /Float from timeline/ })
		);
		await waitFor(() => expect(workspaceStore.offsetFor('rebase-target')).not.toBeNull());

		browseStore.setState({ ...initialState, albums: replacementAlbums.slice(0, 1) });
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: /Album rebase-target/ })).toBeNull();
			expect(workspaceStore.offsetFor('rebase-target')).toBeNull();
		});

		browseStore.setState({ ...initialState, albums: replacementAlbums });
		const anchorMarker = await screen.findByRole('button', {
			name: /Album rebase-anchor, 2000/
		});
		anchorMarker.focus();
		await fireEvent.keyDown(anchorMarker, { key: 'End' });
		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Album rebase-target, 2010/ });
			expect(marker).not.toHaveClass('floating');
			expect(marker).toHaveAttribute('data-manual-offset-x', '0');
			expect(document.querySelector('[data-timeline-tether="rebase-target"]')).toBeNull();
		});
	});

	it('never projects a same-ID offset across a Core publication change', async () => {
		connectTestCore();
		const albums = [
			calendarAlbum('same-core-id', 2000, 0),
			calendarAlbum('same-core-neighbor', 2001, 1)
		];
		const initialState = activeArtistState(albums);
		const browseStore = fakeBrowseStore(initialState);
		const workspaceStore = createCanvasWorkspaceStore();
		render(TimelineLibraryMode, { props: { browseStore, workspaceStore } });
		let marker = await screen.findByRole('button', { name: /Album same-core-id, 2000/ });

		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(
			within(screen.getByRole('menu')).getByRole('menuitem', { name: /Float from timeline/ })
		);
		await waitFor(() => expect(marker).toHaveClass('floating'));
		const staleCoreOffset = workspaceStore.offsetFor('same-core-id');
		expect(staleCoreOffset).not.toBeNull();

		const coreBArtist = { ...candidate(), coreId: 'core-b' };
		const coreBStatus = catalogStatus({ coreId: 'core-b', revision: 2 });
		browseStore.setState({
			...initialState,
			catalogStatus: coreBStatus,
			selectedArtist: coreBArtist,
			discography: initialState.discography
				? {
					...initialState.discography,
					status: coreBStatus,
					artist: coreBArtist
				}
				: null,
			albums
		});
		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Album same-core-id, 2000/ });
			expect(marker).not.toHaveClass('floating');
			expect(marker).toHaveAttribute('data-manual-offset-x', '0');
			expect(marker).toHaveAccessibleName(
				/Album detail unavailable; layout actions remain available with Shift\+F10/
			);
		});
		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		const mismatchedMenu = screen.getByRole('menu', { name: 'Album same-core-id actions' });
		expect(
			within(mismatchedMenu).getByRole('menuitem', { name: /Open album detail/ })
		).toBeDisabled();
		await fireEvent.click(
			within(mismatchedMenu).getByRole('menuitem', { name: /Move after/ })
		);
		expect(workspaceStore.offsetFor('same-core-id')).toEqual(staleCoreOffset);
		expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
			'Album same-core-id placement is unavailable until this Timeline context settles.'
		);

		setCoreStatus({
			status: 'paired',
			core: { id: 'core-b', displayName: 'Replacement Core', displayVersion: '1' }
		});
		await waitFor(() => {
			expect(workspaceStore.offsetFor('same-core-id')).toBeNull();
			expect(document.querySelector('[data-timeline-tether="same-core-id"]')).toBeNull();
		});
	});

	it('keeps tab memory across remounts while a fresh workspace starts canonical', async () => {
		const albums = [
			calendarAlbum('remount-memory', 2000, 0),
			calendarAlbum('remount-neighbor', 2001, 1)
		];
		const first = render(TimelineLibraryMode, {
			props: { artistName: 'Remount Artist', albums }
		});
		let marker = await screen.findByRole('button', { name: /Album remount-memory, 2000/ });
		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(
			within(screen.getByRole('menu')).getByRole('menuitem', { name: /Float from timeline/ })
		);
		await waitFor(() => expect(marker).toHaveClass('floating'));
		first.unmount();

		const second = render(TimelineLibraryMode, {
			props: { artistName: 'Remount Artist', albums }
		});
		marker = await screen.findByRole('button', { name: /Album remount-memory, 2000/ });
		expect(marker).toHaveClass('floating');
		expect(document.querySelectorAll('[data-timeline-tether="remount-memory"]')).toHaveLength(1);
		second.unmount();

		render(TimelineLibraryMode, {
			props: {
				artistName: 'Remount Artist',
				albums,
				workspaceStore: createCanvasWorkspaceStore()
			}
		});
		marker = await screen.findByRole('button', { name: /Album remount-memory, 2000/ });
		expect(marker).not.toHaveClass('floating');
		expect(marker).toHaveAttribute('data-manual-offset-x', '0');
		expect(document.querySelector('[data-timeline-tether="remount-memory"]')).toBeNull();
	});

	it('fits projected bounds and recenters on the immutable chronological origin', async () => {
		const albums = [
			calendarAlbum('fit-origin', 2000, 0),
			calendarAlbum('fit-floating', 2001, 1)
		];
		const canonical = createTimelineCanvasModel(albums);
		const workspaceStore = createCanvasWorkspaceStore();
		workspaceStore.reconcile(
			{ coreId: 'injected-timeline-fixture', artistLocalId: 'Fit Artist' },
			canonical.entities.map((entity) => ({ id: entity.id, x: entity.anchorX, y: entity.anchorY }))
		);
		const token = workspaceStore.beginPlacement('fit-floating')!;
		workspaceStore.commitPlacement(token, { dx: 700, dy: 450 });
		const projected = projectTimelineCanvasModel(
			canonical,
			new Map([['fit-floating', { x: 700, y: 450 }]])
		);
		render(TimelineLibraryMode, {
			props: { artistName: 'Fit Artist', albums, workspaceStore }
		});
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /Album fit-floating, 2001/ })).toHaveAttribute(
				'data-manual-offset-x',
				'700'
			)
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
		const fitted = fitCamera(
			projected.bounds,
			{ x: 0, y: 0, width: 1_400, height: 900 },
			{ padding: 120, maxScale: 1.18 }
		);
		expect(screen.getByTestId('timeline-canvas-world').style.transform).toBe(
			cameraCssTransform(fitted, { x: 0, y: 0, width: 1_400, height: 900 })
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Recenter' }));
		const origin = canonical.entityById.get('fit-origin')!;
		const recentered = {
			centerX: origin.anchorX,
			centerY: 0,
			scale: Math.max(0.82, Math.min(1.08, fitted.scale))
		};
		expect(screen.getByTestId('timeline-canvas-world').style.transform).toBe(
			cameraCssTransform(recentered, { x: 0, y: 0, width: 1_400, height: 900 })
		);
		expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
			'Timeline recentered on its canonical origin.'
		);
	});

	it('opens a floated album detail with the projected marker camera', async () => {
		connectTestCore();
		const selected = selectionPublication();
		const descriptor = detailAlbum(false);
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums, {
			discography: { ...selected.discography, albums: [descriptor] }
		}));
		const detailPublication: TimelineDetailPublication = {
			detail: {
				artist: selected.artist,
				album: descriptor,
				orderedTrackTitles: ['Hunter']
			},
			session: { handleId: 'detail-handle', generation: 8 }
		};
		vi.mocked(browseStore.openAlbum).mockImplementation(async (_localId, onPublished) => {
			onPublished?.(detailPublication);
			return { success: true, publication: detailPublication };
		});
		const workspaceStore = createCanvasWorkspaceStore();
		render(TimelineLibraryMode, { props: { browseStore, workspaceStore } });
		let marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });

		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(
			within(screen.getByRole('menu')).getByRole('menuitem', { name: /Float from timeline/ })
		);
		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Homogenic, Undated/ });
			expect(marker).toHaveClass('floating');
		});
		vi.mocked(pushLibraryPageState).mockClear();

		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(
			within(screen.getByRole('menu')).getByRole('menuitem', { name: /Open album detail/ })
		);
		await waitFor(() => expect(pushLibraryPageState).toHaveBeenCalledTimes(1));
		const canonical = createTimelineCanvasModel(selected.albums);
		const anchor = canonical.entityById.get(ALBUM_ID)!;
		const offset = workspaceStore.offsetFor(ALBUM_ID)!;
		const projected = projectTimelineCanvasModel(
			canonical,
			new Map([[ALBUM_ID, { x: offset.dx, y: offset.dy }]])
		).entityById.get(ALBUM_ID)!;
		const expectedCamera = fitCamera(
			{
				x: projected.x - projected.width / 2,
				y: Math.min(projected.y - projected.height / 2, projected.y - 440 / 2),
				width: projected.width + 64 + 360,
				height: Math.max(projected.height, 440)
			},
			{ x: 0, y: 0, width: 1_400, height: 900 },
			{ padding: 72, maxScale: 1.18 }
		);
		const target = vi.mocked(pushLibraryPageState).mock.calls[0][0];
		if (target.libraryView !== 'timeline') throw new Error('expected Timeline page state');
		expect(target.snapshot.camera).toEqual({
			x: expectedCamera.centerX,
			y: expectedCamera.centerY,
			scale: expectedCamera.scale
		});
		expect(target.snapshot.camera.x).not.toBe(anchor.anchorX);
	});

	it('restores a dragged album before resolving one explicit original-zone action', async () => {
		const frames = installManualAnimationFrames();
		connectTestCore();
		strictArtistPageState();
		setZonesSnapshot([
			timelineZone('zone-test', 'Test'),
			timelineZone('zone-other', 'Other')
		]);
		const selected = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		const workspaceStore = createCanvasWorkspaceStore();
		const canonical = createTimelineCanvasModel(selected.albums);
		workspaceStore.reconcile(
			{ coreId: 'core-a', artistLocalId: ARTIST_ID },
			canonical.entities.map((album) => ({ id: album.id, x: album.anchorX, y: album.anchorY }))
		);
		workspaceStore.commitPlacement(workspaceStore.beginPlacement(ALBUM_ID)!, {
			dx: 37,
			dy: -12
		});
		const commitPlacement = vi.spyOn(workspaceStore, 'commitPlacement');
		const cancelPlacement = vi.spyOn(workspaceStore, 'cancelPlacement');
		const socket = new TimelineAlbumActionTestSocket();
		const albumActionController = timelineActionController(socket);
		const order: string[] = [];
		socket.onEmission = ({ event }) => {
			if (event === 'album-action:begin') order.push('begin');
		};
		render(TimelineLibraryMode, {
			props: { browseStore, workspaceStore, albumActionController }
		});
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		const capture = installSynchronousPointerCapture(viewport);
		const releaseImplementation = capture.releasePointerCapture.getMockImplementation();
		capture.releasePointerCapture.mockImplementation((pointerId) => {
			order.push('release');
			releaseImplementation?.(pointerId);
		});
		const { port, dockRect } = installZoneDockGeometry('zone-test');
		let marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });
		await waitFor(() => {
			expect(marker).toHaveAttribute('data-manual-offset-x', '37');
			expect(marker).toHaveAttribute('data-manual-offset-y', '-12');
		});

		await fireEvent.pointerDown(marker, {
			pointerId: 71,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		await fireEvent.pointerMove(viewport, {
			pointerId: 71,
			buttons: 1,
			clientX: 950,
			clientY: 130
		});
		frames.flush();
		await waitFor(() => expect(port).toHaveAttribute('data-highlighted', 'true'));
		expect(socket.count('album-action:begin')).toBe(0);
		expect(socket.count('album-action:execute')).toBe(0);
		dockRect.mockClear();

		await fireEvent.pointerUp(viewport, {
			pointerId: 71,
			clientX: 950,
			clientY: 130,
			altKey: true,
			ctrlKey: true,
			metaKey: true,
			shiftKey: true
		});
		await waitFor(() => expect(socket.count('album-action:begin')).toBe(1));
		expect(dockRect).toHaveBeenCalledTimes(1);
		expect(order).toEqual(['release', 'begin']);
		expect(workspaceStore.offsetFor(ALBUM_ID)).toEqual({ dx: 37, dy: -12 });
		expect(cancelPlacement).toHaveBeenCalledTimes(1);
		expect(commitPlacement).not.toHaveBeenCalled();
		expect(capture.releasePointerCapture).toHaveBeenCalledTimes(1);
		expect(socket.emission('album-action:begin').value).toEqual({
			requestId: 'timeline-mode-request',
			albumLocalId: ALBUM_ID,
			zoneId: 'zone-test',
			tabId: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
			generation: 7
		});
		expect(JSON.stringify(socket.emission('album-action:begin').value)).not.toMatch(
			/itemKey|handleId|selectedZone/
		);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
		expect(replaceLibraryPageState).not.toHaveBeenCalled();

		setSelectedZone('zone-other');
		acceptTimelineAlbumAction(socket);
		resolveTimelineAlbumActions(socket);
		const chooser = await screen.findByRole('dialog', { name: 'Homogenic' });
		expect(within(chooser).getByText('Target: Test')).toBeInTheDocument();
		const play = within(chooser).getByRole('button', { name: 'Play Now' });
		expect(within(chooser).getByRole('button', { name: 'Queue' })).toBeInTheDocument();
		expect(socket.count('album-action:execute')).toBe(0);
		await waitFor(() => expect(play).toHaveFocus());
		await fireEvent.keyDown(play, { key: '/' });
		expect(play).toHaveFocus();
		expect(screen.getByPlaceholderText('Search artists')).not.toHaveFocus();

		await fireEvent.click(play);
		await fireEvent.click(play);
		expect(socket.count('album-action:execute')).toBe(1);
		expect(socket.emission('album-action:execute').value).toEqual({ actionId: 'opaque-play' });
		expect(socket.count('album-action:cancel')).toBe(0);
		socket.emission('album-action:execute').ack({
			success: true,
			data: { claimed: true, outcome: 'executed' }
		});
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Homogenic' })).toBeNull());
		expect(get(commandFeedbackStore)).toMatchObject({
			source: 'transport',
			command: 'timeline:album-action:play-now',
			kind: 'success'
		});
		marker = screen.getByRole('button', { name: /Homogenic, Undated/ });
		await waitFor(() => expect(marker).toHaveFocus());
	});

	it('treats a vanished highlighted port as a no-action dock drop, not a workspace move', async () => {
		const frames = installManualAnimationFrames();
		connectTestCore();
		strictArtistPageState();
		setZonesSnapshot([timelineZone('zone-test', 'Test')]);
		const selected = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		const workspaceStore = createCanvasWorkspaceStore();
		const canonical = createTimelineCanvasModel(selected.albums);
		workspaceStore.reconcile(
			{ coreId: 'core-a', artistLocalId: ARTIST_ID },
			canonical.entities.map((album) => ({ id: album.id, x: album.anchorX, y: album.anchorY }))
		);
		workspaceStore.commitPlacement(workspaceStore.beginPlacement(ALBUM_ID)!, {
			dx: -24,
			dy: 19
		});
		const commitPlacement = vi.spyOn(workspaceStore, 'commitPlacement');
		const cancelPlacement = vi.spyOn(workspaceStore, 'cancelPlacement');
		const socket = new TimelineAlbumActionTestSocket();
		render(TimelineLibraryMode, {
			props: {
				browseStore,
				workspaceStore,
				albumActionController: timelineActionController(socket)
			}
		});
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		const capture = installSynchronousPointerCapture(viewport);
		const { port, dockRect } = installZoneDockGeometry('zone-test');
		const marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });

		await fireEvent.pointerDown(marker, {
			pointerId: 72,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		await fireEvent.pointerMove(viewport, {
			pointerId: 72,
			buttons: 1,
			clientX: 950,
			clientY: 130
		});
		frames.flush();
		await waitFor(() => expect(port).toHaveAttribute('data-highlighted', 'true'));
		setZonesSnapshot([]);
		await tick();
		expect(screen.queryByText('Test')).toBeNull();
		dockRect.mockClear();

		await fireEvent.pointerUp(viewport, {
			pointerId: 72,
			clientX: 950,
			clientY: 130
		});
		await waitFor(() => {
			expect(workspaceStore.offsetFor(ALBUM_ID)).toEqual({ dx: -24, dy: 19 });
		});
		expect(dockRect).toHaveBeenCalledTimes(1);
		expect(cancelPlacement).toHaveBeenCalledTimes(1);
		expect(commitPlacement).not.toHaveBeenCalled();
		expect(capture.releasePointerCapture).toHaveBeenCalledTimes(1);
		expect(socket.count('album-action:begin')).toBe(0);
		expect(socket.count('album-action:execute')).toBe(0);
		expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
			'Homogenic has no current zone target; no Roon command was sent.'
		);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
	});

	it('opens a six-pixel tap once while a drag plus compatibility click only commits placement', async () => {
		const frames = installManualAnimationFrames();
		connectTestCore();
		strictArtistPageState();
		const selected = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		const workspaceStore = createCanvasWorkspaceStore();
		const commitPlacement = vi.spyOn(workspaceStore, 'commitPlacement');
		const cancelPlacement = vi.spyOn(workspaceStore, 'cancelPlacement');
		render(TimelineLibraryMode, { props: { browseStore, workspaceStore } });
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		const capture = installSynchronousPointerCapture(viewport);
		let marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });

		await fireEvent.pointerDown(marker, {
			pointerId: 31,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		await fireEvent.pointerMove(viewport, {
			pointerId: 31,
			buttons: 1,
			clientX: 406,
			clientY: 300
		});
		await fireEvent.pointerUp(viewport, {
			pointerId: 31,
			clientX: 406,
			clientY: 300
		});
		await fireEvent.click(marker);

		await waitFor(() => expect(browseStore.openAlbum).toHaveBeenCalledTimes(1));
		expect(workspaceStore.offsetFor(ALBUM_ID)).toBeNull();
		expect(commitPlacement).not.toHaveBeenCalled();
		expect(cancelPlacement).toHaveBeenCalledTimes(1);

		marker = screen.getByRole('button', { name: /Homogenic, Undated/ });
		await fireEvent.pointerDown(marker, {
			pointerId: 32,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		await fireEvent.pointerMove(viewport, {
			pointerId: 32,
			buttons: 1,
			clientX: 436,
			clientY: 318
		});
		frames.flush();
		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Homogenic, Undated/ });
			expect(marker).toHaveClass('dragging', 'pinned');
		});
		await fireEvent.pointerUp(viewport, {
			pointerId: 32,
			clientX: 454,
			clientY: 318
		});
		await fireEvent.click(marker);

		await waitFor(() => expect(workspaceStore.offsetFor(ALBUM_ID)).toEqual({
			dx: 54,
			dy: 18
		}));
		expect(commitPlacement).toHaveBeenCalledTimes(1);
		expect(cancelPlacement).toHaveBeenCalledTimes(1);
		expect(browseStore.openAlbum).toHaveBeenCalledTimes(1);
		expect(capture.setPointerCapture).toHaveBeenCalledTimes(2);
		expect(capture.releasePointerCapture).toHaveBeenCalledTimes(2);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
	});

	it('preserves native Space on controls while neutral Space still arms hand-pan', async () => {
		connectTestCore();
		strictArtistPageState();
		const selected = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		render(TimelineLibraryMode, { props: { browseStore } });
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		installSynchronousPointerCapture(viewport);
		const marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });
		const nativeControl = screen.getByRole('button', { name: 'Album actions' });

		nativeControl.focus();
		expect(await fireEvent.keyDown(nativeControl, { key: ' ' })).toBe(true);
		await fireEvent.pointerDown(marker, {
			pointerId: 46,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		expect(viewport).toHaveAttribute('data-gesture-kind', 'album-armed');
		await fireEvent.keyDown(window, { key: 'Escape' });
		await fireEvent.keyUp(nativeControl, { key: ' ' });

		document.body.focus();
		expect(await fireEvent.keyDown(document.body, { key: ' ' })).toBe(false);
		await fireEvent.pointerDown(marker, {
			pointerId: 47,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		expect(viewport).toHaveAttribute('data-gesture-kind', 'pan');
		await fireEvent.keyDown(window, { key: 'Escape' });
		await fireEvent.keyUp(document.body, { key: ' ' });
	});

	it('commits terminal pointerup coordinates before a pending frame and ignores synchronous capture loss', async () => {
		const frames = installManualAnimationFrames();
		connectTestCore();
		strictArtistPageState();
		const selected = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		const workspaceStore = createCanvasWorkspaceStore();
		const commitPlacement = vi.spyOn(workspaceStore, 'commitPlacement');
		const cancelPlacement = vi.spyOn(workspaceStore, 'cancelPlacement');
		render(TimelineLibraryMode, { props: { browseStore, workspaceStore } });
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		const capture = installSynchronousPointerCapture(viewport);
		let marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });

		await fireEvent.pointerDown(marker, {
			pointerId: 33,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		await fireEvent.pointerMove(viewport, {
			pointerId: 33,
			buttons: 1,
			clientX: 436,
			clientY: 318
		});
		expect(frames.pending).toBe(1);
		await fireEvent.pointerUp(viewport, {
			pointerId: 33,
			clientX: 472,
			clientY: 336
		});
		expect(frames.pending).toBe(0);
		frames.invokeCancelled();

		await waitFor(() => {
			marker = screen.getByRole('button', { name: /Homogenic, Undated/ });
			expect(marker).toHaveAttribute('data-manual-offset-x', '72');
			expect(marker).toHaveAttribute('data-manual-offset-y', '36');
		});
		expect(workspaceStore.offsetFor(ALBUM_ID)).toEqual({ dx: 72, dy: 36 });
		expect(commitPlacement).toHaveBeenCalledTimes(1);
		expect(cancelPlacement).not.toHaveBeenCalled();
		expect(capture.releasePointerCapture).toHaveBeenCalledTimes(1);
	});

	it('still commits a terminal placement when releasePointerCapture throws', async () => {
		installManualAnimationFrames();
		connectTestCore();
		strictArtistPageState();
		const selected = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		const workspaceStore = createCanvasWorkspaceStore();
		const commitPlacement = vi.spyOn(workspaceStore, 'commitPlacement');
		const cancelPlacement = vi.spyOn(workspaceStore, 'cancelPlacement');
		render(TimelineLibraryMode, { props: { browseStore, workspaceStore } });
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		const releasePointerCapture = vi.fn(() => {
			throw new Error('synthetic release failure');
		});
		Object.defineProperties(viewport, {
			setPointerCapture: { configurable: true, value: vi.fn() },
			hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
			releasePointerCapture: { configurable: true, value: releasePointerCapture }
		});
		const marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });

		await fireEvent.pointerDown(marker, {
			pointerId: 43,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		await fireEvent.pointerMove(viewport, {
			pointerId: 43,
			buttons: 1,
			clientX: 436,
			clientY: 318
		});
		let terminalError: unknown;
		try {
			await fireEvent.pointerUp(viewport, {
				pointerId: 43,
				clientX: 454,
				clientY: 318
			});
		} catch (error) {
			terminalError = error;
		}

		expect(terminalError).toBeUndefined();
		expect(releasePointerCapture).toHaveBeenCalledTimes(1);
		expect(commitPlacement).toHaveBeenCalledTimes(1);
		expect(workspaceStore.offsetFor(ALBUM_ID)).toEqual({ dx: 54, dy: 18 });

		await fireEvent.pointerDown(marker, {
			pointerId: 45,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		let cancelError: unknown;
		try {
			await fireEvent.keyDown(window, { key: 'Escape' });
		} catch (error) {
			cancelError = error;
		}
		expect(cancelError).toBeUndefined();
		expect(releasePointerCapture).toHaveBeenCalledTimes(2);
		expect(cancelPlacement).toHaveBeenCalledTimes(1);
		expect(workspaceStore.offsetFor(ALBUM_ID)).toEqual({ dx: 54, dy: 18 });
	});

	it('restores the exact pre-offset and suppresses cancelled armed clicks without history', async () => {
		const frames = installManualAnimationFrames();
		connectTestCore();
		strictArtistPageState();
		const selected = selectionPublication();
		const canonical = createTimelineCanvasModel(selected.albums);
		const workspaceStore = createCanvasWorkspaceStore();
		workspaceStore.reconcile(
			{ coreId: 'core-a', artistLocalId: ARTIST_ID },
			canonical.entities.map((entity) => ({
				id: entity.id,
				x: entity.anchorX,
				y: entity.anchorY
			}))
		);
		const initial = workspaceStore.beginPlacement(ALBUM_ID)!;
		workspaceStore.commitPlacement(initial, { dx: 36, dy: -18 });
		const commitPlacement = vi.spyOn(workspaceStore, 'commitPlacement');
		const cancelPlacement = vi.spyOn(workspaceStore, 'cancelPlacement');
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		render(TimelineLibraryMode, { props: { browseStore, workspaceStore } });
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		const capture = installSynchronousPointerCapture(viewport);

		const beginDrag = async (pointerId: number) => {
			const marker = screen.getByRole('button', { name: /Homogenic, Undated/ });
			await fireEvent.pointerDown(marker, {
				pointerId,
				button: 0,
				isPrimary: true,
				clientX: 400,
				clientY: 300
			});
			await fireEvent.pointerMove(viewport, {
				pointerId,
				buttons: 1,
				clientX: 454,
				clientY: 336
			});
			frames.flush();
			await waitFor(() => expect(marker).toHaveClass('dragging'));
		};
		const expectRestored = async () => {
			await waitFor(() => {
				const marker = screen.getByRole('button', { name: /Homogenic, Undated/ });
				expect(marker).not.toHaveClass('dragging');
				expect(marker).toHaveAttribute('data-manual-offset-x', '36');
				expect(marker).toHaveAttribute('data-manual-offset-y', '-18');
			});
			expect(workspaceStore.offsetFor(ALBUM_ID)).toEqual({ dx: 36, dy: -18 });
		};

		await beginDrag(34);
		await fireEvent.pointerCancel(viewport, {
			pointerId: 34,
			clientX: 454,
			clientY: 336
		});
		await expectRestored();

		await beginDrag(35);
		capture.lose(35);
		await expectRestored();

		await beginDrag(36);
		await fireEvent.keyDown(window, { key: 'Escape' });
		await expectRestored();

		for (const [pointerId, cancel] of [
			[41, 'escape'],
			[42, 'lostcapture']
		] as const) {
			const marker = screen.getByRole('button', { name: /Homogenic, Undated/ });
			await fireEvent.pointerDown(marker, {
				pointerId,
				button: 0,
				isPrimary: true,
				clientX: 400,
				clientY: 300
			});
			await fireEvent.pointerMove(viewport, {
				pointerId,
				buttons: 1,
				clientX: 406,
				clientY: 300
			});
			if (cancel === 'escape') {
				await fireEvent.keyDown(window, { key: 'Escape' });
			} else {
				capture.lose(pointerId);
			}
			await fireEvent.pointerUp(viewport, {
				pointerId,
				clientX: 406,
				clientY: 300
			});
			await fireEvent.click(marker);
			await expectRestored();
		}

		expect(cancelPlacement).toHaveBeenCalledTimes(5);
		expect(commitPlacement).not.toHaveBeenCalled();
		expect(browseStore.openAlbum).not.toHaveBeenCalled();
		expect(pushLibraryPageState).not.toHaveBeenCalled();
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
	});

	it('settles one strict camera replacement only when a background pan ends', async () => {
		const frames = installManualAnimationFrames();
		connectTestCore();
		const pageState = strictArtistPageState({ x: 10, y: 20, scale: 1 });
		const selected = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		render(TimelineLibraryMode, { props: { browseStore } });
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		installSynchronousPointerCapture(viewport);
		vi.mocked(replaceLibraryPageState).mockClear();

		await fireEvent.pointerDown(viewport, {
			pointerId: 37,
			button: 0,
			isPrimary: true,
			clientX: 100,
			clientY: 100
		});
		await fireEvent.pointerMove(viewport, {
			pointerId: 37,
			buttons: 1,
			clientX: 140,
			clientY: 120
		});
		frames.flush();
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
		await fireEvent.pointerUp(viewport, {
			pointerId: 37,
			clientX: 160,
			clientY: 130
		});

		const expectedCamera = { x: -50, y: -10, scale: 1 };
		expect(replaceLibraryPageState).toHaveBeenCalledTimes(1);
		expect(replaceLibraryPageState).toHaveBeenCalledWith(
			buildTimelineLibraryPageState({
				...pageState.snapshot,
				camera: expectedCamera
			})
		);
		expect(screen.getByTestId('timeline-canvas-world').style.transform).toBe(
			cameraCssTransform(
				{ centerX: expectedCamera.x, centerY: expectedCamera.y, scale: expectedCamera.scale },
				{ x: 0, y: 0, width: 1_400, height: 900 }
			)
		);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
	});

	it('cancels a newer active pan before a deferred album publication applies its semantic camera', async () => {
		const frames = installManualAnimationFrames();
		connectTestCore();
		strictArtistPageState();
		const selected = selectionPublication();
		const descriptor = detailAlbum(false);
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums, {
			discography: { ...selected.discography, albums: [descriptor] }
		}));
		const detailPublication: TimelineDetailPublication = {
			detail: {
				artist: selected.artist,
				album: descriptor,
				orderedTrackTitles: ['Hunter']
			},
			session: { handleId: 'deferred-detail', generation: 9 }
		};
		let publishDetail: ((publication: TimelineDetailPublication) => void) | undefined;
		let resolveDetail!: (value: {
			success: true;
			publication: TimelineDetailPublication;
		}) => void;
		vi.mocked(browseStore.openAlbum).mockImplementation((_localId, onPublished) => {
			publishDetail = onPublished;
			return new Promise((resolve) => {
				resolveDetail = resolve;
			});
		});
		render(TimelineLibraryMode, { props: { browseStore } });
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		installSynchronousPointerCapture(viewport);
		const marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });

		await fireEvent.click(marker);
		expect(browseStore.openAlbum).toHaveBeenCalledTimes(1);
		expect(publishDetail).toBeTypeOf('function');
		await fireEvent.pointerDown(viewport, {
			pointerId: 44,
			button: 0,
			isPrimary: true,
			clientX: 100,
			clientY: 100
		});
		await fireEvent.pointerMove(viewport, {
			pointerId: 44,
			buttons: 1,
			clientX: 180,
			clientY: 140
		});
		frames.flush();
		await tick();
		expect(viewport).toHaveAttribute('data-gesture-kind', 'pan');

		publishDetail?.(detailPublication);
		await tick();
		expect(viewport).not.toHaveAttribute('data-gesture-kind');
		expect(pushLibraryPageState).toHaveBeenCalledTimes(1);
		const semanticTarget = vi.mocked(pushLibraryPageState).mock.calls[0][0];
		if (semanticTarget.libraryView !== 'timeline') {
			throw new Error('expected Timeline semantic target');
		}
		expect(semanticTarget.snapshot.selectedNode).toEqual({
			kind: 'album',
			localId: ALBUM_ID
		});
		expect(screen.getByTestId('timeline-canvas-world').style.transform).toBe(
			cameraCssTransform(
				{
					centerX: semanticTarget.snapshot.camera.x,
					centerY: semanticTarget.snapshot.camera.y,
					scale: semanticTarget.snapshot.camera.scale
				},
				{ x: 0, y: 0, width: 1_400, height: 900 }
			)
		);
		await fireEvent.pointerUp(viewport, {
			pointerId: 44,
			clientX: 180,
			clientY: 140
		});
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
		resolveDetail({ success: true, publication: detailPublication });
		await tick();
	});

	it('uses viewport-local wheel coordinates and settles one replacement after the full idle window', async () => {
		vi.useFakeTimers();
		const frames = installManualAnimationFrames();
		connectTestCore();
		const pageState = strictArtistPageState({ x: 100, y: 50, scale: 1 });
		const selected = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		render(TimelineLibraryMode, { props: { browseStore } });
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
			x: 100,
			y: 50,
			left: 100,
			top: 50,
			right: 1_500,
			bottom: 950,
			width: 1_400,
			height: 900,
			toJSON: () => ({})
		});
		vi.mocked(replaceLibraryPageState).mockClear();
		const localCursor = { x: 350, y: 200 };
		const viewportRect = { x: 0, y: 0, width: 1_400, height: 900 };
		let expected = zoomCameraAtPoint(
			{ centerX: 100, centerY: 50, scale: 1 },
			Math.exp(0.08),
			localCursor,
			viewportRect
		);
		expected = zoomCameraAtPoint(
			expected,
			expected.scale * Math.exp(0.12),
			localCursor,
			viewportRect
		);

		await fireEvent.wheel(viewport, {
			clientX: 450,
			clientY: 250,
			deltaY: -40,
			deltaMode: 0,
			ctrlKey: true
		});
		await fireEvent.wheel(viewport, {
			clientX: 450,
			clientY: 250,
			deltaY: -60,
			deltaMode: 0,
			ctrlKey: true
		});
		frames.flush();
		await tick();
		expect(screen.getByTestId('timeline-canvas-world').style.transform).toBe(
			cameraCssTransform(expected, viewportRect)
		);
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(159);
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(replaceLibraryPageState).toHaveBeenCalledTimes(1);
		expect(replaceLibraryPageState).toHaveBeenCalledWith(
			buildTimelineLibraryPageState({
				...pageState.snapshot,
				camera: { x: expected.centerX, y: expected.centerY, scale: expected.scale }
			})
		);
	});

	it('cancels pending wheel and drag work across modal and page transitions', async () => {
		vi.useFakeTimers();
		const frames = installManualAnimationFrames();
		connectTestCore();
		const pageState = strictArtistPageState();
		const selected = selectionPublication();
		const workspaceStore = createCanvasWorkspaceStore();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		render(TimelineLibraryMode, { props: { browseStore, workspaceStore } });
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		const world = screen.getByTestId('timeline-canvas-world');
		const settledTransform = world.style.transform;
		installSynchronousPointerCapture(viewport);
		vi.mocked(replaceLibraryPageState).mockClear();

		await fireEvent.wheel(viewport, { deltaX: 32, deltaY: 18, deltaMode: 0 });
		frames.flush();
		await tick();
		expect(world.style.transform).not.toBe(settledTransform);
		await fireEvent.click(screen.getByRole('button', { name: 'Album actions' }));
		expect(screen.getByRole('menu')).toBeInTheDocument();
		expect(world.style.transform).toBe(settledTransform);
		await vi.advanceTimersByTimeAsync(200);
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
		await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

		const marker = screen.getByRole('button', { name: /Homogenic, Undated/ });
		await fireEvent.pointerDown(marker, {
			pointerId: 38,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		await fireEvent.pointerMove(viewport, {
			pointerId: 38,
			buttons: 1,
			clientX: 454,
			clientY: 336
		});
		frames.flush();
		await waitFor(() => expect(marker).toHaveClass('dragging'));
		__setTestPage(
			'http://localhost/library?transition=1',
			buildLibraryPageStateEnvelope(buildTimelineLibraryPageState({
				...pageState.snapshot,
				camera: { x: 25, y: -10, scale: 1 }
			}))
		);

		await waitFor(() => expect(marker).not.toHaveClass('dragging'));
		expect(workspaceStore.offsetFor(ALBUM_ID)).toBeNull();
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
		expect(pushLibraryPageState).not.toHaveBeenCalled();
	});

	it('cancels an active placement and a separate wheel settlement when each viewport unmounts', async () => {
		vi.useFakeTimers();
		const frames = installManualAnimationFrames();
		connectTestCore();
		strictArtistPageState();
		const selected = selectionPublication();
		const dragWorkspace = createCanvasWorkspaceStore();
		const cancelPlacement = vi.spyOn(dragWorkspace, 'cancelPlacement');
		const dragStore = fakeBrowseStore(activeArtistState(selected.albums));
		const dragView = render(TimelineLibraryMode, {
			props: { browseStore: dragStore, workspaceStore: dragWorkspace }
		});
		let viewport = screen.getByTestId('timeline-canvas-viewport');
		installSynchronousPointerCapture(viewport);
		const marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });
		await fireEvent.pointerDown(marker, {
			pointerId: 39,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		await fireEvent.pointerMove(viewport, {
			pointerId: 39,
			buttons: 1,
			clientX: 454,
			clientY: 336
		});
		frames.flush();
		await tick();
		expect(marker).toHaveClass('dragging');
		dragView.unmount();
		expect(dragWorkspace.offsetFor(ALBUM_ID)).toBeNull();
		expect(cancelPlacement).toHaveBeenCalledTimes(1);

		strictArtistPageState();
		const wheelStore = fakeBrowseStore(activeArtistState(selected.albums));
		const wheelView = render(TimelineLibraryMode, { props: { browseStore: wheelStore } });
		viewport = screen.getByTestId('timeline-canvas-viewport');
		const wheelWorld = screen.getByTestId('timeline-canvas-world');
		const beforeWheel = wheelWorld.style.transform;
		vi.mocked(replaceLibraryPageState).mockClear();
		await fireEvent.wheel(viewport, { deltaX: 24, deltaY: 12, deltaMode: 0 });
		frames.flush();
		await tick();
		expect(wheelWorld.style.transform).not.toBe(beforeWheel);
		wheelView.unmount();
		await vi.advanceTimersByTimeAsync(200);
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
	});

	it('keeps the dragged marker pinned while respecting the production object and artwork caps', async () => {
		const frames = installManualAnimationFrames();
		connectTestCore();
		strictArtistPageState();
		const albums = Array.from({ length: 100 }, (_, index) =>
			calendarAlbum(`drag-cap-${String(index).padStart(3, '0')}`, 1940 + index, index, true)
		);
		const workspaceStore = createCanvasWorkspaceStore();
		const browseStore = fakeBrowseStore(activeArtistState(albums));
		render(TimelineLibraryMode, { props: { browseStore, workspaceStore } });
		const viewport = screen.getByTestId('timeline-canvas-viewport');
		installSynchronousPointerCapture(viewport);
		let marker = await screen.findByRole('button', { name: /Album drag-cap-000, 1940/ });

		await fireEvent.pointerDown(marker, {
			pointerId: 40,
			button: 0,
			isPrimary: true,
			clientX: 400,
			clientY: 300
		});
		await waitFor(() => expect(marker).toHaveClass('pinned'));
		await fireEvent.pointerMove(viewport, {
			pointerId: 40,
			buttons: 1,
			clientX: 3_400,
			clientY: 1_300
		});
		frames.flush();

		await waitFor(() => {
			marker = document.querySelector<HTMLButtonElement>('[data-album-id="drag-cap-000"]')!;
			expect(marker).not.toBeNull();
			expect(marker).toHaveClass('dragging', 'pinned');
		});
		expect(Number(viewport.dataset.renderedWorldObjects)).toBeLessThanOrEqual(72);
		expect(Number(viewport.dataset.renderedArtworkImages)).toBeLessThanOrEqual(40);
		expect(document.querySelectorAll('[data-world-object]').length).toBeLessThanOrEqual(72);
		expect(document.querySelectorAll('[data-timeline-artwork]').length).toBeLessThanOrEqual(40);
		await fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(marker).not.toHaveClass('dragging'));
		expect(workspaceStore.offsetFor('drag-cap-000')).toBeNull();
	});

	it('restores the exact context-menu marker instead of the previously focused marker', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([
			calendarAlbum('context-a', 2001, 0),
			calendarAlbum('context-b', 2002, 1)
		]));
		render(TimelineLibraryMode, { props: { browseStore } });
		const markerA = await screen.findByRole('button', { name: /Album context-a, 2001/ });
		const markerB = screen.getByRole('button', { name: /Album context-b, 2002/ });

		markerA.focus();
		await fireEvent.contextMenu(markerB);
		const menu = screen.getByRole('menu', { name: 'Album context-b actions' });
		await fireEvent.keyDown(menu, { key: 'Escape' });
		await waitFor(() => expect(markerB).toHaveFocus());
	});

	it('re-homes marker focus when a catalog replacement removes the focused album', async () => {
		connectTestCore();
		const initialState = activeArtistState([
			calendarAlbum('replace-a', 2001, 0),
			calendarAlbum('replace-b', 2002, 1)
		]);
		const browseStore = fakeBrowseStore(initialState);
		render(TimelineLibraryMode, { props: { browseStore } });
		const removed = await screen.findByRole('button', { name: /Album replace-b, 2002/ });
		removed.focus();

		browseStore.setState({
			...initialState,
			albums: [calendarAlbum('replace-a', 2001, 0)]
		});

		await waitFor(() => {
			expect(screen.queryByRole('button', { name: /Album replace-b, 2002/ })).toBeNull();
			expect(screen.getByRole('button', { name: /Album replace-a, 2001/ })).toHaveFocus();
		});
	});

	it('closes a removed toolbar-menu target and falls through its disabled opener to search', async () => {
		connectTestCore();
		const initialState = activeArtistState([calendarAlbum('removed-menu', 2003, 0)]);
		const browseStore = fakeBrowseStore(initialState);
		render(TimelineLibraryMode, { props: { browseStore } });
		await screen.findByRole('button', { name: /Album removed-menu, 2003/ });
		const toolbarTrigger = screen.getByRole('button', { name: 'Album actions' });
		toolbarTrigger.focus();
		await fireEvent.click(toolbarTrigger);
		expect(screen.getByRole('menu', { name: 'Album removed-menu actions' })).toBeInTheDocument();

		browseStore.setState({ ...initialState, albums: [] });

		await waitFor(() => {
			expect(screen.queryByRole('menu')).toBeNull();
			expect(toolbarTrigger).toBeDisabled();
			expect(screen.getByPlaceholderText('Search artists')).toHaveFocus();
		});
		expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
			'The album actions target is no longer in this Timeline.'
		);
	});

	it('keeps native Enter activation single-shot on the roving album button', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum('enter', 2002, 0)]));
		render(TimelineLibraryMode, { props: { browseStore } });
		const marker = await screen.findByRole('button', { name: /Album enter, 2002/ });
		const user = userEvent.setup();

		marker.focus();
		await user.keyboard('{Enter}');
		expect(browseStore.openAlbum).toHaveBeenCalledTimes(1);
		expect(browseStore.openAlbum).toHaveBeenCalledWith('enter', expect.any(Function));
	});

	it('pages the complete model through an inert 40-row list and restores its far cursor', async () => {
		connectTestCore();
		const albums = Array.from({ length: 81 }, (_, index) =>
			calendarAlbum(`list-${String(index).padStart(3, '0')}`, 1940 + index, index, true)
		);
		const browseStore = fakeBrowseStore(activeArtistState(albums));
		render(TimelineLibraryMode, { props: { browseStore } });

		await fireEvent.click(screen.getByRole('button', { name: 'Browse as list' }));
		const underlay = screen.getByTestId('timeline-spatial-underlay');
		expect(underlay).toHaveAttribute('inert');
		expect(underlay).toHaveAttribute('aria-hidden', 'true');
		expect(screen.getByTestId('timeline-canvas-viewport')).toHaveAttribute('inert');
		const dialog = screen.getByRole('dialog', { name: 'Browse active set as list' });
		const listedTitles: string[] = [];
		expect(dialog).toHaveAttribute('data-mounted-row-count', '40');
		expect(dialog.querySelectorAll('[data-timeline-list-row]')).toHaveLength(40);
		listedTitles.push(...Array.from(dialog.querySelectorAll('[data-timeline-list-row] strong'),
			(element) => element.textContent ?? ''));
		expect(dialog.querySelectorAll('[data-list-active="true"]')).toHaveLength(1);
		expect(dialog.querySelector('[data-list-active="true"]')).toHaveFocus();
		expect(screen.queryByRole('button', { name: /Album list-000, 1940/ })).toBeNull();

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
		expect(dialog.querySelectorAll('[data-timeline-list-row]')).toHaveLength(40);
		expect(within(dialog).getByText('Album list-040')).toBeInTheDocument();
		listedTitles.push(...Array.from(dialog.querySelectorAll('[data-timeline-list-row] strong'),
			(element) => element.textContent ?? ''));
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
		expect(dialog).toHaveAttribute('data-mounted-row-count', '1');
		expect(dialog.querySelectorAll('[data-timeline-list-row]')).toHaveLength(1);
		expect(within(dialog).getByText('Album list-080')).toBeInTheDocument();
		listedTitles.push(...Array.from(dialog.querySelectorAll('[data-timeline-list-row] strong'),
			(element) => element.textContent ?? ''));
		expect(listedTitles).toEqual(albums.map(({ title }) => title));
		expect(document.querySelector('[data-album-id="list-080"]')).toHaveClass('pinned');

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
		await waitFor(() => {
			const target = screen.getByRole('button', { name: /Album list-080, 2020/ });
			expect(target).toHaveFocus();
			expect(target).toHaveAttribute('tabindex', '0');
		});
		expect(underlay).not.toHaveAttribute('inert');
		expect(underlay).not.toHaveAttribute('aria-hidden');
		expect(document.querySelectorAll('[data-world-object]').length).toBeLessThanOrEqual(72);
		expect(document.querySelectorAll('[data-timeline-artwork]').length).toBeLessThanOrEqual(40);
	});

	it('opens one album from list mode and suppresses Slash while the modal owns focus', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([
			calendarAlbum('list-open-a', 2000, 0),
			calendarAlbum('list-open-b', 2001, 1)
		]));
		render(TimelineLibraryMode, { props: { browseStore } });
		await fireEvent.click(screen.getByRole('button', { name: 'Browse as list' }));
		const dialog = screen.getByRole('dialog', { name: 'Browse active set as list' });
		const activeRow = dialog.querySelector<HTMLButtonElement>('[data-list-active="true"]')!;
		await fireEvent.keyDown(activeRow, { key: '/' });
		expect(activeRow).toHaveFocus();

		await fireEvent.click(activeRow);
		await waitFor(() => expect(browseStore.openAlbum).toHaveBeenCalledTimes(1));
		expect(browseStore.openAlbum).toHaveBeenCalledWith('list-open-a', expect.any(Function));
		expect(screen.queryByRole('dialog', { name: 'Browse active set as list' })).toBeNull();
	});

	it('closes list mode with Escape without issuing browse or history mutations', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum('list-escape', 2003, 0)]));
		render(TimelineLibraryMode, { props: { browseStore } });
		await fireEvent.click(screen.getByRole('button', { name: 'Browse as list' }));
		const row = document.querySelector<HTMLButtonElement>('[data-list-active="true"]')!;
		expect(row).toHaveFocus();

		await fireEvent.keyDown(row, { key: 'Escape' });
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Browse active set as list' })).toBeNull();
			expect(screen.getByRole('button', { name: /Album list-escape, 2003/ })).toHaveFocus();
		});
		expect(browseStore.openAlbum).not.toHaveBeenCalled();
		expect(browseStore.restoreSnapshot).toHaveBeenCalledTimes(1);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
	});

	it('opens the same album action menu from the list cursor without duplicate controls', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum('list-actions', 2005, 0)]));
		render(TimelineLibraryMode, { props: { browseStore } });
		await fireEvent.click(screen.getByRole('button', { name: 'Browse as list' }));
		const row = document.querySelector<HTMLButtonElement>('[data-list-active="true"]')!;

		await fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
		const menu = await screen.findByRole('menu', { name: 'Album list-actions actions' });
		expect(screen.queryByRole('dialog', { name: 'Browse active set as list' })).toBeNull();
		expect(within(menu).getByRole('menuitem', { name: /Open album detail/ })).toHaveFocus();
		expect(document.querySelectorAll('[data-album-id="list-actions"]')).toHaveLength(1);

		await fireEvent.keyDown(menu, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /Album list-actions, 2005/ })).toHaveFocus()
		);
	});

	it('routes list named-zone parity through the same chooser and cancels a regrouped target', async () => {
		connectTestCore();
		setZonesSnapshot([timelineZone('zone-test', 'Test', ['output-a'])]);
		const selected = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		const socket = new TimelineAlbumActionTestSocket();
		render(TimelineLibraryMode, {
			props: {
				browseStore,
				albumActionController: timelineActionController(socket)
			}
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Browse as list' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Actions for Homogenic' }));
		const menu = await screen.findByRole('menu', { name: 'Homogenic actions' });
		const sendToTest = within(menu).getByRole('menuitem', { name: /Send to Test/ });
		expect(sendToTest).toBeEnabled();
		await fireEvent.click(sendToTest);

		await waitFor(() => expect(socket.count('album-action:begin')).toBe(1));
		expect(screen.queryByRole('menu', { name: 'Homogenic actions' })).toBeNull();
		expect(screen.queryByRole('dialog', { name: 'Browse active set as list' })).toBeNull();
		expect(socket.emission('album-action:begin').value).toMatchObject({
			albumLocalId: ALBUM_ID,
			zoneId: 'zone-test',
			generation: 7
		});
		expect(socket.count('album-action:execute')).toBe(0);
		acceptTimelineAlbumAction(socket);
		resolveTimelineAlbumActions(socket);
		expect(await screen.findByRole('button', { name: 'Play Now' })).toBeInTheDocument();

		setZonesSnapshot([timelineZone('zone-test', 'Test', ['output-b'])]);
		await waitFor(() => expect(socket.count('album-action:cancel')).toBe(1));
		expect(socket.emission('album-action:cancel').value).toEqual({
			operationId: 'timeline-mode-operation'
		});
		expect(screen.queryByRole('dialog', { name: 'Homogenic' })).toBeNull();
		expect(socket.count('album-action:execute')).toBe(0);
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /Homogenic, Undated/ })).toHaveFocus()
		);
	});

	it('registers a reversible lifecycle that quiesces once and restores action/workspace runtime on rollback', async () => {
		connectTestCore();
		const pageState = strictArtistPageState();
		setZonesSnapshot([timelineZone('zone-test', 'Test')]);
		const selected = selectionPublication();
		const browseStore = fakeBrowseStore(activeArtistState(selected.albums));
		const branchStore = createTimelineBranchStore();
		const workspaceStore = createCanvasWorkspaceStore();
		const socket = new TimelineAlbumActionTestSocket();
		const controller = timelineActionController(socket, 'rollback-request');
		const branchQuiesce = vi.spyOn(branchStore, 'quiesce');
		const workspaceSuspend = vi.spyOn(workspaceStore, 'suspendRuntime');
		const unregister = vi.fn();
		const lifecycleRegistration: { current: LibraryModeLifecycle | null } = { current: null };
		const activation = { cause: 'user-switch' as const, pageState };
		const registerLifecycle = vi.fn(
			(_mode: 'timeline', registered: LibraryModeLifecycle) => {
				lifecycleRegistration.current = registered;
				registered.resume(activation);
				return unregister;
			}
		);
		const activationContext: LibraryModeActivationContext = {
			classicTruncationHistoryPolicy: () => 'preserve',
			committedActivation: () => activation,
			registerLifecycle
		};
		const view = render(TimelineLibraryMode, {
			props: {
				browseStore,
				branchStore,
				workspaceStore,
				albumActionController: controller
			},
			context: new Map([[LIBRARY_MODE_ACTIVATION_CONTEXT, activationContext]])
		});

		await waitFor(() => expect(registerLifecycle).toHaveBeenCalledWith('timeline', expect.any(Object)));
		await waitFor(() => expect(get(workspaceStore).albumCount).toBe(1));
		workspaceStore.commitPlacement(workspaceStore.beginPlacement(ALBUM_ID)!, { dx: 12, dy: -8 });
		let marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });
		await fireEvent.contextMenu(marker);
		await fireEvent.click(screen.getByRole('menuitem', { name: /Send to Test/ }));
		await waitFor(() => expect(socket.count('album-action:begin')).toBe(1));

		const registeredLifecycle = lifecycleRegistration.current;
		if (!registeredLifecycle) throw new Error('Timeline lifecycle was not registered');
		registeredLifecycle.suspend();
		expect(socket.count('album-action:cancel')).toBe(1);
		expect(browseStore.quiesce).toHaveBeenCalledTimes(1);
		expect(branchQuiesce).toHaveBeenCalledTimes(1);
		expect(workspaceSuspend).toHaveBeenCalledTimes(1);
		expect(get(workspaceStore)).toMatchObject({
			albumCount: 0,
			modelFingerprint: null,
			offsets: [{ albumLocalId: ALBUM_ID, dx: 12, dy: -8 }]
		});
		registeredLifecycle.suspend();
		expect(browseStore.quiesce).toHaveBeenCalledTimes(1);
		expect(branchQuiesce).toHaveBeenCalledTimes(1);
		expect(workspaceSuspend).toHaveBeenCalledTimes(1);

		registeredLifecycle.resume(activation);
		await waitFor(() => expect(get(workspaceStore).albumCount).toBe(1));
		expect(workspaceStore.positionFor(ALBUM_ID)).not.toBeNull();
		marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });
		await fireEvent.contextMenu(marker);
		await fireEvent.click(screen.getByRole('menuitem', { name: /Send to Test/ }));
		await waitFor(() => expect(socket.count('album-action:begin')).toBe(2));

		view.unmount();
		expect(unregister).toHaveBeenCalledTimes(1);
	});

	it('bounds Timeline listeners, observers, frames, subscriptions, DOM, and images across 20 lifecycle cycles', async () => {
		const trackedWindowEvents = new Set(['keydown', 'keyup', 'blur', 'focusin']);
		const addListener = vi.spyOn(window, 'addEventListener');
		const removeListener = vi.spyOn(window, 'removeEventListener');
		const activeWindowListeners = (event: string): number =>
			addListener.mock.calls.filter(([type]) => type === event).length -
			removeListener.mock.calls.filter(([type]) => type === event).length;
		const expectActiveWindowListeners = (active: boolean): void => {
			const expected = active
				? { keydown: 2, keyup: 1, blur: 1, focusin: 1 }
				: { keydown: 0, keyup: 0, blur: 0, focusin: 0 };
			for (const event of trackedWindowEvents) {
				expect(activeWindowListeners(event)).toBe(expected[event as keyof typeof expected]);
			}
		};

		let activeObservers = 0;
		let constructedObservers = 0;
		class TrackingResizeObserver {
			private active = false;

			constructor(_callback: ResizeObserverCallback) {
				constructedObservers += 1;
			}

			observe(): void {
				if (this.active) return;
				this.active = true;
				activeObservers += 1;
			}

			unobserve(): void {}

			disconnect(): void {
				if (!this.active) return;
				this.active = false;
				activeObservers -= 1;
			}
		}
		vi.stubGlobal('ResizeObserver', TrackingResizeObserver);
		const frames = installManualAnimationFrames();

		const pageState = strictArtistPageState();
		const activation = { cause: 'user-switch' as const, pageState };
		let registeredLifecycle: LibraryModeLifecycle | null = null;
		const unregister = vi.fn();
		const activationContext: LibraryModeActivationContext = {
			classicTruncationHistoryPolicy: () => 'preserve',
			committedActivation: () => activation,
			registerLifecycle: (_mode, lifecycle) => {
				registeredLifecycle = lifecycle;
				lifecycle.resume(activation);
				return unregister;
			}
		};
		const browseStore = fakeBrowseStore(browseState());
		const workspaceStore = createCanvasWorkspaceStore();
		const socket = new TimelineAlbumActionTestSocket();
		const controller = timelineActionController(socket, 'lifecycle-cycle-request');
		const originalSubscribe = controller.subscribe.bind(controller);
		let activeActionSubscriptions = 0;
		vi.spyOn(controller, 'subscribe').mockImplementation((run) => {
			activeActionSubscriptions += 1;
			const unsubscribe = originalSubscribe(run);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				activeActionSubscriptions -= 1;
				unsubscribe();
			};
		});
		const view = render(TimelineLibraryMode, {
			props: {
				artistName: 'Lifecycle Artist',
				albums: [calendarAlbum('lifecycle-album', 2001, 0, true)],
				browseStore,
				workspaceStore,
				albumActionController: controller
			},
			context: new Map([[LIBRARY_MODE_ACTIVATION_CONTEXT, activationContext]])
		});
		let unmounted = false;

		try {
			await waitFor(() => expect(registeredLifecycle).not.toBeNull());
			await waitFor(() => expect(activeObservers).toBe(1));
			expect(activeActionSubscriptions).toBe(1);
			expectActiveWindowListeners(true);

			for (let cycle = 0; cycle < 20; cycle += 1) {
				const viewport = screen.getByTestId('timeline-canvas-viewport');
				await fireEvent.wheel(viewport, { deltaY: 24 });
				expect(frames.pending).toBeGreaterThan(0);

				registeredLifecycle!.suspend();
				expect(activeObservers).toBe(0);
				expect(frames.pending).toBe(0);
				expect(activeActionSubscriptions).toBe(0);
				expectActiveWindowListeners(false);

				registeredLifecycle!.resume(activation);
				await waitFor(() => expect(activeObservers).toBe(1));
				expect(activeActionSubscriptions).toBe(1);
				expectActiveWindowListeners(true);
				expect(document.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
				expect(document.querySelectorAll('[data-testid="timeline-canvas-world"]')).toHaveLength(1);
				expect(
					Number(screen.getByTestId('timeline-canvas-viewport').dataset.renderedWorldObjects)
				).toBeLessThanOrEqual(72);
				expect(
					Number(screen.getByTestId('timeline-canvas-viewport').dataset.renderedArtworkImages)
				).toBeLessThanOrEqual(40);
			}

			view.unmount();
			unmounted = true;
			expect(activeObservers).toBe(0);
			expect(frames.pending).toBe(0);
			expect(activeActionSubscriptions).toBe(0);
			expectActiveWindowListeners(false);
			expect(document.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(0);
			expect(document.querySelectorAll('[data-world-object]')).toHaveLength(0);
			expect(document.querySelectorAll('[data-timeline-artwork]')).toHaveLength(0);
			expect(constructedObservers).toBe(21);
			expect(unregister).toHaveBeenCalledTimes(1);
		} finally {
			if (!unmounted) view.unmount();
			addListener.mockRestore();
			removeListener.mockRestore();
			vi.unstubAllGlobals();
		}
	});

	it('cancels pre-choice authority on unmount but detaches an executing owner until feedback', async () => {
		connectTestCore();
		strictArtistPageState();
		setZonesSnapshot([timelineZone('zone-test', 'Test')]);
		const selected = selectionPublication();
		const resolvingSocket = new TimelineAlbumActionTestSocket();
		const resolvingView = render(TimelineLibraryMode, {
			props: {
				browseStore: fakeBrowseStore(activeArtistState(selected.albums)),
				albumActionController: timelineActionController(
					resolvingSocket,
					'resolving-request'
				)
			}
		});
		let marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });
		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(screen.getByRole('menuitem', { name: /Send to Test/ }));
		await waitFor(() => expect(resolvingSocket.count('album-action:begin')).toBe(1));

		resolvingView.unmount();
		expect(resolvingSocket.count('album-action:cancel')).toBe(1);
		expect(resolvingSocket.emission('album-action:cancel').value).toEqual({
			requestId: 'resolving-request'
		});
		expect(resolvingSocket.count('album-action:execute')).toBe(0);

		clearCommandFeedback();
		const executingSocket = new TimelineAlbumActionTestSocket();
		const executingView = render(TimelineLibraryMode, {
			props: {
				browseStore: fakeBrowseStore(activeArtistState(selected.albums)),
				albumActionController: timelineActionController(
					executingSocket,
					'executing-request'
				)
			}
		});
		marker = await screen.findByRole('button', { name: /Homogenic, Undated/ });
		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		await fireEvent.click(screen.getByRole('menuitem', { name: /Send to Test/ }));
		await waitFor(() => expect(executingSocket.count('album-action:begin')).toBe(1));
		acceptTimelineAlbumAction(
			executingSocket,
			'executing-request',
			'executing-operation'
		);
		resolveTimelineAlbumActions(
			executingSocket,
			'executing-request',
			'executing-operation'
		);
		await fireEvent.click(await screen.findByRole('button', { name: 'Queue' }));
		expect(executingSocket.count('album-action:execute')).toBe(1);
		const cancelCount = executingSocket.count('album-action:cancel');

		executingView.unmount();
		expect(executingSocket.count('album-action:cancel')).toBe(cancelCount);
		expect(executingSocket.count('album-action:execute')).toBe(1);
		executingSocket.emission('album-action:execute').ack({
			success: true,
			data: { claimed: true, outcome: 'executed' }
		});
		expect(get(commandFeedbackStore)).toMatchObject({
			source: 'queue',
			command: 'timeline:album-action:queue',
			kind: 'success',
			message: 'Queue for Homogenic in Test completed.'
		});
		expect(executingSocket.count('album-action:cancel')).toBe(cancelCount);
	});

	it('keeps the list cursor focused across reorder, removal, and an empty replacement', async () => {
		connectTestCore();
		const albums = Array.from({ length: 81 }, (_, index) =>
			calendarAlbum(`live-list-${String(index).padStart(3, '0')}`, 1940 + index, index)
		);
		const initialState = activeArtistState(albums);
		const browseStore = fakeBrowseStore(initialState);
		render(TimelineLibraryMode, { props: { browseStore } });
		await fireEvent.click(screen.getByRole('button', { name: 'Browse as list' }));
		const dialog = screen.getByRole('dialog', { name: 'Browse active set as list' });
		const firstRow = dialog.querySelector<HTMLButtonElement>('[data-list-active="true"]')!;

		await fireEvent.keyDown(firstRow, { key: 'End' });
		await waitFor(() => {
			const lastRow = dialog.querySelector<HTMLElement>(
				'[data-list-album-id="live-list-080"]'
			);
			expect(lastRow).toHaveFocus();
			expect(within(dialog).getByText('Page 3 of 3')).toBeInTheDocument();
		});

		const movedFirst = calendarAlbum('live-list-080', 1930, 80);
		const reordered = [movedFirst, ...albums.slice(0, 80)];
		browseStore.setState({ ...initialState, albums: reordered });
		await waitFor(() => {
			const activeRows = dialog.querySelectorAll('[data-list-active="true"]');
			expect(activeRows).toHaveLength(1);
			expect(activeRows[0]).toHaveAttribute('data-list-album-id', 'live-list-080');
			expect(activeRows[0]).toHaveAttribute('tabindex', '0');
			expect(activeRows[0]).toHaveFocus();
			expect(within(dialog).getByText('Page 1 of 3')).toBeInTheDocument();
			expect(dialog.querySelectorAll('[data-timeline-list-row]').length).toBeLessThanOrEqual(40);
		});

		browseStore.setState({ ...initialState, albums: albums.slice(0, 80) });
		await waitFor(() => {
			const activeRows = dialog.querySelectorAll('[data-list-active="true"]');
			expect(activeRows).toHaveLength(1);
			expect(activeRows[0]).toHaveAttribute('data-list-album-id', 'live-list-000');
			expect(activeRows[0]).toHaveFocus();
		});

		browseStore.setState({ ...initialState, albums: [] });
		await waitFor(() => {
			expect(dialog.querySelectorAll('[data-timeline-list-row]')).toHaveLength(0);
			expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
		});
		const sharedModal = document.createElement('div');
		sharedModal.setAttribute('role', 'dialog');
		sharedModal.setAttribute('aria-modal', 'true');
		const sharedControl = document.createElement('button');
		sharedControl.textContent = 'Newer shared focus';
		sharedModal.appendChild(sharedControl);
		const searchFocus = vi.fn();
		screen.getByPlaceholderText('Search artists').addEventListener('focus', searchFocus);
		within(dialog).getByRole('button', { name: 'Close' }).click();
		document.body.appendChild(sharedModal);
		sharedControl.focus();
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Browse active set as list' })).toBeNull();
			expect(sharedControl).toHaveFocus();
		});
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(searchFocus).not.toHaveBeenCalled();
		sharedModal.remove();
	});

	it('keeps a newer native list focus over an unresolved End navigation', async () => {
		connectTestCore();
		const albums = Array.from({ length: 81 }, (_, index) =>
			calendarAlbum(`list-race-${String(index).padStart(3, '0')}`, 1940 + index, index)
		);
		const browseStore = fakeBrowseStore(activeArtistState(albums));
		render(TimelineLibraryMode, { props: { browseStore } });
		await fireEvent.click(screen.getByRole('button', { name: 'Browse as list' }));
		const dialog = screen.getByRole('dialog', { name: 'Browse active set as list' });
		const first = dialog.querySelector<HTMLButtonElement>(
			'[data-list-album-id="list-race-000"]'
		)!;
		const second = dialog.querySelector<HTMLButtonElement>(
			'[data-list-album-id="list-race-001"]'
		)!;

		first.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'End', bubbles: true, cancelable: true
		}));
		second.focus();
		await waitFor(() => {
			expect(second).toHaveFocus();
			expect(second).toHaveAttribute('data-list-active', 'true');
			expect(within(dialog).getByText('Page 1 of 3')).toBeInTheDocument();
		});

		second.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'End', bubbles: true, cancelable: true
		}));
		const close = within(dialog).getByRole('button', { name: 'Close' });
		close.focus();
		await waitFor(() => expect(close).toHaveFocus());
	});

	it('leaves list Escape and Tab with a newer shared modal owner', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum('list-owner', 2007, 0)]));
		render(TimelineLibraryMode, { props: { browseStore } });
		await fireEvent.click(screen.getByRole('button', { name: 'Browse as list' }));
		const listDialog = screen.getByRole('dialog', { name: 'Browse active set as list' });
		const row = listDialog.querySelector<HTMLButtonElement>('[data-list-active="true"]')!;
		expect(row).toHaveAttribute('aria-haspopup', 'menu');
		expect(row).toHaveAttribute('aria-keyshortcuts', 'Enter Shift+F10');
		const outsideOpener = document.createElement('button');
		outsideOpener.textContent = 'Shared modal opener';
		document.body.appendChild(outsideOpener);
		const externalDialog = document.createElement('div');
		externalDialog.setAttribute('role', 'dialog');
		externalDialog.setAttribute('aria-modal', 'true');
		const externalButton = document.createElement('button');
		externalButton.textContent = 'Newer shared modal';
		externalDialog.appendChild(externalButton);
		document.body.appendChild(externalDialog);
		externalButton.focus();

		await fireEvent.keyDown(externalButton, { key: 'Tab' });
		expect(externalButton).toHaveFocus();
		await fireEvent.keyDown(row, { key: 'Escape' });
		expect(listDialog).toBeInTheDocument();
		await fireEvent.keyDown(externalButton, { key: 'Escape' });
		expect(listDialog).toBeInTheDocument();

		externalDialog.remove();
		outsideOpener.focus();
		await fireEvent.keyDown(outsideOpener, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog', {
			name: 'Browse active set as list'
		})).toBeNull());
		outsideOpener.remove();
	});

	it('leaves action-menu Escape and Tab with a newer shared modal owner', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum('menu-owner', 2008, 0)]));
		render(TimelineLibraryMode, { props: { browseStore } });
		const marker = await screen.findByRole('button', { name: /Album menu-owner, 2008/ });
		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		const actionDialog = screen.getByRole('dialog', {
			name: 'Album actions for Album menu-owner'
		});
		const menu = screen.getByRole('menu', { name: 'Album menu-owner actions' });
		const outsideOpener = document.createElement('button');
		outsideOpener.textContent = 'Shared modal opener';
		document.body.appendChild(outsideOpener);
		const externalDialog = document.createElement('div');
		externalDialog.setAttribute('role', 'dialog');
		externalDialog.setAttribute('aria-modal', 'true');
		const externalButton = document.createElement('button');
		externalButton.textContent = 'Newer shared modal';
		externalDialog.appendChild(externalButton);
		document.body.appendChild(externalDialog);
		externalButton.focus();

		await fireEvent.keyDown(externalButton, { key: 'Tab' });
		expect(externalButton).toHaveFocus();
		await fireEvent.keyDown(menu, { key: 'Escape' });
		expect(actionDialog).toBeInTheDocument();
		await fireEvent.keyDown(externalButton, { key: 'Escape' });
		expect(actionDialog).toBeInTheDocument();

		externalDialog.remove();
		outsideOpener.focus();
		await fireEvent.keyDown(outsideOpener, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		outsideOpener.remove();
	});

	it('keeps disconnected markers roving with local actions but no detail activation', async () => {
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum('offline', 2004, 0)]));
		render(TimelineLibraryMode, { props: { browseStore } });
		const marker = await screen.findByRole('button', { name: /Album offline, 2004/ });

		expect(marker).not.toHaveAttribute('aria-disabled');
		expect(marker).toHaveAccessibleName(
			/Album detail unavailable; layout actions remain available with Shift\+F10/
		);
		expect(marker).toHaveAttribute('tabindex', '0');
		await fireEvent.click(marker);
		expect(browseStore.openAlbum).not.toHaveBeenCalled();
	});

	it.each([
		{ sessionPhase: 'none' as const, session: null },
		{ sessionPhase: 'stale' as const, session: { handleId: 'stale-handle', generation: 3 } }
	])('allows the store to recover a connected $sessionPhase session before opening detail', async ({
		sessionPhase,
		session
	}) => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([calendarAlbum(`recover-${sessionPhase}`, 2006, 0)], {
			session,
			sessionPhase,
			recoveryRequired: true
		}));
		render(TimelineLibraryMode, { props: { browseStore } });
		const marker = await screen.findByRole('button', {
			name: new RegExp(`Album recover-${sessionPhase}, 2006`)
		});

		expect(marker).not.toHaveAttribute('aria-disabled');
		expect(marker).not.toHaveAccessibleName(/detail unavailable/i);
		await fireEvent.click(marker);
		expect(browseStore.openAlbum).toHaveBeenCalledTimes(1);
	});

	it('leaves detail closure to the approved browser Back path without inventing an Escape entry', async () => {
		connectTestCore();
		const publication = selectionPublication();
		const descriptor = detailAlbum(false);
		const browseStore = fakeBrowseStore(activeArtistState(publication.albums, {
			discography: { ...publication.discography, albums: [descriptor] },
			detailPhase: 'ready',
			selectedAlbumLocalId: ALBUM_ID,
			selectedAlbumDescriptor: descriptor,
			detail: {
				artist: publication.artist,
				album: descriptor,
				orderedTrackTitles: ['Hunter']
			}
		}));
		render(TimelineLibraryMode, { props: { browseStore } });
		await waitFor(() => expect(browseStore.restoreSnapshot).toHaveBeenCalledTimes(1));
		vi.mocked(browseStore.restoreSnapshot).mockClear();
		vi.mocked(pushLibraryPageState).mockClear();
		const marker = screen.getByRole('button', { name: /Homogenic, Undated/ });

		await fireEvent.keyDown(marker, { key: 'Escape' });
		expect(screen.getByLabelText('Homogenic album detail')).toBeInTheDocument();
		expect(browseStore.restoreSnapshot).not.toHaveBeenCalled();
		expect(pushLibraryPageState).not.toHaveBeenCalled();

		marker.focus();
		await fireEvent.keyDown(marker, { key: 'F10', shiftKey: true });
		const menu = screen.getByRole('menu', { name: 'Homogenic actions' });
		const openDetail = within(menu).getByRole('menuitem', { name: /Open album detail/ });
		expect(openDetail).toBeDisabled();
		expect(openDetail).toHaveTextContent('Already open');
		await fireEvent.keyDown(menu, { key: 'Escape' });
	});

	it('uses one semantic polite announcer and ignores camera and pointer-only changes', async () => {
		connectTestCore();
		const browseStore = fakeBrowseStore(activeArtistState([
			calendarAlbum('announce-a', 2000, 0),
			calendarAlbum('announce-b', 2001, 1)
		]));
		render(TimelineLibraryMode, { props: { browseStore } });
		const liveRegions = document.querySelectorAll('[aria-live="polite"]');
		expect(liveRegions).toHaveLength(1);
		const announcer = liveRegions[0];
		const marker = await screen.findByRole('button', { name: /Album announce-a, 2000/ });

		await fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
		await fireEvent.mouseMove(screen.getByTestId('timeline-canvas-viewport'), {
			clientX: 320,
			clientY: 220
		});
		expect(announcer).toHaveTextContent('');

		marker.focus();
		await fireEvent.keyDown(marker, { key: 'ArrowRight' });
		await waitFor(() => expect(announcer).toHaveTextContent('Album announce-b, 2001'));
	});

	it('renders one attached non-actionable Resolve required slab from retained metadata', () => {
		const publication = selectionPublication();
		const descriptor = detailAlbum();
		const browseStore = fakeBrowseStore(browseState({
			query: publication.query,
			catalogStatus: publication.discography.status,
			selectedArtist: publication.artist,
			discography: { ...publication.discography, albums: [descriptor] },
			albums: publication.albums,
			session: publication.session,
			sessionPhase: 'stale',
			detailPhase: 'error',
			detailError: 'Resolve required',
			detailFailureCode: 'ALBUM_NOT_FOUND',
			selectedAlbumLocalId: ALBUM_ID,
			selectedAlbumDescriptor: descriptor,
			recoveryRequired: true
		}));
		render(TimelineLibraryMode, { props: { browseStore } });

		expect(screen.getByText('Resolve required')).toBeInTheDocument();
		const slab = document.querySelector<HTMLElement>('[data-album-detail-id]');
		expect(slab).not.toBeNull();
		expect(document.querySelectorAll('[data-album-detail-id]')).toHaveLength(1);
		expect(slab?.querySelectorAll('button')).toHaveLength(0);
		expect(slab?.querySelectorAll('[data-detail-track]')).toHaveLength(0);
		expect(slab?.querySelector('img')).toHaveAttribute('loading', 'lazy');
	});

	it('keeps a restored missing catalog target mounted as a marker and slab without socket authority', async () => {
		setSocketStatus('connected');
		setCoreStatus({
			status: 'paired',
			core: { id: 'core-a', displayName: 'Test Core', displayVersion: '1' }
		});
		const pageState = buildTimelineLibraryPageState({
			artistQuery: 'Björk',
			selectedArtistLocalId: ARTIST_ID,
			activeSemanticPath: [
				{ kind: 'artist', localId: ARTIST_ID },
				{ kind: 'album', localId: ALBUM_ID }
			],
			selectedNode: { kind: 'album', localId: ALBUM_ID },
			camera: { x: 0, y: 0, scale: 1 },
			displayDepth: 1
		});
		__resetTestPage(
			'http://localhost/library',
			buildLibraryPageStateEnvelope(pageState)
		);
		const socket = {
			connected: true,
			on: vi.fn(),
			off: vi.fn(),
			emit: vi.fn(),
			timeout: vi.fn(() => ({ emit: vi.fn() }))
		};
		socket.on.mockReturnValue(socket);
		socket.off.mockReturnValue(socket);
		socket.emit.mockReturnValue(socket);
		const catalog = missingCatalogResponse();
		const browseStore = createTimelineBrowseSessionStore({
			getSocket: () => socket,
			isReady: () => true,
			fetchStatus: vi.fn().mockResolvedValue(catalog.status),
			fetchArtistAlbums: vi.fn().mockResolvedValue(catalog)
		});
		render(TimelineModeActivationHost, { props: { browseStore, pageState } });

		await screen.findByText('Resolve required');
		expect(document.querySelectorAll(`[data-album-id="${ALBUM_ID}"]`)).toHaveLength(1);
		expect(document.querySelectorAll(`[data-album-detail-id="${ALBUM_ID}"]`)).toHaveLength(1);
		expect(socket.emit).not.toHaveBeenCalled();
		expect(pushLibraryPageState).not.toHaveBeenCalled();
	});

	it('pages tracks at 40 and reserves the slab inside the actual DOM budgets', async () => {
		const publication = selectionPublication();
		const descriptor = detailAlbum();
		const layouts: TimelineAlbumLayoutInput[] = [
			{ ...publication.albums[0], imageKeyHint: descriptor.imageKeyHint },
			...Array.from({ length: 499 }, (_, index) =>
				calendarAlbum(`dense-${String(index).padStart(3, '0')}`, 1950 + (index % 50), index + 1, true)
			)
		];
		const browseStore = fakeBrowseStore(browseState({
			query: publication.query,
			catalogStatus: publication.discography.status,
			selectedArtist: publication.artist,
			discography: { ...publication.discography, albums: [descriptor] },
			albums: layouts,
			session: publication.session,
			sessionPhase: 'live',
			detailPhase: 'ready',
			selectedAlbumLocalId: ALBUM_ID,
			selectedAlbumDescriptor: descriptor,
			detail: {
				artist: publication.artist,
				album: descriptor,
				orderedTrackTitles: Array.from({ length: 81 }, (_, index) => `Track ${index + 1}`)
			}
		}));
		render(TimelineLibraryMode, { props: { browseStore } });

		expect(document.querySelectorAll('[data-detail-track]')).toHaveLength(40);
		expect(screen.getByText('Track 40')).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
		expect(document.querySelectorAll('[data-detail-track]')).toHaveLength(40);
		expect(screen.getByText('Track 41')).toBeInTheDocument();
		expect(screen.getByText('Track 80')).toBeInTheDocument();
		expect(document.querySelectorAll('[data-world-object]').length).toBeLessThanOrEqual(72);
		expect(
			document.querySelectorAll('[data-timeline-artwork], [data-timeline-detail-artwork]').length
		).toBeLessThanOrEqual(40);
		expect(document.querySelectorAll('[data-timeline-detail-artwork]')).toHaveLength(1);
	});

	it('applies a committed restored camera without a reactive auto-fit overwrite', async () => {
		setSocketStatus('connected');
		setCoreStatus({
			status: 'paired',
			core: { id: 'core-a', displayName: 'Test Core', displayVersion: '1' }
		});
		const pageState = buildTimelineLibraryPageState({
			artistQuery: '',
			selectedArtistLocalId: null,
			activeSemanticPath: [],
			selectedNode: null,
			camera: { x: 321, y: -123, scale: 0.5 },
			displayDepth: 0
		});
		const browseStore = fakeBrowseStore(browseState());
		render(TimelineModeActivationHost, { props: { browseStore, pageState } });

		await waitFor(() => expect(browseStore.restoreSnapshot).toHaveBeenCalledTimes(1));
		expect(screen.getByLabelText('Current zoom')).toHaveTextContent('50%');
		expect(browseStore.restoreSnapshot).toHaveBeenCalledWith(pageState.snapshot);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
	});

	it('waits for a fresh paired Core publication before reconnect restore and writes no history', async () => {
		const pairedCore = {
			status: 'paired' as const,
			core: { id: 'core-a', displayName: 'Test Core', displayVersion: '1' }
		};
		setCoreStatus(pairedCore);
		setSocketStatus('disconnected');
		const pageState = buildTimelineLibraryPageState({
			artistQuery: 'Björk',
			selectedArtistLocalId: ARTIST_ID,
			activeSemanticPath: [{ kind: 'artist', localId: ARTIST_ID }],
			selectedNode: { kind: 'artist', localId: ARTIST_ID },
			camera: { x: 45, y: 12, scale: 0.75 },
			displayDepth: 0
		});
		const browseStore = fakeBrowseStore(browseState());
		render(TimelineModeActivationHost, { props: { browseStore, pageState } });
		await waitFor(() => expect(browseStore.connectionLost).toHaveBeenCalledTimes(1));

		setSocketStatus('connected');
		await Promise.resolve();
		expect(browseStore.restoreSnapshot).not.toHaveBeenCalled();
		setCoreStatus({ ...pairedCore, core: { ...pairedCore.core } });
		await waitFor(() => expect(browseStore.restoreSnapshot).toHaveBeenCalledTimes(1));
		expect(browseStore.restoreSnapshot).toHaveBeenCalledWith(pageState.snapshot);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
	});

	it('recovers the current artist history camera while focusing the prior detail marker', async () => {
		const pairedCore = {
			status: 'paired' as const,
			core: { id: 'core-a', displayName: 'Test Core', displayVersion: '1' }
		};
		setCoreStatus(pairedCore);
		setSocketStatus('connected');
		const pageState = buildTimelineLibraryPageState({
			artistQuery: 'Björk',
			selectedArtistLocalId: ARTIST_ID,
			activeSemanticPath: [{ kind: 'artist', localId: ARTIST_ID }],
			selectedNode: { kind: 'artist', localId: ARTIST_ID },
			camera: { x: 45, y: 12, scale: 0.75 },
			displayDepth: 0
		});
		__resetTestPage(
			'http://localhost/library',
			buildLibraryPageStateEnvelope(pageState)
		);
		const publication = selectionPublication();
		const descriptor = detailAlbum();
		const artistState = browseState({
			query: publication.query,
			catalogStatus: publication.discography.status,
			selectedArtist: publication.artist,
			discography: { ...publication.discography, albums: [descriptor] },
			albums: publication.albums,
			session: publication.session,
			sessionPhase: 'live'
		});
		const browseStore = fakeBrowseStore(artistState);
		render(TimelineModeActivationHost, { props: { browseStore, pageState } });
		await waitFor(() => expect(browseStore.restoreSnapshot).toHaveBeenCalledTimes(1));
		vi.mocked(browseStore.restoreSnapshot).mockClear();

		browseStore.setState({
			...artistState,
			detailPhase: 'loading',
			selectedAlbumLocalId: ALBUM_ID,
			selectedAlbumDescriptor: descriptor
		});
		setSocketStatus('disconnected');
		await waitFor(() => expect(browseStore.connectionLost).toHaveBeenCalledTimes(1));
		setSocketStatus('connected');
		await Promise.resolve();
		expect(browseStore.restoreSnapshot).not.toHaveBeenCalled();
		setCoreStatus({ ...pairedCore, core: { ...pairedCore.core } });

		await waitFor(() => expect(browseStore.restoreSnapshot).toHaveBeenCalledTimes(1));
		expect(browseStore.restoreSnapshot).toHaveBeenCalledWith(pageState.snapshot);
		const expectedTransform = cameraCssTransform(
			{ centerX: 45, centerY: 12, scale: 0.75 },
			{ x: 0, y: 0, width: 1_400, height: 900 }
		);
		await waitFor(() => {
			expect(screen.getByTestId('timeline-canvas-world').style.transform).toBe(expectedTransform);
			expect(screen.getByRole('button', { name: /Homogenic, Undated/ })).toHaveFocus();
		});
		expect(pushLibraryPageState).not.toHaveBeenCalled();
	});

	it('re-resolves the current semantic entry after a direct paired Core identity switch', async () => {
		const coreA = {
			status: 'paired' as const,
			core: { id: 'core-a', displayName: 'Core A', displayVersion: '1' }
		};
		setCoreStatus(coreA);
		setSocketStatus('connected');
		const pageState = buildTimelineLibraryPageState({
			artistQuery: 'Björk',
			selectedArtistLocalId: ARTIST_ID,
			activeSemanticPath: [{ kind: 'artist', localId: ARTIST_ID }],
			selectedNode: { kind: 'artist', localId: ARTIST_ID },
			camera: { x: 45, y: 12, scale: 0.75 },
			displayDepth: 0
		});
		__resetTestPage(
			'http://localhost/library',
			buildLibraryPageStateEnvelope(pageState)
		);
		const browseStore = fakeBrowseStore(browseState());
		render(TimelineModeActivationHost, { props: { browseStore, pageState } });
		await waitFor(() => expect(browseStore.restoreSnapshot).toHaveBeenCalledTimes(1));
		vi.mocked(browseStore.restoreSnapshot).mockClear();

		setCoreStatus({
			status: 'paired',
			core: { id: 'core-b', displayName: 'Core B', displayVersion: '1' }
		});

		await waitFor(() => expect(browseStore.connectionLost).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(browseStore.restoreSnapshot).toHaveBeenCalledTimes(1));
		expect(browseStore.restoreSnapshot).toHaveBeenCalledWith(pageState.snapshot);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
	});

	it('renders deterministic calendar and Undated markers with bounded artwork', async () => {
		const onArtistSearch = vi.fn();
		const browseStore = fakeBrowseStore(browseState());
		render(TimelineLibraryMode, {
			props: {
				artistName: 'Shell Artist',
				albums: [
					calendarAlbum('dated-a', 1998, 0, true),
					calendarAlbum('dated-b', 2004, 1),
					undatedAlbum('unknown', 2)
				],
				onArtistSearch,
				browseStore
			}
		});

		expect(screen.getByText('Album dated-a')).toBeInTheDocument();
		expect(screen.getAllByText('1998')).toHaveLength(2);
		expect(screen.getByText('Undated · #3')).toBeInTheDocument();
		expect(document.querySelectorAll('[data-world-object]')).toHaveLength(3);
		expect(document.querySelectorAll('[data-timeline-artwork]')).toHaveLength(1);
		expect(document.querySelector('[draggable="true"]')).toBeNull();

		const search = screen.getByPlaceholderText('Search artists');
		await fireEvent.input(search, { target: { value: 'Another Artist' } });
		await fireEvent.submit(screen.getByRole('search'));
		expect(onArtistSearch).toHaveBeenCalledWith('Another Artist');
	});

	it('cannot fall through to production search after injected data disables a typed query', async () => {
		const browseStore = fakeBrowseStore(browseState());
		const view = render(TimelineLibraryMode, { props: { browseStore } });
		const search = screen.getByPlaceholderText('Search artists');
		await fireEvent.input(search, { target: { value: 'Björk' } });
		expect(search).toHaveValue('Björk');

		await view.rerender({
			artistName: 'Injected Artist',
			albums: [undatedAlbum('injected', 0)],
			browseStore
		});
		expect(search).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
		await fireEvent.submit(screen.getByRole('search'));

		expect(browseStore.search).not.toHaveBeenCalled();
		expect(browseStore.loadCatalogStatus).toHaveBeenCalledTimes(1);
	});

	it('never mounts more world objects or images than the production caps', async () => {
		const albums = Array.from({ length: 500 }, (_, index) =>
			calendarAlbum(`dense-${String(index).padStart(3, '0')}`, 1950 + (index % 50), index, true)
		);
		const browseStore = fakeBrowseStore(browseState());
		render(TimelineLibraryMode, {
			props: { artistName: 'Dense Artist', albums, browseStore }
		});
		const viewport = screen.getByTestId('timeline-canvas-viewport');

		expect(Number(viewport.dataset.renderedWorldObjects)).toBeLessThanOrEqual(72);
		expect(Number(viewport.dataset.renderedArtworkImages)).toBeLessThanOrEqual(40);
		expect(document.querySelectorAll('[data-world-object]').length).toBeLessThanOrEqual(72);
		expect(document.querySelectorAll('[data-timeline-artwork]').length).toBeLessThanOrEqual(40);
		expect(screen.getByPlaceholderText('Search artists')).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
		await fireEvent.submit(screen.getByRole('search'));
		expect(browseStore.search).not.toHaveBeenCalled();
		expect(browseStore.loadCatalogStatus).not.toHaveBeenCalled();
		expect(browseStore.refreshCatalog).not.toHaveBeenCalled();
	});

	it('keeps the semantic tier stable across its zoom hysteresis band', async () => {
		const browseStore = fakeBrowseStore(browseState());
		render(TimelineLibraryMode, { props: { browseStore } });
		const shell = screen.getByRole('region', { name: 'Timeline library canvas' });
		const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
		const zoomIn = screen.getByRole('button', { name: 'Zoom in' });

		expect(shell).toHaveAttribute('data-semantic-tier', 'navigation');
		await fireEvent.click(zoomOut);
		await fireEvent.click(zoomOut);
		await fireEvent.click(zoomOut);
		expect(shell).toHaveAttribute('data-semantic-tier', 'overview');

		await fireEvent.click(zoomIn);
		expect(shell).toHaveAttribute('data-semantic-tier', 'overview');
		await fireEvent.click(zoomIn);
		expect(shell).toHaveAttribute('data-semantic-tier', 'navigation');
	});
});
