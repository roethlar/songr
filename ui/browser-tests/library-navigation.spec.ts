import { expect, test } from '@playwright/test';

const NEW_TAB_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

async function expectLiveCollection(
	page: import('@playwright/test').Page,
	kind: string,
	title: string
): Promise<void> {
	const livePage = page.getByTestId('unified-live-collection-page');
	await expect(livePage).toHaveAttribute('data-level-kind', kind);
	await expect(page.getByTestId('unified-live-collection-title')).toHaveText(title);
	await expect(page.getByTestId('unified-drill-label')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/fixtures/library-scroll.html');
	await expect(page.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expect(page.getByTestId('unified-row').filter({ visible: true }).first()).toBeVisible();
});

test('library addresses survive a fresh tab, reload, Back, and Forward', async ({
	page,
	context
}) => {
	const artistLink = page.getByTestId('unified-row').filter({ visible: true }).nth(7);
	const artistName = (await artistLink.locator('.an').innerText()).trim();
	const artistHref = await artistLink.getAttribute('href');
	expect(artistHref).not.toBeNull();

	const freshPagePromise = context.waitForEvent('page');
	await artistLink.click({ modifiers: [NEW_TAB_MODIFIER] });
	const freshPage = await freshPagePromise;
	await expect(freshPage).toHaveURL(new RegExp(`${artistHref!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u'));
	await expect(freshPage.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expect(freshPage.getByTestId('unified-artist-name')).toHaveText(artistName);
	await freshPage.reload();
	await expect(freshPage.getByTestId('unified-artist-name')).toHaveText(artistName);
	await freshPage.close();

	// Modified click stayed native; the original tab is still on the root.
	await expect(page.getByTestId('unified-row').filter({ visible: true }).first()).toBeVisible();
	await artistLink.click();
	await expect.poll(() => new URL(page.url()).pathname).toBe(new URL(artistHref!, page.url()).pathname);
	await expect(page.getByTestId('unified-artist-name')).toHaveText(artistName);

	const albumLink = page.getByTestId('unified-tile').filter({ visible: true }).first();
	const albumTitle = (await albumLink.locator('.tt').innerText()).trim();
	const albumHref = await albumLink.getAttribute('href');
	expect(albumHref).not.toBeNull();
	await albumLink.click();
	await expect.poll(() => new URL(page.url()).pathname).toBe(new URL(albumHref!, page.url()).pathname);
	await expect(page.getByTestId('unified-album-title')).toHaveText(albumTitle);

	await expect(page.getByTestId('unified-album-tracks')).toContainText('Track 02');
	await page.goBack();
	await expect(page.getByTestId('unified-artist-name')).toHaveText(artistName);

	await page.goForward();
	await expect(page.getByTestId('unified-album-title')).toHaveText(albumTitle);
	await page.reload();
	await expect(page.getByTestId('unified-album-tracks')).toContainText('Track 02');

});

test('Albums-root links survive a modified-click fresh tab and reload', async ({ page, context }) => {
	await page.getByTestId('unified-scope-albums').click();
	const albumLink = page.getByTestId('unified-tile').filter({ visible: true }).nth(9);
	const albumTitle = (await albumLink.locator('.tt').innerText()).trim();
	const albumHref = await albumLink.getAttribute('href');
	expect(albumHref).not.toBeNull();

	const freshPagePromise = context.waitForEvent('page');
	await albumLink.click({ modifiers: [NEW_TAB_MODIFIER] });
	const freshPage = await freshPagePromise;
	await expect(freshPage.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expect(freshPage).toHaveURL(
		new RegExp(`${albumHref!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u')
	);
	await expect(freshPage.getByTestId('unified-album-title')).toHaveText(albumTitle);
	await freshPage.reload();
	await expect(freshPage.getByTestId('unified-album-title')).toHaveText(albumTitle);
	await freshPage.close();

	await expect(page.getByTestId('unified-scope-view').filter({ visible: true })).toHaveAttribute('data-scope', 'albums');
});

test('genre live hierarchy keeps one renderer through sections, subgenre, artist, and album history', async ({
	page,
	context
}) => {
	await page.getByTestId('unified-scope-genres').click();
	const genreLink = page.getByTestId('unified-card').first();
	const genreHref = await genreLink.getAttribute('href');
	expect(genreHref).not.toBeNull();

	const freshPagePromise = context.waitForEvent('page');
	await genreLink.click({ modifiers: [NEW_TAB_MODIFIER] });
	const freshPage = await freshPagePromise;
	await expect(freshPage.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expectLiveCollection(freshPage, 'genre', 'Genre 00');
	await freshPage.reload();
	await expectLiveCollection(freshPage, 'genre', 'Genre 00');
	await freshPage.close();

	await genreLink.click();
	await expectLiveCollection(page, 'genre', 'Genre 00');
	await page.reload();
	await expectLiveCollection(page, 'genre', 'Genre 00');

	await page.goBack();
	await expect(page.getByTestId('unified-card').first()).toBeVisible();
	await page.goForward();
	await expectLiveCollection(page, 'genre', 'Genre 00');

	const albumSectionLink = page.getByRole('link', { name: 'More albums' });
	const albumSectionPagePromise = context.waitForEvent('page');
	await albumSectionLink.click({ modifiers: [NEW_TAB_MODIFIER] });
	const albumSectionPage = await albumSectionPagePromise;
	await expect(albumSectionPage.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expectLiveCollection(albumSectionPage, 'section', 'Albums');
	await albumSectionPage.reload();
	await expectLiveCollection(albumSectionPage, 'section', 'Albums');
	await albumSectionPage.close();

	await albumSectionLink.click();
	await expectLiveCollection(page, 'section', 'Albums');
	await expect(page.getByTestId('unified-live-collection-summary')).toHaveText('400 ALBUMS');
	await expect(page.getByTestId('unified-rail')).toBeVisible();
	await page.getByTestId('unified-live-collection-sort').click();
	await page.getByTestId('unified-live-collection-sort-option-shuffle').click();
	await expect(page.getByTestId('unified-rail')).toHaveCount(0);
	await page.getByTestId('unified-live-collection-sort').click();
	await page.getByTestId('unified-live-collection-sort-option-az').click();
	await expect(page.getByTestId('unified-rail')).toBeVisible();

	const albumLink = page.getByTestId('unified-live-album').first();
	const albumTitle = (await albumLink.locator('.tt').innerText()).trim();
	await albumLink.click();
	await expect(page.getByTestId('unified-album-title')).toHaveText(albumTitle);
	await page.goBack();
	await expectLiveCollection(page, 'section', 'Albums');
	await page.goForward();
	await expect(page.getByTestId('unified-album-title')).toHaveText(albumTitle);
	await page.goBack();

	await page.getByRole('button', { name: '← Genres' }).click();
	await expectLiveCollection(page, 'genre', 'Genre 00');
	const subgenreLink = page.getByRole('link', { name: 'Subgenre 00', exact: true });
	const subgenrePagePromise = context.waitForEvent('page');
	await subgenreLink.click({ modifiers: [NEW_TAB_MODIFIER] });
	const subgenrePage = await subgenrePagePromise;
	await expect(subgenrePage.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expectLiveCollection(subgenrePage, 'genre', 'Subgenre 00');
	await subgenrePage.reload();
	await expectLiveCollection(subgenrePage, 'genre', 'Subgenre 00');
	await subgenrePage.close();

	await subgenreLink.click();
	await expectLiveCollection(page, 'genre', 'Subgenre 00');
	await page.goBack();
	await expectLiveCollection(page, 'genre', 'Genre 00');
	await page.goForward();
	await expectLiveCollection(page, 'genre', 'Subgenre 00');

	const artistSectionLink = page.getByRole('link', { name: 'More artists' });
	const artistSectionPagePromise = context.waitForEvent('page');
	await artistSectionLink.click({ modifiers: [NEW_TAB_MODIFIER] });
	const artistSectionPage = await artistSectionPagePromise;
	await expect(artistSectionPage.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expectLiveCollection(artistSectionPage, 'section', 'Artists');
	await artistSectionPage.reload();
	await expectLiveCollection(artistSectionPage, 'section', 'Artists');
	await artistSectionPage.close();

	await artistSectionLink.click();
	await expectLiveCollection(page, 'section', 'Artists');
	const artistLink = page.getByTestId('unified-live-artist-0');
	const artistName = (await artistLink.locator('.an').innerText()).trim();
	const artistPagePromise = context.waitForEvent('page');
	await artistLink.click({ modifiers: [NEW_TAB_MODIFIER] });
	const artistPage = await artistPagePromise;
	await expect(artistPage.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expect(artistPage.getByTestId('unified-artist-name')).toHaveText(artistName);
	await artistPage.reload();
	await expect(artistPage.getByTestId('unified-artist-name')).toHaveText(artistName);
	await artistPage.close();

	await artistLink.click();
	await expect(page.getByTestId('unified-artist-name')).toHaveText(artistName);
	await page.reload();
	await expect(page.getByTestId('unified-artist-name')).toHaveText(artistName);
	await page.goBack();
	await expectLiveCollection(page, 'section', 'Artists');
	await page.goForward();
	await expect(page.getByTestId('unified-artist-name')).toHaveText(artistName);
});

test('palette composer keeps live composition and recording addresses and cancels actions read-only', async ({
	page,
	context
}) => {
	await page.getByTestId('unified-find').click();
	await page.getByTestId('unified-palette-input').fill('philip glass');
	const composerText = page.getByText('Composer: Philip Glass');
	const composerLink = composerText.locator('xpath=ancestor::*[self::a or self::button][1]');
	await expect(composerLink).toBeVisible();

	await composerLink.click();
	await expectLiveCollection(page, 'composer', 'Philip Glass');
	// Palette results are buttons, so the deterministic SvelteKit stub has no
	// native modified-click. Open the exact durable address it produced in a
	// fresh tab; the component suite separately pins the shallow write itself.
	const composerUrl = new URL('/library/composers/Philip%20Glass', page.url()).href;
	const freshPage = await context.newPage();
	await freshPage.goto(composerUrl);
	await expect(freshPage.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expectLiveCollection(freshPage, 'composer', 'Philip Glass');
	await freshPage.reload();
	await expectLiveCollection(freshPage, 'composer', 'Philip Glass');
	await freshPage.close();

	await page.getByTestId('unified-live-actions').click();
	const choices = page.getByTestId('unified-live-action-choices');
	await expect(choices).toBeVisible();
	await choices.getByRole('button', { name: 'Cancel' }).click();
	await expect(choices).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => window.libraryScrollFixture.actionExecutions))
		.toBe(0);

	const compositionLink = page.getByTestId('unified-live-composition-0');
	const compositionPagePromise = context.waitForEvent('page');
	await compositionLink.click({ modifiers: [NEW_TAB_MODIFIER] });
	const compositionPage = await compositionPagePromise;
	await expect(compositionPage.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expectLiveCollection(compositionPage, 'composition', 'Glassworks');
	await compositionPage.close();

	await compositionLink.click();
	await expectLiveCollection(page, 'composition', 'Glassworks');
	await page.reload();
	await expectLiveCollection(page, 'composition', 'Glassworks');
	const recordingLink = page.getByTestId('unified-live-recording-0');
	const recordingHref = await recordingLink.getAttribute('href');
	expect(recordingHref).not.toBeNull();
	await recordingLink.click();
	await expect.poll(() => new URL(page.url()).pathname).toBe(
		new URL(recordingHref!, page.url()).pathname
	);
	await expectLiveCollection(page, 'track', 'Opening');
	await page.reload();
	await expectLiveCollection(page, 'track', 'Opening');
	await page.goBack();
	await expectLiveCollection(page, 'composition', 'Glassworks');
	await page.goForward();
	await expectLiveCollection(page, 'track', 'Opening');
	await page.goBack();
	await expectLiveCollection(page, 'composition', 'Glassworks');
	await page
		.getByTestId('unified-live-collection-page')
		.getByRole('button', { name: /^←/u })
		.click();
	await expectLiveCollection(page, 'composer', 'Philip Glass');
	await page
		.getByTestId('unified-live-collection-page')
		.getByRole('button', { name: '← Library' })
		.click();
	await expect(page.getByTestId('unified-live-collection-page')).toHaveCount(0);
	await expect(page.getByTestId('unified-pane')).toHaveAttribute('data-scope', 'browse');
	await expect(page.getByTestId('unified-scope-browse')).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => window.libraryScrollFixture.actionExecutions))
		.toBe(0);
});
