import { defineConfig } from '@playwright/test';

// Browser tooling is pinned in the repository-root package and lockfile.
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
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{ name: 'webkit', testMatch: /(?:album-frame-clipping|alphabet-rail|prepared-chunk-hit|play-bar-credit)\.spec\.ts/, use: { browserName: 'webkit' } },
		{ name: 'webkit-grid', testMatch: /library-grid-layout\.spec\.ts/, grep: /preserves exact geometry|native Tab crosses prepared chunks|hidden album grids prepare/, use: { browserName: 'webkit' } }
	],
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
		// Probe the shared media-session fixture before starting browser checks.
		url: `${baseURL}/fixtures/media-session.html`,
		reuseExistingServer: true,
		timeout: 120_000
	}
});
