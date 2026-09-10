import type {
	LetterBucket,
	LibraryAlbumEntry,
	LibraryArtistEntry
} from '$lib/libraryEntries';
import {
	compareLibrarySearchKeys,
	librarySortKey
} from '$lib/libraryEntries';
import type {
	UnifiedAlbumsSort,
	UnifiedArtistsSort,
	UnifiedGenresSort
} from '$lib/stores/unifiedLibraryPrefsStore';

/** Sorting for the live Library; saved unsupported date orders fall back to A–Z. */

export const NO_RELEASE_DATES_REASON =
	'Roon does not expose release dates to controllers, so year ordering would be a guess.';

/** A restored Recently added address cannot fabricate unavailable import dates. */
export const NO_IMPORT_DATES_REASON =
	'Roon does not expose import dates to controllers, so recently-added ordering would be a guess.';

export interface SortMenuEntry {
	readonly id: string;
	readonly label: string;
	/** Present exactly when the entry renders disabled. */
	readonly disabledReason?: string;
}

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

/** Public album rows provide names and credits, without dates or a complete genre map. */
export function liveAlbumSortMenu(): readonly SortMenuEntry[] {
	return Object.freeze([
		{ id: 'az', label: 'A to Z' },
		{ id: 'za', label: 'Z to A' },
		{ id: 'by-artist', label: 'By artist' },
		{ id: 'shuffle', label: 'Shuffle' }
	]);
}

/** The genre drill offers only orderings supported by its current rows. */
export function genreDrillSortMenu(): readonly SortMenuEntry[] {
	return Object.freeze([
		{ id: 'az', label: 'A to Z' },
		{ id: 'za', label: 'Z to A' },
		{ id: 'by-artist', label: 'By artist' },
		{ id: 'shuffle', label: 'Shuffle' }
	]);
}

/**
 * Artist drill album menu.
 *
 * No release-year entry either, and for the same reason (Slice 8d). This page
 * now renders the walk's stored answer, and a stored walk entry carries the
 * row's title, credit and artwork hint — no date. Both surfaces lose the sort
 * together, because fixing one and leaving the other is worse than either.
 */
export function artistDrillSortMenu(): readonly SortMenuEntry[] {
	return Object.freeze([
		{ id: 'az', label: 'A to Z' },
		{ id: 'za', label: 'Z to A' },
		{ id: 'shuffle', label: 'Shuffle' }
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
		case 'year-desc':
			// Migrate saved date sorts to the supported alphabetical order.
			return [...entries];
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
