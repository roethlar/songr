import { describe, expect, it } from 'vitest';
import { nextBrowserTask, visitInTaskBatches } from '../cooperativeTask';

describe('cooperative full-list tasks', () => {
 it('admits an independent task between bounded batches, not just microtasks', async () => {
  const events: string[] = [];
  const work = visitInTaskBatches(['one', 'two', 'three'], item => events.push(item), { batchSize: 1 });
  setTimeout(() => events.push('input'), 0);
  await work;
  expect(events.indexOf('input')).toBeGreaterThan(events.indexOf('one'));
  expect(events.indexOf('input')).toBeLessThan(events.indexOf('two'));
  expect(events.filter(item => item !== 'input')).toEqual(['one', 'two', 'three']);
 });
 it('stops superseded work at a batch boundary without visiting discarded rows', async () => {
  const owner = new AbortController(); const seen: number[] = [];
  const work = visitInTaskBatches([1, 2, 3, 4], item => { seen.push(item); if (item === 2) owner.abort(); }, { signal: owner.signal, batchSize: 2 });
  await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  expect(seen).toEqual([1, 2]);
 });
 it('cancels a task before any list work and rejects invalid batch limits', async () => {
  const owner = new AbortController(); owner.abort();
  await expect(nextBrowserTask(owner.signal)).rejects.toMatchObject({ name: 'AbortError' });
  await expect(visitInTaskBatches([], () => {}, { batchSize: 0 })).rejects.toThrow('Invalid task batch size');
 });
});
