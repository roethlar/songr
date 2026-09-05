import { ALBUM_ACTION_MAX_CHOICES } from "../../shared/albumActionContracts";
import { ALBUM_DETAIL_MAX_TRACKS } from "../../shared/libraryAlbumContracts";
import {
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  normalizeCatalogText,
} from "../../shared/catalogContracts";
import { BrowseItem, BrowseResult } from "../../shared/types";
import { CoordinatedBrowseSession } from "./BrowseSessionCoordinator";

const MAX_DETAIL_ROWS = ALBUM_DETAIL_MAX_TRACKS + ALBUM_ACTION_MAX_CHOICES;
const CONTROL_CHARACTER = /\p{Cc}/u;

export type AlbumDetailResolverErrorCode =
  | "ALBUM_NOT_FOUND"
  | "ALBUM_AMBIGUOUS"
  | "DETAIL_INCOMPLETE"
  | "DETAIL_MISMATCH";

export class AlbumDetailResolverError extends Error {
  public constructor(
    public readonly code: AlbumDetailResolverErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AlbumDetailResolverError";
    Object.setPrototypeOf(this, AlbumDetailResolverError.prototype);
    Error.captureStackTrace?.(this, AlbumDetailResolverError);
  }
}

function canonicalDisplayText(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > CATALOG_DISPLAY_TEXT_MAX_LENGTH
  ) {
    return null;
  }
  const canonical = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return canonical.length > 0 && !CONTROL_CHARACTER.test(canonical)
    ? canonical
    : null;
}

/**
 * Reads one opened album level and returns its ordered track titles.
 *
 * WHAT THIS USED TO BE. This class opened a stable catalog album from a
 * freshly re-observed live artist level and turned it into keyless catalog
 * evidence — fingerprints, edition candidates, chooser descriptors, duplicate
 * revalidation. All of that belonged to the saved catalog model and died with
 * it (`.agents/plans/library-live-view.md` Slice 4). What remains is the one
 * part that never needed a stored record: given an item key and the title the
 * row that produced it rendered, read the level under it and say what its
 * tracks are called, in Roon's own order.
 *
 * Its one caller is the collection (genre/composer drill) album page, which
 * uses the returned titles to build the detail digest an action lease is
 * granted against.
 *
 * The header check is title-only, on purpose. The expected title is the
 * rendering of the very row this key came from, so this compares one level of
 * one drill against the level directly under it — the same surface, one step
 * apart. The subtitle is NOT checked: a drill row's credit line may be absent,
 * and an absent credit has nothing to compare against a present header
 * subtitle. Refusing there would report "this album changed" over a page the
 * reader can plainly see.
 */
export class AlbumDetailResolver {
  public async readDetailRows(
    session: CoordinatedBrowseSession,
    hierarchy: string,
    itemKey: string,
    expectedTitle: string
  ): Promise<string[]> {
    const detail = await session.browse({
      hierarchy,
      itemKey,
      offset: 0,
      pageSize: MAX_DETAIL_ROWS,
    });
    return this.readDetail(detail, normalizeCatalogText(expectedTitle));
  }

  private readDetail(detail: BrowseResult, normalizedTitle: string): string[] {
    const headerTitle = canonicalDisplayText(detail.title);
    if (
      !headerTitle ||
      normalizeCatalogText(headerTitle) !== normalizedTitle
    ) {
      throw new AlbumDetailResolverError(
        "DETAIL_MISMATCH",
        "The live album detail header does not match the row it was opened from"
      );
    }

    const total = detail.totalCount ?? detail.count;
    if (
      detail.offset !== 0 ||
      !Number.isSafeInteger(total) ||
      total < 1 ||
      total > MAX_DETAIL_ROWS ||
      detail.items.length !== total
    ) {
      throw new AlbumDetailResolverError(
        "DETAIL_INCOMPLETE",
        "Roon returned an incomplete or oversized album detail"
      );
    }

    const structural = detail.items.filter((item) => this.isStructural(item));
    if (
      structural.length !== detail.items.length ||
      new Set(structural.map((item) => item.itemKey)).size !== structural.length
    ) {
      throw new AlbumDetailResolverError(
        "DETAIL_INCOMPLETE",
        "The album detail contained an invalid or duplicate row"
      );
    }
    const typed = structural.filter(
      (item) => normalizeCatalogText(item.itemType ?? "") === "track"
    );
    const untypedShape = structural.filter(
      (item) =>
        item.hint === "action_list" &&
        normalizeCatalogText(item.title) !== "play album" &&
        Boolean(item.subtitle) &&
        normalizeCatalogText(item.itemType ?? "") !== "track"
    );
    if (typed.length > 0 && untypedShape.length > 0) {
      throw new AlbumDetailResolverError(
        "DETAIL_INCOMPLETE",
        "The album detail mixed typed and untyped track evidence"
      );
    }
    const tracks = typed.length > 0 ? typed : untypedShape;
    if (
      tracks.length < 1 ||
      tracks.length > ALBUM_DETAIL_MAX_TRACKS ||
      structural.length - tracks.length > ALBUM_ACTION_MAX_CHOICES
    ) {
      throw new AlbumDetailResolverError(
        "DETAIL_INCOMPLETE",
        "The album detail track list is empty or exceeds its bound"
      );
    }

    const orderedTrackTitles: string[] = [];
    for (const track of tracks) {
      const title = canonicalDisplayText(track.title);
      if (!title) {
        throw new AlbumDetailResolverError(
          "DETAIL_INCOMPLETE",
          "The album detail contained an invalid track title"
        );
      }
      orderedTrackTitles.push(title);
    }
    return orderedTrackTitles;
  }

  private isStructural(
    item: BrowseItem
  ): item is BrowseItem & { itemKey: string } {
    return (
      typeof item.itemKey === "string" &&
      item.itemKey.length > 0 &&
      (item.hint === "list" || item.hint === "action_list") &&
      item.isPlayable !== true
    );
  }
}
