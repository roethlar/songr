import type { UnifiedItemTarget } from '$lib/libraryPageState';

/**
 * DOM-independent coordinator for the Unified Library's item pages
 * (rich-item plan §5.2). It owns exactly three things: the current item
 * target, a monotonically increasing page generation, and the retirement
 * hook that fires whenever a live page is replaced or closed so the host
 * can cancel that page's baseline controllers.
 *
 * It deliberately does NOT own playback, queue, favorite, or album/detail
 * authority — those stay in their existing controllers and fail closed
 * exactly as today. Later slices attach the optional editorial session to
 * the generation issued here; a stale generation is how their late events
 * are rejected.
 */
export interface LibraryItemPageState {
	readonly target: UnifiedItemTarget | null;
	/**
	 * Increments on every open and close. Async work captures the
	 * generation it started under and checks `isCurrent` before applying
	 * its result.
	 */
	readonly generation: number;
}

export interface LibraryItemPageControllerDependencies {
	/**
	 * Invoked with the page being retired whenever an open target is
	 * replaced or closed — the host cancels that page's controllers here.
	 * Never invoked for the initial idle state.
	 */
	readonly onRetire?: (retired: UnifiedItemTarget) => void;
}

type Subscriber = (state: LibraryItemPageState) => void;

function frozenState(
	target: UnifiedItemTarget | null,
	generation: number
): LibraryItemPageState {
	return Object.freeze({
		target: target === null ? null : Object.freeze({ ...target }),
		generation
	});
}

export class LibraryItemPageController {
	private readonly deps: LibraryItemPageControllerDependencies;
	private state: LibraryItemPageState = frozenState(null, 0);
	private readonly subscribers = new Set<Subscriber>();

	public constructor(deps: LibraryItemPageControllerDependencies = {}) {
		this.deps = deps;
	}

	/** Svelte store contract. */
	public subscribe(run: Subscriber): () => void {
		this.subscribers.add(run);
		run(this.state);
		return () => {
			this.subscribers.delete(run);
		};
	}

	public get current(): LibraryItemPageState {
		return this.state;
	}

	/**
	 * Opens an item page, retiring any live one first. Returns the new
	 * page generation.
	 */
	public open(target: UnifiedItemTarget): number {
		const retired = this.state.target;
		const generation = this.state.generation + 1;
		this.publish(frozenState(target, generation));
		if (retired !== null) {
			this.deps.onRetire?.(retired);
		}
		return generation;
	}

	/** Closes the live item page, if any. Idempotent. */
	public close(): void {
		const retired = this.state.target;
		if (retired === null) {
			return;
		}
		this.publish(frozenState(null, this.state.generation + 1));
		this.deps.onRetire?.(retired);
	}

	/** True while `generation` still names the live page. */
	public isCurrent(generation: number): boolean {
		return this.state.generation === generation && this.state.target !== null;
	}

	private publish(next: LibraryItemPageState): void {
		this.state = next;
		for (const run of [...this.subscribers]) {
			run(next);
		}
	}
}
