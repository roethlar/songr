/**
 * Keep every album tile in Svelte's light DOM, with its original native link.
 * Native slots divide only the paint tree into complete, bounded grid rows.
 * Every chunk is laid out before paint skipping is enabled; scrolling never
 * constructs tiles, assigns slots, or estimates their geometry.
 */
export const PREPARED_LIBRARY_GRID_EVENT = 'librarygridprepared';
const ROWS_PER_CHUNK = 40;

interface Chunk {
	box: HTMLDivElement;
	slot: HTMLSlotElement;
}

interface Grid {
	node: HTMLElement;
	revision: unknown;
	shadow: ShadowRoot | null;
	chunks: Chunk[];
	children: Element[];
	columns: number;
	widthSources: HTMLElement[];
	disposed: boolean;
}

interface WidthObservation {
	width: number;
	grids: Set<Grid>;
}

interface WidthObserver {
	observer: ResizeObserver;
	targets: Map<HTMLElement, WidthObservation>;
}

const widthObservers = new WeakMap<Document, WidthObserver>();
const pending = new Set<Grid>();
const manualSlots = new WeakMap<Document, boolean>();
let scheduled = false;
let measuring: { grids: Grid[]; cancel(): void } | null = null;

function supportsManualSlots(document: Document): boolean {
	const known = manualSlots.get(document);
	if (known !== undefined) return known;
	const probe = document.createElement('div');
	const slot = document.createElement('slot');
	let supported = false;
	if (typeof probe.attachShadow === 'function' && typeof slot.assign === 'function') {
		try {
			supported = probe.attachShadow({ mode: 'open', slotAssignment: 'manual' }).slotAssignment === 'manual';
		} catch {
			// Leave the ordinary full grid in place when manual slots are unavailable.
		}
	}
	manualSlots.set(document, supported);
	return supported;
}

function observeWidths(grid: Grid): () => void {
	if (typeof ResizeObserver === 'undefined') return () => {};
	const document = grid.node.ownerDocument;
	let shared = widthObservers.get(document);
	if (!shared) {
		const targets = new Map<HTMLElement, WidthObservation>();
		const observer = new ResizeObserver(entries => {
			const changed = new Set<Grid>();
			for (const entry of entries) {
				const target = targets.get(entry.target as HTMLElement);
				if (!target) continue;
				const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
				if (Math.abs(width - target.width) <= 0.01) continue;
				target.width = width;
				for (const affected of target.grids) changed.add(affected);
			}
			for (const affected of changed) schedule(affected);
		});
		shared = { observer, targets };
		widthObservers.set(document, shared);
	}
	for (const source of grid.widthSources) {
		let target = shared.targets.get(source);
		if (!target) {
			target = { width: -1, grids: new Set() };
			shared.targets.set(source, target);
			shared.observer.observe(source, { box: 'border-box' });
		}
		target.grids.add(grid);
	}
	return () => {
		for (const source of grid.widthSources) {
			const target = shared.targets.get(source);
			if (!target) continue;
			target.grids.delete(grid);
			if (target.grids.size === 0) {
				shared.observer.unobserve(source);
				shared.targets.delete(source);
			}
		}
	};
}

function sameRevision(before: unknown, after: unknown): boolean {
	return Object.is(before, after) || (Array.isArray(before) && Array.isArray(after) &&
		before.length === after.length && before.every((value, index) => Object.is(value, after[index])));
}

function schedule(grid: Grid): void {
	if (grid.disposed) return;
	// Even a one-column grid this small is already bounded. In particular,
	// Surprise's 24 tiles need no shadow tree or extra forced layout per redraw.
	if (grid.shadow === null && grid.node.childElementCount <= ROWS_PER_CHUNK) return;
	pending.add(grid);
	if (scheduled) return;
	scheduled = true;
	queueMicrotask(preparePendingGrids);
}

function preparePendingGrids(): void {
	scheduled = false;
	// A resize/revision may arrive before exact block sizes are delivered. Carry
	// every unfinished grid into the replacement batch; stale observers cannot
	// publish geometry or restore ancestors owned by that replacement.
	const unfinished = measuring?.grids ?? [];
	measuring?.cancel();
	const grids = [...new Set([...unfinished, ...pending])].filter(grid => !grid.disposed && grid.node.isConnected);
	pending.clear();
	if (!grids.length) return;

	// Several letter grids share retained ancestors. Open them once, preserving
	// the zero-height clipping which keeps inactive scopes out of the view.
	const panels = new Map<HTMLElement, string>();
	for (const grid of grids) {
		for (let parent: HTMLElement | null = grid.node; parent; parent = parent.parentElement) {
			if (parent.hasAttribute('data-retained-library-panel') && !panels.has(parent)) {
				panels.set(parent, parent.style.contentVisibility);
			}
		}
	}
	const restorePanels = (): void => {
		for (const [panel, previous] of panels) {
			// Visibility switches use aria-hidden, so restoring the inline override
			// respects the current scope. Do not overwrite another inline owner.
			if (panel.style.contentVisibility !== 'visible') continue;
			if (previous) panel.style.contentVisibility = previous;
			else panel.style.removeProperty('content-visibility');
		}
	};
	let waitingForSizes = false;
	try {
		for (const panel of panels.keys()) panel.style.contentVisibility = 'visible';
		for (const grid of grids) {
			for (const chunk of grid.chunks) chunk.box.style.contentVisibility = 'visible';
		}

		// Complete the reads before changing any grid. The existing CSS determines
		// the column count; fractional tracks are recalculated by the browser.
		const widths = new Map<HTMLElement, number>();
		const measureWidth = (node: HTMLElement): number => {
			const known = widths.get(node);
			if (known !== undefined) return known;
			const width = node.getBoundingClientRect().width;
			widths.set(node, width);
			// The initial ResizeObserver delivery must not repeat this preparation.
			const observed = widthObservers.get(node.ownerDocument)?.targets.get(node);
			if (observed) observed.width = width;
			return width;
		};
		const measurements = grids.map(grid => {
			const width = measureWidth(grid.node);
			for (const source of grid.widthSources) measureWidth(source);
			const tracks = getComputedStyle(grid.node).gridTemplateColumns;
			const columns = tracks && tracks !== 'none' ? tracks.trim().split(/\s+/).length : 0;
			return { grid, width, columns };
		});
		const prepared: Grid[] = [];
		for (const { grid, width, columns } of measurements) {
			if (width <= 0 || columns <= 0) continue;
			const children = Array.from(grid.node.children);
			const assignmentChanged = columns !== grid.columns || children.length !== grid.children.length ||
				children.some((child, index) => child !== grid.children[index]);
			grid.shadow ??= grid.node.attachShadow({ mode: 'open', slotAssignment: 'manual' });
			const chunkSize = columns * ROWS_PER_CHUNK;
			const count = Math.ceil(children.length / chunkSize);
			while (grid.chunks.length < count) {
				const box = grid.node.ownerDocument.createElement('div');
				box.setAttribute('data-prepared-library-chunk', '');
				box.style.cssText = 'display:grid;grid-column:1/-1;gap:inherit;overflow-clip-margin:24px;';
				const slot = grid.node.ownerDocument.createElement('slot');
				slot.style.display = 'contents';
				box.append(slot);
				grid.shadow.append(box);
				grid.chunks.push({ box, slot });
			}
			for (let index = 0; index < count; index++) {
				const chunk = grid.chunks[index];
				chunk.box.style.gridTemplateColumns = `repeat(${columns},minmax(0,1fr))`;
				if (assignmentChanged) chunk.slot.assign(...children.slice(index * chunkSize, (index + 1) * chunkSize));
			}
			while (grid.chunks.length > count) {
				const chunk = grid.chunks.pop()!;
				chunk.slot.assign();
				chunk.box.remove();
			}
			grid.children = children;
			grid.columns = columns;
			prepared.push(grid);
		}

		// Viewport DOMRects lose fractional precision at million-pixel scroll
		// coordinates. ResizeObserver reports the exact layout block size instead.
		// Keep these boxes laid out until that pre-paint delivery, then disconnect:
		// scrolling must never cause application measurement or style mutations.
		const boxes = prepared.flatMap(grid => grid.chunks.map(chunk => chunk.box));
		if (boxes.length === 0) return;
		const heights = new Map<Element, number>();
		const observer = new ResizeObserver(entries => {
			if (measuring !== batch) return;
			for (const entry of entries) {
				heights.set(entry.target, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
			}
			if (heights.size !== boxes.length) return;
			observer.disconnect();
			measuring = null;
			try {
				for (const box of boxes) {
					// No padding/border: the observed block size is the intrinsic
					// content height. Numeric sizes cannot retain stale `auto` memory.
					box.style.containIntrinsicBlockSize = `${heights.get(box)!}px`;
					box.style.contentVisibility = 'auto';
				}
				for (const grid of prepared) {
					grid.node.dispatchEvent(new Event(PREPARED_LIBRARY_GRID_EVENT, { bubbles: true }));
				}
			} finally { restorePanels(); }
		});
		const batch = { grids: prepared, cancel(): void {
			observer.disconnect();
			if (measuring === batch) measuring = null;
			restorePanels();
		} };
		measuring = batch;
		for (const box of boxes) observer.observe(box, { box: 'border-box' });
		waitingForSizes = true;
	} finally {
		if (!waitingForSizes) restorePanels();
	}
}

export function prepareLibraryGrid(node: HTMLElement, revision: unknown): {
	update(revision: unknown): void;
	destroy(): void;
} {
	if (typeof ResizeObserver === 'undefined' || !supportsManualSlots(node.ownerDocument)) return { update() {}, destroy() {} };
	// A skipped inactive grid does not receive ResizeObserver updates. Its
	// scrolling pane stays laid out, so observe that available-width boundary
	// too, and refresh hidden geometry before the owner returns to the scope.
	const pane = node.closest<HTMLElement>('[data-library-scroll-pane]');
	const grid: Grid = {
		node, revision, shadow: null, chunks: [], children: [], columns: 0,
		widthSources: pane && pane !== node ? [node, pane] : [node], disposed: false
	};
	const stopObservingWidths = observeWidths(grid);
	const fonts = node.ownerDocument.fonts;
	const fontChanged = (): void => schedule(grid);
	fonts?.addEventListener('loadingdone', fontChanged);
	schedule(grid);
	return {
		update(next) {
			if (sameRevision(grid.revision, next)) return;
			grid.revision = next;
			schedule(grid);
		},
		destroy() {
			grid.disposed = true;
			pending.delete(grid);
			if (measuring?.grids.includes(grid) && !scheduled) {
				scheduled = true;
				queueMicrotask(preparePendingGrids);
			}
			stopObservingWidths();
			fonts?.removeEventListener('loadingdone', fontChanged);
		}
	};
}
