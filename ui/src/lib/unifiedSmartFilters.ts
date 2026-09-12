/** Count filters use album counts printed in public artist rows. */
import { UNIFIED_FILTER_TEXT_MAX_LENGTH } from '$lib/libraryPageState';

export interface SmartCountFilter {
	readonly kind: 'count';
	/** Human label, e.g. "Artists with more than 30 albums". */
	readonly label: string;
	/** Canonical filter text as persisted in unified page state. */
	readonly text: string;
	readonly test: (albumCount: number) => boolean;
}

const COUNT_COMPARATOR_WORDS: Readonly<Record<string, string>> = {
	'>': 'more than ',
	'>=': 'at least ',
	'<': 'fewer than ',
	'<=': 'at most '
};

/**
 * Parses free palette text into smart filters. Returns at most one count
 * filter. Unparseable text returns [] and remains a plain search query.
 */
export function parseSmartFilters(raw: string): SmartCountFilter[] {
	if (raw.length > UNIFIED_FILTER_TEXT_MAX_LENGTH) return [];
	const q = raw.trim().toLowerCase().replace(/\s+/g, ' ');
	if (!q) return [];
	const text = raw.trim().replace(/\s+/g, ' ');
	const out: SmartCountFilter[] = [];
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
	return out;
}

/** First count filter parsed from persisted filter text, if any. */
export function parseCountFilter(raw: string): SmartCountFilter | null {
	return parseSmartFilters(raw)[0] ?? null;
}
