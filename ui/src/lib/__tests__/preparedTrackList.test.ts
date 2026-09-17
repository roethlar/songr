import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/svelte';
import { prepareTrackList } from '../preparedTrackList';
import { installLibraryLayout } from '../../test/libraryLayout';

describe('prepared track list ownership', () => {
 let layout: ReturnType<typeof installLibraryLayout>;
 let host: HTMLDivElement;
 beforeEach(() => {
  layout = installLibraryLayout({ autoMeasure: false });
  host = document.createElement('div');
  document.body.append(host);
 });
 afterEach(() => { host.remove(); layout.restore(); });

 it('ignores measurements delivered after replacement and exposes only the complete replacement', async () => {
  const released = vi.fn();
  const oldState = vi.fn();
  const nextState = vi.fn();
  const createRow = (item: { title: string }) => {
   const node = document.createElement('button'); node.textContent = item.title;
   return { node, destroy: () => released(item) };
  };
  const oldItem = { title: 'Old row' };
  const list = prepareTrackList(host, { items: [oldItem], generation: {}, createRow, onState: oldState });
  await waitFor(() => expect(host.querySelector('.prepared-track-chunk')).not.toBeNull());
  const staleDelivery = layout.captureDelivery();
  list.update({ items: [{ title: 'Replacement' }], generation: {}, createRow, onState: nextState });
  await waitFor(() => expect(released).toHaveBeenCalledWith(oldItem));
  await waitFor(() => expect(host.textContent).toContain('Replacement'));
  staleDelivery();
  expect(host).toHaveAttribute('aria-hidden', 'true');
  expect(oldState.mock.calls.some(([state]) => state.phase === 'ready')).toBe(false);
  expect(nextState.mock.calls.some(([state]) => state.phase === 'ready')).toBe(false);
  layout.flush();
  await waitFor(() => expect(nextState).toHaveBeenLastCalledWith({ phase: 'ready', prepared: 1, total: 1 }));
  expect(host).not.toHaveAttribute('aria-hidden');
  expect(host.textContent).toBe('Replacement');
  list.destroy();
  await waitFor(() => expect(released).toHaveBeenCalledTimes(2));
 });

 it('disposes every prepared row once and ignores queued measurements after disposal', async () => {
  const released = vi.fn();
  const onState = vi.fn();
  const list = prepareTrackList(host, { items: Array.from({ length: 81 }, (_, index) => ({ index })), generation: {}, onState,
   createRow: item => ({ node: document.createElement('button'), destroy: () => released(item.index) }) });
  await waitFor(() => expect(host.querySelectorAll('button')).toHaveLength(81));
  const staleDelivery = layout.captureDelivery();
  list.destroy();
  const callsAtDisposal = onState.mock.calls.length;
  staleDelivery();
  await waitFor(() => expect(released).toHaveBeenCalledTimes(81));
  expect(new Set(released.mock.calls.map(([index]) => index)).size).toBe(81);
  expect(onState).toHaveBeenCalledTimes(callsAtDisposal);
  expect(host).toHaveAttribute('aria-hidden', 'true');
  expect(host.querySelectorAll('button')).toHaveLength(0);
 });
});
