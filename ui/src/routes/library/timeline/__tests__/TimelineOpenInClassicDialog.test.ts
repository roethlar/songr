import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import TimelineOpenInClassicDialog from '../TimelineOpenInClassicDialog.svelte';

describe('TimelineOpenInClassicDialog', () => {
	it('explains the view change and traps focus without making confirmation the default', async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(TimelineOpenInClassicDialog, {
			props: {
				title: 'the track “All Neon Like”',
				description: 'Classic will search for this track. Choose the matching result there.',
				onConfirm,
				onCancel
			}
		});

		const dialog = screen.getByRole('dialog', {
			name: 'Open the track “All Neon Like” in Classic?'
		});
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(dialog).toHaveTextContent('Choose the matching result there');
		expect(dialog).toHaveTextContent('changes Library view to Classic');
		expect(dialog).toHaveTextContent('browser’s Back button');
		expect(dialog).toHaveTextContent('Controller settings');
		expect(dialog).toHaveTextContent('return to Timeline');

		const cancel = screen.getByRole('button', { name: 'Cancel' });
		const confirm = screen.getByRole('button', { name: 'Open in Classic' });
		await waitFor(() => expect(cancel).toHaveFocus());

		confirm.focus();
		await fireEvent.keyDown(confirm, { key: 'Tab' });
		expect(cancel).toHaveFocus();
		await fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
		expect(confirm).toHaveFocus();

		await fireEvent.keyDown(dialog, { key: 'Escape' });
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('confirms only through the explicit Open in Classic action', async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(TimelineOpenInClassicDialog, {
			props: {
				title: 'all results for “Björk”',
				description: 'Classic will run a fresh full-library search for this query.',
				onConfirm,
				onCancel
			}
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Open in Classic' }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('keeps every dismissal path inert while activation is pending', async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(TimelineOpenInClassicDialog, {
			props: {
				title: 'Favorites',
				description: 'Classic will reopen this section from a safe Library root.',
				busy: true,
				onConfirm,
				onCancel
			}
		});

		const dialog = screen.getByRole('dialog', { name: 'Open Favorites in Classic?' });
		expect(dialog).toHaveAttribute('aria-busy', 'true');
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();

		await fireEvent.keyDown(dialog, { key: 'Escape' });
		expect(onCancel).not.toHaveBeenCalled();
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
