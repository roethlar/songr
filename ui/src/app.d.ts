// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { LibraryPageStateEnvelope } from '$lib/libraryPageState';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		interface PageState extends LibraryPageStateEnvelope {}
		// interface Platform {}
	}
}

export {};
