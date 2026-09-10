import {
	normalizeLibraryText
} from '@shared/libraryText';
import type { LibraryRowReference } from '@shared/libraryRootsContracts';

/**
 * The row shapes every library surface renders, and the sort and bucket rules
 * over them.
 *
 * These lived inside `libraryIndexStore.ts`, which was two files fused: a
 * loader for the saved catalog index, and the vocabulary the scope views, the
 * rail, the palette and the drill all speak. The catalog half is deleted
 * (`.agents/plans/library-live-view.md` Slice 4); this half had nothing to do
 * with it and now has a home named for what it is.
 *
 * ONE VOCABULARY, DELIBERATELY. Roon's own roots, a genre drill's live rows
 * and an artist page's albums are three different reads, but they render as
 * the same kind of row, and a second set of entry types would be a second set
 * of renderers to keep in step. What differs between them is what a row
 * carries: a live row carries `liveRef` and nothing else, a drill row carries
 * its position in the drill it came from. Absent stays absent.
 */

export interface LibraryArtistEntry {
	/**
	 * Unique within the snapshot that produced it and worthless outside it —
	 * `live:<token>` for a row from Roon's own roots.
	 */
	id: string;
	name: string;
	/** Precomputed sort key: normalized name, leading article stripped. */
	searchKey: string;
	/**
	 * How many albums Roon credits to this artist, parsed from that row's own
	 * subtitle — the row talking about itself, never a join.
	 *
	 * Unknown is undefined, never 0: 0 is an answer, and rendering absence as 0
	 * tells the reader something the library never said.
	 */
	albumCount?: number;
	/** Opaque artwork key; display data only, never identity. */
	imageKey?: string;
	/**
	 * The live view's opaque reference for this row
	 * (`.agents/plans/library-live-view.md` Slice 1).
	 *
	 * It is the whole identity such a row has, and it is worth exactly one
	 * generation: the server retires it on every refresh, reconnect and lost
	 * session, and a request carrying a retired one is refused. Nothing may
	 * write it down, and no code may compare one to anything but itself.
	 */
	liveRef?: LibraryRowReference;
}

export interface LibraryAlbumEntry {
	id: string;
	title: string;
	artist: string;
	/** Number of exact title/artist versions represented by this group. */
	versionCount?: number;
	/**
	 * Precomputed normalized search/sort key: article-stripped title followed
	 * by artist, so title ordering and artist-name palette matches coexist.
	 */
	searchKey: string;
	/** Opaque artwork key; display data only, never identity. */
	imageKey?: string;
	/**
	 * The live view's opaque reference for this row, on the same terms as
	 * `LibraryArtistEntry.liveRef` above.
	 */
	liveRef?: LibraryRowReference;
}

export interface LetterBucket {
	letter: string;
	start: number;
	count: number;
}

/**
 * Sort key, owner-approved prototype rule: normalize, then strip one
 * leading article (`the `, `a `, `an `) so "The 1975" buckets under `#`
 * and "The Beatles" under `B`, exactly as the approved build-v5 surface
 * renders them (`sortKey = (s) => s.replace(/^(the |a |an )/i, '')`).
 */
export function librarySortKey(text: string): string {
	return normalizeLibraryText(text).replace(/^(the |a |an )/, '');
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

export function computeBuckets(searchKeys: readonly string[]): LetterBucket[] {
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
 * initials survive `normalizeLibraryText`, which lowercases but does not
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

export function sortBySearchKey<T extends { searchKey: string }>(entries: T[]): T[] {
	return entries.sort((a, b) => compareLibrarySearchKeys(a.searchKey, b.searchKey));
}
