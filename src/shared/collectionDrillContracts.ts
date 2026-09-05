/**
 * The collection drill's own open locator: what a genre or composer album card
 * needs in order to be found again in a session that has never seen it.
 *
 * `.agents/plans/library-walk-binding.md` Slice 8. Slice 7 deleted the join
 * that used to give these cards a catalog identity — a live drill row was
 * looked up in the stored catalog by normalized title and artist, and whatever
 * that lookup found was pinned onto the row — and the cards stopped opening as
 * a result. This file is the honest replacement.
 *
 * WHY THIS IS NOT AN `AlbumRef`, AND NOT AN `ArtistAlbumEntry` EITHER. Both of
 * those name a record the controller owns. This names nothing: it is a
 * description of a row's appearance in one collection's drill, and the only
 * thing it can do is find that row again by re-walking the same drill. The
 * album page it opens is built from that live row, not from a catalog identity
 * minted for the occasion.
 *
 * THE WALL THIS FILE SITS BEHIND, WRITTEN DOWN SO IT IS NOT RE-ARGUED. An item
 * page normally opens by `albumLocalId`, and every way of minting one for a
 * genre row is a cross-surface text join: a title+artist lookup in the stored
 * catalog (deleted), an image-key tie-break (deleted with it), or a track-title
 * fingerprint compared across two surfaces (the same join wearing a hash). The
 * `genres` and `composers` hierarchies are a THIRD surface — neither the
 * Artists root nor the Albums root — so the prohibition written on
 * `ArtistAlbumEntry.albumLocalId` covers them unchanged. A collection drill
 * therefore never mints an identity. It navigates through its own drill
 * context, which is exactly what Slice 1's rule requires of a card that cannot
 * be honestly linked.
 *
 * THE INVARIANT. Every comparison in this file is between two renderings of the
 * SAME drill: a stored collection-row rendering against a fresh collection-row
 * rendering of the same hierarchy, or a stored album-row rendering against a
 * fresh album-row rendering inside that same collection. Nothing here compares
 * a name to a credit, stored text to a catalog record, or one hierarchy's text
 * to another's. Every comparison additionally requires a UNIQUE match before it
 * resolves; where a match is not unique the answer is "ambiguous", never a
 * tie-break.
 *
 * WHY IT IS KEYLESS. A drill row's key is doubly ephemeral.
 * `BrowseSessionCoordinator` replaces every raw Roon key with an opaque token
 * bound to one role and one mode generation, and the raw key underneath is
 * bound to a Roon browse session. A locator built on either would be worthless
 * the moment it was durable — which is the whole reason this shape exists, and
 * the same reason `ArtistAlbumOpenLocator` is keyless.
 */

import {
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
} from "./catalogContracts";

export const COLLECTION_DRILL_SOURCE_CONTRACT =
  "controller-collection-drill-v1" as const;

/**
 * The hierarchies whose rows drill to an album list.
 *
 * The hierarchy is part of the locator because these are different surfaces. A
 * locator minted in one must never resolve against another, however alike the
 * two rows read.
 *
 * WHY `artists` IS ONE OF THEM. An artist's discography is a collection in
 * exactly the sense this file means: a row in a hierarchy root, drilled to an
 * album list whose rows carry their own credits. The walk stores that list, and
 * a stored row has no catalog identity to open by — an album the artist merely
 * appears on is credited to somebody else, and Roon does not even render the
 * artist's own name identically on the two surfaces (observed live: an Artists
 * root row reading `’Til Tuesday` over drill rows credited `'Til Tuesday`). The
 * only honest way back to such a row is the way a genre card already goes:
 * re-walk the same drill and find the row by its own rendering. So the artist
 * page navigates through its own drill context, which is what Slice 1 required
 * of a card that cannot be linked, and it does it through this shape rather
 * than a second copy of it.
 */
export const COLLECTION_DRILL_HIERARCHIES = [
  "genres",
  "composers",
  "artists",
] as const;

export type CollectionDrillHierarchy =
  (typeof COLLECTION_DRILL_HIERARCHIES)[number];

export function isCollectionDrillHierarchy(
  value: unknown
): value is CollectionDrillHierarchy {
  return (
    typeof value === "string" &&
    (COLLECTION_DRILL_HIERARCHIES as readonly string[]).includes(value)
  );
}

/**
 * The most album rows one collection drill may be read to.
 *
 * This is the same bound the UI's drill already pages to, and the two must stay
 * equal: a card the UI renders past the server's bound would fail to open with
 * `missing`, which would be a true statement about the server's truncated read
 * and a false one about the library. `unifiedDrillStore` imports this constant
 * rather than keeping its own copy.
 */
export const COLLECTION_DRILL_MAX_ALBUMS = 10_000;

/**
 * The most collection rows a hierarchy root may be read to while looking for
 * one collection. Genres and composers are both far smaller than this on any
 * real library; the bound exists so an unbounded root cannot turn one album
 * open into an unbounded drain.
 */
export const COLLECTION_DRILL_MAX_ROOT_ROWS = 100_000;

/**
 * Everything one collection drill's album row renders, as one comparable unit.
 *
 * Two fields, and deliberately only two: a drill row renders a title and a
 * credit line, and nothing else that could tell two rows apart. The walk's
 * `ArtistAlbumEntryRendering` carries a third, `editionText`, and the resolver
 * that fills it in has never observed a level that supplied one — it hard-codes
 * the empty string. Copying that field here for symmetry would add a comparison
 * dimension that is always empty, and a field that never discriminates cannot
 * make a match more precise; it can only imply a precision this surface does
 * not have. When a drill level is observed to carry edition text, the honest
 * move is to add it here and to the walk together, on that evidence.
 *
 * Both fields are text Roon rendered on that row. Neither is an identity, and
 * neither may be compared against another surface's text.
 */
export interface CollectionDrillAlbumRendering {
  /** Canonical display title, exactly as the drill row rendered it. */
  readonly exactTitle: string;
  /**
   * The row's own credit line (its subtitle), or the empty string when the row
   * carried none.
   *
   * Unlike the walk's `exactCredit`, a missing credit is stored as absent
   * rather than substituted. The walk had to substitute — the `AlbumRef` it
   * publishes rejects an empty artist, so a walk that recorded the absence
   * would store entries no locator could match. Nothing downstream of this
   * shape publishes an `AlbumRef`, so there is no such pressure here, and
   * recording what the row actually rendered is the more truthful of the two.
   */
  readonly exactCredit: string;
}

/**
 * What a drill card needs in order to be reopened later, in a session that has
 * never seen the drill it came from.
 *
 * Deliberately keyless, for the reason at the top of this file. Deliberately
 * positionless too: a card's index in one drain is not a handle on the row,
 * because a later drain can order or page differently, and falling back to a
 * position when a rendering match came back ambiguous would be a guess wearing
 * a number.
 *
 * This shape is durable — it is what a page-state snapshot persists for a
 * collection-opened album — precisely because it contains nothing session-bound.
 */
export interface CollectionDrillOpenLocator {
  readonly sourceContract: typeof COLLECTION_DRILL_SOURCE_CONTRACT;
  /** Which collection hierarchy this locator was minted in. */
  readonly hierarchy: CollectionDrillHierarchy;
  /** The collection row's own title, to be re-found uniquely in the root. */
  readonly collectionExactName: string;
  /**
   * The rest of that root row's rendering, when the surface that minted this
   * locator read it.
   *
   * Present, it must match too: an Artists root can carry two rows with one
   * name and different subtitles — two real artist entities — and a locator
   * naming only the name matches both of them and opens neither. Absent, it
   * discriminates nothing, which is the honest reading for a surface that
   * never read a subtitle at all rather than a claim that the row had none.
   * Genre and composer cards are minted from a drill label alone and carry no
   * subtitle; artist cards always carry theirs, empty string included.
   */
  readonly collectionExactSubtitle?: string;
  /** The album row's rendering, to be selected uniquely inside that drill. */
  readonly rendering: CollectionDrillAlbumRendering;
}

/**
 * A collection root row's rendering, as the surface minting a locator read it.
 *
 * `exactSubtitle` absent means "not read", never "read as empty" — see the
 * locator field above.
 */
export interface CollectionDrillCollectionRendering {
  readonly exactName: string;
  readonly exactSubtitle?: string;
}

/**
 * Which of the locator's two stages could not answer.
 *
 * `collection` is stage one — re-finding the stored collection row in a fresh
 * hierarchy root. `entry` is stage two — selecting the stored album rendering
 * inside that collection's fresh drill. A surface says different things about
 * each: a missing collection means the library no longer carries that genre or
 * composer at all, while a missing entry means this album left that collection.
 */
export type CollectionDrillOpenStage = "collection" | "entry";

/**
 * Why a locator could not be resolved. Both stages fail the same two ways, so
 * both report through this type.
 *
 * `ambiguous` is a real answer, not an error: it means the surface genuinely
 * carries two rows this locator cannot tell apart, and the honest response is
 * to say so rather than to open one of them.
 */
export type CollectionDrillOpenFailure = "missing" | "ambiguous";

export type CollectionDrillOpenResolution =
  | { readonly kind: "resolved"; readonly index: number }
  | {
      readonly kind: CollectionDrillOpenFailure;
      /** How many rows matched: 0 for missing, 2 or more for ambiguous. */
      readonly matchCount: number;
    };

/**
 * A resolution failure with the stage that produced it — the shape a surface
 * needs in order to say which half of the locator could not answer, and how
 * many rows it saw when it could not.
 */
export interface CollectionDrillOpenFailureDetail {
  readonly kind: CollectionDrillOpenFailure;
  readonly stage: CollectionDrillOpenStage;
  /** How many rows matched: 0 for missing, 2 or more for ambiguous. */
  readonly matchCount: number;
}

const CONTROL_CHARACTER = /\p{Cc}/u;

function canonicalDisplayText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function isBoundedDisplayText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CATALOG_DISPLAY_TEXT_MAX_LENGTH &&
    canonicalDisplayText(value) === value &&
    !CONTROL_CHARACTER.test(value)
  );
}

/** Display text that is allowed to be empty — a credit line. */
function isOptionalDisplayText(value: unknown): value is string {
  return value === "" || isBoundedDisplayText(value);
}

function plainDataRecord(value: unknown): Record<string, unknown> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") return null;
  }
  return record;
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  optionalKeys: readonly string[] = []
): boolean {
  const ownKeys = Object.keys(record);
  return (
    keys.every((key) => ownKeys.includes(key)) &&
    ownKeys.every((key) => keys.includes(key) || optionalKeys.includes(key))
  );
}

/**
 * The one canonical form both readers of a drill level must render a row in.
 *
 * There are two readers of the same rows and they must agree exactly, or the
 * locator is worthless. The surface reads a drill to render cards and mints a
 * locator from the row a reader clicked; the server re-reads the same drill
 * later and looks for that rendering. If one side canonicalized and the other
 * kept Roon's raw text, a row carrying a double space or a decomposed accent
 * would be stored in one form and sought in another, and the open would report
 * `missing` — a true statement about the two strings and a false one about the
 * library.
 *
 * So neither side is allowed its own copy of this. Both call this function, and
 * the walk's equivalent discipline is written down in the same words: both
 * readers of one drill level render a row the same way, deliberately.
 *
 * Returns `null` for text that cannot serve as a rendering at all — absent,
 * empty once trimmed, over the display bound, or carrying control characters.
 */
export function canonicalCollectionDrillText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > CATALOG_DISPLAY_TEXT_MAX_LENGTH) {
    return null;
  }
  const canonical = canonicalDisplayText(value);
  return canonical.length > 0 && !CONTROL_CHARACTER.test(canonical)
    ? canonical
    : null;
}

/**
 * One drill row's title and subtitle, read into the comparable form.
 *
 * `null` when the row has no usable title: a row nobody can render cannot be
 * located again either, so it is not offered as an openable card and is not
 * counted as a rival when deciding whether some other row is unique.
 *
 * A row with no subtitle — or one whose subtitle is blank or unusable — gets
 * `creditFallback` when the level it was read from has one, and the empty
 * credit otherwise. The empty credit is a value like any other and matches only
 * rows that also rendered none.
 */
export function collectionDrillRenderingOf(
  title: unknown,
  subtitle: unknown,
  creditFallback?: string
): CollectionDrillAlbumRendering | null {
  const exactTitle = canonicalCollectionDrillText(title);
  if (exactTitle === null) return null;
  return {
    exactTitle,
    exactCredit:
      canonicalCollectionDrillText(subtitle) ??
      canonicalCollectionDrillText(creditFallback) ??
      "",
  };
}

/**
 * What a credit-less row on this level renders as, if not an absence.
 *
 * A property of the LEVEL, not of whoever is reading it, which is the only
 * reason it can be stated here at all. Three readers walk an artist's album
 * level — `DiscographyResolver`, `ArtistAlbumWalk`, and this file's resolver —
 * and the first of them substitutes the browsed artist for a missing credit
 * because the `AlbumRef` it publishes rejects an empty artist. The second
 * matches it deliberately. If the third recorded the absence instead, a stored
 * credit-less entry would never be found again in its own drill, and the page
 * would say "this album has left this artist's discography" about an album
 * still sitting in it.
 *
 * Genres and composers have no such reader and no such pressure: a credit-less
 * row there records its absence, which is the more truthful of the two, and
 * substituting a genre's name for an album credit would be a lie about a
 * different kind of thing entirely.
 */
export function collectionDrillCreditFallback(
  hierarchy: CollectionDrillHierarchy,
  collectionExactName: string
): string | undefined {
  return hierarchy === "artists" ? collectionExactName : undefined;
}

/**
 * True when two album renderings are the same row as far as this file can tell.
 *
 * Exact equality on every rendered field, with no folding of any kind: no case
 * folding, no punctuation folding, no normalization beyond the canonical
 * display form both sides were already read in. Folding is what turned
 * `’Til Tuesday` and `'Til Tuesday` into a binding problem in the first place;
 * a comparison that folds is a comparison that guesses.
 */
export function collectionDrillRenderingsEqual(
  left: CollectionDrillAlbumRendering,
  right: CollectionDrillAlbumRendering
): boolean {
  return (
    left.exactTitle === right.exactTitle && left.exactCredit === right.exactCredit
  );
}

/**
 * Stage one: find the collection again in a freshly loaded hierarchy root.
 *
 * Same surface, exact rendering, unique or nothing. Two genres rendering the
 * same name is not the common case, but it is a possible one, and taking the
 * first would open a different collection's album list with no signal that it
 * had happened. On an Artists root it is not even uncommon: a library can hold
 * two artist entities with one name, rendered as two rows that differ only in
 * their subtitles.
 *
 * Which is why the subtitle is compared whenever the locator carries one. A
 * locator that never read a subtitle carries none and is matched on the name
 * alone — the rule it was minted under, unchanged.
 */
export function resolveCollectionRow(
  freshRootRows: readonly CollectionDrillCollectionRendering[],
  locator: CollectionDrillCollectionRendering
): CollectionDrillOpenResolution {
  let index = -1;
  let matchCount = 0;
  for (let position = 0; position < freshRootRows.length; position += 1) {
    const row = freshRootRows[position];
    if (row.exactName !== locator.exactName) continue;
    if (
      locator.exactSubtitle !== undefined &&
      (row.exactSubtitle ?? "") !== locator.exactSubtitle
    ) {
      continue;
    }
    matchCount += 1;
    if (matchCount === 1) index = position;
  }
  if (matchCount === 1) return { kind: "resolved", index };
  return { kind: matchCount === 0 ? "missing" : "ambiguous", matchCount };
}

/**
 * Stage two: select the stored album rendering within a fresh drill of that
 * collection.
 *
 * Same surface, whole rendering, unique or nothing. On zero matches the album
 * has left the collection (a real outcome — libraries change, and so does what
 * Roon files under a genre); on two or more the drill genuinely carries rows
 * this locator cannot distinguish, and the caller must say so rather than open
 * one of them.
 *
 * There is no discriminator to fall back to and there is deliberately not going
 * to be one built from text: a track-title fingerprint compared against another
 * surface is the same cross-surface join this plan deleted, hashed. If a future
 * drill level supplies its own further rendering, it belongs in
 * `CollectionDrillAlbumRendering` where it is compared against the same surface.
 */
export function resolveCollectionDrillAlbum(
  freshRows: readonly CollectionDrillAlbumRendering[],
  rendering: CollectionDrillAlbumRendering
): CollectionDrillOpenResolution {
  let index = -1;
  let matchCount = 0;
  for (let position = 0; position < freshRows.length; position += 1) {
    if (collectionDrillRenderingsEqual(freshRows[position], rendering)) {
      matchCount += 1;
      if (matchCount === 1) index = position;
    }
  }
  if (matchCount === 1) return { kind: "resolved", index };
  return { kind: matchCount === 0 ? "missing" : "ambiguous", matchCount };
}

/**
 * Whether a drill row can be opened at all, answered from the drill's own rows.
 *
 * A surface that renders a drill can answer this up front, before anyone
 * clicks: a row whose whole rendering repeats inside the SAME drill will come
 * back ambiguous from stage two no matter what a fresh drill looks like —
 * re-drilling returns the same two rows and cannot break the tie either — so
 * the card is marked non-openable at render time rather than failing after a
 * click and a round trip.
 */
export function collectionDrillAlbumIsOpenable(
  rows: readonly CollectionDrillAlbumRendering[],
  index: number
): boolean {
  const row = rows[index];
  if (row === undefined) return false;
  return resolveCollectionDrillAlbum(rows, row).kind === "resolved";
}

/**
 * The locator that reopens one row of one collection's drill.
 *
 * The collection is named by whatever the minting surface actually read of its
 * root row. A surface holding only a label passes only a name, and the locator
 * carries no subtitle rather than an invented empty one.
 */
export function collectionDrillOpenLocator(
  hierarchy: CollectionDrillHierarchy,
  collection: CollectionDrillCollectionRendering,
  rows: readonly CollectionDrillAlbumRendering[],
  index: number
): CollectionDrillOpenLocator | null {
  const row = rows[index];
  if (row === undefined) return null;
  return {
    sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
    hierarchy,
    collectionExactName: collection.exactName,
    ...(collection.exactSubtitle === undefined
      ? {}
      : { collectionExactSubtitle: collection.exactSubtitle }),
    rendering: { exactTitle: row.exactTitle, exactCredit: row.exactCredit },
  };
}

const RENDERING_KEYS = ["exactTitle", "exactCredit"];

export function normalizeCollectionDrillAlbumRendering(
  value: unknown
): CollectionDrillAlbumRendering | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, RENDERING_KEYS) ||
    !isBoundedDisplayText(record.exactTitle) ||
    !isOptionalDisplayText(record.exactCredit)
  ) {
    return null;
  }
  return Object.freeze({
    exactTitle: record.exactTitle,
    exactCredit: record.exactCredit,
  });
}

const LOCATOR_KEYS = [
  "sourceContract",
  "hierarchy",
  "collectionExactName",
  "rendering",
];

/**
 * Optional, and it stays optional rather than becoming a required empty
 * string: a locator persisted by a page that never read subtitles is still a
 * true locator, and rewriting it with an empty subtitle would turn "not read"
 * into the false claim "this row had none".
 */
const LOCATOR_OPTIONAL_KEYS = ["collectionExactSubtitle"];

export function normalizeCollectionDrillOpenLocator(
  value: unknown
): CollectionDrillOpenLocator | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, LOCATOR_KEYS, LOCATOR_OPTIONAL_KEYS) ||
    record.sourceContract !== COLLECTION_DRILL_SOURCE_CONTRACT ||
    !isCollectionDrillHierarchy(record.hierarchy) ||
    !isBoundedDisplayText(record.collectionExactName) ||
    (Object.prototype.hasOwnProperty.call(record, "collectionExactSubtitle") &&
      !isOptionalDisplayText(record.collectionExactSubtitle))
  ) {
    return null;
  }
  const rendering = normalizeCollectionDrillAlbumRendering(record.rendering);
  if (!rendering) return null;
  return Object.freeze({
    sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
    hierarchy: record.hierarchy,
    collectionExactName: record.collectionExactName,
    ...(typeof record.collectionExactSubtitle === "string"
      ? { collectionExactSubtitle: record.collectionExactSubtitle }
      : {}),
    rendering,
  });
}

const FAILURE_KEYS = ["kind", "stage", "matchCount"];

/**
 * A failure detail, with the count checked against the reason it is attached
 * to.
 *
 * `missing` is exactly zero matches and `ambiguous` is exactly two or more; one
 * match is `resolved` and can never arrive here. A record that disagreed with
 * itself would let a surface report "two rows match" over an answer that found
 * none, so there is nowhere in this shape to put a fabricated number.
 */
export function normalizeCollectionDrillOpenFailure(
  value: unknown
): CollectionDrillOpenFailureDetail | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, FAILURE_KEYS) ||
    (record.kind !== "missing" && record.kind !== "ambiguous") ||
    (record.stage !== "collection" && record.stage !== "entry") ||
    typeof record.matchCount !== "number" ||
    !Number.isSafeInteger(record.matchCount) ||
    record.matchCount < 0
  ) {
    return null;
  }
  if (record.kind === "missing" && record.matchCount !== 0) return null;
  if (record.kind === "ambiguous" && record.matchCount < 2) return null;
  return Object.freeze({
    kind: record.kind,
    stage: record.stage,
    matchCount: record.matchCount,
  });
}
