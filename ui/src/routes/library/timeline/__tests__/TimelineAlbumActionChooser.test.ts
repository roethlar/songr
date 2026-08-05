import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import TimelineAlbumActionChooser from '../TimelineAlbumActionChooser.svelte';

const actions = [
	{ actionId: 'opaque-play', label: 'Play Now' },
	{ actionId: 'opaque-queue', label: 'Queue' }
];

describe('TimelineAlbumActionChooser', () => {
	it('focuses cancellable resolution and routes Escape and backdrop through cancellation', async () => {
		const onCancel = vi.fn();
		const onDismiss = vi.fn();
		const onExecute = vi.fn();
		const view = render(TimelineAlbumActionChooser, {
			props: {
				albumTitle: 'Homogenic',
				zoneName: 'Test',
				phase: 'resolving',
				onExecute,
				onCancel,
				onDismiss
			}
		});

		const dialog = screen.getByRole('dialog', { name: 'Homogenic' });
		expect(dialog).toHaveAttribute('data-album-action-phase', 'resolving');
		expect(dialog).toHaveAttribute('aria-busy', 'true');
		expect(screen.getByText('Target: Test')).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());

		await fireEvent.keyDown(dialog, { key: 'Escape' });
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onDismiss).not.toHaveBeenCalled();
		expect(onExecute).not.toHaveBeenCalled();

		await fireEvent.click(view.container.querySelector('.album-action-backdrop')!);
		expect(onCancel).toHaveBeenCalledTimes(2);
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('renders exact returned labels but gives execution authority only to the opaque action ID', async () => {
		const onExecute = vi.fn();
		const onCancel = vi.fn();
		const view = render(TimelineAlbumActionChooser, {
			props: {
				albumTitle: 'Homogenic',
				zoneName: 'Test',
				phase: 'resolving',
				onExecute,
				onCancel
			}
		});

		await view.rerender({
			albumTitle: 'Homogenic',
			zoneName: 'Test',
			phase: 'choosing',
			actions,
			onExecute,
			onCancel
		});
		const choices = screen.getByLabelText('Current actions for Homogenic');
		const play = within(choices).getByRole('button', { name: 'Play Now' });
		const queue = within(choices).getByRole('button', { name: 'Queue' });
		await waitFor(() => expect(play).toHaveFocus());

		await fireEvent.click(queue);
		expect(onExecute).toHaveBeenCalledTimes(1);
		expect(onExecute).toHaveBeenCalledWith('opaque-queue');
		expect(onCancel).not.toHaveBeenCalled();
		expect(screen.getByRole('dialog', { name: 'Homogenic' })).toBeInTheDocument();
	});

	it('makes executing non-dismissible and exposes no action controls', async () => {
		const onExecute = vi.fn();
		const onCancel = vi.fn();
		const onDismiss = vi.fn();
		const view = render(TimelineAlbumActionChooser, {
			props: {
				albumTitle: 'Homogenic',
				zoneName: 'Test',
				phase: 'executing',
				actions,
				executingLabel: 'Play Now',
				onExecute,
				onCancel,
				onDismiss
			}
		});

		const dialog = screen.getByRole('dialog', { name: 'Homogenic' });
		expect(dialog).toHaveAttribute('aria-busy', 'true');
		expect(screen.getByText('Sending Play Now…')).toBeInTheDocument();
		expect(screen.queryByRole('button')).toBeNull();
		expect(view.container.querySelector('.album-action-backdrop')).toBeNull();
		await fireEvent.keyDown(dialog, { key: 'Escape' });
		expect(onCancel).not.toHaveBeenCalled();
		expect(onDismiss).not.toHaveBeenCalled();
		expect(onExecute).not.toHaveBeenCalled();
	});

	it('dismisses deterministic errors without pretending to cancel an active lease', async () => {
		const onCancel = vi.fn();
		const onDismiss = vi.fn();
		render(TimelineAlbumActionChooser, {
			props: {
				albumTitle: 'Homogenic',
				zoneName: 'Test',
				phase: 'error',
				message: 'The zone changed.',
				onExecute: vi.fn(),
				onCancel,
				onDismiss
			}
		});

		expect(screen.getByRole('alert')).toHaveTextContent('The zone changed.');
		const close = screen.getByRole('button', { name: 'Close' });
		await waitFor(() => expect(close).toHaveFocus());
		await fireEvent.click(close);
		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('offers no retry or stale action after an outcome-unknown result', async () => {
		const onExecute = vi.fn();
		const onDismiss = vi.fn();
		render(TimelineAlbumActionChooser, {
			props: {
				albumTitle: 'Homogenic',
				zoneName: 'Test',
				phase: 'outcome-unknown',
				actions,
				message: 'Check the Test zone before doing anything else.',
				onExecute,
				onDismiss
			}
		});

		expect(screen.getByRole('alert')).toHaveTextContent('Outcome unknown');
		expect(screen.getByText('Check the Test zone before doing anything else.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Play Now' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onExecute).not.toHaveBeenCalled();
	});
});
