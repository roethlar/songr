import { describe, expect, it } from 'vitest';
import { decodeLibraryRoute, encodeLibraryRoute, type LibraryRoute } from '../libraryRoute';
import { libraryEntryPageState, libraryPageStateFromRoute, libraryParentPageState, libraryRouteFromPageState } from '../libraryRouteState';
import { buildUnifiedRootPageState, normalizeLibraryPageState } from '../libraryPageState';
import type { AlbumCreditSelector } from '../albumArtistGroups';

const decode = (path: string) => decodeLibraryRoute(new URL(path, 'https://songr.test'));
const credits = ['Single Release', 'A / B', 'AC/DC', 'Earth, Wind & Fire', 'Björk',
	"A%2FB;C?'#&+=", '.', '..', '~%2E', ' credit ', 'x'.repeat(1024)];

function routes(selector: AlbumCreditSelector, credit: string): LibraryRoute[] {
	const album = { title: 'A/B; Édition', credit, edition: 'Remaster; 2' };
	return [
		{ kind: 'album-artists-root' },
		{ kind: 'credit-group', selector },
		{ kind: 'credit-album', selector, album },
		{ kind: 'credit-album-track', selector, album, track: '..' }
	];
}

describe('album-credit addresses and semantic parents', () => {
	it.each(['/library', '/library/'])('uses the remembered view only for bare entry: %s', address => {
		const url = new URL(address, 'https://songr.test');
		expect(libraryRouteFromPageState(libraryEntryPageState(url, 'album-artists'))).toEqual({ kind: 'album-artists-root' });
		expect(libraryRouteFromPageState(libraryEntryPageState(url, 'all-artists'))).toEqual({ kind: 'root', scope: 'artists' });
	});

	it.each(['/library/artists', '/library/album-artists', '/library/artists/A',
		'/library/album-artists/credit/A', '/library/album-artists/credit/A/album/T;A;/track/X',
		'/library/albums/T;A;', '/library/browse?search=Bowie', '/library/artists?filter=%3E0%20albums'
	])('an explicit URL wins over either preference: %s', address => {
		const url = new URL(address, 'https://songr.test');
		const route = decodeLibraryRoute(url);
		expect(route).not.toBeNull();
		for (const view of ['album-artists', 'all-artists'] as const) {
			expect(libraryRouteFromPageState(libraryEntryPageState(url, view))).toEqual(route);
		}
	});

	it.each([...credits.map(credit => [{ kind: 'credit', credit } as AlbumCreditSelector, credit] as const),
		[{ kind: 'uncredited' } as AlbumCreditSelector, ''] as const,
		[{ kind: 'uncredited' } as AlbumCreditSelector, '   '] as const
	])('preserves exact renderings through URL/state round-trips and every parent: %j', (selector, credit) => {
		const chain = routes(selector, credit);
		for (const [index, route] of chain.entries()) {
			const address = encodeLibraryRoute(route);
			expect(decode(address)).toEqual(route);
			expect(encodeLibraryRoute(decode(address)!)).toBe(address);
			const state = libraryPageStateFromRoute(route);
			expect(normalizeLibraryPageState(state)).toEqual(state);
			expect(libraryRouteFromPageState(state)).toEqual(route);
			expect(state.snapshot.artistView).toBe('album-artists');
			expect(state.snapshot.scope).toBe('artists');
			if (index >= 2) {
				expect(state.snapshot.itemTarget).toMatchObject({ kind: 'live', path: {
					origin: 'albums', steps: [{ kind: 'album', title: 'A/B; Édition', credit, edition: 'Remaster; 2' }]
				} });
			} else expect(state.snapshot.itemTarget).toBeNull();
			const parent = libraryParentPageState(state);
			expect(parent === null ? null : libraryRouteFromPageState(parent)).toEqual(chain[index - 1] ?? null);
		}
	});

	it('uses tagged credit paths and never hijacks existing artist addresses or builder defaults', () => {
		expect(encodeLibraryRoute({ kind: 'credit-group', selector: { kind: 'credit', credit: 'AC/DC' } }))
			.toBe('/library/album-artists/credit/AC%2FDC');
		expect(encodeLibraryRoute({ kind: 'credit-group', selector: { kind: 'uncredited' } }))
			.toBe('/library/album-artists/uncredited');
		const route: LibraryRoute = { kind: 'artist', artist: 'AC/DC' };
		expect(decode('/library/artists/AC%2FDC')).toEqual(route);
		expect(libraryPageStateFromRoute(route).snapshot.artistView).toBe('all-artists');
		expect(libraryRouteFromPageState(buildUnifiedRootPageState())).toEqual({ kind: 'root', scope: 'artists' });
	});

	it.each([
		'/library/album-artists/other/X', '/library/album-artists/credit',
		'/library/album-artists/credit/%20', '/library/album-artists/credit/%00',
		'/library/album-artists/credit/%', `/library/album-artists/credit/${'x'.repeat(1025)}`,
		'/library/album-artists/credit/A/album/T;B;',
		'/library/album-artists/uncredited/album/T;Unknown%20album%20artist;',
		'/library/album-artists/credit/A/album/T;A',
		'/library/album-artists/credit/A/album/T;A;/other/X',
		'/library/album-artists/credit/A/album/T;A;/track/X/extra',
		'/library/album-artists/uncredited/credit/X',
		'/library/album-artists/credit/A?filter=x', '/library/album-artists#fragment',
		'/library/album-artists/credit/A/album/T;A;/track/%7F'
	])('refuses malformed or mismatched addresses: %s', address => {
		expect(decode(address)).toBeNull();
	});

	it('refuses unknown selector tags and mismatched constructible album routes', () => {
		const invalid = { kind: 'credit-album', selector: { kind: 'credit', credit: 'A' },
			album: { title: 'T', credit: 'B', edition: '' } } as const;
		expect(() => encodeLibraryRoute(invalid)).toThrow();
		expect(() => libraryPageStateFromRoute(invalid)).toThrow();
		expect(() => encodeLibraryRoute({ kind: 'credit-group', selector: { kind: 'other' } } as unknown as LibraryRoute)).toThrow();
	});

	it('refuses ambiguous credit-state combinations and non-Album-root paths', () => {
		const group = libraryPageStateFromRoute({ kind: 'credit-group', selector: { kind: 'credit', credit: 'A' } });
		for (const patch of [
			{ artistView: 'all-artists' }, { artistView: 'unknown' }, { scope: 'albums' },
			{ albumCredit: { kind: 'credit', credit: '' } }, { filterText: '>0 albums' },
			{ collectionDrill: { kind: 'genre', label: 'Jazz' } },
			{ browseHistory: { context: { hierarchy: 'search', query: 'A' }, history: [], forward: [] } },
			{ itemTarget: { kind: 'live', path: { origin: 'artists', steps: [{ kind: 'artist', title: 'A' }] } } },
			{ itemTarget: { kind: 'live', path: { origin: 'albums', steps: [{ kind: 'album', title: 'T', credit: 'B' }] } } },
			{ itemTarget: { kind: 'live', path: { origin: 'albums', steps: [{ kind: 'album', title: 'T' }] } } },
			{ itemDetail: { kind: 'track', title: 'T' } }
		]) expect(normalizeLibraryPageState({ ...group, snapshot: { ...group.snapshot, ...patch } })).toBeNull();
		const root = libraryPageStateFromRoute({ kind: 'album-artists-root' });
		expect(normalizeLibraryPageState({ ...root, snapshot: { ...root.snapshot, itemTarget: {
			kind: 'live', path: { origin: 'albums', steps: [{ kind: 'album', title: 'T', credit: 'A' }] }
		} } })).toBeNull();
	});

	it.each([
		{ kind: 'root', scope: 'artists' },
		{ kind: 'artist', artist: 'Single Release' },
		{ kind: 'album', album: { title: 'T', credit: 'A', edition: '' } },
		{ kind: 'artist-filter', filter: '>0 albums' }
	] as const)('migrates v10 without changing its meaning: %j', route => {
		const current = libraryPageStateFromRoute(route);
		const { artistView, albumCredit, ...snapshot } = current.snapshot;
		void artistView;
		void albumCredit;
		const restored = normalizeLibraryPageState({ ...current, schemaVersion: 10, snapshot });
		expect(restored).toEqual(current);
		expect(restored?.snapshot.artistView).toBe('all-artists');
		expect(libraryRouteFromPageState(restored!)).toEqual(route);
		// A claimed v10 body with v11 fields is not a valid legacy payload.
		expect(normalizeLibraryPageState({ ...current, schemaVersion: 10 })).toBeNull();
	});
});
