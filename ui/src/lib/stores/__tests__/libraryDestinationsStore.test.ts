import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import type { BrowseResult } from '@shared/types';
import { createPublicNavigationDestinationId } from '@shared/navigationSettings';
import type { ClassicBrowseRoleTransaction } from '../classicBrowseSessionStore';
import { createDefaultLibraryDestinationInventory, type LibraryDestinationInventory } from '$lib/library/LibraryDestinations';
import {
	createLibraryDestinationsStore,
	type LibraryDestinationsSessionClient
} from '../libraryDestinationsStore';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
function inventory(label = 'Browse'): LibraryDestinationInventory {
	return { destinations: createDefaultLibraryDestinationInventory().destinations, fallback: { id: 'browse', label,
		snapshot: { context: { hierarchy: 'browse' }, history: [], forward: [] } }, diagnostics: [] };
}
function client() {
	let claimId = 0;
	const request = vi.fn(async () => ({ action: 'list', title: 'Explore', level: 0,
		offset: 0, count: 0, totalCount: 0, items: [] } as BrowseResult));
	const claim = vi.fn(() => ({ owner: 'normal-shell', claimId: ++claimId,
		ready: Promise.resolve({ handleId: `inventory-${claimId}`, generation: 1 }) }));
	const release = vi.fn();
	const transaction = vi.fn(async (_claim, _role, work) => work({ request } as unknown as ClassicBrowseRoleTransaction));
	return { request, claim, release, transaction, api: { claim, release, transaction } as unknown as LibraryDestinationsSessionClient };
}

describe('isolated Library destination discovery lifecycle', () => {
	it('has no mount/import activity and uses only its own classic-explore read transaction', async () => {
		const session = client();
		const store = createLibraryDestinationsStore({ client: session.api });
		expect(session.claim).not.toHaveBeenCalled();
		expect(get(store)).toEqual({ inventory: inventory(), loading: false, error: null });
		await store.load('zone-a');
		expect(session.claim).toHaveBeenCalledTimes(1);
		expect(session.transaction).toHaveBeenCalledWith(session.claim.mock.results[0].value, 'classic-explore', expect.any(Function));
		expect(session.request).toHaveBeenCalledWith('browse', { hierarchy: 'browse', popAll: true, pageSize: 100, zoneId: 'zone-a' });
		expect(session.release).toHaveBeenCalledExactlyOnceWith(session.claim.mock.results[0].value);
		expect(get(store)).toEqual({ inventory: inventory(), loading: false, error: null });
	});

	it('coalesces concurrent discovery for the same zone, then allows an explicit refresh', async () => {
		const session = client();
		const pending = deferred<LibraryDestinationInventory>();
		const discover = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(inventory('Fresh'));
		const store = createLibraryDestinationsStore({ client: session.api, loadDestinations: discover });
		const first = store.load('zone-a');
		expect(store.load('zone-a')).toBe(first);
		expect(session.claim).toHaveBeenCalledTimes(1);
		pending.resolve(inventory());
		await first;
		await store.load('zone-a');
		expect(session.claim).toHaveBeenCalledTimes(2);
		expect(get(store).inventory?.fallback.label).toBe('Fresh');
	});

	it('reset releases once, suppresses late results, and prevents the next inventory read', async () => {
		const session = client();
		const command = deferred<BrowseResult>();
		session.request.mockReturnValueOnce(command.promise);
		const discover = vi.fn(async (transaction) => {
			await transaction.browse({ hierarchy: 'browse', popAll: true });
			await transaction.browseLoad({ hierarchy: 'browse', offset: 1, count: 1 });
			return inventory('Stale');
		});
		const store = createLibraryDestinationsStore({ client: session.api, loadDestinations: discover });
		const loading = store.load();
		store.reset();
		command.resolve({ level: 0, offset: 0, count: 0, totalCount: 0, items: [] });
		await loading;
		expect(session.request).toHaveBeenCalledTimes(1);
		expect(session.release).toHaveBeenCalledTimes(1);
		expect(get(store)).toEqual({ inventory: inventory(), loading: false, error: null });
	});

	it('a late result from the old zone cannot overwrite or release the new discovery', async () => {
		const session = client();
		const old = deferred<LibraryDestinationInventory>();
		const fresh = deferred<LibraryDestinationInventory>();
		const store = createLibraryDestinationsStore({ client: session.api,
			loadDestinations: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) });
		const first = store.load('old-zone');
		const second = store.load('new-zone');
		old.resolve(inventory('Old'));
		await first;
		expect(get(store)).toEqual({ inventory: inventory(), loading: true, error: null });
		expect(session.release).toHaveBeenCalledTimes(1);
		fresh.resolve(inventory('New'));
		await second;
		expect(get(store).inventory?.fallback.label).toBe('New');
		expect(session.release.mock.calls.map(([claim]) => claim.claimId)).toEqual([1, 2]);
	});

	it('can retry after synchronous claim failure without retaining a settled in-flight promise', async () => {
		const session = client();
		session.claim.mockImplementationOnce(() => { throw new Error('Identity unavailable'); });
		const store = createLibraryDestinationsStore({ client: session.api });
		await store.load();
		expect(get(store).error).toBe('Identity unavailable');
		await store.load();
		expect(session.claim).toHaveBeenCalledTimes(2);
		expect(get(store).inventory).not.toBeNull();
	});

	it('surfaces callback failures, releases its lease, and can retry', async () => {
		const session = client();
		const discover = vi.fn().mockRejectedValueOnce(new Error('Core disconnected')).mockResolvedValue(inventory());
		const store = createLibraryDestinationsStore({ client: session.api, loadDestinations: discover });
		await store.load();
		expect(get(store)).toEqual({ inventory: inventory(), loading: false, error: 'Core disconnected' });
		expect(session.release).toHaveBeenCalledTimes(1);
		await store.load();
		expect(get(store).error).toBeNull();
		expect(session.release).toHaveBeenCalledTimes(2);
	});
	it('keeps previously discovered pages visible throughout a same-zone refresh and failure', async () => {
		const session = client();
		const refresh = deferred<LibraryDestinationInventory>();
		const known = inventory('Existing destinations');
		const discover = vi.fn().mockResolvedValueOnce(known).mockReturnValueOnce(refresh.promise)
			.mockRejectedValueOnce(new Error('Core disconnected'));
		const store = createLibraryDestinationsStore({ client: session.api, loadDestinations: discover });
		await store.load('same-zone');
		const refreshing = store.load('same-zone');
		expect(get(store)).toEqual({ inventory: known, loading: true, error: null });
		refresh.resolve(known);
		await refreshing;
		await store.load('same-zone');
		expect(get(store)).toEqual({ inventory: known, loading: false, error: 'Core disconnected' });
	});

	it('clears prior custom inventory on a zone change while keeping the known pages selectable', async () => {
		const session = client();
		const next = deferred<LibraryDestinationInventory>();
		const store = createLibraryDestinationsStore({ client: session.api,
			loadDestinations: vi.fn().mockResolvedValueOnce(inventory('Old Core')).mockReturnValueOnce(next.promise) });
		await store.load('old-zone');
		const loading = store.load('new-zone');
		expect(get(store)).toEqual({ inventory: inventory(), loading: true, error: null });
		next.resolve(inventory('New Core'));
		await loading;
		expect(get(store).inventory?.fallback.label).toBe('New Core');
	});

	it.each(['root', 'Library'])('keeps discovered pages when %s reports a public diagnostic during refresh', async (branch) => {
		const session = client();
		const previous = inventory();
		const custom = { id: createPublicNavigationDestinationId([{ title: 'Library' }, { title: 'A custom collection' }]),
			label: 'A custom collection', snapshot: { context: { hierarchy: 'browse' as const },
				history: ['Library', 'A custom collection'].map(title => ({ hierarchy: 'browse' as const, breadcrumb: { title } })), forward: [] } };
		previous.destinations.push(custom);
		const diagnostic = inventory();
		diagnostic.diagnostics.push({ branch, message: 'Please reconnect.', isError: true });
		const store = createLibraryDestinationsStore({ client: session.api,
			loadDestinations: vi.fn().mockResolvedValueOnce(previous).mockResolvedValueOnce(diagnostic) });
		await store.load('same-zone');
		await store.load('same-zone');
		expect(get(store).inventory?.destinations).toContainEqual(custom);
		expect(get(store).inventory?.diagnostics).toEqual(diagnostic.diagnostics);
	});

});
