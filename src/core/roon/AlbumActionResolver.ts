import {
  ALBUM_ACTION_LABEL_MAX_LENGTH,
  ALBUM_ACTION_MAX_CHOICES,
  AlbumActionSemantic,
  AlbumActionTrackSelector,
} from "../../shared/albumActionContracts";
import {
  AlbumRef,
  normalizeCatalogText,
} from "../../shared/timelineCatalogContracts";
import { BrowseItem, BrowseResult } from "../../shared/types";
import { createCatalogTrackTitleFingerprint } from "../catalog/CatalogReconciliation";
import { CoordinatedBrowseSession } from "./BrowseSessionCoordinator";

const MAX_SEARCH_ROWS = 500;
const MAX_TRACK_ROWS = 500;
const MAX_DETAIL_ROWS = MAX_TRACK_ROWS + ALBUM_ACTION_MAX_CHOICES;
const MAX_CANDIDATE_DETAIL_DEPTH = 2;
const MAX_ACTION_DEPTH = 4;
const CONTROL_CHARACTER = /\p{Cc}/u;

export type AlbumActionResolutionErrorCode =
  | "ALBUM_NOT_FOUND"
  | "ALBUM_AMBIGUOUS"
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

export interface ResolvedAlbumAction {
  readonly label: string;
  readonly semantic: AlbumActionSemantic;
  /** Ephemeral Roon authority; retained only inside the server operation. */
  readonly itemKey: string;
}

export interface ResolvedAlbumActions {
  readonly actions: readonly ResolvedAlbumAction[];
}

export interface AlbumActionResolverPort {
  resolve(
    session: CoordinatedBrowseSession,
    album: Readonly<AlbumRef>,
    zoneId: string,
    track?: Readonly<AlbumActionTrackSelector>
  ): Promise<ResolvedAlbumActions>;
}

/**
 * Resolves the exact action leaves Roon currently exposes for one reconciled
 * catalog edition. Every call stays inside the action lease and carries its
 * original zone. Ephemeral item keys never leave the returned server object.
 */
export class AlbumActionResolver implements AlbumActionResolverPort {
  public async resolve(
    session: CoordinatedBrowseSession,
    album: Readonly<AlbumRef>,
    zoneId: string,
    track?: Readonly<AlbumActionTrackSelector>
  ): Promise<ResolvedAlbumActions> {
    if (
      album.resolutionStatus !== "resolved" ||
      !album.trackTitleFingerprint
    ) {
      throw new AlbumActionResolutionError(
        "ALBUM_NOT_FOUND",
        "The album has no resolved edition fingerprint"
      );
    }
    if (normalizeCatalogText(album.editionText).length > 0) {
      throw new AlbumActionResolutionError(
        "ALBUM_AMBIGUOUS",
        "The current Browse detail cannot prove the catalog edition text"
      );
    }
    const root = await session.browse({
      hierarchy: "search",
      zoneId,
      input: album.exactTitle,
      popAll: true,
      pageSize: MAX_SEARCH_ROWS,
    });
    this.assertComplete(root, MAX_SEARCH_ROWS, "ALBUM_AMBIGUOUS");

    const categories = this.structuralRows(root.items).filter(
      (item) => normalizeCatalogText(item.title) === "albums"
    );
    if (categories.length > 1) {
      throw new AlbumActionResolutionError(
        "ALBUM_AMBIGUOUS",
        "Search exposed more than one Albums category"
      );
    }

    let parent = root;
    if (categories.length === 1) {
      parent = await session.browse({
        hierarchy: "search",
        zoneId,
        itemKey: categories[0].itemKey,
        pageSize: MAX_SEARCH_ROWS,
      });
      this.assertComplete(parent, MAX_SEARCH_ROWS, "ALBUM_AMBIGUOUS");
    }

    const candidates = this.structuralRows(parent.items).filter(
      (item) =>
        normalizeCatalogText(item.title) === album.normalizedTitle &&
        normalizeCatalogText(item.subtitle ?? "") === album.normalizedArtist
    );
    if (candidates.length === 0) {
      throw new AlbumActionResolutionError(
        "ALBUM_NOT_FOUND",
        "No exact title and artist candidate was found"
      );
    }

    const matchingKeys: string[] = [];
    for (const candidate of candidates) {
      const opened = await this.openCandidateDetail(
        session,
        album,
        zoneId,
        candidate.itemKey
      );
      if (this.detailMatches(opened.detail, album)) {
        matchingKeys.push(candidate.itemKey);
      }
      parent = await session.pop({
        hierarchy: "search",
        zoneId,
        levels: opened.levels,
        pageSize: MAX_SEARCH_ROWS,
      });
      this.assertComplete(parent, MAX_SEARCH_ROWS, "ALBUM_AMBIGUOUS");
    }

    if (matchingKeys.length !== 1) {
      throw new AlbumActionResolutionError(
        matchingKeys.length === 0 ? "ALBUM_NOT_FOUND" : "ALBUM_AMBIGUOUS",
        matchingKeys.length === 0
          ? "No exact candidate matched the catalog track fingerprint"
          : "More than one candidate matched the catalog track fingerprint"
      );
    }

    const freshCandidate = parent.items.find(
      (item) => item.itemKey === matchingKeys[0]
    );
    if (!freshCandidate || !this.isStructural(freshCandidate)) {
      throw new AlbumActionResolutionError(
        "ALBUM_AMBIGUOUS",
        "The selected candidate did not survive parent re-resolution"
      );
    }

    const { detail } = await this.openCandidateDetail(
      session,
      album,
      zoneId,
      freshCandidate.itemKey
    );
    if (!this.detailMatches(detail, album)) {
      throw new AlbumActionResolutionError(
        "ALBUM_AMBIGUOUS",
        "The selected edition changed during action resolution"
      );
    }
    const target = track
      ? this.trackRow(detail, track)
      : this.playAlbumRow(detail);
    const leaves = await this.resolveLeaves(session, zoneId, target);
    return Object.freeze({ actions: Object.freeze(leaves) });
  }

  /**
   * Search can expose one exact album result as a one-row self wrapper before
   * its real detail. Descend only through that complete, uniquely identical
   * wrapper and keep the depth for an exact return to the candidate parent.
   */
  private async openCandidateDetail(
    session: CoordinatedBrowseSession,
    album: Readonly<AlbumRef>,
    zoneId: string,
    itemKey: string
  ): Promise<{ detail: BrowseResult; levels: number }> {
    let detail = await session.browse({
      hierarchy: "search",
      zoneId,
      itemKey,
      pageSize: MAX_DETAIL_ROWS,
    });
    for (let levels = 1; levels < MAX_CANDIDATE_DETAIL_DEPTH; levels += 1) {
      if (this.detailMatches(detail, album)) return { detail, levels };
      const rows = this.structuralRows(detail.items);
      const nested =
        normalizeCatalogText(detail.title ?? "") === album.normalizedTitle &&
        normalizeCatalogText(detail.subtitle ?? "") === album.normalizedArtist &&
        rows.length === 1 &&
        rows[0].hint === "list" &&
        normalizeCatalogText(rows[0].title) === album.normalizedTitle &&
        normalizeCatalogText(rows[0].subtitle ?? "") === album.normalizedArtist
          ? rows[0]
          : null;
      if (!nested) return { detail, levels };
      detail = await session.browse({
        hierarchy: "search",
        zoneId,
        itemKey: nested.itemKey,
        pageSize: MAX_DETAIL_ROWS,
      });
    }
    return { detail, levels: MAX_CANDIDATE_DETAIL_DEPTH };
  }

  /**
   * Bind the client's index/title selector to exactly one live track row of
   * the already-verified album detail. The index addresses the same ordered
   * track list the fingerprint proved, so a drifted list cannot rebind.
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
    if (normalizeCatalogText(row.title) !== normalizeCatalogText(track.title)) {
      throw new AlbumActionResolutionError(
        "TRACK_MISMATCH",
        "The live track at the selected index no longer matches its title"
      );
    }
    return row;
  }

  private detailMatches(
    detail: BrowseResult,
    album: Readonly<AlbumRef>
  ): boolean {
    this.assertComplete(detail, MAX_DETAIL_ROWS, "ALBUM_AMBIGUOUS");
    if (
      normalizeCatalogText(detail.title ?? "") !== album.normalizedTitle ||
      normalizeCatalogText(detail.subtitle ?? "") !== album.normalizedArtist
    ) {
      return false;
    }
    const tracks = this.trackRows(detail.items);
    return (
      tracks.length > 0 &&
      createCatalogTrackTitleFingerprint(tracks.map((track) => track.title)) ===
        album.trackTitleFingerprint
    );
  }

  private trackRows(items: readonly BrowseItem[]): BrowseItem[] {
    const structural = this.structuralRows(items);
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
    if (candidates.some((item) => normalizeCatalogText(item.title).length === 0)) {
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
        normalizeCatalogText(item.title) === "play album" &&
        normalizeCatalogText(item.itemType ?? "") !== "track"
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
    initial: BrowseItem
  ): Promise<ResolvedAlbumAction[]> {
    let cursor = initial;
    for (let depth = 0; depth < MAX_ACTION_DEPTH; depth += 1) {
      const result = await session.browse({
        hierarchy: "search",
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
      if (leaves.length > 0) return this.normalizeLeaves(leaves);

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

  private normalizeLeaves(leaves: readonly BrowseItem[]): ResolvedAlbumAction[] {
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
