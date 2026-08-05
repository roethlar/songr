// Stub for SvelteKit's `$app/stores` module under Vitest. Tests that
// need to control `$page.url` should `vi.mock('$app/stores')` and
// supply their own readable; this file just satisfies the vite import
// resolver so .svelte files compile.
import { readable } from 'svelte/store';

export const page = readable({ url: new URL('http://localhost/') });
export const navigating = readable(null);
export const updated = readable(false);
