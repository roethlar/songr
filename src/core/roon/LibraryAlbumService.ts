import { randomUUID } from "crypto";
import { Logger } from "pino";

import {
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
  CollectionDrillAlbumRendering,
  CollectionDrillHierarchy,
  CollectionDrillOpenFailureDetail,
  CollectionDrillOpenLocator,
} from "../../shared/collectionDrillContracts";
import {
  CollectionDrillResolution,
  CollectionDrillResolver,
  CollectionDrillResolverError,
} from "./CollectionDrillResolver";
import {
  ActionSessionAccess,
  ActionSessionHandle,
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
} from "./BrowseSessionCoordinator";
import { RoonTimeoutError } from "./errors";
import {
  AlbumActionPageSource,
  createAlbumVersionDetailDigest,
} from "./AlbumActionResolver";
import {
  AlbumDetailResolver,
  AlbumDetailResolverError,
} from "./AlbumDetailResolver";

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
  /**
   * The live row key the page still holds for this version, or the empty
   * string for a collection-opened page, which holds none.
   *
   * A catalog page keeps its row key across the whole page session and the
   * lease is checked against it. A collection page cannot: the key it resolved
   * belonged to the browse session that opened it, and that session was
   * released when the read finished. What stands in its place is the locator,
   * which is in `albumSignature` and cannot change while the page is open, and
   * which the action re-walks for itself.
   */
  readonly retainedItemKey: string;
  readonly source: Readonly<AlbumActionPageSource>;
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

/**
 * The two live reads a collection-opened page makes, behind one port.
 *
 * They are one port because they must happen in one session: the item key the
 * first returns is bound to the Roon browse session that produced it, so the
 * second has to run before that session is released. Keeping them together
 * makes that impossible to get wrong at a call site and easy to fake in a test.
 */
export interface LibraryAlbumCollectionResolverPort {
  resolve(
    session: CoordinatedBrowseSession,
    locator: Readonly<CollectionDrillOpenLocator>,
    options?: { assertCurrent?: () => void }
  ): Promise<CollectionDrillResolution>;
  readDetailRows(
    session: CoordinatedBrowseSession,
    hierarchy: CollectionDrillHierarchy,
    itemKey: string,
    expectedTitle: string
  ): Promise<string[]>;
}

/** The real pair: the drill resolver, then the detail reader. */
export class LibraryAlbumCollectionResolver
  implements LibraryAlbumCollectionResolverPort
{
  public constructor(
    private readonly drillResolver = new CollectionDrillResolver(),
    private readonly detailResolver = new AlbumDetailResolver()
  ) {}

  public resolve(
    session: CoordinatedBrowseSession,
    locator: Readonly<CollectionDrillOpenLocator>,
    options: { assertCurrent?: () => void } = {}
  ): Promise<CollectionDrillResolution> {
    return this.drillResolver.resolve(session, locator, options);
  }

  public readDetailRows(
    session: CoordinatedBrowseSession,
    hierarchy: CollectionDrillHierarchy,
    itemKey: string,
    expectedTitle: string
  ): Promise<string[]> {
    return this.detailResolver.readDetailRows(
      session,
      hierarchy,
      itemKey,
      expectedTitle
    );
  }
}

export interface LibraryAlbumServiceOptions {
  resolvingTtlMs?: number;
  requestTombstoneLimit?: number;
  now?: () => number;
  randomId?: () => string;
  collectionResolver?: LibraryAlbumCollectionResolverPort;
}

type OperationPhase =
  | "opening"
  | "degrading"
  | "ready"
  | "terminal"
  | "quarantined";

/**
 * Where an opening page stands in its live public read. Degrade is offered
 * only from `"live-read"`, which makes the deadline race deterministic: the
 * fulfillment path clears `resolutionInFlight` before its own deadline check,
 * so a flag-based test would send timer-first and fulfillment-first schedules
 * down different paths. Extended pages never leave `"idle"`, and the
 * inventory merge runs in `"merging"`, so neither can degrade.
 */
type LiveReadStage = "idle" | "live-read" | "merging";

/**
 * What a page is reading, and by whose authority.
 *
 * One arm, and it names no record at all. A `collection` page was opened from
 * a genre or composer drill row, and it holds the drill's own keyless locator —
 * durable data that arrived in the request and cannot change while the page is
 * open.
 *
 * There used to be two more arms, `public` and `extended`, naming a saved
 * catalog album by its controller-minted id. They died with the catalog
 * (`.agents/plans/library-live-view.md` Slice 4). It stays a tagged union
 * rather than collapsing into the locator, because the tag is what every
 * reader below asks before it assumes anything, and a second kind of page will
 * be added here before it is added anywhere else.
 */
type LibraryAlbumReadAuthority = {
  readonly kind: "collection";
  readonly locator: Readonly<CollectionDrillOpenLocator>;
};

/**
 * What a page puts at its head: a title, and an artist only when it has one.
 *
 * A collection-opened album whose drill row rendered no credit line has no
 * artist, and nothing may be substituted — not the genre, not the composer,
 * and not a catalog lookup on the title. Absent is carried as absent all the
 * way to the wire.
 */
interface LibraryAlbumPageHeading {
  readonly title: string;
  readonly artist?: string;
}

/**
 * The one version a collection-opened page ever has.
 *
 * Exactly one, and not by simplification: a drill row whose whole rendering
 * repeats inside its own drill is refused as ambiguous before the page opens,
 * so a page that opened at all was opened from a row nothing else in that
 * drill reads like. The drill row IS the version. Its detail was read in the
 * same session that resolved it, so the resolved event is already built by the
 * time the versions event is published — there is no second round trip to make
 * and nothing left to select.
 */
interface CollectionVersionAuthority {
  readonly kind: "collection";
  readonly versionId: string;
  readonly summary: LibraryAlbumVersionSummary;
  /**
   * The fingerprint of the ordered track titles this page published, taken
   * over the drill row's own title and credit. An action lease is granted
   * against it and the resolver re-computes it from a fresh read, so an album
   * whose contents moved cannot be acted on by mistake.
   */
  readonly detailDigest: string;
  /** Always set: the detail was read in the session that resolved the row. */
  cached: LibraryAlbumResolvedEvent;
}

type LibraryAlbumVersionAuthority = CollectionVersionAuthority;

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
  liveStage: LiveReadStage;
  timer: Timer | null;
  detailTimer: Timer | null;
  albumSignature: string | null;
  authority: LibraryAlbumReadAuthority | null;
  versions: Map<string, LibraryAlbumVersionAuthority>;
  selectedVersionId: string | null;
  selectionSerial: number;
  detailChain: Promise<void>;
}

class LibraryAlbumPhaseError extends Error {
  public constructor(
    public readonly code: LibraryAlbumFailureCode,
    message: string,
    /**
     * Set only when a collection locator refused. It travels with the error so
     * the failed event can say which half of the locator could not answer,
     * with the count the resolver observed rather than one invented here.
     */
    public readonly collectionFailure?: CollectionDrillOpenFailureDetail
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
  private readonly collectionResolver: LibraryAlbumCollectionResolverPort;

  private readonly operations = new Map<string, LibraryAlbumOperation>();
  private readonly requests = new Map<string, LibraryAlbumOperation>();
  private readonly tabs = new Map<string, LibraryAlbumOperation>();
  private readonly requestTombstones = new Map<string, true>();
  private idNonce = 0;
  private stopped = false;

  public constructor(
    private readonly coordinator: LibraryAlbumCoordinatorPort,
    private readonly logger: Logger,
    options: LibraryAlbumServiceOptions = {}
  ) {
    this.resolvingTtlMs =
      options.resolvingTtlMs ?? DEFAULT_RESOLVING_TTL_MS;
    this.requestTombstoneLimit =
      options.requestTombstoneLimit ?? DEFAULT_REQUEST_TOMBSTONE_LIMIT;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => randomUUID());
    this.collectionResolver =
      options.collectionResolver ?? new LibraryAlbumCollectionResolver();
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
      liveStage: "idle",
      timer: null,
      detailTimer: null,
      albumSignature: null,
      authority: null,
      versions: new Map(),
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
    if (!authority || !version || !operation.albumSignature) return null;
    // A collection page's lease carries the locator rather than a live key.
    // The read that built the page is long finished and its session gone, so
    // the action re-walks the drill for itself; what is granted here is the
    // right to do that, against exactly the track list this page published.
    if (!version.cached.actionsAvailable) return null;
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
      retainedItemKey: "",
      source: Object.freeze({
        kind: "collection" as const,
        source: Object.freeze({
          locator: authority.locator,
          detailDigest: version.detailDigest,
        }),
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
    if (!version) return false;
    // No retained key to compare, because a collection page holds none. What
    // is compared instead is the track list the lease was granted against and
    // the locator, which travels in `albumSignature` and was checked above.
    if (
      version.detailDigest !== authority.source.source.detailDigest ||
      !version.cached.actionsAvailable
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
      const bound = {
        kind: "collection" as const,
        locator: operation.request.target.locator,
      };
      operation.authority = bound;
      operation.albumSignature = this.readAuthoritySignature(bound);
      this.assertReadAuthority(operation);
      await this.openCollectionPage(operation, bound.locator);
    } catch (error) {
      operation.resolutionInFlight = false;
      if (operation.closed || operation.phase !== "opening") return;
      if (error instanceof RoonTimeoutError) {
        this.close(operation, true);
        this.emitFailure(
          operation,
          "RESOLUTION_TIMEOUT",
          "Album page opening timed out"
        );
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
      this.emitFailure(
        operation,
        failure.code,
        failure.message,
        failure.collectionFailure
      );
    }
  }

  /**
   * The heading a collection-opened page carries: the drill row's own text.
   *
   * The title is what the row rendered. The artist is the row's credit line
   * when it rendered one, and ABSENT when it did not — not the genre, not the
   * composer, not a catalog lookup on the title. Both fields come from the row
   * this page was opened from, so nothing here compares one surface's text to
   * another's.
   */
  private headingOfCollectionRow(
    rendering: CollectionDrillAlbumRendering
  ): LibraryAlbumPageHeading {
    return {
      title: rendering.exactTitle,
      ...(rendering.exactCredit === ""
        ? {}
        : { artist: rendering.exactCredit }),
    };
  }

  /**
   * Opens a genre or composer drill row as an album page, in ONE session.
   *
   * The locator is resolved and the album's detail is read inside a single
   * coordinator action, deliberately: the item key the resolver lands on is
   * bound to that Roon browse session, so it cannot be carried out and used
   * later. The resolved event is therefore built here and cached on the one
   * version this page has, and the later select finds it already answered.
   *
   * Every await below is a landing spot. The resolver is handed `assertCurrent`
   * so a page that closed or was superseded mid-walk stops rather than
   * finishing a drain nobody is waiting for, and the fulfillment re-checks the
   * phase and the deadline before it publishes anything.
   */
  private async openCollectionPage(
    operation: LibraryAlbumOperation,
    locator: Readonly<CollectionDrillOpenLocator>
  ): Promise<void> {
    operation.resolutionInFlight = true;
    operation.liveStage = "live-read";
    const opened = await this.coordinator.runAction(
      operation.access,
      async (session) => {
        const guarded = this.guardedSession(operation, session);
        const resolution = await this.collectionResolver.resolve(
          guarded,
          locator,
          { assertCurrent: () => this.assertCollectionReadCurrent(operation) }
        );
        if (resolution.kind !== "resolved") return resolution;
        const orderedTrackTitles = await this.collectionResolver.readDetailRows(
          guarded,
          resolution.hierarchy,
          resolution.itemKey,
          resolution.rendering.exactTitle
        );
        return { kind: "resolved" as const, resolution, orderedTrackTitles };
      }
    );
    operation.resolutionInFlight = false;
    if (operation.closed || operation.phase !== "opening") return;
    if (this.now() >= operation.resolvingDeadlineAt) {
      this.expireOpening(operation);
      return;
    }
    this.assertReadAuthority(operation);

    if (opened.kind !== "resolved") {
      // The locator could not be resolved. This is a real answer about the
      // library — the collection is gone or carried twice, or the album left
      // it or is one of two rows that read exactly alike — so it is reported
      // with its stage and the count the resolver actually observed, and never
      // broken by picking one of the rows. It travels as a phase error so the
      // one failure path in `openPage` closes and emits it, exactly as every
      // other refusal is closed and emitted.
      throw new LibraryAlbumPhaseError(
        opened.kind === "ambiguous" ? "ALBUM_AMBIGUOUS" : "ALBUM_NOT_FOUND",
        opened.stage === "collection"
          ? opened.kind === "ambiguous"
            ? "The library carries more than one collection of that name"
            : "The library no longer carries that collection"
          : opened.kind === "ambiguous"
            ? "That collection carries more than one album that reads alike"
            : "That album is no longer in that collection",
        {
          kind: opened.kind,
          stage: opened.stage,
          matchCount: opened.matchCount,
        }
      );
    }

    const heading = this.headingOfCollectionRow(opened.resolution.rendering);
    const versionId = this.uniqueOpaqueId();
    const summary: LibraryAlbumVersionSummary = Object.freeze({
      versionId,
      // The drill supplied no edition text and this shape does not invent one:
      // `CollectionDrillAlbumRendering` carries a title and a credit because
      // those are the only two things a drill row renders.
      editionText: "",
      trackCount: opened.orderedTrackTitles.length,
      ...(opened.resolution.imageKeyHint === undefined
        ? {}
        : { imageKeyHint: opened.resolution.imageKeyHint }),
    });
    const resolved = this.buildResolvedEvent(
      operation,
      versionId,
      heading,
      // Titles and nothing else. The drill level supplied no track numbers,
      // no durations and no availability, and a page that filled those in
      // would be inventing them.
      opened.orderedTrackTitles.map((title) => ({ title })),
      // Actions ARE available: the resolver can re-walk this drill and read
      // the album's own Play/Queue paths inside the hierarchy the row came
      // from. What it cannot do is anything artist-scoped, and the page offers
      // none of that — every affordance here is one the drill itself carries.
      true,
      summary
    );
    operation.versions.set(versionId, {
      kind: "collection",
      versionId,
      summary,
      detailDigest: createAlbumVersionDetailDigest(
        heading.title,
        // The credit as the row rendered it, empty included. The digest is a
        // fingerprint, not a name, and an absent credit is part of what this
        // row is.
        opened.resolution.rendering.exactCredit,
        opened.orderedTrackTitles
      ),
      cached: resolved,
    });
    this.publishVersions(operation, heading);
  }

  private publishVersions(
    operation: LibraryAlbumOperation,
    heading: LibraryAlbumPageHeading,
    degraded = false
  ): void {
    if (operation.closed) return;
    if (operation.phase !== "opening" && operation.phase !== "degrading") return;
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
      ...(heading.artist === undefined ? {} : { artist: heading.artist }),
      title: heading.title,
      versions: Object.freeze(
        [...operation.versions.values()].map((version) => version.summary)
      ),
      ...(degraded ? { degraded: true as const } : {}),
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
    operation.detailChain = operation.detailChain.then(() => {
      this.resolveSelection(operation, serial, version, resolvingDeadlineAt);
    });
  }

  /**
   * Publish the resolved event for one selected version.
   *
   * Every version this service holds is a collection version, and a collection
   * version is built with its resolved event already cached — the detail was
   * read in the same session that resolved the drill row, because the item key
   * could not outlive it. So there is no live read here and nothing to await.
   *
   * The uncached branch is unreachable by construction and says so out loud
   * rather than silently doing nothing: the alternative would be re-reading a
   * drill whose session is long gone.
   */
  private resolveSelection(
    operation: LibraryAlbumOperation,
    serial: number,
    version: LibraryAlbumVersionAuthority,
    resolvingDeadlineAt: number
  ): void {
    if (!this.selectionCurrent(operation, serial)) return;
    if (this.now() >= resolvingDeadlineAt) {
      this.expireSelection(operation, serial, version, resolvingDeadlineAt);
      return;
    }
    try {
      this.assertReadAuthority(operation);
    } catch (error) {
      this.finishSelection(operation, serial);
      const failure = this.resolutionFailure(error);
      this.emitVersionFailure(
        operation,
        version.versionId,
        resolvingDeadlineAt,
        failure.code,
        failure.message
      );
      return;
    }
    this.finishSelection(operation, serial);
    operation.selectedVersionId = version.versionId;
    this.emitResolved(operation, version.cached);
  }

  private buildResolvedEvent(
    operation: LibraryAlbumOperation,
    versionId: string,
    heading: LibraryAlbumPageHeading,
    orderedTracks: readonly Omit<LibraryAlbumTrack, "index">[],
    actionsAvailable: boolean,
    versionSummary: LibraryAlbumVersionSummary
  ): LibraryAlbumResolvedEvent {
    if (
      orderedTracks.length === 0 ||
      orderedTracks.length > LIBRARY_ALBUM_MAX_TRACKS ||
      orderedTracks.some((track) => !this.validDisplayText(track.title)) ||
      // An absent artist is legal; an artist that is present must be real
      // display text. The empty string fails `validDisplayText`, which is the
      // point: a page with no artist omits the field rather than sending a
      // blank one.
      (heading.artist !== undefined && !this.validDisplayText(heading.artist)) ||
      !this.validDisplayText(heading.title) ||
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
      ...(heading.artist === undefined ? {} : { artist: heading.artist }),
      title: heading.title,
      actionsAvailable,
      versionSummary,
      orderedTracks: Object.freeze(
        orderedTracks.map((track, index) => Object.freeze({ index, ...track }))
      ),
    });
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
      sessionScope: session.sessionScope,
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

  /**
   * The landing spot every await in a collection walk shares.
   *
   * The authority check plus the phase: a page that was closed, superseded or
   * degraded while a drill was draining must stop, rather than finish a read
   * nobody is waiting for. Handed to the resolver as `assertCurrent`, which
   * calls it after every browse and between every page of a level.
   */
  private assertCollectionReadCurrent(operation: LibraryAlbumOperation): void {
    this.assertReadAuthority(operation);
    if (operation.phase !== "opening") {
      throw new LibraryAlbumPhaseError(
        "CANCELED",
        "The album page stopped reading before its drill finished"
      );
    }
  }

  /**
   * The one signature a collection page's authority ever has.
   *
   * The locator arrived in the request and is frozen there. Nothing in the
   * catalog can change it, and nothing in the catalog is consulted for it, so
   * unlike a catalog authority there is no republished snapshot underneath
   * that could quietly turn this page into a different album. The signature
   * exists so the same equality check works for all three arms.
   */
  private collectionAuthoritySignature(
    locator: Readonly<CollectionDrillOpenLocator>
  ): string {
    return [
      "collection",
      locator.hierarchy,
      locator.collectionExactName,
      locator.rendering.exactTitle,
      locator.rendering.exactCredit,
    ].join(" ");
  }

  private assertReadAuthority(operation: LibraryAlbumOperation): void {
    // Nothing stored to re-check against: the locator is request data, and
    // nothing can move it. What this asserts instead is that the page still
    // exists and still holds the identity it opened with.
    //
    // The PHASE is deliberately not checked here, because this same assertion
    // runs long after the read, when an action lease is claimed against a page
    // that has been `ready` for minutes. `assertCollectionReadCurrent` is the
    // one that adds the phase, and it is what the walk lands on after every
    // await.
    if (operation.closed) {
      throw new LibraryAlbumPhaseError("CANCELED", "The album page was closed");
    }
    if (
      !operation.authority ||
      operation.albumSignature !==
        this.collectionAuthoritySignature(operation.request.target.locator)
    ) {
      throw new LibraryAlbumPhaseError(
        "ALBUM_NOT_FOUND",
        "The album identity changed during the page session"
      );
    }
  }

  private readAuthoritySignature(bound: LibraryAlbumReadAuthority): string {
    return this.collectionAuthoritySignature(bound.locator);
  }

  private resolutionFailure(error: unknown): {
    code: LibraryAlbumFailureCode;
    message: string;
    collectionFailure?: CollectionDrillOpenFailureDetail;
  } {
    if (error instanceof LibraryAlbumPhaseError) {
      return {
        code: error.code,
        message: error.message,
        ...(error.collectionFailure
          ? { collectionFailure: error.collectionFailure }
          : {}),
      };
    }
    if (error instanceof CollectionDrillResolverError) {
      // A malformed or oversized drill read is news about the read, not about
      // the album: the reader is told the page could not be built, never that
      // the album is missing from a list the resolver only partly saw.
      return {
        code:
          error.code === "COLLECTION_ALBUMS_PATH_NOT_UNIQUE"
            ? "ALBUM_AMBIGUOUS"
            : "DETAIL_INCOMPLETE",
        message: "That collection's album list could not be read completely",
      };
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
    this.emitFailure(
      operation,
      "RESOLUTION_TIMEOUT",
      "Album page opening timed out"
    );
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
    error: string,
    collectionFailure?: CollectionDrillOpenFailureDetail
  ): void {
    const event: LibraryAlbumFailedEvent = Object.freeze({
      requestId: operation.request.requestId,
      operationId: operation.operationId,
      generation: operation.request.generation,
      resolvingDeadlineAt: operation.resolvingDeadlineAt,
      error,
      code,
      ...(collectionFailure ? { collectionFailure } : {}),
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
