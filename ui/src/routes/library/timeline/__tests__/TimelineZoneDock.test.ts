import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import TimelineZoneDock from '../TimelineZoneDock.svelte';

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		right,
		bottom,
		width: right - left,
		height: bottom - top,
		toJSON: () => ({ left, top, right, bottom })
	} as DOMRect;
}

describe('TimelineZoneDock', () => {
	it('renders dynamic named ports with distinct highlighted, active, and disabled states', async () => {
		const view = render(TimelineZoneDock, {
			props: {
				zones: [
					{ id: 'zone-a', name: 'Living Room', enabled: true },
					{ id: 'zone-b', name: 'Kitchen', enabled: true },
					{ id: 'zone-c', name: 'Office', enabled: false }
				],
				activeZoneId: 'zone-a',
				highlightedZoneId: 'zone-b'
			}
		});

		const dock = screen.getByRole('complementary', { name: 'Roon zones' });
		expect(dock).toHaveAttribute('data-zone-count', '3');
		const livingRoom = screen
			.getByText('Living Room')
			.closest<HTMLElement>('[data-timeline-zone-port]')!;
		const kitchen = screen
			.getByText('Kitchen')
			.closest<HTMLElement>('[data-timeline-zone-port]')!;
		const office = screen
			.getByText('Office')
			.closest<HTMLElement>('[data-timeline-zone-port]')!;
		expect(livingRoom).toHaveAttribute('data-active', 'true');
		expect(livingRoom).toHaveAttribute('aria-current', 'true');
		expect(kitchen).toHaveAttribute('data-highlighted', 'true');
		expect(office).toHaveAttribute('data-disabled', 'true');
		expect(office).toHaveTextContent('Unavailable');

		await view.rerender({
			zones: [{ id: 'zone-b', name: 'Renamed Kitchen', enabled: true }],
			activeZoneId: null,
			highlightedZoneId: null
		});
		expect(dock).toHaveAttribute('data-zone-count', '1');
		expect(screen.queryByText('Living Room')).toBeNull();
		expect(screen.getByText('Renamed Kitchen')).toBeInTheDocument();
	});

	it('registers a synchronous hit tester that reads fresh visible port rectangles', async () => {
		type Controls = {
			inspect(clientX: number, clientY: number): {
				readonly withinDock: boolean;
				readonly zoneId: string | null;
			};
			hitTest(clientX: number, clientY: number): { zoneId: string } | null;
		};
		let controls: Controls | null = null;
		const registrations: Array<Controls | null> = [];
		let zoneALeft = 10;
		const view = render(TimelineZoneDock, {
			props: {
				zones: [
					{ id: 'zone-a', name: 'Living Room', enabled: true },
					{ id: 'zone-b', name: 'Kitchen', enabled: false }
				],
				onControls: (next) => {
					controls = next;
					registrations.push(next);
				}
			}
		});
		await waitFor(() => expect(controls).not.toBeNull());

		const dock = screen.getByRole('complementary', { name: 'Roon zones' });
		const list = screen.getByRole('list', { name: 'Available Roon zones' });
		const zoneA = screen
			.getByText('Living Room')
			.closest<HTMLElement>('[data-timeline-zone-port]')!;
		const zoneB = screen
			.getByText('Kitchen')
			.closest<HTMLElement>('[data-timeline-zone-port]')!;
		vi.spyOn(dock, 'getBoundingClientRect').mockImplementation(() => rect(0, 0, 300, 240));
		vi.spyOn(list, 'getBoundingClientRect').mockImplementation(() => rect(0, 20, 300, 220));
		const zoneARect = vi
			.spyOn(zoneA, 'getBoundingClientRect')
			.mockImplementation(() => rect(zoneALeft, 10, zoneALeft + 80, 60));
		vi.spyOn(zoneB, 'getBoundingClientRect').mockImplementation(() => rect(10, 80, 90, 130));

		expect(controls!.hitTest(20, 20)).toEqual({ zoneId: 'zone-a' });
		zoneALeft = 120;
		expect(controls!.hitTest(20, 20)).toBeNull();
		expect(controls!.hitTest(130, 20)).toEqual({ zoneId: 'zone-a' });
		expect(zoneARect).toHaveBeenCalledTimes(3);
		expect(controls!.hitTest(20, 90)).toBeNull();
		expect(controls!.inspect(20, 90)).toEqual({ withinDock: true, zoneId: null });
		expect(controls!.inspect(20, 230)).toEqual({ withinDock: true, zoneId: null });
		expect(controls!.inspect(320, 230)).toEqual({ withinDock: false, zoneId: null });
		expect(controls!.hitTest(-1, 20)).toBeNull();
		expect(controls!.hitTest(Number.NaN, 20)).toBeNull();

		view.unmount();
		expect(registrations.at(-1)).toBeNull();
	});

	it('keeps an honest empty dock mounted while no zones are online', () => {
		render(TimelineZoneDock, { props: { zones: [] } });
		expect(screen.getByRole('complementary', { name: 'Roon zones' })).toHaveAttribute(
			'data-zone-count',
			'0'
		);
		expect(screen.getByText('No zones available')).toBeInTheDocument();
	});
});
