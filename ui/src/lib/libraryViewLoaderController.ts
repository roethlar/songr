import { writable, type Readable } from 'svelte/store';
import {
	CLASSIC_LIBRARY_VIEW,
	type LibraryView
} from '$lib/stores/libraryViewStore';

export type LibraryViewLoader<T> = () => Promise<T>;
export type LibraryViewLoaders<T> = Readonly<Partial<Record<LibraryView, LibraryViewLoader<T>>>>;

export interface LibraryViewLoaderState<T> {
	requestedMode: LibraryView;
	activeMode: LibraryView | null;
	activeTarget: T | null;
	loading: boolean;
	error: Error | null;
}

export type LibraryViewActivationResult<T> =
	| { status: 'activated'; state: LibraryViewLoaderState<T> }
	| { status: 'failed'; state: LibraryViewLoaderState<T>; error: Error }
	| { status: 'superseded'; state: LibraryViewLoaderState<T> };

export interface LibraryViewActivationCommit<T> {
	requestedMode: LibraryView;
	target: T;
}

export interface LibraryViewActivationOptions<T> {
	/**
	 * Runs synchronously after the requested module is ready, but before the
	 * active target is published. The Library host uses this boundary to
	 * commit preference and semantic history as one activation transaction.
	 */
	beforeCommit?: (commit: LibraryViewActivationCommit<T>) => void;
	/**
	 * Browser-history traversal cannot retain a view that disagrees with the
	 * entry the browser has already selected. Other warm failures retain the
	 * outgoing view by default.
	 */
	clearActiveOnFailure?: boolean;
	/**
	 * Runs immediately before a failed traversal publishes an empty active
	 * target. It lets the host quiesce the outgoing mounted instance first.
	 */
	beforeClearActive?: () => void;
	/** Reject an unavailable explicit history/request target instead of using
	 * the rollout fallback reserved for an untagged stored preference. */
	requireExactMode?: boolean;
}

export interface LibraryViewLoaderController<T> extends Readable<LibraryViewLoaderState<T>> {
	activate(
		preferredMode: LibraryView,
		options?: LibraryViewActivationOptions<T>
	): Promise<LibraryViewActivationResult<T>>;
	invalidatePending(): void;
	getState(): LibraryViewLoaderState<T>;
}

interface LibraryViewLoaderControllerOptions<T> {
	loaders: LibraryViewLoaders<T>;
	resolveMode?: (preferredMode: LibraryView) => LibraryView;
}

export class MissingLibraryViewLoaderError extends Error {
	constructor(readonly mode: LibraryView) {
		super(`No Library view loader is registered for ${mode}`);
		this.name = 'MissingLibraryViewLoaderError';
	}
}

export class UnavailableLibraryViewError extends Error {
	constructor(
		readonly requestedMode: LibraryView,
		readonly availableFallback: LibraryView
	) {
		super(`Library view ${requestedMode} is not available`);
		this.name = 'UnavailableLibraryViewError';
	}
}

function normalizeLoaderError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	return new Error(
		typeof reason === 'string' && reason.length > 0 ? reason : 'Library view loader failed'
	);
}

export function createLibraryViewLoaderController<T>({
	loaders,
	resolveMode = (preferredMode) => preferredMode
}: LibraryViewLoaderControllerOptions<T>): LibraryViewLoaderController<T> {
	let activationGeneration = 0;
	let state: LibraryViewLoaderState<T> = {
		requestedMode: CLASSIC_LIBRARY_VIEW,
		activeMode: null,
		activeTarget: null,
		loading: false,
		error: null
	};
	const internal = writable(state);

	function publish(next: LibraryViewLoaderState<T>): LibraryViewLoaderState<T> {
		state = next;
		internal.set(state);
		return state;
	}

	async function activate(
		preferredMode: LibraryView,
		options: LibraryViewActivationOptions<T> = {}
	): Promise<LibraryViewActivationResult<T>> {
		const requestedMode = resolveMode(preferredMode);
		const generation = ++activationGeneration;
		const fail = (error: Error): LibraryViewActivationResult<T> => {
			if (generation !== activationGeneration) {
				return { status: 'superseded', state };
			}
			const clearActive = options.clearActiveOnFailure === true;
			if (clearActive) {
				try {
					options.beforeClearActive?.();
				} catch {
					// Lifecycle hooks are specified as total. Still clear fail-closed if
					// a broken implementation violates that contract.
				}
			}
			return {
				status: 'failed',
				error,
				state: publish({
					...state,
					requestedMode: clearActive ? requestedMode : (state.activeMode ?? requestedMode),
					activeMode: clearActive ? null : state.activeMode,
					activeTarget: clearActive ? null : state.activeTarget,
					loading: false,
					error
				})
			};
		};
		if (options.requireExactMode === true && requestedMode !== preferredMode) {
			return fail(new UnavailableLibraryViewError(preferredMode, requestedMode));
		}

		if (state.activeMode === requestedMode && state.activeTarget !== null) {
			try {
				options.beforeCommit?.({ requestedMode, target: state.activeTarget });
			} catch (reason) {
				return fail(normalizeLoaderError(reason));
			}
			if (generation !== activationGeneration) {
				return { status: 'superseded', state };
			}
			return {
				status: 'activated',
				state: publish({
					...state,
					requestedMode,
					loading: false,
					error: null
				})
			};
		}

		publish({ ...state, requestedMode, loading: true, error: null });
		const loader = loaders[requestedMode];
		if (!loader) {
			const error = new MissingLibraryViewLoaderError(requestedMode);
			return fail(error);
		}

		try {
			const target = await loader();
			if (generation !== activationGeneration) {
				return { status: 'superseded', state };
			}
			try {
				options.beforeCommit?.({ requestedMode, target });
			} catch (reason) {
				return fail(normalizeLoaderError(reason));
			}
			if (generation !== activationGeneration) {
				return { status: 'superseded', state };
			}

			return {
				status: 'activated',
				state: publish({
					requestedMode,
					activeMode: requestedMode,
					activeTarget: target,
					loading: false,
					error: null
				})
			};
		} catch (reason) {
			if (generation !== activationGeneration) {
				return { status: 'superseded', state };
			}
			const error = normalizeLoaderError(reason);

			return fail(error);
		}
	}

	return {
		subscribe: internal.subscribe,
		activate,
		invalidatePending: () => {
			activationGeneration += 1;
		},
		getState: () => state
	};
}
