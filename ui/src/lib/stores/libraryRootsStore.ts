import { get, writable } from 'svelte/store';
import {
	parseRoonArtistAlbumCount,
	type LibraryInvalidationReason,
	type LibraryRootRow,
	type LibraryRootsResponse,
	type LibraryRootsUnavailableReason,
	type LibraryRowReference,
	type LibrarySessionRetiredEvent
} from '@shared/libraryRootsContracts';
import { normalizeCatalogText } from '@shared/catalogContracts';
import { fetchLibraryRoots, refreshLibraryRoots } from '../api/client';
import {
	compareLibrarySearchKeys,
	computeBuckets,
	librarySortKey,
	type LetterBucket,
	type LibraryAlbumEntry,
	type LibraryArtistEntry
} from '../libraryEntries';

/**
 * Roon's own two lists, held in the browser exactly as the server holds them.
 *
 * `.agents/plans/library-live-view.md` Slice 1. This store is the client half
 * of the live view: it fetches `GET /api/library/roots`, keeps the rows for
 * display and for filtering, and holds the generation those rows belong to.
 *
 * WHAT IT DOES NOT DO, and must never learn to do:
 *
 * - It does not merge, reconcile or repair. There is one source, and rows are
 *   rendered as Roon sent them.
 * - It does not compare a row against any other surface's text. The album
 *   count on an artist row comes from that row's own subtitle, which is Roon
 *   talking about that artist.
 * - It does not remember anything across a generation. When the generation the
 *   server holds is not the one this store holds, every row here is replaced
 *   wholesale rather than diffed, because a row is only meaningful together
 *   with the reference that names it.
 *
 * WHY ENTRIES LOOK LIKE THE INDEX STORE'S. The scope views, the rail and the
 * palette already speak `LibraryArtistEntry` and `LibraryAlbumEntry`, and a
 * second vocabulary for the same rows would be a second set of renderers to
 * keep in step. What differs is what a live entry carries: `liveRef` instead
 * of a catalog id, and no catalog identity at all — which is the honest state
 * of affairs, since Roon's row IS the identity and it dies with the session.
 */

/** Reasons the surface has no rows, in the server's own vocabulary. */
export type LibraryRootsUnavailable = LibraryRootsUnavailableReason;

export interface LibraryRootsState {
	phase: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
	/** The generation every reference in this state belongs to. */
	generation: string | null;
	coreId: string | null;
	/** When the server read these roots, ISO-8601. */
	readAt: string | null;
	artists: LibraryArtistEntry[];
	albums: LibraryAlbumEntry[];
	/**
	 * Roon's own rows, kept beside the display entries rather than derived
	 * back out of them.
	 *
	 * An address is re-walked against Roon's exact text, and an entry is a
	 * rendering of that text for a list — the artist count is parsed out of the
	 * subtitle, the album credit is folded into a sort key. Reconstructing the
	 * row from the entry would mean deciding, in a second place, what Roon had
	 * said. These are the rows as they arrived, in Roon's own order.
	 */
	artistRows: readonly LibraryRootRow[];
	albumRows: readonly LibraryRootRow[];
	artistBuckets: LetterBucket[];
	albumBuckets: LetterBucket[];
	/** Roon's own count for each root, which the rows must match. */
	artistCount: number | null;
	albumCount: number | null;
	unavailable: LibraryRootsUnavailable | null;
	error: string | null;
	retirementRevision: number;
	retirementReason: LibraryInvalidationReason | null;
}

const IDLE_STATE: LibraryRootsState = {
	phase: 'idle',
	generation: null,
	coreId: null,
	readAt: null,
	artists: [],
	albums: [],
	artistRows: [],
	albumRows: [],
	artistBuckets: [],
	albumBuckets: [],
	artistCount: null,
	albumCount: null,
	unavailable: null,
	error: null,
	retirementRevision: 0,
	retirementReason: null
};

const internalStore = writable<LibraryRootsState>(IDLE_STATE);

export const libraryRootsStore = {
	subscribe: internalStore.subscribe
};

/** Monotonic fence. Any await that crosses a bump drops its result. */
let fence = 0;
const RETIRED_GENERATION_LIMIT = 256;
const retiredGenerations = new Set<string>();
interface RootsRequest {
	token: number;
	coreId: string;
	done: Promise<void>;
	recoveryRevision?: number;
}
const pendingRequests = new Set<RootsRequest>();

/** Register before invoking fetch: a retirement may arrive before its response. */
async function ownRootsRequest(
	coreId: string,
	run: (token: number) => Promise<void>,
	recoveryRevision?: number
): Promise<void> {
	let finish!: () => void;
	const request: RootsRequest = {
		token: fence,
		coreId,
		recoveryRevision,
		done: new Promise<void>((resolve) => { finish = resolve; })
	};
	pendingRequests.add(request);
	try {
		await run(request.token);
	} finally {
		pendingRequests.delete(request);
		finish();
	}
}

function emptyResult(coreId: string): LibraryRootsState {
	const held = get(internalStore);
	return {
		...IDLE_STATE,
		coreId,
		retirementRevision: held.retirementRevision,
		retirementReason: held.retirementReason
	};
}

function rememberRetiredGeneration(generation: string): void {
	retiredGenerations.delete(generation);
	retiredGenerations.add(generation);
	while (retiredGenerations.size > RETIRED_GENERATION_LIMIT) {
		const oldest = retiredGenerations.values().next().value;
		if (oldest === undefined) return;
		retiredGenerations.delete(oldest);
	}
}

export function resetLibraryRoots(): void {
	fence += 1;
	pendingRequests.clear();
	retiredGenerations.clear();
	internalStore.set(IDLE_STATE);
}

export function retireLibraryGeneration(event: LibrarySessionRetiredEvent): boolean {
	if (event.retired === null) return false;
	const held = get(internalStore);
	if (held.coreId !== event.coreId || held.generation !== event.retired) return false;
	rememberRetiredGeneration(event.retired);
	internalStore.set({
		...IDLE_STATE,
		coreId: event.coreId,
		retirementRevision: held.retirementRevision + 1,
		retirementReason: event.reason
	});
	return true;
}

/** The generation this store currently holds, for a caller that needs to ask. */
export function heldLibraryGeneration(): string | null {
	return get(internalStore).generation;
}

/**
 * One live Artists row as an entry.
 *
 * `id` is the reference's own token, prefixed so it cannot be mistaken for a
 * catalog id by anything that still handles both. It is unique within a
 * snapshot and worthless outside it, which is exactly the lifetime a list key
 * should have.
 */
export function liveArtistEntry(row: LibraryRootRow): LibraryArtistEntry {
	const albumCount = parseRoonArtistAlbumCount(row.subtitle);
	return {
		id: `live:${row.ref.token}`,
		name: row.title,
		searchKey: librarySortKey(row.title),
		// Absent, never 0: 0 is an answer, and a row that said nothing has not
		// given one.
		...(albumCount !== null ? { albumCount } : {}),
		...(row.imageKey !== undefined ? { imageKey: row.imageKey } : {}),
		liveRef: row.ref
	};
}

/**
 * One live Albums row as an entry.
 *
 * The credit is the row's own subtitle. Nothing looks it up anywhere, and no
 * artist entry is consulted: two rows reading the same credit are two rows
 * that render the same text, which is all this store is entitled to say.
 */
export function liveAlbumEntry(row: LibraryRootRow): LibraryAlbumEntry {
	const artist = row.subtitle ?? '';
	return {
		id: `live:${row.ref.token}`,
		title: row.title,
		artist,
		searchKey: `${librarySortKey(row.title)} ${normalizeCatalogText(artist)}`,
		...(row.imageKey !== undefined ? { imageKey: row.imageKey } : {}),
		liveRef: row.ref
	};
}

/**
 * Type-to-filter, over the rows already in memory.
 *
 * Substring, over the normalized sort key and over the raw text, which is what
 * the palette already does for the index: the sort key finds "bjork" in
 * "Björk" and the raw comparison finds what normalization folded away. No
 * scoring, no fuzziness, no ranking — a filter that guesses is a filter that
 * hides the row somebody typed the name of.
 */
export function filterLiveEntries<T extends { searchKey: string }>(
	entries: readonly T[],
	query: string,
	text: (entry: T) => string
): T[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [...entries];
	const normalized = normalizeCatalogText(trimmed);
	const lowered = trimmed.toLowerCase();
	return entries.filter(
		(entry) => entry.searchKey.includes(normalized) || text(entry).toLowerCase().includes(lowered)
	);
}

function prepare(roots: LibraryRootsResponse & { kind: 'snapshot' }): LibraryRootsState {
	// Roon's own order is kept for the rows themselves; the sort key is what
	// the A-Z rail and the letter buckets run on, and it is computed per row
	// from that row's own title.
	const artists = roots.artists.rows
		.map(liveArtistEntry)
		.sort((left, right) => compareLibrarySearchKeys(left.searchKey, right.searchKey));
	const albums = roots.albums.rows
		.map(liveAlbumEntry)
		.sort((left, right) => compareLibrarySearchKeys(left.searchKey, right.searchKey));
	return {
		phase: 'ready',
		generation: roots.generation,
		coreId: roots.coreId,
		readAt: roots.readAt,
		artists,
		albums,
		artistRows: roots.artists.rows,
		albumRows: roots.albums.rows,
		artistBuckets: computeBuckets(artists.map((entry) => entry.searchKey)),
		albumBuckets: computeBuckets(albums.map((entry) => entry.searchKey)),
		artistCount: roots.artists.count,
		albumCount: roots.albums.count,
		unavailable: null,
		error: null,
		retirementRevision: 0,
		retirementReason: null
	};
}

export interface LoadLibraryRootsOptions {
	/** The paired Core the caller is loading for; another Core's rows are dropped. */
	coreId: string;
	/** Passive recovery belongs to this exact retirement and visible lifecycle. */
	retirement?: {
		revision: number;
		isCurrent: () => boolean;
	};
}

async function recoverRetiredRoots(
	fetchFn: typeof fetch,
	options: LoadLibraryRootsOptions & { retirement: NonNullable<LoadLibraryRootsOptions['retirement']> }
): Promise<void> {
	const token = fence;
	const isCurrent = () => {
		const held = get(internalStore);
		return token === fence && options.retirement.isCurrent() &&
			held.coreId === options.coreId &&
			held.retirementRevision === options.retirement.revision;
	};
	// Only this browser's actual requests can publish into this store. Waiting
	// also coalesces concurrent recoveries; recheck the set after every await.
	let replacementAttempted = false;
	while (isCurrent()) {
		const pending = [...pendingRequests].filter(
			(request) => request.token === token && request.coreId === options.coreId
		);
		if (pending.length === 0) break;
		replacementAttempted ||= pending.some(
			(request) => request.recoveryRevision === options.retirement.revision
		);
		await Promise.all(pending.map((request) => request.done));
	}
	if (!isCurrent() || replacementAttempted || get(internalStore).generation !== null) return;
	// One replacement read, including when an owned response failed or was
	// itself retired. No polling or recursive retry after this read fails.
	await readLibraryRoots(fetchFn, options, options.retirement.revision);
}

async function apply(
	token: number,
	result: Awaited<ReturnType<typeof fetchLibraryRoots>>,
	options: LoadLibraryRootsOptions
): Promise<void> {
	if (token !== fence) return;
	if (result.kind === 'unavailable') {
		// Not an error, and not an empty library: a state with its own sentence.
		internalStore.set({
			...emptyResult(options.coreId),
			phase: 'unavailable',
			unavailable: result.unavailable.reason,
			error: result.unavailable.message
		});
		return;
	}
	const roots = result.roots;
	if (retiredGenerations.has(roots.generation)) return;
	if (roots.coreId !== options.coreId) {
		// An old Core's payload arriving after a re-pair is never rendered.
		internalStore.set({
			...emptyResult(options.coreId),
			phase: 'error',
			error: 'Library roots arrived for a different Core'
		});
		return;
	}
	if (roots.kind === 'current') {
		// The generation this store holds is still the server's. Nothing to do,
		// and deliberately nothing rebuilt: the rows on screen are the rows the
		// server just confirmed.
		internalStore.update((state) =>
			state.generation === roots.generation ? state : { ...state }
		);
		return;
	}
	const held = get(internalStore);
	internalStore.set({
		...prepare(roots),
		retirementRevision: held.retirementRevision,
		retirementReason: held.retirementReason
	});
}

/**
 * Load the roots, or confirm the ones already held.
 *
 * A store that already holds a generation sends it, which turns this into the
 * cheap check the server answers from Roon's own root counts. That is the
 * plan's scope-activation trigger, and it is why coming back to the Library
 * costs a quarter of a second rather than a second and a half.
 */
export async function loadLibraryRoots(
	fetchFn: typeof fetch,
	options: LoadLibraryRootsOptions
): Promise<void> {
	if (options.retirement !== undefined) {
		return recoverRetiredRoots(fetchFn, { ...options, retirement: options.retirement });
	}
	return readLibraryRoots(fetchFn, options);
}

async function readLibraryRoots(
	fetchFn: typeof fetch,
	options: LoadLibraryRootsOptions,
	recoveryRevision?: number
): Promise<void> {
	return ownRootsRequest(options.coreId, async (token) => {
		const held = get(internalStore);
		if (held.phase !== 'ready') {
			internalStore.update((state) => ({ ...state, phase: 'loading', error: null }));
		}
		try {
			const result = await fetchLibraryRoots(
				fetchFn,
				held.phase === 'ready' && held.generation !== null ? held.generation : undefined
			);
			await apply(token, result, options);
		} catch (error) {
			if (token !== fence) return;
			internalStore.set({
				...emptyResult(options.coreId),
				phase: 'error',
				error: error instanceof Error ? error.message : 'Library roots failed'
			});
		}
	}, recoveryRevision);
}

/** The reader asked for fresh truth: re-read, retiring every held reference. */
export async function refreshLibraryRootsNow(
	fetchFn: typeof fetch,
	options: LoadLibraryRootsOptions
): Promise<void> {
	return ownRootsRequest(options.coreId, async (token) => {
		internalStore.update((state) => ({ ...state, phase: 'loading', error: null }));
		try {
			await apply(token, await refreshLibraryRoots(fetchFn), options);
		} catch (error) {
			if (token !== fence) return;
			internalStore.set({
				...emptyResult(options.coreId),
				phase: 'error',
				error: error instanceof Error ? error.message : 'Library refresh failed'
			});
		}
	});
}
