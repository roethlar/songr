import { createRawSnippet, mount, tick } from 'svelte';
import Layout from '../../src/routes/+layout.svelte';
import { claimLibraryViewHost } from '../../src/lib/stores/libraryViewHostStore';
import { __setTestPageStore } from '../../src/test/app-stubs/stores';
import { getSocket } from '../../src/lib/socket/client';
import { DEFAULT_NAVIGATION_SETTINGS } from '@shared/navigationSettings';
import type { Zone } from '@shared/types';

// Exercise the production outer layout and its real host-claim contract. Only
// server data and SvelteKit's page store are fixture-owned; no full-bleed CSS,
// shell-contract override, or replacement playback footer is injected.
const groupedZone: Zone = {
  zone_id: 'fixture-zone', display_name: 'Living Room and Kitchen', state: 'stopped', seek_position: 0,
  is_play_allowed: true, is_pause_allowed: false, is_previous_allowed: true,
  is_next_allowed: true, is_seek_allowed: false,
  outputs: [
    { output_id: 'fixture-living-room', display_name: 'Living Room', volume: { type: 'number', min: 0, max: 100, value: 35, step: 1, is_muted: false } },
    { output_id: 'fixture-kitchen', display_name: 'Kitchen' }
  ]
};
const grouped = new URL(window.location.href).searchParams.get('grouped') === '1';
const fixtureResponses: Record<string, unknown> = {
  '/api/core': { status: 'paired', core: { id: 'shell-fixture', displayName: 'Fixture Core' } },
  '/api/zones': { zones: grouped ? [groupedZone] : [] },
  '/api/recently-played': { epoch: 1, revision: 0, entries: [] },
  '/api/favorites': { entries: [] },
  '/api/health': { ready: true, subsystems: {} },
  '/api/settings/navigation': DEFAULT_NAVIGATION_SETTINGS,
  '/api/onboarding': { everPaired: true, hostname: 'shell-fixture' }
};
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const value = input instanceof Request ? input.url : input.toString();
  const url = new URL(value, window.location.href);
  if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
    if (!(url.pathname in fixtureResponses)) throw new Error(`Unexpected fixture API: ${url.pathname}`);
    return new Response(JSON.stringify(fixtureResponses[url.pathname]), {
      headers: { 'content-type': 'application/json' }
    });
  }
  return originalFetch(input, init);
};
// No live engine is involved. Stop the real Socket.IO client's automatic
// connection before mounting; the footer's presentation does not need a Core.
getSocket()?.disconnect();

const initial = new URL(window.location.href);
if (initial.searchParams.has('path')) {
  const target = new URL(initial.searchParams.get('path')!, initial);
  target.searchParams.set('shell', '1');
  window.history.replaceState({}, '', target);
}
__setTestPageStore(window.location.href);
const host = claimLibraryViewHost();
if (initial.searchParams.get('active') !== '0') host.publishActiveMode('unified');
const children = createRawSnippet(() => ({
  render: () => '<section data-testid="shell-route-child" style="display:flex;flex-direction:column;background:var(--songr-bg)"><div data-testid="shell-route-heading">Library route content</div></section>'
}));
mount(Layout, { target: document.getElementById('app')!, props: { children } });

window.appShellFixture = {
  async navigate(pathname: string) {
    const url = new URL(pathname, window.location.href);
    url.searchParams.set('shell', '1');
    window.history.pushState({}, '', url);
    __setTestPageStore(window.location.href);
    await tick();
  },
  async setActive(active: boolean) {
    host.publishActiveMode(active ? 'unified' : null);
    await tick();
  },
  async releaseHost() { host.release(); await tick(); }
};
await tick();
document.documentElement.dataset.fixtureReady = 'true';

declare global {
  interface Window {
    appShellFixture: {
      navigate(pathname: string): Promise<void>;
      setActive(active: boolean): Promise<void>;
      releaseHost(): Promise<void>;
    };
  }
}
