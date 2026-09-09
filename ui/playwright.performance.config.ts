import { defineConfig } from '@playwright/test';

// Use optimized shipping components and actual decoded artwork. Development
// instrumentation and request interception would distort the latency budget.
export default defineConfig({
 testDir: './performance-tests', workers: 1, fullyParallel: false,
 timeout: 120_000, reporter: 'list', outputDir: 'test-results/library-performance',
 use: { baseURL: 'http://127.0.0.1:4196', browserName: 'chromium', viewport: { width: 1280, height: 820 }, trace: 'retain-on-failure' },
 webServer: {
  command: 'npm exec -- vite build --config browser-tests/vite.performance.config.ts && npm exec -- vite preview --config browser-tests/vite.performance.config.ts --host 127.0.0.1 --port 4196 --strictPort',
  url: 'http://127.0.0.1:4196/fixtures/library-scroll.html', timeout: 120_000, reuseExistingServer: false
 }
});
