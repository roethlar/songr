import { expect, test } from '@playwright/test';

const presentations = [
	{ theme: 'dark', density: 'compact' },
	{ theme: 'dark', density: 'normal' },
	{ theme: 'dark', density: 'pi' },
	{ theme: 'light', density: 'compact' },
	{ theme: 'light', density: 'normal' },
	{ theme: 'light', density: 'pi' }
] as const;

test('album editorial sections and child views work in every presentation', async ({ page }) => {
	await page.goto('/fixtures/editorial-album.html');
	const proseColors = new Map<string, string>();

	for (const presentation of presentations) {
		await page.evaluate(({ theme, density }) => {
			window.editorialAlbumFixture.reset();
			window.editorialAlbumFixture.setPresentation(theme, density);
		}, presentation);

		// Parent album view: review with long-form collapse, credits with a
		// follow row, and both relationship families.
		await expect(page.getByTestId('unified-album-review')).toContainText('Review');
		const toggle = page.getByTestId('unified-album-review-toggle');
		await expect(toggle).toHaveText('Read more');
		const collapsed = await page.getByTestId('unified-album-review-text').textContent();
		await toggle.click();
		await expect(toggle).toHaveText('Show less');
		const expanded = await page.getByTestId('unified-album-review-text').textContent();
		expect((expanded ?? '').length).toBeGreaterThan((collapsed ?? '').length);
		await expect(page.getByTestId('unified-album-credits')).toContainText('Robin Engineer');
		await expect(page.getByTestId('unified-album-credits-follow-0-0')).toHaveText(
			'Casey Producer'
		);
		await expect(page.getByTestId('unified-album-related')).toContainText('Similar albums');
		await expect(page.getByTestId('unified-album-related')).toContainText('See also');
		proseColors.set(
			presentation.theme,
			await page
				.getByTestId('unified-album-review-text')
				.evaluate((element) => getComputedStyle(element).color)
		);

		// Exact-track child: per-row Info opens the track's own view with
		// its description and role-grouped credits.
		await page.getByTestId('unified-track-info-1').click();
		await expect(page.getByTestId('unified-album-track-info')).toContainText('Middle Song');
		await expect(page.getByTestId('unified-album-track-description')).toContainText(
			'About the composition'
		);
		await expect(page.getByTestId('unified-album-track-credits')).toContainText('Composer');
		await expect(page.getByTestId('unified-album-track-credits')).toContainText(
			'Jamie Composer'
		);

		// A performer followed from track credits backs out to those credits
		// (ri5-4), not to the album view.
		await page.getByTestId('unified-album-track-credits-follow-1-0').click();
		await expect(page.getByTestId('unified-album-credit-performer')).toContainText(
			'Casey Producer'
		);
		await expect(page.getByTestId('unified-album-performer-biography')).toContainText(
			'Biography'
		);
		await expect(page.getByTestId('unified-album-credit-performer-back')).toHaveText(
			'Back to track credits'
		);
		await page.getByTestId('unified-album-credit-performer-back').click();
		await expect(page.getByTestId('unified-album-track-info')).toContainText('Middle Song');
		await page.getByTestId('unified-album-track-info-back').click();
		await expect(page.getByTestId('unified-album-review')).toBeVisible();

		// A followed similar album replaces the album's editorial surface
		// with the child's identity and sections; Back restores the parent.
		await page.getByTestId('unified-album-related-follow-0-0').click();
		await expect(page.getByTestId('unified-album-similar-album')).toContainText(
			'Similar Album One'
		);
		await expect(page.getByTestId('unified-album-similar-review')).toBeVisible();
		await page.getByTestId('unified-album-similar-album-back').click();
		await expect(page.getByTestId('unified-album-related')).toBeVisible();
	}

	expect(proseColors.get('dark')).not.toBe(proseColors.get('light'));

	// A retryable section failure earns exactly the quiet retry affordance.
	await page.evaluate(() => window.editorialAlbumFixture.failReview());
	await expect(page.getByTestId('unified-album-review-retry')).toHaveText('Try again');
	await page.evaluate(() => window.editorialAlbumFixture.reset());
	await expect(page.getByTestId('unified-album-review')).toBeVisible();

	// §4.3: Escape never silently discards an item page — Back is the exit.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('unified-album-page')).toBeVisible();
	await expect(page.getByTestId('unified-album-review')).toBeVisible();

	// §4.3: long prose reads without horizontal scrolling and stays
	// selectable.
	await page.getByTestId('unified-album-review-toggle').click();
	const proseMetrics = await page
		.getByTestId('unified-album-review-text')
		.evaluate((element) => ({
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
			userSelect: getComputedStyle(element).userSelect
		}));
	expect(proseMetrics.scrollWidth).toBeLessThanOrEqual(proseMetrics.clientWidth);
	expect(proseMetrics.userSelect).not.toBe('none');
});
