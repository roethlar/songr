import { fileURLToPath, URL } from 'node:url';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';


const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const libraryRouteFixture: Plugin = {
	name: 'library-route-fixture',
	configureServer(server) {
		server.middlewares.use((request, _response, next) => {
			if (request.url) {
				const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
				if (pathname === '/library' || pathname.startsWith('/library/')) {
					request.url = '/fixtures/library-scroll.html';
				}
			}
			next();
		});
	}
};

// The server root is this directory, not `fixtures/`, so fixture pages are
// addressable as `/fixtures/<name>.html`. There is deliberately no page
// manifest and no rollup input list — either would be a second source of truth
// that could name a page the checkout does not carry; Playwright discovers its
// specs from disk.
export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	plugins: [libraryRouteFixture, svelte()],
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
			'@shared': fileURLToPath(new URL('../../src/shared', import.meta.url))
		}
	},
	server: {
		fs: {
			allow: [uiRoot, repositoryRoot]
		}
	}
});
