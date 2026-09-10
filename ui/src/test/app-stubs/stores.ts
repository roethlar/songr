// Stub for SvelteKit's `$app/stores` module under Vitest. Tests that
// need to control `$page.url` should `vi.mock('$app/stores')` and
// supply their own readable; this file just satisfies the vite import
// resolver so .svelte files compile.
import { readable, writable } from 'svelte/store';

const pageState = writable({ url: new URL('http://localhost/') });
export const page = { subscribe: pageState.subscribe };

/** Full outer-layout browser fixtures explicitly mirror their real URL here. */
export function __setTestPageStore(url: string | URL): void {
	pageState.set({ url: new URL(url, 'http://localhost/') });
}
export const navigating = readable(null);
export const updated = readable(false);
