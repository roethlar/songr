import { CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT } from '@shared/timelineCatalogContracts';
import type { TimelineAlbumLayoutInput } from '../types';

export function calendarAlbum(
	id: string,
	year: number,
	ordinal: number,
	options: { image?: boolean; title?: string } = {}
): TimelineAlbumLayoutInput {
	return {
		localId: id,
		title: options.title ?? `Album ${id}`,
		artist: 'Test Artist',
		placement: {
			kind: 'calendar',
			ordinal,
			year,
			evidence: {
				sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
				field: 'original-release-date',
				date: String(year).padStart(4, '0')
			}
		},
		...(options.image ? { imageKeyHint: `image-${id}` } : {})
	};
}

export function undatedAlbum(id: string, ordinal: number): TimelineAlbumLayoutInput {
	return {
		localId: id,
		title: `Album ${id}`,
		artist: 'Test Artist',
		placement: {
			kind: 'undated',
			ordinal,
			label: 'Undated',
			reason: 'no-proven-original-release-date'
		}
	};
}

export function denseAlbums(count: number): TimelineAlbumLayoutInput[] {
	return Array.from({ length: count }, (_, index) =>
		calendarAlbum(`album-${String(index).padStart(5, '0')}`, 1950 + (index % 70), index, {
			image: true
		})
	);
}
