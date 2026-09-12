import { describe, expect, it } from 'vitest';
import type { LetterBucket, LibraryAlbumEntry, LibraryArtistEntry } from '$lib/libraryEntries';
import {
	liveAlbumSortMenu,
	artistDrillSortMenu,
	ARTIST_SORT_MENU,
	genreDrillSortMenu,
	GENRE_SORT_MENU,
	namedCountBuckets,
	reverseBuckets,
	seededShuffle,
	sortAlbums,
	sortArtists,
	sortNamedCounts
} from '$lib/unifiedLibrarySorts';

function artist(name: string, albumCount: number): LibraryArtistEntry {
	return {
		id: `artist:${name}`,
		name,
		searchKey: name.toLowerCase(),
		albumCount
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




	/**
	 * Slice 8d: both drill menus lost the release-year slot outright, at every
	 * gate setting. Their cards carry no date — the artist page renders the
	 * walk's stored answer and the genre page a live drill — so an entry there
	 * offered an ordering neither surface could perform. Not disabled, gone: a
	 * disabled entry says "not right now", and this is not about timing.
	 */
	it('offers the artist drill no release-year order at all', () => {
		expect(artistDrillSortMenu().map((entry) => entry.id)).toEqual(['az', 'za', 'shuffle']);
	});

	it('offers the genre drill no release-year order at all', () => {
		expect(genreDrillSortMenu().map((entry) => entry.id)).toEqual([
			'az',
			'za',
			'by-artist',
			'shuffle'
		]);
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
