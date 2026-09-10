import { expect, test, type Page } from '@playwright/test';

const PANE = '[data-testid="unified-pane"]';
const TOOLBAR = '.library-list-toolbar:visible';

async function expectPinned(page: Page) {
	const pane = await page.locator(PANE).boundingBox();
	const scopes = await page.getByRole('navigation', { name: 'Library scope' }).boundingBox();
	const toolbar = await page.locator(TOOLBAR).boundingBox();
	expect(pane).not.toBeNull();
	expect(scopes).not.toBeNull();
	expect(toolbar).not.toBeNull();
	expect(toolbar!.y).toBeGreaterThanOrEqual(scopes!.y + scopes!.height - 1);
	expect(toolbar!.y).toBeLessThanOrEqual(scopes!.y + scopes!.height + 1);
	expect(toolbar!.y + toolbar!.height).toBeLessThan(pane!.y + pane!.height);
	expect(toolbar!.x).toBeGreaterThanOrEqual(pane!.x - 1);
	expect(toolbar!.x + toolbar!.width).toBeLessThanOrEqual(pane!.x + pane!.width + 1);
}

async function deepScroll(page: Page, top = 3000) {
	await page.locator(PANE).evaluate((node, offset) => { node.scrollTop = offset; }, top);
	await expect.poll(() => page.locator(PANE).evaluate(node => node.scrollTop)).toBe(top);
	await expectPinned(page);
}

async function rawClick(page: Page, testId: string) {
	const before = await page.locator(PANE).evaluate(node => node.scrollTop);
	const box = await page.getByTestId(testId).boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
	expect(await page.locator(PANE).evaluate(node => node.scrollTop)).toBe(before);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/fixtures/library-scroll.html');
	await expect(page.getByTestId('unified-row').filter({ visible: true }).first()).toBeVisible();
});

test('root heading and Sort stay pinned below one-row navigation and Touch density', async ({ page }, info) => {
	await deepScroll(page);
	await rawClick(page, 'unified-sort');
	await expect(page.getByTestId('unified-sort')).toHaveAttribute('aria-expanded', 'true');
	await rawClick(page, 'unified-sort-option-za');
	await expect(page.getByTestId('unified-sort')).toContainText('Z to A');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.evaluate(() => window.libraryScrollFixture.setPresentation('dark', 'pi'));
	// Width changes move pages into More; the navigation remains one row.
	// Its measured height must still feed the sticky heading's clearance.
	await expect(page.getByTestId('unified-scope-more')).toBeInViewport();
	await expect.poll(() => page.locator(PANE).evaluate(node => {
		const nav = node.querySelector<HTMLElement>('nav.scopes')!;
		return Math.abs(parseFloat(getComputedStyle(node).getPropertyValue('--library-scopes-height'))
			- nav.getBoundingClientRect().height);
	})).toBeLessThan(1);
	const navigation = await page.getByRole('navigation', { name: 'Library scope' }).evaluate(node => {
		const bounds = node.getBoundingClientRect();
		const buttons = Array.from(node.querySelectorAll<HTMLElement>('.scope-navigation > .sc:not(.scope-measure)'));
		return { count: buttons.length, oneRow: buttons.every(button => {
			const rect = button.getBoundingClientRect();
			return Math.abs(rect.top - buttons[0].getBoundingClientRect().top) <= 1
				&& rect.left >= bounds.left && rect.right <= bounds.right && rect.height >= 44;
		}) };
	});
	expect(navigation.count).toBeGreaterThan(1);
	expect(navigation.oneRow).toBe(true);
	await deepScroll(page);
	await rawClick(page, 'unified-scope-more');
	await expect(page.getByRole('menu', { name: 'More library pages' })).toBeInViewport();
	await expect(page.getByTestId('unified-scope-tracks')).toBeInViewport();
	await page.keyboard.press('Escape');
	await rawClick(page, 'unified-sort');
	await expect(page.getByTestId('unified-sort-option-az')).toBeInViewport();
	await rawClick(page, 'unified-sort-option-az');
	await page.screenshot({ path: info.outputPath('pinned-toolbar-touch.png') });
	await page.getByTestId('unified-scope-albums').click();
	await expect(page.getByTestId('unified-tile').filter({ visible: true }).first()).toBeVisible();
	await deepScroll(page);
	await rawClick(page, 'unified-sort');
	await expect(page.getByTestId('unified-sort-option-shuffle')).toBeInViewport();
});

test('rail jumps and focused rows land below both pinned bars', async ({ page }) => {
	await deepScroll(page);
	await page.getByTestId('unified-rail').getByRole('button', { name: 'M', exact: true }).click();
	const target = page.locator('[data-grp="M"]:visible');
	await expect.poll(async () => {
		const group = await target.boundingBox();
		const toolbar = await page.locator(TOOLBAR).boundingBox();
		return group!.y - (toolbar!.y + toolbar!.height);
	}).toBeGreaterThanOrEqual(8);
	await expectPinned(page);
	// Browser-native focus scrolling must use the same clearance as rail jumps.
	await page.getByTestId('unified-row').filter({ visible: true }).nth(40).focus();
	await expect.poll(async () => {
		const focused = await page.getByTestId('unified-row').filter({ visible: true }).nth(40).boundingBox();
		const toolbar = await page.locator(TOOLBAR).boundingBox();
		return focused!.y - (toolbar!.y + toolbar!.height);
	}).toBeGreaterThanOrEqual(0);
});

test('live collection toolbar takes over from the hidden root toolbar', async ({ page }, info) => {
	await page.getByTestId('unified-scope-genres').click();
	await page.getByTestId('unified-card').first().click();
	await page.getByRole('link', { name: 'More albums' }).click();
	await expect(page.getByTestId('unified-live-album').first()).toBeVisible();
	await deepScroll(page);
	await rawClick(page, 'unified-live-collection-sort');
	await rawClick(page, 'unified-live-collection-sort-option-shuffle');
	await expect(page.getByTestId('unified-live-collection-sort')).toContainText('Shuffle');
	await expectPinned(page);
	await page.screenshot({ path: info.outputPath('pinned-collection-toolbar.png') });
});

test('count-filter heading and Back remain pinned', async ({ page }) => {
	await page.goto('/library/artists?filter=%3E0%20albums');
	await expect(page.getByTestId('unified-filter-artist')).toHaveCount(400);
	await deepScroll(page, 2000);
	await expect(page.getByTestId('unified-filter-summary')).toHaveText('400 ARTISTS');
	const back = (await page.getByTestId('unified-filter-back').boundingBox())!;
	await page.mouse.click(back.x + back.width / 2, back.y + back.height / 2);
	await expect(page.getByTestId('unified-row').filter({ visible: true }).first()).toBeVisible();
});
