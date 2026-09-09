import type {
	LibraryLevel,
	LibraryLevelRow,
	LibraryNodeKind,
	LibraryOpenResponse
} from '@shared/libraryOpenContracts';
import type { LibraryRootRow, LibraryRowReference } from '@shared/libraryRootsContracts';

/**
 * A page's address in the live library: the renderings Roon showed on the way
 * to it (`.agents/plans/library-live-view.md` Slice 2).
 *
 * WHY A PAGE IS ADDRESSED BY RENDERINGS AND NEVER BY A REFERENCE. A reference
 * is worth exactly one generation. The moment the roots are re-read every
 * reference in the browser is dead, and a page holding one would have nothing
 * left to be. What survives a generation change is what the reader saw: the
 * artist row said `’Til Tuesday`, the album row under it said `Voices Carry` by
 * `’Til Tuesday`. Those are Roon's own strings, and asking Roon for them again
 * is the same question the reader's click asked the first time.
 *
 * WHY THIS IS NOT A CROSS-SURFACE NAME JOIN. Every step is re-walked through
 * the SAME list it was recorded from — the Artists root, then that artist's own
 * level, then that album's own level. No text is ever carried from one surface
 * to a different one and matched there. The path is a replay of one walk, not a
 * lookup in a second index.
 *
 * WHAT HAPPENS WHEN THE ANSWER IS NOT EXACTLY ONE ROW. Nothing is guessed. No
 * row is `missing` and the surface says so in the page's own words; more than
 * one is `ambiguous`, which is Roon showing two identical rows, and the reader
 * is told that rather than shown whichever came first. Slice 3 turns the
 * ambiguous case into an explicit group page; until then it is reported, and
 * reporting it is what keeps a wrong page off the screen.
 */

/** Which of Roon's own lists a path starts from. */
export type LibraryPathOrigin = 'artists' | 'albums' | 'genres' | 'composers';

/** The two roots the session holds; the other two are read on demand. */
export type LibraryHeldRoot = Extract<LibraryPathOrigin, 'artists' | 'albums'>;
export type LibraryOnDemandRoot = Extract<LibraryPathOrigin, 'genres' | 'composers'>;

export const LIBRARY_HELD_ROOTS: readonly LibraryHeldRoot[] = ['artists', 'albums'];

/**
 * One row on the path, by what Roon rendered on it.
 *
 * `credit` is present only where Roon's subtitle is part of what distinguishes
 * the row — an album's credit line. It is deliberately ABSENT on an artist,
 * genre or composer step, where the subtitle is a count: a count changes when
 * the library changes, and an address that stopped resolving because an artist
 * gained an album would be an address that lies about what is gone.
 */
export interface LibraryPathStep {
	readonly kind: LibraryNodeKind;
	readonly title: string;
	readonly credit?: string;
	/** Present on album steps; empty when Roon rendered no edition text. */
	readonly edition?: string;
}

export interface LibraryRenderingPath {
	readonly origin: LibraryPathOrigin;
	/** At least one step; the last names the page. */
	readonly steps: readonly LibraryPathStep[];
}

/** The row a path resolved to, in this generation. */
export interface LibraryPathTarget {
	readonly ref: LibraryRowReference;
	readonly title: string;
	readonly subtitle: string | null;
	readonly imageKey: string | null;
	readonly kind: LibraryNodeKind;
}

export type LibraryPathResolution =
	| { readonly kind: 'resolved'; readonly target: LibraryPathTarget }
	| { readonly kind: 'missing'; readonly at: LibraryPathStep }
	| {
			readonly kind: 'ambiguous';
			readonly at: LibraryPathStep;
			readonly count: number;
			/** The current live rows the group page may open without guessing. */
			readonly targets: readonly LibraryPathTarget[];
			/** Address prefix ending at the repeated rendering. */
			readonly path: LibraryRenderingPath;
	  }
	| { readonly kind: 'stale' }
	| { readonly kind: 'unavailable'; readonly message: string }
	| { readonly kind: 'canceled' };

export interface LibraryPathDependencies {
	/** Roon's held roots as the store has them, or `null` when none is held. */
	readonly heldRoot: (root: LibraryHeldRoot) => readonly LibraryRootRow[] | null;
	readonly openRef: (ref: LibraryRowReference) => Promise<LibraryOpenResponse>;
	readonly openRoot: (root: LibraryOnDemandRoot) => Promise<LibraryOpenResponse>;
	/**
	 * Consulted after every await. A resolution that is no longer wanted stops
	 * where it is rather than reading the rest of a path nobody will look at —
	 * every await here is a place the reader may already have navigated away.
	 */
	readonly stillWanted?: () => boolean;
}

/**
 * Whether one row is the row a step names.
 *
 * Exact string equality, deliberately: these are Roon's own characters on both
 * sides, recorded from one list and compared against that same list. Folding
 * case or accents would make two rows Roon renders differently into one row
 * here, which is the ambiguity this whole path exists to refuse.
 */
export function libraryRowMatchesStep(
	row: { readonly title: string; readonly subtitle?: string },
	step: LibraryPathStep
): boolean {
	if (row.title !== step.title) return false;
	if (step.credit === undefined) return true;
	// The current live row contract exposes title and credit only. A nonempty
	// edition in an externally supplied address therefore cannot be proved.
	return (row.subtitle ?? '') === step.credit && (step.edition ?? '') === '';
}

function targetOf(row: LibraryRootRow | LibraryLevelRow, kind: LibraryNodeKind): LibraryPathTarget {
	return {
		ref: row.ref,
		title: row.title,
		subtitle: row.subtitle ?? null,
		imageKey: row.imageKey ?? null,
		kind: 'kind' in row ? row.kind : kind
	};
}

function pick<T extends { readonly title: string; readonly subtitle?: string }>(
	rows: readonly T[],
	step: LibraryPathStep
):
	| { readonly kind: 'one'; readonly row: T }
	| { readonly kind: 'none' }
	| { readonly kind: 'many'; readonly rows: readonly T[] } {
	const matched = rows.filter((row) => libraryRowMatchesStep(row, step));
	if (matched.length === 1) return { kind: 'one', row: matched[0] };
	if (matched.length === 0) return { kind: 'none' };
	return { kind: 'many', rows: matched };
}

/** The step a path's origin is itself, for the "no longer in library" sentence. */
function originStep(origin: LibraryPathOrigin): LibraryPathStep {
	return origin === 'artists'
		? { kind: 'artist', title: 'Artists' }
		: origin === 'albums'
			? { kind: 'album', title: 'Albums' }
			: origin === 'genres'
				? { kind: 'genre', title: 'Genres' }
				: { kind: 'composer', title: 'Composers' };
}

/**
 * Walk a rendering path against the library as it is right now.
 *
 * Every step but the last is opened; the last is only found, because what a
 * page does with the row it addresses is the page's business — a track row is
 * never opened by anyone, and opening an album to find out whether it is there
 * would read a level twice.
 */
export async function resolveLibraryRenderingPath(
	dependencies: LibraryPathDependencies,
	path: LibraryRenderingPath
): Promise<LibraryPathResolution> {
	if (path.steps.length === 0) return { kind: 'missing', at: originStep(path.origin) };
	const wanted = dependencies.stillWanted ?? (() => true);

	let rows: readonly (LibraryRootRow | LibraryLevelRow)[];
	if (path.origin === 'artists' || path.origin === 'albums') {
		const held = dependencies.heldRoot(path.origin);
		// No held root is not "the row is gone": it is the reader having no
		// snapshot at all, which the roots load answers, not this walk.
		if (held === null) return { kind: 'stale' };
		rows = held;
	} else {
		const opened = await dependencies.openRoot(path.origin);
		if (!wanted()) return { kind: 'canceled' };
		if (opened.kind !== 'level') {
			return opened.kind === 'stale'
				? { kind: 'stale' }
				: { kind: 'unavailable', message: opened.message };
		}
		rows = opened.rows;
	}

	let target: LibraryPathTarget | null = null;
	for (let index = 0; index < path.steps.length; index += 1) {
		const step = path.steps[index];
		const found = pick(rows, step);
		if (found.kind === 'none') return { kind: 'missing', at: step };
		if (found.kind === 'many') {
			return {
				kind: 'ambiguous',
				at: step,
				count: found.rows.length,
				targets: found.rows.map((row) => targetOf(row, step.kind)),
				path: { origin: path.origin, steps: path.steps.slice(0, index + 1) }
			};
		}
		target = targetOf(found.row, step.kind);
		if (index === path.steps.length - 1) break;
		const opened = await dependencies.openRef(target.ref);
		if (!wanted()) return { kind: 'canceled' };
		if (opened.kind !== 'level') {
			return opened.kind === 'stale'
				? { kind: 'stale' }
				: { kind: 'unavailable', message: opened.message };
		}
		rows = opened.rows;
	}

	// Unreachable with a non-empty path: the loop either returns or assigns.
	return target === null ? { kind: 'stale' } : { kind: 'resolved', target };
}

/** The sentence a surface says when a path stopped resolving. */
export function libraryPathFailureMessage(resolution: LibraryPathResolution): string | null {
	switch (resolution.kind) {
		case 'missing':
			return `Roon no longer lists “${resolution.at.title}”.`;
		case 'ambiguous':
			return `Roon lists ${resolution.count} identical entries — merge them in Roon`;
		case 'unavailable':
			return resolution.message;
		default:
			return null;
	}
}

/** A step naming one album row, credit included because two may share a title. */
export function libraryAlbumStep(title: string, credit: string, edition = ''): LibraryPathStep {
	return { kind: 'album', title, credit, edition };
}

/** A child belongs to its explicit source, which need not be the visible page. */
export function libraryChildPath(source: LibraryRenderingPath, row: LibraryLevelRow): LibraryRenderingPath {
	const step = row.kind === 'album' ? libraryAlbumStep(row.title, row.subtitle ?? '')
		: { kind: row.kind, title: row.title };
	return { origin: source.origin, steps: [...source.steps, step] };
}
