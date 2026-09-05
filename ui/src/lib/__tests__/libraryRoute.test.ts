import { describe, expect, it } from 'vitest';
import {
	decodeLibraryRoute,
	encodeLibraryRoute,
	type LibraryRoute,
	type LibraryRouteAlbum
} from '../libraryRoute';

const ORIGIN = 'https://songr.test';
const HOSTILE = "Björk / A;B? C#D&E=F%G+H'()*";
const ALBUM: LibraryRouteAlbum = {
	title: `Signals; ${HOSTILE}`,
	credit: `’Til Tuesday / ${HOSTILE}`,
	edition: ''
};
const EDITION: LibraryRouteAlbum = { ...ALBUM, edition: `Édition; +/% ${HOSTILE}` };

function decode(path: string): LibraryRoute | null {
	return decodeLibraryRoute(new URL(path, ORIGIN));
}

describe('Library route codec', () => {
	const routes: readonly LibraryRoute[] = [
		{ kind: 'root', scope: 'artists' },
		{ kind: 'root', scope: 'albums' },
		{ kind: 'root', scope: 'genres' },
		{ kind: 'root', scope: 'favorites' },
		{ kind: 'root', scope: 'recently-played' },
		{ kind: 'root', scope: 'most-played' },
		{ kind: 'root', scope: 'playlists' },
		{ kind: 'root', scope: 'recently-added' },
		{ kind: 'root', scope: 'surprise' },
		{ kind: 'artist-filter', filter: HOSTILE },
		{ kind: 'artist', artist: HOSTILE },
		{ kind: 'artist-album', artist: HOSTILE, album: ALBUM },
		{ kind: 'artist-album-track', artist: HOSTILE, album: EDITION, track: HOSTILE },
		{ kind: 'album', album: ALBUM },
		{ kind: 'album-track', album: EDITION, track: HOSTILE },
		{ kind: 'genre', genre: HOSTILE },
		{ kind: 'genre-album', genre: HOSTILE, album: ALBUM },
		{ kind: 'genre-album', genre: 'path', album: ALBUM },
		{ kind: 'genre-album-track', genre: HOSTILE, album: EDITION, track: HOSTILE },
		{ kind: 'composer', composer: HOSTILE },
		{ kind: 'composition', composer: HOSTILE, composition: HOSTILE },
		{ kind: 'composition', composer: 'path', composition: 'Opening' },
		{
			kind: 'live-path',
			path: {
				origin: 'genres',
				steps: [
					{ kind: 'genre', title: HOSTILE },
					{ kind: 'section', title: 'Albums' },
					{ kind: 'genre', title: 'Nested / genre' },
					{ kind: 'section', title: 'Artists' },
					{ kind: 'artist', title: 'Björk' },
					{ kind: 'album', title: '', credit: '', edition: '' },
					{ kind: 'entry', title: 'Generic; entry' }
				]
			}
		},
		{
			kind: 'live-path',
			path: {
				origin: 'composers',
				steps: [
					{ kind: 'composer', title: HOSTILE },
					{ kind: 'composition', title: 'Night; Windows' },
					{ kind: 'track', title: 'Recording / I' }
				]
			}
		},
		{ kind: 'browse', steps: [], search: null },
		{
			kind: 'browse',
			steps: [
				{ title: HOSTILE, subtitle: '12 results', itemType: 'Albums' },
				{ title: '.', searchCategory: true },
				{ title: '..' }
			],
			search: null
		},
		{
			kind: 'browse',
			steps: [{ title: HOSTILE }, { title: 'Deep child', subtitle: HOSTILE }],
			search: HOSTILE
		}
	];

	it.each(routes.map((route) => [route.kind, route] as const))(
		'round-trips every constructible %s variant',
		(_kind, route) => {
			const encoded = encodeLibraryRoute(route);
			expect(decode(encoded)).toEqual(route);
			expect(encoded).not.toContain(HOSTILE);
		}
	);

	it('uses the specified album tuple segment and terminal search query', () => {
		expect(
			encodeLibraryRoute({
				kind: 'artist-album',
				artist: 'A/B',
				album: { title: 'T;T', credit: 'C?', edition: '' }
			})
		).toBe('/library/artists/A%2FB/T%3BT;C%3F;');
		expect(
			encodeLibraryRoute({ kind: 'browse', steps: [{ title: 'A/B' }], search: 'x+y z' })
		).toBe(
			'/library/browse/A%2FB;;;0?search=x%2By%20z'
		);
	});

	it('encodes artist smart filters in a strict query', () => {
		expect(encodeLibraryRoute({ kind: 'artist-filter', filter: '>30 albums & favorites' })).toBe(
			'/library/artists?filter=%3E30%20albums%20%26%20favorites'
		);
	});

	it('encodes every live path step as four strict fields', () => {
		expect(
			encodeLibraryRoute({
				kind: 'live-path',
				path: {
					origin: 'genres',
					steps: [
						{ kind: 'genre', title: 'Jazz' },
						{ kind: 'section', title: 'Albums' },
						{ kind: 'album', title: 'A/B', credit: '', edition: '' }
					]
				}
			})
		).toBe('/library/genres/path/genre;Jazz;;/section;Albums;;/album;A%2FB;;');
	});

	it('accepts /library only as an artists-root alias', () => {
		expect(decode('/library')).toEqual({ kind: 'root', scope: 'artists' });
		expect(encodeLibraryRoute(decode('/library')!)).toBe('/library/artists');
	});

	it.each([
		'/other',
		'/library/unknown',
		'/library/artists/%',
		'/library/artists/name/title;credit',
		'/library/artists/name/title;credit;edition/track/extra',
		'/library/albums/;credit;',
		'/library/genres/name/title;credit;edition/track/extra',
		'/library/genres/path/genre;Jazz;;/section;Albums;',
		'/library/genres/path/genre;Jazz;;/section;Albums;credit;',
		'/library/genres/path/genre;Jazz;;/action;Play;;',
		'/library/genres/path/artist;Miles;;/section;Albums;;',
		'/library/genres/path/genre;Jazz;;/section;Albums;;?extra=x',
		'/library/composers/path/composer;Glass;;/composition;Opening;;#fragment',
		'/library/composers/Mara/Glass;Mara;',
		'/library/composers/name/composition/extra',
		'/library/browse/one//two',
		'/library/browse/one?search=',
		'/library/browse/one?search=x&extra=y',
		'/library/artists/name?search=x',
		'/library/artists?filter=',
		'/library/artists?filter=x&extra=y',
		'/library/artists#fragment'
	])('rejects a malformed or partially understood address: %s', (path) => {
		expect(decode(path)).toBeNull();
	});

	it('rejects controls, overlong values, and impossible constructed routes', () => {
		expect(decode('/library/artists/%00')).toBeNull();
		expect(decode(`/library/artists/${'x'.repeat(1_025)}`)).toBeNull();
		expect(() => encodeLibraryRoute({ kind: 'artist', artist: '' })).toThrow(TypeError);
		expect(() =>
			encodeLibraryRoute({ kind: 'browse', steps: [{ title: 'ok' }], search: 'bad\nquery' })
		).toThrow(TypeError);
		expect(() =>
			encodeLibraryRoute({
				kind: 'live-path',
				path: {
					origin: 'genres',
					steps: [{ kind: 'genre', title: 'only one step' }]
				}
			})
		).toThrow(TypeError);
		expect(() =>
			encodeLibraryRoute({
				kind: 'live-path',
				path: {
					origin: 'genres',
					steps: [
						{ kind: 'genre', title: 'Jazz' },
						{ kind: 'action', title: 'Play' }
					]
				}
			})
		).toThrow(TypeError);
		expect(() =>
			encodeLibraryRoute({
				kind: 'live-path',
				path: {
					origin: 'composers',
					steps: [
						{ kind: 'composer', title: 'Glass' },
						{ kind: 'composition', title: 'Opening', credit: 'not allowed' }
					]
				}
			})
		).toThrow(TypeError);
		expect(() =>
			encodeLibraryRoute({
				kind: 'live-path',
				path: {
					origin: 'genres',
					steps: [
						{ kind: 'genre', title: 'Jazz' },
						...Array.from({ length: 64 }, () => ({ kind: 'entry' as const, title: 'x' }))
					]
				}
			})
		).toThrow(TypeError);
	});
});
