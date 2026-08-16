import { fileURLToPath, URL } from 'node:url';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

import { resolveLibraryScopeSlotsModule } from '../src/lib/libraryFeatures/resolveScopeSlots.js';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

// The server root is this directory, not `fixtures/`, so that pages under both
// the public `fixtures/` tree and the walled `native/` root are addressable:
// `/fixtures/media-session.html` and `/native/fixtures/most-played.html`.
//
// Page resolution is disk existence, the same principle `resolveScopeSlots.js`
// applies to the `@libraryFeatures` alias, and it needs no code here to enforce
// it: a checkout without `native/` simply has no such file to serve, and nothing
// asks for one, because Playwright discovers its specs from disk too. There is
// deliberately no page manifest and no rollup input list — either would be a
// second source of truth that could name a page the checkout does not carry.
export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	plugins: [svelte()],
	resolve: {
		alias: {
			'$app/environment': fileURLToPath(
				new URL('./fixtures/app-environment.ts', import.meta.url)
			),
			// The composition fixture mounts UnifiedLibraryMode whole, whose
			// page-state navigation reaches SvelteKit's virtual modules; the
			// same browser-safe stubs the Vitest config aliases serve here.
			'$app/navigation': fileURLToPath(
				new URL('../src/test/app-stubs/navigation.ts', import.meta.url)
			),
			'$app/state': fileURLToPath(
				new URL('../src/test/app-stubs/state.svelte.ts', import.meta.url)
			),
			'$app/stores': fileURLToPath(
				new URL('../src/test/app-stubs/stores.ts', import.meta.url)
			),
			$lib: fileURLToPath(new URL('../src/lib', import.meta.url)),
			'@shared': fileURLToPath(new URL('../../src/shared', import.meta.url)),
			// Same resolver as svelte.config.js and vitest.config.ts. Fixture
			// pages import the views directly today, but the alias must mean the
			// same thing here or a fixture that reaches the surface through it
			// would silently get a different resolution.
			'@libraryFeatures': resolveLibraryScopeSlotsModule()
		}
	},
	server: {
		fs: {
			allow: [uiRoot, repositoryRoot]
		}
	}
});
