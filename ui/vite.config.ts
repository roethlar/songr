import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The product version, read from the REPOSITORY ROOT package.json — the one
// the release is cut from. `ui/package.json` carries its own unrelated version
// and is deliberately not the source here. Stamped in at build time so the
// About panel can name the release without a server round-trip, which also
// keeps it correct for the plain browser client and the desktop shell alike.
const rootPackageJson = fileURLToPath(new URL('../package.json', import.meta.url));
let appVersion: string;
try {
	appVersion = JSON.parse(readFileSync(rootPackageJson, 'utf8')).version;
} catch (cause) {
	// A bare ENOENT here is unreadable in a container log. Any build context that
	// does not carry the root package.json is misconfigured — the Dockerfile's
	// frontend stage must COPY it — so fail loudly and name the fix.
	throw new Error(
		`Cannot read the product version from ${rootPackageJson}. The UI build ` +
			`needs the repository root package.json in its build context.`,
		{ cause }
	);
}

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
