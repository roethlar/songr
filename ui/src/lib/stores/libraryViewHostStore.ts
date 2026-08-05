import { writable, type Readable } from 'svelte/store';
import { normalizeLibraryIntent, type LibraryIntent } from '$lib/libraryIntent';
import type { LibraryView } from './libraryViewStore';

export interface LibraryViewHostState {
	readonly activeMode: LibraryView | null;
	readonly pendingMode: LibraryView | null;
	readonly transition: LibraryViewHostTransition | null;
}

export interface LibraryViewHostTransition {
	readonly fromMode: LibraryView;
	readonly toMode: LibraryView;
}

export type LibraryViewHostActivationOutcome = 'activated' | 'failed' | 'superseded';

export interface LibraryViewHostPublisher {
	publishActiveMode(
		activeMode: LibraryView | null,
		transition?: LibraryViewHostTransition | null,
		pendingMode?: LibraryView | null
	): void;
	handleRequests(
		handler: (requestedMode: LibraryView) => Promise<LibraryViewHostActivationOutcome>
	): void;
	handleOpenClassicRequests(
		handler: (intent: LibraryIntent) => Promise<LibraryViewHostActivationOutcome>
	): void;
	release(): void;
}

export interface LibraryViewHostStateStore {
	store: Readable<LibraryViewHostState>;
	claim(): LibraryViewHostPublisher;
	request(requestedMode: LibraryView): Promise<LibraryViewHostActivationOutcome> | null;
	openClassic(value: unknown): Promise<LibraryViewHostActivationOutcome> | null;
}

const EMPTY_HOST_STATE: LibraryViewHostState = Object.freeze({
	activeMode: null,
	pendingMode: null,
	transition: null
});

export function createLibraryViewHostStateStore(): LibraryViewHostStateStore {
	const internal = writable<LibraryViewHostState>(EMPTY_HOST_STATE);
	let ownerGeneration = 0;
	let requestHandler:
		| ((requestedMode: LibraryView) => Promise<LibraryViewHostActivationOutcome>)
		| null = null;
	let openClassicRequestHandler:
		| ((intent: LibraryIntent) => Promise<LibraryViewHostActivationOutcome>)
		| null = null;

	function publish(next: LibraryViewHostState): void {
		const pendingMode = next.pendingMode === next.activeMode ? null : next.pendingMode;
		const transition =
			next.transition !== null &&
			pendingMode === next.transition.toMode &&
			next.activeMode === next.transition.fromMode &&
			next.transition.fromMode !== next.transition.toMode
				? Object.freeze({ ...next.transition })
				: null;
		internal.set(Object.freeze({ activeMode: next.activeMode, pendingMode, transition }));
	}

	function resetHostState(): void {
		publish(EMPTY_HOST_STATE);
	}

	return {
		store: { subscribe: internal.subscribe },
		request(requestedMode): Promise<LibraryViewHostActivationOutcome> | null {
			const handler = requestHandler;
			if (!handler) return null;
			return handler(requestedMode);
		},
		openClassic(value): Promise<LibraryViewHostActivationOutcome> | null {
			const intent = normalizeLibraryIntent(value);
			const handler = openClassicRequestHandler;
			if (!handler || !intent) return null;
			return handler(intent);
		},
		claim(): LibraryViewHostPublisher {
			const generation = ++ownerGeneration;
			let released = false;
			requestHandler = null;
			openClassicRequestHandler = null;
			resetHostState();

			return {
				publishActiveMode(
					activeMode,
					transition = null,
					pendingMode = transition?.toMode ?? null
				): void {
					if (released || generation !== ownerGeneration) return;
					publish({ activeMode, pendingMode, transition });
				},
				handleRequests(handler): void {
					if (released || generation !== ownerGeneration) return;
					requestHandler = (requestedMode) => {
						if (released || generation !== ownerGeneration) {
							return Promise.resolve('superseded');
						}
						return handler(requestedMode);
					};
				},
				handleOpenClassicRequests(handler): void {
					if (released || generation !== ownerGeneration) return;
					openClassicRequestHandler = async (intent) => {
						if (released || generation !== ownerGeneration) return 'superseded';
						try {
							const outcome = await handler(intent);
							return released || generation !== ownerGeneration
								? 'superseded'
								: outcome;
						} catch {
							return released || generation !== ownerGeneration
								? 'superseded'
								: 'failed';
						}
					};
				},
				release(): void {
					if (released) return;
					released = true;
					if (generation !== ownerGeneration) return;
					ownerGeneration++;
					requestHandler = null;
					openClassicRequestHandler = null;
					resetHostState();
				}
			};
		}
	};
}

const productionHostState = createLibraryViewHostStateStore();

export const libraryViewHostStore = productionHostState.store;
export const claimLibraryViewHost = productionHostState.claim;
export const requestLibraryView = productionHostState.request;
export const openLibraryIntentInClassic = productionHostState.openClassic;
