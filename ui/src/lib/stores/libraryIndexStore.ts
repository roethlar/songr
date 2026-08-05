import { writable } from 'svelte/store';
import type { CatalogIndexResponse } from '@shared/catalogIndexContracts';
import type { CatalogIndexNativeFeatures } from '@shared/catalogIndexContracts';
import { CLASSIC_BROWSE_PAGE_SIZE_MAX } from '@shared/classicBrowseContracts';
import {
	normalizeCatalogText,
	type CatalogPartialDate,
	type CatalogResolutionStatus,
	type CatalogStatus
} from '@shared/timelineCatalogContracts';
import type { BrowseItem } from '@shared/types';
import { fetchCatalogIndex, withClassicBrowseRoleTransaction } from '../api/client';
import {
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim
} from './classicBrowseSessionStore';

/**
 * Unified Library index store (Unified Library plan §3.2, slice 3).
 *
 * Primary identity source is `GET /api/catalog/index` — the catalog snapshot
 * with real localIds and bindings. Artist album counts come from the public
 * Roon Artists hierarchy subtitles, exactly as the owner-approved build-v5
 * reference fetcher does; catalog binding counts are not a substitute. When
 * the server answers the honest 409 ("catalog empty" — no crawl has published
 * yet), the same bounded browse drain supplies the fallback rows.
 *
 * Entries, search keys, and letter buckets are prepared once per
 * `coreId + revision` and cached; a repeat load of the same revision
 * republishes the identical prepared arrays. On unpair/re-pair the caller
 * fences the store (`resetLibraryIndex`), which drops every outstanding
 * request and clears prepared caches for other Cores.
 */

export type LibrarySource = 'catalog' | 'browse';

export interface LibraryCapabilities {
	/** Album/track actions need real catalog localIds. */
	albumActions: boolean;
	/** Durable page-state restoration needs catalog identity. */
	durableRestoration: boolean;
	/** Count-based filters need a complete Roon Artists count list. */
	countFilters: boolean;
	countFiltersDisabledReason?: string;
	/** True when counts come from an unfinished/foreign enumeration. */
	countsApproximate: boolean;
	/**
	 * Release-year sorting needs the native date features (catalog v3 +
	 * the capability state machine's date answer on the index). When the
	 * index carried the capability's own reason it lands in
	 * `dateFeaturesDisabledReason`; otherwise the sort menu falls back to
	 * its own honest default reason.
	 */
	dateFeatures: boolean;
	dateFeaturesDisabledReason?: string;
	/**
	 * Most played needs the extended play features (the play-statistics pull
	 * plus the capability state machine's play answer on the index). When the index
	 * carried the capability's own reason it lands in
	 * `playFeaturesDisabledReason`.
	 */
	playFeatures: boolean;
	playFeaturesDisabledReason?: string;
	/**
	 * Playlists (Slice 7) ride the BASE native capability (the playlist
	 * snapshot pulled with the catalog refresh), not the date/play gates.
	 * When the index carried the capability's own reason it lands in
	 * `playlistFeaturesDisabledReason`.
	 */
	playlistFeatures: boolean;
	playlistFeaturesDisabledReason?: string;
}

export interface LibraryArtistEntry {
	/** Catalog localId, or a synthetic `browse:` id in fallback mode. */
	id: string;
	name: string;
	/** Precomputed sort key: normalized name, leading article stripped. */
	searchKey: string;
	/** Roon Artists-hierarchy album count. Unknown is undefined, never 0. */
	albumCount?: number;
	countComplete: boolean;
	catalogLocalId?: string;
}

export interface LibraryAlbumEntry {
	id: string;
	title: string;
	artist: string;
	/**
	 * Precomputed normalized search/sort key: article-stripped title followed
	 * by artist, so title ordering and artist-name palette matches coexist.
	 */
	searchKey: string;
	artistId?: string;
	imageKey?: string;
	catalogLocalId?: string;
	resolutionStatus?: CatalogResolutionStatus;
	/** Native release dates (catalog v3); the release-year sort key. */
	originalReleaseDate?: CatalogPartialDate;
	releaseDate?: CatalogPartialDate;
	/** Native import timestamp (catalog v3); the recently-added sort key. */
	importDate?: string;
}

export interface BrowseAlbumIdentity {
	readonly title: string;
	readonly artist: string;
	readonly imageKey?: string | null;
}

export interface LetterBucket {
	letter: string;
	start: number;
	count: number;
}

export interface LibraryIndexState {
	phase: 'idle' | 'loading' | 'ready' | 'error';
	source: LibrarySource | null;
	coreId: string | null;
	/** Catalog revision backing the entries; null for browse fallback. */
	revision: number | null;
	status: CatalogStatus | null;
	artists: LibraryArtistEntry[];
	albums: LibraryAlbumEntry[];
	artistBuckets: LetterBucket[];
	albumBuckets: LetterBucket[];
	capabilities: LibraryCapabilities;
	/** True when the browse-drain hit its hard cap before completion. */
	truncated: boolean;
	error: string | null;
}

export const CATALOG_CAPABILITIES: LibraryCapabilities = Object.freeze({
	albumActions: true,
	durableRestoration: true,
	countFilters: true,
	countsApproximate: false,
	// Conservative default: until the index carries the native capability
	// answer, date features stay disabled (the menu shows its honest reason).
	dateFeatures: false,
	playFeatures: false,
	playlistFeatures: false
});

/** Catalog mode when the Roon Artists count list cannot cover every row. */
export const INCOMPLETE_ARTIST_COUNTS_CAPABILITIES: LibraryCapabilities = Object.freeze({
	albumActions: true,
	durableRestoration: true,
	countFilters: false,
	countFiltersDisabledReason:
		'Counts are incomplete: the Roon Artists list did not match every catalog artist.',
	countsApproximate: false,
	dateFeatures: false,
	playFeatures: false,
	playlistFeatures: false
});

export const BROWSE_FALLBACK_CAPABILITIES: LibraryCapabilities = Object.freeze({
	albumActions: false,
	durableRestoration: false,
	countFilters: false,
	countFiltersDisabledReason:
		'Count filters need catalog artist identities; the catalog has not been crawled yet.',
	countsApproximate: false,
	dateFeatures: false,
	playFeatures: false,
	playlistFeatures: false
});

/**
 * Drain page size is bound to the classic browse contract cap: the drain's
 * initial `browse` call sends this as `pageSize`, and the contract rejects
 * anything above `CLASSIC_BROWSE_PAGE_SIZE_MAX` — a literal here can (and
 * did) silently drift past the cap, making every fallback drain fail with
 * "Classic browse request is invalid".
 */
export const BROWSE_DRAIN_PAGE_SIZE = CLASSIC_BROWSE_PAGE_SIZE_MAX;
export const BROWSE_DRAIN_MAX_ITEMS = 10_000;

const IDLE_STATE: LibraryIndexState = {
	phase: 'idle',
	source: null,
	coreId: null,
	revision: null,
	status: null,
	artists: [],
	albums: [],
	artistBuckets: [],
	albumBuckets: [],
	capabilities: CATALOG_CAPABILITIES,
	truncated: false,
	error: null
};

const internalStore = writable<LibraryIndexState>(IDLE_STATE);

export const libraryIndexStore = {
	subscribe: internalStore.subscribe
};

interface PreparedIndex {
	artists: LibraryArtistEntry[];
	albums: LibraryAlbumEntry[];
	artistBuckets: LetterBucket[];
	albumBuckets: LetterBucket[];
	artistCountsComplete: boolean;
}

/**
 * Prepared-entry cache keyed `coreId:revision`. Bounded to the two most
 * recent keys — enough for the only real repeat pattern (view remount on
 * an unchanged revision) without retaining stale 40k-entry arrays.
 */
const preparedCache = new Map<string, PreparedIndex>();
const PREPARED_CACHE_MAX_KEYS = 2;

/** Monotonic fence. Any await that crosses a bump drops its result. */
let fence = 0;

export function resetLibraryIndex(): void {
	fence += 1;
	preparedCache.clear();
	internalStore.set(IDLE_STATE);
}

/**
 * Sort key, owner-approved prototype rule: normalize, then strip one
 * leading article (`the `, `a `, `an `) so "The 1975" buckets under `#`
 * and "The Beatles" under `B`, exactly as the approved build-v5 surface
 * renders them (`sortKey = (s) => s.replace(/^(the |a |an )/i, '')`).
 */
export function librarySortKey(text: string): string {
	return normalizeCatalogText(text).replace(/^(the |a |an )/, '');
}

/**
 * Within-bucket order, owner-approved prototype rule: ICU collation
 * (`x.k.localeCompare(y.k)`), which sorts punctuation-led names by their
 * first word — `’Til Tuesday` before `"Weird Al" Yankovic` — instead of
 * by code point. Pinned to `en-US` so every environment (browser, Node
 * tests, the Pi kiosk) collates identically.
 */
const SEARCH_KEY_COLLATOR = new Intl.Collator('en-US');

export function bucketLetterFor(searchKey: string): string {
	const first = searchKey.codePointAt(0);
	if (first === undefined) return '#';
	if (first >= 0x61 && first <= 0x7a) {
		return String.fromCodePoint(first - 0x20);
	}
	return '#';
}

function computeBuckets(searchKeys: readonly string[]): LetterBucket[] {
	const buckets: LetterBucket[] = [];
	for (let index = 0; index < searchKeys.length; index += 1) {
		const letter = bucketLetterFor(searchKeys[index]);
		const last = buckets[buckets.length - 1];
		if (last && last.letter === letter) {
			last.count += 1;
		} else {
			buckets.push({ letter, start: index, count: 1 });
		}
	}
	return buckets;
}

/**
 * Rail-bucket rank for a search key: `#` first, then A–Z. Sorting by this
 * rank before code-point order keeps every bucket letter contiguous.
 * Without it, keys that start above `z` (e.g. `č`, `é`, `ó` — accented
 * initials survive `normalizeCatalogText`, which lowercases but does not
 * fold diacritics) sort after the A–Z run and open a second `#` bucket,
 * which crashes the letter-keyed each blocks in the unified scope views
 * (duplicate key `#`).
 */
function bucketRankFor(searchKey: string): number {
	const letter = bucketLetterFor(searchKey);
	return letter === '#' ? 0 : letter.charCodeAt(0) - 0x40;
}

export function compareLibrarySearchKeys(left: string, right: string): number {
	return (
		bucketRankFor(left) - bucketRankFor(right) ||
		SEARCH_KEY_COLLATOR.compare(left, right)
	);
}

function albumIdentityKey(title: string, artist: string): string {
	return `${normalizeCatalogText(title)}\u0000${normalizeCatalogText(artist)}`;
}

/**
 * Reattaches live browse rows to catalog identities without guessing.
 * Title + artist must resolve uniquely, unless the live cover key uniquely
 * disambiguates multiple catalog editions.
 */
export function reconcileBrowseAlbumsToCatalog(
	browseAlbums: readonly BrowseAlbumIdentity[],
	catalogAlbums: readonly LibraryAlbumEntry[]
): LibraryAlbumEntry[] {
	const candidatesByIdentity = new Map<string, LibraryAlbumEntry[]>();
	for (const candidate of catalogAlbums) {
		if (!candidate.catalogLocalId) continue;
		const key = albumIdentityKey(candidate.title, candidate.artist);
		const candidates = candidatesByIdentity.get(key);
		if (candidates) candidates.push(candidate);
		else candidatesByIdentity.set(key, [candidate]);
	}

	return browseAlbums.map((album, index) => {
		const candidates =
			candidatesByIdentity.get(albumIdentityKey(album.title, album.artist)) ?? [];
		const imageMatches = album.imageKey
			? candidates.filter((candidate) => candidate.imageKey === album.imageKey)
			: [];
		const match =
			imageMatches.length === 1
				? imageMatches[0]
				: candidates.length === 1
					? candidates[0]
					: undefined;
		const imageKey = album.imageKey ?? match?.imageKey;
		return {
			id: match?.id ?? `drill:${index}:${album.title}`,
			title: album.title,
			artist: album.artist,
			searchKey: `${librarySortKey(album.title)} ${normalizeCatalogText(album.artist)}`,
			...(imageKey ? { imageKey } : {}),
			...(match?.artistId ? { artistId: match.artistId } : {}),
			...(match?.catalogLocalId ? { catalogLocalId: match.catalogLocalId } : {}),
			...(match?.resolutionStatus ? { resolutionStatus: match.resolutionStatus } : {}),
			...(match?.originalReleaseDate
				? { originalReleaseDate: match.originalReleaseDate }
				: {}),
			...(match?.releaseDate ? { releaseDate: match.releaseDate } : {})
		};
	});
}

function sortBySearchKey<T extends { searchKey: string }>(entries: T[]): T[] {
	return entries.sort((a, b) => compareLibrarySearchKeys(a.searchKey, b.searchKey));
}

function catalogCapabilities(
	prepared: PreparedIndex,
	native: CatalogIndexNativeFeatures | undefined
): LibraryCapabilities {
	const counts = prepared.artistCountsComplete
		? CATALOG_CAPABILITIES
		: INCOMPLETE_ARTIST_COUNTS_CAPABILITIES;
	if (native === undefined) return counts;
	return Object.freeze({
		...counts,
		dateFeatures: native.dateFeaturesAvailable,
		...(native.dateFeaturesUnavailableReason !== undefined
			? { dateFeaturesDisabledReason: native.dateFeaturesUnavailableReason }
			: {}),
		playFeatures: native.playFeaturesAvailable,
		...(native.playFeaturesUnavailableReason !== undefined
			? { playFeaturesDisabledReason: native.playFeaturesUnavailableReason }
			: {}),
		playlistFeatures: native.playlistFeaturesAvailable,
		...(native.playlistFeaturesUnavailableReason !== undefined
			? { playlistFeaturesDisabledReason: native.playlistFeaturesUnavailableReason }
			: {})
	});
}

/** Mirrors build-v5's first-integer extraction from an Artists row subtitle. */
export function parseRoonArtistAlbumCount(subtitle: string | undefined): number | null {
	const match = subtitle?.match(/\d[\d,]*/);
	if (!match) return null;
	const parsed = Number(match[0].replaceAll(',', ''));
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function artistCountQueues(items: readonly BrowseItem[]): Map<string, number[]> {
	const queues = new Map<string, number[]>();
	for (const item of items) {
		const count = parseRoonArtistAlbumCount(item.subtitle);
		if (count === null) continue;
		const key = normalizeCatalogText(item.title);
		const queue = queues.get(key);
		if (queue) queue.push(count);
		else queues.set(key, [count]);
	}
	return queues;
}

function prepareCatalogIndex(
	index: CatalogIndexResponse,
	artistCountRows?: { items: readonly BrowseItem[]; truncated: boolean }
): PreparedIndex {
	const countQueues = artistCountRows ? artistCountQueues(artistCountRows.items) : null;
	let matchedCountRows = 0;
	const artists = sortBySearchKey(
		index.artists.map(
			(artist): LibraryArtistEntry => {
				const queue = countQueues?.get(normalizeCatalogText(artist.name));
				const roonCount = queue?.shift();
				if (roonCount !== undefined) matchedCountRows += 1;
				return {
					id: artist.localId,
					name: artist.name,
					searchKey: librarySortKey(artist.name),
					...(artistCountRows
						? roonCount !== undefined
							? { albumCount: roonCount }
							: {}
						: { albumCount: artist.knownAlbumCount }),
					countComplete: artistCountRows
						? roonCount !== undefined && !artistCountRows.truncated
						: artist.countComplete,
					catalogLocalId: artist.localId
				};
			}
		)
	);
	const albums = sortBySearchKey(
		index.albums.map(
			(album): LibraryAlbumEntry => ({
				id: album.localId,
				title: album.title,
				artist: album.artist,
				searchKey: `${librarySortKey(album.title)} ${normalizeCatalogText(album.artist)}`,
				...(album.artistLocalId !== undefined ? { artistId: album.artistLocalId } : {}),
				...(album.imageKeyHint !== undefined ? { imageKey: album.imageKeyHint } : {}),
				catalogLocalId: album.localId,
				resolutionStatus: album.resolutionStatus,
				...(album.originalReleaseDate !== undefined
					? { originalReleaseDate: { ...album.originalReleaseDate } }
					: {}),
				...(album.releaseDate !== undefined
					? { releaseDate: { ...album.releaseDate } }
					: {}),
				...(album.importDate !== undefined ? { importDate: album.importDate } : {})
			})
		)
	);
	const artistCountsComplete = artistCountRows
		? !artistCountRows.truncated &&
			matchedCountRows === index.artists.length &&
			artistCountRows.items.length === index.artists.length
		: index.artists.every((artist) => artist.countComplete);
	return {
		artists,
		albums,
		artistBuckets: computeBuckets(artists.map((entry) => entry.searchKey)),
		albumBuckets: computeBuckets(albums.map((entry) => entry.searchKey)),
		artistCountsComplete
	};
}

interface DrainTransaction {
	browse(options: {
		hierarchy: 'albums' | 'artists';
		pageSize?: number;
	}): Promise<{ items: BrowseItem[]; totalCount?: number; count: number }>;
	browseLoad(options: {
		hierarchy: 'albums' | 'artists';
		offset: number;
		count: number;
	}): Promise<{ items: BrowseItem[] }>;
}

async function drainHierarchy(
	transaction: DrainTransaction,
	hierarchy: 'albums' | 'artists'
): Promise<{ items: BrowseItem[]; truncated: boolean }> {
	const root = await transaction.browse({ hierarchy, pageSize: BROWSE_DRAIN_PAGE_SIZE });
	const total = Math.min(root.totalCount ?? root.count, BROWSE_DRAIN_MAX_ITEMS);
	const items: BrowseItem[] = [...root.items].slice(0, BROWSE_DRAIN_MAX_ITEMS);
	while (items.length < total) {
		const page = await transaction.browseLoad({
			hierarchy,
			offset: items.length,
			count: Math.min(BROWSE_DRAIN_PAGE_SIZE, total - items.length)
		});
		if (page.items.length === 0) break;
		items.push(...page.items.slice(0, total - items.length));
	}
	const reportedTotal = root.totalCount ?? root.count;
	return { items, truncated: reportedTotal > items.length };
}

function prepareBrowseFallback(
	artistItems: readonly BrowseItem[],
	albumItems: readonly BrowseItem[],
	artistCountsTruncated: boolean
): PreparedIndex {
	let parsedArtistCounts = 0;
	const artists = sortBySearchKey(
		artistItems.map(
			(item, index): LibraryArtistEntry => {
				const albumCount = parseRoonArtistAlbumCount(item.subtitle);
				if (albumCount !== null) parsedArtistCounts += 1;
				return {
					id: `browse:artist:${index}`,
					name: item.title,
					searchKey: librarySortKey(item.title),
					...(albumCount !== null ? { albumCount } : {}),
					countComplete: albumCount !== null && !artistCountsTruncated
				};
			}
		)
	);
	const albums = sortBySearchKey(
		albumItems.map(
			(item, index): LibraryAlbumEntry => ({
				id: `browse:album:${index}`,
				title: item.title,
				artist: item.subtitle ?? '',
				searchKey: `${librarySortKey(item.title)} ${normalizeCatalogText(item.subtitle ?? '')}`,
				...(item.imageKey !== undefined ? { imageKey: item.imageKey } : {})
			})
		)
	);
	return {
		artists,
		albums,
		artistBuckets: computeBuckets(artists.map((entry) => entry.searchKey)),
		albumBuckets: computeBuckets(albums.map((entry) => entry.searchKey)),
		artistCountsComplete:
			!artistCountsTruncated && parsedArtistCounts === artistItems.length
	};
}

function rememberPrepared(key: string, prepared: PreparedIndex): void {
	preparedCache.set(key, prepared);
	while (preparedCache.size > PREPARED_CACHE_MAX_KEYS) {
		const oldest = preparedCache.keys().next().value;
		if (oldest === undefined) break;
		preparedCache.delete(oldest);
	}
}

export interface LoadLibraryIndexOptions {
	/** The paired Core the caller is loading for. Responses for any other
	 * Core are rejected, never rendered. */
	coreId: string;
	claim: ClassicBrowseSessionClaim;
}

export async function loadLibraryIndex(
	fetchFn: typeof fetch,
	options: LoadLibraryIndexOptions
): Promise<void> {
	const token = fence;
	internalStore.update((state) => ({ ...state, phase: 'loading', error: null }));

	let result: Awaited<ReturnType<typeof fetchCatalogIndex>>;
	try {
		result = await fetchCatalogIndex(fetchFn);
	} catch (error) {
		if (token !== fence) return;
		internalStore.update((state) => ({
			...state,
			phase: 'error',
			error: error instanceof Error ? error.message : 'Catalog index failed'
		}));
		return;
	}
	if (token !== fence) return;

	if (result.kind === 'index') {
		const { index } = result;
		if (index.status.coreId !== options.coreId) {
			// Old-Core payload after a re-pair race — never rendered.
			internalStore.update((state) => ({
				...state,
				phase: 'error',
				error: 'Catalog index arrived for a different Core'
			}));
			return;
		}
		const cacheKey = `${index.status.coreId}:${index.status.revision}`;
		let prepared = preparedCache.get(cacheKey);
		if (!prepared) {
			let artistCountRows:
				| { items: readonly BrowseItem[]; truncated: boolean }
				| undefined;
			if (index.artists.some((artist) => !artist.countComplete)) {
				try {
					artistCountRows = await withClassicBrowseRoleTransaction(
						'classic-explore',
						options.claim,
						(transaction) =>
							drainHierarchy(transaction as DrainTransaction, 'artists')
					);
				} catch (error) {
					if (token !== fence) return;
					if (error instanceof ClassicBrowseSupersededError) return;
					internalStore.update((state) => ({
						...state,
						phase: 'error',
						error:
							error instanceof Error
								? `Could not load artist album counts: ${error.message}`
								: 'Could not load artist album counts'
					}));
					return;
				}
				if (token !== fence) return;
			}
			prepared = prepareCatalogIndex(index, artistCountRows);
			rememberPrepared(cacheKey, prepared);
		}
		internalStore.set({
			phase: 'ready',
			source: 'catalog',
			coreId: index.status.coreId,
			revision: index.status.revision,
			status: index.status,
			artists: prepared.artists,
			albums: prepared.albums,
			artistBuckets: prepared.artistBuckets,
			albumBuckets: prepared.albumBuckets,
			capabilities: catalogCapabilities(prepared, index.native),
			truncated: false,
			error: null
		});
		return;
	}

	// Honest empty catalog: browse-drain fallback.
	try {
		const drained = await withClassicBrowseRoleTransaction(
			'classic-explore',
			options.claim,
			async (transaction) => {
				const albums = await drainHierarchy(transaction as DrainTransaction, 'albums');
				const artists = await drainHierarchy(transaction as DrainTransaction, 'artists');
				return { albums, artists };
			}
		);
		if (token !== fence) return;
		const prepared = prepareBrowseFallback(
			drained.artists.items,
			drained.albums.items,
			drained.artists.truncated
		);
		internalStore.set({
			phase: 'ready',
			source: 'browse',
			coreId: options.coreId,
			revision: null,
			status: null,
			artists: prepared.artists,
			albums: prepared.albums,
			artistBuckets: prepared.artistBuckets,
			albumBuckets: prepared.albumBuckets,
			capabilities: BROWSE_FALLBACK_CAPABILITIES,
			truncated: drained.artists.truncated || drained.albums.truncated,
			error: null
		});
	} catch (error) {
		if (token !== fence) return;
		if (error instanceof ClassicBrowseSupersededError) return;
		internalStore.update((state) => ({
			...state,
			phase: 'error',
			error: error instanceof Error ? error.message : 'Library fallback failed'
		}));
	}
}
