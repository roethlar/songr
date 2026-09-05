/**
 * The one interface every library backend answers, and the types its answers
 * are made of.
 *
 * `.agents/plans/library-live-view.md`, "Multi-backend shape (designed now,
 * built later)". Roon is the first implementation (`LiveLibrarySession`);
 * Plex, Jellyfin, Navidrome and Lyrion would be others. What makes that
 * possible is that a reference is OPAQUE to everything above this line: Roon's
 * is a session-bound token that dies with its generation, another backend's
 * could be a stable id, and no caller may care which.
 *
 * WHAT SLICE 1 DECLARES, AND WHAT IT DOES NOT. The plan names six members —
 * `connect`, `roots`, `open`, `search`, `resolvePath`, `onInvalidated`. This
 * file declares the ones Slice 1 implements. `open(ref)` arrives with Slice 2
 * (pages that open by key) and `search`/`resolvePath` with Slice 3
 * (addresses), because a member declared here today would have to be
 * implemented as a throw, and an interface whose methods lie about what the
 * system can do is worse than one that grows. Recorded rather than left to be
 * noticed: `.agents/state.md`, Slice 1.
 */
import type { AllowedBrowseHierarchy } from "../../shared/browseHierarchies";
import type { BrowseItem } from "../../shared/types";
import type {
  LibraryInvalidationReason,
  LibraryRootsUnavailableReason,
  LibraryRowReference,
} from "../../shared/libraryRootsContracts";
export type { LibraryInvalidationReason } from "../../shared/libraryRootsContracts";
import type {
  LibraryNodeKind,
  LibraryOpenUnavailableReason,
} from "../../shared/libraryOpenContracts";
import type {
  CoordinatedBrowseSession,
  LibraryActionAnchor,
} from "../roon/BrowseSessionCoordinator";

/**
 * One row held in memory, with the reference the UI was given for it.
 *
 * The raw Roon item key is deliberately NOT here. It lives in the coordinator's
 * token authority, and the only way back to it is to resolve the reference
 * inside a live session on the channel that minted it.
 */
export interface LibraryRootRowHold {
  readonly ref: LibraryRowReference;
  readonly title: string;
  readonly subtitle?: string;
  readonly imageKey?: string;
}

export interface LibraryRootHold {
  /** The level's own count, as Roon reported it. */
  readonly count: number;
  readonly rows: readonly LibraryRootRowHold[];
}

/**
 * A point-in-time snapshot of both roots, stamped with the generation every
 * reference in it belongs to.
 */
export interface LibrarySnapshot {
  readonly generation: string;
  readonly coreId: string;
  /** Epoch milliseconds when the read completed. */
  readonly readAt: number;
  readonly artists: LibraryRootHold;
  readonly albums: LibraryRootHold;
}

export type LibraryRootsOutcome =
  | { readonly kind: "snapshot"; readonly snapshot: LibrarySnapshot }
  | {
      readonly kind: "unavailable";
      readonly reason: LibraryRootsUnavailableReason;
      readonly message: string;
    };

/**
 * Why a generation was retired. Every one of these retires EVERY outstanding
 * reference; none of them retires some.
 */
export interface LibraryInvalidation {
  readonly reason: LibraryInvalidationReason;
  /** The generation that just died, when there was one. */
  readonly retired: string | null;
  readonly coreId: string | null;
}

/** What asked for a read; carried into logs and into the invalidation. */
export type LibraryReadTrigger =
  | "connect"
  | "reconnect"
  | "user-refresh"
  | "timer"
  | "scope-activation"
  | "first-read";

/**
 * Runs one unit of work on the serialized, server-driven catalog browse lease.
 *
 * Structurally identical to `CatalogBrowseRunner` in `src/server/`, declared
 * here so a core module does not import a server one. Every multi-call browse
 * the live session makes runs inside ONE of these, which is what makes a root
 * read and its page loads a single transaction that no other caller can
 * interleave — the plan's "one serialized coordinator transaction".
 */
export type LibraryBrowseRunner = <T>(
  coreId: string,
  work: (session: CoordinatedBrowseSession) => Promise<T>
) => Promise<T>;

/**
 * The coordinator's publication surface, narrowed to what the live session
 * needs. `BrowseSessionCoordinator` satisfies it structurally.
 */
export interface LibraryPublicationPort {
  beginCatalogPublication(sessionScope: string): number;
  replaceCatalogPublishedItems(
    sessionScope: string,
    authorityGeneration: number,
    items: readonly BrowseItem[]
  ): ReadonlyArray<{ token: string; item: BrowseItem }>;
  appendCatalogPublishedItems(
    sessionScope: string,
    authorityGeneration: number,
    items: readonly BrowseItem[]
  ): ReadonlyArray<{ token: string; item: BrowseItem }>;
  retireCatalogPublishedTokens(
    sessionScope: string,
    authorityGeneration: number,
    tokens: readonly string[]
  ): number;
  resolveCatalogPublishedItem(
    sessionScope: string,
    authorityGeneration: number,
    token: string
  ): BrowseItem & { itemKey: string };
}

/** One row of an opened level, with the reference the UI was given for it. */
export interface LibraryLevelRowHold {
  readonly ref: LibraryRowReference;
  readonly title: string;
  readonly subtitle?: string;
  readonly imageKey?: string;
  readonly kind: LibraryNodeKind;
}

/**
 * One level Roon rendered, as the session holds it before it goes on the wire.
 *
 * `title` is Roon's own heading for the level — the album's title on a track
 * list, the artist's name on a discography — which is how a page says what it
 * opened without trusting the client to remember.
 */
export interface LibraryLevelHold {
  readonly generation: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly count: number;
  readonly rows: readonly LibraryLevelRowHold[];
}

export type LibraryOpenOutcome =
  | { readonly kind: "level"; readonly level: LibraryLevelHold }
  /**
   * The reference named a snapshot that no longer exists. Not an error: the
   * reader re-reads the roots and resolves its page again.
   */
  | { readonly kind: "stale" }
  | {
      readonly kind: "unavailable";
      readonly reason: LibraryOpenUnavailableReason;
      readonly message: string;
    };

/** The two roots read on connect, and the two read only when asked for. */
export type LibraryOnDemandRoot = "genres" | "composers";

/**
 * One live reference, resolved into everything an action needs to act on it.
 *
 * `.agents/plans/library-live-view.md` Slice 2. Measured on the owner's Core
 * before this existed (2026-09-03, `.agents/state.md`): browsing an album's
 * `Play Album` row, or a track row, with a zone bound answers with the four
 * action leaves. So a live action needs no track index, no title selector and
 * no track-list digest — the reference the reader clicked IS the subject, and
 * that is the whole of the identity. Nothing here is a controller-minted id and
 * nothing here is compared against another surface.
 *
 * `anchor` travels because a Roon item key is meaningless off the session that
 * minted it; `generation` travels because a reference is worth exactly as much
 * as the snapshot it belongs to.
 */
export interface LibraryActionSubject {
  readonly anchor: LibraryActionAnchor;
  /** The opaque library generation the reference named. */
  readonly generation: string;
  readonly hierarchy: AllowedBrowseHierarchy;
  /** Ephemeral Roon authority; never leaves the server. */
  readonly itemKey: string;
  /** Roon's own text for the row, for logs and refusal messages only. */
  readonly title: string;
  readonly kind: LibraryNodeKind;
}

export interface LibrarySource {
  /** Which backend this is; for logs and diagnostics, never for behaviour. */
  readonly kind: string;

  /** A Core became available. Reads the roots. */
  connect(coreId: string, trigger?: LibraryReadTrigger): void;

  /** The Core is gone. Retires everything and holds no snapshot. */
  disconnect(reason: LibraryInvalidationReason): void;

  /** The snapshot in hand right now, without reading anything. */
  current(): LibrarySnapshot | null;

  /**
   * The current snapshot, reading the roots first if there is none.
   *
   * Never re-reads a snapshot it already has: the caller that wants fresh
   * truth asks for it by name (`refresh`), and the caller that wants to know
   * whether what it holds is still true asks `revalidate`.
   */
  roots(trigger: LibraryReadTrigger): Promise<LibraryRootsOutcome>;

  /** Re-read both roots unconditionally, retiring every reference. */
  refresh(trigger: LibraryReadTrigger): Promise<LibraryRootsOutcome>;

  /**
   * Ask the Core for the two root counts and re-read only if they moved.
   *
   * Measured 2026-09-03 on the owner's Core: a count check costs ~125 ms and
   * one call per root against ~1.7 s and 61 calls for a full read of both.
   */
  revalidate(trigger: LibraryReadTrigger): Promise<LibraryRootsOutcome>;

  /**
   * One published reference, back to the row it names, or a refusal.
   *
   * The primitive every later open is built on, and the only way back to a
   * Roon item key. It throws rather than answering null: a caller that acted
   * on a retired reference is asking about a library that no longer exists,
   * and the one thing it must not receive is a plausible answer.
   */
  resolve(ref: LibraryRowReference): BrowseItem & { itemKey: string };

  /**
   * One published reference, resolved into an action's subject, or a refusal.
   *
   * `.agents/plans/library-live-view.md` Slice 2. The same two checks `open`
   * makes — the generation must be the one currently published, and the token
   * must be one it carries — and for the same reason: a reference from a
   * retired snapshot names nothing, and the caller must be told so rather than
   * handed the nearest plausible row. It throws `STALE_GENERATION`, which is
   * reported to the reader; it is never a silent no-op.
   */
  resolveActionSubject(ref: LibraryRowReference): LibraryActionSubject;

  /**
   * Whether a subject resolved earlier still belongs to the live snapshot.
   *
   * Asked between the claim and the dispatch, and again before execution, so a
   * refresh landing mid-action refuses rather than plays.
   */
  isActionSubjectCurrent(subject: Readonly<LibraryActionSubject>): boolean;

  /**
   * Open one published reference and read the level Roon renders beneath it.
   *
   * `.agents/plans/library-live-view.md` Slice 2, and the plan's invariant in
   * one method: the row is browsed on the Core before any page appears, so a
   * row Roon no longer has produces a refusal rather than a page. Every row of
   * the level comes back with its own reference, minted into the SAME
   * generation, so a reader can descend without anything above it going dead.
   */
  open(ref: LibraryRowReference): Promise<LibraryOpenOutcome>;

  /**
   * Read one of the roots that is not held on connect, as a level.
   *
   * Genres and Composers are lists like any other, but they are not part of
   * what a reader always has open, so they are paid for when a reader asks
   * rather than on every connect. They come back in the level shape because
   * that is what they are, and their rows open exactly the way every other row
   * does.
   */
  openRoot(root: LibraryOnDemandRoot): Promise<LibraryOpenOutcome>;

  /** Told whenever a generation is retired, with what died and why. */
  onInvalidated(listener: (event: LibraryInvalidation) => void): () => void;

  /** Stops timers and retires everything. */
  close(): void;
}
