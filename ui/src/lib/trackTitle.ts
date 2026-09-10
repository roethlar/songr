import type { LibraryAlbumTrack } from '@shared/libraryAlbumContracts';

/** Show only explicit track-number metadata, without duplicating Roon's title prefix. */
export function albumTrackNumber(track: LibraryAlbumTrack): number | null {
	if (!Number.isSafeInteger(track.trackNumber) || track.trackNumber! < 0) return null;
	if (/^\s*(?:\d+(?:-\d+)?\.\s+|\d+-\d+\s+)/.test(track.title)) return null;
	return track.trackNumber!;
}
