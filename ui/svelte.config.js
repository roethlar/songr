import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { resolveBuildRevision } from './src/lib/buildRevision.js';
import { resolveLibraryScopeSlotsModule } from './src/lib/libraryFeatures/resolveScopeSlots.js';

// Build-time revision stamp, surfaced in the sidebar footer via
// `$app/environment`'s `version` and used by SvelteKit for stale-
// deployment detection. See buildRevision.js for the resolution
// order and why the fallback is unique per build, never a constant.
const revision = resolveBuildRevision();

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		version: { name: revision },
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			// Serve index.html for any path not matched by a static file,
			// so SvelteKit's client-side router handles deep-linking.
			fallback: 'index.html',
			precompress: false
		}),
		alias: {
			'@shared': path.resolve('../src/shared'),
			// The library surface's extended scopes, resolved by disk existence
			// so a checkout without them builds unconfigured. Same resolver in
			// vitest.config.ts and browser-tests/vite.config.ts, so every
			// toolchain agrees about what this alias means.
			'@libraryFeatures': resolveLibraryScopeSlotsModule()
		}
	}
};

export default config;
