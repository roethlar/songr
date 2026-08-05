import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import { ImageService } from '../../../../core/roon/ImageService';
import { createImageRouter } from '../image';

// Minimal mock client
const mockRoonClient = {
  getImage: jest.fn(),
} as any;

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: 'info',
} as any;

function startApp(service: ImageService): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/image', createImageRouter(service));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('GET /api/image/:key', () => {
  let tmpDir: string;
  let service: ImageService;
  let app: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    tmpDir = path.join(__dirname, `__cache_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const fakeImageApi = {
      get_image: (
        _key: string,
        _opts: unknown,
        cb: (err: unknown, contentType: string, buf: Buffer) => void
      ) => {
        cb(null, 'image/png', Buffer.from('PNG_BYTES'));
      },
    };
    mockRoonClient.getImage.mockReturnValue(fakeImageApi);
    service = new ImageService(mockRoonClient, mockLogger, tmpDir);
    service.start();
    app = await startApp(service);
  });

  afterEach(async () => {
    await app.close();
    // tmpDir cleanup is best-effort; jest worker exit will clean it
    try {
      const fs = await import('fs/promises');
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns 400 for an unknown scale', async () => {
    const res = await fetch(`${app.url}/api/image/abc?scale=evil`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/scale/);
  });

  it('returns 400 for non-integer width', async () => {
    const res = await fetch(`${app.url}/api/image/abc?scale=fit&width=1.5&height=10`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/width/);
  });

  it('returns 400 for negative width', async () => {
    const res = await fetch(`${app.url}/api/image/abc?scale=fit&width=-10&height=10`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for width exceeding the cap', async () => {
    const res = await fetch(`${app.url}/api/image/abc?scale=fit&width=99999&height=99999`);
    expect(res.status).toBe(400);
  });

  it('returns 400 when scale is set without width and height', async () => {
    const res = await fetch(`${app.url}/api/image/abc?scale=fit`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an overlong key', async () => {
    const longKey = 'a'.repeat(257);
    const res = await fetch(`${app.url}/api/image/${longKey}`);
    expect(res.status).toBe(400);
  });

  it('does not write outside the cache directory for an encoded path-traversal key', async () => {
    // %2E%2E%2F decodes to "../" — the old code would have used path.join
    // to escape the cache directory. The cache filename is now a hash, so
    // the file lands inside cacheDir regardless of input shape.
    const traversalKey = encodeURIComponent('../../escape');
    const res = await fetch(`${app.url}/api/image/${traversalKey}`);
    // Either 200 (image served) or 5xx (Roon returned nothing) is acceptable;
    // what matters is no file is created outside cacheDir.
    expect([200, 404, 500]).toContain(res.status);

    // Give the fire-and-forget cache write a moment.
    await new Promise((r) => setTimeout(r, 50));

    const fs = await import('fs/promises');
    // Anything in tmpDir is fine; nothing in its parent named "escape*".
    const parent = path.dirname(tmpDir);
    const parentEntries = await fs.readdir(parent);
    expect(parentEntries.some((name) => name.startsWith('escape'))).toBe(false);
  });

  it('writes a fixed-length hash filename to the cache directory', async () => {
    const res = await fetch(`${app.url}/api/image/normalkey`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    await new Promise((r) => setTimeout(r, 50));

    const fs = await import('fs/promises');
    const entries = await fs.readdir(tmpDir);
    const dataFiles = entries.filter((e) => !e.endsWith('.meta'));
    expect(dataFiles).toHaveLength(1);
    // SHA-256 hex digest length
    expect(dataFiles[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
