import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The product version, read from the REPOSITORY ROOT package.json — the one
// the release is cut from. `ui/package.json` carries its own unrelated version
// and is deliberately not the source here. Stamped in at build time so the
// About panel can name the release without a server round-trip, which also
// keeps it correct for the plain browser client and the desktop shell alike.
const appVersion: string = JSON.parse(
	readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
).version;

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(appVersion)
	},
	plugins: [sveltekit()],
	server: {
		proxy: {
			'/api': {
				target: 'http://localhost:3333',
				changeOrigin: true
			},
			'/socket.io': {
				target: 'http://localhost:3333',
				ws: true
			}
		}
	}
});
