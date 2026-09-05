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
	LIBRARY_OPAQUE_MAX_LENGTH,
	normalizeLibraryRootsResponse,
	normalizeLibraryRootsUnavailable,
	type LibraryRootsResponse,
	type LibraryRootsUnavailable,
	type LibraryRowReference
} from '@shared/libraryRootsContracts';
import {
	normalizeLibraryOpenResponse,
	type LibraryOpenResponse
} from '@shared/libraryOpenContracts';
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
/**
 * The live library's two roots (`.agents/plans/library-live-view.md` Slice 1).
 *
 * `unavailable` is an ANSWER, not a transport failure: a paired Core that is
 * being spared, or no Core at all, is something the surface has to say out
 * loud, and flattening it into an error — or worse, into an empty library —
 * would render as a library that lost its contents.
 *
 * Passing the generation the caller already holds turns this into the cheap
 * check: the server confirms it against Roon's own root counts and answers
 * `current` with no rows, or hands back the whole new snapshot if what the
 * caller holds is gone.
 */
export type LibraryRootsResult =
	| { kind: 'roots'; roots: LibraryRootsResponse }
	| { kind: 'unavailable'; unavailable: LibraryRootsUnavailable };

async function libraryRootsRequest(
	fetchFn: FetchLike,
	input: string,
	init?: RequestInit
): Promise<LibraryRootsResult> {
	let body: unknown;
	try {
		body = await request<unknown>(fetchFn, input, init);
	} catch (error) {
		if (error instanceof ApiError && error.status === 503) {
			const unavailable = normalizeLibraryRootsUnavailable(error.body);
			if (unavailable) return { kind: 'unavailable', unavailable };
		}
		if (error instanceof SyntaxError) throw new ApiError('Invalid library response', 502, null);
		throw error;
	}
	const roots = normalizeLibraryRootsResponse(body);
	if (!roots) throw new ApiError('Invalid library response', 502, body);
	return { kind: 'roots', roots };
}

export function fetchLibraryRoots(
	fetchFn: FetchLike,
	heldGeneration?: string
): Promise<LibraryRootsResult> {
	if (heldGeneration !== undefined) {
		// Bounded before it is sent rather than after it comes back: a
		// generation this long is not one this server minted.
		if (heldGeneration.length === 0 || heldGeneration.length > LIBRARY_OPAQUE_MAX_LENGTH) {
			throw new TypeError('Library generation is invalid');
		}
		const params = new URLSearchParams({ generation: heldGeneration });
		return libraryRootsRequest(fetchFn, `/api/library/roots?${params.toString()}`);
	}
	return libraryRootsRequest(fetchFn, '/api/library/roots');
}

/** The reader's own Refresh: re-read both roots now, retiring every reference. */
export function refreshLibraryRoots(fetchFn: FetchLike): Promise<LibraryRootsResult> {
	return libraryRootsRequest(fetchFn, '/api/library/roots/refresh', { method: 'POST' });
}

/**
 * Open one live row, or one on-demand root (`.agents/plans/library-live-view.md`
 * Slice 2).
 *
 * All three outcomes the server states — a level, `stale`, `unavailable` — come
 * back as ANSWERS rather than exceptions, because each is something the surface
 * has to say in different words. `stale` in particular is not a failure: it is
 * the library saying the snapshot the reader held has been replaced, and the
 * reader's response is to re-resolve, not to retry the same dead reference.
 *
 * A transport failure is still thrown. Flattening one into `unavailable` would
 * put a sentence about the Core on screen for what is a broken connection.
 */
async function libraryOpenRequest(
	fetchFn: FetchLike,
	body: unknown
): Promise<LibraryOpenResponse> {
	let payload: unknown;
	try {
		payload = await request<unknown>(fetchFn, '/api/library/open', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
	} catch (error) {
		if (error instanceof ApiError && (error.status === 409 || error.status === 503)) {
			const stated = normalizeLibraryOpenResponse(error.body);
			if (stated) return stated;
		}
		if (error instanceof SyntaxError) throw new ApiError('Invalid library response', 502, null);
		throw error;
	}
	const level = normalizeLibraryOpenResponse(payload);
	if (!level) throw new ApiError('Invalid library response', 502, payload);
	return level;
}

export function openLibraryReference(
	fetchFn: FetchLike,
	ref: LibraryRowReference
): Promise<LibraryOpenResponse> {
	return libraryOpenRequest(fetchFn, { ref });
}

/** Roon's Genres and Composers roots, read only when a reader asks for one. */
export function openLibraryRoot(
	fetchFn: FetchLike,
	root: 'genres' | 'composers'
): Promise<LibraryOpenResponse> {
	return libraryOpenRequest(fetchFn, { root });
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

/**
 * /api/health answers 503 with the SAME diagnostic body when a critical
 * subsystem is degraded. Either way, 503 diagnostics are data rather than a
 * transport failure, so recover them from the ApiError instead of throwing.
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
