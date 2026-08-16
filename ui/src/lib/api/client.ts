import type {
	AddFavoriteRequest,
	BrowseResult,
	CoreSwitchRequest,
	CoreSwitchResponse,
	CoreStatusResponse,
	ErrorResponse,
	FavoritesResponse,
	HealthResponse,
	OnboardingStatusResponse,
	RecentlyPlayedSnapshot,
	SearchResult,
	ZonesResponse
} from '@shared/types';
import type {
	ClassicBrowseLoadOptions,
	ClassicBrowseOptions,
	ClassicBrowsePopOptions,
	ClassicBrowseRole,
	ClassicBrowseSearchOptions
} from '@shared/classicBrowseContracts';
import {
	classicBrowseSessionClient,
	type ClassicBrowseRoleTransaction,
	type ClassicBrowseSessionClaim
} from '$lib/stores/classicBrowseSessionStore';
import {
	CATALOG_ARTIST_ALBUMS_DEFAULT_LIMIT,
	CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
	CATALOG_ARTIST_QUERY_MAX_LENGTH,
	CATALOG_ARTIST_SEARCH_DEFAULT_LIMIT,
	CATALOG_ARTIST_SEARCH_MAX_LIMIT,
	isCatalogLocalId,
	normalizeCatalogArtistAlbumsResponse,
	normalizeCatalogArtistSearchResponse,
	normalizeCatalogRefreshAcceptedResponse,
	normalizeCatalogStatus,
	type CatalogArtistAlbumsResponse,
	type CatalogArtistSearchResponse,
	type CatalogRefreshAcceptedResponse,
	type CatalogStatus
} from '@shared/catalogContracts';
import {
	normalizeCatalogIndexResponse,
	type CatalogIndexResponse
} from '@shared/catalogIndexContracts';
import { buildApiRequestInit } from '@shared/apiRequest';

export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.body = body;
	}
}

export type FetchLike = typeof fetch;

const CONTROL_CHARACTER = /\p{Cc}/u;

async function request<T>(fetchFn: FetchLike, input: RequestInfo, init?: RequestInit): Promise<T> {
	const response = await fetchFn(input, buildApiRequestInit(init));

	if (!response.ok) {
		// Read the body once as text, then attempt JSON parse from
		// that. The previous code called response.json() then
		// response.text() — but `json()` consumes the body, so the
		// follow-up `text()` throws and the caller loses the
		// intended ApiError. Reading text first keeps non-JSON
		// error bodies (e.g. proxy/HTML pages) intact.
		const raw = await response.text().catch(() => '');
		let body: unknown = raw;
		if (raw) {
			try {
				body = JSON.parse(raw);
			} catch {
				body = raw;
			}
		}
		const fromObject =
			body && typeof body === 'object' ? (body as ErrorResponse).error : undefined;
		const fromText = typeof body === 'string' && body ? body : undefined;
		const message = fromObject || fromText || response.statusText;
		throw new ApiError(message, response.status, body);
	}

	return (await response.json()) as T;
}

function invalidCatalogResponse(body: unknown): ApiError {
	return new ApiError('Invalid catalog response', 502, body);
}

/**
 * Exported so sibling feature clients share this transport rather than
 * reimplementing it. Not part of the surface callers should reach for
 * directly — prefer a named fetcher below.
 */
export async function catalogRequest<T>(
	fetchFn: FetchLike,
	input: RequestInfo,
	normalize: (value: unknown) => T | null,
	init?: RequestInit
): Promise<T> {
	let body: unknown;
	try {
		body = await request<unknown>(fetchFn, input, init);
	} catch (error) {
		if (error instanceof SyntaxError) throw invalidCatalogResponse(null);
		throw error;
	}
	const normalized = normalize(body);
	if (!normalized) throw invalidCatalogResponse(body);
	return normalized;
}

function catalogLimit(value: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new RangeError('Catalog limit is invalid');
	}
	return value;
}

function catalogArtistQuery(value: string): string {
	if (typeof value !== 'string' || value.length > CATALOG_ARTIST_QUERY_MAX_LENGTH) {
		throw new TypeError('Catalog artist query is invalid');
	}
	const canonical = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
	if (canonical.length > CATALOG_ARTIST_QUERY_MAX_LENGTH || CONTROL_CHARACTER.test(canonical)) {
		throw new TypeError('Catalog artist query is invalid');
	}
	return canonical;
}

export function fetchCoreStatus(fetchFn: FetchLike): Promise<CoreStatusResponse> {
	return request<CoreStatusResponse>(fetchFn, '/api/core');
}

export function switchCore(fetchFn: FetchLike): Promise<CoreSwitchResponse> {
	const body: CoreSwitchRequest = { confirmed: true };
	return request<CoreSwitchResponse>(fetchFn, '/api/core/switch', {
		method: 'POST',
		body: JSON.stringify(body)
	});
}

/**
 * First-run read model. Two facts the browser cannot derive: whether this
 * install has ever paired a Core, and the hostname of the machine running
 * the engine. See `OnboardingStatusResponse`.
 */
export function fetchOnboardingStatus(fetchFn: FetchLike): Promise<OnboardingStatusResponse> {
	return request<OnboardingStatusResponse>(fetchFn, '/api/onboarding');
}

export function fetchCatalogStatus(fetchFn: FetchLike): Promise<CatalogStatus> {
	return catalogRequest(fetchFn, '/api/catalog/status', normalizeCatalogStatus);
}

export type CatalogIndexResult =
	| { kind: 'index'; index: CatalogIndexResponse }
	| { kind: 'empty' };

/**
 * GET /api/catalog/index. A 409 is the server's honest "catalog empty"
 * answer and is returned as `{ kind: 'empty' }` so callers can fall back
 * to browse-drain; everything else invalid throws like the sibling
 * catalog fetchers.
 */
export async function fetchCatalogIndex(fetchFn: FetchLike): Promise<CatalogIndexResult> {
	try {
		const index = await catalogRequest(
			fetchFn,
			'/api/catalog/index',
			normalizeCatalogIndexResponse
		);
		return { kind: 'index', index };
	} catch (error) {
		if (error instanceof ApiError && error.status === 409) return { kind: 'empty' };
		throw error;
	}
}

export function refreshCatalog(fetchFn: FetchLike): Promise<CatalogRefreshAcceptedResponse> {
	return catalogRequest(
		fetchFn,
		'/api/catalog/refresh',
		normalizeCatalogRefreshAcceptedResponse,
		{ method: 'POST' }
	);
}

export async function searchCatalogArtists(
	fetchFn: FetchLike,
	queryValue: string,
	limitValue = CATALOG_ARTIST_SEARCH_DEFAULT_LIMIT
): Promise<CatalogArtistSearchResponse> {
	const query = catalogArtistQuery(queryValue);
	const limit = catalogLimit(limitValue, CATALOG_ARTIST_SEARCH_MAX_LIMIT);
	const params = new URLSearchParams({ query, limit: String(limit) });
	const response = await catalogRequest(
		fetchFn,
		`/api/catalog/artists?${params.toString()}`,
		normalizeCatalogArtistSearchResponse
	);
	if (response.query !== query || response.limit !== limit) {
		throw invalidCatalogResponse(response);
	}
	return response;
}

export async function fetchCatalogArtistAlbums(
	fetchFn: FetchLike,
	artistLocalId: string,
	limitValue = CATALOG_ARTIST_ALBUMS_DEFAULT_LIMIT
): Promise<CatalogArtistAlbumsResponse> {
	if (!isCatalogLocalId(artistLocalId)) {
		throw new TypeError('Catalog artist ID is invalid');
	}
	const limit = catalogLimit(limitValue, CATALOG_ARTIST_ALBUMS_MAX_LIMIT);
	const params = new URLSearchParams({ limit: String(limit) });
	const response = await catalogRequest(
		fetchFn,
		`/api/catalog/artists/${encodeURIComponent(artistLocalId)}/albums?${params.toString()}`,
		normalizeCatalogArtistAlbumsResponse
	);
	if (response.artist.localId !== artistLocalId || response.limit !== limit) {
		throw invalidCatalogResponse(response);
	}
	return response;
}

export async function loadCatalogArtistAlbums(
	fetchFn: FetchLike,
	artistLocalId: string,
	revisionValue: number,
	limitValue = CATALOG_ARTIST_ALBUMS_DEFAULT_LIMIT
): Promise<CatalogArtistAlbumsResponse> {
	if (!isCatalogLocalId(artistLocalId)) {
		throw new TypeError('Catalog artist ID is invalid');
	}
	if (
		!Number.isSafeInteger(revisionValue) ||
		revisionValue < 1 ||
		revisionValue >= Number.MAX_SAFE_INTEGER
	) {
		throw new RangeError('Catalog revision is invalid');
	}
	const limit = catalogLimit(limitValue, CATALOG_ARTIST_ALBUMS_MAX_LIMIT);
	const params = new URLSearchParams({
		revision: String(revisionValue),
		limit: String(limit)
	});
	const response = await catalogRequest(
		fetchFn,
		`/api/catalog/artists/${encodeURIComponent(artistLocalId)}/albums/load?${params.toString()}`,
		normalizeCatalogArtistAlbumsResponse,
		{ method: 'POST' }
	);
	if (
		response.artist.localId !== artistLocalId ||
		response.limit !== limit ||
		(response.status.revision !== revisionValue && response.status.revision !== revisionValue + 1)
	) {
		throw invalidCatalogResponse(response);
	}
	return response;
}

/**
 * /api/health answers 503 with the SAME diagnostic body when a critical
 * subsystem is degraded. Non-critical catalog diagnostics may be degraded in
 * a 200 body. Either way, 503 diagnostics are data rather than a transport
 * failure, so recover them from the ApiError instead of throwing.
 */
export async function fetchHealth(fetchFn: FetchLike): Promise<HealthResponse> {
	try {
		return await request<HealthResponse>(fetchFn, '/api/health');
	} catch (err) {
		if (
			err instanceof ApiError &&
			err.status === 503 &&
			err.body &&
			typeof err.body === 'object' &&
			'subsystems' in err.body
		) {
			return err.body as HealthResponse;
		}
		throw err;
	}
}

export async function fetchZones(fetchFn: FetchLike): Promise<ZonesResponse['zones']> {
	const { zones } = await request<ZonesResponse>(fetchFn, '/api/zones');
	return zones;
}

export async function fetchRecentlyPlayed(
	fetchFn: FetchLike
): Promise<RecentlyPlayedSnapshot> {
	return request<RecentlyPlayedSnapshot>(fetchFn, '/api/recently-played');
}

export async function clearRecentlyPlayed(
	fetchFn: FetchLike
): Promise<RecentlyPlayedSnapshot> {
	return request<RecentlyPlayedSnapshot>(fetchFn, '/api/recently-played', {
		method: 'DELETE'
	});
}

export function fetchFavorites(fetchFn: FetchLike): Promise<FavoritesResponse> {
	return request<FavoritesResponse>(fetchFn, '/api/favorites');
}

export function addFavorite(
	fetchFn: FetchLike,
	payload: AddFavoriteRequest
): Promise<FavoritesResponse> {
	return request<FavoritesResponse>(fetchFn, '/api/favorites', {
		method: 'POST',
		body: JSON.stringify(payload)
	});
}

export function removeFavorite(fetchFn: FetchLike, id: string): Promise<FavoritesResponse> {
	return request<FavoritesResponse>(fetchFn, `/api/favorites/${encodeURIComponent(id)}`, {
		method: 'DELETE'
	});
}

export function browse(
	_fetchFn: FetchLike,
	options: ClassicBrowseOptions,
	claim: ClassicBrowseSessionClaim,
	role: ClassicBrowseRole = options.hierarchy === 'search'
		? 'classic-search'
		: 'classic-browse'
): Promise<BrowseResult> {
	return classicBrowseSessionClient.request(claim, 'browse', role, options);
}

export function browseLoad(
	_fetchFn: FetchLike,
	options: ClassicBrowseLoadOptions,
	claim: ClassicBrowseSessionClaim,
	role: ClassicBrowseRole = options.hierarchy === 'search'
		? 'classic-search'
		: 'classic-browse'
): Promise<BrowseResult> {
	return classicBrowseSessionClient.request(claim, 'load', role, options);
}

export function browsePop(
	_fetchFn: FetchLike,
	options: ClassicBrowsePopOptions,
	claim: ClassicBrowseSessionClaim,
	role: ClassicBrowseRole = options.hierarchy === 'search'
		? 'classic-search'
		: 'classic-browse'
): Promise<BrowseResult> {
	return classicBrowseSessionClient.request(claim, 'pop', role, options);
}

export function browseSearch(
	_fetchFn: FetchLike,
	options: ClassicBrowseSearchOptions,
	claim: ClassicBrowseSessionClaim,
	role: ClassicBrowseRole = 'classic-search'
): Promise<SearchResult[]> {
	return classicBrowseSessionClient.request(claim, 'search', role, options);
}

export interface ClassicBrowseApiTransaction {
	browse(options: ClassicBrowseOptions): Promise<BrowseResult>;
	browseLoad(options: ClassicBrowseLoadOptions): Promise<BrowseResult>;
	browsePop(options: ClassicBrowsePopOptions): Promise<BrowseResult>;
	browseSearch(options: ClassicBrowseSearchOptions): Promise<SearchResult[]>;
}

function classicBrowseApiTransaction(
	transaction: ClassicBrowseRoleTransaction
): ClassicBrowseApiTransaction {
	return {
		browse: (options) => transaction.request('browse', options),
		browseLoad: (options) => transaction.request('load', options),
		browsePop: (options) => transaction.request('pop', options),
		browseSearch: (options) => transaction.request('search', options)
	};
}

export function withClassicBrowseRoleTransaction<T>(
	role: ClassicBrowseRole,
	claim: ClassicBrowseSessionClaim,
	work: (transaction: ClassicBrowseApiTransaction) => Promise<T>
): Promise<T> {
	return classicBrowseSessionClient.transaction(claim, role, (transaction) =>
		work(classicBrowseApiTransaction(transaction))
	);
}
