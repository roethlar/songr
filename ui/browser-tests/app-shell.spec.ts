import { expect, test, type Page } from '@playwright/test';

async function shellGeometry(page: Page) {
  return page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>('[data-workspace-presentation]')!;
    const child = document.querySelector<HTMLElement>('[data-testid="shell-route-child"]')!;
    const footer = document.querySelector<HTMLElement>('[aria-label="Playback controls"]');
    const style = getComputedStyle(workspace);
    return {
      pathname: window.location.pathname,
      presentation: workspace.dataset.workspacePresentation,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      workspace: workspace.getBoundingClientRect().toJSON(),
      child: child.getBoundingClientRect().toJSON(),
      footer: footer?.getBoundingClientRect().toJSON() ?? null,
      controls: footer ? [...footer.querySelectorAll<HTMLElement>('button, input, [aria-label="Volume unavailable"]')]
        .filter(element => element.getClientRects().length > 0)
        .map(element => ({ label: element.getAttribute('aria-label') ?? element.textContent?.trim(), rect: element.getBoundingClientRect().toJSON() })) : [],
      documentWidth: document.documentElement.scrollWidth,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  });
}

async function expectLibraryShell(page: Page) {
  await expect(page.locator('[data-workspace-presentation]')).toHaveAttribute('data-workspace-presentation', 'full-bleed');
  const footer = page.getByRole('contentinfo', { name: 'Playback controls' });
  await expect(footer).toBeVisible();
  const geometry = await shellGeometry(page);
  expect(geometry.padding).toEqual(['0px', '0px', '0px', '0px']);
  expect(geometry.workspace.x).toBe(0);
  expect(geometry.workspace.width).toBe(geometry.viewport.width);
  expect(geometry.child.x).toBe(0);
  expect(geometry.child.width).toBe(geometry.viewport.width);
  expect(geometry.child.y).toBe(geometry.workspace.y);
  expect(geometry.footer!.bottom).toBe(geometry.viewport.height);
  expect(geometry.workspace.bottom).toBe(geometry.footer!.top);
  expect(geometry.documentWidth).toBe(geometry.viewport.width);
  for (const control of geometry.controls) {
    expect(control.rect.left, control.label).toBeGreaterThanOrEqual(0);
    expect(control.rect.right, control.label).toBeLessThanOrEqual(geometry.viewport.width);
    expect(control.rect.top, control.label).toBeGreaterThanOrEqual(geometry.footer!.top);
    expect(control.rect.bottom, control.label).toBeLessThanOrEqual(geometry.viewport.height);
  }
  if (geometry.viewport.width >= 800) expect(geometry.footer!.height).toBe(59);
}

test('full outer layout keeps deep Library routes edge-to-window with playback across navigation and reload', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/library/browse?shell=1');
  await page.waitForSelector('html[data-fixture-ready="true"]');
  await page.locator('[data-workspace-presentation]').evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished));
  });
  await testInfo.attach('initial-shell-geometry', { body: JSON.stringify(await shellGeometry(page), null, 2), contentType: 'application/json' });
  await testInfo.attach('initial-shell', { body: await page.screenshot(), contentType: 'image/png' });
  await expectLibraryShell(page);

  // The active-view guard is still required even on a valid Library URL.
  await page.evaluate(() => window.appShellFixture.setActive(false));
  await expect(page.locator('[data-workspace-presentation]')).toHaveAttribute('data-workspace-presentation', 'contained');
  await expect(page.getByRole('contentinfo', { name: 'Playback controls' })).toHaveCount(0);
  await page.evaluate(() => window.appShellFixture.setActive(true));
  await expectLibraryShell(page);

  for (const pathname of ['/library', '/library/', '/library/artists/AC%2FDC/albums/record', '/library/browse']) {
    await page.evaluate(path => window.appShellFixture.navigate(path), pathname);
    await expectLibraryShell(page);
  }
  await page.reload();
  await page.waitForSelector('html[data-fixture-ready="true"]');
  await expectLibraryShell(page);
  for (const viewport of [{ width: 800, height: 480 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expectLibraryShell(page);
    await testInfo.attach(`shell-geometry-${viewport.width}`, { body: JSON.stringify(await shellGeometry(page), null, 2), contentType: 'application/json' });
    await testInfo.attach(`shell-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' });
  }

  // Keep the active view deliberately present: pathname boundaries must still
  // prevent an unrelated route from inheriting the Library shell.
  for (const pathname of ['/libraryish', '/library-old', '/library%2Ftracks', '/']) {
    await page.evaluate(path => window.appShellFixture.navigate(path), pathname);
    await expect(page.locator('[data-workspace-presentation]')).toHaveAttribute('data-workspace-presentation', 'contained');
    await expect(page.getByRole('contentinfo', { name: 'Playback controls' })).toHaveCount(0);
  }
  await page.evaluate(() => window.appShellFixture.navigate('/library/browse'));
  await expectLibraryShell(page);
  await page.evaluate(() => window.appShellFixture.releaseHost());
  await expect(page.getByRole('contentinfo', { name: 'Playback controls' })).toHaveCount(0);
  expect(errors).toEqual([]);
});


test('full outer layout keeps grouped-zone and volume controls reachable on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/library/browse?shell=1&grouped=1');
  await page.waitForSelector('html[data-fixture-ready="true"]');
  await expect(page.getByRole('button', { name: 'Ungroup current zone' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Volume', exact: true })).toBeVisible();
  await testInfo.attach('grouped-shell-geometry', { body: JSON.stringify(await shellGeometry(page), null, 2), contentType: 'application/json' });
  await testInfo.attach('grouped-shell', { body: await page.screenshot(), contentType: 'image/png' });
  await expectLibraryShell(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await expectLibraryShell(page);
});
