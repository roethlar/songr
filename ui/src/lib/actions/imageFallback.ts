/**
 * Svelte action: hide an <img> whose source fails to load, revealing
 * the styled art container behind it (all art containers carry a
 * placeholder background or glyph) instead of the browser's
 * broken-image icon. A later successful load — e.g. Svelte swapping
 * `src` when the track changes — makes the image visible again.
 */
export function hideOnError(node: HTMLImageElement): { destroy(): void } {
	const hide = () => {
		node.style.visibility = 'hidden';
	};
	const show = () => {
		node.style.visibility = '';
	};

	// A cached failure can settle before the action attaches.
	if (node.complete && node.naturalWidth === 0 && node.src) {
		hide();
	}

	node.addEventListener('error', hide);
	node.addEventListener('load', show);

	return {
		destroy() {
			node.removeEventListener('error', hide);
			node.removeEventListener('load', show);
		}
	};
}
