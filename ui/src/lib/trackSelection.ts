import { writable, type Readable } from 'svelte/store';

export interface TrackSelectionSnapshot<T extends object> {
 count: number;
 selected: ReadonlySet<T>;
}
export interface TrackSelectionBinding<T extends object> {
 item: T;
 ordered: () => readonly T[];
 /** A predicate gates live interaction without caching transient busy state in native inputs. */
 disabled?: boolean | (() => boolean);
 generation?: object;
}
export interface TrackSelection<T extends object> extends Readable<TrackSelectionSnapshot<T>> {
 /** Ordinary title activation toggles membership; a second activation removes it. */
 activateRow(item: T, orderedVisible: readonly T[], shift?: boolean): boolean;
 toggle(item: T, orderedVisible: readonly T[], shift?: boolean): void;
 selectAll(visible: readonly T[]): void;
 clear(): void;
 retain(valid: readonly T[], generation?: object): void;
 ordered(fullSorted: readonly T[]): T[];
 row(node: HTMLElement, options: TrackSelectionBinding<T>): { update(options: TrackSelectionBinding<T>): void; destroy(): void };
}

/** Selection is an ephemeral set of exact current objects, never a descriptor/key lookup. */
export function createTrackSelection<T extends object>(): TrackSelection<T> {
 let selected = new Set<T>();
 let anchor: T | null = null;
 let generation: object | undefined;
 let valid: Set<T> | null = null;
 let validItems: readonly T[] | undefined;
 const state = writable<TrackSelectionSnapshot<T>>({ count: 0, selected });
 type Binding = { node: HTMLElement; options: TrackSelectionBinding<T> };
 const bindings = new Map<T, Set<Binding>>();
 const pending = new Set<Binding>();
 let task: ReturnType<typeof setTimeout> | undefined;
 const authorized = (binding: Binding): boolean =>
  (binding.options.generation === undefined || binding.options.generation === generation) &&
  (valid === null || valid.has(binding.options.item));
 const current = (binding: Binding): boolean => authorized(binding) && !(typeof binding.options.disabled === 'function' ? binding.options.disabled() : binding.options.disabled);
 function paint(binding: Binding): void {
  const checked = authorized(binding) && selected.has(binding.options.item);
  binding.node.classList.toggle('is-track-selected', checked);
  const target = binding.node.querySelector<HTMLElement>('[data-track-select-target]');
  target?.setAttribute('aria-pressed', String(checked));
  target?.setAttribute('aria-disabled', String(!current(binding)));
 }
 function drain(): void {
  task = undefined;
  let count = 0;
  for (const binding of pending) {
   pending.delete(binding);
   paint(binding);
   if (++count === 128) break;
  }
  if (pending.size) task = setTimeout(drain, 0);
 }
 function changed(items: Iterable<T>): void {
  for (const item of items) for (const binding of bindings.get(item) ?? []) pending.add(binding);
  // An individual activation paints immediately; large range/all changes yield.
  if (pending.size <= 8) { for (const binding of pending) paint(binding); pending.clear(); }
  else if (task === undefined) task = setTimeout(drain, 0);
 }
 function publish(next: Set<T>): void {
  const difference = new Set<T>();
  for (const item of selected) if (!next.has(item)) difference.add(item);
  for (const item of next) if (!selected.has(item)) difference.add(item);
  selected = next;
  state.set({ count: selected.size, selected });
  changed(difference);
 }
 function toggle(item: T, orderedVisible: readonly T[], shift = false): void {
  if (valid !== null && !valid.has(item)) return;
  const next = new Set(selected);
  const from = shift && anchor ? orderedVisible.indexOf(anchor) : -1;
  const to = orderedVisible.indexOf(item);
  const checking = !next.has(item);
  if (from >= 0 && to >= 0) {
   for (let index = Math.min(from, to); index <= Math.max(from, to); index++) {
    const row = orderedVisible[index];
    if (valid !== null && !valid.has(row)) continue;
    if (checking) next.add(row); else next.delete(row);
   }
  } else if (checking) next.add(item); else next.delete(item);
  anchor = item;
  publish(next);
 }
 function activateRow(item: T, orderedVisible: readonly T[], shift = false): boolean {
  if (valid !== null && !valid.has(item)) return false;
  toggle(item, orderedVisible, shift);
  return true;
 }
 type PointerAttempt = {
  binding: Binding; item: T; x: number; y: number; cancelled: boolean; version: number;
  scroll: Array<{ node: Element; top: number; left: number }>;
 };
 const pointers = new Set<number>();
 const attempts = new Map<number, PointerAttempt>();
 const released = new WeakMap<Binding, PointerAttempt | false>();
 let boundRows = 0;
 let lastScroll = -Infinity;
 let interactionVersion = 0;
 let listeningDocument: Document | undefined;
 const now = (): number => Date.now();
 function cancelPointers(): void {
  interactionVersion++;
  for (const attempt of attempts.values()) released.set(attempt.binding, false);
  attempts.clear(); pointers.clear();
 }
 function onPointerDown(event: PointerEvent): void {
  pointers.add(event.pointerId);
  if (pointers.size > 1 || event.isPrimary === false) {
   interactionVersion++;
   for (const attempt of attempts.values()) attempt.cancelled = true;
  }
 }
 function moved(attempt: PointerAttempt, event: PointerEvent): boolean {
  return Math.hypot(event.clientX - attempt.x, event.clientY - attempt.y) > 8;
 }
 function onPointerMove(event: PointerEvent): void {
  const attempt = attempts.get(event.pointerId);
  if (attempt && moved(attempt, event)) attempt.cancelled = true;
 }
 function onPointerUp(event: PointerEvent): void {
  const attempt = attempts.get(event.pointerId);
  if (attempt) {
   const allowed = !attempt.cancelled && !moved(attempt, event) &&
    current(attempt.binding) && attempt.item === attempt.binding.options.item &&
    attempt.scroll.every(({ node, top, left }) => node.scrollTop === top && node.scrollLeft === left);
   released.set(attempt.binding, allowed ? attempt : false);
   attempts.delete(event.pointerId);
  }
  pointers.delete(event.pointerId);
 }
 function onPointerCancel(event: PointerEvent): void {
  const attempt = attempts.get(event.pointerId);
  if (attempt) released.set(attempt.binding, false);
  attempts.delete(event.pointerId); pointers.delete(event.pointerId);
 }
 function onScroll(): void {
  interactionVersion++;
  lastScroll = now();
  for (const attempt of attempts.values()) attempt.cancelled = true;
 }
 function listen(doc: Document): void {
  listeningDocument = doc;
  doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  doc.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  doc.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
  doc.addEventListener('pointercancel', onPointerCancel, { capture: true, passive: true });
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  doc.defaultView?.addEventListener('blur', cancelPointers);
 }
 function unlisten(): void {
  const doc = listeningDocument;
  doc?.removeEventListener('pointerdown', onPointerDown, true);
  doc?.removeEventListener('pointermove', onPointerMove, true);
  doc?.removeEventListener('pointerup', onPointerUp, true);
  doc?.removeEventListener('pointercancel', onPointerCancel, true);
  doc?.removeEventListener('scroll', onScroll, true);
  doc?.defaultView?.removeEventListener('blur', cancelPointers);
  listeningDocument = undefined;
  cancelPointers();
 }
 function bindNode(node: HTMLElement, options: TrackSelectionBinding<T>) {
  const binding: Binding = { node, options };
  if (boundRows++ === 0) listen(node.ownerDocument);
  const isSelectionTarget = (target: EventTarget | null): boolean => {
   if (!(target instanceof Element)) return false;
   const interactive = target.closest('a,button,input,select,textarea,label,[role="button"],[role="link"]');
   return !interactive || (node.contains(interactive) && interactive.hasAttribute('data-track-select-target'));
  };
  const register = (): void => {
   const group = bindings.get(binding.options.item) ?? new Set<Binding>();
   group.add(binding); bindings.set(binding.options.item, group); paint(binding);
  };
  const unregister = (): void => {
   const group = bindings.get(binding.options.item);
   group?.delete(binding);
   if (group?.size === 0) bindings.delete(binding.options.item);
   pending.delete(binding);
   released.delete(binding);
   for (const [id, attempt] of attempts) if (attempt.binding === binding) attempts.delete(id);
  };
  const pointerdown = (event: PointerEvent): void => {
   if (!isSelectionTarget(event.target)) return;
   released.set(binding, false);
   if (!current(binding)) return;
   const scroll: PointerAttempt['scroll'] = [];
   for (let parent: Element | null = node; parent; parent = parent.parentElement) {
    scroll.push({ node: parent, top: parent.scrollTop, left: parent.scrollLeft });
   }
   attempts.set(event.pointerId, {
    binding, item: binding.options.item, x: event.clientX, y: event.clientY, scroll, version: interactionVersion,
    // A tap that stops recent momentum must not also select the row underneath.
    cancelled: event.button !== 0 || event.isPrimary === false || pointers.size > 1 || now() - lastScroll < 180
   });
  };
  const click = (event: MouseEvent): void => {
   if (!current(binding)) { paint(binding); return; }
   if (!isSelectionTarget(event.target)) return;
   // Native keyboard and assistive activation has no preceding pointer sequence.
   const release = released.get(binding);
   if (event.detail !== 0 && (!release || release.cancelled || release.version !== interactionVersion ||
    !release.scroll.every(({ node, top, left }) => node.scrollTop === top && node.scrollLeft === left))) return;
   released.delete(binding);
   node.querySelector<HTMLElement>('[data-track-select-target]')?.focus({ preventScroll: true });
   activateRow(binding.options.item, binding.options.ordered(), event.shiftKey);
   paint(binding);
  };
  const keydown = (event: KeyboardEvent): void => {
   if (event.repeat && (event.key === 'Enter' || event.key === ' ') && isSelectionTarget(event.target)) event.preventDefault();
  };
  node.addEventListener('pointerdown', pointerdown, { passive: true });
  node.addEventListener('click', click);
  node.addEventListener('keydown', keydown);
  register();
  return {
   update(next: TrackSelectionBinding<T>) { unregister(); binding.options = next; register(); },
   destroy() {
    unregister(); node.removeEventListener('pointerdown', pointerdown);
    node.removeEventListener('click', click); node.removeEventListener('keydown', keydown);
    if (--boundRows === 0) unlisten();
   }
  };
 }
 return {
  subscribe: state.subscribe,
  activateRow,
  toggle,
  selectAll(visible) { const next = new Set(selected); for (const item of visible) if (valid === null || valid.has(item)) next.add(item); publish(next); },
  clear() { anchor = null; if (selected.size) publish(new Set()); },
  retain(items, nextGeneration) {
   if (validItems === items && generation === nextGeneration) return;
   validItems = items;
   const authorityChanged = generation !== nextGeneration;
   const replaced = nextGeneration !== undefined && generation !== undefined && authorityChanged;
   generation = nextGeneration;
   valid = new Set(items);
   if (anchor && (!valid.has(anchor) || replaced)) anchor = null;
   const next = replaced ? new Set<T>() : new Set([...selected].filter(item => valid!.has(item)));
   if (next.size !== selected.size || replaced) publish(next);
   // Existing generation-bound DOM becomes inert even when it was not checked.
   if (authorityChanged) changed(bindings.keys());
  },
  ordered(items) { return selected.size ? items.filter(item => selected.has(item)) : []; },
  row: bindNode
 };
}
