import { get } from 'svelte/store';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();
	get length(): number { return this.values.size; }
	clear(): void { this.values.clear(); }
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
	removeItem(key: string): void { this.values.delete(key); }
	setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('themeStore', () => {
	let storage: MemoryStorage;
	let originalStorageDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		storage = new MemoryStorage();
		originalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
		delete document.documentElement.dataset.theme;
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			writable: true,
			value: vi.fn(() => ({ matches: false }))
		});
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalStorageDescriptor) {
			Object.defineProperty(window, 'localStorage', originalStorageDescriptor);
		} else {
			Reflect.deleteProperty(window, 'localStorage');
		}
	});

	it.each(['dark', 'light', 'laser', 'miami', 'pop'] as const)('applies and persists %s', async theme => {
		const { setTheme, themeStore } = await import('../themeStore');

		setTheme(theme);

		expect(get(themeStore)).toBe(theme);
		expect(document.documentElement.dataset.theme).toBe(theme);
		expect(storage.getItem('roon-controller-theme')).toBe(theme);
	});

	it.each(['dark', 'light', 'laser', 'miami', 'pop'] as const)('prepaints and restores %s before the OS preference', async theme => {
		storage.setItem('roon-controller-theme', theme);
		vi.mocked(window.matchMedia).mockReturnValue({ matches: theme !== 'light' } as MediaQueryList);
		const appHtml = readFileSync(resolve(process.cwd(), 'src/app.html'), 'utf8');
		const bootstrap = appHtml.match(/<script>([\s\S]*?)<\/script>/)![1];
		new Function('window', 'document', 'localStorage', bootstrap)(window, document, storage);
		expect(document.documentElement.dataset.theme).toBe(theme);
		const { initializeTheme, themeStore } = await import('../themeStore');

		initializeTheme();

		expect(get(themeStore)).toBe(theme);
		expect(document.documentElement.dataset.theme).toBe(theme);
	});

	it.each([false, true])('falls back from an unknown saved theme with OS light=%s', async light => {
		storage.setItem('roon-controller-theme', 'ultraviolet');
		vi.mocked(window.matchMedia).mockReturnValue({ matches: light } as MediaQueryList);
		const appHtml = readFileSync(resolve(process.cwd(), 'src/app.html'), 'utf8');
		new Function('window', 'document', 'localStorage', appHtml.match(/<script>([\s\S]*?)<\/script>/)![1])(window, document, storage);
		expect(document.documentElement.dataset.theme).toBe(light ? 'light' : 'dark');
		const { initializeTheme, themeStore } = await import('../themeStore');
		initializeTheme();
		expect(get(themeStore)).toBe(light ? 'light' : 'dark');
	});

	it('honors the OS light preference when no preference is stored', async () => {
		vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
		const { initializeTheme, themeStore } = await import('../themeStore');

		initializeTheme();

		expect(get(themeStore)).toBe('light');
		expect(document.documentElement.dataset.theme).toBe('light');
	});

	it('prepaints the preference and initializes the shell from the same contract', () => {
		const appHtml = readFileSync(resolve(process.cwd(), 'src/app.html'), 'utf8');
		const layout = readFileSync(resolve(process.cwd(), 'src/routes/+layout.svelte'), 'utf8');

		expect(appHtml).toContain("localStorage.getItem('roon-controller-theme')");
		expect(appHtml).toContain("document.documentElement.setAttribute('data-theme', theme)");
		expect(layout).toContain("import { initializeTheme } from '$lib/stores/themeStore'");
		expect(layout).toContain('initializeTheme();');
	});
});
