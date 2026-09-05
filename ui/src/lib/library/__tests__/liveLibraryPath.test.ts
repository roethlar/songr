import { describe, expect, it, vi } from 'vitest';
import {
	libraryAlbumStep,
	libraryPathFailureMessage,
	libraryRowMatchesStep,
	resolveLibraryRenderingPath,
	type LibraryPathDependencies,
	type LibraryRenderingPath
} from '../liveLibraryPath';
import { LIBRARY_OPEN_CONTRACT, type LibraryOpenResponse } from '@shared/libraryOpenContracts';
import type { LibraryRootRow, LibraryRowReference } from '@shared/libraryRootsContracts';

const GEN = 'gen-1';

function ref(token: string, generation = GEN): LibraryRowReference {
	return { generation, token };
}

function rootRow(title: string, subtitle?: string, token?: string): LibraryRootRow {
	return {
		ref: ref(token ?? `root:${title}:${subtitle ?? ''}`),
		title,
		...(subtitle === undefined ? {} : { subtitle })
	};
}

function level(
	title: string,
	rows: readonly { title: string; subtitle?: string; kind?: 'album' | 'track' | 'action' }[]
): LibraryOpenResponse {
	const mapped = rows.map((row) => ({
		ref: ref(`lvl:${title}:${row.title}:${row.subtitle ?? ''}`),
		title: row.title,
		kind: row.kind ?? 'album',
		...(row.subtitle === undefined ? {} : { subtitle: row.subtitle })
	}));
	return {
		contract: LIBRARY_OPEN_CONTRACT,
		kind: 'level',
		generation: GEN,
		title,
		count: mapped.length,
		rows: mapped
	};
}

function deps(over: Partial<LibraryPathDependencies> = {}): LibraryPathDependencies {
	return {
		heldRoot: () => [],
		openRef: async () => ({ contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' }),
		openRoot: async () => ({ contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' }),
		...over
	};
}

const TIL_TUESDAY: LibraryRenderingPath = {
	origin: 'artists',
	steps: [{ kind: 'artist', title: '’Til Tuesday' }]
};

describe('resolveLibraryRenderingPath', () => {
	it('answers the one root row an address names, and hands back its live reference', async () => {
		const rows = [rootRow('Björk', '31 Albums'), rootRow('’Til Tuesday', '5 Albums')];
		const resolution = await resolveLibraryRenderingPath(
			deps({ heldRoot: () => rows }),
			TIL_TUESDAY
		);
		expect(resolution).toEqual({
			kind: 'resolved',
			target: {
				ref: rows[1].ref,
				title: '’Til Tuesday',
				subtitle: '5 Albums',
				imageKey: null,
				kind: 'artist'
			}
		});
	});

	it('does not match an artist on its count, so a new album never loses the address', async () => {
		// Roon writes the album count in the subtitle of an Artists row. An
		// address that compared it would stop resolving the moment the artist
		// gained an album — reporting "no longer in library" about a library
		// that gained something.
		const resolution = await resolveLibraryRenderingPath(
			deps({ heldRoot: () => [rootRow('’Til Tuesday', '6 Albums')] }),
			TIL_TUESDAY
		);
		expect(resolution.kind).toBe('resolved');
	});

	it('matches an album on its credit as well as its title', async () => {
		const rows = [
			rootRow('3 Feet High and Rising', 'De La Soul'),
			rootRow('3 Feet High and Rising', 'Someone Else')
		];
		const resolution = await resolveLibraryRenderingPath(deps({ heldRoot: () => rows }), {
			origin: 'albums',
			steps: [libraryAlbumStep('3 Feet High and Rising', 'Someone Else')]
		});
		expect(resolution).toMatchObject({ kind: 'resolved', target: { ref: rows[1].ref } });
	});

	it('reports two identical rows rather than opening whichever came first', async () => {
		const rows = [
			rootRow('3 Feet High and Rising', 'De La Soul', 'duplicate:one'),
			rootRow('3 Feet High and Rising', 'De La Soul', 'duplicate:two')
		];
		const resolution = await resolveLibraryRenderingPath(deps({ heldRoot: () => rows }), {
			origin: 'albums',
			steps: [libraryAlbumStep('3 Feet High and Rising', 'De La Soul')]
		});
		expect(resolution).toEqual({
			kind: 'ambiguous',
			at: {
				kind: 'album',
				title: '3 Feet High and Rising',
				credit: 'De La Soul',
				edition: ''
			},
			count: 2,
			targets: rows.map((row) => ({
				ref: row.ref,
				title: row.title,
				subtitle: row.subtitle ?? null,
				imageKey: null,
				kind: 'album'
			})),
			path: {
				origin: 'albums',
				steps: [libraryAlbumStep('3 Feet High and Rising', 'De La Soul')]
			}
		});
		expect(libraryPathFailureMessage(resolution)).toContain('merge them in Roon');
	});

	it('names the step that is gone, not the page', async () => {
		const resolution = await resolveLibraryRenderingPath(
			deps({ heldRoot: () => [rootRow('Björk', '31 Albums')] }),
			TIL_TUESDAY
		);
		expect(resolution).toEqual({ kind: 'missing', at: TIL_TUESDAY.steps[0] });
		expect(libraryPathFailureMessage(resolution)).toContain('’Til Tuesday');
	});

	it('walks through the level of every step but the last', async () => {
		const artistRow = rootRow('’Til Tuesday', '5 Albums');
		const openRef = vi.fn(async () =>
			level('’Til Tuesday', [
				{ title: 'Play Artist', kind: 'action' },
				{ title: 'Voices Carry', subtitle: '’Til Tuesday' },
				{ title: 'Welcome Home', subtitle: '’Til Tuesday' }
			])
		);
		const resolution = await resolveLibraryRenderingPath(
			deps({ heldRoot: () => [artistRow], openRef }),
			{
				origin: 'artists',
				steps: [
					{ kind: 'artist', title: '’Til Tuesday' },
					libraryAlbumStep('Voices Carry', '’Til Tuesday')
				]
			}
		);
		// One open, for the artist. The album is FOUND, never opened: what a
		// page does with the row it addresses is the page's own read.
		expect(openRef).toHaveBeenCalledTimes(1);
		expect(openRef).toHaveBeenCalledWith(artistRow.ref);
		expect(resolution).toMatchObject({
			kind: 'resolved',
			target: { title: 'Voices Carry', subtitle: '’Til Tuesday', kind: 'album' }
		});
	});

	it('reads an on-demand root before its first step, and never a held one', async () => {
		const openRoot = vi.fn(async () =>
			level('Genres', [{ title: 'Electronic', subtitle: '204 Albums', kind: 'album' }])
		);
		const heldRoot = vi.fn(() => []);
		const resolution = await resolveLibraryRenderingPath(
			deps({ openRoot, heldRoot }),
			{ origin: 'genres', steps: [{ kind: 'genre', title: 'Electronic' }] }
		);
		expect(openRoot).toHaveBeenCalledWith('genres');
		expect(heldRoot).not.toHaveBeenCalled();
		expect(resolution.kind).toBe('resolved');
	});

	it('says stale rather than missing when the reader holds no roots at all', async () => {
		// No held snapshot is not a statement about the row. The reader has
		// nothing to look in, and the answer is "re-read", not "it is gone".
		const resolution = await resolveLibraryRenderingPath(
			deps({ heldRoot: () => null }),
			TIL_TUESDAY
		);
		expect(resolution).toEqual({ kind: 'stale' });
	});

	it('carries a stale level through as stale, and an unavailable one with its sentence', async () => {
		const artistRow = rootRow('’Til Tuesday', '5 Albums');
		const path: LibraryRenderingPath = {
			origin: 'artists',
			steps: [{ kind: 'artist', title: '’Til Tuesday' }, libraryAlbumStep('Voices Carry', '’Til Tuesday')]
		};
		await expect(
			resolveLibraryRenderingPath(
				deps({
					heldRoot: () => [artistRow],
					openRef: async () => ({ contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' })
				}),
				path
			)
		).resolves.toEqual({ kind: 'stale' });
		await expect(
			resolveLibraryRenderingPath(
				deps({
					heldRoot: () => [artistRow],
					openRef: async () => ({
						contract: LIBRARY_OPEN_CONTRACT,
						kind: 'unavailable',
						reason: 'core-under-pressure',
						message: 'The Core is busy.'
					})
				}),
				path
			)
		).resolves.toEqual({ kind: 'unavailable', message: 'The Core is busy.' });
	});

	it('stops at the first await nobody is waiting on', async () => {
		const artistRow = rootRow('’Til Tuesday', '5 Albums');
		const openRef = vi.fn(async () => level('’Til Tuesday', [{ title: 'Voices Carry' }]));
		const resolution = await resolveLibraryRenderingPath(
			deps({ heldRoot: () => [artistRow], openRef, stillWanted: () => false }),
			{
				origin: 'artists',
				steps: [
					{ kind: 'artist', title: '’Til Tuesday' },
					libraryAlbumStep('Voices Carry', '’Til Tuesday'),
					{ kind: 'track', title: 'Voices Carry' }
				]
			}
		);
		expect(resolution).toEqual({ kind: 'canceled' });
		// One read issued, then the walk stopped: an abandoned page does not
		// keep reading levels nobody will look at.
		expect(openRef).toHaveBeenCalledTimes(1);
	});
});

describe('libraryRowMatchesStep', () => {
	it('compares Roon characters exactly, folding nothing', () => {
		// U+2019 and U+0027 are two different apostrophes and two different
		// rows. Folding them would make one row out of two Roon renders apart.
		expect(libraryRowMatchesStep({ title: '’Til Tuesday' }, { kind: 'artist', title: "'Til Tuesday" })).toBe(
			false
		);
		expect(libraryRowMatchesStep({ title: 'BJÖRK' }, { kind: 'artist', title: 'Björk' })).toBe(false);
	});

	it('treats an absent subtitle as an empty credit, which is a real answer', () => {
		expect(libraryRowMatchesStep({ title: 'Untitled' }, libraryAlbumStep('Untitled', ''))).toBe(true);
		expect(libraryRowMatchesStep({ title: 'Untitled', subtitle: 'X' }, libraryAlbumStep('Untitled', ''))).toBe(
			false
		);
	});

	it('refuses nonempty edition text the live row contract does not expose', () => {
		expect(
			libraryRowMatchesStep(
				{ title: 'Signals', subtitle: 'Mara Ensemble' },
				libraryAlbumStep('Signals', 'Mara Ensemble', 'Deluxe')
			)
		).toBe(false);
	});
});
