import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { expect } from 'vitest';

/** Explicit layout inputs for behavioral tests. Browser tests own real geometry. */
export function installLibraryLayout({ toolbarWidth = 640, autoMeasure = true } = {}) {
 const originalRect = HTMLElement.prototype.getBoundingClientRect;
 const originalObserver = globalThis.ResizeObserver;
 const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
 const observers = new Set<FixtureResizeObserver>();
 let currentToolbarWidth = toolbarWidth;
 class FixtureResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe(target: Element) {
   this.targets.add(target);
   if (autoMeasure) queueMicrotask(() => { if (this.targets.has(target)) this.report(target); });
  }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); observers.delete(this); }
  report(target: Element) {
   const inlineSize = target.classList.contains('track-selection-controls') ? currentToolbarWidth : 800;
   const blockSize = Math.max(1, target.childElementCount) * 40;
   this.callback([{ target, borderBoxSize: [{ inlineSize, blockSize }],
    contentBoxSize: [{ inlineSize, blockSize }], devicePixelContentBoxSize: [],
    contentRect: { x: 0, y: 0, width: inlineSize, height: blockSize, top: 0, left: 0,
     right: inlineSize, bottom: blockSize, toJSON: () => ({}) }
   }], this);
  }
 }
 globalThis.ResizeObserver = FixtureResizeObserver;
 HTMLElement.prototype.getBoundingClientRect = function () {
  const width = this.hasAttribute('data-measure-tools') ? 72 : this.hasAttribute('data-measure-more') ? 36 : this.hasAttribute('data-measure-action') ? 80 : null;
  if (width === null) return originalRect.call(this);
  return { x: 0, y: 0, width, height: 32, top: 0, left: 0, right: width, bottom: 32, toJSON: () => ({}) };
 };
 Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() {
  return this.classList.contains('track-selection-controls') ? currentToolbarWidth : originalWidth?.get?.call(this) ?? 0;
 } });
 const captureDelivery = () => {
  const pending = [...observers].flatMap(observer => [...observer.targets].map(target => () => observer.report(target)));
  return () => { for (const deliver of pending) deliver(); };
 };
 return {
  captureDelivery,
  flush: () => captureDelivery()(),
  setToolbarWidth(width: number) { currentToolbarWidth = width; captureDelivery()(); },
  restore() {
   for (const observer of observers) observer.disconnect();
   globalThis.ResizeObserver = originalObserver;
   HTMLElement.prototype.getBoundingClientRect = originalRect;
   if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth);
   else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  }
 };
}

export async function readyBrowseRows(count?: number) {
 await waitFor(() => {
  expect(screen.getByTestId('unified-browse-list')).toHaveAttribute('aria-busy', 'false');
  if (count !== undefined) expect(screen.queryAllByTestId('unified-browse-row')).toHaveLength(count);
 });
 return screen.queryAllByTestId('unified-browse-row');
}

/** Exercise the same explicit operation in the toolbar or its responsive menu. */
export async function clickSelectionAction(name: string, buttonName = name) {
 const direct = screen.queryByRole('button', { name: buttonName });
 if (direct) { await fireEvent.click(direct); return; }
 const more = screen.getByRole('button', { name: 'More actions' });
 if (more.getAttribute('aria-expanded') !== 'true') await fireEvent.click(more);
 const menu = screen.getByRole('menu', { name: 'More actions for selection' });
 await fireEvent.click(within(menu).getByRole('menuitem', { name }));
}
