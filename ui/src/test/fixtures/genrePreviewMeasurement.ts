import { vi } from 'vitest';

/** jsdom has no layout. Supply only the measured genre pane, leaving other chrome alone. */
export function genrePreviewMeasurement() {
	let width = 556, tile = 160, gap = 16;
	const observers: { notify: () => void; disconnected: boolean }[] = [];
	const computed = globalThis.getComputedStyle;
	vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element, pseudo) => {
		if (element.getAttribute('data-testid') === 'genre-overview') {
			const style = document.createElement('div').style;
			style.setProperty('--tile', `${tile}px`); style.setProperty('--gap', `${gap}px`);
			style.paddingLeft = '22px'; style.paddingRight = '22px';
			return style;
		}
		return computed(element, pseudo);
	});
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
		return this.dataset.testid === 'genre-overview' ? width : 0;
	});
	vi.stubGlobal('ResizeObserver', class {
		entry: { notify: () => void; disconnected: boolean };
		constructor(callback: () => void) { this.entry = { notify: callback, disconnected: false }; observers.push(this.entry); }
		observe() {} unobserve() {} disconnect() { this.entry.disconnected = true; }
	});
	return { observers, resize(next: number) { width = next; for (const observer of observers) if (!observer.disconnected) observer.notify(); },
		density(nextTile: number, nextGap: number) { tile = nextTile; gap = nextGap; } };
}
