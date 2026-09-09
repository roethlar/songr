import { expect, test, type Locator, type Page } from '@playwright/test';

const PANE = '[data-testid="unified-pane"]';
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const mode = (page: Page, view: string) => page.getByTestId(`unified-artist-view-${view}`);
const group = (page: Page, label: string) => page.getByTestId('unified-credit-artist').filter({ visible: true })
	.filter({ has: page.getByText(label, { exact: true }) });
let errors: string[];
let apiRequests: string[];

test.beforeEach(({ page, context }) => {
	errors = [];
	apiRequests = [];
	const watch = (view: Page) => view.on('pageerror', error => errors.push(error.message));
	watch(page);
	context.on('page', watch);
	context.on('request', request => {
		if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
	});
});
test.afterEach(async ({ context }) => {
	for (const view of context.pages()) {
		expect(await view.evaluate(() => window.libraryScrollFixture?.actionExecutions ?? 0)).toBe(0);
	}
	expect(errors).toEqual([]);
	expect(apiRequests).toEqual([]);
});

async function scroll(page: Page, top: number) {
	await page.locator(PANE).evaluate((pane, offset) => { pane.scrollTop = offset; }, top);
	await expect.poll(() => page.locator(PANE).evaluate(pane => pane.scrollTop)).toBe(top);
}

async function pinnedClick(page: Page, control: Locator) {
	const top = await page.locator(PANE).evaluate(pane => pane.scrollTop);
	const scopes = (await page.getByRole('navigation', { name: 'Library scope' }).boundingBox())!;
	const toolbar = (await page.locator('.library-list-toolbar:visible').boundingBox())!;
	const box = (await control.boundingBox())!;
	expect(toolbar.y).toBeCloseTo(scopes.y + scopes.height, 0);
	expect(box.y).toBeGreaterThanOrEqual(toolbar.y);
	expect(box.y + box.height).toBeLessThanOrEqual(toolbar.y + toolbar.height);
	expect(await page.locator(PANE).evaluate(pane => pane.scrollTop)).toBe(top);
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function expectRailClearance(page: Page) {
	await expect.poll(async () => {
		const target = (await page.locator('[data-grp="M"]:visible').boundingBox())!;
		const bar = (await page.locator('.library-list-toolbar:visible').boundingBox())!;
		const gap = target.y - bar.y - bar.height;
		return gap >= 0 && gap <= 32;
	}).toBe(true);
}

test('default, remembered and explicit views coexist; the pinned switch keeps separate scroll positions', async ({ page, context }, info) => {
	await page.goto('/library');
	await expect(page).toHaveURL(/\/library\/album-artists$/);
	await expect(page.getByTestId('unified-credit-artist').filter({ visible: true })).toHaveCount(400);
	await expect(mode(page, 'album-artists')).toHaveAttribute('aria-pressed', 'true');
	await scroll(page, 3000);
	await pinnedClick(page, mode(page, 'all-artists'));
	await expect(page.getByTestId('unified-row').filter({ visible: true })).toHaveCount(400);
	await scroll(page, 2500);
	await pinnedClick(page, mode(page, 'album-artists'));
	await expect.poll(() => page.locator(PANE).evaluate(pane => pane.scrollTop)).toBe(3000);
	await page.screenshot({ path: info.outputPath('album-artist-switch-desktop.png') });
	await pinnedClick(page, mode(page, 'all-artists'));
	await expect.poll(() => page.locator(PANE).evaluate(pane => pane.scrollTop)).toBe(2500);

	const other = await context.newPage();
	await other.goto('/library');
	await expect(other).toHaveURL(/\/library\/artists$/);
	await other.goto('/library/album-artists');
	await expect(mode(other, 'album-artists')).toHaveAttribute('aria-pressed', 'true');
	await mode(other, 'all-artists').click();
	await mode(other, 'album-artists').click();
	await expect(mode(page, 'all-artists')).toHaveAttribute('aria-pressed', 'true');
	await expect(page).toHaveURL(/\/library\/artists$/);
	await page.reload();
	await expect(mode(page, 'all-artists')).toHaveAttribute('aria-pressed', 'true');
	await page.goto('/library');
	await expect(page).toHaveURL(/\/library\/album-artists$/);
	const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('roon-controller-unified-library-prefs')!));
	expect(Object.keys(saved).sort()).toEqual(['artistView', 'density', 'sorts', 'version']);
	await other.close();
});

test.describe('exact credit pages', () => {
	test.beforeEach(async ({ context }) => {
		await context.addInitScript(() => { window.libraryScrollFixtureVariant = 'album-credits'; });
	});

	async function composerExcursion(page: Page) {
		await page.getByTestId('unified-find').click();
		await page.getByTestId('unified-palette-input').fill('philip glass');
		await page.getByRole('button').filter({ hasText: 'Composer: Philip Glass' }).click();
		await expect(page.getByTestId('unified-live-collection-page')).toHaveAttribute('data-level-kind', 'composer');
		await page.getByRole('button', { name: '← Search results' }).click();
		await expect(page.getByTestId('unified-palette-input')).toHaveValue('philip glass');
		await expect(page.getByRole('button').filter({ hasText: 'Composer: Philip Glass' })).toHaveClass(/sel/);
	}

	for (const origin of [
		{ path: '/library/album-artists', title: null, count: 5 },
		{ path: '/library/album-artists/credit/Single%20Release', title: 'Single Release', count: 1 },
		{ path: '/library/album-artists/uncredited', title: 'Unknown album artist', count: 1 }
	]) {
		test(`palette return preserves the addressed list ${origin.path}`, async ({ page }) => {
			await page.goto(origin.path);
			const address = page.url();
			for (const dismiss of ['escape', 'chord']) {
				await composerExcursion(page);
				await page.keyboard.press(dismiss === 'escape' ? 'Escape' : `${modifier}+k`);
				await expect(page.getByTestId('unified-palette')).toHaveCount(0);
				await expect(page).toHaveURL(address);
				await expect(page.getByTestId(origin.title ? 'unified-tile' : 'unified-credit-artist').filter({ visible: true })).toHaveCount(origin.count);
				if (origin.title) await expect(page.getByTestId('unified-list-heading')).toHaveText(origin.title);
				else await expect(mode(page, 'album-artists')).toHaveAttribute('aria-pressed', 'true');
				await expect(page.getByTestId('unified-row').filter({ visible: true })).toHaveCount(0);
			}
			await page.reload();
			await expect(page.getByTestId(origin.title ? 'unified-tile' : 'unified-credit-artist').filter({ visible: true })).toHaveCount(origin.count);
			if (origin.title) {
				await page.getByTestId('unified-credit-back').click();
				await expect(page).toHaveURL(/\/library\/album-artists$/);
			}
		});
	}

	test('palette return preserves a long group scroll and its owned Back entry', async ({ page }) => {
		await page.goto('/library/album-artists');
		await group(page, await page.evaluate(() => window.libraryScrollFixture.longCredit)).click();
		const address = page.url();
		await scroll(page, 3000);
		await composerExcursion(page);
		await page.keyboard.press('Escape');
		await expect(page).toHaveURL(address);
		await expect.poll(() => page.locator(PANE).evaluate(pane => pane.scrollTop)).toBe(3000);
		await expect(page.getByTestId('unified-sort')).toBeInViewport();
		await page.getByTestId('unified-credit-back').click();
		await expect(page).toHaveURL(/\/library\/album-artists$/);
		await expect(page.getByTestId('unified-credit-artist').filter({ visible: true })).toHaveCount(5);
	});

	test('navigation away during a palette excursion cannot restore its abandoned group', async ({ page }) => {
		await page.goto('/library/album-artists/credit/Single%20Release');
		await page.getByTestId('unified-find').click();
		await page.getByTestId('unified-palette-input').fill('philip glass');
		await page.getByRole('button').filter({ hasText: 'Composer: Philip Glass' }).click();
		await expect(page.getByRole('button', { name: '← Search results' })).toBeVisible();
		await page.getByTestId('unified-scope-albums').click();
		await expect(page).toHaveURL(/\/library\/albums$/);
		await page.getByTestId('unified-find').click();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('unified-tile').filter({ visible: true })).toHaveCount(400);
		await expect(page).toHaveURL(/\/library\/albums$/);
		await page.goBack();
		await expect(page.getByTestId('unified-list-heading')).toHaveText('Single Release');
		await expect(page.getByTestId('unified-tile').filter({ visible: true })).toHaveCount(1);
	});

	test('a changed album credit invalidates the addressed album instead of reassigning it', async ({ page }) => {
		await page.goto('/library');
		await group(page, 'Single Release').click();
		await page.getByTestId('unified-tile').filter({ visible: true }).click();
		await expect(page.getByTestId('unified-album-tracks')).toBeVisible();
		const address = page.url();
		await page.evaluate(() => window.libraryScrollFixture.replaceAlbumCredit('Single Release', 'Changed credit'));
		await expect(page.getByTestId('unified-album-error')).toBeVisible();
		await expect(page.getByTestId('unified-album-tracks')).toHaveCount(0);
		await expect(page).toHaveURL(address);
		await page.getByTestId('unified-album-back').click();
		await expect(page.getByTestId('unified-credit-missing')).toBeVisible();
	});

	test('group → album → track survives native new tabs, reload, parent traversal and browser history', async ({ page, context }) => {
		await page.goto('/library');
		await expect(page.getByTestId('unified-credit-artist').filter({ visible: true })).toHaveCount(5);
		await expect(group(page, 'Single Release').locator('.ac')).toHaveText('1');
		const creditLink = group(page, 'AC/DC / Björk; 100%');
		const groupHref = (await creditLink.getAttribute('href'))!;
		const opened = context.waitForEvent('page');
		await creditLink.click({ modifiers: [modifier] });
		const fresh = await opened;
		await expect(fresh.getByTestId('unified-list-heading')).toHaveText('AC/DC / Björk; 100%');
		await fresh.reload();
		await expect(fresh.getByTestId('unified-tile').filter({ visible: true })).toHaveCount(1);
		await fresh.getByTestId('unified-credit-back').click();
		await expect(fresh).toHaveURL(/\/library\/album-artists$/);
		await fresh.close();

		await creditLink.click();
		const albumLink = page.getByTestId('unified-tile').filter({ visible: true });
		const albumHref = (await albumLink.getAttribute('href'))!;
		const albumOpened = context.waitForEvent('page');
		await albumLink.click({ modifiers: [modifier] });
		const albumTab = await albumOpened;
		await expect(albumTab.getByTestId('unified-album-title')).toHaveText('Collaboration; One');
		await albumTab.reload();
		await expect(albumTab.getByTestId('unified-track-info-1')).toBeVisible();
		await albumTab.getByTestId('unified-album-back').click();
		await expect.poll(() => new URL(albumTab.url()).pathname).toBe(groupHref);
		await albumTab.close();

		await albumLink.click();
		await expect(page.getByTestId('unified-album-tracks')).toBeVisible();
		await page.getByTestId('unified-album-play').click();
		await expect(page.getByTestId('unified-album-action-choices')).toBeVisible();
		await page.getByTestId('unified-album-action-choices').getByRole('button', { name: 'Cancel' }).click();
		await expect.poll(() => new URL(page.url()).pathname).toBe(albumHref);
		const trackLink = page.getByTestId('unified-track-info-1');
		const trackHref = (await trackLink.getAttribute('href'))!;
		const trackOpened = context.waitForEvent('page');
		await trackLink.click({ modifiers: [modifier] });
		const trackTab = await trackOpened;
		await expect(trackTab.getByTestId('unified-album-track-info')).toContainText('Track 02');
		await trackTab.reload();
		await expect(trackTab.getByTestId('unified-album-track-info')).toContainText('Track 02');
		await trackTab.getByTestId('unified-album-track-info-back').click();
		await expect.poll(() => new URL(trackTab.url()).pathname).toBe(albumHref);
		await trackTab.getByTestId('unified-album-back').click();
		await expect.poll(() => new URL(trackTab.url()).pathname).toBe(groupHref);
		await trackTab.getByTestId('unified-credit-back').click();
		await expect(trackTab).toHaveURL(/\/library\/album-artists$/);
		await trackTab.close();

		await trackLink.click();
		await expect.poll(() => new URL(page.url()).pathname).toBe(trackHref);
		await page.goBack();
		await expect(page.getByTestId('unified-album-track-info')).toHaveCount(0);
		await page.goBack();
		await expect(page.getByTestId('unified-list-heading')).toHaveText('AC/DC / Björk; 100%');
		await page.goForward();
		await page.goForward();
		await expect(page.getByTestId('unified-album-track-info')).toContainText('Track 02');
		await page.reload();
		await expect(page.getByTestId('unified-album-track-info')).toContainText('Track 02');
		expect(await page.evaluate(() => window.libraryScrollFixture.liveOpenRefs.every(ref => !ref.token.startsWith('artist:')))).toBe(true);
	});

	test('a long group keeps its toolbar, Sort and rail accessible after resize and density changes', async ({ page }, info) => {
		await page.goto('/library');
		const credit = await page.evaluate(() => window.libraryScrollFixture.longCredit);
		await group(page, credit).click();
		await expect(page.getByTestId('unified-summary')).toHaveText('396 ALBUMS');
		await scroll(page, 3000);
		await pinnedClick(page, page.getByTestId('unified-sort'));
		await page.getByTestId('unified-sort-option-shuffle').click();
		await expect(page.getByTestId('unified-sort')).toContainText('Shuffle');
		await page.setViewportSize({ width: 390, height: 844 });
		await page.evaluate(() => window.libraryScrollFixture.setPresentation('dark', 'pi'));
		await scroll(page, 3000);
		await expect.poll(() => page.locator(PANE).evaluate(pane => parseFloat(getComputedStyle(pane).getPropertyValue('--library-toolbar-height')))).toBeGreaterThan(100);
		await pinnedClick(page, page.getByTestId('unified-sort'));
		await page.getByTestId('unified-sort-option-az').click();
		await page.screenshot({ path: info.outputPath('album-credit-toolbar-touch.png') });
		// The existing phone layout deliberately hides the rail at 520px and below.
		await page.setViewportSize({ width: 800, height: 844 });
		await page.getByTestId('unified-rail').getByRole('button', { name: 'M', exact: true }).click();
		await expectRailClearance(page);
		await page.screenshot({ path: info.outputPath('album-credit-rail-touch.png') });
	});

	test('replacement generations, missing credits and duplicate renderings retain their actual authority', async ({ page }) => {
		await page.goto('/library');
		const credit = await page.evaluate(() => window.libraryScrollFixture.longCredit);
		await group(page, credit).click();
		await page.evaluate(() => window.libraryScrollFixture.replaceRetiredLibraryGeneration());
		const duplicate = page.getByTestId('unified-tile').filter({ visible: true }).filter({ hasText: 'Repeated Rendering' });
		await expect(duplicate).toHaveCount(2);
		await duplicate.nth(1).click();
		await expect(page.getByTestId('unified-album-title')).toHaveText('Repeated Rendering');
		expect(await page.evaluate(() => window.libraryScrollFixture.liveOpenRefs.at(-1))).toEqual({
			generation: 'fixture-gen-2', token: 'album:Repeated Rendering:copy:399'
		});
		await page.reload();
		await expect(page.getByTestId('unified-library-group-page')).toBeVisible();
		const candidates = page.getByTestId(/^unified-library-group-candidate-\d+$/);
		await expect(candidates).toHaveCount(2);
		await candidates.nth(1).click();
		await expect(page.getByTestId('unified-album-title')).toHaveText('Repeated Rendering');
		await page.getByTestId('unified-album-back').click();
		await expect(page.getByTestId('unified-list-heading')).toHaveText(credit);
		await page.evaluate(held => window.libraryScrollFixture.replaceAlbumCredit(held, 'Changed credit'), credit);
		await expect(page.getByTestId('unified-credit-missing')).toBeVisible();
		await expect(page.getByTestId('unified-list-heading')).toHaveText(credit);
		expect(await page.evaluate(() => window.libraryScrollFixture.liveOpenRefs.some(ref => ref.token.startsWith('artist:')))).toBe(false);
	});
});

test.describe('cold credit deep links', () => {
	const groupPath = '/library/album-artists/credit/Single%20Release';
	const albumPath = `${groupPath}/album/Solo%20Record;Single%20Release;`;
	const trackPath = `${albumPath}/track/Track%2002`;
	test.beforeEach(async ({ context }) => {
		await context.addInitScript(() => {
			window.libraryScrollFixtureVariant = 'album-credits';
			window.libraryScrollFixtureColdStart = true;
		});
	});

	async function coldReady(page: Page) {
		await expect(page.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
		expect(await page.evaluate(() => window.libraryScrollFixture.socketConnected)).toBe(false);
		expect(await page.evaluate(() => window.libraryScrollFixture.liveOpenRefs)).toEqual([]);
		await expect(page.getByTestId('unified-album-back')).toBeVisible();
	}

	for (const track of [false, true]) {
		test(`${track ? 'track' : 'album'} address survives cold start and reload`, async ({ page }) => {
			const path = track ? trackPath : albumPath;
			await page.goto(path);
			for (const rootsFirst of [false, true]) {
				await coldReady(page);
				if (!rootsFirst) await page.evaluate(() => window.libraryScrollFixture.fireConnection('connect'));
				await page.evaluate(() => window.libraryScrollFixture.publishInitialRoots());
				await expect(page.getByTestId('unified-album-tracks')).toBeVisible();
				await expect(page.getByTestId('unified-album-title')).toHaveText('Solo Record');
				if (track) await expect(page.getByTestId('unified-album-track-info')).toContainText('Track 02');
				await page.evaluate(() => window.libraryScrollFixture.fireConnection('connect'));
				await page.evaluate(() => window.libraryScrollFixture.publishInitialRoots());
				await expect.poll(() => page.evaluate(() => window.libraryScrollFixture.liveOpenRefs)).toEqual([
					{ generation: 'fixture-gen-1', token: 'album:Solo Record' }
				]);
				await expect.poll(() => new URL(page.url()).pathname).toBe(path);
				if (!rootsFirst) await page.reload();
			}
			if (track) {
				await page.getByTestId('unified-album-track-info-back').click();
				await expect.poll(() => new URL(page.url()).pathname).toBe(albumPath);
			}
			await page.getByTestId('unified-album-back').click();
			await expect.poll(() => new URL(page.url()).pathname).toBe(groupPath);
			await expect(page.getByTestId('unified-list-heading')).toHaveText('Single Release');
		});
	}

	test('leaving an unresolved album cancels it before roots and connection arrive', async ({ page }) => {
		await page.goto(trackPath);
		await coldReady(page);
		await page.getByTestId('unified-scope-albums').click();
		await expect(page).toHaveURL(/\/library\/albums$/);
		await page.evaluate(() => window.libraryScrollFixture.fireConnection('connect'));
		await page.evaluate(() => window.libraryScrollFixture.publishInitialRoots());
		await expect(page.getByTestId('unified-tile').filter({ visible: true })).toHaveCount(400);
		await expect(page.getByTestId('unified-album-tracks')).toHaveCount(0);
		await expect(page.getByTestId('unified-album-track-info')).toHaveCount(0);
		expect(await page.evaluate(() => window.libraryScrollFixture.liveOpenRefs)).toEqual([]);
		await expect(page).toHaveURL(/\/library\/albums$/);
	});
});

test('album-credit root rail, focused rows and the narrow switch reserve pinned clearance', async ({ page }, info) => {
	await page.goto('/library');
	await expect(page.getByTestId('unified-credit-artist').filter({ visible: true })).toHaveCount(400);
	await page.getByTestId('unified-rail').getByRole('button', { name: 'M', exact: true }).click();
	await expectRailClearance(page);
	const row = page.getByTestId('unified-credit-artist').filter({ visible: true }).nth(40);
	await row.evaluate(element => element.focus());
	await expect.poll(async () => {
		const target = (await row.boundingBox())!;
		const bar = (await page.locator('.library-list-toolbar:visible').boundingBox())!;
		return target.y - bar.y - bar.height;
	}).toBeGreaterThanOrEqual(0);
	await expect(row).toBeInViewport();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.evaluate(() => window.libraryScrollFixture.setPresentation('dark', 'pi'));
	await scroll(page, 3000);
	await pinnedClick(page, mode(page, 'all-artists'));
	await expect(mode(page, 'all-artists')).toHaveAttribute('aria-pressed', 'true');
	await scroll(page, 2500);
	await pinnedClick(page, mode(page, 'album-artists'));
	expect(await page.locator(PANE).evaluate(pane => pane.scrollWidth <= pane.clientWidth)).toBe(true);
	await expect(mode(page, 'album-artists')).toBeInViewport();
	await expect(mode(page, 'all-artists')).toBeInViewport();
	await page.screenshot({ path: info.outputPath('album-artist-switch-touch.png') });
});
