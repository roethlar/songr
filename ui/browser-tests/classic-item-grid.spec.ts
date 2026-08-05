import { expect, test } from '@playwright/test';

/**
 * The public browser test. Deliberately minimal: it exists so this suite is
 * never vacuously green in a checkout without the extended-feature layer, where
 * every spec under `native/` is absent. Three assertions, one interaction — the
 * smallest thing that fails if the Classic browse surface stops working.
 *
 * Do not grow this into a campaign. Classic browse behaviour is covered by the
 * unit suites; what is proven here is that the page really renders in a browser
 * and really responds to a click.
 */
test('the Classic browse grid renders its items and answers a click', async ({ page }) => {
	await page.goto('/fixtures/classic-item-grid.html');

	const cards = page.locator('.item-card');
	await expect(cards).toHaveCount(3);
	await expect(page.getByText('Placeholder Suite No. 1')).toBeVisible();

	await cards.first().click();
	await expect(page.getByTestId('classic-grid-clicked')).toHaveText(
		'Placeholder Suite No. 1'
	);
});
