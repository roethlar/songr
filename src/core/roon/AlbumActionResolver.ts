import { createHash } from "crypto";

import {
  ALBUM_ACTION_LABEL_MAX_LENGTH,
  ALBUM_ACTION_MAX_CHOICES,
  AlbumActionSemantic,
  AlbumActionTrackSelector,
} from "../../shared/albumActionContracts";
import { normalizeLibraryText } from "../../shared/libraryText";
import { BrowseItem, BrowseResult } from "../../shared/types";
import { CoordinatedBrowseSession } from "./BrowseSessionCoordinator";
import { CollectionDrillResolver } from "./CollectionDrillResolver";
import { CollectionDrillOpenLocator } from "../../shared/collectionDrillContracts";

const MAX_TRACK_ROWS = 500;
const MAX_DETAIL_ROWS = MAX_TRACK_ROWS + ALBUM_ACTION_MAX_CHOICES;
const MAX_ACTION_DEPTH = 4;
const CONTROL_CHARACTER = /\p{Cc}/u;

export type AlbumActionResolutionErrorCode =
  | "ALBUM_NOT_FOUND"
  | "ALBUM_AMBIGUOUS"
  | "ALBUM_CHANGED"
  | "TRACK_NOT_FOUND"
  | "TRACK_MISMATCH"
  | "ACTION_PATH_NOT_FOUND"
  | "NO_SUPPORTED_ACTIONS";

export class AlbumActionResolutionError extends Error {
  public constructor(
    public readonly code: AlbumActionResolutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AlbumActionResolutionError";
    Object.setPrototypeOf(this, AlbumActionResolutionError.prototype);
  }
}

/**
 * The Roon browse hierarchy an action's item key was resolved against. Keys
 * are only meaningful within the hierarchy/session that produced them, so
 * this must travel with the item key to execution time.
 */
export type AlbumActionBrowseHierarchy =
  | "search"
  | "albums"
  | "artists"
  | "genres"
  | "composers";

export interface ResolvedAlbumAction {
  readonly label: string;
  readonly semantic: AlbumActionSemantic;
  /** Ephemeral Roon authority; retained only inside the server operation. */
  readonly itemKey: string;
  /** Hierarchy this itemKey must be executed against. */
  readonly hierarchy: AlbumActionBrowseHierarchy;
}

export interface ResolvedAlbumActions {
  readonly actions: readonly ResolvedAlbumAction[];
}

/**
 * What an action on a collection-opened page has to go on.
 *
 * A locator and a digest, and nothing that names a catalog record — because
 * there is no catalog record. The locator finds the row again by re-walking
 * its own drill, and the digest is the fingerprint of the track list the page
 * published, so an album whose contents moved under the page cannot be acted
 * on by mistake.
 *
 * There is no version count here and there does not need to be one: a page
 * opens from a collection drill only when its rendering is unique inside that
 * drill, so the row IS the version.
 */
export interface AlbumActionCollectionSource {
  readonly locator: Readonly<CollectionDrillOpenLocator>;
  readonly detailDigest: string;
}

/**
 * What an action on a live library reference has to go on: the reference,
 * already resolved to the row it names on the session that minted it.
 *
 * There is nothing else, and nothing else is needed. Measured on the owner's
 * Core 2026-09-03 (`.agents/state.md`): browsing an album's `Play Album` row
 * with a zone bound answers with the four action leaves, and so does a track
 * row's own reference — including for both halves of a Roon-duplicated pair,
 * which each answered for themselves. So the reader's own click IS the subject.
 *
 * WHY THERE IS NO DIGEST HERE, UNLIKE THE OTHER TWO SOURCES. Those two have to
 * find the row again, by re-walking a drill or re-observing a discography, and
 * a fingerprint is how they prove they found the same one. This source never
 * looks for anything: the reference is bound to a snapshot, the snapshot is
 * retired whole the moment the library is re-read, and a reference from a
 * retired snapshot is refused rather than re-matched. There is no window in
 * which the row could have moved and no name to compare it against.
 */
export interface AlbumActionReferenceSource {
  readonly itemKey: string;
  readonly hierarchy: AlbumActionBrowseHierarchy;
  /** Roon's own text for the row, carried for refusal messages only. */
  readonly title: string;
}

/**
 * The one kind of page an action lease can still be granted to, kept tagged so
 * the service dispatches on the tag rather than on the shape.
 *
 * There used to be a second, `catalog`, whose source named a reconciled album
 * record and re-observed its artist's discography to find the row again. It
 * died with the saved catalog model (`.agents/plans/library-live-view.md`
 * Slice 4). A live library reference is not a page source at all — it needs no
 * page behind it — and travels as its own authority arm in the service.
 */
export type AlbumActionPageSource = {
  readonly kind: "collection";
  readonly source: AlbumActionCollectionSource;
};

export function createAlbumVersionDetailDigest(
  title: string,
  artist: string,
  orderedTrackTitles: readonly string[]
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        normalizeLibraryText(title),
        normalizeLibraryText(artist),
        orderedTrackTitles.map(normalizeLibraryText),
      ])
    )
    .digest("hex");
}

export interface AlbumActionResolverPort {
  resolveCollectionVersion(
    session: CoordinatedBrowseSession,
    source: Readonly<AlbumActionCollectionSource>,
    zoneId: string,
    track?: Readonly<AlbumActionTrackSelector>
  ): Promise<ResolvedAlbumActions>;
  resolveReference(
    session: CoordinatedBrowseSession,
    source: Readonly<AlbumActionReferenceSource>,
    zoneId: string
  ): Promise<ResolvedAlbumActions>;
}

/**
 * Resolves the exact action leaves Roon currently exposes for one album page
 * or one live library reference. Every call stays inside the action lease and
 * carries its original zone. Ephemeral item keys never leave the returned
 * server object.
 */
export class AlbumActionResolver implements AlbumActionResolverPort {
  public constructor(
    private readonly collectionDrillResolver = new CollectionDrillResolver()
  ) {}

  /**
   * Resolves the action leaves for a page opened from a genre or composer
   * drill.
   *
   * The whole path stays inside that drill: the locator is re-walked to the
   * row, the row is opened, and the leaves are read in the SAME hierarchy the
   * key came from — Roon's keys mean nothing outside the hierarchy and session
   * that issued them, which is why the hierarchy travels with them.
   *
   * The digest is the guard: the fingerprint of the ordered track titles this
   * page published. If the
   * album's contents moved since, the action refuses rather than playing
   * something the reader did not see. Note what is NOT checked — the detail
   * header's subtitle. A drill row's credit line may be absent, and an absent
   * credit has nothing to compare; the title and the track list carry it.
   */
  public async resolveCollectionVersion(
    session: CoordinatedBrowseSession,
    source: Readonly<AlbumActionCollectionSource>,
    zoneId: string,
    track?: Readonly<AlbumActionTrackSelector>
  ): Promise<ResolvedAlbumActions> {
    const zonedSession = this.zoneBoundSession(session, zoneId);
    const resolution = await this.collectionDrillResolver.resolve(
      zonedSession,
      source.locator
    );
    if (resolution.kind !== "resolved") {
      throw new AlbumActionResolutionError(
        resolution.kind === "missing" ? "ALBUM_NOT_FOUND" : "ALBUM_AMBIGUOUS",
        resolution.kind === "missing"
          ? "The selected album is no longer in that collection"
          : "The selected album is no longer unique in that collection"
      );
    }
    const detail = await zonedSession.browse({
      hierarchy: resolution.hierarchy,
      zoneId,
      itemKey: resolution.itemKey,
      pageSize: MAX_DETAIL_ROWS,
    });
    this.assertComplete(detail, MAX_DETAIL_ROWS, "ALBUM_AMBIGUOUS");
    if (
      normalizeLibraryText(detail.title ?? "") !==
      normalizeLibraryText(resolution.rendering.exactTitle)
    ) {
      throw new AlbumActionResolutionError(
        "ALBUM_CHANGED",
        "The selected album's live detail no longer matches the drill row"
      );
    }
    const digest = createAlbumVersionDetailDigest(
      resolution.rendering.exactTitle,
      resolution.rendering.exactCredit,
      this.trackRows(detail.items).map((row) => row.title)
    );
    if (digest !== source.detailDigest) {
      throw new AlbumActionResolutionError(
        "ALBUM_CHANGED",
        "The selected album track list changed"
      );
    }
    const target = track
      ? this.trackRow(detail, track)
      : this.playAlbumRow(detail);
    const leaves = await this.resolveLeaves(
      zonedSession,
      zoneId,
      target,
      resolution.hierarchy
    );
    return Object.freeze({ actions: Object.freeze(leaves) });
  }

  /**
   * Resolve the action leaves for one live library reference.
   *
   * `.agents/plans/library-live-view.md` Slice 2, and the whole of the live
   * album page's playback path. There is no search, no drill, no discography
   * re-observation and no re-matching of any kind: the row the reader clicked
   * was published by the session this call runs on, in the generation this
   * call is anchored to, so the only thing left to do is ask Roon what can be
   * done with it. Everything after that is the same code the other two sources
   * end in — `resolveLeaves` descends the action list and `normalizeLeaves`
   * refuses an ambiguous one — so there is one rule about what a leaf is.
   *
   * The zone binds the same way it does everywhere else here, and it is the
   * reason this works at all: Roon renders `Play Now` / `Add Next` / `Queue` /
   * `Start Radio` only for a browse carrying a zone.
   */
  public async resolveReference(
    session: CoordinatedBrowseSession,
    source: Readonly<AlbumActionReferenceSource>,
    zoneId: string
  ): Promise<ResolvedAlbumActions> {
    const zonedSession = this.zoneBoundSession(session, zoneId);
    const leaves = await this.resolveLeaves(
      zonedSession,
      zoneId,
      { itemKey: source.itemKey },
      source.hierarchy
    );
    return Object.freeze({ actions: Object.freeze(leaves) });
  }

  /**
   * Bind the client's index/title selector to exactly one live track row of
   * the already-verified album detail. The index addresses the same ordered
   * track list the digest proved, so a drifted list cannot rebind.
   */
  private trackRow(
    detail: BrowseResult,
    track: Readonly<AlbumActionTrackSelector>
  ): BrowseItem {
    const rows = this.trackRows(detail.items);
    if (
      !Number.isSafeInteger(track.index) ||
      track.index < 0 ||
      track.index >= rows.length
    ) {
      throw new AlbumActionResolutionError(
        "TRACK_NOT_FOUND",
        "The selected track index does not exist on the live album"
      );
    }
    const row = rows[track.index];
    if (normalizeLibraryText(row.title) !== normalizeLibraryText(track.title)) {
      throw new AlbumActionResolutionError(
        "TRACK_MISMATCH",
        "The live track at the selected index no longer matches its title"
      );
    }
    return row;
  }

  private trackRows(items: readonly BrowseItem[]): BrowseItem[] {
    const structural = this.structuralRows(items);
    const typed = structural.filter(
      (item) => normalizeLibraryText(item.itemType ?? "") === "track"
    );
    const untypedShape = structural.filter(
      (item) =>
        item.hint === "action_list" &&
        normalizeLibraryText(item.title) !== "play album" &&
        Boolean(item.subtitle) &&
        normalizeLibraryText(item.itemType ?? "") !== "track"
    );
    if (typed.length > 0 && untypedShape.length > 0) {
      throw new AlbumActionResolutionError(
        "ALBUM_AMBIGUOUS",
        "The album mixed typed and untyped track evidence"
      );
    }
    const candidates = typed.length > 0 ? typed : untypedShape;
    if (candidates.length > MAX_TRACK_ROWS) {
      throw new AlbumActionResolutionError(
        "ALBUM_AMBIGUOUS",
        "The album track list exceeded its resolution bound"
      );
    }
    if (candidates.some((item) => normalizeLibraryText(item.title).length === 0)) {
      throw new AlbumActionResolutionError(
        "ALBUM_AMBIGUOUS",
        "The album exposed an empty track title"
      );
    }
    return candidates;
  }

  private playAlbumRow(detail: BrowseResult): BrowseItem {
    const rows = this.structuralRows(detail.items).filter(
      (item) =>
        item.hint === "action_list" &&
        normalizeLibraryText(item.title) === "play album" &&
        normalizeLibraryText(item.itemType ?? "") !== "track"
    );
    if (rows.length !== 1) {
      throw new AlbumActionResolutionError(
        "ACTION_PATH_NOT_FOUND",
        "The album did not expose one exact Play Album path"
      );
    }
    return rows[0];
  }

  private async resolveLeaves(
    session: CoordinatedBrowseSession,
    zoneId: string,
    // Only the key is read, so the parameter says only that. A live reference
    // resolves to a row rather than to a `BrowseItem`, and widening the type to
    // fit would have meant inventing `isLoadable`/`isPlayable` values nobody
    // measured.
    initial: { readonly itemKey?: string },
    hierarchy: AlbumActionBrowseHierarchy
  ): Promise<ResolvedAlbumAction[]> {
    let cursor: { readonly itemKey?: string } = initial;
    for (let depth = 0; depth < MAX_ACTION_DEPTH; depth += 1) {
      const result = await session.browse({
        hierarchy,
        zoneId,
        itemKey: cursor.itemKey,
        pageSize: ALBUM_ACTION_MAX_CHOICES + 1,
      });
      this.assertComplete(
        result,
        ALBUM_ACTION_MAX_CHOICES,
        "NO_SUPPORTED_ACTIONS"
      );
      const leaves = result.items.filter(
        (item) =>
          item.hint === "action" &&
          item.isPlayable &&
          typeof item.itemKey === "string" &&
          item.itemKey.length > 0
      );
      if (leaves.length > 0) return this.normalizeLeaves(leaves, hierarchy);

      const nested = this.structuralRows(result.items).filter(
        (item) => item.hint === "action_list"
      );
      if (nested.length !== 1) {
        throw new AlbumActionResolutionError(
          "ACTION_PATH_NOT_FOUND",
          "The album action path did not continue uniquely"
        );
      }
      cursor = nested[0];
    }
    throw new AlbumActionResolutionError(
      "ACTION_PATH_NOT_FOUND",
      "The album action path exceeded its depth bound"
    );
  }

  private zoneBoundSession(
    session: CoordinatedBrowseSession,
    zoneId: string
  ): CoordinatedBrowseSession {
    const zoned: CoordinatedBrowseSession = {
      sessionScope: session.sessionScope,
      browse: (options) => session.browse({ ...options, zoneId }),
      load: (options) => session.load({ ...options, zoneId }),
      pop: (options) => session.pop({ ...options, zoneId }),
    };
    return Object.freeze(zoned);
  }

  private normalizeLeaves(
    leaves: readonly BrowseItem[],
    hierarchy: AlbumActionBrowseHierarchy
  ): ResolvedAlbumAction[] {
    if (leaves.length === 0 || leaves.length > ALBUM_ACTION_MAX_CHOICES) {
      throw new AlbumActionResolutionError(
        "NO_SUPPORTED_ACTIONS",
        "The album action list was empty or oversized"
      );
    }
    const labels = new Set<string>();
    const keys = new Set<string>();
    const normalized: ResolvedAlbumAction[] = [];
    for (const leaf of leaves) {
      const label = leaf.title;
      const itemKey = leaf.itemKey ?? "";
      if (
        label.length === 0 ||
        label.length > ALBUM_ACTION_LABEL_MAX_LENGTH ||
        label.trim() !== label ||
        CONTROL_CHARACTER.test(label) ||
        labels.has(label) ||
        keys.has(itemKey)
      ) {
        throw new AlbumActionResolutionError(
          "NO_SUPPORTED_ACTIONS",
          "The album action list contained ambiguous or invalid leaves"
        );
      }
      labels.add(label);
      keys.add(itemKey);
      normalized.push(
        Object.freeze({
          label,
          semantic: this.semantic(label),
          itemKey,
          hierarchy,
        })
      );
    }
    return normalized;
  }

  private semantic(label: string): AlbumActionSemantic {
    if (label === "Play Now") return "play-now";
    if (label === "Add Next") return "add-next";
    if (label === "Queue") return "queue";
    return "other";
  }

  private structuralRows(
    items: readonly BrowseItem[]
  ): Array<BrowseItem & { itemKey: string }> {
    return items.filter((item) => this.isStructural(item));
  }

  private isStructural(item: BrowseItem): item is BrowseItem & { itemKey: string } {
    return (
      typeof item.itemKey === "string" &&
      item.itemKey.length > 0 &&
      (item.hint === "list" || item.hint === "action_list") &&
      item.isPlayable !== true
    );
  }

  private assertComplete(
    result: BrowseResult,
    maximum: number,
    code: AlbumActionResolutionErrorCode
  ): void {
    const total = result.totalCount ?? result.count;
    if (
      result.offset !== 0 ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total > maximum ||
      result.items.length !== total
    ) {
      throw new AlbumActionResolutionError(
        code,
        "Roon returned an incomplete or oversized action-resolution list"
      );
    }
  }
}
