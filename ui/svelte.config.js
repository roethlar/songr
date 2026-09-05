import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { resolveBuildRevision } from './src/lib/buildRevision.js';

// Build-time revision stamp, surfaced in the sidebar footer via
// `$app/environment`'s `version` and used by SvelteKit for stale-
// deployment detection. See buildRevision.js for the resolution
// order and why the fallback must be deterministic within a build
// (per-environment config evaluation) yet never a constant across
// releases.
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
			'@shared': path.resolve('../src/shared')
		}
	}
};

export default config;
