import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 900 } });
const rail = (page: Page) => page.getByTestId('unified-rail');
const letter = (page: Page, name: string) => rail(page).getByRole('button', { name, exact: true });
async function openIndex(page: Page, motion = true) {
	await page.addInitScript(motion => {
		window.libraryScrollFixtureSize = { artists: 260, albums: 520 };
		window.libraryScrollFixturePresentation = { interfaceMotion: motion };
	}, motion);
	await page.goto('/fixtures/library-scroll.html');
	await expect(rail(page).getByRole('button')).toHaveCount(27);
	await page.evaluate(() => window.libraryScrollFixture.setPresentation('laser', 'normal'));
}
const scale = (page: Page, name: string) => letter(page, name).locator('.rail-letter').evaluate(node => {
	const transform = getComputedStyle(node).transform;
	return transform === 'none' ? 1 : new DOMMatrix(transform).a;
});
const geometry = (page: Page) => rail(page).evaluate(node => ({
	height: node.clientHeight, scrollHeight: node.scrollHeight, scrollWidth: node.scrollWidth, width: node.clientWidth
}));

test('the entire alphabet fits readable desktop heights and scrolls only in short windows', async ({ page }) => {
	await openIndex(page);
	for (const height of [900, 740]) {
		await page.setViewportSize({ width: 1280, height });
		await expect.poll(async () => { const g = await geometry(page); return g.scrollHeight <= g.height; }).toBe(true);
		const bounds = await rail(page).boundingBox();
		const last = await letter(page, 'Z').boundingBox();
		expect(last!.y + last!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
		expect(await letter(page, 'A').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(22);
	}
	await page.setViewportSize({ width: 1280, height: 460 });
	await expect.poll(async () => { const g = await geometry(page); return g.scrollHeight > g.height; }).toBe(true);
	await letter(page, 'Z').scrollIntoViewIfNeeded();
	await letter(page, 'Z').click();
	await expect(letter(page, 'Z')).toHaveClass(/on/);
	await letter(page, 'A').scrollIntoViewIfNeeded();
	await letter(page, 'A').click();
	await expect(letter(page, 'A')).toHaveClass(/on/);
});

test('Dock magnification tapers through neighbors without shifting the pane, hits or overflow', async ({ page }, info) => {
	await openIndex(page);
	const pane = await page.getByTestId('unified-pane').boundingBox();
	const before = await geometry(page);
	const target = await letter(page, 'M').boundingBox();
	await letter(page, 'M').hover();
	await expect.poll(() => scale(page, 'M')).toBeGreaterThan(1.55);
	const nearby = await scale(page, 'N');
	expect(nearby).toBeGreaterThan(1.2);
	expect(nearby).toBeLessThan(await scale(page, 'M'));
	expect(await scale(page, 'A')).toBe(1);
	expect(await geometry(page)).toEqual(before);
	expect(await letter(page, 'M').boundingBox()).toEqual(target);
	expect(await page.getByTestId('unified-pane').boundingBox()).toEqual(pane);
	await page.screenshot({ path: info.outputPath('laser-magnified.png') });
	await page.mouse.click(target!.x + target!.width / 2, target!.y + target!.height / 2);
	await expect(letter(page, 'M')).toHaveClass(/on/);
	await expect.poll(() => page.getByTestId('unified-pane').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
	await page.mouse.move(pane!.x + 100, pane!.y + 200);
	await expect.poll(() => scale(page, 'M')).toBe(1);
	// End glyphs also have room for their full magnification.
	for (const name of ['#', 'Z']) {
		const button = letter(page, name);
		const b = await button.boundingBox();
		await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2);
		await expect.poll(() => scale(page, name)).toBeGreaterThan(1.55);
		expect(await geometry(page)).toEqual(before);
		const glyph = await button.locator('.rail-letter').boundingBox();
		const r = await rail(page).boundingBox();
		expect(glyph!.y).toBeGreaterThanOrEqual(r!.y);
		expect(glyph!.y + glyph!.height).toBeLessThanOrEqual(r!.y + r!.height);
	}
});

test('reversed sorting, disabled letters and keyboard activation retain their exact targets', async ({ page, browserName }) => {
	await openIndex(page);
	await expect(letter(page, '#')).toBeDisabled();
	const initialScroll = await page.getByTestId('unified-pane').evaluate(node => node.scrollTop);
	await letter(page, '#').evaluate(node => node.click());
	expect(await page.getByTestId('unified-pane').evaluate(node => node.scrollTop)).toBe(initialScroll);
	await letter(page, 'A').focus();
	// macOS WebKit follows Safari's default Option-Tab navigation of controls.
	await page.keyboard.press(browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
	await expect(letter(page, 'B')).toBeFocused();
	await page.keyboard.press('Space');
	await expect(letter(page, 'B')).toHaveClass(/on/);
	await page.getByTestId('unified-sort').click();
	await page.getByRole('button', { name: 'Z to A', exact: true }).click();
	await expect(rail(page).getByRole('button').first()).toHaveText('Z');
	await letter(page, 'M').click();
	await expect(letter(page, 'M')).toHaveClass(/on/);
	await expect.poll(async () => {
		const row = await page.locator('[data-scope-panel="artists"] [data-letter="M"]').first().boundingBox();
		const toolbar = await page.locator('.library-list-toolbar:visible').boundingBox();
		return !!row && !!toolbar && row.y >= toolbar.y + toolbar.height - 1 && row.y < toolbar.y + toolbar.height + 80;
	}).toBe(true);
	await page.getByTestId('unified-scope-albums').click();
	const g = await geometry(page);
	expect(g.scrollHeight).toBeLessThanOrEqual(g.height);
});

for (const preference of ['application', 'operating system'] as const) {
	test(`${preference} reduced motion leaves letters stationary`, async ({ page }) => {
		if (preference === 'operating system') await page.emulateMedia({ reducedMotion: 'reduce' });
		await openIndex(page, preference !== 'application');
		await letter(page, 'M').hover();
		await page.waitForTimeout(200);
		expect(await scale(page, 'M')).toBe(1);
		await expect(rail(page)).not.toHaveAttribute('data-rail-motion', '');
		if (preference === 'operating system') {
			await page.emulateMedia({ reducedMotion: 'no-preference' });
			await page.mouse.move(200, 300);
			await letter(page, 'M').hover();
			await expect.poll(() => scale(page, 'M')).toBeGreaterThan(1.55);
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await expect.poll(() => scale(page, 'M')).toBe(1);
		}
	});
}

test('all additional themes use neutral scrollbar colors distinct from decorative borders', async ({ page }, info) => {
	await openIndex(page);
	for (const theme of ['laser', 'miami', 'pop'] as const) {
		await page.evaluate(theme => window.libraryScrollFixture.setPresentation(theme, 'normal'), theme);
		const colors = await page.evaluate(() => {
			const style = getComputedStyle(document.documentElement);
			const tokens = ['--songr-scrollbar', '--songr-scrollbar-rail', '--songr-queue-scrollbar'];
			return { border: style.getPropertyValue('--songr-theme-line').trim(), thumbs: tokens.map(token => style.getPropertyValue(token).trim()) };
		});
		for (const color of colors.thumbs) expect(color).not.toBe(colors.border);
		const thumb = await rail(page).evaluate(node => getComputedStyle(node, '::-webkit-scrollbar-thumb').backgroundColor);
		const channels = thumb.match(/[\d.]+/g)!.slice(0, 3).map(Number);
		expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(2);
		await page.screenshot({ path: info.outputPath(`${theme}-rail.png`) });
	}
});

test.describe('touch rail', () => {
	test.use({ hasTouch: true });
	test('keeps large touch targets, reachable endpoints and direct taps without hover zoom', async ({ page }) => {
		await openIndex(page);
		expect(await letter(page, 'A').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
		for (const name of ['Z', 'A']) {
			await letter(page, name).scrollIntoViewIfNeeded();
			await letter(page, name).tap();
			await expect(letter(page, name)).toHaveClass(/on/);
			expect(await scale(page, name)).toBe(1);
		}
		await page.evaluate(() => window.libraryScrollFixture.setPresentation('laser', 'compact'));
		const compact = await geometry(page);
		expect(compact.scrollWidth).toBeLessThanOrEqual(compact.width);
		await page.evaluate(() => window.libraryScrollFixture.setPresentation('laser', 'pi'));
		expect(await letter(page, 'A').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
		await letter(page, 'Z').scrollIntoViewIfNeeded();
		await letter(page, 'Z').tap();
		await expect(letter(page, 'Z')).toHaveClass(/on/);
	});

	test('Pi density fits both letter columns without sideways scrolling', async ({ page }) => {
		await openIndex(page);
		await page.evaluate(() => window.libraryScrollFixture.setPresentation('laser', 'pi'));
		for (const height of [650, 900]) {
			await page.setViewportSize({ width: 1024, height });
			await expect.poll(() => rail(page).evaluate(node => {
				const style = getComputedStyle(node);
				return {
					overflow: node.scrollWidth - node.clientWidth,
					horizontalScrollbar: node.offsetHeight - node.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)
				};
			}), `Pi rail at ${height}px`).toEqual({ overflow: 0, horizontalScrollbar: 0 });
			expect(await letter(page, 'A').evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
		}
	});
});
