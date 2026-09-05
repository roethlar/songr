import { randomUUID } from "crypto";
import { Logger } from "pino";

import {
  ALBUM_ACTION_LABEL_MAX_LENGTH,
  ALBUM_ACTION_MAX_CHOICES,
  ALBUM_ACTION_SEMANTICS,
  AlbumActionBeginAck,
  AlbumActionBeginRequest,
  AlbumActionCancelAck,
  AlbumActionCancelRequest,
  AlbumActionExecuteAck,
  AlbumActionFailedEvent,
  AlbumActionFailureCode,
  AlbumActionResolvedEvent,
  AlbumActionSemantic,
  isAlbumActionReferenceRequest,
  normalizeAlbumActionBeginRequest,
  normalizeAlbumActionCancelRequest,
  normalizeAlbumActionExecuteRequest,
} from "../../shared/albumActionContracts";
import type { LibraryRowReference } from "../../shared/libraryRootsContracts";
import type { LibraryActionSubject } from "../library/LibrarySource";
import {
  BrowseOptions,
  BrowseResult,
  Zone,
} from "../../shared/types";
import {
  AlbumActionBrowseHierarchy,
  AlbumActionResolutionError,
  AlbumActionResolverPort,
  AlbumActionPageSource,
  ResolvedAlbumAction,
  ResolvedAlbumActions,
} from "./AlbumActionResolver";
import {
  ActionSessionAccess,
  ActionSessionHandle,
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
  LibraryActionAnchor,
} from "./BrowseSessionCoordinator";
import { RoonTimeoutError } from "./errors";

const DEFAULT_RESOLVING_TTL_MS = 30_000;
const DEFAULT_CHOOSING_TTL_MS = 30_000;
const DEFAULT_REQUEST_TOMBSTONE_LIMIT = 256;
const MAX_TTL_MS = 5 * 60_000;
const MAX_TOMBSTONES = 4_096;
const CONTROL_CHARACTER = /\p{Cc}/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const OPAQUE_ID_MAX_LENGTH = 128;
const ID_ATTEMPTS = 32;
const ALBUM_ACTION_HIERARCHIES: readonly AlbumActionBrowseHierarchy[] = [
  "search",
  "artists",
];
type Timer = ReturnType<typeof setTimeout>;

export interface AlbumActionOrigin {
  readonly coreId: string;
  readonly socketId: string;
}

export interface AlbumActionEventSink {
  resolved(event: AlbumActionResolvedEvent): void;
  failed(event: AlbumActionFailedEvent): void;
}

export interface AlbumActionBeginReservation {
  readonly ack: AlbumActionBeginAck;
  /** One-shot continuation. The socket adapter acknowledges before invoking it. */
  readonly start?: () => void;
}

export interface AlbumActionZonePort {
  getZone(zoneId: string): Zone | undefined;
}

export interface AlbumActionPageAuthority {
  readonly pageId: string;
  readonly versionId: string;
  readonly coreId: string;
  readonly socketId: string;
  readonly tabId: string;
  readonly generation: number;
  readonly albumSignature: string;
  readonly retainedItemKey: string;
  readonly source: Readonly<AlbumActionPageSource>;
}

export interface AlbumActionPagePort {
  claimSelectedVersionAction(
    origin: AlbumActionOrigin,
    input: {
      readonly pageId: string;
      readonly versionId: string;
      readonly tabId: string;
      readonly generation: number;
    }
  ): Readonly<AlbumActionPageAuthority> | null;
  isSelectedVersionActionCurrent(
    authority: Readonly<AlbumActionPageAuthority>
  ): boolean;
}

/**
 * The live library, as an action needs to see it.
 *
 * `.agents/plans/library-live-view.md` Slice 2. Two questions and nothing else:
 * what does this reference name, and is it still the reference the reader is
 * holding. Both are answered by the session that published it, because it is
 * the only thing that knows.
 */
export interface AlbumActionLibraryPort {
  resolveActionSubject(
    ref: Readonly<LibraryRowReference>
  ): Readonly<LibraryActionSubject>;
  isActionSubjectCurrent(subject: Readonly<LibraryActionSubject>): boolean;
}

export interface AlbumActionCoordinatorPort {
  acquireAction(input: {
    coreId: string;
    socketId: string;
    tabId: string;
    leaseId: string;
    zoneId: string;
    generation: number;
  }): ActionSessionHandle;
  runAction<T>(
    access: ActionSessionAccess,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T>;
  runLibraryAction<T>(
    access: ActionSessionAccess,
    anchor: LibraryActionAnchor,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T>;
  claimActionExecute(access: ActionSessionAccess): boolean;
  executeAction(
    access: ActionSessionAccess,
    options: Omit<BrowseOptions, "multiSessionKey"> & {
      multiSessionKey?: never;
    },
    onIssued: () => void
  ): Promise<BrowseResult>;
  executeLibraryAction(
    access: ActionSessionAccess,
    anchor: LibraryActionAnchor,
    options: Omit<BrowseOptions, "multiSessionKey"> & {
      multiSessionKey?: never;
    },
    onIssued: () => void
  ): Promise<BrowseResult>;
  releaseAction(access: ActionSessionAccess): Promise<void>;
  quarantineAction(access: ActionSessionAccess): void;
}

/**
 * What one operation is acting on, and therefore where it dispatches.
 *
 * A retained page and a live reference are two different kinds of authority
 * over the same question — "is this still the thing the reader is looking at?"
 * — so the operation carries whichever it was begun with and asks that one.
 * There is no third state and no fallback between them: a request addresses a
 * page or it addresses a reference.
 */
type AlbumActionAuthority =
  | { readonly kind: "page"; readonly page: Readonly<AlbumActionPageAuthority> }
  | {
      readonly kind: "reference";
      readonly subject: Readonly<LibraryActionSubject>;
    };

export interface AlbumActionServiceOptions {
  resolvingTtlMs?: number;
  choosingTtlMs?: number;
  requestTombstoneLimit?: number;
  now?: () => number;
  randomId?: () => string;
}

type OperationPhase =
  | "resolving"
  | "choosing"
  | "claimed-execute"
  | "claimed-cancel"
  | "terminal"
  | "quarantined";

interface ActionBinding {
  readonly actionId: string;
  readonly label: string;
  readonly semantic: AlbumActionSemantic;
  readonly itemKey: string;
  /** Browse hierarchy this itemKey resolves within; required for execution. */
  readonly hierarchy: AlbumActionBrowseHierarchy;
}

interface AlbumActionOperation {
  readonly origin: AlbumActionOrigin;
  readonly request: AlbumActionBeginRequest;
  readonly operationId: string;
  readonly resolvingDeadlineAt: number;
  readonly topologyFingerprint: string;
  readonly access: ActionSessionAccess;
  readonly sink: AlbumActionEventSink;
  readonly authority: AlbumActionAuthority;
  phase: OperationPhase;
  timer?: Timer;
  started: boolean;
  resolutionInFlight: boolean;
  closed: boolean;
  executeIssued: boolean;
  coreInvalidated: boolean;
  choosingDeadlineAt?: number;
  actions: ActionBinding[];
}

class AlbumActionPhaseError extends Error {
  public constructor(
    public readonly code: AlbumActionFailureCode,
    message: string
  ) {
    super(message);
    this.name = "AlbumActionPhaseError";
    Object.setPrototypeOf(this, AlbumActionPhaseError.prototype);
  }
}

/**
 * Owns the server-side two-phase album-action state machine.
 * Raw Roon keys stay only in ActionBinding and are invalidated at every
 * terminal transition; clients receive opaque one-use action IDs instead.
 */
export class AlbumActionService {
  private readonly resolvingTtlMs: number;
  private readonly choosingTtlMs: number;
  private readonly requestTombstoneLimit: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly operations = new Map<string, AlbumActionOperation>();
  private readonly requests = new Map<string, AlbumActionOperation>();
  private readonly actions = new Map<string, AlbumActionOperation>();
  private readonly requestTombstones = new Map<string, true>();
  private idNonce = 0;
  private stopped = false;

  public constructor(
    private readonly coordinator: AlbumActionCoordinatorPort,
    private readonly pages: AlbumActionPagePort,
    private readonly zones: AlbumActionZonePort,
    private readonly resolver: AlbumActionResolverPort,
    private readonly logger: Logger,
    private readonly library: AlbumActionLibraryPort,
    options: AlbumActionServiceOptions = {}
  ) {
    this.resolvingTtlMs =
      options.resolvingTtlMs ?? DEFAULT_RESOLVING_TTL_MS;
    this.choosingTtlMs = options.choosingTtlMs ?? DEFAULT_CHOOSING_TTL_MS;
    this.requestTombstoneLimit =
      options.requestTombstoneLimit ?? DEFAULT_REQUEST_TOMBSTONE_LIMIT;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.validateOptions();
  }

  /**
   * Take the authority a request addresses, or refuse.
   *
   * A page request claims its retained version, exactly as before. A reference
   * request resolves against the live library, which refuses `STALE_GENERATION`
   * when the snapshot behind the reference has been retired — and that refusal
   * is turned into a rejected begin, reported to the reader, never a quiet
   * fallback to some other row.
   */
  private claimAuthority(
    origin: AlbumActionOrigin,
    request: AlbumActionBeginRequest
  ): AlbumActionAuthority | null {
    if (isAlbumActionReferenceRequest(request)) {
      try {
        return {
          kind: "reference",
          subject: this.library.resolveActionSubject(request.ref),
        };
      } catch (error) {
        if (
          error instanceof BrowseSessionCoordinatorError &&
          (error.code === "STALE_GENERATION" || error.code === "SESSION_LOST")
        ) {
          return null;
        }
        throw error;
      }
    }
    const page = this.pages.claimSelectedVersionAction(origin, {
      pageId: request.pageId,
      versionId: request.versionId,
      tabId: request.tabId,
      generation: request.generation,
    });
    return page ? { kind: "page", page } : null;
  }

  /** Whether the thing this operation is acting on is still the live one. */
  private authorityCurrent(operation: AlbumActionOperation): boolean {
    return operation.authority.kind === "reference"
      ? this.library.isActionSubjectCurrent(operation.authority.subject)
      : this.pages.isSelectedVersionActionCurrent(operation.authority.page);
  }

  public begin(
    origin: AlbumActionOrigin,
    value: unknown,
    sink: AlbumActionEventSink
  ): AlbumActionBeginReservation {
    if (this.stopped || !this.validOrigin(origin) || !this.validSink(sink)) {
      return this.beginRejected("INVALID_REQUEST", "Invalid album action request");
    }
    const request = normalizeAlbumActionBeginRequest(value);
    if (!request) {
      return this.beginRejected("INVALID_REQUEST", "Invalid album action request");
    }

    const requestKey = this.requestKey(origin.socketId, request.requestId);
    if (this.requests.has(requestKey) || this.requestTombstones.has(requestKey)) {
      return this.beginRejected(
        "REQUEST_ID_CONFLICT",
        "The album action request ID was already used"
      );
    }

    const zone = this.zones.getZone(request.zoneId);
    const topologyFingerprint = zone
      ? this.zoneTopologyFingerprint(zone, request.zoneId)
      : null;
    if (!topologyFingerprint) {
      return this.beginRejected("ZONE_NOT_FOUND", "The target zone is unavailable");
    }
    const authority = this.claimAuthority(origin, request);
    if (!authority) {
      return this.beginRejected(
        "SESSION_LOST",
        isAlbumActionReferenceRequest(request)
          ? "That row is no longer part of the current library"
          : "The selected album version is no longer current"
      );
    }

    let operationId: string;
    try {
      operationId = this.uniqueOpaqueId();
    } catch {
      return this.beginRejected(
        "BACKPRESSURE",
        "Album action identifiers are temporarily unavailable"
      );
    }

    let handle: ActionSessionHandle;
    try {
      handle = this.coordinator.acquireAction({
        coreId: origin.coreId,
        socketId: origin.socketId,
        tabId: request.tabId,
        leaseId: operationId,
        zoneId: request.zoneId,
        generation: request.generation,
      });
    } catch (error) {
      if (error instanceof BrowseSessionCoordinatorError) {
        if (error.code === "BACKPRESSURE") {
          return this.beginRejected(
            "BACKPRESSURE",
            "Album action capacity is full"
          );
        }
        if (
          error.code === "STALE_GENERATION" ||
          error.code === "SESSION_LOST"
        ) {
          return this.beginRejected(
            "SESSION_LOST",
            "The browse session is no longer current"
          );
        }
      }
      return this.beginRejected(
        "INVALID_REQUEST",
        "The browse session cannot own this album action"
      );
    }

    const resolvingDeadlineAt = this.now() + this.resolvingTtlMs;
    const operation: AlbumActionOperation = {
      origin: Object.freeze({ ...origin }),
      request,
      operationId,
      resolvingDeadlineAt,
      topologyFingerprint,
      access: Object.freeze({
        coreId: origin.coreId,
        socketId: origin.socketId,
        tabId: request.tabId,
        handle,
      }),
      sink,
      authority,
      phase: "resolving",
      started: false,
      resolutionInFlight: false,
      closed: false,
      executeIssued: false,
      coreInvalidated: false,
      actions: [],
    };
    this.operations.set(operationId, operation);
    this.requests.set(requestKey, operation);
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

  public cancel(
    origin: AlbumActionOrigin,
    value: unknown
  ): AlbumActionCancelAck {
    if (!this.validOrigin(origin)) return this.invalidCancelAck();
    const request = normalizeAlbumActionCancelRequest(value);
    if (!request) return this.invalidCancelAck();
    const operation = this.operationForCancel(origin, request);
    if (!operation) {
      return { success: true, data: { claimed: false } };
    }
    return {
      success: true,
      data: { claimed: this.claimCancel(operation, true) },
    };
  }

  public async execute(
    origin: AlbumActionOrigin,
    value: unknown
  ): Promise<AlbumActionExecuteAck> {
    if (!this.validOrigin(origin)) return this.invalidExecuteAck();
    const request = normalizeAlbumActionExecuteRequest(value);
    if (!request) return this.invalidExecuteAck();
    const operation = this.actions.get(request.actionId);
    if (
      !operation ||
      operation.closed ||
      operation.phase !== "choosing" ||
      !this.sameOrigin(operation, origin)
    ) {
      return { success: true, data: { claimed: false } };
    }

    const choosingDeadlineAt = operation.choosingDeadlineAt;
    if (!choosingDeadlineAt || this.now() > choosingDeadlineAt) {
      this.expireChoosing(operation);
      return { success: true, data: { claimed: false } };
    }
    if (!this.authorityCurrent(operation)) {
      this.close(operation, false);
      return this.executeRejected(
        "ALBUM_UNRESOLVED",
        "The selected album version is no longer current"
      );
    }

    let coordinatorClaimed = false;
    try {
      coordinatorClaimed = this.coordinator.claimActionExecute(operation.access);
    } catch (error) {
      this.logCoordinatorFailure(
        "claim album action execute",
        operation,
        error
      );
    }
    if (!coordinatorClaimed) {
      this.close(operation, false);
      this.emitFailure(
        operation,
        "SESSION_LOST",
        "The album action session is no longer available"
      );
      return { success: true, data: { claimed: false } };
    }

    operation.phase = "claimed-execute";
    this.clearOperationTimer(operation);
    this.invalidateActionIds(operation);
    const binding = operation.actions.find(
      (candidate) => candidate.actionId === request.actionId
    );
    if (!binding) {
      this.close(operation, false);
      return this.executeRejected(
        "ACTION_UNAVAILABLE",
        "The selected album action is unavailable"
      );
    }

    const currentZone = this.zones.getZone(operation.request.zoneId);
    if (!currentZone) {
      this.close(operation, false);
      return this.executeRejected("ZONE_NOT_FOUND", "The target zone disappeared");
    }
    if (
      this.zoneTopologyFingerprint(currentZone, operation.request.zoneId) !==
      operation.topologyFingerprint
    ) {
      this.close(operation, false);
      return this.executeRejected(
        "ZONE_CHANGED",
        "The target zone grouping changed"
      );
    }
    if (!this.authorityCurrent(operation)) {
      this.close(operation, false);
      return this.executeRejected(
        "ALBUM_UNRESOLVED",
        "The selected album version changed before execution"
      );
    }
    try {
      const dispatchOptions = {
        hierarchy: binding.hierarchy,
        zoneId: operation.request.zoneId,
        itemKey: binding.itemKey,
      };
      const onIssued = (): void => {
        operation.executeIssued = true;
      };
      // The leaf's key belongs to whichever session found it, so the dispatch
      // goes back to that session. For a live reference that is the library
      // channel, anchored to the publication the reference was minted in — a
      // refresh landing between the claim and here refuses the call rather
      // than sending a key whose meaning has expired.
      await (operation.authority.kind === "reference"
        ? this.coordinator.executeLibraryAction(
            operation.access,
            operation.authority.subject.anchor,
            dispatchOptions,
            onIssued
          )
        : this.coordinator.executeAction(
            operation.access,
            dispatchOptions,
            onIssued
          ));
      if (
        !operation.executeIssued ||
        operation.coreInvalidated ||
        this.stopped
      ) {
        this.close(operation, operation.executeIssued);
        return this.executeUnknown();
      }
      this.close(operation, false);
      return { success: true, data: { claimed: true, outcome: "executed" } };
    } catch (error) {
      if (operation.executeIssued) {
        this.close(operation, true);
        return this.executeUnknown();
      }
      this.logger.debug(
        { err: error, operationId: operation.operationId },
        "Album action failed before native dispatch"
      );
      this.close(operation, false);
      return this.executeRejected(
        "ACTION_UNAVAILABLE",
        "The selected album action could not be dispatched"
      );
    }
  }

  /** Atomically claims all cancelable operations before coordinator disconnect. */
  public disconnectSocket(socketId: string): void {
    for (const operation of [...this.operations.values()]) {
      if (operation.origin.socketId === socketId) {
        this.claimCancel(operation, false);
      }
    }
  }

  /** Runs before coordinator Core invalidation so uncertain work is quarantined. */
  public invalidateCore(coreId: string): void {
    for (const operation of [...this.operations.values()]) {
      if (operation.origin.coreId !== coreId || operation.closed) continue;
      if (operation.phase === "claimed-execute") {
        operation.coreInvalidated = true;
        if (operation.executeIssued) this.close(operation, true);
        continue;
      }
      if (operation.phase === "resolving" || operation.phase === "choosing") {
        const quarantine =
          operation.phase === "resolving" && operation.resolutionInFlight;
        this.close(operation, quarantine);
        this.emitFailure(
          operation,
          "SESSION_LOST",
          "The Roon Core session was lost"
        );
      }
    }
  }

  public shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const operation of [...this.operations.values()]) {
      if (operation.closed) continue;
      if (operation.phase === "claimed-execute") {
        operation.coreInvalidated = true;
        this.close(operation, operation.executeIssued);
      } else {
        this.close(
          operation,
          operation.phase === "resolving" && operation.resolutionInFlight
        );
      }
    }
  }

  private startResolution(operation: AlbumActionOperation): void {
    if (
      operation.closed ||
      operation.started ||
      operation.phase !== "resolving"
    ) {
      return;
    }
    if (this.now() >= operation.resolvingDeadlineAt) {
      this.expireResolving(operation);
      return;
    }
    operation.started = true;
    void this.resolveOperation(operation);
  }

  /**
   * Ask Roon what can be done with the thing this operation names.
   *
   * Two sources, two paths, dispatched on the operation's own authority and
   * never on anything read off a wire. A collection page re-walks the drill its
   * row came from; a live reference is already the row, and only has to be
   * browsed with a zone bound. Nothing here ever reads another surface's
   * identity.
   *
   * WHERE EACH ONE RUNS, AND WHY IT DIFFERS. The page source runs on the action
   * lease's own channel, because it finds its album by walking Roon from a root
   * and any session can do that. The reference source runs on the library
   * channel that minted it, because a Roon item key means nothing off the
   * session it came from — and it runs there anchored to that channel's
   * publication generation, so a snapshot retired mid-resolution refuses rather
   * than resolves against whatever the key now names.
   */
  private resolveAgainstAuthority(
    operation: AlbumActionOperation
  ): Promise<ResolvedAlbumActions> {
    const authority = operation.authority;
    if (authority.kind === "reference") {
      return this.coordinator.runLibraryAction(
        operation.access,
        authority.subject.anchor,
        (session) =>
          this.resolver.resolveReference(
            this.guardedResolutionSession(operation, session),
            {
              itemKey: authority.subject.itemKey,
              hierarchy: this.referenceHierarchy(authority.subject),
              title: authority.subject.title,
            },
            operation.request.zoneId
          )
      );
    }
    const page = authority.page;
    const request = operation.request;
    const track = isAlbumActionReferenceRequest(request)
      ? undefined
      : request.track;
    return this.coordinator.runAction(operation.access, (session) =>
      this.resolver.resolveCollectionVersion(
        this.guardedResolutionSession(operation, session),
        page.source.source,
        operation.request.zoneId,
        track
      )
    );
  }

  /**
   * The hierarchy a live reference's action leaves must be executed against.
   *
   * The library publishes references on the four hierarchies it reads — Roon's
   * Artists, Albums, Genres and Composers roots — and a leaf found under one is
   * only meaningful there. Anything else is a shape this service does not know
   * how to execute, and it is refused rather than guessed at.
   */
  private referenceHierarchy(
    subject: Readonly<LibraryActionSubject>
  ): AlbumActionBrowseHierarchy {
    if (
      subject.hierarchy === "artists" ||
      subject.hierarchy === "albums" ||
      subject.hierarchy === "genres" ||
      subject.hierarchy === "composers"
    ) {
      return subject.hierarchy;
    }
    throw new AlbumActionResolutionError(
      "ACTION_PATH_NOT_FOUND",
      "That row is not on a hierarchy this controller can act on"
    );
  }

  private async resolveOperation(operation: AlbumActionOperation): Promise<void> {
    try {
      this.assertResolutionAuthority(operation);
      operation.resolutionInFlight = true;
      const resolved = await this.resolveAgainstAuthority(operation);
      operation.resolutionInFlight = false;
      if (operation.closed || operation.phase !== "resolving") return;
      if (this.now() > operation.resolvingDeadlineAt) {
        this.expireResolving(operation);
        return;
      }
      this.assertResolutionAuthority(operation);
      const bindings = this.bindResolvedActions(
        resolved.actions,
        this.executableHierarchies(operation)
      );
      this.enterChoosing(operation, bindings);
    } catch (error) {
      operation.resolutionInFlight = false;
      if (operation.closed || operation.phase !== "resolving") return;
      if (error instanceof RoonTimeoutError) {
        this.close(operation, true);
        this.emitFailure(
          operation,
          "RESOLUTION_TIMEOUT",
          "Album action resolution timed out"
        );
        return;
      }
      if (
        error instanceof BrowseSessionCoordinatorError &&
        (error.code === "STALE_GENERATION" || error.code === "SESSION_LOST")
      ) {
        this.close(operation, true);
        this.emitFailure(
          operation,
          "SESSION_LOST",
          "The album action session was lost"
        );
        return;
      }
      const failure = this.resolutionFailure(error);
      this.close(operation, false);
      this.emitFailure(operation, failure.code, failure.message);
    }
  }

  private enterChoosing(
    operation: AlbumActionOperation,
    bindings: ActionBinding[]
  ): void {
    if (operation.closed || operation.phase !== "resolving") return;
    this.clearOperationTimer(operation);
    operation.actions = bindings;
    operation.choosingDeadlineAt = this.now() + this.choosingTtlMs;
    operation.phase = "choosing";
    for (const binding of bindings) this.actions.set(binding.actionId, operation);
    this.armChoosingTimer(operation);
    const event: AlbumActionResolvedEvent = Object.freeze({
      requestId: operation.request.requestId,
      operationId: operation.operationId,
      generation: operation.request.generation,
      choosingDeadlineAt: operation.choosingDeadlineAt,
      actions: Object.freeze(
        bindings.map((binding) =>
          Object.freeze({
            actionId: binding.actionId,
            label: binding.label,
            semantic: binding.semantic,
          })
        )
      ),
    });
    try {
      operation.sink.resolved(event);
    } catch (error) {
      this.logger.warn(
        { err: error, operationId: operation.operationId },
        "Album action resolved sink failed"
      );
    }
  }

  /**
   * The hierarchies this operation's leaves are allowed to have come from.
   *
   * For a live reference it is exactly one — the hierarchy the reference itself
   * was published on — which is stricter than a fixed list could be: a leaf
   * that surfaced on any other hierarchy is not the row the reader clicked. The
   * page sources keep the list they have always had, unchanged.
   */
  private executableHierarchies(
    operation: AlbumActionOperation
  ): readonly AlbumActionBrowseHierarchy[] {
    return operation.authority.kind === "reference"
      ? [this.referenceHierarchy(operation.authority.subject)]
      : ALBUM_ACTION_HIERARCHIES;
  }

  private bindResolvedActions(
    resolved: readonly ResolvedAlbumAction[],
    allowedHierarchies: readonly AlbumActionBrowseHierarchy[]
  ): ActionBinding[] {
    if (resolved.length === 0 || resolved.length > ALBUM_ACTION_MAX_CHOICES) {
      throw new AlbumActionResolutionError(
        "NO_SUPPORTED_ACTIONS",
        "Roon returned no bounded album actions"
      );
    }
    const labels = new Set<string>();
    const itemKeys = new Set<string>();
    const actionIds = new Set<string>();
    const bindings: ActionBinding[] = [];
    for (const action of resolved) {
      if (
        typeof action.label !== "string" ||
        action.label.length === 0 ||
        action.label.length > ALBUM_ACTION_LABEL_MAX_LENGTH ||
        action.label.trim() !== action.label ||
        CONTROL_CHARACTER.test(action.label) ||
        !ALBUM_ACTION_SEMANTICS.includes(action.semantic) ||
        typeof action.itemKey !== "string" ||
        action.itemKey.length === 0 ||
        !allowedHierarchies.includes(action.hierarchy) ||
        labels.has(action.label) ||
        itemKeys.has(action.itemKey)
      ) {
        throw new AlbumActionResolutionError(
          "NO_SUPPORTED_ACTIONS",
          "Roon returned ambiguous album actions"
        );
      }
      const actionId = this.uniqueOpaqueId(actionIds);
      labels.add(action.label);
      itemKeys.add(action.itemKey);
      actionIds.add(actionId);
      bindings.push(
        Object.freeze({
          actionId,
          label: action.label,
          semantic: action.semantic,
          itemKey: action.itemKey,
          hierarchy: action.hierarchy,
        })
      );
    }
    return bindings;
  }

  private claimCancel(
    operation: AlbumActionOperation,
    emitFailure: boolean
  ): boolean {
    if (
      operation.closed ||
      (operation.phase !== "resolving" && operation.phase !== "choosing")
    ) {
      return false;
    }
    const quarantine =
      operation.phase === "resolving" && operation.resolutionInFlight;
    operation.phase = "claimed-cancel";
    this.close(operation, quarantine);
    if (emitFailure) {
      this.emitFailure(operation, "CANCELED", "The album action was canceled");
    }
    return true;
  }

  private expireResolving(operation: AlbumActionOperation): void {
    if (operation.closed || operation.phase !== "resolving") return;
    if (this.now() < operation.resolvingDeadlineAt) {
      this.armResolvingTimer(operation);
      return;
    }
    this.close(operation, operation.resolutionInFlight);
    this.emitFailure(
      operation,
      "RESOLUTION_TIMEOUT",
      "Album action resolution timed out"
    );
  }

  private expireChoosing(operation: AlbumActionOperation): void {
    if (operation.closed || operation.phase !== "choosing") return;
    const deadline = operation.choosingDeadlineAt;
    if (deadline && this.now() < deadline) {
      this.armChoosingTimer(operation);
      return;
    }
    this.close(operation, false);
    this.emitFailure(
      operation,
      "CANCELED",
      "The album action choices expired"
    );
  }

  private close(operation: AlbumActionOperation, quarantine: boolean): void {
    if (operation.closed) return;
    operation.closed = true;
    operation.phase = quarantine ? "quarantined" : "terminal";
    this.clearOperationTimer(operation);
    this.invalidateActionIds(operation);
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
    this.addRequestTombstone(requestKey);
    if (quarantine) {
      try {
        this.coordinator.quarantineAction(operation.access);
      } catch (error) {
        this.logCoordinatorFailure("quarantine album action", operation, error);
      }
    } else {
      try {
        void Promise.resolve(this.coordinator.releaseAction(operation.access)).catch(
          (error: unknown) => {
            this.logCoordinatorFailure("release album action", operation, error);
          }
        );
      } catch (error) {
        this.logCoordinatorFailure("release album action", operation, error);
      }
    }
  }

  private invalidateActionIds(operation: AlbumActionOperation): void {
    for (const binding of operation.actions) {
      if (this.actions.get(binding.actionId) === operation) {
        this.actions.delete(binding.actionId);
      }
    }
  }

  private guardedResolutionSession(
    operation: AlbumActionOperation,
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
    operation: AlbumActionOperation,
    call: () => Promise<T>
  ): Promise<T> {
    this.assertResolutionAuthority(operation);
    const result = await call();
    this.assertResolutionAuthority(operation);
    return result;
  }

  private assertResolutionAuthority(operation: AlbumActionOperation): void {
    const currentZone = this.zones.getZone(operation.request.zoneId);
    if (!currentZone) {
      throw new AlbumActionPhaseError(
        "ZONE_NOT_FOUND",
        "The target zone disappeared during album action resolution"
      );
    }
    if (
      this.zoneTopologyFingerprint(currentZone, operation.request.zoneId) !==
      operation.topologyFingerprint
    ) {
      throw new AlbumActionPhaseError(
        "ZONE_CHANGED",
        "The target zone grouping changed during album action resolution"
      );
    }
    if (!this.authorityCurrent(operation)) {
      throw new AlbumActionPhaseError(
        "SESSION_LOST",
        "The selected album version changed during action resolution"
      );
    }
  }

  private zoneTopologyFingerprint(zone: Zone, expectedZoneId: string): string | null {
    if (zone.zone_id !== expectedZoneId) return null;
    const outputIds = (zone.outputs ?? []).map((output) => output.output_id);
    if (
      outputIds.some(
        (outputId) => typeof outputId !== "string" || outputId.length === 0
      )
    ) {
      return null;
    }
    return JSON.stringify([
      zone.zone_id,
      [...new Set(outputIds)].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      ),
    ]);
  }

  private operationForCancel(
    origin: AlbumActionOrigin,
    request: AlbumActionCancelRequest
  ): AlbumActionOperation | undefined {
    const operation =
      "requestId" in request
        ? this.requests.get(this.requestKey(origin.socketId, request.requestId))
        : this.operations.get(request.operationId);
    return operation && this.sameOrigin(operation, origin) ? operation : undefined;
  }

  private sameOrigin(
    operation: AlbumActionOperation,
    origin: AlbumActionOrigin
  ): boolean {
    return (
      operation.origin.coreId === origin.coreId &&
      operation.origin.socketId === origin.socketId
    );
  }

  private requestKey(socketId: string, requestId: string): string {
    return `${socketId}\u0000${requestId}`;
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

  private uniqueOpaqueId(additional = new Set<string>()): string {
    if (this.idNonce >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Album action identifier space is exhausted");
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
        !additional.has(candidate) &&
        !this.operations.has(candidate) &&
        !this.actions.has(candidate)
      ) {
        this.idNonce = nextNonce;
        return candidate;
      }
    }
    throw new Error("Unable to allocate a unique opaque album action ID");
  }

  private armResolvingTimer(operation: AlbumActionOperation): void {
    this.clearOperationTimer(operation);
    const remaining = Math.max(0, operation.resolvingDeadlineAt - this.now());
    operation.timer = this.unrefTimer(
      setTimeout(() => this.expireResolving(operation), remaining)
    );
  }

  private armChoosingTimer(operation: AlbumActionOperation): void {
    this.clearOperationTimer(operation);
    const deadline = operation.choosingDeadlineAt ?? this.now();
    const remaining = Math.max(0, deadline - this.now());
    operation.timer = this.unrefTimer(
      setTimeout(() => this.expireChoosing(operation), remaining)
    );
  }

  private clearOperationTimer(operation: AlbumActionOperation): void {
    if (operation.timer !== undefined) clearTimeout(operation.timer);
    operation.timer = undefined;
  }

  private unrefTimer(timer: Timer): Timer {
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return timer;
  }

  private emitFailure(
    operation: AlbumActionOperation,
    code: AlbumActionFailureCode,
    message: string
  ): void {
    const event: AlbumActionFailedEvent = Object.freeze({
      requestId: operation.request.requestId,
      operationId: operation.operationId,
      generation: operation.request.generation,
      resolvingDeadlineAt: operation.resolvingDeadlineAt,
      error: message,
      code,
    });
    try {
      operation.sink.failed(event);
    } catch (error) {
      this.logger.warn(
        { err: error, operationId: operation.operationId },
        "Album action failed sink failed"
      );
    }
  }

  private resolutionFailure(error: unknown): {
    code: AlbumActionFailureCode;
    message: string;
  } {
    if (error instanceof AlbumActionPhaseError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof AlbumActionResolutionError) {
      return {
        code: error.code,
        message: {
          ALBUM_NOT_FOUND: "The album could not be resolved",
          ALBUM_AMBIGUOUS: "The album edition is ambiguous",
          ALBUM_CHANGED: "The selected album version changed",
          TRACK_NOT_FOUND: "The selected track no longer exists on the album",
          TRACK_MISMATCH: "The selected track no longer matches the album",
          ACTION_PATH_NOT_FOUND: "No exact album action path was found",
          NO_SUPPORTED_ACTIONS: "No supported album actions were found",
        }[error.code],
      };
    }
    return {
      code: "INTERNAL_ERROR",
      message: "Album action resolution failed",
    };
  }

  private beginRejected(
    code:
      | "INVALID_REQUEST"
      | "ZONE_NOT_FOUND"
      | "BACKPRESSURE"
      | "REQUEST_ID_CONFLICT"
      | "SESSION_LOST",
    error: string
  ): AlbumActionBeginReservation {
    return Object.freeze({ ack: Object.freeze({ success: false, code, error }) });
  }

  private executeRejected(
    code:
      | "ZONE_NOT_FOUND"
      | "ZONE_CHANGED"
      | "ALBUM_UNRESOLVED"
      | "ACTION_UNAVAILABLE"
      | "EXPIRED",
    error: string
  ): AlbumActionExecuteAck {
    return { success: true, data: { claimed: true, outcome: "rejected", code, error } };
  }

  private executeUnknown(): AlbumActionExecuteAck {
    return {
      success: true,
      data: {
        claimed: true,
        outcome: "outcome-unknown",
        error: "The album action may have reached Roon; it will not be retried",
      },
    };
  }

  private invalidCancelAck(): AlbumActionCancelAck {
    return {
      success: false,
      code: "INVALID_REQUEST",
      error: "Invalid album action cancel request",
    };
  }

  private invalidExecuteAck(): AlbumActionExecuteAck {
    return {
      success: false,
      code: "INVALID_REQUEST",
      error: "Invalid album action execute request",
    };
  }

  private validOrigin(origin: AlbumActionOrigin): boolean {
    return (
      Boolean(origin) &&
      typeof origin.coreId === "string" &&
      origin.coreId.length > 0 &&
      typeof origin.socketId === "string" &&
      origin.socketId.length > 0
    );
  }

  private validSink(sink: AlbumActionEventSink): boolean {
    return (
      Boolean(sink) &&
      typeof sink.resolved === "function" &&
      typeof sink.failed === "function"
    );
  }

  private logCoordinatorFailure(
    action: string,
    operation: AlbumActionOperation,
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
    for (const [name, value] of [
      ["resolvingTtlMs", this.resolvingTtlMs],
      ["choosingTtlMs", this.choosingTtlMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TTL_MS) {
        throw new Error(`${name} must be a positive bounded safe integer`);
      }
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
