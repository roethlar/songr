import { ALBUM_ACTION_MAX_CHOICES } from "../../shared/albumActionContracts";
import { ALBUM_DETAIL_MAX_TRACKS } from "../../shared/libraryAlbumContracts";
import {
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
  AlbumRef,
  ArtistRef,
  normalizeCatalogText,
} from "../../shared/catalogContracts";
import { BrowseItem, BrowseResult } from "../../shared/types";
import {
  ResolvedSelectedArtistObservation,
  createCatalogTrackTitleFingerprint,
} from "../catalog/CatalogReconciliation";
import { CoordinatedBrowseSession } from "./BrowseSessionCoordinator";
import {
  DiscographyResolver,
  ObservedDiscography,
} from "./DiscographyResolver";

const MAX_DETAIL_ROWS =
  ALBUM_DETAIL_MAX_TRACKS + ALBUM_ACTION_MAX_CHOICES;
const MAX_DUPLICATE_REVALIDATIONS = ALBUM_ACTION_MAX_CHOICES;
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

export interface AlbumDetailResolution {
  readonly observation: ResolvedSelectedArtistObservation;
  readonly orderedTrackTitles: readonly string[];
}

export interface AlbumDetailParentObserver {
  observeCurrent(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    first?: BrowseResult
  ): Promise<ObservedDiscography>;
}

/** One distinguishable live edition of a catalog album, display data only. */
export interface AlbumEditionCandidate {
  readonly observationIndex: number;
  readonly title: string;
  readonly artist: string;
  readonly editionText: string;
}

/** Chooser echo used to re-bind one previously observed edition candidate. */
export interface AlbumEditionDescriptor {
  readonly title: string;
  readonly artist: string;
  readonly editionText: string;
}

interface AlbumCandidate {
  readonly observationIndex: number;
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

/**
 * Opens one stable catalog album from a freshly re-observed live artist level,
 * then converts its complete track list into keyless catalog/detail evidence.
 */
export class AlbumDetailResolver {
  public constructor(
    private readonly parentObserver: AlbumDetailParentObserver =
      new DiscographyResolver()
  ) {}

  public async resolve(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    album: Readonly<AlbumRef>,
    discography: ObservedDiscography
  ): Promise<AlbumDetailResolution> {
    if (
      artist.resolutionStatus !== "resolved" ||
      album.resolutionStatus !== "resolved" ||
      album.artistLocalId !== artist.localId ||
      album.coreId !== artist.coreId
    ) {
      throw new AlbumDetailResolverError(
        "ALBUM_NOT_FOUND",
        "The requested album is not resolved for this artist"
      );
    }

    if (normalizeCatalogText(album.editionText).length > 0) {
      throw new AlbumDetailResolverError(
        "ALBUM_AMBIGUOUS",
        "The live album detail cannot prove the catalog edition"
      );
    }

    const candidates = this.candidates(discography, album);
    if (candidates.length === 0) {
      throw new AlbumDetailResolverError(
        "ALBUM_NOT_FOUND",
        "The album no longer exists in the live discography"
      );
    }
    if (
      candidates.some(
        ({ observationIndex }) =>
          normalizeCatalogText(
            discography.observation.albums[observationIndex].editionText
          ).length > 0
      )
    ) {
      throw new AlbumDetailResolverError(
        "ALBUM_AMBIGUOUS",
        "The live discography contains edition evidence the detail cannot prove"
      );
    }

    if (candidates.length === 1) {
      const opened = await this.openCandidate(
        session,
        album,
        discography,
        candidates[0]
      );
      if (
        album.trackTitleFingerprint !== undefined &&
        album.trackTitleFingerprint !== opened.fingerprint
      ) {
        throw new AlbumDetailResolverError(
          "DETAIL_MISMATCH",
          "The live album track sequence no longer matches its catalog identity"
        );
      }
      return this.buildResolution(
        discography,
        candidates[0].observationIndex,
        opened.detail,
        opened.orderedTrackTitles
      );
    }

    if (
      album.trackTitleFingerprint === undefined ||
      candidates.length > MAX_DUPLICATE_REVALIDATIONS
    ) {
      throw new AlbumDetailResolverError(
        "ALBUM_AMBIGUOUS",
        "The live discography does not identify one exact album edition"
      );
    }

    const expectedFingerprint = album.trackTitleFingerprint;
    const matchingOrdinals: number[] = [];
    let current = discography;
    for (let ordinal = 0; ordinal < candidates.length; ordinal += 1) {
      const currentCandidates = this.requireStableCandidates(
        current,
        album,
        candidates.length
      );
      const opened = await this.openCandidate(
        session,
        album,
        current,
        currentCandidates[ordinal]
      );
      if (opened.fingerprint === expectedFingerprint) {
        matchingOrdinals.push(ordinal);
      }
      if (ordinal + 1 < candidates.length) {
        current = await this.refreshParent(session, artist);
      }
    }

    if (matchingOrdinals.length === 0) {
      throw new AlbumDetailResolverError(
        "ALBUM_NOT_FOUND",
        "No duplicate live album matched the catalog track fingerprint"
      );
    }
    if (matchingOrdinals.length !== 1) {
      throw new AlbumDetailResolverError(
        "ALBUM_AMBIGUOUS",
        "More than one live album matched the catalog track fingerprint"
      );
    }

    // Leave the shared interactive session on a freshly revalidated copy of
    // the winning detail. Authority comes from the refreshed parent even when
    // Roon happens to repeat the same opaque key string.
    current = await this.refreshParent(session, artist);
    const finalCandidates = this.requireStableCandidates(
      current,
      album,
      candidates.length
    );
    const winner = finalCandidates[matchingOrdinals[0]];
    const opened = await this.openCandidate(
      session,
      album,
      current,
      winner
    );
    if (opened.fingerprint !== expectedFingerprint) {
      throw new AlbumDetailResolverError(
        "DETAIL_MISMATCH",
        "The duplicate album changed during final revalidation"
      );
    }
    return this.buildResolution(
      current,
      winner.observationIndex,
      opened.detail,
      opened.orderedTrackTitles
    );
  }

  /**
   * Every live discography row matching the catalog album's canonical title
   * and artist, with the display fields a chooser needs to tell them apart.
   */
  public observeCandidates(
    discography: ObservedDiscography,
    album: Readonly<AlbumRef>
  ): AlbumEditionCandidate[] {
    return this.candidates(discography, album).map(({ observationIndex }) => {
      const observed = discography.observation.albums[observationIndex];
      return {
        observationIndex,
        title: observed.exactTitle,
        artist: observed.exactArtist,
        editionText: observed.editionText,
      };
    });
  }

  /**
   * Open exactly the previously offered edition candidate against a fresh
   * observation. Header and completeness proofs still apply; the catalog
   * track fingerprint does not, because editions may differ from the
   * reconciled catalog edition by design.
   */
  public async resolveCandidate(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    album: Readonly<AlbumRef>,
    discography: ObservedDiscography,
    descriptor: AlbumEditionDescriptor
  ): Promise<AlbumDetailResolution> {
    if (
      artist.resolutionStatus !== "resolved" ||
      album.resolutionStatus !== "resolved" ||
      album.artistLocalId !== artist.localId ||
      album.coreId !== artist.coreId
    ) {
      throw new AlbumDetailResolverError(
        "ALBUM_NOT_FOUND",
        "The requested album is not resolved for this artist"
      );
    }
    const matches = this.observeCandidates(discography, album).filter(
      (candidate) =>
        normalizeCatalogText(candidate.title) ===
          normalizeCatalogText(descriptor.title) &&
        normalizeCatalogText(candidate.artist) ===
          normalizeCatalogText(descriptor.artist) &&
        normalizeCatalogText(candidate.editionText) ===
          normalizeCatalogText(descriptor.editionText)
    );
    if (matches.length === 0) {
      throw new AlbumDetailResolverError(
        "ALBUM_NOT_FOUND",
        "The chosen edition no longer exists in the live discography"
      );
    }
    if (matches.length > 1) {
      throw new AlbumDetailResolverError(
        "ALBUM_AMBIGUOUS",
        "The chosen edition descriptor does not identify one live album"
      );
    }
    const opened = await this.openCandidate(session, album, discography, {
      observationIndex: matches[0].observationIndex,
    });
    return this.buildResolution(
      discography,
      matches[0].observationIndex,
      opened.detail,
      opened.orderedTrackTitles
    );
  }

  /**
   * Opens one exact retained parent row. Unlike catalog resolution, the row's
   * page-scoped item key is the authority, so identical title/artist/edition
   * rows remain independently selectable and an ambiguous catalog anchor is
   * acceptable when it is bound to one resolved artist.
   */
  public async resolveObservedCandidate(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    album: Readonly<AlbumRef>,
    discography: ObservedDiscography,
    observationIndex: number
  ): Promise<AlbumDetailResolution> {
    if (
      artist.resolutionStatus !== "resolved" ||
      album.artistLocalId !== artist.localId ||
      album.coreId !== artist.coreId ||
      !Number.isSafeInteger(observationIndex) ||
      observationIndex < 0
    ) {
      throw new AlbumDetailResolverError(
        "ALBUM_NOT_FOUND",
        "The requested album row is not bound to this artist"
      );
    }
    const observed = discography.observation.albums[observationIndex];
    if (
      !observed ||
      normalizeCatalogText(observed.exactTitle) !== album.normalizedTitle ||
      normalizeCatalogText(observed.exactArtist) !== album.normalizedArtist
    ) {
      throw new AlbumDetailResolverError(
        "DETAIL_MISMATCH",
        "The retained album row no longer matches the album group"
      );
    }
    const opened = await this.openCandidate(session, album, discography, {
      observationIndex,
    });
    return this.buildResolution(
      discography,
      observationIndex,
      opened.detail,
      opened.orderedTrackTitles
    );
  }

  private candidates(
    discography: ObservedDiscography,
    album: Readonly<AlbumRef>
  ): AlbumCandidate[] {
    return discography.observation.albums
      .map((_observed, observationIndex) => ({ observationIndex }))
      .filter(({ observationIndex }) => {
        const observed = discography.observation.albums[observationIndex];
        return (
          normalizeCatalogText(observed.exactTitle) === album.normalizedTitle &&
          normalizeCatalogText(observed.exactArtist) === album.normalizedArtist
        );
      });
  }

  private requireStableCandidates(
    discography: ObservedDiscography,
    album: Readonly<AlbumRef>,
    expectedCount: number
  ): AlbumCandidate[] {
    const candidates = this.candidates(discography, album);
    if (
      candidates.length !== expectedCount ||
      candidates.some(
        ({ observationIndex }) =>
          normalizeCatalogText(
            discography.observation.albums[observationIndex].editionText
          ).length > 0
      )
    ) {
      throw new AlbumDetailResolverError(
        "ALBUM_AMBIGUOUS",
        "The duplicate album set changed during revalidation"
      );
    }
    return candidates;
  }

  private async refreshParent(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>
  ): Promise<ObservedDiscography> {
    const parent = await session.pop({
      hierarchy: "artists",
      levels: 1,
      refresh: true,
      pageSize: 100,
    });
    return this.parentObserver.observeCurrent(session, artist, parent);
  }

  private async openCandidate(
    session: CoordinatedBrowseSession,
    album: Readonly<AlbumRef>,
    discography: ObservedDiscography,
    candidate: AlbumCandidate
  ): Promise<{
    readonly detail: BrowseResult;
    readonly orderedTrackTitles: string[];
    readonly fingerprint: string;
  }> {
    const liveRows = discography.liveAlbums.filter(
      (row) => row.observationIndex === candidate.observationIndex
    );
    if (liveRows.length !== 1) {
      throw new AlbumDetailResolverError(
        "ALBUM_AMBIGUOUS",
        "The live album row could not be bound uniquely"
      );
    }

    const detail = await session.browse({
      hierarchy: "artists",
      itemKey: liveRows[0].itemKey,
      offset: 0,
      pageSize: MAX_DETAIL_ROWS,
    });
    const orderedTrackTitles = this.readDetail(detail, album);
    const detailFingerprint = createCatalogTrackTitleFingerprint(
      orderedTrackTitles
    );
    return { detail, orderedTrackTitles, fingerprint: detailFingerprint };
  }

  private buildResolution(
    discography: ObservedDiscography,
    observationIndex: number,
    detail: BrowseResult,
    orderedTrackTitles: string[]
  ): AlbumDetailResolution {
    const albums = discography.observation.albums.map((observed, index) =>
      index === observationIndex
        ? {
            ...observed,
            detail: {
              sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
              fieldInventoryComplete: true as const,
              headerTitle: canonicalDisplayText(detail.title) as string,
              headerSubtitle: canonicalDisplayText(detail.subtitle) as string,
              returnedTrackCount: orderedTrackTitles.length,
              totalTrackCount: orderedTrackTitles.length,
              orderedTrackTitles,
              originalReleaseDateField: { status: "not-exposed" as const },
              editionReleaseDateField: { status: "not-exposed" as const },
            },
          }
        : observed
    );
    return {
      observation: { ...discography.observation, albums },
      orderedTrackTitles,
    };
  }

  private readDetail(
    detail: BrowseResult,
    album: Readonly<AlbumRef>
  ): string[] {
    const headerTitle = canonicalDisplayText(detail.title);
    const headerSubtitle = canonicalDisplayText(detail.subtitle);
    if (
      !headerTitle ||
      !headerSubtitle ||
      normalizeCatalogText(headerTitle) !== album.normalizedTitle ||
      normalizeCatalogText(headerSubtitle) !== album.normalizedArtist
    ) {
      throw new AlbumDetailResolverError(
        "DETAIL_MISMATCH",
        "The live album detail header does not match the catalog album"
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
