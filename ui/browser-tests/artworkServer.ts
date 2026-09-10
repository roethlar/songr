import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

const artwork = readFileSync(new URL('../../desktop/build/icons/256x256.png', import.meta.url));
interface ImageRequest {
	key: string;
	startedAt: number;
	finishedAt: number | null;
	status: number | 'aborted' | null;
}
interface State {
	delayMs: number;
	failOnce: Set<string>;
	requests: ImageRequest[];
	active: number;
	peak: number;
}
const freshState = (delayMs = 400, failOnce: string[] = []): State => ({
	delayMs, failOnce: new Set(failOnce), requests: [], active: 0, peak: 0
});

/** Real same-origin HTTP preserves Chromium's connection queue in artwork tests. */
export function artworkFixtureServer(): Plugin {
	let state = freshState();
	return {
		name: 'artwork-fixture-server',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const pathname = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
				if (pathname === '/__fixture-artwork/configure' && req.method === 'POST') {
					let body = '';
					req.on('data', part => { body += String(part); });
					req.on('end', () => {
						try {
							const input = JSON.parse(body) as { delayMs: number; failOnce?: string[] };
							if (!Number.isFinite(input.delayMs) || input.delayMs < 0 || input.delayMs > 5000 ||
								(input.failOnce !== undefined && (!Array.isArray(input.failOnce) ||
								input.failOnce.some(key => typeof key !== 'string')))) throw new Error('Invalid fixture configuration');
							state = freshState(input.delayMs, input.failOnce);
							res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
							res.end('{}');
						} catch {
							res.writeHead(400); res.end('Invalid fixture configuration');
						}
					});
					return;
				}
				if (pathname === '/__fixture-artwork/state') {
					res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
					res.end(JSON.stringify({ requests: state.requests, active: state.active, peak: state.peak }));
					return;
				}
				const match = /^\/api\/image\/(art-\d+)$/.exec(pathname);
				if (!match) { next(); return; }
				// Capture this state so a closing previous test cannot affect the next.
				const current = state;
				const key = match[1];
				const fail = current.failOnce.delete(key);
				const entry: ImageRequest = { key, startedAt: Date.now(), finishedAt: null, status: null };
				current.requests.push(entry);
				current.active++;
				current.peak = Math.max(current.peak, current.active);
				const timer = setTimeout(() => {
					entry.status = fail ? 503 : 200;
					entry.finishedAt = Date.now();
					current.active--;
					const body = fail ? Buffer.from('{"error":"Temporary artwork failure"}') : artwork;
					res.writeHead(entry.status, {
						'Content-Type': fail ? 'application/json' : 'image/png',
						'Content-Length': body.length,
						'Cache-Control': fail ? 'no-store' : 'public, max-age=3600',
						...(fail ? { 'Retry-After': '0' } : {})
					});
					res.end(body);
				}, current.delayMs);
				timer.unref();
				res.on('close', () => {
					if (entry.finishedAt !== null) return;
					clearTimeout(timer);
					entry.status = 'aborted'; entry.finishedAt = Date.now(); current.active--;
				});
			});
		}
	};
}
