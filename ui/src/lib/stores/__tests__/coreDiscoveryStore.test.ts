import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/api/client', () => ({ fetchCoreDiscovery: vi.fn() }));
import { fetchCoreDiscovery } from '$lib/api/client';
import { coreDiscoveryStore, loadCoreDiscovery, resetCoreDiscovery, setCoreDiscovery } from '../coreDiscoveryStore';
import type { CoreDiscoveryStatus } from '@shared/coreDiscovery';

const pending: CoreDiscoveryStatus = { cores: [{
	id: 'core-a', displayName: 'Core A', host: '203.0.113.10', phase: 'awaiting-approval'
}] };

beforeEach(() => { resetCoreDiscovery(); vi.mocked(fetchCoreDiscovery).mockReset(); });

describe('discovery snapshot ordering', () => {
	it('hydrates pending approval from HTTP on a fresh page', async () => {
		vi.mocked(fetchCoreDiscovery).mockResolvedValue(pending);
		await loadCoreDiscovery(fetch);
		expect(get(coreDiscoveryStore)).toEqual(pending);
	});

	it('a late HTTP answer cannot undo a newer live observation', async () => {
		let resolve!: (status: CoreDiscoveryStatus) => void;
		vi.mocked(fetchCoreDiscovery).mockReturnValue(new Promise((done) => { resolve = done; }));
		const loading = loadCoreDiscovery(fetch); setCoreDiscovery(pending);
		resolve({ cores: [] }); await loading;
		expect(get(coreDiscoveryStore)).toEqual(pending);
	});

	it('disconnect retires pending reads and removes stale approval', async () => {
		let resolve!: (status: CoreDiscoveryStatus) => void;
		vi.mocked(fetchCoreDiscovery).mockReturnValue(new Promise((done) => { resolve = done; }));
		setCoreDiscovery(pending);
		const loading = loadCoreDiscovery(fetch); resetCoreDiscovery();
		resolve(pending); await loading;
		expect(get(coreDiscoveryStore)).toBeNull();
	});

	it('rejects malformed snapshots and projects away non-display data', () => {
		setCoreDiscovery({ cores: [{ ...pending.cores[0], token: 'secret' }] });
		expect(get(coreDiscoveryStore)).toEqual(pending);
		setCoreDiscovery({ cores: [{ ...pending.cores[0], phase: 'invented' }] });
		expect(get(coreDiscoveryStore)).toEqual(pending);
		setCoreDiscovery({ cores: [pending.cores[0], pending.cores[0]] });
		expect(get(coreDiscoveryStore)).toEqual(pending);
	});
});
