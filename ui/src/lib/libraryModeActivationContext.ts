import type {
	LibraryPageState,
	LibraryViewActivationCause
} from '$lib/libraryPageState';
import type { LibraryView } from '$lib/stores/libraryViewStore';

export interface CommittedLibraryModeActivation {
	readonly cause: LibraryViewActivationCause;
	readonly pageState: LibraryPageState;
}

export interface LibraryModeLifecycle {
	/** Restore only from the host's committed, keyless activation state. */
	resume(activation: CommittedLibraryModeActivation): void;
	/** Quiesce local authority. Implementations must be synchronous and idempotent. */
	suspend(): void;
}

export interface LibraryModeActivationContext {
	/** The activation that actually committed the currently mounted mode. */
	committedActivation?(): CommittedLibraryModeActivation | null;
	/**
	 * Register the lifecycle owned by the currently mounted mode instance.
	 * The returned cleanup is idempotent and cannot unregister a newer instance.
	 */
	registerLifecycle?(mode: LibraryView, lifecycle: LibraryModeLifecycle): () => void;
}

export const LIBRARY_MODE_ACTIVATION_CONTEXT = Symbol('library-mode-activation');
