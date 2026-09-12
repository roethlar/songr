import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { UpdateCheckResult } from '@shared/updateCheck';
import { createUpdateCheckStore } from '../updateCheckStore';

const result = (changes: Partial<UpdateCheckResult> = {}): UpdateCheckResult => ({
	currentVersion: '1.4.3', status: 'update-available', latestVersion: '1.4.4',
	releaseUrl: 'https://github.com/roethlar/songr/releases/tag/v1.4.4',
	checkedAt: '2026-09-12T12:00:00Z', ...changes
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('manual connected-server update check', () => {
	it('reads server metadata without triggering a release check or using the UI build version', async () => {
		const store = createUpdateCheckStore();
		const fetchFn = vi.fn(async () => response({ currentVersion: '1.2.7' }));
		await store.loadVersion(fetchFn);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(fetchFn).toHaveBeenCalledWith('/api/updates', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
		expect(get(store)).toMatchObject({ currentVersion: '1.2.7', result: null, checking: false });
	});
	it('checks on demand and takes version/result from the responding server', async () => {
		const store = createUpdateCheckStore();
		const remote = result({ currentVersion: '1.2.7' });
		const fetchFn = vi.fn(async () => response(remote));
		await store.check(fetchFn);
		expect(fetchFn).toHaveBeenCalledWith('/api/updates/check', expect.objectContaining({ method: 'POST' }));
		expect(get(store)).toMatchObject({ currentVersion: '1.2.7', result: remote, error: null, checking: false });
	});
	it.each(['current', 'ahead', 'no-release'] as const)('retains the distinct %s outcome', async status => {
		const store = createUpdateCheckStore();
		const value = result({ status, ...(status === 'no-release' ? { latestVersion: null, releaseUrl: null } : {}) });
		await store.check(vi.fn(async () => response(value)));
		expect(get(store).result?.status).toBe(status);
		expect(get(store).error).toBeNull();
	});
	it('accepts the fixed-repository release link with encoded build metadata', async () => {
		const store = createUpdateCheckStore();
		await store.check(vi.fn(async () => response(result({ latestVersion: '1.4.4+build',
			releaseUrl: 'https://github.com/roethlar/songr/releases/tag/v1.4.4%2Bbuild' }))));
		expect(get(store).result?.status).toBe('update-available');
		expect(get(store).error).toBeNull();
	});
	it('does not let a slow metadata request overwrite a completed manual check', async () => {
		const store = createUpdateCheckStore(), pending = deferred<Response>();
		const reading = store.loadVersion(vi.fn(() => pending.promise));
		await store.check(vi.fn(async () => response(result())));
		pending.resolve(response({ currentVersion: '1.0.0' })); await reading;
		expect(get(store).currentVersion).toBe('1.4.3');
		expect(get(store).result?.status).toBe('update-available');
	});
	it('does not issue another check while a request is pending', async () => {
		const store = createUpdateCheckStore(), pending = deferred<Response>();
		const fetchFn = vi.fn(() => pending.promise);
		const first = store.check(fetchFn);
		await store.check(fetchFn);
		expect(get(store).checking).toBe(true); expect(fetchFn).toHaveBeenCalledTimes(1);
		pending.resolve(response(result())); await first;
		expect(get(store).checking).toBe(false);
	});
	it.each([
		[result({ status: 'current' }), 500],
		[{ currentVersion: '1.4.3' }, 200],
		[result({ releaseUrl: 'https://example.com/unrelated' }), 200],
		[result({ releaseUrl: 'javascript:alert(1)' }), 200],
		[{ ...result(), status: 'unknown' }, 200],
	])('clears an earlier success when a subsequent check is invalid', async (body, status) => {
		const store = createUpdateCheckStore();
		await store.check(vi.fn(async () => response(result({ status: 'current' }))));
		await store.check(vi.fn(async () => response(body, status as number)));
		expect(get(store).result).toBeNull(); expect(get(store).error).toContain('Could not check');
	});
	it('shows an upstream outage as failure, retaining the actual installed version', async () => {
		const store = createUpdateCheckStore();
		await store.check(vi.fn(async () => response(result({ status: 'unavailable', latestVersion: null,
			releaseUrl: null, message: 'GitHub is temporarily unavailable.' }), 503)));
		expect(get(store)).toMatchObject({ currentVersion: '1.4.3', error: 'GitHub is temporarily unavailable.', checking: false });
	});
	it('clears stale release results when a reopened Settings reads a changed server version', async () => {
		const store = createUpdateCheckStore();
		await store.check(vi.fn(async () => response(result())));
		await store.loadVersion(vi.fn(async () => response({ currentVersion: '1.4.4' })));
		expect(get(store)).toMatchObject({ currentVersion: '1.4.4', result: null });
	});
	it('aborts a stalled request and allows retry without holding the checking state', async () => {
		vi.useFakeTimers();
		const store = createUpdateCheckStore();
		const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
		}));
		const pending = store.check(fetchFn);
		await vi.advanceTimersByTimeAsync(8_000); await pending;
		expect(get(store)).toMatchObject({ checking: false, result: null });
		expect(get(store).error).toContain('Could not check');
		await store.check(vi.fn(async () => response(result())));
		expect(get(store).result?.status).toBe('update-available');
	});
	it('ignores a response arriving after the store is reset', async () => {
		const store = createUpdateCheckStore(), pending = deferred<Response>();
		const checking = store.check(vi.fn(() => pending.promise));
		store.reset(); pending.resolve(response(result())); await checking;
		expect(get(store)).toMatchObject({ currentVersion: null, result: null, checking: false, error: null });
	});
});
