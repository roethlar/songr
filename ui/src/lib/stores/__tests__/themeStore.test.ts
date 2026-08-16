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

	it('applies and persists an explicit theme', async () => {
		const { setTheme, themeStore } = await import('../themeStore');

		setTheme('light');

		expect(get(themeStore)).toBe('light');
		expect(document.documentElement.dataset.theme).toBe('light');
		expect(storage.getItem('roon-controller-theme')).toBe('light');
	});

	it('initializes from persisted preference before the OS preference', async () => {
		storage.setItem('roon-controller-theme', 'light');
		const { initializeTheme, themeStore } = await import('../themeStore');

		initializeTheme();

		expect(get(themeStore)).toBe('light');
		expect(document.documentElement.dataset.theme).toBe('light');
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
