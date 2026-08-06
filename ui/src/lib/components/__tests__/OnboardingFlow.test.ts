import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingStatusResponse, Zone } from '@shared/types';

vi.mock('$lib/api/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/client')>();
	return {
		...actual,
		fetchOnboardingStatus: vi.fn(),
		fetchZones: vi.fn()
	};
});

import { fetchOnboardingStatus, fetchZones } from '$lib/api/client';
import { setCoreStatus } from '$lib/stores/coreStore';
import { resetOnboardingStatus } from '$lib/stores/onboardingStore';
import { selectedZoneStore, setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setSocketStatus } from '$lib/stores/socketStatusStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import OnboardingFlow from '../OnboardingFlow.svelte';

const LOCAL_HOST = 'studio-desk';

function zone(overrides: Partial<Zone> & Pick<Zone, 'zone_id' | 'display_name'>): Zone {
	return {
		state: 'stopped',
		is_play_allowed: true,
		is_pause_allowed: false,
		is_previous_allowed: false,
		is_next_allowed: false,
		is_seek_allowed: false,
		outputs: [],
		...overrides
	} as Zone;
}

function status(overrides: Partial<OnboardingStatusResponse> = {}): OnboardingStatusResponse {
	return { everPaired: false, hostname: LOCAL_HOST, ...overrides };
}

/**
 * `waitFor(() => expect(...).toBeNull())` is worthless for "it must STAY
 * gone": it succeeds on its first synchronous poll, before Svelte has
 * flushed the change that would bring the element back. Flush first, then
 * assert once.
 */
async function settle(): Promise<void> {
	await tick();
	await tick();
}

beforeEach(() => {
	vi.mocked(fetchOnboardingStatus).mockReset();
	vi.mocked(fetchZones).mockReset().mockResolvedValue([]);
	resetOnboardingStatus();
	setCoreStatus({ status: 'discovering' });
	setZonesSnapshot([]);
	setSelectedZone('');
	setSocketStatus('connected');
});

afterEach(() => {
	vi.useRealTimers();
});

describe('OnboardingFlow — when it appears', () => {
	it('renders the Connect step on an install that has never paired a Core', async () => {
		vi.mocked(fetchOnboardingStatus).mockResolvedValue(status());
		render(OnboardingFlow);

		const dialog = await screen.findByTestId('onboarding-flow');
		expect(dialog).toHaveAttribute('data-onboarding-step', 'connect');
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(
			screen.getByRole('heading', { name: 'Connect to your Roon Core' })
		).toBeInTheDocument();
		// The exact label the user has to find in Roon.
		expect(screen.getByText('Roon Web Controller')).toBeInTheDocument();
		expect(screen.getByTestId('onboarding-core-status')).toHaveTextContent(
			/looking for your roon core/i
		);
	});

	it('never appears for an install that has paired before, Core reachable or not', async () => {
		vi.mocked(fetchOnboardingStatus).mockResolvedValue(status({ everPaired: true }));
		render(OnboardingFlow);

		await waitFor(() => expect(fetchOnboardingStatus).toHaveBeenCalled());
		// A paired install whose Core is off reports `discovering`, exactly
		// like a first run. It must still see nothing.
		setCoreStatus({ status: 'discovering' });
		await waitFor(() => expect(screen.queryByTestId('onboarding-flow')).toBeNull());

		setCoreStatus({ status: 'unpaired' });
		await waitFor(() => expect(screen.queryByTestId('onboarding-flow')).toBeNull());
	});

	it('stays hidden when the first-run read fails, rather than guessing', async () => {
		vi.mocked(fetchOnboardingStatus).mockRejectedValue(new Error('offline'));
		render(OnboardingFlow);

		await waitFor(() => expect(fetchOnboardingStatus).toHaveBeenCalled());
		expect(screen.queryByTestId('onboarding-flow')).toBeNull();
	});
});

describe('OnboardingFlow — Connect step', () => {
	it('reflects a lost socket and a dropped Core without leaving the step', async () => {
		vi.mocked(fetchOnboardingStatus).mockResolvedValue(status());
		render(OnboardingFlow);
		await screen.findByTestId('onboarding-flow');

		setSocketStatus('connecting');
		await waitFor(() =>
			expect(screen.getByTestId('onboarding-core-status')).toHaveTextContent(/reconnecting/i)
		);

		setSocketStatus('connected');
		setCoreStatus({ status: 'unpaired' });
		await waitFor(() =>
			expect(screen.getByTestId('onboarding-core-status')).toHaveTextContent(
				/your roon core disconnected/i
			)
		);
		expect(screen.getByTestId('onboarding-flow')).toHaveAttribute(
			'data-onboarding-step',
			'connect'
		);
	});

	it('advances to the local-playback step by itself when pairing lands', async () => {
		vi.mocked(fetchOnboardingStatus).mockResolvedValue(status());
		render(OnboardingFlow);
		await screen.findByTestId('onboarding-flow');

		setCoreStatus({
			status: 'paired',
			core: { id: 'core-1', displayName: 'Mock Core', displayVersion: '2.0' }
		});

		await waitFor(() =>
			expect(screen.getByTestId('onboarding-flow')).toHaveAttribute(
				'data-onboarding-step',
				'local-playback'
			)
		);
		expect(
			screen.getByRole('heading', { name: 'Play to this computer' })
		).toBeInTheDocument();
	});
});

describe('OnboardingFlow — local playback step', () => {
	async function reachLocalPlayback(
		statusOverrides: Partial<OnboardingStatusResponse> = {}
	): Promise<void> {
		vi.mocked(fetchOnboardingStatus).mockResolvedValue(status(statusOverrides));
		render(OnboardingFlow);
		await screen.findByTestId('onboarding-flow');
		setCoreStatus({
			status: 'paired',
			core: { id: 'core-1', displayName: 'Mock Core', displayVersion: '2.0' }
		});
		await waitFor(() =>
			expect(screen.getByTestId('onboarding-flow')).toHaveAttribute(
				'data-onboarding-step',
				'local-playback'
			)
		);
	}

	it('names the zone it is waiting for and links the official downloads page', async () => {
		await reachLocalPlayback();

		expect(screen.getByTestId('onboarding-zone-status')).toHaveTextContent(LOCAL_HOST);
		const link = screen.getByRole('link', { name: /get roon bridge/i });
		expect(link).toHaveAttribute('href', 'https://roon.app/downloads');
		expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
	});

	it('explains itself without a hostname instead of promising to auto-detect', async () => {
		await reachLocalPlayback({ hostname: '' });

		expect(screen.getByTestId('onboarding-zone-status')).toHaveTextContent(
			/could not be read/i
		);
		expect(screen.getByRole('link', { name: /get roon bridge/i })).toBeInTheDocument();
	});

	it('closes and adopts the zone when one named after this computer appears', async () => {
		await reachLocalPlayback();
		expect(get(selectedZoneStore)).toBe('');

		setZonesSnapshot([
			zone({ zone_id: 'z-kitchen', display_name: 'Kitchen' }),
			zone({
				zone_id: 'z-local',
				display_name: 'Kitchen + Studio Desk',
				outputs: [
					{ output_id: 'o-kitchen', display_name: 'Kitchen' },
					{ output_id: 'o-local', display_name: 'Studio-Desk' }
				]
			})
		]);

		await waitFor(() => expect(screen.queryByTestId('onboarding-flow')).toBeNull());
		expect(get(selectedZoneStore)).toBe('z-local');
	});

	it('skips on request and does not reopen when state changes afterwards', async () => {
		await reachLocalPlayback();

		await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
		await waitFor(() => expect(screen.queryByTestId('onboarding-flow')).toBeNull());
		expect(get(selectedZoneStore)).toBe('');

		// A later Core blip, or the local zone showing up after all, must not
		// drag the user back into a wizard they dismissed.
		setCoreStatus({ status: 'discovering' });
		setZonesSnapshot([zone({ zone_id: 'z-local', display_name: LOCAL_HOST, outputs: [{ output_id: 'o-local', display_name: LOCAL_HOST }] })]);
		await settle();
		expect(screen.queryByTestId('onboarding-flow')).toBeNull();
		expect(get(selectedZoneStore)).toBe('');
	});

	it('does not reopen when the adopted local zone later disappears', async () => {
		await reachLocalPlayback();
		setZonesSnapshot([zone({ zone_id: 'z-local', display_name: LOCAL_HOST, outputs: [{ output_id: 'o-local', display_name: LOCAL_HOST }] })]);
		await waitFor(() => expect(screen.queryByTestId('onboarding-flow')).toBeNull());

		// Roon Bridge quits, the machine sleeps, the network hiccups — the
		// zone goes away. The flow is done and must stay done.
		setZonesSnapshot([]);
		await settle();
		expect(screen.queryByTestId('onboarding-flow')).toBeNull();
	});

	it('polls the zone list while the step is open and stops once it closes', async () => {
		vi.useFakeTimers();
		vi.mocked(fetchOnboardingStatus).mockResolvedValue(status());
		render(OnboardingFlow);
		await vi.waitFor(() => expect(screen.queryByTestId('onboarding-flow')).not.toBeNull());
		setCoreStatus({
			status: 'paired',
			core: { id: 'core-1', displayName: 'Mock Core', displayVersion: '2.0' }
		});
		await vi.waitFor(() =>
			expect(screen.getByTestId('onboarding-flow')).toHaveAttribute(
				'data-onboarding-step',
				'local-playback'
			)
		);

		expect(fetchZones).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5000);
		expect(vi.mocked(fetchZones).mock.calls.length).toBe(1);

		setZonesSnapshot([zone({ zone_id: 'z-local', display_name: LOCAL_HOST, outputs: [{ output_id: 'o-local', display_name: LOCAL_HOST }] })]);
		await vi.waitFor(() => expect(screen.queryByTestId('onboarding-flow')).toBeNull());

		const callsAtClose = vi.mocked(fetchZones).mock.calls.length;
		await vi.advanceTimersByTimeAsync(20000);
		expect(vi.mocked(fetchZones).mock.calls.length).toBe(callsAtClose);
	});
});

