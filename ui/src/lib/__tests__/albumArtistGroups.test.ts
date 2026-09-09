import { describe, expect, it } from 'vitest';
import {
	albumCreditKey, albumCreditMatches, albumCreditSelector,
	groupAlbumArtists, normalizeAlbumCreditSelector, sortAlbumArtistGroups
} from '../albumArtistGroups';
import type { LibraryAlbumEntry } from '../libraryEntries';

function album(artist: string, id: string): LibraryAlbumEntry {
	return Object.freeze({ id, title: 'Same album title', artist, searchKey: 'same album title',
		liveRef: Object.freeze({ generation: 'current', token: id }) });
}

describe('exact public album-credit groups', () => {
	it('retains single releases, combined credits, exact variants, and every edition/ref', () => {
		const credits = ['Single Release', 'Shared', 'Shared', 'A / B', 'AC/DC', 'Earth, Wind & Fire',
			'Björk', 'Björk', 'Björk', 'BJÖRK', 'Björk ', '’Til Tuesday', "'Til Tuesday"];
		const albums = Object.freeze(credits.map((credit, index) => album(credit, `${index}`)));
		const groups = groupAlbumArtists(albums);
		expect(groups).toHaveLength(credits.length - 2);
		for (const credit of new Set(credits)) {
			const group = groups.find(entry => entry.label === credit)!;
			const originals = albums.filter(entry => entry.artist === credit);
			expect(group.selector).toEqual({ kind: 'credit', credit });
			expect(group.albumCount).toBe(originals.length);
			expect(group.albums).toEqual(originals);
			group.albums.forEach((entry, index) => expect(entry).toBe(originals[index]));
			expect(group).not.toHaveProperty('liveRef');
		}
		// There is no Artists-root input from which to invent contributor groups.
		expect(groups.some(group => group.label === 'Guest only')).toBe(false);
		expect(groups.some(group => group.label === 'A' || group.label === 'B')).toBe(false);
		expect(groups.reduce((total, group) => total + group.albumCount, 0)).toBe(albums.length);
	});

	it('keeps all uncredited rows, distinct from the literal Unknown album artist credit', () => {
		const albums = [album('', 'empty'), album(' ', 'space'), album('\t', 'tab'),
			album('Unknown album artist', 'literal')];
		const groups = groupAlbumArtists(albums);
		expect(groups).toHaveLength(2);
		const missing = groups.find(group => group.selector.kind === 'uncredited')!;
		const literal = groups.find(group => group.selector.kind === 'credit')!;
		expect(missing.label).toBe(literal.label);
		expect(missing.key).not.toBe(literal.key);
		expect(missing.albumCount).toBe(3);
		expect(missing.albums).toEqual(albums.slice(0, 3));
		expect(albumCreditSelector(undefined)).toEqual({ kind: 'uncredited' });
		expect(albumCreditMatches(missing.selector, undefined)).toBe(true);
		expect(albumCreditMatches(literal.selector, undefined)).toBe(false);
		expect(albumCreditMatches(missing.selector, literal.label)).toBe(false);
	});

	it('sorts each mode with deterministic exact-selector ties, without regrouping', () => {
		const groups = groupAlbumArtists([album('Beta', 'b1'), album('Beta', 'b2'),
			album('alpha', 'a1'), album('Alpha', 'a2'), album('', 'u1'), album('Unknown album artist', 'u2')]);
		const original = [...groups];
		const az = sortAlbumArtistGroups(groups, 'az');
		expect(az.map(group => group.label)).toEqual(['Alpha', 'alpha', 'Beta',
			'Unknown album artist', 'Unknown album artist']);
		expect(az.at(-2)?.selector.kind).toBe('credit');
		expect(az.at(-1)?.selector.kind).toBe('uncredited');
		expect(sortAlbumArtistGroups([...groups].reverse(), 'az')).toEqual(az);
		expect(sortAlbumArtistGroups(groups, 'za')).toEqual([...az].reverse());
		expect(sortAlbumArtistGroups(groups, 'most-albums')[0].label).toBe('Beta');
		expect(sortAlbumArtistGroups(groups, 'fewest-albums').at(-1)?.label).toBe('Beta');
		expect(groups).toEqual(original);
		for (const group of az) expect(group).toBe(groups.find(entry => entry.key === group.key));
		expect(az.map(group => group.letter)).toEqual(['A', 'A', 'B', 'U', 'U']);
	});

	it('covers 40,000 albums with exactly one credit read per row', () => {
		let creditReads = 0;
		const albums: LibraryAlbumEntry[] = Array.from({ length: 40_000 }, (_, index) => ({
			id: `row:${index}`, title: `Album ${index}`, searchKey: `album ${index}`,
			get artist() { creditReads += 1; return `Credit ${index % 2003}`; },
			liveRef: { generation: 'large', token: `${index}` }
		}));
		const groups = groupAlbumArtists(albums);
		expect(creditReads).toBe(albums.length);
		expect(groups).toHaveLength(2003);
		expect(groups.reduce((total, group) => total + group.albumCount, 0)).toBe(40_000);
		const members = new Set(groups.flatMap(group => [...group.albums]));
		expect(members.size).toBe(albums.length);
		for (const entry of albums) expect(members.has(entry)).toBe(true);
		sortAlbumArtistGroups(groups, 'most-albums');
		expect(creditReads).toBe(albums.length);
	});

	it.each([null, [], {}, { kind: 'unknown' }, { kind: 'credit', credit: '' },
		{ kind: 'credit', credit: ' ' }, { kind: 'credit', credit: 'X\nY' },
		{ kind: 'credit', credit: 'x'.repeat(1025) }, { kind: 'uncredited', credit: '' },
		{ kind: 'credit', credit: 'X', id: 'invented' }, Object.create({ kind: 'uncredited' })
	])('refuses malformed selectors: %j', value => {
		expect(normalizeAlbumCreditSelector(value)).toBeNull();
	});

	it('preserves bounded exact credit text and tagged key distinctions', () => {
		const credit = ' '.repeat(10) + 'A/B' + ' '.repeat(10);
		expect(normalizeAlbumCreditSelector({ kind: 'credit', credit })).toEqual({ kind: 'credit', credit });
		expect(normalizeAlbumCreditSelector({ kind: 'credit', credit: 'x'.repeat(1024) })).not.toBeNull();
		expect(albumCreditKey({ kind: 'credit', credit: 'uncredited' })).not.toBe(albumCreditKey({ kind: 'uncredited' }));
	});
});
