import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import UnifiedFavoritesView from '../UnifiedFavoritesView.svelte';

const favorite = {
	id: 'favorite-1',
	type: 'track' as const,
	title: 'Heroes',
	artist: 'David Bowie',
	added_at: '2026-08-10T00:00:00.000Z'
};

describe('UnifiedFavoritesView', () => {
	it('lists, activates, and removes Favorites in Unified row language', async () => {
		const onActivate = vi.fn();
		const onRemove = vi.fn();
		render(UnifiedFavoritesView, {
			props: {
				state: { entries: [favorite], loading: false, loaded: true },
				onActivate,
				onRemove
			}
		});

		expect(screen.getByTestId('unified-favorite-row')).toHaveTextContent('Heroes');
		expect(screen.getByTestId('unified-favorite-row')).toHaveTextContent('David Bowie');
		await fireEvent.click(screen.getByRole('button', { name: 'Search favorite Heroes' }));
		expect(onActivate).toHaveBeenCalledWith(favorite);
		await fireEvent.click(screen.getByRole('button', { name: 'Remove Heroes from favorites' }));
		expect(onRemove).toHaveBeenCalledWith(favorite);
	});

	it('uses the Unified theme tokens', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const source = fs.readFileSync(
			path.resolve(process.cwd(), 'src/routes/library/UnifiedFavoritesView.svelte'),
			'utf8'
		);
		const style = source.match(/<style\b[^>]*>[\s\S]*?<\/style>/)?.[0];
		expect(style).toBeDefined();
		expect(style).toContain('var(--unified-fg)');
		expect(style).toContain('var(--songr-panel)');
	});
});
