import type {
	LetterBucket,
	LibraryAlbumEntry,
	LibraryArtistEntry
} from '$lib/stores/libraryIndexStore';
import {
	compareLibrarySearchKeys,
	librarySortKey
} from '$lib/stores/libraryIndexStore';
import type {
	UnifiedAlbumsSort,
	UnifiedArtistsSort,
	UnifiedGenresSort
} from '$lib/stores/unifiedLibraryPrefsStore';
import type { CatalogPartialDate } from '@shared/timelineCatalogContracts';

/**
 * Pure sorting/menu logic for the Unified Library scope views (plan §4
 * slice 5; release-year sort enabled in Slice 4 of
 * `.agents/plans/native-read-features.md`). Sort menus carry
 * disabled-with-reason entries verbatim; when the native date features are
 * unavailable the release-year entry renders exactly as it did before the
 * native module existed.
 */

export const NO_RELEASE_DATES_REASON =
	'Roon does not expose release dates to controllers, so year ordering would be a guess.';

/**
 * Honest fallback for a restored Recently added page whose native date
 * features have since dropped away (the capability's own reason wins when
 * the index carries one; same rule as the release-year menu).
 */
export const NO_IMPORT_DATES_REASON =
	'Roon does not expose import dates to controllers, so recently-added ordering would be a guess.';

export interface SortMenuEntry {
	readonly id: string;
	readonly label: string;
	/** Present exactly when the entry renders disabled. */
	readonly disabledReason?: string;
}

/** Verbatim from the approved prototype's album sort menu. */
export const NO_GENRE_SORT_REASON = 'Roon caps genre pages; no full album-genre map';

export const ARTIST_SORT_MENU: readonly SortMenuEntry[] = Object.freeze([
	{ id: 'az', label: 'A to Z' },
	{ id: 'za', label: 'Z to A' },
	{ id: 'most-albums', label: 'Most albums' },
	{ id: 'fewest-albums', label: 'Fewest albums' }
]);

export const GENRE_SORT_MENU: readonly SortMenuEntry[] = Object.freeze([
	{ id: 'az', label: 'A to Z' },
	{ id: 'za', label: 'Z to A' },
	{ id: 'most-albums', label: 'Most albums' }
]);

/**
 * The date-feature gate the menus degrade against: the capability state
 * machine's answer, carried on the catalog index. `reason` is the
 * capability's own honest reason when it supplied one; otherwise the menu
 * falls back to `NO_RELEASE_DATES_REASON`, the pre-native presentation.
 */
export interface DateFeatureGate {
	readonly available: boolean;
	readonly reason?: string;
}

const UNAVAILABLE_GATE: DateFeatureGate = Object.freeze({ available: false });

const RELEASE_YEAR_ENABLED_ENTRIES: readonly SortMenuEntry[] = Object.freeze([
	{ id: 'year-asc', label: 'Oldest first' },
	{ id: 'year-desc', label: 'Newest first' }
]);

function releaseYearEntry(gate: DateFeatureGate): SortMenuEntry {
	return {
		id: 'release-year',
		label: 'Release year',
		disabledReason: gate.reason ?? NO_RELEASE_DATES_REASON
	};
}

/** Albums scope menu; the release-year slot mirrors the pre-native layout. */
export function albumSortMenu(gate: DateFeatureGate = UNAVAILABLE_GATE): readonly SortMenuEntry[] {
	return Object.freeze([
		{ id: 'az', label: 'A to Z' },
		{ id: 'za', label: 'Z to A' },
		{ id: 'by-artist', label: 'By artist' },
		{ id: 'shuffle', label: 'Shuffle' },
		...(gate.available ? RELEASE_YEAR_ENABLED_ENTRIES : [releaseYearEntry(gate)]),
		{ id: 'by-genre', label: 'By genre', disabledReason: NO_GENRE_SORT_REASON }
	]);
}

/** Genre drill album menu; pre-native it carried no release-year entry at all. */
export function genreDrillSortMenu(
	gate: DateFeatureGate = UNAVAILABLE_GATE
): readonly SortMenuEntry[] {
	return Object.freeze([
		{ id: 'az', label: 'A to Z' },
		{ id: 'za', label: 'Z to A' },
		{ id: 'by-artist', label: 'By artist' },
		{ id: 'shuffle', label: 'Shuffle' },
		...(gate.available ? RELEASE_YEAR_ENABLED_ENTRIES : [])
	]);
}

/** Artist drill album menu; the release-year slot mirrors the pre-native layout. */
export function artistDrillSortMenu(
	gate: DateFeatureGate = UNAVAILABLE_GATE
): readonly SortMenuEntry[] {
	return Object.freeze([
		{ id: 'az', label: 'A to Z' },
		{ id: 'za', label: 'Z to A' },
		{ id: 'shuffle', label: 'Shuffle' },
		...(gate.available ? RELEASE_YEAR_ENABLED_ENTRIES : [releaseYearEntry(gate)])
	]);
}

/** Chronological album orders; the A–Z rail hides for exactly these. */
export function isChronologicalAlbumSort(sort: string): boolean {
	return sort === 'year-asc' || sort === 'year-desc';
}

/** Deterministic 32-bit PRNG so a persisted seed replays one shuffle. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function seededShuffle<T>(entries: readonly T[], seed: number): T[] {
	const next = mulberry32(seed);
	const shuffled = [...entries];
	for (let i = shuffled.length - 1; i > 0; i -= 1) {
		const j = Math.floor(next() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled;
}

/** Index entries arrive A–Z presorted; every sorter returns a new array. */
export function sortArtists(
	entries: readonly LibraryArtistEntry[],
	sort: UnifiedArtistsSort
): LibraryArtistEntry[] {
	switch (sort) {
		case 'az':
			return [...entries];
		case 'za':
			return [...entries].reverse();
		case 'most-albums':
			return [...entries].sort((a, b) => (b.albumCount ?? 0) - (a.albumCount ?? 0));
		case 'fewest-albums':
			return [...entries].sort((a, b) => (a.albumCount ?? 0) - (b.albumCount ?? 0));
	}
}

/**
 * Release-year sort key (Slice 4 pinned semantics): an album's original
 * release date, falling back to its release date; year-only dates (month/day
 * 0) order within their year; undated albums last in BOTH directions; ties
 * break by the same normalized title key the alphabetical sorts use
 * (ascending in both directions, so the tie-break never depends on input
 * order).
 *
 * Described in product terms rather than by the extended layer's own field
 * spellings, which boundary §4 denylists — the note on those rules says
 * retained comparators may pin the semantics but never the protocol names.
 */
function releaseDateOf(entry: LibraryAlbumEntry): CatalogPartialDate | undefined {
	return entry.originalReleaseDate ?? entry.releaseDate;
}

function compareReleaseYear(
	left: LibraryAlbumEntry,
	right: LibraryAlbumEntry,
	direction: 1 | -1
): number {
	const leftDate = releaseDateOf(left);
	const rightDate = releaseDateOf(right);
	if (leftDate === undefined && rightDate === undefined) {
		return compareLibrarySearchKeys(left.searchKey, right.searchKey);
	}
	if (leftDate === undefined) return 1;
	if (rightDate === undefined) return -1;
	const diff =
		leftDate.year - rightDate.year ||
		leftDate.month - rightDate.month ||
		leftDate.day - rightDate.day;
	if (diff !== 0) return direction * diff;
	return compareLibrarySearchKeys(left.searchKey, right.searchKey);
}

/**
 * Recently-added ordering (Slice 5 pinned semantics): library-added timestamp
 * descending (most recently added first); albums without one go last; ties —
 * including the all-undated tail — break by the same normalized title key the
 * alphabetical sorts use, so the order never depends on input order. The
 * timestamps are canonical ISO (`YYYY-MM-DDTHH:MM:SS.mmmZ`, pinned by the
 * index contract), so code-point comparison is chronological comparison.
 *
 * Named for the product concept, not the wire key it reads: boundary §4
 * denylists the extended layer's spelling of that field, and an exported
 * function embedding the spelling would put it in every caller too.
 */
export function sortAlbumsByRecentlyAdded(
	entries: readonly LibraryAlbumEntry[]
): LibraryAlbumEntry[] {
	return [...entries].sort((left, right) => {
		if (left.importDate === undefined && right.importDate === undefined) {
			return compareLibrarySearchKeys(left.searchKey, right.searchKey);
		}
		if (left.importDate === undefined) return 1;
		if (right.importDate === undefined) return -1;
		if (left.importDate !== right.importDate) {
			return left.importDate < right.importDate ? 1 : -1;
		}
		return compareLibrarySearchKeys(left.searchKey, right.searchKey);
	});
}

export function sortAlbums(
	entries: readonly LibraryAlbumEntry[],
	sort: UnifiedAlbumsSort,
	shuffleSeed: number
): LibraryAlbumEntry[] {
	switch (sort) {
		case 'az':
			return [...entries];
		case 'za':
			return [...entries].reverse();
		case 'by-artist':
			return [...entries].sort((a, b) => {
				return (
					compareLibrarySearchKeys(librarySortKey(a.artist), librarySortKey(b.artist)) ||
					compareLibrarySearchKeys(a.searchKey, b.searchKey)
				);
			});
		case 'year-asc':
			return [...entries].sort((a, b) => compareReleaseYear(a, b, 1));
		case 'year-desc':
			return [...entries].sort((a, b) => compareReleaseYear(a, b, -1));
		case 'shuffle':
			return seededShuffle(entries, shuffleSeed);
	}
}

export interface NamedCountEntry {
	readonly label: string;
	readonly albumCount: number;
}

const namedCountSortKey = (label: string): string =>
	label.replace(/^(the |a |an )/i, '').toLowerCase();

const namedCountLetter = (label: string): string => {
	const first = namedCountSortKey(label).charAt(0).toUpperCase();
	return /[A-Z]/.test(first) ? first : '#';
};

export function sortNamedCounts<T extends NamedCountEntry>(
	entries: readonly T[],
	sort: UnifiedGenresSort
): T[] {
	const byLabel = (a: T, b: T): number =>
		namedCountSortKey(a.label).localeCompare(namedCountSortKey(b.label));
	switch (sort) {
		case 'az':
			return [...entries].sort(byLabel);
		case 'za':
			return [...entries].sort((a, b) => byLabel(b, a));
		case 'most-albums':
			return [...entries].sort((a, b) => b.albumCount - a.albumCount || byLabel(a, b));
	}
}

export function namedCountBuckets<T extends NamedCountEntry>(
	entries: readonly T[]
): LetterBucket[] {
	const buckets: LetterBucket[] = [];
	for (const [index, entry] of sortNamedCounts(entries, 'az').entries()) {
		const letter = namedCountLetter(entry.label);
		const last = buckets[buckets.length - 1];
		if (last?.letter === letter) last.count += 1;
		else buckets.push({ letter, start: index, count: 1 });
	}
	return buckets;
}

/**
 * ZA rail reversal: mirror A–Z buckets onto the reversed list so every
 * letter still addresses exactly its own entries (plan §4 slice 5).
 */
export function reverseBuckets(
	buckets: readonly LetterBucket[],
	total: number
): LetterBucket[] {
	return [...buckets]
		.reverse()
		.map((bucket) => ({
			letter: bucket.letter,
			start: total - bucket.start - bucket.count,
			count: bucket.count
		}));
}
