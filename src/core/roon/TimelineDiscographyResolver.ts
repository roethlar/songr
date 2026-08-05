import {
  CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  CATALOG_OPAQUE_TEXT_MAX_LENGTH,
  ArtistRef,
  normalizeCatalogText,
} from "../../shared/timelineCatalogContracts";
import { BrowseItem, BrowseResult } from "../../shared/types";
import {
  CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
  ResolvedSelectedArtistObservation,
  SelectedArtistObservation,
} from "../catalog/CatalogReconciliation";
import { CoordinatedBrowseSession } from "./BrowseSessionCoordinator";

export const TIMELINE_ARTIST_PAGE_SIZE = 100;
export const TIMELINE_ARTIST_ROOT_MAX_ROWS = 100_000;
export const TIMELINE_ARTIST_ROOT_MAX_PAGES = 1_000;
export const TIMELINE_DISCOGRAPHY_MAX_DEPTH = 4;
export const TIMELINE_DISCOGRAPHY_MAX_ROWS =
  CATALOG_ARTIST_ALBUMS_MAX_LIMIT + 1;

export type TimelineDiscographyResolution =
  | {
      readonly kind: "resolved";
      readonly observation: ResolvedSelectedArtistObservation;
    }
  | {
      readonly kind: "missing" | "ambiguous";
      readonly observation: SelectedArtistObservation;
    };

export interface TimelineLiveAlbumRow {
  readonly observationIndex: number;
  readonly itemKey: string;
}

/**
 * Server-only view of one complete live discography level. The item keys are
 * consumed immediately by a coordinated resolver and never cross a wire or a
 * persistence boundary.
 */
export interface TimelineObservedDiscography {
  readonly observation: ResolvedSelectedArtistObservation;
  readonly liveAlbums: readonly TimelineLiveAlbumRow[];
}

export type TimelineDiscographyResolverErrorCode =
  | "INCOMPLETE_ARTIST_ROOT"
  | "DISCOGRAPHY_PATH_NOT_UNIQUE"
  | "INCOMPLETE_DISCOGRAPHY"
  | "DISCOGRAPHY_TOO_LARGE"
  | "INVALID_DISCOGRAPHY_ROW";

export class TimelineDiscographyResolverError extends Error {
  public constructor(
    public readonly code: TimelineDiscographyResolverErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TimelineDiscographyResolverError";
    Object.setPrototypeOf(this, TimelineDiscographyResolverError.prototype);
    Error.captureStackTrace?.(this, TimelineDiscographyResolverError);
  }
}

const CONTROL_CHARACTER = /\p{Cc}/u;

interface CompleteListOptions {
  readonly label: "artist root" | "discography" | "structural menu";
  readonly maxRows: number;
  readonly maxPages: number;
}

function canonicalDisplayText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > CATALOG_DISPLAY_TEXT_MAX_LENGTH) {
    return null;
  }
  const canonical = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return canonical.length > 0 && !CONTROL_CHARACTER.test(canonical)
    ? canonical
    : null;
}

function opaqueHint(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= CATALOG_OPAQUE_TEXT_MAX_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTER.test(value)
    ? value
    : undefined;
}

function isStructural(item: BrowseItem): boolean {
  return (
    typeof item.itemKey === "string" &&
    item.itemKey.length > 0 &&
    item.isPlayable !== true &&
    (item.hint === "list" || item.hint === "action_list")
  );
}

function hasExplicitAlbumType(item: BrowseItem): boolean {
  return (
    typeof item.itemType === "string" &&
    normalizeCatalogText(item.itemType) === "album"
  );
}

function hasExplicitNonAlbumType(item: BrowseItem): boolean {
  return item.itemType !== undefined && !hasExplicitAlbumType(item);
}

function resolverError(
  label: CompleteListOptions["label"],
  message: string
): TimelineDiscographyResolverError {
  const code =
    label === "artist root"
      ? "INCOMPLETE_ARTIST_ROOT"
      : label === "discography"
        ? "INCOMPLETE_DISCOGRAPHY"
        : "DISCOGRAPHY_PATH_NOT_UNIQUE";
  return new TimelineDiscographyResolverError(code, message);
}

/**
 * Resolves one stable catalog artist into the tab's retained live album level.
 * Every ephemeral key remains inside this method and its coordinated session.
 */
export class TimelineDiscographyResolver {
  public async resolve(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>
  ): Promise<TimelineDiscographyResolution> {
    const firstRoot = await session.browse({
      hierarchy: "artists",
      offset: 0,
      pageSize: TIMELINE_ARTIST_PAGE_SIZE,
      popAll: true,
      refresh: true,
    });
    const rootRows = await this.readCompleteList(session, firstRoot, {
      label: "artist root",
      maxRows: TIMELINE_ARTIST_ROOT_MAX_ROWS,
      maxPages: TIMELINE_ARTIST_ROOT_MAX_PAGES,
    });
    const matches = rootRows.filter(
      (item) =>
        isStructural(item) &&
        canonicalDisplayText(item.title) !== null &&
        normalizeCatalogText(item.title) === artist.normalizedName
    );

    if (matches.length !== 1) {
      return {
        kind: matches.length === 0 ? "missing" : "ambiguous",
        observation: {
          sourceContract:
            CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
          artist: {
            exactName: artist.exactName,
            candidateCount: matches.length,
          },
        },
      };
    }

    const artistRow = matches[0];
    let current = await session.browse({
      hierarchy: "artists",
      itemKey: artistRow.itemKey,
      offset: 0,
      pageSize: TIMELINE_ARTIST_PAGE_SIZE,
    });

    for (let depth = 0; depth <= TIMELINE_DISCOGRAPHY_MAX_DEPTH; depth += 1) {
      if (this.looksLikeDiscography(current, artist.normalizedName)) {
        const rows = await this.readCompleteList(session, current, {
          label: "discography",
          maxRows: TIMELINE_DISCOGRAPHY_MAX_ROWS,
          maxPages: Math.ceil(
            TIMELINE_DISCOGRAPHY_MAX_ROWS / TIMELINE_ARTIST_PAGE_SIZE
          ),
        });
        return {
          kind: "resolved",
          observation: this.buildObservation(artistRow, artist, rows),
        };
      }

      if (depth === TIMELINE_DISCOGRAPHY_MAX_DEPTH) {
        break;
      }

      const menuRows = await this.readCompleteList(session, current, {
        label: "structural menu",
        maxRows: TIMELINE_ARTIST_PAGE_SIZE,
        maxPages: 1,
      });
      const albumPaths = menuRows.filter(
        (item) =>
          isStructural(item) &&
          item.hint === "list" &&
          normalizeCatalogText(item.title) === "albums"
      );
      if (albumPaths.length !== 1) {
        throw new TimelineDiscographyResolverError(
          "DISCOGRAPHY_PATH_NOT_UNIQUE",
          "The selected artist did not expose one safe Albums path"
        );
      }
      current = await session.browse({
        hierarchy: "artists",
        itemKey: albumPaths[0].itemKey,
        offset: 0,
        pageSize: TIMELINE_ARTIST_PAGE_SIZE,
      });
    }

    throw new TimelineDiscographyResolverError(
      "DISCOGRAPHY_PATH_NOT_UNIQUE",
      "The selected artist exceeded the bounded Albums traversal depth"
    );
  }

  /**
   * Re-observe the complete album level currently owned by this session.
   * Supplying `first` is used by Back after its atomic pop-and-refresh; without
   * it the resolver loads page zero of the retained current level.
   */
  public async observeCurrent(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    first?: BrowseResult
  ): Promise<TimelineObservedDiscography> {
    const current = first ?? await session.load({
      hierarchy: "artists",
      offset: 0,
      count: TIMELINE_ARTIST_PAGE_SIZE,
    });
    if (!this.looksLikeDiscography(current, artist.normalizedName)) {
      throw new TimelineDiscographyResolverError(
        "INCOMPLETE_DISCOGRAPHY",
        "The retained Timeline level is not the expected artist discography"
      );
    }
    const rows = await this.readCompleteList(session, current, {
      label: "discography",
      maxRows: TIMELINE_DISCOGRAPHY_MAX_ROWS,
      maxPages: Math.ceil(
        TIMELINE_DISCOGRAPHY_MAX_ROWS / TIMELINE_ARTIST_PAGE_SIZE
      ),
    });
    const observation = this.buildObservationFromIdentity(
      artist.exactName,
      artist.imageKeyHint,
      rows
    );
    const liveAlbums = rows
      .filter((item) => item.hint === "list")
      .map((item, observationIndex) => ({
        observationIndex,
        itemKey: item.itemKey as string,
      }));
    return { observation, liveAlbums };
  }

  private looksLikeDiscography(
    result: BrowseResult,
    normalizedArtistName: string
  ): boolean {
    if (result.totalCount === 0) {
      return (
        typeof result.title === "string" &&
        normalizeCatalogText(result.title) === normalizedArtistName
      );
    }
    const structural = result.items.filter(isStructural);
    const listRows = structural.filter((item) => item.hint === "list");
    if (listRows.some(hasExplicitAlbumType)) {
      return true;
    }
    if (listRows.some(hasExplicitNonAlbumType)) {
      return false;
    }
    if (
      typeof result.title === "string" &&
      /\balbums?\b/iu.test(result.title) &&
      structural.length > 0
    ) {
      return true;
    }
    const hasNamedAlbumsPath = structural.some(
      (item) =>
        item.hint === "list" && normalizeCatalogText(item.title) === "albums"
    );
    return (
      !hasNamedAlbumsPath &&
      typeof result.title === "string" &&
      normalizeCatalogText(result.title) === normalizedArtistName &&
      structural.some((item) => item.hint === "list") &&
      structural.every(
        (item) => item.hint === "list" || item.hint === "action_list"
      )
    );
  }

  private buildObservation(
    artistRow: BrowseItem,
    catalogArtist: Readonly<ArtistRef>,
    rows: readonly BrowseItem[]
  ): ResolvedSelectedArtistObservation {
    return this.buildObservationFromIdentity(
      canonicalDisplayText(artistRow.title) ?? catalogArtist.exactName,
      opaqueHint(artistRow.imageKey),
      rows
    );
  }

  private buildObservationFromIdentity(
    exactArtist: string,
    artistImage: string | undefined,
    rows: readonly BrowseItem[]
  ): ResolvedSelectedArtistObservation {
    const actionRows = rows.filter((item) => item.hint === "action_list");
    const listRows = rows.filter((item) => item.hint === "list");
    if (
      actionRows.length > 1 ||
      actionRows.length + listRows.length !== rows.length ||
      listRows.length > CATALOG_ARTIST_ALBUMS_MAX_LIMIT ||
      rows.some((item) => !isStructural(item)) ||
      listRows.some(hasExplicitNonAlbumType)
    ) {
      throw new TimelineDiscographyResolverError(
        listRows.length > CATALOG_ARTIST_ALBUMS_MAX_LIMIT
          ? "DISCOGRAPHY_TOO_LARGE"
          : "INVALID_DISCOGRAPHY_ROW",
        "The selected artist discography was not one complete bounded album list"
      );
    }
    const albums = listRows.map((item) => {
      const exactTitle = canonicalDisplayText(item.title);
      if (!exactTitle) {
        throw new TimelineDiscographyResolverError(
          "INVALID_DISCOGRAPHY_ROW",
          "A selected-artist album row had no valid title"
        );
      }
      const imageKeyHint = opaqueHint(item.imageKey);
      return {
        exactTitle,
        exactArtist,
        editionText: "",
        ...(imageKeyHint ? { imageKeyHint } : {}),
      };
    });
    return {
      sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
      artist: {
        exactName: exactArtist,
        candidateCount: 1,
        ...(artistImage ? { imageKeyHint: artistImage } : {}),
      },
      discographyComplete: true,
      albums,
    };
  }

  private async readCompleteList(
    session: CoordinatedBrowseSession,
    first: BrowseResult,
    options: CompleteListOptions
  ): Promise<BrowseItem[]> {
    const total = first.totalCount;
    if (
      total === undefined ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total > options.maxRows
    ) {
      if (options.label === "discography" && Number.isSafeInteger(total)) {
        throw new TimelineDiscographyResolverError(
          "DISCOGRAPHY_TOO_LARGE",
          "The selected artist discography exceeds the supported bound"
        );
      }
      throw resolverError(options.label, `${options.label} reported an invalid total`);
    }
    const pages = Math.max(1, Math.ceil(total / TIMELINE_ARTIST_PAGE_SIZE));
    if (pages > options.maxPages) {
      throw resolverError(options.label, `${options.label} exceeded its page bound`);
    }
    const rows: BrowseItem[] = [];
    const seenKeys = new Set<string>();
    this.appendPage(rows, seenKeys, first, 0, total, options);

    for (
      let offset = TIMELINE_ARTIST_PAGE_SIZE;
      offset < total;
      offset += TIMELINE_ARTIST_PAGE_SIZE
    ) {
      const page = await session.load({
        hierarchy: "artists",
        offset,
        count: Math.min(TIMELINE_ARTIST_PAGE_SIZE, total - offset),
      });
      this.appendPage(rows, seenKeys, page, offset, total, options);
    }
    if (rows.length !== total) {
      throw resolverError(
        options.label,
        `${options.label} assembled ${rows.length} of ${total} rows`
      );
    }
    return rows;
  }

  private appendPage(
    rows: BrowseItem[],
    seenKeys: Set<string>,
    page: BrowseResult,
    expectedOffset: number,
    expectedTotal: number,
    options: CompleteListOptions
  ): void {
    const expectedRows = Math.min(
      TIMELINE_ARTIST_PAGE_SIZE,
      Math.max(0, expectedTotal - expectedOffset)
    );
    if (
      page.offset !== expectedOffset ||
      page.totalCount !== expectedTotal ||
      page.items.length !== expectedRows
    ) {
      throw resolverError(options.label, `${options.label} pagination changed`);
    }
    for (const item of page.items) {
      if (
        typeof item.itemKey !== "string" ||
        item.itemKey.length === 0 ||
        seenKeys.has(item.itemKey)
      ) {
        throw resolverError(
          options.label,
          `${options.label} contained a missing or duplicate row key`
        );
      }
      seenKeys.add(item.itemKey);
      rows.push(item);
    }
  }
}
