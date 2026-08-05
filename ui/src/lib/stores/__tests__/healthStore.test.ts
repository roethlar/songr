import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { HealthResponse } from '@shared/types';

const fetchHealth = vi.fn<(f: unknown) => Promise<HealthResponse>>();
vi.mock('$lib/api/client', () => ({
	fetchHealth: (...args: unknown[]) => fetchHealth(...(args as [unknown]))
}));

import { healthStore, loadHealth, setHealth } from '../healthStore';

function degraded(): HealthResponse {
	return {
		status: 'degraded',
		ready: false,
		timestamp: '2026-07-10T00:00:00Z',
		subsystems: {
			recently_played: { ready: false, degraded: true, epoch: 1, revision: 2, entry_count: 3 },
			favorites: { ready: true, degraded: false, entry_count: 4 }
		}
	};
}

beforeEach(() => {
	fetchHealth.mockReset();
	setHealth(null);
});

describe('healthStore', () => {
	it('stores the fetched snapshot, including a degraded (503-bodied) one', async () => {
		fetchHealth.mockResolvedValue(degraded());
		await loadHealth(fetch);
		expect(get(healthStore)?.ready).toBe(false);
		expect(get(healthStore)?.subsystems.recently_played?.degraded).toBe(true);
	});

	it('keeps the previous snapshot when the health fetch itself fails', async () => {
		fetchHealth.mockResolvedValue(degraded());
		await loadHealth(fetch);

		fetchHealth.mockRejectedValue(new Error('boom'));
		await loadHealth(fetch);

		// Transport failure ≠ healthy; the degraded snapshot stays.
		expect(get(healthStore)?.ready).toBe(false);
	});
});
