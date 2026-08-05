import { describe, expect, it, vi } from 'vitest';
import type {
	AlbumRef,
	ArtistRef,
	CatalogArtistAlbumsResponse,
	CatalogArtistSearchResponse,
	CatalogRefreshAcceptedResponse,
	CatalogStatus
} from '@shared/timelineCatalogContracts';
import {
	addFavorite,
	fetchCatalogArtistAlbums,
	fetchCatalogStatus,
	loadCatalogArtistAlbums,
	refreshCatalog,
	searchCatalogArtists
} from '../client';

const ARTIST_ID = '10000000-0000-4000-8000-000000000001';
const ALBUM_ID = '20000000-0000-4000-8000-000000000001';
const OBSERVED_AT = '2026-07-14T12:00:00.000Z';

function status(over: Partial<CatalogStatus> = {}): CatalogStatus {
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
		updatedAt: OBSERVED_AT,
		lastCompleteScanAt: OBSERVED_AT,
		...over
	};
}

function artist(exactName = 'Björk'): ArtistRef {
	return {
		localId: ARTIST_ID,
		coreId: 'core-a',
		exactName,
		normalizedName: exactName.toLocaleLowerCase('en-US'),
		firstSeenAt: OBSERVED_AT,
		lastSeenAt: OBSERVED_AT,
		resolutionStatus: 'resolved'
	};
}

function album(): AlbumRef {
	return {
		localId: ALBUM_ID,
		coreId: 'core-a',
		artistLocalId: ARTIST_ID,
		exactTitle: 'Homogenic',
		exactArtist: 'Björk',
		normalizedTitle: 'homogenic',
		normalizedArtist: 'björk',
		editionText: '',
		firstSeenAt: OBSERVED_AT,
		lastSeenAt: OBSERVED_AT,
		resolutionStatus: 'resolved',
		originalReleaseYear: 1997,
		originalReleaseYearEvidence: {
			sourceContract: 'controller-normalized-browse-album-detail-v1',
			field: 'original-release-date',
			date: '1997-09-22'
		}
	};
}

function searchResponse(
	query = 'Björk',
	limit = 20
): CatalogArtistSearchResponse {
	return {
		status: status(),
		query,
		limit,
		total: 1,
		truncated: false,
		artists: [artist(query)]
	};
}

function albumsResponse(limit = 200): CatalogArtistAlbumsResponse {
	return {
		status: status(),
		artist: artist(),
		limit,
		total: 1,
		truncated: false,
		albums: [album()]
	};
}

function refreshResponse(): CatalogRefreshAcceptedResponse {
	return { status: status({ refresh: 'running' }) };
}

function jsonFetch(body: unknown, statusCode = 200): ReturnType<typeof vi.fn<typeof fetch>> {
	return vi.fn<typeof fetch>().mockResolvedValue(
		new Response(JSON.stringify(body), {
			status: statusCode,
			headers: { 'Content-Type': 'application/json' }
		})
	);
}

describe('catalog API client', () => {
	it('strictly loads catalog status', async () => {
		const body = status();
		const fetchFn = jsonFetch(body);

		const result = await fetchCatalogStatus(fetchFn);

		expect(result).toEqual(body);
		expect(result).not.toBe(body);
		expect(fetchFn).toHaveBeenCalledWith(
			'/api/catalog/status',
			expect.objectContaining({ credentials: 'include' })
		);
	});

	it('starts an explicit refresh with an empty POST body', async () => {
		const fetchFn = jsonFetch(refreshResponse());

		await expect(refreshCatalog(fetchFn)).resolves.toEqual(refreshResponse());

		const [input, init] = fetchFn.mock.calls[0];
		expect(input).toBe('/api/catalog/refresh');
		expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
		expect(init).not.toHaveProperty('body');
		expect(new Headers(init?.headers).has('content-type')).toBe(false);
	});

	it('canonicalizes and URL-encodes a bounded artist search', async () => {
		const query = 'Björk & Friends';
		const fetchFn = jsonFetch(searchResponse(query, 40));

		await expect(searchCatalogArtists(fetchFn, '\t Björk   & Friends \n', 40)).resolves.toEqual(
			searchResponse(query, 40)
		);

		expect(fetchFn.mock.calls[0][0]).toBe(
			'/api/catalog/artists?query=Bj%C3%B6rk+%26+Friends&limit=40'
		);
	});

	it('loads a bounded discography for the requested stable artist ID', async () => {
		const fetchFn = jsonFetch(albumsResponse(500));

		await expect(fetchCatalogArtistAlbums(fetchFn, ARTIST_ID, 500)).resolves.toEqual(
			albumsResponse(500)
		);

		expect(fetchFn.mock.calls[0][0]).toBe(
			`/api/catalog/artists/${ARTIST_ID}/albums?limit=500`
		);
	});

	it('loads and strictly correlates an artist discography at an expected catalog revision', async () => {
		const hydrated = albumsResponse(8);
		const fetchFn = jsonFetch({
			...hydrated,
			status: status({ revision: 2 })
		});

		await expect(loadCatalogArtistAlbums(fetchFn, ARTIST_ID, 1, 8)).resolves.toMatchObject({
			status: { revision: 2 },
			artist: { localId: ARTIST_ID },
			limit: 8
		});

		expect(fetchFn).toHaveBeenCalledWith(
			`/api/catalog/artists/${ARTIST_ID}/albums/load?revision=1&limit=8`,
			expect.objectContaining({ method: 'POST', credentials: 'include' })
		);
		const init = fetchFn.mock.calls[0][1];
		expect(init).not.toHaveProperty('body');
		expect(new Headers(init?.headers).has('content-type')).toBe(false);
	});

	it('keeps the JSON content type when a request actually carries JSON', async () => {
		const fetchFn = jsonFetch({ entries: [] });

		await expect(
			addFavorite(fetchFn, { type: 'album', title: 'Homogenic', artist: 'Björk' })
		).resolves.toEqual({ entries: [] });

		const init = fetchFn.mock.calls[0][1];
		expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
		expect(init?.body).toBe(
			JSON.stringify({ type: 'album', title: 'Homogenic', artist: 'Björk' })
		);
	});

	it('rejects an invalid load revision before fetching and a response beyond its one-revision envelope', async () => {
		const fetchFn = jsonFetch(albumsResponse(8));
		await expect(loadCatalogArtistAlbums(fetchFn, ARTIST_ID, 0, 8)).rejects.toBeInstanceOf(
			RangeError
		);
		await expect(
			loadCatalogArtistAlbums(fetchFn, ARTIST_ID, Number.MAX_SAFE_INTEGER, 8)
		).rejects.toBeInstanceOf(RangeError);
		expect(fetchFn).not.toHaveBeenCalled();

		const jumped = jsonFetch({
			...albumsResponse(8),
			status: status({ revision: 3 })
		});
		await expect(loadCatalogArtistAlbums(jumped, ARTIST_ID, 1, 8)).rejects.toMatchObject({
			name: 'ApiError',
			status: 502
		});
	});

	it('rejects out-of-bound limits and invalid artist IDs before fetching', async () => {
		const fetchFn = jsonFetch(status());

		await expect(searchCatalogArtists(fetchFn, 'Björk', 41)).rejects.toBeInstanceOf(RangeError);
		await expect(fetchCatalogArtistAlbums(fetchFn, 'not-a-local-id')).rejects.toBeInstanceOf(
			TypeError
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('rejects successful malformed catalog shapes as a 502 ApiError', async () => {
		const malformed = { unexpected: true };
		const calls = [
			(fetchFn: typeof fetch) => fetchCatalogStatus(fetchFn),
			(fetchFn: typeof fetch) => refreshCatalog(fetchFn),
			(fetchFn: typeof fetch) => searchCatalogArtists(fetchFn, 'Björk'),
			(fetchFn: typeof fetch) => fetchCatalogArtistAlbums(fetchFn, ARTIST_ID),
			(fetchFn: typeof fetch) => loadCatalogArtistAlbums(fetchFn, ARTIST_ID, 1)
		];

		for (const call of calls) {
			const fetchFn = jsonFetch(malformed);
			await expect(call(fetchFn)).rejects.toMatchObject({
				name: 'ApiError',
				status: 502,
				body: malformed
			});
		}
	});

	it('rejects syntactically invalid successful JSON as a 502 ApiError', async () => {
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
			new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } })
		);

		await expect(fetchCatalogStatus(fetchFn)).rejects.toEqual(
			expect.objectContaining({ name: 'ApiError', status: 502, body: null })
		);
	});

	it('rejects a valid response correlated to a different request', async () => {
		const wrongQuery = jsonFetch(searchResponse('Björk', 20));
		const wrongArtist = jsonFetch({
			...albumsResponse(),
			artist: { ...artist(), localId: '10000000-0000-4000-8000-000000000002' },
			albums: [
				{
					...album(),
					artistLocalId: '10000000-0000-4000-8000-000000000002'
				}
			]
		});

		await expect(searchCatalogArtists(wrongQuery, 'Björk Guðmundsdóttir')).rejects.toMatchObject({
			status: 502
		});
		await expect(fetchCatalogArtistAlbums(wrongArtist, ARTIST_ID)).rejects.toMatchObject({
			status: 502
		});
	});

	it('preserves non-success server errors', async () => {
		const fetchFn = jsonFetch({ error: 'Catalog unavailable', details: 'SERVICE_UNAVAILABLE' }, 503);

		await expect(fetchCatalogStatus(fetchFn)).rejects.toMatchObject({
			name: 'ApiError',
			status: 503,
			body: { error: 'Catalog unavailable', details: 'SERVICE_UNAVAILABLE' }
		});
	});
});
