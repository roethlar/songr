import { describe, expect, it } from 'vitest';
import {
	libraryPageStateFromRoute,
	libraryParentPageState,
	libraryRouteFromPageState
} from '../libraryRouteState';
import type { LibraryRoute } from '../libraryRoute';


const album = { title: 'Glass; Houses', credit: 'Mara / Ensemble', edition: '' };
const edition = { ...album, edition: 'Édition + 2' };

describe('Library route activation state', () => {
	const routes: readonly LibraryRoute[] = [
		{ kind: 'root', scope: 'artists' },
		{ kind: 'root', scope: 'favorites' },
		{ kind: 'artist-filter', filter: '>30 albums' },
		{ kind: 'artist', artist: 'Mara' },
		{ kind: 'artist-album', artist: 'Mara', album },
		{ kind: 'album', album },
		{ kind: 'genre', genre: 'New / Music' },
		{ kind: 'genre-album', genre: 'New / Music', album },
		{ kind: 'composer', composer: 'Mara' },
		{ kind: 'composition', composer: 'Mara', composition: 'Night; Windows' },
		{
			kind: 'live-path',
			path: {
				origin: 'genres',
				steps: [
					{ kind: 'genre', title: 'New / Music' },
					{ kind: 'section', title: 'Artists' },
					{ kind: 'artist', title: 'Mara' }
				]
			}
		},
		{
			kind: 'live-path',
			path: {
				origin: 'composers',
				steps: [
					{ kind: 'composer', title: 'Mara' },
					{ kind: 'composition', title: 'Night; Windows' },
					{ kind: 'track', title: 'Finale' }
				]
			}
		},
		{ kind: 'browse', steps: [], search: null },
		{
			kind: 'browse',
			steps: [
				{ title: 'Albums', subtitle: '12 results', itemType: 'Albums', searchCategory: true },
				{ title: 'Glass Houses', subtitle: 'Mara', itemType: 'album' }
			],
			search: 'Mara + Glass'
		}
	];

	it.each(routes.map((route) => [route.kind, route] as const))(
		'preserves the durable %s route through transient mode state',
		(_kind, route) => {
			expect(libraryRouteFromPageState(libraryPageStateFromRoute(route))).toEqual(route);
		}
	);


	it.each([
		[{ kind: 'album-track', album, track: 'Finale' }, { kind: 'album', album }],
		[{ kind: 'artist-album-track', artist: 'Mara', album, track: 'Finale' }, { kind: 'artist-album', artist: 'Mara', album }],
		[{ kind: 'genre-album-track', genre: 'New / Music', album, track: 'Finale' }, { kind: 'genre-album', genre: 'New / Music', album }],
		[{ kind: 'credit-album-track', selector: { kind: 'credit', credit: album.credit }, album, track: 'Finale' },
		 { kind: 'credit-album', selector: { kind: 'credit', credit: album.credit }, album }]
	] satisfies readonly (readonly [LibraryRoute, LibraryRoute])[])(
		'migrates retired Track Info route %j to its album without losing its origin',
		(route, parent) => {
			const restored = libraryPageStateFromRoute(route);
			expect(restored.snapshot.itemDetail).toBeNull();
			expect(libraryRouteFromPageState(restored)).toEqual(parent);
		}
	);

	it.each(['recently-added', 'most-played', 'playlists'] as const)(
		'migrates retired %s root to Albums', scope => {
			const state = libraryPageStateFromRoute({ kind: 'root', scope });
			expect(state.snapshot.scope).toBe('albums');
			expect(libraryRouteFromPageState(state)).toEqual({ kind: 'root', scope: 'albums' });
		}
	);

	it('keeps an album edition on the live path when it is nonempty', () => {
		const state = libraryPageStateFromRoute({ kind: 'album', album: edition });
		expect(state.snapshot.itemTarget).toEqual({
			kind: 'live',
			path: {
				origin: 'albums',
				steps: [
					{
						kind: 'album',
						title: album.title,
						credit: album.credit,
						edition: edition.edition
					}
				]
			}
		});
	});

	it('keeps every structural step when restoring a fallback path', () => {
		const route: LibraryRoute = {
			kind: 'live-path',
			path: {
				origin: 'genres',
				steps: [
					{ kind: 'genre', title: 'Jazz' },
					{ kind: 'section', title: 'Albums' },
					{ kind: 'genre', title: 'Modal' },
					{ kind: 'section', title: 'Artists' },
					{ kind: 'artist', title: 'Miles Davis' }
				]
			}
		};
		const state = libraryPageStateFromRoute(route);

		expect(state.snapshot.itemTarget).toEqual({ kind: 'live', path: route.path });
		expect(libraryRouteFromPageState(state)).toEqual(route);
	});

	it('migrates an old album-track fallback to its existing album parent', () => {
		const route: LibraryRoute = {
			kind: 'live-path',
			path: {
				origin: 'composers',
				steps: [
					{ kind: 'composer', title: 'Mara' },
					{ kind: 'composition', title: 'Night; Windows' },
					{ kind: 'album', title: album.title, credit: album.credit, edition: album.edition },
					{ kind: 'track', title: 'Finale' }
				]
			}
		};
		const state = libraryPageStateFromRoute(route);

		expect(state.snapshot.itemTarget).toEqual({
			kind: 'live',
			path: { origin: 'composers', steps: route.path.steps.slice(0, -1) }
		});
		expect(state.snapshot.itemDetail).toBeNull();
		expect(libraryRouteFromPageState(state)).toEqual({ ...route, path: { ...route.path, steps: route.path.steps.slice(0, -1) } });
	});

	it.each([
		[
			{ kind: 'artist' as const, artist: 'Mara' },
			{ kind: 'root' as const, scope: 'artists' as const }
		],
		[
			{ kind: 'artist-album' as const, artist: 'Mara', album },
			{ kind: 'artist' as const, artist: 'Mara' }
		],
		[
			{ kind: 'artist-album-track' as const, artist: 'Mara', album, track: 'Finale' },
			{ kind: 'artist' as const, artist: 'Mara' }
		],
		[
			{ kind: 'genre' as const, genre: 'New / Music' },
			{ kind: 'root' as const, scope: 'genres' as const }
		],
		[
			{ kind: 'genre-album' as const, genre: 'New / Music', album },
			{
				kind: 'live-path' as const,
				path: {
					origin: 'genres' as const,
					steps: [
						{ kind: 'genre' as const, title: 'New / Music' },
						{ kind: 'section' as const, title: 'Albums' }
					]
				}
			}
		],
		[
			{ kind: 'composition' as const, composer: 'Mara', composition: 'Night; Windows' },
			{ kind: 'composer' as const, composer: 'Mara' }
		],
		[
			{ kind: 'composer' as const, composer: 'Mara' },
			{ kind: 'browse' as const, steps: [], search: null }
		],
		[
			{
				kind: 'live-path' as const,
				path: {
					origin: 'composers' as const,
					steps: [
						{ kind: 'composer' as const, title: 'Mara' },
						{ kind: 'composition' as const, title: 'Night; Windows' },
						{ kind: 'track' as const, title: 'Recording I' }
					]
				}
			},
			{ kind: 'composition' as const, composer: 'Mara', composition: 'Night; Windows' }
		]
	] satisfies readonly (readonly [LibraryRoute, LibraryRoute])[])(
		'derives the semantic parent of $kind without browser history',
		(route, parent) => {
			const parentState = libraryParentPageState(libraryPageStateFromRoute(route));
			expect(parentState).not.toBeNull();
			expect(libraryRouteFromPageState(parentState!)).toEqual(parent);
		}
	);

	it('has no parent above a Library root', () => {
		expect(
			libraryParentPageState(libraryPageStateFromRoute({ kind: 'root', scope: 'albums' }))
		).toBeNull();
	});
});
