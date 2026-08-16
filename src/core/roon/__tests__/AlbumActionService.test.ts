import { Logger } from "pino";

import { createCatalogTrackTitleFingerprint } from "../../catalog/CatalogReconciliation";
import {
  AlbumActionCoordinatorPort,
  AlbumActionEventSink,
  AlbumActionOrigin,
  AlbumActionPageAuthority,
  AlbumActionPagePort,
  AlbumActionService,
  AlbumActionZonePort,
} from "../AlbumActionService";
import {
  AlbumActionResolutionError,
  AlbumActionResolverPort,
  AlbumActionVersionSource,
  ResolvedAlbumActions,
} from "../AlbumActionResolver";
import {
  ActionSessionAccess,
  ActionSessionHandle,
  BrowseSessionCoordinatorError,
  CoordinatedBrowseSession,
} from "../BrowseSessionCoordinator";
import { RoonTimeoutError } from "../errors";
import {
  AlbumActionBeginRequest,
  AlbumActionFailedEvent,
  AlbumActionResolvedEvent,
} from "../../../shared/albumActionContracts";
import { AlbumRef, ArtistRef } from "../../../shared/catalogContracts";
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
  return { level: 0, offset: 0, count: 0, items: [] };
}

function album(patch: Partial<AlbumRef> = {}): AlbumRef {
  const tracks = ["1. First", "2. Second"];
  return {
    localId: "018f0f64-3f31-7a9b-8c2d-8f572cb18a12",
    coreId: "core-1",
    artistLocalId: "018f0f64-3f31-7a9b-8c2d-8f572cb18a13",
    exactTitle: "Album",
    exactArtist: "Artist",
    normalizedTitle: "album",
    normalizedArtist: "artist",
    editionText: "",
    trackTitleFingerprint: createCatalogTrackTitleFingerprint(tracks),
    firstSeenAt: "2026-07-14T00:00:00.000Z",
    lastSeenAt: "2026-07-14T00:00:00.000Z",
    resolutionStatus: "resolved",
    ...patch,
  } as AlbumRef;
}

function artist(): ArtistRef {
  return {
    localId: "018f0f64-3f31-7a9b-8c2d-8f572cb18a13",
    coreId: "core-1",
    exactName: "Artist",
    normalizedName: "artist",
    firstSeenAt: "2026-07-14T00:00:00.000Z",
    lastSeenAt: "2026-07-14T00:00:00.000Z",
    resolutionStatus: "resolved",
  };
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

function resolvedActions(): ResolvedAlbumActions {
  return {
    actions: [
      { label: "Play Now", semantic: "play-now", itemKey: "raw-play" },
      { label: "Add Next", semantic: "add-next", itemKey: "raw-next" },
      { label: "Queue", semantic: "queue", itemKey: "raw-queue" },
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

function versionSource(): AlbumActionVersionSource {
  return {
    album: album(),
    artist: artist(),
    detailDigest: "detail-digest",
    versionCount: 2,
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
    retainedItemKey: "retained-version-row",
    source: versionSource(),
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
  public releaseCalls = 0;
  public quarantineCalls = 0;
  public acquireError?: Error;
  public releaseError?: Error;
  public claimResult = true;
  public executeMode: "success" | "pre-error" | "post-error" | "deferred" =
    "success";
  public execution = deferred<BrowseResult>();
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
    return Promise.resolve(browseResult());
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

describe("AlbumActionService", () => {
  let coordinator: FakeCoordinator;
  let pages: FakePages;
  let currentZone: Zone | undefined;
  let resolverImpl: (
    session: CoordinatedBrowseSession,
    source: Readonly<AlbumActionVersionSource>,
    zoneId: string
  ) => Promise<ResolvedAlbumActions>;
  let resolverCalls: Array<{
    source: Readonly<AlbumActionVersionSource>;
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
    currentZone = zone();
    resolverCalls = [];
    resolverImpl = () => Promise.resolve(resolvedActions());
    const resolver: AlbumActionResolverPort = {
      resolve: () => {
        throw new Error("Legacy catalog resolution must not be used");
      },
      resolveSelectedVersion: (session, source, zoneId) => {
        resolverCalls.push({ source, zoneId });
        return resolverImpl(session, source, zoneId);
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
    expect(invalid.ack).toMatchObject({ success: false, code: "INVALID_REQUEST" });
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

  it("claims once, executes the exact stored key and zone, and invalidates siblings", async () => {
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
      hierarchy: "search",
      zoneId: "zone-1",
      itemKey: "raw-play",
    });
    expect(coordinator.releaseCalls).toBe(1);
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
});
