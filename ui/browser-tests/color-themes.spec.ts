import { expect, test } from '@playwright/test';

const themes = [
	{ id: 'laser', label: 'Laser', bg: 'rgb(0, 0, 0)', accent: 'rgb(255, 53, 206)', count: 'rgb(244, 255, 69)' },
	{ id: 'miami', label: 'Miami', bg: 'rgb(22, 5, 33)', accent: 'rgb(255, 104, 189)', count: 'rgb(255, 233, 145)' },
	{ id: 'pop', label: 'Pop Art', bg: 'rgb(255, 242, 176)', accent: 'rgb(38, 59, 184)', count: 'rgb(160, 28, 82)' }
] as const;

test.use({ viewport: { width: 1440, height: 900 }, hasTouch: true, reducedMotion: 'reduce' });

for (const theme of themes) {
	test(`${theme.label} works through Settings, reload, Library and playback`, async ({ page }, info) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/library/album-artists?public=1');
		await page.getByRole('button', { name: 'Open Controller settings' }).tap();
		const choices = page.getByRole('group', { name: 'Color theme' });
		await expect(choices.getByRole('button')).toHaveCount(5);
		await choices.getByRole('button', { name: theme.label, exact: true }).tap();
		await expect(choices.getByRole('button', { pressed: true })).toHaveText(theme.label);
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
		await page.screenshot({ path: info.outputPath('settings.png') });
		await page.getByRole('button', { name: 'Close Controller settings' }).tap();
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
		await expect(page.getByTestId('unified-artist-view-album-artists')).toHaveAttribute('aria-pressed', 'true');
		const artist = page.getByTestId('unified-credit-artist').filter({ visible: true }).first();
		await expect(artist.locator('.ac')).toHaveCSS('color', theme.count);
		await expect(page.locator('.unified-surface')).toHaveCSS('background-color', theme.bg);
		await page.screenshot({ path: info.outputPath('artists.png') });
		await page.getByTestId('unified-scope-albums').tap();
		const tile = page.locator('[data-scope-panel="albums"] .tile').first();
		await expect(tile.locator('.art')).not.toHaveCSS('box-shadow', 'none');
		await page.screenshot({ path: info.outputPath('albums.png') });
		await tile.tap();
		const tracks = page.getByTestId('unified-album-tracks');
		await expect(tracks).toBeVisible();
		await tracks.locator('.tnm').first().tap();
		await page.mouse.move(0, 0);
		await expect(tracks.locator('.tnm').first()).toHaveAttribute('aria-pressed', 'true');
		await expect(tracks.locator('.tnm').first()).toHaveCSS('color', theme.count);
		const selected = tracks.locator('.is-track-selected');
		await expect(selected).not.toHaveCSS('box-shadow', 'none');
		if (theme.id === 'pop') await expect(selected).toHaveCSS('background-color', 'rgb(255, 216, 232)');
		else await expect(selected).toHaveCSS('background-image', /linear-gradient/);
		await page.screenshot({ path: info.outputPath('album.png') });

		// The production outer layout owns the actual transport and zone menu.
		await page.goto('/library?shell=1&grouped=1');
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
		await expect(page.locator('.unified-transport-controls button.big')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await page.screenshot({ path: info.outputPath('playback.png') });

		// Returning to an existing palette removes the new treatment completely.
		await page.goto('/library/album-artists?public=1');
		await page.getByRole('button', { name: 'Open Controller settings' }).tap();
		await page.getByRole('group', { name: 'Color theme' }).getByRole('button', { name: 'Dark', exact: true }).tap();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.getByRole('button', { name: 'Close Controller settings' }).tap();
		await expect(page.getByTestId('unified-pane')).toHaveCSS('background-image', 'none');
		await page.setViewportSize({ width: 390, height: 844 });
		await page.getByRole('button', { name: 'Open Controller settings' }).tap();
		await page.getByRole('group', { name: 'Color theme' }).getByRole('button', { name: theme.label, exact: true }).tap();
		await expect(page.getByRole('group', { name: 'Color theme' }).getByRole('button', { pressed: true })).toHaveText(theme.label);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		await page.screenshot({ path: info.outputPath('settings-touch.png') });
		expect(errors).toEqual([]);
	});
}
