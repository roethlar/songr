/**
 * Leading track-number prefixes Roon puts on browse track-list rows:
 *
 *   "3. Cornflake Girl"           — single-disc "N. "
 *   "1-22 Dear Theodosia"         — multi-disc "D-T " (no dot)
 *   "1-22. Dear Theodosia"        — multi-disc dotted variant
 *
 * A bare "N " (digits + space, no dot, no dash) is NOT treated as a
 * prefix — titles legitimately start with numbers ("1979 (Remastered)",
 * "99 Luftballons"). The dash form requires exactly two number groups
 * followed by whitespace, so "1-800-273-8255" and "1-2-3 …" survive;
 * a real title like "24-7 Lover" is a known (rare) false positive.
 */
const TRACK_PREFIX = /^(?:\d+(?:-\d+)?\.\s*|\d+-\d+\s+)/;

/**
 * Strip the leading track-number prefix from a Roon track title so it
 * matches the bare title Roon emits in now-playing events and search
 * results. The browse track list uses "3. Cornflake Girl" (or
 * "1-22 Dear Theodosia" on multi-disc albums) / now-playing reports
 * "Cornflake Girl".
 */
export function trackTitle(title: string): string {
	return title.replace(TRACK_PREFIX, '');
}

/**
 * Extract the leading track number from a title like "3. Song Name" →
 * "3", or "1-22 Song Name" → "1-22" on multi-disc albums. Falls back
 * to the row index (1-based) when no prefix is present.
 */
export function trackNum(title: string, index: number): string {
	const m = title.match(/^(\d+(?:-\d+)?)\./) ?? title.match(/^(\d+-\d+)\s/);
	return m?.[1] ?? String(index + 1);
}

/**
 * True when a track title begins with its own leading ordinal ("1. 'Round
 * Midnight") — Roon's browse display convention. The album sheet renders
 * Roon's title byte-for-byte and suppresses its own derived row index on
 * pages where every title carries one: Roon's ordinal is authoritative and
 * the derived index is the wrong thing to preserve (owner ruling;
 * release-readiness plan slice 1). Deliberately narrower than TRACK_PREFIX
 * above: only the dotted single-number form suppresses the index.
 */
export function trackTitleCarriesOrdinal(title: string): boolean {
	return /^\s*\d+\.\s/.test(title);
}
