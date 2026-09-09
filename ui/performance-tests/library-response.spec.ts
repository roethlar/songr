import { expect, test } from '@playwright/test';

for (const sample of [
 { albums: 3914, singleLetter: false, albumsSort: 'az' },
 { albums: 40000, singleLetter: false, albumsSort: 'az' },
 { albums: 40000, singleLetter: true, albumsSort: 'az' },
 { albums: 40000, singleLetter: false, albumsSort: 'shuffle' }
] as const) {
 test(`${sample.albums} albums, ${sample.singleLetter ? 'single letter' : sample.albumsSort}: chips and new artwork stay responsive`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(sample => {
   window.libraryScrollFixtureSize = { artists: 1679, albums: sample.albums };
   window.libraryScrollFixturePresentation = { artwork: true, longTitles: true, ...sample };
  }, sample);
  await page.goto('/fixtures/library-scroll.html');
  await expect(page.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
  await expect(page.getByTestId('unified-row').first()).toBeVisible();
  const timing = [];
  for (const scope of ['albums', 'artists', 'genres', 'albums', 'surprise', 'albums']) {
   timing.push(await page.evaluate(scope => new Promise<{scope: string; ms: number}>(resolve => {
    const start = performance.now();
    document.querySelector<HTMLButtonElement>(`[data-testid="unified-scope-${scope}"]`)!.click();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({scope, ms: performance.now() - start})));
   }), scope));
   await page.waitForTimeout(100);
  }
  const scroll = await page.getByTestId('unified-pane').evaluate(async pane => {
   const initialHeight = pane.scrollHeight;
   const frames: number[] = [], positions: number[] = [];
   let added = 0, removed = 0;
   const observer = new MutationObserver(records => records.forEach(r => { added += r.addedNodes.length; removed += r.removedNodes.length; }));
   observer.observe(pane, {childList: true, subtree: true});
   let previous = performance.now();
   for (let frame = 0; frame < 120; frame++) {
    pane.scrollTo({top: frame * 150, behavior: 'instant'});
    await new Promise(requestAnimationFrame);
    const now = performance.now(); frames.push(now - previous); previous = now;
    positions.push(pane.scrollTop);
   }
   const decoded = [...pane.querySelectorAll<HTMLImageElement>('[data-scope-panel="albums"] img')].filter(img => img.complete && img.naturalWidth > 0).length;
   const jumpStart = performance.now();
   pane.scrollTo({top: pane.scrollHeight, behavior: 'instant'});
   await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
   const jumpMs = performance.now() - jumpStart;
   const atEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1;
   const finalHeight = pane.scrollHeight;
   observer.disconnect();
   return {frames, positions, added, removed, decoded, initialHeight, finalHeight, atEnd, jumpMs};
  });
  // Inspect the destination after timing: querying all offscreen rectangles
  // during measurement would itself force the complete list to paint.
  const last = page.locator('[data-scope-panel="albums"] .tile').last();
  await expect(last).toBeInViewport();
  await expect.poll(() => last.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(256);
  const sorted = scroll.frames.slice(1).sort((a,b) => a-b);
  const measurements = {sample, timing, ...scroll, scrollP95: sorted[Math.floor(sorted.length * .95)], scrollMax: Math.max(...sorted)};
  await info.attach('response', {body: JSON.stringify(measurements, null, 2), contentType: 'application/json'});
  console.log(JSON.stringify({sample, chips: timing.map(t => Math.round(t.ms)), p95: measurements.scrollP95, max: measurements.scrollMax, jump: scroll.jumpMs, decoded: scroll.decoded}));
  expect(errors).toEqual([]);
  expect(scroll.added).toBe(0); expect(scroll.removed).toBe(0);
  expect(scroll.positions.at(-1)).toBe(17850);
  expect(scroll.finalHeight).toBe(scroll.initialHeight);
  expect(scroll.atEnd).toBe(true);
  expect(scroll.decoded).toBeGreaterThan(300);
  expect.soft(Math.max(...timing.map(t => t.ms)), 'Every chip, including the first, must present within 50 ms').toBeLessThanOrEqual(50);
  expect.soft(measurements.scrollP95, 'Continuous scrolling must stay within two 60 Hz frames').toBeLessThanOrEqual(33.4);
  expect.soft(measurements.scrollMax, 'Scrolling must not introduce a long frame').toBeLessThanOrEqual(50);
  expect.soft(scroll.jumpMs, 'A first jump to distant content must present within 50 ms').toBeLessThanOrEqual(50);
 });
}
