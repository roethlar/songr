import { expect, test } from '@playwright/test';

const presentations = [
	{ theme: 'dark', density: 'compact' },
	{ theme: 'dark', density: 'normal' },
	{ theme: 'dark', density: 'pi' },
	{ theme: 'light', density: 'compact' },
	{ theme: 'light', density: 'normal' },
	{ theme: 'light', density: 'pi' }
] as const;

test('artist editorial sections and the related-artist child work in every presentation', async ({
	page
}) => {
	await page.goto('/fixtures/editorial-artist.html');
	const proseColors = new Map<string, string>();

	for (const presentation of presentations) {
		await page.evaluate(({ theme, density }) => {
			window.editorialArtistFixture.reset();
			window.editorialArtistFixture.setPresentation(theme, density);
		}, presentation);

		await expect(page.getByTestId('unified-artist-name')).toHaveText('Fixture Artist');
		await expect(page.getByTestId('fixture-discography')).toContainText('First Fixture Album');

		// Biography with long-form collapse.
		const toggle = page.getByTestId('unified-artist-biography-toggle');
		await expect(toggle).toHaveText('Read more');
		await toggle.click();
		await expect(toggle).toHaveText('Show less');

		// Relationship families in delivered order; rows without a follow
		// target render as plain text.
		await expect(page.getByTestId('unified-artist-relationships')).toContainText(
			'Similar artists'
		);
		await expect(page.getByTestId('unified-artist-relationships')).toContainText('Influenced');
		await expect(page.getByTestId('unified-artist-relationships')).toContainText(
			'Unlinked Artist'
		);
		await expect(page.getByTestId('unified-artist-relationships-follow-0-0')).toHaveText(
			'Kindred Artist'
		);

		// External links carry safe http(s) destinations only.
		const link = page.getByTestId('unified-artist-links-link-0');
		await expect(link).toHaveAttribute('href', 'https://example.com/fixture-artist');
		await expect(link).toHaveAttribute('rel', /noopener/);

		proseColors.set(
			presentation.theme,
			await page
				.getByTestId('unified-artist-biography-text')
				.evaluate((element) => getComputedStyle(element).color)
		);

		// A followed related artist replaces the surface with the child's
		// identity; the back control names the parent artist.
		await page.getByTestId('unified-artist-relationships-follow-0-0').click();
		await expect(page.getByTestId('unified-artist-related-artist')).toContainText(
			'Kindred Artist'
		);
		await expect(page.getByTestId('unified-artist-related-artist-back')).toHaveText(
			'Back to Fixture Artist'
		);
		await expect(page.getByTestId('unified-artist-biography-text')).toContainText(
			'Kindred Artist is a synthetic fixture performer'
		);
		await page.getByTestId('unified-artist-related-artist-back').click();
		await expect(page.getByTestId('unified-artist-relationships')).toBeVisible();
	}

	expect(proseColors.get('dark')).not.toBe(proseColors.get('light'));

	// §4.3 tab order: content (the biography and its toggle) precedes the
	// relationship rows, which precede the external links.
	const tabOrder: string[] = [];
	await page.getByTestId('unified-artist-back').focus();
	for (let step = 0; step < 25; step += 1) {
		await page.keyboard.press('Tab');
		const focusedTestId = await page.evaluate(() =>
			document.activeElement instanceof HTMLElement
				? (document.activeElement.dataset.testid ?? null)
				: null
		);
		if (focusedTestId) tabOrder.push(focusedTestId);
		if (focusedTestId === 'unified-artist-links-link-0') break;
	}
	const toggleAt = tabOrder.indexOf('unified-artist-biography-toggle');
	const followAt = tabOrder.indexOf('unified-artist-relationships-follow-0-0');
	const linkAt = tabOrder.indexOf('unified-artist-links-link-0');
	expect(toggleAt).toBeGreaterThanOrEqual(0);
	expect(followAt).toBeGreaterThan(toggleAt);
	expect(linkAt).toBeGreaterThan(followAt);
});
