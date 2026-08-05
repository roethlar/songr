import { describe, it, expect } from 'vitest';
import { splitArtists, splitSubtitleSegments } from '../artistList';

describe('splitArtists', () => {
	it('splits Roon multi-artist credit strings on " / "', () => {
		expect(
			splitArtists(
				'Lio-Marcus Mendel / Leland Orlov, Jr. / Anton Reyes / Hamilton Cast Ensemble'
			)
		).toEqual([
			'Lio-Marcus Mendel',
			'Leland Orlov, Jr.',
			'Anton Reyes',
			'Hamilton Cast Ensemble'
		]);
	});

	it('returns a single-artist string as one entry', () => {
		expect(splitArtists('Tilda Arlen')).toEqual(['Tilda Arlen']);
	});

	it('does NOT split names containing a bare slash (AC/DC)', () => {
		expect(splitArtists('AC/DC')).toEqual(['AC/DC']);
		expect(splitArtists('AC/DC / Bon Scott')).toEqual(['AC/DC', 'Bon Scott']);
	});

	it('does not treat commas as separators (Leland Orlov, Jr.)', () => {
		expect(splitArtists('Leland Orlov, Jr.')).toEqual(['Leland Orlov, Jr.']);
	});

	it('handles empty / undefined input', () => {
		expect(splitArtists(undefined)).toEqual([]);
		expect(splitArtists('')).toEqual([]);
	});
});

describe('splitSubtitleSegments', () => {
	it('splits "Artist · Album" into both segments', () => {
		expect(splitSubtitleSegments('Tilda Arlen · Under the Pink')).toEqual([
			'Tilda Arlen',
			'Under the Pink'
		]);
	});

	it('further splits a multi-artist field', () => {
		expect(splitSubtitleSegments('A / B · Some Album')).toEqual(['A', 'B', 'Some Album']);
	});

	it('handles a bare artist subtitle', () => {
		expect(splitSubtitleSegments('Damon Dukes')).toEqual(['Damon Dukes']);
	});

	it('handles empty / undefined input', () => {
		expect(splitSubtitleSegments(undefined)).toEqual([]);
		expect(splitSubtitleSegments('')).toEqual([]);
	});
});
