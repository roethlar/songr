import { artworkRequests, type ArtworkInterest } from '../artworkRequests';
import { PREPARED_LIBRARY_GRID_EVENT } from '../preparedLibraryGrid';

const LOOKAHEAD = 200;
interface ImageState {
	node: HTMLImageElement;
	url: string;
	interest?: ArtworkInterest;
	eligible: boolean;
	failed: boolean;
	permanentFailure: boolean;
	loaded: boolean;
	handingOff: boolean;
	handoffFailures: number;
	retryTimer?: ReturnType<typeof setTimeout>;
	disposed: boolean;
}
interface Observation {
	images: Map<Element, ImageState>;
	register(state: ImageState): void;
	remove(state: ImageState): void;
	stop(): void;
}
interface ImageGroup {
	box: HTMLElement;
	images: Set<ImageState>;
	near: boolean;
}
const observations = new WeakMap<Document, Map<Element | null, Observation>>();

function admit(state: ImageState, bounds: DOMRectReadOnly, viewport: { top: number; bottom: number }): void {
	if (state.disposed || state.loaded || state.handingOff) return;
	const distance = Math.max(viewport.top - bounds.bottom, bounds.top - viewport.bottom, 0);
	const eligible = bounds.width > 0 && bounds.height > 0 && distance <= LOOKAHEAD;
	if (!eligible) {
		state.eligible = false;
		state.failed = false; // A later visit gets a new, bounded recovery attempt.
		state.interest?.dispose();
		state.interest = undefined;
		return;
	}
	state.eligible = true;
	if (state.failed || state.permanentFailure) return;
	// Every visible cover precedes lookahead, regardless of DOM/list order.
	const priority = distance === 0 ? 0 : 1 + distance / LOOKAHEAD;
	if (state.interest) {
		state.interest.priority(priority);
		return;
	}
	state.interest = artworkRequests.request(state.url, priority, result => {
		state.interest = undefined;
		if (state.disposed) return;
		if (result.ok) {
			state.handingOff = true;
			state.node.src = state.url;
		} else {
			state.failed = true;
			state.permanentFailure = !result.retryable;
			state.node.style.visibility = 'hidden';
		}
	});
}

function observe(state: ImageState): () => void {
	const document = state.node.ownerDocument;
	const root = state.node.closest('[data-library-scroll-pane]');
	let roots = observations.get(document);
	if (!roots) { roots = new Map(); observations.set(document, roots); }
	let shared = roots.get(root);
	if (!shared) {
		const images = new Map<Element, ImageState>();
		const near = new Set<ImageState>();
		const fine = new Set<ImageState>();
		const groups = new Map<Element, ImageGroup>();
		const membership = new Map<ImageState, ImageGroup | null>();
		const pending = new Set<ImageState>();
		let coarse: IntersectionObserver | undefined;
		let regroupScheduled = false;
		let regroupAll = false;
		let stopped = false;
		let frame = 0;
		const viewport = () => root?.getBoundingClientRect() ?? { top: 0, bottom: document.documentElement.clientHeight };
		const deactivate = (image: ImageState) => {
			near.delete(image);
			image.eligible = false;
			image.failed = false;
			image.interest?.dispose();
			image.interest = undefined;
		};
		const observer = new IntersectionObserver(entries => {
			const view = viewport();
			for (const entry of entries) {
				const image = images.get(entry.target);
				if (!image || !fine.has(image)) continue;
				if (entry.isIntersecting) {
					near.add(image);
					admit(image, entry.boundingClientRect, view);
				} else deactivate(image);
			}
		}, { root, rootMargin: `${LOOKAHEAD}px 0px`, threshold: [0, 1] });
		const watch = (image: ImageState) => {
			if (fine.has(image)) return;
			fine.add(image);
			observer.observe(image.node);
		};
		const unwatch = (image: ImageState) => {
			if (!fine.delete(image)) return;
			observer.unobserve(image.node);
			deactivate(image);
		};
		const detachGroup = (image: ImageState) => {
			const group = membership.get(image);
			membership.delete(image);
			if (!group) return;
			group.images.delete(image);
			if (!group.images.size) {
				coarse?.unobserve(group.box);
				groups.delete(group.box);
			}
		};
		const regroup = () => {
			regroupScheduled = false;
			if (stopped) return;
			const affected = regroupAll ? [...images.values()] : [...pending];
			pending.clear();
			regroupAll = false;
			for (const image of affected) {
				if (!images.has(image.node)) continue;
				// The tile and slot already exist and have their full prepared
				// geometry. Only artwork observation is partitioned here.
				const slot = image.node.closest<HTMLElement>('.tile')?.assignedSlot;
				const box = slot?.parentElement;
				const prepared = box?.hasAttribute('data-prepared-library-chunk') ? box : null;
				if (membership.has(image) && (membership.get(image)?.box ?? null) === prepared) continue;
				unwatch(image);
				detachGroup(image);
				if (!prepared) {
					membership.set(image, null);
					watch(image);
					continue;
				}
				if (!coarse) coarse = new IntersectionObserver(entries => {
					for (const entry of entries) {
						const group = groups.get(entry.target);
						if (!group) continue;
						group.near = entry.isIntersecting;
						for (const image of group.images) {
							if (group.near) watch(image);
							else unwatch(image);
						}
					}
				}, { root, rootMargin: `${LOOKAHEAD}px 0px` });
				let group = groups.get(prepared);
				if (!group) {
					group = { box: prepared, images: new Set(), near: false };
					groups.set(prepared, group);
					coarse.observe(prepared);
				}
				membership.set(image, group);
				group.images.add(image);
				if (group.near) watch(image);
			}
		};
		const scheduleRegroup = () => {
			if (regroupScheduled) return;
			regroupScheduled = true;
			// Child actions mount before the parent grid's preparation action.
			// Wait for that existing microtask batch before reading slot membership.
			queueMicrotask(() => queueMicrotask(regroup));
		};
		const assignmentsChanged = () => { regroupAll = true; scheduleRegroup(); };
		const scrolling = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				const view = viewport();
				// Only the small observed lookahead set is visited. Rows, slots and
				// prepared geometry remain untouched during scrolling.
				for (const image of near) admit(image, image.node.getBoundingClientRect(), view);
			});
		};
		const scrollTarget = root ?? document;
		scrollTarget.addEventListener('scroll', scrolling, { passive: true });
		scrollTarget.addEventListener(PREPARED_LIBRARY_GRID_EVENT, assignmentsChanged);
		shared = {
			images,
			register(image) {
				images.set(image.node, image);
				if (!image.node.closest('.tile')) { membership.set(image, null); watch(image); }
				else { pending.add(image); scheduleRegroup(); }
			},
			remove(image) {
				images.delete(image.node);
				pending.delete(image);
				unwatch(image);
				detachGroup(image);
			},
			stop() {
				stopped = true;
				observer.disconnect();
				coarse?.disconnect();
				cancelAnimationFrame(frame);
				scrollTarget.removeEventListener('scroll', scrolling);
				scrollTarget.removeEventListener(PREPARED_LIBRARY_GRID_EVENT, assignmentsChanged);
			}
		};
		roots.set(root, shared);
	}
	shared.register(state);
	return () => {
		shared.remove(state);
		if (!shared.images.size) { shared.stop(); roots.delete(root); }
	};
}

/** Keep full tile DOM/layout while admitting only useful artwork requests.
 * Successful images retain their original URL; the browser owns cache eviction.
 */
export function libraryArtwork(node: HTMLImageElement, url: string): { update(url: string): void; destroy(): void } {
	let state: ImageState;
	let stop = () => {};
	const currentHandoff = () => !state.disposed && state.handingOff &&
		node.getAttribute('src') === state.url &&
		(!node.currentSrc || node.currentSrc === new URL(state.url, node.ownerDocument.baseURI).href);
	const show = () => {
		if (!currentHandoff() || node.naturalWidth === 0) return;
		state.loaded = true;
		state.handingOff = false;
		node.style.visibility = '';
		stop();
		stop = () => {};
	};
	const hide = () => {
		if (!currentHandoff()) return;
		node.style.visibility = 'hidden';
		state.handingOff = false;
		state.handoffFailures++;
		state.failed = true;
		if (state.handoffFailures > 2) { state.permanentFailure = true; return; }
		// A cache handoff can still fail (for example corrupt image bytes).
		// Recover a bounded number of times, never a persistent decode loop.
		state.retryTimer = setTimeout(() => {
			state.retryTimer = undefined;
			state.failed = false;
			if (!state.eligible || state.disposed) return;
			const root = node.closest('[data-library-scroll-pane]');
			const viewport = root?.getBoundingClientRect() ?? { top: 0, bottom: node.ownerDocument.documentElement.clientHeight };
			admit(state, node.getBoundingClientRect(), viewport);
		}, 500);
	};
	node.addEventListener('load', show);
	node.addEventListener('error', hide);
	const setup = (source: string) => {
		state = { node, url: source, eligible: false, failed: false, permanentFailure: false, loaded: false, handingOff: false, handoffFailures: 0, disposed: false };
		// The action owns src so native lazy loading cannot build an unbounded
		// HTTP queue ahead of the admission controller.
		node.removeAttribute('src');
		node.loading = 'eager';
		node.style.visibility = 'hidden';
		if (!source) return;
		if (typeof IntersectionObserver === 'undefined') { state.handingOff = true; node.src = source; return; }
		stop = observe(state);
	};
	const cleanup = () => {
		state.disposed = true;
		clearTimeout(state.retryTimer);
		state.interest?.dispose();
		stop();
		stop = () => {};
	};
	setup(url);
	return {
		update(next) {
			if (state.url === next) return;
			cleanup();
			setup(next);
		},
		destroy() {
			cleanup();
			node.removeEventListener('load', show);
			node.removeEventListener('error', hide);
		}
	};
}
