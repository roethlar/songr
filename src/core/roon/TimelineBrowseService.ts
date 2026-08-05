import {
  CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
  AlbumRef,
  CatalogArtistAlbumsResponse,
  CatalogStatus,
  normalizeCatalogArtistAlbumsResponse,
} from "../../shared/timelineCatalogContracts";
import {
  TimelineAlbumDetailBeginAck,
  TimelineAlbumDetailCloseAck,
  TimelineAlbumDetailCloseCorrelation,
  TimelineAlbumDetailCloseErrorCode,
  TimelineAlbumDetailCloseFailedEvent,
  TimelineAlbumDetailCloseRequest,
  TimelineAlbumDetailClosedEvent,
  TimelineAlbumDetailCorrelation,
  TimelineAlbumDetailErrorCode,
  TimelineAlbumDetailFailedEvent,
  TimelineAlbumDetailLoadedEvent,
  TimelineAlbumDetailRequest,
  TimelineAlbumDetailSnapshot,
  TimelineArtistLoadBeginAck,
  TimelineArtistLoadCorrelation,
  TimelineArtistLoadErrorCode,
  TimelineArtistLoadFailedEvent,
  TimelineArtistLoadedEvent,
  TimelineArtistLoadRequest,
  TimelineBrowseSessionRef,
  TimelineSessionReconnectAck,
  TimelineSessionReconnectRequest,
  TimelineSessionReleaseAck,
  TimelineSessionReleaseRequest,
} from "../../shared/timelineBrowseContracts";
import {
  CatalogSelectedArtistResult,
  CatalogServiceError,
} from "../catalog/CatalogService";
import {
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
  DEFAULT_BROWSE_SESSION_LIMITS,
  ModeSessionAccess,
  ModeSessionHandle,
} from "./BrowseSessionCoordinator";
import {
  TimelineAlbumDetailResolution,
  TimelineAlbumDetailResolver,
  TimelineAlbumDetailResolverError,
} from "./TimelineAlbumDetailResolver";
import {
  TimelineDiscographyResolution,
  TimelineDiscographyResolver,
  TimelineDiscographyResolverError,
  TimelineObservedDiscography,
} from "./TimelineDiscographyResolver";
import { CoreUnpairedError, RoonTimeoutError } from "./errors";

export interface TimelineArtistLoadOrigin {
  readonly coreId: string;
  readonly socketId: string;
}

export interface TimelineArtistLoadSink {
  loaded(event: TimelineArtistLoadedEvent): void;
  failed(event: TimelineArtistLoadFailedEvent): void;
}

export interface TimelineAlbumDetailSink {
  loaded(event: TimelineAlbumDetailLoadedEvent): void;
  failed(event: TimelineAlbumDetailFailedEvent): void;
}

export interface TimelineAlbumDetailCloseSink {
  closed(event: TimelineAlbumDetailClosedEvent): void;
  failed(event: TimelineAlbumDetailCloseFailedEvent): void;
}

export interface TimelineBrowseCatalog {
  getArtistAlbums(
    coreId: string,
    artistLocalId: unknown,
    limitValue?: unknown
  ): Promise<CatalogArtistAlbumsResponse | null>;
  getStatus(coreId: string): CatalogStatus;
  reconcileSelectedArtist(
    coreId: string,
    selectedArtistLocalId: unknown,
    observation: unknown
  ): Promise<CatalogSelectedArtistResult>;
}

export interface TimelineBrowseCoordinator {
  acquireMode(input: {
    coreId: string;
    socketId: string;
    tabId: string;
    mode: "timeline";
    replaceDisconnected?: boolean;
  }): ModeSessionHandle;
  reconnectMode(input: {
    coreId: string;
    tabId: string;
    socketId: string;
    handle: ModeSessionHandle;
  }): ModeSessionHandle;
  runMode<T>(
    access: ModeSessionAccess,
    role: "timeline-interactive",
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T>;
  releaseMode(access: ModeSessionAccess): Promise<void>;
}

export interface TimelineDiscographyResolverLike {
  resolve(
    session: CoordinatedBrowseSession,
    artist: CatalogArtistAlbumsResponse["artist"]
  ): Promise<TimelineDiscographyResolution>;
  observeCurrent(
    session: CoordinatedBrowseSession,
    artist: CatalogArtistAlbumsResponse["artist"],
    first?: Awaited<ReturnType<CoordinatedBrowseSession["pop"]>>
  ): Promise<TimelineObservedDiscography>;
}

export interface TimelineAlbumDetailResolverLike {
  resolve(
    session: CoordinatedBrowseSession,
    artist: CatalogArtistAlbumsResponse["artist"],
    album: AlbumRef,
    discography: TimelineObservedDiscography
  ): Promise<TimelineAlbumDetailResolution>;
}

export interface TimelineBrowseServiceOptions {
  readonly now?: () => number;
  readonly loadTimeoutMs?: number;
  readonly retiredRequestLimit?: number;
  readonly runtimeIdleMs?: number;
  readonly disconnectGraceMs?: number;
  readonly resolver?: TimelineDiscographyResolverLike;
  readonly detailResolver?: TimelineAlbumDetailResolverLike;
  readonly getCurrentCoreId?: () => string | null;
}

export interface TimelineArtistLoadReservation {
  readonly ack: TimelineArtistLoadBeginAck;
  start?: () => Promise<void>;
  abandon?: () => Promise<void>;
}

export interface TimelineAlbumDetailReservation {
  readonly ack: TimelineAlbumDetailBeginAck;
  start?: () => Promise<void>;
  abandon?: () => Promise<void>;
}

export interface TimelineAlbumDetailCloseReservation {
  readonly ack: TimelineAlbumDetailCloseAck;
  start?: () => Promise<void>;
  abandon?: () => Promise<void>;
}

type TimelineBrowseErrorCode =
  | TimelineAlbumDetailErrorCode
  | "DISCOGRAPHY_UNAVAILABLE";

export class TimelineBrowseServiceError extends Error {
  public constructor(
    public readonly code: TimelineBrowseErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TimelineBrowseServiceError";
    Object.setPrototypeOf(this, TimelineBrowseServiceError.prototype);
    Error.captureStackTrace?.(this, TimelineBrowseServiceError);
  }
}

interface OperationBase {
  readonly kind: "artist" | "detail" | "close";
  readonly key: string;
  readonly requestKey: string;
  readonly origin: TimelineArtistLoadOrigin;
  readonly tabId: string;
  readonly handle: ModeSessionHandle;
  readonly access: ModeSessionAccess;
  started: boolean;
  terminal: boolean;
  supersededPrior: boolean;
  timer?: ReturnType<typeof setTimeout>;
  settled?: Promise<void>;
}

interface ArtistLoadOperation extends OperationBase {
  readonly kind: "artist";
  readonly request: TimelineArtistLoadRequest;
  readonly correlation: TimelineArtistLoadCorrelation;
  readonly sink: TimelineArtistLoadSink;
}

interface DetailLoadOperation extends OperationBase {
  readonly kind: "detail";
  readonly request: TimelineAlbumDetailRequest;
  readonly correlation: TimelineAlbumDetailCorrelation;
  readonly sink: TimelineAlbumDetailSink;
  readonly baseArtistLocalId: string;
  readonly reuseCurrentParent: boolean;
}

interface DetailCloseOperation extends OperationBase {
  readonly kind: "close";
  readonly request: TimelineAlbumDetailCloseRequest;
  readonly correlation: TimelineAlbumDetailCloseCorrelation;
  readonly sink: TimelineAlbumDetailCloseSink;
  readonly popCoherentParent: boolean;
}

type TimelineOperation =
  | ArtistLoadOperation
  | DetailLoadOperation
  | DetailCloseOperation;

type TimelineRuntimeLevel =
  | {
      readonly kind: "artist";
      readonly artistLocalId: string;
    }
  | {
      readonly kind: "detail";
      readonly baseArtistLocalId: string;
      readonly detailArtistLocalId: string;
      readonly albumLocalId: string;
      readonly detail: TimelineAlbumDetailSnapshot;
    }
  | {
      readonly kind: "unknown";
    };

interface TimelineRuntime {
  readonly key: string;
  readonly coreId: string;
  readonly tabId: string;
  readonly handle: ModeSessionHandle;
  readonly baseArtistLocalId: string;
  socketId: string;
  access: ModeSessionAccess;
  level: TimelineRuntimeLevel;
  disconnected: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_LOAD_TIMEOUT_MS = 30_000;
const DEFAULT_RETIRED_REQUEST_LIMIT = 256;

/** Owns selected-artist/detail operations above the Browse coordinator. */
export class TimelineBrowseService {
  private readonly now: () => number;
  private readonly loadTimeoutMs: number;
  private readonly retiredRequestLimit: number;
  private readonly runtimeIdleMs: number;
  private readonly disconnectGraceMs: number;
  private readonly resolver: TimelineDiscographyResolverLike;
  private readonly detailResolver: TimelineAlbumDetailResolverLike;
  private readonly getCurrentCoreId: () => string | null;
  private readonly currentByTab = new Map<string, TimelineOperation>();
  private readonly runtimes = new Map<string, TimelineRuntime>();
  private readonly activeRequestIds = new Map<string, TimelineOperation>();
  private readonly retiredRequestIds = new Set<string>();
  private stopped = false;

  public constructor(
    private readonly coordinator: TimelineBrowseCoordinator,
    private readonly catalog: TimelineBrowseCatalog,
    options: TimelineBrowseServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    this.retiredRequestLimit =
      options.retiredRequestLimit ?? DEFAULT_RETIRED_REQUEST_LIMIT;
    this.runtimeIdleMs =
      options.runtimeIdleMs ?? DEFAULT_BROWSE_SESSION_LIMITS.modeIdleMs;
    this.disconnectGraceMs =
      options.disconnectGraceMs ?? DEFAULT_BROWSE_SESSION_LIMITS.disconnectGraceMs;
    this.resolver = options.resolver ?? new TimelineDiscographyResolver();
    this.detailResolver =
      options.detailResolver ?? new TimelineAlbumDetailResolver(this.resolver);
    this.getCurrentCoreId = options.getCurrentCoreId ?? (() => null);
    if (
      !Number.isSafeInteger(this.loadTimeoutMs) ||
      this.loadTimeoutMs <= 0 ||
      !Number.isSafeInteger(this.retiredRequestLimit) ||
      this.retiredRequestLimit <= 0 ||
      !Number.isSafeInteger(this.runtimeIdleMs) ||
      this.runtimeIdleMs <= 0 ||
      !Number.isSafeInteger(this.disconnectGraceMs) ||
      this.disconnectGraceMs <= 0
    ) {
      throw new Error("Timeline browse service limits must be positive integers");
    }
  }

  public begin(
    origin: TimelineArtistLoadOrigin,
    request: TimelineArtistLoadRequest,
    sink: TimelineArtistLoadSink
  ): TimelineArtistLoadReservation {
    if (this.stopped) {
      return { ack: this.artistFailureAck("SESSION_LOST", "Timeline browsing is stopped") };
    }
    const conflict = this.requestConflict(origin.socketId, request.requestId);
    if (conflict) {
      return {
        ack: this.artistFailureAck(
          "REQUEST_ID_CONFLICT",
          "Timeline artist request ID was already used"
        ),
      };
    }

    let handle: ModeSessionHandle;
    try {
      handle = this.coordinator.acquireMode({
        coreId: origin.coreId,
        socketId: origin.socketId,
        tabId: request.tabId,
        mode: "timeline",
        replaceDisconnected: true,
      });
    } catch (error) {
      const mapped = this.mapError(error, "artist");
      return { ack: this.artistFailureAck(mapped.code as TimelineArtistLoadErrorCode, mapped.message) };
    }

    const deadline = this.createDeadline();
    const access = this.access(origin, request.tabId, handle);
    if (deadline === null) {
      void this.safeRelease(access);
      return {
        ack: this.artistFailureAck(
          "BACKPRESSURE",
          "Timeline load deadline is unavailable"
        ),
      };
    }
    const key = this.tabKey(origin.coreId, request.tabId);
    const operation: ArtistLoadOperation = {
      kind: "artist",
      key,
      requestKey: this.requestKey(origin.socketId, request.requestId),
      origin,
      tabId: request.tabId,
      request,
      handle,
      access,
      correlation: {
        requestId: request.requestId,
        session: this.sessionRef(handle),
        loadingDeadlineAt: deadline,
      },
      sink,
      started: false,
      terminal: false,
      supersededPrior: false,
    };
    this.deleteRuntime(this.runtimes.get(key));
    this.installOperation(operation);
    return this.artistReservation(operation);
  }

  public beginDetail(
    origin: TimelineArtistLoadOrigin,
    request: TimelineAlbumDetailRequest,
    sink: TimelineAlbumDetailSink
  ): TimelineAlbumDetailReservation {
    if (this.stopped) {
      return { ack: this.detailFailureAck("SESSION_LOST", "Timeline browsing is stopped") };
    }
    const conflict = this.requestConflict(origin.socketId, request.requestId);
    if (conflict) return { ack: this.detailFailureAck("REQUEST_ID_CONFLICT", conflict) };

    let runtime: TimelineRuntime;
    try {
      runtime = this.requireRuntime(origin, request.tabId, request.session);
    } catch (error) {
      const mapped = this.mapError(error, "detail");
      return { ack: this.detailFailureAck(mapped.code as TimelineAlbumDetailErrorCode, mapped.message) };
    }
    const deadline = this.createDeadline();
    if (deadline === null) {
      return { ack: this.detailFailureAck("BACKPRESSURE", "Timeline load deadline is unavailable") };
    }
    const operation: DetailLoadOperation = {
      kind: "detail",
      key: runtime.key,
      requestKey: this.requestKey(origin.socketId, request.requestId),
      origin,
      tabId: request.tabId,
      request,
      handle: runtime.handle,
      access: runtime.access,
      correlation: {
        requestId: request.requestId,
        session: this.sessionRef(runtime.handle),
        artistLocalId: request.artistLocalId,
        albumLocalId: request.albumLocalId,
        loadingDeadlineAt: deadline,
      },
      sink,
      baseArtistLocalId: runtime.baseArtistLocalId,
      reuseCurrentParent:
        runtime.level.kind === "artist" &&
        runtime.level.artistLocalId === request.artistLocalId,
      started: false,
      terminal: false,
      supersededPrior: false,
    };
    this.installOperation(operation);
    return this.detailReservation(operation);
  }

  public closeDetail(
    origin: TimelineArtistLoadOrigin,
    request: TimelineAlbumDetailCloseRequest,
    sink: TimelineAlbumDetailCloseSink
  ): TimelineAlbumDetailCloseReservation {
    if (this.stopped) {
      return { ack: this.closeFailureAck("SESSION_LOST", "Timeline browsing is stopped") };
    }
    const conflict = this.requestConflict(origin.socketId, request.requestId);
    if (conflict) return { ack: this.closeFailureAck("REQUEST_ID_CONFLICT", conflict) };

    let runtime: TimelineRuntime;
    try {
      runtime = this.requireRuntime(origin, request.tabId, request.session);
      if (
        runtime.level.kind !== "detail" ||
        runtime.baseArtistLocalId !== request.baseArtistLocalId ||
        runtime.level.baseArtistLocalId !== request.baseArtistLocalId ||
        runtime.level.detailArtistLocalId !== request.detailArtistLocalId ||
        runtime.level.albumLocalId !== request.albumLocalId
      ) {
        throw new TimelineBrowseServiceError(
          "STALE_GENERATION",
          "The requested Timeline detail is no longer current"
        );
      }
    } catch (error) {
      const mapped = this.mapError(error, "close");
      return { ack: this.closeFailureAck(mapped.code as TimelineAlbumDetailCloseErrorCode, mapped.message) };
    }
    const deadline = this.createDeadline();
    if (deadline === null) {
      return { ack: this.closeFailureAck("BACKPRESSURE", "Timeline close deadline is unavailable") };
    }
    const operation: DetailCloseOperation = {
      kind: "close",
      key: runtime.key,
      requestKey: this.requestKey(origin.socketId, request.requestId),
      origin,
      tabId: request.tabId,
      request,
      handle: runtime.handle,
      access: runtime.access,
      correlation: {
        requestId: request.requestId,
        session: this.sessionRef(runtime.handle),
        baseArtistLocalId: request.baseArtistLocalId,
        detailArtistLocalId: request.detailArtistLocalId,
        albumLocalId: request.albumLocalId,
        closingDeadlineAt: deadline,
      },
      sink,
      popCoherentParent:
        request.baseArtistLocalId === request.detailArtistLocalId,
      started: false,
      terminal: false,
      supersededPrior: false,
    };
    this.installOperation(operation);
    return this.closeReservation(operation);
  }

  public reconnect(
    origin: TimelineArtistLoadOrigin,
    request: TimelineSessionReconnectRequest
  ): TimelineSessionReconnectAck {
    if (this.stopped) {
      return this.reconnectFailureAck("SESSION_LOST", "Timeline browsing is stopped");
    }
    const key = this.tabKey(origin.coreId, request.tabId);
    const runtime = this.runtimes.get(key);
    if (
      !runtime ||
      runtime.coreId !== origin.coreId ||
      runtime.handle.handleId !== request.session.handleId ||
      runtime.handle.generation !== request.session.generation
    ) {
      return this.reconnectFailureAck(
        "STALE_GENERATION",
        "The Timeline session generation is no longer current"
      );
    }
    if (!runtime.disconnected || runtime.level.kind === "unknown") {
      return this.reconnectFailureAck(
        "SESSION_LOST",
        "The disconnected Timeline level must be re-resolved"
      );
    }
    try {
      const handle = this.coordinator.reconnectMode({
        coreId: origin.coreId,
        tabId: request.tabId,
        socketId: origin.socketId,
        handle: runtime.handle,
      });
      runtime.socketId = origin.socketId;
      runtime.access = this.access(origin, request.tabId, handle);
      runtime.disconnected = false;
      this.clearTimer(runtime.graceTimer);
      runtime.graceTimer = undefined;
      this.scheduleRuntimeIdle(runtime);
      return {
        success: true,
        data: {
          requestId: request.requestId,
          session: this.sessionRef(handle),
        },
      };
    } catch (error) {
      const mapped = this.mapReconnectError(error);
      return this.reconnectFailureAck(mapped.code, mapped.message);
    }
  }

  public release(
    origin: TimelineArtistLoadOrigin,
    request: TimelineSessionReleaseRequest
  ): TimelineSessionReleaseAck {
    if (this.stopped) {
      return this.releaseFailureAck("SESSION_LOST", "Timeline browsing is stopped");
    }
    const key = this.tabKey(origin.coreId, request.tabId);
    const operation = this.currentByTab.get(key);
    const runtime = this.runtimes.get(key);
    const operationMatches =
      operation !== undefined &&
      operation.origin.coreId === origin.coreId &&
      operation.origin.socketId === origin.socketId &&
      operation.tabId === request.tabId &&
      operation.handle.handleId === request.session.handleId &&
      operation.handle.generation === request.session.generation;
    const runtimeMatches =
      runtime !== undefined &&
      runtime.coreId === origin.coreId &&
      runtime.socketId === origin.socketId &&
      runtime.tabId === request.tabId &&
      runtime.handle.handleId === request.session.handleId &&
      runtime.handle.generation === request.session.generation;
    if (!operationMatches && !runtimeMatches) {
      return this.releaseFailureAck(
        "STALE_GENERATION",
        "The Timeline session generation is no longer current"
      );
    }

    const access = runtimeMatches ? runtime.access : operation!.access;
    if (operationMatches) this.closeWithoutEvent(operation);
    if (runtimeMatches) this.deleteRuntime(runtime);
    void this.safeRelease(access);
    return {
      success: true,
      data: { requestId: request.requestId, session: this.sessionRef(access.handle) },
    };
  }

  public disconnectSocket(socketId: string): void {
    for (const operation of [...this.currentByTab.values()]) {
      if (operation.origin.socketId !== socketId) continue;
      const runtime = this.runtimes.get(operation.key);
      if (runtime?.handle.handleId === operation.handle.handleId) {
        runtime.level = { kind: "unknown" };
      }
      this.closeWithoutEvent(operation);
    }
    for (const runtime of this.runtimes.values()) {
      if (runtime.socketId !== socketId || runtime.disconnected) continue;
      runtime.disconnected = true;
      this.clearTimer(runtime.idleTimer);
      runtime.idleTimer = undefined;
      runtime.graceTimer = this.unrefTimer(
        setTimeout(() => {
          if (this.runtimes.get(runtime.key) !== runtime || !runtime.disconnected) {
            return;
          }
          this.deleteRuntime(runtime);
          void this.safeRelease(runtime.access);
        }, this.disconnectGraceMs)
      );
    }
  }

  public invalidateCore(coreId: string): void {
    for (const operation of [...this.currentByTab.values()]) {
      if (operation.origin.coreId === coreId) this.closeWithoutEvent(operation);
    }
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.coreId === coreId) this.deleteRuntime(runtime);
    }
  }

  public shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const operation of [...this.currentByTab.values()]) {
      this.closeWithoutEvent(operation);
    }
    for (const runtime of [...this.runtimes.values()]) {
      this.deleteRuntime(runtime);
    }
  }

  private artistReservation(
    operation: ArtistLoadOperation
  ): TimelineArtistLoadReservation {
    return {
      ack: { success: true, data: operation.correlation },
      start: () => this.start(operation),
      abandon: () => this.abandon(operation),
    };
  }

  private detailReservation(
    operation: DetailLoadOperation
  ): TimelineAlbumDetailReservation {
    return {
      ack: { success: true, data: operation.correlation },
      start: () => this.start(operation),
      abandon: () => this.abandon(operation),
    };
  }

  private closeReservation(
    operation: DetailCloseOperation
  ): TimelineAlbumDetailCloseReservation {
    return {
      ack: { success: true, data: operation.correlation },
      start: () => this.start(operation),
      abandon: () => this.abandon(operation),
    };
  }

  private installOperation(operation: TimelineOperation): void {
    const previous = this.currentByTab.get(operation.key);
    operation.supersededPrior = previous !== undefined;
    this.currentByTab.set(operation.key, operation);
    this.activeRequestIds.set(operation.requestKey, operation);
    if (previous) this.supersede(previous, operation);
  }

  private start(operation: TimelineOperation): Promise<void> {
    if (operation.settled) return operation.settled;
    if (operation.terminal || !this.isCurrent(operation)) {
      return Promise.resolve();
    }
    try {
      this.assertBeforeDeadline(operation);
    } catch (error) {
      operation.settled = this.failCurrent(
        operation,
        this.mapError(error, operation.kind)
      );
      return operation.settled;
    }
    operation.started = true;
    const runtime = this.runtimes.get(operation.key);
    if (operation.kind !== "artist" && runtime) {
      this.clearTimer(runtime.idleTimer);
      runtime.idleTimer = undefined;
      runtime.level = { kind: "unknown" };
    }
    this.armTimer(operation);
    operation.settled = this.execute(operation);
    return operation.settled;
  }

  private execute(operation: TimelineOperation): Promise<void> {
    if (operation.kind === "artist") return this.executeArtist(operation);
    if (operation.kind === "detail") return this.executeDetail(operation);
    return this.executeClose(operation);
  }

  private async executeArtist(operation: ArtistLoadOperation): Promise<void> {
    try {
      this.assertOperationAuthority(operation);
      const known = await this.knownArtist(
        operation.origin.coreId,
        operation.request.artistLocalId,
        "artist"
      );
      this.assertOperationAuthority(operation);
      const resolution = await this.coordinator.runMode(
        operation.access,
        "timeline-interactive",
        (session) => this.resolver.resolve(session, known.artist)
      );
      this.assertOperationAuthority(operation);
      if (resolution.kind !== "resolved") {
        await this.catalog.reconcileSelectedArtist(
          operation.origin.coreId,
          operation.request.artistLocalId,
          resolution.observation
        );
        this.assertOperationAuthority(operation);
        throw new TimelineBrowseServiceError(
          resolution.kind === "missing" ? "ARTIST_NOT_FOUND" : "ARTIST_AMBIGUOUS",
          resolution.kind === "missing"
            ? "Artist no longer exists in the current Roon hierarchy"
            : "Artist name is ambiguous in the current Roon hierarchy"
        );
      }
      const reconciled = await this.catalog.reconcileSelectedArtist(
        operation.origin.coreId,
        operation.request.artistLocalId,
        resolution.observation
      );
      this.assertOperationAuthority(operation);
      const response = this.workingSetResponse(operation.origin.coreId, reconciled);
      await this.coordinator.runMode(
        operation.access,
        "timeline-interactive",
        () => {
          this.assertOperationAuthority(operation);
          const runtime = this.createRuntime(
            operation,
            operation.request.artistLocalId,
            { kind: "artist", artistLocalId: operation.request.artistLocalId }
          );
          operation.sink.loaded({ ...operation.correlation, discography: response });
          this.complete(operation);
          this.scheduleRuntimeIdle(runtime);
          return Promise.resolve();
        }
      );
    } catch (error) {
      await this.failCurrent(operation, this.mapError(error, "artist"));
    }
  }

  private async executeDetail(operation: DetailLoadOperation): Promise<void> {
    try {
      this.assertOperationAuthority(operation);
      const known = await this.knownArtist(
        operation.origin.coreId,
        operation.request.artistLocalId,
        "detail"
      );
      const album = this.knownAlbum(known, operation.request.albumLocalId);
      this.assertOperationAuthority(operation);
      const detailResolution = await this.coordinator.runMode(
        operation.access,
        "timeline-interactive",
        async (session) => {
          let observed: TimelineObservedDiscography;
          if (operation.reuseCurrentParent) {
            observed = await this.resolver.observeCurrent(session, known.artist);
          } else {
            const resolution = await this.resolver.resolve(session, known.artist);
            if (resolution.kind !== "resolved") {
              throw new TimelineBrowseServiceError(
                resolution.kind === "missing"
                  ? "ARTIST_NOT_FOUND"
                  : "ARTIST_AMBIGUOUS",
                "The detail artist could not be resolved uniquely"
              );
            }
            observed = await this.resolver.observeCurrent(session, known.artist);
          }
          return this.detailResolver.resolve(
            session,
            known.artist,
            album,
            observed
          );
        }
      );
      this.assertOperationAuthority(operation);
      const reconciled = await this.catalog.reconcileSelectedArtist(
        operation.origin.coreId,
        operation.request.artistLocalId,
        detailResolution.observation
      );
      this.assertOperationAuthority(operation);
      const publishedAlbum = reconciled.albums.find(
        (candidate) =>
          candidate.localId === operation.request.albumLocalId &&
          candidate.artistLocalId === reconciled.artist.localId &&
          candidate.resolutionStatus === "resolved" &&
          candidate.trackTitleFingerprint !== undefined
      );
      if (!publishedAlbum || reconciled.artist.resolutionStatus !== "resolved") {
        throw new TimelineBrowseServiceError(
          "ALBUM_AMBIGUOUS",
          "Album detail did not preserve one resolved catalog identity"
        );
      }
      const snapshot: TimelineAlbumDetailSnapshot = {
        artist: reconciled.artist,
        album: publishedAlbum,
        orderedTrackTitles: detailResolution.orderedTrackTitles,
      };
      await this.coordinator.runMode(
        operation.access,
        "timeline-interactive",
        () => {
          this.assertOperationAuthority(operation);
          const runtime = this.createRuntime(
            operation,
            operation.baseArtistLocalId,
            {
              kind: "detail",
              baseArtistLocalId: operation.baseArtistLocalId,
              detailArtistLocalId: operation.request.artistLocalId,
              albumLocalId: operation.request.albumLocalId,
              detail: snapshot,
            }
          );
          operation.sink.loaded({ ...operation.correlation, detail: snapshot });
          this.complete(operation);
          this.scheduleRuntimeIdle(runtime);
          return Promise.resolve();
        }
      );
    } catch (error) {
      await this.failCurrent(operation, this.mapError(error, "detail"));
    }
  }

  private async executeClose(operation: DetailCloseOperation): Promise<void> {
    try {
      this.assertOperationAuthority(operation);
      const known = await this.knownArtist(
        operation.origin.coreId,
        operation.request.baseArtistLocalId,
        "close"
      );
      this.assertOperationAuthority(operation);
      const observation = await this.coordinator.runMode(
        operation.access,
        "timeline-interactive",
        async (session) => {
          if (operation.popCoherentParent) {
            const popped = await session.pop({
              hierarchy: "artists",
              levels: 1,
              refresh: true,
              pageSize: 100,
            });
            try {
              return (await this.resolver.observeCurrent(
                session,
                known.artist,
                popped
              )).observation;
            } catch (error) {
              if (!(error instanceof TimelineDiscographyResolverError)) throw error;
            }
          }
          const resolution = await this.resolver.resolve(session, known.artist);
          if (resolution.kind !== "resolved") {
            throw new TimelineBrowseServiceError(
              resolution.kind === "missing" ? "ARTIST_NOT_FOUND" : "ARTIST_AMBIGUOUS",
              "The selected artist parent could not be resolved uniquely"
            );
          }
          return resolution.observation;
        }
      );
      this.assertOperationAuthority(operation);
      const reconciled = await this.catalog.reconcileSelectedArtist(
        operation.origin.coreId,
        operation.request.baseArtistLocalId,
        observation
      );
      this.assertOperationAuthority(operation);
      const response = this.workingSetResponse(operation.origin.coreId, reconciled);
      await this.coordinator.runMode(
        operation.access,
        "timeline-interactive",
        () => {
          this.assertOperationAuthority(operation);
          const runtime = this.createRuntime(
            operation,
            operation.request.baseArtistLocalId,
            {
              kind: "artist",
              artistLocalId: operation.request.baseArtistLocalId,
            }
          );
          operation.sink.closed({ ...operation.correlation, discography: response });
          this.complete(operation);
          this.scheduleRuntimeIdle(runtime);
          return Promise.resolve();
        }
      );
    } catch (error) {
      await this.failCurrent(operation, this.mapError(error, "close"));
    }
  }

  private async knownArtist(
    coreId: string,
    artistLocalId: string,
    kind: TimelineOperation["kind"]
  ): Promise<CatalogArtistAlbumsResponse> {
    const known = await this.catalog.getArtistAlbums(
      coreId,
      artistLocalId,
      CATALOG_ARTIST_ALBUMS_MAX_LIMIT
    );
    if (!known) {
      const status = this.catalog.getStatus(coreId);
      throw new TimelineBrowseServiceError(
        status.available && status.complete
          ? "ARTIST_NOT_FOUND"
          : "CATALOG_UNAVAILABLE",
        status.available && status.complete
          ? "Catalog artist was not found"
          : "Artist catalog is not ready"
      );
    }
    if (known.status.persistence === "degraded") {
      throw new TimelineBrowseServiceError(
        "CATALOG_UNAVAILABLE",
        `${kind === "detail" ? "Detail" : "Selected"} artist catalog persistence is degraded`
      );
    }
    return known;
  }

  private knownAlbum(
    known: CatalogArtistAlbumsResponse,
    albumLocalId: string
  ): AlbumRef {
    const matches = known.albums.filter(
      (album) =>
        album.localId === albumLocalId &&
        album.coreId === known.artist.coreId &&
        album.artistLocalId === known.artist.localId
    );
    if (matches.length !== 1 || matches[0].resolutionStatus === "missing") {
      throw new TimelineBrowseServiceError(
        "ALBUM_NOT_FOUND",
        "Catalog album was not found for the detail artist"
      );
    }
    if (matches[0].resolutionStatus !== "resolved") {
      throw new TimelineBrowseServiceError(
        "ALBUM_AMBIGUOUS",
        "Catalog album requires identity resolution before detail can open"
      );
    }
    return matches[0];
  }

  private workingSetResponse(
    coreId: string,
    reconciled: CatalogSelectedArtistResult
  ): CatalogArtistAlbumsResponse {
    const albums = reconciled.albums.filter(
      (album) => album.resolutionStatus !== "missing"
    );
    if (albums.length > CATALOG_ARTIST_ALBUMS_MAX_LIMIT) {
      throw new TimelineBrowseServiceError(
        "DISCOGRAPHY_UNAVAILABLE",
        "Selected artist working set exceeds the supported bound"
      );
    }
    if (
      reconciled.snapshot.coreId !== coreId ||
      reconciled.status.coreId !== coreId ||
      reconciled.status.revision !== reconciled.snapshot.revision
    ) {
      throw new TimelineBrowseServiceError(
        "INTERNAL_ERROR",
        "Selected artist reconciliation status does not match its snapshot"
      );
    }
    const response = normalizeCatalogArtistAlbumsResponse({
      status: reconciled.status,
      artist: reconciled.artist,
      limit: CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
      total: albums.length,
      truncated: false,
      albums,
    });
    if (!response) {
      throw new TimelineBrowseServiceError(
        "INTERNAL_ERROR",
        "Selected artist produced an invalid working set"
      );
    }
    return response;
  }

  private async failCurrent(
    operation: TimelineOperation,
    error: TimelineBrowseServiceError
  ): Promise<void> {
    if (operation.terminal) return;
    if (this.isCurrent(operation)) {
      try {
        if (operation.kind === "artist") {
          operation.sink.failed({
            ...operation.correlation,
            error: error.message,
            code: error.code as TimelineArtistLoadErrorCode,
          });
        } else if (operation.kind === "detail") {
          operation.sink.failed({
            ...operation.correlation,
            error: error.message,
            code: error.code as TimelineAlbumDetailErrorCode,
          });
        } else {
          operation.sink.failed({
            ...operation.correlation,
            error: error.message,
            code: error.code as TimelineAlbumDetailCloseErrorCode,
          });
        }
      } catch {
        // Socket delivery failure is terminal; cleanup still must run.
      }
    }
    this.complete(operation);
    this.deleteRuntimeFor(operation);
    await this.safeRelease(operation.access);
  }

  private async abandon(operation: TimelineOperation): Promise<void> {
    if (operation.terminal) return;
    const started = operation.started;
    const runtime = this.runtimes.get(operation.key);
    const untouchedRuntime =
      operation.kind !== "artist" &&
      !started &&
      !operation.supersededPrior &&
      runtime !== undefined &&
      runtime.handle.handleId === operation.handle.handleId &&
      runtime.handle.generation === operation.handle.generation &&
      runtime.level.kind !== "unknown";
    this.complete(operation);
    if (!untouchedRuntime) {
      this.deleteRuntimeFor(operation);
      await this.safeRelease(operation.access);
    }
  }

  private supersede(
    operation: TimelineOperation,
    replacement: TimelineOperation
  ): void {
    if (operation.terminal) return;
    this.complete(operation);
    const sameHandle =
      operation.handle.handleId === replacement.handle.handleId &&
      operation.handle.generation === replacement.handle.generation;
    if (sameHandle) {
      const runtime = this.runtimes.get(operation.key);
      if (runtime) runtime.level = { kind: "unknown" };
      return;
    }
    this.deleteRuntimeFor(operation);
    void this.safeRelease(operation.access);
  }

  private closeWithoutEvent(operation: TimelineOperation): void {
    if (!operation.terminal) this.complete(operation);
  }

  private complete(operation: TimelineOperation): void {
    if (operation.terminal) return;
    operation.terminal = true;
    this.clearTimer(operation.timer);
    operation.timer = undefined;
    if (this.currentByTab.get(operation.key) === operation) {
      this.currentByTab.delete(operation.key);
    }
    if (this.activeRequestIds.get(operation.requestKey) === operation) {
      this.activeRequestIds.delete(operation.requestKey);
    }
    this.retireRequest(operation.requestKey);
  }

  private createRuntime(
    operation: TimelineOperation,
    baseArtistLocalId: string,
    level: TimelineRuntimeLevel
  ): TimelineRuntime {
    const existing = this.runtimes.get(operation.key);
    if (
      existing &&
      (existing.handle.handleId !== operation.handle.handleId ||
        existing.handle.generation !== operation.handle.generation)
    ) {
      this.deleteRuntime(existing);
    }
    const runtime: TimelineRuntime = existing ?? {
      key: operation.key,
      coreId: operation.origin.coreId,
      tabId: operation.tabId,
      socketId: operation.origin.socketId,
      handle: operation.handle,
      access: operation.access,
      baseArtistLocalId,
      level,
      disconnected: false,
    };
    runtime.socketId = operation.origin.socketId;
    runtime.access = operation.access;
    runtime.level = level;
    runtime.disconnected = false;
    this.clearTimer(runtime.graceTimer);
    runtime.graceTimer = undefined;
    this.runtimes.set(operation.key, runtime);
    return runtime;
  }

  private requireRuntime(
    origin: TimelineArtistLoadOrigin,
    tabId: string,
    session: TimelineBrowseSessionRef
  ): TimelineRuntime {
    const runtime = this.runtimes.get(this.tabKey(origin.coreId, tabId));
    if (
      !runtime ||
      runtime.socketId !== origin.socketId ||
      runtime.tabId !== tabId ||
      runtime.handle.handleId !== session.handleId ||
      runtime.handle.generation !== session.generation
    ) {
      throw new TimelineBrowseServiceError(
        "STALE_GENERATION",
        "The Timeline session generation is no longer current"
      );
    }
    if (runtime.disconnected) {
      throw new TimelineBrowseServiceError(
        "SESSION_LOST",
        "The Timeline session is disconnected"
      );
    }
    return runtime;
  }

  private scheduleRuntimeIdle(runtime: TimelineRuntime): void {
    this.clearTimer(runtime.idleTimer);
    runtime.idleTimer = this.unrefTimer(
      setTimeout(() => {
        if (this.runtimes.get(runtime.key) !== runtime || runtime.disconnected) return;
        this.deleteRuntime(runtime);
        void this.safeRelease(runtime.access);
      }, this.runtimeIdleMs)
    );
  }

  private deleteRuntime(runtime: TimelineRuntime | undefined): void {
    if (!runtime) return;
    this.clearTimer(runtime.idleTimer);
    this.clearTimer(runtime.graceTimer);
    runtime.idleTimer = undefined;
    runtime.graceTimer = undefined;
    if (this.runtimes.get(runtime.key) === runtime) {
      this.runtimes.delete(runtime.key);
    }
  }

  private deleteRuntimeFor(operation: TimelineOperation): void {
    const runtime = this.runtimes.get(operation.key);
    if (runtime?.handle.handleId === operation.handle.handleId) {
      this.deleteRuntime(runtime);
    }
  }

  private retireRequest(requestKey: string): void {
    this.retiredRequestIds.add(requestKey);
    while (this.retiredRequestIds.size > this.retiredRequestLimit) {
      const oldest = this.retiredRequestIds.values().next().value;
      if (typeof oldest !== "string") break;
      this.retiredRequestIds.delete(oldest);
    }
  }

  private requestConflict(socketId: string, requestId: string): string | null {
    const key = this.requestKey(socketId, requestId);
    return this.activeRequestIds.has(key) || this.retiredRequestIds.has(key)
      ? "Timeline request ID was already used"
      : null;
  }

  private assertOperationAuthority(operation: TimelineOperation): void {
    if (!this.isCurrent(operation)) {
      throw new TimelineBrowseServiceError(
        "STALE_GENERATION",
        "Timeline request was superseded"
      );
    }
    this.assertCoreCurrent(operation.origin.coreId, operation.kind);
    this.assertBeforeDeadline(operation);
  }

  private assertBeforeDeadline(operation: TimelineOperation): void {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now >= this.deadline(operation)) {
      throw this.timeoutError(operation.kind);
    }
  }

  private armTimer(operation: TimelineOperation): void {
    if (operation.terminal) return;
    const now = this.now();
    const remaining = this.deadline(operation) - now;
    if (!Number.isSafeInteger(now) || remaining <= 0) {
      void this.failCurrent(operation, this.timeoutError(operation.kind));
      return;
    }
    operation.timer = this.unrefTimer(
      setTimeout(() => {
        operation.timer = undefined;
        if (operation.terminal) return;
        const currentNow = this.now();
        if (Number.isSafeInteger(currentNow) && currentNow < this.deadline(operation)) {
          this.armTimer(operation);
          return;
        }
        void this.failCurrent(operation, this.timeoutError(operation.kind));
      }, remaining)
    );
  }

  private timeoutError(kind: TimelineOperation["kind"]): TimelineBrowseServiceError {
    return new TimelineBrowseServiceError(
      "SESSION_LOST",
      kind === "close"
        ? "Timeline detail close timed out"
        : kind === "detail"
          ? "Timeline album detail timed out"
          : "Timeline artist load timed out"
    );
  }

  private isCurrent(operation: TimelineOperation): boolean {
    return !operation.terminal && this.currentByTab.get(operation.key) === operation;
  }

  private assertCoreCurrent(
    expectedCoreId: string,
    kind: TimelineOperation["kind"]
  ): void {
    if (this.getCurrentCoreId() !== expectedCoreId) {
      throw new TimelineBrowseServiceError(
        "CORE_UNAVAILABLE",
        kind === "artist"
          ? "Roon Core changed during Timeline artist loading"
          : kind === "detail"
            ? "Roon Core changed during Timeline album detail loading"
            : "Roon Core changed during Timeline detail close"
      );
    }
  }

  private mapError(
    error: unknown,
    kind: TimelineOperation["kind"]
  ): TimelineBrowseServiceError {
    if (error instanceof TimelineBrowseServiceError) return error;
    if (error instanceof TimelineAlbumDetailResolverError) {
      const code: TimelineAlbumDetailErrorCode =
        error.code === "ALBUM_NOT_FOUND"
          ? "ALBUM_NOT_FOUND"
          : error.code === "ALBUM_AMBIGUOUS"
            ? "ALBUM_AMBIGUOUS"
            : "DETAIL_UNAVAILABLE";
      return new TimelineBrowseServiceError(code, error.message);
    }
    if (error instanceof TimelineDiscographyResolverError) {
      return new TimelineBrowseServiceError(
        kind === "detail" ? "DETAIL_UNAVAILABLE" : "DISCOGRAPHY_UNAVAILABLE",
        kind === "detail"
          ? "The album detail parent could not be loaded completely"
          : "The selected artist discography could not be loaded completely"
      );
    }
    if (error instanceof BrowseSessionCoordinatorError) {
      const code: TimelineBrowseErrorCode =
        error.code === "BACKPRESSURE"
          ? "BACKPRESSURE"
          : error.code === "SESSION_LOST"
            ? "SESSION_LOST"
            : "STALE_GENERATION";
      return new TimelineBrowseServiceError(code, error.message);
    }
    if (error instanceof CatalogServiceError) {
      return new TimelineBrowseServiceError(
        "CATALOG_UNAVAILABLE",
        "Artist catalog could not publish the selected working set"
      );
    }
    if (error instanceof CoreUnpairedError) {
      return new TimelineBrowseServiceError(
        "CORE_UNAVAILABLE",
        "Roon Core is unavailable"
      );
    }
    if (error instanceof RoonTimeoutError) {
      return new TimelineBrowseServiceError(
        "SESSION_LOST",
        "Roon browse session timed out"
      );
    }
    return new TimelineBrowseServiceError(
      "INTERNAL_ERROR",
      kind === "close"
        ? "Timeline detail close failed"
        : kind === "detail"
          ? "Timeline album detail loading failed"
          : "Timeline artist loading failed"
    );
  }

  private mapReconnectError(
    error: unknown
  ): { code: "STALE_GENERATION" | "SESSION_LOST" | "INTERNAL_ERROR"; message: string } {
    if (error instanceof BrowseSessionCoordinatorError) {
      return {
        code: error.code === "SESSION_LOST" ? "SESSION_LOST" : "STALE_GENERATION",
        message: error.message,
      };
    }
    return { code: "INTERNAL_ERROR", message: "Timeline reconnect failed" };
  }

  private artistFailureAck(
    code: TimelineArtistLoadErrorCode,
    error: string
  ): TimelineArtistLoadBeginAck {
    return { success: false, code, error };
  }

  private detailFailureAck(
    code: TimelineAlbumDetailErrorCode,
    error: string
  ): TimelineAlbumDetailBeginAck {
    return { success: false, code, error };
  }

  private closeFailureAck(
    code: TimelineAlbumDetailCloseErrorCode,
    error: string
  ): TimelineAlbumDetailCloseAck {
    return { success: false, code, error };
  }

  private reconnectFailureAck(
    code: "CORE_UNAVAILABLE" | "STALE_GENERATION" | "SESSION_LOST" | "INTERNAL_ERROR",
    error: string
  ): TimelineSessionReconnectAck {
    return { success: false, code, error };
  }

  private releaseFailureAck(
    code: "STALE_GENERATION" | "SESSION_LOST" | "INTERNAL_ERROR",
    error: string
  ): TimelineSessionReleaseAck {
    return { success: false, code, error };
  }

  private safeRelease(access: ModeSessionAccess): Promise<void> {
    try {
      return this.coordinator.releaseMode(access).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  private access(
    origin: TimelineArtistLoadOrigin,
    tabId: string,
    handle: ModeSessionHandle
  ): ModeSessionAccess {
    return {
      coreId: origin.coreId,
      socketId: origin.socketId,
      tabId,
      handle,
    };
  }

  private sessionRef(handle: ModeSessionHandle): TimelineBrowseSessionRef {
    return { handleId: handle.handleId, generation: handle.generation };
  }

  private createDeadline(): number | null {
    const deadline = this.now() + this.loadTimeoutMs;
    return Number.isSafeInteger(deadline) && deadline > 0 ? deadline : null;
  }

  private deadline(operation: TimelineOperation): number {
    return operation.kind === "close"
      ? operation.correlation.closingDeadlineAt
      : operation.correlation.loadingDeadlineAt;
  }

  private tabKey(coreId: string, tabId: string): string {
    return JSON.stringify([coreId, tabId]);
  }

  private requestKey(socketId: string, requestId: string): string {
    return JSON.stringify([socketId, requestId]);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (timer) clearTimeout(timer);
  }

  private unrefTimer<T extends ReturnType<typeof setTimeout>>(timer: T): T {
    timer.unref?.();
    return timer;
  }
}
