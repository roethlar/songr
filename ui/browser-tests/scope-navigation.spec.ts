import { expect, test, type Page } from '@playwright/test';
import {
 DEFAULT_NAVIGATION_SETTINGS, NAVIGATION_DESTINATION_IDS,
 type NavigationDestinationId, type NavigationSettingsSnapshot
} from '../../src/shared/navigationSettings';

const primary = (page: Page) => page.locator('.scope-navigation > [data-primary-id]:visible');
const more = (page: Page) => page.getByRole('button', { name: 'More library pages', exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'More library pages' });

async function enter(page: Page) {
 await page.setViewportSize({ width: 1440, height: 900 });
 await page.goto('/fixtures/library-scroll.html?nav=default');
 await expect(page.getByTestId('unified-row').first()).toBeVisible();
 await expect(primary(page)).toHaveText(['Artists', 'Albums', 'Genres']);
}
async function apply(page: Page, update: Partial<NavigationSettingsSnapshot>) {
 const prior = await page.evaluate(() => window.libraryScrollFixture.navigationSnapshot!);
 const snapshot = { ...prior, ...update, revision: prior.revision + 1 };
 expect(await page.evaluate(snapshot => window.libraryScrollFixture.applyNavigationSnapshot(snapshot), snapshot)).toBe(true);
 return snapshot;
}
async function primaryIds(page: Page): Promise<string[]> {
 return primary(page).evaluateAll(buttons => buttons.map(button => (button as HTMLElement).dataset.primaryId!));
}
async function reachableIds(page: Page): Promise<string[]> {
 const shown = await primaryIds(page);
 if (await more(page).isVisible()) {
  await more(page).click();
  shown.push(...await menu(page).getByRole('menuitem').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-testid')!.replace('unified-scope-', ''))));
  await page.keyboard.press('Escape');
 }
 return shown.sort();
}

test('defaults retain the compact chips and More only selects other pages', async ({ page }) => {
 await enter(page);
 const snapshot = await page.evaluate(() => window.libraryScrollFixture.navigationSnapshot);
 expect(snapshot).toEqual(DEFAULT_NAVIGATION_SETTINGS);
 await more(page).click();
 await expect(menu(page).getByText(/settings|options|customize/i)).toHaveCount(0);
 await menu(page).getByRole('menuitem', { name: 'Favorites', exact: true }).click();
 await expect(menu(page)).toHaveCount(0);
 await expect(page.getByTestId('unified-pane')).toHaveAttribute('data-scope', 'favorites');
 await expect(more(page)).toHaveClass(/\bon\b/);
 await expect(more(page)).toBeFocused();
 await expect(primary(page)).toHaveText(['Artists', 'Albums', 'Genres']);
 expect(await page.evaluate(() => window.libraryScrollFixture.navigationSnapshot)).toEqual(snapshot);
});

test('server snapshots update pins and ordering without remounting the library', async ({ page }) => {
 await enter(page);
 const firstRow = await page.getByTestId('unified-row').first().elementHandle();
 const order: NavigationDestinationId[] = ['favorites', 'genres', 'albums', 'artists', ...NAVIGATION_DESTINATION_IDS.filter(id => !['favorites', 'genres', 'albums', 'artists'].includes(id))];
 const snapshot = await apply(page, { order, pinned: ['favorites', 'albums'] });
 await expect(primary(page)).toHaveText(['Favorites', 'Albums']);
 expect(await firstRow!.evaluate(node => node.isConnected)).toBe(true);
 expect(await page.evaluate(snapshot => window.libraryScrollFixture.applyNavigationSnapshot(snapshot), DEFAULT_NAVIGATION_SETTINGS)).toBe(false);
 await expect(primary(page)).toHaveText(['Favorites', 'Albums']);
 expect(await page.evaluate(() => window.libraryScrollFixture.navigationSnapshot)).toEqual(snapshot);
});

test('800, 390 and 320 pixel widths keep one row and every configured page reachable', async ({ page }) => {
 await enter(page);
 const available = await reachableIds(page);
 const configured = await apply(page, { pinned: NAVIGATION_DESTINATION_IDS });
 for (const viewport of [{ width: 800, height: 480 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
  await page.setViewportSize(viewport);
  await expect.poll(async () => page.locator('.scope-navigation').evaluate(nav => {
   const rect = nav.getBoundingClientRect();
   const buttons = Array.from(nav.querySelectorAll<HTMLElement>(':scope > .sc:not(.scope-measure)'));
   return buttons.every(button => { const box = button.getBoundingClientRect(); return box.left >= rect.left - 1 && box.right <= rect.right + 1 && Math.abs(box.top - buttons[0].getBoundingClientRect().top) <= 1; });
  })).toBe(true);
  expect(await reachableIds(page)).toEqual(available);
  await more(page).click();
  const bounds = await menu(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.libraryScrollFixture.navigationSnapshot)).toEqual(configured);
 }
});

test('no pins, all pins, and keyboard navigation preserve focus and avoid an empty More menu', async ({ page }) => {
 await enter(page);
 const available = await reachableIds(page);
 await apply(page, { pinned: [] });
 await expect(primary(page)).toHaveCount(0);
 await more(page).focus();
 await page.keyboard.press('ArrowDown');
 await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
 expect(await menu(page).getByRole('menuitem').count()).toBe(available.length);
 await page.keyboard.press('End');
 await expect(menu(page).getByRole('menuitem').last()).toBeFocused();
 await page.keyboard.press('Home');
 await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
 await page.keyboard.press('ArrowDown');
 await expect(menu(page).getByRole('menuitem').nth(1)).toBeFocused();
 await page.keyboard.press('Escape');
 await expect(more(page)).toBeFocused();
 await expect(menu(page)).toHaveCount(0);
 await more(page).press('ArrowUp');
 await expect(menu(page).getByRole('menuitem').last()).toBeFocused();
 await page.keyboard.press('Tab');
 await expect(menu(page)).toHaveCount(0);
 await expect(more(page)).not.toBeFocused();
 await page.setViewportSize({ width: 1920, height: 1080 });
 await more(page).click();
 await apply(page, { pinned: NAVIGATION_DESTINATION_IDS });
 await expect(menu(page)).toHaveCount(0);
 await expect(more(page)).toHaveCount(0);
 expect((await primaryIds(page)).sort()).toEqual(available);
});


test('More stays inside a short library pane through resizing and End reaches its last item', async ({ page }, info) => {
 await enter(page);
 const pane = page.getByTestId('unified-pane');
 async function resizePane(height: number) {
  await pane.evaluate((node, height) => {
   Object.assign(node.style, { height: `${height}px`, maxHeight: `${height}px`, minHeight: '0', flex: '1 1 0%', alignSelf: 'flex-start', boxSizing: 'border-box' });
  }, height);
  await expect.poll(() => pane.evaluate(node => node.getBoundingClientRect().height)).toBe(height);
 }
 await resizePane(160);
 const scrollBefore = await pane.evaluate(node => node.scrollTop);
 await more(page).click();
 const originalMenu = await menu(page).elementHandle();
 for (const height of [160, 300, 140]) {
  await resizePane(height);
  // A pane can change height without changing the window or navigation width.
  // More remains open; its own scroller must adapt to the new clipping boundary.
  await expect(menu(page)).toBeVisible();
  expect(await menu(page).evaluate((node, original) => node === original, originalMenu)).toBe(true);
  await expect.poll(async () => {
   const paneBounds = (await pane.boundingBox())!;
   const menuBounds = (await menu(page).boundingBox())!;
   return menuBounds.y + menuBounds.height - (paneBounds.y + paneBounds.height);
  }, { message: 'the complete menu must fit above the library pane bottom' }).toBeLessThanOrEqual(0);
  const paneBounds = (await pane.boundingBox())!;
  const menuBounds = (await menu(page).boundingBox())!;
  expect(menuBounds.y).toBeGreaterThanOrEqual(paneBounds.y);
  await page.keyboard.press('End');
  const last = menu(page).getByRole('menuitem').last();
  await expect(last).toBeFocused();
  const lastBounds = (await last.boundingBox())!;
  const menuScroll = await menu(page).evaluate(node => ({ top: node.scrollTop, overflow: node.scrollHeight > node.clientHeight }));
  await info.attach(`short-pane-menu-${height}`, { body: JSON.stringify({ paneBounds, menuBounds, lastBounds, menuScroll, scrollBefore, scrollAfter: await pane.evaluate(node => node.scrollTop) }), contentType: 'application/json' });
  if (height !== 300) expect(menuScroll.overflow, 'the short pane requires an internal menu scroller').toBe(true);
  if (menuScroll.overflow) expect(menuScroll.top, 'End should scroll the overflow menu internally').toBeGreaterThan(0);
  expect(lastBounds.y).toBeGreaterThanOrEqual(menuBounds.y);
  expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(menuBounds.y + menuBounds.height);
  expect(lastBounds.y + lastBounds.height, 'the last destination must fit above the library pane bottom').toBeLessThanOrEqual(paneBounds.y + paneBounds.height);
  expect(await pane.evaluate(node => node.scrollTop)).toBe(scrollBefore);
 }
});
