import { expect, test } from '@playwright/test';

for (const albums of [3914, 40000]) {
 test(`complete ${albums}-album lists survive switching and scrolling`, async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.addInitScript(albums => { window.libraryScrollFixtureSize = { artists: 1679, albums }; }, albums);
  await page.goto('/fixtures/library-scroll.html');
  await expect(page.getByTestId('unified-row').filter({ visible: true }).first()).toBeVisible();
  const artist = await page.getByTestId('unified-row').filter({visible: true}).first().elementHandle();
  await page.getByTestId('unified-scope-albums').click();
  const tiles = page.locator('[data-scope-panel="albums"] [data-testid="unified-tile"]');
  await expect(tiles).toHaveCount(albums);
  const first = await tiles.first().elementHandle();
  expect(await artist!.evaluate(node => node.isConnected)).toBe(true);
  await page.getByTestId('unified-scope-artists').click();
  expect(await first!.evaluate(node => node.isConnected)).toBe(true);
  // Inactive full lists remain in the DOM but cannot receive keyboard focus.
  await first!.evaluate(node => node.focus());
  expect(await first!.evaluate(node => document.activeElement === node)).toBe(false);
  const timings: Array<{ scope: string; ms: number }> = [];
  for (const scope of ['albums', 'artists', 'genres', 'albums', 'surprise', 'albums', 'tracks', 'favorites', 'albums']) {
   timings.push(await page.evaluate(scope => new Promise<{scope: string; ms: number}>(resolve => {
    const start = performance.now();
    document.querySelector<HTMLButtonElement>(`[data-testid="unified-scope-${scope}"]`)!.click();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({scope, ms: performance.now() - start})));
   }), scope));
   expect(await first!.evaluate(node => node.isConnected)).toBe(true);
   expect(await artist!.evaluate(node => node.isConnected)).toBe(true);
  }
  expect(await tiles.first().evaluate((node, original) => node === original, first)).toBe(true);
  await artist!.evaluate(node => node.focus());
  expect(await artist!.evaluate(node => document.activeElement === node)).toBe(false);
  await first!.evaluate(node => node.focus());
  expect(await first!.evaluate(node => document.activeElement === node)).toBe(true);
  const scroll = await page.getByTestId('unified-pane').evaluate(async node => {
   let added = 0, removed = 0;
   const observer = new MutationObserver(records => { for (const record of records) { added += record.addedNodes.length; removed += record.removedNodes.length; } });
   observer.observe(node, {childList: true, subtree: true});
   const frames: number[] = [];
   let previous = performance.now();
   for (let frame = 0; frame < 90; frame++) {
    node.scrollTo({top: frame * 180, behavior: 'instant'});
    await new Promise(requestAnimationFrame);
    const now = performance.now(); frames.push(now - previous); previous = now;
   }
   node.scrollTo({top: node.scrollHeight, behavior: 'instant'});
   await new Promise(requestAnimationFrame);
   const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
   node.scrollTo({top: 0, behavior: 'instant'});
   await new Promise(requestAnimationFrame);
   observer.disconnect();
   return {added, removed, atEnd, frames};
  });
  expect(scroll.added).toBe(0);
  expect(scroll.removed).toBe(0);
  expect(scroll.atEnd).toBe(true);
  await expect(tiles).toHaveCount(albums);
  await page.evaluate(() => window.libraryScrollFixture.replaceRetiredLibraryGeneration());
  await expect.poll(() => first!.evaluate(node => node.isConnected)).toBe(false);
  await expect(tiles).toHaveCount(albums);
  await tiles.first().click();
  expect(await page.evaluate(() => window.libraryScrollFixture.liveOpenRefs.at(-1)?.generation))
   .toBe(await page.evaluate(() => window.libraryScrollFixture.liveGeneration));
  await info.attach('switch-and-scroll-measurements', {body: JSON.stringify({albums, timings, scroll}), contentType: 'application/json'});
 });
}


test('scope returns and Surprise preserve album Shuffle until Shuffle is chosen again', async ({ page }) => {
 await page.addInitScript(() => { window.libraryScrollFixturePresentation = {albumsSort: 'shuffle'}; });
 await page.goto('/fixtures/library-scroll.html');
 await page.getByTestId('unified-scope-albums').click();
 const tiles = page.locator('[data-scope-panel="albums"] .tile');
 const order = await tiles.allTextContents();
 const original = await tiles.first().elementHandle();
 for (const scope of ['artists', 'albums', 'surprise', 'albums']) {
  await page.getByTestId(`unified-scope-${scope}`).click();
  expect(await tiles.allTextContents()).toEqual(order);
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
 }
 await page.getByTestId('unified-sort').click();
 await page.getByTestId('unified-sort-option-shuffle').click();
 expect(await tiles.allTextContents()).not.toEqual(order);
});
