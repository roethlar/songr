/**
 * Minimal count-based pluralization helper. No i18n framework — this
 * repo has none and none is warranted for a two-form English noun
 * (plan §5 non-goal). Callers supply both forms so casing differences
 * between call sites (e.g. "ALBUM"/"ALBUMS" vs "album"/"albums") stay
 * each site's own concern; this helper only picks which form applies.
 */
export function pluralize(count: number, singular: string, plural: string): string {
	return count === 1 ? singular : plural;
}
