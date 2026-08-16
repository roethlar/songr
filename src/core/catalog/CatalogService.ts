import { randomUUID } from "crypto";
import { Logger } from "pino";

import {
  AlbumRef,
  ArtistRef,
  CATALOG_ALBUM_EXTENDED_FIELD_KEYS,
  CATALOG_ARTIST_ALBUMS_DEFAULT_LIMIT,
  CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
  CATALOG_ARTIST_QUERY_MAX_LENGTH,
  CATALOG_ARTIST_SEARCH_DEFAULT_LIMIT,
  CATALOG_ARTIST_SEARCH_MAX_LIMIT,
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  CATALOG_OPAQUE_TEXT_MAX_LENGTH,
  CatalogAlbumExtendedFields,
  CatalogArtistAlbumsResponse,
  CatalogArtistSearchResponse,
  CatalogFreshness,
  CatalogStaleReason,
  CatalogStatus,
  CatalogStatusProblem,
  CatalogStatusProblemCode,
  albumHasExtendedEnrichment,
  catalogArtistSearchRank,
  compareCatalogTextByCodePoint,
  isCatalogLocalId,
  normalizeAlbumRef,
  normalizeArtistRef,
  normalizeCatalogText,
} from "../../shared/catalogContracts";
import { repairEncoding } from "../../shared/repairEncoding";
import { BrowseItem, BrowseResult } from "../../shared/types";
import {
  CatalogSessionHandle,
  CoordinatedBrowseSession,
} from "../roon/BrowseSessionCoordinator";
import {
  DiscographyResolution,
  DiscographyResolver,
} from "../roon/DiscographyResolver";
import { CatalogPersistence } from "./CatalogPersistence";
import {
  CatalogReconciliationError,
  ReconciledSelectedArtist,
  reconcileSelectedArtist as reconcileSelectedArtistDescriptors,
} from "./CatalogReconciliation";

export type CatalogHierarchy = "artists" | "albums";

export interface CatalogBrowseCoordinator {
  acquireCatalog(coreId: string): CatalogSessionHandle;
  runCatalog<T>(
    coreId: string,
    handle: CatalogSessionHandle,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T>;
  releaseCatalog(coreId: string, handle: CatalogSessionHandle): Promise<void>;
}

export interface CatalogAuxiliaryArtistResolver {
  resolve(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>
  ): Promise<DiscographyResolution>;
}

export interface CatalogHierarchyScanMetrics {
  readonly pages: number;
  readonly scannedRows: number;
  readonly descriptorRows: number;
}

export interface CatalogAlbumArtistAttributionMetrics {
  readonly exactUnique: number;
  readonly ambiguous: number;
  readonly missingOrNonExact: number;
}

export interface CatalogScanMetrics {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly artists: CatalogHierarchyScanMetrics;
  readonly albums: CatalogHierarchyScanMetrics;
  readonly albumArtistAttribution: CatalogAlbumArtistAttributionMetrics;
}

export interface CatalogSnapshot {
  readonly coreId: string;
  readonly revision: number;
  readonly updatedAt: string;
  /** Absent until a complete Artists + Albums scan has published. */
  readonly lastCompleteScanAt?: string;
  readonly artists: readonly Readonly<ArtistRef>[];
  readonly albums: readonly Readonly<AlbumRef>[];
}

export interface CatalogScanResult {
  readonly snapshot: CatalogSnapshot;
  readonly metrics: CatalogScanMetrics;
}

export interface CatalogSelectedArtistResult {
  readonly snapshot: CatalogSnapshot;
  readonly status: CatalogStatus;
  readonly artist: Readonly<ArtistRef>;
  readonly albums: readonly Readonly<AlbumRef>[];
}

export interface CatalogServiceOptions {
  pageSize?: number;
  maxItemsPerHierarchy?: number;
  now?: () => number;
  createLocalId?: () => string;
  persistence?: CatalogPersistence;
  auxiliaryArtistResolver?: CatalogAuxiliaryArtistResolver;
}

export const CATALOG_PERSISTENCE_VERSION = 3 as const;
/**
 * Version 1 predates the text-encoding repair; version 2 predates native
 * enrichment. Both are accepted on read and rewritten once as the current
 * version. Version 2 needs no transformation — the native fields are
 * optional, so a v2 snapshot is already a valid v3 snapshot without them.
 * Version 1 additionally repairs mojibake and recomputes the derived
 * normalized fields.
 */
export const LEGACY_CATALOG_PERSISTENCE_VERSION = 1 as const;
export const PRE_NATIVE_CATALOG_PERSISTENCE_VERSION = 2 as const;

export type CatalogServiceErrorCode =
  | "INVALID_CONFIGURATION"
  | "INCOMPLETE_SCAN"
  | "INVALID_DESCRIPTOR"
  | "INVALID_MERGE"
  | "IDENTITY_CONFLICT"
  | "PERSISTENCE_DEGRADED"
  | "INVALID_PERSISTED_STATE"
  | "INVALID_QUERY"
  | "REVISION_CONFLICT"
  | "AUXILIARY_ARTIST_UNAVAILABLE";

export class CatalogServiceError extends Error {
  public constructor(
    public readonly code: CatalogServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CatalogServiceError";
    Object.setPrototypeOf(this, CatalogServiceError.prototype);
    Error.captureStackTrace?.(this, CatalogServiceError);
  }
}

interface ScannedRow {
  title: string;
  subtitle?: string;
  imageKey?: string;
}

interface HierarchyScan {
  rows: ScannedRow[];
  pages: number;
}

interface RawCatalogScan {
  artists: HierarchyScan;
  albums: HierarchyScan;
}

interface SelectedArtistOverlay {
  generation: number;
  artist: ArtistRef;
  albums: AlbumRef[];
  suppressedAlbumLocalIds: readonly string[];
}

interface CoreCatalogState {
  revision: number;
  snapshot: CatalogSnapshot | null;
  overlays: Map<string, SelectedArtistOverlay>;
  overlayGeneration: number;
  lastScanMetrics: CatalogScanMetrics | null;
  started: boolean;
  startPromise: Promise<void> | null;
  commitTail: Promise<void>;
  freshness: CatalogFreshness;
  staleReason?: CatalogStaleReason;
  persistenceDegraded: boolean;
  lastProblem?: CatalogStatusProblem;
  invalidationGeneration: number;
}

interface PersistedCatalogEnvelope {
  version: typeof CATALOG_PERSISTENCE_VERSION;
  coreId: string;
  snapshot: CatalogSnapshot;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 5_000;
const DEFAULT_MAX_ITEMS_PER_HIERARCHY = 100_000;
const ABSOLUTE_MAX_ITEMS_PER_HIERARCHY = 1_000_000;
const CONTROL_CHARACTER = /\p{Cc}/u;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * In-memory, Core-scoped catalog read model.
 *
 * Full scans are built off to the side and published with one reference swap.
 * Selected-artist overlays can publish while a scan is in flight and are
 * re-applied to the completed candidate so that the fresher working set is not
 * lost. Optional Core-scoped persistence commits before the in-memory swap and
 * exposes freshness/degradation status and bounded keyless queries. Selected
 * artist observations reconcile stable IDs and exact-detail release evidence;
 * broad root scans remain keyless and cannot fabricate dates.
 */
export class CatalogService {
  private readonly pageSize: number;
  private readonly maxItemsPerHierarchy: number;
  private readonly now: () => number;
  private readonly createLocalId: () => string;
  private readonly persistence?: CatalogPersistence;
  private readonly auxiliaryArtistResolver: CatalogAuxiliaryArtistResolver;
  private readonly cores = new Map<string, CoreCatalogState>();
  private readonly inFlightScans = new Map<string, Promise<CatalogScanResult>>();
  private catalogSessionTail: Promise<void> = Promise.resolve();
  private readonly inFlightAuxiliaryArtistLoads = new Map<
    string,
    Promise<CatalogSelectedArtistResult | null>
  >();

  public constructor(
    private readonly coordinator: CatalogBrowseCoordinator,
    private readonly logger: Logger,
    options: CatalogServiceOptions = {}
  ) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxItemsPerHierarchy =
      options.maxItemsPerHierarchy ?? DEFAULT_MAX_ITEMS_PER_HIERARCHY;
    this.now = options.now ?? Date.now;
    this.createLocalId = options.createLocalId ?? randomUUID;
    this.persistence = options.persistence;
    this.auxiliaryArtistResolver =
      options.auxiliaryArtistResolver ?? new DiscographyResolver();
    this.validateConfiguration();
  }

  public getSnapshot(coreId: string): CatalogSnapshot | null {
    return this.cores.get(coreId)?.snapshot ?? null;
  }

  public getLastScanMetrics(coreId: string): CatalogScanMetrics | null {
    return this.cores.get(coreId)?.lastScanMetrics ?? null;
  }

  public getStatus(coreId: string): CatalogStatus {
    this.assertCoreId(coreId);
    const state = this.cores.get(coreId);
    const snapshot = state?.snapshot ?? null;
    return this.statusForSnapshot(coreId, state, snapshot);
  }

  public async searchArtists(
    coreId: string,
    queryValue: unknown,
    limitValue: unknown = CATALOG_ARTIST_SEARCH_DEFAULT_LIMIT
  ): Promise<CatalogArtistSearchResponse> {
    this.assertCoreId(coreId);
    const query = this.canonicalSearchQuery(queryValue);
    const limit = this.readBoundedLimit(
      limitValue,
      CATALOG_ARTIST_SEARCH_MAX_LIMIT,
      "artist search"
    );
    await this.start(coreId);
    const normalizedQuery = query.length > 0 ? normalizeCatalogText(query) : "";
    const snapshot = this.getSnapshot(coreId);
    const ranked: Array<{ artist: ArtistRef; rank: 0 | 1 | 2 }> = [];
    let total = 0;
    if (normalizedQuery.length > 0) {
      for (const artist of snapshot?.artists ?? []) {
        const rank = catalogArtistSearchRank(
          artist.normalizedName,
          normalizedQuery
        );
        if (rank === 3) continue;
        total += 1;
        const candidate = { artist, rank };
        const insertAt = ranked.findIndex(
          (existing) =>
            this.compareArtistSearchCandidates(candidate, existing) < 0
        );
        if (insertAt >= 0) {
          ranked.splice(insertAt, 0, candidate);
          if (ranked.length > limit) ranked.pop();
        } else if (ranked.length < limit) {
          ranked.push(candidate);
        }
      }
    }
    const artists = Object.freeze(
      ranked.map((candidate) => candidate.artist)
    );
    return Object.freeze({
      status: this.getStatus(coreId),
      query,
      limit,
      total,
      truncated: total > artists.length,
      artists,
    });
  }

  public async getArtistAlbums(
    coreId: string,
    artistLocalId: unknown,
    limitValue: unknown = CATALOG_ARTIST_ALBUMS_DEFAULT_LIMIT
  ): Promise<CatalogArtistAlbumsResponse | null> {
    this.assertCoreId(coreId);
    if (!isCatalogLocalId(artistLocalId)) {
      throw new CatalogServiceError(
        "INVALID_QUERY",
        "Artist local ID is invalid"
      );
    }
    const limit = this.readBoundedLimit(
      limitValue,
      CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
      "artist albums"
    );
    await this.start(coreId);
    const state = this.getOrCreateState(coreId);
    return this.artistAlbumsFromSnapshot(
      coreId,
      state,
      state.snapshot,
      artistLocalId,
      limit
    );
  }

  /**
   * Resolve one explicit auxiliary artist through the server-owned catalog
   * session. The caller's revision is a commit precondition: a cache hit stays
   * at that revision, while this method's own publication advances it once.
   */
  public async loadArtistAlbums(
    coreId: string,
    artistLocalId: unknown,
    expectedRevisionValue: unknown,
    limitValue: unknown = CATALOG_ARTIST_ALBUMS_DEFAULT_LIMIT
  ): Promise<CatalogArtistAlbumsResponse | null> {
    this.assertCoreId(coreId);
    if (!isCatalogLocalId(artistLocalId)) {
      throw new CatalogServiceError(
        "INVALID_QUERY",
        "Artist local ID is invalid"
      );
    }
    const expectedRevision = this.readExpectedRevision(expectedRevisionValue);
    const limit = this.readBoundedLimit(
      limitValue,
      CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
      "artist albums"
    );
    await this.start(coreId);
    const state = this.getOrCreateState(coreId);
    const invalidationGeneration = state.invalidationGeneration;
    const snapshot = state.snapshot;
    this.assertExpectedRevision(snapshot, expectedRevision);
    const artist = snapshot?.artists.find(
      (candidate) =>
        candidate.coreId === coreId && candidate.localId === artistLocalId
    );
    if (!artist) return null;
    if (artist.resolutionStatus === "resolved") {
      return this.artistAlbumsFromSnapshot(
        coreId,
        state,
        snapshot,
        artistLocalId,
        limit
      );
    }
    if (artist.resolutionStatus !== "unresolved") {
      throw new CatalogServiceError(
        "AUXILIARY_ARTIST_UNAVAILABLE",
        "Auxiliary artist is not safely resolvable"
      );
    }
    this.assertPersistenceHealthy(state);

    const loadKey = JSON.stringify([coreId, artistLocalId, expectedRevision]);
    const existing = this.inFlightAuxiliaryArtistLoads.get(loadKey);
    if (existing) {
      const publication = await existing;
      return publication
        ? this.artistAlbumsResponse(
            publication.status,
            publication.artist,
            publication.albums,
            limit
          )
        : null;
    }
    const load = this.performAuxiliaryArtistLoad(
      coreId,
      artistLocalId,
      expectedRevision,
      invalidationGeneration
    );
    this.inFlightAuxiliaryArtistLoads.set(loadKey, load);
    const clear = (): void => {
      if (this.inFlightAuxiliaryArtistLoads.get(loadKey) === load) {
        this.inFlightAuxiliaryArtistLoads.delete(loadKey);
      }
    };
    void load.then(clear, clear);
    const publication = await load;
    return publication
      ? this.artistAlbumsResponse(
          publication.status,
          publication.artist,
          publication.albums,
          limit
        )
      : null;
  }

  /** Load and strictly validate this Core's persisted snapshot once. */
  public start(coreId: string): Promise<void> {
    this.assertCoreId(coreId);
    const state = this.getOrCreateState(coreId);
    if (state.started) return Promise.resolve();
    if (state.startPromise) return state.startPromise;
    const started = this.loadPersisted(coreId, state);
    state.startPromise = started;
    return started;
  }

  /** Preserve keyless context but prevent an in-flight scan from publishing. */
  public markCoreDisconnected(coreId: string): void {
    this.assertCoreId(coreId);
    const state = this.getOrCreateState(coreId);
    state.invalidationGeneration += 1;
    if (state.snapshot) {
      state.freshness = "stale";
      state.staleReason = "core-disconnected";
    }
  }

  /**
   * Applies the native crosswalk's enrichment to the published snapshot
   * (Slice 3). Strip-and-set: albums named in `updates` gain exactly those
   * native fields; every other album loses its native fields, so the merge
   * is a pure function of the latest crosswalk report. Core identity is
   * asserted before and after the merge, and a merge that changes nothing
   * publishes nothing — the operation is idempotent. The merge is queued
   * behind any in-flight commit and reads the current snapshot inside the
   * commit, so it can never clobber a concurrently published scan.
   */
  public async applyNativeEnrichment(
    coreId: string,
    updates: ReadonlyMap<string, CatalogAlbumExtendedFields>
  ): Promise<void> {
    this.assertCoreId(coreId);
    await this.start(coreId);
    const state = this.getOrCreateState(coreId);
    await this.enqueueCommit(state, async () => {
      const snapshot = state.snapshot;
      if (!snapshot || snapshot.coreId !== coreId) {
        throw new CatalogServiceError(
          "IDENTITY_CONFLICT",
          "Native enrichment Core did not match the catalog snapshot Core"
        );
      }
      const albums = snapshot.albums.map((album) => {
        if (album.coreId !== coreId) {
          throw new CatalogServiceError(
            "IDENTITY_CONFLICT",
            "Native enrichment encountered an album from another Core"
          );
        }
        const descriptor: Record<string, unknown> = { ...album };
        for (const key of CATALOG_ALBUM_EXTENDED_FIELD_KEYS) {
          delete descriptor[key];
        }
        const fields = updates.get(album.localId);
        if (fields) {
          for (const key of CATALOG_ALBUM_EXTENDED_FIELD_KEYS) {
            const fieldValue = fields[key];
            if (fieldValue === undefined) continue;
            descriptor[key] =
              fieldValue !== null && typeof fieldValue === "object"
                ? { ...fieldValue }
                : fieldValue;
          }
        }
        const normalized = normalizeAlbumRef(descriptor);
        if (!normalized || normalized.coreId !== coreId) {
          throw new CatalogServiceError(
            "INVALID_MERGE",
            "Native enrichment produced an invalid album descriptor"
          );
        }
        return normalized;
      });
      const changed = albums.some(
        (album, index) =>
          !this.nativeFieldsEqual(album, snapshot.albums[index])
      );
      if (!changed) return;
      const merged = this.createSnapshot(state, {
        coreId,
        updatedAt: new Date(this.readClock()).toISOString(),
        ...(snapshot.lastCompleteScanAt
          ? { lastCompleteScanAt: snapshot.lastCompleteScanAt }
          : {}),
        artists: snapshot.artists,
        albums,
      });
      await this.persistSnapshot(coreId, state, merged);
      this.commitSnapshot(state, merged);
      this.logger.info(
        {
          coreId,
          revision: merged.revision,
          enrichedAlbums: updates.size,
        },
        "Catalog native enrichment published"
      );
    });
  }

  private nativeFieldsEqual(
    left: Readonly<AlbumRef>,
    right: Readonly<AlbumRef>
  ): boolean {
    return CATALOG_ALBUM_EXTENDED_FIELD_KEYS.every((key) => {
      const leftValue = left[key];
      const rightValue = right[key];
      if (
        leftValue !== null &&
        rightValue !== null &&
        typeof leftValue === "object" &&
        typeof rightValue === "object"
      ) {
        return (
          leftValue.year === rightValue.year &&
          leftValue.month === rightValue.month &&
          leftValue.day === rightValue.day
        );
      }
      return leftValue === rightValue;
    });
  }

  /** Scan both public catalog hierarchies and atomically publish on success. */
  public scan(coreId: string): Promise<CatalogScanResult> {
    const existing = this.inFlightScans.get(coreId);
    if (existing) return existing;
    const scan = this.performScan(coreId);
    this.inFlightScans.set(coreId, scan);
    const clear = (): void => {
      if (this.inFlightScans.get(coreId) === scan) {
        this.inFlightScans.delete(coreId);
      }
    };
    void scan.then(clear, clear);
    return scan;
  }

  private async performScan(coreId: string): Promise<CatalogScanResult> {
    await this.start(coreId);
    const state = this.getOrCreateState(coreId);
    this.assertPersistenceHealthy(state);
    const invalidationGeneration = state.invalidationGeneration;
    const baseSnapshot = state.snapshot;
    const baseOverlayGeneration = state.overlayGeneration;
    const startedAt = this.readClock();
    const startedTimestamp = new Date(startedAt).toISOString();
    let rawScan: RawCatalogScan | undefined;
    let primaryError: unknown;

    try {
      rawScan = await this.runCatalogSession(coreId, async (session) => ({
        artists: await this.scanHierarchy(session, "artists"),
        albums: await this.scanHierarchy(session, "albums"),
      }));
    } catch (error) {
      primaryError = error;
    }

    if (primaryError !== undefined) {
      this.recordScanFailure(state);
      this.logger.warn(
        { err: primaryError, coreId },
        "Catalog scan failed; retaining the published snapshot"
      );
      if (primaryError instanceof Error) throw primaryError;
      throw new CatalogServiceError(
        "INCOMPLETE_SCAN",
        "Catalog scan failed with a non-Error rejection"
      );
    }
    if (!rawScan) {
      this.recordScanFailure(state);
      throw new CatalogServiceError(
        "INCOMPLETE_SCAN",
        "Catalog scan returned no candidate"
      );
    }
    const completeScan = rawScan;
    try {
      return await this.enqueueCommit(state, async () => {
        if (state.invalidationGeneration !== invalidationGeneration) {
          throw new CatalogServiceError(
            "INCOMPLETE_SCAN",
            "Catalog scan was invalidated before publication"
          );
        }
        this.assertPersistenceHealthy(state);
        const finishedAt = this.readClock();
        const completedAt = new Date(finishedAt).toISOString();
        const candidate = this.buildCandidate(
          coreId,
          completeScan,
          baseSnapshot,
          completedAt
        );
        const overlaid = this.applyOverlays(
          candidate.artists,
          candidate.albums,
          new Map(
            [...state.overlays].filter(
              ([, overlay]) => overlay.generation > baseOverlayGeneration
            )
          )
        );
        const metrics = this.freezeMetrics({
          startedAt: startedTimestamp,
          completedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
          artists: {
            pages: completeScan.artists.pages,
            scannedRows: completeScan.artists.rows.length,
            descriptorRows: candidate.artists.length,
          },
          albums: {
            pages: completeScan.albums.pages,
            scannedRows: completeScan.albums.rows.length,
            descriptorRows: candidate.albums.length,
          },
          albumArtistAttribution: candidate.albumArtistAttribution,
        });
        const snapshot = this.createSnapshot(state, {
          coreId,
          updatedAt: completedAt,
          lastCompleteScanAt: completedAt,
          artists: overlaid.artists,
          albums: overlaid.albums,
        });
        await this.persistSnapshot(coreId, state, snapshot);
        const invalidatedDuringPersistence =
          state.invalidationGeneration !== invalidationGeneration;
        this.commitSnapshot(state, snapshot);
        for (const [artistLocalId, overlay] of state.overlays) {
          if (overlay.generation <= baseOverlayGeneration) {
            state.overlays.delete(artistLocalId);
          }
        }
        state.lastScanMetrics = metrics;
        if (invalidatedDuringPersistence) {
          state.freshness = "stale";
          state.staleReason = "core-disconnected";
        } else {
          state.freshness = "fresh";
          state.staleReason = undefined;
          state.lastProblem = undefined;
        }

        this.logger.info(
          {
            coreId,
            revision: snapshot.revision,
            durationMs: metrics.durationMs,
            artists: metrics.artists,
            albums: metrics.albums,
            albumArtistAttribution: metrics.albumArtistAttribution,
          },
          "Catalog scan published"
        );

        return Object.freeze({ snapshot, metrics });
      });
    } catch (error) {
      if (!state.persistenceDegraded) this.recordScanFailure(state);
      throw error;
    }
  }

  /**
   * Reconcile a complete, keyless selected-artist observation immediately.
   * IDs, timestamps, hashes, statuses, and release evidence are server-owned.
   */
  public async reconcileSelectedArtist(
    coreId: string,
    selectedArtistLocalId: unknown,
    observation: unknown,
    expectedRevision?: number,
    expectedInvalidationGeneration?: number
  ): Promise<CatalogSelectedArtistResult> {
    this.assertCoreId(coreId);
    if (
      selectedArtistLocalId !== null &&
      !isCatalogLocalId(selectedArtistLocalId)
    ) {
      throw new CatalogServiceError(
        "INVALID_MERGE",
        "Selected artist local ID is invalid"
      );
    }
    await this.start(coreId);
    const state = this.getOrCreateState(coreId);
    this.assertPersistenceHealthy(state);
    const invalidationGeneration =
      expectedInvalidationGeneration ?? state.invalidationGeneration;
    return this.enqueueCommit(state, async () => {
      if (state.invalidationGeneration !== invalidationGeneration) {
        throw new CatalogServiceError(
          "INVALID_MERGE",
          "Selected-artist reconciliation was invalidated before publication"
        );
      }
      this.assertPersistenceHealthy(state);
      const current = state.snapshot;
      if (expectedRevision !== undefined) {
        this.assertExpectedRevision(current, expectedRevision);
      }
      const observedAt = new Date(this.readClock()).toISOString();
      let reconciled: ReconciledSelectedArtist;
      try {
        reconciled = reconcileSelectedArtistDescriptors({
          coreId,
          selectedArtistLocalId,
          observation,
          currentArtists: current?.artists ?? [],
          currentAlbums: current?.albums ?? [],
          observedAt,
          createLocalId: this.createLocalId,
        });
      } catch (error) {
        if (error instanceof CatalogReconciliationError) {
          const code =
            error.code === "IDENTITY_CONFLICT"
              ? "IDENTITY_CONFLICT"
              : error.code === "INVALID_OBSERVATION"
                ? "INVALID_MERGE"
                : "INVALID_DESCRIPTOR";
          throw new CatalogServiceError(code, error.message);
        }
        throw error;
      }
      if (reconciled.albums.length > CATALOG_ARTIST_ALBUMS_MAX_LIMIT) {
        throw new CatalogServiceError(
          "INVALID_MERGE",
          "Selected-artist reconciliation exceeds the per-artist album bound"
        );
      }
      const generation = state.overlayGeneration + 1;
      const overlay: SelectedArtistOverlay = {
        generation,
        artist: this.freezeArtist(reconciled.artist),
        albums: reconciled.albums.map((album) => this.freezeAlbum(album)),
        suppressedAlbumLocalIds: Object.freeze([
          ...reconciled.suppressedAlbumLocalIds,
        ]),
      };
      const merged = this.applyOverlay(
        current?.artists ?? [],
        current?.albums ?? [],
        overlay
      );
      if (
        merged.artists.length > this.maxItemsPerHierarchy ||
        merged.albums.length > this.maxItemsPerHierarchy
      ) {
        throw new CatalogServiceError(
          "INVALID_MERGE",
          "Selected-artist reconciliation exceeds the catalog bound"
        );
      }
      const snapshot = this.createSnapshot(state, {
        coreId,
        updatedAt: observedAt,
        ...(current?.lastCompleteScanAt
          ? { lastCompleteScanAt: current.lastCompleteScanAt }
          : {}),
        artists: merged.artists,
        albums: merged.albums,
      });
      const publishedArtist = snapshot.artists.find(
        (artist) => artist.localId === overlay.artist.localId
      );
      if (!publishedArtist) {
        throw new CatalogServiceError(
          "INVALID_DESCRIPTOR",
          "Published reconciliation lost its artist descriptor"
        );
      }
      const publishedAlbums = snapshot.albums.filter(
        (album) => album.artistLocalId === publishedArtist.localId
      );
      await this.persistSnapshot(coreId, state, snapshot);
      const invalidatedDuringPersistence =
        state.invalidationGeneration !== invalidationGeneration;
      this.commitSnapshot(state, snapshot);
      state.overlayGeneration = generation;
      state.overlays.set(overlay.artist.localId, overlay);
      if (invalidatedDuringPersistence) {
        state.freshness = "stale";
        state.staleReason = "core-disconnected";
      } else if (!current || state.freshness === "empty") {
        state.freshness = "fresh";
        state.staleReason = undefined;
      }
      return Object.freeze({
        snapshot,
        status: this.statusForSnapshot(coreId, state, snapshot),
        artist: publishedArtist,
        albums: Object.freeze(publishedAlbums),
      });
    });
  }

  private async performAuxiliaryArtistLoad(
    coreId: string,
    artistLocalId: string,
    expectedRevision: number,
    expectedInvalidationGeneration: number
  ): Promise<CatalogSelectedArtistResult | null> {
    const resolution = await this.runCatalogSession(coreId, async (session) => {
      const state = this.getOrCreateState(coreId);
      if (state.invalidationGeneration !== expectedInvalidationGeneration) {
        throw new CatalogServiceError(
          "INVALID_MERGE",
          "Auxiliary artist load was invalidated before browse"
        );
      }
      this.assertPersistenceHealthy(state);
      const snapshot = state.snapshot;
      this.assertExpectedRevision(snapshot, expectedRevision);
      const artist = snapshot?.artists.find(
        (candidate) =>
          candidate.coreId === coreId && candidate.localId === artistLocalId
      );
      if (!artist) return null;
      if (artist.resolutionStatus !== "unresolved") {
        throw new CatalogServiceError(
          "AUXILIARY_ARTIST_UNAVAILABLE",
          "Auxiliary artist is not safely resolvable"
        );
      }
      return this.auxiliaryArtistResolver.resolve(session, artist);
    });
    if (resolution === null) return null;
    if (resolution.kind !== "resolved") {
      throw new CatalogServiceError(
        "AUXILIARY_ARTIST_UNAVAILABLE",
        "Auxiliary artist could not be resolved uniquely"
      );
    }

    return this.reconcileSelectedArtist(
      coreId,
      artistLocalId,
      resolution.observation,
      expectedRevision,
      expectedInvalidationGeneration
    );
  }

  /** Serialize every scan and auxiliary crawl before acquiring the singleton. */
  private runCatalogSession<T>(
    coreId: string,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    const prior = this.catalogSessionTail;
    const run = prior.then(
      () => this.withCatalogSession(coreId, work),
      () => this.withCatalogSession(coreId, work)
    );
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.catalogSessionTail = tail;
    return run;
  }

  private async withCatalogSession<T>(
    coreId: string,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    let handle: CatalogSessionHandle | undefined;
    let value: T | undefined;
    let failed = false;
    let primaryError: unknown;
    try {
      handle = this.coordinator.acquireCatalog(coreId);
      value = await this.coordinator.runCatalog(coreId, handle, work);
    } catch (error) {
      failed = true;
      primaryError = error;
    }

    if (handle) {
      try {
        await this.coordinator.releaseCatalog(coreId, handle);
      } catch (error) {
        if (!failed) {
          failed = true;
          primaryError = error;
        } else {
          this.logger.warn(
            { err: error, coreId },
            "Catalog session cleanup also failed after catalog work"
          );
        }
      }
    }
    if (failed) throw primaryError;
    return value as T;
  }

  private artistAlbumsFromSnapshot(
    coreId: string,
    state: CoreCatalogState,
    snapshot: CatalogSnapshot | null,
    artistLocalId: string,
    limit: number
  ): CatalogArtistAlbumsResponse | null {
    const artist = snapshot?.artists.find(
      (candidate) =>
        candidate.coreId === coreId && candidate.localId === artistLocalId
    );
    if (!artist || !snapshot) return null;
    return this.artistAlbumsResponse(
      this.statusForSnapshot(coreId, state, snapshot),
      artist,
      snapshot.albums,
      limit
    );
  }

  private artistAlbumsResponse(
    status: CatalogStatus,
    artist: Readonly<ArtistRef>,
    candidates: readonly Readonly<AlbumRef>[],
    limit: number
  ): CatalogArtistAlbumsResponse {
    const matching: AlbumRef[] = [];
    let total = 0;
    for (const album of candidates) {
      if (
        album.coreId !== artist.coreId ||
        album.artistLocalId !== artist.localId
      ) {
        continue;
      }
      total += 1;
      if (matching.length < limit) matching.push(album);
    }
    const albums = Object.freeze(matching);
    return Object.freeze({
      status,
      artist,
      limit,
      total,
      truncated: total > albums.length,
      albums,
    });
  }

  private statusForSnapshot(
    coreId: string,
    state: CoreCatalogState | undefined,
    snapshot: CatalogSnapshot | null
  ): CatalogStatus {
    return Object.freeze({
      coreId,
      freshness: state?.freshness ?? "empty",
      ...(state?.staleReason ? { staleReason: state.staleReason } : {}),
      persistence: state?.persistenceDegraded ? "degraded" : "healthy",
      refresh: this.inFlightScans.has(coreId) ? "running" : "idle",
      available: snapshot !== null,
      complete: snapshot?.lastCompleteScanAt !== undefined,
      revision: snapshot?.revision ?? 0,
      artistCount: snapshot?.artists.length ?? 0,
      albumCount: snapshot?.albums.length ?? 0,
      ...(snapshot ? { updatedAt: snapshot.updatedAt } : {}),
      ...(snapshot?.lastCompleteScanAt
        ? { lastCompleteScanAt: snapshot.lastCompleteScanAt }
        : {}),
      ...(state?.lastProblem
        ? { lastProblem: Object.freeze({ ...state.lastProblem }) }
        : {}),
    });
  }

  private assertExpectedRevision(
    snapshot: CatalogSnapshot | null,
    expectedRevision: number
  ): void {
    if (snapshot?.revision !== expectedRevision) {
      throw new CatalogServiceError(
        "REVISION_CONFLICT",
        "Catalog revision changed before auxiliary publication"
      );
    }
  }

  private async scanHierarchy(
    session: CoordinatedBrowseSession,
    hierarchy: CatalogHierarchy
  ): Promise<HierarchyScan> {
    const first = await session.browse({
      hierarchy,
      offset: 0,
      pageSize: this.pageSize,
      popAll: true,
      refresh: true,
    });
    const total = this.readTotal(first, hierarchy);
    const seenKeys = new Set<string>();
    const rows = this.readPage(first, hierarchy, 0, total, seenKeys);
    let pages = 1;

    for (let offset = this.pageSize; offset < total; offset += this.pageSize) {
      const page = await session.load({
        hierarchy,
        offset,
        count: Math.min(this.pageSize, total - offset),
      });
      rows.push(...this.readPage(page, hierarchy, offset, total, seenKeys));
      pages += 1;
    }

    if (rows.length !== total) {
      throw this.incomplete(
        hierarchy,
        `assembled ${rows.length} of ${total} rows`
      );
    }
    return {
      rows,
      pages,
    };
  }

  private readTotal(result: BrowseResult, hierarchy: CatalogHierarchy): number {
    const total = result.totalCount;
    if (
      !Number.isSafeInteger(total) ||
      total === undefined ||
      total < 0 ||
      total > this.maxItemsPerHierarchy
    ) {
      throw this.incomplete(hierarchy, "reported an invalid or unbounded total");
    }
    return total;
  }

  private readPage(
    result: BrowseResult,
    hierarchy: CatalogHierarchy,
    expectedOffset: number,
    expectedTotal: number,
    seenKeys: Set<string>
  ): ScannedRow[] {
    if (result.offset !== expectedOffset || result.totalCount !== expectedTotal) {
      throw this.incomplete(hierarchy, "page offset or total changed during scan");
    }
    const expectedCount = Math.min(
      this.pageSize,
      Math.max(0, expectedTotal - expectedOffset)
    );
    if (result.items.length !== expectedCount) {
      throw this.incomplete(
        hierarchy,
        `page ${expectedOffset} returned ${result.items.length} of ${expectedCount} rows`
      );
    }

    return result.items.map((item) => {
      this.assertUniqueEphemeralKey(item, hierarchy, seenKeys);
      return {
        title: item.title,
        ...(item.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
        ...(item.imageKey !== undefined ? { imageKey: item.imageKey } : {}),
      };
    });
  }

  private assertUniqueEphemeralKey(
    item: BrowseItem,
    hierarchy: CatalogHierarchy,
    seenKeys: Set<string>
  ): void {
    if (
      typeof item.itemKey !== "string" ||
      item.itemKey.length === 0 ||
      seenKeys.has(item.itemKey)
    ) {
      throw this.incomplete(
        hierarchy,
        "contained a missing or duplicate ephemeral row key"
      );
    }
    seenKeys.add(item.itemKey);
  }

  private buildCandidate(
    coreId: string,
    raw: RawCatalogScan,
    prior: CatalogSnapshot | null,
    observedAt: string
  ): {
    artists: ArtistRef[];
    albums: AlbumRef[];
    albumArtistAttribution: CatalogAlbumArtistAttributionMetrics;
  } {
    const usedIds = new Set<string>([
      ...(prior?.artists.map((artist) => artist.localId) ?? []),
      ...(prior?.albums.map((album) => album.localId) ?? []),
    ]);
    const artistRows: Array<{
      exactName: string;
      normalizedName: string;
      imageKeyHint?: string;
    }> = [];
    for (const row of raw.artists.rows) {
      const exactName = this.canonicalDisplayText(row.title);
      if (exactName === null) continue;
      const imageKeyHint = this.opaqueHint(row.imageKey);
      artistRows.push({
        exactName,
        normalizedName: normalizeCatalogText(exactName),
        ...(imageKeyHint ? { imageKeyHint } : {}),
      });
    }
    const artistNameCounts = this.countBy(
      artistRows.map((artist) => artist.normalizedName)
    );
    const artists = this.reconcileRootArtists(
      coreId,
      artistRows,
      prior,
      observedAt,
      usedIds
    );
    const albumArtistAttribution = {
      exactUnique: 0,
      ambiguous: 0,
      missingOrNonExact: 0,
    };
    const albumRows: Array<{
      exactTitle: string;
      exactArtist: string;
      normalizedTitle: string;
      normalizedArtist: string;
      imageKeyHint?: string;
    }> = [];
    for (const row of raw.albums.rows) {
      const exactTitle = this.canonicalDisplayText(row.title);
      const exactArtist = this.canonicalDisplayText(row.subtitle);
      if (exactArtist === null) {
        albumArtistAttribution.missingOrNonExact += 1;
      } else {
        const matchCount = artistNameCounts.get(normalizeCatalogText(exactArtist)) ?? 0;
        if (matchCount === 1) albumArtistAttribution.exactUnique += 1;
        else if (matchCount > 1) albumArtistAttribution.ambiguous += 1;
        else albumArtistAttribution.missingOrNonExact += 1;
      }
      if (exactTitle === null || exactArtist === null) continue;
      const imageKeyHint = this.opaqueHint(row.imageKey);
      albumRows.push({
        exactTitle,
        exactArtist,
        normalizedTitle: normalizeCatalogText(exactTitle),
        normalizedArtist: normalizeCatalogText(exactArtist),
        ...(imageKeyHint ? { imageKeyHint } : {}),
      });
    }
    const albums = this.reconcileRootAlbums(
      coreId,
      albumRows,
      prior,
      observedAt,
      usedIds
    );
    const artistIds = new Set(artists.map((artist) => artist.localId));
    if (
      artists.length > this.maxItemsPerHierarchy ||
      albums.length > this.maxItemsPerHierarchy ||
      albums.some(
        (album) => album.artistLocalId && !artistIds.has(album.artistLocalId)
      )
    ) {
      throw new CatalogServiceError(
        "INCOMPLETE_SCAN",
        "Reconciled catalog candidate exceeds bounds or has an orphan binding"
      );
    }
    return {
      artists,
      albums,
      albumArtistAttribution: Object.freeze(albumArtistAttribution),
    };
  }

  private reconcileRootArtists(
    coreId: string,
    rows: readonly {
      exactName: string;
      normalizedName: string;
      imageKeyHint?: string;
    }[],
    prior: CatalogSnapshot | null,
    observedAt: string,
    usedIds: Set<string>
  ): ArtistRef[] {
    const rowGroups = new Map<string, typeof rows[number][]>();
    for (const row of rows) {
      const group = rowGroups.get(row.normalizedName) ?? [];
      group.push(row);
      rowGroups.set(row.normalizedName, group);
    }
    const priorGroups = new Map<string, Readonly<ArtistRef>[]>();
    for (const artist of prior?.artists ?? []) {
      const group = priorGroups.get(artist.normalizedName) ?? [];
      group.push(artist);
      priorGroups.set(artist.normalizedName, group);
    }
    const boundArtistIds = new Set(
      (prior?.albums ?? [])
        .map((album) => album.artistLocalId)
        .filter((localId): localId is string => localId !== undefined)
    );
    const isDurable = (artist: Readonly<ArtistRef>): boolean =>
      artist.resolutionStatus !== "unresolved" ||
      boundArtistIds.has(artist.localId);
    const consumed = new Set<string>();
    const artists: ArtistRef[] = [];

    for (const [normalizedName, groupRows] of rowGroups) {
      const priorGroup = priorGroups.get(normalizedName) ?? [];
      const durable = priorGroup.filter(isDurable);
      if (groupRows.length === 1) {
        const match =
          priorGroup.length === 1
            ? priorGroup[0]
            : durable.length === 1
              ? durable[0]
              : undefined;
        if (match) {
          consumed.add(match.localId);
          artists.push(
            this.rootArtistDescriptor(
              coreId,
              groupRows[0],
              observedAt,
              match.localId,
              match.firstSeenAt,
              match.resolutionStatus === "resolved" ? "resolved" : "unresolved",
              match
            )
          );
        } else if (durable.length > 1) {
          for (const retained of durable) {
            consumed.add(retained.localId);
            artists.push(this.retainArtistStatus(retained, "ambiguous"));
          }
        } else {
          artists.push(
            this.rootArtistDescriptor(
              coreId,
              groupRows[0],
              observedAt,
              this.allocateLocalId(usedIds),
              observedAt,
              "unresolved"
            )
          );
        }
        continue;
      }

      for (const retained of durable) {
        consumed.add(retained.localId);
        artists.push(this.retainArtistStatus(retained, "ambiguous"));
      }
      for (let index = durable.length; index < groupRows.length; index += 1) {
        artists.push(
          this.rootArtistDescriptor(
            coreId,
            groupRows[index],
            observedAt,
            this.allocateLocalId(usedIds),
            observedAt,
            "ambiguous"
          )
        );
      }
    }

    for (const artist of prior?.artists ?? []) {
      if (isDurable(artist) && !consumed.has(artist.localId)) {
        artists.push(this.retainArtistStatus(artist, "missing"));
      }
    }
    return artists;
  }

  private rootArtistDescriptor(
    coreId: string,
    row: { exactName: string; normalizedName: string; imageKeyHint?: string },
    observedAt: string,
    localId: string,
    firstSeenAt: string,
    resolutionStatus: "unresolved" | "resolved" | "ambiguous",
    prior?: Readonly<ArtistRef>
  ): ArtistRef {
    const imageKeyHint = row.imageKeyHint ?? prior?.imageKeyHint;
    const descriptor = normalizeArtistRef({
      localId,
      coreId,
      exactName: row.exactName,
      normalizedName: row.normalizedName,
      ...(imageKeyHint ? { imageKeyHint } : {}),
      firstSeenAt,
      lastSeenAt: observedAt,
      resolutionStatus,
    });
    if (!descriptor) {
      throw new CatalogServiceError(
        "INVALID_DESCRIPTOR",
        "An Artists hierarchy row could not form a catalog descriptor"
      );
    }
    return descriptor;
  }

  private retainArtistStatus(
    artist: Readonly<ArtistRef>,
    resolutionStatus: "ambiguous" | "missing"
  ): ArtistRef {
    const descriptor = normalizeArtistRef({ ...artist, resolutionStatus });
    if (!descriptor) {
      throw new CatalogServiceError(
        "INVALID_DESCRIPTOR",
        "A retained artist descriptor became invalid"
      );
    }
    return descriptor;
  }

  private reconcileRootAlbums(
    coreId: string,
    rows: readonly {
      exactTitle: string;
      exactArtist: string;
      normalizedTitle: string;
      normalizedArtist: string;
      imageKeyHint?: string;
    }[],
    prior: CatalogSnapshot | null,
    observedAt: string,
    usedIds: Set<string>
  ): AlbumRef[] {
    const key = (value: {
      normalizedTitle: string;
      normalizedArtist: string;
    }): string =>
      JSON.stringify([value.normalizedTitle, value.normalizedArtist]);
    const rowGroups = new Map<string, typeof rows[number][]>();
    for (const row of rows) {
      const groupKey = key(row);
      const group = rowGroups.get(groupKey) ?? [];
      group.push(row);
      rowGroups.set(groupKey, group);
    }
    const priorGroups = new Map<string, Readonly<AlbumRef>[]>();
    for (const album of prior?.albums ?? []) {
      const groupKey = key(album);
      const group = priorGroups.get(groupKey) ?? [];
      group.push(album);
      priorGroups.set(groupKey, group);
    }
    const isDurable = (album: Readonly<AlbumRef>): boolean =>
      album.artistLocalId !== undefined ||
      album.resolutionStatus !== "unresolved" ||
      album.trackTitleFingerprint !== undefined ||
      album.originalReleaseYearEvidence !== undefined ||
      album.editionReleaseYearEvidence !== undefined ||
      albumHasExtendedEnrichment(album);
    const consumed = new Set<string>();
    const albums: AlbumRef[] = [];

    for (const [groupKey, groupRows] of rowGroups) {
      const priorGroup = priorGroups.get(groupKey) ?? [];
      const durable = priorGroup.filter(isDurable);
      if (groupRows.length === 1) {
        const match =
          priorGroup.length === 1
            ? priorGroup[0]
            : durable.length === 1
              ? durable[0]
              : undefined;
        if (match) {
          consumed.add(match.localId);
          albums.push(
            this.rootAlbumDescriptor(
              coreId,
              groupRows[0],
              observedAt,
              match.localId,
              match.firstSeenAt,
              match.resolutionStatus === "resolved" ? "resolved" : "unresolved",
              match
            )
          );
        } else if (durable.length > 1) {
          for (const retained of durable) {
            consumed.add(retained.localId);
            albums.push(this.retainAlbumStatus(retained, "ambiguous"));
          }
        } else {
          albums.push(
            this.rootAlbumDescriptor(
              coreId,
              groupRows[0],
              observedAt,
              this.allocateLocalId(usedIds),
              observedAt,
              "unresolved"
            )
          );
        }
        continue;
      }

      for (const retained of durable) {
        consumed.add(retained.localId);
        albums.push(this.retainAlbumStatus(retained, "ambiguous"));
      }
      for (let index = durable.length; index < groupRows.length; index += 1) {
        albums.push(
          this.rootAlbumDescriptor(
            coreId,
            groupRows[index],
            observedAt,
            this.allocateLocalId(usedIds),
            observedAt,
            "ambiguous"
          )
        );
      }
    }

    for (const album of prior?.albums ?? []) {
      if (isDurable(album) && !consumed.has(album.localId)) {
        albums.push(this.retainAlbumStatus(album, "missing"));
      }
    }
    return albums;
  }

  private rootAlbumDescriptor(
    coreId: string,
    row: {
      exactTitle: string;
      exactArtist: string;
      normalizedTitle: string;
      normalizedArtist: string;
      imageKeyHint?: string;
    },
    observedAt: string,
    localId: string,
    firstSeenAt: string,
    resolutionStatus: "unresolved" | "resolved" | "ambiguous",
    prior?: Readonly<AlbumRef>
  ): AlbumRef {
    const imageKeyHint = row.imageKeyHint ?? prior?.imageKeyHint;
    const descriptor: Record<string, unknown> = {
      localId,
      coreId,
      ...(prior?.artistLocalId ? { artistLocalId: prior.artistLocalId } : {}),
      exactTitle: row.exactTitle,
      exactArtist: row.exactArtist,
      normalizedTitle: row.normalizedTitle,
      normalizedArtist: row.normalizedArtist,
      editionText: prior?.editionText ?? "",
      ...(prior?.trackTitleFingerprint
        ? { trackTitleFingerprint: prior.trackTitleFingerprint }
        : {}),
      ...(imageKeyHint ? { imageKeyHint } : {}),
      firstSeenAt,
      lastSeenAt: observedAt,
      resolutionStatus,
    };
    if (
      prior?.originalReleaseYear !== undefined &&
      prior.originalReleaseYearEvidence
    ) {
      descriptor.originalReleaseYear = prior.originalReleaseYear;
      descriptor.originalReleaseYearEvidence = prior.originalReleaseYearEvidence;
    }
    if (
      prior?.editionReleaseYear !== undefined &&
      prior.editionReleaseYearEvidence
    ) {
      descriptor.editionReleaseYear = prior.editionReleaseYear;
      descriptor.editionReleaseYearEvidence = prior.editionReleaseYearEvidence;
    }
    // Native enrichment rides the descriptor's identity: while the catalog
    // keeps recognizing this album as the same one, its native binding and
    // date/play fields survive hierarchy rescans until the next native
    // merge refreshes or strips them.
    if (prior) {
      for (const key of CATALOG_ALBUM_EXTENDED_FIELD_KEYS) {
        if (prior[key] !== undefined) descriptor[key] = prior[key];
      }
    }
    const normalized = normalizeAlbumRef(descriptor);
    if (!normalized) {
      throw new CatalogServiceError(
        "INVALID_DESCRIPTOR",
        "An Albums hierarchy row could not form a catalog descriptor"
      );
    }
    return normalized;
  }

  private retainAlbumStatus(
    album: Readonly<AlbumRef>,
    resolutionStatus: "ambiguous" | "missing"
  ): AlbumRef {
    const descriptor = normalizeAlbumRef({ ...album, resolutionStatus });
    if (!descriptor) {
      throw new CatalogServiceError(
        "INVALID_DESCRIPTOR",
        "A retained album descriptor became invalid"
      );
    }
    return descriptor;
  }

  private applyOverlays(
    artists: readonly Readonly<ArtistRef>[],
    albums: readonly Readonly<AlbumRef>[],
    overlays: ReadonlyMap<string, SelectedArtistOverlay>
  ): { artists: ArtistRef[]; albums: AlbumRef[] } {
    let nextArtists = [...artists] as ArtistRef[];
    let nextAlbums = [...albums] as AlbumRef[];
    for (const overlay of overlays.values()) {
      const merged = this.applyOverlay(nextArtists, nextAlbums, overlay);
      nextArtists = merged.artists;
      nextAlbums = merged.albums;
    }
    return { artists: nextArtists, albums: nextAlbums };
  }

  private applyOverlay(
    artists: readonly Readonly<ArtistRef>[],
    albums: readonly Readonly<AlbumRef>[],
    overlay: SelectedArtistOverlay
  ): { artists: ArtistRef[]; albums: AlbumRef[] } {
    const artistInsertAt = artists.findIndex(
      (artist) => artist.localId === overlay.artist.localId
    );
    const nextArtists = artists.filter(
      (artist) => artist.localId !== overlay.artist.localId
    ) as ArtistRef[];
    nextArtists.splice(
      artistInsertAt < 0
        ? nextArtists.length
        : Math.min(artistInsertAt, nextArtists.length),
      0,
      overlay.artist
    );

    const overlayAlbumIds = new Set(
      [
        ...overlay.albums.map((album) => album.localId),
        ...overlay.suppressedAlbumLocalIds,
      ]
    );
    const shouldReplaceAlbum = (album: Readonly<AlbumRef>): boolean =>
      overlayAlbumIds.has(album.localId) ||
      album.artistLocalId === overlay.artist.localId;
    const albumInsertAt = albums.findIndex(shouldReplaceAlbum);
    const nextAlbums = albums.filter(
      (album) => !shouldReplaceAlbum(album)
    ) as AlbumRef[];
    nextAlbums.splice(
      albumInsertAt < 0 ? nextAlbums.length : Math.min(albumInsertAt, nextAlbums.length),
      0,
      ...overlay.albums
    );
    return { artists: nextArtists, albums: nextAlbums };
  }

  private createSnapshot(
    state: CoreCatalogState,
    value: Omit<CatalogSnapshot, "revision">
  ): CatalogSnapshot {
    return Object.freeze({
      coreId: value.coreId,
      revision: state.revision + 1,
      updatedAt: value.updatedAt,
      ...(value.lastCompleteScanAt
        ? { lastCompleteScanAt: value.lastCompleteScanAt }
        : {}),
      artists: Object.freeze(
        value.artists.map((artist) => this.freezeArtist(artist))
      ),
      albums: Object.freeze(value.albums.map((album) => this.freezeAlbum(album))),
    });
  }

  private commitSnapshot(
    state: CoreCatalogState,
    snapshot: CatalogSnapshot
  ): void {
    state.revision = snapshot.revision;
    state.snapshot = snapshot;
  }

  private async loadPersisted(
    coreId: string,
    state: CoreCatalogState
  ): Promise<void> {
    try {
      const raw = this.persistence ? await this.persistence.read(coreId) : null;
      if (raw !== null) {
        const { envelope: persisted, migrated } =
          this.normalizePersistedEnvelope(raw, coreId);
        state.revision = persisted.snapshot.revision;
        state.snapshot = persisted.snapshot;
        state.freshness = "stale";
        state.staleReason = "restored";
        if (migrated) {
          // One-time rewrite at the current version so the migration
          // never re-runs for this file.
          try {
            await this.persistSnapshot(coreId, state, persisted.snapshot);
          } catch {
            // persistSnapshot already logged and marked persistence
            // degraded; the restored in-memory snapshot remains valid.
          }
        }
      }
    } catch (error) {
      state.persistenceDegraded = true;
      state.lastProblem = this.problem("PERSISTENCE_READ_FAILED");
      this.logger.warn(
        { err: error, coreId },
        "Catalog persistence is unreadable; preserving it and entering degraded mode"
      );
    } finally {
      state.started = true;
    }
  }

  private async persistSnapshot(
    coreId: string,
    state: CoreCatalogState,
    snapshot: CatalogSnapshot
  ): Promise<void> {
    if (!this.persistence) return;
    try {
      const envelope: PersistedCatalogEnvelope = {
        version: CATALOG_PERSISTENCE_VERSION,
        coreId,
        snapshot,
      };
      await this.persistence.write(coreId, envelope);
    } catch (error) {
      state.persistenceDegraded = true;
      state.invalidationGeneration += 1;
      state.lastProblem = this.problem("PERSISTENCE_WRITE_FAILED");
      if (state.snapshot) {
        state.freshness = "stale";
        state.staleReason = "persistence-failed";
      }
      this.logger.warn(
        { err: error, coreId },
        "Catalog persistence failed; retaining the prior published snapshot"
      );
      throw new CatalogServiceError(
        "PERSISTENCE_DEGRADED",
        "Catalog persistence is degraded"
      );
    }
  }

  /**
   * Version-1 records were persisted before the encoding repair. Repair
   * display text and recompute the derived normalized fields on the RAW
   * records, before contract validation — the shared validators enforce
   * normalized === normalizeCatalogText(exact). Only existing keys are
   * touched, so exact-key validation is unaffected.
   */
  private migrateLegacyArtistText(candidate: unknown): unknown {
    if (!candidate || typeof candidate !== "object") return candidate;
    const record = { ...(candidate as Record<string, unknown>) };
    if (typeof record.exactName === "string") {
      const repaired = repairEncoding(record.exactName);
      if (repaired !== record.exactName) {
        record.exactName = repaired;
        record.normalizedName = normalizeCatalogText(repaired);
      }
    }
    return record;
  }

  private migrateLegacyAlbumText(candidate: unknown): unknown {
    if (!candidate || typeof candidate !== "object") return candidate;
    const record = { ...(candidate as Record<string, unknown>) };
    if (typeof record.exactTitle === "string") {
      const repaired = repairEncoding(record.exactTitle);
      if (repaired !== record.exactTitle) {
        record.exactTitle = repaired;
        record.normalizedTitle = normalizeCatalogText(repaired);
      }
    }
    if (typeof record.exactArtist === "string") {
      const repaired = repairEncoding(record.exactArtist);
      if (repaired !== record.exactArtist) {
        record.exactArtist = repaired;
        record.normalizedArtist = normalizeCatalogText(repaired);
      }
    }
    if (typeof record.editionText === "string") {
      const repaired = repairEncoding(record.editionText);
      if (repaired !== record.editionText) {
        record.editionText = repaired;
        if (typeof record.normalizedEditionText === "string") {
          record.normalizedEditionText = normalizeCatalogText(repaired);
        }
      }
    }
    return record;
  }

  private normalizePersistedEnvelope(
    value: unknown,
    expectedCoreId: string
  ): { envelope: PersistedCatalogEnvelope; migrated: boolean } {
    const envelope = this.plainRecord(value);
    if (
      !envelope ||
      !this.hasExactKeys(envelope, ["version", "coreId", "snapshot"]) ||
      (envelope.version !== CATALOG_PERSISTENCE_VERSION &&
        envelope.version !== PRE_NATIVE_CATALOG_PERSISTENCE_VERSION &&
        envelope.version !== LEGACY_CATALOG_PERSISTENCE_VERSION) ||
      envelope.coreId !== expectedCoreId
    ) {
      throw this.invalidPersisted("envelope");
    }
    const migrated = envelope.version !== CATALOG_PERSISTENCE_VERSION;
    const textMigrated = envelope.version === LEGACY_CATALOG_PERSISTENCE_VERSION;
    const rawSnapshot = this.plainRecord(envelope.snapshot);
    if (
      !rawSnapshot ||
      !this.hasExactKeys(
        rawSnapshot,
        ["coreId", "revision", "updatedAt", "artists", "albums"],
        ["lastCompleteScanAt"]
      ) ||
      rawSnapshot.coreId !== expectedCoreId ||
      typeof rawSnapshot.revision !== "number" ||
      !Number.isSafeInteger(rawSnapshot.revision) ||
      rawSnapshot.revision < 1 ||
      !this.isCanonicalTimestamp(rawSnapshot.updatedAt) ||
      !Array.isArray(rawSnapshot.artists) ||
      !Array.isArray(rawSnapshot.albums) ||
      rawSnapshot.artists.length > this.maxItemsPerHierarchy ||
      rawSnapshot.albums.length > this.maxItemsPerHierarchy
    ) {
      throw this.invalidPersisted("snapshot");
    }
    if (
      Object.prototype.hasOwnProperty.call(rawSnapshot, "lastCompleteScanAt") &&
      (!this.isCanonicalTimestamp(rawSnapshot.lastCompleteScanAt) ||
        Date.parse(rawSnapshot.lastCompleteScanAt) >
          Date.parse(rawSnapshot.updatedAt))
    ) {
      throw this.invalidPersisted("timestamps");
    }

    const artists = rawSnapshot.artists.map((candidate) => {
      const artist = normalizeArtistRef(
        textMigrated ? this.migrateLegacyArtistText(candidate) : candidate
      );
      if (!artist || artist.coreId !== expectedCoreId) {
        throw this.invalidPersisted("artist descriptor");
      }
      return this.freezeArtist(artist);
    });
    const albums = rawSnapshot.albums.map((candidate) => {
      const album = normalizeAlbumRef(
        textMigrated ? this.migrateLegacyAlbumText(candidate) : candidate
      );
      if (!album || album.coreId !== expectedCoreId) {
        throw this.invalidPersisted("album descriptor");
      }
      return this.freezeAlbum(album);
    });
    const artistIds = new Set(artists.map((artist) => artist.localId));
    const allIds = new Set<string>();
    for (const localId of [
      ...artists.map((artist) => artist.localId),
      ...albums.map((album) => album.localId),
    ]) {
      if (allIds.has(localId)) throw this.invalidPersisted("duplicate local ID");
      allIds.add(localId);
    }
    if (
      albums.some(
        (album) => album.artistLocalId && !artistIds.has(album.artistLocalId)
      )
    ) {
      throw this.invalidPersisted("album artist binding");
    }

    const snapshot: CatalogSnapshot = Object.freeze({
      coreId: expectedCoreId,
      revision: rawSnapshot.revision,
      updatedAt: rawSnapshot.updatedAt,
      ...(typeof rawSnapshot.lastCompleteScanAt === "string"
        ? { lastCompleteScanAt: rawSnapshot.lastCompleteScanAt }
        : {}),
      artists: Object.freeze(artists),
      albums: Object.freeze(albums),
    });
    return {
      envelope: Object.freeze({
        version: CATALOG_PERSISTENCE_VERSION,
        coreId: expectedCoreId,
        snapshot,
      }),
      migrated,
    };
  }

  private enqueueCommit<T>(
    state: CoreCatalogState,
    operation: () => Promise<T>
  ): Promise<T> {
    const run = state.commitTail.then(operation, operation);
    state.commitTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private assertPersistenceHealthy(state: CoreCatalogState): void {
    if (state.persistenceDegraded) {
      throw new CatalogServiceError(
        "PERSISTENCE_DEGRADED",
        "Catalog persistence is degraded"
      );
    }
  }

  private recordScanFailure(state: CoreCatalogState): void {
    state.lastProblem = this.problem("SCAN_FAILED");
    if (state.snapshot) {
      state.freshness = "stale";
      if (state.staleReason !== "core-disconnected") {
        state.staleReason = "scan-failed";
      }
    }
  }

  private problem(code: CatalogStatusProblemCode): CatalogStatusProblem {
    let occurredAt = "1970-01-01T00:00:00.000Z";
    try {
      occurredAt = new Date(this.readClock()).toISOString();
    } catch {
      // Preserve the primary catalog error if an injected/test clock is bad.
    }
    return Object.freeze({ code, occurredAt });
  }

  private plainRecord(value: unknown): Record<string, unknown> | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return null;
    }
    return value as Record<string, unknown>;
  }

  private hasExactKeys(
    record: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = []
  ): boolean {
    const keys = Reflect.ownKeys(record);
    return (
      keys.every(
        (key) =>
          typeof key === "string" &&
          (required.includes(key) || optional.includes(key))
      ) &&
      required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
    );
  }

  private isCanonicalTimestamp(value: unknown): value is string {
    if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  }

  private invalidPersisted(detail: string): CatalogServiceError {
    return new CatalogServiceError(
      "INVALID_PERSISTED_STATE",
      `Persisted catalog failed strict validation (${detail})`
    );
  }

  private freezeArtist(value: unknown): ArtistRef {
    const normalized = normalizeArtistRef(value);
    if (!normalized) {
      throw new CatalogServiceError(
        "INVALID_DESCRIPTOR",
        "Catalog artist descriptor is invalid"
      );
    }
    return Object.freeze(normalized);
  }

  private freezeAlbum(value: unknown): AlbumRef {
    const normalized = normalizeAlbumRef(value);
    if (!normalized) {
      throw new CatalogServiceError(
        "INVALID_DESCRIPTOR",
        "Catalog album descriptor is invalid"
      );
    }
    if (normalized.originalReleaseYearEvidence) {
      Object.freeze(normalized.originalReleaseYearEvidence);
    }
    if (normalized.editionReleaseYearEvidence) {
      Object.freeze(normalized.editionReleaseYearEvidence);
    }
    if (normalized.originalReleaseDate) {
      Object.freeze(normalized.originalReleaseDate);
    }
    if (normalized.releaseDate) {
      Object.freeze(normalized.releaseDate);
    }
    return Object.freeze(normalized);
  }

  private freezeMetrics(metrics: CatalogScanMetrics): CatalogScanMetrics {
    return Object.freeze({
      ...metrics,
      artists: Object.freeze({ ...metrics.artists }),
      albums: Object.freeze({ ...metrics.albums }),
      albumArtistAttribution: Object.freeze({
        ...metrics.albumArtistAttribution,
      }),
    });
  }

  private countBy(values: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  }

  private canonicalSearchQuery(value: unknown): string {
    if (
      typeof value !== "string" ||
      value.length > CATALOG_ARTIST_QUERY_MAX_LENGTH
    ) {
      throw new CatalogServiceError("INVALID_QUERY", "Artist query is invalid");
    }
    const canonical = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (
      canonical.length > CATALOG_ARTIST_QUERY_MAX_LENGTH ||
      CONTROL_CHARACTER.test(canonical)
    ) {
      throw new CatalogServiceError("INVALID_QUERY", "Artist query is invalid");
    }
    return canonical;
  }

  private readExpectedRevision(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value >= Number.MAX_SAFE_INTEGER
    ) {
      throw new CatalogServiceError(
        "INVALID_QUERY",
        "Catalog revision is invalid"
      );
    }
    return value;
  }

  private readBoundedLimit(
    value: unknown,
    maximum: number,
    label: string
  ): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > maximum
    ) {
      throw new CatalogServiceError(
        "INVALID_QUERY",
        `${label} limit is invalid`
      );
    }
    return value;
  }

  private compareArtistSearchCandidates(
    left: { artist: ArtistRef; rank: 0 | 1 | 2 },
    right: { artist: ArtistRef; rank: 0 | 1 | 2 }
  ): number {
    return (
      left.rank - right.rank ||
      compareCatalogTextByCodePoint(
        left.artist.normalizedName,
        right.artist.normalizedName
      ) ||
      compareCatalogTextByCodePoint(
        left.artist.exactName,
        right.artist.exactName
      ) ||
      compareCatalogTextByCodePoint(left.artist.localId, right.artist.localId)
    );
  }

  private canonicalDisplayText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const canonical = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
    return canonical.length > 0 &&
      canonical.length <= CATALOG_DISPLAY_TEXT_MAX_LENGTH &&
      !CONTROL_CHARACTER.test(canonical)
      ? canonical
      : null;
  }

  private opaqueHint(value: unknown): string | undefined {
    return typeof value === "string" &&
      value.length > 0 &&
      value.length <= CATALOG_OPAQUE_TEXT_MAX_LENGTH &&
      value.trim() === value &&
      !CONTROL_CHARACTER.test(value)
      ? value
      : undefined;
  }

  private allocateLocalId(usedIds: Set<string>): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.createLocalId();
      if (typeof candidate !== "string" || usedIds.has(candidate)) continue;
      const probe = normalizeArtistRef({
        localId: candidate,
        coreId: "probe",
        exactName: "probe",
        normalizedName: "probe",
        firstSeenAt: "2000-01-01T00:00:00.000Z",
        lastSeenAt: "2000-01-01T00:00:00.000Z",
        resolutionStatus: "unresolved",
      });
      if (!probe) continue;
      usedIds.add(candidate);
      return candidate;
    }
    throw new CatalogServiceError(
      "INVALID_CONFIGURATION",
      "Local ID generator did not produce a unique valid UUID"
    );
  }

  private readClock(): number {
    const value = this.now();
    if (!Number.isFinite(value)) {
      throw new CatalogServiceError(
        "INVALID_CONFIGURATION",
        "Catalog clock returned a non-finite value"
      );
    }
    const timestamp = new Date(value).toISOString();
    if (Number.isNaN(Date.parse(timestamp))) {
      throw new CatalogServiceError(
        "INVALID_CONFIGURATION",
        "Catalog clock returned an invalid date"
      );
    }
    return value;
  }

  private getOrCreateState(coreId: string): CoreCatalogState {
    let state = this.cores.get(coreId);
    if (!state) {
      state = {
        revision: 0,
        snapshot: null,
        overlays: new Map(),
        overlayGeneration: 0,
        lastScanMetrics: null,
        started: false,
        startPromise: null,
        commitTail: Promise.resolve(),
        freshness: "empty",
        persistenceDegraded: false,
        invalidationGeneration: 0,
      };
      this.cores.set(coreId, state);
    }
    return state;
  }

  private validateConfiguration(): void {
    if (
      !Number.isSafeInteger(this.pageSize) ||
      this.pageSize < 1 ||
      this.pageSize > MAX_PAGE_SIZE ||
      !Number.isSafeInteger(this.maxItemsPerHierarchy) ||
      this.maxItemsPerHierarchy < this.pageSize ||
      this.maxItemsPerHierarchy > ABSOLUTE_MAX_ITEMS_PER_HIERARCHY
    ) {
      throw new CatalogServiceError(
        "INVALID_CONFIGURATION",
        "Catalog paging limits are invalid"
      );
    }
  }

  private assertCoreId(coreId: string): void {
    if (
      typeof coreId !== "string" ||
      coreId.length < 1 ||
      coreId.length > CATALOG_OPAQUE_TEXT_MAX_LENGTH ||
      coreId.trim() !== coreId ||
      CONTROL_CHARACTER.test(coreId)
    ) {
      throw new CatalogServiceError(
        "INVALID_CONFIGURATION",
        "Catalog Core ID is invalid"
      );
    }
  }

  private incomplete(
    hierarchy: CatalogHierarchy,
    detail: string
  ): CatalogServiceError {
    return new CatalogServiceError(
      "INCOMPLETE_SCAN",
      `The ${hierarchy} hierarchy ${detail}`
    );
  }
}
