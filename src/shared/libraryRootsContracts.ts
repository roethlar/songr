/**
 * The wire shape of Roon's own library roots, as the live view publishes them.
 *
 * `.agents/plans/library-live-view.md` Slice 1. The controller stores nothing
 * about the library on disk; what it holds is a session-scoped, generation-
 * stamped point-in-time snapshot of the two lists Roon renders, and this is the
 * shape that snapshot travels in.
 *
 * WHAT IS NOT IN HERE, and why each absence is deliberate:
 *
 * - No Roon item key. Every row is named by an opaque `{ generation, token }`
 *   reference minted by `BrowseSessionCoordinator`; the raw key stays on the
 *   server, bound to the browse session that produced it.
 * - No controller-minted id. There is no `localId`, no ordinal, no synthetic
 *   handle that outlives the snapshot. A reference is worthless the moment its
 *   generation is retired, and that is the point: it cannot be written down,
 *   so nothing downstream can be tempted to treat it as identity.
 * - No count on an album row, and no normalized text anywhere. Every string
 *   here is what Roon rendered, verbatim, for display and for filtering. None
 *   of it may be compared against another surface's text.
 *
 * THE GENERATION IS THE WHOLE CONTRACT. A reader holds a generation; the
 * server holds exactly one. When they agree, every reference the reader holds
 * names a row the server can still resolve. When they disagree, every one of
 * them is dead and the reader re-reads. There is no third state, and nothing
 * partially valid.
 */

/** Bumped when this shape changes, so an older reader is refused, not misread. */
export const LIBRARY_ROOTS_CONTRACT = "library-roots-v1" as const;
export const LIBRARY_SESSION_RETIRED_CONTRACT =
  "library-session-retired-v1" as const;
export const LIBRARY_INVALIDATION_REASONS = [
  "refresh",
  "count-mismatch",
  "connect",
  "reconnect",
  "core-lost",
  "session-lost",
  "read-failed",
  "shutdown",
] as const;
export type LibraryInvalidationReason =
  (typeof LIBRARY_INVALIDATION_REASONS)[number];

/** Longest display string accepted on the wire; Roon's own are far shorter. */
export const LIBRARY_TEXT_MAX_LENGTH = 1_024;

/** Longest opaque reference field accepted on the wire. */
export const LIBRARY_OPAQUE_MAX_LENGTH = 256;

/**
 * Most rows one root may carry.
 *
 * Matches the coordinator's own published-item bound for the catalog channel,
 * so a snapshot the server was willing to publish is never one this contract
 * refuses to carry. Measured scale for reference (owner's Core, 2026-09-03):
 * 1,678 artists and 3,906 albums.
 */
export const LIBRARY_ROOT_ROWS_MAX = 100_000;

/**
 * An opaque, generation-bound handle for one row Roon returned.
 *
 * Both halves are required to use it: the token names the row and the
 * generation names the snapshot the token belongs to. A token alone is
 * meaningless, which is why the two never travel apart.
 */
export interface LibraryRowReference {
  readonly generation: string;
  readonly token: string;
}

/** One row of a root, exactly as Roon rendered it. */
export interface LibraryRootRow {
  readonly ref: LibraryRowReference;
  /** Roon's own title text. */
  readonly title: string;
  /**
   * Roon's own subtitle text, when the row carried one.
   *
   * The same field means different things on the two roots, because Roon puts
   * different things there: on an Artists row it is the album count ("58
   * Albums"); on an Albums row it is the credit. The contract carries the text
   * rather than an interpretation, and the surface that renders it decides
   * which it is — the one place that is entitled to know.
   */
  readonly subtitle?: string;
  /** Roon's artwork key, when the row carried one. */
  readonly imageKey?: string;
}

export interface LibraryRootView {
  /** The level's own count, as Roon reported it. */
  readonly count: number;
  readonly rows: readonly LibraryRootRow[];
}

/** A complete point-in-time snapshot of both roots. */
export interface LibraryRootsSnapshot {
  readonly contract: typeof LIBRARY_ROOTS_CONTRACT;
  readonly kind: "snapshot";
  readonly generation: string;
  readonly coreId: string;
  /** When the roots were read, ISO-8601. */
  readonly readAt: string;
  readonly artists: LibraryRootView;
  readonly albums: LibraryRootView;
}

/**
 * The answer to "is the generation I hold still the current one?".
 *
 * Carries no rows on purpose: a reader whose generation is current already has
 * every row, and re-sending a megabyte to say "nothing changed" would make the
 * cheap check the expensive one.
 */
export interface LibraryRootsCurrent {
  readonly contract: typeof LIBRARY_ROOTS_CONTRACT;
  readonly kind: "current";
  readonly generation: string;
  readonly coreId: string;
}

export type LibraryRootsResponse = LibraryRootsSnapshot | LibraryRootsCurrent;

/**
 * Why the server has no snapshot to give.
 *
 * Named states rather than one generic failure, because the surface says
 * different things for each: nothing is paired, the Core is being spared, or
 * the read itself refused.
 */
export type LibraryRootsUnavailableReason =
  | "no-core"
  | "core-under-pressure"
  | "read-failed";

export interface LibraryRootsUnavailable {
  readonly contract: typeof LIBRARY_ROOTS_CONTRACT;
  readonly kind: "unavailable";
  readonly reason: LibraryRootsUnavailableReason;
  /** Plain sentence for a reader; never a Roon key or an internal identifier. */
  readonly message: string;
}

export interface LibrarySessionRetiredEvent {
  readonly contract: typeof LIBRARY_SESSION_RETIRED_CONTRACT;
  readonly coreId: string;
  readonly retired: string | null;
  readonly reason: LibraryInvalidationReason;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) => typeof key === "string" && expected.includes(key)
    )
  );
}

export function normalizeLibrarySessionRetiredEvent(
  value: unknown
): LibrarySessionRetiredEvent | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["contract", "coreId", "retired", "reason"]) ||
    value.contract !== LIBRARY_SESSION_RETIRED_CONTRACT ||
    !isText(value.coreId, LIBRARY_OPAQUE_MAX_LENGTH) ||
    (value.retired !== null &&
      !isText(value.retired, LIBRARY_OPAQUE_MAX_LENGTH)) ||
    !LIBRARY_INVALIDATION_REASONS.includes(
      value.reason as LibraryInvalidationReason
    )
  ) {
    return null;
  }
  return {
    contract: LIBRARY_SESSION_RETIRED_CONTRACT,
    coreId: value.coreId,
    retired: value.retired,
    reason: value.reason as LibraryInvalidationReason,
  };
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isOptionalText(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function normalizeReference(value: unknown): LibraryRowReference | null {
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

function normalizeRow(
  value: unknown,
  generation: string
): LibraryRootRow | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const ref = normalizeReference(raw.ref);
  // A row whose reference names a different snapshot than the envelope is not
  // a row with a stale field — it is a payload nobody can reason about, and it
  // is refused whole rather than repaired.
  if (ref === null || ref.generation !== generation) return null;
  if (typeof raw.title !== "string" || raw.title.length > LIBRARY_TEXT_MAX_LENGTH) {
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
    ...(typeof raw.subtitle === "string" ? { subtitle: raw.subtitle } : {}),
    ...(typeof raw.imageKey === "string" ? { imageKey: raw.imageKey } : {}),
  };
}

function normalizeRootView(
  value: unknown,
  generation: string
): LibraryRootView | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(raw.count) ||
    (raw.count as number) < 0 ||
    (raw.count as number) > LIBRARY_ROOT_ROWS_MAX ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > LIBRARY_ROOT_ROWS_MAX
  ) {
    return null;
  }
  const rows: LibraryRootRow[] = [];
  for (const entry of raw.rows) {
    const row = normalizeRow(entry, generation);
    if (row === null) return null;
    rows.push(row);
  }
  // The count Roon reported and the rows actually carried must agree. A root
  // that disagrees with itself is exactly the case the reader's integrity
  // rules exist to refuse, and letting it through here would undo them.
  if (rows.length !== (raw.count as number)) return null;
  return { count: raw.count as number, rows };
}

/**
 * Validates one roots response, answering `null` for anything that is not one.
 *
 * Strict on purpose, in the shape every other contract in this repo is strict:
 * a partially-understood library payload would be rendered as if it were the
 * library.
 */
export function normalizeLibraryRootsResponse(
  value: unknown
): LibraryRootsResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.contract !== LIBRARY_ROOTS_CONTRACT) return null;
  if (
    !isText(raw.generation, LIBRARY_OPAQUE_MAX_LENGTH) ||
    !isText(raw.coreId, LIBRARY_OPAQUE_MAX_LENGTH)
  ) {
    return null;
  }
  if (raw.kind === "current") {
    return {
      contract: LIBRARY_ROOTS_CONTRACT,
      kind: "current",
      generation: raw.generation,
      coreId: raw.coreId,
    };
  }
  if (raw.kind !== "snapshot") return null;
  if (!isText(raw.readAt, LIBRARY_TEXT_MAX_LENGTH)) return null;
  const artists = normalizeRootView(raw.artists, raw.generation);
  const albums = normalizeRootView(raw.albums, raw.generation);
  if (artists === null || albums === null) return null;
  return {
    contract: LIBRARY_ROOTS_CONTRACT,
    kind: "snapshot",
    generation: raw.generation,
    coreId: raw.coreId,
    readAt: raw.readAt,
    artists,
    albums,
  };
}

export function normalizeLibraryRootsUnavailable(
  value: unknown
): LibraryRootsUnavailable | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.contract !== LIBRARY_ROOTS_CONTRACT || raw.kind !== "unavailable") {
    return null;
  }
  if (
    raw.reason !== "no-core" &&
    raw.reason !== "core-under-pressure" &&
    raw.reason !== "read-failed"
  ) {
    return null;
  }
  if (!isText(raw.message, LIBRARY_TEXT_MAX_LENGTH)) return null;
  return {
    contract: LIBRARY_ROOTS_CONTRACT,
    kind: "unavailable",
    reason: raw.reason,
    message: raw.message,
  };
}

/**
 * The album count Roon writes on an Artists row, and the ONE place that rule
 * lives.
 *
 * The row talks about itself: "58 Albums" is Roon's own statement about the
 * artist that row names, not a join with anything. Every one of the owner's
 * 1,678 Artists rows carried a digit-bearing subtitle when this was measured
 * (2026-09-03), so a row that yields no count here is genuinely unusual, and
 * `null` says so rather than answering 0 — 0 is an answer, and rendering
 * absence as 0 would tell a reader something the library never said.
 */
export function parseRoonArtistAlbumCount(
  subtitle: string | undefined
): number | null {
  const match = subtitle?.match(/\d[\d,]*/u);
  if (!match) return null;
  const parsed = Number(match[0].split(",").join(""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
