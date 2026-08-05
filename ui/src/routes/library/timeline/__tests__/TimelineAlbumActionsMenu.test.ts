import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import TimelineAlbumActionsMenu from '../TimelineAlbumActionsMenu.svelte';

function props(overrides: Record<string, unknown> = {}) {
	return {
		title: 'Homogenic',
		left: 20,
		top: 40,
		onOpen: vi.fn(),
		onFloat: vi.fn(),
		onReturn: vi.fn(),
		onMoveBefore: vi.fn(),
		onMoveAfter: vi.fn(),
		onDismiss: vi.fn(),
		...overrides
	};
}

describe('TimelineAlbumActionsMenu named-zone parity', () => {
	it('keeps current workspace controls by default and adds branch attachment only when supplied', async () => {
		const onAttachArtistBranch = vi.fn();
		const onDismiss = vi.fn();
		render(TimelineAlbumActionsMenu, {
			props: props({ onAttachArtistBranch, onDismiss })
		});

		const menu = screen.getByRole('menu', { name: 'Homogenic actions' });
		expect(within(menu).getByRole('menuitem', { name: /Float from timeline/ })).toBeEnabled();
		expect(within(menu).getByRole('menuitem', { name: /Move before/ })).toBeInTheDocument();
		expect(within(menu).getByRole('menuitem', { name: /Move after/ })).toBeInTheDocument();

		await fireEvent.click(
			within(menu).getByRole('menuitem', { name: /Attach artist branch/ })
		);
		expect(onAttachArtistBranch).toHaveBeenCalledTimes(1);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('offers a keyboard-reachable Classic fallback and dismisses after selection', async () => {
		const onOpenInClassic = vi.fn();
		const onDismiss = vi.fn();
		render(TimelineAlbumActionsMenu, {
			props: props({ onOpenInClassic, onDismiss })
		});

		const fallback = screen.getByRole('menuitem', { name: /Open album in Classic/ });
		expect(fallback).toBeEnabled();
		await fireEvent.click(fallback);
		expect(onOpenInClassic).toHaveBeenCalledTimes(1);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('hides lane-inapplicable workspace controls without changing zone entries', () => {
		render(TimelineAlbumActionsMenu, {
			props: props({
				showWorkspaceControls: false,
				onAttachArtistBranch: vi.fn(),
				zones: [{ id: 'zone-a', name: 'Living Room', enabled: true }],
				onSendToZone: vi.fn()
			})
		});

		const menu = screen.getByRole('menu', { name: 'Homogenic actions' });
		expect(within(menu).queryByRole('menuitem', { name: /Float from timeline/ })).toBeNull();
		expect(within(menu).queryByRole('menuitem', { name: /Return to timeline/ })).toBeNull();
		expect(within(menu).queryByRole('menuitem', { name: /Move before/ })).toBeNull();
		expect(within(menu).queryByRole('menuitem', { name: /Move after/ })).toBeNull();
		expect(within(menu).getByRole('menuitem', { name: /Attach artist branch/ })).toBeEnabled();
		expect(within(menu).getByRole('menuitem', { name: /Send to Living Room/ })).toBeEnabled();
	});

	it('renders a bounded named-zone section and leaves the modal transition to its parent', async () => {
		const onSendToZone = vi.fn();
		const onDismiss = vi.fn();
		const zones = [
			{ id: 'zone-a', name: 'Living Room', enabled: true },
			{ id: 'zone-b', name: 'Kitchen', enabled: false },
			...Array.from({ length: 10 }, (_, index) => ({
				id: `zone-${index + 3}`,
				name: `Overflow ${index + 1}`,
				enabled: true
			}))
		];
		render(TimelineAlbumActionsMenu, {
			props: props({ zones, onSendToZone, onDismiss })
		});

		const menu = screen.getByRole('menu', { name: 'Homogenic actions' });
		expect(menu).toHaveStyle({ maxHeight: 'calc(100% - 56px)' });
		await waitFor(() =>
			expect(within(menu).getByRole('menuitem', { name: /Open album detail/ })).toHaveFocus()
		);
		expect(within(menu).getByText('Send to named zone')).toBeInTheDocument();
		expect(menu.querySelector('.zone-action-list')).not.toBeNull();
		expect(menu.querySelectorAll('.zone-action-list [role="menuitem"]')).toHaveLength(zones.length);

		const livingRoom = within(menu).getByRole('menuitem', { name: /Send to Living Room/ });
		const kitchen = within(menu).getByRole('menuitem', { name: /Send to Kitchen/ });
		expect(livingRoom).toBeEnabled();
		expect(kitchen).toBeDisabled();
		await fireEvent.click(livingRoom);
		expect(onSendToZone).toHaveBeenCalledTimes(1);
		expect(onSendToZone).toHaveBeenCalledWith('zone-a');
		expect(onDismiss).not.toHaveBeenCalled();
		expect(menu).toBeInTheDocument();

		await fireEvent.click(kitchen);
		expect(onSendToZone).toHaveBeenCalledTimes(1);
	});

	it('keeps named-zone entries disabled until a parent supplies transition authority', () => {
		render(TimelineAlbumActionsMenu, {
			props: props({
				zones: [{ id: 'zone-a', name: 'Living Room', enabled: true }]
			})
		});

		expect(screen.getByRole('menuitem', { name: /Send to Living Room/ })).toBeDisabled();
	});
});
