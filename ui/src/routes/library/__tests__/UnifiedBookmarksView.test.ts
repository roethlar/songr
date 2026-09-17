import { installLibraryLayout, clickSelectionAction } from '../../../test/libraryLayout';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import UnifiedBookmarksView from '../UnifiedBookmarksView.svelte';

const favorite = {
	id: 'favorite-1',
	type: 'track' as const,
	title: 'Heroes',
	artist: 'David Bowie',
	added_at: '2026-08-10T00:00:00.000Z'
};

describe('UnifiedBookmarksView', () => {
	let layout: ReturnType<typeof installLibraryLayout>;
	afterEach(() => layout?.restore());
	it.each([640, 100])('lists, activates, and removes Bookmarks at toolbar width %i', async width => {
		layout = installLibraryLayout({ toolbarWidth: width });
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
		if (width === 640) await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled());
		else {
			await waitFor(() => expect(screen.queryByRole('button', { name: 'Open' })).toBeNull());
			expect(screen.getByRole('button', { name: 'More actions' })).toBeEnabled();
		}
		await clickSelectionAction('Open');
		expect(onActivate).toHaveBeenCalledWith(favorite);
		await clickSelectionAction('Remove selected');
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
