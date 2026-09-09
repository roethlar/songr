import { expect, test, type Page } from '@playwright/test';

const ALBUMS = 3000;
const PANEL = '[data-scope-panel="albums"]';
const GRID = `${PANEL} .tiles`;
const TILES = `${PANEL} [data-testid="unified-tile"]`;
const PANE = '[data-testid="unified-pane"]';

async function openAlbums(page: Page, sort: 'az' | 'shuffle') {
	await page.addInitScript(({ albums, sort }) => {
		window.libraryScrollFixtureSize = { artists: 100, albums };
		window.libraryScrollFixturePresentation = {
			singleLetter: true, longTitles: true, albumsSort: sort
		};
	}, { albums: ALBUMS, sort });
	await page.goto('/fixtures/library-scroll.html');
	await expect(page.getByTestId('unified-row').filter({ visible: true }).first()).toBeVisible();
	await page.getByTestId('unified-scope-albums').click();
	await expect(page.locator(TILES)).toHaveCount(ALBUMS);
	await expect(page.locator(TILES).first()).toBeVisible();
	await expect.poll(() => page.locator(GRID).evaluate(grid =>
		grid.shadowRoot?.querySelectorAll('[data-prepared-library-chunk]').length ?? 0
	)).toBeGreaterThan(2);
}

async function expectStableDistantScroll(page: Page) {
	const result = await page.locator(GRID).evaluate(async grid => {
		const pane = document.querySelector<HTMLElement>('[data-testid="unified-pane"]')!;
		const originals = [...grid.querySelectorAll('[data-testid="unified-tile"]')];
		const chunks = [...grid.shadowRoot!.querySelectorAll<HTMLElement>('[data-prepared-library-chunk]')];
		// Read the containers only: probing the distant tiles here would force
		// their layout and could accidentally repair an unprepared list.
		const intrinsic = chunks.map(chunk => chunk.style.containIntrinsicBlockSize);
		const before = { pane: pane.scrollHeight, grid: grid.getBoundingClientRect().height };
		let added = 0, removed = 0, attributes = 0;
		const observer = new MutationObserver(records => {
			for (const record of records) {
				added += record.addedNodes.length;
				removed += record.removedNodes.length;
				if (record.type === 'attributes') attributes++;
			}
		});
		observer.observe(grid, { childList: true, subtree: true, attributes: true });
		observer.observe(grid.shadowRoot!, { childList: true, subtree: true, attributes: true });
		const positions: Array<{ pane: number; grid: number; reached: boolean }> = [];
		for (const fraction of [1, 0, 0.5, 1, 0]) {
			const target = (pane.scrollHeight - pane.clientHeight) * fraction;
			pane.scrollTo({ top: target, behavior: 'instant' });
			await new Promise(requestAnimationFrame);
			await new Promise(requestAnimationFrame);
			positions.push({ pane: pane.scrollHeight, grid: grid.getBoundingClientRect().height,
				reached: Math.abs(pane.scrollTop - target) <= 1 });
		}
		observer.disconnect();
		return { before, positions, intrinsic, added, removed, attributes,
			retained: originals.every(node => node.isConnected && node.parentElement === grid) };
	});
	expect(result.intrinsic.every(value => /^\d+(?:\.\d+)?px$/.test(value))).toBe(true);
	expect(result.added).toBe(0);
	expect(result.removed).toBe(0);
	expect(result.attributes).toBe(0);
	expect(result.retained).toBe(true);
	for (const position of result.positions) {
		expect(position.reached).toBe(true);
		expect(position.pane).toBe(result.before.pane);
		expect(position.grid).toBeCloseTo(result.before.grid, 3);
	}
}

async function expectOrdinaryGridGeometry(page: Page) {
	const result = await page.locator(GRID).evaluate(grid => {
		// Independent oracle: the same complete light-DOM tiles in the original
		// CSS auto-fill grid, with no action, shadow root, chunks or estimates.
		const bounds = grid.getBoundingClientRect();
		const style = getComputedStyle(grid);
		const oracle = grid.cloneNode(true) as HTMLElement;
		oracle.removeAttribute('data-testid');
		oracle.setAttribute('aria-hidden', 'true');
		oracle.inert = true;
		oracle.style.cssText = `position:fixed;left:-100000px;top:0;width:${bounds.width}px;display:grid;` +
			`grid-template-columns:repeat(auto-fill,minmax(${style.getPropertyValue('--tile')},1fr));` +
			`gap:${style.gap};visibility:hidden;content-visibility:visible;contain:none;`;
		grid.parentElement!.append(oracle);
		try {
			const expectedBounds = oracle.getBoundingClientRect();
			const actual = [...grid.querySelectorAll<HTMLElement>('[data-testid="unified-tile"]')];
			const expected = [...oracle.querySelectorAll<HTMLElement>('[data-testid="unified-tile"]')];
			let worst = { index: -1, error: 0 };
			actual.forEach((tile, index) => {
				const rect = tile.getBoundingClientRect();
				const reference = expected[index].getBoundingClientRect();
				const error = Math.max(Math.abs(rect.x - bounds.x - (reference.x - expectedBounds.x)),
					Math.abs(rect.y - bounds.y - (reference.y - expectedBounds.y)),
					Math.abs(rect.width - reference.width), Math.abs(rect.height - reference.height));
				if (error > worst.error) worst = { index, error };
			});
			const chunks = [...grid.shadowRoot!.querySelectorAll<HTMLElement>('[data-prepared-library-chunk]')];
			const intrinsicErrors = chunks.map(chunk => {
				const assigned = chunk.querySelector('slot')!.assignedElements();
				const first = expected[actual.indexOf(assigned[0] as HTMLElement)].getBoundingClientRect();
				const last = expected[actual.indexOf(assigned.at(-1) as HTMLElement)].getBoundingClientRect();
				return Math.abs(parseFloat(chunk.style.containIntrinsicBlockSize) - (last.bottom - first.top));
			});
			return { actualHeight: bounds.height, expectedHeight: expectedBounds.height, worst,
				intrinsicError: Math.max(...intrinsicErrors) };
		} finally { oracle.remove(); }
	});
	expect(result.actualHeight).toBeCloseTo(result.expectedHeight, 1);
	expect(result.intrinsicError, 'prepared chunk sizes equal independently laid-out ordinary rows').toBeLessThan(0.1);
	expect(result.worst.error, `largest geometry difference at tile ${result.worst.index}`).toBeLessThan(0.1);
}

for (const sort of ['az', 'shuffle'] as const) {
	test(`a complete ${sort === 'az' ? 'single-letter' : 'flat Shuffle'} grid preserves exact geometry through distant scrolling`, async ({ page }) => {
		test.setTimeout(90_000);
		await openAlbums(page, sort);
		await expectStableDistantScroll(page);
		await expectOrdinaryGridGeometry(page);
	});
}

test('hidden album grids prepare their new width and density before returning', async ({ page }) => {
	test.setTimeout(90_000);
	await openAlbums(page, 'az');
	const original = await page.locator(TILES).first().elementHandle();
	const preparedGeometry = () => page.locator(GRID).evaluate(grid =>
		[...grid.shadowRoot!.querySelectorAll<HTMLElement>('[data-prepared-library-chunk]')]
			.map(chunk => `${chunk.style.gridTemplateColumns}:${chunk.style.containIntrinsicBlockSize}`).join('|')
	);
	// Change width and density separately: one observer must not accidentally
	// compensate for the other. Read only prepared inline metadata while hidden.
	for (const change of [
		() => page.setViewportSize({ width: 710, height: 820 }),
		() => page.evaluate(() => window.libraryScrollFixture.setPresentation('dark', 'pi')),
		() => page.setViewportSize({ width: 1440, height: 900 }),
		() => page.evaluate(() => window.libraryScrollFixture.setPresentation('dark', 'compact'))
	]) {
		const before = await preparedGeometry();
		await page.getByTestId('unified-scope-artists').click();
		await change();
		await expect.poll(preparedGeometry).not.toBe(before);
		await page.getByTestId('unified-scope-albums').click();
		await expect(page.locator(TILES).first()).toBeVisible();
		expect(await original!.evaluate(node => node.isConnected)).toBe(true);
		await expectStableDistantScroll(page);
		await expectOrdinaryGridGeometry(page);
	}
});

test('native Tab crosses prepared chunks and distant album titles remain browser-searchable', async ({ page }) => {
	test.setTimeout(90_000);
	await openAlbums(page, 'az');
	const boundary = await page.locator(GRID).evaluate(grid => {
		const first = grid.shadowRoot!.querySelector('[data-prepared-library-chunk]')!;
		const slot = first.querySelector('slot')!;
		const last = slot.assignedElements().at(-1)!;
		return [...grid.querySelectorAll('[data-testid="unified-tile"]')].indexOf(last);
	});
	expect(boundary).toBeGreaterThan(0);
	expect(boundary).toBeLessThan(ALBUMS - 1);
	const before = page.locator(TILES).nth(boundary);
	const after = page.locator(TILES).nth(boundary + 1);
	await before.focus();
	await expect(before).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(after).toBeFocused();
	await expect(after).toBeInViewport();
	const focusedBounds = (await after.boundingBox())!;
	const toolbarBounds = (await page.locator('.library-list-toolbar:visible').boundingBox())!;
	expect(focusedBounds.y).toBeGreaterThanOrEqual(toolbarBounds.y + toolbarBounds.height - 1);
	await page.keyboard.press('Shift+Tab');
	await expect(before).toBeFocused();

	const target = (await page.locator(TILES).last().locator('.tt').textContent())!;
	await page.locator(PANE).evaluate(pane => pane.scrollTo({ top: 0, behavior: 'instant' }));
	const found = await page.evaluate(target => {
		(document.activeElement as HTMLElement | null)?.blur();
		window.getSelection()?.removeAllRanges();
		return (window as Window & { find(text: string, caseSensitive?: boolean): boolean }).find(target, true);
	}, target);
	expect(found).toBe(true);
	// Chromium's window.find selects but does not scroll, including in an
	// ordinary unchunked grid. Assert the browser found the actual distant
	// light-DOM title; native focus scrolling is independently checked above.
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(target);
	expect(await page.locator(TILES).last().evaluate(tile =>
		tile.contains(window.getSelection()?.anchorNode ?? null)
	)).toBe(true);
});
