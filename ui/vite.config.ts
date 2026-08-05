import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
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
