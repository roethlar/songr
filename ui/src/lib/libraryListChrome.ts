/**
 * Measure the two pinned Library rows without changing the pane's scroll owner.
 * A hidden collection can remain mounted under an item page, so measure all
 * registered toolbars and reserve only the visible one's height. Ownership is
 * per pane; neither a retired action nor its queued observer may clear another
 * page's measurements.
 */
type ChromeRole = 'scopes' | 'toolbar';
interface PaneChrome {
	nodes: Map<HTMLElement, ChromeRole>;
	observer: ResizeObserver | null;
	measure: () => void;
}

const panes = new WeakMap<HTMLElement, PaneChrome>();

export function measureLibraryChrome(node: HTMLElement, role: ChromeRole): { destroy(): void } {
	const pane = node.closest<HTMLElement>('[data-library-scroll-pane]');
	if (!pane) return { destroy() {} };
	let chrome = panes.get(pane);
	if (!chrome) {
		const nodes = new Map<HTMLElement, ChromeRole>();
		const measure = (): void => {
			if (nodes.size === 0) return;
			let scopes = 0;
			let toolbar = 0;
			for (const [element, kind] of nodes) {
				const hidden = element.closest('[data-retained-library-panel][aria-hidden="true"], [hidden]');
				const height = hidden ? 0 : element.getBoundingClientRect().height;
				if (kind === 'scopes') scopes = Math.max(scopes, height);
				else toolbar = Math.max(toolbar, height);
			}
			pane.style.setProperty('--library-scopes-height', `${scopes}px`);
			pane.style.setProperty('--library-toolbar-height', `${toolbar}px`);
		};
		chrome = {
			nodes,
			measure,
			observer: typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
		};
		pane.addEventListener('library-panel-visibility', measure);
		panes.set(pane, chrome);
	}
	const held = chrome;
	held.nodes.set(node, role);
	held.observer?.observe(node, { box: 'border-box' });
	held.measure();
	return {
		destroy() {
			held.observer?.unobserve(node);
			held.nodes.delete(node);
			if (held.nodes.size > 0) held.measure();
			else {
				held.observer?.disconnect();
				pane.removeEventListener('library-panel-visibility', held.measure);
				panes.delete(pane);
				pane.style.removeProperty('--library-scopes-height');
				pane.style.removeProperty('--library-toolbar-height');
			}
		}
	};
}
