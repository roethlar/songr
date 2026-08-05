import { defineConfig } from '@playwright/test';

// Playwright is intentionally pinned in the repository-root toolchain. The
// timeline live-action evidence binds the exact UI manifest and lockfile bytes,
// so browser-only tooling must not be added to ui/package*.json.
const port = 4174;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: './browser-tests',
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	expect: {
		timeout: 5_000
	},
	reporter: 'list',
	outputDir: 'test-results/playwright',
	use: {
		baseURL,
		browserName: 'chromium',
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure',
		video: 'retain-on-failure',
		testIdAttribute: 'data-testid'
	},
	webServer: {
		command: `npm exec -- vite --config browser-tests/vite.config.ts --host 127.0.0.1 --port ${port}`,
		// The readiness probe must name a page that exists in every checkout, so
		// it points at the public Classic fixture rather than a walled one. A
		// walled page here would make the server look unhealthy in a tree without
		// the extended-feature layer, and the suite would fail to start rather
		// than run its public spec.
		url: `${baseURL}/fixtures/classic-item-grid.html`,
		reuseExistingServer: true,
		timeout: 120_000
	}
});
