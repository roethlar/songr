import { describe, expect, it } from 'vitest';
import {
	PAGING_STRESS_ALBUM_COUNT,
	SYNTHETIC_ALBUM_COUNT,
	SYNTHETIC_ARTIST_COUNT,
	chronologyLabel,
	createPagingStressFixture,
	createScenario,
	createSyntheticCatalog
} from './index';

describe('synthetic catalog fixtures', () => {
	it('preserves the recorded logical catalog cardinalities', () => {
		const catalog = createSyntheticCatalog();

		expect(catalog.counts).toEqual({ artists: SYNTHETIC_ARTIST_COUNT, albums: SYNTHETIC_ALBUM_COUNT });
		expect(catalog.artists).toHaveLength(1_671);
		expect(catalog.albums).toHaveLength(3_896);
		expect(new Set(catalog.artists.map((artist) => artist.id))).toHaveLength(1_671);
		expect(new Set(catalog.albums.map((album) => album.id))).toHaveLength(3_896);
		expect(catalog.artists.reduce((sum, artist) => sum + artist.albumCount, 0)).toBe(3_896);
	});

	it('provides exact small, medium, large, and paging-stress fixtures', () => {
		expect(createScenario('small').albums).toHaveLength(1);
		expect(createScenario('medium').albums).toHaveLength(11);
		expect(createScenario('large').albums).toHaveLength(38);
		expect(createScenario('stress').albums).toHaveLength(PAGING_STRESS_ALBUM_COUNT);
	});

	it('pages all 4,541 stress albums without gaps or duplicates', () => {
		const fixture = createPagingStressFixture(257);
		const flattened = fixture.pages.flat();

		expect(fixture.total).toBe(4_541);
		expect(flattened).toHaveLength(4_541);
		expect(new Set(flattened.map((album) => album.id))).toHaveLength(4_541);
		expect(flattened.map((album) => album.id)).toEqual(fixture.albums.map((album) => album.id));
		expect(fixture.pages.slice(0, -1).every((page) => page.length === 257)).toBe(true);
	});

	it('anchors only explicit original-release years and labels edition-only evidence Undated', () => {
		const medium = createScenario('medium');
		const editionOnly = medium.albums.find(
			(album) => album.originalReleaseYear === null && album.editionReleaseYear !== null
		);
		const known = medium.albums.find((album) => album.originalReleaseYear !== null);

		expect(editionOnly).toBeDefined();
		expect(chronologyLabel(editionOnly!)).toBe('Undated');
		expect(chronologyLabel(known!)).toBe(String(known!.originalReleaseYear));
	});
});
