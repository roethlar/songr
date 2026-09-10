import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtworkResult } from '../artworkRequests';
import { libraryArtwork } from '../actions/libraryArtwork';
import { PREPARED_LIBRARY_GRID_EVENT } from '../preparedLibraryGrid';

const requests = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../artworkRequests', () => ({ artworkRequests: requests }));
let observerCallback: IntersectionObserverCallback;
let observers: Array<{
	callback: IntersectionObserverCallback;
	observe: ReturnType<typeof vi.fn>;
	unobserve: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
}>;
let calls: Array<{ url: string; complete(result: ArtworkResult): void; dispose: ReturnType<typeof vi.fn> }>;
let node: HTMLImageElement;
let cleanup: (() => void) | undefined;
const rect = { top: 10, bottom: 110, left: 0, right: 100, width: 100, height: 100 } as DOMRect;
function intersects(visible: boolean) {
	observerCallback([{ target: node, isIntersecting: visible, boundingClientRect: rect, intersectionRatio: visible ? 1 : 0, intersectionRect: rect, rootBounds: rect, time: 0 }], {} as IntersectionObserver);
}
function imageEvent(type: 'load' | 'error', source: string, naturalWidth: number) {
	Object.defineProperty(node, 'currentSrc', { configurable: true, value: new URL(source, document.baseURI).href });
	Object.defineProperty(node, 'naturalWidth', { configurable: true, value: naturalWidth });
	node.dispatchEvent(new Event(type));
}

beforeEach(() => {
	vi.useFakeTimers();
	calls = [];
	requests.request.mockImplementation((url, _priority, complete) => {
		const dispose = vi.fn();
		calls.push({ url, complete, dispose });
		return { dispose, priority: vi.fn() };
	});
	observers = [];
	vi.stubGlobal('IntersectionObserver', class {
		observe = vi.fn();
		unobserve = vi.fn();
		disconnect = vi.fn();
		constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
			if (Array.isArray(options.threshold)) observerCallback = callback;
			observers.push({ callback, observe: this.observe, unobserve: this.unobserve, disconnect: this.disconnect });
		}
	});
	const pane = document.createElement('div');
	pane.setAttribute('data-library-scroll-pane', '');
	pane.getBoundingClientRect = () => ({ ...rect, top: 0, bottom: 600, height: 600 });
	node = document.createElement('img');
	node.getBoundingClientRect = () => rect;
	pane.append(node);
	document.body.append(pane);
});
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	document.body.replaceChildren();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('library artwork image lifecycle', () => {
	it('does not give native loading a URL until admission succeeds, then retains the cacheable URL', () => {
		const action = libraryArtwork(node, '/cover');
		cleanup = action.destroy;
		expect(node.hasAttribute('src')).toBe(false);
		intersects(true);
		expect(calls).toHaveLength(1);
		expect(node.hasAttribute('src')).toBe(false);
		calls[0].complete({ ok: true });
		expect(node.getAttribute('src')).toBe('/cover');
		imageEvent('load', '/cover', 256);
		expect(node.style.visibility).toBe('');
	});

	it('ignores old admission and native events after source replacement and disposal', () => {
		const action = libraryArtwork(node, '/old');
		cleanup = action.destroy;
		intersects(true);
		action.update('/new');
		calls[0].complete({ ok: true });
		imageEvent('load', '/old', 256);
		expect(node.hasAttribute('src')).toBe(false);
		intersects(true);
		expect(calls.map(call => call.url)).toEqual(['/old', '/new']);
		calls[1].complete({ ok: true });
		imageEvent('load', '/old', 256);
		expect(node.style.visibility).toBe('hidden');
		imageEvent('load', '/new', 256);
		expect(node.style.visibility).toBe('');
		action.update('/destroyed');
		intersects(true);
		action.destroy();
		cleanup = undefined;
		calls[2].complete({ ok: true });
		imageEvent('load', '/destroyed', 256);
		expect(node.hasAttribute('src')).toBe(false);
	});

	it('recovers native handoff errors but stops retrying persistent corrupt bytes', async () => {
		const action = libraryArtwork(node, '/corrupt');
		cleanup = action.destroy;
		intersects(true);
		for (let index = 0; index < 3; index++) {
			expect(calls).toHaveLength(index + 1);
			calls[index].complete({ ok: true });
			imageEvent('error', '/corrupt', 0);
			await vi.advanceTimersByTimeAsync(500);
		}
		intersects(false);
		intersects(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(calls).toHaveLength(3);
		expect(node.style.visibility).toBe('hidden');
	});
});

function tileGrid() {
	const grid = document.createElement('div');
	const tile = document.createElement('a');
	tile.className = 'tile';
	node.replaceWith(grid);
	tile.append(node);
	grid.append(tile);
	const shadow = grid.attachShadow({ mode: 'open' });
	let assigned: HTMLSlotElement | null = null;
	Object.defineProperty(tile, 'assignedSlot', { configurable: true, get: () => assigned });
	return {
		grid,
		prepare() {
			const box = document.createElement('div');
			box.setAttribute('data-prepared-library-chunk', '');
			const slot = document.createElement('slot');
			box.append(slot);
			shadow.append(box);
			assigned = slot;
			grid.dispatchEvent(new Event(PREPARED_LIBRARY_GRID_EVENT, { bubbles: true }));
			return box;
		}
	};
}
function groupIntersection(box: HTMLElement, visible: boolean) {
	observers[1].callback([{
		target: box, isIntersecting: visible, boundingClientRect: rect,
		intersectionRatio: visible ? 1 : 0, intersectionRect: rect, rootBounds: rect, time: 0
	}], {} as IntersectionObserver);
}

describe('artwork observation of prepared chunks', () => {
	it('fine-observes images only while their already prepared chunk is nearby', async () => {
		const grid = tileGrid();
		const box = grid.prepare();
		const action = libraryArtwork(node, '/cover');
		cleanup = action.destroy;
		await vi.advanceTimersByTimeAsync(0);
		expect(observers[1].observe).toHaveBeenCalledWith(box);
		expect(observers[0].observe).not.toHaveBeenCalled();
		groupIntersection(box, true);
		expect(observers[0].observe).toHaveBeenCalledWith(node);
		intersects(true);
		expect(calls).toHaveLength(1);
		groupIntersection(box, false);
		expect(observers[0].unobserve).toHaveBeenCalledWith(node);
		expect(calls[0].dispose).toHaveBeenCalledOnce();
	});

	it('discovers later first preparation and reassignment, releasing obsolete chunk ownership', async () => {
		const grid = tileGrid();
		const action = libraryArtwork(node, '/cover');
		cleanup = action.destroy;
		await vi.advanceTimersByTimeAsync(0);
		expect(observers[0].observe).toHaveBeenCalledWith(node);
		expect(observers).toHaveLength(1);
		const first = grid.prepare();
		await vi.advanceTimersByTimeAsync(0);
		expect(observers[0].unobserve).toHaveBeenCalledWith(node);
		expect(observers[1].observe).toHaveBeenCalledWith(first);
		const second = grid.prepare();
		await vi.advanceTimersByTimeAsync(0);
		expect(observers[1].unobserve).toHaveBeenCalledWith(first);
		expect(observers[1].observe).toHaveBeenCalledWith(second);
		expect(node.isConnected).toBe(true);
		action.destroy();
		cleanup = undefined;
		expect(observers[1].unobserve).toHaveBeenCalledWith(second);
		expect(observers.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true);
	});
});
