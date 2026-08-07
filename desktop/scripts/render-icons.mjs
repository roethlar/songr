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
 *   desktop/build/icon.png                 1024×1024, electron-builder converts
 *                                          it per target (icns / ico / pngs)
 *   desktop/resources/trayIconTemplate.png 16×16 macOS template (black+alpha)
 *   desktop/resources/trayIconTemplate@2x.png 32×32
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
