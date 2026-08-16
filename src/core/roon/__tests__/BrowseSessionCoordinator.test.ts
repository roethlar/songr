import { BrowseService } from "../BrowseService";
import {
  ActionSessionHandle,
  BrowseSessionLimits,
  BrowseSessionCoordinator,
  BrowseSessionCoordinatorError,
  CLASSIC_SESSION_ROLES,
  ModeSessionAccess,
  ModeSessionHandle,
} from "../BrowseSessionCoordinator";
import { RoonTimeoutError } from "../errors";

const EMPTY_RESULT = {
  level: 0,
  offset: 0,
  count: 0,
  items: [],
};
const TRACKS_PAGE = {
  title: "Tracks",
  level: 1,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("BrowseSessionCoordinator", () => {
  let service: {
    browse: jest.Mock;
    load: jest.Mock;
    pop: jest.Mock;
    reRoot: jest.Mock;
  };
  let coordinator: BrowseSessionCoordinator;

  beforeEach(() => {
    service = {
      browse: jest.fn().mockResolvedValue(EMPTY_RESULT),
      load: jest.fn().mockResolvedValue(EMPTY_RESULT),
      pop: jest.fn().mockResolvedValue(EMPTY_RESULT),
      reRoot: jest.fn().mockResolvedValue(undefined),
    };
    coordinator = makeCoordinator();
  });

  afterEach(() => {
    coordinator.shutdown();
    jest.useRealTimers();
  });

  function makeCoordinator(
    limits: Partial<BrowseSessionLimits> = {}
  ): BrowseSessionCoordinator {
    return new BrowseSessionCoordinator(service as unknown as BrowseService, {
      // Deliberately collide the random source: the coordinator must still
      // never reuse a handle or raw session name within the process.
      randomId: () => "fixed-random",
      limits,
    });
  }

  function modeAccess(
    handle: ModeSessionHandle,
    overrides: Partial<Omit<ModeSessionAccess, "handle">> = {}
  ): ModeSessionAccess {
    return {
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      handle,
      ...overrides,
    };
  }

  async function classicHandle(): Promise<ModeSessionHandle> {
    return coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
  }

  function actionAccess(handle: ActionSessionHandle) {
    return {
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      handle,
    };
  }

  it("allocates only opaque handles and the exact Classic channel counts", async () => {
    const classic = await coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "classic-tab",
      mode: "classic",
    });
    const second = await coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-2",
      tabId: "second-tab",
      mode: "classic",
    });

    expect(Object.keys(classic).sort()).toEqual([
      "generation",
      "handleId",
      "kind",
      "mode",
    ]);
    expect(JSON.stringify([classic, second])).not.toMatch(
      /multi_session|sessionName|classic-browse/
    );
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      activeTabs: 2,
      classicTabs: 2,
      sessions: 8,
      activeSessions: 8,
    });
  });

  it("rejects the retired timeline mode as an unknown browse mode", () => {
    expect(() =>
      coordinator.acquireMode({
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        mode: "timeline" as never,
      })
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ROLE",
        message: "Unknown browse mode",
      })
    );
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      activeTabs: 0,
      sessions: 0,
    });
  });

  it("binds published Classic item tokens to one generation and role", () => {
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const access = modeAccess(handle);
    const published = coordinator.publishClassicBrowseResult(access, "classic-browse", {
      level: 0,
      offset: 0,
      count: 1,
      items: [
        {
          title: "Album",
          itemKey: "raw-roon-key",
          isLoadable: true,
          isPlayable: false,
        },
      ],
    });
    const token = published.items[0]?.itemKey;

    expect(token).toBeDefined();
    expect(token).not.toBe("raw-roon-key");
    expect(coordinator.resolveClassicItemKey(access, "classic-browse", token!)).toBe(
      "raw-roon-key"
    );
    expect(() =>
      coordinator.resolveClassicItemKey(access, "classic-search", token!)
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("atomically replaces Unified song bindings and retains descriptors only on the server", () => {
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const access = modeAccess(handle);
    const firstGeneration = coordinator.beginClassicPublishedItems(
      access,
      "classic-search"
    );
    const first = coordinator.replaceClassicPublishedItems(
      access,
      "classic-search",
      firstGeneration,
      [
        {
          title: "Dear Theodosia",
          subtitle: "Orlando Ballet Chorus",
          itemKey: "raw-song-key",
          imageKey: "song-image",
          isLoadable: false,
          isPlayable: true,
        },
      ],
      TRACKS_PAGE
    )[0]!;

    expect(first.token).not.toBe("raw-song-key");
    expect(first.item.itemKey).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("raw-song-key");
    expect(
      coordinator.resolveClassicPublishedItem(
        access,
        "classic-search",
        first.token
      )
    ).toMatchObject({
      title: "Dear Theodosia",
      itemKey: "raw-song-key",
    });

    const secondGeneration = coordinator.beginClassicPublishedItems(
      access,
      "classic-search"
    );
    const second = coordinator.replaceClassicPublishedItems(
      access,
      "classic-search",
      secondGeneration,
      [
        {
          title: "Wait for It",
          itemKey: "raw-second-key",
          isLoadable: false,
          isPlayable: true,
        },
      ],
      TRACKS_PAGE
    )[0]!;

    expect(() =>
      coordinator.resolveClassicPublishedItem(
        access,
        "classic-search",
        first.token
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    expect(
      coordinator.resolveClassicPublishedItem(
        access,
        "classic-search",
        second.token
      ).itemKey
    ).toBe("raw-second-key");
    expect(() =>
      coordinator.resolveClassicPublishedItem(
        modeAccess(handle, { socketId: "socket-elsewhere" }),
        "classic-search",
        second.token
      )
    ).toThrow(expect.objectContaining({ code: "OWNER_MISMATCH" }));
  });

  it("keeps palette and row resolution on one mutually exclusive song-authority generation", () => {
    expect(CLASSIC_SESSION_ROLES).toEqual([
      "classic-browse",
      "classic-search",
      "classic-explore",
      "classic-composition",
    ]);
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const access = modeAccess(handle);
    const searchGeneration = coordinator.beginClassicPublishedItems(
      access,
      "classic-search"
    );
    const search = coordinator.replaceClassicPublishedItems(
      access,
      "classic-search",
      searchGeneration,
      [
        {
          title: "Palette result",
          itemKey: "raw-palette",
          isLoadable: false,
          isPlayable: true,
        },
      ],
      TRACKS_PAGE
    )[0]!;
    const resolverGeneration = coordinator.beginClassicPublishedItems(
      access,
      "classic-search"
    );
    const resolver = coordinator.replaceClassicPublishedItems(
      access,
      "classic-search",
      resolverGeneration,
      [
        {
          title: "Resolver result",
          itemKey: "raw-resolver",
          isLoadable: false,
          isPlayable: true,
        },
      ],
      TRACKS_PAGE
    )[0]!;

    expect(
      coordinator.resolveClassicPublishedItem(
        access,
        "classic-search",
        resolver.token
      ).itemKey
    ).toBe("raw-resolver");
    expect(() =>
      coordinator.resolveClassicPublishedItem(
        access,
        "classic-search",
        search.token
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("prevents an older overlapping search from republishing retired song IDs", () => {
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const access = modeAccess(handle);
    const older = coordinator.beginClassicPublishedItems(
      access,
      "classic-search"
    );
    const newer = coordinator.beginClassicPublishedItems(
      access,
      "classic-search"
    );

    expect(() =>
      coordinator.replaceClassicPublishedItems(
        access,
        "classic-search",
        older,
        [
          {
            title: "Old result",
            itemKey: "raw-old",
            isLoadable: true,
            isPlayable: false,
          },
        ],
        TRACKS_PAGE
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));

    const published = coordinator.replaceClassicPublishedItems(
      access,
      "classic-search",
      newer,
      [
        {
          title: "New result",
          itemKey: "raw-new",
          isLoadable: true,
          isPlayable: false,
        },
      ],
      TRACKS_PAGE
    );
    expect(
      coordinator.resolveClassicPublishedItem(
        access,
        "classic-search",
        published[0]!.token
      ).itemKey
    ).toBe("raw-new");
  });

  it("keeps song authority only when the restored Tracks rows still match exactly", () => {
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const access = modeAccess(handle);
    const generation = coordinator.beginClassicPublishedItems(
      access,
      "classic-search"
    );
    const retainedRows = [
      {
        title: "Dear Theodosia",
        subtitle: "Orlando Ballet Chorus",
        itemKey: "raw-song-key",
        hint: "action_list",
        isLoadable: true,
        isPlayable: false,
      },
    ];
    const published = coordinator.replaceClassicPublishedItems(
      access,
      "classic-search",
      generation,
      retainedRows,
      TRACKS_PAGE
    );

    expect(
      coordinator.retainClassicPublishedItemsAfterRestore(
        access,
        "classic-search",
        generation,
        {
          ...TRACKS_PAGE,
          offset: 0,
          count: retainedRows.length,
          totalCount: retainedRows.length,
          items: retainedRows,
        }
      )
    ).toBe(true);
    expect(
      coordinator.retainClassicPublishedItemsAfterRestore(
        access,
        "classic-search",
        generation,
        {
          ...TRACKS_PAGE,
          title: "Albums",
          offset: 0,
          count: 1,
          totalCount: 1,
          items: retainedRows,
        }
      )
    ).toBe(false);
    expect(() =>
      coordinator.resolveClassicPublishedItem(
        access,
        "classic-search",
        published[0]!.token
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("runs the final mode action assertion at the exact native handoff", async () => {
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const access = modeAccess(handle);
    const order: string[] = [];
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onIssued();
      order.push("native");
      return Promise.resolve(EMPTY_RESULT);
    });

    await coordinator.runModeAction(
      access,
      "classic-search",
      async (session) => {
        await session.executeAction(
          {
            hierarchy: "search",
            zoneId: "zone-1",
            itemKey: "raw-action",
          },
          () => order.push("assert"),
          () => order.push("issued")
        );
      }
    );

    expect(order).toEqual(["assert", "issued", "native"]);
  });

  it("sends nothing when the exact-handoff mode assertion rejects", async () => {
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const access = modeAccess(handle);
    let nativeIssued = false;
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onIssued();
      nativeIssued = true;
      return Promise.resolve(EMPTY_RESULT);
    });

    await expect(
      coordinator.runModeAction(
        access,
        "classic-search",
        async (session) => {
          await session.executeAction(
            {
              hierarchy: "search",
              zoneId: "zone-1",
              itemKey: "raw-action",
            },
            () => {
              throw new Error("authority changed");
            },
            () => undefined
          );
        }
      )
    ).rejects.toThrow("authority changed");
    expect(nativeIssued).toBe(false);
  });

  it("retires Classic item tokens on disconnect and disconnected replacement", () => {
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const access = modeAccess(handle);
    const token = coordinator.publishClassicBrowseResult(access, "classic-browse", {
      level: 0,
      offset: 0,
      count: 1,
      items: [
        {
          title: "Album",
          itemKey: "raw-roon-key",
          isLoadable: true,
          isPlayable: false,
        },
      ],
    }).items[0]!.itemKey!;

    coordinator.disconnectSocket("core-1", "socket-1");
    coordinator.reconnectMode({
      coreId: "core-1",
      socketId: "socket-2",
      tabId: "tab-1",
      handle,
    });
    expect(() =>
      coordinator.resolveClassicItemKey(
        modeAccess(handle, { socketId: "socket-2" }),
        "classic-browse",
        token
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));

    coordinator.disconnectSocket("core-1", "socket-2");
    const fresh = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-3",
      tabId: "tab-1",
      mode: "classic",
      replaceDisconnected: true,
    });
    expect(fresh.generation).toBeGreaterThan(handle.generation);
    expect(() =>
      coordinator.resolveClassicItemKey(
        modeAccess(fresh, { socketId: "socket-3" }),
        "classic-browse",
        token
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("bounds Classic item-token authority and evicts the oldest token", () => {
    coordinator.shutdown();
    coordinator = makeCoordinator({ maxPublishedItemKeysPerRole: 2 });
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const access = modeAccess(handle);
    const publish = (raw: string) =>
      coordinator.publishClassicBrowseResult(access, "classic-browse", {
        level: 0,
        offset: 0,
        count: 1,
        items: [
          {
            title: raw,
            itemKey: raw,
            isLoadable: true,
            isPlayable: false,
          },
        ],
      }).items[0]!.itemKey!;
    const first = publish("raw-1");
    const second = publish("raw-2");
    const third = publish("raw-3");

    expect(() => coordinator.resolveClassicItemKey(access, "classic-browse", first)).toThrow(
      expect.objectContaining({ code: "STALE_GENERATION" })
    );
    expect(coordinator.resolveClassicItemKey(access, "classic-browse", second)).toBe("raw-2");
    expect(coordinator.resolveClassicItemKey(access, "classic-browse", third)).toBe("raw-3");
  });

  it("enforces eight tabs without allocating anything for the rejected ninth", async () => {
    for (let index = 0; index < 8; index += 1) {
      await coordinator.acquireMode({
        coreId: "core-1",
        socketId: `socket-${index}`,
        tabId: `tab-${index}`,
        mode: "classic",
      });
    }
    const before = coordinator.diagnostics("core-1");

    expect(() =>
      coordinator.acquireMode({
        coreId: "core-1",
        socketId: "socket-9",
        tabId: "tab-9",
        mode: "classic",
      })
    ).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));
    expect(coordinator.diagnostics("core-1")).toEqual(before);
  });

  it("enforces one catalog and four pinned action leases", async () => {
    const catalog = await coordinator.acquireCatalog("core-1");
    expect(() => coordinator.acquireCatalog("core-1")).toThrow(
      expect.objectContaining({ code: "BACKPRESSURE" })
    );

    const modes: ModeSessionHandle[] = [];
    const actions: ActionSessionHandle[] = [];
    for (let index = 0; index < 4; index += 1) {
      modes.push(
        coordinator.acquireMode({
          coreId: "core-1",
          socketId: `socket-${index}`,
          tabId: `tab-${index}`,
          mode: "classic",
        })
      );
      actions.push(
        coordinator.acquireAction({
          coreId: "core-1",
          socketId: `socket-${index}`,
          tabId: `tab-${index}`,
          leaseId: `lease-${index}`,
          zoneId: `zone-${index}`,
          generation: modes[index].generation,
        })
      );
    }
    const before = coordinator.diagnostics("core-1");
    expect(() =>
      coordinator.acquireAction({
        coreId: "core-1",
        socketId: "socket-0",
        tabId: "tab-0",
        leaseId: "lease-5",
        zoneId: "zone-0",
        generation: modes[0].generation,
      })
    ).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));
    expect(coordinator.diagnostics("core-1")).toEqual(before);

    await coordinator.releaseCatalog("core-1", catalog);
    await coordinator.releaseAction({
      coreId: "core-1",
      socketId: "socket-0",
      tabId: "tab-0",
      handle: actions[0],
    });
  });

  it("serializes one channel while allowing independent Classic roles to run", async () => {
    const handle = await coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const access = modeAccess(handle);
    const firstGate = deferred<void>();
    const order: string[] = [];

    const first = coordinator.runMode(access, "classic-browse", async () => {
      order.push("browse-1-start");
      await firstGate.promise;
      order.push("browse-1-end");
      return 1;
    });
    const second = coordinator.runMode(access, "classic-browse", async () => {
      order.push("browse-2");
      return 2;
    });
    const search = coordinator.runMode(access, "classic-search", async () => {
      order.push("search");
      return 3;
    });

    await flushPromises();
    expect(order).toEqual(["browse-1-start", "search"]);
    await expect(search).resolves.toBe(3);
    firstGate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual([
      "browse-1-start",
      "search",
      "browse-1-end",
      "browse-2",
    ]);
  });

  it("keeps a rejected channel task from poisoning its queue", async () => {
    const handle = await classicHandle();
    const access = modeAccess(handle);
    await expect(
      coordinator.runMode(access, "classic-browse", async () => {
        throw new Error("expected failure");
      })
    ).rejects.toThrow("expected failure");
    await expect(
      coordinator.runMode(access, "classic-browse", async () => "next")
    ).resolves.toBe("next");
  });

  it("serializes concurrent facade calls inside one coordinated task", async () => {
    const handle = await classicHandle();
    const gate = deferred<typeof EMPTY_RESULT>();
    service.browse.mockReturnValueOnce(gate.promise);

    const run = coordinator.runMode(
      modeAccess(handle),
      "classic-browse",
      async (session) => {
        const browse = session.browse({ hierarchy: "browse" });
        const load = session.load({ hierarchy: "browse" });
        return Promise.all([browse, load]);
      }
    );
    await flushPromises();
    expect(service.browse).toHaveBeenCalledTimes(1);
    expect(service.load).not.toHaveBeenCalled();
    gate.resolve(EMPTY_RESULT);
    await expect(run).resolves.toHaveLength(2);
    expect(service.load).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-owner, cross-Core, stale generation, and wrong-role access", async () => {
    const handle = await classicHandle();
    expect(() =>
      coordinator.runMode(
        modeAccess(handle, { socketId: "other-socket" }),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "OWNER_MISMATCH" }));
    expect(() =>
      coordinator.runMode(
        modeAccess(handle, { coreId: "other-core" }),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "OWNER_MISMATCH" }));
    expect(() =>
      coordinator.runMode(
        modeAccess({ ...handle, generation: handle.generation + 1 }),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    expect(() =>
      coordinator.runMode(modeAccess(handle), "catalog" as never, async () => undefined)
    ).toThrow(expect.objectContaining({ code: "INVALID_ROLE" }));
  });

  it("rejects duplicate ownership of one active tab", async () => {
    await classicHandle();
    expect(() =>
      coordinator.acquireMode({
        coreId: "core-1",
        socketId: "other-socket",
        tabId: "tab-1",
        mode: "classic",
      })
    ).toThrow(expect.objectContaining({ code: "OWNER_MISMATCH" }));
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      activeTabs: 1,
      sessions: 4,
    });
  });

  it("never starts queued work or publishes an in-flight result after release", async () => {
    const handle = await classicHandle();
    const access = modeAccess(handle);
    const gate = deferred<string>();
    const queuedWork = jest.fn(async () => "queued");
    const inFlight = coordinator.runMode(
      access,
      "classic-browse",
      async () => gate.promise
    );
    const inFlightAssertion = expect(inFlight).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
    await flushPromises();
    const queued = coordinator.runMode(access, "classic-browse", queuedWork);
    const queuedAssertion = expect(queued).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
    const release = coordinator.releaseMode(access);

    gate.resolve("late result");
    await inFlightAssertion;
    await queuedAssertion;
    await release;
    expect(queuedWork).not.toHaveBeenCalled();
  });

  it("acquires and uses a fresh generation while abandoned work is still running", async () => {
    const abandoned = await classicHandle();
    const gate = deferred<string>();
    const oldRun = coordinator.runMode(
      modeAccess(abandoned),
      "classic-browse",
      async () => gate.promise
    );
    const oldAssertion = expect(oldRun).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
    await flushPromises();

    const fresh = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    await expect(
      coordinator.runMode(
        modeAccess(fresh),
        "classic-browse",
        async () => "fresh result"
      )
    ).resolves.toBe("fresh result");

    gate.resolve("abandoned result");
    await oldAssertion;
  });

  it("rejects a stale Roon result before callback code can consume it", async () => {
    const oldHandle = await classicHandle();
    const roonResult = deferred<typeof EMPTY_RESULT>();
    service.browse.mockReturnValueOnce(roonResult.promise);
    let consumed = false;
    const oldRun = coordinator.runMode(
      modeAccess(oldHandle),
      "classic-browse",
      async (session) => {
        await session.browse({ hierarchy: "browse" });
        consumed = true;
      }
    );
    const oldAssertion = expect(oldRun).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
    await flushPromises();
    expect(service.browse).toHaveBeenCalledTimes(1);

    const fresh = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    roonResult.resolve(EMPTY_RESULT);
    await oldAssertion;
    expect(consumed).toBe(false);
    await expect(
      coordinator.runMode(
        modeAccess(fresh),
        "classic-browse",
        async () => "fresh"
      )
    ).resolves.toBe("fresh");
  });

  it("drains an unawaited browse call before release cleanup can re-root", async () => {
    const handle = await classicHandle();
    const browseGate = deferred<typeof EMPTY_RESULT>();
    service.browse.mockReturnValueOnce(browseGate.promise);
    const run = coordinator.runMode(
      modeAccess(handle),
      "classic-browse",
      async (session) => {
        void session.browse({ hierarchy: "browse" });
        throw new Error("primary callback failure");
      }
    );
    const runAssertion = expect(run).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
    await flushPromises();
    const release = coordinator.releaseMode(modeAccess(handle));
    let releaseSettled = false;
    void release.then(() => {
      releaseSettled = true;
    });
    await flushPromises();
    expect(service.reRoot).not.toHaveBeenCalled();
    expect(releaseSettled).toBe(false);

    browseGate.resolve(EMPTY_RESULT);
    await runAssertion;
    await release;
    expect(service.reRoot).toHaveBeenCalledTimes(1);
  });

  it("mints fresh private names on replacement and rejects the old handle", async () => {
    const first = await classicHandle();
    await coordinator.runMode(
      modeAccess(first),
      "classic-browse",
      (session) => session.browse({ hierarchy: "browse" })
    );
    const firstName = service.browse.mock.calls[0][0].multiSessionKey;

    const second = await coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    await coordinator.runMode(
      modeAccess(second),
      "classic-browse",
      (session) => session.browse({ hierarchy: "browse" })
    );
    const secondName = service.browse.mock.calls[1][0].multiSessionKey;

    expect(second.generation).toBeGreaterThan(first.generation);
    expect(secondName).not.toBe(firstName);
    expect(() =>
      coordinator.runMode(
        modeAccess(first),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("invalidates old results on Core loss and permits fresh reacquisition", async () => {
    const handle = await classicHandle();
    const gate = deferred<string>();
    const inFlight = coordinator.runMode(
      modeAccess(handle),
      "classic-browse",
      async () => gate.promise
    );
    const assertion = expect(inFlight).rejects.toMatchObject({
      code: "SESSION_LOST",
    });
    await flushPromises();
    const invalidation = coordinator.invalidateCore("core-1");
    gate.resolve("old Core result");
    await assertion;
    await invalidation;

    expect(() =>
      coordinator.runMode(
        modeAccess(handle),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "SESSION_LOST" }));
    const fresh = await classicHandle();
    await expect(
      coordinator.runMode(
        modeAccess(fresh),
        "classic-browse",
        async () => "fresh"
      )
    ).resolves.toBe("fresh");
  });

  it("gives Core loss precedence over a release already waiting on work", async () => {
    const handle = await classicHandle();
    const gate = deferred<string>();
    const run = coordinator.runMode(
      modeAccess(handle),
      "classic-browse",
      async () => gate.promise
    );
    const runAssertion = expect(run).rejects.toMatchObject({
      code: "SESSION_LOST",
    });
    await flushPromises();
    const release = coordinator.releaseMode(modeAccess(handle));
    const invalidation = coordinator.invalidateCore("core-1");
    gate.resolve("late");
    await runAssertion;
    await release;
    await invalidation;

    expect(() =>
      coordinator.runMode(
        modeAccess(handle),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "SESSION_LOST" }));
  });

  it("quarantines a timeout until late fulfillment and never reuses its name", async () => {
    coordinator.shutdown();
    coordinator = makeCoordinator({ maxPhysicalSessionsPerCore: 8 });
    const late = deferred<void>();
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onTimeout(late.promise);
      return Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
    });
    const first = await classicHandle();
    const run = coordinator.runMode(
      modeAccess(first),
      "classic-browse",
      (session) => session.browse({ hierarchy: "browse" })
    );
    await expect(run).rejects.toBeInstanceOf(RoonTimeoutError);
    const abandonedName = service.browse.mock.calls[0][0].multiSessionKey;
    expect(coordinator.diagnostics("core-1").quarantinedSessions).toBe(1);

    const replacement = await classicHandle();
    await coordinator.runMode(
      modeAccess(replacement),
      "classic-browse",
      (session) => session.browse({ hierarchy: "browse" })
    );
    const freshName = service.browse.mock.calls[1][0].multiSessionKey;
    expect(freshName).not.toBe(abandonedName);
    expect(() =>
      coordinator.acquireMode({
        coreId: "core-1",
        socketId: "socket-2",
        tabId: "tab-2",
        mode: "classic",
      })
    ).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));

    late.resolve();
    await flushPromises();
    expect(coordinator.diagnostics("core-1").quarantinedSessions).toBe(0);
    expect(
      coordinator.acquireMode({
        coreId: "core-1",
        socketId: "socket-2",
        tabId: "tab-2",
        mode: "classic",
      })
    ).toMatchObject({ kind: "mode" });
  });

  it("preserves the current generation when replacement has no physical capacity", async () => {
    coordinator.shutdown();
    coordinator = makeCoordinator({ maxPhysicalSessionsPerCore: 8 });
    const first = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-2",
      tabId: "tab-2",
      mode: "classic",
    });

    expect(() =>
      coordinator.acquireMode({
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        mode: "classic",
      })
    ).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      activeTabs: 2,
      sessions: 8,
    });
    await expect(
      coordinator.runMode(
        modeAccess(first),
        "classic-browse",
        async () => "still current"
      )
    ).resolves.toBe("still current");
  });

  it("cleans quarantine after a late rejection or the five-minute reap", async () => {
    jest.useFakeTimers();
    coordinator.shutdown();
    coordinator = makeCoordinator({ quarantineReapMs: 300_000 });
    const lateReject = deferred<void>();
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onTimeout(lateReject.promise);
      return Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
    });
    const first = await classicHandle();
    await expect(
      coordinator.runMode(
        modeAccess(first),
        "classic-browse",
        (session) => session.browse({ hierarchy: "browse" })
      )
    ).rejects.toBeInstanceOf(RoonTimeoutError);
    expect(coordinator.diagnostics("core-1").quarantinedSessions).toBe(1);
    lateReject.reject(new Error("late callback failed"));
    await flushPromises();
    expect(coordinator.diagnostics("core-1").quarantinedSessions).toBe(0);

    const never = deferred<void>();
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onTimeout(never.promise);
      return Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
    });
    const second = await classicHandle();
    await expect(
      coordinator.runMode(
        modeAccess(second),
        "classic-browse",
        (session) => session.browse({ hierarchy: "browse" })
      )
    ).rejects.toBeInstanceOf(RoonTimeoutError);
    jest.advanceTimersByTime(300_000);
    await flushPromises();
    expect(coordinator.diagnostics("core-1").quarantinedSessions).toBe(0);
  });

  it("uses one idempotent cleanup path when late settlement and reap race", async () => {
    jest.useFakeTimers();
    coordinator.shutdown();
    coordinator = makeCoordinator({ quarantineReapMs: 100 });
    const late = deferred<void>();
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onTimeout(late.promise);
      return Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
    });
    const handle = await classicHandle();
    await expect(
      coordinator.runMode(
        modeAccess(handle),
        "classic-browse",
        (session) => session.browse({ hierarchy: "browse" })
      )
    ).rejects.toBeInstanceOf(RoonTimeoutError);

    jest.advanceTimersByTime(100);
    late.resolve();
    await flushPromises();
    expect(coordinator.diagnostics("core-1").sessions).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("re-roots every touched hierarchy once before clean release", async () => {
    const handle = await classicHandle();
    await coordinator.runMode(
      modeAccess(handle),
      "classic-browse",
      async (session) => {
        await session.browse({ hierarchy: "browse" });
        await session.load({ hierarchy: "search" });
      }
    );
    const privateName = service.browse.mock.calls[0][0].multiSessionKey;

    await coordinator.releaseMode(modeAccess(handle));
    expect(service.reRoot.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["browse", privateName],
      ["search", privateName],
    ]);
    expect(coordinator.diagnostics("core-1").sessions).toBe(0);
  });

  it("quarantines a cleanup re-root that times out", async () => {
    const late = deferred<void>();
    const handle = await classicHandle();
    await coordinator.runMode(
      modeAccess(handle),
      "classic-browse",
      (session) => session.browse({ hierarchy: "browse" })
    );
    service.reRoot.mockImplementationOnce((_hierarchy, _key, lifecycle) => {
      lifecycle.onTimeout(late.promise);
      return Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
    });

    await coordinator.releaseMode(modeAccess(handle));
    expect(coordinator.diagnostics("core-1").quarantinedSessions).toBe(1);
    late.resolve();
    await flushPromises();
    expect(coordinator.diagnostics("core-1").sessions).toBe(0);
  });

  it("resets idle expiry on accepted activity and releases after fifteen idle minutes", async () => {
    jest.useFakeTimers();
    coordinator.shutdown();
    coordinator = makeCoordinator({ modeIdleMs: 1_000 });
    const handle = await classicHandle();
    jest.advanceTimersByTime(999);
    await coordinator.runMode(
      modeAccess(handle),
      "classic-browse",
      async () => "activity"
    );
    jest.advanceTimersByTime(999);
    await flushPromises();
    expect(coordinator.diagnostics("core-1").activeTabs).toBe(1);
    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(coordinator.diagnostics("core-1").activeTabs).toBe(0);
  });

  it("does not expire a mode while accepted work is still pending", async () => {
    jest.useFakeTimers();
    coordinator.shutdown();
    coordinator = makeCoordinator({ modeIdleMs: 100 });
    const handle = await classicHandle();
    const gate = deferred<void>();
    const run = coordinator.runMode(
      modeAccess(handle),
      "classic-browse",
      async () => gate.promise
    );
    await flushPromises();
    jest.advanceTimersByTime(1_000);
    await flushPromises();
    expect(coordinator.diagnostics("core-1").activeTabs).toBe(1);
    gate.resolve();
    await run;
    jest.advanceTimersByTime(100);
    await flushPromises();
    expect(coordinator.diagnostics("core-1").activeTabs).toBe(0);
  });

  it("preserves a disconnected mode only when its opaque handle reconnects in grace", async () => {
    jest.useFakeTimers();
    coordinator.shutdown();
    coordinator = makeCoordinator({
      disconnectGraceMs: 100,
      modeIdleMs: 10_000,
    });
    const handle = await classicHandle();
    coordinator.disconnectSocket("core-1", "socket-1");
    jest.advanceTimersByTime(99);
    const reconnected = coordinator.reconnectMode({
      coreId: "core-1",
      tabId: "tab-1",
      socketId: "socket-2",
      handle,
    });
    jest.advanceTimersByTime(101);
    await flushPromises();

    await expect(
      coordinator.runMode(
        modeAccess(reconnected, { socketId: "socket-2" }),
        "classic-browse",
        async () => "connected"
      )
    ).resolves.toBe("connected");
    expect(() =>
      coordinator.runMode(
        modeAccess(handle),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "OWNER_MISMATCH" }));
  });

  it("replaces a disconnected same-tab lease with a fresh generation after reload", async () => {
    jest.useFakeTimers();
    coordinator.shutdown();
    coordinator = makeCoordinator({
      disconnectGraceMs: 100,
      modeIdleMs: 10_000,
    });
    const abandoned = await classicHandle();
    await coordinator.runMode(
      modeAccess(abandoned),
      "classic-browse",
      (session) => session.browse({ hierarchy: "artists" })
    );
    const abandonedName = service.browse.mock.calls[0][0].multiSessionKey;

    coordinator.disconnectSocket("core-1", "socket-1");
    const fresh = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-2",
      tabId: "tab-1",
      mode: "classic",
      replaceDisconnected: true,
    });
    await coordinator.runMode(
      modeAccess(fresh, { socketId: "socket-2" }),
      "classic-browse",
      (session) => session.browse({ hierarchy: "artists" })
    );
    const freshName = service.browse.mock.calls[1][0].multiSessionKey;

    expect(fresh.generation).toBeGreaterThan(abandoned.generation);
    expect(freshName).not.toBe(abandonedName);
    expect(() =>
      coordinator.runMode(
        modeAccess(abandoned),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("does not let a different socket replace an active same-tab lease", async () => {
    await classicHandle();
    expect(() =>
      coordinator.acquireMode({
        coreId: "core-1",
        socketId: "socket-2",
        tabId: "tab-1",
        mode: "classic",
        replaceDisconnected: true,
      })
    ).toThrow(expect.objectContaining({ code: "OWNER_MISMATCH" }));
  });

  it("keeps disconnected replacement explicit for Classic", async () => {
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    coordinator.disconnectSocket("core-1", "socket-1");

    expect(() =>
      coordinator.acquireMode({
        coreId: "core-1",
        socketId: "socket-2",
        tabId: "tab-1",
        mode: "classic",
      })
    ).toThrow(expect.objectContaining({ code: "OWNER_MISMATCH" }));
    const fresh = coordinator.acquireMode({
        coreId: "core-1",
        socketId: "socket-2",
        tabId: "tab-1",
        mode: "classic",
        replaceDisconnected: true,
      });
    expect(fresh.generation).toBeGreaterThan(handle.generation);
    expect(() =>
      coordinator.runMode(
        modeAccess(handle),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("does not bypass physical capacity when replacing a disconnected lease", async () => {
    coordinator.shutdown();
    coordinator = makeCoordinator({ maxPhysicalSessionsPerCore: 4 });
    const abandoned = await classicHandle();
    coordinator.disconnectSocket("core-1", "socket-1");

    expect(() =>
      coordinator.acquireMode({
        coreId: "core-1",
        socketId: "socket-2",
        tabId: "tab-1",
        mode: "classic",
        replaceDisconnected: true,
      })
    ).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));
    expect(
      coordinator.reconnectMode({
        coreId: "core-1",
        tabId: "tab-1",
        socketId: "socket-2",
        handle: abandoned,
      })
    ).toMatchObject({ generation: abandoned.generation });
  });

  it("isolates pending work when disconnected replacement mints a fresh session", async () => {
    const abandoned = await classicHandle();
    const gate = deferred<string>();
    const pending = coordinator.runMode(
      modeAccess(abandoned),
      "classic-browse",
      async () => gate.promise
    );
    const pendingAssertion = expect(pending).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
    await flushPromises();
    coordinator.disconnectSocket("core-1", "socket-1");

    const fresh = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-2",
      tabId: "tab-1",
      mode: "classic",
      replaceDisconnected: true,
    });
    await expect(
      coordinator.runMode(
        modeAccess(fresh, { socketId: "socket-2" }),
        "classic-browse",
        async () => "fresh"
      )
    ).resolves.toBe("fresh");

    gate.resolve("late abandoned result");
    await pendingAssertion;
  });

  it("rejects an old-socket result after reconnect transfers ownership", async () => {
    jest.useFakeTimers();
    coordinator.shutdown();
    coordinator = makeCoordinator({
      disconnectGraceMs: 100,
      modeIdleMs: 10_000,
    });
    const handle = await classicHandle();
    const gate = deferred<void>();
    const inFlight = coordinator.runMode(
      modeAccess(handle),
      "classic-browse",
      async (session) => {
        await gate.promise;
        await session.browse({ hierarchy: "browse" });
        return "old socket result";
      }
    );
    const assertion = expect(inFlight).rejects.toMatchObject({
      code: "OWNER_MISMATCH",
    });
    await flushPromises();
    coordinator.disconnectSocket("core-1", "socket-1");
    coordinator.reconnectMode({
      coreId: "core-1",
      tabId: "tab-1",
      socketId: "socket-2",
      handle,
    });
    gate.resolve();
    await assertion;
    expect(service.browse).not.toHaveBeenCalled();
  });

  it("releases a disconnected mode after the sixty-second grace", async () => {
    jest.useFakeTimers();
    coordinator.shutdown();
    coordinator = makeCoordinator({
      disconnectGraceMs: 100,
      modeIdleMs: 10_000,
    });
    const handle = await classicHandle();
    coordinator.disconnectSocket("core-1", "socket-1");
    jest.advanceTimersByTime(100);
    await flushPromises();
    expect(coordinator.diagnostics("core-1").activeTabs).toBe(0);
    expect(() =>
      coordinator.runMode(
        modeAccess(handle),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "SESSION_LOST" }));
  });

  it("keeps an action slot pinned until in-flight work and cleanup finish", async () => {
    coordinator.shutdown();
    coordinator = makeCoordinator({ maxActionsPerCore: 1 });
    const firstMode = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    const secondMode = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-2",
      tabId: "tab-2",
      mode: "classic",
    });
    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "lease-1",
      zoneId: "zone-1",
      generation: firstMode.generation,
    });
    const gate = deferred<string>();
    const run = coordinator.runAction(actionAccess(action), async () => gate.promise);
    const runAssertion = expect(run).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
    await flushPromises();
    const release = coordinator.releaseAction(actionAccess(action));
    expect(() =>
      coordinator.acquireAction({
        coreId: "core-1",
        socketId: "socket-2",
        tabId: "tab-2",
        leaseId: "lease-2",
        zoneId: "zone-2",
        generation: secondMode.generation,
      })
    ).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));

    gate.resolve("late");
    await runAssertion;
    await release;
    expect(
      coordinator.acquireAction({
        coreId: "core-1",
        socketId: "socket-2",
        tabId: "tab-2",
        leaseId: "lease-2",
        zoneId: "zone-2",
        generation: secondMode.generation,
      })
    ).toMatchObject({ kind: "action" });
  });

  it("rejects an action lease outside its active tab generation", async () => {
    const mode = await classicHandle();
    expect(() =>
      coordinator.acquireAction({
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        leaseId: "stale-action",
        zoneId: "zone-1",
        generation: mode.generation + 1,
      })
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    expect(() =>
      coordinator.acquireAction({
        coreId: "core-1",
        socketId: "other-socket",
        tabId: "tab-1",
        leaseId: "foreign-action",
        zoneId: "zone-1",
        generation: mode.generation,
      })
    ).toThrow(expect.objectContaining({ code: "OWNER_MISMATCH" }));
    expect(coordinator.diagnostics("core-1").actions).toBe(0);
  });

  it("grants action leases to a Classic mode generation", async () => {
    const mode = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });

    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "classic-action",
      zoneId: "zone-1",
      generation: mode.generation,
    });
    expect(action).toMatchObject({ kind: "action" });
    expect(coordinator.diagnostics("core-1").actions).toBe(1);
    await coordinator.releaseAction(actionAccess(action));
    expect(coordinator.diagnostics("core-1").actions).toBe(0);
  });

  it("supports zone-less read leases that can never execute", async () => {
    const mode = await classicHandle();
    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "read-only-action",
      generation: mode.generation,
    });

    await coordinator.runAction(actionAccess(action), (session) =>
      session.browse({ hierarchy: "artists" })
    );
    expect(service.browse.mock.calls[0][0]).toMatchObject({
      hierarchy: "artists",
    });

    await expect(
      coordinator.runAction(actionAccess(action), (session) =>
        session.browse({ hierarchy: "artists", zoneId: "zone-1" })
      )
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

    expect(coordinator.claimActionExecute(actionAccess(action))).toBe(false);
    // Without a claim the execute path can never open, so the zone-less
    // lease is structurally read-only.
    expect(() =>
      coordinator.executeAction(
        actionAccess(action),
        { hierarchy: "artists", zoneId: "zone-1", itemKey: "action-key" },
        () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    await coordinator.releaseAction(actionAccess(action));
  });

  it("rejects an action result before consumption after its mode is replaced", async () => {
    const mode = await classicHandle();
    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "old-action",
      zoneId: "zone-1",
      generation: mode.generation,
    });
    const roonResult = deferred<typeof EMPTY_RESULT>();
    service.browse.mockReturnValueOnce(roonResult.promise);
    let consumed = false;
    const run = coordinator.runAction(actionAccess(action), async (session) => {
      await session.browse({ hierarchy: "search" });
      consumed = true;
    });
    const assertion = expect(run).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
    await flushPromises();
    coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    roonResult.resolve(EMPTY_RESULT);
    await assertion;
    expect(consumed).toBe(false);
    expect(() =>
      coordinator.runAction(actionAccess(action), async () => undefined)
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    await coordinator.releaseAction(actionAccess(action));
  });

  it("leaves action-phase cancellation to its owner on socket disconnect", async () => {
    const mode = await classicHandle();
    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "disconnect-action",
      zoneId: "zone-1",
      generation: mode.generation,
    });

    coordinator.disconnectSocket("core-1", "socket-1");
    await flushPromises();
    expect(coordinator.diagnostics("core-1").actions).toBe(1);
    expect(() =>
      coordinator.runAction(actionAccess(action), async () => undefined)
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    await coordinator.releaseAction(actionAccess(action));
    expect(coordinator.diagnostics("core-1").actions).toBe(0);
  });

  it("requires a drained current mode generation for the execute claim", async () => {
    const mode = await classicHandle();
    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "queued-action",
      zoneId: "zone-1",
      generation: mode.generation,
    });
    const gate = deferred<void>();
    const resolving = coordinator.runAction(actionAccess(action), () => gate.promise);
    const resolvingAssertion = expect(resolving).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
    expect(coordinator.claimActionExecute(actionAccess(action))).toBe(false);

    coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    gate.resolve();

    await resolvingAssertion;
    expect(() => coordinator.claimActionExecute(actionAccess(action))).toThrow(
      expect.objectContaining({ code: "STALE_GENERATION" })
    );
    expect(service.browse).not.toHaveBeenCalled();
    await coordinator.releaseAction(actionAccess(action));
  });

  it("keeps an issued execute server-owned across socket disconnect", async () => {
    const mode = await classicHandle();
    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "issued-action",
      zoneId: "zone-1",
      generation: mode.generation,
    });
    const roonResult = deferred<typeof EMPTY_RESULT>();
    const order: string[] = [];
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onIssued();
      order.push("browse");
      return roonResult.promise;
    });

    expect(coordinator.claimActionExecute(actionAccess(action))).toBe(true);
    expect(coordinator.claimActionExecute(actionAccess(action))).toBe(false);
    const execution = coordinator.executeAction(
      actionAccess(action),
      { hierarchy: "search", zoneId: "zone-1", itemKey: "action-key" },
      () => order.push("issued")
    );
    coordinator.disconnectSocket("core-1", "socket-1");
    await flushPromises();
    expect(order).toEqual(["issued", "browse"]);
    roonResult.resolve(EMPTY_RESULT);
    await expect(execution).resolves.toEqual(EMPTY_RESULT);
    expect(coordinator.diagnostics("core-1").actions).toBe(1);

    await coordinator.releaseAction(actionAccess(action));
    expect(coordinator.diagnostics("core-1").actions).toBe(0);
  });

  it("enforces the original action zone through browse, execute, and cleanup", async () => {
    const mode = await classicHandle();
    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "zone-bound-action",
      zoneId: "zone-1",
      generation: mode.generation,
    });

    await expect(
      coordinator.runAction(actionAccess(action), (session) =>
        session.browse({ hierarchy: "search", zoneId: "zone-2" })
      )
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    expect(service.browse).not.toHaveBeenCalled();

    await coordinator.runAction(actionAccess(action), (session) =>
      session.browse({ hierarchy: "search", zoneId: "zone-1" })
    );
    expect(coordinator.claimActionExecute(actionAccess(action))).toBe(true);
    expect(() =>
      coordinator.executeAction(
        actionAccess(action),
        { hierarchy: "search", zoneId: "zone-2", itemKey: "action-key" },
        () => undefined
      )
    ).toThrow(expect.objectContaining({ code: "OWNER_MISMATCH" }));

    await coordinator.releaseAction(actionAccess(action));
    expect(service.reRoot).toHaveBeenCalledWith(
      "search",
      expect.any(String),
      expect.any(Object),
      "zone-1"
    );
  });

  it("upgrades action quarantine to the underlying late Roon settlement", async () => {
    coordinator.shutdown();
    coordinator = makeCoordinator({ maxActionsPerCore: 1 });
    const mode = await classicHandle();
    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "uncertain-action",
      zoneId: "zone-1",
      generation: mode.generation,
    });
    const browseResult = deferred<typeof EMPTY_RESULT>();
    const lateRoonSettlement = deferred<void>();
    let lifecycle: { onTimeout: (late: Promise<void>) => void } | undefined;
    service.browse.mockImplementationOnce((_options, value) => {
      lifecycle = value;
      return browseResult.promise;
    });
    const run = coordinator.runAction(actionAccess(action), (session) =>
      session.browse({ hierarchy: "search", zoneId: "zone-1" })
    );
    await flushPromises();

    coordinator.quarantineAction(actionAccess(action));
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      actions: 1,
      quarantinedSessions: 1,
    });
    expect(() =>
      coordinator.acquireAction({
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        leaseId: "replacement-action",
        zoneId: "zone-1",
        generation: mode.generation,
      })
    ).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));

    lifecycle?.onTimeout(lateRoonSettlement.promise);
    browseResult.reject(new RoonTimeoutError("browse.browse", 15_000));
    await expect(run).rejects.toBeInstanceOf(RoonTimeoutError);
    await flushPromises();
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      actions: 1,
      quarantinedSessions: 1,
    });

    lateRoonSettlement.resolve();
    await flushPromises();
    await flushPromises();
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      actions: 0,
      quarantinedSessions: 0,
    });
    expect(
      coordinator.acquireAction({
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        leaseId: "replacement-action",
        zoneId: "zone-1",
        generation: mode.generation,
      })
    ).toMatchObject({ kind: "action" });
  });

  it("serializes the singleton catalog channel", async () => {
    const catalog = coordinator.acquireCatalog("core-1");
    const gate = deferred<void>();
    const order: string[] = [];
    const first = coordinator.runCatalog("core-1", catalog, async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
    });
    const second = coordinator.runCatalog("core-1", catalog, async () => {
      order.push("second");
    });
    await flushPromises();
    expect(order).toEqual(["first-start"]);
    gate.resolve();
    await first;
    await second;
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("rejects attempts to smuggle a raw session key into the facade", async () => {
    const handle = await classicHandle();
    await expect(
      coordinator.runMode(
        modeAccess(handle),
        "classic-browse",
        (session) =>
          session.browse({
            hierarchy: "browse",
            multiSessionKey: "client-chosen",
          } as never)
      )
    ).rejects.toMatchObject({ code: "INVALID_HANDLE" });
    expect(service.browse).not.toHaveBeenCalled();
  });

  it("clears idle, grace, and quarantine timers on shutdown", async () => {
    jest.useFakeTimers();
    const handle = await classicHandle();
    coordinator.disconnectSocket("core-1", "socket-1");
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    coordinator.shutdown();
    expect(jest.getTimerCount()).toBe(0);
    expect(() =>
      coordinator.runMode(
        modeAccess(handle),
        "classic-browse",
        async () => undefined
      )
    ).toThrow(BrowseSessionCoordinatorError);
  });
});
