import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureLibraryChrome } from '../libraryListChrome';

afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe('measured Library chrome', () => {
	it('tracks wrapping and visible toolbar replacement, and fences retired observers', () => {
		const callbacks: Array<() => void> = [];
		const observe = vi.fn();
		const unobserve = vi.fn();
		const disconnect = vi.fn();
		vi.stubGlobal('ResizeObserver', class {
			constructor(callback: () => void) { callbacks.push(callback); }
			observe = observe;
			unobserve = unobserve;
			disconnect = disconnect;
		});
		const pane = document.createElement('div');
		pane.dataset.libraryScrollPane = '';
		document.body.append(pane);
		function node(height: number) {
			const element = document.createElement('div');
			pane.append(element);
			let currentHeight = height;
			vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({ height: currentHeight }) as DOMRect);
			return { element, resize: (next: number) => { currentHeight = next; } };
		}
		const scopes = node(66);
		const root = node(54);
		const detail = node(0);
		const scopeAction = measureLibraryChrome(scopes.element, 'scopes');
		const rootAction = measureLibraryChrome(root.element, 'toolbar');
		const detailAction = measureLibraryChrome(detail.element, 'toolbar');
		expect(callbacks).toHaveLength(1);
		expect(observe).toHaveBeenCalledTimes(3);
		expect(observe).toHaveBeenCalledWith(scopes.element, { box: 'border-box' });
		expect(pane.style.getPropertyValue('--library-scopes-height')).toBe('66px');
		expect(pane.style.getPropertyValue('--library-toolbar-height')).toBe('54px');
		scopes.resize(110);
		root.resize(0);
		detail.resize(92);
		callbacks[0]();
		expect(pane.style.getPropertyValue('--library-scopes-height')).toBe('110px');
		expect(pane.style.getPropertyValue('--library-toolbar-height')).toBe('92px');
		rootAction.destroy();
		expect(pane.style.getPropertyValue('--library-toolbar-height')).toBe('92px');
		detailAction.destroy();
		expect(pane.style.getPropertyValue('--library-toolbar-height')).toBe('0px');
		scopeAction.destroy();
		expect(unobserve).toHaveBeenCalledTimes(3);
		expect(disconnect).toHaveBeenCalledOnce();
		expect(pane.style.getPropertyValue('--library-scopes-height')).toBe('');
		const replacement = measureLibraryChrome(scopes.element, 'scopes');
		callbacks[0]();
		expect(pane.style.getPropertyValue('--library-scopes-height')).toBe('110px');
		replacement.destroy();
	});

 it('ignores retained inactive toolbars without forcing their layout', () => {
  const pane = document.createElement('div'); pane.dataset.libraryScrollPane = '';
  const panel = document.createElement('div'); panel.dataset.retainedLibraryPanel = '';
  panel.setAttribute('aria-hidden', 'true');
  const toolbar = document.createElement('div'); panel.append(toolbar); pane.append(panel); document.body.append(pane);
  const measure = vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue({height: 72} as DOMRect);
  const action = measureLibraryChrome(toolbar, 'toolbar');
  expect(measure).not.toHaveBeenCalled();
  expect(pane.style.getPropertyValue('--library-toolbar-height')).toBe('0px');
  panel.removeAttribute('aria-hidden');
  panel.dispatchEvent(new Event('library-panel-visibility', {bubbles: true}));
  expect(pane.style.getPropertyValue('--library-toolbar-height')).toBe('72px');
  panel.setAttribute('aria-hidden', 'true');
  panel.dispatchEvent(new Event('library-panel-visibility', {bubbles: true}));
  expect(pane.style.getPropertyValue('--library-toolbar-height')).toBe('0px');
  expect(measure).toHaveBeenCalledOnce(); action.destroy();
 });

	it('does nothing outside the Library pane', () => {
		const node = document.createElement('div');
		expect(() => measureLibraryChrome(node, 'toolbar').destroy()).not.toThrow();
	});
});
