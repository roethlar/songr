export const DESKTOP_FRAME_P95_LIMIT_MS = 20;
export const FRAME_MAX_LIMIT_MS = 100;
export const DESKTOP_QUERY_P95_LIMIT_MS = 4;
export const WARM_HEAP_LIMIT_BYTES = 80 * 1024 * 1024;
export const RECOVERY_TOLERANCE = 0.1;

export interface DomBudgetSample {
	worldObjects: number;
	artworkImages: number;
	connectors: number;
	totalElements: number;
}

export interface FrameSummary {
	sampleCount: number;
	p50Ms: number | null;
	p95Ms: number | null;
	maxMs: number | null;
	over100Ms: number;
}

export interface LongTaskSummary {
	supported: boolean;
	count: number;
	totalMs: number;
	maxMs: number;
}

export interface DecodeSummary {
	attempted: number;
	decoded: number;
	failed: number;
	p95Ms: number | null;
	maxNaturalWidth: number;
	maxNaturalHeight: number;
}

export interface HeapReading {
	supported: boolean;
	precision: 'unavailable' | 'coarse' | 'precise';
	usedBytes: number | null;
	totalBytes: number | null;
	limitBytes: number | null;
}

export type LedgerKind =
	| 'listeners'
	| 'observers'
	| 'animationFrames'
	| 'pointerGestures'
	| 'objectUrls';

export type LedgerSnapshot = Record<LedgerKind, number>;

const emptyLedger = (): LedgerSnapshot => ({
	listeners: 0,
	observers: 0,
	animationFrames: 0,
	pointerGestures: 0,
	objectUrls: 0
});

export class RuntimeResourceLedger {
	readonly #counts = emptyLedger();

	acquire(kind: LedgerKind): () => void {
		this.#counts[kind] += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#counts[kind] = Math.max(0, this.#counts[kind] - 1);
		};
	}

	snapshot(): LedgerSnapshot {
		return { ...this.#counts };
	}

	hasRetainedResources(): boolean {
		return Object.values(this.#counts).some((count) => count !== 0);
	}
}

export function percentile(values: readonly number[], quantile: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const boundedQuantile = Math.min(1, Math.max(0, quantile));
	const index = Math.ceil(boundedQuantile * sorted.length) - 1;
	return sorted[Math.max(0, index)];
}

export function appendTimingSample(
	samples: readonly number[],
	next: number,
	captureAll: boolean,
	idleLimit = 240
): number[] {
	return captureAll ? [...samples, next] : [...samples.slice(-(idleLimit - 1)), next];
}

export function summarizeFrames(intervals: readonly number[]): FrameSummary {
	return {
		sampleCount: intervals.length,
		p50Ms: percentile(intervals, 0.5),
		p95Ms: percentile(intervals, 0.95),
		maxMs: intervals.length === 0 ? null : Math.max(...intervals),
		over100Ms: intervals.filter((interval) => interval > FRAME_MAX_LIMIT_MS).length
	};
}

export function sampleDomBudgets(root: ParentNode): DomBudgetSample {
	return {
		worldObjects: root.querySelectorAll('[data-world-object]').length,
		artworkImages: root.querySelectorAll('img[data-artwork][src]').length,
		connectors: root.querySelectorAll('[data-connector]').length,
		totalElements: root.querySelectorAll('*').length
	};
}

export function maxDomBudgets(samples: readonly DomBudgetSample[]): DomBudgetSample {
	return samples.reduce<DomBudgetSample>(
		(maximum, sample) => ({
			worldObjects: Math.max(maximum.worldObjects, sample.worldObjects),
			artworkImages: Math.max(maximum.artworkImages, sample.artworkImages),
			connectors: Math.max(maximum.connectors, sample.connectors),
			totalElements: Math.max(maximum.totalElements, sample.totalElements)
		}),
		{ worldObjects: 0, artworkImages: 0, connectors: 0, totalElements: 0 }
	);
}

export function classifyHeapPrecision(
	usedBytes: number,
	totalBytes: number
): HeapReading['precision'] {
	const coarseQuantum = 1_000_000;
	return usedBytes % coarseQuantum === 0 && totalBytes % coarseQuantum === 0
		? 'coarse'
		: 'precise';
}

export function readHeap(): HeapReading {
	const memory = (
		performance as Performance & {
			memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
		}
	).memory;

	return memory
		? {
				supported: true,
				precision: classifyHeapPrecision(memory.usedJSHeapSize, memory.totalJSHeapSize),
				usedBytes: memory.usedJSHeapSize,
				totalBytes: memory.totalJSHeapSize,
				limitBytes: memory.jsHeapSizeLimit
			}
		: {
				supported: false,
				precision: 'unavailable',
				usedBytes: null,
				totalBytes: null,
				limitBytes: null
			};
}

export async function decodeMountedArtwork(root: ParentNode): Promise<DecodeSummary> {
	const images = [...root.querySelectorAll<HTMLImageElement>('img[data-artwork][src]')];
	const timings: number[] = [];
	let decoded = 0;
	let failed = 0;

	await Promise.all(
		images.map(async (image) => {
			const startedAt = performance.now();
			try {
				await image.decode();
				decoded += 1;
			} catch {
				failed += 1;
			} finally {
				timings.push(performance.now() - startedAt);
			}
		})
	);

	return {
		attempted: images.length,
		decoded,
		failed,
		p95Ms: percentile(timings, 0.95),
		maxNaturalWidth: images.reduce((width, image) => Math.max(width, image.naturalWidth), 0),
		maxNaturalHeight: images.reduce((height, image) => Math.max(height, image.naturalHeight), 0)
	};
}

export function observeLongTasks(ledger: RuntimeResourceLedger): {
	stop: () => LongTaskSummary;
} {
	const durations: number[] = [];
	const supported =
		typeof PerformanceObserver !== 'undefined' &&
		PerformanceObserver.supportedEntryTypes?.includes('longtask');

	if (!supported) {
		return { stop: () => ({ supported: false, count: 0, totalMs: 0, maxMs: 0 }) };
	}

	const release = ledger.acquire('observers');
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) durations.push(entry.duration);
	});
	observer.observe({ entryTypes: ['longtask'] });
	let stopped = false;

	return {
		stop: () => {
			if (!stopped) {
				stopped = true;
				observer.disconnect();
				release();
			}
			return {
				supported: true,
				count: durations.length,
				totalMs: durations.reduce((total, duration) => total + duration, 0),
				maxMs: durations.length === 0 ? 0 : Math.max(...durations)
			};
		}
	};
}

export async function runFrameTrace(options: {
	durationMs?: number;
	root: ParentNode;
	ledger: RuntimeResourceLedger;
	onFrame: (progress: number) => void;
	onSample?: (sample: DomBudgetSample, progress: number) => void;
	signal?: AbortSignal;
}): Promise<{ frames: FrameSummary; domPeak: DomBudgetSample; intervals: number[] }> {
	const durationMs = options.durationMs ?? 10_000;
	const intervals: number[] = [];
	const domSamples: DomBudgetSample[] = [];
	const release = options.ledger.acquire('animationFrames');
	const releaseAbortListener = options.signal
		? options.ledger.acquire('listeners')
		: () => {};

	return new Promise((resolve, reject) => {
		let startedAt: number | null = null;
		let priorAt: number | null = null;
		let frameId = 0;
		let settled = false;

		const finish = () => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener('abort', abort);
			releaseAbortListener();
			release();
			resolve({
				frames: summarizeFrames(intervals),
				domPeak: maxDomBudgets(domSamples),
				intervals
			});
		};

		const abort = () => {
			if (settled) return;
			settled = true;
			cancelAnimationFrame(frameId);
			options.signal?.removeEventListener('abort', abort);
			releaseAbortListener();
			release();
			reject(new DOMException('Frame trace aborted', 'AbortError'));
		};

		const frame = (now: number) => {
			if (settled) return;
			startedAt ??= now;
			if (priorAt !== null) intervals.push(now - priorAt);
			priorAt = now;
			const elapsed = now - startedAt;
			const progress = Math.min(1, elapsed / durationMs);
			options.onFrame(progress);
			const domSample = sampleDomBudgets(options.root);
			domSamples.push(domSample);
			options.onSample?.(domSample, progress);

			if (elapsed < durationMs) {
				frameId = requestAnimationFrame(frame);
				return;
			}

			finish();
		};

		if (options.signal?.aborted) {
			abort();
			return;
		}
		options.signal?.addEventListener('abort', abort, { once: true });
		frameId = requestAnimationFrame(frame);
	});
}

export function sanitizedBrowserProfile(): Record<string, string | number | boolean | null> {
	const nav = navigator as Navigator & { deviceMemory?: number };
	return {
		userAgent: nav.userAgent,
		platform: nav.platform,
		hardwareConcurrency: nav.hardwareConcurrency,
		deviceMemoryGiB: nav.deviceMemory ?? null,
		viewportWidth: window.innerWidth,
		viewportHeight: window.innerHeight,
		devicePixelRatio: window.devicePixelRatio,
		heapApiSupported: readHeap().supported
	};
}

export function exportMetrics(
	filename: string,
	payload: unknown,
	ledger: RuntimeResourceLedger
): void {
	const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
	const release = ledger.acquire('objectUrls');
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	URL.revokeObjectURL(url);
	release();
}
