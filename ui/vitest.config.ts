import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { resolveLibraryScopeSlotsModule } from './src/lib/libraryFeatures/resolveScopeSlots.js';

// Vitest config kept separate from vite.config.ts so the SvelteKit dev
// server doesn't try to load the test setup. The Svelte plugin compiles
// .svelte files in component tests; SvelteKit's `$app/*` modules are
// aliased to tiny stubs so imports resolve in node.
export default defineConfig({
	plugins: [svelte({ hot: false })],
	test: {
		environment: 'jsdom',
		// .js included for tests of build-time modules that must stay
		// plain JS (svelte.config.js imports them outside any transform).
		include: ['src/**/__tests__/**/*.test.{js,ts,svelte.test.ts}'],
		setupFiles: ['./src/test/setup.ts'],
		globals: false
	},
	resolve: {
		alias: {
			$app: path.resolve('./src/test/app-stubs'),
			$lib: path.resolve('./src/lib'),
			'@shared': path.resolve('../src/shared'),
			// Resolved by the same function svelte.config.js uses, so the suite
			// sees exactly the slots the build would.
			'@libraryFeatures': resolveLibraryScopeSlotsModule()
		},
		// Tell vite to use the browser conditions when resolving Svelte
		// packages, so component tests get the browser entry points.
		conditions: ['browser']
	}
});
