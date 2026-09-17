import { expect, test, type Page } from '@playwright/test';

const sections = (page: Page) => page.getByTestId('album-artist-section').filter({ visible: true });
const tiles = (page: Page) => page.locator('[data-scope-panel="albums"] .tile');
async function chooseGrouping(page: Page, name: string) {
	await page.getByTestId('unified-sort').click();
	await page.getByRole('button', { name, exact: true }).click();
}

test('Albums artist grouping remembers its mode, preserves native album links and keeps the rail aligned', async ({ page, context }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await context.addInitScript(() => { window.libraryScrollFixtureSize = { artists: 40, albums: 400 }; });
	await page.goto('/library/albums');
	await expect(tiles(page)).toHaveCount(400);
	const originalLinks = await tiles(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('href')).sort());
	await page.getByTestId('unified-sort').click();
	await page.getByRole('button', { name: 'Group by Artist', exact: true }).focus();
	await page.keyboard.press('Space');
	await expect(sections(page)).toHaveCount(40);
	await expect(page.getByTestId('unified-sort')).toContainText('By artist');
	expect(await tiles(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('href')).sort())).toEqual(originalLinks);
	expect(await sections(page).evaluateAll(groups => groups.every(group => {
		const artist = group.querySelector('h2')!.textContent;
		return [...group.querySelectorAll('.tile .ta')].every(credit => credit.textContent === artist);
	}))).toBe(true);

	await page.reload();
	await expect(sections(page)).toHaveCount(40);
	const other = await context.newPage();
	await other.goto('/library/albums');
	await expect(sections(other)).toHaveCount(40);
	await chooseGrouping(other, 'Group by letter');
	await expect(sections(page)).toHaveCount(0);
	await expect(page.locator('[data-scope-panel="albums"] .grp .gl')).toHaveCount(26);
	await chooseGrouping(other, 'Group by Artist');
	await expect(sections(page)).toHaveCount(40);
	await other.close();

	const retainedArtist = await page.locator('[data-scope-panel="artists"] .arow').first().elementHandle();
	await page.getByTestId('unified-scope-artists').click();
	await expect(sections(page)).toHaveCount(0);
	await page.getByTestId('unified-scope-albums').click();
	await expect(sections(page)).toHaveCount(40);
	await page.evaluate(() => window.libraryScrollFixture.setPresentation('dark', 'compact'));
	expect(await retainedArtist!.evaluate(node => node.isConnected)).toBe(true);
	await page.getByTestId('unified-rail').getByRole('button', { name: 'M', exact: true }).click();
	await expect.poll(async () => {
		const heading = await page.locator('.album-artist-group[data-grp="M"] h2').first().boundingBox();
		const toolbar = await page.locator('.library-list-toolbar:visible').boundingBox();
		return !!heading && !!toolbar && heading.y >= toolbar.y + toolbar.height && heading.y < toolbar.y + toolbar.height + 60;
	}).toBe(true);
	const target = page.locator('.album-artist-group[data-grp="M"] .tile').first();
	const href = await target.getAttribute('href');
	await target.click();
	await expect(page).toHaveURL(new URL(href!, page.url()).href);
	await expect(page.getByTestId('unified-album-tracks')).toBeVisible();
	expect(errors).toEqual([]);
});

test('artist grouping toggles off and clears on alternate sort choices', async ({ page }) => {
	await page.goto('/library/albums');
	await chooseGrouping(page, 'Group by Artist');
	await expect(sections(page)).toHaveCount(400);
	await chooseGrouping(page, 'Group by Artist');
	await expect(sections(page)).toHaveCount(0);
	await expect(page.getByTestId('unified-sort')).toContainText('By artist');
	for (const sort of ['az', 'za', 'shuffle']) {
		await chooseGrouping(page, 'Group by Artist');
		await page.getByTestId('unified-sort').click();
		await page.getByTestId(`unified-sort-option-${sort}`).click();
		await expect(sections(page)).toHaveCount(0);
		expect(await page.evaluate(() => JSON.parse(localStorage.getItem('roon-controller-unified-library-prefs')!).albumGrouping)).toBe('none');
	}
});

test.describe('touch headings', () => {
	test.use({ hasTouch: true, viewport: { width: 820, height: 900 } });
	test('long names stay on one line and read on tap while compound and missing credits remain distinct', async ({ page }, info) => {
		await page.addInitScript(() => {
			window.libraryScrollFixtureVariant = 'album-credits';
			window.libraryScrollFixturePresentation = { interfaceMotion: true };
		});
		await page.goto('/library/albums');
		await page.getByTestId('unified-sort').tap();
		await page.getByRole('button', { name: 'Group by Artist', exact: true }).tap();
		await expect(sections(page)).toHaveCount(5);
		await expect(sections(page).getByRole('heading', { name: 'Unknown album artist', exact: true })).toHaveCount(2);
		const longCredit = await page.evaluate(() => window.libraryScrollFixture.longCredit);
		const longSection = sections(page).filter({ has: page.getByRole('heading', { name: longCredit, exact: true }) });
		await longSection.getByRole('heading').scrollIntoViewIfNeeded();
		const bounds = await longSection.evaluate(section => {
			const heading = section.querySelector('h2')!;
			const rect = heading.getBoundingClientRect();
			return { headingWidth: heading.scrollWidth, width: heading.clientWidth, height: rect.height,
				line: parseFloat(getComputedStyle(heading).lineHeight), bottom: rect.bottom,
				albumTop: section.querySelector('.tile')!.getBoundingClientRect().top };
		});
		expect(bounds.headingWidth).toBeLessThanOrEqual(bounds.width);
		expect(bounds.height).toBeLessThanOrEqual(bounds.line + 23);
		expect(bounds.albumTop).toBeGreaterThanOrEqual(bounds.bottom);
		const button = longSection.getByRole('button', { name: longCredit, exact: true });
		await page.waitForTimeout(200); // A tap which stops recent scroll momentum must not activate.
		await button.tap();
		await expect(button).toHaveAttribute('data-reading', '');
		await page.waitForTimeout(1100);
		expect(await button.locator('span').evaluate(node => new DOMMatrix(getComputedStyle(node).transform).m41)).toBeLessThan(-4);
		expect((await longSection.locator('.tile').first().boundingBox())!.y).toBe(bounds.albumTop);
		await button.tap();
		await expect(button).toHaveAttribute('aria-pressed', 'false');
		await page.screenshot({ path: info.outputPath('albums-grouped-by-artist-touch.png') });
	});
});

test('hover and keyboard read overflowing headings; motion preferences use a static full name', async ({ page }, info) => {
	await page.setViewportSize({ width: 820, height: 900 });
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.addInitScript(() => {
		window.libraryScrollFixtureVariant = 'album-credits';
		window.libraryScrollFixturePresentation = { interfaceMotion: true };
	});
	await page.goto('/library/albums');
	await chooseGrouping(page, 'Group by Artist');
	const longCredit = await page.evaluate(() => window.libraryScrollFixture.longCredit);
	const name = page.getByRole('button', { name: longCredit, exact: true });
	await name.hover();
	await expect(name).toHaveAttribute('data-reading', '');
	await page.waitForTimeout(1100);
	const reading = await name.locator('span').evaluate(node => ({
		x: new DOMMatrix(getComputedStyle(node).transform).m41,
		timing: node.getAnimations()[0].effect!.getTiming(),
		wrap: getComputedStyle(node).whiteSpace
	}));
	expect(reading.x).toBeLessThan(-4);
	expect(reading.timing).toMatchObject({ delay: 700, easing: 'linear' });
	expect(reading.wrap).toBe('nowrap');
	await page.mouse.move(0, 0);
	await expect(name).toHaveAttribute('aria-pressed', 'false');
	await name.focus(); await page.keyboard.press('Enter');
	await expect(name).toHaveAttribute('data-reading', '');
	await page.keyboard.press('Escape');
	await expect(name).toHaveAttribute('aria-pressed', 'false');

	await name.hover();
	await page.evaluate(() => window.libraryScrollFixture.setInterfaceMotion(false));
	await expect(name).not.toHaveAttribute('data-reading');
	await page.mouse.move(0, 0); await name.hover();
	await expect(page.locator('.album-artist-name-popup')).toBeVisible();
	await expect(page.locator('.album-artist-name-popup')).toHaveText(longCredit);
	await page.screenshot({ path: info.outputPath('artist-name-motion-disabled.png') });
	await page.evaluate(() => window.libraryScrollFixture.setInterfaceMotion(true));
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.mouse.move(0, 0); await name.hover();
	await expect(page.locator('.album-artist-name-popup')).toBeVisible();
	await expect(name).not.toHaveAttribute('data-reading');
	await page.getByTestId('unified-scope-artists').click();
	await expect(page.locator('.album-artist-name-popup')).toHaveCount(0);
	await expect(page.locator('[data-reading]')).toHaveCount(0);
});
