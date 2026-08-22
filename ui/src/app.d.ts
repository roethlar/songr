// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { LibraryPageStateEnvelope } from '$lib/libraryPageState';

declare global {
	/**
	 * Product version, stamped in at build time from the repository root
	 * `package.json` by `vite.config.ts` (and by `vitest.config.ts` so the
	 * suite sees the same shape the build produces).
	 */
	const __APP_VERSION__: string;

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		interface PageState extends LibraryPageStateEnvelope {}
		// interface Platform {}
	}
}

export {};
