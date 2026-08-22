import { expect, test, type Page } from '@playwright/test';

// The owner's report, 2026-08-22: "the UI's apparent minimum width is too wide
// for a phone browser, and there's no horizontal scroll (which would be bad UX
// anyway) so there's no way to navigate to the cutoff items."
//
// `.unified-surface` sets `overflow: hidden`, so anything wider than the
// viewport is not merely cramped — it is clipped and unreachable. That makes
// "nothing sticks out" the load-bearing assertion, and it is a layout fact only
// a real engine can answer.
//
// Desktop stays the primary target (`.agents/repo-guidance.md`); these widths
// are about the surface remaining USABLE below it, not about optimising for it.

const WIDTHS = [320, 360, 390, 430, 520, 768, 1024, 1440];

async function overflowingElements(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const vw = document.documentElement.clientWidth;
		const out: string[] = [];
		document.querySelectorAll<HTMLElement>('*').forEach((el) => {
			const rect = el.getBoundingClientRect();
			if (rect.width === 0) return;
			if (rect.right > vw + 1) {
				const cls =
					typeof el.className === 'string' && el.className
						? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
						: '';
				out.push(`${el.tagName.toLowerCase()}${cls} right=${Math.round(rect.right)}/${vw}`);
			}
		});
		return out;
	});
}

test('nothing is clipped out of reach at any supported width', async ({ page }) => {
	await page.goto('/fixtures/library-scroll.html');
	await expect(page.getByTestId('unified-row').first()).toBeVisible();

	for (const width of WIDTHS) {
		await page.setViewportSize({ width, height: 844 });
		// Let the breakpoint settle before measuring.
		await page.waitForTimeout(120);

		expect(await overflowingElements(page), `overflow at ${width}px`).toEqual([]);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth),
			`document scrolls horizontally at ${width}px`
		).toBeLessThanOrEqual(width);
	}
});

test('the core controls stay reachable on a phone', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/fixtures/library-scroll.html');
	await expect(page.getByTestId('unified-row').first()).toBeVisible();

	for (const id of [
		'unified-brand',
		'unified-about-open',
		'unified-scope-artists',
		'unified-scope-albums',
		'unified-scope-browse'
	]) {
		await expect(page.getByTestId(id), `${id} off-screen at 390px`).toBeInViewport();
	}

	// Names must be readable, not ellipsed into a single-column-worth of nothing:
	// the multi-column list collapses to one column at phone width.
	const firstRow = page.getByTestId('unified-row').first();
	await expect(firstRow).toContainText(/Artist \d{3}/u);
	const rowWidth = await firstRow.evaluate((el) => el.getBoundingClientRect().width);
	expect(rowWidth).toBeGreaterThan(200);
});
