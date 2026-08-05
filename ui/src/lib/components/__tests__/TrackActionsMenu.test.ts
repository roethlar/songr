import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import TrackActionsMenu from '../TrackActionsMenu.svelte';
import type { BrowseItem } from '@shared/types';
import { focusTrap } from '$lib/actions/focusTrap';

function makeAction(title: string, itemKey: string): BrowseItem {
	return {
		title,
		itemKey,
		hint: 'action',
		isLoadable: false,
		isPlayable: true
	};
}

const baseProps = {
	title: 'Hey Jude',
	actions: [makeAction('Play Now', 'a1'), makeAction('Add Next', 'a2')],
	onAction: vi.fn(),
	onClose: vi.fn()
};

function fireTab(shiftKey = false) {
	window.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
	);
}

describe('TrackActionsMenu focus management', () => {
	it('moves focus into the menu on open', () => {
		render(TrackActionsMenu, { props: baseProps });
		expect(screen.getByRole('button', { name: 'Play Now' })).toBe(document.activeElement);
	});

	it('wraps Tab from the last control back to the first', () => {
		render(TrackActionsMenu, { props: baseProps });
		screen.getByRole('button', { name: 'Cancel' }).focus();

		fireTab();

		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Play Now' }));
	});

	it('wraps Shift+Tab from the first control to the last', () => {
		render(TrackActionsMenu, { props: baseProps });
		screen.getByRole('button', { name: 'Play Now' }).focus();

		fireTab(true);

		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
	});

	it('restores focus to the opener on close', async () => {
		const opener = document.createElement('button');
		opener.textContent = 'row ⋮';
		document.body.appendChild(opener);
		opener.focus();

		const { unmount } = render(TrackActionsMenu, { props: baseProps });
		expect(document.activeElement).not.toBe(opener);

		unmount();
		expect(document.activeElement).toBe(opener);
		opener.remove();
	});

	it('excludes explicitly untabbable native controls and can defer semantic focus restoration', () => {
		const opener = document.createElement('button');
		const dialog = document.createElement('div');
		const skipped = document.createElement('button');
		const disabled = document.createElement('button');
		const active = document.createElement('button');
		skipped.tabIndex = -1;
		disabled.disabled = true;
		disabled.tabIndex = 0;
		dialog.append(skipped, disabled, active);
		document.body.append(opener, dialog);
		opener.focus();

		const trap = focusTrap(dialog, { restoreFocus: false });
		expect(active).toHaveFocus();
		trap.destroy();
		expect(opener).not.toHaveFocus();

		opener.remove();
		dialog.remove();
	});
});
