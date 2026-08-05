import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createLibraryViewHostStateStore } from '../libraryViewHostStore';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe('libraryViewHostStore', () => {
	it('publishes one valid transition only for the current host claim', () => {
		const hostState = createLibraryViewHostStateStore();
		const first = hostState.claim();
		first.publishActiveMode('classic');
		expect(get(hostState.store)).toEqual({
			activeMode: 'classic',
			pendingMode: null,
			transition: null
		});

		const replacement = hostState.claim();
		expect(get(hostState.store)).toEqual({
			activeMode: null,
			pendingMode: null,
			transition: null
		});
		first.publishActiveMode('timeline', {
			fromMode: 'timeline',
			toMode: 'classic'
		});
		first.release();
		expect(get(hostState.store)).toEqual({
			activeMode: null,
			pendingMode: null,
			transition: null
		});

		replacement.publishActiveMode(null, null, 'timeline');
		expect(get(hostState.store)).toEqual({
			activeMode: null,
			pendingMode: 'timeline',
			transition: null
		});

		replacement.publishActiveMode('timeline', {
			fromMode: 'timeline',
			toMode: 'classic'
		});
		const transitionState = get(hostState.store);
		expect(transitionState).toEqual({
			activeMode: 'timeline',
			pendingMode: 'classic',
			transition: {
				fromMode: 'timeline',
				toMode: 'classic'
			}
		});
		expect(Object.isFrozen(transitionState)).toBe(true);
		expect(Object.isFrozen(transitionState.transition)).toBe(true);

		replacement.publishActiveMode('timeline', {
			fromMode: 'classic',
			toMode: 'timeline'
		});
		expect(get(hostState.store)).toEqual({
			activeMode: 'timeline',
			pendingMode: null,
			transition: null
		});
		replacement.release();
		expect(get(hostState.store)).toEqual({
			activeMode: null,
			pendingMode: null,
			transition: null
		});
	});

	it('routes bounded user-switch outcomes only through the current host claim', async () => {
		const hostState = createLibraryViewHostStateStore();
		const first = hostState.claim();
		const firstHandler = vi.fn(async () => 'activated' as const);
		first.handleRequests(firstHandler);

		await expect(hostState.request('timeline')).resolves.toBe('activated');
		expect(firstHandler).toHaveBeenCalledWith('timeline');

		const second = hostState.claim();
		expect(hostState.request('classic')).toBeNull();
		second.handleRequests(vi.fn(async () => 'failed' as const));
		first.release();
		await expect(hostState.request('classic')).resolves.toBe('failed');

		second.release();
		expect(hostState.request('classic')).toBeNull();
	});

	it('routes only validated keyless Classic intents with outcomes from the current host claim', async () => {
		const hostState = createLibraryViewHostStateStore();
		const first = hostState.claim();
		const firstHandler = vi.fn(async () => 'activated' as const);
		first.handleOpenClassicRequests(firstHandler);

		const firstActivation = hostState.openClassic({
			kind: 'album',
			destination: 'search',
			query: 'Homogenic',
			localDescriptorId: 'album-local-id',
			display: { title: 'Homogenic', artist: 'Björk' }
		});
		expect(firstActivation).not.toBeNull();
		await expect(firstActivation!).resolves.toBe('activated');
		expect(firstHandler).toHaveBeenCalledWith({
			kind: 'album',
			destination: 'search',
			query: 'Homogenic',
			localDescriptorId: 'album-local-id',
			display: { title: 'Homogenic', artist: 'Björk' }
		});
		expect(hostState.openClassic({
			kind: 'album',
			destination: 'search',
			query: 'Homogenic',
			itemKey: 'must-not-cross'
		})).toBeNull();

		const second = hostState.claim();
		expect(hostState.openClassic({
			kind: 'general',
			destination: 'welcome-section',
			section: 'favorites'
		})).toBeNull();
		const secondHandler = vi.fn(async () => 'failed' as const);
		second.handleOpenClassicRequests(secondHandler);
		first.release();
		const secondActivation = hostState.openClassic({
			kind: 'general',
			destination: 'welcome-section',
			section: 'recently-played'
		});
		expect(secondActivation).not.toBeNull();
		await expect(secondActivation!).resolves.toBe('failed');
		expect(secondHandler).toHaveBeenCalledTimes(1);

		second.release();
		expect(hostState.openClassic({
			kind: 'general',
			destination: 'welcome-section',
			section: 'favorites'
		})).toBeNull();
	});

	it('reports failure when the current Classic request handler throws', async () => {
		const hostState = createLibraryViewHostStateStore();
		const owner = hostState.claim();
		owner.publishActiveMode('timeline');
		owner.handleOpenClassicRequests(() => {
			throw new Error('request failed synchronously');
		});

		const activation = hostState.openClassic({
			kind: 'general',
			destination: 'welcome-section',
			section: 'favorites'
		});
		expect(activation).not.toBeNull();
		await expect(activation!).resolves.toBe('failed');
		expect(get(hostState.store)).toEqual({
			activeMode: 'timeline',
			pendingMode: null,
			transition: null
		});
	});

	it.each(['resolve', 'reject'] as const)(
		'supersedes a Classic outcome that settles by %s after its host claim is replaced',
		async (settlement) => {
			const hostState = createLibraryViewHostStateStore();
			const completion = deferred<'activated'>();
			const first = hostState.claim();
			first.handleOpenClassicRequests(vi.fn(() => completion.promise));
			const activation = hostState.openClassic({
				kind: 'general',
				destination: 'welcome-section',
				section: 'favorites'
			});
			expect(activation).not.toBeNull();

			const replacement = hostState.claim();
			const replacementHandler = vi.fn(async () => 'activated' as const);
			replacement.handleOpenClassicRequests(replacementHandler);
			replacement.publishActiveMode('classic');
			if (settlement === 'resolve') completion.resolve('activated');
			else completion.reject(new Error('stale handler failed'));

			await expect(activation!).resolves.toBe('superseded');
			expect(replacementHandler).not.toHaveBeenCalled();
			expect(get(hostState.store)).toEqual({
				activeMode: 'classic',
				pendingMode: null,
				transition: null
			});
		}
	);
});
