/**
 * Resolving one `CollectionDrillOpenLocator` against a live Roon session.
 *
 * `.agents/plans/library-walk-binding.md` Slice 8b. The locator is keyless and
 * durable; this is the thing that turns it back into a live row when somebody
 * opens a genre or composer card. The whole path is a re-walk of the drill the
 * card came from: hierarchy root, the collection row, its album list, the album
 * row. Nothing here consults the catalog, and nothing here compares text from
 * one surface against text from another.
 *
 * Both comparisons are unique-or-nothing, and both report which stage refused.
 * `ambiguous` is a real answer about the library — two rows this locator cannot
 * tell apart — and never a reason to pick one.
 *
 * The live item key this produces is server-only. It is consumed immediately by
 * the caller that asked, and never crosses the wire or a persistence boundary:
 * `BrowseSessionCoordinator` binds raw keys to a Roon session, which is the
 * reason the locator is keyless in the first place.
 */

import {
  COLLECTION_DRILL_MAX_ALBUMS,
  COLLECTION_DRILL_MAX_ROOT_ROWS,
  CollectionDrillAlbumRendering,
  CollectionDrillHierarchy,
  CollectionDrillOpenFailure,
  CollectionDrillOpenLocator,
  CollectionDrillOpenStage,
  canonicalCollectionDrillText,
  collectionDrillCreditFallback,
  collectionDrillRenderingOf,
  resolveCollectionDrillAlbum,
  resolveCollectionRow,
} from "../../shared/collectionDrillContracts";
import { BrowseItem, BrowseResult } from "../../shared/types";
import { CoordinatedBrowseSession } from "./BrowseSessionCoordinator";
import { readCompleteBrowseLevel } from "./browseLevelReader";

export const COLLECTION_DRILL_PAGE_SIZE = 100;

/**
 * The structural label a collection node uses for its album list.
 *
 * Comparing a live menu row against this fixed constant is not a cross-surface
 * join: it is one surface's structural label against a literal, the same way
 * `DiscographyResolver` finds an artist's album path. Nothing about an album's
 * or an artist's identity is being matched here, and the result still has to be
 * unique before it is used.
 */
const ALBUMS_CHILD_LABEL = "Albums";

export type CollectionDrillResolverErrorCode =
  | "INCOMPLETE_COLLECTION_ROOT"
  | "INCOMPLETE_COLLECTION_DRILL"
  | "COLLECTION_ALBUMS_PATH_NOT_UNIQUE"
  | "COLLECTION_DRILL_TOO_LARGE";

export class CollectionDrillResolverError extends Error {
  public constructor(
    public readonly code: CollectionDrillResolverErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CollectionDrillResolverError";
    Object.setPrototypeOf(this, CollectionDrillResolverError.prototype);
    Error.captureStackTrace?.(this, CollectionDrillResolverError);
  }
}

/** The live row a locator resolved to. Server-only; never persisted. */
export interface ResolvedCollectionDrillAlbum {
  readonly kind: "resolved";
  readonly hierarchy: CollectionDrillHierarchy;
  readonly itemKey: string;
  /** What the row rendered now, which matched what the locator stored. */
  readonly rendering: CollectionDrillAlbumRendering;
  /**
   * The row's artwork key, when it carried one. An opaque hint and never an
   * identity: it is not compared to anything, on this surface or any other,
   * and an image-key tie-break is one of the joins this plan deleted.
   */
  readonly imageKeyHint?: string;
}

export interface RefusedCollectionDrillAlbum {
  readonly kind: CollectionDrillOpenFailure;
  readonly stage: CollectionDrillOpenStage;
  /** How many rows matched: 0 for missing, 2 or more for ambiguous. */
  readonly matchCount: number;
}

export type CollectionDrillResolution =
  | ResolvedCollectionDrillAlbum
  | RefusedCollectionDrillAlbum;

export interface CollectionDrillResolveOptions {
  /**
   * Called after every await. A caller whose page has been superseded or
   * cancelled throws from here and the walk stops rather than finishing a
   * read nobody is waiting for.
   */
  readonly assertCurrent?: () => void;
}

/**
 * A row that can be selected at all.
 *
 * Only an item key is required, deliberately matching what the surface itself
 * requires when it renders a drill. A server that were stricter than the
 * surface would refuse to reopen rows a reader can plainly see, and would
 * report that as `missing` — a statement about this filter rather than about
 * the library.
 */
function hasItemKey(item: BrowseItem): item is BrowseItem & { itemKey: string } {
  return typeof item.itemKey === "string" && item.itemKey.length > 0;
}

/** Play/Shuffle rows and other verbs are not albums, on either reader. */
function isActionItem(item: BrowseItem): boolean {
  return item.hint === "action" || item.hint === "action_list";
}

export class CollectionDrillResolver {
  public async resolve(
    session: CoordinatedBrowseSession,
    locator: CollectionDrillOpenLocator,
    options: CollectionDrillResolveOptions = {}
  ): Promise<CollectionDrillResolution> {
    const collectionRow = await this.findCollectionRow(session, locator, options);
    if (collectionRow.kind !== "resolved") return collectionRow;
    return this.findAlbumRow(session, locator, collectionRow.item, options);
  }

  /** Stage one: the collection itself, in a freshly loaded hierarchy root. */
  private async findCollectionRow(
    session: CoordinatedBrowseSession,
    locator: CollectionDrillOpenLocator,
    options: CollectionDrillResolveOptions
  ): Promise<
    | { readonly kind: "resolved"; readonly item: BrowseItem & { itemKey: string } }
    | RefusedCollectionDrillAlbum
  > {
    const first = await session.browse({
      hierarchy: locator.hierarchy,
      offset: 0,
      pageSize: COLLECTION_DRILL_PAGE_SIZE,
      popAll: true,
      refresh: true,
    });
    options.assertCurrent?.();
    const rootRows = await readCompleteBrowseLevel(session, first, {
      hierarchy: locator.hierarchy,
      label: "collection root",
      pageSize: COLLECTION_DRILL_PAGE_SIZE,
      maxRows: COLLECTION_DRILL_MAX_ROOT_ROWS,
      maxPages: Math.ceil(COLLECTION_DRILL_MAX_ROOT_ROWS / COLLECTION_DRILL_PAGE_SIZE),
      refuse: (message) =>
        new CollectionDrillResolverError("INCOMPLETE_COLLECTION_ROOT", message),
      assertCurrent: options.assertCurrent,
    });

    const candidates = rootRows.filter(hasItemKey);
    // Indices are preserved so a match maps back to its row. A row with no
    // usable title becomes the empty string, which can never match: the
    // locator's collection name is non-empty by its own contract, so an
    // unreadable row is neither selected nor counted as a rival.
    //
    // The subtitle is read from the same rows, and matters on an Artists root,
    // where two rows can carry one name and differ only there. It is compared
    // only when the locator carries one to compare against.
    const renderings = candidates.map((item) => ({
      exactName: canonicalCollectionDrillText(item.title) ?? "",
      exactSubtitle: canonicalCollectionDrillText(item.subtitle) ?? "",
    }));
    const resolution = resolveCollectionRow(renderings, {
      exactName: locator.collectionExactName,
      ...(locator.collectionExactSubtitle === undefined
        ? {}
        : { exactSubtitle: locator.collectionExactSubtitle }),
    });
    if (resolution.kind !== "resolved") {
      return {
        kind: resolution.kind,
        stage: "collection",
        matchCount: resolution.matchCount,
      };
    }
    return { kind: "resolved", item: candidates[resolution.index] };
  }

  /** Stage two: the album row, inside that collection's own album list. */
  private async findAlbumRow(
    session: CoordinatedBrowseSession,
    locator: CollectionDrillOpenLocator,
    collectionRow: BrowseItem & { itemKey: string },
    options: CollectionDrillResolveOptions
  ): Promise<CollectionDrillResolution> {
    const node = await session.browse({
      hierarchy: locator.hierarchy,
      itemKey: collectionRow.itemKey,
      offset: 0,
      pageSize: COLLECTION_DRILL_PAGE_SIZE,
    });
    options.assertCurrent?.();
    const nodeRows = await this.readLevel(session, node, locator.hierarchy, options);

    // A genre node is a section list — Play Genre, Albums, Artists, subgenres —
    // so the album list is one level further down. A composer node drills
    // straight to its albums and has no such child. Both shapes are real, so
    // the absence of the child is not an error; two of them is, because
    // choosing between them would be the guess this path exists to avoid.
    const albumsChildren = nodeRows
      .filter(hasItemKey)
      .filter(
        (item) => canonicalCollectionDrillText(item.title) === ALBUMS_CHILD_LABEL
      );
    if (albumsChildren.length > 1) {
      throw new CollectionDrillResolverError(
        "COLLECTION_ALBUMS_PATH_NOT_UNIQUE",
        "The collection offered more than one album list"
      );
    }

    let albumRows = nodeRows;
    if (albumsChildren.length === 1) {
      const level = await session.browse({
        hierarchy: locator.hierarchy,
        itemKey: albumsChildren[0].itemKey,
        offset: 0,
        pageSize: COLLECTION_DRILL_PAGE_SIZE,
      });
      options.assertCurrent?.();
      albumRows = await this.readLevel(session, level, locator.hierarchy, options);
    }

    const candidates: {
      readonly item: BrowseItem & { itemKey: string };
      readonly rendering: CollectionDrillAlbumRendering;
    }[] = [];
    // The level's own rule for a row that rendered no credit at all, applied
    // here so this reader renders such a row the way the other readers of the
    // same level do. Nothing is looked up: the fallback is the collection row
    // this walk just descended through, which is text from this very surface.
    const creditFallback = collectionDrillCreditFallback(
      locator.hierarchy,
      locator.collectionExactName
    );
    for (const item of albumRows) {
      if (!hasItemKey(item) || isActionItem(item)) continue;
      const rendering = collectionDrillRenderingOf(
        item.title,
        item.subtitle,
        creditFallback
      );
      if (rendering) candidates.push({ item, rendering });
    }

    const resolution = resolveCollectionDrillAlbum(
      candidates.map((candidate) => candidate.rendering),
      locator.rendering
    );
    if (resolution.kind !== "resolved") {
      return {
        kind: resolution.kind,
        stage: "entry",
        matchCount: resolution.matchCount,
      };
    }
    const chosen = candidates[resolution.index];
    return {
      kind: "resolved",
      hierarchy: locator.hierarchy,
      itemKey: chosen.item.itemKey,
      rendering: chosen.rendering,
      ...(typeof chosen.item.imageKey === "string" && chosen.item.imageKey.length > 0
        ? { imageKeyHint: chosen.item.imageKey }
        : {}),
    };
  }

  private readLevel(
    session: CoordinatedBrowseSession,
    first: BrowseResult,
    hierarchy: CollectionDrillHierarchy,
    options: CollectionDrillResolveOptions
  ): Promise<BrowseItem[]> {
    return readCompleteBrowseLevel(session, first, {
      hierarchy,
      label: "collection drill",
      pageSize: COLLECTION_DRILL_PAGE_SIZE,
      maxRows: COLLECTION_DRILL_MAX_ALBUMS,
      maxPages: Math.ceil(COLLECTION_DRILL_MAX_ALBUMS / COLLECTION_DRILL_PAGE_SIZE),
      refuse: (message) =>
        new CollectionDrillResolverError("INCOMPLETE_COLLECTION_DRILL", message),
      // A drill larger than the bound is different news from a malformed one:
      // it means the surface is showing part of a list, and the reader is
      // entitled to hear that rather than "this album is not here".
      tooLarge: () =>
        new CollectionDrillResolverError(
          "COLLECTION_DRILL_TOO_LARGE",
          "The collection drill exceeds the supported bound"
        ),
      assertCurrent: options.assertCurrent,
    });
  }
}
