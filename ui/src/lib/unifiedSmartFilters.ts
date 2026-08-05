/**
 * Smart-filter parser for the unified library palette (plan §3.2, slice 7).
 *
 * Ported from the owner-approved prototype (`build-v5.mjs` `parseSmart`)
 * together with its unit table. Count filters evaluate live against index
 * album counts; whether they may run at all is gated by the caller on
 * complete artist bindings (`LibraryCapabilities.countFilters`), because a
 * single unbound album could belong to any artist and every count would be
 * a guess. Year expressions always parse and always render disabled:
 * Roon's public API exposes no release dates, and inventing them is
 * prohibited (`NO_RELEASE_DATES_REASON`).
 */
import { UNIFIED_FILTER_TEXT_MAX_LENGTH } from '$lib/libraryPageState';
import { NO_RELEASE_DATES_REASON } from '$lib/unifiedLibrarySorts';

export interface SmartCountFilter {
	readonly kind: 'count';
	/** Human label, e.g. "Artists with more than 30 albums". */
	readonly label: string;
	/** Canonical filter text as persisted in unified page state. */
	readonly text: string;
	readonly test: (albumCount: number) => boolean;
}

export interface SmartYearFilter {
	readonly kind: 'year';
	readonly label: string;
	/** Honest disable reason — release dates do not exist controller-side. */
	readonly reason: string;
}

export type SmartFilter = SmartCountFilter | SmartYearFilter;

const COUNT_COMPARATOR_WORDS: Readonly<Record<string, string>> = {
	'>': 'more than ',
	'>=': 'at least ',
	'<': 'fewer than ',
	'<=': 'at most '
};

/**
 * Parses free palette text into smart filters. Returns at most one count
 * filter and at most one year filter (prototype parity). Unparseable text
 * returns [] — the palette then treats the text as a plain search query.
 */
export function parseSmartFilters(raw: string): SmartFilter[] {
	if (raw.length > UNIFIED_FILTER_TEXT_MAX_LENGTH) return [];
	const q = raw.trim().toLowerCase().replace(/\s+/g, ' ');
	if (!q) return [];
	const text = raw.trim().replace(/\s+/g, ' ');
	const out: SmartFilter[] = [];
	let m: RegExpMatchArray | null = null;
	if (/^(only )?(one|1) album( by)?s?$/.test(q) || q === 'one') {
		out.push({
			kind: 'count',
			label: 'Artists with exactly one album',
			text,
			test: (c) => c === 1
		});
	} else if ((m = q.match(/^([<>]=?) ?(\d+) albums?$/))) {
		const op = m[1];
		const n = Number(m[2]);
		out.push({
			kind: 'count',
			label: `Artists with ${COUNT_COMPARATOR_WORDS[op]}${n} albums`,
			text,
			test: (c) => (op === '>' ? c > n : op === '>=' ? c >= n : op === '<' ? c < n : c <= n)
		});
	} else if ((m = q.match(/^(\d+)\+ ?albums?$/))) {
		const n = Number(m[1]);
		out.push({
			kind: 'count',
			label: `Artists with at least ${n} albums`,
			text,
			test: (c) => c >= n
		});
	} else if ((m = q.match(/^(\d+) albums?$/))) {
		const n = Number(m[1]);
		out.push({
			kind: 'count',
			label: `Artists with exactly ${n} albums`,
			text,
			test: (c) => c === n
		});
	}
	if (
		/^(19|20)\d{2} ?[-–] ?(19|20)?\d{2}$/.test(q) ||
		/^(19|20)?\d0'?s$/.test(q) ||
		/^(new|newer|newest|recent)( releases?)?$/.test(q) ||
		/^releases? /.test(q)
	) {
		out.push({
			kind: 'year',
			label: `Release years: "${text}"`,
			reason: NO_RELEASE_DATES_REASON
		});
	}
	return out;
}

/** First count filter parsed from persisted filter text, if any. */
export function parseCountFilter(raw: string): SmartCountFilter | null {
	for (const filter of parseSmartFilters(raw)) {
		if (filter.kind === 'count') return filter;
	}
	return null;
}
