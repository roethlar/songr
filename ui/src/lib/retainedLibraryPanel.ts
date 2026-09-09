/** Keep complete inactive lists laid out without doing work on scrolling. */
export function prepareRetainedLibraryPanel(node: HTMLElement, initialRevision: unknown): { update(revision: unknown): void; destroy(): void } {
	let revision = initialRevision;
	let width = -1;
	let disposed = false;
	const prepare = (): void => {
		if (disposed) return;
		// A retained parent may itself be hidden under an album/detail page.
		// Keep its zero-height clipping while temporarily allowing layout.
		const panels: HTMLElement[] = [];
		for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
			if (parent.hasAttribute('data-retained-library-panel')) panels.push(parent);
		}
		const prior = panels.map(panel => panel.style.contentVisibility);
		try {
			for (const panel of panels) panel.style.contentVisibility = 'visible';
			width = node.getBoundingClientRect().width;
			void (node.firstElementChild as HTMLElement | null)?.scrollHeight;
		} finally {
			panels.forEach((panel, index) => {
				if (prior[index]) panel.style.contentVisibility = prior[index];
				else panel.style.removeProperty('content-visibility');
			});
		}
	};
	prepare();
	const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
		if (entries.some(entry => entry.target === node && entry.contentRect.width !== width)) prepare();
	});
	observer?.observe(node);
	return {
		update(next) {
			// A root confirmation can publish a new state object with unchanged
			// generation/rows. It must not force another full layout.
			const same = Object.is(revision, next) || (Array.isArray(revision) && Array.isArray(next) &&
				revision.length === next.length && revision.every((value, index) => Object.is(value, next[index])));
			if (same) return;
			revision = next;
			prepare();
		},
		destroy() { disposed = true; observer?.disconnect(); }
	};
}
