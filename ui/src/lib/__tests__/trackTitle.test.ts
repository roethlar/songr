import { describe, it, expect } from 'vitest';
import { albumTrackNumber } from '../trackTitle';

describe('actual album track numbers', () => {
	it('never substitutes a collection position for absent metadata', () => {
		expect(albumTrackNumber({ index: 63, title: 'Song' })).toBeNull();
		expect(albumTrackNumber({ index: 0, title: '1979 (Remastered)' })).toBeNull();
	});
	it('shows only the explicit validated number, independent of position', () => {
		expect(albumTrackNumber({ index: 63, title: 'Song', trackNumber: 7 })).toBe(7);
		expect(albumTrackNumber({ index: 8, title: 'Hidden track', trackNumber: 0 })).toBe(0);
		for (const trackNumber of [-1, NaN, 1.5, Infinity]) expect(albumTrackNumber({ index: 0, title: 'Song', trackNumber })).toBeNull();
	});
	it('keeps single-disc and multidisc numbered titles without a duplicate number', () => {
		for (const title of ['1. Song', ' 2. Song', '1-22 Dear Theodosia', '1-22. Dear Theodosia']) {
			expect(albumTrackNumber({ index: 63, title, trackNumber: 22 })).toBeNull();
		}
	});
	it('does not strip or reinterpret a title that starts with a year or other number', () => {
		expect(albumTrackNumber({ index: 1, title: '1979 (Remastered)', trackNumber: 7 })).toBe(7);
		expect(albumTrackNumber({ index: 1, title: '99 Luftballons', trackNumber: 7 })).toBe(7);
	});
});
