import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
	root,
	plugins: [svelte()],
	server: {
		host: '127.0.0.1',
		port: 4174,
		strictPort: true,
		open: false
	},
	preview: {
		host: '127.0.0.1',
		port: 4174,
		strictPort: true,
		open: false
	},
	build: {
		outDir: join(tmpdir(), 'roon-controller-timeline-harness'),
		emptyOutDir: true,
		sourcemap: true
	}
});
