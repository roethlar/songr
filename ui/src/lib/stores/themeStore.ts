import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export const THEME_OPTIONS = [
	{ id: 'dark', label: 'Dark' },
	{ id: 'light', label: 'Light' },
	{ id: 'laser', label: 'Laser' },
	{ id: 'miami', label: 'Miami' },
	{ id: 'pop', label: 'Pop Art' }
] as const;

export type ThemeMode = (typeof THEME_OPTIONS)[number]['id'];

function isThemeMode(value: string | null): value is ThemeMode {
	return THEME_OPTIONS.some(option => option.id === value);
}

// app.html reads the same key before Svelte hydrates to prevent a theme flash.
export const THEME_STORAGE_KEY = 'roon-controller-theme';

function detectInitialTheme(): ThemeMode {
	if (!browser) return 'dark';

	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		if (isThemeMode(stored)) return stored;
	} catch {
		/* localStorage can be unavailable in locked-down browser contexts. */
	}

	return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const internalStore = writable<ThemeMode>(detectInitialTheme());

export const themeStore = {
	subscribe: internalStore.subscribe
};

export function applyTheme(theme: ThemeMode): void {
	if (!browser) return;
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem(THEME_STORAGE_KEY, theme);
	} catch {
		/* Keep the live theme even when persistence is unavailable. */
	}
}

export function setTheme(theme: ThemeMode): void {
	internalStore.set(theme);
	applyTheme(theme);
}

export function initializeTheme(): void {
	const theme = detectInitialTheme();
	applyTheme(theme);
	internalStore.set(theme);
}
