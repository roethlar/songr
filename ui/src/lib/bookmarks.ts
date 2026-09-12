import type { AddFavoriteRequest, FavoriteEntry, FavoriteType } from '@shared/types';
import type { LibraryAlbumTrack } from '@shared/libraryAlbumContracts';
import { normalizeLibraryText } from '@shared/libraryText';
import type { LibraryAlbumEntry, LibraryArtistEntry } from './libraryEntries';
import type { LibraryRootsState } from './stores/libraryRootsStore';

export interface BookmarkMetadata {
	title: string;
	artist?: string | null;
	album?: string | null;
	imageKey?: string | null;
}

/** Save display metadata only; live navigation and playback capabilities stay in their owners. */
export function bookmarkPayload(type: FavoriteType, metadata: BookmarkMetadata): AddFavoriteRequest {
	return {
		type,
		title: metadata.title,
		...(metadata.artist?.trim() ? { artist: metadata.artist } : {}),
		...(metadata.album?.trim() ? { album: metadata.album } : {}),
		...(metadata.imageKey?.trim() ? { image_key: metadata.imageKey } : {})
	};
}

/** Keep the exact title Roon returned; list position is not track-number metadata. */
export function albumTrackBookmarkPayload(
	track: LibraryAlbumTrack,
	context: Omit<BookmarkMetadata, 'title'>
): AddFavoriteRequest {
	return bookmarkPayload('track', { ...context, title: track.title });
}

export type BookmarkTarget =
	| { kind: 'artist'; entry: LibraryArtistEntry }
	| { kind: 'album'; entry: LibraryAlbumEntry };

/** Broaden an album track's search terms; this never changes saved identity or picks a result. */
export function bookmarkSearchQuery(bookmark: Pick<FavoriteEntry, 'type' | 'title' | 'album'>): string {
	if (bookmark.type !== 'track' || !bookmark.album?.trim()) return bookmark.title;
	return bookmark.title.replace(/^\s*(?:\d+(?:-\d+)?\.\s+|\d+-\d+\s+)(?=\S)/, '');
}

/** A bookmark is a hint: open a current entity only when its display metadata identifies one row. */
export function resolveBookmarkTarget(
	bookmark: FavoriteEntry,
	roots: Pick<LibraryRootsState, 'phase' | 'artists' | 'albums'>
): BookmarkTarget | null {
	if (roots.phase !== 'ready') return null;
	const title = normalizeLibraryText(bookmark.title);
	if (!title) return null;
	if (bookmark.type === 'artist') {
		let match: LibraryArtistEntry | null = null;
		for (const artist of roots.artists) {
			if (normalizeLibraryText(artist.name) !== title) continue;
			if (match) return null;
			match = artist;
		}
		return match ? { kind: 'artist', entry: match } : null;
	}
	if (bookmark.type === 'album') {
		const credit = bookmark.artist?.trim() ? normalizeLibraryText(bookmark.artist) : null;
		let match: LibraryAlbumEntry | null = null;
		for (const album of roots.albums) {
			if (normalizeLibraryText(album.title) !== title ||
				(credit !== null && normalizeLibraryText(album.artist) !== credit)) continue;
			if (match) return null;
			match = album;
		}
		return match ? { kind: 'album', entry: match } : null;
	}
	return null;
}
