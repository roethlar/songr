/**
 * Split a Roon artist credit string into individual artists.
 *
 * Roon's public API delivers multi-artist credits as ONE string with
 * names joined by " / " — e.g. "Lio-Marcus Mendel / Leland Orlov, Jr.
 * / Hamilton Cast Ensemble" (live capture 2026-06-10). Native Roon
 * clients break the names out via richer per-artist metadata that the
 * extension API doesn't expose, so splitting the display string is
 * the best we can do.
 *
 * Whitespace is required on BOTH sides of the slash so band names
 * containing a bare slash ("AC/DC") don't split. Commas are NOT
 * separators ("Leland Orlov, Jr.").
 */
export function splitArtists(value: string | undefined | null): string[] {
	if (!value) return [];
	return value
		.split(/\s+\/\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Split a browse-row subtitle into individually-clickable segments.
 * Roon joins subtitle fields with " · " ("Artist · Album"), and the
 * artist field itself may carry multiple names joined by " / ".
 * "A / B · Album" → ["A", "B", "Album"].
 *
 * Caveat: a field whose own text contains " / " (rare album titles)
 * also splits — each piece is still a usable search query, so the
 * failure mode is a clumsier link, not a broken one.
 */
export function splitSubtitleSegments(subtitle: string | undefined | null): string[] {
	if (!subtitle) return [];
	return subtitle
		.split(/\s*·\s*/)
		.flatMap((field) => splitArtists(field))
		.filter((s) => s.length > 0);
}
