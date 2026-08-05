import { describe, expect, it } from 'vitest';
import { pluralize } from '$lib/pluralize';

describe('pluralize', () => {
	it('returns the singular form for a count of exactly 1', () => {
		expect(pluralize(1, 'album', 'albums')).toBe('album');
	});

	it('returns the plural form for 0, negative, and >1 counts', () => {
		expect(pluralize(0, 'album', 'albums')).toBe('albums');
		expect(pluralize(-1, 'album', 'albums')).toBe('albums');
		expect(pluralize(2, 'album', 'albums')).toBe('albums');
		expect(pluralize(60, 'album', 'albums')).toBe('albums');
	});

	it('does not case the forms itself — callers own casing', () => {
		expect(pluralize(1, 'ALBUM', 'ALBUMS')).toBe('ALBUM');
		expect(pluralize(2, 'ALBUM', 'ALBUMS')).toBe('ALBUMS');
	});
});
