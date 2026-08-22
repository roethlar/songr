#!/usr/bin/env node
/**
 * Render the desktop icon assets from their SVG sources through the
 * repository's pinned Chromium, the same way `product/brand/social-preview.png`
 * is produced: a deterministic render from committed geometry, never a
 * hand-exported bitmap.
 *
 *   node desktop/scripts/render-icons.mjs
 *
 * Outputs:
 *   desktop/build/icon.png                 1024×1024, the macOS/Windows source
 *                                          electron-builder converts (icns / ico)
 *   desktop/build/icons/<size>x<size>.png   the Linux icon SET (see below)
 *   desktop/resources/trayIconTemplate.png 16×16 macOS template (black+alpha)
 *   desktop/resources/trayIconTemplate@2x.png 32×32
 *
 * Why Linux gets a directory and not the 1024 PNG: pointed at a single PNG,
 * electron-builder installs it as-is at its native size, so deb/rpm shipped
 * only `hicolor/1024x1024/apps/songr.png`. `hicolor-icon-theme`'s index.theme
 * lists fixed sizes only up to 512x512, and freedesktop icon lookup visits
 * only listed directories — so `Icon=songr` resolved to nothing and launchers
 * drew a blank. Every size below IS listed in index.theme; 1024 deliberately
 * is not emitted into the set, because that is exactly what broke.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Linux icon-set sizes. Every one of these is a fixed-size directory listed in
 * hicolor's index.theme, which is what makes the icon resolvable at all.
 */
const LINUX_ICON_SIZES = [16, 32, 48, 64, 128, 256, 512];

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..');

// The root workspace owns the pinned Playwright Chromium.
const requireRoot = createRequire(path.join(REPO_ROOT, 'package.json'));
const { chromium } = requireRoot('@playwright/test');

async function renderSvg(page, svgPath, outPath, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.goto(`file://${svgPath}`);
  // Chromium renders a bare SVG document as the page; the viewport is the
  // canvas, and omitBackground keeps the corners transparent.
  await page.screenshot({ path: outPath, omitBackground: true });
  process.stdout.write(`[icons] ${path.relative(REPO_ROOT, outPath)} (${size}x${size})\n`);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await renderSvg(
    page,
    path.join(DESKTOP_DIR, 'build', 'icon.svg'),
    path.join(DESKTOP_DIR, 'build', 'icon.png'),
    1024,
  );
  // The Linux set, from the same committed geometry as the 1024 render above.
  const iconsDir = path.join(DESKTOP_DIR, 'build', 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });
  for (const size of LINUX_ICON_SIZES) {
    await renderSvg(
      page,
      path.join(DESKTOP_DIR, 'build', 'icon.svg'),
      path.join(iconsDir, `${size}x${size}.png`),
      size,
    );
  }
  await renderSvg(
    page,
    path.join(DESKTOP_DIR, 'build', 'trayIconTemplate.svg'),
    path.join(DESKTOP_DIR, 'resources', 'trayIconTemplate.png'),
    16,
  );
  await renderSvg(
    page,
    path.join(DESKTOP_DIR, 'build', 'trayIconTemplate.svg'),
    path.join(DESKTOP_DIR, 'resources', 'trayIconTemplate@2x.png'),
    32,
  );
} finally {
  await browser.close();
}
