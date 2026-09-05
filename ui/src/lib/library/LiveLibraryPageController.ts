import type { LibraryLevel, LibraryOpenResponse } from '@shared/libraryOpenContracts';
import type { LibraryRootRow, LibraryRowReference } from '@shared/libraryRootsContracts';
import {
	libraryPathFailureMessage,
	resolveLibraryRenderingPath,
	type LibraryHeldRoot,
	type LibraryOnDemandRoot,
	type LibraryPathStep,
	type LibraryPathTarget,
	type LibraryRenderingPath
} from './liveLibraryPath';

/**
 * One live library page: the row its address names, and the level that row
 * opens onto (`.agents/plans/library-live-view.md` Slice 2).
 *
 * WHAT THIS OWNS, AND WHY IT IS ONE OBJECT. Opening a page in the live view is
 * two questions that must not be answered by two different owners: which row is
 * this, and what is inside it. Splitting them is how a page ends up showing one
 * album's tracks under another album's heading, because the two answers came
 * from different generations. Here they are one transition, fenced together.
 *
 * THE REFERENCE AND THE ADDRESS ARE NOT ALTERNATIVES. A reader who clicked a
 * row hands over the reference that row carried, and it is used — that click
 * was unambiguous even where the rendering is not, and re-deriving the row from
 * its text would throw that certainty away. The address is what the page falls
 * back to when the reference is dead, which is what a refresh, a reconnect or a
 * restore makes it. Both name the same row; only one of them survives.
 *
 * WHAT THE PAGE NEVER DOES is show something. Every failure is a sentence: the
 * row is gone, Roon lists it twice, the Core cannot be read. There is no arm
 * here that opens whatever came back first.
 */

export type LiveLibraryPagePhase = 'idle' | 'opening' | 'ready' | 'group' | 'failed';

export interface LiveLibraryPageGroup {
	readonly at: LibraryPathStep;
	readonly path: LibraryRenderingPath;
	readonly targets: readonly LibraryPathTarget[];
}

export interface LiveLibraryPageState {
	readonly phase: LiveLibraryPagePhase;
	readonly path: LibraryRenderingPath | null;
	/** The row the address names, in the generation it resolved under. */
	readonly target: LibraryPathTarget | null;
	/** What Roon put inside that row. */
	readonly level: LibraryLevel | null;
	/** Why there is no page, in words a reader can act on. */
	readonly message: string | null;
	/** Current live candidates when the address names repeated Roon rows. */
	readonly group: LiveLibraryPageGroup | null;
	/**
	 * True when the reason was a retired snapshot rather than a missing row.
	 * The host answers this by re-reading the roots and retrying, which is the
	 * same thing it would do after a reload — never by retrying the dead
	 * reference, which cannot start working again.
	 */
	readonly stale: boolean;
	/** Monotonic page fence. Every await is checked against it. */
	readonly generation: number;
}

export interface LiveLibraryPageOpenInput {
	readonly path: LibraryRenderingPath;
	/** The reference the reader's own click carried, when there was one. */
	readonly ref?: LibraryRowReference;
	/** Roon's own strings from the clicked row, so the heading needs no read. */
	readonly title?: string;
	readonly subtitle?: string;
	readonly imageKey?: string;
}

export interface LiveLibraryPageDependencies {
	readonly heldRoot: (root: LibraryHeldRoot) => readonly LibraryRootRow[] | null;
	readonly openRef: (ref: LibraryRowReference) => Promise<LibraryOpenResponse>;
	readonly openRoot: (root: LibraryOnDemandRoot) => Promise<LibraryOpenResponse>;
	/** The generation the reader's roots are from; `null` when none is held. */
	readonly heldGeneration: () => string | null;
}

const IDLE: LiveLibraryPageState = Object.freeze({
	phase: 'idle',
	path: null,
	target: null,
	level: null,
	message: null,
	group: null,
	stale: false,
	generation: 0
});

/** DOM-independent state machine for one open live page. */
export class LiveLibraryPageController {
	readonly #dependencies: LiveLibraryPageDependencies;
	readonly #subscribers = new Set<(state: LiveLibraryPageState) => void>();
	#state: LiveLibraryPageState = IDLE;
	#fence = 0;
	#disposed = false;

	public constructor(dependencies: LiveLibraryPageDependencies) {
		this.#dependencies = dependencies;
	}

	public subscribe(run: (state: LiveLibraryPageState) => void): () => void {
		this.#subscribers.add(run);
		run(this.#state);
		return () => this.#subscribers.delete(run);
	}

	public snapshot(): LiveLibraryPageState {
		return this.#state;
	}

	/** The generation currently open, for a host deciding whether to re-resolve. */
	public get openGeneration(): string | null {
		return this.#state.level?.generation ?? null;
	}

	public open(input: LiveLibraryPageOpenInput): void {
		if (this.#disposed) return;
		void this.#run(input);
	}

	/**
	 * Re-resolve the open page from its address alone.
	 *
	 * The reference is deliberately dropped: retry exists for the case where it
	 * died, and offering it again would answer `stale` forever.
	 */
	public retry(): void {
		const path = this.#state.path;
		if (this.#disposed || path === null) return;
		void this.#run({ path });
	}

	public reset(): void {
		this.#fence += 1;
		if (this.#state === IDLE) return;
		this.#publish(IDLE);
	}

	public dispose(): void {
		this.#disposed = true;
		this.#fence += 1;
		this.#subscribers.clear();
	}

	async #run(input: LiveLibraryPageOpenInput): Promise<void> {
		this.#fence += 1;
		const fence = this.#fence;
		const current = (): boolean => fence === this.#fence && !this.#disposed;
		this.#publish({
			phase: 'opening',
			path: input.path,
			// The clicked row's own strings stand in for the heading while the
			// level is read, so the page never renders a blank identity it will
			// later fill in. It is replaced, not merged, once Roon answers.
			target:
				input.ref === undefined || input.title === undefined
					? null
					: {
							ref: input.ref,
							title: input.title,
							subtitle: input.subtitle ?? null,
							imageKey: input.imageKey ?? null,
							kind: input.path.steps[input.path.steps.length - 1]?.kind ?? 'entry'
						},
			level: null,
			message: null,
			group: null,
			stale: false,
			generation: fence
		});

		const held = this.#dependencies.heldGeneration();
		// A reference from another generation is not "probably fine": it is
		// dead, and the address is the only thing left that names this page.
		const usable =
			input.ref !== undefined && held !== null && input.ref.generation === held
				? input.ref
				: null;

		let target: LibraryPathTarget;
		if (usable !== null) {
			target = {
				ref: usable,
				title: input.title ?? '',
				subtitle: input.subtitle ?? null,
				imageKey: input.imageKey ?? null,
				kind: input.path.steps[input.path.steps.length - 1]?.kind ?? 'entry'
			};
		} else {
			const resolution = await resolveLibraryRenderingPath(
				{
					heldRoot: this.#dependencies.heldRoot,
					openRef: this.#dependencies.openRef,
					openRoot: this.#dependencies.openRoot,
					stillWanted: current
				},
				input.path
			);
			if (!current()) return;
			if (resolution.kind === 'canceled') return;
			if (resolution.kind === 'ambiguous') {
				this.#publish({
					phase: 'group',
					path: input.path,
					target: null,
					level: null,
					message: libraryPathFailureMessage(resolution),
					group: {
						at: resolution.at,
						path: resolution.path,
						targets: resolution.targets
					},
					stale: false,
					generation: fence
				});
				return;
			}
			if (resolution.kind !== 'resolved') {
				this.#fail(
					fence,
					input.path,
					resolution.kind === 'stale'
						? 'The library has been re-read since this page opened.'
						: (libraryPathFailureMessage(resolution) ?? 'This page could not be opened.'),
					resolution.kind === 'stale'
				);
				return;
			}
			target = resolution.target;
		}

		let opened: LibraryOpenResponse;
		try {
			opened = await this.#dependencies.openRef(target.ref);
		} catch (error) {
			if (!current()) return;
			this.#fail(
				fence,
				input.path,
				error instanceof Error ? error.message : 'This page could not be opened.',
				false
			);
			return;
		}
		if (!current()) return;
		if (opened.kind === 'stale') {
			this.#fail(fence, input.path, 'The library has been re-read since this page opened.', true);
			return;
		}
		if (opened.kind === 'unavailable') {
			this.#fail(fence, input.path, opened.message, false);
			return;
		}
		this.#publish({
			phase: 'ready',
			path: input.path,
			// Roon's own heading for the level replaces the clicked row's text
			// when it has one: it is the level saying what it is, which is the
			// one way a page can tell that Roon opened something else.
			target: { ...target, title: opened.title.length > 0 ? opened.title : target.title },
			level: opened,
			message: null,
			group: null,
			stale: false,
			generation: fence
		});
	}

	#fail(
		fence: number,
		path: LibraryRenderingPath,
		message: string,
		stale: boolean
	): void {
		if (fence !== this.#fence || this.#disposed) return;
		this.#publish({
			phase: 'failed',
			path,
			target: null,
			level: null,
			message,
			group: null,
			stale,
			generation: fence
		});
	}

	#publish(state: LiveLibraryPageState): void {
		this.#state = Object.freeze(state);
		for (const run of [...this.#subscribers]) run(this.#state);
	}
}
