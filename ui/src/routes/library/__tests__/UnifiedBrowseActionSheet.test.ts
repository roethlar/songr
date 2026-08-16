import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import type { UnifiedBrowseActionState } from '$lib/library/UnifiedBrowseController';
import UnifiedBrowseActionSheet from '../UnifiedBrowseActionSheet.svelte';

function state(over: Partial<UnifiedBrowseActionState> = {}): UnifiedBrowseActionState {
	return {
		phase: 'ready',
		source: {
			kind: 'search',
			query: 'heroes',
			item: {
				title: 'Heroes',
				subtitle: 'David Bowie',
				hint: 'action_list',
				isLoadable: false,
				isPlayable: false,
				resultType: 'track',
				categoryTitle: 'Tracks'
			}
		},
		available: { 'play-now': true, 'add-next': true, queue: true },
		error: null,
		...over
	};
}

function mount(options: {
	actionState?: UnifiedBrowseActionState;
	zones?: readonly { zoneId: string; name: string }[];
} = {}) {
	const onAction = vi.fn();
	const onFavorite = vi.fn();
	const onClose = vi.fn();
	const result = render(UnifiedBrowseActionSheet, {
		props: {
			state: options.actionState ?? state(),
			zones: options.zones ?? [{ zoneId: 'zone-a', name: 'Living Room' }],
			onAction,
			onFavorite,
			onClose
		}
	});
	return { ...result, onAction, onFavorite, onClose };
}

describe('UnifiedBrowseActionSheet', () => {
	it('opens without quick-playing and exposes every approved explicit action', () => {
		const harness = mount();

		expect(harness.onAction).not.toHaveBeenCalled();
		expect(screen.getByText('Heroes')).toBeInTheDocument();
		expect(screen.getByTestId('unified-browse-action-play-now')).toBeEnabled();
		expect(screen.getByTestId('unified-browse-action-add-next')).toBeEnabled();
		expect(screen.getByTestId('unified-browse-action-queue')).toBeEnabled();
		expect(screen.getByTestId('unified-browse-action-favorite')).toBeEnabled();
	});

	it('executes only after a named action click and keeps Favorite separate', async () => {
		const harness = mount();

		await fireEvent.click(screen.getByTestId('unified-browse-action-add-next'));
		expect(harness.onAction).toHaveBeenCalledWith('add-next', 'zone-a');
		await fireEvent.click(screen.getByTestId('unified-browse-action-favorite'));
		expect(harness.onFavorite).toHaveBeenCalledTimes(1);
	});

	it('preserves the chosen semantic through the explicit zone choice', async () => {
		const harness = mount({
			zones: [
				{ zoneId: 'zone-a', name: 'Living Room' },
				{ zoneId: 'zone-b', name: 'Office' }
			]
		});

		await fireEvent.click(screen.getByTestId('unified-browse-action-queue'));
		expect(screen.getByTestId('unified-browse-action-zones')).toHaveTextContent('Queue on');
		await fireEvent.click(screen.getByRole('button', { name: 'Office' }));
		expect(harness.onAction).toHaveBeenCalledWith('queue', 'zone-b');
	});

	it('moves focus into the modal and traps Tab navigation', async () => {
		mount();
		const close = screen.getByRole('button', { name: 'Close actions' });
		const last = screen.getByTestId('unified-browse-action-favorite');

		expect(close).toHaveFocus();
		last.focus();
		await fireEvent.keyDown(window, { key: 'Tab' });
		expect(close).toHaveFocus();
		await fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
		expect(last).toHaveFocus();
	});

	it('closes from Escape', async () => {
		const harness = mount();
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(harness.onClose).toHaveBeenCalledTimes(1);
	});

	it('disables actions Roon did not expose', () => {
		mount({
			actionState: state({
				available: { 'play-now': true, 'add-next': false, queue: false }
			})
		});

		expect(screen.getByTestId('unified-browse-action-play-now')).toBeEnabled();
		expect(screen.getByTestId('unified-browse-action-add-next')).toBeDisabled();
		expect(screen.getByTestId('unified-browse-action-queue')).toBeDisabled();
	});

	it('uses the Unified songr theme tokens', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const source = fs.readFileSync(
			path.resolve(process.cwd(), 'src/routes/library/UnifiedBrowseActionSheet.svelte'),
			'utf8'
		);
		const style = source.match(/<style\b[^>]*>[\s\S]*?<\/style>/)?.[0];
		expect(style).toBeDefined();
		expect(style).toContain('var(--unified-fg)');
		expect(style).toContain('var(--songr-panel)');
	});
});
