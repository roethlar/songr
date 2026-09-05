import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	LIBRARY_ROOTS_CONTRACT,
	LIBRARY_SESSION_RETIRED_CONTRACT,
	type LibraryInvalidationReason,
	type LibraryRootRow
} from '@shared/libraryRootsContracts';
import {
	filterLiveEntries,
	heldLibraryGeneration,
	libraryRootsStore,
	liveAlbumEntry,
	liveArtistEntry,
	loadLibraryRoots,
	refreshLibraryRootsNow,
	retireLibraryGeneration,
	resetLibraryRoots
} from '../libraryRootsStore';

const CORE_ID = 'core-a';

function row(generation: string, token: string, title: string, subtitle?: string): LibraryRootRow {
	return {
		ref: { generation, token },
		title,
		...(subtitle !== undefined ? { subtitle } : {}),
		imageKey: `image-${token}`
	};
}

function snapshot(generation: string, over: Record<string, unknown> = {}) {
	return {
		contract: LIBRARY_ROOTS_CONTRACT,
		kind: 'snapshot',
		generation,
		coreId: CORE_ID,
		readAt: '2026-09-03T00:20:13.190Z',
		artists: {
			count: 3,
			rows: [
				row(generation, `${generation}-a1`, 'The Invented Band', '12 Albums'),
				row(generation, `${generation}-a2`, 'Björk Invented', '1 Album'),
				row(generation, `${generation}-a3`, 'Another Invention'),
			]
		},
		albums: {
			count: 2,
			rows: [
				row(generation, `${generation}-b1`, 'Invented Record', 'The Invented Band'),
				row(generation, `${generation}-b2`, 'Second Invention', 'Björk Invented')
			]
		},
		...over
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function retire(reason: LibraryInvalidationReason = 'refresh'): void {
	expect(retireLibraryGeneration({
		contract: LIBRARY_SESSION_RETIRED_CONTRACT,
		coreId: CORE_ID,
		retired: 'gen-1',
		reason
	})).toBe(true);
}

function recovery(isCurrent = () => true) {
	return {
		coreId: CORE_ID,
		retirement: { revision: get(libraryRootsStore).retirementRevision, isCurrent }
	};
}

function pendingResponse() {
	let resolve!: (response: Response) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

describe('live library roots store', () => {
	beforeEach(() => {
		resetLibraryRoots();
	});

	it.each(['refresh', 'count-mismatch', 'session-lost'] as const)(
		'loads one replacement for an external %s retirement', async (reason) => {
			const fetchFn = vi.fn<typeof fetch>()
				.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
				.mockResolvedValueOnce(jsonResponse(snapshot('gen-2')));
			await loadLibraryRoots(fetchFn, { coreId: CORE_ID });
			retire(reason);
			await Promise.all([loadLibraryRoots(fetchFn, recovery()), loadLibraryRoots(fetchFn, recovery())]);
			expect(fetchFn).toHaveBeenCalledTimes(2);
			expect(fetchFn.mock.calls[1][0]).toBe('/api/library/roots');
			expect(get(libraryRootsStore)).toMatchObject({ phase: 'ready', generation: 'gen-2' });
		}
	);

	it.each(['refresh', 'load'] as const)('waits for an owned %s response without duplicate reads', async (kind) => {
		const pending = pendingResponse();
		const fetchFn = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
			.mockImplementationOnce(() => pending.promise);
		await loadLibraryRoots(fetchFn, { coreId: CORE_ID });
		const owned = kind === 'refresh'
			? refreshLibraryRootsNow(fetchFn, { coreId: CORE_ID })
			: loadLibraryRoots(fetchFn, { coreId: CORE_ID });
		retire(kind === 'refresh' ? 'refresh' : 'count-mismatch');
		const recovered = loadLibraryRoots(fetchFn, recovery());
		await Promise.resolve();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		pending.resolve(jsonResponse(snapshot('gen-2')));
		await Promise.all([owned, recovered]);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(get(libraryRootsStore)).toMatchObject({ phase: 'ready', generation: 'gen-2', retirementRevision: 1 });
	});

	it.each(['read-first', 'refresh-first'] as const)(
		'waits for every owned response before deciding recovery (%s)', async (order) => {
			const readResponse = pendingResponse();
			const refreshResponse = pendingResponse();
			const fetchFn = vi.fn<typeof fetch>()
				.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
				.mockImplementationOnce(() => readResponse.promise)
				.mockImplementationOnce(() => refreshResponse.promise);
			await loadLibraryRoots(fetchFn, { coreId: CORE_ID });
			const read = loadLibraryRoots(fetchFn, { coreId: CORE_ID });
			const refresh = refreshLibraryRootsNow(fetchFn, { coreId: CORE_ID });
			retire();
			let recoveryFinished = false;
			const recovered = loadLibraryRoots(fetchFn, recovery()).then(() => { recoveryFinished = true; });
			if (order === 'read-first') {
				readResponse.reject(new Error('Old read failed'));
				await read;
			} else {
				refreshResponse.resolve(jsonResponse(snapshot('gen-2')));
				await refresh;
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(recoveryFinished).toBe(false);
			expect(fetchFn).toHaveBeenCalledTimes(3);
			if (order === 'read-first') refreshResponse.resolve(jsonResponse(snapshot('gen-2')));
			else readResponse.resolve(jsonResponse(snapshot('gen-1')));
			await Promise.all([read, refresh, recovered]);
			expect(fetchFn).toHaveBeenCalledTimes(3);
			expect(get(libraryRootsStore).generation).toBe('gen-2');
		}
	);

	it.each(['failed', 'retired', 'unavailable'] as const)('replaces once when an owned response is %s', async (outcome) => {
		const pending = pendingResponse();
		const fetchFn = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
			.mockImplementationOnce(() => pending.promise)
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-2')));
		await loadLibraryRoots(fetchFn, { coreId: CORE_ID });
		const owned = refreshLibraryRootsNow(fetchFn, { coreId: CORE_ID });
		retire();
		const recovered = loadLibraryRoots(fetchFn, recovery());
		if (outcome === 'failed') pending.reject(new Error('Refresh failed'));
		else if (outcome === 'unavailable') pending.resolve(jsonResponse({
			contract: LIBRARY_ROOTS_CONTRACT, kind: 'unavailable',
			reason: 'core-under-pressure', message: 'Busy'
		}, 503));
		else pending.resolve(jsonResponse(snapshot('gen-1')));
		await Promise.all([owned, recovered]);
		expect(fetchFn).toHaveBeenCalledTimes(3);
		expect(get(libraryRootsStore).generation).toBe('gen-2');
	});

	it.each(['suspended', 'reset', 'superseded-retirement'] as const)(
		'does not issue a replacement after the wait becomes %s', async (change) => {
			const pending = pendingResponse();
			const fetchFn = vi.fn<typeof fetch>()
				.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
				.mockImplementationOnce(() => pending.promise);
			await loadLibraryRoots(fetchFn, { coreId: CORE_ID });
			const owned = refreshLibraryRootsNow(fetchFn, { coreId: CORE_ID });
			retire();
			let current = true;
			const options = recovery(() => current);
			if (change === 'superseded-retirement') options.retirement.revision -= 1;
			const recovered = loadLibraryRoots(fetchFn, options);
			if (change === 'reset') resetLibraryRoots();
			if (change === 'suspended') current = false;
			pending.resolve(jsonResponse(snapshot('gen-1')));
			await Promise.all([owned, recovered]);
			expect(fetchFn).toHaveBeenCalledTimes(2);
			expect(get(libraryRootsStore).generation).toBeNull();
		}
	);

	it('does not re-read if replacement arrived before the retirement observer runs', async () => {
		const fetchFn = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-2')));
		await loadLibraryRoots(fetchFn, { coreId: CORE_ID });
		retire();
		const options = recovery();
		await loadLibraryRoots(fetchFn, { coreId: CORE_ID });
		await loadLibraryRoots(fetchFn, options);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(get(libraryRootsStore).generation).toBe('gen-2');
	});

	it('does not recover a different Core s retirement', async () => {
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(snapshot('gen-1')));
		await loadLibraryRoots(fetchFn, { coreId: CORE_ID });
		retire();
		await loadLibraryRoots(fetchFn, { ...recovery(), coreId: 'other-core' });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('does not retry after the one recovery read fails', async () => {
		const fetchFn = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
			.mockRejectedValueOnce(new Error('Core unavailable'));
		await loadLibraryRoots(fetchFn, { coreId: CORE_ID });
		retire();
		await Promise.all([loadLibraryRoots(fetchFn, recovery()), loadLibraryRoots(fetchFn, recovery())]);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(get(libraryRootsStore)).toMatchObject({ phase: 'error', error: 'Core unavailable' });
	});

	it('a reset detaches an old Core request from new-Core recovery', async () => {
		const old = pendingResponse();
		const oldLoad = loadLibraryRoots(vi.fn(() => old.promise), { coreId: 'old-core' });
		resetLibraryRoots();
		const fetchFn = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-2')));
		await loadLibraryRoots(fetchFn, { coreId: CORE_ID });
		retire();
		await loadLibraryRoots(fetchFn, recovery());
		expect(get(libraryRootsStore).generation).toBe('gen-2');
		old.resolve(jsonResponse(snapshot('old-gen', { coreId: 'old-core' })));
		await oldLoad;
		expect(get(libraryRootsStore).generation).toBe('gen-2');
	});

	it('renders Roon rows in their own words, with counts from their own subtitles', async () => {
		const fetchFn = vi.fn(async () => jsonResponse(snapshot('gen-1')));
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });

		const state = get(libraryRootsStore);
		expect(state.phase).toBe('ready');
		expect(state.generation).toBe('gen-1');
		expect(state.artistCount).toBe(3);
		expect(state.albumCount).toBe(2);
		// Sorted by the article-stripped sort key, not by Roon's order: "The
		// Invented Band" files under I.
		expect(state.artists.map((entry) => entry.name)).toEqual([
			'Another Invention',
			'Björk Invented',
			'The Invented Band'
		]);
		expect(state.artists.find((entry) => entry.name === 'The Invented Band')?.albumCount).toBe(12);
		// A row that said nothing gets no count, rather than a 0 the library
		// never said.
		expect(state.artists.find((entry) => entry.name === 'Another Invention')?.albumCount).toBe(
			undefined
		);
		// An album's credit is that row's own subtitle; nothing is looked up.
		expect(state.albums[0]).toMatchObject({
			title: 'Invented Record',
			artist: 'The Invented Band'
		});
	});

	it('carries a reference for every row and no catalog identity for any', async () => {
		const fetchFn = vi.fn(async () => jsonResponse(snapshot('gen-1')));
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		const state = get(libraryRootsStore);
		for (const entry of [...state.artists, ...state.albums]) {
			expect(entry.liveRef?.generation).toBe('gen-1');
			expect(entry.liveRef?.token).toEqual(expect.any(String));
			// "No catalog identity" is now a type-level guarantee: the entry types
			// carry no `catalogLocalId` field to assert `undefined` about. What
			// remains checkable at runtime is that the id is minted from the live
			// token and from nothing else, which is the same claim from the front.
			expect(entry.id).toBe(`live:${entry.liveRef?.token}`);
		}
		expect(heldLibraryGeneration()).toBe('gen-1');
	});

	it('sends the generation it holds, so a second load is the cheap check', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
			.mockResolvedValueOnce(
				jsonResponse({
					contract: LIBRARY_ROOTS_CONTRACT,
					kind: 'current',
					generation: 'gen-1',
					coreId: CORE_ID
				})
			);
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		const first = get(libraryRootsStore);
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });

		expect(fetchFn.mock.calls[0][0]).toBe('/api/library/roots');
		expect(fetchFn.mock.calls[1][0]).toBe('/api/library/roots?generation=gen-1');
		const second = get(libraryRootsStore);
		expect(second.phase).toBe('ready');
		expect(second.generation).toBe('gen-1');
		// The rows the server just confirmed are the rows still on screen: the
		// confirmation carries none, and none are rebuilt.
		expect(second.artists).toBe(first.artists);
	});

	it('replaces every row when the generation it held is gone', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-2')));
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		const stale = get(libraryRootsStore).artists[0].liveRef;
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });

		const state = get(libraryRootsStore);
		expect(state.generation).toBe('gen-2');
		// Not one reference survives a generation, and nothing is diffed: a row
		// is only meaningful with the reference that names it.
		for (const entry of [...state.artists, ...state.albums]) {
			expect(entry.liveRef?.generation).toBe('gen-2');
			expect(entry.liveRef?.token).not.toBe(stale?.token);
		}
	});

	it('re-reads on the reader s own refresh', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-2')));
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		await refreshLibraryRootsNow(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		expect(fetchFn.mock.calls[1][0]).toBe('/api/library/roots/refresh');
		expect(fetchFn.mock.calls[1][1]).toMatchObject({ method: 'POST' });
		expect(get(libraryRootsStore).generation).toBe('gen-2');
	});

	it('says the Core is being spared rather than showing an empty library', async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse(
				{
					contract: LIBRARY_ROOTS_CONTRACT,
					kind: 'unavailable',
					reason: 'core-under-pressure',
					message: 'Waiting for the Roon Core to answer promptly again.'
				},
				503
			)
		);
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		const state = get(libraryRootsStore);
		expect(state.phase).toBe('unavailable');
		expect(state.unavailable).toBe('core-under-pressure');
		expect(state.artists).toEqual([]);
		expect(state.error).toContain('Waiting for the Roon Core');
	});

	it('never renders another Core s library', async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse(snapshot('gen-1', { coreId: 'core-b' }))
		);
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		const state = get(libraryRootsStore);
		expect(state.phase).toBe('error');
		expect(state.artists).toEqual([]);
	});

	it('refuses a payload it cannot fully understand', async () => {
		const broken = snapshot('gen-1');
		broken.artists.count = 99;
		const fetchFn = vi.fn(async () => jsonResponse(broken));
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		expect(get(libraryRootsStore).phase).toBe('error');
		expect(get(libraryRootsStore).artists).toEqual([]);
	});

	it('drops a response that crosses a reset', async () => {
		let release: (value: Response) => void = () => undefined;
		const pending = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const fetchFn = vi.fn(() => pending);
		const load = loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		resetLibraryRoots();
		release(jsonResponse(snapshot('gen-1')));
		await load;
		expect(get(libraryRootsStore).phase).toBe('idle');
	});

	it('retires only the held generation and ignores null or late notices', async () => {
		const fetchFn = vi.fn(async () => jsonResponse(snapshot('gen-1')));
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		const revision = get(libraryRootsStore).retirementRevision;

		expect(
			retireLibraryGeneration({
				contract: LIBRARY_SESSION_RETIRED_CONTRACT,
				coreId: CORE_ID,
				retired: null,
				reason: 'connect'
			})
		).toBe(false);
		expect(
			retireLibraryGeneration({
				contract: LIBRARY_SESSION_RETIRED_CONTRACT,
				coreId: CORE_ID,
				retired: 'gen-old',
				reason: 'session-lost'
			})
		).toBe(false);

		expect(
			retireLibraryGeneration({
				contract: LIBRARY_SESSION_RETIRED_CONTRACT,
				coreId: CORE_ID,
				retired: 'gen-1',
				reason: 'session-lost'
			})
		).toBe(true);
		expect(get(libraryRootsStore)).toMatchObject({
			phase: 'idle',
			generation: null,
			coreId: CORE_ID,
			artists: [],
			retirementRevision: revision + 1,
			retirementReason: 'session-lost'
		});
	});

	it('accepts a replacement refresh while refusing every late retired response', async () => {
		let resolveRefresh: (value: Response) => void = () => undefined;
		const pendingRefresh = new Promise<Response>((resolve) => {
			resolveRefresh = resolve;
		});
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
			.mockImplementationOnce(() => pendingRefresh)
			.mockResolvedValueOnce(jsonResponse(snapshot('gen-1')))
			.mockResolvedValueOnce(
				jsonResponse({
					contract: LIBRARY_ROOTS_CONTRACT,
					kind: 'current',
					generation: 'gen-1',
					coreId: CORE_ID
				})
			);
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		const refresh = refreshLibraryRootsNow(fetchFn as unknown as typeof fetch, {
			coreId: CORE_ID
		});
		retireLibraryGeneration({
			contract: LIBRARY_SESSION_RETIRED_CONTRACT,
			coreId: CORE_ID,
			retired: 'gen-1',
			reason: 'session-lost'
		});

		resolveRefresh(jsonResponse(snapshot('gen-2')));
		await refresh;
		expect(get(libraryRootsStore)).toMatchObject({
			phase: 'ready',
			generation: 'gen-2',
			retirementRevision: 1
		});

		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		expect(get(libraryRootsStore).generation).toBe('gen-2');
		await loadLibraryRoots(fetchFn as unknown as typeof fetch, { coreId: CORE_ID });
		expect(get(libraryRootsStore).generation).toBe('gen-2');
	});
});

describe('type-to-filter over the in-memory root', () => {
	const artists = [
		liveArtistEntry(row('g', 't1', 'The Invented Band', '12 Albums')),
		liveArtistEntry(row('g', 't2', 'Björk Invented', '1 Album')),
		liveArtistEntry(row('g', 't3', 'Another Invention'))
	];

	it('matches on the normalized key and on the raw text', () => {
		expect(
			filterLiveEntries(artists, 'Björk', (entry) => entry.name).map((entry) => entry.name)
		).toEqual(['Björk Invented']);
		// The article is stripped from the sort key, so the raw comparison is
		// what finds a reader who typed it.
		expect(
			filterLiveEntries(artists, 'The Invented', (entry) => entry.name).map((entry) => entry.name)
		).toEqual(['The Invented Band']);
	});

	it('does not fold diacritics, which is the repo s existing rule and not this slice s to change', () => {
		// `normalizeCatalogText` lowercases and does not fold diacritics, so an
		// ASCII query does not reach an accented name. The palette has behaved
		// this way over the stored index for as long as it has existed; the live
		// filter matches it deliberately rather than quietly diverging on one
		// surface. Recorded as a known limitation, not asserted as a virtue.
		expect(filterLiveEntries(artists, 'bjork', (entry) => entry.name)).toEqual([]);
	});

	it('matches the middle of a name, not only its start', () => {
		expect(
			filterLiveEntries(artists, 'invent', (entry) => entry.name).map((entry) => entry.name)
		).toHaveLength(3);
	});

	it('answers the whole root for an empty query and nothing for a miss', () => {
		expect(filterLiveEntries(artists, '   ', (entry) => entry.name)).toHaveLength(3);
		expect(filterLiveEntries(artists, 'zzzz', (entry) => entry.name)).toEqual([]);
	});

	it('filters albums by title and by the credit Roon put on the row', () => {
		const albums = [
			liveAlbumEntry(row('g', 'b1', 'Invented Record', 'The Invented Band')),
			liveAlbumEntry(row('g', 'b2', 'Second Invention', 'Björk Invented'))
		];
		expect(
			filterLiveEntries(albums, 'second', (entry) => `${entry.title} ${entry.artist}`)
		).toHaveLength(1);
		expect(
			filterLiveEntries(albums, 'Björk', (entry) => `${entry.title} ${entry.artist}`)
		).toHaveLength(1);
	});
});
