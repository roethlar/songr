import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import type { UnifiedBrowseState } from '$lib/library/UnifiedBrowseController';
import UnifiedBrowseView from '../UnifiedBrowseView.svelte';

function readyState(over: Partial<UnifiedBrowseState> = {}): UnifiedBrowseState {
	return {
		phase: 'ready',
		result: {
			title: 'Library',
			level: 1,
			offset: 0,
			count: 2,
			totalCount: 102,
			items: [
				{
					title: 'Tracks',
					subtitle: '12,500 tracks',
					itemKey: 'tracks-key',
					hint: 'list',
					isLoadable: true,
					isPlayable: false
				},
				{
					title: 'Search',
					itemKey: 'search-key',
					hint: 'list',
					inputPrompt: 'Search',
					isLoadable: false,
					isPlayable: false
				}
			]
		},
		snapshot: {
			context: { hierarchy: 'browse' },
			history: [{ hierarchy: 'browse', breadcrumb: { title: 'Library' } }],
			forward: []
		},
		notice: null,
		error: null,
		...over
	};
}

function mount(state = readyState()) {
	const onBack = vi.fn();
	const onForward = vi.fn();
	const onItem = vi.fn();
	const onSearchPrompt = vi.fn();
	const result = render(UnifiedBrowseView, {
		props: { state, onBack, onForward, onItem, onSearchPrompt }
	});
	return { ...result, onBack, onForward, onItem, onSearchPrompt };
}

describe('UnifiedBrowseView', () => {
 it('uses the supplied collection matches and complete counts without offering network paging', async () => {
  const state = readyState();
  const match = state.result!.items[0];
  const onItem = vi.fn(), onFilter = vi.fn(), onSort = vi.fn();
  const { rerender } = render(UnifiedBrowseView, { props: {
   state, displayItems: [match], onItem, onBack: vi.fn(), onForward: vi.fn(), onSearchPrompt: vi.fn(),
   collection: { label: 'Tracks', filter: 'rock', sort: 'name-desc', matchCount: 51, onFilter, onSort, onRetry: vi.fn() }
  } });
  expect(screen.getAllByTestId('unified-browse-row')).toHaveLength(1);
  expect(screen.getByTestId('unified-browse-summary')).toHaveTextContent('51 OF 102');
  expect(screen.queryByTestId('unified-browse-path')).toBeNull();
  expect(screen.queryByTestId('unified-browse-more')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Open Tracks' }));
  expect(onItem).toHaveBeenCalledWith(match);
  await fireEvent.input(screen.getByRole('searchbox', { name: 'Filter Tracks' }), { target: { value: 'jazz' } });
  expect(onFilter).toHaveBeenCalledWith('jazz');
  await fireEvent.change(screen.getByRole('combobox', { name: 'Sort Tracks' }), { target: { value: 'name-asc' } });
  expect(onSort).toHaveBeenCalledWith('name-asc');
  await rerender({ displayItems: [], collection: { label: 'Tracks', filter: 'no matches', sort: 'original', matchCount: 0, onFilter, onSort, onRetry: vi.fn() } });
  expect(screen.getByTestId('unified-browse-empty')).toHaveTextContent('No matches.');
  expect(screen.getByTestId('unified-browse-summary')).toHaveTextContent('0 OF 102');
 });

	it.each([false, true])('shows Roon message isError=%s instead of claiming an empty collection', (isError) => {
		mount(readyState({ result: { action: 'message', message: 'Tags are unavailable on this Core.',
			isError, title: 'Tags', level: 2, offset: 0, count: 0, items: [] } }));
		const message = screen.getByTestId('unified-browse-message');
		expect(message).toHaveTextContent('Tags are unavailable on this Core.');
		expect(message).toHaveAttribute('role', isError ? 'alert' : 'status');
		expect(message.classList.contains('browse-error')).toBe(isError);
		expect(screen.queryByTestId('unified-browse-empty')).toBeNull();
		expect(screen.queryByTestId('unified-browse-summary')).toBeNull();
		expect(screen.queryByTestId('unified-browse-more')).toBeNull();
	});

	it('keeps genuine empty lists distinct from Roon messages', () => {
		mount(readyState({ result: { action: 'list', title: 'Tags', level: 2, offset: 0, count: 0, items: [] } }));
		expect(screen.getByTestId('unified-browse-empty')).toHaveTextContent('Nothing is available here.');
		expect(screen.queryByTestId('unified-browse-message')).toBeNull();
	});

	it('shows an explicit error fallback when the Core omits its message text', () => {
		mount(readyState({ result: { action: 'message', isError: true, level: 0, offset: 0, count: 0, items: [] } }));
		expect(screen.getByRole('alert')).toHaveTextContent('Roon reported an error.');
		expect(screen.queryByTestId('unified-browse-empty')).toBeNull();
	});

	it('renders library rows with named navigation controls', () => {
		mount();

		expect(screen.getByTestId('unified-browse-title')).toHaveTextContent('Library');
		expect(screen.getByTestId('unified-browse-summary')).toHaveTextContent('2 OF 102');
		expect(screen.queryByTestId('unified-browse-path')).toBeNull();
		const rows = screen.getAllByTestId('unified-browse-row');
		expect(rows[0]).toHaveTextContent('Tracks');
		expect(rows[0]).toHaveTextContent('12,500 tracks');
		expect(screen.getByRole('button', { name: 'Open Tracks' })).toBeEnabled();
		expect(screen.getByRole('button', { name: 'Search in Search' })).toBeEnabled();
	});

	it('routes hierarchy, input-prompt, and history clicks explicitly', async () => {
		const harness = mount();
		const rows = screen.getAllByTestId('unified-browse-row');

		await fireEvent.click(screen.getByRole('button', { name: 'Open Tracks' }));
		expect(harness.onItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'Tracks' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Search in Search' }));
		expect(harness.onSearchPrompt).toHaveBeenCalledTimes(1);
		await fireEvent.click(screen.getByTestId('unified-browse-back'));
		expect(harness.onBack).toHaveBeenCalledTimes(1);
	});


	it('keeps unknown action-list titles inert until an explicit action is available', async () => {
		const playable = {
			...readyState(),
			result: {
				...readyState().result!,
				count: 1,
				totalCount: 1,
				items: [
					{
						title: 'Heroes',
						itemKey: 'song-key',
						hint: 'action_list',
						isLoadable: false,
						isPlayable: false
					}
				]
			}
		};
		const harness = mount(playable);

		expect(harness.onItem).not.toHaveBeenCalled();
		const row = screen.getByTestId('unified-browse-row');
		expect(screen.getByRole('button', { name: 'More actions for Heroes' })).toBeDisabled();
		await fireEvent.click(row);
		expect(harness.onItem).not.toHaveBeenCalled();
	});

	it('uses the Unified theme tokens and catches attributed style tags', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const source = fs.readFileSync(
			path.resolve(process.cwd(), 'src/routes/library/UnifiedBrowseView.svelte'),
			'utf8'
		);
		const style = (value: string) => value.match(/<style\b[^>]*>[\s\S]*?<\/style>/)?.[0];

		expect(style(source)).toBeDefined();
		expect(style(source)).toContain('var(--unified-bg)');
		expect(style(source)).toContain('var(--unified-accent)');
		expect(style('<style lang="postcss">.x{color:var(--text)}</style>')).toContain('var(--');
	});
});


describe('explicit track controls', () => {
	it.each(['library', 'search'] as const)('uses explicit album-style controls in %s Tracks with missing itemType', async (context) => {
		const item = { title: 'Same title', subtitle: 'Same artist', itemKey: 'selected-copy', hint: 'action_list', isLoadable: false, isPlayable: false };
		let state = readyState({ result: { title: 'Tracks', level: 2, offset: 0, count: 1, totalCount: 1, items: [item] } });
		if (context === 'search') state = { ...state, snapshot: { context: { hierarchy: 'search', query: 'Same' }, history: [{ hierarchy: 'search', breadcrumb: { title: 'Tracks' } }], forward: [] } };
		const onItem = vi.fn(), onAction = vi.fn(), onFavorite = vi.fn();
		render(UnifiedBrowseView, { props: {
			state, onItem, onBack: vi.fn(), onForward: vi.fn(), onSearchPrompt: vi.fn(),
			collection: context === 'library' ? { id: 'tracks', label: 'Tracks', filter: '', sort: 'original', matchCount: 1,
				onFilter: vi.fn(), onSort: vi.fn(), onRetry: vi.fn() } : undefined,
			trackActions: { enabled: true, busy: false, status: null, error: false, onAction, onFavorite, onMore: vi.fn(), onCloseMore: vi.fn() }
		} });
		const row = screen.getByTestId('unified-browse-row');
		await fireEvent.click(row);
		expect(onItem).not.toHaveBeenCalled();
		expect(onAction).not.toHaveBeenCalled();
		expect(row.classList.contains('tr')).toBe(true);
		await fireEvent.click(within(row).getByRole('button', { name: 'Play' }));
		expect(onAction).toHaveBeenLastCalledWith(item, 'play-now');
		await fireEvent.click(within(row).getByRole('button', { name: 'Queue' }));
		expect(onAction).toHaveBeenLastCalledWith(item, 'queue');
		await fireEvent.click(within(row).getByLabelText('More actions for Same title'));
		await fireEvent.click(within(row).getByRole('button', { name: 'Add Next' }));
		expect(onAction).toHaveBeenLastCalledWith(item, 'add-next');
		await fireEvent.click(within(row).getByLabelText('More actions for Same title'));
		await fireEvent.click(within(row).getByRole('button', { name: 'Favorite' }));
		expect(onFavorite).toHaveBeenCalledWith(item);
		expect(onItem).not.toHaveBeenCalled();
	});
});
