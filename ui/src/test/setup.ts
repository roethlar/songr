// Vitest setup. Resets sessionStorage/localStorage between tests so
// store state from one test can't leak into another. Some jsdom builds
// don't expose `.clear()` on the storage objects, so guard the call.
import { beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/svelte';

function safeClear(storage: Storage | undefined) {
	if (!storage) return;
	if (typeof storage.clear === 'function') {
		storage.clear();
		return;
	}
	for (let i = storage.length - 1; i >= 0; i--) {
		const key = storage.key(i);
		if (key) storage.removeItem(key);
	}
}

// jsdom has no ResizeObserver; Svelte's bind:clientWidth/clientHeight
// requires one. A no-op observer keeps components mountable — tests
// that need real measurements stub their own via vi.stubGlobal.
if (typeof globalThis.ResizeObserver === 'undefined') {
	class NoopResizeObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
}

beforeEach(() => {
	safeClear(globalThis.sessionStorage);
	safeClear(globalThis.localStorage);
});

afterEach(() => {
	// Unmount any Svelte components rendered during the test so DOM
	// state doesn't leak into the next case.
	cleanup();
});
