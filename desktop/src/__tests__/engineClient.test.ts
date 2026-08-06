import { EngineTrayClient } from '../engineClient';
import type { TraySocket } from '../engineClient';
import { TrayZoneTracker } from '../trayModel';

/**
 * A stand-in for the Socket.IO client: it records what was emitted and lets a
 * test push server events in. Nothing here binds a port or starts a server.
 */
class FakeSocket implements TraySocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  disconnectCalls = 0;
  readonly #listeners = new Map<string, ((payload: unknown) => void)[]>();

  on(event: string, listener: (payload: unknown) => void): unknown {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(listener);
    this.#listeners.set(event, existing);
    return this;
  }

  emit(event: string, payload: unknown): unknown {
    this.emitted.push({ event, payload });
    return this;
  }

  disconnect(): unknown {
    this.disconnectCalls += 1;
    return this;
  }

  /** Deliver a server → client event. */
  receive(event: string, payload?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

const wireZone = (zoneId: string, state: string): unknown => ({
  zone_id: zoneId,
  display_name: zoneId,
  state,
  is_play_allowed: state !== 'playing',
  is_pause_allowed: state === 'playing',
  is_next_allowed: true,
  is_previous_allowed: true,
});

interface Harness {
  readonly client: EngineTrayClient;
  readonly tracker: TrayZoneTracker;
  readonly sockets: FakeSocket[];
  readonly urls: string[];
  readonly changes: () => number;
  socket(): FakeSocket;
}

const makeHarness = (): Harness => {
  const tracker = new TrayZoneTracker();
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  let changes = 0;

  const client = new EngineTrayClient({
    tracker,
    onChange: () => {
      changes += 1;
    },
    createSocket: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  return {
    client,
    tracker,
    sockets,
    urls,
    changes: () => changes,
    socket: () => {
      const last = sockets[sockets.length - 1];
      if (last === undefined) {
        throw new Error('no socket was created');
      }
      return last;
    },
  };
};

describe('EngineTrayClient', () => {
  it('connects to the engine url it is given', () => {
    const h = makeHarness();
    h.client.connect('http://127.0.0.1:51234');

    expect(h.urls).toEqual(['http://127.0.0.1:51234']);
    expect(h.client.connected).toBe(true);
  });

  it('feeds the zone snapshot into the tracker', () => {
    const h = makeHarness();
    h.client.connect('http://127.0.0.1:1');

    h.socket().receive('zones', {
      zones: [wireZone('kitchen', 'stopped'), wireZone('study', 'playing')],
    });

    expect(h.tracker.targetZoneId).toBe('study');
    expect(h.changes()).toBeGreaterThan(0);
  });

  it('applies per-zone updates, removals and now-playing', () => {
    const h = makeHarness();
    h.client.connect('http://127.0.0.1:1');

    h.socket().receive('zone-updated', { zone: wireZone('study', 'playing') });
    h.socket().receive('now-playing-updated', {
      zone_id: 'study',
      now_playing: { title: 'Cirrus', artist: 'Bonobo' },
    });

    expect(h.tracker.target?.track).toEqual({ title: 'Cirrus', artist: 'Bonobo' });

    h.socket().receive('zone-removed', { zone_id: 'study' });
    expect(h.tracker.target).toBeNull();
  });

  it('ignores payloads it cannot parse', () => {
    const h = makeHarness();
    h.client.connect('http://127.0.0.1:1');
    h.socket().receive('zones', { zones: [wireZone('study', 'playing')] });
    const before = h.changes();

    h.socket().receive('zones', 'garbage');
    h.socket().receive('zone-updated', {});
    h.socket().receive('zone-removed', {});
    h.socket().receive('now-playing-updated', { now_playing: {} });

    expect(h.tracker.targetZoneId).toBe('study');
    expect(h.changes()).toBe(before);
  });

  it('sends transport commands for the selected zone', () => {
    const h = makeHarness();
    h.client.connect('http://127.0.0.1:1');
    h.socket().receive('zones', { zones: [wireZone('study', 'playing')] });

    h.client.playPause();
    h.client.next();
    h.client.previous();

    expect(h.socket().emitted).toEqual([
      { event: 'transport:play-pause', payload: { zone_id: 'study' } },
      { event: 'transport:next', payload: { zone_id: 'study' } },
      { event: 'transport:previous', payload: { zone_id: 'study' } },
    ]);
  });

  it('sends nothing when there is no zone to control', () => {
    const h = makeHarness();
    h.client.connect('http://127.0.0.1:1');

    h.client.playPause();
    h.client.next();

    expect(h.socket().emitted).toEqual([]);
  });

  it('sends nothing before it has connected', () => {
    const h = makeHarness();
    expect(() => {
      h.client.playPause();
    }).not.toThrow();
    expect(h.sockets).toHaveLength(0);
  });

  it('forgets the zones when the engine connection drops', () => {
    const h = makeHarness();
    h.client.connect('http://127.0.0.1:1');
    h.socket().receive('zones', { zones: [wireZone('study', 'playing')] });

    h.socket().receive('disconnect');

    expect(h.tracker.target).toBeNull();
  });

  it('drops the old socket when reconnecting to a relaunched engine', () => {
    const h = makeHarness();
    h.client.connect('http://127.0.0.1:1');
    const first = h.socket();
    h.socket().receive('zones', { zones: [wireZone('study', 'playing')] });

    h.client.connect('http://127.0.0.1:2');

    expect(first.disconnectCalls).toBe(1);
    expect(h.sockets).toHaveLength(2);
    // State from the previous engine must not survive into the new one.
    expect(h.tracker.target).toBeNull();
  });

  it('is safe to disconnect twice', () => {
    const h = makeHarness();
    h.client.connect('http://127.0.0.1:1');

    h.client.disconnect();
    h.client.disconnect();

    expect(h.socket().disconnectCalls).toBe(1);
    expect(h.client.connected).toBe(false);
  });
});
