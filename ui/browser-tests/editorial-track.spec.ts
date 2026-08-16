import { expect, test } from '@playwright/test';

const presentations = [
	{ theme: 'dark', density: 'compact' },
	{ theme: 'dark', density: 'normal' },
	{ theme: 'dark', density: 'pi' },
	{ theme: 'light', density: 'compact' },
	{ theme: 'light', density: 'normal' },
	{ theme: 'light', density: 'pi' }
] as const;

test('the exact-track page keeps its anatomy in every presentation', async ({ page }) => {
	await page.goto('/fixtures/editorial-track.html');
	const headingColors = new Map<string, string>();

	for (const presentation of presentations) {
		await page.evaluate(({ theme, density }) => {
			window.editorialTrackFixture.setPresentation(theme, density);
		}, presentation);

		await expect(page.getByTestId('unified-song-title')).toHaveText('Fixture Song');
		await expect(page.getByTestId('unified-song-subtitle')).toContainText('Fixture Artist');
		await expect(page.getByTestId('unified-song-close')).toHaveText('Close search');

		// Actions are enabled: one supplied zone plus a live onAction.
		await expect(page.getByTestId('unified-song-play-now')).toBeEnabled();
		await expect(page.getByTestId('unified-song-add-next')).toBeEnabled();
		await expect(page.getByTestId('unified-song-queue')).toBeEnabled();

		// Independently authorized relationship links: one album, one
		// artist, one composer.
		await expect(page.getByTestId('unified-song-album-link')).toBeEnabled();
		await expect(page.getByTestId('unified-song-artist-link')).toHaveText('Go to Artist');
		await expect(page.getByTestId('unified-song-composer-links')).toContainText(
			'Jamie Composer'
		);
		await expect(page.getByTestId('unified-song-relationship-status')).toContainText(
			'One matching album found.'
		);

		headingColors.set(
			presentation.theme,
			await page
				.getByTestId('unified-song-title')
				.evaluate((element) => getComputedStyle(element).color)
		);
	}

	expect(headingColors.get('dark')).not.toBe(headingColors.get('light'));

	// A single zone executes directly with that zone.
	await page.getByTestId('unified-song-play-now').click();
	expect(await page.evaluate(() => window.editorialTrackFixture.actionLog())).toContain(
		'play-now@zone-a'
	);
});
