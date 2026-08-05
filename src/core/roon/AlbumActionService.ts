import { randomUUID } from "crypto";
import { Logger } from "pino";

import { CatalogSnapshot } from "../catalog/CatalogService";
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
  normalizeAlbumActionBeginRequest,
  normalizeAlbumActionCancelRequest,
  normalizeAlbumActionExecuteRequest,
} from "../../shared/albumActionContracts";
import { AlbumRef } from "../../shared/timelineCatalogContracts";
import {
  BrowseOptions,
  BrowseResult,
  Zone,
} from "../../shared/types";
import {
  AlbumActionResolutionError,
  AlbumActionResolverPort,
  ResolvedAlbumAction,
} from "./AlbumActionResolver";
import {
  ActionSessionAccess,
  ActionSessionHandle,
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
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

export interface AlbumActionCatalogPort {
  getSnapshot(coreId: string): CatalogSnapshot | null;
}

export interface AlbumActionZonePort {
  getZone(zoneId: string): Zone | undefined;
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
  claimActionExecute(access: ActionSessionAccess): boolean;
  executeAction(
    access: ActionSessionAccess,
    options: Omit<BrowseOptions, "multiSessionKey"> & {
      multiSessionKey?: never;
    },
    onIssued: () => void
  ): Promise<BrowseResult>;
  releaseAction(access: ActionSessionAccess): Promise<void>;
  quarantineAction(access: ActionSessionAccess): void;
}

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
}

interface AlbumActionOperation {
  readonly origin: AlbumActionOrigin;
  readonly request: AlbumActionBeginRequest;
  readonly operationId: string;
  readonly resolvingDeadlineAt: number;
  readonly topologyFingerprint: string;
  readonly access: ActionSessionAccess;
  readonly sink: AlbumActionEventSink;
  phase: OperationPhase;
  timer?: Timer;
  started: boolean;
  resolutionInFlight: boolean;
  closed: boolean;
  executeIssued: boolean;
  coreInvalidated: boolean;
  choosingDeadlineAt?: number;
  albumSignature?: string;
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
 * Owns the server-side two-phase Timeline album-action state machine.
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
    private readonly catalog: AlbumActionCatalogPort,
    private readonly zones: AlbumActionZonePort,
    private readonly resolver: AlbumActionResolverPort,
    private readonly logger: Logger,
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
      return error instanceof BrowseSessionCoordinatorError &&
        error.code === "BACKPRESSURE"
        ? this.beginRejected("BACKPRESSURE", "Album action capacity is full")
        : this.beginRejected(
            "INVALID_REQUEST",
            "The Timeline session cannot own this album action"
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
    const currentAlbum = this.currentResolvedAlbum(
      operation.origin.coreId,
      operation.request.albumLocalId
    );
    if (
      !currentAlbum ||
      !operation.albumSignature ||
      this.albumAuthoritySignature(currentAlbum) !== operation.albumSignature
    ) {
      this.close(operation, false);
      return this.executeRejected(
        "ALBUM_UNRESOLVED",
        "The album identity is no longer resolved"
      );
    }

    try {
      await this.coordinator.executeAction(
        operation.access,
        {
          hierarchy: "search",
          zoneId: operation.request.zoneId,
          itemKey: binding.itemKey,
        },
        () => {
          operation.executeIssued = true;
        }
      );
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

  private async resolveOperation(operation: AlbumActionOperation): Promise<void> {
    try {
      const album = this.currentResolvedAlbum(
        operation.origin.coreId,
        operation.request.albumLocalId
      );
      if (!album) {
        throw new AlbumActionResolutionError(
          "ALBUM_NOT_FOUND",
          "The album is not currently resolved"
        );
      }
      operation.albumSignature = this.albumAuthoritySignature(album);
      this.assertResolutionAuthority(operation);
      operation.resolutionInFlight = true;
      const resolved = await this.coordinator.runAction(
        operation.access,
        (session) =>
          this.resolver.resolve(
            this.guardedResolutionSession(operation, session),
            album,
            operation.request.zoneId,
            operation.request.track
          )
      );
      operation.resolutionInFlight = false;
      if (operation.closed || operation.phase !== "resolving") return;
      if (this.now() > operation.resolvingDeadlineAt) {
        this.expireResolving(operation);
        return;
      }
      this.assertResolutionAuthority(operation);
      const bindings = this.bindResolvedActions(resolved.actions);
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
        error.code === "SESSION_LOST"
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

  private bindResolvedActions(
    resolved: readonly ResolvedAlbumAction[]
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

  private currentResolvedAlbum(coreId: string, localId: string): AlbumRef | null {
    const snapshot = this.catalog.getSnapshot(coreId);
    if (!snapshot || snapshot.coreId !== coreId) return null;
    const matches = snapshot.albums.filter(
      (album) => album.localId === localId && album.coreId === coreId
    );
    if (
      matches.length !== 1 ||
      matches[0].resolutionStatus !== "resolved" ||
      !matches[0].trackTitleFingerprint
    ) {
      return null;
    }
    return matches[0];
  }

  private guardedResolutionSession(
    operation: AlbumActionOperation,
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
    const currentAlbum = this.currentResolvedAlbum(
      operation.origin.coreId,
      operation.request.albumLocalId
    );
    if (
      !currentAlbum ||
      !operation.albumSignature ||
      this.albumAuthoritySignature(currentAlbum) !== operation.albumSignature
    ) {
      throw new AlbumActionPhaseError(
        "ALBUM_NOT_FOUND",
        "The album identity changed during action resolution"
      );
    }
  }

  private albumAuthoritySignature(album: Readonly<AlbumRef>): string {
    return JSON.stringify([
      album.coreId,
      album.localId,
      album.artistLocalId ?? "",
      album.exactTitle,
      album.exactArtist,
      album.normalizedTitle,
      album.normalizedArtist,
      album.editionText,
      album.trackTitleFingerprint ?? "",
      album.resolutionStatus,
    ]);
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
    code: "INVALID_REQUEST" | "ZONE_NOT_FOUND" | "BACKPRESSURE" | "REQUEST_ID_CONFLICT",
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
