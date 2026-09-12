import { nextBrowserTask, visitInTaskBatches } from './cooperativeTask';

export interface PreparedTrackRow { node: HTMLElement; destroy?: () => void }
export interface PreparedTrackListState { phase: 'preparing' | 'ready' | 'error'; prepared: number; total: number; error?: string }
export interface PreparedTrackListOptions<T extends object> {
 items: readonly T[];
 generation: object;
 createRow: (item: T) => PreparedTrackRow;
 onState: (state: PreparedTrackListState) => void;
 layoutRevision?: unknown;
 suspended?: boolean;
}
const ROWS_PER_CHUNK = 40;
const CHUNKS_PER_TASK = 4;
interface Chunk<T> { node: HTMLDivElement; items: readonly T[]; measured: boolean }

/** Full native rows, prepared once in independent fixed chunks; no scroll listener or viewport rendering. */
export function prepareTrackList<T extends object>(host: HTMLElement, initial: PreparedTrackListOptions<T>): {
 update(next: PreparedTrackListOptions<T>): void; destroy(): void;
} {
 let options = initial;
 let generation = initial.generation;
 let rows = new Map<T, PreparedTrackRow>();
 let chunks: Chunk<T>[] = [];
 let layer: HTMLDivElement | null = null;
 let operation: AbortController | null = null;
 let disposed = false;
 let width = -1;
 let layoutVersion = 0;
 let preparedLayoutVersion = -1;
 const document = host.ownerDocument;
 const original = { height: host.style.height, overflow: host.style.overflow, visibility: host.style.visibility };
 function hidden(): void {
  host.style.height = '0px'; host.style.overflow = 'hidden'; host.style.visibility = 'hidden';
  host.inert = true; host.setAttribute('aria-hidden', 'true');
 }
 function visible(): void {
  host.style.height = original.height; host.style.overflow = original.overflow; host.style.visibility = original.visibility;
  host.inert = false; host.removeAttribute('aria-hidden');
 }
 function release(retired: Map<T, PreparedTrackRow>): void {
  void visitInTaskBatches(retired, ([item, row]) => {
   row.destroy?.(); row.node.remove(); retired.delete(item);
  }).catch(() => { /* Disposal has no external action and is never cancelled. */ });
 }
 function measure(batch: Chunk<T>[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
   if (signal.aborted) { reject(signal.reason); return; }
   if (typeof ResizeObserver === 'undefined') { reject(new Error('This browser cannot prepare the complete list.')); return; }
   const sizes = new Map<Element, number>();
   const cancel = (): void => { observer.disconnect(); reject(signal.reason); };
   const observer = new ResizeObserver(entries => {
    if (signal.aborted) return;
    for (const entry of entries) {
     const value = entry.borderBoxSize[0]?.blockSize;
     if (value === undefined || !Number.isFinite(value) || value <= 0) continue;
     sizes.set(entry.target, value);
    }
    if (sizes.size !== batch.length) return;
    observer.disconnect(); signal.removeEventListener('abort', cancel);
    for (const chunk of batch) {
     chunk.node.style.containIntrinsicBlockSize = `${sizes.get(chunk.node)!}px`;
     chunk.node.style.contentVisibility = 'auto';
     chunk.measured = true;
    }
    resolve();
   });
   signal.addEventListener('abort', cancel, { once: true });
   for (const chunk of batch) {
    chunk.node.style.contentVisibility = 'visible';
    observer.observe(chunk.node, { box: 'border-box' });
   }
  });
 }
 async function prepare(forceLayout = false): Promise<void> {
  operation?.abort();
  const owner = new AbortController(); operation = owner;
  const signal = owner.signal;
  const current = options;
  if (current.suspended) { hidden(); current.onState({ phase: 'preparing', prepared: 0, total: current.items.length }); return; }
  const currentLayout = layoutVersion;
  hidden();
  current.onState({ phase: 'preparing', prepared: 0, total: current.items.length });
  if (generation !== current.generation) {
   generation = current.generation;
   const retired = rows; rows = new Map(); release(retired);
   chunks = [];
  }
  const oldLayer = layer;
  if (oldLayer) oldLayer.style.contentVisibility = 'hidden';
  const nextLayer = document.createElement('div');
  nextLayer.className = 'prepared-track-layer';
  nextLayer.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr);grid-column:1/-1;';
  host.append(nextLayer); layer = nextLayer;
  const reusable = new Map(chunks.map(chunk => [chunk.items[0], chunk]));
  const nextChunks: Chunk<T>[] = [];
  // Published incrementally for cancellation ownership, never rescanned as a growing prefix.
  chunks = nextChunks;
  try {
   await nextBrowserTask(signal);
   for (let offset = 0; offset < current.items.length;) {
    const pending: Chunk<T>[] = [];
    for (let group = 0; group < CHUNKS_PER_TASK && offset < current.items.length; group++) {
     signal.throwIfAborted();
     const items = current.items.slice(offset, offset + ROWS_PER_CHUNK);
     let chunk = reusable.get(items[0]);
     if (!chunk || chunk.items.length !== items.length || !items.every((item, index) => chunk!.items[index] === item)) {
      const node = document.createElement('div');
      node.className = 'prepared-track-chunk';
      node.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr);contain:layout style paint;overflow-clip-margin:280px;';
      chunk = { node, items, measured: false };
      for (const item of items) {
       let row = rows.get(item);
       if (!row) { row = current.createRow(item); rows.set(item, row); }
       node.append(row.node);
      }
     }
     nextLayer.append(chunk.node); nextChunks.push(chunk);
     if (forceLayout || preparedLayoutVersion !== currentLayout || !chunk.measured) pending.push(chunk);
     offset += items.length;
    }
    if (pending.length) await measure(pending, signal);
    signal.throwIfAborted();
    current.onState({ phase: 'preparing', prepared: Math.min(offset, current.items.length), total: current.items.length });
    await nextBrowserTask(signal);
   }
   signal.throwIfAborted();
   oldLayer?.remove();
   preparedLayoutVersion = currentLayout;
   visible();
   current.onState({ phase: 'ready', prepared: current.items.length, total: current.items.length });
  } catch (error) {
   if (signal.aborted || disposed) { oldLayer?.remove(); return; }
   current.onState({ phase: 'error', prepared: 0, total: current.items.length, error: error instanceof Error ? error.message : 'The list could not be prepared.' });
  }
 }
 const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
  for (const entry of entries) {
   const nextWidth = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
   if (Math.abs(nextWidth - width) <= 0.01) continue;
   const initialWidth = width < 0; width = nextWidth;
   if (!initialWidth && !disposed) { layoutVersion++; void prepare(true); }
  }
 });
 resize?.observe(host, { box: 'border-box' });
 const fonts = (): void => { if (!disposed) { layoutVersion++; void prepare(true); } };
 document.fonts?.addEventListener('loadingdone', fonts);
 void prepare();
 return {
  update(next) {
   const changed = options.items !== next.items || options.generation !== next.generation || options.suspended !== next.suspended || !Object.is(options.layoutRevision, next.layoutRevision);
   const layoutChanged = !Object.is(options.layoutRevision, next.layoutRevision);
   options = next;
   if (layoutChanged) layoutVersion++;
   if (changed && !disposed) void prepare(layoutChanged);
  },
  destroy() {
   disposed = true; operation?.abort(); hidden(); resize?.disconnect();
   document.fonts?.removeEventListener('loadingdone', fonts);
   const retired = rows; rows = new Map(); chunks = []; release(retired);
  }
 };
}
