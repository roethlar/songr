import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingStatusResponse, Zone } from '@shared/types';
import { CORE_DISCOVERY_WAIT_MS, type DiscoveredCore } from '@shared/coreDiscovery';

vi.mock('$lib/api/client', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/api/client')>(),
	fetchOnboardingStatus: vi.fn(), fetchCoreDiscovery: vi.fn(), fetchZones: vi.fn()
}));

import { fetchOnboardingStatus, fetchCoreDiscovery, fetchZones } from '$lib/api/client';
import { setCoreStatus } from '$lib/stores/coreStore';
import { resetCoreDiscovery, setCoreDiscovery } from '$lib/stores/coreDiscoveryStore';
import { resetOnboardingStatus } from '$lib/stores/onboardingStore';
import { selectedZoneStore, setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setSocketStatus } from '$lib/stores/socketStatusStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import OnboardingFlow from '../OnboardingFlow.svelte';

const LOCAL_HOST = 'studio-desk';
const candidate: DiscoveredCore = {
	id: 'core-a', displayName: 'Studio Core', host: '203.0.113.10', phase: 'connecting'
};
const localZone = {
	zone_id: 'z-local', display_name: 'Studio Desk', state: 'stopped',
	outputs: [{ output_id: 'o-local', display_name: LOCAL_HOST }]
} as Zone;

function status(overrides: Partial<OnboardingStatusResponse> = {}): OnboardingStatusResponse {
	return { everPaired: false, hostname: LOCAL_HOST, ...overrides };
}
async function settle(): Promise<void> { await tick(); await tick(); }
async function start(): Promise<void> {
	render(OnboardingFlow);
	await screen.findByTestId('onboarding-flow');
	await settle();
}
async function pair(): Promise<void> {
	setCoreStatus({ status: 'paired', core: { id: 'core-a', displayName: 'Studio Core', displayVersion: '2' } });
	await settle();
}

beforeEach(() => {
	vi.mocked(fetchOnboardingStatus).mockReset().mockResolvedValue(status());
	vi.mocked(fetchCoreDiscovery).mockReset().mockResolvedValue({ cores: [] });
	vi.mocked(fetchZones).mockReset().mockResolvedValue([]);
	resetOnboardingStatus(); resetCoreDiscovery();
	setCoreStatus({ status: 'discovering' });
	setZonesSnapshot([]); setSelectedZone(''); setSocketStatus('connected');
});
afterEach(() => { vi.useRealTimers(); });

describe('OnboardingFlow — discovery and approval', () => {
	it('searches on first run without telling the user to approve an undiscovered extension', async () => {
		await start();
		expect(screen.getByRole('heading', { name: 'Connect to your Roon Core' })).toBeInTheDocument();
		expect(screen.getByTestId('onboarding-flow')).toHaveAttribute('aria-modal', 'true');
		expect(screen.getByText(/searching your local network/i)).toBeInTheDocument();
		expect(screen.queryByTestId('onboarding-approval-instructions')).toBeNull();
		expect(screen.queryByText(/settings → extensions/i)).toBeNull();
	});

	it('shows no-Core-found guidance after a bounded wait and recovers automatically', async () => {
		vi.useFakeTimers(); render(OnboardingFlow); await settle();
		await vi.advanceTimersByTimeAsync(CORE_DISCOVERY_WAIT_MS - 1);
		expect(screen.queryByText(/no roon core found yet/i)).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		expect(screen.getByText(/no roon core found yet/i)).toBeInTheDocument();
		expect(screen.getByText(/a firewall such as ufw/i)).toBeInTheDocument();
		expect(screen.getByText(/cannot determine whether a firewall/i)).toBeInTheDocument();
		expect(screen.queryByTestId('onboarding-approval-instructions')).toBeNull();
		setCoreDiscovery({ cores: [candidate] }); await settle();
		expect(screen.getByText('Studio Core')).toBeInTheDocument();
		expect(screen.getByText('203.0.113.10')).toBeInTheDocument();
		expect(screen.getByText(/discovered · connecting/i)).toBeInTheDocument();
		expect(screen.queryByText(/no roon core found yet/i)).toBeNull();
		expect(screen.queryByTestId('onboarding-approval-instructions')).toBeNull();
	});

	it('shows approval instructions only for a reachable Core with registration submitted', async () => {
		await start();
		setCoreDiscovery({ cores: [{ ...candidate, phase: 'registering' }] }); await settle();
		expect(screen.getByText(/reading core identity/i)).toBeInTheDocument();
		expect(screen.queryByTestId('onboarding-approval-instructions')).toBeNull();
		setCoreDiscovery({ cores: [{ ...candidate, phase: 'awaiting-approval' }] }); await settle();
		expect(screen.getByTestId('onboarding-approval-instructions')).toHaveTextContent(`Songr (${LOCAL_HOST})`);
		expect(screen.getByText(/waiting for approval in roon/i)).toBeInTheDocument();
		setCoreDiscovery({ cores: [{ ...candidate, phase: 'failed', detail: 'Connecting to the Core failed (ECONNREFUSED).' }] }); await settle();
		expect(screen.queryByTestId('onboarding-approval-instructions')).toBeNull();
		expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
	});

	it('shows independent Core statuses, including failure alongside pending approval', async () => {
		await start();
		setCoreDiscovery({ cores: [
			{ ...candidate, phase: 'failed', detail: 'Reading the Core identity timed out.' },
			{ ...candidate, id: 'core-b', displayName: 'Other Core', phase: 'awaiting-approval' }
		] }); await settle();
		expect(screen.getAllByRole('listitem')).toHaveLength(2);
		expect(screen.getByText(/identity timed out/)).toBeInTheDocument();
		expect(screen.getByText('Other Core')).toBeInTheDocument();
		expect(screen.getByTestId('onboarding-approval-instructions')).toBeInTheDocument();
	});

	it('hides stale approval while disconnected and refreshes on reconnect', async () => {
		await start();
		setCoreDiscovery({ cores: [{ ...candidate, phase: 'awaiting-approval' }] }); await settle();
		setSocketStatus('connecting'); await settle();
		expect(screen.getByTestId('onboarding-core-status')).toHaveTextContent(/reconnecting/i);
		expect(screen.queryByTestId('onboarding-approval-instructions')).toBeNull();
		setSocketStatus('connected'); await settle();
		expect(fetchCoreDiscovery).toHaveBeenCalledTimes(2);
		expect(screen.queryByTestId('onboarding-approval-instructions')).toBeNull();
	});

	it('does not mistake an unavailable discovery snapshot for no Core found', async () => {
		vi.useFakeTimers();
		vi.mocked(fetchCoreDiscovery).mockRejectedValue(new Error('unavailable'));
		render(OnboardingFlow); await settle();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(screen.getByTestId('onboarding-core-status')).toHaveTextContent(/waiting for discovery status/i);
		expect(screen.queryByText(/no roon core found yet/i)).toBeNull();
	});
});

describe('OnboardingFlow — completion and optional local playback', () => {
	it('removes the blocking dialog immediately on pairing and offers an optional Bridge note', async () => {
		await start(); await pair();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.queryByTestId('onboarding-flow')).toBeNull();
		expect(screen.getByTestId('onboarding-bridge-note')).not.toHaveAttribute('aria-modal');
		expect(screen.getByText(/Songr is ready to use/)).toBeInTheDocument();
		expect(screen.getByText(/download and install/)).toHaveTextContent('Settings → Audio');
		expect(screen.getByRole('link', { name: /get roon bridge/i })).toHaveAttribute('href', 'https://roon.app/downloads');
		expect(screen.getByRole('link', { name: /get roon bridge/i })).toHaveAttribute('rel', expect.stringContaining('noopener'));
		expect(fetchZones).not.toHaveBeenCalled();
	});

	it('needs no hostname or zone discovery to complete', async () => {
		vi.mocked(fetchOnboardingStatus).mockResolvedValue(status({ hostname: '' }));
		await start(); await pair();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByTestId('onboarding-bridge-note')).toBeInTheDocument();
	});

	it('selects an already-known local output once and omits the Bridge note', async () => {
		setZonesSnapshot([localZone]); await start(); await pair();
		expect(get(selectedZoneStore)).toBe('z-local');
		expect(screen.queryByTestId('onboarding-bridge-note')).toBeNull();
		setSelectedZone('another-zone'); setZonesSnapshot([]); setCoreStatus({ status: 'unpaired' }); await settle();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(get(selectedZoneStore)).toBe('another-zone');
	});

	it('dismisses the note without reopening setup or stealing a later zone selection', async () => {
		await start(); await pair();
		await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
		setSelectedZone('another-zone'); setZonesSnapshot([localZone]); setCoreStatus({ status: 'discovering' }); await settle();
		expect(screen.queryByTestId('onboarding-bridge-note')).toBeNull();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(get(selectedZoneStore)).toBe('another-zone');
	});

	it('dismisses the note when a Bridge arrives without polling or changing selection', async () => {
		await start(); await pair(); vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fetchZones).not.toHaveBeenCalled();
		setSelectedZone('another-zone'); setZonesSnapshot([localZone]); await settle();
		expect(screen.queryByTestId('onboarding-bridge-note')).toBeNull();
		expect(get(selectedZoneStore)).toBe('another-zone');
	});
});

describe('OnboardingFlow — established-install and palette guards', () => {
	it('never appears for an established install even when its Core is unreachable', async () => {
		vi.mocked(fetchOnboardingStatus).mockResolvedValue(status({ everPaired: true }));
		render(OnboardingFlow);
		await waitFor(() => expect(fetchOnboardingStatus).toHaveBeenCalled()); await settle();
		expect(screen.queryByRole('dialog')).toBeNull(); await pair();
		expect(screen.queryByTestId('onboarding-bridge-note')).toBeNull();
	});

	it('stays hidden when the first-run read fails', async () => {
		vi.mocked(fetchOnboardingStatus).mockRejectedValue(new Error('offline'));
		render(OnboardingFlow); await settle();
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('references no theme tokens so first-run text is readable before a theme exists', async () => {
		const fs = await import('node:fs'); const path = await import('node:path');
		const source = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/components/OnboardingFlow.svelte'), 'utf8');
		expect(source.slice(source.indexOf('<style>'))).not.toContain('var(--');
	});
});
