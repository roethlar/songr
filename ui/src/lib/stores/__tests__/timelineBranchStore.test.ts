import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';

import {
	normalizeCatalogText,
	type AlbumRef,
	type ArtistRef,
	type CatalogArtistAlbumsResponse,
	type CatalogArtistSearchResponse,
	type CatalogStatus
} from '@shared/timelineCatalogContracts';
import {
	TIMELINE_BRANCH_MAX_ALBUMS,
	TIMELINE_BRANCH_MAX_DEPTH,
	TIMELINE_BRANCH_MAX_OPEN,
	TIMELINE_BRANCH_MAX_SEARCH_RESULTS,
	TIMELINE_BRANCH_PROVENANCE,
	createTimelineBranchStore,
	type TimelineBranchScope,
	type TimelineBranchSourceRef,
	type TimelineBranchStore
} from '../timelineBranchStore';
import { ApiError } from '$lib/api/client';

const AT = '2026-07-15T12:00:00.000Z';
const CORE_A = 'core-a';
const CORE_B = 'core-b';

function localId(sequence: number, kind: 'artist' | 'album' = 'artist'): string {
	return `${kind === 'artist' ? '10000000' : '20000000'}-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

const BASE_ARTIST = artist(localId(1), 'Artist Base');
const ARTISTS = Array.from({ length: 10 }, (_, index) =>
	artist(localId(index + 2), `Artist ${String(index + 1).padStart(2, '0')}`)
);
const BASE_ALBUM_ID = localId(1, 'album');

const SCOPE: TimelineBranchScope = Object.freeze({
	coreId: CORE_A,
	baseArtistLocalId: BASE_ARTIST.localId,
	catalogRevision: 7,
	sourceGeneration: 11
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function status(
	coreId = CORE_A,
	revision = SCOPE.catalogRevision,
	overrides: Partial<CatalogStatus> = {}
): CatalogStatus {
	return {
		coreId,
		freshness: 'fresh',
		persistence: 'healthy',
		refresh: 'idle',
		available: true,
		complete: true,
		revision,
		artistCount: 40,
		albumCount: 80,
		updatedAt: AT,
		lastCompleteScanAt: AT,
		...overrides
	};
}

function artist(id: string, exactName: string, coreId = CORE_A): ArtistRef {
	return {
		localId: id,
		coreId,
		exactName,
		normalizedName: normalizeCatalogText(exactName),
		firstSeenAt: AT,
		lastSeenAt: AT,
		resolutionStatus: 'resolved'
	};
}

function album(owner: ArtistRef, index: number, coreId = owner.coreId): AlbumRef {
	const year = 1990 + index;
	return {
		localId: localId(index + 10, 'album'),
		coreId,
		artistLocalId: owner.localId,
		exactTitle: `Album ${index}`,
		exactArtist: owner.exactName,
		normalizedTitle: normalizeCatalogText(`Album ${index}`),
		normalizedArtist: owner.normalizedName,
		editionText: '',
		imageKeyHint: `image-${index}`,
		firstSeenAt: AT,
		lastSeenAt: AT,
		resolutionStatus: 'resolved',
		originalReleaseYear: year,
		originalReleaseYearEvidence: {
			sourceContract: 'controller-normalized-browse-album-detail-v1',
			field: 'original-release-date',
			date: String(year)
		}
	};
}

function searchResponse(
	query: string,
	artists: readonly ArtistRef[],
	options: { readonly coreId?: string; readonly revision?: number; readonly total?: number } = {}
): CatalogArtistSearchResponse {
	const total = options.total ?? artists.length;
	const ordered = [...artists].sort((left, right) =>
		left.normalizedName < right.normalizedName
			? -1
			: left.normalizedName > right.normalizedName
				? 1
				: left.localId < right.localId
					? -1
					: 1
	);
	return {
		status: status(options.coreId, options.revision),
		query,
		limit: TIMELINE_BRANCH_MAX_SEARCH_RESULTS,
		total,
		truncated: total > TIMELINE_BRANCH_MAX_SEARCH_RESULTS,
		artists: ordered
	};
}

function albumsResponse(
	owner: ArtistRef,
	albums: readonly AlbumRef[] = [album(owner, 1)],
	options: {
		readonly coreId?: string;
		readonly revision?: number;
		readonly total?: number;
		readonly statusOverrides?: Partial<CatalogStatus>;
	} = {}
): CatalogArtistAlbumsResponse {
	const total = options.total ?? albums.length;
	return {
		status: status(options.coreId ?? owner.coreId, options.revision, options.statusOverrides),
		artist: owner,
		limit: TIMELINE_BRANCH_MAX_ALBUMS,
		total,
		truncated: total > TIMELINE_BRANCH_MAX_ALBUMS,
		albums
	};
}

function createStore(dependencies: Parameters<typeof createTimelineBranchStore>[0]) {
	const store = createTimelineBranchStore({
		fetchFn: vi.fn() as unknown as typeof fetch,
		...dependencies
	});
	expect(store.activate(SCOPE)).toMatchObject({ accepted: true });
	const source = store.sourceForBaseAlbum(BASE_ALBUM_ID, BASE_ALBUM_ID);
	if (!source) throw new Error('test source was not created');
	return { store, source };
}

async function searchFor(
	store: TimelineBranchStore,
	source: TimelineBranchSourceRef,
	artistId: string
): Promise<void> {
	const result = await store.searchArtists(source, 'artist');
	expect(result).toMatchObject({ success: true });
	expect(get(store).search.candidates.some((candidate) => candidate.localId === artistId)).toBe(true);
}

describe('Timeline branch store', () => {
	it('does not republish reconstructed but value-identical scopes', () => {
		const { store } = createStore({ search: vi.fn(), fetchArtistAlbums: vi.fn() });
		const snapshots: unknown[] = [];
		const unsubscribe = store.subscribe((value) => snapshots.push(value));
		const before = get(store);

		expect(store.reconcileScope({ ...SCOPE })).toMatchObject({
			accepted: true,
			incompatible: false,
			sourceChanged: false
		});
		expect(store.resume({ ...SCOPE })).toMatchObject({ accepted: true });
		expect(get(store)).toBe(before);
		expect(snapshots).toHaveLength(1);
		unsubscribe();
	});

	it('publishes one complete keyless branch atomically and uses both exact eight-item limits', async () => {
		const pendingAlbums = deferred<CatalogArtistAlbumsResponse>();
		const search = vi.fn().mockResolvedValue(searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)]));
		const fetchArtistAlbums = vi.fn().mockReturnValue(pendingAlbums.promise);
		const { store, source } = createStore({ search, fetchArtistAlbums });

		await searchFor(store, source, ARTISTS[0].localId);
		expect(get(store).search.candidates).toHaveLength(7);
		expect(get(store).search.candidates.some(({ localId }) => localId === BASE_ARTIST.localId)).toBe(false);

		const attaching = store.attachArtist(source, ARTISTS[0].localId);
		const loading = get(store).branches[0];
		expect(loading).toMatchObject({
			branchId: 'timeline-branch-1',
			depth: 1,
			phase: 'loading',
			albums: [],
			provenance: TIMELINE_BRANCH_PROVENANCE
		});

		const descriptors = Array.from({ length: TIMELINE_BRANCH_MAX_ALBUMS }, (_, index) =>
			album(ARTISTS[0], index + 1)
		);
		pendingAlbums.resolve(albumsResponse(ARTISTS[0], descriptors, { total: 12 }));
		const attached = await attaching;
		expect(attached).toMatchObject({ success: true, branchId: loading.branchId });
		const ready = get(store).branches[0];
		expect(ready.phase).toBe('ready');
		expect(ready.albums).toHaveLength(TIMELINE_BRANCH_MAX_ALBUMS);
		expect(ready.catalogTotal).toBe(12);
		expect(ready.catalogTruncated).toBe(true);
		expect(ready.albums[0]).toEqual({
			entityId: `${ready.branchId}:${descriptors[0].localId}`,
			branchId: ready.branchId,
			albumLocalId: descriptors[0].localId,
			artistLocalId: ARTISTS[0].localId,
			title: descriptors[0].exactTitle,
			artist: ARTISTS[0].exactName,
			placement: expect.objectContaining({ kind: 'calendar', year: 1991 }),
			resolutionStatus: 'resolved',
			imageKeyHint: 'image-1'
		});
		expect(JSON.stringify(ready)).not.toMatch(/(?:itemKey|session|handleId|actionKey)/u);
		expect(Object.isFrozen(ready)).toBe(true);
		expect(Object.isFrozen(ready.albums)).toBe(true);
		expect(search).toHaveBeenCalledWith(expect.any(Function), 'artist', 8);
		expect(fetchArtistAlbums).toHaveBeenCalledWith(
			expect.any(Function),
			ARTISTS[0].localId,
			SCOPE.catalogRevision,
			8
		);
	});

	it('adopts one hydrated revision atomically while preserving settled branches and retiring other loads', async () => {
		const pending = deferred<CatalogArtistAlbumsResponse>();
		const search = vi.fn().mockResolvedValue(
			searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)])
		);
		const fetchArtistAlbums = vi.fn((_: typeof fetch, artistId: string) => {
			if (artistId === ARTISTS[1].localId) return pending.promise;
			const owner = ARTISTS.find((candidate) => candidate.localId === artistId)!;
			return Promise.resolve(
				albumsResponse(owner, [album(owner, 1)], {
					revision: artistId === ARTISTS[2].localId ? SCOPE.catalogRevision + 1 : SCOPE.catalogRevision
				})
			);
		});
		const { store, source } = createStore({ search, fetchArtistAlbums });

		await searchFor(store, source, ARTISTS[0].localId);
		await store.attachArtist(source, ARTISTS[0].localId);
		await searchFor(store, source, ARTISTS[1].localId);
		const staleLoad = store.attachArtist(source, ARTISTS[1].localId);
		await searchFor(store, source, ARTISTS[2].localId);
		const adopter = vi.fn().mockReturnValue(true);
		await expect(
			store.attachArtist(source, ARTISTS[2].localId, adopter)
		).resolves.toMatchObject({ success: true });

		expect(adopter).toHaveBeenCalledWith(
			expect.objectContaining({ revision: SCOPE.catalogRevision + 1 }),
			SCOPE.catalogRevision
		);
		expect(get(store).scope?.catalogRevision).toBe(SCOPE.catalogRevision + 1);
		expect(get(store).search.phase).toBe('idle');
		expect(get(store).branches.map(({ phase }) => phase)).toEqual(['ready', 'error', 'ready']);
		expect(get(store).branches[0].albums).toHaveLength(1);
		expect(get(store).branches[2].albums).toHaveLength(1);

		pending.resolve(albumsResponse(ARTISTS[1]));
		await expect(staleLoad).resolves.toMatchObject({ success: false, reason: 'superseded' });
		expect(get(store).branches.map(({ phase }) => phase)).toEqual(['ready', 'error', 'ready']);
	});

	it('counts loading and error slots toward the three-branch cap and excludes all open artists', async () => {
		const first = deferred<CatalogArtistAlbumsResponse>();
		const search = vi.fn().mockResolvedValue(searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)]));
		const fetchArtistAlbums = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockRejectedValueOnce(new Error('second failed'))
			.mockRejectedValueOnce(new Error('third failed'));
		const { store, source } = createStore({ search, fetchArtistAlbums });

		await searchFor(store, source, ARTISTS[0].localId);
		const firstLoad = store.attachArtist(source, ARTISTS[0].localId);
		await searchFor(store, source, ARTISTS[1].localId);
		expect(get(store).search.candidates.some(({ localId }) => localId === ARTISTS[0].localId)).toBe(false);
		await expect(store.attachArtist(source, ARTISTS[1].localId)).resolves.toMatchObject({
			success: false,
			reason: 'failed'
		});
		await searchFor(store, source, ARTISTS[2].localId);
		await expect(store.attachArtist(source, ARTISTS[2].localId)).resolves.toMatchObject({
			success: false,
			reason: 'failed'
		});

		expect(get(store).branches.map(({ phase }) => phase)).toEqual(['loading', 'error', 'error']);
		expect(get(store).branches).toHaveLength(TIMELINE_BRANCH_MAX_OPEN);
		await store.searchArtists(source, 'artist');
		await expect(store.attachArtist(source, ARTISTS[3].localId)).resolves.toEqual({
			success: false,
			reason: 'capacity'
		});

		store.connectionLost();
		first.resolve(albumsResponse(ARTISTS[0]));
		await expect(firstLoad).resolves.toMatchObject({ success: false, reason: 'superseded' });
	});

	it('filters base, parent, and parallel branch artists and enforces graph depth two', async () => {
		const search = vi.fn().mockResolvedValue(searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)]));
		const fetchArtistAlbums = vi.fn((_: typeof fetch, artistId: string) => {
			const owner = ARTISTS.find((candidate) => candidate.localId === artistId)!;
			return Promise.resolve(albumsResponse(owner));
		});
		const { store, source } = createStore({ search, fetchArtistAlbums });

		await searchFor(store, source, ARTISTS[0].localId);
		await store.attachArtist(source, ARTISTS[0].localId);
		await searchFor(store, source, ARTISTS[1].localId);
		await store.attachArtist(source, ARTISTS[1].localId);
		const firstAlbum = get(store).branches[0].albums[0];
		const childSource = store.sourceForBranchAlbum(firstAlbum.entityId)!;

		await searchFor(store, childSource, ARTISTS[2].localId);
		const candidateIds = get(store).search.candidates.map(({ localId }) => localId);
		expect(candidateIds).not.toContain(BASE_ARTIST.localId);
		expect(candidateIds).not.toContain(ARTISTS[0].localId);
		expect(candidateIds).not.toContain(ARTISTS[1].localId);
		await store.attachArtist(childSource, ARTISTS[2].localId);
		const depthTwo = get(store).branches.find((branch) => branch.depth === TIMELINE_BRANCH_MAX_DEPTH)!;
		const depthTwoSource = store.sourceForBranchAlbum(depthTwo.albums[0].entityId)!;
		await expect(store.searchArtists(depthTwoSource, 'artist')).resolves.toEqual({
			success: false,
			reason: 'invalid-source'
		});
	});

	it('preserves settled topology across source-generation changes while retiring pending work', async () => {
		const pending = deferred<CatalogArtistAlbumsResponse>();
		const search = vi.fn().mockResolvedValue(searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)]));
		const fetchArtistAlbums = vi
			.fn()
			.mockResolvedValueOnce(albumsResponse(ARTISTS[0]))
			.mockRejectedValueOnce(new Error('settled error'))
			.mockReturnValueOnce(pending.promise);
		const { store, source } = createStore({ search, fetchArtistAlbums });

		for (let index = 0; index < 2; index += 1) {
			await searchFor(store, source, ARTISTS[index].localId);
			await store.attachArtist(source, ARTISTS[index].localId);
		}
		await searchFor(store, source, ARTISTS[2].localId);
		const pendingLoad = store.attachArtist(source, ARTISTS[2].localId);

		const result = store.reconcileScope({ ...SCOPE, sourceGeneration: 12 });
		expect(result).toMatchObject({ accepted: true, incompatible: false, sourceChanged: true });
		expect(get(store).branches.map(({ phase }) => phase)).toEqual(['ready', 'error', 'error']);
		expect(get(store).branches.map(({ source }) => source.sourceGeneration)).toEqual([12, 12, 12]);
		pending.resolve(albumsResponse(ARTISTS[2]));
		await expect(pendingLoad).resolves.toMatchObject({ success: false, reason: 'superseded' });
	});

	it('clears incompatible Core, base-artist, and catalog-revision scopes and rejects their late work', async () => {
		for (const nextScope of [
			{ ...SCOPE, coreId: CORE_B },
			{ ...SCOPE, baseArtistLocalId: ARTISTS[9].localId },
			{ ...SCOPE, catalogRevision: SCOPE.catalogRevision + 1 }
		]) {
			const pending = deferred<CatalogArtistSearchResponse>();
			const search = vi
				.fn()
				.mockResolvedValueOnce(searchResponse('artist', [BASE_ARTIST, ARTISTS[0]]))
				.mockReturnValueOnce(pending.promise);
			const { store, source } = createStore({
				search,
				fetchArtistAlbums: vi.fn().mockResolvedValue(albumsResponse(ARTISTS[0]))
			});
			await searchFor(store, source, ARTISTS[0].localId);
			await store.attachArtist(source, ARTISTS[0].localId);
			expect(get(store).branches).toHaveLength(1);
			const searching = store.searchArtists(source, 'artist');
			const reconciled = store.reconcileScope(nextScope);
			expect(reconciled).toMatchObject({
				accepted: true,
				incompatible: true,
				clearedBranchCount: 1
			});
			expect(get(store).branches).toEqual([]);
			pending.resolve(searchResponse('artist', [BASE_ARTIST, ARTISTS[0]]));
			await expect(searching).resolves.toEqual({ success: false, reason: 'superseded' });
			expect(get(store).search.candidates).toEqual([]);
		}
	});

	it('cancelSearch invalidates only search work and cannot be undone by a late response', async () => {
		const pending = deferred<CatalogArtistSearchResponse>();
		const { store, source } = createStore({
			search: vi.fn().mockReturnValue(pending.promise),
			fetchArtistAlbums: vi.fn()
		});
		const searching = store.searchArtists(source, 'artist');
		expect(get(store).search.phase).toBe('loading');
		store.cancelSearch();
		expect(get(store).search).toEqual(expect.objectContaining({ phase: 'idle', candidates: [] }));
		pending.resolve(searchResponse('artist', [BASE_ARTIST, ARTISTS[0]]));
		await expect(searching).resolves.toEqual({ success: false, reason: 'superseded' });
		expect(get(store).branches).toEqual([]);
	});

	it('disconnect and quiesce preserve settled branches, retire pending loads, and resume safely', async () => {
		const pendingLoad = deferred<CatalogArtistAlbumsResponse>();
		const pendingSearch = deferred<CatalogArtistSearchResponse>();
		const search = vi
			.fn()
			.mockResolvedValueOnce(searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)]))
			.mockResolvedValueOnce(searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)]))
			.mockReturnValueOnce(pendingSearch.promise);
		const fetchArtistAlbums = vi
			.fn()
			.mockResolvedValueOnce(albumsResponse(ARTISTS[0]))
			.mockReturnValueOnce(pendingLoad.promise)
			.mockResolvedValueOnce(albumsResponse(ARTISTS[1]));
		const { store, source } = createStore({ search, fetchArtistAlbums });

		await searchFor(store, source, ARTISTS[0].localId);
		await store.attachArtist(source, ARTISTS[0].localId);
		await searchFor(store, source, ARTISTS[1].localId);
		const interrupted = store.attachArtist(source, ARTISTS[1].localId);
		store.connectionLost();
		expect(get(store).branches.map(({ phase }) => phase)).toEqual(['ready', 'error']);
		await expect(store.searchArtists(source, 'artist')).resolves.toEqual({
			success: false,
			reason: 'inactive'
		});
		pendingLoad.resolve(albumsResponse(ARTISTS[1]));
		await expect(interrupted).resolves.toMatchObject({ success: false, reason: 'superseded' });

		store.resume(SCOPE);
		await expect(store.retryBranch(get(store).branches[1].branchId)).resolves.toMatchObject({
			success: true
		});
		const searching = store.searchArtists(source, 'artist');
		store.quiesce();
		pendingSearch.resolve(searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)]));
		await expect(searching).resolves.toEqual({ success: false, reason: 'superseded' });
		expect(get(store).branches.map(({ phase }) => phase)).toEqual(['ready', 'ready']);
	});

	it('rejects wrong-Core responses and classifies a one-step revision without an adoption hook as stale', async () => {
		const wrongCoreBase = artist(BASE_ARTIST.localId, BASE_ARTIST.exactName, CORE_B);
		const wrongCoreArtist = artist(ARTISTS[0].localId, ARTISTS[0].exactName, CORE_B);
		const search = vi
			.fn()
			.mockResolvedValueOnce(searchResponse('artist', [wrongCoreBase, wrongCoreArtist], { coreId: CORE_B }))
			.mockResolvedValueOnce(searchResponse('artist', [BASE_ARTIST, ARTISTS[0]]));
		const wrongRevisionArtist = artist(ARTISTS[0].localId, ARTISTS[0].exactName);
		const fetchArtistAlbums = vi.fn().mockResolvedValue(
			albumsResponse(wrongRevisionArtist, [album(wrongRevisionArtist, 1)], {
				revision: SCOPE.catalogRevision + 1
			})
		);
		const { store, source } = createStore({ search, fetchArtistAlbums });

		await expect(store.searchArtists(source, 'artist')).resolves.toMatchObject({
			success: false,
			reason: 'failed'
		});
		expect(get(store).search.candidates).toEqual([]);
		await searchFor(store, source, ARTISTS[0].localId);
		await expect(store.attachArtist(source, ARTISTS[0].localId)).resolves.toMatchObject({
			success: false,
			reason: 'catalog-conflict'
		});
		expect(get(store).branches[0]).toMatchObject({ phase: 'error', albums: [] });
	});

	it('classifies an exact server revision conflict for caller-driven catalog recovery', async () => {
		const search = vi.fn().mockResolvedValue(
			searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)])
		);
		const conflict = new ApiError('Catalog changed; retry request', 409, {
			error: 'Catalog changed; retry request',
			details: 'REVISION_CONFLICT'
		});
		const { store, source } = createStore({
			search,
			fetchArtistAlbums: vi.fn().mockRejectedValue(conflict)
		});

		await searchFor(store, source, ARTISTS[0].localId);
		await expect(store.attachArtist(source, ARTISTS[0].localId)).resolves.toMatchObject({
			success: false,
			reason: 'catalog-conflict',
			error: 'The catalog changed while this artist branch was loading'
		});
		expect(get(store).branches[0]).toMatchObject({
			phase: 'error',
			error: 'The catalog changed while this artist branch was loading',
			albums: []
		});
	});

	it('classifies a refused one-step hydration adoption as the same recoverable catalog conflict', async () => {
		const search = vi.fn().mockResolvedValue(
			searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)])
		);
		const fetchArtistAlbums = vi.fn().mockResolvedValue(
			albumsResponse(ARTISTS[0], [album(ARTISTS[0], 1)], {
				revision: SCOPE.catalogRevision + 1,
				statusOverrides: { refresh: 'running' }
			})
		);
		const adopter = vi.fn().mockReturnValue(false);
		const { store, source } = createStore({ search, fetchArtistAlbums });

		await searchFor(store, source, ARTISTS[0].localId);
		await expect(store.attachArtist(source, ARTISTS[0].localId, adopter)).resolves.toMatchObject({
			success: false,
			reason: 'catalog-conflict',
			error: 'The catalog changed while this artist branch was loading'
		});
		expect(adopter).toHaveBeenCalledWith(
			expect.objectContaining({ revision: SCOPE.catalogRevision + 1, refresh: 'running' }),
			SCOPE.catalogRevision
		);
		expect(get(store).branches[0]).toMatchObject({ phase: 'error', albums: [] });
	});

	it('close cascades through descendants and rejects a closed child load', async () => {
		const childLoad = deferred<CatalogArtistAlbumsResponse>();
		const search = vi.fn().mockResolvedValue(searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)]));
		const fetchArtistAlbums = vi
			.fn()
			.mockResolvedValueOnce(albumsResponse(ARTISTS[0]))
			.mockReturnValueOnce(childLoad.promise);
		const { store, source } = createStore({ search, fetchArtistAlbums });

		await searchFor(store, source, ARTISTS[0].localId);
		await store.attachArtist(source, ARTISTS[0].localId);
		const parent = get(store).branches[0];
		const childSource = store.sourceForBranchAlbum(parent.albums[0].entityId)!;
		await searchFor(store, childSource, ARTISTS[1].localId);
		const child = store.attachArtist(childSource, ARTISTS[1].localId);
		const childId = get(store).branches[1].branchId;

		expect(store.closeBranch(parent.branchId)).toEqual({
			closed: true,
			branchIds: [parent.branchId, childId]
		});
		expect(get(store).branches).toEqual([]);
		childLoad.resolve(albumsResponse(ARTISTS[1]));
		await expect(child).resolves.toMatchObject({
			success: false,
			reason: 'superseded',
			branchId: childId
		});
	});

	it('retries and closes only the named failed branch', async () => {
		const search = vi.fn().mockResolvedValue(searchResponse('artist', [BASE_ARTIST, ...ARTISTS.slice(0, 7)]));
		const fetchArtistAlbums = vi
			.fn()
			.mockRejectedValueOnce(new Error('first'))
			.mockRejectedValueOnce(new Error('second'))
			.mockResolvedValueOnce(albumsResponse(ARTISTS[0]));
		const { store, source } = createStore({ search, fetchArtistAlbums });

		for (let index = 0; index < 2; index += 1) {
			await searchFor(store, source, ARTISTS[index].localId);
			await store.attachArtist(source, ARTISTS[index].localId);
		}
		const [first, second] = get(store).branches;
		await expect(store.retryBranch(first.branchId)).resolves.toMatchObject({ success: true });
		expect(get(store).branches.map(({ phase }) => phase)).toEqual(['ready', 'error']);
		expect(store.closeBranch(second.branchId)).toEqual({
			closed: true,
			branchIds: [second.branchId]
		});
		expect(get(store).branches.map(({ branchId }) => branchId)).toEqual([first.branchId]);
	});

	it('rejects extra authority-shaped response fields and never writes browser storage', async () => {
		const sessionWrite = vi.spyOn(Storage.prototype, 'setItem');
		const unsafe = {
			...searchResponse('artist', [BASE_ARTIST, ARTISTS[0]]),
			itemKey: 'not-keyless'
		} as unknown as CatalogArtistSearchResponse;
		const unsafeAlbums = {
			...albumsResponse(ARTISTS[0]),
			albums: [{ ...album(ARTISTS[0], 1), sessionKey: 'not-keyless' }]
		} as unknown as CatalogArtistAlbumsResponse;
		const { store, source } = createStore({
			search: vi
				.fn()
				.mockResolvedValueOnce(unsafe)
				.mockResolvedValueOnce(searchResponse('artist', [BASE_ARTIST, ARTISTS[0]])),
			fetchArtistAlbums: vi.fn().mockResolvedValue(unsafeAlbums)
		});

		await expect(store.searchArtists(source, 'artist')).resolves.toMatchObject({
			success: false,
			reason: 'failed'
		});
		expect(get(store).search.candidates).toEqual([]);
		await searchFor(store, source, ARTISTS[0].localId);
		await expect(store.attachArtist(source, ARTISTS[0].localId)).resolves.toMatchObject({
			success: false,
			reason: 'failed'
		});
		expect(get(store).branches[0]).toMatchObject({ phase: 'error', albums: [] });
		expect(sessionWrite).not.toHaveBeenCalled();
		sessionWrite.mockRestore();
	});
});
