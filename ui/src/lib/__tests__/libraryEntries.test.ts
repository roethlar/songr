import { describe, it, expect } from 'vitest';

import {
	bucketLetterFor,
	compareLibrarySearchKeys,
	computeBuckets,
	librarySortKey,
	sortBySearchKey
} from '../libraryEntries';


describe('library sort keys and letter buckets', () => {
	// These rules used to be proved only through the catalog index loader, which
	// is deleted. They are the rail's whole contract and belong to nothing that
	// went with it, so they are proved here directly.
	it('strips one leading article for sorting, and only one', () => {
		expect(librarySortKey('The Beatles')).toBe('beatles');
		expect(librarySortKey('A Certain Ratio')).toBe('certain ratio');
		expect(librarySortKey('An Emotional Fish')).toBe('emotional fish');
		// "The 1975" buckets under # because what is left starts with a digit.
		expect(librarySortKey('The 1975')).toBe('1975');
		// Only the leading one: an article inside the name stays.
		expect(librarySortKey('The The Band')).toBe('the band');
		// A word merely beginning with an article is untouched.
		expect(librarySortKey('Therapy?')).toBe('therapy?');
	});

	it('folds every non a–z initial into the single # bucket', () => {
		expect(bucketLetterFor('beatles')).toBe('B');
		expect(bucketLetterFor('1975')).toBe('#');
		expect(bucketLetterFor('’til tuesday')).toBe('#');
		// Accented initials survive normalization, which lowercases but does not
		// fold diacritics. They must still bucket under # or the rail would
		// render two separate # sections and crash its letter-keyed each block.
		expect(bucketLetterFor('éliane radigue')).toBe('#');
		expect(bucketLetterFor('')).toBe('#');
	});

	it('orders # before A–Z so every bucket letter stays contiguous', () => {
		const keys = ['éliane', 'beatles', '1975', 'aphex'];
		expect([...keys].sort(compareLibrarySearchKeys)).toEqual([
			'1975',
			'éliane',
			'aphex',
			'beatles'
		]);
	});

	it('sorts punctuation-led names by their first word, not by code point', () => {
		// ICU collation, pinned to en-US: `’Til Tuesday` before `"Weird Al"`.
		const sorted = sortBySearchKey(
			[{ searchKey: librarySortKey('"Weird Al" Yankovic') }, { searchKey: librarySortKey('’Til Tuesday') }]
		);
		expect(sorted.map((entry) => entry.searchKey)).toEqual([
			librarySortKey('’Til Tuesday'),
			librarySortKey('"Weird Al" Yankovic')
		]);
	});

	it('describes each contiguous run of one letter exactly once', () => {
		expect(computeBuckets(['1975', 'aphex', 'autechre', 'beatles'])).toEqual([
			{ letter: '#', start: 0, count: 1 },
			{ letter: 'A', start: 1, count: 2 },
			{ letter: 'B', start: 3, count: 1 }
		]);
		expect(computeBuckets([])).toEqual([]);
	});
});
