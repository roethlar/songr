import { describe, expect, it } from 'vitest';
import type { AlbumRef } from '@shared/catalogContracts';
import { normalizeCatalogText } from '@shared/catalogContracts';
import { foldCatalogNameKey, libraryAlbumEntryFromAlbumRef } from '$lib/catalogNameMatch';
import { librarySortKey } from '$lib/stores/libraryIndexStore';

describe('foldCatalogNameKey', () => {
	it('joins the typographic credit variants the catalog actually contains', () => {
		// The measured production case: the Artists row says ’Til Tuesday
		// (U+2019) while the Albums-row credits say 'Til Tuesday (U+0027).
		expect(foldCatalogNameKey('’Til Tuesday')).toBe(foldCatalogNameKey("'Til Tuesday"));
		expect(foldCatalogNameKey('“Weird Al” Yankovic')).toBe(
			foldCatalogNameKey('"Weird Al" Yankovic')
		);
		expect(foldCatalogNameKey('Sinéad O’Connor')).toBe(
			foldCatalogNameKey("Sinéad O'Connor")
		);
		expect(foldCatalogNameKey('Ike – Tina')).toBe(foldCatalogNameKey('Ike - Tina'));
	});

	it('collapses whitespace and case without folding distinct letters', () => {
		expect(foldCatalogNameKey('  2   Chainz ')).toBe('2 chainz');
		expect(foldCatalogNameKey('AC/DC')).toBe('ac/dc');
		// Diacritics stay significant: é and e are different artists' letters.
		expect(foldCatalogNameKey('Sinéad')).not.toBe(foldCatalogNameKey('Sinead'));
	});
});

describe('libraryAlbumEntryFromAlbumRef', () => {
	function albumRef(over: Partial<AlbumRef> = {}): AlbumRef {
		const exactTitle = 'Voices Carry';
		const exactArtist = "'Til Tuesday";
		return {
			localId: '11111111-1111-4111-8111-111111111111',
			coreId: 'core-a',
			exactTitle,
			exactArtist,
			normalizedTitle: normalizeCatalogText(exactTitle),
			normalizedArtist: normalizeCatalogText(exactArtist),
			editionText: '',
			firstSeenAt: '2026-08-08T00:00:00.000Z',
			lastSeenAt: '2026-08-08T00:00:00.000Z',
			resolutionStatus: 'resolved',
			...over
		} as AlbumRef;
	}

	it('maps a load-response album exactly like an index row', () => {
		const entry = libraryAlbumEntryFromAlbumRef(
			albumRef({
				artistLocalId: '22222222-2222-4222-8222-222222222222',
				imageKeyHint: 'img-1',
				originalReleaseDate: { year: 1985, month: 0, day: 0 }
			})
		);
		expect(entry).toEqual({
			id: '11111111-1111-4111-8111-111111111111',
			title: 'Voices Carry',
			artist: "'Til Tuesday",
			versionCount: 1,
			memberLocalIds: ['11111111-1111-4111-8111-111111111111'],
			searchKey: `${librarySortKey('Voices Carry')} ${normalizeCatalogText("'Til Tuesday")}`,
			artistId: '22222222-2222-4222-8222-222222222222',
			imageKey: 'img-1',
			catalogLocalId: '11111111-1111-4111-8111-111111111111',
			resolutionStatus: 'resolved',
			originalReleaseDate: { year: 1985, month: 0, day: 0 }
		});
	});

	it('omits absent optionals instead of writing undefined fields', () => {
		const entry = libraryAlbumEntryFromAlbumRef(albumRef());
		expect(Object.keys(entry).sort()).toEqual([
			'artist',
			'catalogLocalId',
			'id',
			'memberLocalIds',
			'resolutionStatus',
			'searchKey',
			'title',
			'versionCount'
		]);
	});
});
