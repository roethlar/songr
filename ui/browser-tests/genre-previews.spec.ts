import { expect, test, type Page } from '@playwright/test';

const NEW_TAB = process.platform === 'darwin' ? 'Meta' : 'Control';
async function overview(page: Page, genre: string) {
	await page.goto(`/library/genres/${encodeURIComponent(genre)}`);
	await expect(page.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expect(page.getByTestId('unified-live-collection-title')).toHaveText(genre);
	await expect(page.getByTestId('genre-preview-album').first()).toBeVisible();
}
async function oneRow(page: Page, totalArtists: number, totalAlbums: number) {
	const capacity = await page.getByTestId('genre-overview').evaluate(element => {
		const style = getComputedStyle(element);
		const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		const tile = parseFloat(style.getPropertyValue('--tile')), gap = parseFloat(style.getPropertyValue('--gap'));
		return Math.max(1, Math.floor((width + gap) / (tile + gap)));
	});
	await expect(page.getByTestId('genre-overview')).toHaveAttribute('data-capacity', String(capacity));
	for (const [kind, total] of [['artist', totalArtists], ['album', totalAlbums]] as const) {
		const cards = page.getByTestId(`genre-preview-${kind}`);
		await expect(cards).toHaveCount(Math.min(capacity, total));
		const metrics = await page.getByTestId(`genre-preview-row-${kind}`).evaluate(element => {
			const box = element.getBoundingClientRect();
			return { width: box.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
				gap: parseFloat(getComputedStyle(element).gap), tiles: [...element.children].map(tile => {
					const r = tile.getBoundingClientRect(); return { y: r.y, width: r.width, right: r.right - box.x };
				}) };
		});
		expect(new Set(metrics.tiles.map(tile => Math.round(tile.y))).size).toBe(1);
		expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
		for (const tile of metrics.tiles) {
			expect(tile.right).toBeLessThanOrEqual(metrics.width + 1);
			expect(Math.abs(tile.width - (metrics.width - metrics.gap * (capacity - 1)) / capacity)).toBeLessThan(1);
		}
	}
	return capacity;
}

test('Roon-shaped 80s and singleton Alt. Rock show both rows and full 17/1 More destinations', async ({ page }, info) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	for (const [genre, artists, albums] of [['80s', 4, 17], ['Alt. Rock', 1, 1]] as const) {
		await overview(page, genre); await oneRow(page, artists, albums);
		expect(await page.getByTestId('genre-overview').getByRole('heading', { level: 3 }).allTextContents()).toEqual(['Artists', 'Albums']);
		await expect(page.getByTestId('unified-live-collection-sort')).toHaveCount(0);
		await expect(page.getByTestId('genre-preview-artist').first().locator('.art')).toHaveCSS('border-radius', '50%');
		await expect(page.getByTestId('genre-preview-album').first().locator('.art')).not.toHaveCSS('border-radius', '50%');
		await expect(page.getByTestId('genre-preview-artist').first().getByTestId('genre-preview-placeholder')).toBeVisible();
		const reads = await page.evaluate(() => window.libraryScrollFixture.livePreviewReads);
		expect(reads.map(read => read.ref.token)).toEqual([`section:${genre}:artists`, `section:${genre}:albums`]);
		expect(await page.evaluate(() => window.libraryScrollFixture.liveOpenRefs.map(ref => ref.token))).toEqual([`genre:${genre}`]);
		await page.screenshot({ path: info.outputPath(`${genre === '80s' ? '80s' : 'singleton'}-desktop.png`) });
		await page.getByRole('link', { name: 'More albums' }).click();
		await expect(page.getByTestId('unified-live-album')).toHaveCount(albums);
		await expect(page.getByTestId('unified-live-collection-summary')).toHaveText(`${albums} ALBUMS`);
		expect(await page.evaluate(() => window.libraryScrollFixture.actionExecutions)).toBe(0);
	}
});

test('responsive capacity keeps one physical row at narrow and desktop widths across densities', async ({ page }, info) => {
	await page.setViewportSize({ width: 1440, height: 1000 }); await overview(page, 'Genre 00');
	let capacity = await oneRow(page, 4, 400);
	const initialReads = await page.evaluate(() => window.libraryScrollFixture.livePreviewReads.length);
	await page.setViewportSize({ width: 700, height: 900 });
	const smaller = await oneRow(page, 4, 400); expect(smaller).toBeLessThan(capacity);
	await page.waitForTimeout(200);
	expect(await page.evaluate(() => window.libraryScrollFixture.livePreviewReads.length)).toBe(initialReads);
	await page.screenshot({ path: info.outputPath('narrow-normal.png') });
	await page.setViewportSize({ width: 1440, height: 1000 }); await oneRow(page, 4, 400);
	await page.waitForTimeout(200); expect(await page.evaluate(() => window.libraryScrollFixture.livePreviewReads.length)).toBe(initialReads);
	for (const density of ['compact', 'pi', 'normal'] as const) {
		await page.evaluate(density => window.libraryScrollFixture.setPresentation('dark', density), density);
		capacity = await oneRow(page, 4, 400);
		await expect(page.getByTestId('genre-preview-album')).toHaveCount(capacity);
		await page.screenshot({ path: info.outputPath(`desktop-${density}.png`) });
	}
	// A vertical scroll keeps the genre's parent toolbar below the scope chips.
	await page.setViewportSize({ width: 700, height: 460 }); await oneRow(page, 4, 400);
	await page.getByTestId('unified-pane').evaluate(element => { element.scrollTop = 500; });
	const toolbar = page.locator('.library-list-toolbar:visible');
	await expect.poll(async () => {
		const top = (await toolbar.boundingBox())!;
		const scopes = (await page.getByRole('navigation', { name: 'Library scope' }).boundingBox())!;
		return Math.abs(top.y - scopes.y - scopes.height);
	}).toBeLessThanOrEqual(2);
	await page.getByRole('link', { name: 'Subgenre 00', exact: true }).click();
	await expect(page.getByTestId('unified-live-collection-title')).toHaveText('Subgenre 00');
	await expect(page.getByTestId('genre-preview-artist').first()).toBeVisible();
	await expect(page.getByText(/did not provide an Albums section/)).toBeVisible();
});

for (const kind of ['artist', 'album'] as const) {
	test(`preview ${kind} supports native fresh tabs, reload, owned Back and browser Forward`, async ({ page, context }) => {
		await overview(page, '80s');
		const card = page.getByTestId(`genre-preview-${kind}`).first();
		const href = await card.getAttribute('href');
		const title = await card.locator('.tt').innerText();
		const freshPromise = context.waitForEvent('page'); await card.click({ modifiers: [NEW_TAB] });
		const fresh = await freshPromise;
		await expect(fresh.getByTestId(`unified-${kind === 'artist' ? 'artist-name' : 'album-title'}`)).toHaveText(title);
		await fresh.reload();
		await expect(fresh.getByTestId(`unified-${kind === 'artist' ? 'artist-name' : 'album-title'}`)).toHaveText(title);
		await fresh.getByTestId(`unified-${kind}-back`).click();
		await expect(fresh.getByTestId('unified-live-collection-page')).toHaveAttribute('data-level-kind', 'section');
		await expect(fresh.getByTestId('unified-live-collection-title')).toHaveText(kind === 'artist' ? 'Artists' : 'Albums');
		await fresh.close();
		await expect(page.getByTestId('genre-overview')).toBeVisible();
		await card.click(); await expect.poll(() => new URL(page.url()).pathname).toBe(new URL(href!, page.url()).pathname);
		await page.getByTestId(`unified-${kind}-back`).click(); await expect(page.getByTestId('genre-overview')).toBeVisible();
		await page.goForward(); await expect(page.getByTestId(`unified-${kind === 'artist' ? 'artist-name' : 'album-title'}`)).toHaveText(title);
		await page.goBack(); await expect(page.getByTestId('genre-preview-album').first()).toBeVisible();
	});
}

test('replacement generation reacquires previews and genre Actions can be canceled without execution', async ({ page }) => {
	await overview(page, '80s');
	const { replacement } = await page.evaluate(() => window.libraryScrollFixture.replaceRetiredLibraryGeneration());
	await expect.poll(() => page.evaluate(() => window.libraryScrollFixture.livePreviewReads.at(-1)?.ref.generation)).toBe(replacement);
	await expect(page.getByTestId('genre-preview-album').first()).toBeVisible();
	await page.getByTestId('unified-live-actions').click();
	await expect(page.getByTestId('unified-live-action-choices')).toBeVisible();
	await page.getByTestId('unified-live-action-choices').getByRole('button', { name: 'Cancel' }).click();
	expect(await page.evaluate(() => window.libraryScrollFixture.actionExecutions)).toBe(0);
	await expect(page.getByTestId('genre-overview')).toBeVisible();
});

test('a preview artist keeps genre ancestry through an album and track reload', async ({ page }) => {
	await overview(page, '80s');
	const artist = await page.getByTestId('genre-preview-artist').first().locator('.tt').innerText();
	await page.getByTestId('genre-preview-artist').first().click();
	await expect(page.getByTestId('unified-artist-name')).toHaveText(artist);
	await page.getByTestId('unified-tile').filter({ visible: true }).first().click();
	await page.getByTestId('unified-track-info-1').click();
	await expect(page.getByTestId('unified-album-track-info')).toContainText('Track 02');
	expect(decodeURIComponent(new URL(page.url()).pathname)).toContain('/section;Artists;;/artist;');
	await page.reload();
	await expect(page.getByTestId('unified-album-track-info')).toContainText('Track 02');
	await page.goBack(); await expect(page.getByTestId('unified-album-track-info')).toHaveCount(0);
	await page.goBack(); await expect(page.getByTestId('unified-artist-name')).toHaveText(artist);
	await page.goBack(); await expect(page.getByTestId('genre-overview')).toBeVisible();
});

test('disconnected preview and More clicks leave the overview and address untouched', async ({ page }) => {
	await overview(page, '80s'); const address = page.url();
	const before = await page.evaluate(() => window.libraryScrollFixture.liveOpenRefs.length);
	await page.evaluate(() => window.libraryScrollFixture.fireConnection('disconnect'));
	await page.getByTestId('genre-preview-album').first().click();
	await page.getByRole('link', { name: 'More artists' }).click();
	expect(page.url()).toBe(address);
	await expect(page.getByTestId('genre-overview')).toBeVisible();
	expect(await page.evaluate(() => window.libraryScrollFixture.liveOpenRefs.length)).toBe(before);
	expect(await page.evaluate(() => window.libraryScrollFixture.actionExecutions)).toBe(0);
});
