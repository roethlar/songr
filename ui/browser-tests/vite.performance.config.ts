import base from './vite.config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const artwork = readFileSync(new URL('../../desktop/build/icons/256x256.png', import.meta.url));
const images: Plugin = {
 name: 'performance-artwork',
 configurePreviewServer(server) {
  server.middlewares.use((req, res, next) => {
   if (!req.url?.startsWith('/api/image/')) return next();
   res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
   res.end(artwork);
  });
 }
};
export default {
 ...base, plugins: [...base.plugins!, images],
 build: {
  outDir: '../test-results/library-performance-build', emptyOutDir: true,
  rollupOptions: { input: fileURLToPath(new URL('./fixtures/library-scroll.html', import.meta.url)) }
 }
};
