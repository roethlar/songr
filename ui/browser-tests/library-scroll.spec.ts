import { expect, test, type Page } from '@playwright/test';

// The owner's report, 2026-08-22: "if I drill down to an artist then hit back,
// it reloads the artists page completely, losing my place in the several
// hundred long list. if I drill to an album then hit artists then go back to
// the album tab, it reloads and I lose my place."
//
// Scroll restoration is a LAYOUT behaviour — the browser clamps `scrollTop` to
// the container's current `scrollHeight` — so it can only be proven in a real
// engine. jsdom has no layout and would pass any of this vacuously.
//
// Not covered here: the Back BUTTON on an item page. That path calls
// `window.history.back()`, and the real surface reacts through
// `+page.svelte`'s `page.state` effect (suspend → resume). This fixture mounts
// `UnifiedLibraryMode` directly with the `$app/navigation` stub, which keeps
// its own in-memory history and never touches `window.history`, so a real
// `back()` would simply leave the fixture document. The restore that path uses
// is the same `restorePaneScrollTop` proven below.

const PANE = '[data-testid="unified-pane"]';

async function paneScrollTop(page: Page): Promise<number> {
	return page.locator(PANE).evaluate((pane) => pane.scrollTop);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/fixtures/library-scroll.html');
	await expect(page.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	// Wait for ROWS, not just the chrome: `scrollTop` is clamped to the current
	// scrollHeight, so acting before the list renders silently lands at 0.
	await expect(page.getByTestId('unified-row').first()).toBeVisible();
});

test('a scope returns to where you drilled out of it', async ({ page }) => {
	const rows = page.getByTestId('unified-row');

	// Drill in from deep in the list. Targeting a row by index keeps the
	// starting position deterministic — a text filter can match a row near the
	// top and quietly scroll back up before clicking.
	const row = rows.nth(300);
	await row.scrollIntoViewIfNeeded();
	const drilledFrom = await paneScrollTop(page);
	expect(drilledFrom).toBeGreaterThan(2000);

	await row.click();
	await expect(page.getByTestId('unified-artist-back')).toBeVisible();

	// Leave the scope entirely and come back.
	await page.getByTestId('unified-scope-albums').click();
	await expect(page.getByTestId('unified-tile').first()).toBeVisible();

	await page.getByTestId('unified-scope-artists').click();
	await expect(rows.first()).toBeVisible();

	// The whole point: a return, not a restart.
	await expect
		.poll(async () => paneScrollTop(page), { timeout: 4000 })
		.toBeGreaterThan(drilledFrom * 0.9);
});

test('the scope chips stay reachable from deep in a list, and switching keeps the place', async ({
	page
}) => {
	const rows = page.getByTestId('unified-row');
	const albumsChip = page.getByTestId('unified-scope-albums');
	const artistsChip = page.getByTestId('unified-scope-artists');

	await rows.nth(300).scrollIntoViewIfNeeded();
	const deep = await paneScrollTop(page);
	expect(deep).toBeGreaterThan(2000);

	// Pinned: still on screen without scrolling back to the top.
	await expect(albumsChip).toBeInViewport();

	await albumsChip.click();
	await expect(page.getByTestId('unified-tile').first()).toBeVisible();

	await artistsChip.click();
	await expect(rows.first()).toBeVisible();
	await expect
		.poll(async () => paneScrollTop(page), { timeout: 4000 })
		.toBeGreaterThan(deep * 0.9);
});

test('a scope with no remembered position still opens at the top', async ({ page }) => {
	// The memory must not invent a position for a scope never scrolled, and a
	// deliberate reset must still win over an in-flight restore.
	await page.getByTestId('unified-scope-albums').click();
	await expect(page.getByTestId('unified-tile').first()).toBeVisible();
	await expect.poll(async () => paneScrollTop(page), { timeout: 4000 }).toBe(0);
});
