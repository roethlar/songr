/**
 * Durable addresses for the live Library (`library-live-view.md`, Slice 3).
 *
 * A route contains only renderings Roon showed on the same path. It never
 * contains a live reference, item key, catalog id, ordinal, artwork key, or
 * any other value whose meaning can expire with a session or generation.
 */

import { LIBRARY_NODE_KINDS, type LibraryNodeKind } from '@shared/libraryOpenContracts';
import type { LibraryPathStep, LibraryRenderingPath } from '$lib/library/liveLibraryPath';

export const LIBRARY_ROUTE_TEXT_MAX_LENGTH = 1_024;
export const LIBRARY_ROUTE_STEPS_MAX = 64;

export const LIBRARY_ROOT_ROUTE_SCOPES = [
	'artists',
	'albums',
	'genres',
	'favorites',
	'recently-played',
	'most-played',
	'playlists',
	'recently-added',
	'surprise'
] as const;

export type LibraryRootRouteScope = (typeof LIBRARY_ROOT_ROUTE_SCOPES)[number];

/** Every album address carries all three same-surface renderings. */
export interface LibraryRouteAlbum {
	readonly title: string;
	readonly credit: string;
	/** Empty means that Roon rendered no edition text. */
	readonly edition: string;
}

/** Durable, keyless rendering of one row in Roon's Browse hierarchy. */
export interface LibraryRouteBrowseStep {
	readonly title: string;
	readonly subtitle?: string;
	readonly itemType?: string;
	readonly searchCategory?: true;
}

export type LibraryRouteLivePath = Omit<LibraryRenderingPath, 'origin'> & {
	readonly origin: Extract<LibraryRenderingPath['origin'], 'genres' | 'composers'>;
};

export type LibraryRoute =
	| { readonly kind: 'root'; readonly scope: LibraryRootRouteScope }
	| { readonly kind: 'artist-filter'; readonly filter: string }
	| { readonly kind: 'artist'; readonly artist: string }
	| { readonly kind: 'artist-album'; readonly artist: string; readonly album: LibraryRouteAlbum }
	| {
			readonly kind: 'artist-album-track';
			readonly artist: string;
			readonly album: LibraryRouteAlbum;
			readonly track: string;
	  }
	| { readonly kind: 'album'; readonly album: LibraryRouteAlbum }
	| { readonly kind: 'album-track'; readonly album: LibraryRouteAlbum; readonly track: string }
	| { readonly kind: 'genre'; readonly genre: string }
	| { readonly kind: 'genre-album'; readonly genre: string; readonly album: LibraryRouteAlbum }
	| {
			readonly kind: 'genre-album-track';
			readonly genre: string;
			readonly album: LibraryRouteAlbum;
			readonly track: string;
	  }
	| { readonly kind: 'composer'; readonly composer: string }
	| { readonly kind: 'composition'; readonly composer: string; readonly composition: string }
	| { readonly kind: 'live-path'; readonly path: LibraryRouteLivePath }
	| {
			readonly kind: 'browse';
			readonly steps: readonly LibraryRouteBrowseStep[];
			/** Search is terminal context for the path, not a path step. */
			readonly search: string | null;
	  };

function isText(value: string, allowEmpty = false): boolean {
	return (
		value.length <= LIBRARY_ROUTE_TEXT_MAX_LENGTH &&
		(allowEmpty || value.length > 0) &&
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

function requireText(value: string, label: string, allowEmpty = false): string {
	if (!isText(value, allowEmpty)) throw new TypeError(`Invalid Library route ${label}`);
	return value;
}

/**
 * `encodeURIComponent` leaves a few punctuation characters literal. Encoding
 * them too keeps every value visibly separate from route punctuation. A dot
 * segment is encoded because URL parsers otherwise normalize it away.
 */
function encodeSegment(value: string): string {
	const encoded = encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
		`%${character.codePointAt(0)?.toString(16).toUpperCase()}`
	);
	// A URL parser removes even percent-encoded `.` and `..` path segments.
	// The leading `~` makes these two encodings ordinary segments; no other
	// value emitted by this encoder has either exact spelling.
	return encoded === '.' ? '~%2E' : encoded === '..' ? '~%2E%2E' : encoded;
}

function decodeSegment(value: string, allowEmpty = false): string | null {
	if (value.toUpperCase() === '~%2E') return '.';
	if (value.toUpperCase() === '~%2E%2E') return '..';
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return null;
	}
	return isText(decoded, allowEmpty) ? decoded : null;
}

function encodeAlbum(album: LibraryRouteAlbum): string {
	return [
		encodeSegment(requireText(album.title, 'album title')),
		encodeSegment(requireText(album.credit, 'album credit', true)),
		encodeSegment(requireText(album.edition, 'album edition', true))
	].join(';');
}

function decodeAlbum(value: string): LibraryRouteAlbum | null {
	const parts = value.split(';');
	if (parts.length !== 3) return null;
	const title = decodeSegment(parts[0]);
	const credit = decodeSegment(parts[1], true);
	const edition = decodeSegment(parts[2], true);
	return title === null || credit === null || edition === null ? null : { title, credit, edition };
}

function encodeBrowseStep(step: LibraryRouteBrowseStep): string {
	return [
		encodeSegment(requireText(step.title, 'Browse step title')),
		step.subtitle === undefined
			? ''
			: encodeSegment(requireText(step.subtitle, 'Browse step subtitle')),
		step.itemType === undefined
			? ''
			: encodeSegment(requireText(step.itemType, 'Browse step item type')),
		step.searchCategory === true ? '1' : '0'
	].join(';');
}

function decodeBrowseStep(value: string): LibraryRouteBrowseStep | null {
	const parts = value.split(';');
	if (parts.length !== 4 || (parts[3] !== '0' && parts[3] !== '1')) return null;
	const title = decodeSegment(parts[0]);
	const subtitle = parts[1] === '' ? undefined : decodeSegment(parts[1]);
	const itemType = parts[2] === '' ? undefined : decodeSegment(parts[2]);
	if (title === null || subtitle === null || itemType === null) return null;
	return {
		title,
		...(subtitle === undefined ? {} : { subtitle }),
		...(itemType === undefined ? {} : { itemType }),
		...(parts[3] === '1' ? { searchCategory: true as const } : {})
	};
}

type LibraryRouteLiveStepKind = Exclude<LibraryNodeKind, 'action'>;

const LIBRARY_ROUTE_LIVE_STEP_KINDS = LIBRARY_NODE_KINDS.filter(
	(kind): kind is LibraryRouteLiveStepKind => kind !== 'action'
);

function encodeLivePathStep(step: LibraryPathStep): string {
	if (!(LIBRARY_ROUTE_LIVE_STEP_KINDS as readonly string[]).includes(step.kind)) {
		throw new TypeError('Invalid Library route live path kind');
	}
	const title = encodeSegment(requireText(step.title, 'live path title', true));
	if (step.kind === 'album') {
		if (step.credit === undefined || step.edition === undefined) {
			throw new TypeError('Invalid Library route live album rendering');
		}
		return [
			step.kind,
			title,
			encodeSegment(requireText(step.credit, 'live album credit', true)),
			encodeSegment(requireText(step.edition, 'live album edition', true))
		].join(';');
	}
	if (step.credit !== undefined || step.edition !== undefined) {
		throw new TypeError('Invalid Library route non-album rendering');
	}
	return [step.kind, title, '', ''].join(';');
}

function decodeLivePathStep(value: string): LibraryPathStep | null {
	const parts = value.split(';');
	if (parts.length !== 4) return null;
	const kind = parts[0];
	if (!(LIBRARY_ROUTE_LIVE_STEP_KINDS as readonly string[]).includes(kind)) return null;
	const title = decodeSegment(parts[1], true);
	if (title === null) return null;
	if (kind === 'album') {
		const credit = decodeSegment(parts[2], true);
		const edition = decodeSegment(parts[3], true);
		return credit === null || edition === null
			? null
			: { kind, title, credit, edition };
	}
	return parts[2] === '' && parts[3] === ''
		? { kind: kind as LibraryRouteLiveStepKind, title }
		: null;
}

function requireLivePath(path: LibraryRouteLivePath): readonly LibraryPathStep[] {
	if (path.origin !== 'genres' && path.origin !== 'composers') {
		throw new TypeError('Invalid Library route live path origin');
	}
	if (path.steps.length < 2 || path.steps.length > LIBRARY_ROUTE_STEPS_MAX) {
		throw new TypeError('Invalid Library route live path depth');
	}
	const expectedRootKind = path.origin === 'genres' ? 'genre' : 'composer';
	if (path.steps[0]?.kind !== expectedRootKind) {
		throw new TypeError('Invalid Library route live path root');
	}
	return path.steps;
}

function routePath(parts: readonly string[]): string {
	return `/${parts.join('/')}`;
}

/** Encode one constructible route to its canonical in-app URL. */
export function encodeLibraryRoute(route: LibraryRoute): string {
	switch (route.kind) {
		case 'root':
			return routePath(['library', route.scope]);
		case 'artist-filter':
			return `${routePath(['library', 'artists'])}?filter=${encodeSegment(
				requireText(route.filter, 'artist filter')
			)}`;
		case 'artist':
			return routePath(['library', 'artists', encodeSegment(requireText(route.artist, 'artist'))]);
		case 'artist-album':
			return routePath([
				'library',
				'artists',
				encodeSegment(requireText(route.artist, 'artist')),
				encodeAlbum(route.album)
			]);
		case 'artist-album-track':
			return routePath([
				'library',
				'artists',
				encodeSegment(requireText(route.artist, 'artist')),
				encodeAlbum(route.album),
				encodeSegment(requireText(route.track, 'track'))
			]);
		case 'album':
			return routePath(['library', 'albums', encodeAlbum(route.album)]);
		case 'album-track':
			return routePath([
				'library',
				'albums',
				encodeAlbum(route.album),
				encodeSegment(requireText(route.track, 'track'))
			]);
		case 'genre':
			return routePath(['library', 'genres', encodeSegment(requireText(route.genre, 'genre'))]);
		case 'genre-album':
			return routePath([
				'library',
				'genres',
				encodeSegment(requireText(route.genre, 'genre')),
				encodeAlbum(route.album)
			]);
		case 'genre-album-track':
			return routePath([
				'library',
				'genres',
				encodeSegment(requireText(route.genre, 'genre')),
				encodeAlbum(route.album),
				encodeSegment(requireText(route.track, 'track'))
			]);
		case 'composer':
			return routePath([
				'library',
				'composers',
				encodeSegment(requireText(route.composer, 'composer'))
			]);
		case 'composition':
			return routePath([
				'library',
				'composers',
				encodeSegment(requireText(route.composer, 'composer')),
				encodeSegment(requireText(route.composition, 'composition'))
			]);
		case 'live-path':
			return routePath([
				'library',
				route.path.origin,
				'path',
				...requireLivePath(route.path).map(encodeLivePathStep)
			]);
		case 'browse': {
			if (route.steps.length > LIBRARY_ROUTE_STEPS_MAX) {
				throw new TypeError('Invalid Library route Browse depth');
			}
			const path = routePath([
				'library',
				'browse',
				...route.steps.map(encodeBrowseStep)
			]);
			return route.search === null
				? path
				: `${path}?search=${encodeSegment(requireText(route.search, 'search'))}`;
		}
	}
}

function rawPathSegments(url: URL): string[] | null {
	if (url.hash.length > 0 || !url.pathname.startsWith('/')) return null;
	const parts = url.pathname.split('/');
	if (parts[0] !== '') return null;
	parts.shift();
	if (parts.at(-1) === '') parts.pop();
	return parts.some((part) => part.length === 0) ? null : parts;
}

function decodeSearch(url: URL): string | null | false {
	if (url.search.length === 0) return null;
	const matched = /^\?search=([^&]*)$/u.exec(url.search);
	if (!matched) return false;
	return decodeSegment(matched[1]) ?? false;
}

function decodeLivePathRoute(
	section: string,
	parts: readonly string[]
): Extract<LibraryRoute, { kind: 'live-path' }> | null | false {
	if ((section !== 'genres' && section !== 'composers') || parts[2] !== 'path') return false;
	const encodedSteps = parts.slice(3);
	// `path` remains a valid genre/composer rendering. A fallback step always
	// contains its four-field separators, so only that spelling claims the
	// marker and existing named addresses remain unambiguous.
	if (encodedSteps.length === 0 || !encodedSteps[0].includes(';')) return false;
	const firstFieldCount = encodedSteps[0].split(';').length;
	// A named genre called "path" followed by an album has the album codec's
	// three fields. Keep that already-canonical address on the named arm.
	if (firstFieldCount === 3) return false;
	if (firstFieldCount !== 4) return null;
	if (encodedSteps.length < 2 || encodedSteps.length > LIBRARY_ROUTE_STEPS_MAX) return null;
	const steps = encodedSteps.map(decodeLivePathStep);
	if (steps.some((step) => step === null)) return null;
	const origin = section as LibraryRouteLivePath['origin'];
	const expectedRootKind = origin === 'genres' ? 'genre' : 'composer';
	if (steps[0]?.kind !== expectedRootKind) return null;
	return {
		kind: 'live-path',
		path: { origin, steps: steps as LibraryPathStep[] }
	};
}

/**
 * Decode a URL strictly. `null` means no route is understood; callers may
 * show the Library root, but must never partially restore the malformed path.
 */
export function decodeLibraryRoute(url: URL): LibraryRoute | null {
	const parts = rawPathSegments(url);
	if (parts === null || parts[0] !== 'library') return null;
	if (parts.length === 1) {
		return url.search.length === 0 ? { kind: 'root', scope: 'artists' } : null;
	}

	const section = parts[1];
	if (section === 'artists' && parts.length === 2 && url.search.length > 0) {
		const matched = /^\?filter=([^&]*)$/u.exec(url.search);
		const filter = matched === null ? null : decodeSegment(matched[1]);
		return filter === null ? null : { kind: 'artist-filter', filter };
	}
	if (section === 'browse') {
		if (parts.length - 2 > LIBRARY_ROUTE_STEPS_MAX) return null;
		const steps = parts.slice(2).map(decodeBrowseStep);
		if (steps.some((step) => step === null)) return null;
		const search = decodeSearch(url);
		return search === false
			? null
			: { kind: 'browse', steps: steps as LibraryRouteBrowseStep[], search };
	}
	if (url.search.length > 0) return null;
	const livePath = decodeLivePathRoute(section, parts);
	if (livePath !== false) return livePath;

	if ((LIBRARY_ROOT_ROUTE_SCOPES as readonly string[]).includes(section) && parts.length === 2) {
		return { kind: 'root', scope: section as LibraryRootRouteScope };
	}

	if (section === 'artists') {
		const artist = parts.length >= 3 ? decodeSegment(parts[2]) : null;
		if (artist === null) return null;
		if (parts.length === 3) return { kind: 'artist', artist };
		const album = decodeAlbum(parts[3] ?? '');
		if (album === null) return null;
		if (parts.length === 4) return { kind: 'artist-album', artist, album };
		const track = parts.length === 5 ? decodeSegment(parts[4]) : null;
		return track === null ? null : { kind: 'artist-album-track', artist, album, track };
	}

	if (section === 'albums') {
		const album = parts.length >= 3 ? decodeAlbum(parts[2]) : null;
		if (album === null) return null;
		if (parts.length === 3) return { kind: 'album', album };
		const track = parts.length === 4 ? decodeSegment(parts[3]) : null;
		return track === null ? null : { kind: 'album-track', album, track };
	}

	if (section === 'genres') {
		const genre = parts.length >= 3 ? decodeSegment(parts[2]) : null;
		if (genre === null) return null;
		if (parts.length === 3) return { kind: 'genre', genre };
		const album = decodeAlbum(parts[3] ?? '');
		if (album === null) return null;
		if (parts.length === 4) return { kind: 'genre-album', genre, album };
		const track = parts.length === 5 ? decodeSegment(parts[4]) : null;
		return track === null ? null : { kind: 'genre-album-track', genre, album, track };
	}

	if (section === 'composers') {
		const composer = parts.length >= 3 ? decodeSegment(parts[2]) : null;
		if (composer === null) return null;
		if (parts.length === 3) return { kind: 'composer', composer };
		if (decodeAlbum(parts[3] ?? '') !== null) return null;
		const composition = parts.length === 4 ? decodeSegment(parts[3]) : null;
		return composition === null ? null : { kind: 'composition', composer, composition };
	}

	return null;
}
