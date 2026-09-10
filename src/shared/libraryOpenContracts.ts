/**
 * The wire shape of one level Roon rendered, as the live view publishes it.
 *
 * `.agents/plans/library-live-view.md` Slice 2. Slice 1 published Roon's two
 * roots; this is what happens when a reader opens one of those rows. The server
 * browses the row Roon's own item key names, reads the level completely, and
 * publishes every row in it as another opaque `{ generation, token }` reference
 * belonging to the SAME snapshot the parent row belonged to.
 *
 * WHAT A LEVEL IS, AND WHAT IT IS NOT. It is Roon's own list, in Roon's own
 * order, with Roon's own strings — the same discipline as the roots contract.
 * It is not a page: nothing here decides that an artist's level is a
 * discography or that an album's level is a track listing. That reading belongs
 * to the surface, and the server states only what it can know from the path it
 * walked, in `kind` below.
 *
 * WHY EVERY ROW CARRIES A REFERENCE, INCLUDING THE VERB ROWS. Roon renders
 * "Play Album" as a row of the level like any other, and a surface that wants
 * to offer it has to be able to name it. Naming is all a reference does here;
 * this contract carries no way to execute anything.
 *
 * THE GENERATION IS STILL THE WHOLE CONTRACT. A level's references are worth
 * exactly as much as the snapshot they were minted in. When that snapshot is
 * retired every reference in every level dies at once, and a request carrying
 * one is refused `stale` rather than answered approximately.
 */

import type { LibraryRowReference } from "./libraryRootsContracts";
import {
  LIBRARY_OPAQUE_MAX_LENGTH,
  LIBRARY_TEXT_MAX_LENGTH,
} from "./libraryRootsContracts";

/** Bumped when this shape changes, so an older reader is refused, not misread. */
export const LIBRARY_OPEN_CONTRACT = "library-open-v1" as const;

/**
 * Most rows one level may carry.
 *
 * Sized from the largest level the owner's Core actually renders: the
 * `Pop/Rock` genre's album list is 2,696 rows (measured 2026-09-03). The bound
 * is well above that and well below the roots bound, because a level is one
 * page's worth of list and a root is the whole library.
 */
export const LIBRARY_LEVEL_ROWS_MAX = 20_000;

/**
 * What the server knows a row to be, from the path it walked to reach it.
 *
 * NOT a guess about the row's text, and never a comparison against another
 * surface. The Artists root publishes artists because it is the Artists root;
 * the level under an artist publishes albums because that is what Roon puts
 * under an artist. When Roon's own structure makes the answer ambiguous the
 * honest value is `entry` — a navigable row of a list whose nature the server
 * will not claim to know.
 *
 * `action` is the exception, and it is structural rather than semantic: Roon
 * marks its verb rows, and a surface must be able to keep them out of a grid of
 * albums without reading their titles.
 */
export const LIBRARY_NODE_KINDS = [
  "artist",
  "album",
  "track",
  "genre",
  "composer",
  "composition",
  /** A structural child of a collection node: Roon's own "Albums"/"Artists". */
  "section",
  /** A verb row: Play Artist, Play Album, Play Genre, Play Composer, Play Work. */
  "action",
  /** Navigable, nature unclaimed. */
  "entry",
] as const;

export type LibraryNodeKind = (typeof LIBRARY_NODE_KINDS)[number];

/** One row of a level, exactly as Roon rendered it. */
export interface LibraryLevelRow {
  readonly ref: LibraryRowReference;
  /** Roon's own title text. */
  readonly title: string;
  /**
   * Roon's own subtitle text, when the row carried one.
   *
   * As on the roots, the contract carries the text rather than an
   * interpretation: on an album row under an artist it is the credit, on a
   * track row it is the performers, on a genre row it is a count. The surface
   * that renders it decides which, because it is the one that knows what it
   * asked for.
   */
  readonly subtitle?: string;
  /** Roon's artwork key, when the row carried one. */
  readonly imageKey?: string;
  readonly kind: LibraryNodeKind;
}

/**
 * The level itself.
 *
 * `title` and `subtitle` are Roon's own heading for the level, which is how a
 * page states what it opened without the client having to remember what it
 * clicked — and, more usefully, how a page can tell that Roon opened something
 * other than what was asked for.
 */
export interface LibraryLevel {
  readonly contract: typeof LIBRARY_OPEN_CONTRACT;
  readonly kind: "level";
  readonly generation: string;
  readonly title: string;
  readonly subtitle?: string;
  /** The level's own count, as Roon reported it. Equals `rows.length`. */
  readonly count: number;
  readonly rows: readonly LibraryLevelRow[];
}

/**
 * The reference is gone.
 *
 * A distinct answer rather than an error, because it is not a failure: it is
 * the library saying the snapshot this reader was holding has been replaced.
 * The reader re-reads the roots and resolves its page again, which is exactly
 * what it would do after a reload.
 */
export interface LibraryOpenStale {
  readonly contract: typeof LIBRARY_OPEN_CONTRACT;
  readonly kind: "stale";
}

/** Why the server could not read the level at all. */
export type LibraryOpenUnavailableReason =
  | "no-core"
  | "core-under-pressure"
  | "read-failed";

export interface LibraryOpenUnavailable {
  readonly contract: typeof LIBRARY_OPEN_CONTRACT;
  readonly kind: "unavailable";
  readonly reason: LibraryOpenUnavailableReason;
  /** Plain sentence for a reader; never a Roon key or an internal identifier. */
  readonly message: string;
}

export type LibraryOpenResponse =
  | LibraryLevel
  | LibraryOpenStale
  | LibraryOpenUnavailable;

/** The body of an open request: one reference, and nothing else. */
export interface LibraryOpenRequest {
  readonly ref: LibraryRowReference;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isOptionalText(value: unknown, max: number): boolean {
  return (
    value === undefined || (typeof value === "string" && value.length <= max)
  );
}

function isNodeKind(value: unknown): value is LibraryNodeKind {
  return (
    typeof value === "string" &&
    (LIBRARY_NODE_KINDS as readonly string[]).includes(value)
  );
}

export function normalizeLibraryRowReference(
  value: unknown
): LibraryRowReference | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    !isText(raw.generation, LIBRARY_OPAQUE_MAX_LENGTH) ||
    !isText(raw.token, LIBRARY_OPAQUE_MAX_LENGTH)
  ) {
    return null;
  }
  return { generation: raw.generation, token: raw.token };
}

export function normalizeLibraryOpenRequest(
  value: unknown
): LibraryOpenRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = normalizeLibraryRowReference(
    (value as Record<string, unknown>).ref
  );
  return ref === null ? null : { ref };
}

export function normalizeLibraryLevelRow(
  value: unknown,
  generation: string
): LibraryLevelRow | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const ref = normalizeLibraryRowReference(raw.ref);
  // A row whose reference names a different snapshot than the level it arrived
  // in is not a row with one stale field — it is a payload nobody can reason
  // about, and it is refused whole rather than repaired.
  if (ref === null || ref.generation !== generation) return null;
  if (!isNodeKind(raw.kind)) return null;
  if (
    typeof raw.title !== "string" ||
    raw.title.length > LIBRARY_TEXT_MAX_LENGTH
  ) {
    return null;
  }
  if (
    !isOptionalText(raw.subtitle, LIBRARY_TEXT_MAX_LENGTH) ||
    !isOptionalText(raw.imageKey, LIBRARY_OPAQUE_MAX_LENGTH)
  ) {
    return null;
  }
  return {
    ref,
    title: raw.title,
    kind: raw.kind,
    ...(typeof raw.subtitle === "string" ? { subtitle: raw.subtitle } : {}),
    ...(typeof raw.imageKey === "string" ? { imageKey: raw.imageKey } : {}),
  };
}

/**
 * Validates one open response, answering `null` for anything that is not one.
 *
 * Strict in the shape every other contract in this repo is strict: a
 * partially-understood level would be rendered as if it were the level.
 */
export function normalizeLibraryOpenResponse(
  value: unknown
): LibraryOpenResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.contract !== LIBRARY_OPEN_CONTRACT) return null;
  if (raw.kind === "stale") {
    return { contract: LIBRARY_OPEN_CONTRACT, kind: "stale" };
  }
  if (raw.kind === "unavailable") {
    if (
      raw.reason !== "no-core" &&
      raw.reason !== "core-under-pressure" &&
      raw.reason !== "read-failed"
    ) {
      return null;
    }
    if (!isText(raw.message, LIBRARY_TEXT_MAX_LENGTH)) return null;
    return {
      contract: LIBRARY_OPEN_CONTRACT,
      kind: "unavailable",
      reason: raw.reason,
      message: raw.message,
    };
  }
  if (raw.kind !== "level") return null;
  if (!isText(raw.generation, LIBRARY_OPAQUE_MAX_LENGTH)) return null;
  if (
    typeof raw.title !== "string" ||
    raw.title.length > LIBRARY_TEXT_MAX_LENGTH ||
    !isOptionalText(raw.subtitle, LIBRARY_TEXT_MAX_LENGTH)
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(raw.count) ||
    (raw.count as number) < 0 ||
    (raw.count as number) > LIBRARY_LEVEL_ROWS_MAX ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > LIBRARY_LEVEL_ROWS_MAX
  ) {
    return null;
  }
  const rows: LibraryLevelRow[] = [];
  for (const entry of raw.rows) {
    const row = normalizeLibraryLevelRow(entry, raw.generation);
    if (row === null) return null;
    rows.push(row);
  }
  // The count Roon reported and the rows actually carried must agree, the same
  // rule the roots contract applies for the same reason: a level that
  // disagrees with itself is what the reader's integrity rules exist to
  // refuse, and letting it through here would undo them.
  if (rows.length !== (raw.count as number)) return null;
  return {
    contract: LIBRARY_OPEN_CONTRACT,
    kind: "level",
    generation: raw.generation,
    title: raw.title,
    count: raw.count as number,
    rows,
    ...(typeof raw.subtitle === "string" ? { subtitle: raw.subtitle } : {}),
  };
}

/**
 * Roon's own verb rows, by the exact label Roon renders.
 *
 * Comparing a live row against these fixed literals is not a cross-surface
 * join: it is one surface's structural label against a constant, the same move
 * `CollectionDrillResolver` makes to find a collection's "Albums" child. No
 * identity is being matched, and the classification decides only whether a row
 * is a verb — never which album or track it is.
 */
export const LIBRARY_VERB_LABELS: readonly string[] = [
  "play album",
  "play artist",
  "play genre",
  "play composer",
  "play composition",
  "play work",
  "play now",
  "play from here",
  "shuffle",
  "queue",
  "start radio",
];

/** Roon's own structural children of a collection node. */
export const LIBRARY_SECTION_LABELS: readonly string[] = ["albums", "artists"];

/**
 * The structural facts a row's kind is decided from. Deliberately not a
 * `BrowseItem`: nothing here may depend on a Roon item key.
 */
export interface LibraryRowShape {
  readonly title: string;
  readonly subtitle?: string;
  readonly hint?: string;
  readonly itemType?: string;
}

function labelOf(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * What a level's ordinary rows are, given the row that was opened to reach it.
 *
 * The ONE place Roon's library structure is written down, so the server assigns
 * a kind from the path it walked rather than from what the text looks like, and
 * so no second copy of the rule can drift.
 *
 * Every case here was read off the owner's own Core rather than assumed
 * (2026-09-03): an artist opens onto albums, an album onto its tracks, a
 * composer onto compositions — not albums, which is why this is written down
 * rather than guessed — and a genre onto a section list whose ordinary rows are
 * subgenres.
 */
export function libraryImpliedChildKind(node: {
  readonly kind: LibraryNodeKind;
  readonly title: string;
}): LibraryNodeKind {
  switch (node.kind) {
    case "artist":
      return "album";
    case "album":
      return "track";
    case "composer":
      return "composition";
    case "composition":
      return "track";
    case "genre":
      return "genre";
    // A section is the one row whose own label decides its children rather
    // than its parent's kind: Roon's "Albums" holds albums and its "Artists"
    // holds artists, and there is no other way to know which.
    case "section": {
      const label = labelOf(node.title);
      if (label === "albums") return "album";
      if (label === "artists") return "artist";
      return "entry";
    }
    default:
      return "entry";
  }
}

/**
 * One row's kind, from what its level implies and what Roon marked it as.
 *
 * WHY THE VERB TEST DIFFERS FROM `AlbumDetailResolver`'s track rule, on
 * purpose. That reader needs certainty that a row is a track before binding it
 * to a catalog record, so it requires a subtitle and drops anything that fails.
 * Here the cost of the two mistakes is reversed: dropping a real track
 * silently shortens a track list the reader is looking at, which is a false
 * statement about the album. So a row is a verb only when Roon's own verb
 * label is what it renders AND it carries no subtitle — a track with no
 * credited performers stays a track, and the only way to lose one would be for
 * Roon to title it exactly "Play Album" and give it no subtitle at all.
 */
export function libraryRowKind(
  implied: LibraryNodeKind,
  row: LibraryRowShape
): LibraryNodeKind {
  const label = labelOf(row.title);
  if (row.hint === "action") return "action";
  if (
    row.hint === "action_list" &&
    row.subtitle === undefined &&
    LIBRARY_VERB_LABELS.includes(label)
  ) {
    return "action";
  }
  if (implied === "genre" && LIBRARY_SECTION_LABELS.includes(label)) {
    return "section";
  }
  return implied;
}
