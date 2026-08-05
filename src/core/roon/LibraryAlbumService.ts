import { randomUUID } from "crypto";
import { Logger } from "pino";

import {
  createCatalogTrackTitleFingerprint,
  ResolvedSelectedArtistObservation,
} from "../catalog/CatalogReconciliation";
import { CatalogSnapshot } from "../catalog/CatalogService";
import {
  LIBRARY_ALBUM_MAX_CANDIDATES,
  LIBRARY_ALBUM_MAX_TRACKS,
  LIBRARY_ALBUM_TEXT_MAX_LENGTH,
  LibraryAlbumCancelAck,
  LibraryAlbumCandidate,
  LibraryAlbumFailedEvent,
  LibraryAlbumFailureCode,
  LibraryAlbumOpenAck,
  LibraryAlbumOpenRequest,
  LibraryAlbumResolvedEvent,
  normalizeLibraryAlbumCancelRequest,
  normalizeLibraryAlbumOpenRequest,
} from "../../shared/libraryAlbumContracts";
import {
  AlbumRef,
  ArtistRef,
  normalizeCatalogText,
} from "../../shared/timelineCatalogContracts";
import {
  ActionSessionAccess,
  ActionSessionHandle,
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
} from "./BrowseSessionCoordinator";
import { RoonTimeoutError } from "./errors";
import {
  TimelineAlbumDetailResolver,
  TimelineAlbumDetailResolverError,
  TimelineAlbumEditionCandidate,
  TimelineAlbumEditionDescriptor,
} from "./TimelineAlbumDetailResolver";
import {
  TimelineDiscographyResolver,
  TimelineDiscographyResolverError,
  TimelineObservedDiscography,
} from "./TimelineDiscographyResolver";

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
  resolved(event: LibraryAlbumResolvedEvent): void;
  failed(event: LibraryAlbumFailedEvent): void;
}

export interface LibraryAlbumOpenReservation {
  readonly ack: LibraryAlbumOpenAck;
  /** One-shot continuation. The socket adapter acknowledges before invoking it. */
  readonly start?: () => void;
}

export interface LibraryAlbumCatalogPort {
  getSnapshot(coreId: string): CatalogSnapshot | null;
  reconcileSelectedArtist(
    coreId: string,
    selectedArtistLocalId: string,
    observation: ResolvedSelectedArtistObservation
  ): Promise<{
    readonly artist: Readonly<ArtistRef>;
    readonly albums: readonly Readonly<AlbumRef>[];
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
  releaseAction(access: ActionSessionAccess): Promise<void>;
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
  ): Promise<TimelineObservedDiscography>;
  observeCandidates(
    discography: TimelineObservedDiscography,
    album: Readonly<AlbumRef>
  ): readonly TimelineAlbumEditionCandidate[];
  resolve(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    album: Readonly<AlbumRef>,
    discography: TimelineObservedDiscography
  ): Promise<LibraryAlbumResolution>;
  resolveCandidate(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    album: Readonly<AlbumRef>,
    discography: TimelineObservedDiscography,
    descriptor: TimelineAlbumEditionDescriptor
  ): Promise<LibraryAlbumResolution>;
}

/** Default resolver: the mode-neutral Timeline discography/detail machinery. */
export class LibraryAlbumResolver implements LibraryAlbumResolverPort {
  public constructor(
    private readonly discographyResolver = new TimelineDiscographyResolver(),
    private readonly detailResolver = new TimelineAlbumDetailResolver()
  ) {}

  public async observe(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>
  ): Promise<TimelineObservedDiscography> {
    const resolution = await this.discographyResolver.resolve(session, artist);
    if (resolution.kind !== "resolved") {
      throw new TimelineAlbumDetailResolverError(
        resolution.kind === "missing" ? "ALBUM_NOT_FOUND" : "ALBUM_AMBIGUOUS",
        resolution.kind === "missing"
          ? "The album artist could not be re-observed live"
          : "The album artist did not resolve uniquely"
      );
    }
    return this.discographyResolver.observeCurrent(session, artist);
  }

  public observeCandidates(
    discography: TimelineObservedDiscography,
    album: Readonly<AlbumRef>
  ): readonly TimelineAlbumEditionCandidate[] {
    return this.detailResolver.observeCandidates(discography, album);
  }

  public async resolve(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    album: Readonly<AlbumRef>,
    discography: TimelineObservedDiscography
  ): Promise<LibraryAlbumResolution> {
    const resolution = await this.detailResolver.resolve(
      session,
      artist,
      album,
      discography
    );
    return resolution;
  }

  public async resolveCandidate(
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    album: Readonly<AlbumRef>,
    discography: TimelineObservedDiscography,
    descriptor: TimelineAlbumEditionDescriptor
  ): Promise<LibraryAlbumResolution> {
    const resolution = await this.detailResolver.resolveCandidate(
      session,
      artist,
      album,
      discography,
      descriptor
    );
    return resolution;
  }
}

export interface LibraryAlbumServiceOptions {
  resolvingTtlMs?: number;
  requestTombstoneLimit?: number;
  now?: () => number;
  randomId?: () => string;
  fallbackResolver?: LibraryAlbumFallbackResolverPort;
}

type OperationPhase = "resolving" | "terminal" | "quarantined";

type LibraryAlbumReadAuthority =
  | {
      readonly kind: "public";
      readonly album: Readonly<AlbumRef>;
      readonly artist: Readonly<ArtistRef>;
    }
  | {
      readonly kind: "extended";
      readonly album: Readonly<AlbumRef>;
    };

interface LibraryAlbumOperation {
  readonly origin: LibraryAlbumOrigin;
  readonly request: LibraryAlbumOpenRequest;
  readonly operationId: string;
  readonly resolvingDeadlineAt: number;
  readonly access: ActionSessionAccess;
  readonly sink: LibraryAlbumEventSink;
  phase: OperationPhase;
  timer?: Timer;
  started: boolean;
  resolutionInFlight: boolean;
  closed: boolean;
  albumSignature?: string;
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

class LibraryAlbumAmbiguityError extends Error {
  public constructor(
    public readonly candidates: readonly LibraryAlbumCandidate[],
    message: string
  ) {
    super(message);
    this.name = "LibraryAlbumAmbiguityError";
    Object.setPrototypeOf(this, LibraryAlbumAmbiguityError.prototype);
  }
}

/**
 * Owns the server-side single-phase library-album read machine on zone-less
 * coordinator read leases. Operations are tab-scoped and generation-fenced;
 * a newer open supersedes the tab's previous read. Raw Roon keys never leave
 * the coordinated session; clients receive keyless ordered track titles.
 */
export class LibraryAlbumService {
  private readonly resolvingTtlMs: number;
  private readonly requestTombstoneLimit: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly fallbackResolver?: LibraryAlbumFallbackResolverPort;
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
    this.resolvingTtlMs = options.resolvingTtlMs ?? DEFAULT_RESOLVING_TTL_MS;
    this.requestTombstoneLimit =
      options.requestTombstoneLimit ?? DEFAULT_REQUEST_TOMBSTONE_LIMIT;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => randomUUID());
    this.fallbackResolver = options.fallbackResolver;
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
        "Library album identifiers are temporarily unavailable"
      );
    }

    // The tab owns at most one read: retire the previous operation before its
    // replacement takes the lease, so late events can never interleave.
    const tabKey = this.tabKey(origin.socketId, request.tabId);
    const existing = this.tabs.get(tabKey);
    if (existing && !existing.closed) {
      this.close(existing, existing.resolutionInFlight);
      this.emitFailure(
        existing,
        "SUPERSEDED",
        "A newer album open superseded this operation"
      );
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
      return error instanceof BrowseSessionCoordinatorError &&
        error.code === "BACKPRESSURE"
        ? this.openRejected("BACKPRESSURE", "Library album capacity is full")
        : this.openRejected(
            "INVALID_REQUEST",
            "The library session cannot own this album read"
          );
    }

    const resolvingDeadlineAt = this.now() + this.resolvingTtlMs;
    const operation: LibraryAlbumOperation = {
      origin: Object.freeze({ ...origin }),
      request,
      operationId,
      resolvingDeadlineAt,
      access: Object.freeze({
        coreId: origin.coreId,
        socketId: origin.socketId,
        tabId: request.tabId,
        handle,
      }),
      sink,
      phase: "resolving",
      started: false,
      resolutionInFlight: false,
      closed: false,
    };
    this.operations.set(operationId, operation);
    this.requests.set(requestKey, operation);
    this.tabs.set(tabKey, operation);
    this.armResolvingTimer(operation);

    let started = false;
    return Object.freeze({
      ack: Object.freeze({
        success: true as const,
        data: Object.freeze({
          requestId: request.requestId,
          operationId,
          resolvingDeadlineAt,
        }),
      }),
      start: (): void => {
        if (started) return;
        started = true;
        this.startResolution(operation);
      },
    });
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
    this.emitFailure(operation, "CANCELED", "The album read was canceled");
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
      if (!operation.closed) {
        this.close(operation, operation.resolutionInFlight);
      }
    }
  }

  private startResolution(operation: LibraryAlbumOperation): void {
    if (operation.closed || operation.started || operation.phase !== "resolving") {
      return;
    }
    if (this.now() >= operation.resolvingDeadlineAt) {
      this.expireResolving(operation);
      return;
    }
    operation.started = true;
    void this.resolveOperation(operation);
  }

  private async resolveOperation(operation: LibraryAlbumOperation): Promise<void> {
    try {
      const bound = this.currentAlbum(
        operation.origin.coreId,
        operation.request.albumLocalId
      );
      if (!bound) {
        throw new LibraryAlbumPhaseError(
          "ALBUM_NOT_FOUND",
          "The album is not currently resolved in the catalog"
        );
      }
      operation.albumSignature = this.readAuthoritySignature(bound);
      this.assertReadAuthority(operation);
      if (bound.kind === "extended") {
        await this.resolveWithFallback(operation, bound.album);
        return;
      }
      operation.resolutionInFlight = true;
      const resolution = await this.coordinator.runAction(
        operation.access,
        (session) =>
          this.resolveWithSession(
            operation,
            this.guardedResolutionSession(operation, session),
            bound.artist,
            bound.album
          )
      );
      operation.resolutionInFlight = false;
      if (operation.closed || operation.phase !== "resolving") return;
      if (this.now() > operation.resolvingDeadlineAt) {
        this.expireResolving(operation);
        return;
      }
      this.assertReadAuthority(operation);
      const event = this.buildResolvedEvent(
        operation,
        bound.album,
        resolution.orderedTrackTitles,
        true
      );
      const reconciled = await this.catalog.reconcileSelectedArtist(
        operation.origin.coreId,
        bound.artist.localId,
        resolution.observation
      );
      if (operation.closed || operation.phase !== "resolving") return;
      if (this.now() > operation.resolvingDeadlineAt) {
        this.expireResolving(operation);
        return;
      }
      const published = this.publishedResolutionAuthority(
        bound,
        reconciled,
        resolution.orderedTrackTitles
      );
      operation.albumSignature = this.readAuthoritySignature(published);
      this.assertReadAuthority(operation);
      this.close(operation, false);
      this.emitResolved(operation, event);
    } catch (error) {
      operation.resolutionInFlight = false;
      if (operation.closed || operation.phase !== "resolving") return;
      if (error instanceof RoonTimeoutError) {
        this.close(operation, true);
        this.emitFailure(
          operation,
          "RESOLUTION_TIMEOUT",
          "Library album resolution timed out"
        );
        return;
      }
      if (
        error instanceof BrowseSessionCoordinatorError &&
        error.code === "SESSION_LOST"
      ) {
        this.close(operation, true);
        this.emitFailure(operation, "SESSION_LOST", "The album read session was lost");
        return;
      }
      if (error instanceof LibraryAlbumAmbiguityError) {
        this.close(operation, false);
        this.emitFailure(
          operation,
          "ALBUM_AMBIGUOUS",
          error.message,
          error.candidates
        );
        return;
      }
      const failure = this.resolutionFailure(error);
      this.close(operation, false);
      this.emitFailure(operation, failure.code, failure.message);
    }
  }

  private async resolveWithFallback(
    operation: LibraryAlbumOperation,
    album: Readonly<AlbumRef>
  ): Promise<void> {
    const fallbackResolver = this.fallbackResolver;
    if (!fallbackResolver) {
      throw new LibraryAlbumPhaseError(
        "ALBUM_NOT_FOUND",
        "The album is not currently resolved in the catalog"
      );
    }
    const candidate = operation.request.candidate;
    if (candidate && !this.candidateMatchesAlbum(candidate, album)) {
      throw new LibraryAlbumPhaseError(
        "DETAIL_MISMATCH",
        "The selected album no longer matches the search result"
      );
    }

    let resolution: LibraryAlbumFallbackResolution;
    try {
      resolution = await fallbackResolver.resolve(operation.origin.coreId, album);
    } catch (error) {
      // Catalog drift takes precedence over an adapter-level read failure.
      this.assertReadAuthority(operation);
      if (error instanceof LibraryAlbumFallbackError) {
        throw new LibraryAlbumPhaseError(error.code, error.message);
      }
      throw new LibraryAlbumPhaseError(
        "DETAIL_INCOMPLETE",
        "The album's full track list could not be read"
      );
    }
    if (operation.closed || operation.phase !== "resolving") return;
    if (this.now() > operation.resolvingDeadlineAt) {
      this.expireResolving(operation);
      return;
    }
    this.assertReadAuthority(operation);
    const event = this.buildResolvedEvent(
      operation,
      album,
      resolution.orderedTrackTitles,
      false
    );
    this.close(operation, false);
    this.emitResolved(operation, event);
  }

  private async resolveWithSession(
    operation: LibraryAlbumOperation,
    session: CoordinatedBrowseSession,
    artist: Readonly<ArtistRef>,
    album: Readonly<AlbumRef>
  ): Promise<LibraryAlbumResolution> {
    const discography = await this.resolver.observe(session, artist);
    const candidate = operation.request.candidate;
    if (candidate) {
      return this.resolver.resolveCandidate(
        session,
        artist,
        album,
        discography,
        candidate
      );
    }
    try {
      return await this.resolver.resolve(session, artist, album, discography);
    } catch (error) {
      if (
        error instanceof TimelineAlbumDetailResolverError &&
        error.code === "ALBUM_AMBIGUOUS"
      ) {
        const candidates = this.chooserCandidates(
          this.resolver.observeCandidates(discography, album)
        );
        if (candidates) {
          throw new LibraryAlbumAmbiguityError(
            candidates,
            "The album has more than one distinguishable live edition"
          );
        }
      }
      throw error;
    }
  }

  /**
   * Only editions a retry can re-bind uniquely are offered: triples that occur
   * exactly once, each with bounded display fields, within the chooser cap.
   */
  private chooserCandidates(
    observed: readonly TimelineAlbumEditionCandidate[]
  ): LibraryAlbumCandidate[] | null {
    const counts = new Map<string, number>();
    for (const candidate of observed) {
      const identity = this.candidateIdentity(candidate);
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    const unique: LibraryAlbumCandidate[] = [];
    const offered = new Set<string>();
    for (const candidate of observed) {
      const identity = this.candidateIdentity(candidate);
      if (counts.get(identity) !== 1 || offered.has(identity)) continue;
      if (
        !this.validDisplayText(candidate.title) ||
        !this.validDisplayText(candidate.artist) ||
        !this.validOptionalDisplayText(candidate.editionText)
      ) {
        continue;
      }
      offered.add(identity);
      unique.push(
        Object.freeze({
          title: candidate.title,
          artist: candidate.artist,
          editionText: candidate.editionText,
        })
      );
    }
    return unique.length >= 1 && unique.length <= LIBRARY_ALBUM_MAX_CANDIDATES
      ? unique
      : null;
  }

  private candidateIdentity(candidate: TimelineAlbumEditionCandidate): string {
    return JSON.stringify([
      normalizeCatalogText(candidate.title),
      normalizeCatalogText(candidate.artist),
      normalizeCatalogText(candidate.editionText),
    ]);
  }

  private candidateMatchesAlbum(
    candidate: LibraryAlbumCandidate,
    album: Readonly<AlbumRef>
  ): boolean {
    return (
      normalizeCatalogText(candidate.title) === album.normalizedTitle &&
      normalizeCatalogText(candidate.artist) === album.normalizedArtist &&
      normalizeCatalogText(candidate.editionText) ===
        normalizeCatalogText(album.editionText)
    );
  }

  private buildResolvedEvent(
    operation: LibraryAlbumOperation,
    album: Readonly<AlbumRef>,
    orderedTrackTitles: readonly string[],
    actionsAvailable: boolean
  ): LibraryAlbumResolvedEvent {
    if (
      orderedTrackTitles.length === 0 ||
      orderedTrackTitles.length > LIBRARY_ALBUM_MAX_TRACKS ||
      orderedTrackTitles.some((title) => !this.validDisplayText(title)) ||
      !this.validDisplayText(album.exactArtist) ||
      !this.validDisplayText(album.exactTitle)
    ) {
      throw new LibraryAlbumPhaseError(
        "DETAIL_INCOMPLETE",
        "The album detail exceeded its keyless display bounds"
      );
    }
    return Object.freeze({
      requestId: operation.request.requestId,
      operationId: operation.operationId,
      generation: operation.request.generation,
      artist: album.exactArtist,
      title: album.exactTitle,
      actionsAvailable,
      orderedTracks: Object.freeze(
        orderedTrackTitles.map((title, index) => Object.freeze({ index, title }))
      ),
    });
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

  private currentAlbum(
    coreId: string,
    localId: string
  ): LibraryAlbumReadAuthority | null {
    const snapshot = this.catalog.getSnapshot(coreId);
    if (!snapshot || snapshot.coreId !== coreId) return null;
    const albums = snapshot.albums.filter(
      (album) => album.localId === localId && album.coreId === coreId
    );
    if (albums.length !== 1) return null;
    const album = albums[0];
    if (album.resolutionStatus === "resolved" && album.artistLocalId) {
      const artists = snapshot.artists.filter(
        (artist) =>
          artist.localId === album.artistLocalId && artist.coreId === coreId
      );
      if (artists.length === 1 && artists[0].resolutionStatus === "resolved") {
        return { kind: "public", album, artist: artists[0] };
      }
    }
    return album.resolutionStatus === "unresolved" &&
      typeof album.extendedAlbumId === "string" &&
      album.extendedAlbumId.length > 0 &&
      this.fallbackResolver
      ? { kind: "extended", album }
      : null;
  }

  private guardedResolutionSession(
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
        "The album identity changed during the read"
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

  private publishedResolutionAuthority(
    prior: Extract<LibraryAlbumReadAuthority, { kind: "public" }>,
    reconciled: {
      artist: Readonly<ArtistRef>;
      albums: readonly Readonly<AlbumRef>[];
    },
    orderedTrackTitles: readonly string[]
  ): Extract<LibraryAlbumReadAuthority, { kind: "public" }> {
    const expectedFingerprint =
      createCatalogTrackTitleFingerprint(orderedTrackTitles);
    const publishedAlbums = reconciled.albums.filter(
      (album) =>
        album.localId === prior.album.localId &&
        album.artistLocalId === reconciled.artist.localId
    );
    if (
      reconciled.artist.localId !== prior.artist.localId ||
      reconciled.artist.resolutionStatus !== "resolved" ||
      publishedAlbums.length !== 1 ||
      publishedAlbums[0].resolutionStatus !== "resolved" ||
      publishedAlbums[0].trackTitleFingerprint !== expectedFingerprint
    ) {
      throw new LibraryAlbumPhaseError(
        "ALBUM_AMBIGUOUS",
        "Album detail did not preserve one resolved catalog identity"
      );
    }
    const published = {
      kind: "public" as const,
      album: publishedAlbums[0],
      artist: reconciled.artist,
    };
    const expected = {
      kind: "public" as const,
      album: {
        ...prior.album,
        trackTitleFingerprint: expectedFingerprint,
      },
      artist: prior.artist,
    };
    if (
      this.readAuthoritySignature(published) !==
      this.readAuthoritySignature(expected)
    ) {
      throw new LibraryAlbumPhaseError(
        "ALBUM_AMBIGUOUS",
        "Album detail changed the resolved catalog identity"
      );
    }
    return published;
  }

  private resolutionFailure(error: unknown): {
    code: LibraryAlbumFailureCode;
    message: string;
  } {
    if (error instanceof LibraryAlbumPhaseError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof TimelineAlbumDetailResolverError) {
      return {
        code: error.code,
        message: {
          ALBUM_NOT_FOUND: "The album could not be re-observed live",
          ALBUM_AMBIGUOUS: "The album edition is ambiguous",
          DETAIL_INCOMPLETE: "Roon returned an incomplete album detail",
          DETAIL_MISMATCH: "The live album no longer matches its catalog identity",
        }[error.code],
      };
    }
    if (error instanceof TimelineDiscographyResolverError) {
      return {
        code:
          error.code === "DISCOGRAPHY_PATH_NOT_UNIQUE"
            ? "ALBUM_AMBIGUOUS"
            : "DETAIL_INCOMPLETE",
        message: "The album's artist could not be re-observed exactly",
      };
    }
    return { code: "INTERNAL_ERROR", message: "Library album resolution failed" };
  }

  private close(operation: LibraryAlbumOperation, quarantine: boolean): void {
    if (operation.closed) return;
    operation.closed = true;
    operation.phase = quarantine ? "quarantined" : "terminal";
    this.clearOperationTimer(operation);
    if (this.operations.get(operation.operationId) === operation) {
      this.operations.delete(operation.operationId);
    }
    const requestKey = this.requestKey(
      operation.origin.socketId,
      operation.request.requestId
    );
    if (this.requests.get(requestKey) === operation) {
      this.requests.delete(requestKey);
    }
    const tabKey = this.tabKey(operation.origin.socketId, operation.request.tabId);
    if (this.tabs.get(tabKey) === operation) {
      this.tabs.delete(tabKey);
    }
    this.addRequestTombstone(requestKey);
    if (quarantine) {
      try {
        this.coordinator.quarantineAction(operation.access);
      } catch (error) {
        this.logCoordinatorFailure("quarantine album read", operation, error);
      }
    } else {
      try {
        void Promise.resolve(
          this.coordinator.releaseAction(operation.access)
        ).catch((error: unknown) => {
          this.logCoordinatorFailure("release album read", operation, error);
        });
      } catch (error) {
        this.logCoordinatorFailure("release album read", operation, error);
      }
    }
  }

  private expireResolving(operation: LibraryAlbumOperation): void {
    if (operation.closed || operation.phase !== "resolving") return;
    if (this.now() < operation.resolvingDeadlineAt) {
      this.armResolvingTimer(operation);
      return;
    }
    this.close(operation, operation.resolutionInFlight);
    this.emitFailure(
      operation,
      "RESOLUTION_TIMEOUT",
      "Library album resolution timed out"
    );
  }

  private armResolvingTimer(operation: LibraryAlbumOperation): void {
    this.clearOperationTimer(operation);
    const remaining = Math.max(0, operation.resolvingDeadlineAt - this.now());
    operation.timer = this.unrefTimer(
      setTimeout(() => this.expireResolving(operation), remaining)
    );
  }

  private clearOperationTimer(operation: LibraryAlbumOperation): void {
    if (operation.timer !== undefined) clearTimeout(operation.timer);
    operation.timer = undefined;
  }

  private unrefTimer(timer: Timer): Timer {
    if (typeof timer === "object" && "unref" in timer) timer.unref();
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
        "Library album resolved sink failed"
      );
    }
  }

  private emitFailure(
    operation: LibraryAlbumOperation,
    code: LibraryAlbumFailureCode,
    message: string,
    candidates?: readonly LibraryAlbumCandidate[]
  ): void {
    const base = {
      requestId: operation.request.requestId,
      operationId: operation.operationId,
      generation: operation.request.generation,
      resolvingDeadlineAt: operation.resolvingDeadlineAt,
      error: message,
      code,
    };
    const event: LibraryAlbumFailedEvent = Object.freeze(
      candidates && code === "ALBUM_AMBIGUOUS"
        ? { ...base, candidates: Object.freeze([...candidates]) }
        : base
    );
    try {
      operation.sink.failed(event);
    } catch (error) {
      this.logger.warn(
        { err: error, operationId: operation.operationId },
        "Library album failed sink failed"
      );
    }
  }

  private requestKey(socketId: string, requestId: string): string {
    return `${socketId}\\u0000${requestId}`;
  }

  private tabKey(socketId: string, tabId: string): string {
    return `${socketId}\\u0000${tabId}`;
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
      throw new Error("Library album identifier space is exhausted");
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
    throw new Error("Unable to allocate a unique opaque library album ID");
  }

  private openRejected(
    code: "INVALID_REQUEST" | "BACKPRESSURE" | "REQUEST_ID_CONFLICT",
    error: string
  ): LibraryAlbumOpenReservation {
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

  private validSink(sink: LibraryAlbumEventSink): boolean {
    return (
      Boolean(sink) &&
      typeof sink.resolved === "function" &&
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
        `${action} reached an already-settled lease`
      );
      return;
    }
    this.logger.error(
      { err: error, operationId: operation.operationId },
      `${action} failed unexpectedly after client authority was retired`
    );
  }

  private validateOptions(): void {
    if (
      !Number.isSafeInteger(this.resolvingTtlMs) ||
      this.resolvingTtlMs <= 0 ||
      this.resolvingTtlMs > MAX_TTL_MS
    ) {
      throw new Error("resolvingTtlMs must be a positive bounded safe integer");
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
