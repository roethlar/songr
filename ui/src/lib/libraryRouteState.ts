import {
	buildUnifiedLibraryPageState,
	buildUnifiedRootPageState,
	normalizeLibraryScope,
	type BrowseBreadcrumb,
	type UnifiedLibraryPageState
} from '$lib/libraryPageState';
import {
	libraryAlbumStep,
	type LibraryPathStep,
	type LibraryRenderingPath
} from '$lib/library/liveLibraryPath';
import {
	LIBRARY_ROOT_ROUTE_SCOPES,
	decodeLibraryRoute,
	LIBRARY_ROUTE_STEPS_MAX,
	type LibraryRootRouteScope,
	type LibraryRoute,
	type LibraryRouteAlbum,
	type LibraryRouteBrowseStep,
	type LibraryRouteLivePath
} from '$lib/libraryRoute';
import { albumCreditMatches, type ArtistView } from '$lib/albumArtistGroups';

/** Preferences apply only to unaddressed entry; existing URLs always win. */
export function libraryEntryPageState(url: URL, artistView: ArtistView): UnifiedLibraryPageState {
	const bare = (url.pathname === '/library' || url.pathname === '/library/') &&
		url.search === '' && url.hash === '';
	const route = bare && artistView === 'album-artists'
		? { kind: 'album-artists-root' as const } : decodeLibraryRoute(url);
	return route === null ? buildUnifiedRootPageState() : libraryPageStateFromRoute(route);
}

function livePageState(
	scope: UnifiedLibraryPageState['snapshot']['scope'],
	path: LibraryRenderingPath
): UnifiedLibraryPageState {
	return buildUnifiedLibraryPageState({
		scope,
		collectionDrill: null,
		itemTarget: { kind: 'live', path },
		filterText: '',
		surpriseSeed: null
	});
}

function routeAlbumStep(album: LibraryRouteAlbum): LibraryPathStep {
	return libraryAlbumStep(album.title, album.credit, album.edition);
}

function albumOf(step: LibraryPathStep | undefined): LibraryRouteAlbum | null {
	return step?.kind === 'album' && step.credit !== undefined
		? { title: step.title, credit: step.credit, edition: step.edition ?? '' }
		: null;
}

function browseBreadcrumb(step: LibraryRouteBrowseStep): BrowseBreadcrumb {
	return {
		title: step.title,
		...(step.subtitle === undefined ? {} : { subtitle: step.subtitle }),
		...(step.itemType === undefined ? {} : { itemType: step.itemType }),
		...(step.searchCategory === true ? { searchCategory: true as const } : {})
	};
}

/** Build activation state; retired Track Info URLs restore their exact album parent. */
export function libraryPageStateFromRoute(route: LibraryRoute): UnifiedLibraryPageState {
	switch (route.kind) {
		case 'root':
			return buildUnifiedRootPageState(normalizeLibraryScope(route.scope) ?? 'artists');
		case 'album-artists-root':
		case 'credit-group':
		case 'credit-album':
		case 'credit-album-track':
			return buildUnifiedLibraryPageState({
				scope: 'artists', artistView: 'album-artists',
				albumCredit: route.kind === 'album-artists-root' ? null : route.selector,
				collectionDrill: null, filterText: '', surpriseSeed: null,
				itemTarget: route.kind === 'credit-album' || route.kind === 'credit-album-track'
					? { kind: 'live', path: { origin: 'albums', steps: [routeAlbumStep(route.album)] } } : null
			});
		case 'artist-filter':
			return buildUnifiedLibraryPageState({
				scope: 'artists',
				collectionDrill: null,
				itemTarget: null,
				filterText: route.filter,
				surpriseSeed: null
			});
		case 'artist':
			return livePageState('artists', {
				origin: 'artists',
				steps: [{ kind: 'artist', title: route.artist }]
			});
		case 'artist-album':
		case 'artist-album-track':
			return livePageState(
				'artists',
				{
					origin: 'artists',
					steps: [
						{ kind: 'artist', title: route.artist },
						routeAlbumStep(route.album)
					]
				}
			);
		case 'album':
		case 'album-track':
			return livePageState(
				'albums',
				{ origin: 'albums', steps: [routeAlbumStep(route.album)] }
			);
		case 'genre':
			return livePageState('genres', {
				origin: 'genres',
				steps: [{ kind: 'genre', title: route.genre }]
			});
		case 'genre-album':
		case 'genre-album-track':
			return livePageState(
				'genres',
				{
					origin: 'genres',
					steps: [
						{ kind: 'genre', title: route.genre },
						{ kind: 'section', title: 'Albums' },
						routeAlbumStep(route.album)
					]
				}
			);
		case 'composer':
			return livePageState('browse', {
				origin: 'composers',
				steps: [{ kind: 'composer', title: route.composer }]
			});
		case 'composition':
			return livePageState('browse', {
				origin: 'composers',
				steps: [
					{ kind: 'composer', title: route.composer },
					{ kind: 'composition', title: route.composition }
				]
			});
		case 'live-path': {
			const last = route.path.steps.at(-1);
			const parent = route.path.steps.at(-2);
			const albumTrack = last?.kind === 'track' && parent?.kind === 'album';
			return livePageState(
				route.path.origin === 'genres' ? 'genres' : 'browse',
				{
					origin: route.path.origin,
					steps: albumTrack ? route.path.steps.slice(0, -1) : route.path.steps
				}
			);
		}
		case 'browse': {
			const hierarchy = route.search === null ? 'browse' : 'search';
			return buildUnifiedLibraryPageState({
				scope: 'browse',
				collectionDrill: null,
				itemTarget: null,
				filterText: '',
				surpriseSeed: null,
				browseHistory: {
					context:
						route.search === null
							? { hierarchy: 'browse' }
							: { hierarchy: 'search', query: route.search },
					history: route.steps.map((step) => ({
						hierarchy,
						breadcrumb: browseBreadcrumb(step)
					})),
					forward: []
				}
			});
		}
	}
}

function browseStep(breadcrumb: BrowseBreadcrumb): LibraryRouteBrowseStep {
	return {
		title: breadcrumb.title,
		...(breadcrumb.subtitle === undefined ? {} : { subtitle: breadcrumb.subtitle }),
		...(breadcrumb.itemType === undefined ? {} : { itemType: breadcrumb.itemType }),
		...(breadcrumb.searchCategory === true ? { searchCategory: true as const } : {})
	};
}

function fallbackLivePath(
	path: LibraryRenderingPath
): Extract<LibraryRoute, { kind: 'live-path' }> | null {
	if (path.origin !== 'genres' && path.origin !== 'composers') return null;
	const steps = path.steps;
	if (
		steps.length < 2 ||
		steps.length > LIBRARY_ROUTE_STEPS_MAX ||
		steps.some((step) => step.kind === 'action')
	) {
		return null;
	}
	return {
		kind: 'live-path',
		path: { origin: path.origin as LibraryRouteLivePath['origin'], steps }
	};
}

function routeFromLivePath(
	path: LibraryRenderingPath
): LibraryRoute | null {
	if (path.origin === 'artists') {
		const artist = path.steps[0];
		if (artist?.kind !== 'artist' || path.steps.length > 2) return null;
		if (path.steps.length === 1) {
			return { kind: 'artist', artist: artist.title };
		}
		const album = albumOf(path.steps[1]);
		return album === null
			? null
			: { kind: 'artist-album', artist: artist.title, album };
	}
	if (path.origin === 'albums') {
		if (path.steps.length !== 1) return null;
		const album = albumOf(path.steps[0]);
		return album === null ? null : { kind: 'album', album };
	}
	if (path.origin === 'genres') {
		const genre = path.steps[0];
		if (genre?.kind !== 'genre') return null;
		if (path.steps.length === 1) {
			return { kind: 'genre', genre: genre.title };
		}
		const section = path.steps[1];
		const album = path.steps.length === 3 ? albumOf(path.steps[2]) : null;
		return section?.kind === 'section' && section.title === 'Albums' && album !== null
			? { kind: 'genre-album', genre: genre.title, album }
			: fallbackLivePath(path);
	}
	const composer = path.steps[0];
	if (composer?.kind !== 'composer') return null;
	if (path.steps.length === 1) {
		return { kind: 'composer', composer: composer.title };
	}
	const composition = path.steps[1];
	if (path.steps.length === 2 && composition?.kind === 'composition') {
		return { kind: 'composition', composer: composer.title, composition: composition.title };
	}
	return fallbackLivePath(path);
}

/** Derive a durable URL route from the mode's current semantic state. */
export function libraryRouteFromPageState(state: UnifiedLibraryPageState): LibraryRoute | null {
	const snapshot = state.snapshot;
	// Credit context is a display filter over Albums, not an Artists path.
	// Resolve it before the generic live branch so an album keeps its parent.
	if (snapshot.artistView === 'album-artists') {
		if (snapshot.scope !== 'artists' || snapshot.collectionDrill !== null ||
			snapshot.filterText !== '' || snapshot.composition !== null) return null;
		const selector = snapshot.albumCredit;
		if (snapshot.itemTarget === null) {
			return selector === null ? { kind: 'album-artists-root' } : { kind: 'credit-group', selector };
		}
		if (selector === null || snapshot.itemTarget.kind !== 'live' ||
			snapshot.itemTarget.path.origin !== 'albums' || snapshot.itemTarget.path.steps.length !== 1) return null;
		const album = albumOf(snapshot.itemTarget.path.steps[0]);
		return album !== null && albumCreditMatches(selector, album.credit)
			? { kind: 'credit-album', selector, album } : null;
	}
	if (snapshot.albumCredit !== null) return null;
	if (snapshot.itemTarget?.kind === 'live') {
		return routeFromLivePath(snapshot.itemTarget.path);
	}
	if (snapshot.itemTarget?.kind === 'collection') {
		const locator = snapshot.itemTarget.locator;
		const album: LibraryRouteAlbum = {
			title: locator.rendering.exactTitle,
			credit: locator.rendering.exactCredit,
			edition: ''
		};
		if (locator.hierarchy === 'artists') {
			return { kind: 'artist-album', artist: locator.collectionExactName, album };
		}
		if (locator.hierarchy === 'genres') {
			return { kind: 'genre-album', genre: locator.collectionExactName, album };
		}
		return null;
	}
	if (snapshot.itemTarget !== null) return null;
	if (snapshot.filterText !== '') {
		return snapshot.scope === 'artists' &&
			snapshot.collectionDrill === null &&
			snapshot.composition === null
			? { kind: 'artist-filter', filter: snapshot.filterText }
			: null;
	}

	if (snapshot.collectionDrill?.kind === 'genre') {
		return { kind: 'genre', genre: snapshot.collectionDrill.label };
	}
	if (snapshot.collectionDrill?.kind === 'composer') {
		return snapshot.composition?.title
			? {
					kind: 'composition',
					composer: snapshot.collectionDrill.label,
					composition: snapshot.composition.title
				}
			: { kind: 'composer', composer: snapshot.collectionDrill.label };
	}

	if (snapshot.scope === 'browse') {
		return {
			kind: 'browse',
			steps: snapshot.browseHistory.history.map((step) => browseStep(step.breadcrumb)),
			search:
				snapshot.browseHistory.context.hierarchy === 'search'
					? snapshot.browseHistory.context.query
					: null
		};
	}

	return snapshot.composition === null &&
		(LIBRARY_ROOT_ROUTE_SCOPES as readonly string[]).includes(snapshot.scope)
		? { kind: 'root', scope: snapshot.scope as LibraryRootRouteScope }
		: null;
}

/**
 * The durable semantic parent of one Library page.
 *
 * This is intentionally state/route logic rather than DOM logic: a restored
 * entry has no history ownership, so its Back control replaces that entry with
 * this parent and renders it without guessing what sits before the entry.
 */
export function libraryParentPageState(
	state: UnifiedLibraryPageState
): UnifiedLibraryPageState | null {
	const snapshot = state.snapshot;
	if (snapshot.itemTarget?.kind === 'live') {
		const steps = snapshot.itemTarget.path.steps;
		return steps.length > 1
			? buildUnifiedLibraryPageState({
					...snapshot,
					itemTarget: {
						kind: 'live',
						path: { ...snapshot.itemTarget.path, steps: steps.slice(0, -1) }
					},
					itemOriginName: null
				})
			: buildUnifiedLibraryPageState({
					...snapshot,
					itemTarget: null,
					itemOriginName: null
				});
	}
	if (snapshot.itemTarget?.kind === 'collection') {
		return buildUnifiedLibraryPageState({
			...snapshot,
			itemTarget: null,
			itemOriginName: null
		});
	}
	if (snapshot.albumCredit !== null) {
		return buildUnifiedLibraryPageState({ ...snapshot, albumCredit: null });
	}
	if (snapshot.composition !== null) {
		return buildUnifiedLibraryPageState({
			...snapshot,
			composition: snapshot.composition.title === null ? null : { title: null }
		});
	}
	if (snapshot.collectionDrill !== null) {
		return buildUnifiedLibraryPageState({ ...snapshot, collectionDrill: null });
	}
	if (snapshot.filterText !== '') {
		return buildUnifiedRootPageState('artists');
	}
	return null;
}
