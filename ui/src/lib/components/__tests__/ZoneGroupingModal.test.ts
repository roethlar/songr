import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import ZoneGroupingModal from '../ZoneGroupingModal.svelte';
import { createFakeSocket } from '../../../test/fixtures/socket';

const fakeSocket = createFakeSocket();
vi.mock('$lib/socket/client', () => ({
	getSocket: () => fakeSocket
}));

vi.mock('$lib/socket/emit', () => ({
	emitWithAck: vi.fn().mockResolvedValue({ success: true })
}));

import { emitWithAck } from '$lib/socket/emit';
import {
	zoneGroupingStore,
	openZoneGrouping,
	closeZoneGrouping
} from '$lib/stores/zoneGroupingStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import type { Zone } from '@shared/types';

function makeZone(over: Partial<Zone> = {}): Zone {
	return {
		zone_id: over.zone_id ?? 'zone-a',
		display_name: over.display_name ?? 'Main',
		state: over.state ?? 'playing',
		seek_position: 0,
		is_play_allowed: true,
		is_pause_allowed: true,
		is_previous_allowed: true,
		is_next_allowed: true,
		is_seek_allowed: true,
		outputs: over.outputs ?? []
	};
}

beforeEach(() => {
	vi.mocked(emitWithAck).mockReset();
	vi.mocked(emitWithAck).mockResolvedValue({ success: true });
	closeZoneGrouping();
	setZonesSnapshot([]);
	setSelectedZone('');
});

function seedTwoZones() {
	setZonesSnapshot([
		makeZone({
			zone_id: 'zone-a',
			display_name: 'Living Room',
			outputs: [{ output_id: 'out-a', display_name: 'Speakers' }]
		}),
		makeZone({
			zone_id: 'zone-b',
			display_name: 'Kitchen',
			outputs: [{ output_id: 'out-b', display_name: 'Sonos' }]
		})
	]);
	setSelectedZone('zone-a');
}

describe('ZoneGroupingModal', () => {
	it('renders nothing when closed', () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		expect(screen.queryByRole('dialog', { name: 'Group zones' })).toBeNull();
	});

	it('renders one row per unique output across all zones when open', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		expect(screen.getByText('Speakers')).toBeInTheDocument();
		expect(screen.getByText('Sonos')).toBeInTheDocument();
		// Zone names are shown as secondary labels.
		expect(screen.getByText('Living Room')).toBeInTheDocument();
		expect(screen.getByText('Kitchen')).toBeInTheDocument();
	});

	it('pre-checks the active zone outputs and leaves others unchecked', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
		// First row is 'out-a' (Living Room is selected zone) → checked.
		expect(checkboxes[0].checked).toBe(true);
		// Second row 'out-b' (Kitchen) → not checked.
		expect(checkboxes[1].checked).toBe(false);
	});

	it('Group button is disabled until 2+ outputs are checked', async () => {
		setZonesSnapshot([
			makeZone({
				zone_id: 'zone-a',
				outputs: [
					{ output_id: 'out-a', display_name: 'A' },
					{ output_id: 'out-b', display_name: 'B' }
				]
			})
		]);
		setSelectedZone('');
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		// No active zone → nothing pre-checked.
		const groupBtn = screen.getByRole('button', { name: 'Group selected outputs' });
		expect(groupBtn).toBeDisabled();

		const checkboxes = screen.getAllByRole('checkbox');
		await fireEvent.click(checkboxes[0]);
		// One checked → still disabled.
		expect(groupBtn).toBeDisabled();

		await fireEvent.click(checkboxes[1]);
		// Two checked → enabled.
		expect(groupBtn).not.toBeDisabled();
	});

	it('Save emits transport:group with the checked output_ids', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		// Active zone 'zone-a' has out-a pre-checked. Add out-b.
		const checkboxes = screen.getAllByRole('checkbox');
		await fireEvent.click(checkboxes[1]);

		await fireEvent.click(screen.getByRole('button', { name: 'Group selected outputs' }));

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:group',
				expect.objectContaining({
					output_ids: expect.arrayContaining(['out-a', 'out-b'])
				}),
				expect.any(Object)
			);
		});
	});

	it('closes the overlay after a successful save', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		const checkboxes = screen.getAllByRole('checkbox');
		await fireEvent.click(checkboxes[1]);
		await fireEvent.click(screen.getByRole('button', { name: 'Group selected outputs' }));

		await waitFor(() => {
			expect(get(zoneGroupingStore)).toBe(false);
		});
	});

	it('Cancel closes without emitting', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(get(zoneGroupingStore)).toBe(false);
		expect(emitWithAck).not.toHaveBeenCalled();
	});

	it('Esc closes without emitting', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(get(zoneGroupingStore)).toBe(false);
		expect(emitWithAck).not.toHaveBeenCalled();
	});

	it('shows empty state when no zones / outputs are available', async () => {
		// setZonesSnapshot([]) already in beforeEach.
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		expect(screen.getByText('No outputs available.')).toBeInTheDocument();
		// Group button stays disabled.
		expect(screen.getByRole('button', { name: 'Group selected outputs' })).toBeDisabled();
	});

	it('reopen #1 P1: user-checked outputs survive a zonesStore refresh mid-selection', async () => {
		// Prior $effect re-ran on every zonesStore update (because it
		// read activeZone, derived from zonesStore). Socket-driven
		// zone refreshes would clobber the user's checked boxes back
		// to "active zone outputs only". Fix re-seeds only on the
		// closed→open transition.
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
		await fireEvent.click(checkboxes[1]); // Add Kitchen
		expect(checkboxes[0].checked).toBe(true);
		expect(checkboxes[1].checked).toBe(true);

		// Socket-driven refresh: same zones but a new state value
		// flows through the derived chain. Pre-fix this reset
		// selectedOutputs back to {out-a}.
		setZonesSnapshot([
			makeZone({
				zone_id: 'zone-a',
				display_name: 'Living Room',
				state: 'paused',
				outputs: [{ output_id: 'out-a', display_name: 'Speakers' }]
			}),
			makeZone({
				zone_id: 'zone-b',
				display_name: 'Kitchen',
				state: 'playing',
				outputs: [{ output_id: 'out-b', display_name: 'Sonos' }]
			})
		]);
		await tick();

		const refreshed = screen.getAllByRole('checkbox') as HTMLInputElement[];
		expect(refreshed[0].checked).toBe(true);
		expect(refreshed[1].checked).toBe(true);
	});

	it('feat-6: no power button rendered when output has no standby-capable source_controls', async () => {
		// Output with no source_controls → canStandby is false → no button.
		setZonesSnapshot([
			makeZone({
				zone_id: 'zone-a',
				display_name: 'Living Room',
				outputs: [
					{
						output_id: 'out-a',
						display_name: 'Speakers'
						// source_controls undefined
					}
				]
			})
		]);
		setSelectedZone('zone-a');
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		expect(screen.queryByRole('button', { name: /Standby Speakers/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /Wake Speakers/i })).toBeNull();
	});

	it('feat-6: no power button when source_controls present but none support standby', async () => {
		setZonesSnapshot([
			makeZone({
				zone_id: 'zone-a',
				outputs: [
					{
						output_id: 'out-a',
						display_name: 'Speakers',
						source_controls: [
							{
								control_key: '1',
								display_name: 'AirPlay',
								status: 'selected',
								supports_standby: false
							}
						]
					}
				]
			})
		]);
		setSelectedZone('zone-a');
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		expect(screen.queryByRole('button', { name: /Standby Speakers/i })).toBeNull();
	});

	it('feat-6: click emits transport:standby with control_key when output is not in standby', async () => {
		setZonesSnapshot([
			makeZone({
				zone_id: 'zone-a',
				outputs: [
					{
						output_id: 'out-a',
						display_name: 'Naim',
						source_controls: [
							{
								control_key: 'sc-1',
								display_name: 'Naim NAC',
								status: 'selected',
								supports_standby: true
							}
						]
					}
				]
			})
		]);
		setSelectedZone('zone-a');
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		const btn = screen.getByRole('button', { name: 'Standby Naim' });
		await fireEvent.click(btn);

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:standby',
				{ output_id: 'out-a', control_key: 'sc-1' },
				expect.any(Object)
			);
		});
	});

	it('feat-6 reopen P1: multi-control output renders no power button', async () => {
		// Per types.ts contract, multi-control outputs need a
		// per-control affordance (nested menu) — not in scope for this
		// iteration. The aggregate "any control is asleep → wake all"
		// heuristic from the pre-reopen build could send the wrong
		// action when one control was selected and another was in
		// standby. Until the menu ships, render nothing for this case.
		setZonesSnapshot([
			makeZone({
				zone_id: 'zone-a',
				outputs: [
					{
						output_id: 'out-a',
						display_name: 'Mixed',
						source_controls: [
							{
								control_key: 'sc-1',
								display_name: 'Input A',
								status: 'selected',
								supports_standby: true
							},
							{
								control_key: 'sc-2',
								display_name: 'Input B',
								status: 'standby',
								supports_standby: true
							}
						]
					}
				]
			})
		]);
		setSelectedZone('zone-a');
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		expect(screen.queryByRole('button', { name: /Wake Mixed/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /Standby Mixed/i })).toBeNull();
	});

	it('feat-6 reopen P1: mixed standby+non-standby controls — only the standby-capable one counts', async () => {
		// One supports_standby control + an unrelated non-standby
		// control (e.g. an aux input that doesn't sleep) is still a
		// single-control output for power-button purposes — the
		// non-standby control isn't a power destination, so it
		// doesn't push the count to 2.
		setZonesSnapshot([
			makeZone({
				zone_id: 'zone-a',
				outputs: [
					{
						output_id: 'out-a',
						display_name: 'Naim',
						source_controls: [
							{
								control_key: 'sc-1',
								display_name: 'Naim NAC',
								status: 'standby',
								supports_standby: true
							},
							{
								control_key: 'sc-aux',
								display_name: 'Aux',
								status: 'selected',
								supports_standby: false
							}
						]
					}
				]
			})
		]);
		setSelectedZone('zone-a');
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		const btn = screen.getByRole('button', { name: 'Wake Naim' });
		await fireEvent.click(btn);

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:wake',
				{ output_id: 'out-a', control_key: 'sc-1' },
				expect.any(Object)
			);
		});
	});

	it('feat-6: click emits transport:wake with control_key when output is in standby', async () => {
		setZonesSnapshot([
			makeZone({
				zone_id: 'zone-a',
				outputs: [
					{
						output_id: 'out-a',
						display_name: 'Naim',
						source_controls: [
							{
								control_key: 'sc-1',
								display_name: 'Naim NAC',
								status: 'standby',
								supports_standby: true
							}
						]
					}
				]
			})
		]);
		setSelectedZone('zone-a');
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		const btn = screen.getByRole('button', { name: 'Wake Naim' });
		await fireEvent.click(btn);

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:wake',
				{ output_id: 'out-a', control_key: 'sc-1' },
				expect.any(Object)
			);
		});
	});

	it('reopen #1 P2: failed save keeps the modal open with selection intact', async () => {
		// emitWithAck doesn't throw for server-reported failures; it
		// resolves with { success: false, error }. Save must inspect
		// the result and keep the modal open + selection intact on
		// failure.
		vi.mocked(emitWithAck).mockResolvedValue({
			success: false,
			error: 'group_outputs failed: NetworkError'
		});

		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
		await fireEvent.click(checkboxes[1]);

		const groupBtn = screen.getByRole('button', {
			name: 'Group selected outputs'
		});
		await fireEvent.click(groupBtn);

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalled();
		});

		expect(get(zoneGroupingStore)).toBe(true);
		const stillThere = screen.getAllByRole('checkbox') as HTMLInputElement[];
		expect(stillThere[0].checked).toBe(true);
		expect(stillThere[1].checked).toBe(true);
		// submitting cleared so user can retry.
		expect(
			screen.getByRole('button', { name: 'Group selected outputs' })
		).not.toBeDisabled();
	});
});
