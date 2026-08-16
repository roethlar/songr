import { fireEvent, render, screen } from '@testing-library/svelte';
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
	const onLoadMore = vi.fn();
	const onSearchPrompt = vi.fn();
	const result = render(UnifiedBrowseView, {
		props: { state, onBack, onForward, onItem, onLoadMore, onSearchPrompt }
	});
	return { ...result, onBack, onForward, onItem, onLoadMore, onSearchPrompt };
}

describe('UnifiedBrowseView', () => {
	it('renders the deep hierarchy as prototype-language rows with semantic history', () => {
		mount();

		expect(screen.getByTestId('unified-browse-title')).toHaveTextContent('Library');
		expect(screen.getByTestId('unified-browse-summary')).toHaveTextContent('2 OF 102');
		expect(screen.getByTestId('unified-browse-path')).toHaveTextContent('Library');
		const rows = screen.getAllByTestId('unified-browse-row');
		expect(rows[0]).toHaveTextContent('Tracks');
		expect(rows[0]).toHaveTextContent('12,500 tracks');
		expect(rows[0]).toHaveTextContent('OPEN');
		expect(rows[1]).toHaveTextContent('SEARCH');
	});

	it('routes hierarchy, input-prompt, history, and paging clicks explicitly', async () => {
		const harness = mount();
		const rows = screen.getAllByTestId('unified-browse-row');

		await fireEvent.click(rows[0]);
		expect(harness.onItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'Tracks' }));
		await fireEvent.click(rows[1]);
		expect(harness.onSearchPrompt).toHaveBeenCalledTimes(1);
		await fireEvent.click(screen.getByTestId('unified-browse-back'));
		expect(harness.onBack).toHaveBeenCalledTimes(1);
		await fireEvent.click(screen.getByTestId('unified-browse-more'));
		expect(harness.onLoadMore).toHaveBeenCalledTimes(1);
	});

	it('keeps loaded rows visible and exposes retry after paging fails', async () => {
		const harness = mount(readyState({ phase: 'error', error: 'temporary timeout' }));

		expect(screen.getByTestId('unified-browse-error')).toHaveTextContent(
			'Could not load more: temporary timeout'
		);
		expect(screen.getAllByTestId('unified-browse-row')).toHaveLength(2);
		const retry = screen.getByTestId('unified-browse-more');
		expect(retry).toHaveTextContent('Retry next 100');

		await fireEvent.click(retry);
		expect(harness.onLoadMore).toHaveBeenCalledTimes(1);
	});

	it('labels playable rows as actions and never invokes them during render', async () => {
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
		expect(row).toHaveTextContent('ACTIONS');
		await fireEvent.click(row);
		expect(harness.onItem).toHaveBeenCalledTimes(1);
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
