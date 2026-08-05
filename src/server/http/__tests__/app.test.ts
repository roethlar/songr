import http from 'http';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { AddressInfo } from 'net';
import { createHttpApp } from '../app';
import { RoonClient } from '../../../core/roon/RoonClient';
import { TransportService } from '../../../core/roon/TransportService';
import { ImageService } from '../../../core/roon/ImageService';
import { RecentlyPlayedService } from '../../../core/recently-played/RecentlyPlayedService';
import { FavoritesService } from '../../../core/favorites/FavoritesService';
import type { CatalogHttpService } from '../routes/catalog';

const stubLogger: any = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: 'info',
};

const stubRoon: any = {
  getCoreStatus: () => 'discovering',
  getCoreInfo: () => null,
  getTransport: () => null,
  getBrowse: jest.fn(() => null),
  getImage: () => null,
};

async function startApp() {
  const transport = new TransportService(stubRoon as RoonClient, stubLogger);
  const images = new ImageService(stubRoon as RoonClient, stubLogger, '/tmp/__roon_test_img_cache__');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-test-rp-'));
  const recentlyPlayed = new RecentlyPlayedService(transport, stubLogger, {
    filePath: path.join(tmpDir, 'recently-played.json'),
  });
  await recentlyPlayed.start();
  const favorites = new FavoritesService(stubLogger, {
    filePath: path.join(tmpDir, 'favorites.json'),
  });
  await favorites.start();
  const app = createHttpApp(
    stubRoon as RoonClient,
    transport,
    images,
    recentlyPlayed,
    favorites,
    stubLogger,
    {
      // No catalog method should run while the Roon stub is unpaired. The
      // app-level assertion below proves that the router is mounted before
      // the generic /api 404 without inventing client-owned Core authority.
      catalogService: {} as CatalogHttpService,
      getDiagnosticCoreId: () => null,
    }
  );
  return new Promise<{
    url: string;
    close: () => Promise<void>;
    recentlyPlayed: RecentlyPlayedService;
    favorites: FavoritesService;
  }>(
    (resolve) => {
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
          recentlyPlayed,
          favorites,
        });
      });
    }
  );
}

describe('HTTP app routing', () => {
  let app: {
    url: string;
    close: () => Promise<void>;
    recentlyPlayed: RecentlyPlayedService;
    favorites: FavoritesService;
  };

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers malformed JSON bodies with 400, not 500', async () => {
    const res = await fetch(`${app.url}/api/favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"type": "track", "title": ',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('returns JSON 404 for unknown /api/* routes (does not fall through to SPA)', async () => {
    const res = await fetch(`${app.url}/api/this-route-does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Not Found');
  });

  it.each([
    '/api/browse',
    '/api/browse/load',
    '/api/browse/pop',
    '/api/browse/search',
  ])('does not expose the legacy coordinator-bypassing endpoint %s', async (route) => {
    stubRoon.getBrowse.mockClear();
    const res = await fetch(`${app.url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hierarchy: 'browse',
        input: 'query',
        multiSessionKey: 'client-owned-session',
      }),
    });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: 'Not Found' });
    expect(stubRoon.getBrowse).not.toHaveBeenCalled();
  });

  it('mounts catalog routes before the generic /api 404', async () => {
    const res = await fetch(`${app.url}/api/catalog/status`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Roon core not paired',
      details: 'CORE_UNPAIRED',
    });
  });

  it('answers /api/health with status ok + per-subsystem diagnostics', async () => {
    const res = await fetch(`${app.url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      ready: boolean;
      subsystems: {
        recently_played?: {
          ready: boolean;
          degraded: boolean;
          epoch: number;
          revision: number;
          entry_count: number;
          last_persist_error?: { message: string; ts: string };
        };
      };
    };
    expect(body.status).toBe('ok');
    expect(body.ready).toBe(true);
    expect(body.subsystems.recently_played).toBeDefined();
    expect(body.subsystems.recently_played!.ready).toBe(true);
    expect(body.subsystems.recently_played!.degraded).toBe(false);
    expect(typeof body.subsystems.recently_played!.epoch).toBe('number');
    expect(typeof body.subsystems.recently_played!.revision).toBe('number');
    expect(typeof body.subsystems.recently_played!.entry_count).toBe('number');
  });

  it('L-1: /api/health returns 503 + status degraded when recently_played is degraded', async () => {
    const svc = app.recentlyPlayed as unknown as { degraded: boolean };
    const saved = svc.degraded;
    svc.degraded = true;
    try {
      const res = await fetch(`${app.url}/api/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        status: string;
        ready: boolean;
        subsystems: { recently_played: { degraded: boolean; ready: boolean } };
      };
      expect(body.status).toBe('degraded');
      expect(body.ready).toBe(false);
      expect(body.subsystems.recently_played.degraded).toBe(true);
      expect(body.subsystems.recently_played.ready).toBe(false);
    } finally {
      svc.degraded = saved;
    }
  });

  it('L-1: /api/health surfaces last_persist_error when a persist has failed', async () => {
    // Inject a lastPersistError directly — exercising the persist
    // failure path would require either the M-3 await-persist
    // semantics (not on this branch) or filesystem patching, both
    // overkill for verifying the health serializer.
    const svc = app.recentlyPlayed as unknown as {
      lastPersistError: { message: string; ts: string } | undefined;
    };
    const saved = svc.lastPersistError;
    svc.lastPersistError = {
      message: 'ENOSPC: no space left',
      ts: '2026-05-16T16:00:00.000Z',
    };
    try {
      const res = await fetch(`${app.url}/api/health`);
      expect(res.status).toBe(200); // degraded is false; service "ready" still
      const body = (await res.json()) as {
        subsystems: {
          recently_played: {
            last_persist_error?: { message: string; ts: string };
          };
        };
      };
      expect(body.subsystems.recently_played.last_persist_error).toEqual({
        message: 'ENOSPC: no space left',
        ts: '2026-05-16T16:00:00.000Z',
      });
    } finally {
      svc.lastPersistError = saved;
    }
  });

  it('GET /api/recently-played returns the service\'s entries', async () => {
    // Inject an entry directly via the transport event the service
    // listens to. This avoids depending on the test harness having
    // a real Roon Core attached.
    const transport = (app.recentlyPlayed as any).transportService;
    transport.emit('now-playing-updated', {
      zone_id: 'zone-x',
      now_playing: {
        zone_id: 'zone-x',
        title: 'Test Track',
        artist: 'Test Artist',
        album: 'Test Album',
        state: 'playing',
      },
    });
    // The service updates the in-memory list synchronously on the
    // event, so a single tick is enough before fetching.
    await new Promise((r) => setImmediate(r));

    const res = await fetch(`${app.url}/api/recently-played`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ title: string }> };
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.entries[0].title).toBe('Test Track');
  });

  it('GET /api/recently-played returns 503 when the service is degraded', async () => {
    // Force the degraded flag (in production this happens when the
    // eager generation persist fails at startup). Routes must refuse
    // to serve from a service whose epoch isn't durable — serving
    // would let clients adopt state that can't survive a restart.
    const svc = app.recentlyPlayed as unknown as { degraded: boolean };
    const saved = svc.degraded;
    svc.degraded = true;
    try {
      const res = await fetch(`${app.url}/api/recently-played`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/degraded/i);

      const delRes = await fetch(`${app.url}/api/recently-played`, { method: 'DELETE' });
      expect(delRes.status).toBe(503);
    } finally {
      svc.degraded = saved;
    }
  });

  it('favorites: POST adds, GET lists, DELETE removes (end-to-end)', async () => {
    const addRes = await fetch(`${app.url}/api/favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'track', title: 'Hey Jude', artist: 'The Beatles' }),
    });
    expect(addRes.status).toBe(200);
    const added = (await addRes.json()) as { entries: Array<{ id: string; title: string }> };
    expect(added.entries[0].title).toBe('Hey Jude');

    const getRes = await fetch(`${app.url}/api/favorites`);
    expect(getRes.status).toBe(200);
    const listed = (await getRes.json()) as { entries: Array<{ id: string }> };
    expect(listed.entries).toHaveLength(1);

    const delRes = await fetch(
      `${app.url}/api/favorites/${encodeURIComponent(listed.entries[0].id)}`,
      { method: 'DELETE' }
    );
    expect(delRes.status).toBe(200);
    const afterDelete = (await delRes.json()) as { entries: unknown[] };
    expect(afterDelete.entries).toHaveLength(0);
  });

  it('favorites: POST rejects bad payloads with 400', async () => {
    const noTitle = await fetch(`${app.url}/api/favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'track' }),
    });
    expect(noTitle.status).toBe(400);

    const badType = await fetch(`${app.url}/api/favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'playlist', title: 'X' }),
    });
    expect(badType.status).toBe(400);
    const body = (await badType.json()) as { error: string };
    expect(body.error).toMatch(/track, album, artist/);
  });

  it('favorites: routes 503 when the service is degraded', async () => {
    const svc = app.favorites as unknown as { degraded: boolean };
    const saved = svc.degraded;
    svc.degraded = true;
    try {
      const res = await fetch(`${app.url}/api/favorites`);
      expect(res.status).toBe(503);
      const post = await fetch(`${app.url}/api/favorites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'track', title: 'X' }),
      });
      expect(post.status).toBe(503);
    } finally {
      svc.degraded = saved;
    }
  });

  it('favorites: degraded state is surfaced by /api/health (503, ready=false)', async () => {
    // /api/favorites returning 503 while health reports 200/ready
    // would hide a down endpoint from operators.
    const svc = app.favorites as unknown as { degraded: boolean };
    const saved = svc.degraded;
    svc.degraded = true;
    try {
      const res = await fetch(`${app.url}/api/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        ready: boolean;
        subsystems: { favorites?: { ready: boolean; degraded: boolean } };
      };
      expect(body.ready).toBe(false);
      expect(body.subsystems.favorites).toEqual(
        expect.objectContaining({ ready: false, degraded: true })
      );
    } finally {
      svc.degraded = saved;
    }

    // And back to healthy once the flag clears.
    const healthy = await fetch(`${app.url}/api/health`);
    expect(healthy.status).toBe(200);
    const healthyBody = (await healthy.json()) as {
      subsystems: { favorites?: { ready: boolean } };
    };
    expect(healthyBody.subsystems.favorites).toEqual(
      expect.objectContaining({ ready: true, degraded: false })
    );
  });

  it('rate limit: artwork requests do not consume the general /api budget', async () => {
    // Dedicated app instance — this test deliberately exhausts the
    // 600/min general limiter, which would poison every later test
    // sharing the beforeAll instance (the limiter keys on IP).
    const isolated = await startApp();
    try {
      // 700 image requests: above the general cap, far below the
      // image cap. None may 429 (they may 4xx/5xx for other reasons —
      // the stub Roon has no image service — but not 429).
      const imageResults = await Promise.all(
        Array.from({ length: 700 }, (_, i) =>
          fetch(`${isolated.url}/api/image/key-${i}`).then((r) => r.status)
        )
      );
      expect(imageResults).not.toContain(429);

      // The general limiter still works: hammer a non-image endpoint
      // past 600 and expect 429s to appear.
      const coreResults = await Promise.all(
        Array.from({ length: 650 }, () =>
          fetch(`${isolated.url}/api/core`).then((r) => r.status)
        )
      );
      expect(coreResults).toContain(429);
    } finally {
      await isolated.close();
    }
  });

  it('M-4: GET /api/transport/queue/:zoneId rejects maxItems > MAX with 400', async () => {
    // Per TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS = 50_000.
    // A query that exceeds the cap must be rejected up-front so we
    // don't even attempt a multi-million-item Roon subscription.
    const res = await fetch(`${app.url}/api/transport/queue/zone-q?maxItems=999999`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/maxItems must be ≤ 50000/);
  });

  it('M-4: POST /api/transport/queue/subscribe rejects max_item_count > MAX with 400', async () => {
    const res = await fetch(`${app.url}/api/transport/queue/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ zone_id: 'zone-q', max_item_count: 999_999 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/max_item_count must be ≤ 50000/);
  });

  it('DELETE /api/recently-played wipes the list', async () => {
    // Seed one entry, confirm it lands, then DELETE and confirm empty.
    const transport = (app.recentlyPlayed as any).transportService;
    transport.emit('now-playing-updated', {
      zone_id: 'zone-y',
      now_playing: {
        zone_id: 'zone-y',
        title: 'Doomed Track',
        state: 'playing',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(app.recentlyPlayed.getEntries().length).toBeGreaterThan(0);

    const res = await fetch(`${app.url}/api/recently-played`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
    expect(app.recentlyPlayed.getEntries()).toEqual([]);
  });
});
