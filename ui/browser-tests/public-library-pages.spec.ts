import { expect, test, type Page } from '@playwright/test';

const more = (page: Page) => page.getByRole('button', { name: 'More library pages', exact: true });

async function enter(page: Page, desktop = false) {
	await page.goto(`/fixtures/library-scroll.html?public=1&nav=default${desktop ? '&desktop=1' : ''}`);
	await expect(page.getByTestId('unified-row').first()).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.libraryScrollFixture?.publicReads.some(read => read.page === 'Library'))).toBe(true);
}

async function openPage(page: Page, id: string, label: string) {
	const control = page.getByTestId(`unified-scope-${id}`);
	if (!await control.isVisible()) await more(page).click();
	await control.click();
	await expect(page.getByTestId('unified-browse-title')).toHaveText(label);
}

async function reloadPublicPage(page: Page, state: { empty?: string; error?: string } = {}) {
	await page.evaluate(state => {
		const url = new URL(window.location.href);
		url.searchParams.set('public', '1');
		url.searchParams.set('nav', 'default');
		if (state.empty) url.searchParams.set('public_empty', state.empty);
		if (state.error) url.searchParams.set('public_error', state.error);
		window.history.replaceState({}, '', url);
	}, state);
	await page.reload();
}

for (const display of [
	{ name: 'desktop', width: 1440, height: 900, desktop: true },
	{ name: 'phone', width: 390, height: 844, desktop: false }
]) {
	test(`${display.name}: organized Settings pins every public page and complete filters find final records`, async ({ page }, testInfo) => {
		await page.setViewportSize(display);
		await enter(page, display.desktop);
		await page.getByRole('button', { name: 'Open Controller settings' }).click();
		const settings = page.getByRole('dialog', { name: 'Controller settings' });
		await expect(settings.getByRole('region', { name: 'Appearance' }).getByRole('group', { name: 'Library density' })).toBeVisible();
		await expect(settings.getByRole('button', { name: 'Library navigation', exact: true })).toHaveAttribute('aria-expanded', 'false');
		await expect(settings.getByRole('button', { name: 'Roon options', exact: true })).toHaveAttribute('aria-expanded', 'false');
		await expect(settings.getByRole('checkbox')).toHaveCount(0);
		const settingsScreenshot = testInfo.outputPath(`settings-${display.name}.png`);
		await settings.screenshot({ path: settingsScreenshot });
		await testInfo.attach(`settings-${display.name}`, { path: settingsScreenshot, contentType: 'image/png' });
		await settings.getByRole('button', { name: 'Library navigation', exact: true }).click();
		await expect(settings.getByRole('checkbox', { name: 'Browse', exact: true })).toHaveCount(0);
		await expect(settings.getByRole('checkbox', { name: 'Playlists', exact: true })).toHaveCount(0);
		const discoveriesId = await page.evaluate(() => window.libraryScrollFixture.discoveriesId);
		const pages = [
			{ id: 'tracks', label: 'Tracks' }, { id: 'composers', label: 'Composers' },
			{ id: 'tags', label: 'Tags' }, { id: discoveriesId, label: 'Discoveries' }
		];
		for (const destination of pages) {
			const checkbox = settings.getByRole('checkbox', { name: destination.label, exact: true });
			await checkbox.click();
			await expect(checkbox).toBeChecked();
		}
		await expect.poll(() => page.evaluate(() => window.libraryScrollFixture.navigationWrites.length)).toBe(4);
		const saved = await page.evaluate(() => window.libraryScrollFixture.navigationWrites.at(-1)!);
		for (const destination of pages) {
			expect(saved.pinned).toContain(destination.id);
			expect(saved.order).toContain(destination.id);
		}
		expect((await page.evaluate(() => window.libraryScrollFixture.publicReads)).every(read => ['Browse', 'Library'].includes(read.page))).toBe(true);
		await settings.getByRole('button', { name: 'Done', exact: true }).click();
		for (const destination of pages) {
			await openPage(page, destination.id, destination.label);
			const filter = page.getByRole('searchbox', { name: `Filter ${destination.label}`, exact: true });
			const sort = page.getByRole('combobox', { name: `Sort ${destination.label}`, exact: true });
			const reads = await page.evaluate(() => window.libraryScrollFixture.publicReads);
			expect(reads.find(read => read.page === destination.label && read.operation === 'browse')).toMatchObject({
				offset: 0, count: 225, totalCount: 225, returnedCount: 100
			});
			await expect(filter).toBeEnabled();
			await expect(sort).toBeEnabled();
			await expect(page.getByTestId('unified-browse-summary')).toHaveText('225');
			if (destination.id === 'tracks') {
				const readCount = (await page.evaluate(() => window.libraryScrollFixture.publicReads)).length;
				await sort.selectOption('artist-asc');
				await expect(page.getByTestId('unified-browse-row').first()).toContainText('Tracks needle at end');
				await sort.selectOption('artist-desc');
				await expect(page.getByTestId('unified-browse-row').first()).toContainText('Tracks 223');
				expect((await page.evaluate(() => window.libraryScrollFixture.publicReads)).length).toBe(readCount);
			} else {
				await expect(sort.locator('option[value="artist-asc"], option[value="artist-desc"]')).toHaveCount(0);
			}
			await sort.selectOption('name-desc');
			await expect(page.getByTestId('unified-browse-row').first()).toContainText(`${destination.label} needle at end`);
			await filter.fill('needle');
			await expect(page.getByTestId('unified-browse-row')).toHaveCount(1);
			await expect(page.getByTestId('unified-browse-row')).toContainText(`${destination.label} needle at end`);
			await expect(page.getByTestId('unified-browse-summary')).toHaveText('1 OF 225');
			expect((await page.evaluate(() => window.libraryScrollFixture.publicReads))
				.filter(read => read.page === destination.label && read.operation === 'load').slice(-2)).toEqual([
				{ page: destination.label, operation: 'load', offset: 100, count: 225, totalCount: 225, returnedCount: 100 },
				{ page: destination.label, operation: 'load', offset: 200, count: 225, totalCount: 225, returnedCount: 25 }
			]);
			await expect(page.getByTestId('unified-scope-browse')).toHaveCount(0);
			await reloadPublicPage(page);
			await expect(page.getByTestId('unified-browse-title')).toHaveText(destination.label);
			await expect(filter).toBeEnabled();
			await expect(sort).toBeEnabled();
			await filter.fill('needle');
			await expect(page.getByTestId('unified-browse-row')).toHaveCount(1);
			await expect(page.getByTestId('unified-browse-row')).toContainText(`${destination.label} needle at end`);
		}
	});
}

test('public pages keep their identity, filter and sort through empty/error responses and retry', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await enter(page);
	await page.evaluate(() => window.libraryScrollFixture.setPublicPageMode('Tags', 'empty'));
	await openPage(page, 'tags', 'Tags');
	await reloadPublicPage(page, { empty: 'Tags' });
	await expect(page.getByTestId('unified-browse-title')).toHaveText('Tags');
	await expect(page.getByRole('searchbox', { name: 'Filter Tags' })).toBeEnabled();
	await expect(page.getByRole('combobox', { name: 'Sort Tags' })).toBeEnabled();
	await expect(page.getByTestId('unified-browse-empty')).toHaveText('Nothing is available here.');
	await page.getByTestId('unified-scope-artists').click();
	await page.evaluate(() => window.libraryScrollFixture.setPublicPageMode('Composers', 'error'));
	await openPage(page, 'composers', 'Composers');
	await reloadPublicPage(page, { empty: 'Tags', error: 'Composers' });
	await expect(page.getByTestId('unified-browse-title')).toHaveText('Composers');
	await expect(page.getByRole('searchbox', { name: 'Filter Composers' })).toBeDisabled();
	await expect(page.getByRole('combobox', { name: 'Sort Composers' })).toBeDisabled();
	await expect(page.getByTestId('unified-browse-error')).toContainText('Composers fixture is unavailable');
	await expect(page.getByRole('button', { name: 'Retry Composers' })).toBeVisible();
	await page.evaluate(() => window.libraryScrollFixture.setPublicPageMode('Composers', 'ready'));
	await page.getByRole('button', { name: 'Retry Composers' }).click();
	await expect(page.getByRole('searchbox', { name: 'Filter Composers' })).toBeEnabled();
	await page.getByRole('searchbox', { name: 'Filter Composers' }).fill('needle');
	await expect(page.getByTestId('unified-browse-row')).toHaveCount(1);
	await expect(page.getByTestId('unified-browse-row')).toContainText('Composers needle at end');
});



for (const display of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
	test(`${display.name}: Tracks use explicit inline actions for the exact row and refuse expired tokens`, async ({ page }, testInfo) => {
		await page.setViewportSize(display);
		await enter(page);
		await openPage(page, 'tracks', 'Tracks');
		await expect(page.getByRole('combobox', { name: 'Sort Tracks' })).toBeEnabled();
		await page.getByRole('combobox', { name: 'Sort Tracks' }).selectOption('artist-desc');
		await page.getByRole('searchbox', { name: 'Filter Tracks' }).fill('All-4-One');
		const rows = page.getByTestId('unified-browse-row');
		await expect(rows).toHaveCount(2);
		await expect(page.getByTestId('unified-browse-summary')).toHaveText('2 OF 225');
		await rows.nth(1).locator('.tnm').click();
		await expect(page.getByTestId('unified-browse-action-sheet')).toHaveCount(0);
		expect(await page.evaluate(() => window.libraryScrollFixture.publicActionProbes)).toEqual([]);
		expect(await page.evaluate(() => window.libraryScrollFixture.publicActions)).toEqual([]);
		const firstMore = rows.nth(0).getByLabel('More actions for I Swear');
		await firstMore.click();
		await expect(rows.nth(0).getByRole('button', { name: 'Add Next', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(rows.nth(0).getByRole('button', { name: 'Add Next', exact: true })).toBeHidden();
		await expect(firstMore).toBeFocused();
		await firstMore.click();
		await page.getByTestId('unified-browse-title').click();
		await expect(rows.nth(0).getByRole('button', { name: 'Add Next', exact: true })).toBeHidden();
		await rows.nth(1).getByLabel('More actions for I Swear').click();
		await expect(rows.nth(1).getByRole('button', { name: 'Add Next', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(rows.nth(1).getByLabel('More actions for I Swear')).toBeFocused();
		await firstMore.focus();
		await page.keyboard.press('Enter');
		await rows.nth(1).getByLabel('More actions for I Swear').focus();
		await page.keyboard.press('Space');
		await expect(page.locator('.track-more[open]')).toHaveCount(1);
		await expect(rows.nth(0).getByRole('button', { name: 'Add Next', exact: true })).toBeHidden();
		await expect(rows.nth(1).getByRole('button', { name: 'Add Next', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		const readsBefore = await page.evaluate(() => window.libraryScrollFixture.publicReads.length);
		await rows.nth(1).getByRole('button', { name: 'Queue', exact: true }).click();
		await expect(page.getByTestId('unified-track-status')).toHaveText('Queued: I Swear');
		const probes = await page.evaluate(() => window.libraryScrollFixture.publicActionProbes);
		expect(probes).toHaveLength(1);
		expect(probes[0].rowIndex).toBe(222);
		expect(await page.evaluate(() => window.libraryScrollFixture.publicActions)).toEqual([
			{ rowIndex: 222, action: 'Queue', generation: probes[0].generation }
		]);
		expect(await page.evaluate(() => window.libraryScrollFixture.publicReads.length)).toBe(readsBefore);
		await rows.nth(1).getByLabel('More actions for I Swear').click();
		await rows.nth(1).getByRole('button', { name: 'Add Next', exact: true }).click();
		await expect(page.getByTestId('unified-track-status')).toHaveText('Added next: I Swear');
		await rows.nth(1).getByLabel('More actions for I Swear').click();
		await rows.nth(1).getByRole('button', { name: 'Favorite', exact: true }).click();
		await expect(page.getByTestId('unified-track-status')).toHaveText('Added to favorites: I Swear');
		expect(await page.evaluate(() => window.libraryScrollFixture.publicFavoriteWrites)).toEqual([
			{ type: 'track', title: 'I Swear', artist: 'All-4-One' }
		]);
		const screenshot = testInfo.outputPath(`tracks-inline-${display.name}.png`);
		await rows.nth(1).hover();
		await expect(rows.nth(1).getByRole('button', { name: 'Play', exact: true })).toHaveCSS('opacity', '1');
		await page.screenshot({ path: screenshot });
		await testInfo.attach(`tracks-inline-${display.name}`, { path: screenshot, contentType: 'image/png' });
		await page.evaluate(() => window.libraryScrollFixture.expirePublicActionAuthority());
		await rows.nth(1).getByRole('button', { name: 'Play', exact: true }).click();
		await expect(page.getByTestId('unified-track-status')).toContainText('expired');
		await expect(page.getByTestId('unified-browse-action-sheet')).toHaveCount(0);
		expect(await page.evaluate(() => window.libraryScrollFixture.publicActions)).toEqual([
			{ rowIndex: 222, action: 'Queue', generation: probes[0].generation },
			{ rowIndex: 222, action: 'Add Next', generation: probes[0].generation }
		]);
		await expect(page.getByRole('searchbox', { name: 'Filter Tracks' })).toBeEnabled();
		await expect(rows).toHaveCount(2);
	});
}

test('Recently played opens a title search and current track page without playback', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/fixtures/library-scroll.html?public=1&nav=default&recent=1');
	await expect(page.getByTestId('unified-row').first()).toBeVisible();
	await more(page).click();
	await page.getByTestId('unified-scope-recently-played').click();
	const recent = page.locator('[data-scope-panel="recently-played"]');
	await expect(recent.getByText(/Only what this controller watched|Roon does not share/)).toHaveCount(0);
	await recent.getByRole('button', { name: /I Swear/ }).click();
	await expect(page.getByTestId('unified-palette-input')).toHaveValue('I Swear');
	await expect(page.getByTestId('unified-palette-row').filter({ hasText: 'All-4-One' })).toBeVisible();
	expect(await page.evaluate(() => window.libraryScrollFixture.publicSearchQueries)).toEqual(['I Swear']);
	expect(await page.evaluate(() => window.libraryScrollFixture.publicActions)).toEqual([]);
	await page.getByTestId('unified-palette-row').filter({ hasText: 'All-4-One' }).click();
	await expect(page.getByTestId('unified-track-page')).toBeVisible();
	await expect(page.getByTestId('unified-song-title')).toHaveText('I Swear');
	expect(await page.evaluate(() => window.libraryScrollFixture.publicActions)).toEqual([]);
});
