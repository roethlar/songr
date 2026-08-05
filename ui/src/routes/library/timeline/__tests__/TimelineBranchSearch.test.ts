import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import TimelineBranchSearch from '../TimelineBranchSearch.svelte';

const candidates = Array.from({ length: 10 }, (_, index) => ({
	artistLocalId: `artist-${index + 1}`,
	name: `Artist ${index + 1}`,
	subtitle: index === 0 ? '3 albums' : undefined
}));

function props(overrides: Record<string, unknown> = {}) {
	return {
		sourceTitle: 'Kid A',
		phase: 'idle' as const,
		onSearch: vi.fn(),
		onChoose: vi.fn(),
		onCancel: vi.fn(),
		...overrides
	};
}

describe('TimelineBranchSearch', () => {
	it('traps focus, searches only on explicit submit, and cancels through Escape', async () => {
		const onSearch = vi.fn();
		const onCancel = vi.fn();
		render(TimelineBranchSearch, {
			props: props({ onSearch, onCancel })
		});

		const dialog = screen.getByRole('dialog', { name: 'Attach artist branch' });
		const searchbox = screen.getByRole('searchbox', { name: 'Artist name' });
		await waitFor(() => expect(searchbox).toHaveFocus());

		await fireEvent.input(searchbox, { target: { value: '  Thom Yorke  ' } });
		expect(onSearch).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		expect(onSearch).toHaveBeenCalledTimes(1);
		expect(onSearch).toHaveBeenCalledWith('Thom Yorke');

		const cancel = screen.getByRole('button', { name: 'Cancel' });
		cancel.focus();
		await fireEvent.keyDown(cancel, { key: 'Tab' });
		expect(searchbox).toHaveFocus();

		await fireEvent.keyDown(dialog, { key: 'Escape' });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('caps choices at eight and returns only the chosen keyless candidate', async () => {
		const onChoose = vi.fn();
		render(TimelineBranchSearch, {
			props: props({ phase: 'ready', candidates, onChoose })
		});

		const results = screen.getByRole('list', { name: 'Artist search results' });
		expect(within(results).getAllByRole('button')).toHaveLength(8);
		expect(within(results).queryByText('Artist 9')).toBeNull();
		expect(screen.getByText('Showing 8 of 10 matches')).toBeInTheDocument();

		await fireEvent.click(within(results).getByRole('button', { name: /Artist 1/ }));
		expect(onChoose).toHaveBeenCalledTimes(1);
		expect(onChoose).toHaveBeenCalledWith(candidates[0]);
	});

	it('renders loading, error, and empty states without invented relation language', async () => {
		const base = props({ phase: 'loading' });
		const view = render(TimelineBranchSearch, { props: base });

		expect(screen.getByRole('status')).toHaveTextContent('Searching artists…');
		expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
		expect(view.container).not.toHaveTextContent(/Similar|Recommended/i);

		await view.rerender({ ...base, phase: 'error', errorMessage: 'Catalog unavailable.' });
		expect(screen.getByRole('alert')).toHaveTextContent('Catalog unavailable.');

		await view.rerender({ ...base, phase: 'ready', candidates: [] });
		expect(screen.getByRole('status')).toHaveTextContent('No artists found');
		expect(view.container).not.toHaveTextContent(/Similar|Recommended/i);
	});
});
