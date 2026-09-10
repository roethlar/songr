import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NAVIGATION_SETTINGS, NAVIGATION_DESTINATIONS } from '@shared/navigationSettings';
import LibraryScopeNavigation from '../LibraryScopeNavigation.svelte';

const items = NAVIGATION_DESTINATIONS.filter(item => ['artists', 'albums', 'genres', 'browse', 'favorites', 'recently-played', 'surprise'].includes(item.id));
function mount(overrides = {}) {
	const onSelect = vi.fn();
	return { onSelect, ...render(LibraryScopeNavigation, { props: { items,
		order: DEFAULT_NAVIGATION_SETTINGS.order, pinned: DEFAULT_NAVIGATION_SETTINGS.pinned,
		activeId: 'artists', onSelect, ...overrides } }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('LibraryScopeNavigation', () => {
	it('keeps the approved three primary pages and puts other destinations in More only', async () => {
		const { onSelect } = mount();
		expect(screen.getByTestId('unified-scope-artists')).toBeVisible();
		expect(screen.getByTestId('unified-scope-albums')).toBeVisible();
		expect(screen.getByTestId('unified-scope-genres')).toBeVisible();
		expect(screen.queryByTestId('unified-scope-favorites')).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-scope-more'));
		expect(screen.getByRole('menu')).toBeVisible();
		expect(screen.queryByText(/settings|customize/i)).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-scope-favorites'));
		expect(onSelect).toHaveBeenCalledWith('favorites');
		expect(screen.queryByRole('menu')).toBeNull();
		expect(screen.getByTestId('unified-scope-more')).toHaveFocus();
	});
	it('reflects a server pin/order change without changing it when choosing overflow', async () => {
		const { rerender, onSelect } = mount();
		await rerender({ pinned: ['favorites'], activeId: 'albums' });
		expect(screen.getByTestId('unified-scope-favorites')).toBeVisible();
		expect(screen.getByTestId('unified-scope-more')).toHaveClass('on');
		await fireEvent.click(screen.getByTestId('unified-scope-more'));
		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		expect(onSelect).toHaveBeenCalledWith('albums');
		expect(screen.queryByTestId('unified-scope-albums')).toBeNull();
	});
	it('works with no pins and does not offer an empty menu when all pages fit', async () => {
		const { rerender } = mount({ pinned: [] });
		await fireEvent.click(screen.getByTestId('unified-scope-more'));
		expect(screen.getAllByRole('menuitem')).toHaveLength(items.length);
		await rerender({ pinned: items.map(item => item.id) });
		expect(screen.queryByRole('menu')).toBeNull();
		expect(screen.queryByTestId('unified-scope-more')).toBeNull();
	});
	it('supports arrow keys, Escape, and pointer dismissal', async () => {
		mount();
		const more = screen.getByTestId('unified-scope-more');
		await fireEvent.keyDown(more, { key: 'ArrowDown' });
		await waitFor(() => expect(screen.getAllByRole('menuitem')[0]).toHaveFocus());
		await fireEvent.keyDown(document.activeElement!, { key: 'End' });
		expect(screen.getAllByRole('menuitem').at(-1)).toHaveFocus();
		await fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
		expect(more).toHaveFocus();
		expect(screen.queryByRole('menu')).toBeNull();
		await fireEvent.click(more);
		await fireEvent.pointerDown(document.body);
		expect(screen.queryByRole('menu')).toBeNull();
	});
	it('moves a stable prefix into overflow on resize without rewriting configured pins', async () => {
		let width = 250;
		let resize: (() => void) | undefined;
		vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
			return { width: this.tagName === 'BUTTON' ? 80 : width, bottom: 80, left: 0 } as DOMRect;
		});
		vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
		mount();
		await waitFor(() => expect(screen.queryByTestId('unified-scope-albums')).toBeNull());
		expect(screen.getByTestId('unified-scope-artists')).toBeVisible();
		await fireEvent.click(screen.getByTestId('unified-scope-more'));
		expect(screen.getByTestId('unified-scope-albums')).toBeVisible();
		await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
		width = 600; resize?.();
		await waitFor(() => expect(screen.getByTestId('unified-scope-albums')).toBeVisible());
		expect(screen.getByTestId('unified-scope-genres')).toBeVisible();
		expect(DEFAULT_NAVIGATION_SETTINGS.pinned).toEqual(['artists', 'albums', 'genres']);
	});
});
