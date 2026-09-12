import { describe, expect, it } from 'vitest';
import type { FavoriteEntry } from '@shared/types';
import type { LibraryAlbumTrack } from '@shared/libraryAlbumContracts';
import type { LibraryAlbumEntry, LibraryArtistEntry } from '../libraryEntries';
import { albumTrackBookmarkPayload, bookmarkPayload, bookmarkSearchQuery, resolveBookmarkTarget } from '../bookmarks';

const artist = (name: string, id = 'artist'): LibraryArtistEntry => ({ id, name, searchKey: name });
const album = (title: string, credit: string, id = 'album'): LibraryAlbumEntry => ({ id, title, artist: credit, searchKey: title });
const saved = (type: FavoriteEntry['type'], title: string, credit?: string): FavoriteEntry => ({
	id: 'saved', type, title, ...(credit === undefined ? {} : { artist: credit }), added_at: '2026-09-11T00:00:00Z'
});

describe('bookmarkPayload', () => {
	it('retains numeric titles and supplied credits without storing live authority', () => {
		const metadata = { title: '1. Outside', artist: 'David Bowie', album: '1. Outside', imageKey: 'image', itemKey: 'live-action', liveRef: { generation: 'old' } };
		expect(bookmarkPayload('track', metadata)).toEqual({
			type: 'track', title: '1. Outside', artist: 'David Bowie', album: '1. Outside', image_key: 'image'
		});
	});
	it('omits blank or absent optional metadata, preserving punctuation and text', () => {
		expect(bookmarkPayload('artist', { title: '!!!', artist: ' ', album: null, imageKey: undefined })).toEqual({ type: 'artist', title: '!!!' });
		expect(bookmarkPayload('album', { title: ' 1999 ', artist: ' Prince ' })).toEqual({ type: 'album', title: ' 1999 ', artist: ' Prince ' });
	});
});

describe('albumTrackBookmarkPayload', () => {
	const context = { album: 'The Album', artist: 'The Artist', imageKey: 'art' };
	it.each([
		{ index: 18, title: '7. Song' },
		{ index: 18, title: '2-7 Song' },
		{ index: 18, title: '2-7. Song' },
		{ index: 18, title: '007. 1999' },
		{ index: 0, title: '1. Outside' },
		{ index: 0, title: '1999' },
		{ index: 0, title: '1 Love' },
		{ index: 0, title: '1. ' }
	] satisfies LibraryAlbumTrack[])('preserves the exact public title in %j without saving array position', (track) => {
		expect(albumTrackBookmarkPayload(track, context)).toEqual({
			type: 'track', title: track.title, album: 'The Album', artist: 'The Artist', image_key: 'art'
		});
	});
});

describe('bookmarkSearchQuery', () => {
	it.each(['3. UGH!', '1-3. UGH!', '1-3 UGH!'])('searches the song words for album display title %s without changing the saved title', title => {
		const bookmark = { ...saved('track', title), album: 'The Album' };
		expect(bookmarkSearchQuery(bookmark)).toBe('UGH!');
		expect(bookmark.title).toBe(title);
	});
	it('keeps non-album tracks and entity names intact, and never auto-resolves a track', () => {
		expect(bookmarkSearchQuery(saved('track', '1. Outside'))).toBe('1. Outside');
		expect(bookmarkSearchQuery(saved('album', '1. Outside'))).toBe('1. Outside');
		expect(bookmarkSearchQuery({ ...saved('track', '1999'), album: '1999' })).toBe('1999');
		expect(resolveBookmarkTarget({ ...saved('track', '1. Outside'), album: 'Outside' }, {
			phase: 'ready', artists: [], albums: [album('Outside', 'Artist')]
		})).toBeNull();
	});
});

describe('resolveBookmarkTarget', () => {
	it('returns the exact current artist object after normalization only', () => {
		const entry = artist('Björk');
		expect(resolveBookmarkTarget(saved('artist', ' BJÖRK '), { phase: 'ready', artists: [entry], albums: [] })).toEqual({ kind: 'artist', entry });
		expect(resolveBookmarkTarget(saved('artist', ' BJÖRK '), { phase: 'ready', artists: [entry], albums: [] })?.entry).toBe(entry);
	});
	it('never chooses an arbitrary duplicate artist or drops leading articles', () => {
		const roots = { phase: 'ready' as const, artists: [artist('The Band'), artist('The Band', 'other')], albums: [] };
		expect(resolveBookmarkTarget(saved('artist', 'The Band'), roots)).toBeNull();
		expect(resolveBookmarkTarget(saved('artist', 'Band'), { ...roots, artists: [roots.artists[0]] })).toBeNull();
	});
	it('requires exact album credit when the saved entry carries it', () => {
		const expected = album('Greatest Hits', 'Queen');
		const roots = { phase: 'ready' as const, artists: [], albums: [album('Greatest Hits', 'ABBA'), expected] };
		const target = resolveBookmarkTarget(saved('album', 'greatest  hits', ' QUEEN '), roots);
		expect(target).toEqual({ kind: 'album', entry: expected });
		expect(target?.entry).toBe(expected);
		expect(resolveBookmarkTarget(saved('album', 'Greatest Hits', 'Queen & David Bowie'), roots)).toBeNull();
	});
	it('requires one album match even with no saved artist or duplicate exact metadata', () => {
		const entry = album('Greatest Hits', 'Queen');
		const roots = { phase: 'ready' as const, artists: [], albums: [entry] };
		expect(resolveBookmarkTarget(saved('album', 'Greatest Hits'), roots)?.entry).toBe(entry);
		expect(resolveBookmarkTarget(saved('album', 'Greatest Hits'), { ...roots, albums: [entry, album('Greatest Hits', 'ABBA')] })).toBeNull();
		expect(resolveBookmarkTarget(saved('album', 'Greatest Hits', 'Queen'), { ...roots, albums: [entry, album('Greatest Hits', 'Queen', 'duplicate')] })).toBeNull();
	});
	it.each(['idle', 'loading', 'unavailable', 'error'] as const)('rejects retained rows while roots are %s', (phase) => {
		expect(resolveBookmarkTarget(saved('album', 'Album', 'Artist'), { phase, artists: [], albums: [album('Album', 'Artist')] })).toBeNull();
	});
	it('keeps tracks, missing entries, and blank titles on the explicit search path', () => {
		const roots = { phase: 'ready' as const, artists: [artist('Song')], albums: [album('Song', 'Artist')] };
		expect(resolveBookmarkTarget(saved('track', 'Song', 'Artist'), roots)).toBeNull();
		expect(resolveBookmarkTarget(saved('artist', 'Missing'), roots)).toBeNull();
		expect(resolveBookmarkTarget(saved('artist', ' '), { ...roots, artists: [artist(' ')] })).toBeNull();
	});
});
