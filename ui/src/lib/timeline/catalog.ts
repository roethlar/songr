import {
	deriveCatalogTimelinePlacement,
	type CatalogArtistAlbumsResponse
} from '@shared/timelineCatalogContracts';
import type { TimelineAlbumLayoutInput } from './types';

export interface TimelineCatalogMappingOptions {
	/** Retain only this missing descriptor as a recovery anchor. */
	readonly retainMissingLocalId?: string;
}

/**
 * Turn a strictly normalized catalog discography into keyless layout inputs.
 * The source-array index is the local chronology ordinal. Production selected-
 * artist responses already omit historical `missing` descriptors; the check
 * below is a defensive boundary for broader catalog responses, not a promise
 * that ordinals survive server-side working-set filtering.
 */
export function mapCatalogArtistAlbumsToTimelineInputs(
	response: CatalogArtistAlbumsResponse,
	options: TimelineCatalogMappingOptions = {}
): TimelineAlbumLayoutInput[] {
	const inputs: TimelineAlbumLayoutInput[] = [];
	response.albums.forEach((album, ordinal) => {
		const placement = deriveCatalogTimelinePlacement(album, ordinal);
		if (!placement) {
			throw new TypeError('Catalog album has no valid Timeline placement');
		}
		if (
			album.resolutionStatus === 'missing' &&
			album.localId !== options.retainMissingLocalId
		) return;
		inputs.push({
			localId: album.localId,
			title: album.exactTitle,
			artist: album.exactArtist,
			placement,
			...(album.imageKeyHint ? { imageKeyHint: album.imageKeyHint } : {})
		});
	});
	return inputs;
}
