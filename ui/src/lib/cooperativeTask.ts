/** A real task boundary: Promise.resolve/tick/microtasks do not admit input or paint. */
export function nextBrowserTask(signal?: AbortSignal): Promise<void> {
 return new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); return; }
  const cancel = (): void => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, 0);
  signal?.addEventListener('abort', cancel, { once: true });
 });
}

export async function visitInTaskBatches<T>(items: Iterable<T>, visit: (item: T) => void,
 options: { signal?: AbortSignal; batchSize?: number; yieldTask?: (signal?: AbortSignal) => Promise<void> } = {}): Promise<void> {
 const size = options.batchSize ?? 128;
 if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid task batch size');
 const yieldTask = options.yieldTask ?? nextBrowserTask;
 let count = 0;
 await yieldTask(options.signal);
 for (const item of items) {
  options.signal?.throwIfAborted();
  visit(item);
  if (++count === size) { count = 0; await yieldTask(options.signal); }
 }
 options.signal?.throwIfAborted();
}
