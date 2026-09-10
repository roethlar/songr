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
