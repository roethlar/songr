import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import UnifiedBookmarksView from '../UnifiedBookmarksView.svelte';

const favorite = {
	id: 'favorite-1',
	type: 'track' as const,
	title: 'Heroes',
	artist: 'David Bowie',
	added_at: '2026-08-10T00:00:00.000Z'
};

describe('UnifiedBookmarksView', () => {
	it('lists, activates, and removes Bookmarks in Unified row language', async () => {
		const onActivate = vi.fn();
		const onRemoveBatch = vi.fn(async () => {});
		render(UnifiedBookmarksView, {
			props: {
				state: { entries: [favorite], loading: false, loaded: true },
				onActivate,
				onRemoveBatch
			}
		});

		expect(screen.getByTestId('unified-favorite-row')).toHaveTextContent('Heroes');
		expect(screen.getByTestId('unified-favorite-row')).toHaveTextContent('David Bowie');
		await fireEvent.click(screen.getByRole('button', { name: 'Select Heroes' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open' }));
		expect(onActivate).toHaveBeenCalledWith(favorite);
		await fireEvent.click(screen.getByRole('button', { name: 'Remove selected' }));
		expect(onRemoveBatch).toHaveBeenCalledWith([favorite]);
	});

	it('uses the Unified theme tokens', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const source = fs.readFileSync(
			path.resolve(process.cwd(), 'src/routes/library/UnifiedBookmarksView.svelte'),
			'utf8'
		);
		const style = source.match(/<style\b[^>]*>[\s\S]*?<\/style>/)?.[0];
		expect(style).toBeDefined();
		expect(style).toContain('var(--unified-fg)');
		expect(style).toContain('var(--songr-line-10)');
	});
});
