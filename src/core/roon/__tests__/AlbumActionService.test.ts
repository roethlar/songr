import { Logger } from "pino";

import {
  AlbumActionCoordinatorPort,
  AlbumActionEventSink,
  AlbumActionLibraryPort,
  AlbumActionOrigin,
  AlbumActionPageAuthority,
  AlbumActionPagePort,
  AlbumActionService,
  AlbumActionZonePort,
} from "../AlbumActionService";
import {
  AlbumActionBrowseHierarchy,
  AlbumActionCollectionSource,
  AlbumActionReferenceSource,
  AlbumActionResolutionError,
  AlbumActionResolverPort,
  ResolvedAlbumActions,
} from "../AlbumActionResolver";
import {
  ActionSessionAccess,
  ActionSessionHandle,
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
  LibraryActionAnchor,
} from "../BrowseSessionCoordinator";
import type { LibraryActionSubject } from "../../library/LibrarySource";
import type { LibraryRowReference } from "../../../shared/libraryRootsContracts";
import { RoonTimeoutError } from "../errors";
import {
  AlbumActionBeginRequest,
  AlbumActionFailedEvent,
  AlbumActionReferenceBeginRequest,
  AlbumActionResolvedEvent,
} from "../../../shared/albumActionContracts";
import { COLLECTION_DRILL_SOURCE_CONTRACT } from "../../../shared/collectionDrillContracts";
import { BrowseOptions, BrowseResult, Zone } from "../../../shared/types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function browseResult(): BrowseResult {
  return { action: "none", level: 0, offset: 0, count: 0, items: [] };
}

function zone(outputIds = ["output-a"]): Zone {
  return {
    zone_id: "zone-1",
    display_name: "Test",
    state: "stopped",
    is_play_allowed: true,
    is_pause_allowed: false,
    is_previous_allowed: false,
    is_next_allowed: false,
    is_seek_allowed: false,
    outputs: outputIds.map((output_id) => ({
      output_id,
      display_name: output_id,
    })),
  };
}

function resolvedActions(
  hierarchy: AlbumActionBrowseHierarchy = "artists"
): ResolvedAlbumActions {
  return {
    actions: [
      {
        label: "Play Now",
        semantic: "play-now",
        itemKey: "raw-play",
        hierarchy,
      },
      {
        label: "Add Next",
        semantic: "add-next",
        itemKey: "raw-next",
        hierarchy,
      },
      { label: "Queue", semantic: "queue", itemKey: "raw-queue", hierarchy },
    ],
  };
}

const origin: AlbumActionOrigin = { coreId: "core-1", socketId: "socket-1" };
const otherOrigin: AlbumActionOrigin = {
  coreId: "core-1",
  socketId: "socket-2",
};

function request(patch: Partial<AlbumActionBeginRequest> = {}): AlbumActionBeginRequest {
  return {
    requestId: "request-1",
    pageId: "page-1",
    versionId: "version-1",
    zoneId: "zone-1",
    tabId: "tab-1",
    generation: 7,
    ...patch,
  };
}

/**
 * The one page source an action lease can still be granted to: a locator that
 * re-walks its own drill, and the digest of the track list the page published.
 * Nothing here names a stored record, because there is no stored record.
 */
function collectionSource(): AlbumActionCollectionSource {
  return {
    locator: {
      sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
      hierarchy: "genres",
      collectionExactName: "Bright Machinery",
      rendering: {
        exactTitle: "Harbour Lantern",
        exactCredit: "The Paper Fleet",
      },
    },
    detailDigest: "detail-digest",
  };
}

class FakePages implements AlbumActionPagePort {
  public current = true;
  public claimCalls = 0;
  public currentChecks = 0;
  public invalidateAtCheck: number | null = null;
  public readonly authority: AlbumActionPageAuthority = {
    pageId: "page-1",
    versionId: "version-1",
    coreId: "core-1",
    socketId: "socket-1",
    tabId: "tab-1",
    generation: 7,
    albumSignature: "album-signature",
    // A collection page holds no live key: the session that resolved its row
    // was released when the read finished, so the lease carries the locator
    // and the real page issues an empty string here.
    retainedItemKey: "",
    source: { kind: "collection" as const, source: collectionSource() },
  };

  public claimSelectedVersionAction(
    actionOrigin: AlbumActionOrigin,
    input: {
      pageId: string;
      versionId: string;
      tabId: string;
      generation: number;
    }
  ): Readonly<AlbumActionPageAuthority> | null {
    this.claimCalls += 1;
    return this.current &&
      actionOrigin.coreId === this.authority.coreId &&
      actionOrigin.socketId === this.authority.socketId &&
      input.pageId === this.authority.pageId &&
      input.versionId === this.authority.versionId &&
      input.tabId === this.authority.tabId &&
      input.generation === this.authority.generation
      ? this.authority
      : null;
  }

  public isSelectedVersionActionCurrent(
    authority: Readonly<AlbumActionPageAuthority>
  ): boolean {
    this.currentChecks += 1;
    if (this.currentChecks === this.invalidateAtCheck) this.current = false;
    return this.current && authority === this.authority;
  }
}

class FakeCoordinator implements AlbumActionCoordinatorPort {
  public acquireCalls = 0;
  public acquireInputs: Array<{
    coreId: string;
    socketId: string;
    tabId: string;
    leaseId: string;
    zoneId: string;
    generation: number;
  }> = [];
  public runCalls = 0;
  public runAccesses: ActionSessionAccess[] = [];
  public claimCalls = 0;
  public claimAccesses: ActionSessionAccess[] = [];
  public executeCalls: Array<{
    access: ActionSessionAccess;
    options: Omit<BrowseOptions, "multiSessionKey"> & {
      multiSessionKey?: never;
    };
  }> = [];
  public libraryRunCalls: Array<{
    access: ActionSessionAccess;
    anchor: LibraryActionAnchor;
  }> = [];
  public libraryExecuteCalls: Array<{
    access: ActionSessionAccess;
    anchor: LibraryActionAnchor;
    options: Omit<BrowseOptions, "multiSessionKey"> & {
      multiSessionKey?: never;
    };
  }> = [];
  public libraryRunError?: Error;
  public libraryExecuteError?: Error;
  public releaseCalls = 0;
  public quarantineCalls = 0;
  public acquireError?: Error;
  public releaseError?: Error;
  public claimResult = true;
  public executeMode: "success" | "pre-error" | "post-error" | "deferred" =
    "success";
  public execution = deferred<BrowseResult>();
  public executeResult = browseResult();
  public browseImpl: () => Promise<BrowseResult> = () =>
    Promise.resolve(browseResult());

  public acquireAction(input: {
    coreId: string;
    socketId: string;
    tabId: string;
    leaseId: string;
    zoneId: string;
    generation: number;
  }): ActionSessionHandle {
    this.acquireCalls += 1;
    this.acquireInputs.push(input);
    if (this.acquireError) throw this.acquireError;
    return { kind: "action", handleId: "handle-1", generation: 7 };
  }

  public runAction<T>(
    access: ActionSessionAccess,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    this.runCalls += 1;
    this.runAccesses.push(access);
    const session: CoordinatedBrowseSession = {
      sessionScope: "action-session",
      browse: () => this.browseImpl(),
      load: () => this.browseImpl(),
      pop: () => this.browseImpl(),
    };
    return work(session);
  }

  public runLibraryAction<T>(
    access: ActionSessionAccess,
    anchor: LibraryActionAnchor,
    work: (session: CoordinatedBrowseSession) => Promise<T>
  ): Promise<T> {
    this.libraryRunCalls.push({ access, anchor });
    if (this.libraryRunError) return Promise.reject(this.libraryRunError);
    const session: CoordinatedBrowseSession = {
      sessionScope: anchor.sessionScope,
      browse: () => this.browseImpl(),
      load: () => this.browseImpl(),
      pop: () => this.browseImpl(),
    };
    return work(session);
  }

  public claimActionExecute(access: ActionSessionAccess): boolean {
    this.claimCalls += 1;
    this.claimAccesses.push(access);
    return this.claimResult;
  }

  public executeAction(
    access: ActionSessionAccess,
    options: Omit<BrowseOptions, "multiSessionKey"> & {
      multiSessionKey?: never;
    },
    onIssued: () => void
  ): Promise<BrowseResult> {
    this.executeCalls.push({ access, options });
    if (this.executeMode === "pre-error") {
      return Promise.reject(new Error("before dispatch"));
    }
    onIssued();
    if (this.executeMode === "post-error") {
      return Promise.reject(new Error("after dispatch"));
    }
    if (this.executeMode === "deferred") return this.execution.promise;
    return Promise.resolve(this.executeResult);
  }

  public executeLibraryAction(
    access: ActionSessionAccess,
    anchor: LibraryActionAnchor,
    options: Omit<BrowseOptions, "multiSessionKey"> & {
      multiSessionKey?: never;
    },
    onIssued: () => void
  ): Promise<BrowseResult> {
    this.libraryExecuteCalls.push({ access, anchor, options });
    if (this.libraryExecuteError) {
      return Promise.reject(this.libraryExecuteError);
    }
    onIssued();
    return Promise.resolve(this.executeResult);
  }

  public releaseAction(): Promise<void> {
    this.releaseCalls += 1;
    if (this.releaseError) return Promise.reject(this.releaseError);
    return Promise.resolve();
  }

  public quarantineAction(): void {
    this.quarantineCalls += 1;
  }
}

/**
 * The live library, as the action service sees it.
 *
 * `retired` is what a re-read of the roots does to every outstanding reference
 * at once: `resolveActionSubject` starts refusing, and a subject resolved
 * before the re-read stops being current. Both are separate switches here
 * because the two matter at different moments — one at begin, one between the
 * claim and the dispatch.
 */
class FakeLibrary implements AlbumActionLibraryPort {
  public retired = false;
  public resolveCalls: LibraryRowReference[] = [];
  public currentChecks = 0;
  public hierarchy: LibraryActionSubject["hierarchy"] = "albums";
  public readonly anchor: LibraryActionAnchor = {
    sessionScope: "catalog-session-1",
    authorityGeneration: 4,
  };

  public resolveActionSubject(
    ref: Readonly<LibraryRowReference>
  ): Readonly<LibraryActionSubject> {
    this.resolveCalls.push({ ...ref });
    if (this.retired) {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The library snapshot that published this reference has been retired"
      );
    }
    return Object.freeze({
      anchor: this.anchor,
      generation: ref.generation,
      hierarchy: this.hierarchy,
      itemKey: `roon-key-for-${ref.token}`,
      title: "3 Feet High and Rising",
      kind: "action" as const,
    });
  }

  public isActionSubjectCurrent(): boolean {
    this.currentChecks += 1;
    return !this.retired;
  }
}

describe("AlbumActionService", () => {
  let coordinator: FakeCoordinator;
  let pages: FakePages;
  let library: FakeLibrary;
  let referenceCalls: Array<{
    source: Readonly<AlbumActionReferenceSource>;
    zoneId: string;
    sessionScope: string;
  }>;
  let currentZone: Zone | undefined;
  let resolverImpl: (
    session: CoordinatedBrowseSession,
    source: Readonly<AlbumActionCollectionSource>,
    zoneId: string
  ) => Promise<ResolvedAlbumActions>;
  let resolverCalls: Array<{
    source: Readonly<AlbumActionCollectionSource>;
    zoneId: string;
  }>;
  let service: AlbumActionService;
  let resolvedEvents: AlbumActionResolvedEvent[];
  let failedEvents: AlbumActionFailedEvent[];
  let sink: AlbumActionEventSink;
  let idCounter: number;
  let loggerError: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
    coordinator = new FakeCoordinator();
    pages = new FakePages();
    library = new FakeLibrary();
    currentZone = zone();
    resolverCalls = [];
    referenceCalls = [];
    resolverImpl = () => Promise.resolve(resolvedActions());
    const resolver: AlbumActionResolverPort = {
      resolveCollectionVersion: (session, source, zoneId) => {
        resolverCalls.push({ source, zoneId });
        return resolverImpl(session, source, zoneId);
      },
      resolveReference: (session, source, zoneId) => {
        referenceCalls.push({
          source,
          zoneId,
          sessionScope: session.sessionScope,
        });
        return Promise.resolve(resolvedActions(source.hierarchy));
      },
    };
    const zones: AlbumActionZonePort = { getZone: () => currentZone };
    resolvedEvents = [];
    failedEvents = [];
    sink = {
      resolved: (event) => resolvedEvents.push(event),
      failed: (event) => failedEvents.push(event),
    };
    idCounter = 1;
    loggerError = jest.fn();
    service = new AlbumActionService(
      coordinator,
      pages,
      zones,
      resolver,
      {
        warn: jest.fn(),
        debug: jest.fn(),
        error: loggerError,
      } as unknown as Logger,
      library,
      {
        resolvingTtlMs: 1_000,
        choosingTtlMs: 1_000,
        randomId: () =>
          `00000000-0000-4000-8000-${String(idCounter++).padStart(12, "0")}`,
      }
    );
  });

  afterEach(() => {
    service.shutdown();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  async function resolveRequest(
    requestValue: AlbumActionBeginRequest = request()
  ): Promise<AlbumActionResolvedEvent> {
    const reservation = service.begin(origin, requestValue, sink);
    if (!reservation.ack.success || !reservation.start) {
      throw new Error("Expected accepted album action begin");
    }
    reservation.start();
    await flush();
    const event = resolvedEvents[resolvedEvents.length - 1];
    if (!event) throw new Error("Expected resolved album actions");
    return event;
  }

  it("returns the accepted ack before any Browse work and emits only keyless choices", async () => {
    const reservation = service.begin(origin, request(), sink);

    expect(reservation.ack).toMatchObject({
      success: true,
      data: { requestId: "request-1" },
    });
    if (!reservation.ack.success) throw new Error("Expected accepted begin");
    expect(coordinator.acquireInputs).toEqual([
      {
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        leaseId: reservation.ack.data.operationId,
        zoneId: "zone-1",
        generation: 7,
      },
    ]);
    expect(coordinator.runCalls).toBe(0);
    expect(resolverCalls).toHaveLength(0);

    reservation.start?.();
    reservation.start?.();
    await flush();

    expect(coordinator.runCalls).toBe(1);
    expect(coordinator.runAccesses[0]).toMatchObject({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      handle: { kind: "action", handleId: "handle-1", generation: 7 },
    });
    expect(resolverCalls).toHaveLength(1);
    expect(resolverCalls[0].zoneId).toBe("zone-1");
    expect(resolvedEvents).toHaveLength(1);
    expect(Object.keys(resolvedEvents[0].actions[0]).sort()).toEqual([
      "actionId",
      "label",
      "semantic",
    ]);
    expect(JSON.stringify(resolvedEvents[0])).not.toContain("raw-play");
    expect(resolvedEvents[0].choosingDeadlineAt).toBe(
      Date.now() + 1_000
    );
  });

  it("rejects invalid, missing-zone, conflicting, and backpressured begins without extra leases", () => {
    const invalid = service.begin(origin, { bad: true }, sink);
    expect(invalid.ack).toEqual({
      success: false,
      code: "INVALID_REQUEST",
      error: "Invalid album action request",
    });
    expect(coordinator.acquireCalls).toBe(0);

    currentZone = undefined;
    const missing = service.begin(origin, request(), sink);
    expect(missing.ack).toMatchObject({ success: false, code: "ZONE_NOT_FOUND" });
    expect(coordinator.acquireCalls).toBe(0);

    currentZone = zone();
    const accepted = service.begin(origin, request(), sink);
    expect(accepted.ack.success).toBe(true);
    const conflict = service.begin(origin, request(), sink);
    expect(conflict.ack).toMatchObject({
      success: false,
      code: "REQUEST_ID_CONFLICT",
    });
    expect(coordinator.acquireCalls).toBe(1);

    coordinator.acquireError = new BrowseSessionCoordinatorError(
      "BACKPRESSURE",
      "full"
    );
    const backpressure = service.begin(
      origin,
      request({ requestId: "request-2" }),
      sink
    );
    expect(backpressure.ack).toMatchObject({
      success: false,
      code: "BACKPRESSURE",
    });
    expect(resolvedEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(0);
  });

  it.each(["STALE_GENERATION", "SESSION_LOST"] as const)(
    "reports %s mode authority as a lost session",
    (code) => {
      coordinator.acquireError = new BrowseSessionCoordinatorError(
        code,
        "retired"
      );

      const reservation = service.begin(origin, request(), sink);

      expect(reservation.ack).toEqual({
        success: false,
        code: "SESSION_LOST",
        error: "The browse session is no longer current",
      });
      expect(reservation.start).toBeUndefined();
      expect(coordinator.acquireCalls).toBe(1);
      expect(resolvedEvents).toHaveLength(0);
      expect(failedEvents).toHaveLength(0);
    }
  );

  it("retains a bounded request tombstone after cancellation", () => {
    const accepted = service.begin(origin, request(), sink);
    expect(accepted.ack.success).toBe(true);
    expect(service.cancel(origin, { requestId: "request-1" })).toEqual({
      success: true,
      data: { claimed: true },
    });

    expect(service.begin(origin, request(), sink).ack).toMatchObject({
      success: false,
      code: "REQUEST_ID_CONFLICT",
    });
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("rejects a page token presented by a different socket", () => {
    const first = service.begin(origin, request(), sink);
    const second = service.begin(otherOrigin, request(), sink);

    expect(first.ack.success).toBe(true);
    expect(second.ack).toMatchObject({ success: false, code: "SESSION_LOST" });
    expect(coordinator.acquireCalls).toBe(1);
    expect(service.cancel(origin, { requestId: "request-1" })).toEqual({
      success: true,
      data: { claimed: true },
    });
  });

  it("retains exactly the configured bounded request replay horizon", () => {
    for (let index = 0; index < 256; index += 1) {
      const requestId = `bounded-${index}`;
      const reservation = service.begin(origin, request({ requestId }), sink);
      if (!reservation.ack.success) throw new Error("Expected accepted begin");
      expect(service.cancel(origin, { requestId })).toEqual({
        success: true,
        data: { claimed: true },
      });
    }
    expect(
      service.begin(origin, request({ requestId: "bounded-0" }), sink).ack
    ).toMatchObject({ success: false, code: "REQUEST_ID_CONFLICT" });

    const overflow = service.begin(
      origin,
      request({ requestId: "bounded-256" }),
      sink
    );
    expect(overflow.ack.success).toBe(true);
    expect(service.cancel(origin, { requestId: "bounded-256" })).toEqual({
      success: true,
      data: { claimed: true },
    });
    expect(
      service.begin(origin, request({ requestId: "bounded-0" }), sink).ack.success
    ).toBe(true);
  });

  it("escalates an unexpected cleanup failure after retiring client authority", async () => {
    coordinator.releaseError = new Error("unexpected cleanup failure");
    const accepted = service.begin(origin, request(), sink);
    if (!accepted.ack.success) throw new Error("Expected accepted begin");

    expect(service.cancel(origin, { operationId: accepted.ack.data.operationId })).toEqual({
      success: true,
      data: { claimed: true },
    });
    await flush();

    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][1]).toContain("failed unexpectedly");
    expect(
      service.cancel(origin, { operationId: accepted.ack.data.operationId })
    ).toEqual({ success: true, data: { claimed: false } });
  });

  it("uses a fresh full chooser deadline after slow resolution", async () => {
    const resolution = deferred<ResolvedAlbumActions>();
    resolverImpl = () => resolution.promise;
    const reservation = service.begin(origin, request(), sink);
    if (!reservation.ack.success) throw new Error("Expected accepted begin");
    const resolvingDeadline = reservation.ack.data.resolvingDeadlineAt;
    reservation.start?.();
    await flush();

    jest.advanceTimersByTime(900);
    resolution.resolve(resolvedActions());
    await flush();

    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0].choosingDeadlineAt).toBe(Date.now() + 1_000);
    expect(resolvedEvents[0].choosingDeadlineAt).toBeGreaterThan(
      resolvingDeadline
    );
    jest.advanceTimersByTime(999);
    expect(coordinator.releaseCalls).toBe(0);
    jest.advanceTimersByTime(1);
    expect(coordinator.releaseCalls).toBe(1);
    expect(failedEvents[failedEvents.length - 1]?.code).toBe("CANCELED");
  });

  it("fails resolution when a zone regroups inside a Browse call even if the resolver would restore it", async () => {
    coordinator.browseImpl = () => {
      currentZone = zone(["output-b"]);
      return Promise.resolve(browseResult());
    };
    resolverImpl = async (session) => {
      await session.browse({ hierarchy: "search", zoneId: "zone-1" });
      currentZone = zone(["output-a"]);
      return resolvedActions();
    };
    const reservation = service.begin(origin, request(), sink);
    reservation.start?.();
    await flush();

    expect(resolvedEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("ZONE_CHANGED");
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("rechecks selected-version authority immediately before publishing choices", async () => {
    const resolution = deferred<ResolvedAlbumActions>();
    resolverImpl = () => resolution.promise;
    const reservation = service.begin(origin, request(), sink);
    reservation.start?.();
    await flush();
    pages.current = false;

    resolution.resolve(resolvedActions());
    await flush();

    expect(resolvedEvents).toHaveLength(0);
    expect(failedEvents[0].code).toBe("SESSION_LOST");
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("lets a resolution completion win exactly at its deadline when the timer has not claimed", async () => {
    const resolution = deferred<ResolvedAlbumActions>();
    resolverImpl = () => resolution.promise;
    const reservation = service.begin(origin, request(), sink);
    if (!reservation.ack.success) throw new Error("Expected accepted begin");
    reservation.start?.();
    await flush();

    jest.setSystemTime(reservation.ack.data.resolvingDeadlineAt);
    resolution.resolve(resolvedActions());
    await flush();

    expect(resolvedEvents).toHaveLength(1);
    expect(failedEvents).toHaveLength(0);
    expect(resolvedEvents[0].choosingDeadlineAt).toBe(
      reservation.ack.data.resolvingDeadlineAt + 1_000
    );
  });

  it("quarantines a resolving timeout and ignores the late result", async () => {
    const resolution = deferred<ResolvedAlbumActions>();
    resolverImpl = () => resolution.promise;
    const reservation = service.begin(origin, request(), sink);
    if (!reservation.ack.success) throw new Error("Expected accepted begin");
    const operationId = reservation.ack.data.operationId;
    reservation.start?.();
    await flush();

    jest.advanceTimersByTime(1_000);
    expect(coordinator.quarantineCalls).toBe(1);
    expect(coordinator.releaseCalls).toBe(0);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");

    resolution.resolve(resolvedActions());
    await flush();
    expect(resolvedEvents).toHaveLength(0);
    expect(
      service.cancel(origin, { operationId })
    ).toEqual({ success: true, data: { claimed: false } });
  });

  it("never reuses retired operation or action authority when randomness repeats", async () => {
    const first = await resolveRequest();
    const staleActionId = first.actions[0].actionId;
    expect(service.cancel(origin, { operationId: first.operationId })).toEqual({
      success: true,
      data: { claimed: true },
    });

    idCounter = 1;
    const second = await resolveRequest(request({ requestId: "request-2" }));
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.actions.map((action) => action.actionId)).not.toContain(
      staleActionId
    );
    expect(service.cancel(origin, { operationId: first.operationId })).toEqual({
      success: true,
      data: { claimed: false },
    });
    await expect(
      service.execute(origin, { actionId: staleActionId })
    ).resolves.toEqual({ success: true, data: { claimed: false } });
    expect(service.cancel(origin, { operationId: second.operationId })).toEqual({
      success: true,
      data: { claimed: true },
    });
  });

  it("cleanly releases a no-start timeout because no Roon work is uncertain", () => {
    service.begin(origin, request(), sink);

    jest.advanceTimersByTime(1_000);

    expect(coordinator.releaseCalls).toBe(1);
    expect(coordinator.quarantineCalls).toBe(0);
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");
  });

  it("does not start Browse work when an accepted reservation is already expired", async () => {
    const reservation = service.begin(origin, request(), sink);
    if (!reservation.ack.success) throw new Error("Expected accepted begin");
    jest.setSystemTime(reservation.ack.data.resolvingDeadlineAt);

    reservation.start?.();
    await flush();

    expect(coordinator.runCalls).toBe(0);
    expect(resolverCalls).toHaveLength(0);
    expect(resolvedEvents).toHaveLength(0);
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");
    expect(coordinator.releaseCalls).toBe(1);
    expect(coordinator.quarantineCalls).toBe(0);
  });

  it("quarantines a native Roon timeout but cleanly releases an ordinary resolver failure", async () => {
    resolverImpl = () =>
      Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
    const timedOut = service.begin(origin, request(), sink);
    timedOut.start?.();
    await flush();
    expect(coordinator.quarantineCalls).toBe(1);
    expect(failedEvents[0].code).toBe("RESOLUTION_TIMEOUT");

    resolverImpl = () =>
      Promise.reject(
        new AlbumActionResolutionError("ALBUM_AMBIGUOUS", "ambiguous")
      );
    const ordinary = service.begin(
      origin,
      request({ requestId: "request-2" }),
      sink
    );
    ordinary.start?.();
    await flush();
    expect(coordinator.releaseCalls).toBe(1);
    expect(coordinator.quarantineCalls).toBe(1);
    expect(failedEvents[1].code).toBe("ALBUM_AMBIGUOUS");
  });

  it("binds cancel and action authority to the originating socket", async () => {
    const event = await resolveRequest();

    expect(
      service.cancel(otherOrigin, { operationId: event.operationId })
    ).toEqual({ success: true, data: { claimed: false } });
    await expect(
      service.execute(otherOrigin, { actionId: event.actions[0].actionId })
    ).resolves.toEqual({ success: true, data: { claimed: false } });
    expect(coordinator.claimCalls).toBe(0);
    expect(coordinator.executeCalls).toHaveLength(0);
    expect(service.cancel(origin, { operationId: event.operationId })).toEqual({
      success: true,
      data: { claimed: true },
    });
  });

  it("lets chooser expiry claim before execution without dispatch", async () => {
    const event = await resolveRequest();
    jest.setSystemTime(event.choosingDeadlineAt + 1);

    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toEqual({ success: true, data: { claimed: false } });
    expect(coordinator.claimCalls).toBe(0);
    expect(coordinator.executeCalls).toHaveLength(0);
    expect(coordinator.releaseCalls).toBe(1);
    expect(failedEvents[0].code).toBe("CANCELED");
  });

  it("lets execute claim exactly at the chooser deadline when its timer has not run", async () => {
    const event = await resolveRequest();
    jest.setSystemTime(event.choosingDeadlineAt);

    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toMatchObject({
      success: true,
      data: { claimed: true, outcome: "executed" },
    });
    expect(coordinator.claimCalls).toBe(1);
    expect(coordinator.executeCalls).toHaveLength(1);
  });

  it("lets the chooser timer claim exactly at the deadline before execute", async () => {
    const event = await resolveRequest();

    jest.advanceTimersByTime(1_000);
    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toEqual({ success: true, data: { claimed: false } });
    expect(coordinator.claimCalls).toBe(0);
    expect(coordinator.executeCalls).toHaveLength(0);
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("claims once, executes the exact stored key, zone, and hierarchy, and invalidates siblings", async () => {
    const event = await resolveRequest();
    const play = event.actions.find((action) => action.semantic === "play-now");
    const queue = event.actions.find((action) => action.semantic === "queue");
    if (!play || !queue) throw new Error("Expected Play and Queue choices");

    const first = service.execute(origin, { actionId: play.actionId });
    const second = service.execute(origin, { actionId: queue.actionId });

    await expect(first).resolves.toEqual({
      success: true,
      data: { claimed: true, outcome: "executed" },
    });
    await expect(second).resolves.toEqual({
      success: true,
      data: { claimed: false },
    });
    expect(coordinator.claimCalls).toBe(1);
    expect(coordinator.claimAccesses[0]).toMatchObject({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      handle: { kind: "action", handleId: "handle-1", generation: 7 },
    });
    expect(coordinator.executeCalls).toHaveLength(1);
    expect(coordinator.executeCalls[0].options).toEqual({
      hierarchy: "artists",
      zoneId: "zone-1",
      itemKey: "raw-play",
    });
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("reports a public Roon refusal without replaying the claimed album action", async () => {
    const event = await resolveRequest();
    coordinator.executeResult = {
      ...browseResult(),
      action: "message",
      isError: true,
      message: "This album is unavailable",
    };

    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toEqual({
      success: true,
      data: {
        claimed: true,
        outcome: "rejected",
        code: "ROON_REJECTED",
        error: "This album is unavailable",
      },
    });
    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toEqual({ success: true, data: { claimed: false } });
    expect(coordinator.executeCalls).toHaveLength(1);
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("leaves an unrecognized issued album response uncertain without replaying it", async () => {
    const event = await resolveRequest();
    coordinator.executeResult = { ...browseResult(), action: undefined };

    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toMatchObject({
      success: true,
      data: { claimed: true, outcome: "outcome-unknown" },
    });
    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toEqual({ success: true, data: { claimed: false } });
    expect(coordinator.executeCalls).toHaveLength(1);
    expect(coordinator.quarantineCalls).toBe(1);
  });

  it("executes an artists-resolved binding (library album page) against the artists hierarchy", async () => {
    resolverImpl = () => Promise.resolve(resolvedActions("artists"));
    const event = await resolveRequest();
    const play = event.actions.find((action) => action.semantic === "play-now");
    if (!play) throw new Error("Expected a Play Now choice");

    await service.execute(origin, { actionId: play.actionId });

    expect(coordinator.executeCalls).toHaveLength(1);
    expect(coordinator.executeCalls[0].options).toEqual({
      hierarchy: "artists",
      zoneId: "zone-1",
      itemKey: "raw-play",
    });
  });

  it("executes a search-resolved binding (search-origin album) against the search hierarchy", async () => {
    resolverImpl = () => Promise.resolve(resolvedActions("search"));
    const event = await resolveRequest();
    const play = event.actions.find((action) => action.semantic === "play-now");
    if (!play) throw new Error("Expected a Play Now choice");

    await service.execute(origin, { actionId: play.actionId });

    expect(coordinator.executeCalls).toHaveLength(1);
    expect(coordinator.executeCalls[0].options).toEqual({
      hierarchy: "search",
      zoneId: "zone-1",
      itemKey: "raw-play",
    });
  });

  it("rejects a regrouped zone after claiming and sends zero execute calls", async () => {
    const event = await resolveRequest();
    currentZone = zone(["output-a", "output-b"]);

    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toMatchObject({
      success: true,
      data: { claimed: true, outcome: "rejected", code: "ZONE_CHANGED" },
    });
    expect(coordinator.claimCalls).toBe(1);
    expect(coordinator.executeCalls).toHaveLength(0);
    expect(coordinator.releaseCalls).toBe(1);
    await expect(
      service.execute(origin, { actionId: event.actions[1].actionId })
    ).resolves.toEqual({ success: true, data: { claimed: false } });
  });

  it("rejects a vanished target zone after claiming and invalidates every choice without dispatch", async () => {
    const event = await resolveRequest();
    currentZone = undefined;

    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toEqual({
      success: true,
      data: {
        claimed: true,
        outcome: "rejected",
        code: "ZONE_NOT_FOUND",
        error: "The target zone disappeared",
      },
    });
    expect(coordinator.claimCalls).toBe(1);
    expect(coordinator.executeCalls).toHaveLength(0);
    expect(coordinator.releaseCalls).toBe(1);
    expect(coordinator.quarantineCalls).toBe(0);
    await expect(
      service.execute(origin, { actionId: event.actions[1].actionId })
    ).resolves.toEqual({ success: true, data: { claimed: false } });
    expect(coordinator.claimCalls).toBe(1);
    expect(coordinator.executeCalls).toHaveLength(0);
  });

  it("lets execute beat a same-turn cancel exactly once and retires every sibling choice", async () => {
    const event = await resolveRequest();
    coordinator.executeMode = "deferred";

    const execution = service.execute(origin, {
      actionId: event.actions[0].actionId,
    });
    const cancellation = service.cancel(origin, {
      operationId: event.operationId,
    });
    const siblingExecution = service.execute(origin, {
      actionId: event.actions[1].actionId,
    });

    expect(cancellation).toEqual({ success: true, data: { claimed: false } });
    await expect(siblingExecution).resolves.toEqual({
      success: true,
      data: { claimed: false },
    });
    expect(coordinator.claimCalls).toBe(1);
    expect(coordinator.executeCalls).toHaveLength(1);
    expect(coordinator.releaseCalls).toBe(0);
    expect(failedEvents).toHaveLength(0);

    coordinator.execution.resolve(browseResult());
    await expect(execution).resolves.toEqual({
      success: true,
      data: { claimed: true, outcome: "executed" },
    });
    expect(coordinator.executeCalls).toHaveLength(1);
    expect(coordinator.releaseCalls).toBe(1);
    expect(coordinator.quarantineCalls).toBe(0);
    expect(failedEvents).toHaveLength(0);
  });

  it("rejects a retired selected version before claiming execute", async () => {
    const event = await resolveRequest();
    pages.current = false;

    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toMatchObject({
      success: true,
      data: { claimed: true, outcome: "rejected", code: "ALBUM_UNRESOLVED" },
    });
    expect(coordinator.claimCalls).toBe(0);
    expect(coordinator.executeCalls).toHaveLength(0);
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("rechecks selected-version authority after claiming and before dispatch", async () => {
    const event = await resolveRequest();
    pages.currentChecks = 0;
    pages.invalidateAtCheck = 2;

    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toMatchObject({
      success: true,
      data: {
        claimed: true,
        outcome: "rejected",
        code: "ALBUM_UNRESOLVED",
      },
    });
    expect(coordinator.claimCalls).toBe(1);
    expect(coordinator.executeCalls).toHaveLength(0);
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("reports a pre-dispatch failure as rejected with clean release", async () => {
    const event = await resolveRequest();
    coordinator.executeMode = "pre-error";

    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toMatchObject({
      success: true,
      data: {
        claimed: true,
        outcome: "rejected",
        code: "ACTION_UNAVAILABLE",
      },
    });
    expect(coordinator.releaseCalls).toBe(1);
    expect(coordinator.quarantineCalls).toBe(0);
  });

  it("reports a post-dispatch failure as outcome unknown and quarantines without retry", async () => {
    const event = await resolveRequest();
    coordinator.executeMode = "post-error";

    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toMatchObject({
      success: true,
      data: { claimed: true, outcome: "outcome-unknown" },
    });
    expect(coordinator.executeCalls).toHaveLength(1);
    expect(coordinator.quarantineCalls).toBe(1);
    expect(coordinator.releaseCalls).toBe(0);
    await expect(
      service.execute(origin, { actionId: event.actions[0].actionId })
    ).resolves.toEqual({ success: true, data: { claimed: false } });
    expect(coordinator.executeCalls).toHaveLength(1);
  });

  it("does not let disconnect cancel an already claimed execute", async () => {
    const event = await resolveRequest();
    coordinator.executeMode = "deferred";

    const execution = service.execute(origin, {
      actionId: event.actions[0].actionId,
    });
    service.disconnectSocket("socket-1");
    expect(coordinator.executeCalls).toHaveLength(1);
    expect(coordinator.releaseCalls).toBe(0);

    coordinator.execution.resolve(browseResult());
    await expect(execution).resolves.toMatchObject({
      success: true,
      data: { claimed: true, outcome: "executed" },
    });
    expect(coordinator.releaseCalls).toBe(1);
  });

  it("turns Core invalidation after dispatch into outcome unknown", async () => {
    const event = await resolveRequest();
    coordinator.executeMode = "deferred";

    const execution = service.execute(origin, {
      actionId: event.actions[0].actionId,
    });
    service.invalidateCore("core-1");
    expect(coordinator.quarantineCalls).toBe(1);

    coordinator.execution.resolve(browseResult());
    await expect(execution).resolves.toMatchObject({
      success: true,
      data: { claimed: true, outcome: "outcome-unknown" },
    });
    expect(coordinator.releaseCalls).toBe(0);
  });

  it("atomically cancels resolving and choosing operations on disconnect", async () => {
    const pending = deferred<ResolvedAlbumActions>();
    resolverImpl = () => pending.promise;
    const resolving = service.begin(origin, request(), sink);
    resolving.start?.();
    await flush();
    service.disconnectSocket("socket-1");
    expect(coordinator.quarantineCalls).toBe(1);

    resolverImpl = () => Promise.resolve(resolvedActions());
    const choosingEvent = await resolveRequest(
      request({ requestId: "request-2" })
    );
    service.disconnectSocket("socket-1");
    expect(coordinator.releaseCalls).toBe(1);
    await expect(
      service.execute(origin, { actionId: choosingEvent.actions[0].actionId })
    ).resolves.toEqual({ success: true, data: { claimed: false } });
  });

  // `.agents/plans/library-live-view.md` Slice 2. A live album page acts on the
  // row Roon rendered, so the request carries a reference instead of a page and
  // a version — and the whole of the two-phase machine still applies to it.
  describe("live library references", () => {
    function referenceRequest(
      patch: Partial<AlbumActionReferenceBeginRequest> = {}
    ): AlbumActionBeginRequest {
      return {
        requestId: "request-1",
        ref: { generation: "gen-live-1", token: "token-play-album" },
        zoneId: "zone-1",
        tabId: "tab-1",
        generation: 7,
        ...patch,
      };
    }

    it("resolves on the library channel the reference was published on", async () => {
      const event = await resolveRequest(referenceRequest());

      // The page port is never consulted: there is no page.
      expect(pages.claimCalls).toBe(0);
      expect(coordinator.runCalls).toBe(0);
      expect(coordinator.libraryRunCalls).toHaveLength(1);
      expect(coordinator.libraryRunCalls[0].anchor).toEqual({
        sessionScope: "catalog-session-1",
        authorityGeneration: 4,
      });
      expect(referenceCalls).toEqual([
        {
          source: {
            itemKey: "roon-key-for-token-play-album",
            hierarchy: "albums",
            title: "3 Feet High and Rising",
          },
          zoneId: "zone-1",
          sessionScope: "catalog-session-1",
        },
      ]);
      // Nothing keyed reaches the reader, exactly as on the page path.
      expect(JSON.stringify(event)).not.toContain("roon-key-for");
    });

    it("reports a public Roon refusal on the anchored library channel", async () => {
      const event = await resolveRequest(referenceRequest());
      coordinator.executeResult = {
        ...browseResult(),
        action: "message",
        isError: true,
        message: "This track is unavailable",
      };

      await expect(
        service.execute(origin, { actionId: event.actions[0].actionId })
      ).resolves.toEqual({
        success: true,
        data: {
          claimed: true,
          outcome: "rejected",
          code: "ROON_REJECTED",
          error: "This track is unavailable",
        },
      });
      await expect(
        service.execute(origin, { actionId: event.actions[0].actionId })
      ).resolves.toEqual({ success: true, data: { claimed: false } });
      expect(coordinator.libraryExecuteCalls).toHaveLength(1);
      expect(coordinator.executeCalls).toHaveLength(0);
      expect(coordinator.releaseCalls).toBe(1);
    });

    it("dispatches execution back onto the same anchored library channel", async () => {
      const event = await resolveRequest(referenceRequest());

      await expect(
        service.execute(origin, { actionId: event.actions[0].actionId })
      ).resolves.toEqual({
        success: true,
        data: { claimed: true, outcome: "executed" },
      });

      // The claim is still taken on the lease, and the dispatch still goes to
      // the channel that found the leaf — never the action lease's own.
      expect(coordinator.claimCalls).toBe(1);
      expect(coordinator.executeCalls).toHaveLength(0);
      expect(coordinator.libraryExecuteCalls).toHaveLength(1);
      expect(coordinator.libraryExecuteCalls[0].anchor).toEqual({
        sessionScope: "catalog-session-1",
        authorityGeneration: 4,
      });
      expect(coordinator.libraryExecuteCalls[0].options).toEqual({
        hierarchy: "albums",
        zoneId: "zone-1",
        itemKey: "raw-play",
      });
    });

    it("refuses a retired reference at begin, and says so", async () => {
      library.retired = true;

      const reservation = service.begin(origin, referenceRequest(), sink);

      // Reported, never a silent no-op and never somebody else's album.
      expect(reservation.ack).toEqual({
        success: false,
        code: "SESSION_LOST",
        error: "That row is no longer part of the current library",
      });
      expect(reservation.start).toBeUndefined();
      expect(coordinator.acquireCalls).toBe(0);
      expect(coordinator.libraryRunCalls).toHaveLength(0);
    });

    it.each(["STALE_GENERATION", "SESSION_LOST"] as const)(
      "reports %s library authority during resolution as a lost session",
      async (code) => {
        coordinator.libraryRunError = new BrowseSessionCoordinatorError(
          code,
          "retired"
        );
        const reservation = service.begin(origin, referenceRequest(), sink);
        expect(reservation.ack.success).toBe(true);

        reservation.start?.();
        await flush();

        expect(resolvedEvents).toHaveLength(0);
        expect(failedEvents).toHaveLength(1);
        expect(failedEvents[0]).toMatchObject({
          code: "SESSION_LOST",
          error: "The album action session was lost",
        });
        expect(coordinator.quarantineCalls).toBe(1);
      }
    );

    it("refuses to execute a reference whose snapshot was retired mid-choice", async () => {
      const event = await resolveRequest(referenceRequest());
      library.retired = true;

      await expect(
        service.execute(origin, { actionId: event.actions[0].actionId })
      ).resolves.toEqual({
        success: true,
        data: {
          claimed: true,
          outcome: "rejected",
          code: "ALBUM_UNRESOLVED",
          error: "The selected album version is no longer current",
        },
      });
      // Refused before the claim and before any dispatch: nothing played.
      expect(coordinator.libraryExecuteCalls).toHaveLength(0);
      expect(coordinator.claimCalls).toBe(0);
    });

    it("refuses leaves that surfaced on a hierarchy the reference does not live on", async () => {
      library.hierarchy = "artists";
      const resolver = (
        service as unknown as { resolver: AlbumActionResolverPort }
      ).resolver;
      jest
        .spyOn(resolver, "resolveReference")
        .mockResolvedValue(resolvedActions("search"));

      const reservation = service.begin(origin, referenceRequest(), sink);
      reservation.start?.();
      await flush();

      expect(resolvedEvents).toHaveLength(0);
      expect(failedEvents[failedEvents.length - 1]).toMatchObject({
        code: "NO_SUPPORTED_ACTIONS",
      });
    });
  });
});
