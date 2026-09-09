import type { LibraryLevelRow } from '@shared/libraryOpenContracts';
import type { LibraryRowReference } from '@shared/libraryRootsContracts';
import { libraryGenrePreviewKind, normalizeLibraryPreviewResponse, LIBRARY_PREVIEW_LIMIT_MAX,
	type LibraryPreview, type LibraryPreviewItemKind, type LibraryPreviewResponse } from '@shared/libraryPreviewContracts';
import type { LiveLibraryPageState } from './LiveLibraryPageController';
import { libraryChildPath, type LibraryRenderingPath } from './liveLibraryPath';

export interface GenrePreviewOwner {
	readonly page: LiveLibraryPageState;
	readonly rootGeneration: string;
	readonly lifecycle: number;
}
export interface GenrePreviewSection {
	readonly kind: LibraryPreviewItemKind;
	readonly candidates: readonly LibraryLevelRow[];
	readonly sourcePath: LibraryRenderingPath | null;
	readonly phase: 'omitted' | 'ambiguous' | 'loading' | 'ready' | 'failed';
	readonly preview: LibraryPreview | null;
	readonly error: string | null;
}
export interface GenrePreviewState {
	readonly owner: GenrePreviewOwner | null;
	readonly capacity: number;
	readonly stale: boolean;
	readonly artist: GenrePreviewSection;
	readonly album: GenrePreviewSection;
}
interface Dependencies {
	readonly read: (ref: LibraryRowReference, limit: number) => Promise<LibraryPreviewResponse>;
	readonly isCurrent: (owner: GenrePreviewOwner) => boolean;
	readonly canRetry: () => boolean;
	readonly onStale: (owner: GenrePreviewOwner) => void;
}
const KINDS = ['artist', 'album'] as const;
const empty = (kind: LibraryPreviewItemKind): GenrePreviewSection => ({
	kind, candidates: [], sourcePath: null, phase: 'omitted', preview: null, error: null
});
const idle = (): GenrePreviewState => ({ owner: null, capacity: 0, stale: false,
	artist: empty('artist'), album: empty('album') });

/** Subordinate prefix reader: never navigates, claims a session, or persists data. */
export class GenrePreviewController {
	readonly #deps: Dependencies;
	readonly #subscribers = new Set<(state: GenrePreviewState) => void>();
	#state = idle();
	#epoch = 0;
	#revision = 0;
	#disposed = false;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#tail: Promise<void> = Promise.resolve();
	#coverage: { owner: GenrePreviewOwner; revision: number; limit: number } | null = null;

	constructor(deps: Dependencies) { this.#deps = deps; }
	subscribe(run: (state: GenrePreviewState) => void): () => void {
		this.#subscribers.add(run); run(this.#state);
		return () => this.#subscribers.delete(run);
	}
	snapshot(): GenrePreviewState { return this.#state; }

	setPage(page: LiveLibraryPageState, rootGeneration: string | null, lifecycle: number): void {
		if (this.#disposed) return;
		const old = this.#state.owner;
		if (old?.page === page && old.rootGeneration === rootGeneration && old.lifecycle === lifecycle) return;
		if (page.phase !== 'ready' || page.target?.kind !== 'genre' || page.path?.origin !== 'genres' ||
			!page.level || !rootGeneration || page.level.generation !== rootGeneration ||
			page.target.ref.generation !== rootGeneration) { this.reset(); return; }
		this.#retire();
		const owner = { page, rootGeneration, lifecycle };
		const section = (kind: LibraryPreviewItemKind): GenrePreviewSection => {
			const candidates = page.level!.rows.filter(row =>
				libraryGenrePreviewKind({ ...row, hierarchy: page.path!.origin }) === kind);
			return { kind, candidates, preview: null, error: null,
				phase: candidates.length === 0 ? 'omitted' : candidates.length > 1 ? 'ambiguous' : 'loading',
				sourcePath: candidates.length === 1 ? libraryChildPath(page.path!, candidates[0]) : null };
		};
		this.#publish({ owner, capacity: 0, stale: false, artist: section('artist'), album: section('album') });
	}

	setCapacity(value: number): void {
		if (this.#disposed || !Number.isSafeInteger(value) || value < 0 || !this.#state.owner) return;
		const capacity = Math.min(value, LIBRARY_PREVIEW_LIMIT_MAX);
		if (capacity === this.#state.capacity) return;
		this.#publish({ ...this.#state, capacity });
		if (capacity === 0) { this.#cancelTimer(); this.#revision++; return; }
		if (this.#state.stale) return;
		const pendingTimer = this.#timer !== null;
		this.#cancelTimer();
		const covered = this.#coverage?.owner === this.#state.owner &&
			this.#coverage.revision === this.#revision && this.#coverage.limit >= capacity;
		const needed = !covered && KINDS.some(kind => this.#needsRead(kind, capacity));
		// Shrinking is presentation-only when a retained/in-flight prefix covers
		// it. Only a new read demand changes request ownership, not every pixel.
		if (!needed && !pendingTimer) return;
		this.#revision++;
		this.#timer = setTimeout(() => { this.#timer = null; this.#enqueue(capacity); }, 150);
	}

	retry(kind: LibraryPreviewItemKind): void {
		const owner = this.#state.owner;
		if (this.#disposed || !owner || this.#state.stale || this.#state.capacity === 0 ||
			!this.#deps.isCurrent(owner) || !this.#deps.canRetry() || this.#state[kind].phase !== 'failed') return;
		this.#cancelTimer(); this.#revision++;
		this.#section(kind, { ...this.#state[kind], phase: 'loading', error: null, preview: null });
		this.#enqueue(this.#state.capacity);
	}

	reset(): void {
		this.#retire();
		if (this.#state.owner !== null) this.#publish(idle());
	}
	dispose(): void { this.reset(); this.#disposed = true; this.#subscribers.clear(); }
	#cancelTimer(): void { if (this.#timer !== null) clearTimeout(this.#timer); this.#timer = null; }
	#retire(): void { this.#epoch++; this.#revision++; this.#cancelTimer(); this.#coverage = null; }
	#publish(state: GenrePreviewState): void { this.#state = state; for (const run of this.#subscribers) run(state); }
	#section(kind: LibraryPreviewItemKind, section: GenrePreviewSection): void {
		this.#publish({ ...this.#state, [kind]: section });
	}
	#needsRead(kind: LibraryPreviewItemKind, capacity: number): boolean {
		const section = this.#state[kind];
		if (section.candidates.length !== 1 || section.phase === 'failed') return false;
		return !section.preview || section.preview.rows.length < Math.min(capacity, section.preview.totalCount);
	}
	#enqueue(limit: number): void {
		const owner = this.#state.owner;
		const epoch = this.#epoch, revision = this.#revision;
		if (!owner) return;
		this.#coverage = { owner, revision, limit };
		const current = (): boolean => !this.#disposed && this.#state.owner === owner &&
			epoch === this.#epoch && revision === this.#revision && this.#deps.isCurrent(owner) && !this.#state.stale;
		// One queue across replacements too: old reads may finish, never publish
		// into a new page or overlap a second request to the public browse channel.
		this.#tail = this.#tail.then(async () => {
			for (const kind of KINDS) {
				if (!current()) return;
				if (!this.#needsRead(kind, limit)) continue;
				const section = this.#state[kind];
				const ref = section.candidates[0].ref;
				if (ref.generation !== owner.rootGeneration) { this.#stale(owner); return; }
				this.#section(kind, { ...section, phase: 'loading', error: null });
				if (!current()) return;
				try {
					const result = normalizeLibraryPreviewResponse(await this.#deps.read(ref, limit), limit);
					if (!current()) return;
					if (result?.kind === 'stale' || (result?.kind === 'preview' && result.generation !== owner.rootGeneration)) {
						this.#stale(owner); return;
					}
					if (!result || (result.kind === 'preview' && result.rows.some(row => row.kind !== kind))) {
						throw new Error('Roon returned an invalid preview.');
					}
					if (result.kind === 'unavailable') throw new Error(result.message);
					this.#section(kind, { ...section, phase: 'ready', preview: result, error: null });
				} catch (error) {
					if (!current()) return;
					this.#section(kind, { ...section, phase: 'failed', preview: null,
						error: error instanceof Error ? error.message : 'This preview is unavailable.' });
				}
			}
		});
	}
	#stale(owner: GenrePreviewOwner): void {
		this.#retire();
		const failed = (section: GenrePreviewSection): GenrePreviewSection => ({ ...section,
			phase: section.candidates.length === 1 ? 'failed' : section.phase, preview: null,
			error: 'This preview is no longer current. Retry to reload the genre.' });
		this.#publish({ ...this.#state, stale: true, artist: failed(this.#state.artist), album: failed(this.#state.album) });
		this.#deps.onStale(owner);
	}
}
