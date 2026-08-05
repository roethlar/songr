import type { BrowseResult } from '@shared/types';

export type AlbumChipKind = 'year' | 'format';

export interface AlbumChip {
	kind: AlbumChipKind;
	label: string;
}

// Order matters — longer / more specific tags first ("MQA Studio"
// wins over "MQA", "Hi-Res" doesn't get split). The list is
// intentionally narrow: widely-used Roon-reported quality / format
// markers. Add cautiously — false positives leak album-title
// substrings into chips.
const FORMAT_TAGS = [
	'MQA Studio',
	'MQA',
	'Hi-Res',
	'Hi Res',
	'HiRes',
	'DSD256',
	'DSD128',
	'DSD64',
	'DSD',
	'FLAC',
	'ALAC',
	'WAV',
	'MP3',
	'AAC'
];

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Range of a matched token within the original subtitle. Used by
 * `extractArtistFromSubtitle` to splice out the token + its
 * adjacent separator without touching the rest.
 */
interface TokenSpan {
	start: number;
	end: number;
	label: string;
}

/**
 * Find a year (19xx/20xx) that is structurally a metadata token —
 * preceded by a "real" metadata separator (`·`, `/`, `,`, `|`) or
 * the string start, and followed by one of those OR the string end.
 * Plain whitespace alone is NOT enough on the leading side, so
 * artist names like "The 1975" don't misfire.
 *
 * Trace examples:
 * - "The 1975" → no leading metadata sep before "1975" → null.
 * - "The 1975 · 2022 · FLAC" → "1975" preceded by space only
 *   (rejected); "2022" preceded by ` · ` (accepted) → 2022.
 * - "Tilda Arlen · 1994" → "1994" preceded by ` · `, followed by $.
 * - "1994 · Tilda Arlen" → "1994" preceded by ^, followed by ` · `.
 * - "1994" alone → preceded by ^, followed by $.
 */
function findYearSpan(subtitle: string): TokenSpan | null {
	// Two valid contexts:
	//   A) year preceded by a real metadata separator (`·`, `/`,
	//      `,`, `|`) with optional whitespace. Trailing side can be
	//      another separator or string end.
	//   B) year at string start followed by a real metadata
	//      separator. Trailing real-sep required so a lone "1994"
	//      subtitle doesn't chip.
	// Both rules require at least one real-sep adjacent. Plain
	// whitespace alone never qualifies — that's the "The 1975"
	// guard. The format-tag separator set deliberately omits space.
	const realSepClass = '[·/,|]';
	const reA = new RegExp(`(${realSepClass})(\\s*)((19|20)\\d{2})(?=\\s*(?:${realSepClass}|$))`);
	const reB = new RegExp(`^((19|20)\\d{2})(?=\\s*${realSepClass})`);

	const a = reA.exec(subtitle);
	const b = reB.exec(subtitle);

	let chosen: { start: number; end: number; label: string } | null = null;

	if (a && a.index !== undefined) {
		const lead = a[1].length + a[2].length;
		const start = a.index + lead;
		const year = a[3];
		chosen = { start, end: start + year.length, label: year };
	}
	if (b && b.index !== undefined) {
		const year = b[1];
		const bSpan = { start: 0, end: year.length, label: year };
		// Pattern B matches at position 0 — choose it only if pattern A
		// didn't already find an earlier-or-equal match. Pattern A at
		// position 0 isn't possible (it requires a leading sep), so
		// pattern B always wins if both match and B is "earlier" — but
		// in practice they describe different positions, and we want
		// the FIRST match (so if A's match is later than B's, B wins).
		if (!chosen || bSpan.start < chosen.start) chosen = bSpan;
	}

	return chosen;
}

/**
 * Find the first format tag (longest-first) bounded by separators
 * or string edges.
 */
function findFormatSpan(subtitle: string): TokenSpan | null {
	for (const tag of FORMAT_TAGS) {
		const re = new RegExp(
			`(^|[^A-Za-z0-9])${escapeRe(tag)}($|[^A-Za-z0-9])`,
			'i'
		);
		const m = subtitle.match(re);
		if (!m || m.index === undefined) continue;
		const leadingBoundaryLen = m[1].length;
		const tagStart = m.index + leadingBoundaryLen;
		const tagEnd = tagStart + tag.length;
		return { start: tagStart, end: tagEnd, label: tag };
	}
	return null;
}

/**
 * Heuristic extraction of album-page chips (year, format) from the
 * Roon-supplied subtitle. Fails closed — returns empty array when
 * nothing recognizable is found.
 *
 * Per UX overhaul plan (PR2 album page polish): "best-effort
 * metadata only; hide unavailable chips." Patterns are narrow —
 * years require a leading separator (so artist names like
 * "The 1975" don't misfire), format tags use boundary regex (so
 * "Wavves" doesn't trigger WAV).
 */
export function extractAlbumChips(subtitle: string | undefined): AlbumChip[] {
	if (!subtitle) return [];
	const chips: AlbumChip[] = [];

	const year = findYearSpan(subtitle);
	if (year) chips.push({ kind: 'year', label: year.label });

	const format = findFormatSpan(subtitle);
	if (format) chips.push({ kind: 'format', label: format.label });

	return chips;
}

/**
 * Strip year and format tokens (plus one adjacent separator each)
 * from a subtitle, leaving the artist portion intact.
 *
 * CRITICAL: preserves internal artist punctuation. The previous
 * version collapsed every separator in the result, corrupting
 * names like "AC/DC" → "AC DC" and "Jay-Z" → "Jay Z". This
 * version splices out only the matched span + ONE adjacent
 * separator (preferring trailing to keep the "Artist · year ·
 * format" layout clean), leaving every other character of the
 * original string untouched.
 *
 * Used by the album-header "Search for this artist" link.
 */
export function extractArtistFromSubtitle(subtitle: string | undefined): string {
	if (!subtitle) return '';

	const yearSpan = findYearSpan(subtitle);
	const formatSpan = findFormatSpan(subtitle);
	const spans: TokenSpan[] = [];
	if (yearSpan) spans.push(yearSpan);
	if (formatSpan) spans.push(formatSpan);
	if (spans.length === 0) {
		return subtitle.trim();
	}
	// Process the later span first so removing the earlier one
	// doesn't shift the indices of any subsequent span.
	spans.sort((a, b) => b.start - a.start);

	let working = subtitle;
	const isSeparator = (ch: string | undefined): boolean =>
		ch !== undefined && /[^A-Za-z0-9]/.test(ch);

	for (const span of spans) {
		let start = span.start;
		let end = span.end;
		const trailing = working[end];
		const leading = working[start - 1];
		// Prefer trailing — "Artist · year · format" places separators
		// AFTER each non-last token. If at string end, take the
		// leading separator instead.
		if (end < working.length && isSeparator(trailing)) {
			end += 1;
		} else if (start > 0 && isSeparator(leading)) {
			start -= 1;
		}
		working = working.slice(0, start) + working.slice(end);
	}

	// Trim outer whitespace and outer separator runs only — preserve
	// internal artist punctuation like "AC/DC", "Jay-Z", "GZA/Genius".
	return working.replace(/^[\s/·,|\-]+|[\s/·,|\-]+$/g, '').trim();
}

/**
 * True when the current browse result looks like an album page —
 * a content-level (level 2+) listing whose rows are track plays
 * AND which has a non-empty subtitle (real album pages carry the
 * artist as subtitle).
 *
 * `inferredAllTracks` is the layout's signal that the track-list
 * heuristic kicked in WITHOUT any `itemType=track` row — i.e. the
 * page is something like `Library/Tracks` or playlist contents,
 * not a real album. Excluded so stray year-shaped tokens in a
 * non-album subtitle don't render as chips.
 */
export function isAlbumPage(
	current: BrowseResult | null,
	isTrackList: boolean,
	inferredAllTracks = false
): boolean {
	if (!current) return false;
	if (!isTrackList) return false;
	if (inferredAllTracks) return false;
	if ((current.level ?? 0) < 2) return false;
	if (!current.subtitle || current.subtitle.trim().length === 0) return false;
	return true;
}
