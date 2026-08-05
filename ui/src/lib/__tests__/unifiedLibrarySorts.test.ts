import { describe, expect, it } from 'vitest';
import type { LetterBucket, LibraryAlbumEntry, LibraryArtistEntry } from '$lib/stores/libraryIndexStore';
import {
	albumSortMenu,
	artistDrillSortMenu,
	ARTIST_SORT_MENU,
	genreDrillSortMenu,
	GENRE_SORT_MENU,
	isChronologicalAlbumSort,
	NO_RELEASE_DATES_REASON,
	namedCountBuckets,
	reverseBuckets,
	seededShuffle,
	sortAlbums,
	sortAlbumsByRecentlyAdded,
	sortArtists,
	sortNamedCounts
} from '$lib/unifiedLibrarySorts';

function artist(name: string, albumCount: number): LibraryArtistEntry {
	return {
		id: `artist:${name}`,
		name,
		searchKey: name.toLowerCase(),
		albumCount,
		countComplete: true
	};
}

function album(title: string, artistName: string): LibraryAlbumEntry {
	return {
		id: `album:${title}`,
		title,
		artist: artistName,
		searchKey: `${title.toLowerCase()} — ${artistName.toLowerCase()}`
	};
}

describe('sort menus', () => {
	it('uses the approved prototype labels for alphabetical sorts', () => {
		expect(ARTIST_SORT_MENU.slice(0, 2).map((entry) => entry.label)).toEqual([
			'A to Z',
			'Z to A'
		]);
	});

	it('keeps release-year present but disabled with the verified reason when date features are unavailable', () => {
		const releaseYear = albumSortMenu({ available: false }).find(
			(entry) => entry.id === 'release-year'
		);
		expect(releaseYear).toBeDefined();
		expect(releaseYear?.disabledReason).toBe(NO_RELEASE_DATES_REASON);
	});

	it('prefers the capability state machine reason over the default when one is carried', () => {
		const reason = 'no native catalog snapshot is available';
		const releaseYear = albumSortMenu({ available: false, reason }).find(
			(entry) => entry.id === 'release-year'
		);
		expect(releaseYear?.disabledReason).toBe(reason);
	});

	it('replaces the disabled release-year entry with the two chronological orders when available', () => {
		const menu = albumSortMenu({ available: true });
		expect(menu.map((entry) => entry.id)).toEqual([
			'az',
			'za',
			'by-artist',
			'shuffle',
			'year-asc',
			'year-desc',
			'by-genre'
		]);
		expect(menu.find((entry) => entry.id === 'year-asc')).toMatchObject({
			label: 'Oldest first'
		});
		expect(menu.find((entry) => entry.id === 'year-desc')).toMatchObject({
			label: 'Newest first'
		});
		expect(menu.every((entry) => entry.id !== 'release-year')).toBe(true);
	});

	it('mirrors the same availability rule into the artist drill menu', () => {
		const disabled = artistDrillSortMenu({ available: false });
		expect(disabled.map((entry) => entry.id)).toEqual(['az', 'za', 'shuffle', 'release-year']);
		expect(disabled.at(-1)?.disabledReason).toBe(NO_RELEASE_DATES_REASON);
		const enabled = artistDrillSortMenu({ available: true });
		expect(enabled.map((entry) => entry.id)).toEqual([
			'az',
			'za',
			'shuffle',
			'year-asc',
			'year-desc'
		]);
		expect(enabled.every((entry) => entry.disabledReason === undefined)).toBe(true);
	});

	it('keeps the genre drill menu exactly as before when date features are unavailable', () => {
		expect(genreDrillSortMenu({ available: false }).map((entry) => entry.id)).toEqual([
			'az',
			'za',
			'by-artist',
			'shuffle'
		]);
		expect(genreDrillSortMenu({ available: true }).map((entry) => entry.id)).toEqual([
			'az',
			'za',
			'by-artist',
			'shuffle',
			'year-asc',
			'year-desc'
		]);
	});

	it('only the album menu carries disabled entries when date features are unavailable', () => {
		const disabled = [
			...ARTIST_SORT_MENU,
			...albumSortMenu({ available: false }),
			...GENRE_SORT_MENU
		].filter((entry) => entry.disabledReason !== undefined);
		expect(disabled.map((entry) => entry.id)).toEqual(['release-year', 'by-genre']);
	});

	it('marks exactly the year orders as chronological for the rail rule', () => {
		expect(isChronologicalAlbumSort('year-asc')).toBe(true);
		expect(isChronologicalAlbumSort('year-desc')).toBe(true);
		for (const other of ['az', 'za', 'by-artist', 'shuffle', 'release-year']) {
			expect(isChronologicalAlbumSort(other)).toBe(false);
		}
	});
});

describe('sortArtists', () => {
	const entries = [artist('Abba', 3), artist('Beck', 9), artist('Cave', 5)];

	it('za reverses without mutating the input', () => {
		const za = sortArtists(entries, 'za');
		expect(za.map((e) => e.name)).toEqual(['Cave', 'Beck', 'Abba']);
		expect(entries[0].name).toBe('Abba');
	});

	it('most/fewest albums order by count', () => {
		expect(sortArtists(entries, 'most-albums').map((e) => e.albumCount)).toEqual([9, 5, 3]);
		expect(sortArtists(entries, 'fewest-albums').map((e) => e.albumCount)).toEqual([3, 5, 9]);
	});
});

describe('sortAlbums', () => {
	const entries = [album('Arrival', 'Abba'), album('Odelay', 'Beck'), album('Colors', 'Beck')];

	it('by-artist groups by artist then title', () => {
		expect(sortAlbums(entries, 'by-artist', 1).map((e) => e.title)).toEqual([
			'Arrival',
			'Colors',
			'Odelay'
		]);
	});

	it('by-artist uses the same article-stripped order as its letter groups', () => {
		const grouped = [
			album('King’s Mouth', 'The Flaming Lips'),
			album('Solitude', 'The The'),
			album('Angel Dust', 'Faith No More'),
			album('Everything', 'The Verve'),
			album('Soft Sounds', 'Japanese Breakfast')
		];

		expect(sortAlbums(grouped, 'by-artist', 1).map((entry) => entry.artist)).toEqual([
			'Faith No More',
			'The Flaming Lips',
			'Japanese Breakfast',
			'The The',
			'The Verve'
		]);
	});

	it('shuffle replays identically for one seed and differs across seeds', () => {
		const wide = Array.from({ length: 40 }, (_, i) => album(`T${i}`, 'X'));
		const first = sortAlbums(wide, 'shuffle', 7).map((e) => e.id);
		const replay = sortAlbums(wide, 'shuffle', 7).map((e) => e.id);
		const other = sortAlbums(wide, 'shuffle', 8).map((e) => e.id);
		expect(replay).toEqual(first);
		expect(other).not.toEqual(first);
		expect([...first].sort()).toEqual([...replay].sort());
	});

	it('seededShuffle preserves membership', () => {
		const items = [1, 2, 3, 4, 5];
		expect([...seededShuffle(items, 3)].sort()).toEqual(items);
	});
});

describe('sortAlbums — release year (Slice 4)', () => {
	function dated(
		title: string,
		dates?: {
			original?: readonly [number, number, number];
			release?: readonly [number, number, number];
		}
	): LibraryAlbumEntry {
		const entry = album(title, 'Artist');
		return {
			...entry,
			// Match the store's searchKey: article-stripped normalized title.
			searchKey: `${title.toLowerCase().replace(/^(the |a |an )/, '')} — artist`,
			...(dates?.original
				? {
						originalReleaseDate: {
							year: dates.original[0],
							month: dates.original[1],
							day: dates.original[2]
						}
					}
				: {}),
			...(dates?.release
				? {
						releaseDate: {
							year: dates.release[0],
							month: dates.release[1],
							day: dates.release[2]
						}
					}
				: {})
		};
	}

	const titles = (entries: readonly LibraryAlbumEntry[]): string[] =>
		entries.map((entry) => entry.title);

	it('orders by originalReleaseDate, ascending and descending', () => {
		const entries = [
			dated('Middle', { original: [1975, 6, 1] }),
			dated('Earliest', { original: [1959, 8, 17] }),
			dated('Latest', { original: [1997, 9, 22] })
		];
		expect(titles(sortAlbums(entries, 'year-asc', 1))).toEqual([
			'Earliest',
			'Middle',
			'Latest'
		]);
		expect(titles(sortAlbums(entries, 'year-desc', 1))).toEqual([
			'Latest',
			'Middle',
			'Earliest'
		]);
		// The input order is never mutated.
		expect(entries[0].title).toBe('Middle');
	});

	it('prefers originalReleaseDate over releaseDate and falls back to releaseDate', () => {
		const entries = [
			// Original 1970 must win over the 1990 reissue date.
			dated('Reissue', { original: [1970, 1, 1], release: [1990, 1, 1] }),
			// No original: the release date is the fallback key.
			dated('Fallback', { release: [1965, 5, 5] }),
			dated('Between', { original: [1968, 3, 3] })
		];
		expect(titles(sortAlbums(entries, 'year-asc', 1))).toEqual([
			'Fallback',
			'Between',
			'Reissue'
		]);
	});

	it('orders year-only dates inside their own year', () => {
		const entries = [
			dated('Dated June', { original: [1975, 6, 1] }),
			dated('Year Only', { original: [1975, 0, 0] }),
			dated('Earlier Year', { original: [1974, 11, 31] }),
			dated('Later Year', { original: [1976, 1, 1] })
		];
		expect(titles(sortAlbums(entries, 'year-asc', 1))).toEqual([
			'Earlier Year',
			'Year Only',
			'Dated June',
			'Later Year'
		]);
		expect(titles(sortAlbums(entries, 'year-desc', 1))).toEqual([
			'Later Year',
			'Dated June',
			'Year Only',
			'Earlier Year'
		]);
	});

	it('places undated albums last in BOTH directions', () => {
		const entries = [
			dated('Undated B'),
			dated('Old', { original: [1960, 1, 1] }),
			dated('Undated A'),
			dated('New', { original: [2000, 1, 1] })
		];
		expect(titles(sortAlbums(entries, 'year-asc', 1))).toEqual([
			'Old',
			'New',
			'Undated A',
			'Undated B'
		]);
		expect(titles(sortAlbums(entries, 'year-desc', 1))).toEqual([
			'New',
			'Old',
			'Undated A',
			'Undated B'
		]);
	});

	it('breaks date ties by the normalized title key, independent of input order', () => {
		const first = [
			dated('Zebra Tie', { original: [1975, 6, 1] }),
			dated('The Alpha Tie', { original: [1975, 6, 1] })
		];
		const reversed = [...first].reverse();
		// "The Alpha Tie" sorts by its article-stripped key (alpha…), before
		// "Zebra Tie", exactly like the alphabetical sorts.
		expect(titles(sortAlbums(first, 'year-asc', 1))).toEqual([
			'The Alpha Tie',
			'Zebra Tie'
		]);
		expect(titles(sortAlbums(reversed, 'year-asc', 1))).toEqual([
			'The Alpha Tie',
			'Zebra Tie'
		]);
		// The tie-break direction is stable: descending flips the date key,
		// never the title tie-break, so the order stays deterministic.
		expect(titles(sortAlbums(reversed, 'year-desc', 1))).toEqual([
			'The Alpha Tie',
			'Zebra Tie'
		]);
	});
});

describe('sortAlbumsByRecentlyAdded — recently added (Slice 5)', () => {
	function imported(title: string, importDate?: string): LibraryAlbumEntry {
		const entry = album(title, 'Artist');
		return {
			...entry,
			// Match the store's searchKey: article-stripped normalized title.
			searchKey: `${title.toLowerCase().replace(/^(the |a |an )/, '')} — artist`,
			...(importDate !== undefined ? { importDate } : {})
		};
	}

	const titles = (entries: readonly LibraryAlbumEntry[]): string[] =>
		entries.map((entry) => entry.title);

	it('orders by importDate descending, newest first', () => {
		const entries = [
			imported('Middle', '2026-07-20T10:00:00.000Z'),
			imported('Newest', '2026-07-24T09:30:00.000Z'),
			imported('Oldest', '2026-07-18T12:00:00.000Z')
		];
		expect(titles(sortAlbumsByRecentlyAdded(entries))).toEqual(['Newest', 'Middle', 'Oldest']);
		// The input order is never mutated.
		expect(entries[0].title).toBe('Middle');
	});

	it('places albums without an importDate last, titled among themselves', () => {
		const entries = [
			imported('Undated B'),
			imported('Imported', '2026-07-24T09:30:00.000Z'),
			imported('Undated A'),
			imported('Older', '2026-07-18T12:00:00.000Z')
		];
		expect(titles(sortAlbumsByRecentlyAdded(entries))).toEqual([
			'Imported',
			'Older',
			'Undated A',
			'Undated B'
		]);
	});

	it('breaks equal timestamps by the normalized title key, independent of input order', () => {
		const first = [
			imported('Zebra Tie', '2026-07-20T10:00:00.000Z'),
			imported('The Alpha Tie', '2026-07-20T10:00:00.000Z')
		];
		const reversed = [...first].reverse();
		// "The Alpha Tie" sorts by its article-stripped key (alpha…), before
		// "Zebra Tie", exactly like the alphabetical sorts.
		expect(titles(sortAlbumsByRecentlyAdded(first))).toEqual(['The Alpha Tie', 'Zebra Tie']);
		expect(titles(sortAlbumsByRecentlyAdded(reversed))).toEqual(['The Alpha Tie', 'Zebra Tie']);
	});
});

describe('sortNamedCounts', () => {
	const entries = [
		{ label: 'Rock', albumCount: 4 },
		{ label: 'The Ambient', albumCount: 2 },
		{ label: 'Rap', albumCount: 11 },
		{ label: 'Blues', albumCount: 11 }
	];

	it('sorts live count-ordered rows like the prototype before letter grouping', () => {
		expect(sortNamedCounts(entries, 'az').map((e) => e.label)).toEqual([
			'The Ambient',
			'Blues',
			'Rap',
			'Rock'
		]);
		expect(sortNamedCounts(entries, 'za').map((e) => e.label)).toEqual([
			'Rock',
			'Rap',
			'Blues',
			'The Ambient'
		]);
		expect(sortNamedCounts(entries, 'most-albums').map((e) => e.label)).toEqual([
			'Blues',
			'Rap',
			'Rock',
			'The Ambient'
		]);
	});

	it('builds genre rail buckets over the rendered A–Z order', () => {
		expect(namedCountBuckets(entries)).toEqual([
			{ letter: 'A', start: 0, count: 1 },
			{ letter: 'B', start: 1, count: 1 },
			{ letter: 'R', start: 2, count: 2 }
		]);
	});
});

describe('reverseBuckets', () => {
	it('mirrors starts so each letter addresses the same entries', () => {
		const buckets: LetterBucket[] = [
			{ letter: 'A', start: 0, count: 3 },
			{ letter: 'B', start: 3, count: 2 },
			{ letter: 'C', start: 5, count: 4 }
		];
		const reversed = reverseBuckets(buckets, 9);
		expect(reversed).toEqual([
			{ letter: 'C', start: 0, count: 4 },
			{ letter: 'B', start: 4, count: 2 },
			{ letter: 'A', start: 6, count: 3 }
		]);
		// Round-trip: reversing twice restores the original mapping.
		expect(reverseBuckets(reversed, 9)).toEqual(buckets);
	});

	it('handles sparse buckets (missing letters) without gaps drifting', () => {
		const buckets: LetterBucket[] = [
			{ letter: 'A', start: 0, count: 1 },
			{ letter: 'Z', start: 1, count: 6 }
		];
		expect(reverseBuckets(buckets, 7)).toEqual([
			{ letter: 'Z', start: 0, count: 6 },
			{ letter: 'A', start: 6, count: 1 }
		]);
	});
});
