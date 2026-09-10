import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtworkRequests } from '../artworkRequests';

function pendingFetch() {
	const pending: Array<{ url: string; signal: AbortSignal; finish(status?: number, headers?: HeadersInit): void }> = [];
	const fetcher = vi.fn<typeof fetch>((input, init) => new Promise<Response>(resolve => {
		pending.push({ url: String(input), signal: init!.signal!, finish(status = 200, headers) {
			resolve(new Response(new Uint8Array([1, 2, 3]), { status, headers }));
		} });
	}));
	return { fetcher, pending };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('artwork request admission', () => {
	it('admits visible URLs before lookahead and bounds actual active requests', async () => {
		const { fetcher, pending } = pendingFetch();
		const queue = createArtworkRequests({ fetch: fetcher });
		queue.request('/near', 2, vi.fn());
		for (let index = 0; index < 8; index++) queue.request(`/visible-${index}`, 0, vi.fn());
		await settle();
		expect(pending.map(value => value.url)).toEqual(['/visible-0', '/visible-1', '/visible-2', '/visible-3']);
		pending[0].finish();
		await settle();
		expect(pending.at(-1)?.url).toBe('/visible-4');
	});

	it('drops stale queued rows without releasing started Core work on rapid scrolling', async () => {
		const { fetcher, pending } = pendingFetch();
		const queue = createArtworkRequests({ fetch: fetcher });
		const old = Array.from({ length: 30 }, (_, index) => queue.request(`/old-${index}`, 0, vi.fn()));
		await settle();
		for (const interest of old) interest.dispose();
		for (let index = 0; index < 100; index++) {
			const skipped = queue.request(`/skipped-${index}`, 0, vi.fn());
			skipped.dispose();
		}
		queue.request('/destination', 0, vi.fn());
		await settle();
		expect(pending).toHaveLength(4);
		expect(pending.every(value => !value.signal.aborted)).toBe(true);
		pending[0].finish();
		await settle();
		expect(pending.map(value => value.url)).toEqual(['/old-0', '/old-1', '/old-2', '/old-3', '/destination']);
	});

	it('shares an active URL across scopes and ignores obsolete completed handles', async () => {
		const { fetcher, pending } = pendingFetch();
		const queue = createArtworkRequests({ fetch: fetcher });
		const firstDone = vi.fn();
		const secondDone = vi.fn();
		const old = queue.request('/same', 1, firstDone);
		await settle();
		old.dispose();
		queue.request('/same', 0, secondDone);
		await settle();
		expect(pending).toHaveLength(1);
		pending[0].finish();
		await settle();
		expect(firstDone).not.toHaveBeenCalled();
		expect(secondDone).toHaveBeenCalledWith({ ok: true });
		const thirdDone = vi.fn();
		queue.request('/same', 0, thirdDone);
		old.dispose();
		await settle();
		expect(pending).toHaveLength(2);
		pending[1].finish();
		await settle();
		expect(thirdDone).toHaveBeenCalledWith({ ok: true });
	});

	it('holds the admission slot until the complete response body reaches the HTTP cache', async () => {
		let finishBody!: (value: ArrayBuffer) => void;
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue({
			ok: true, arrayBuffer: () => new Promise(resolve => { finishBody = resolve; })
		} as Response);
		const queue = createArtworkRequests({ fetch: fetcher, concurrency: 1 });
		const done = vi.fn();
		queue.request('/first', 0, done);
		queue.request('/next', 0, vi.fn());
		await settle();
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(done).not.toHaveBeenCalled();
		finishBody(new ArrayBuffer(3));
		await settle();
		expect(done).toHaveBeenCalledWith({ ok: true });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it.each([429, 503, 504])('automatically recovers transient HTTP %i with a bounded delay', async status => {
		const { fetcher, pending } = pendingFetch();
		const queue = createArtworkRequests({ fetch: fetcher });
		const done = vi.fn();
		queue.request('/cover', 0, done);
		await settle();
		pending[0].finish(status);
		await settle();
		await vi.advanceTimersByTimeAsync(499);
		expect(pending).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		pending[1].finish();
		await settle();
		expect(done).toHaveBeenCalledWith({ ok: true });
	});

	it('honors a one-minute Retry-After and cancels that wait when its scope leaves', async () => {
		const { fetcher, pending } = pendingFetch();
		const queue = createArtworkRequests({ fetch: fetcher });
		const interest = queue.request('/limited', 0, vi.fn());
		await settle();
		pending[0].finish(429, { 'Retry-After': '60' });
		await settle();
		await vi.advanceTimersByTimeAsync(59_999);
		expect(pending).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(pending).toHaveLength(2);
		pending[1].finish(429, { 'Retry-After': '60' });
		await settle();
		interest.dispose();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(pending).toHaveLength(2);
	});

	it('slows persistent transient failures and recovers when Core returns without navigation', async () => {
		let transientAttempts = 0;
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => new Response('', {
			status: input === '/missing' ? 404 : ++transientAttempts <= 3 ? 503 : 200
		}));
		const queue = createArtworkRequests({ fetch: fetcher });
		const missing = vi.fn();
		const unavailable = vi.fn();
		queue.request('/missing', 0, missing);
		queue.request('/unavailable', 0, unavailable);
		await vi.advanceTimersByTimeAsync(31_999);
		expect(fetcher.mock.calls.filter(([url]) => url === '/missing')).toHaveLength(1);
		expect(transientAttempts).toBe(3);
		expect(missing).toHaveBeenCalledWith({ ok: false, retryable: false });
		expect(unavailable).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(transientAttempts).toBe(4);
		expect(unavailable).toHaveBeenCalledWith({ ok: true });
		await vi.advanceTimersByTimeAsync(300_000);
		expect(transientAttempts).toBe(4);
	});

	it('removes delayed retries when their scope leaves without disturbing another URL', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
		const queue = createArtworkRequests({ fetch: fetcher });
		const done = vi.fn();
		const interest = queue.request('/old', 0, done);
		await settle();
		interest.dispose();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(done).not.toHaveBeenCalled();
	});
});
