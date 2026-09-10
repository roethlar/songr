import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	DEFAULT_NAVIGATION_SETTINGS, NAVIGATION_DESTINATION_IDS, createPublicNavigationDestinationId, MAX_CUSTOM_NAVIGATION_DESTINATIONS,
	type NavigationSettingsSnapshot, type NavigationDestinationId
} from '@shared/navigationSettings';
import { createNavigationSettingsStore } from '../navigationSettingsStore';

function snapshot(revision = 1, pinned: readonly NavigationDestinationId[] = ['artists', 'albums', 'genres']): NavigationSettingsSnapshot {
	return { ...DEFAULT_NAVIGATION_SETTINGS, revision, order: [...NAVIGATION_DESTINATION_IDS], pinned: [...pinned] };
}
function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function echoServer() {
	return vi.fn(async (_url, init) => {
		const request = JSON.parse(init!.body as string);
		return response({ version: 1, revision: request.expectedRevision + 1,
			order: request.order, pinned: request.pinned });
	}) as unknown as typeof fetch;
}

describe('server navigation preferences', () => {
	it('starts without invented saved choices and hydrates the server snapshot with request credentials', async () => {
		const store = createNavigationSettingsStore();
		expect(get(store).snapshot).toBeNull();
		const fetchFn = vi.fn(async () => response(snapshot(7, ['favorites']))) as unknown as typeof fetch;
		await store.load(fetchFn);
		expect(fetchFn).toHaveBeenCalledWith('/api/settings/navigation', expect.objectContaining({ credentials: 'include', cache: 'no-store' }));
		expect(get(store)).toMatchObject({ snapshot: snapshot(7, ['favorites']), loading: false, error: null });
	});

	it('does not let a delayed GET replace a newer broadcast', async () => {
		const store = createNavigationSettingsStore(), pending = deferred<Response>();
		const read = store.load(vi.fn(() => pending.promise) as unknown as typeof fetch);
		store.applySnapshot(snapshot(9, ['surprise']));
		pending.resolve(response(snapshot(8, ['albums']))); await read;
		expect(get(store).snapshot).toEqual(snapshot(9, ['surprise']));
		expect(get(store).loading).toBe(false);
	});

	it('accepts the newest revision from concurrent reloads regardless of response order', async () => {
		const store = createNavigationSettingsStore(), first = deferred<Response>(), second = deferred<Response>();
		const fetchFn = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) as unknown as typeof fetch;
		const a = store.load(fetchFn), b = store.load(fetchFn);
		second.resolve(response(snapshot(4))); await b;
		first.resolve(response(snapshot(5, ['favorites']))); await a;
		expect(get(store).snapshot).toEqual(snapshot(5, ['favorites']));
	});

	it('ignores invalid, equal and older broadcasts, and owns a copy of accepted arrays', () => {
		const store = createNavigationSettingsStore(), incoming = snapshot(4);
		expect(store.applySnapshot(incoming)).toBe(true);
		(incoming.pinned as NavigationDestinationId[]).push('tags');
		expect(store.applySnapshot(snapshot(4, ['albums']))).toBe(false);
		expect(store.applySnapshot(snapshot(3, []))).toBe(false);
		expect(store.applySnapshot({ ...snapshot(8), extra: true })).toBe(false);
		expect(get(store).snapshot).toEqual(snapshot(4));
	});

	it('retains unavailable positions and pins when capabilities change, without writing', async () => {
		const store = createNavigationSettingsStore(); store.applySnapshot(snapshot(2, ['artists', 'tags', 'playlists']));
		const before = get(store).snapshot;
		store.setAvailableDestinations(['artists', 'albums']);
		expect(get(store).snapshot).toBe(before);
		expect(store.getCapabilities()).toEqual(['artists', 'albums']);
		const fetchFn = vi.fn() as unknown as typeof fetch;
		expect(await store.setPinned('tags', false, fetchFn)).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('moves among available neighbors while preserving invisible positions and pins', async () => {
		const store = createNavigationSettingsStore();
		const current = { ...snapshot(3, ['artists', 'tags']), order: ['artists', 'tracks', 'albums', ...NAVIGATION_DESTINATION_IDS.filter(id => !['artists', 'tracks', 'albums'].includes(id))] as NavigationDestinationId[] };
		store.applySnapshot(current); store.setAvailableDestinations(['artists', 'albums', 'genres']);
		const expected = { ...current, revision: 4, order: ['albums', 'tracks', 'artists', ...current.order.slice(3)] as NavigationDestinationId[] };
		const fetchFn = vi.fn(async () => response(expected)) as unknown as typeof fetch;
		expect(await store.move('albums', 'earlier', fetchFn)).toBe(true);
		const request = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string);
		expect(request).toEqual({ expectedRevision: 3, order: expected.order, pinned: ['artists', 'tags'] });
		expect(get(store).snapshot).toEqual(expected);
	});

	it('keeps confirmed choices while saving and prevents overlapping local writes', async () => {
		const store = createNavigationSettingsStore(), pending = deferred<Response>(); store.applySnapshot(snapshot(3));
		const fetchFn = vi.fn(() => pending.promise) as unknown as typeof fetch;
		const save = store.setPinned('favorites', true, fetchFn);
		expect(get(store)).toMatchObject({ saving: true, snapshot: snapshot(3) });
		expect(await store.setPinned('artists', false, fetchFn)).toBe(false);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		pending.resolve(response(snapshot(4, ['artists', 'albums', 'genres', 'favorites'])));
		expect(await save).toBe(true);
		expect(get(store)).toMatchObject({ saving: false, error: null, snapshot: snapshot(4, ['artists', 'albums', 'genres', 'favorites']) });
	});

	it.each(['http', 'network'])('reports %s save failure without changing saved choices', async kind => {
		const store = createNavigationSettingsStore(); store.applySnapshot(snapshot(3));
		const fetchFn = vi.fn(async () => { if (kind === 'network') throw new Error('Connection lost'); return response({ error: 'Disk write failed' }, 503); }) as unknown as typeof fetch;
		expect(await store.setPinned('favorites', true, fetchFn)).toBe(false);
		expect(get(store).snapshot).toEqual(snapshot(3));
		expect(get(store).saving).toBe(false);
		expect(get(store).error).toMatch(/not saved/);
	});

	it('shows the conflict snapshot and never resubmits a stale edit automatically', async () => {
		const store = createNavigationSettingsStore(); store.applySnapshot(snapshot(3));
		const fetchFn = vi.fn(async () => response({ error: 'Conflict', current: snapshot(4, ['surprise']) }, 409)) as unknown as typeof fetch;
		expect(await store.setPinned('favorites', true, fetchFn)).toBe(false);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(get(store)).toMatchObject({ snapshot: snapshot(4, ['surprise']), saving: false, error: null });
		expect(get(store).notice).toMatch(/another client.*not saved/);
	});

	it('does not roll back a newer broadcast when a write acknowledgement arrives late', async () => {
		const store = createNavigationSettingsStore(), pending = deferred<Response>(); store.applySnapshot(snapshot(3));
		const save = store.setPinned('favorites', true, vi.fn(() => pending.promise) as unknown as typeof fetch);
		store.applySnapshot(snapshot(5, ['surprise']));
		pending.resolve(response(snapshot(4, ['artists', 'albums', 'genres', 'favorites']))); await save;
		expect(get(store).snapshot).toEqual(snapshot(5, ['surprise']));
	});

	it('keeps the last confirmed snapshot on failed reload and can retry an initial failure', async () => {
		const store = createNavigationSettingsStore();
		const fetchFn = vi.fn().mockResolvedValueOnce(response({ error: 'Unavailable' }, 503)).mockResolvedValueOnce(response(snapshot(0))) as unknown as typeof fetch;
		await store.load(fetchFn); expect(get(store).snapshot).toBeNull(); expect(get(store).error).toMatch(/Could not load/);
		await store.load(fetchFn); expect(get(store)).toMatchObject({ snapshot: snapshot(0), error: null });
		await store.load(vi.fn(async () => response({}, 503)) as unknown as typeof fetch);
		expect(get(store).snapshot).toEqual(snapshot(0));
	});

	it('resets all defaults with the current server revision and no browser storage', async () => {
		const storage = vi.spyOn(Storage.prototype, 'setItem');
		try {
			const store = createNavigationSettingsStore(); store.applySnapshot(snapshot(6, ['favorites', 'tags']));
			const fetchFn = vi.fn(async () => response(snapshot(7))) as unknown as typeof fetch;
			expect(await store.resetDefaults(fetchFn)).toBe(true);
			expect(JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)).toEqual({ expectedRevision: 6, order: DEFAULT_NAVIGATION_SETTINGS.order, pinned: DEFAULT_NAVIGATION_SETTINGS.pinned });
			expect(storage).not.toHaveBeenCalled();
		} finally { storage.mockRestore(); }
	});

	it('retires pending HTTP work when server context resets', async () => {
		const store = createNavigationSettingsStore(), pending = deferred<Response>(); store.applySnapshot(snapshot(3));
		const save = store.setPinned('favorites', true, vi.fn(() => pending.promise) as unknown as typeof fetch);
		store.reset(); pending.resolve(response(snapshot(4))); expect(await save).toBe(false);
		expect(get(store)).toMatchObject({ snapshot: null, saving: false });
	});
	it('pins and orders a newly discovered page through the server before it has a saved position', async () => {
		const custom = createPublicNavigationDestinationId([{ title: 'Collections' }]);
		const store = createNavigationSettingsStore(); store.applySnapshot(snapshot(2));
		store.setAvailableDestinations(['artists', 'albums', 'genres', custom]);
		const server = vi.fn(async (_url, init) => {
			const request = JSON.parse(init!.body as string);
			return response({ version: 1, revision: request.expectedRevision + 1,
				order: request.order, pinned: request.pinned });
		}) as unknown as typeof fetch;
		expect(await store.setPinned(custom, true, server)).toBe(true);
		expect(get(store).snapshot?.order).toEqual([...NAVIGATION_DESTINATION_IDS, custom]);
		expect(get(store).snapshot?.pinned).toContain(custom);
		expect(await store.move(custom, 'earlier', server)).toBe(true);
		const saved = get(store).snapshot!;
		expect(saved.order.indexOf(custom)).toBeLessThan(saved.order.indexOf('genres'));
		const reloaded = createNavigationSettingsStore();
		expect(reloaded.applySnapshot(saved)).toBe(true);
		expect(get(reloaded).snapshot).toEqual(saved);
	});

	it('saves only the explicitly pinned new custom page, leaving unrelated discoveries unsaved', async () => {
		const [first, pinned, last] = ['First', 'Pinned', 'Last'].map(title => createPublicNavigationDestinationId([{ title }]));
		const store = createNavigationSettingsStore(); store.applySnapshot(snapshot(2));
		store.setAvailableDestinations(['artists', first, pinned, last]);
		expect(await store.setPinned(pinned, true, echoServer())).toBe(true);
		expect(get(store).snapshot?.order).toEqual([...NAVIGATION_DESTINATION_IDS, pinned]);
		expect(get(store).availableDestinations).toEqual(['artists', first, pinned, last]);
	});

	it('keeps builtin pin, unpin and reorder edits working at full saved custom capacity', async () => {
		const custom = Array.from({ length: MAX_CUSTOM_NAVIGATION_DESTINATIONS }, (_, index) =>
			createPublicNavigationDestinationId([{ title: `Saved ${index}` }]));
		const added = createPublicNavigationDestinationId([{ title: 'Newly discovered' }]);
		const store = createNavigationSettingsStore();
		store.applySnapshot({ ...snapshot(2), order: [...NAVIGATION_DESTINATION_IDS, ...custom] });
		store.setAvailableDestinations(['artists', 'albums', 'genres', ...custom, added]);
		const server = echoServer();
		expect(await store.setPinned('artists', false, server)).toBe(true);
		expect(await store.setPinned('artists', true, server)).toBe(true);
		expect(await store.move('albums', 'earlier', server)).toBe(true);
		expect(server).toHaveBeenCalledTimes(3);
		expect(get(store).snapshot?.order).not.toContain(added);
		expect(get(store).snapshot?.order.slice(0, 2)).toEqual(['albums', 'artists']);
		expect(get(store).snapshot?.pinned).toContain('artists');
		expect(get(store).error).toBeNull();
	});

	it('reports genuine custom capacity overflow without changing confirmed preferences', async () => {
		const custom = Array.from({ length: MAX_CUSTOM_NAVIGATION_DESTINATIONS }, (_, index) =>
			createPublicNavigationDestinationId([{ title: `Saved ${index}` }]));
		const added = createPublicNavigationDestinationId([{ title: 'Newly discovered' }]);
		const store = createNavigationSettingsStore();
		store.applySnapshot({ ...snapshot(2), order: [...NAVIGATION_DESTINATION_IDS, ...custom] });
		store.setAvailableDestinations(['artists', ...custom, added]);
		const previous = get(store).snapshot, server = echoServer();
		expect(await store.setPinned(added, true, server)).toBe(false);
		expect(server).not.toHaveBeenCalled();
		expect(get(store).snapshot).toBe(previous);
		expect(get(store).error).toMatch(/not saved.*64.*custom/i);
		expect(get(store).saving).toBe(false);
	});

	it('persists only the unsaved custom prefix needed to preserve an explicit one-row move', async () => {
		const [first, moved, neighbor, later] = ['First', 'Moved', 'Neighbor', 'Later'].map(title => createPublicNavigationDestinationId([{ title }]));
		const store = createNavigationSettingsStore(); store.applySnapshot(snapshot(2));
		store.setAvailableDestinations(['artists', first, moved, neighbor, later]);
		expect(await store.move(moved, 'later', echoServer())).toBe(true);
		expect(get(store).snapshot?.order).toEqual([...NAVIGATION_DESTINATION_IDS, first, neighbor, moved]);
		expect(get(store).snapshot?.pinned).toEqual(snapshot(2).pinned);
		expect(get(store).availableDestinations).toContain(later);
	});

});
