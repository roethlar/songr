import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { DEFAULT_PRESENTATION_SETTINGS, resolvePresentationSettings, type PresentationSettingsSnapshot } from '@shared/presentationSettings';
import { createPresentationSettingsStore, presentationSettingsStore, bindDocumentPresentation, getEffectiveMotion } from '../presentationSettingsStore';
function snapshot(revision = 1, choices: Partial<PresentationSettingsSnapshot> = {}): PresentationSettingsSnapshot {
  return { ...DEFAULT_PRESENTATION_SETTINGS, revision, ...choices };
}
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { presentationSettingsStore.reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('confirmed server appearance preferences', () => {
  it('uses icons and no motion before hydration without writing defaults', async () => {
    const store = createPresentationSettingsStore();
    expect(resolvePresentationSettings(get(store).snapshot, false)).toEqual({ actionDisplay: 'icons', smoothScroll: false, interfaceMotion: false });
    const fetchFn = vi.fn(async () => response(snapshot(7, { actionDisplay: 'text' }))) as unknown as typeof fetch;
    await store.load(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('/api/settings/presentation', expect.objectContaining({ credentials: 'include', cache: 'no-store' }));
    expect(get(store).snapshot?.actionDisplay).toBe('text');
  });
  it('retains unrelated choices and waits for durable confirmation before changing the UI', async () => {
    const store = createPresentationSettingsStore(), pending = deferred<Response>();
    store.applySnapshot(snapshot(2, { smoothScroll: false }));
    const fetchFn = vi.fn(() => pending.promise) as unknown as typeof fetch;
    const saving = store.update({ actionDisplay: 'both' }, fetchFn);
    expect(get(store)).toMatchObject({ saving: true, snapshot: snapshot(2, { smoothScroll: false }) });
    expect(JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ expectedRevision: 2, actionDisplay: 'both', smoothScroll: false, interfaceMotion: true });
    pending.resolve(response(snapshot(3, { actionDisplay: 'both', smoothScroll: false })));
    expect(await saving).toBe(true); expect(get(store).snapshot?.actionDisplay).toBe('both');
  });
  it('does not let delayed GET or save responses replace a newer broadcast', async () => {
    const store = createPresentationSettingsStore(), read = deferred<Response>(), write = deferred<Response>();
    store.applySnapshot(snapshot(1));
    const reading = store.load(vi.fn(() => read.promise) as unknown as typeof fetch);
    const saving = store.update({ actionDisplay: 'text' }, vi.fn(() => write.promise) as unknown as typeof fetch);
    store.applySnapshot(snapshot(5, { interfaceMotion: false }));
    read.resolve(response(snapshot(2))); write.resolve(response(snapshot(2, { actionDisplay: 'text' })));
    await Promise.all([reading, saving]);
    expect(get(store).snapshot).toEqual(snapshot(5, { interfaceMotion: false }));
  });
  it('shows a conflict snapshot without retrying or overwriting the other client', async () => {
    const store = createPresentationSettingsStore(); store.applySnapshot(snapshot(1));
    const latest = snapshot(2, { smoothScroll: false });
    const fetchFn = vi.fn(async () => response({ current: latest }, 409)) as unknown as typeof fetch;
    expect(await store.update({ actionDisplay: 'both' }, fetchFn)).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(get(store).snapshot).toEqual(latest);
    expect(get(store).notice).toContain('not saved');
  });
  it.each([
    [response({ error: 'disk full' }, 500)],
    [response(snapshot(1, { actionDisplay: 'both' }))],
    [response(snapshot(2, { actionDisplay: 'text' }))],
    [response({ ...snapshot(2, { actionDisplay: 'both' }), selectionMode: 'checkbox' })],
  ])('does not claim an unconfirmed or malformed save succeeded', async reply => {
    const store = createPresentationSettingsStore(); store.applySnapshot(snapshot(1));
    expect(await store.update({ actionDisplay: 'both' }, vi.fn(async () => reply) as unknown as typeof fetch)).toBe(false);
    expect(get(store).snapshot).toEqual(snapshot(1)); expect(get(store).error).toContain('not saved');
  });
  it('ignores invalid, equal and older broadcasts', () => {
    const store = createPresentationSettingsStore(); store.applySnapshot(snapshot(4));
    for (const value of [snapshot(4, { smoothScroll: false }), snapshot(3), { ...snapshot(5), extra: true }, { ...snapshot(5), interfaceMotion: 'false' }])
      expect(store.applySnapshot(value)).toBe(false);
    expect(get(store).snapshot).toEqual(snapshot(4));
  });
  it('discards in-flight results after its server context is reset', async () => {
    const store = createPresentationSettingsStore(), pending = deferred<Response>();
    const loading = store.load(vi.fn(() => pending.promise) as unknown as typeof fetch);
    store.reset(); pending.resolve(response(snapshot(10))); await loading;
    expect(get(store).snapshot).toBeNull();
  });
  it('validates updates before requests and refuses updates before hydration', async () => {
    const store = createPresentationSettingsStore(), fetchFn = vi.fn() as unknown as typeof fetch;
    expect(await store.update({ actionDisplay: 'text' }, fetchFn)).toBe(false);
    store.applySnapshot(snapshot(1));
    expect(await store.update({ smoothScroll: 'false' } as never, fetchFn)).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
describe('device motion overrides', () => {
  it('honors independent saved flags and OS suppression without rewriting the snapshot', () => {
    const saved = snapshot(3, { actionDisplay: 'both', smoothScroll: true, interfaceMotion: false });
    expect(resolvePresentationSettings(saved, false)).toEqual({ actionDisplay: 'both', smoothScroll: true, interfaceMotion: false });
    expect(resolvePresentationSettings(saved, true)).toEqual({ actionDisplay: 'both', smoothScroll: false, interfaceMotion: false });
    expect(saved.smoothScroll).toBe(true);
  });
  it('updates document-wide attributes live when server or OS preferences change', () => {
    const listeners = new Set<() => void>();
    const query = { matches: false, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
    vi.stubGlobal('matchMedia', vi.fn(() => query));
    presentationSettingsStore.reset();
    const root = document.createElement('html'), stop = bindDocumentPresentation(root);
    expect(root.dataset).toMatchObject({ actionDisplay: 'icons', smoothScroll: 'off', interfaceMotion: 'off' });
    presentationSettingsStore.applySnapshot(snapshot(1, { actionDisplay: 'both' }));
    expect(root.dataset).toMatchObject({ actionDisplay: 'both', smoothScroll: 'on', interfaceMotion: 'on' });
    query.matches = true; listeners.forEach(listener => listener());
    expect(root.dataset).toMatchObject({ smoothScroll: 'off', interfaceMotion: 'off' });
    expect(getEffectiveMotion()).toEqual({ smoothScroll: false, interfaceMotion: false });
    expect(get(presentationSettingsStore).snapshot?.interfaceMotion).toBe(true);
    query.matches = false; listeners.forEach(listener => listener());
    expect(root.dataset.interfaceMotion).toBe('on'); stop(); expect(listeners.size).toBe(0);
  });
});
