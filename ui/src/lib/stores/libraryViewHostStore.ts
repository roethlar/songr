import { writable, type Readable } from 'svelte/store';
import type { LibraryView } from './libraryViewStore';

export interface LibraryViewHostState {
	readonly activeMode: LibraryView | null;
}

export interface LibraryViewHostPublisher {
	publishActiveMode(activeMode: LibraryView | null): void;
	release(): void;
}

const EMPTY_HOST_STATE: LibraryViewHostState = Object.freeze({ activeMode: null });

export function createLibraryViewHostStateStore(): {
	store: Readable<LibraryViewHostState>;
	claim(): LibraryViewHostPublisher;
} {
	const internal = writable<LibraryViewHostState>(EMPTY_HOST_STATE);
	let ownerGeneration = 0;

	return {
		store: { subscribe: internal.subscribe },
		claim(): LibraryViewHostPublisher {
			const generation = ++ownerGeneration;
			let released = false;
			internal.set(EMPTY_HOST_STATE);

			return {
				publishActiveMode(activeMode): void {
					if (released || generation !== ownerGeneration) return;
					internal.set(Object.freeze({ activeMode }));
				},
				release(): void {
					if (released) return;
					released = true;
					if (generation !== ownerGeneration) return;
					ownerGeneration += 1;
					internal.set(EMPTY_HOST_STATE);
				}
			};
		}
	};
}

const productionHostState = createLibraryViewHostStateStore();

export const libraryViewHostStore = productionHostState.store;
export const claimLibraryViewHost = productionHostState.claim;
