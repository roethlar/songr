import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/client')>();
	return { ...actual, fetchOnboardingStatus: vi.fn() };
});

import { fetchOnboardingStatus } from '$lib/api/client';
import {
	loadOnboardingStatus,
	onboardingStatusStore,
	resetOnboardingStatus
} from '../onboardingStore';

const fetchFn = (() => {
	throw new Error('unused');
}) as unknown as typeof fetch;

beforeEach(() => {
	vi.mocked(fetchOnboardingStatus).mockReset();
	resetOnboardingStatus();
});

describe('onboardingStore', () => {
	it('starts unknown so nothing renders before the server has answered', () => {
		expect(get(onboardingStatusStore)).toEqual({ everPaired: 'unknown', hostname: null });
	});

	it('publishes the server answer and normalises an empty hostname to null', async () => {
		vi.mocked(fetchOnboardingStatus).mockResolvedValue({
			everPaired: false,
			hostname: ''
		});
		await loadOnboardingStatus(fetchFn);

		expect(get(onboardingStatusStore)).toEqual({ everPaired: false, hostname: null });
	});

	it('reads once and never again, so a reconnect cannot cancel a running flow', async () => {
		vi.mocked(fetchOnboardingStatus).mockResolvedValue({
			everPaired: false,
			hostname: 'studio-desk'
		});
		await loadOnboardingStatus(fetchFn);

		// What a re-read WOULD return after pairing completes mid-flow.
		vi.mocked(fetchOnboardingStatus).mockResolvedValue({
			everPaired: true,
			hostname: 'studio-desk'
		});
		await loadOnboardingStatus(fetchFn);
		await loadOnboardingStatus(fetchFn);

		expect(fetchOnboardingStatus).toHaveBeenCalledTimes(1);
		expect(get(onboardingStatusStore).everPaired).toBe(false);
	});

	it('shares one in-flight read between concurrent callers', async () => {
		vi.mocked(fetchOnboardingStatus).mockResolvedValue({
			everPaired: false,
			hostname: 'studio-desk'
		});
		await Promise.all([
			loadOnboardingStatus(fetchFn),
			loadOnboardingStatus(fetchFn),
			loadOnboardingStatus(fetchFn)
		]);

		expect(fetchOnboardingStatus).toHaveBeenCalledTimes(1);
	});

	it('fails closed on error — stays unknown, and does not latch the failure', async () => {
		vi.mocked(fetchOnboardingStatus).mockRejectedValueOnce(new Error('offline'));
		await loadOnboardingStatus(fetchFn);
		expect(get(onboardingStatusStore)).toEqual({ everPaired: 'unknown', hostname: null });

		vi.mocked(fetchOnboardingStatus).mockResolvedValue({
			everPaired: false,
			hostname: 'studio-desk'
		});
		await loadOnboardingStatus(fetchFn);
		expect(get(onboardingStatusStore)).toEqual({
			everPaired: false,
			hostname: 'studio-desk'
		});
	});
});
