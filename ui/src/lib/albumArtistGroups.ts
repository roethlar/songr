import {
	bucketLetterFor,
	compareLibrarySearchKeys,
	librarySortKey,
	type LibraryAlbumEntry
} from '$lib/libraryEntries';

export type ArtistView = 'album-artists' | 'all-artists';
export type AlbumCreditSelector =
	| { readonly kind: 'credit'; readonly credit: string }
	| { readonly kind: 'uncredited' };

export interface AlbumArtistGroup {
	readonly selector: AlbumCreditSelector;
	/** A display-group key, never a Roon identity or reference. */
	readonly key: string;
	readonly label: string;
	readonly searchKey: string;
	readonly letter: string;
	readonly albumCount: number;
	readonly albums: readonly LibraryAlbumEntry[];
}

export type AlbumArtistSort = 'az' | 'za' | 'most-albums' | 'fewest-albums';

/** Validate the same bounded text domain as durable Library route segments. */
export function normalizeAlbumCreditSelector(value: unknown): AlbumCreditSelector | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return null;
	const record = value as Record<string, unknown>;
	const keys = Reflect.ownKeys(record);
	if (record.kind === 'uncredited') {
		return keys.length === 1 && keys[0] === 'kind' ? { kind: 'uncredited' } : null;
	}
	return record.kind === 'credit' && keys.length === 2 && keys.includes('kind') &&
		keys.includes('credit') && typeof record.credit === 'string' &&
		record.credit.length <= 1024 && record.credit.trim().length > 0 &&
		!/[\u0000-\u001f\u007f]/u.test(record.credit)
		? { kind: 'credit', credit: record.credit }
		: null;
}

export function albumCreditSelector(credit: string | undefined): AlbumCreditSelector {
	return (credit ?? '').trim().length === 0
		? { kind: 'uncredited' }
		: { kind: 'credit', credit: credit! };
}

export function albumCreditKey(selector: AlbumCreditSelector): string {
	return selector.kind === 'uncredited' ? 'uncredited' : `credit:${selector.credit}`;
}

export function albumCreditLabel(selector: AlbumCreditSelector): string {
	return selector.kind === 'uncredited' ? 'Unknown album artist' : selector.credit;
}

export function albumCreditMatches(selector: AlbumCreditSelector, credit: string | undefined): boolean {
	return selector.kind === 'uncredited'
		? (credit ?? '').trim().length === 0
		: credit === selector.credit;
}

/** One linear pass over a complete live Albums snapshot; retain every row/ref. */
export function groupAlbumArtists(albums: readonly LibraryAlbumEntry[]): AlbumArtistGroup[] {
	const groups = new Map<string, { selector: AlbumCreditSelector; albums: LibraryAlbumEntry[] }>();
	for (const album of albums) {
		const selector = albumCreditSelector(album.artist);
		const key = albumCreditKey(selector);
		let group = groups.get(key);
		if (!group) {
			group = { selector, albums: [] };
			groups.set(key, group);
		}
		group.albums.push(album);
	}
	return Array.from(groups, ([key, group]) => {
		const label = albumCreditLabel(group.selector);
		const searchKey = librarySortKey(label);
		return {
			key, selector: group.selector, label, searchKey,
			letter: bucketLetterFor(searchKey),
			albumCount: group.albums.length, albums: group.albums
		};
	});
}

/** Sort without regrouping or changing the snapshot's rows/membership. */
export function sortAlbumArtistGroups(
	groups: readonly AlbumArtistGroup[], sort: AlbumArtistSort
): AlbumArtistGroup[] {
	return [...groups].sort((left, right) => {
		const alpha = compareLibrarySearchKeys(left.searchKey, right.searchKey) ||
			(left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
		if (sort === 'most-albums') return right.albumCount - left.albumCount || alpha;
		if (sort === 'fewest-albums') return left.albumCount - right.albumCount || alpha;
		return sort === 'za' ? -alpha : alpha;
	});
}
