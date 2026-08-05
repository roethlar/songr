import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
	root,
	plugins: [svelte({ hot: false })],
	test: {
		environment: 'jsdom',
		globals: false,
		include: ['src/**/*.test.ts'],
		setupFiles: ['./src/test/setup.ts']
	},
	resolve: {
		conditions: ['browser']
	}
});
