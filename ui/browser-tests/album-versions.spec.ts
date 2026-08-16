import { expect, test } from '@playwright/test';

const presentations = [
	{ theme: 'dark', density: 'compact' },
	{ theme: 'dark', density: 'normal' },
	{ theme: 'dark', density: 'pi' },
	{ theme: 'light', density: 'compact' },
	{ theme: 'light', density: 'normal' },
	{ theme: 'light', density: 'pi' }
] as const;

test('version selection and cached tab navigation work in every presentation', async ({ page }) => {
	await page.goto('/fixtures/album-versions.html');
	const panelColors = new Map<string, string>();

	for (const presentation of presentations) {
		await page.evaluate(({ theme, density }) => {
			window.albumVersionsFixture.reset();
			window.albumVersionsFixture.setPresentation(theme, density);
		}, presentation);

		await expect(page.getByTestId('unified-album-tab-versions')).toHaveText('Versions (2)');
		await expect(page.getByTestId('unified-album-version-0')).toContainText('Version 1');
		await expect(page.getByTestId('unified-album-version-1')).toContainText('Version 2');
		await expect(page.getByTestId('unified-album-page')).toBeInViewport();
		// The hero artwork keeps the retired panel's exact box (ri1-5).
		const artBox = await page
			.getByTestId('unified-album-page')
			.locator('.art')
			.boundingBox();
		expect(artBox?.width).toBe(196);
		expect(artBox?.height).toBe(196);
		// The page surface is transparent over the pane; the version rows
		// carry the themed surface token, so they prove theming reaches the
		// album page.
		panelColors.set(
			presentation.theme,
			await page.getByTestId('unified-album-version-0').evaluate(
				(element) => getComputedStyle(element).backgroundColor
			)
		);

		await page.getByTestId('unified-album-version-1').click();
		await expect(page.getByTestId('unified-album-detail-loading')).toContainText('Version 2');
		await page.evaluate(() => window.albumVersionsFixture.resolve('version-b'));
		await expect(page.getByTestId('unified-album-tracks')).toContainText('Live track 13');

		await page.getByTestId('unified-album-tab-versions').click();
		await expect(page.getByTestId('unified-album-version-1')).toHaveClass(/selected/);
		await expect(page.getByTestId('unified-album-version-1')).toContainText('13 tracks');
		await page.getByTestId('unified-album-tab-details').click();
		await expect(page.getByTestId('unified-album-tracks')).toContainText('Live track 13');

		await page.getByTestId('unified-album-tab-versions').click();
		await page.getByTestId('unified-album-version-0').click();
		await page.evaluate(() => window.albumVersionsFixture.fail('version-a'));
		await expect(page.getByTestId('unified-album-version-0')).toContainText('Retry');
		await expect(page.getByTestId('unified-album-version-1')).toContainText('13 tracks');
	}

	expect(panelColors.get('dark')).not.toBe(panelColors.get('light'));
});
