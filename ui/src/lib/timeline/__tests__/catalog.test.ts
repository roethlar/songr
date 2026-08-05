import { describe, expect, it } from 'vitest';
import type {
	AlbumRef,
	ArtistRef,
	CatalogArtistAlbumsResponse,
	CatalogStatus
} from '@shared/timelineCatalogContracts';
import { mapCatalogArtistAlbumsToTimelineInputs } from '../catalog';

const ARTIST_ID = '10000000-0000-4000-8000-000000000001';
const OBSERVED_AT = '2026-07-14T12:00:00.000Z';

function status(): CatalogStatus {
	return {
		coreId: 'core-a',
		freshness: 'fresh',
		persistence: 'healthy',
		refresh: 'idle',
		available: true,
		complete: true,
		revision: 1,
		artistCount: 1,
		albumCount: 4,
		updatedAt: OBSERVED_AT,
		lastCompleteScanAt: OBSERVED_AT
	};
}

function artist(): ArtistRef {
	return {
		localId: ARTIST_ID,
		coreId: 'core-a',
		exactName: 'Björk',
		normalizedName: 'björk',
		firstSeenAt: OBSERVED_AT,
		lastSeenAt: OBSERVED_AT,
		resolutionStatus: 'resolved'
	};
}

function albumBase(localId: string, exactTitle: string) {
	return {
		localId,
		coreId: 'core-a',
		artistLocalId: ARTIST_ID,
		exactTitle,
		exactArtist: 'Björk',
		normalizedTitle: exactTitle.toLocaleLowerCase('en-US'),
		normalizedArtist: 'björk',
		editionText: '',
		firstSeenAt: OBSERVED_AT,
		lastSeenAt: OBSERVED_AT
	};
}

function originalDatedAlbum(): AlbumRef {
	return {
		...albumBase('20000000-0000-4000-8000-000000000001', 'Homogenic'),
		resolutionStatus: 'resolved',
		imageKeyHint: 'homogenic-image',
		originalReleaseYear: 1997,
		originalReleaseYearEvidence: {
			sourceContract: 'controller-normalized-browse-album-detail-v1',
			field: 'original-release-date',
			date: '1997-09-22'
		}
	};
}

function editionOnlyAlbum(): AlbumRef {
	return {
		...albumBase('20000000-0000-4000-8000-000000000002', 'Vespertine'),
		resolutionStatus: 'resolved',
		editionText: '2021 reissue',
		editionReleaseYear: 2021,
		editionReleaseYearEvidence: {
			sourceContract: 'controller-normalized-browse-album-detail-v1',
			field: 'edition-release-date',
			date: '2021-06-04'
		}
	};
}

function missingAlbum(): AlbumRef {
	return {
		...albumBase('20000000-0000-4000-8000-000000000003', 'Historical Missing'),
		resolutionStatus: 'missing'
	};
}

function ambiguousAlbum(): AlbumRef {
	return {
		...albumBase('20000000-0000-4000-8000-000000000004', 'Ambiguous Edition'),
		resolutionStatus: 'ambiguous'
	};
}

function response(): CatalogArtistAlbumsResponse {
	return {
		status: status(),
		artist: artist(),
		limit: 200,
		total: 4,
		truncated: false,
		albums: [originalDatedAlbum(), editionOnlyAlbum(), missingAlbum(), ambiguousAlbum()]
	};
}

describe('mapCatalogArtistAlbumsToTimelineInputs', () => {
	it('preserves source-array order and local ordinals while defensively omitting missing descriptors', () => {
		const inputs = mapCatalogArtistAlbumsToTimelineInputs(response());

		expect(inputs.map(({ title }) => title)).toEqual([
			'Homogenic',
			'Vespertine',
			'Ambiguous Edition'
		]);
		expect(inputs.map(({ placement }) => placement.ordinal)).toEqual([0, 1, 3]);
		expect(inputs[0]).toMatchObject({
			localId: '20000000-0000-4000-8000-000000000001',
			artist: 'Björk',
			imageKeyHint: 'homogenic-image',
			placement: { kind: 'calendar', year: 1997 }
		});
	});

	it('keeps edition-only evidence Undated and labels ambiguous resolution honestly', () => {
		const inputs = mapCatalogArtistAlbumsToTimelineInputs(response());

		expect(inputs[1].placement).toEqual({
			kind: 'undated',
			ordinal: 1,
			label: 'Undated',
			reason: 'no-proven-original-release-date'
		});
		expect(inputs[2].placement).toEqual({
			kind: 'undated',
			ordinal: 3,
			label: 'Undated',
			reason: 'album-not-resolved'
		});
	});

	it('retains only an explicitly selected missing descriptor as a recovery anchor', () => {
		const inputs = mapCatalogArtistAlbumsToTimelineInputs(response(), {
			retainMissingLocalId: missingAlbum().localId
		});

		expect(inputs.map(({ title }) => title)).toEqual([
			'Homogenic',
			'Vespertine',
			'Historical Missing',
			'Ambiguous Edition'
		]);
		expect(inputs[2]).toMatchObject({
			localId: missingAlbum().localId,
			placement: {
				kind: 'undated',
				ordinal: 2,
				reason: 'album-not-resolved'
			}
		});
	});

	it('fails closed when an album cannot derive a valid placement', () => {
		const invalid = {
			...response(),
			albums: [{ ...originalDatedAlbum(), localId: 'not-a-local-id' }]
		} as unknown as CatalogArtistAlbumsResponse;

		expect(() => mapCatalogArtistAlbumsToTimelineInputs(invalid)).toThrow(
			'Catalog album has no valid Timeline placement'
		);
	});
});
