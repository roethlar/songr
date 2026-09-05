import { randomUUID } from "crypto";

import {
  BrowseItem,
  BrowseLoadOptions,
  BrowseOptions,
  BrowsePopOptions,
  BrowseResult,
} from "../../shared/types";
import { BrowseCallLifecycle, BrowseService } from "./BrowseService";
import { RoonTimeoutError } from "./errors";

export const CLASSIC_SESSION_ROLES = [
  "classic-browse",
  "classic-search",
  "classic-explore",
  // Isolated channel for the composition surface's composers walk (ri8-3).
  "classic-composition",
] as const;
export type ClassicSessionRole = (typeof CLASSIC_SESSION_ROLES)[number];
export type ModeSessionRole = ClassicSessionRole;
export type BrowseMode = "classic";

export interface BrowseSessionLimits {
  maxTabsPerCore: number;
  maxActionsPerCore: number;
  maxPhysicalSessionsPerCore: number;
  maxPublishedItemKeysPerRole: number;
  maxPublishedCatalogItemKeys: number;
  modeIdleMs: number;
  disconnectGraceMs: number;
  quarantineReapMs: number;
  retiredHandleLimit: number;
}

// Derived so a new classic role cannot silently under-provision the cap:
// per-tab classic channels, plus the catalog publication channel and its
// isolated count-check channel, plus action leases.
const DEFAULT_ACTIVE_SESSION_CAPACITY = 8 * CLASSIC_SESSION_ROLES.length + 2 + 4;

/**
 * The physical cap includes one complete active-capacity generation of
 * quarantine headroom. A stalled Core therefore cannot grow the registry
 * without bound, while one abandoned generation does not immediately prevent
 * a healthy replacement from being acquired.
 */
export const DEFAULT_BROWSE_SESSION_LIMITS: Readonly<BrowseSessionLimits> =
  Object.freeze({
    maxTabsPerCore: 8,
    maxActionsPerCore: 4,
    maxPhysicalSessionsPerCore: DEFAULT_ACTIVE_SESSION_CAPACITY * 2,
    maxPublishedItemKeysPerRole: 8_192,
    // The catalog channel publishes whole library roots at once, so its bound
    // is a library size rather than a page size. Measured on the owner's Core
    // 2026-09-03 (`.agents/state.md`): 5,584 rows for both roots cost 2.08 MB
    // of heap, about 370 bytes a row. 100,000 rows is therefore roughly 37 MB
    // held — a bound rather than a target, sized so that no real library is
    // refused and a runaway one still cannot grow the server without limit.
    maxPublishedCatalogItemKeys: 100_000,
    modeIdleMs: 15 * 60 * 1_000,
    disconnectGraceMs: 60 * 1_000,
    quarantineReapMs: 5 * 60 * 1_000,
    retiredHandleLimit: 256,
  });

export type BrowseSessionErrorCode =
  | "BACKPRESSURE"
  | "INVALID_HANDLE"
  | "OWNER_MISMATCH"
  | "STALE_GENERATION"
  | "SESSION_LOST"
  | "INVALID_ROLE";

export class BrowseSessionCoordinatorError extends Error {
  public readonly code: BrowseSessionErrorCode;
  public readonly statusCode: number;

  constructor(code: BrowseSessionErrorCode, message: string) {
    super(message);
    this.name = "BrowseSessionCoordinatorError";
    this.code = code;
    this.statusCode =
      code === "BACKPRESSURE"
        ? 429
        : code === "OWNER_MISMATCH"
          ? 403
          : code === "SESSION_LOST"
            ? 503
            : 409;
    Error.captureStackTrace(this, BrowseSessionCoordinatorError);
  }
}

export interface ModeSessionHandle {
  readonly kind: "mode";
  readonly handleId: string;
  readonly generation: number;
  readonly mode: BrowseMode;
}

export interface ModeSessionRetiredEvent {
  readonly coreId: string;
  readonly socketId: string;
  readonly tabId: string;
  readonly session: ModeSessionHandle;
  readonly reason: "SESSION_LOST";
}

export interface CatalogSessionHandle {
  readonly kind: "catalog";
  readonly handleId: string;
  readonly generation: number;
}

export interface CatalogCountSessionHandle {
  readonly kind: "catalog-count";
  readonly handleId: string;
  readonly generation: number;
}

export interface ActionSessionHandle {
  readonly kind: "action";
  readonly handleId: string;
  readonly generation: number;
}

export interface ModeSessionAccess {
  coreId: string;
  socketId: string;
  tabId: string;
  handle: ModeSessionHandle;
}

export interface ActionSessionAccess {
  coreId: string;
  socketId: string;
  tabId: string;
  handle: ActionSessionHandle;
}

/**
 * Where a set of live library references came from, and which publication they
 * belong to.
 *
 * `.agents/plans/library-live-view.md` Slice 2. An action on a live reference
 * carries this alongside its lease, because the reference alone does not say
 * enough: the item key behind it is meaningful only on the channel that minted
 * it, and only while that channel's publication generation is the one it was
 * minted in. Both facts are checked before any call is dispatched.
 */
export interface LibraryActionAnchor {
  readonly sessionScope: string;
  readonly authorityGeneration: number;
}

export type CoordinatedBrowseOptions = Omit<BrowseOptions, "multiSessionKey"> & {
  multiSessionKey?: never;
};
export type CoordinatedBrowseLoadOptions = Omit<
  BrowseLoadOptions,
  "multiSessionKey"
> & { multiSessionKey?: never };
export type CoordinatedBrowsePopOptions = Omit<
  BrowsePopOptions,
  "multiSessionKey"
> & { multiSessionKey?: never };

/** A session-key-free facade used only by server-side services. */
export interface CoordinatedBrowseSession {
  /**
   * Opaque identity of the underlying browse-session generation. Server-side
   * resolvers may key ephemeral caches on it; it must never cross a wire or a
   * persistence boundary.
   */
  readonly sessionScope: string;
  browse(options: CoordinatedBrowseOptions): Promise<BrowseResult>;
  load(options: CoordinatedBrowseLoadOptions): Promise<BrowseResult>;
  pop(options: CoordinatedBrowsePopOptions): Promise<BrowseResult>;
}

/**
 * A mode-owned browse session that can cross one exact native action boundary.
 * The assertion runs synchronously at the Roon handoff, before anything is sent.
 */
export interface CoordinatedModeActionSession
  extends CoordinatedBrowseSession {
  executeAction(
    options: CoordinatedBrowseOptions,
    assertBeforeIssue: () => void,
    onIssued: () => void
  ): Promise<BrowseResult>;
}

export interface BrowseSessionDiagnostics {
  activeTabs: number;
  classicTabs: number;
  actions: number;
  catalog: number;
  sessions: number;
  activeSessions: number;
  releasingSessions: number;
  quarantinedSessions: number;
}

type LeaseKind = "mode" | "catalog" | "catalog-count" | "action";
type LeaseState =
  | "active"
  | "disconnected"
  | "releasing"
  | "lost"
  | "closed";
type ChannelState = "active" | "releasing" | "quarantined" | "closed";
type SessionRole = ModeSessionRole | "catalog" | "catalog-count" | "action";
type Timer = ReturnType<typeof setTimeout>;

interface BaseLeaseRecord {
  kind: LeaseKind;
  coreId: string;
  coreEpoch: number;
  handleId: string;
  generation: number;
  state: LeaseState;
  lossCode?: BrowseSessionErrorCode;
  channels: Map<SessionRole, ChannelRecord>;
  pending: number;
  cleanupPromise?: Promise<void>;
}

interface ModeLeaseRecord extends BaseLeaseRecord {
  kind: "mode";
  mode: BrowseMode;
  socketId: string;
  tabId: string;
  idleTimer?: Timer;
  graceTimer?: Timer;
  lastActivity: number;
  retirementAnnounced?: boolean;
}

interface CatalogLeaseRecord extends BaseLeaseRecord {
  kind: "catalog";
}

interface CatalogCountLeaseRecord extends BaseLeaseRecord {
  kind: "catalog-count";
}

interface ActionLeaseRecord extends BaseLeaseRecord {
  kind: "action";
  leaseId: string;
  socketId: string;
  tabId: string;
  /** Zone-less leases are read-only: they can never claim an execute. */
  zoneId: string | undefined;
  executeClaimed: boolean;
  executeIssued: boolean;
}

type LeaseRecord =
  | ModeLeaseRecord
  | CatalogLeaseRecord
  | CatalogCountLeaseRecord
  | ActionLeaseRecord;

interface ChannelRecord {
  role: SessionRole;
  sessionName: string;
  owner: LeaseRecord;
  state: ChannelState;
  tail: Promise<void>;
  touchedHierarchies: Set<string>;
  closed: Promise<void>;
  resolveClosed: () => void;
  quarantineTimer?: Timer;
  quarantineCleaned: boolean;
  quarantineSettlements: number;
  publishedItemGeneration: number;
  publishedItemKeys?: PublishedItemKeyAuthority;
}

interface PublishedItemKeyAuthority {
  generation: number;
  tokenToRaw: Map<string, string>;
  rawToToken: Map<string, string>;
  tokenToItem: Map<string, BrowseItem & { itemKey: string }>;
  orderedTokens: string[];
  pageProof?: ClassicPublishedPageProof;
}

export interface ClassicPublishedItemBinding {
  readonly authorityGeneration: number;
  readonly item: BrowseItem & { itemKey: string };
}

export interface ClassicPublishedPageProof {
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly level: number;
}

interface CoreRegistry {
  coreId: string;
  epoch: number;
  tabs: Map<string, ModeLeaseRecord>;
  catalog?: CatalogLeaseRecord;
  catalogCount?: CatalogCountLeaseRecord;
  actions: Map<string, ActionLeaseRecord>;
  sessions: Set<ChannelRecord>;
}

interface RetiredHandle {
  coreId: string;
  generation: number;
  code: BrowseSessionErrorCode;
}

export interface BrowseSessionCoordinatorOptions {
  limits?: Partial<BrowseSessionLimits>;
  randomId?: () => string;
  now?: () => number;
}

class CoordinatedBrowseSessionImpl implements CoordinatedModeActionSession {
  private tail: Promise<void> = Promise.resolve();
  private actionAttempted = false;
  public readonly sessionScope: string;

  constructor(
    private readonly browseService: BrowseService,
    private readonly channel: ChannelRecord,
    private readonly lifecycle: BrowseCallLifecycle,
    private readonly assertUsable: () => void,
    private readonly validateOptions: (options: {
      hierarchy: string;
      zoneId?: string;
    }) => void = () => undefined
  ) {
    this.sessionScope = channel.sessionName;
  }

  public browse(options: CoordinatedBrowseOptions): Promise<BrowseResult> {
    return this.enqueue(options, () =>
      this.browseService.browse(
        { ...options, multiSessionKey: this.channel.sessionName },
        this.lifecycle
      )
    );
  }

  public load(options: CoordinatedBrowseLoadOptions): Promise<BrowseResult> {
    return this.enqueue(options, () =>
      this.browseService.load(
        { ...options, multiSessionKey: this.channel.sessionName },
        this.lifecycle
      )
    );
  }

  public pop(options: CoordinatedBrowsePopOptions): Promise<BrowseResult> {
    return this.enqueue(options, () =>
      this.browseService.pop(
        { ...options, multiSessionKey: this.channel.sessionName },
        this.lifecycle
      )
    );
  }

  public executeAction(
    options: CoordinatedBrowseOptions,
    assertBeforeIssue: () => void,
    onIssued: () => void
  ): Promise<BrowseResult> {
    if (
      typeof assertBeforeIssue !== "function" ||
      typeof onIssued !== "function"
    ) {
      return Promise.reject(
        new BrowseSessionCoordinatorError(
          "INVALID_HANDLE",
          "Mode action callbacks are invalid"
        )
      );
    }
    return this.enqueue(options, () => {
      if (this.actionAttempted) {
        throw new BrowseSessionCoordinatorError(
          "STALE_GENERATION",
          "The mode action session already attempted an execute"
        );
      }
      this.actionAttempted = true;
      let issued = false;
      return this.browseService.browse(
        { ...options, multiSessionKey: this.channel.sessionName },
        {
          ...this.lifecycle,
          onIssued: () => {
            if (issued) return;
            assertBeforeIssue();
            onIssued();
            issued = true;
          },
        }
      );
    });
  }

  public drain(): Promise<void> {
    return this.tail;
  }

  private enqueue<T extends { hierarchy: string }, R>(
    options: T,
    operation: () => Promise<R>
  ): Promise<R> {
    const task = this.tail.then(async () => {
      if (Object.prototype.hasOwnProperty.call(options, "multiSessionKey")) {
        throw new BrowseSessionCoordinatorError(
          "INVALID_HANDLE",
          "Coordinated browse options cannot contain a session key"
        );
      }
      this.validateOptions(options);
      this.assertUsable();
      this.channel.touchedHierarchies.add(options.hierarchy);
      const result = await operation();
      this.assertUsable();
      return result;
    });
    this.tail = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }
}

/**
 * Owns every new coordinated Roon browse session. The class deliberately has
 * no Socket.IO or HTTP dependency: later integration slices can expose opaque
 * handles without ever exposing the raw multi_session_key.
 */
export class BrowseSessionCoordinator {
  private readonly limits: BrowseSessionLimits;
  private readonly randomId: () => string;
  private readonly now: () => number;
  private readonly cores = new Map<string, CoreRegistry>();

  /**
   * Every live channel by its own session scope.
   *
   * The Classic publication path finds its channel from the caller's mode
   * lease, because a Classic result belongs to one tab's role. The catalog
   * path cannot: the catalog lease is a process-wide singleton whose work runs
   * through `runBrowse`, and the only identity that reaches a caller
   * inside that transaction is `CoordinatedBrowseSession.sessionScope`. That
   * string is already documented as server-side-only, so indexing by it lends
   * the catalog publication the same channel-bound lifetime the Classic one
   * has — including retirement on release, invalidation and shutdown, which
   * the channel already performs and neither path has to remember to do.
   */
  private readonly channelsByScope = new Map<string, ChannelRecord>();
  private readonly coreEpochs = new Map<string, number>();
  private readonly handles = new Map<string, LeaseRecord>();
  private readonly retiredHandles = new Map<string, RetiredHandle>();
  private readonly modeRetiredListeners = new Set<
    (event: ModeSessionRetiredEvent) => void
  >();
  private generation = 0;
  private nonce = 0;
  private stopped = false;

  constructor(
    private readonly browseService: BrowseService,
    options: BrowseSessionCoordinatorOptions = {}
  ) {
    this.limits = this.normalizeLimits(options.limits);
    this.randomId = options.randomId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  public onModeRetired(
    listener: (event: ModeSessionRetiredEvent) => void
  ): () => void {
    this.modeRetiredListeners.add(listener);
    return () => {
      this.modeRetiredListeners.delete(listener);
    };
  }

  public acquireMode(input: {
    coreId: string;
    socketId: string;
    tabId: string;
    mode: BrowseMode;
    /**
     * Browser reload/reconnect recovery may replace, but never preserve, a
     * disconnected same-tab, same-mode generation after the browser has lost
     * its in-memory handle. Active generations retain strict socket ownership.
     */
    replaceDisconnected?: boolean;
  }): ModeSessionHandle {
    this.assertRunning();
    this.assertIdentifier(input.coreId, "coreId");
    this.assertIdentifier(input.socketId, "socketId");
    this.assertIdentifier(input.tabId, "tabId");
    if (input.mode !== "classic") {
      throw new BrowseSessionCoordinatorError("INVALID_ROLE", "Unknown browse mode");
    }
    const core = this.getCore(input.coreId);
    const roles: readonly ModeSessionRole[] = CLASSIC_SESSION_ROLES;
    const existing = core.tabs.get(input.tabId);
    if (existing) {
      const mayReplaceDisconnected =
        input.replaceDisconnected === true &&
        existing.mode === input.mode &&
        existing.state === "disconnected";
	  if (
		(existing.state === "active" || existing.state === "disconnected") &&
		existing.mode !== input.mode
	  ) {
		throw new BrowseSessionCoordinatorError(
		  "OWNER_MISMATCH",
		  "The tab already belongs to another active mode"
		);
	  }
      if (
        (existing.state === "active" || existing.state === "disconnected") &&
        !mayReplaceDisconnected &&
        existing.socketId !== input.socketId
      ) {
        throw new BrowseSessionCoordinatorError(
          "OWNER_MISMATCH",
          "The tab already belongs to another socket"
        );
      }
    }

    if (!existing && core.tabs.size >= this.limits.maxTabsPerCore) {
      throw this.backpressure("The Core has reached its active tab limit");
    }
    this.assertPhysicalCapacity(core, roles.length);
    if (existing) {
      void this.beginReleaseLease(existing, "STALE_GENERATION", true);
    }

    const generation = this.nextGeneration();
    const lease: ModeLeaseRecord = {
      kind: "mode",
      coreId: input.coreId,
      coreEpoch: core.epoch,
      handleId: this.uniqueToken("mode-handle"),
      generation,
      state: "active",
      mode: input.mode,
      socketId: input.socketId,
      tabId: input.tabId,
      channels: new Map(),
      pending: 0,
      lastActivity: this.now(),
    };
    for (const role of roles) this.addChannel(core, lease, role);
    core.tabs.set(input.tabId, lease);
    this.handles.set(lease.handleId, lease);
    this.scheduleIdle(lease);
    return this.modeHandle(lease);
  }

  public runMode<T>(
    access: ModeSessionAccess,
    role: ModeSessionRole,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    const lease = this.resolveMode(access);
    const allowedRoles: readonly ModeSessionRole[] = CLASSIC_SESSION_ROLES;
    if (!allowedRoles.includes(role)) {
      throw new BrowseSessionCoordinatorError(
        "INVALID_ROLE",
        "The requested role is not owned by this mode"
      );
    }
    const channel = lease.channels.get(role);
    if (!channel) throw this.sessionLost("The mode session is no longer available");
    return this.runChannel(lease, channel, work, () => {
      if (lease.socketId !== access.socketId || lease.tabId !== access.tabId) {
        throw this.ownerMismatch();
      }
    });
  }

  /**
   * Run discovery, one irreversible action, and restoration on one retained
   * Classic song-authority channel without allowing another navigation
   * between them. Unified palette and row resolution deliberately share it.
   */
  public runModeAction<T>(
    access: ModeSessionAccess,
    role: "classic-search",
    work: (session: CoordinatedModeActionSession) => Promise<T>
  ): Promise<T> {
    const lease = this.resolveMode(access);
    if (lease.mode !== "classic") {
      throw new BrowseSessionCoordinatorError(
        "INVALID_ROLE",
        "Public song actions require a Classic mode generation"
      );
    }
    const channel = lease.channels.get(role);
    if (!channel) {
      throw this.sessionLost("The mode action session is no longer available");
    }
    return this.runChannel(
      lease,
      channel,
      (session) => work(session as CoordinatedModeActionSession),
      () => {
        if (lease.socketId !== access.socketId || lease.tabId !== access.tabId) {
          throw this.ownerMismatch();
        }
      }
    );
  }

  /**
   * Resolve a client-visible Classic item token only inside the exact mode
   * generation and role that published it. Raw Roon item keys never cross the
   * socket boundary.
   */
  public resolveClassicItemKey(
    access: ModeSessionAccess,
    role: ClassicSessionRole,
    token: string
  ): string {
    const channel = this.resolveClassicChannel(access, role);
    const raw = channel.publishedItemKeys?.tokenToRaw.get(token);
    if (!raw) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The Classic item key is not valid for this generation and role"
      );
    }
    return raw;
  }

  /**
   * Resolve the frozen descriptor and raw key published for one opaque
   * Classic item token. The clone prevents a caller from mutating the
   * coordinator's authority record.
   */
  public resolveClassicPublishedItem(
    access: ModeSessionAccess,
    role: ClassicSessionRole,
    token: string
  ): BrowseItem & { itemKey: string } {
    return this.resolveClassicPublishedItemBinding(access, role, token).item;
  }

  public resolveClassicPublishedItemBinding(
    access: ModeSessionAccess,
    role: ClassicSessionRole,
    token: string
  ): ClassicPublishedItemBinding {
    const channel = this.resolveClassicChannel(access, role);
    const authority = channel.publishedItemKeys;
    const item = authority?.tokenToItem.get(token);
    if (!authority || !item) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The Classic item is not valid for this generation and role"
      );
    }
    return Object.freeze({
      authorityGeneration: authority.generation,
      item: Object.freeze({ ...item }),
    });
  }

  /**
   * Synchronously retire the prior result set and reserve a publication
   * generation for one new query.
   */
  public beginClassicPublishedItems(
    access: ModeSessionAccess,
    role: ClassicSessionRole
  ): number {
    const channel = this.resolveClassicChannel(access, role);
    return this.advancePublishedItemGeneration(channel);
  }

  /** Explicit search close: invalidate both visible and still-running results. */
  public clearClassicPublishedItems(
    access: ModeSessionAccess,
    role: ClassicSessionRole
  ): void {
    const channel = this.resolveClassicChannel(access, role);
    this.advancePublishedItemGeneration(channel);
  }

  /**
   * Atomically replace one role's published-item generation.
   *
   * Used by Unified song search: a new query invalidates every result ID
   * from the previous query before any new ID becomes visible.
   */
  public replaceClassicPublishedItems(
    access: ModeSessionAccess,
    role: ClassicSessionRole,
    authorityGeneration: number,
    items: readonly BrowseItem[],
    page: Pick<BrowseResult, "title" | "subtitle" | "level">
  ): ReadonlyArray<{ token: string; item: BrowseItem }> {
    const channel = this.resolveClassicChannel(access, role);
    return this.replacePublishedItems(channel, authorityGeneration, items, {
      tokenPrefix: "classic-item",
      limit: this.limits.maxPublishedItemKeysPerRole,
      staleMessage: "A newer Classic result generation replaced this query",
      backpressureMessage:
        "The Classic result exceeds the item-key authority limit",
      // A page whose own level is not a real offset cannot serve as the proof a
      // restore checks against, so it is refused with the same backpressure
      // answer and at the same point in the sequence as an oversized page.
      alsoRefuse: !Number.isSafeInteger(page.level) || page.level < 0,
      pageProof: Object.freeze({
        title: page.title ?? null,
        subtitle: page.subtitle ?? null,
        level: page.level,
      }),
    });
  }

  /**
   * The one atomic swap both publication paths run through.
   *
   * Written once rather than twice deliberately. The properties that make a
   * published token safe — every raw key replaced before anything leaves the
   * server, the whole set installed in a single assignment, and the generation
   * re-checked AFTER the tokens are minted so a refresh that landed mid-mint
   * cannot have its retirement undone — are not properties a second copy would
   * keep by accident.
   */
  private replacePublishedItems(
    channel: ChannelRecord,
    authorityGeneration: number,
    items: readonly BrowseItem[],
    options: {
      readonly tokenPrefix: string;
      readonly limit: number;
      readonly staleMessage: string;
      readonly backpressureMessage: string;
      /** A caller-specific refusal, taken with the size check. */
      readonly alsoRefuse?: boolean;
      readonly pageProof?: ClassicPublishedPageProof;
    }
  ): ReadonlyArray<{ token: string; item: BrowseItem }> {
    if (
      !Number.isSafeInteger(authorityGeneration) ||
      authorityGeneration !== channel.publishedItemGeneration
    ) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        options.staleMessage
      );
    }
    if (
      items.length > options.limit ||
      options.alsoRefuse === true ||
      items.some(
        (item) =>
          typeof item.itemKey !== "string" || item.itemKey.length === 0
      )
    ) {
      throw this.backpressure(options.backpressureMessage);
    }
    const authority: PublishedItemKeyAuthority = {
      generation: authorityGeneration,
      tokenToRaw: new Map<string, string>(),
      rawToToken: new Map<string, string>(),
      tokenToItem: new Map<string, BrowseItem & { itemKey: string }>(),
      orderedTokens: [],
      ...(options.pageProof !== undefined
        ? { pageProof: options.pageProof }
        : {}),
    };
    const published = items.map((item) => {
      const raw = item.itemKey as string;
      const token = this.uniqueToken(options.tokenPrefix);
      const frozen = Object.freeze({ ...item, itemKey: raw });
      authority.tokenToRaw.set(token, raw);
      authority.rawToToken.set(raw, token);
      authority.tokenToItem.set(token, frozen);
      authority.orderedTokens.push(token);
      const descriptor = { ...item };
      delete descriptor.itemKey;
      return Object.freeze({ token, item: Object.freeze(descriptor) });
    });
    if (authorityGeneration !== channel.publishedItemGeneration) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        options.staleMessage
      );
    }
    channel.publishedItemKeys = authority;
    return published;
  }

  /**
   * Keep the retained result IDs only when the exact ordered raw rows are
   * still present after returning to the Tracks page.
   */
  public retainClassicPublishedItemsAfterRestore(
    access: ModeSessionAccess,
    role: ClassicSessionRole,
    authorityGeneration: number,
    restoredPage: BrowseResult
  ): boolean {
    const channel = this.resolveClassicChannel(access, role);
    const authority = channel.publishedItemKeys;
    if (
      channel.publishedItemGeneration !== authorityGeneration ||
      authority?.generation !== authorityGeneration ||
      !authority.pageProof
    ) {
      return false;
    }
    const pageMatches =
      authority.pageProof.level === restoredPage.level &&
      authority.pageProof.title === (restoredPage.title ?? null) &&
      authority.pageProof.subtitle === (restoredPage.subtitle ?? null);
    const restored = restoredPage.items.filter(
      (item): item is BrowseItem & { itemKey: string } =>
        typeof item.itemKey === "string" && item.itemKey.length > 0
    );
    const matches =
      pageMatches &&
      restored.length === authority.orderedTokens.length &&
      authority.orderedTokens.every((token, index) => {
        const retained = authority.tokenToItem.get(token);
        return Boolean(
          retained &&
            restored[index] &&
            this.samePublishedItem(retained, restored[index])
        );
      });
    if (!matches) this.advancePublishedItemGeneration(channel);
    return matches;
  }

  /**
   * Conditionally retire only the authority used by an action. A newer query's
   * result set is never cleared by cleanup from an older action.
   */
  public retireClassicPublishedItems(
    access: ModeSessionAccess,
    role: ClassicSessionRole,
    authorityGeneration: number
  ): boolean {
    const channel = this.resolveClassicChannel(access, role);
    if (channel.publishedItemGeneration !== authorityGeneration) return false;
    this.advancePublishedItemGeneration(channel);
    return true;
  }

  /** Replace every raw Roon item key with a bounded opaque role token. */
  public publishClassicBrowseResult(
    access: ModeSessionAccess,
    role: ClassicSessionRole,
    result: BrowseResult
  ): BrowseResult {
    const channel = this.resolveClassicChannel(access, role);
    const distinctRawKeys = new Set(
      result.items
        .map((item) => item.itemKey)
        .filter((itemKey): itemKey is string => typeof itemKey === "string" && itemKey.length > 0)
    );
    if (distinctRawKeys.size > this.limits.maxPublishedItemKeysPerRole) {
      throw this.backpressure("The Classic result exceeds the item-key authority limit");
    }
    return {
      ...result,
      items: result.items.map((item) =>
        item.itemKey
          ? {
              ...item,
              itemKey: this.publishClassicItemKey(
                channel,
                item.itemKey,
                item
              ),
            }
          : { ...item }
      ),
    };
  }

  // ── Catalog-session publication ──────────────────────────────────────
  //
  // The same token authority the Classic path uses, reached by session scope
  // instead of by mode lease, and restricted to the catalog role so the two
  // paths can never contend for one channel's single authority.
  //
  // `.agents/plans/library-live-view.md` Slice 1. The live library session
  // reads Roon's roots on the catalog channel and publishes every row to the
  // UI as `{ generation, token }`. Raw Roon item keys never leave the server,
  // and a refresh, a reconnect or a lost session retires every outstanding
  // reference in one step rather than row by row.

  /**
   * Retire every reference this catalog channel has published and reserve the
   * generation for the next set.
   *
   * Synchronous and total, deliberately: the reader is about to spend a second
   * or two paging Roon, and the tokens from the previous snapshot must be dead
   * for that whole interval rather than dying when the new set lands. A
   * request arriving in between is refused as stale, which is the truth — the
   * snapshot it was reading is gone.
   */
  public beginCatalogPublication(sessionScope: string): number {
    return this.advancePublishedItemGeneration(
      this.resolveCatalogChannelByScope(sessionScope)
    );
  }

  /** Atomically install one generation's published rows. */
  public replaceCatalogPublishedItems(
    sessionScope: string,
    authorityGeneration: number,
    items: readonly BrowseItem[]
  ): ReadonlyArray<{ token: string; item: BrowseItem }> {
    return this.replacePublishedItems(
      this.resolveCatalogChannelByScope(sessionScope),
      authorityGeneration,
      items,
      {
        tokenPrefix: "library-row",
        limit: this.limits.maxPublishedCatalogItemKeys,
        staleMessage:
          "A newer library generation replaced this snapshot while it was being published",
        backpressureMessage:
          "The library roots exceed the published-item authority limit",
      }
    );
  }

  /**
   * One published reference, back to the row that minted it.
   *
   * Both halves of the reference are checked. The generation is checked
   * because a token from a retired snapshot must not resolve even if a later
   * snapshot happened to mint the same string, and the token is checked
   * because a caller may hold a reference to a row this generation no longer
   * carries. Either failure is `STALE_GENERATION`: from the caller's side they
   * are the same event — the thing you were pointing at is not there any more.
   */
  public resolveCatalogPublishedItem(
    sessionScope: string,
    authorityGeneration: number,
    token: string
  ): BrowseItem & { itemKey: string } {
    const channel = this.resolveCatalogChannelByScope(sessionScope);
    const authority = channel.publishedItemKeys;
    if (
      authority === undefined ||
      channel.publishedItemGeneration !== authorityGeneration ||
      authority.generation !== authorityGeneration
    ) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The library snapshot that published this reference has been retired"
      );
    }
    const item = authority.tokenToItem.get(token);
    if (item === undefined) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The library snapshot does not carry this reference"
      );
    }
    return item;
  }

  /**
   * Publish one more level's rows into the generation that is already live.
   *
   * `.agents/plans/library-live-view.md` Slice 2. The roots are published once
   * per generation and every page opened inside that generation adds its own
   * level to the same authority, because a reference is only meaningful
   * alongside the roots reference it was reached from: an artist's albums have
   * to stay resolvable while the reader is looking at one of them, and Back
   * has to find the artist's own rows still alive.
   *
   * APPEND RATHER THAN REPLACE, and the distinction is the whole point. A
   * replace would retire the roots the moment a reader opened anything, which
   * would make every list on screen dead the instant it was used. The
   * generation still means exactly what it meant: one library snapshot, whose
   * references all die together and never one at a time.
   *
   * The generation is checked before the tokens are minted and again after,
   * the same double check `replacePublishedItems` performs and for the same
   * reason — a refresh that landed mid-mint must not have its retirement
   * quietly undone by rows published into the authority it just killed.
   */
  public appendCatalogPublishedItems(
    sessionScope: string,
    authorityGeneration: number,
    items: readonly BrowseItem[]
  ): ReadonlyArray<{ token: string; item: BrowseItem }> {
    const channel = this.resolveCatalogChannelByScope(sessionScope);
    const authority = channel.publishedItemKeys;
    if (
      !Number.isSafeInteger(authorityGeneration) ||
      channel.publishedItemGeneration !== authorityGeneration ||
      authority === undefined ||
      authority.generation !== authorityGeneration
    ) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The library snapshot that published these references has been retired"
      );
    }
    if (
      authority.orderedTokens.length + items.length >
        this.limits.maxPublishedCatalogItemKeys ||
      items.some(
        (item) => typeof item.itemKey !== "string" || item.itemKey.length === 0
      )
    ) {
      throw this.backpressure(
        "The library level exceeds the published-item authority limit"
      );
    }
    const minted = items.map((item) => {
      const raw = item.itemKey as string;
      const token = this.uniqueToken("library-row");
      const frozen = Object.freeze({ ...item, itemKey: raw });
      const descriptor = { ...item };
      delete descriptor.itemKey;
      return {
        token,
        raw,
        frozen,
        published: Object.freeze({ token, item: Object.freeze(descriptor) }),
      };
    });
    if (
      channel.publishedItemGeneration !== authorityGeneration ||
      channel.publishedItemKeys !== authority
    ) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The library snapshot that published these references has been retired"
      );
    }
    for (const entry of minted) {
      authority.tokenToRaw.set(entry.token, entry.raw);
      // First token wins: two levels can legitimately carry one Roon row (an
      // album on its artist's page and again in a genre), and the reverse map
      // exists only for the Classic dedupe path. Overwriting it here would
      // make the reverse map disagree with the forward one for no caller.
      if (!authority.rawToToken.has(entry.raw)) {
        authority.rawToToken.set(entry.raw, entry.token);
      }
      authority.tokenToItem.set(entry.token, entry.frozen);
      authority.orderedTokens.push(entry.token);
    }
    return minted.map((entry) => entry.published);
  }

  /**
   * Retire named references without touching the rest of the generation.
   *
   * The one exception to "references die together", and it is narrow on
   * purpose: it exists so the live session can bound what one generation holds
   * by dropping the levels a reader has navigated away from. A reference this
   * retires answers `STALE_GENERATION` afterwards — the same answer, and the
   * same recovery, as a reference whose whole generation died.
   *
   * Answers how many it actually retired rather than throwing on a stale
   * generation: the caller is pruning, and a generation that has already been
   * retired wholesale has nothing left for it to prune.
   */
  public retireCatalogPublishedTokens(
    sessionScope: string,
    authorityGeneration: number,
    tokens: readonly string[]
  ): number {
    const channel = this.resolveCatalogChannelByScope(sessionScope);
    const authority = channel.publishedItemKeys;
    if (
      channel.publishedItemGeneration !== authorityGeneration ||
      authority === undefined ||
      authority.generation !== authorityGeneration
    ) {
      return 0;
    }
    const retiring = new Set(tokens);
    let retired = 0;
    for (const token of retiring) {
      const raw = authority.tokenToRaw.get(token);
      if (raw === undefined) continue;
      authority.tokenToRaw.delete(token);
      authority.tokenToItem.delete(token);
      if (authority.rawToToken.get(raw) === token) {
        authority.rawToToken.delete(raw);
      }
      retired += 1;
    }
    if (retired > 0) {
      authority.orderedTokens = authority.orderedTokens.filter(
        (token) => !retiring.has(token)
      );
    }
    return retired;
  }

  /**
   * The catalog channel behind one session scope, or a refusal naming why it
   * cannot be published into.
   */
  private resolveCatalogChannelByScope(sessionScope: string): ChannelRecord {
    const channel = this.channelsByScope.get(sessionScope);
    if (channel === undefined || channel.state !== "active") {
      throw new BrowseSessionCoordinatorError(
        "SESSION_LOST",
        "The browse session that published these references is gone"
      );
    }
    if (channel.role !== "catalog") {
      // Not a caller mistake to route around: the Classic roles publish
      // through their own lease-keyed path, and one channel has exactly one
      // authority. Two publishers on one channel would silently retire each
      // other's references.
      throw new BrowseSessionCoordinatorError(
        "INVALID_ROLE",
        "Only the catalog session publishes library references"
      );
    }
    this.assertLeaseUsable(channel.owner);
    return channel;
  }

  public async releaseMode(access: ModeSessionAccess): Promise<void> {
    const lease = this.resolveMode(access, true);
    await this.beginReleaseLease(lease, "STALE_GENERATION", true);
  }

  public reconnectMode(input: {
    coreId: string;
    tabId: string;
    socketId: string;
    handle: ModeSessionHandle;
  }): ModeSessionHandle {
    this.assertIdentifier(input.socketId, "socketId");
    const lease = this.resolveLease(input.coreId, input.handle, "mode", true);
    if (lease.kind !== "mode") throw this.invalidHandle();
    if (lease.tabId !== input.tabId) throw this.ownerMismatch();
    if (lease.state !== "disconnected") {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "Only a disconnected mode lease can reconnect"
      );
    }
    this.clearTimer(lease.graceTimer);
    lease.graceTimer = undefined;
    lease.socketId = input.socketId;
    lease.state = "active";
    lease.lastActivity = this.now();
    this.scheduleIdle(lease);
    return this.modeHandle(lease);
  }

  public acquireCatalog(coreId: string): CatalogSessionHandle {
    this.assertRunning();
    this.assertIdentifier(coreId, "coreId");
    const core = this.getCore(coreId);
    if (core.catalog) {
      throw this.backpressure("The Core already has a catalog session");
    }
    this.assertPhysicalCapacity(core, 1);

    const lease: CatalogLeaseRecord = {
      kind: "catalog",
      coreId,
      coreEpoch: core.epoch,
      handleId: this.uniqueToken("catalog-handle"),
      generation: this.nextGeneration(),
      state: "active",
      channels: new Map(),
      pending: 0,
    };
    this.addChannel(core, lease, "catalog");
    core.catalog = lease;
    this.handles.set(lease.handleId, lease);
    return this.catalogHandle(lease);
  }

  /**
   * Acquire the isolated session used only to ask whether root counts moved.
   * Re-rooting this channel must never invalidate keys published by the
   * catalog channel.
   */
  public acquireCatalogCount(coreId: string): CatalogCountSessionHandle {
    this.assertRunning();
    this.assertIdentifier(coreId, "coreId");
    const core = this.getCore(coreId);
    if (core.catalogCount) {
      throw this.backpressure("The Core already has a catalog count session");
    }
    this.assertPhysicalCapacity(core, 1);

    const lease: CatalogCountLeaseRecord = {
      kind: "catalog-count",
      coreId,
      coreEpoch: core.epoch,
      handleId: this.uniqueToken("catalog-count-handle"),
      generation: this.nextGeneration(),
      state: "active",
      channels: new Map(),
      pending: 0,
    };
    this.addChannel(core, lease, "catalog-count");
    core.catalogCount = lease;
    this.handles.set(lease.handleId, lease);
    return this.catalogCountHandle(lease);
  }

  public runCatalog<T>(
    coreId: string,
    handle: CatalogSessionHandle,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    const lease = this.resolveLease(coreId, handle, "catalog");
    if (lease.kind !== "catalog") throw this.invalidHandle();
    const channel = lease.channels.get("catalog");
    if (!channel) throw this.sessionLost("The catalog session is unavailable");
    return this.runChannel(lease, channel, work);
  }

  public runCatalogCount<T>(
    coreId: string,
    handle: CatalogCountSessionHandle,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    const lease = this.resolveLease(coreId, handle, "catalog-count");
    if (lease.kind !== "catalog-count") throw this.invalidHandle();
    const channel = lease.channels.get("catalog-count");
    if (!channel) {
      throw this.sessionLost("The catalog count session is unavailable");
    }
    return this.runChannel(lease, channel, work);
  }

  public async releaseCatalogCount(
    coreId: string,
    handle: CatalogCountSessionHandle
  ): Promise<void> {
    if (this.isRetiredHandle(coreId, handle)) return;
    const lease = this.resolveLease(coreId, handle, "catalog-count", true);
    if (lease.kind !== "catalog-count") throw this.invalidHandle();
    await this.beginReleaseLease(lease, "STALE_GENERATION", true);
  }

  public async releaseCatalog(
    coreId: string,
    handle: CatalogSessionHandle
  ): Promise<void> {
    // Holder cleanup is idempotent: a lease retired by a timeout reap or an
    // invalidation before the holder released is already gone.
    if (this.isRetiredHandle(coreId, handle)) return;
    const lease = this.resolveLease(coreId, handle, "catalog", true);
    if (lease.kind !== "catalog") throw this.invalidHandle();
    await this.beginReleaseLease(lease, "STALE_GENERATION", true);
  }

  public acquireAction(input: {
    coreId: string;
    socketId: string;
    tabId: string;
    leaseId: string;
    /** Omit for a zone-less read lease; such a lease can never execute. */
    zoneId?: string;
    generation: number;
  }): ActionSessionHandle {
    this.assertRunning();
    this.assertIdentifier(input.coreId, "coreId");
    this.assertIdentifier(input.socketId, "socketId");
    this.assertIdentifier(input.tabId, "tabId");
    this.assertIdentifier(input.leaseId, "leaseId");
    if (input.zoneId !== undefined) this.assertIdentifier(input.zoneId, "zoneId");
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "Action generation must be a non-negative safe integer"
      );
    }

    const core = this.getCore(input.coreId);
    const modeLease = core.tabs.get(input.tabId);
    if (!modeLease || modeLease.state !== "active") {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The action does not belong to an active mode generation"
      );
    }
    if (modeLease.socketId !== input.socketId) throw this.ownerMismatch();
    if (modeLease.generation !== input.generation) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The action mode generation is stale"
      );
    }
    if (
      core.actions.size >= this.limits.maxActionsPerCore ||
      core.actions.has(input.leaseId)
    ) {
      throw this.backpressure("The Core has reached its action lease limit");
    }
    this.assertPhysicalCapacity(core, 1);

    const lease: ActionLeaseRecord = {
      kind: "action",
      coreId: input.coreId,
      coreEpoch: core.epoch,
      handleId: this.uniqueToken("action-handle"),
      generation: input.generation,
      state: "active",
      leaseId: input.leaseId,
      socketId: input.socketId,
      tabId: input.tabId,
      zoneId: input.zoneId,
      executeClaimed: false,
      executeIssued: false,
      channels: new Map(),
      pending: 0,
    };
    this.addChannel(core, lease, "action");
    core.actions.set(input.leaseId, lease);
    this.handles.set(lease.handleId, lease);
    return this.actionHandle(lease);
  }

  public runAction<T>(
    access: ActionSessionAccess,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    const lease = this.resolveAction(access);
    const channel = lease.channels.get("action");
    if (!channel) throw this.sessionLost("The action session is unavailable");
    return this.runChannel(lease, channel, work, () => {
      if (lease.socketId !== access.socketId || lease.tabId !== access.tabId) {
        throw this.ownerMismatch();
      }
      if (lease.executeClaimed || lease.executeIssued) {
        throw new BrowseSessionCoordinatorError(
          "STALE_GENERATION",
          "The action lease already crossed its execute boundary"
        );
      }
      this.assertActionModeCurrent(lease);
    }, (options) => this.assertActionZone(lease, options.zoneId));
  }

  /**
   * Run one action lease's resolution work on the channel that published the
   * references it is acting on, inside that channel's own serialized tail.
   *
   * `.agents/plans/library-live-view.md` Slice 2, and the one thing the live
   * album page could not do before it. A live reference names a Roon item key
   * that was minted on the library's browse session; the same string on the
   * action lease's own session names some other row, or nothing. So the work
   * has to happen where the key means something, and this is the entry point
   * that lets an action lease reach there without owning the channel.
   *
   * WHAT DOES NOT MOVE, WHICH IS EVERYTHING THAT MAKES AN ACTION SAFE. The
   * single-execute claim stays on the lease record and is asserted here
   * unconsumed. The zone gate is applied to every call the work makes, exactly
   * as it is on the lease's own channel. Quarantine-on-timeout is per-channel
   * and already fires for the catalog channel, which is the correct blast
   * radius rather than a widened one: a Roon call that may still settle must
   * not be followed by another on the same stack, and taking the library
   * channel down retires the generation, which is precisely the event every
   * open page already knows how to recover from.
   *
   * Measured against the owner's Core before it was built (2026-09-03,
   * `.agents/state.md`): an album's `Play Album` reference and a track row's
   * own reference each answer with the four action leaves when browsed with a
   * zone bound, both halves of a Roon-duplicated pair answer for themselves,
   * and the artist level re-opens identically afterwards.
   */
  public runLibraryAction<T>(
    access: ActionSessionAccess,
    anchor: LibraryActionAnchor,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    const lease = this.resolveAction(access);
    const channel = this.resolveLibraryActionChannel(anchor);
    return this.runChannel(
      lease,
      channel,
      work,
      () => {
        if (lease.socketId !== access.socketId || lease.tabId !== access.tabId) {
          throw this.ownerMismatch();
        }
        if (lease.executeClaimed || lease.executeIssued) {
          throw new BrowseSessionCoordinatorError(
            "STALE_GENERATION",
            "The action lease already crossed its execute boundary"
          );
        }
        this.assertActionModeCurrent(lease);
        // Re-checked on the tail rather than only at entry: this call may have
        // waited behind a root re-read that retired the whole snapshot.
        this.resolveLibraryActionChannel(anchor);
      },
      (options) => this.assertActionZone(lease, options.zoneId)
    );
  }

  /**
   * The library channel an anchor names, or a refusal.
   *
   * Both halves are checked. The channel must be the one that minted the
   * references — a different catalog session's keys are somebody else's rows —
   * and its publication generation must be the one they were minted in. A
   * reference from a retired snapshot is refused `STALE_GENERATION` here, which
   * is what the reader is told, rather than dispatched against whatever the key
   * happens to name now.
   */
  private resolveLibraryActionChannel(
    anchor: LibraryActionAnchor
  ): ChannelRecord {
    const channel = this.resolveCatalogChannelByScope(anchor.sessionScope);
    const authority = channel.publishedItemKeys;
    if (
      !Number.isSafeInteger(anchor.authorityGeneration) ||
      authority === undefined ||
      authority.generation !== anchor.authorityGeneration
    ) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The library snapshot that published this reference has been retired"
      );
    }
    return channel;
  }

  /**
   * Atomically reserve the execute winner while the owning browse
   * generation is still current. All pre-dispatch rechecks run after this
   * claim, so a later mode switch cannot convert the winner into a cancel.
   */
  public claimActionExecute(access: ActionSessionAccess): boolean {
    const lease = this.resolveAction(access);
    const channel = lease.channels.get("action");
    if (
      !channel ||
      channel.state !== "active" ||
      lease.zoneId === undefined ||
      lease.pending !== 0 ||
      lease.executeClaimed ||
      lease.executeIssued
    ) {
      return false;
    }
    lease.executeClaimed = true;
    return true;
  }

  public async releaseAction(access: ActionSessionAccess): Promise<void> {
    if (this.isRetiredHandle(access.coreId, access.handle)) return;
    const lease = this.resolveAction(access, false, true);
    await this.beginReleaseLease(lease, "STALE_GENERATION", true);
  }

  /**
   * Cross the irreversible Roon-action boundary on the pinned action channel.
   *
   * A prior `claimActionExecute` owns cancellation arbitration. The one-shot
   * dispatch latch runs at BrowseService's exact native-Roon handoff; after it
   * fires, disconnect and mode replacement cannot rewrite the eventual result
   * as session loss.
   */
  public executeAction(
    access: ActionSessionAccess,
    options: CoordinatedBrowseOptions,
    onIssued: () => void
  ): Promise<BrowseResult> {
    const lease = this.resolveAction(access, false);
    const channel = lease.channels.get("action");
    if (!channel) throw this.sessionLost("The action session is unavailable");
    return this.dispatchActionExecute(lease, channel, access, options, onIssued);
  }

  /**
   * Cross the same boundary for a live library reference, on the channel that
   * published it, anchored to that channel's publication generation.
   *
   * `.agents/plans/library-live-view.md` Slice 2. Everything the action lease
   * owns still applies and is applied here — the unconsumed execute claim, the
   * zone gate, the owner and mode checks, the one-shot dispatch latch. What
   * changes is only where the call lands, and it has to change: the leaf's item
   * key was minted on the library's browse session and names nothing anywhere
   * else. The anchor is re-checked on the tail, so a refresh that retired the
   * snapshot between the claim and the dispatch refuses the call outright
   * rather than executing a key whose meaning has expired.
   */
  public executeLibraryAction(
    access: ActionSessionAccess,
    anchor: LibraryActionAnchor,
    options: CoordinatedBrowseOptions,
    onIssued: () => void
  ): Promise<BrowseResult> {
    const lease = this.resolveAction(access, false);
    const channel = this.resolveLibraryActionChannel(anchor);
    return this.dispatchActionExecute(
      lease,
      channel,
      access,
      options,
      onIssued,
      () => {
        this.resolveLibraryActionChannel(anchor);
      }
    );
  }

  private dispatchActionExecute(
    lease: ActionLeaseRecord,
    channel: ChannelRecord,
    access: ActionSessionAccess,
    options: CoordinatedBrowseOptions,
    onIssued: () => void,
    assertAnchorCurrent: () => void = () => undefined
  ): Promise<BrowseResult> {
    if (typeof onIssued !== "function") throw this.invalidHandle();
    if (!lease.executeClaimed || lease.executeIssued) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The action lease has no unconsumed execute claim"
      );
    }
    this.assertActionZone(lease, options.zoneId);
    lease.pending += 1;

    const task = channel.tail.then(async () => {
      this.assertLeaseUsable(lease);
      if (lease.socketId !== access.socketId || lease.tabId !== access.tabId) {
        throw this.ownerMismatch();
      }
      if (channel.state !== "active") {
        throw this.sessionLost("The action session is not active");
      }
      if (!lease.executeClaimed || lease.executeIssued) {
        throw new BrowseSessionCoordinatorError(
          "STALE_GENERATION",
          "The action lease already crossed its execute boundary"
        );
      }
      if (Object.prototype.hasOwnProperty.call(options, "multiSessionKey")) {
        throw new BrowseSessionCoordinatorError(
          "INVALID_HANDLE",
          "Coordinated browse options cannot contain a session key"
        );
      }
      this.assertActionZone(lease, options.zoneId);
      // For a library action this is the anchor check, run here rather than
      // only at entry: the snapshot behind the reference may have been retired
      // while this call waited on the library's own tail, and a key from a
      // retired snapshot must be refused rather than sent.
      assertAnchorCurrent();

      channel.touchedHierarchies.add(options.hierarchy);
      let issued = false;
      const lifecycle: BrowseCallLifecycle = {
        onIssued: () => {
          if (issued) return;
          onIssued();
          issued = true;
          lease.executeIssued = true;
        },
        onTimeout: (lateSettlement) => {
          this.quarantineChannel(channel, lateSettlement);
          this.releaseAfterTimeout(lease, false);
          if (channel.owner !== lease) {
            this.releaseAfterTimeout(channel.owner, true);
          }
        },
      };
      return this.browseService.browse(
        { ...options, multiSessionKey: channel.sessionName },
        lifecycle
      );
    });
    channel.tail = task.then(
      () => undefined,
      () => undefined
    );
    const finish = (): void => {
      lease.pending = Math.max(0, lease.pending - 1);
    };
    void task.then(finish, finish);
    return task;
  }

  /**
   * Taint an action channel whose Roon call can still settle after the logical
   * operation has been canceled or expired. The physical session remains
   * unavailable until that settlement or the bounded quarantine reap.
   */
  public quarantineAction(
    access: ActionSessionAccess
  ): void {
    const lease = this.resolveAction(access, false);
    const channel = lease.channels.get("action");
    if (!channel) throw this.sessionLost("The action session is unavailable");
    this.quarantineChannel(channel, channel.tail);
    void this.beginReleaseLease(lease, "SESSION_LOST", false);
  }

  public disconnectSocket(coreId: string, socketId: string): void {
    const core = this.cores.get(coreId);
    if (!core) return;
    for (const lease of core.tabs.values()) {
      if (lease.socketId !== socketId || lease.state !== "active") continue;
      lease.state = "disconnected";
      this.clearPublishedItemKeys(lease);
      this.clearTimer(lease.idleTimer);
      lease.idleTimer = undefined;
      lease.graceTimer = this.unrefTimer(
        setTimeout(() => {
          void this.beginReleaseLease(lease, "SESSION_LOST", true);
        }, this.limits.disconnectGraceMs)
      );
    }
    // AlbumActionService owns the atomic resolving/choosing cancel claim.
    // Releasing an action lease here would bypass that state machine and race
    // an execute claim. The socket adapter asks the action service to cancel
    // before forwarding the owner disconnect to this coordinator.
  }

  public async invalidateCore(coreId: string): Promise<void> {
    const nextEpoch = (this.coreEpochs.get(coreId) ?? 0) + 1;
    this.coreEpochs.set(coreId, nextEpoch);
    const core = this.cores.get(coreId);
    if (!core) return;
    core.epoch = nextEpoch;
    const leases = new Set<LeaseRecord>([
      ...core.tabs.values(),
      ...core.actions.values(),
      ...(core.catalog ? [core.catalog] : []),
      ...(core.catalogCount ? [core.catalogCount] : []),
      ...[...core.sessions].map((session) => session.owner),
    ]);
    await Promise.all(
      [...leases]
        .filter((lease) => lease.state !== "closed")
        .map((lease) =>
          this.beginReleaseLease(lease, "SESSION_LOST", false)
        )
    );
  }

  public diagnostics(coreId: string): BrowseSessionDiagnostics {
    const core = this.cores.get(coreId);
    if (!core) {
      return {
        activeTabs: 0,
        classicTabs: 0,
        actions: 0,
        catalog: 0,
        sessions: 0,
        activeSessions: 0,
        releasingSessions: 0,
        quarantinedSessions: 0,
      };
    }
    const sessions = [...core.sessions];
    const tabs = [...core.tabs.values()].filter((lease) =>
      lease.state === "active" || lease.state === "disconnected"
    );
    return {
      activeTabs: tabs.length,
      classicTabs: tabs.filter((lease) => lease.mode === "classic").length,
      actions: [...core.actions.values()].filter(
        (lease) => lease.state !== "closed"
      ).length,
      catalog: core.catalog && core.catalog.state !== "closed" ? 1 : 0,
      sessions: sessions.length,
      activeSessions: sessions.filter((session) => session.state === "active")
        .length,
      releasingSessions: sessions.filter(
        (session) => session.state === "releasing"
      ).length,
      quarantinedSessions: sessions.filter(
        (session) => session.state === "quarantined"
      ).length,
    };
  }

  public shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const core of this.cores.values()) {
      for (const lease of [
        ...core.tabs.values(),
        ...core.actions.values(),
        ...(core.catalog ? [core.catalog] : []),
        ...(core.catalogCount ? [core.catalogCount] : []),
      ]) {
        lease.state = "closed";
        if (lease.kind === "mode") {
          this.clearTimer(lease.idleTimer);
          this.clearTimer(lease.graceTimer);
        }
      }
      for (const channel of core.sessions) {
        this.clearTimer(channel.quarantineTimer);
        channel.state = "closed";
        channel.resolveClosed();
      }
      core.tabs.clear();
      core.actions.clear();
      core.catalog = undefined;
      core.catalogCount = undefined;
      core.sessions.clear();
    }
    this.cores.clear();
    this.handles.clear();
    this.retiredHandles.clear();
    this.modeRetiredListeners.clear();
  }

  private runChannel<T>(
    lease: LeaseRecord,
    channel: ChannelRecord,
    work: (session: CoordinatedBrowseSession) => Promise<T>,
    assertOwner: () => void = () => undefined,
    validateOptions: (options: { hierarchy: string; zoneId?: string }) => void =
      () => undefined
  ): Promise<T> {
    this.assertLeaseUsable(lease);
    assertOwner();
    lease.pending += 1;
    if (lease.kind === "mode") {
      lease.lastActivity = this.now();
      this.clearTimer(lease.idleTimer);
      lease.idleTimer = undefined;
    }

    const task = channel.tail.then(async () => {
      this.assertLeaseUsable(lease);
      assertOwner();
      if (channel.state !== "active") {
        throw this.sessionLost("The browse session is not active");
      }
      const lifecycle: BrowseCallLifecycle = {
        onTimeout: (lateSettlement) => {
          this.quarantineChannel(channel, lateSettlement);
          this.releaseAfterTimeout(lease, true);
          // A lease may run on a channel it does not own — a library action
          // resolves references on the catalog channel that minted them. The
          // channel is quarantined either way, so its owner's lease must be
          // marked lost too, or the owner would keep a lease whose only
          // channel is dead and every later call on it would fail forever.
          if (channel.owner !== lease) {
            this.releaseAfterTimeout(channel.owner, true);
          }
        },
      };
      const session = new CoordinatedBrowseSessionImpl(
        this.browseService,
        channel,
        lifecycle,
        () => {
          this.assertLeaseUsable(lease);
          assertOwner();
          if (channel.state !== "active") {
            throw this.sessionLost("The browse session is not active");
          }
        },
        validateOptions
      );

      let result!: T;
      let primaryError: unknown;
      let failed = false;
      try {
        result = await work(session);
      } catch (error) {
        primaryError = error;
        failed = true;
      }
      try {
        await session.drain();
      } catch (error) {
        if (!failed) {
          primaryError = error;
          failed = true;
        }
      }

      if (failed) {
        if (primaryError instanceof RoonTimeoutError) throw primaryError;
        this.assertLeaseUsable(lease);
        assertOwner();
        throw primaryError;
      }

      this.assertLeaseUsable(lease);
      assertOwner();
      if (channel.state !== "active") {
        throw this.sessionLost("The browse session was lost during the request");
      }
      return result;
    });
    channel.tail = task.then(
      () => undefined,
      () => undefined
    );
    const finish = (): void => {
      lease.pending = Math.max(0, lease.pending - 1);
      if (lease.kind === "mode" && lease.pending === 0 && lease.state === "active") {
        this.scheduleIdle(lease);
      }
    };
    void task.then(finish, finish);
    return task;
  }

  private async beginReleaseLease(
    lease: LeaseRecord,
    reason: BrowseSessionErrorCode,
    reroot: boolean
  ): Promise<void> {
    if (lease.cleanupPromise) {
      if (reason === "SESSION_LOST" && lease.lossCode !== "SESSION_LOST") {
        lease.state = "lost";
        lease.lossCode = "SESSION_LOST";
        if (lease.kind === "mode") this.announceModeRetired(lease);
      }
      return lease.cleanupPromise;
    }
    if (lease.state === "closed") return;
    lease.state = reason === "SESSION_LOST" ? "lost" : "releasing";
    lease.lossCode ??= reason;
    this.clearPublishedItemKeys(lease);
    if (lease.kind === "mode") {
      this.clearTimer(lease.idleTimer);
      this.clearTimer(lease.graceTimer);
      lease.idleTimer = undefined;
      lease.graceTimer = undefined;
      const core = this.cores.get(lease.coreId);
      if (core?.tabs.get(lease.tabId) === lease) core.tabs.delete(lease.tabId);
    }

    lease.cleanupPromise = Promise.all(
      [...lease.channels.values()].map((channel) =>
        this.releaseChannel(channel, reroot)
      )
    ).then(() => {
      this.finalizeLease(lease, lease.lossCode ?? reason);
    });
    if (lease.kind === "mode" && lease.lossCode === "SESSION_LOST") {
      this.announceModeRetired(lease);
    }
    return lease.cleanupPromise;
  }

  private announceModeRetired(lease: ModeLeaseRecord): void {
    if (lease.retirementAnnounced) return;
    lease.retirementAnnounced = true;
    const event: ModeSessionRetiredEvent = Object.freeze({
      coreId: lease.coreId,
      socketId: lease.socketId,
      tabId: lease.tabId,
      session: Object.freeze(this.modeHandle(lease)),
      reason: "SESSION_LOST",
    });
    for (const listener of this.modeRetiredListeners) {
      try {
        listener(event);
      } catch {
        // Retirement is lifecycle truth, not part of cleanup authority. A
        // broken observer cannot strand channels behind a lost lease.
      }
    }
  }

  private async releaseChannel(
    channel: ChannelRecord,
    reroot: boolean
  ): Promise<void> {
    if (this.isClosed(channel)) return;
    if (this.isQuarantined(channel)) {
      await this.waitForActionQuarantine(channel);
      return;
    }
    await channel.tail;
    if (this.isClosed(channel)) return;
    if (this.isQuarantined(channel)) {
      await this.waitForActionQuarantine(channel);
      return;
    }
    channel.state = "releasing";

    if (reroot) {
      for (const hierarchy of channel.touchedHierarchies) {
        try {
          await this.browseService.reRoot(
            hierarchy,
            channel.sessionName,
            {
              onTimeout: (lateSettlement) =>
                this.quarantineChannel(channel, lateSettlement),
            },
            channel.owner.kind === "action" ? channel.owner.zoneId : undefined
          );
        } catch {
          if (!this.isQuarantined(channel)) {
            this.quarantineChannel(channel, Promise.resolve());
          }
          await this.waitForActionQuarantine(channel);
          return;
        }
      }
    }

    if (channel.state === "releasing") this.closeChannel(channel);
  }

  private isQuarantined(channel: ChannelRecord): boolean {
    return channel.state === "quarantined";
  }

  private isClosed(channel: ChannelRecord): boolean {
    return channel.state === "closed";
  }

  private async waitForActionQuarantine(channel: ChannelRecord): Promise<void> {
    if (channel.owner.kind === "action") await channel.closed;
  }

  private quarantineChannel(
    channel: ChannelRecord,
    lateSettlement: Promise<void>
  ): void {
    if (channel.state === "closed") return;
    if (channel.state !== "quarantined") {
      channel.state = "quarantined";
      channel.quarantineTimer = this.unrefTimer(
        setTimeout(
          () => this.cleanupQuarantine(channel),
          this.limits.quarantineReapMs
        )
      );
    }
    channel.quarantineSettlements += 1;
    void lateSettlement.then(
      () => this.settleQuarantine(channel),
      () => this.settleQuarantine(channel)
    );
  }

  private settleQuarantine(channel: ChannelRecord): void {
    if (channel.quarantineCleaned) return;
    channel.quarantineSettlements = Math.max(
      0,
      channel.quarantineSettlements - 1
    );
    if (channel.quarantineSettlements === 0) {
      this.cleanupQuarantine(channel);
    }
  }

  /**
   * A lease with a holder (the catalog singleton, a pinned action lease) is
   * not finalized out from under its holder on timeout: the quarantine
   * already bars new work on the channel, and the lease is released when the
   * holder releases it or when the quarantine reaps the channel. Mode leases
   * keep the immediate release; their holder is the socket lifecycle itself.
   */
  private releaseAfterTimeout(lease: LeaseRecord, reroot: boolean): void {
    if (
      lease.kind !== "catalog" &&
      lease.kind !== "catalog-count" &&
      lease.kind !== "action"
    ) {
      void this.beginReleaseLease(lease, "SESSION_LOST", reroot);
      return;
    }
    if (lease.state !== "active") return;
    lease.state = "lost";
    lease.lossCode = "SESSION_LOST";
  }

  /**
   * Reap a held lease whose holder never released it after a timeout. Runs
   * when the last quarantined channel closes (late settlement or the bounded
   * quarantine reap), so a wedged holder cannot leak the lease past the
   * quarantine window; disconnect, invalidateCore, and shutdown reap it too.
   */
  private finalizeDeferredLease(lease: LeaseRecord): void {
    if (lease.state !== "lost" || lease.cleanupPromise) return;
    if (
      [...lease.channels.values()].some((channel) => channel.state !== "closed")
    ) {
      return;
    }
    this.finalizeLease(lease, lease.lossCode ?? "SESSION_LOST");
  }

  private cleanupQuarantine(channel: ChannelRecord): void {
    if (channel.quarantineCleaned) return;
    channel.quarantineCleaned = true;
    this.clearTimer(channel.quarantineTimer);
    channel.quarantineTimer = undefined;
    this.closeChannel(channel);
    this.finalizeDeferredLease(channel.owner);
  }

  private closeChannel(channel: ChannelRecord): void {
    if (channel.state === "closed") return;
    channel.state = "closed";
    channel.resolveClosed();
    // The scope index must not outlive the channel: a scope string that
    // resolved to a closed channel would let a caller publish into a session
    // Roon no longer has, and every reference minted there would name nothing.
    if (this.channelsByScope.get(channel.sessionName) === channel) {
      this.channelsByScope.delete(channel.sessionName);
    }
    const core = this.cores.get(channel.owner.coreId);
    core?.sessions.delete(channel);
    if (core) this.pruneCore(core);
  }

  private finalizeLease(
    lease: LeaseRecord,
    reason: BrowseSessionErrorCode
  ): void {
    lease.state = "closed";
    this.handles.delete(lease.handleId);
    this.retireHandle(lease, reason);
    const core = this.cores.get(lease.coreId);
    if (!core) return;
    if (lease.kind === "mode" && core.tabs.get(lease.tabId) === lease) {
      core.tabs.delete(lease.tabId);
    } else if (lease.kind === "catalog" && core.catalog === lease) {
      core.catalog = undefined;
    } else if (
      lease.kind === "catalog-count" &&
      core.catalogCount === lease
    ) {
      core.catalogCount = undefined;
    } else if (
      lease.kind === "action" &&
      core.actions.get(lease.leaseId) === lease
    ) {
      core.actions.delete(lease.leaseId);
    }
    this.pruneCore(core);
  }

  private resolveMode(
    access: ModeSessionAccess,
    allowInactive = false
  ): ModeLeaseRecord {
    const lease = this.resolveLease(
      access.coreId,
      access.handle,
      "mode",
      allowInactive
    );
    if (lease.kind !== "mode") throw this.invalidHandle();
    if (lease.socketId !== access.socketId || lease.tabId !== access.tabId) {
      throw this.ownerMismatch();
    }
    if (lease.mode !== access.handle.mode) throw this.invalidHandle();
    return lease;
  }

  private resolveClassicChannel(
    access: ModeSessionAccess,
    role: ClassicSessionRole
  ): ChannelRecord {
    const lease = this.resolveMode(access);
    if (lease.mode !== "classic" || !CLASSIC_SESSION_ROLES.includes(role)) {
      throw new BrowseSessionCoordinatorError(
        "INVALID_ROLE",
        "Classic item keys require a Classic session role"
      );
    }
    const channel = lease.channels.get(role);
    if (!channel) throw this.sessionLost("The Classic session role is unavailable");
    return channel;
  }

  private publishClassicItemKey(
    channel: ChannelRecord,
    raw: string,
    item?: BrowseItem
  ): string {
    const authority = channel.publishedItemKeys ?? {
      generation: channel.publishedItemGeneration,
      tokenToRaw: new Map<string, string>(),
      rawToToken: new Map<string, string>(),
      tokenToItem: new Map<string, BrowseItem & { itemKey: string }>(),
      orderedTokens: [],
    };
    channel.publishedItemKeys = authority;
    const existing = authority.rawToToken.get(raw);
    if (existing) {
      authority.tokenToRaw.delete(existing);
      authority.tokenToRaw.set(existing, raw);
      if (item) {
        authority.tokenToItem.set(
          existing,
          Object.freeze({ ...item, itemKey: raw })
        );
      }
      return existing;
    }
    while (authority.tokenToRaw.size >= this.limits.maxPublishedItemKeysPerRole) {
      const oldestToken = authority.tokenToRaw.keys().next().value;
      if (!oldestToken) break;
      const oldestRaw = authority.tokenToRaw.get(oldestToken);
      authority.tokenToRaw.delete(oldestToken);
      authority.tokenToItem.delete(oldestToken);
      authority.orderedTokens = authority.orderedTokens.filter(
        (token) => token !== oldestToken
      );
      if (oldestRaw && authority.rawToToken.get(oldestRaw) === oldestToken) {
        authority.rawToToken.delete(oldestRaw);
      }
    }
    const token = this.uniqueToken("classic-item");
    authority.tokenToRaw.set(token, raw);
    authority.rawToToken.set(raw, token);
    authority.orderedTokens.push(token);
    if (item) {
      authority.tokenToItem.set(
        token,
        Object.freeze({ ...item, itemKey: raw })
      );
    }
    return token;
  }

  private clearPublishedItemKeys(lease: LeaseRecord): void {
    for (const channel of lease.channels.values()) {
      channel.publishedItemKeys?.tokenToRaw.clear();
      channel.publishedItemKeys?.rawToToken.clear();
      channel.publishedItemKeys?.tokenToItem.clear();
      if (channel.publishedItemKeys) channel.publishedItemKeys.orderedTokens = [];
      channel.publishedItemKeys = undefined;
    }
  }

  private advancePublishedItemGeneration(channel: ChannelRecord): number {
    if (channel.publishedItemGeneration >= Number.MAX_SAFE_INTEGER) {
      throw this.backpressure("The Classic item generation space is exhausted");
    }
    channel.publishedItemKeys?.tokenToRaw.clear();
    channel.publishedItemKeys?.rawToToken.clear();
    channel.publishedItemKeys?.tokenToItem.clear();
    if (channel.publishedItemKeys) channel.publishedItemKeys.orderedTokens = [];
    channel.publishedItemKeys = undefined;
    channel.publishedItemGeneration += 1;
    return channel.publishedItemGeneration;
  }

  private samePublishedItem(
    retained: BrowseItem & { itemKey: string },
    restored: BrowseItem & { itemKey: string }
  ): boolean {
    return (
      retained.itemKey === restored.itemKey &&
      retained.title === restored.title &&
      (retained.subtitle ?? null) === (restored.subtitle ?? null) &&
      (retained.hint ?? null) === (restored.hint ?? null) &&
      (retained.imageKey ?? null) === (restored.imageKey ?? null) &&
      retained.isLoadable === restored.isLoadable &&
      retained.isPlayable === restored.isPlayable &&
      (retained.itemType ?? null) === (restored.itemType ?? null) &&
      (retained.inputPrompt ?? null) === (restored.inputPrompt ?? null)
    );
  }

  private resolveAction(
    access: ActionSessionAccess,
    requireCurrentMode = true,
    allowInactive = false
  ): ActionLeaseRecord {
    const lease = this.resolveLease(
      access.coreId,
      access.handle,
      "action",
      allowInactive
    );
    if (lease.kind !== "action") throw this.invalidHandle();
    if (lease.socketId !== access.socketId || lease.tabId !== access.tabId) {
      throw this.ownerMismatch();
    }
    if (requireCurrentMode) this.assertActionModeCurrent(lease);
    return lease;
  }

  private assertActionModeCurrent(lease: ActionLeaseRecord): void {
    const modeLease = this.cores.get(lease.coreId)?.tabs.get(lease.tabId);
    if (!modeLease || modeLease.state !== "active") {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The action mode generation is no longer active"
      );
    }
    if (modeLease.socketId !== lease.socketId) throw this.ownerMismatch();
    if (modeLease.generation !== lease.generation) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The action mode generation is stale"
      );
    }
  }

  private assertActionZone(
    lease: ActionLeaseRecord,
    zoneId: string | undefined
  ): void {
    if (zoneId !== lease.zoneId) {
      throw new BrowseSessionCoordinatorError(
        "OWNER_MISMATCH",
        "The action browse call does not match its original zone"
      );
    }
  }

  private resolveLease(
    coreId: string,
    handle:
      | ModeSessionHandle
      | CatalogSessionHandle
      | CatalogCountSessionHandle
      | ActionSessionHandle,
    expectedKind: LeaseKind,
    allowInactive = false
  ): LeaseRecord {
    if (
      !handle ||
      typeof handle.handleId !== "string" ||
      !Number.isSafeInteger(handle.generation) ||
      handle.kind !== expectedKind
    ) {
      throw this.invalidHandle();
    }
    const lease = this.handles.get(handle.handleId);
    if (!lease) {
      const retired = this.retiredHandles.get(handle.handleId);
      if (
        retired &&
        retired.coreId === coreId &&
        retired.generation === handle.generation
      ) {
        throw new BrowseSessionCoordinatorError(
          retired.code,
          "The browse session generation is no longer current"
        );
      }
      throw this.invalidHandle();
    }
    if (lease.kind !== expectedKind) throw this.invalidHandle();
    if (lease.coreId !== coreId) throw this.ownerMismatch();
    if (lease.generation !== handle.generation) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The browse session generation is stale"
      );
    }
    if (allowInactive) {
      if ((this.coreEpochs.get(lease.coreId) ?? 0) !== lease.coreEpoch) {
        throw this.sessionLost("The Roon Core session was lost");
      }
    } else {
      this.assertLeaseUsable(lease);
    }
    return lease;
  }

  private assertLeaseUsable(lease: LeaseRecord): void {
    if (this.stopped) throw this.sessionLost("The browse coordinator is stopped");
    if ((this.coreEpochs.get(lease.coreId) ?? 0) !== lease.coreEpoch) {
      throw this.sessionLost("The Roon Core session was lost");
    }
    if (lease.state !== "active") {
      const code = lease.lossCode ??
        (lease.state === "disconnected" ? "SESSION_LOST" : "STALE_GENERATION");
      throw new BrowseSessionCoordinatorError(
        code,
        "The browse session generation is not active"
      );
    }
  }

  private addChannel(
    core: CoreRegistry,
    owner: LeaseRecord,
    role: SessionRole
  ): void {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const channel: ChannelRecord = {
      role,
      sessionName: `${role}:${owner.generation}:${this.uniqueToken("session")}`,
      owner,
      state: "active",
      tail: Promise.resolve(),
      touchedHierarchies: new Set(),
      closed,
      resolveClosed,
      quarantineCleaned: false,
      quarantineSettlements: 0,
      publishedItemGeneration: 0,
    };
    owner.channels.set(role, channel);
    core.sessions.add(channel);
    this.channelsByScope.set(channel.sessionName, channel);
  }

  private getCore(coreId: string): CoreRegistry {
    const existing = this.cores.get(coreId);
    if (existing) return existing;
    const core: CoreRegistry = {
      coreId,
      epoch: this.coreEpochs.get(coreId) ?? 0,
      tabs: new Map(),
      actions: new Map(),
      sessions: new Set(),
    };
    this.cores.set(coreId, core);
    return core;
  }

  private pruneCore(core: CoreRegistry): void {
    if (
      core.tabs.size === 0 &&
      core.actions.size === 0 &&
      !core.catalog &&
      !core.catalogCount &&
      core.sessions.size === 0
    ) {
      this.cores.delete(core.coreId);
    }
  }

  private assertPhysicalCapacity(core: CoreRegistry, requested: number): void {
    if (core.sessions.size + requested > this.limits.maxPhysicalSessionsPerCore) {
      throw this.backpressure("The Core browse-session registry is full");
    }
  }

  private scheduleIdle(lease: ModeLeaseRecord): void {
    if (lease.state !== "active" || lease.pending > 0) return;
    this.clearTimer(lease.idleTimer);
    lease.lastActivity = this.now();
    lease.idleTimer = this.unrefTimer(
      setTimeout(() => {
        void this.beginReleaseLease(lease, "SESSION_LOST", true);
      }, this.limits.modeIdleMs)
    );
  }

  private modeHandle(lease: ModeLeaseRecord): ModeSessionHandle {
    return Object.freeze({
      kind: "mode" as const,
      handleId: lease.handleId,
      generation: lease.generation,
      mode: lease.mode,
    });
  }

  private catalogHandle(lease: CatalogLeaseRecord): CatalogSessionHandle {
    return Object.freeze({
      kind: "catalog" as const,
      handleId: lease.handleId,
      generation: lease.generation,
    });
  }

  private catalogCountHandle(
    lease: CatalogCountLeaseRecord
  ): CatalogCountSessionHandle {
    return Object.freeze({
      kind: "catalog-count" as const,
      handleId: lease.handleId,
      generation: lease.generation,
    });
  }

  private actionHandle(lease: ActionLeaseRecord): ActionSessionHandle {
    return Object.freeze({
      kind: "action" as const,
      handleId: lease.handleId,
      generation: lease.generation,
    });
  }

  /**
   * True only for a handle this coordinator already finalized and retired.
   * A genuinely unknown handle returns false so resolveLease still rejects it.
   */
  private isRetiredHandle(
    coreId: string,
    handle:
      | ModeSessionHandle
      | CatalogSessionHandle
      | CatalogCountSessionHandle
      | ActionSessionHandle
  ): boolean {
    if (!handle || typeof handle.handleId !== "string") return false;
    const retired = this.retiredHandles.get(handle.handleId);
    return Boolean(
      retired &&
        retired.coreId === coreId &&
        retired.generation === handle.generation
    );
  }

  private retireHandle(
    lease: LeaseRecord,
    code: BrowseSessionErrorCode
  ): void {
    this.retiredHandles.set(lease.handleId, {
      coreId: lease.coreId,
      generation: lease.generation,
      code,
    });
    while (this.retiredHandles.size > this.limits.retiredHandleLimit) {
      const oldest = this.retiredHandles.keys().next().value;
      if (!oldest) break;
      this.retiredHandles.delete(oldest);
    }
  }

  private uniqueToken(prefix: string): string {
    this.nonce += 1;
    return `${prefix}-${this.randomId()}-${this.nonce}`;
  }

  private nextGeneration(): number {
    if (this.generation >= Number.MAX_SAFE_INTEGER) {
      throw this.backpressure("The browse generation space is exhausted");
    }
    this.generation += 1;
    return this.generation;
  }

  private normalizeLimits(
    supplied: Partial<BrowseSessionLimits> | undefined
  ): BrowseSessionLimits {
    const limits = { ...DEFAULT_BROWSE_SESSION_LIMITS, ...supplied };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Browse session limit ${name} must be a positive integer`);
      }
    }
    return limits;
  }

  private assertRunning(): void {
    if (this.stopped) throw this.sessionLost("The browse coordinator is stopped");
  }

  private assertIdentifier(value: string, name: string): void {
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new BrowseSessionCoordinatorError(
        "INVALID_HANDLE",
        `${name} must be a non-empty bounded string`
      );
    }
  }

  private unrefTimer<T extends Timer>(timer: T): T {
    timer.unref?.();
    return timer;
  }

  private clearTimer(timer: Timer | undefined): void {
    if (timer) clearTimeout(timer);
  }

  private backpressure(message: string): BrowseSessionCoordinatorError {
    return new BrowseSessionCoordinatorError("BACKPRESSURE", message);
  }

  private invalidHandle(): BrowseSessionCoordinatorError {
    return new BrowseSessionCoordinatorError(
      "INVALID_HANDLE",
      "The browse session handle is invalid"
    );
  }

  private ownerMismatch(): BrowseSessionCoordinatorError {
    return new BrowseSessionCoordinatorError(
      "OWNER_MISMATCH",
      "The browse session belongs to another owner"
    );
  }

  private sessionLost(message: string): BrowseSessionCoordinatorError {
    return new BrowseSessionCoordinatorError("SESSION_LOST", message);
  }
}
