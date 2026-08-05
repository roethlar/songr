import { writable, type Readable } from 'svelte/store';

import {
	CATALOG_ARTIST_QUERY_MAX_LENGTH,
	deriveCatalogTimelinePlacement,
	isCatalogLocalId,
	normalizeCatalogArtistAlbumsResponse,
	normalizeCatalogArtistSearchResponse,
	type ArtistRef,
	type CatalogResolutionStatus,
	type CatalogStatus,
	type CatalogTimelinePlacement
} from '@shared/timelineCatalogContracts';
import { ApiError, loadCatalogArtistAlbums, searchCatalogArtists } from '$lib/api/client';
import {
	mapCatalogArtistAlbumsToTimelineInputs,
	type TimelineCatalogMappingOptions
} from '$lib/timeline/catalog';
import type { TimelineAlbumLayoutInput } from '$lib/timeline';

export const TIMELINE_BRANCH_MAX_OPEN = 3;
export const TIMELINE_BRANCH_MAX_SEARCH_RESULTS = 8;
export const TIMELINE_BRANCH_MAX_ALBUMS = 8;
export const TIMELINE_BRANCH_MAX_DEPTH = 2;

export const TIMELINE_BRANCH_PROVENANCE = Object.freeze({
	provider: 'artist-search',
	providerLabel: 'Artist search',
	attachmentLabel: 'User-attached branch'
} as const);

export type TimelineBranchLifecycle = 'active' | 'disconnected' | 'quiesced';
export type TimelineBranchPhase = 'loading' | 'ready' | 'error';
export type TimelineBranchSearchPhase = 'idle' | 'loading' | 'ready' | 'error';
export type TimelineBranchDepth = 1 | 2;
export type TimelineBranchSourceDepth = 0 | TimelineBranchDepth;

export type TimelineBranchCatalogRevisionAdopter = (
	status: CatalogStatus,
	expectedRevision: number
) => boolean;

export interface TimelineBranchScope {
	readonly coreId: string;
	readonly baseArtistLocalId: string;
	readonly catalogRevision: number;
	/** Generation of the current base-canvas semantic source model. */
	readonly sourceGeneration: number;
}

export interface TimelineBranchSourceRef {
	readonly kind: 'base-album' | 'branch-album';
	readonly entityId: string;
	readonly albumLocalId: string;
	readonly parentBranchId: string | null;
	readonly depth: TimelineBranchSourceDepth;
	readonly sourceGeneration: number;
}

export interface TimelineBranchAlbum {
	/** Stable within this tab-memory topology and unique across parallel branches. */
	readonly entityId: string;
	readonly branchId: string;
	readonly albumLocalId: string;
	readonly artistLocalId: string;
	readonly title: string;
	readonly artist: string;
	readonly placement: CatalogTimelinePlacement;
	readonly resolutionStatus: CatalogResolutionStatus;
	readonly imageKeyHint?: string;
}

export interface TimelineArtistBranch {
	readonly branchId: string;
	readonly generation: number;
	readonly depth: TimelineBranchDepth;
	readonly source: TimelineBranchSourceRef;
	readonly artist: ArtistRef;
	readonly provenance: typeof TIMELINE_BRANCH_PROVENANCE;
	readonly phase: TimelineBranchPhase;
	readonly error: string | null;
	readonly albums: readonly TimelineBranchAlbum[];
	readonly catalogTotal: number;
	readonly catalogTruncated: boolean;
}

export interface TimelineBranchSearchState {
	readonly phase: TimelineBranchSearchPhase;
	readonly query: string;
	readonly source: TimelineBranchSourceRef | null;
	readonly candidates: readonly ArtistRef[];
	readonly catalogTotal: number;
	readonly catalogTruncated: boolean;
	readonly error: string | null;
}

export interface TimelineBranchState {
	readonly scope: TimelineBranchScope | null;
	readonly lifecycle: TimelineBranchLifecycle;
	readonly search: TimelineBranchSearchState;
	readonly branches: readonly TimelineArtistBranch[];
}

export interface TimelineBranchScopeResult {
	readonly accepted: boolean;
	readonly incompatible: boolean;
	readonly sourceChanged: boolean;
	readonly clearedBranchCount: number;
}

export type TimelineBranchSearchResult =
	| { readonly success: true; readonly candidates: readonly ArtistRef[] }
	| {
			readonly success: false;
			readonly reason:
				| 'inactive'
				| 'invalid-source'
				| 'invalid-query'
				| 'superseded'
				| 'failed';
			readonly error?: string;
	  };

export type TimelineBranchLoadResult =
	| {
			readonly success: true;
			readonly branchId: string;
			readonly branch: TimelineArtistBranch;
	  }
	| {
			readonly success: false;
			readonly reason:
				| 'inactive'
				| 'invalid-source'
				| 'not-candidate'
				| 'capacity'
				| 'depth-limit'
				| 'not-retryable'
				| 'catalog-conflict'
				| 'superseded'
				| 'failed';
			readonly branchId?: string;
			readonly branch?: TimelineArtistBranch;
			readonly error?: string;
	  };

export interface TimelineBranchCloseResult {
	readonly closed: boolean;
	readonly branchIds: readonly string[];
}

type FetchLike = typeof fetch;

export interface TimelineBranchStoreDependencies {
	readonly fetchFn?: FetchLike;
	readonly search?: (
		fetchFn: FetchLike,
		query: string,
		limit: number
	) => ReturnType<typeof searchCatalogArtists>;
	readonly fetchArtistAlbums?: (
		fetchFn: FetchLike,
		artistLocalId: string,
		revision: number,
		limit: number
	) => ReturnType<typeof loadCatalogArtistAlbums>;
	readonly mapAlbums?: (
		response: Parameters<typeof mapCatalogArtistAlbumsToTimelineInputs>[0],
		options?: TimelineCatalogMappingOptions
	) => TimelineAlbumLayoutInput[];
}

export interface TimelineBranchStore extends Readable<TimelineBranchState> {
	reconcileScope(scope: TimelineBranchScope): TimelineBranchScopeResult;
	activate(scope: TimelineBranchScope): TimelineBranchScopeResult;
	resume(scope: TimelineBranchScope): TimelineBranchScopeResult;
	sourceForBaseAlbum(entityId: string, albumLocalId: string): TimelineBranchSourceRef | null;
	sourceForBranchAlbum(entityId: string): TimelineBranchSourceRef | null;
	searchArtists(source: TimelineBranchSourceRef, query: string): Promise<TimelineBranchSearchResult>;
	cancelSearch(): void;
	attachArtist(
		source: TimelineBranchSourceRef,
		artistLocalId: string,
		adoptCatalogRevision?: TimelineBranchCatalogRevisionAdopter
	): Promise<TimelineBranchLoadResult>;
	retryBranch(
		branchId: string,
		adoptCatalogRevision?: TimelineBranchCatalogRevisionAdopter
	): Promise<TimelineBranchLoadResult>;
	closeBranch(branchId: string): TimelineBranchCloseResult;
	connectionLost(): void;
	quiesce(): void;
	destroy(): void;
}

const EMPTY_SEARCH: TimelineBranchSearchState = Object.freeze({
	phase: 'idle',
	query: '',
	source: null,
	candidates: Object.freeze([]),
	catalogTotal: 0,
	catalogTruncated: false,
	error: null
});

const EMPTY_STATE: TimelineBranchState = Object.freeze({
	scope: null,
	lifecycle: 'quiesced',
	search: EMPTY_SEARCH,
	branches: Object.freeze([])
});

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function productionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return globalThis.fetch(input, init);
}

function validIdentity(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function normalizeScope(scope: TimelineBranchScope): TimelineBranchScope | null {
	if (
		!validIdentity(scope?.coreId) ||
		!isCatalogLocalId(scope?.baseArtistLocalId) ||
		!Number.isSafeInteger(scope?.catalogRevision) ||
		scope.catalogRevision < 1 ||
		!Number.isSafeInteger(scope?.sourceGeneration) ||
		scope.sourceGeneration < 0
	) return null;
	return Object.freeze({
		coreId: scope.coreId,
		baseArtistLocalId: scope.baseArtistLocalId,
		catalogRevision: scope.catalogRevision,
		sourceGeneration: scope.sourceGeneration
	});
}

function incompatibleScope(left: TimelineBranchScope | null, right: TimelineBranchScope): boolean {
	return (
		left !== null &&
		(left.coreId !== right.coreId ||
			left.baseArtistLocalId !== right.baseArtistLocalId ||
			left.catalogRevision !== right.catalogRevision)
	);
}

function sameSource(left: TimelineBranchSourceRef | null, right: TimelineBranchSourceRef): boolean {
	return (
		left?.kind === right.kind &&
		left.entityId === right.entityId &&
		left.albumLocalId === right.albumLocalId &&
		left.parentBranchId === right.parentBranchId &&
		left.depth === right.depth &&
		left.sourceGeneration === right.sourceGeneration
	);
}

function copySource(source: TimelineBranchSourceRef): TimelineBranchSourceRef {
	return Object.freeze({ ...source });
}

function copyArtist(artist: ArtistRef): ArtistRef {
	return Object.freeze({
		localId: artist.localId,
		coreId: artist.coreId,
		exactName: artist.exactName,
		normalizedName: artist.normalizedName,
		...(artist.imageKeyHint ? { imageKeyHint: artist.imageKeyHint } : {}),
		firstSeenAt: artist.firstSeenAt,
		lastSeenAt: artist.lastSeenAt,
		resolutionStatus: artist.resolutionStatus
	});
}

function canonicalQuery(value: string): string | null {
	if (typeof value !== 'string' || value.length > CATALOG_ARTIST_QUERY_MAX_LENGTH) return null;
	try {
		const query = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
		return query.length <= CATALOG_ARTIST_QUERY_MAX_LENGTH && !CONTROL_CHARACTER.test(query)
			? query
			: null;
	} catch {
		return null;
	}
}

function errorText(reason: unknown, fallback: string): string {
	return reason instanceof Error && reason.message.trim().length > 0 ? reason.message : fallback;
}

class TimelineBranchCatalogConflictError extends Error {
	constructor() {
		super('Hydrated branch catalog revision was not adopted');
		this.name = 'TimelineBranchCatalogConflictError';
	}
}

function catalogRevisionConflict(reason: unknown): boolean {
	return (
		reason instanceof TimelineBranchCatalogConflictError ||
		(
			reason instanceof ApiError &&
			reason.status === 409 &&
			reason.body !== null &&
			typeof reason.body === 'object' &&
			'details' in reason.body &&
			(reason.body as { readonly details?: unknown }).details === 'REVISION_CONFLICT'
		)
	);
}

function placementEquals(left: CatalogTimelinePlacement, right: CatalogTimelinePlacement): boolean {
	if (
		left.kind !== right.kind ||
		left.ordinal !== right.ordinal
	) return false;
	if (left.kind === 'calendar' && right.kind === 'calendar') {
		return (
			left.year === right.year &&
			left.evidence.sourceContract === right.evidence.sourceContract &&
			left.evidence.field === right.evidence.field &&
			left.evidence.date === right.evidence.date
		);
	}
	return (
		left.kind === 'undated' &&
		right.kind === 'undated' &&
		left.label === right.label &&
		left.reason === right.reason
	);
}

export function timelineBranchEntityId(branchId: string, albumLocalId: string): string {
	return `${branchId}:${albumLocalId}`;
}

export function createTimelineBranchStore(
	dependencies: TimelineBranchStoreDependencies = {}
): TimelineBranchStore {
	const state = writable<TimelineBranchState>(EMPTY_STATE);
	const fetchFn = dependencies.fetchFn ?? productionFetch;
	const searchCatalog = dependencies.search ?? searchCatalogArtists;
	const fetchAlbums = dependencies.fetchArtistAlbums ?? loadCatalogArtistAlbums;
	const mapAlbums = dependencies.mapAlbums ?? mapCatalogArtistAlbumsToTimelineInputs;

	let snapshot = EMPTY_STATE;
	let destroyed = false;
	let scopeEpoch = 0;
	let searchGeneration = 0;
	let nextBranchOrdinal = 1;
	let nextBranchGeneration = 1;

	function publish(patch: Partial<Omit<TimelineBranchState, 'branches' | 'search'>> & {
		readonly branches?: readonly TimelineArtistBranch[];
		readonly search?: TimelineBranchSearchState;
	}): void {
		snapshot = Object.freeze({
			scope: patch.scope === undefined ? snapshot.scope : patch.scope,
			lifecycle: patch.lifecycle ?? snapshot.lifecycle,
			search: patch.search ?? snapshot.search,
			branches: patch.branches ? Object.freeze([...patch.branches]) : snapshot.branches
		});
		state.set(snapshot);
	}

	function resetSearch(): void {
		if (destroyed) return;
		searchGeneration += 1;
		if (snapshot.search !== EMPTY_SEARCH) publish({ search: EMPTY_SEARCH });
	}

	function branchById(branchId: string): TimelineArtistBranch | null {
		return snapshot.branches.find((branch) => branch.branchId === branchId) ?? null;
	}

	function resolveSource(source: TimelineBranchSourceRef): TimelineBranchSourceRef | null {
		const scope = snapshot.scope;
		if (!scope || !validIdentity(source?.entityId) || !isCatalogLocalId(source?.albumLocalId)) {
			return null;
		}
		if (source.kind === 'base-album') {
			if (
				source.parentBranchId !== null ||
				source.depth !== 0 ||
				source.sourceGeneration !== scope.sourceGeneration
			) return null;
			return copySource(source);
		}
		if (source.kind !== 'branch-album' || source.parentBranchId === null) return null;
		const branch = branchById(source.parentBranchId);
		if (
			!branch ||
			branch.phase !== 'ready' ||
			source.depth !== branch.depth ||
			source.sourceGeneration !== branch.generation ||
			!branch.albums.some(
				(album) => album.entityId === source.entityId && album.albumLocalId === source.albumLocalId
			)
		) return null;
		return copySource(source);
	}

	function excludedArtistIds(source: TimelineBranchSourceRef): Set<string> {
		const ids = new Set<string>();
		if (snapshot.scope) ids.add(snapshot.scope.baseArtistLocalId);
		for (const branch of snapshot.branches) ids.add(branch.artist.localId);
		let branchId = source.parentBranchId;
		while (branchId) {
			const branch = branchById(branchId);
			if (!branch) break;
			ids.add(branch.artist.localId);
			branchId = branch.source.parentBranchId;
		}
		return ids;
	}

	function scopeMatches(
		capturedScope: TimelineBranchScope,
		capturedEpoch: number,
		coreId?: string,
		catalogRevision?: number
	): boolean {
		const current = snapshot.scope;
		return (
			!destroyed &&
			snapshot.lifecycle === 'active' &&
			scopeEpoch === capturedEpoch &&
			current?.coreId === capturedScope.coreId &&
			current.baseArtistLocalId === capturedScope.baseArtistLocalId &&
			current.catalogRevision === capturedScope.catalogRevision &&
			current.sourceGeneration === capturedScope.sourceGeneration &&
			(coreId === undefined || coreId === capturedScope.coreId) &&
			(catalogRevision === undefined || catalogRevision === capturedScope.catalogRevision)
		);
	}

	function replaceBranch(branch: TimelineArtistBranch): boolean {
		const index = snapshot.branches.findIndex((entry) => entry.branchId === branch.branchId);
		if (index < 0) return false;
		const branches = [...snapshot.branches];
		branches[index] = branch;
		publish({ branches });
		return true;
	}

	function errorBranch(
		branch: TimelineArtistBranch,
		error: string,
		generation = branch.generation
	): TimelineArtistBranch {
		return Object.freeze({
			...branch,
			generation,
			phase: 'error',
			error,
			albums: Object.freeze([]),
			catalogTotal: 0,
			catalogTruncated: false
		});
	}

	function publishHydratedReadyBranch(
		ready: TimelineArtistBranch,
		currentScope: TimelineBranchScope,
		nextRevision: number
	): boolean {
		const nextScope = Object.freeze({ ...currentScope, catalogRevision: nextRevision });
		let replaced = false;
		const branches = snapshot.branches.map((branch) => {
			if (branch.branchId === ready.branchId) {
				replaced = true;
				return ready;
			}
			if (branch.phase !== 'loading') return branch;
			return errorBranch(
				branch,
				'Branch load was retired when auxiliary artist hydration advanced the catalog revision',
				nextBranchGeneration++
			);
		});
		if (!replaced) return false;
		scopeEpoch += 1;
		searchGeneration += 1;
		publish({ scope: nextScope, search: EMPTY_SEARCH, branches });
		return true;
	}

	function retirePending(message: string, nextSourceGeneration?: number): void {
		searchGeneration += 1;
		const branches = snapshot.branches.map((branch) => {
			const source =
				branch.source.kind === 'base-album' && nextSourceGeneration !== undefined
					? copySource({ ...branch.source, sourceGeneration: nextSourceGeneration })
					: branch.source;
			if (branch.phase !== 'loading') {
				return source === branch.source ? branch : Object.freeze({ ...branch, source });
			}
			const generation = nextBranchGeneration++;
			return errorBranch(Object.freeze({ ...branch, source }), message, generation);
		});
		publish({ search: EMPTY_SEARCH, branches });
	}

	function applyScope(scopeValue: TimelineBranchScope): TimelineBranchScopeResult {
		const scope = normalizeScope(scopeValue);
		if (!scope || destroyed) {
			return { accepted: false, incompatible: false, sourceChanged: false, clearedBranchCount: 0 };
		}
		const incompatible = incompatibleScope(snapshot.scope, scope);
		const sourceChanged =
			snapshot.scope !== null && snapshot.scope.sourceGeneration !== scope.sourceGeneration;
		const clearedBranchCount = incompatible ? snapshot.branches.length : 0;
		if (!snapshot.scope || incompatible) {
			scopeEpoch += 1;
			searchGeneration += 1;
			publish({ scope, search: EMPTY_SEARCH, branches: Object.freeze([]) });
		} else if (sourceChanged) {
			scopeEpoch += 1;
			publish({ scope });
			retirePending('Branch load was retired when its source generation changed', scope.sourceGeneration);
		}
		return { accepted: true, incompatible, sourceChanged, clearedBranchCount };
	}

	function activate(scope: TimelineBranchScope): TimelineBranchScopeResult {
		const result = applyScope(scope);
		if (result.accepted && snapshot.lifecycle !== 'active') publish({ lifecycle: 'active' });
		return result;
	}

	async function loadBranch(
		branchId: string,
		branchGeneration: number,
		adoptCatalogRevision?: TimelineBranchCatalogRevisionAdopter
	): Promise<TimelineBranchLoadResult> {
		const branch = branchById(branchId);
		const scope = snapshot.scope;
		if (!branch || !scope || snapshot.lifecycle !== 'active') {
			return { success: false, reason: 'inactive', branchId };
		}
		const capturedEpoch = scopeEpoch;
		const source = resolveSource(branch.source);
		if (!source) return { success: false, reason: 'invalid-source', branchId };
		try {
			const raw = await fetchAlbums(
				fetchFn,
				branch.artist.localId,
				scope.catalogRevision,
				TIMELINE_BRANCH_MAX_ALBUMS
			);
			const current = branchById(branchId);
			if (
				!current ||
				current.generation !== branchGeneration ||
				!scopeMatches(scope, capturedEpoch) ||
				!resolveSource(source)
			) return { success: false, reason: 'superseded', branchId };

			const response = normalizeCatalogArtistAlbumsResponse(raw);
			if (
				!response ||
				response.limit !== TIMELINE_BRANCH_MAX_ALBUMS ||
				response.status.coreId !== scope.coreId ||
				(
					response.status.revision !== scope.catalogRevision &&
					response.status.revision !== scope.catalogRevision + 1
				) ||
				response.artist.localId !== current.artist.localId ||
				response.artist.coreId !== scope.coreId
			) throw new Error('Branch albums did not match the active catalog scope');

			const mapped = mapAlbums(response);
			const expected = response.albums.filter((album) => album.resolutionStatus !== 'missing');
			if (mapped.length !== expected.length || mapped.length > TIMELINE_BRANCH_MAX_ALBUMS) {
				throw new Error('Branch album mapping was incomplete');
			}
			const albums = mapped.map((input, index): TimelineBranchAlbum => {
				const descriptor = expected[index];
				const sourceIndex = response.albums.findIndex((album) => album.localId === descriptor.localId);
				const placement = deriveCatalogTimelinePlacement(descriptor, sourceIndex);
				if (
					!placement ||
					input.localId !== descriptor.localId ||
					input.title !== descriptor.exactTitle ||
					input.artist !== descriptor.exactArtist ||
					input.imageKeyHint !== descriptor.imageKeyHint ||
					!placementEquals(input.placement, placement)
				) throw new Error('Branch album mapping did not match its keyless descriptor');
				return Object.freeze({
					entityId: timelineBranchEntityId(branchId, descriptor.localId),
					branchId,
					albumLocalId: descriptor.localId,
					artistLocalId: response.artist.localId,
					title: descriptor.exactTitle,
					artist: descriptor.exactArtist,
					placement,
					resolutionStatus: descriptor.resolutionStatus,
					...(descriptor.imageKeyHint ? { imageKeyHint: descriptor.imageKeyHint } : {})
				});
			});
			const ready = Object.freeze({
				...current,
				artist: copyArtist(response.artist),
				phase: 'ready' as const,
				error: null,
				albums: Object.freeze(albums),
				catalogTotal: response.total,
				catalogTruncated: response.truncated
			});
				if (response.status.revision === scope.catalogRevision + 1) {
					if (!adoptCatalogRevision?.(response.status, scope.catalogRevision)) {
						throw new TimelineBranchCatalogConflictError();
					}
				const adoptedCurrent = branchById(branchId);
				if (
					!adoptedCurrent ||
					adoptedCurrent.generation !== branchGeneration ||
					!scopeMatches(scope, capturedEpoch) ||
					!resolveSource(source) ||
					!publishHydratedReadyBranch(ready, scope, response.status.revision)
				) return { success: false, reason: 'superseded', branchId };
			} else if (!replaceBranch(ready)) {
				return { success: false, reason: 'superseded', branchId };
			}
			return { success: true, branchId, branch: ready };
		} catch (reason) {
			const current = branchById(branchId);
			if (
				!current ||
				current.generation !== branchGeneration ||
				!scopeMatches(scope, capturedEpoch)
			) return { success: false, reason: 'superseded', branchId };
			const conflict = catalogRevisionConflict(reason);
			const error = conflict
				? 'The catalog changed while this artist branch was loading'
				: errorText(reason, 'Artist branch could not be loaded');
			const failed = errorBranch(current, error);
			replaceBranch(failed);
			return {
				success: false,
				reason: conflict ? 'catalog-conflict' : 'failed',
				branchId,
				branch: failed,
				error
			};
		}
	}

	return {
		subscribe: state.subscribe,
		reconcileScope: applyScope,
		activate,
		resume: activate,
		sourceForBaseAlbum(entityId, albumLocalId): TimelineBranchSourceRef | null {
			if (
				destroyed ||
				!snapshot.scope ||
				!validIdentity(entityId) ||
				!isCatalogLocalId(albumLocalId)
			) return null;
			return Object.freeze({
				kind: 'base-album',
				entityId,
				albumLocalId,
				parentBranchId: null,
				depth: 0,
				sourceGeneration: snapshot.scope.sourceGeneration
			});
		},
		sourceForBranchAlbum(entityId): TimelineBranchSourceRef | null {
			if (destroyed) return null;
			for (const branch of snapshot.branches) {
				if (branch.phase !== 'ready') continue;
				const album = branch.albums.find((candidate) => candidate.entityId === entityId);
				if (!album) continue;
				return Object.freeze({
					kind: 'branch-album',
					entityId: album.entityId,
					albumLocalId: album.albumLocalId,
					parentBranchId: branch.branchId,
					depth: branch.depth,
					sourceGeneration: branch.generation
				});
			}
			return null;
		},
		async searchArtists(sourceValue, queryValue): Promise<TimelineBranchSearchResult> {
			const query = canonicalQuery(queryValue);
			if (query === null) return { success: false, reason: 'invalid-query' };
			if (destroyed || snapshot.lifecycle !== 'active' || !snapshot.scope) {
				return { success: false, reason: 'inactive' };
			}
			const source = resolveSource(sourceValue);
			if (!source || source.depth >= TIMELINE_BRANCH_MAX_DEPTH) {
				return { success: false, reason: 'invalid-source' };
			}
			const scope = snapshot.scope;
			const capturedEpoch = scopeEpoch;
			const generation = ++searchGeneration;
			if (query.length === 0) {
				publish({ search: Object.freeze({ ...EMPTY_SEARCH, source, query }) });
				return { success: true, candidates: Object.freeze([]) };
			}
			publish({
				search: Object.freeze({
					...EMPTY_SEARCH,
					phase: 'loading',
					query,
					source
				})
			});
			try {
				const raw = await searchCatalog(fetchFn, query, TIMELINE_BRANCH_MAX_SEARCH_RESULTS);
				if (
					generation !== searchGeneration ||
					!scopeMatches(scope, capturedEpoch) ||
					!sameSource(resolveSource(source), source)
				) return { success: false, reason: 'superseded' };
				const response = normalizeCatalogArtistSearchResponse(raw);
				if (
					!response ||
					response.query !== query ||
					response.limit !== TIMELINE_BRANCH_MAX_SEARCH_RESULTS ||
					response.status.coreId !== scope.coreId ||
					response.status.revision !== scope.catalogRevision
				) throw new Error('Artist search did not match the active catalog scope');
				const excluded = excludedArtistIds(source);
				const candidates = Object.freeze(
					response.artists
						.filter((artist) => artist.coreId === scope.coreId && !excluded.has(artist.localId))
						.slice(0, TIMELINE_BRANCH_MAX_SEARCH_RESULTS)
						.map(copyArtist)
				);
				publish({
					search: Object.freeze({
						phase: 'ready',
						query,
						source,
						candidates,
						catalogTotal: response.total,
						catalogTruncated: response.truncated,
						error: null
					})
				});
				return { success: true, candidates };
			} catch (reason) {
				if (
					generation !== searchGeneration ||
					!scopeMatches(scope, capturedEpoch)
				) return { success: false, reason: 'superseded' };
				const error = errorText(reason, 'Artist search failed');
				publish({
					search: Object.freeze({
						...EMPTY_SEARCH,
						phase: 'error',
						query,
						source,
						error
					})
				});
				return { success: false, reason: 'failed', error };
			}
		},
		cancelSearch: resetSearch,
		async attachArtist(
			sourceValue,
			artistLocalId,
			adoptCatalogRevision
		): Promise<TimelineBranchLoadResult> {
			if (destroyed || snapshot.lifecycle !== 'active' || !snapshot.scope) {
				return { success: false, reason: 'inactive' };
			}
			const source = resolveSource(sourceValue);
			if (!source) return { success: false, reason: 'invalid-source' };
			if (source.depth >= TIMELINE_BRANCH_MAX_DEPTH) {
				return { success: false, reason: 'depth-limit' };
			}
			if (snapshot.branches.length >= TIMELINE_BRANCH_MAX_OPEN) {
				return { success: false, reason: 'capacity' };
			}
			const candidate =
				snapshot.search.phase === 'ready' && sameSource(snapshot.search.source, source)
					? snapshot.search.candidates.find((artist) => artist.localId === artistLocalId)
					: undefined;
			if (!candidate || excludedArtistIds(source).has(candidate.localId)) {
				return { success: false, reason: 'not-candidate' };
			}
			const branchId = `timeline-branch-${nextBranchOrdinal++}`;
			const generation = nextBranchGeneration++;
			const branch = Object.freeze({
				branchId,
				generation,
				depth: (source.depth + 1) as TimelineBranchDepth,
				source,
				artist: copyArtist(candidate),
				provenance: TIMELINE_BRANCH_PROVENANCE,
				phase: 'loading' as const,
				error: null,
				albums: Object.freeze([]),
				catalogTotal: 0,
				catalogTruncated: false
			});
			searchGeneration += 1;
			publish({ search: EMPTY_SEARCH, branches: [...snapshot.branches, branch] });
			return loadBranch(branchId, generation, adoptCatalogRevision);
		},
		async retryBranch(branchId, adoptCatalogRevision): Promise<TimelineBranchLoadResult> {
			if (destroyed || snapshot.lifecycle !== 'active') {
				return { success: false, reason: 'inactive', branchId };
			}
			const branch = branchById(branchId);
			if (!branch || branch.phase !== 'error') {
				return { success: false, reason: 'not-retryable', branchId };
			}
			const source = resolveSource(branch.source);
			if (!source) return { success: false, reason: 'invalid-source', branchId };
			const generation = nextBranchGeneration++;
			const loading = Object.freeze({
				...branch,
				generation,
				source,
				phase: 'loading' as const,
				error: null,
				albums: Object.freeze([]),
				catalogTotal: 0,
				catalogTruncated: false
			});
			replaceBranch(loading);
			return loadBranch(branchId, generation, adoptCatalogRevision);
		},
		closeBranch(branchId): TimelineBranchCloseResult {
			if (destroyed) return { closed: false, branchIds: Object.freeze([]) };
			const branch = branchById(branchId);
			if (!branch) return { closed: false, branchIds: Object.freeze([]) };
			const closed = new Set<string>([branchId]);
			let changed = true;
			while (changed) {
				changed = false;
				for (const candidate of snapshot.branches) {
					if (
						!closed.has(candidate.branchId) &&
						candidate.source.parentBranchId !== null &&
						closed.has(candidate.source.parentBranchId)
					) {
						closed.add(candidate.branchId);
						changed = true;
					}
				}
			}
			const branchIds = Object.freeze(
				snapshot.branches
					.filter((candidate) => closed.has(candidate.branchId))
					.map((candidate) => candidate.branchId)
			);
			const closesSearch =
				snapshot.search.source?.parentBranchId !== null &&
				snapshot.search.source?.parentBranchId !== undefined &&
				closed.has(snapshot.search.source.parentBranchId);
			if (closesSearch) searchGeneration += 1;
			publish({
				branches: snapshot.branches.filter((candidate) => !closed.has(candidate.branchId)),
				...(closesSearch ? { search: EMPTY_SEARCH } : {})
			});
			return { closed: true, branchIds };
		},
		connectionLost(): void {
			if (destroyed || snapshot.lifecycle === 'disconnected') return;
			publish({ lifecycle: 'disconnected' });
			scopeEpoch += 1;
			retirePending('Branch load was interrupted by disconnection');
		},
		quiesce(): void {
			if (destroyed || snapshot.lifecycle === 'quiesced') return;
			publish({ lifecycle: 'quiesced' });
			scopeEpoch += 1;
			retirePending('Branch load was retired while Timeline was inactive');
		},
		destroy(): void {
			if (destroyed) return;
			if (snapshot.lifecycle !== 'quiesced') {
				publish({ lifecycle: 'quiesced' });
				scopeEpoch += 1;
				retirePending('Branch load was retired while Timeline was inactive');
			}
			destroyed = true;
			searchGeneration += 1;
			scopeEpoch += 1;
		}
	};
}

export const timelineBranchStore = createTimelineBranchStore();
