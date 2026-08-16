import { randomUUID } from "crypto";
import { Logger } from "pino";

import {
  normalizeCatalogTrackTitle,
  ResolvedSelectedArtistObservation,
} from "../catalog/CatalogReconciliation";
import { CatalogSnapshot } from "../catalog/CatalogService";
import {
  LIBRARY_ALBUM_MAX_VERSIONS,
  LIBRARY_ALBUM_MAX_TRACKS,
  LIBRARY_ALBUM_TEXT_MAX_LENGTH,
  LibraryAlbumCancelAck,
  LibraryAlbumFailedEvent,
  LibraryAlbumFailureCode,
  LibraryAlbumOpenAck,
  LibraryAlbumOpenRequest,
  LibraryAlbumResolvedEvent,
  LibraryAlbumSelectAck,
  LibraryAlbumVersionFailedEvent,
  LibraryAlbumVersionSummary,
  LibraryAlbumVersionsEvent,
  LibraryAlbumTrack,
  normalizeLibraryAlbumVersionSummary,
  normalizeLibraryAlbumCancelRequest,
  normalizeLibraryAlbumOpenRequest,
  normalizeLibraryAlbumSelectRequest,
} from "../../shared/libraryAlbumContracts";
import {
  AlbumRef,
  ArtistRef,
  normalizeCatalogText,
} from "../../shared/catalogContracts";
import { BrowseResult } from "../../shared/types";
import {
  ActionSessionAccess,
  ActionSessionHandle,
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
} from "./BrowseSessionCoordinator";
import { RoonTimeoutError } from "./errors";
import {
  AlbumActionVersionSource,
  createAlbumVersionDetailDigest,
} from "./AlbumActionResolver";
import {
  AlbumDetailResolver,
  AlbumDetailResolverError,
  AlbumEditionCandidate,
} from "./AlbumDetailResolver";
import {
  DiscographyResolver,
  DiscographyResolverError,
  ObservedDiscography,
} from "./DiscographyResolver";

const DEFAULT_RESOLVING_TTL_MS = 30_000;
const DEFAULT_REQUEST_TOMBSTONE_LIMIT = 256;
const MAX_TTL_MS = 5 * 60_000;
const MAX_TOMBSTONES = 4_096;
const CONTROL_CHARACTER = /\p{Cc}/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const OPAQUE_ID_MAX_LENGTH = 128;
const ID_ATTEMPTS = 32;

type Timer = ReturnType<typeof setTimeout>;

export interface LibraryAlbumOrigin {
  readonly coreId: string;
  readonly socketId: string;
}

export interface LibraryAlbumEventSink {
  versions(event: LibraryAlbumVersionsEvent): void;
  resolved(event: LibraryAlbumResolvedEvent): void;
  versionFailed(event: LibraryAlbumVersionFailedEvent): void;
  failed(event: LibraryAlbumFailedEvent): void;
}

export interface LibraryAlbumOpenReservation {
  readonly ack: LibraryAlbumOpenAck;
  /** One-shot start invoked only after the accepted ack is delivered. */
  readonly start?: () => void;
}

export interface LibraryAlbumSelectReservation {
  readonly ack: LibraryAlbumSelectAck;
  /** One-shot start invoked only after the accepted ack is delivered. */
  readonly start?: () => void;
}

export interface LibraryAlbumActionAuthority {
  readonly pageId: string;
  readonly versionId: string;
  readonly coreId: string;
  readonly socketId: string;
  readonly tabId: string;
  readonly generation: number;
  readonly albumSignature: string;
  readonly retainedItemKey: string;
  readonly source: Readonly<AlbumActionVersionSource>;
}

export interface LibraryAlbumCatalogPort {
  getSnapshot(coreId: string): CatalogSnapshot | null;
  reconcileSelectedArtist(
    coreId: string,
    artistLocalId: string,
    observation: ResolvedSelectedArtistObservation
  ): Promise<{
    artist: Readonly<ArtistRef>;
    albums: readonly Readonly<AlbumRef>[];
  }>;
}

export interface LibraryAlbumCoordinatorPort {
  acquireAction(input: {
    coreId: string;
    socketId: string;
    tabId: string;
    leaseId: string;
    generation: number;
  }): ActionSessionHandle;
  runAction<T>(
    access: ActionSessionAccess,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T>;
  releaseAction(access: ActionSessionAccess): Promise<void> | void;
  quarantineAction(access: ActionSessionAccess): void;
}

export interface LibraryAlbumResolution {
  readonly observation: ResolvedSelectedArtistObservation;
  readonly orderedTrackTitles: readonly string[];
}

export interface LibraryAlbumFallbackResolution {
  readonly orderedTrackTitles: readonly string[];
}

export interface LibraryAlbumFallbackResolverPort {
  resolve(
    coreId: string,
    album: Readonly<AlbumRef>
  ): Promise<LibraryAlbumFallbackResolution>;
}

/** Channel-neutral version metadata supplied by an optional feature layer. */
export interface LibraryAlbumInventoryVersion {
  readonly stableKey: string;
  readonly title: string;
  readonly artist: string;
  readonly editionText: string;
  readonly sourceLabel?: string;
  readonly releaseDate?: string;
  readonly playCount?: number;
  readonly lastPlayedAt?: string;
  readonly isFavorite?: boolean;
  readonly isListenLater?: boolean;
  readonly isBanned?: boolean;
}

/** Exact read-only track metadata for one inventory version. */
export interface LibraryAlbumInventoryTrack {
  readonly title: string;
  readonly trackNumber: number;
  readonly mediaNumber: number;
  readonly lengthSeconds: number | null;
  readonly available: boolean;
}

export interface LibraryAlbumInventoryDetail {
  readonly stableKey: string;
  readonly tracks: readonly LibraryAlbumInventoryTrack[];
}

type LibraryAlbumDetailTrack = Omit<LibraryAlbumTrack, "index">;

/** Optional richer inventory. Stable keys stay server-side and never cross the wire. */
export interface LibraryAlbumVersionInventoryPort {
  list(
    coreId: string,
    group: { readonly title: string; readonly artist: string }
  ): Promise<readonly LibraryAlbumInventoryVersion[] | null>;
  read(
    coreId: string,
    stableKeys: readonly string[]
  ): Promise<readonly LibraryAlbumInventoryDetail[] | null>;
}

export class LibraryAlbumFallbackError extends Error {
  public constructor(
    public readonly code: Extract<
      LibraryAlbumFailureCode,
      "DETAIL_INCOMPLETE" | "DETAIL_MISMATCH"
    >,
    message: string
  ) {
    super(message);
    this.name = "LibraryAlbumFallbackError";
    Object.setPrototypeOf(this, LibraryAlbumFallbackError.prototype);
  }
}

export interface LibraryAlbumResolverPort {
  observe(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>
  ): Promise<ObservedDiscography>;
  observeCurrent(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    first?: BrowseResult
  ): Promise<ObservedDiscography>;
  observeCandidates(
    discography: ObservedDiscography,
    album: Readonly<AlbumRef>
  ): readonly AlbumEditionCandidate[];
  resolveObservedCandidate(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    album: Readonly<AlbumRef>,
    discography: ObservedDiscography,
    observationIndex: number
  ): Promise<LibraryAlbumResolution>;
}

/** Public, mode-neutral discography/detail machinery. */
export class LibraryAlbumResolver implements LibraryAlbumResolverPort {
  public constructor(
    private readonly discographyResolver = new DiscographyResolver(),
    private readonly detailResolver = new AlbumDetailResolver()
  ) {}

  public async observe(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>
  ): Promise<ObservedDiscography> {
    const resolution = await this.discographyResolver.resolve(session, artist);
    if (resolution.kind !== "resolved") {
      throw new AlbumDetailResolverError(
        resolution.kind === "missing" ? "ALBUM_NOT_FOUND" : "ALBUM_AMBIGUOUS",
        resolution.kind === "missing"
          ? "The album artist could not be re-observed live"
          : "The album artist did not resolve uniquely"
      );
    }
    return this.discographyResolver.observeCurrent(session, artist);
  }

  public observeCurrent(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    first?: BrowseResult
  ): Promise<ObservedDiscography> {
    return this.discographyResolver.observeCurrent(session, artist, first);
  }

  public observeCandidates(
    discography: ObservedDiscography,
    album: Readonly<AlbumRef>
  ): readonly AlbumEditionCandidate[] {
    return this.detailResolver.observeCandidates(discography, album);
  }

  public resolveObservedCandidate(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    album: Readonly<AlbumRef>,
    discography: ObservedDiscography,
    observationIndex: number
  ): Promise<LibraryAlbumResolution> {
    return this.detailResolver.resolveObservedCandidate(
      session,
      artist,
      album,
      discography,
      observationIndex
    );
  }
}

export interface LibraryAlbumServiceOptions {
  resolvingTtlMs?: number;
  requestTombstoneLimit?: number;
  now?: () => number;
  randomId?: () => string;
  fallbackResolver?: LibraryAlbumFallbackResolverPort;
  versionInventory?: LibraryAlbumVersionInventoryPort;
}

type OperationPhase = "opening" | "ready" | "terminal" | "quarantined";

type LibraryAlbumReadAuthority =
  | {
      readonly kind: "public";
      readonly album: Readonly<AlbumRef>;
      readonly artist: Readonly<ArtistRef>;
    }
  | { readonly kind: "extended"; readonly album: Readonly<AlbumRef> };

interface PublicVersionAuthority {
  readonly kind: "public";
  readonly versionId: string;
  readonly itemKey: string;
  readonly publicSummary: LibraryAlbumVersionSummary;
  summary: LibraryAlbumVersionSummary;
  stableKey?: string;
  cached?: LibraryAlbumResolvedEvent;
  detailDigest?: string;
}

interface ExtendedVersionAuthority {
  readonly kind: "extended";
  readonly versionId: string;
  readonly summary: LibraryAlbumVersionSummary;
  cached?: LibraryAlbumResolvedEvent;
}

interface InventoryVersionAuthority {
  readonly kind: "inventory";
  readonly versionId: string;
  readonly stableKey: string;
  summary: LibraryAlbumVersionSummary;
  cached?: LibraryAlbumResolvedEvent;
}

type LibraryAlbumVersionAuthority =
  | PublicVersionAuthority
  | ExtendedVersionAuthority
  | InventoryVersionAuthority;

interface LibraryAlbumOperation {
  readonly operationId: string;
  readonly origin: LibraryAlbumOrigin;
  readonly request: LibraryAlbumOpenRequest;
  readonly resolvingDeadlineAt: number;
  readonly access: ActionSessionAccess;
  readonly sink: LibraryAlbumEventSink;
  phase: OperationPhase;
  started: boolean;
  closed: boolean;
  resolutionInFlight: boolean;
  timer: Timer | null;
  detailTimer: Timer | null;
  albumSignature: string | null;
  authority: LibraryAlbumReadAuthority | null;
  discography: ObservedDiscography | null;
  sessionAtDetail: boolean;
  versions: Map<string, LibraryAlbumVersionAuthority>;
  inventoryVersions: Map<string, LibraryAlbumInventoryVersion>;
  publicVersionCount: number;
  selectedVersionId: string | null;
  selectionSerial: number;
  detailChain: Promise<void>;
}

class LibraryAlbumPhaseError extends Error {
  public constructor(
    public readonly code: LibraryAlbumFailureCode,
    message: string
  ) {
    super(message);
    this.name = "LibraryAlbumPhaseError";
    Object.setPrototypeOf(this, LibraryAlbumPhaseError.prototype);
  }
}

/**
 * One retained, zone-less album page per socket tab. The page owns opaque
 * version IDs backed by exact live Roon row keys for its lifetime.
 */
export class LibraryAlbumService {
  private readonly resolvingTtlMs: number;
  private readonly requestTombstoneLimit: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly fallbackResolver?: LibraryAlbumFallbackResolverPort;
  private readonly versionInventory?: LibraryAlbumVersionInventoryPort;

  private readonly operations = new Map<string, LibraryAlbumOperation>();
  private readonly requests = new Map<string, LibraryAlbumOperation>();
  private readonly tabs = new Map<string, LibraryAlbumOperation>();
  private readonly requestTombstones = new Map<string, true>();
  private idNonce = 0;
  private stopped = false;

  public constructor(
    private readonly coordinator: LibraryAlbumCoordinatorPort,
    private readonly catalog: LibraryAlbumCatalogPort,
    private readonly resolver: LibraryAlbumResolverPort,
    private readonly logger: Logger,
    options: LibraryAlbumServiceOptions = {}
  ) {
    this.resolvingTtlMs =
      options.resolvingTtlMs ?? DEFAULT_RESOLVING_TTL_MS;
    this.requestTombstoneLimit =
      options.requestTombstoneLimit ?? DEFAULT_REQUEST_TOMBSTONE_LIMIT;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => randomUUID());
    this.fallbackResolver = options.fallbackResolver;
    this.versionInventory = options.versionInventory;
    this.validateOptions();
  }

  public open(
    origin: LibraryAlbumOrigin,
    value: unknown,
    sink: LibraryAlbumEventSink
  ): LibraryAlbumOpenReservation {
    if (this.stopped || !this.validOrigin(origin) || !this.validSink(sink)) {
      return this.openRejected("INVALID_REQUEST", "Invalid library album request");
    }
    const request = normalizeLibraryAlbumOpenRequest(value);
    if (!request) {
      return this.openRejected("INVALID_REQUEST", "Invalid library album request");
    }
    const requestKey = this.requestKey(origin.socketId, request.requestId);
    if (this.requests.has(requestKey) || this.requestTombstones.has(requestKey)) {
      return this.openRejected(
        "REQUEST_ID_CONFLICT",
        "The library album request ID was already used"
      );
    }

    let operationId: string;
    try {
      operationId = this.uniqueOpaqueId();
    } catch {
      return this.openRejected(
        "BACKPRESSURE",
        "Library album identifiers temporarily unavailable"
      );
    }

    const tabKey = this.tabKey(origin.socketId, request.tabId);
    const existing = this.tabs.get(tabKey);
    if (existing && !existing.closed) {
      this.close(existing, existing.resolutionInFlight);
      this.emitFailure(existing, "SUPERSEDED", "A newer album page replaced this one");
    }

    let handle: ActionSessionHandle;
    try {
      handle = this.coordinator.acquireAction({
        coreId: origin.coreId,
        socketId: origin.socketId,
        tabId: request.tabId,
        leaseId: operationId,
        generation: request.generation,
      });
    } catch (error) {
      if (
        error instanceof BrowseSessionCoordinatorError &&
        error.code === "BACKPRESSURE"
      ) {
        return this.openRejected("BACKPRESSURE", "Album pages are currently busy");
      }
      return this.openRejected(
        "INVALID_REQUEST",
        "The library session is no longer current"
      );
    }

    const access: ActionSessionAccess = Object.freeze({
      coreId: origin.coreId,
      socketId: origin.socketId,
      tabId: request.tabId,
      handle,
    });
    const resolvingDeadlineAt = this.now() + this.resolvingTtlMs;
    const operation: LibraryAlbumOperation = {
      operationId,
      origin: Object.freeze({ ...origin }),
      request: Object.freeze({ ...request }),
      resolvingDeadlineAt,
      access,
      sink,
      phase: "opening",
      started: false,
      closed: false,
      resolutionInFlight: false,
      timer: null,
      detailTimer: null,
      albumSignature: null,
      authority: null,
      discography: null,
      sessionAtDetail: false,
      versions: new Map(),
      inventoryVersions: new Map(),
      publicVersionCount: 0,
      selectedVersionId: null,
      selectionSerial: 0,
      detailChain: Promise.resolve(),
    };
    this.operations.set(operationId, operation);
    this.requests.set(requestKey, operation);
    this.tabs.set(tabKey, operation);
    this.armOpeningTimer(operation);

    let started = false;
    return Object.freeze({
      ack: Object.freeze({
        success: true,
        data: Object.freeze({
          requestId: request.requestId,
          operationId,
          resolvingDeadlineAt,
        }),
      }),
      start: (): void => {
        if (started) return;
        started = true;
        this.startOpen(operation);
      },
    });
  }

  public select(
    origin: LibraryAlbumOrigin,
    value: unknown
  ): LibraryAlbumSelectReservation {
    if (this.stopped || !this.validOrigin(origin)) {
      return this.selectRejected("INVALID_REQUEST", "Invalid album version request");
    }
    const request = normalizeLibraryAlbumSelectRequest(value);
    if (!request) {
      return this.selectRejected("INVALID_REQUEST", "Invalid album version request");
    }
    const operation = this.operations.get(request.operationId);
    if (
      !operation ||
      operation.closed ||
      operation.phase !== "ready" ||
      operation.origin.coreId !== origin.coreId ||
      operation.origin.socketId !== origin.socketId
    ) {
      return this.selectRejected("SESSION_LOST", "The album page is no longer current");
    }
    const version = operation.versions.get(request.versionId);
    if (!version) {
      return this.selectRejected("INVALID_REQUEST", "Unknown album version");
    }

    const resolvingDeadlineAt = this.now() + this.resolvingTtlMs;
    let started = false;
    return Object.freeze({
      ack: Object.freeze({
        success: true,
        data: Object.freeze({
          operationId: operation.operationId,
          versionId: version.versionId,
          resolvingDeadlineAt,
        }),
      }),
      start: (): void => {
        if (started) return;
        started = true;
        this.scheduleSelection(operation, version, resolvingDeadlineAt);
      },
    });
  }

  public claimSelectedVersionAction(
    origin: LibraryAlbumOrigin,
    input: {
      readonly pageId: string;
      readonly versionId: string;
      readonly tabId: string;
      readonly generation: number;
    }
  ): LibraryAlbumActionAuthority | null {
    if (this.stopped || !this.validOrigin(origin)) return null;
    const operation = this.operations.get(input.pageId);
    if (!operation || !this.selectedActionSourceMatches(operation, origin, input)) {
      return null;
    }
    const authority = operation.authority;
    const version = operation.versions.get(input.versionId);
    if (
      !authority ||
      authority.kind !== "public" ||
      !version ||
      version.kind !== "public" ||
      !version.cached?.actionsAvailable ||
      !version.detailDigest ||
      !operation.albumSignature
    ) {
      return null;
    }
    try {
      this.assertReadAuthority(operation);
    } catch {
      return null;
    }
    return Object.freeze({
      pageId: operation.operationId,
      versionId: version.versionId,
      coreId: operation.origin.coreId,
      socketId: operation.origin.socketId,
      tabId: operation.request.tabId,
      generation: operation.request.generation,
      albumSignature: operation.albumSignature,
      retainedItemKey: version.itemKey,
      source: Object.freeze({
        album: authority.album,
        artist: authority.artist,
        detailDigest: version.detailDigest,
        versionCount: operation.publicVersionCount,
      }),
    });
  }

  public isSelectedVersionActionCurrent(
    authority: Readonly<LibraryAlbumActionAuthority>
  ): boolean {
    if (this.stopped) return false;
    const operation = this.operations.get(authority.pageId);
    if (
      !operation ||
      !this.selectedActionSourceMatches(
        operation,
        { coreId: authority.coreId, socketId: authority.socketId },
        authority
      ) ||
      operation.albumSignature !== authority.albumSignature
    ) {
      return false;
    }
    const version = operation.versions.get(authority.versionId);
    if (
      !version ||
      version.kind !== "public" ||
      version.itemKey !== authority.retainedItemKey ||
      version.detailDigest !== authority.source.detailDigest ||
      operation.publicVersionCount !== authority.source.versionCount ||
      !version.cached?.actionsAvailable
    ) {
      return false;
    }
    try {
      this.assertReadAuthority(operation);
      return true;
    } catch {
      return false;
    }
  }

  public cancel(origin: LibraryAlbumOrigin, value: unknown): LibraryAlbumCancelAck {
    if (!this.validOrigin(origin)) return this.invalidCancelAck();
    const request = normalizeLibraryAlbumCancelRequest(value);
    if (!request) return this.invalidCancelAck();
    const operation =
      "operationId" in request
        ? this.operations.get(request.operationId)
        : this.requests.get(this.requestKey(origin.socketId, request.requestId));
    if (
      !operation ||
      operation.closed ||
      operation.origin.coreId !== origin.coreId ||
      operation.origin.socketId !== origin.socketId
    ) {
      return { success: true, data: { claimed: false } };
    }
    this.close(operation, operation.resolutionInFlight);
    this.emitFailure(operation, "CANCELED", "The album page was closed");
    return { success: true, data: { claimed: true } };
  }

  public disconnectSocket(socketId: string): void {
    for (const operation of [...this.operations.values()]) {
      if (operation.origin.socketId === socketId && !operation.closed) {
        this.close(operation, operation.resolutionInFlight);
      }
    }
  }

  /** Runs before coordinator Core invalidation so uncertain work is quarantined. */
  public invalidateCore(coreId: string): void {
    for (const operation of [...this.operations.values()]) {
      if (operation.origin.coreId !== coreId || operation.closed) continue;
      this.close(operation, operation.resolutionInFlight);
      this.emitFailure(operation, "SESSION_LOST", "The Roon Core session was lost");
    }
  }

  public shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const operation of [...this.operations.values()]) {
      if (!operation.closed) this.close(operation, operation.resolutionInFlight);
    }
  }

  private startOpen(operation: LibraryAlbumOperation): void {
    if (operation.closed || operation.started || operation.phase !== "opening") return;
    if (this.now() >= operation.resolvingDeadlineAt) {
      this.expireOpening(operation);
      return;
    }
    operation.started = true;
    void this.openPage(operation);
  }

  private async openPage(operation: LibraryAlbumOperation): Promise<void> {
    try {
      const bound = this.currentAlbum(
        operation.origin.coreId,
        operation.request.albumLocalId
      );
      if (!bound) {
        throw new LibraryAlbumPhaseError(
          "ALBUM_NOT_FOUND",
          "The album is not currently available"
        );
      }
      operation.authority = bound;
      operation.albumSignature = this.readAuthoritySignature(bound);
      this.assertReadAuthority(operation);

      if (bound.kind === "extended") {
        const inventory = await this.loadVersionInventory(operation, bound.album);
        if (inventory.length > 0) {
          for (const value of inventory) {
            operation.inventoryVersions.set(value.stableKey, value);
            const version = this.buildInventoryVersion(value);
            operation.versions.set(version.versionId, version);
          }
        } else {
          const version = this.buildExtendedVersion(bound.album);
          operation.versions.set(version.versionId, version);
        }
        this.publishVersions(operation, bound.album);
        return;
      }

      operation.resolutionInFlight = true;
      const discography = await this.coordinator.runAction(
        operation.access,
        async (session) =>
          this.resolver.observe(
            this.guardedSession(operation, session),
            bound.artist
          )
      );
      operation.resolutionInFlight = false;
      if (operation.closed || operation.phase !== "opening") return;
      if (this.now() > operation.resolvingDeadlineAt) {
        this.expireOpening(operation);
        return;
      }
      this.assertReadAuthority(operation);
      operation.discography = discography;
      const publicVersions = this.buildPublicVersions(bound.album, discography);
      operation.publicVersionCount = publicVersions.length;
      for (const version of publicVersions) {
        operation.versions.set(version.versionId, version);
      }
      await this.mergeVersionInventory(operation, bound.album, publicVersions);
      if (operation.closed || operation.phase !== "opening") return;
      this.assertReadAuthority(operation);
      this.publishVersions(operation, bound.album);
    } catch (error) {
      operation.resolutionInFlight = false;
      if (operation.closed || operation.phase !== "opening") return;
      if (error instanceof RoonTimeoutError) {
        this.close(operation, true);
        this.emitFailure(operation, "RESOLUTION_TIMEOUT", "Album page opening timed out");
        return;
      }
      if (
        error instanceof BrowseSessionCoordinatorError &&
        error.code === "SESSION_LOST"
      ) {
        this.close(operation, true);
        this.emitFailure(operation, "SESSION_LOST", "The album page session was lost");
        return;
      }
      const failure = this.resolutionFailure(error);
      this.close(operation, false);
      this.emitFailure(operation, failure.code, failure.message);
    }
  }

  private publishVersions(
    operation: LibraryAlbumOperation,
    album: Readonly<AlbumRef>
  ): void {
    if (operation.closed || operation.phase !== "opening") return;
    if (operation.versions.size < 1) {
      throw new LibraryAlbumPhaseError(
        "ALBUM_NOT_FOUND",
        "No live versions of this album were found"
      );
    }
    operation.phase = "ready";
    this.clearOpeningTimer(operation);
    const event: LibraryAlbumVersionsEvent = Object.freeze({
      requestId: operation.request.requestId,
      operationId: operation.operationId,
      generation: operation.request.generation,
      artist: album.exactArtist,
      title: album.exactTitle,
      versions: Object.freeze(
        [...operation.versions.values()].map((version) => version.summary)
      ),
    });
    try {
      operation.sink.versions(event);
    } catch (error) {
      this.logger.warn(
        { err: error, operationId: operation.operationId },
        "Library album versions sink failed"
      );
    }
  }

  private buildPublicVersions(
    album: Readonly<AlbumRef>,
    discography: ObservedDiscography
  ): PublicVersionAuthority[] {
    const candidates = this.resolver.observeCandidates(discography, album);
    if (
      candidates.length < 1 ||
      candidates.length > LIBRARY_ALBUM_MAX_VERSIONS
    ) {
      throw new LibraryAlbumPhaseError(
        candidates.length === 0 ? "ALBUM_NOT_FOUND" : "DETAIL_INCOMPLETE",
        candidates.length === 0
          ? "No live versions of this album were found"
          : "The album has more versions than this page can safely retain"
      );
    }
    const seenItemKeys = new Set<string>();
    return candidates.map((candidate) => {
      const observed = discography.observation.albums[candidate.observationIndex];
      const liveRows = discography.liveAlbums.filter(
        (row) => row.observationIndex === candidate.observationIndex
      );
      if (
        !observed ||
        liveRows.length !== 1 ||
        seenItemKeys.has(liveRows[0].itemKey) ||
        normalizeCatalogText(candidate.title) !== album.normalizedTitle ||
        normalizeCatalogText(candidate.artist) !== album.normalizedArtist ||
        !this.validOptionalDisplayText(candidate.editionText)
      ) {
        throw new LibraryAlbumPhaseError(
          "DETAIL_INCOMPLETE",
          "The live album version list was incomplete"
        );
      }
      seenItemKeys.add(liveRows[0].itemKey);
      const versionId = this.uniqueOpaqueId();
      const summary: LibraryAlbumVersionSummary = Object.freeze({
        versionId,
        editionText: candidate.editionText,
        ...(observed.imageKeyHint
          ? { imageKeyHint: observed.imageKeyHint }
          : {}),
      });
      return {
        kind: "public",
        versionId,
        itemKey: liveRows[0].itemKey,
        publicSummary: summary,
        summary,
      };
    });
  }

  private buildExtendedVersion(album: Readonly<AlbumRef>): ExtendedVersionAuthority {
    const versionId = this.uniqueOpaqueId();
    const summary: LibraryAlbumVersionSummary = Object.freeze({
      versionId,
      editionText: album.editionText,
      ...(album.imageKeyHint ? { imageKeyHint: album.imageKeyHint } : {}),
    });
    return { kind: "extended", versionId, summary };
  }

  private async loadVersionInventory(
    operation: LibraryAlbumOperation,
    album: Readonly<AlbumRef>
  ): Promise<readonly LibraryAlbumInventoryVersion[]> {
    const inventory = this.versionInventory;
    if (!inventory) return [];
    try {
      const values = await inventory.list(operation.origin.coreId, {
        title: album.exactTitle,
        artist: album.exactArtist,
      });
      if (
        !values ||
        values.length < 1 ||
        values.length > LIBRARY_ALBUM_MAX_VERSIONS
      ) {
        return [];
      }
      const seen = new Set<string>();
      for (const value of values) {
        if (
          !value ||
          typeof value !== "object" ||
          !this.validOpaqueId(value.stableKey) ||
          seen.has(value.stableKey) ||
          normalizeCatalogText(value.title) !== album.normalizedTitle ||
          normalizeCatalogText(value.artist) !== album.normalizedArtist ||
          !normalizeLibraryAlbumVersionSummary(
            this.inventorySummary("inventory", value)
          )
        ) {
          this.logger.warn(
            { operationId: operation.operationId },
            "Album version inventory returned an invalid or conflicting group; ignoring its enhancement"
          );
          return [];
        }
        seen.add(value.stableKey);
      }
      return values;
    } catch (error) {
      this.logger.debug(
        { err: error, operationId: operation.operationId },
        "Album version inventory unavailable; retaining the public page"
      );
      return [];
    }
  }

  private async mergeVersionInventory(
    operation: LibraryAlbumOperation,
    album: Readonly<AlbumRef>,
    publicVersions: readonly PublicVersionAuthority[]
  ): Promise<void> {
    const inventory = await this.loadVersionInventory(operation, album);
    if (operation.closed || inventory.length === 0) return;
    for (const value of inventory) {
      operation.inventoryVersions.set(value.stableKey, value);
    }

    const publicByEdition = new Map<string, PublicVersionAuthority[]>();
    for (const version of publicVersions) {
      const key = normalizeCatalogText(version.publicSummary.editionText);
      const group = publicByEdition.get(key) ?? [];
      group.push(version);
      publicByEdition.set(key, group);
    }
    const inventoryByEdition = new Map<string, LibraryAlbumInventoryVersion[]>();
    for (const value of inventory) {
      const key = normalizeCatalogText(value.editionText);
      const group = inventoryByEdition.get(key) ?? [];
      group.push(value);
      inventoryByEdition.set(key, group);
    }

    const matchedKeys = new Set<string>();
    for (const [key, pageValues] of publicByEdition) {
      const inventoryValues = inventoryByEdition.get(key) ?? [];
      const blankSingleton =
        key === "" && publicVersions.length === 1 && inventory.length === 1;
      if (
        pageValues.length !== 1 ||
        inventoryValues.length !== 1 ||
        (key === "" && !blankSingleton)
      ) {
        continue;
      }
      const version = pageValues[0];
      const value = inventoryValues[0];
      version.stableKey = value.stableKey;
      version.summary = this.inventorySummary(
        version.versionId,
        value,
        version.publicSummary
      );
      matchedKeys.add(value.stableKey);
    }

    // An unmatched richer row is provably distinct only when every public row
    // carries a non-empty unique edition discriminator. Blank public labels may
    // still describe any richer row, so those rows stay hidden until a complete
    // selected-detail fingerprint proves a one-to-one match.
    const publicEditionKeys = publicVersions.map((version) =>
      normalizeCatalogText(version.publicSummary.editionText)
    );
    const canExposeUnmatched =
      publicEditionKeys.every((key) => key !== "") &&
      new Set(publicEditionKeys).size === publicEditionKeys.length;
    const unmatched = canExposeUnmatched
      ? inventory.filter((value) => !matchedKeys.has(value.stableKey))
      : [];
    if (operation.versions.size + unmatched.length > LIBRARY_ALBUM_MAX_VERSIONS) {
      return;
    }
    for (const value of unmatched) {
      const version = this.buildInventoryVersion(value);
      operation.versions.set(version.versionId, version);
    }
  }

  private buildInventoryVersion(
    value: LibraryAlbumInventoryVersion
  ): InventoryVersionAuthority {
    const versionId = this.uniqueOpaqueId();
    return {
      kind: "inventory",
      versionId,
      stableKey: value.stableKey,
      summary: this.inventorySummary(versionId, value),
    };
  }

  private inventorySummary(
    versionId: string,
    value: LibraryAlbumInventoryVersion,
    base?: LibraryAlbumVersionSummary,
    detail?: LibraryAlbumInventoryDetail
  ): LibraryAlbumVersionSummary {
    const durationValues = detail?.tracks.map((track) => track.lengthSeconds) ?? [];
    const durationKnown =
      durationValues.length > 0 && durationValues.every((length) => length !== null);
    return Object.freeze({
      versionId,
      editionText: value.editionText || base?.editionText || "",
      ...(base?.imageKeyHint ? { imageKeyHint: base.imageKeyHint } : {}),
      ...(value.sourceLabel ? { sourceLabel: value.sourceLabel } : {}),
      ...(value.releaseDate ? { releaseDate: value.releaseDate } : {}),
      ...(detail ? { trackCount: detail.tracks.length } : {}),
      ...(durationKnown
        ? {
            durationSeconds: durationValues.reduce(
              (sum, length) => sum + length,
              0
            ),
          }
        : {}),
      ...(detail
        ? { available: detail.tracks.every((track) => track.available) }
        : {}),
      ...(value.playCount !== undefined ? { playCount: value.playCount } : {}),
      ...(value.lastPlayedAt ? { lastPlayedAt: value.lastPlayedAt } : {}),
      ...(value.isFavorite !== undefined
        ? { isFavorite: value.isFavorite }
        : {}),
      ...(value.isListenLater !== undefined
        ? { isListenLater: value.isListenLater }
        : {}),
      ...(value.isBanned !== undefined ? { isBanned: value.isBanned } : {}),
    });
  }

  private scheduleSelection(
    operation: LibraryAlbumOperation,
    version: LibraryAlbumVersionAuthority,
    resolvingDeadlineAt: number
  ): void {
    if (operation.closed || operation.phase !== "ready") return;
    operation.selectionSerial += 1;
    operation.selectedVersionId = null;
    const serial = operation.selectionSerial;
    this.clearDetailTimer(operation);
    operation.detailTimer = this.unrefTimer(
      setTimeout(
        () => this.expireSelection(operation, serial, version, resolvingDeadlineAt),
        Math.max(0, resolvingDeadlineAt - this.now())
      )
    );
    operation.detailChain = operation.detailChain.then(() =>
      this.resolveSelection(operation, serial, version, resolvingDeadlineAt)
    );
  }

  private async resolveSelection(
    operation: LibraryAlbumOperation,
    serial: number,
    version: LibraryAlbumVersionAuthority,
    resolvingDeadlineAt: number
  ): Promise<void> {
    if (!this.selectionCurrent(operation, serial)) return;
    if (this.now() >= resolvingDeadlineAt) {
      this.expireSelection(operation, serial, version, resolvingDeadlineAt);
      return;
    }
    if (version.cached) {
      this.finishSelection(operation, serial);
      operation.selectedVersionId = version.versionId;
      this.emitResolved(operation, version.cached);
      return;
    }

    try {
      this.assertReadAuthority(operation);
      let event: LibraryAlbumResolvedEvent;
      if (version.kind === "inventory") {
        event = await this.resolveInventorySelection(operation, version);
      } else if (version.kind === "extended") {
        event = await this.resolveExtendedSelection(operation, version);
      } else {
        operation.resolutionInFlight = true;
        const resolution = await this.coordinator.runAction(
          operation.access,
          (session) => this.resolvePublicSelection(operation, version, session)
        );
        operation.resolutionInFlight = false;
        this.assertReadAuthority(operation);
        const album = operation.authority?.album;
        if (!album) {
          throw new LibraryAlbumPhaseError(
            "ALBUM_NOT_FOUND",
            "The album page authority was lost"
          );
        }
        const detailDigest = createAlbumVersionDetailDigest(
          album.exactTitle,
          album.exactArtist,
          resolution.orderedTrackTitles
        );
        const enriched = await this.enrichPublicDetail(
          operation,
          version,
          resolution.orderedTrackTitles
        );
        event = this.buildResolvedEvent(
          operation,
          version.versionId,
          album,
          enriched.tracks,
          true,
          enriched.summary
        );
        version.detailDigest = detailDigest;
      }
      version.cached = event;
      if (!this.selectionCurrent(operation, serial)) return;
      if (this.now() > resolvingDeadlineAt) {
        this.expireSelection(operation, serial, version, resolvingDeadlineAt);
        return;
      }
      this.finishSelection(operation, serial);
      operation.selectedVersionId = version.versionId;
      this.emitResolved(operation, event);
    } catch (error) {
      operation.resolutionInFlight = false;
      if (!this.selectionCurrent(operation, serial)) return;
      this.finishSelection(operation, serial);
      if (error instanceof RoonTimeoutError) {
        this.close(operation, true);
        this.emitVersionFailure(
          operation,
          version.versionId,
          resolvingDeadlineAt,
          "RESOLUTION_TIMEOUT",
          "This album version timed out"
        );
        return;
      }
      if (
        error instanceof BrowseSessionCoordinatorError &&
        error.code === "SESSION_LOST"
      ) {
        this.close(operation, true);
        this.emitVersionFailure(
          operation,
          version.versionId,
          resolvingDeadlineAt,
          "SESSION_LOST",
          "The album page session was lost"
        );
        return;
      }
      const failure = this.resolutionFailure(error);
      this.emitVersionFailure(
        operation,
        version.versionId,
        resolvingDeadlineAt,
        failure.code,
        failure.message
      );
    }
  }

  private async resolveExtendedSelection(
    operation: LibraryAlbumOperation,
    version: ExtendedVersionAuthority
  ): Promise<LibraryAlbumResolvedEvent> {
    const fallbackResolver = this.fallbackResolver;
    const album = operation.authority?.album;
    if (!fallbackResolver || !album) {
      throw new LibraryAlbumPhaseError(
        "ALBUM_NOT_FOUND",
        "This album version is not currently readable"
      );
    }
    let resolution: LibraryAlbumFallbackResolution;
    try {
      resolution = await fallbackResolver.resolve(operation.origin.coreId, album);
    } catch (error) {
      this.assertReadAuthority(operation);
      if (error instanceof LibraryAlbumFallbackError) {
        throw new LibraryAlbumPhaseError(error.code, error.message);
      }
      throw new LibraryAlbumPhaseError(
        "DETAIL_INCOMPLETE",
        "The album's full track list could not be read"
      );
    }
    this.assertReadAuthority(operation);
    return this.buildResolvedEvent(
      operation,
      version.versionId,
      album,
      resolution.orderedTrackTitles.map((title) => ({ title })),
      false,
      version.summary
    );
  }

  private async resolveInventorySelection(
    operation: LibraryAlbumOperation,
    version: InventoryVersionAuthority
  ): Promise<LibraryAlbumResolvedEvent> {
    const album = operation.authority?.album;
    const value = operation.inventoryVersions.get(version.stableKey);
    if (!album || !value) {
      throw new LibraryAlbumPhaseError(
        "ALBUM_NOT_FOUND",
        "This album version is not currently readable"
      );
    }
    const details = await this.readInventoryDetails(operation, [version.stableKey]);
    const detail = details.find((candidate) => candidate.stableKey === version.stableKey);
    if (!detail) {
      throw new LibraryAlbumPhaseError(
        "DETAIL_INCOMPLETE",
        "The album's full track list could not be read"
      );
    }
    version.summary = this.inventorySummary(
      version.versionId,
      value,
      version.summary,
      detail
    );
    return this.buildResolvedEvent(
      operation,
      version.versionId,
      album,
      detail.tracks,
      false,
      version.summary
    );
  }

  private async enrichPublicDetail(
    operation: LibraryAlbumOperation,
    version: PublicVersionAuthority,
    publicTitles: readonly string[]
  ): Promise<{
    readonly summary: LibraryAlbumVersionSummary;
    readonly tracks: readonly LibraryAlbumDetailTrack[];
  }> {
    const publicTracks = publicTitles.map((title) => ({ title }));
    if (!this.versionInventory || operation.inventoryVersions.size === 0) {
      return { summary: version.publicSummary, tracks: publicTracks };
    }
    const usedKeys = new Set<string>();
    for (const candidate of operation.versions.values()) {
      if (candidate === version) continue;
      if (candidate.kind === "inventory") usedKeys.add(candidate.stableKey);
      if (candidate.kind === "public" && candidate.stableKey) {
        usedKeys.add(candidate.stableKey);
      }
    }
    const availableKeys = [...operation.inventoryVersions.keys()].filter(
      (stableKey) => !usedKeys.has(stableKey)
    );
    const details = await this.readInventoryDetails(operation, availableKeys);
    const normalizedPublicTitles = publicTitles.map(normalizeCatalogTrackTitle);
    const matches = details.filter(
      (detail) =>
        detail.tracks.length === normalizedPublicTitles.length &&
        detail.tracks.every(
          (track, index) =>
            normalizeCatalogTrackTitle(track.title) === normalizedPublicTitles[index]
        )
    );
    if (matches.length !== 1) {
      version.stableKey = undefined;
      version.summary = version.publicSummary;
      return { summary: version.publicSummary, tracks: publicTracks };
    }
    const detail = matches[0];
    const value = operation.inventoryVersions.get(detail.stableKey);
    if (!value) {
      return { summary: version.publicSummary, tracks: publicTracks };
    }
    version.stableKey = detail.stableKey;
    version.summary = this.inventorySummary(
      version.versionId,
      value,
      version.publicSummary,
      detail
    );
    return {
      summary: version.summary,
      tracks: publicTitles.map((title, index) => ({
        title,
        trackNumber: detail.tracks[index].trackNumber,
        mediaNumber: detail.tracks[index].mediaNumber,
        lengthSeconds: detail.tracks[index].lengthSeconds,
        available: detail.tracks[index].available,
      })),
    };
  }

  private async readInventoryDetails(
    operation: LibraryAlbumOperation,
    stableKeys: readonly string[]
  ): Promise<readonly LibraryAlbumInventoryDetail[]> {
    const inventory = this.versionInventory;
    if (!inventory || stableKeys.length === 0) return [];
    try {
      const values = await inventory.read(operation.origin.coreId, stableKeys);
      if (!values || values.length > stableKeys.length) return [];
      const requested = new Set(stableKeys);
      const seen = new Set<string>();
      for (const value of values) {
        if (
          !value ||
          !requested.has(value.stableKey) ||
          seen.has(value.stableKey) ||
          !Array.isArray(value.tracks) ||
          value.tracks.length < 1 ||
          value.tracks.length > LIBRARY_ALBUM_MAX_TRACKS ||
          value.tracks.some((track) => !this.validInventoryTrack(track))
        ) {
          return [];
        }
        seen.add(value.stableKey);
      }
      return values;
    } catch (error) {
      this.logger.debug(
        { err: error, operationId: operation.operationId },
        "Album version detail enhancement unavailable; retaining public details"
      );
      return [];
    }
  }

  private validInventoryTrack(value: LibraryAlbumInventoryTrack): boolean {
    return (
      Boolean(value) &&
      this.validDisplayText(value.title) &&
      Number.isSafeInteger(value.trackNumber) &&
      value.trackNumber >= 0 &&
      Number.isSafeInteger(value.mediaNumber) &&
      value.mediaNumber >= 0 &&
      (value.lengthSeconds === null ||
        (Number.isFinite(value.lengthSeconds) && value.lengthSeconds >= 0)) &&
      typeof value.available === "boolean"
    );
  }

  private async resolvePublicSelection(
    operation: LibraryAlbumOperation,
    version: PublicVersionAuthority,
    session: CoordinatedBrowseSession
  ): Promise<LibraryAlbumResolution> {
    const authority = operation.authority;
    if (!authority || authority.kind !== "public") {
      throw new LibraryAlbumPhaseError(
        "SESSION_LOST",
        "The public album page authority was lost"
      );
    }
    const guarded = this.guardedSession(operation, session);
    let current = operation.discography;
    if (!current) {
      throw new LibraryAlbumPhaseError(
        "SESSION_LOST",
        "The retained album version list was lost"
      );
    }
    if (operation.sessionAtDetail) {
      const parent = await guarded.pop({
        hierarchy: "artists",
        levels: 1,
        refresh: false,
        pageSize: 100,
      });
      operation.sessionAtDetail = false;
      current = await this.resolver.observeCurrent(
        guarded,
        authority.artist,
        parent
      );
      operation.discography = current;
    }
    const liveRows = current.liveAlbums.filter(
      (row) => row.itemKey === version.itemKey
    );
    if (liveRows.length !== 1) {
      throw new LibraryAlbumPhaseError(
        "ALBUM_NOT_FOUND",
        "This album version is no longer present on the page"
      );
    }
    const observationIndex = liveRows[0].observationIndex;
    const observed = current.observation.albums[observationIndex];
    if (
      !observed ||
      normalizeCatalogText(observed.exactTitle) !== authority.album.normalizedTitle ||
      normalizeCatalogText(observed.exactArtist) !== authority.album.normalizedArtist
    ) {
      throw new LibraryAlbumPhaseError(
        "DETAIL_MISMATCH",
        "This album version no longer matches the page"
      );
    }
    operation.sessionAtDetail = true;
    return this.resolver.resolveObservedCandidate(
      guarded,
      authority.artist,
      authority.album,
      current,
      observationIndex
    );
  }

  private buildResolvedEvent(
    operation: LibraryAlbumOperation,
    versionId: string,
    album: Readonly<AlbumRef>,
    orderedTracks: readonly LibraryAlbumDetailTrack[],
    actionsAvailable: boolean,
    versionSummary: LibraryAlbumVersionSummary
  ): LibraryAlbumResolvedEvent {
    if (
      orderedTracks.length === 0 ||
      orderedTracks.length > LIBRARY_ALBUM_MAX_TRACKS ||
      orderedTracks.some((track) => !this.validDisplayText(track.title)) ||
      !this.validDisplayText(album.exactArtist) ||
      !this.validDisplayText(album.exactTitle) ||
      !normalizeLibraryAlbumVersionSummary(versionSummary) ||
      versionSummary.versionId !== versionId
    ) {
      throw new LibraryAlbumPhaseError(
        "DETAIL_INCOMPLETE",
        "The album detail did not contain a complete bounded track list"
      );
    }
    return Object.freeze({
      requestId: operation.request.requestId,
      operationId: operation.operationId,
      generation: operation.request.generation,
      versionId,
      artist: album.exactArtist,
      title: album.exactTitle,
      actionsAvailable,
      versionSummary,
      orderedTracks: Object.freeze(
        orderedTracks.map((track, index) => Object.freeze({ index, ...track }))
      ),
    });
  }

  private currentAlbum(
    coreId: string,
    albumLocalId: string
  ): LibraryAlbumReadAuthority | null {
    const snapshot = this.catalog.getSnapshot(coreId);
    if (!snapshot || snapshot.coreId !== coreId) return null;
    const albums = snapshot.albums.filter(
      (album) => album.localId === albumLocalId && album.coreId === coreId
    );
    if (albums.length !== 1) return null;
    const selectedAlbum = albums[0];
    if (
      selectedAlbum.artistLocalId &&
      (selectedAlbum.resolutionStatus === "resolved" ||
        selectedAlbum.resolutionStatus === "ambiguous")
    ) {
      const artists = snapshot.artists.filter(
        (candidate) =>
          candidate.localId === selectedAlbum.artistLocalId &&
          candidate.coreId === coreId &&
          candidate.resolutionStatus === "resolved"
      );
      if (artists.length === 1) {
        return { kind: "public", album: selectedAlbum, artist: artists[0] };
      }
    }
    if (
      selectedAlbum.resolutionStatus === "unresolved" &&
      selectedAlbum.extendedAlbumId !== undefined &&
      selectedAlbum.extendedAlbumId.length > 0 &&
      this.fallbackResolver
    ) {
      return { kind: "extended", album: selectedAlbum };
    }
    return null;
  }

  private selectedActionSourceMatches(
    operation: LibraryAlbumOperation,
    origin: LibraryAlbumOrigin,
    input: {
      readonly pageId: string;
      readonly versionId: string;
      readonly tabId: string;
      readonly generation: number;
    }
  ): boolean {
    return (
      !operation.closed &&
      operation.phase === "ready" &&
      operation.operationId === input.pageId &&
      operation.selectedVersionId === input.versionId &&
      operation.origin.coreId === origin.coreId &&
      operation.origin.socketId === origin.socketId &&
      operation.request.tabId === input.tabId &&
      operation.request.generation === input.generation
    );
  }

  private guardedSession(
    operation: LibraryAlbumOperation,
    session: CoordinatedBrowseSession
  ): CoordinatedBrowseSession {
    const guarded: CoordinatedBrowseSession = {
      browse: (options) =>
        this.runResolutionCall(operation, () => session.browse(options)),
      load: (options) =>
        this.runResolutionCall(operation, () => session.load(options)),
      pop: (options) =>
        this.runResolutionCall(operation, () => session.pop(options)),
    };
    return Object.freeze(guarded);
  }

  private async runResolutionCall<T>(
    operation: LibraryAlbumOperation,
    call: () => Promise<T>
  ): Promise<T> {
    this.assertReadAuthority(operation);
    const result = await call();
    this.assertReadAuthority(operation);
    return result;
  }

  private assertReadAuthority(operation: LibraryAlbumOperation): void {
    const bound = this.currentAlbum(
      operation.origin.coreId,
      operation.request.albumLocalId
    );
    if (
      !bound ||
      !operation.albumSignature ||
      this.readAuthoritySignature(bound) !== operation.albumSignature
    ) {
      throw new LibraryAlbumPhaseError(
        "ALBUM_NOT_FOUND",
        "The album identity changed during the page session"
      );
    }
  }

  private readAuthoritySignature(bound: LibraryAlbumReadAuthority): string {
    const albumIdentity = [
      bound.kind,
      bound.album.coreId,
      bound.album.localId,
      bound.album.artistLocalId ?? "",
      bound.album.exactTitle,
      bound.album.exactArtist,
      bound.album.normalizedTitle,
      bound.album.normalizedArtist,
      bound.album.editionText,
      bound.album.trackTitleFingerprint ?? "",
      bound.album.resolutionStatus,
    ];
    return JSON.stringify(
      bound.kind === "public"
        ? [
            ...albumIdentity,
            bound.artist.localId,
            bound.artist.resolutionStatus,
          ]
        : [...albumIdentity, bound.album.extendedAlbumId ?? ""]
    );
  }

  private resolutionFailure(error: unknown): {
    code: LibraryAlbumFailureCode;
    message: string;
  } {
    if (error instanceof LibraryAlbumPhaseError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof AlbumDetailResolverError) {
      return {
        code: error.code,
        message: {
          ALBUM_NOT_FOUND: "This album version was not found live",
          ALBUM_AMBIGUOUS: "This album version could not be selected exactly",
          DETAIL_INCOMPLETE: "This album version's detail was incomplete",
          DETAIL_MISMATCH: "This album version changed while it was read",
        }[error.code],
      };
    }
    if (error instanceof DiscographyResolverError) {
      return {
        code:
          error.code === "DISCOGRAPHY_PATH_NOT_UNIQUE"
            ? "ALBUM_AMBIGUOUS"
            : "DETAIL_INCOMPLETE",
        message: "The album artist could not be re-observed exactly",
      };
    }
    return { code: "INTERNAL_ERROR", message: "Library album resolution failed" };
  }

  private close(operation: LibraryAlbumOperation, quarantine: boolean): void {
    if (operation.closed) return;
    operation.closed = true;
    operation.phase = quarantine ? "quarantined" : "terminal";
    operation.selectionSerial += 1;
    this.clearOpeningTimer(operation);
    this.clearDetailTimer(operation);
    if (this.operations.get(operation.operationId) === operation) {
      this.operations.delete(operation.operationId);
    }
    const requestKey = this.requestKey(
      operation.origin.socketId,
      operation.request.requestId
    );
    if (this.requests.get(requestKey) === operation) this.requests.delete(requestKey);
    const tabKey = this.tabKey(operation.origin.socketId, operation.request.tabId);
    if (this.tabs.get(tabKey) === operation) this.tabs.delete(tabKey);
    this.addRequestTombstone(requestKey);
    if (quarantine) {
      try {
        this.coordinator.quarantineAction(operation.access);
      } catch (error) {
        this.logCoordinatorFailure("quarantine album page", operation, error);
      }
    } else {
      try {
        void Promise.resolve(this.coordinator.releaseAction(operation.access)).catch(
          (error: unknown) => {
            this.logCoordinatorFailure("release album page", operation, error);
          }
        );
      } catch (error) {
        this.logCoordinatorFailure("release album page", operation, error);
      }
    }
  }

  private expireOpening(operation: LibraryAlbumOperation): void {
    if (operation.closed || operation.phase !== "opening") return;
    if (this.now() < operation.resolvingDeadlineAt) {
      this.armOpeningTimer(operation);
      return;
    }
    this.close(operation, operation.resolutionInFlight);
    this.emitFailure(operation, "RESOLUTION_TIMEOUT", "Album page opening timed out");
  }

  private expireSelection(
    operation: LibraryAlbumOperation,
    serial: number,
    version: LibraryAlbumVersionAuthority,
    resolvingDeadlineAt: number
  ): void {
    if (!this.selectionCurrent(operation, serial)) return;
    operation.selectionSerial += 1;
    this.clearDetailTimer(operation);
    if (operation.resolutionInFlight) this.close(operation, true);
    this.emitVersionFailure(
      operation,
      version.versionId,
      resolvingDeadlineAt,
      "RESOLUTION_TIMEOUT",
      "This album version timed out"
    );
  }

  private selectionCurrent(
    operation: LibraryAlbumOperation,
    serial: number
  ): boolean {
    return (
      !operation.closed &&
      operation.phase === "ready" &&
      operation.selectionSerial === serial
    );
  }

  private finishSelection(operation: LibraryAlbumOperation, serial: number): void {
    if (operation.selectionSerial === serial) this.clearDetailTimer(operation);
  }

  private armOpeningTimer(operation: LibraryAlbumOperation): void {
    this.clearOpeningTimer(operation);
    operation.timer = this.unrefTimer(
      setTimeout(
        () => this.expireOpening(operation),
        Math.max(0, operation.resolvingDeadlineAt - this.now())
      )
    );
  }

  private clearOpeningTimer(operation: LibraryAlbumOperation): void {
    if (operation.timer) clearTimeout(operation.timer);
    operation.timer = null;
  }

  private clearDetailTimer(operation: LibraryAlbumOperation): void {
    if (operation.detailTimer) clearTimeout(operation.detailTimer);
    operation.detailTimer = null;
  }

  private unrefTimer(timer: Timer): Timer {
    timer.unref?.();
    return timer;
  }

  private emitResolved(
    operation: LibraryAlbumOperation,
    event: LibraryAlbumResolvedEvent
  ): void {
    try {
      operation.sink.resolved(event);
    } catch (error) {
      this.logger.warn(
        { err: error, operationId: operation.operationId },
        "Library album details sink failed"
      );
    }
  }

  private emitVersionFailure(
    operation: LibraryAlbumOperation,
    versionId: string,
    resolvingDeadlineAt: number,
    code: LibraryAlbumFailureCode,
    error: string
  ): void {
    const event: LibraryAlbumVersionFailedEvent = Object.freeze({
      requestId: operation.request.requestId,
      operationId: operation.operationId,
      generation: operation.request.generation,
      resolvingDeadlineAt,
      versionId,
      error,
      code,
    });
    try {
      operation.sink.versionFailed(event);
    } catch (sinkError) {
      this.logger.warn(
        { err: sinkError, operationId: operation.operationId },
        "Library album version failure sink failed"
      );
    }
  }

  private emitFailure(
    operation: LibraryAlbumOperation,
    code: LibraryAlbumFailureCode,
    error: string
  ): void {
    const event: LibraryAlbumFailedEvent = Object.freeze({
      requestId: operation.request.requestId,
      operationId: operation.operationId,
      generation: operation.request.generation,
      resolvingDeadlineAt: operation.resolvingDeadlineAt,
      error,
      code,
    });
    try {
      operation.sink.failed(event);
    } catch (sinkError) {
      this.logger.warn(
        { err: sinkError, operationId: operation.operationId },
        "Library album failure sink failed"
      );
    }
  }

  private validDisplayText(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= LIBRARY_ALBUM_TEXT_MAX_LENGTH &&
      value.trim() === value &&
      !CONTROL_CHARACTER.test(value)
    );
  }

  private validOptionalDisplayText(value: unknown): value is string {
    return value === "" || this.validDisplayText(value);
  }

  private requestKey(socketId: string, requestId: string): string {
    return `${socketId}\u0000${requestId}`;
  }

  private tabKey(socketId: string, tabId: string): string {
    return `${socketId}\u0000${tabId}`;
  }

  private addRequestTombstone(requestKey: string): void {
    this.requestTombstones.delete(requestKey);
    this.requestTombstones.set(requestKey, true);
    while (this.requestTombstones.size > this.requestTombstoneLimit) {
      const oldest = this.requestTombstones.keys().next().value;
      if (typeof oldest !== "string") break;
      this.requestTombstones.delete(oldest);
    }
  }

  private uniqueOpaqueId(): string {
    if (this.idNonce >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Library album identifier space exhausted");
    }
    const nextNonce = this.idNonce + 1;
    const suffix = `:${nextNonce.toString(36)}`;
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      const randomPart = this.randomId();
      const candidate = `${randomPart}${suffix}`;
      if (
        typeof randomPart === "string" &&
        randomPart.length > 0 &&
        candidate.length <= OPAQUE_ID_MAX_LENGTH &&
        OPAQUE_ID.test(candidate) &&
        !this.operations.has(candidate)
      ) {
        this.idNonce = nextNonce;
        return candidate;
      }
    }
    throw new Error("Unable to allocate unique opaque library album ID");
  }

  private openRejected(
    code: "INVALID_REQUEST" | "BACKPRESSURE" | "REQUEST_ID_CONFLICT",
    error: string
  ): LibraryAlbumOpenReservation {
    return Object.freeze({ ack: Object.freeze({ success: false, code, error }) });
  }

  private selectRejected(
    code: "INVALID_REQUEST" | "BACKPRESSURE" | "SESSION_LOST",
    error: string
  ): LibraryAlbumSelectReservation {
    return Object.freeze({ ack: Object.freeze({ success: false, code, error }) });
  }

  private invalidCancelAck(): LibraryAlbumCancelAck {
    return {
      success: false,
      code: "INVALID_REQUEST",
      error: "Invalid library album cancel request",
    };
  }

  private validOrigin(origin: LibraryAlbumOrigin): boolean {
    return (
      Boolean(origin) &&
      typeof origin.coreId === "string" &&
      origin.coreId.length > 0 &&
      typeof origin.socketId === "string" &&
      origin.socketId.length > 0
    );
  }

  private validOpaqueId(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= OPAQUE_ID_MAX_LENGTH &&
      OPAQUE_ID.test(value)
    );
  }

  private validSink(sink: LibraryAlbumEventSink): boolean {
    return (
      Boolean(sink) &&
      typeof sink.versions === "function" &&
      typeof sink.resolved === "function" &&
      typeof sink.versionFailed === "function" &&
      typeof sink.failed === "function"
    );
  }

  private logCoordinatorFailure(
    action: string,
    operation: LibraryAlbumOperation,
    error: unknown
  ): void {
    if (
      error instanceof BrowseSessionCoordinatorError &&
      (error.code === "INVALID_HANDLE" ||
        error.code === "STALE_GENERATION" ||
        error.code === "SESSION_LOST")
    ) {
      this.logger.debug(
        { err: error, operationId: operation.operationId },
        `Library album ${action} already settled`
      );
      return;
    }
    this.logger.error(
      { err: error, operationId: operation.operationId },
      `Library album ${action} failed`
    );
  }

  private validateOptions(): void {
    if (
      !Number.isSafeInteger(this.resolvingTtlMs) ||
      this.resolvingTtlMs <= 0 ||
      this.resolvingTtlMs > MAX_TTL_MS
    ) {
      throw new Error("resolvingTtlMs must be a positive bounded integer");
    }
    if (
      !Number.isSafeInteger(this.requestTombstoneLimit) ||
      this.requestTombstoneLimit <= 0 ||
      this.requestTombstoneLimit > MAX_TOMBSTONES
    ) {
      throw new Error("requestTombstoneLimit must be a positive bounded integer");
    }
  }
}
