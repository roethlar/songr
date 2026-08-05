import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export type ThemeMode = 'dark' | 'light';

// Storage key is also referenced by the inline script in app.html; keep them
// in sync if you rename it.
const STORAGE_KEY = 'roon-controller-theme';

function detectInitialTheme(): ThemeMode {
	if (!browser) {
		return 'dark';
	}

	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'dark' || stored === 'light') {
			return stored;
		}
	} catch {
		/* localStorage unavailable (private mode, blocked, etc.) */
	}

	// Honor the OS preference when nothing is stored.
	if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
		return 'light';
	}
	return 'dark';
}

const internalStore = writable<ThemeMode>(detectInitialTheme());

export const themeStore = {
	subscribe: internalStore.subscribe
};

export function applyTheme(theme: ThemeMode): void {
	if (!browser) {
		return;
	}

	document.documentElement.setAttribute('data-theme', theme);
	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		/* localStorage unavailable */
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

export function toggleTheme(): void {
	internalStore.update((current) => {
		const next: ThemeMode = current === 'dark' ? 'light' : 'dark';
		applyTheme(next);
		return next;
	});
}
