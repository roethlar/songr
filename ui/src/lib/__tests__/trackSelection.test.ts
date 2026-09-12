import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createTrackSelection } from '../trackSelection';

describe('exact current track selection', () => {
 it('acts top-to-bottom in current order, not selection order or matching labels', () => {
  const first = { title: 'Duplicate' }, second = { title: 'Duplicate' }, last = { title: 'Last' };
  const selection = createTrackSelection<typeof first>();
  const rows = [first, second, last];
  selection.retain(rows, {});
  selection.toggle(last, rows); selection.toggle(first, rows); selection.toggle(second, rows);
  expect(selection.ordered([second, first, last])).toEqual([second, first, last]);
  expect(selection.ordered(rows)[1]).toBe(second);
 });
 it('supports ranges while preserving selections hidden by a filter', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ index }));
  const selection = createTrackSelection<typeof rows[number]>();
  selection.retain(rows, {});
  selection.toggle(rows[0], rows); selection.toggle(rows[3], rows, true);
  expect(selection.ordered(rows)).toEqual(rows.slice(0, 4));
  selection.selectAll([rows[4]]);
  expect(get(selection).count).toBe(5);
  selection.toggle(rows[1], rows, true);
  expect(selection.ordered(rows)).toEqual([rows[0], rows[4]]);
 });
 it('keeps exact valid objects through ordering/filtering and clears a replacement generation', () => {
  const a = {}, b = {}, generation = {};
  const selection = createTrackSelection<object>();
  selection.retain([a, b], generation); selection.toggle(b, [a, b]);
  selection.retain([b, a], generation);
  expect(selection.ordered([b, a])).toEqual([b]);
  selection.retain([b, a], {});
  expect(get(selection).count).toBe(0);
 });
 it('retires selected objects without transferring selection to equal metadata', () => {
  const old = { title: 'Same' }, replacement = { title: 'Same' }, generation = {};
  const selection = createTrackSelection<typeof old>();
  selection.retain([old], generation); selection.toggle(old, [old]);
  const snapshot = get(selection);
  selection.retain([replacement], generation);
  expect(get(selection).count).toBe(0);
  selection.toggle(old, [old]);
  expect(get(selection).count).toBe(0);
  expect(snapshot.selected.has(old)).toBe(true);
 });
 it('selects only matching valid rows and clears both the selection and range anchor', () => {
  const a = {}, b = {}, stale = {};
  const selection = createTrackSelection<object>();
  selection.retain([a, b], {}); selection.selectAll([a, stale]);
  expect(selection.ordered([a, b, stale])).toEqual([a]);
  selection.clear(); selection.toggle(b, [a, b], true);
  expect(selection.ordered([a, b])).toEqual([b]);
 });
});

describe('gold-title native activation', () => {
 const cleanups: Array<() => void> = [];
 afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
 });
 function fixture(count = 2) {
  const rows = Array.from({ length: count }, (_, index) => ({ title: `Track ${index + 1}` }));
  const generation = {};
  const selection = createTrackSelection<typeof rows[number]>();
  selection.retain(rows, generation);
  const container = document.createElement('div');
  document.body.append(container);
  const controls = rows.map(item => {
   const row = document.createElement('div');
   row.setAttribute('role', 'listitem');
   const title = document.createElement('button');
   title.dataset.trackSelectTarget = '';
   title.textContent = item.title;
   row.append(title); container.append(row);
   const binding = selection.row(row, { item, ordered: () => rows, generation });
   cleanups.push(() => binding.destroy());
   return { row, title, binding };
  });
  return { rows, generation, selection, container, controls };
 }
 function pointer(target: Element, type: string, options: { id?: number; x?: number; y?: number; primary?: boolean } = {}) {
  // PointerEvent is absent in some jsdom versions. The selection action consumes
  // these native event fields, without involving a rendered Svelte component.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: options.x ?? 20, clientY: options.y ?? 20, button: 0 });
  Object.defineProperties(event, {
   pointerId: { value: options.id ?? 1 },
   isPrimary: { value: options.primary ?? true },
   pointerType: { value: 'touch' }
  });
  target.dispatchEvent(event);
  return event;
 }
 function click(target: Element, detail = 1) {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
 }
 function tap(target: Element) {
  pointer(target, 'pointerdown'); pointer(target, 'pointerup'); click(target);
 }
 it('toggles distinct titles with ordinary taps and exposes pressed state without changing list roles', () => {
  const { rows, selection, controls } = fixture();
  tap(controls[1].title); tap(controls[0].title);
  expect(selection.ordered(rows)).toEqual(rows);
  expect(controls[0].row).toHaveClass('is-track-selected');
  expect(controls[0].title).toHaveAttribute('aria-pressed', 'true');
  expect(controls[0].row).toHaveAttribute('role', 'listitem');
  tap(controls[1].title);
  expect(selection.ordered(rows)).toEqual([rows[0]]);
  expect(controls[1].title).toHaveAttribute('aria-pressed', 'false');
 });
 it('accepts native keyboard or assistive activation without pointer events and suppresses held-key repeats', () => {
  const { rows, selection, controls } = fixture();
  click(controls[0].title, 0);
  expect(selection.ordered(rows)).toEqual([rows[0]]);
  const repeat = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', repeat: true });
  controls[0].title.dispatchEvent(repeat);
  expect(repeat.defaultPrevented).toBe(true);
  click(controls[0].title, 0);
  expect(get(selection).count).toBe(0);
 });
 it('does not select on pointerdown or pointerup before native click', () => {
  const { selection, controls } = fixture();
  pointer(controls[0].title, 'pointerdown');
  expect(get(selection).count).toBe(0);
  pointer(controls[0].title, 'pointerup');
  expect(get(selection).count).toBe(0);
  click(controls[0].title);
  expect(get(selection).count).toBe(1);
 });
 it('rejects movement beyond 8 pixels even when the pointer returns to its start', () => {
  const { selection, controls } = fixture();
  const target = controls[0].title;
  expect(pointer(target, 'pointerdown').defaultPrevented).toBe(false);
  expect(pointer(target, 'pointermove', { y: 50 }).defaultPrevented).toBe(false);
  pointer(target, 'pointermove'); pointer(target, 'pointerup'); click(target);
  expect(get(selection).count).toBe(0);
  tap(target);
  expect(get(selection).count).toBe(1);
 });
 it('checks the release position even when no pointermove was delivered', () => {
  const { selection, controls } = fixture();
  pointer(controls[0].title, 'pointerdown');
  pointer(controls[0].title, 'pointerup', { x: 100 });
  click(controls[0].title);
  expect(get(selection).count).toBe(0);
 });
 it('rejects scrolling and a tap that merely stops recent momentum', () => {
  vi.useFakeTimers();
  const { selection, controls, container } = fixture();
  const target = controls[0].title;
  pointer(target, 'pointerdown');
  container.dispatchEvent(new Event('scroll'));
  pointer(target, 'pointerup'); click(target);
  expect(get(selection).count).toBe(0);
  vi.advanceTimersByTime(50); tap(target);
  expect(get(selection).count).toBe(0);
  vi.advanceTimersByTime(200); tap(target);
  expect(get(selection).count).toBe(1);
 });
 it('checks actual ancestor scroll offsets before a delayed scroll event arrives', () => {
  const { selection, controls, container } = fixture();
  pointer(controls[0].title, 'pointerdown');
  container.scrollTop = 30;
  pointer(controls[0].title, 'pointerup'); click(controls[0].title);
  expect(get(selection).count).toBe(0);
 });
 it('rejects scrolling that begins between pointer release and native click', () => {
  const { selection, controls, container } = fixture();
  pointer(controls[0].title, 'pointerdown'); pointer(controls[0].title, 'pointerup');
  container.dispatchEvent(new Event('scroll')); click(controls[0].title);
  expect(get(selection).count).toBe(0);
 });
 it.each(['pointercancel', 'blur'])('rejects interrupted input after %s', kind => {
  const { selection, controls } = fixture();
  const target = controls[0].title;
  pointer(target, 'pointerdown');
  if (kind === 'blur') window.dispatchEvent(new Event('blur'));
  else pointer(target, kind);
  pointer(target, 'pointerup'); click(target);
  expect(get(selection).count).toBe(0);
  tap(target);
  expect(get(selection).count).toBe(1);
 });
 it('cancels both fingers when a second touch starts outside the track list', () => {
  const { selection, controls } = fixture();
  pointer(controls[0].title, 'pointerdown');
  pointer(document.body, 'pointerdown', { id: 2, primary: false });
  pointer(document.body, 'pointerup', { id: 2, primary: false });
  pointer(controls[0].title, 'pointerup'); click(controls[0].title);
  expect(get(selection).count).toBe(0);
 });
 it('preserves nested navigation/action controls instead of treating them as row selection', () => {
  const { selection, controls } = fixture();
  const button = document.createElement('button');
  controls[0].row.append(button);
  const run = vi.fn(); button.addEventListener('click', run);
  tap(button);
  expect(run).toHaveBeenCalledOnce();
  expect(get(selection).count).toBe(0);
 });
 it('rechecks dynamic busy state and current generation at release and activation', () => {
  const { rows, generation, selection, controls } = fixture();
  let busy = false;
  controls[0].binding.update({ item: rows[0], ordered: () => rows, generation, disabled: () => busy });
  pointer(controls[0].title, 'pointerdown'); busy = true;
  pointer(controls[0].title, 'pointerup'); click(controls[0].title);
  expect(get(selection).count).toBe(0);
  busy = false;
  pointer(controls[0].title, 'pointerdown'); selection.retain(rows, {});
  pointer(controls[0].title, 'pointerup'); click(controls[0].title);
  click(controls[0].title, 0);
  expect(get(selection).count).toBe(0);
  expect(controls[0].title).toHaveAttribute('aria-disabled', 'true');
 });
 it('invalidates an in-flight gesture when a row binding changes to another item', () => {
  const { rows, generation, selection, controls } = fixture();
  pointer(controls[0].title, 'pointerdown');
  controls[0].binding.update({ item: rows[1], ordered: () => rows, generation });
  pointer(controls[0].title, 'pointerup'); click(controls[0].title);
  expect(get(selection).count).toBe(0);
 });
 it('paints large all/clear changes incrementally and retains exact state before paint completes', () => {
  vi.useFakeTimers();
  const { rows, selection, controls } = fixture(300);
  selection.selectAll(rows);
  expect(get(selection).count).toBe(300);
  expect(controls[299].title).toHaveAttribute('aria-pressed', 'false');
  vi.runAllTimers();
  expect(controls.every(({ title }) => title.getAttribute('aria-pressed') === 'true')).toBe(true);
  selection.clear();
  expect(get(selection).count).toBe(0);
  vi.runAllTimers();
  expect(controls.every(({ title }) => title.getAttribute('aria-pressed') === 'false')).toBe(true);
 });
});
