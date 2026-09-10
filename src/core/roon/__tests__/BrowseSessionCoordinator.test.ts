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

  it("bounds non-collection Classic item-token authority and evicts the oldest token", () => {
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
      coordinator.publishClassicBrowseResult(access, "classic-composition", {
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

    expect(() => coordinator.resolveClassicItemKey(access, "classic-composition", first)).toThrow(
      expect.objectContaining({ code: "STALE_GENERATION" })
    );
    expect(coordinator.resolveClassicItemKey(access, "classic-composition", second)).toBe("raw-2");
    expect(coordinator.resolveClassicItemKey(access, "classic-composition", third)).toBe("raw-3");
  });

  it.each(["classic-browse", "classic-search", "classic-explore"] as const)("retains exact first and last %s collection tokens after loading more than 8192 rows", async (role) => {
    const access = modeAccess(await classicHandle());
    const total = 8_193;
    let first = "";
    let second = "";
    let last = "";
    for (let offset = 0; offset < total; offset += 4_000) {
      const items = Array.from({ length: Math.min(4_000, total - offset) }, (_, index) => ({
        title: "Same title", subtitle: "Same artist", itemKey: `track-${offset + index}`,
        hint: "action_list", isLoadable: true, isPlayable: false,
      }));
      const result = coordinator.publishClassicBrowseResult(access, role, {
        title: "Tracks", level: 2, offset, count: total, totalCount: total, items,
      });
      if (offset === 0) { first = result.items[0].itemKey!; second = result.items[1].itemKey!; }
      last = result.items[result.items.length - 1].itemKey!;
    }
    expect(first).not.toBe(second);
    expect(coordinator.resolveClassicItemKey(access, role, first)).toBe("track-0");
    expect(coordinator.resolveClassicItemKey(access, role, second)).toBe("track-1");
    expect(coordinator.resolveClassicItemKey(access, role, last)).toBe("track-8192");
  });

  it.each(["classic-browse", "classic-search", "classic-explore"] as const)("refuses %s collection overflow atomically and reclaims capacity only at a new generation", async (role) => {
    coordinator.shutdown();
    coordinator = makeCoordinator({
      maxPublishedItemKeysPerRole: 2, maxPublishedBrowseCollectionItemKeys: 3,
    });
    const access = modeAccess(await classicHandle());
    const publish = (keys: string[], title = "Same title") => coordinator.publishClassicBrowseResult(
      access, role, {
        title: "Tracks", level: 2, offset: 0, count: keys.length,
        items: keys.map((itemKey) => ({ title, itemKey, isLoadable: true, isPlayable: false })),
      }
    );
    const first = publish(["raw-a", "raw-b", "raw-c"]);
    const token = first.items[0].itemKey!;
    expect(() => publish(["raw-a", "raw-d", "raw-e", "raw-f"], "Attempted overwrite"))
      .toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));
    expect(coordinator.resolveClassicPublishedItem(access, role, token))
      .toMatchObject({ title: "Same title", itemKey: "raw-a" });
    // The rejected page must neither consume capacity nor evict existing rows.
    const next = publish(["raw-d", "raw-e"]);
    expect(coordinator.resolveClassicItemKey(access, role, next.items[1].itemKey!)).toBe("raw-e");
    expect(publish(["raw-a", "raw-a"]).items.map((item) => item.itemKey)).toEqual([token, token]);
    expect(() => publish(["raw-f"])).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));
    coordinator.beginClassicPublishedItems(access, role);
    const replacement = publish(["raw-a", "raw-b", "raw-c", "raw-d", "raw-e"], "New list");
    expect(replacement.items[0].itemKey).not.toBe(token);
    expect(() => coordinator.resolveClassicItemKey(access, role, token))
      .toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    expect(coordinator.resolveClassicPublishedItem(access, role, replacement.items[0].itemKey!))
      .toMatchObject({ title: "New list", itemKey: "raw-a" });
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

  it("announces idle retirement once with the exact public mode handle", async () => {
    jest.useFakeTimers();
    coordinator.shutdown();
    coordinator = makeCoordinator({ modeIdleMs: 100 });
    const retired: unknown[] = [];
    coordinator.onModeRetired((event) => retired.push(event));
    const handle = await classicHandle();

    jest.advanceTimersByTime(100);
    await flushPromises();

    expect(retired).toEqual([
      {
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        session: handle,
        reason: "SESSION_LOST",
      },
    ]);
    expect(Object.isFrozen(retired[0])).toBe(true);
    expect(Object.isFrozen((retired[0] as { session: unknown }).session)).toBe(
      true
    );
  });

  it("announces Core retirement once but not client release or same-tab replacement", async () => {
    const retired: unknown[] = [];
    coordinator.onModeRetired((event) => retired.push(event));

    const released = await classicHandle();
    await coordinator.releaseMode(modeAccess(released));
    expect(retired).toEqual([]);

    const replaced = await classicHandle();
    const replacement = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    await flushPromises();
    expect(retired).toEqual([]);

    await coordinator.invalidateCore("core-1");
    expect(retired).toEqual([
      {
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        session: replacement,
        reason: "SESSION_LOST",
      },
    ]);
    expect(replacement.generation).toBeGreaterThan(replaced.generation);
  });

  it("announces a late release upgrade once and isolates throwing observers", async () => {
    const observed: unknown[] = [];
    coordinator.onModeRetired(() => {
      throw new Error("observer failed");
    });
    coordinator.onModeRetired((event) => observed.push(event));
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
    expect(observed).toEqual([
      expect.objectContaining({ session: handle, reason: "SESSION_LOST" }),
    ]);

    gate.resolve("late");
    await runAssertion;
    await release;
    await invalidation;
    await flushPromises();

    expect(observed).toHaveLength(1);
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      activeTabs: 0,
      sessions: 0,
    });
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

  it("gives catalog count checks a different physical session", async () => {
    const catalog = coordinator.acquireCatalog("core-1");
    const count = coordinator.acquireCatalogCount("core-1");

    await coordinator.runCatalog("core-1", catalog, (session) =>
      session.browse({ hierarchy: "albums" })
    );
    await coordinator.runCatalogCount("core-1", count, (session) =>
      session.browse({ hierarchy: "albums", popAll: true, refresh: true })
    );

    const [publicationCall, countCall] = service.browse.mock.calls.map(
      (call) => call[0] as Record<string, unknown>
    );
    expect(publicationCall.multiSessionKey).not.toBe(countCall.multiSessionKey);
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      catalog: 1,
      sessions: 2,
      activeSessions: 2,
    });

    await coordinator.releaseCatalogCount("core-1", count);
    await coordinator.releaseCatalog("core-1", catalog);
  });

  it("a lost count session does not retire the catalog publication session", async () => {
    const catalog = coordinator.acquireCatalog("core-1");
    const count = coordinator.acquireCatalogCount("core-1");
    const late = deferred<void>();
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onTimeout(late.promise);
      return Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
    });

    await expect(
      coordinator.runCatalogCount("core-1", count, (session) =>
        session.browse({ hierarchy: "albums", refresh: true })
      )
    ).rejects.toBeInstanceOf(RoonTimeoutError);
    await expect(
      coordinator.runCatalog("core-1", catalog, async () => "still current")
    ).resolves.toBe("still current");

    const release = coordinator.releaseCatalogCount("core-1", count);
    late.resolve();
    await release;
    await coordinator.releaseCatalog("core-1", catalog);
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

  it("defers a timed-out catalog lease teardown until the holder releases", async () => {
    const catalog = coordinator.acquireCatalog("core-1");
    const late = deferred<void>();
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onTimeout(late.promise);
      return Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
    });
    await expect(
      coordinator.runCatalog("core-1", catalog, (session) =>
        session.browse({ hierarchy: "browse" })
      )
    ).rejects.toBeInstanceOf(RoonTimeoutError);

    // The generation must not rotate out from under the holder.
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      catalog: 1,
      quarantinedSessions: 1,
    });
    expect(() => coordinator.acquireCatalog("core-1")).toThrow(
      expect.objectContaining({ code: "BACKPRESSURE" })
    );
    expect(() =>
      coordinator.runCatalog("core-1", catalog, async () => undefined)
    ).toThrow(expect.objectContaining({ code: "SESSION_LOST" }));

    await coordinator.releaseCatalog("core-1", catalog);
    await flushPromises();
    expect(coordinator.diagnostics("core-1").catalog).toBe(0);

    late.resolve();
    await flushPromises();
    expect(coordinator.diagnostics("core-1").sessions).toBe(0);
    expect(coordinator.acquireCatalog("core-1")).toMatchObject({
      kind: "catalog",
    });
  });

  it("reaps a deferred catalog lease at the quarantine bound when the holder never releases", async () => {
    jest.useFakeTimers();
    coordinator.shutdown();
    coordinator = makeCoordinator({ quarantineReapMs: 100 });
    const catalog = coordinator.acquireCatalog("core-1");
    const never = deferred<void>();
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onTimeout(never.promise);
      return Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
    });
    await expect(
      coordinator.runCatalog("core-1", catalog, (session) =>
        session.browse({ hierarchy: "browse" })
      )
    ).rejects.toBeInstanceOf(RoonTimeoutError);
    expect(coordinator.diagnostics("core-1").catalog).toBe(1);

    jest.advanceTimersByTime(100);
    await flushPromises();
    expect(coordinator.diagnostics("core-1")).toMatchObject({
      catalog: 0,
      sessions: 0,
    });
    // Holder cleanup after the reap is a no-op, not an error.
    await coordinator.releaseCatalog("core-1", catalog);
    expect(coordinator.acquireCatalog("core-1")).toMatchObject({
      kind: "catalog",
    });
  });

  it("releases a catalog lease idempotently but still rejects an unknown handle", async () => {
    const catalog = coordinator.acquireCatalog("core-1");
    await coordinator.releaseCatalog("core-1", catalog);
    await coordinator.releaseCatalog("core-1", catalog);
    expect(coordinator.diagnostics("core-1").catalog).toBe(0);
    await expect(
      coordinator.releaseCatalog("core-1", {
        kind: "catalog",
        handleId: "never-issued",
        generation: 999,
      })
    ).rejects.toMatchObject({ code: "INVALID_HANDLE" });

    // The same idempotency covers a pinned action lease retired before its
    // holder finished cleanup.
    const mode = await classicHandle();
    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "idempotent-action",
      zoneId: "zone-1",
      generation: mode.generation,
    });
    await coordinator.releaseAction(actionAccess(action));
    await coordinator.releaseAction(actionAccess(action));
    expect(coordinator.diagnostics("core-1").actions).toBe(0);
  });

  it("defers a pinned action lease teardown on timeout until the holder releases", async () => {
    const mode = await classicHandle();
    const action = coordinator.acquireAction({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      leaseId: "deferred-action",
      zoneId: "zone-1",
      generation: mode.generation,
    });
    const late = deferred<void>();
    service.browse.mockImplementationOnce((_options, lifecycle) => {
      lifecycle.onTimeout(late.promise);
      return Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
    });
    await expect(
      coordinator.runAction(actionAccess(action), (session) =>
        session.browse({ hierarchy: "search", zoneId: "zone-1" })
      )
    ).rejects.toBeInstanceOf(RoonTimeoutError);

    expect(coordinator.diagnostics("core-1")).toMatchObject({
      actions: 1,
      quarantinedSessions: 1,
    });
    expect(() =>
      coordinator.runAction(actionAccess(action), async () => undefined)
    ).toThrow(expect.objectContaining({ code: "SESSION_LOST" }));

    // The action channel quarantine completes only at the late settlement.
    const released = coordinator.releaseAction(actionAccess(action));
    late.resolve();
    await released;
    await flushPromises();
    expect(coordinator.diagnostics("core-1").actions).toBe(0);
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
  // ── Catalog-session publication (library-live-view Slice 1) ──────────
  //
  // The same authority the Classic path uses, reached by session scope. What
  // these establish is that a published reference is worth exactly one
  // generation on one channel, and nothing else.

  async function catalogScope(): Promise<{
    scope: string;
    handle: ReturnType<BrowseSessionCoordinator["acquireCatalog"]>;
  }> {
    const handle = coordinator.acquireCatalog("core-1");
    const scope = await coordinator.runCatalog(
      "core-1",
      handle,
      async (session) => session.sessionScope
    );
    return { scope, handle };
  }

  function libraryRow(title: string, itemKey?: string) {
    return {
      title,
      hint: "list",
      isLoadable: true,
      isPlayable: false,
      ...(itemKey !== undefined ? { itemKey } : {}),
    };
  }

  const LIBRARY_ROWS = [
    libraryRow("Invented Artist A", "raw-a"),
    libraryRow("Invented Artist B", "raw-b"),
  ];

  it("publishes library rows as tokens and resolves them back", async () => {
    const { scope } = await catalogScope();
    const generation = coordinator.beginCatalogPublication(scope);
    const published = coordinator.replaceCatalogPublishedItems(
      scope,
      generation,
      LIBRARY_ROWS
    );

    expect(published).toHaveLength(2);
    // The published descriptor carries the rendering and nothing else: the raw
    // key is what the token replaces, so a descriptor that still had one would
    // defeat the whole exercise.
    expect(published[0].item).toEqual({
      title: "Invented Artist A",
      hint: "list",
      isLoadable: true,
      isPlayable: false,
    });
    expect(published[0].token).not.toBe(published[1].token);
    expect(
      coordinator.resolveCatalogPublishedItem(
        scope,
        generation,
        published[1].token
      ).itemKey
    ).toBe("raw-b");
  });

  it("retires every published reference when the next generation begins", async () => {
    const { scope } = await catalogScope();
    const first = coordinator.beginCatalogPublication(scope);
    const published = coordinator.replaceCatalogPublishedItems(
      scope,
      first,
      LIBRARY_ROWS
    );
    const second = coordinator.beginCatalogPublication(scope);
    expect(second).not.toBe(first);

    for (const entry of published) {
      expect(() =>
        coordinator.resolveCatalogPublishedItem(scope, first, entry.token)
      ).toThrow(
        expect.objectContaining({ code: "STALE_GENERATION" })
      );
      // Nor by claiming the new generation with an old token: a token is not a
      // password that works on whichever generation is current.
      expect(() =>
        coordinator.resolveCatalogPublishedItem(scope, second, entry.token)
      ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    }
  });

  it("refuses a publication written against a generation that has moved", async () => {
    const { scope } = await catalogScope();
    const stale = coordinator.beginCatalogPublication(scope);
    coordinator.beginCatalogPublication(scope);
    expect(() =>
      coordinator.replaceCatalogPublishedItems(scope, stale, LIBRARY_ROWS)
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("appends a level without retiring the rows already published", async () => {
    const { scope } = await catalogScope();
    const generation = coordinator.beginCatalogPublication(scope);
    const roots = coordinator.replaceCatalogPublishedItems(
      scope,
      generation,
      LIBRARY_ROWS
    );
    const level = coordinator.appendCatalogPublishedItems(scope, generation, [
      libraryRow("Invented Album A", "raw-album-a"),
    ]);

    // The whole point: opening something in a list does not kill the list.
    expect(
      coordinator.resolveCatalogPublishedItem(scope, generation, roots[0].token)
        .itemKey
    ).toBe("raw-a");
    expect(
      coordinator.resolveCatalogPublishedItem(scope, generation, level[0].token)
        .itemKey
    ).toBe("raw-album-a");
    expect(level[0].item).not.toHaveProperty("itemKey");
    expect(level[0].token).not.toBe(roots[0].token);
  });

  it("refuses to append into a generation that has moved", async () => {
    const { scope } = await catalogScope();
    const stale = coordinator.beginCatalogPublication(scope);
    coordinator.replaceCatalogPublishedItems(scope, stale, LIBRARY_ROWS);
    coordinator.beginCatalogPublication(scope);
    expect(() =>
      coordinator.appendCatalogPublishedItems(scope, stale, LIBRARY_ROWS)
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("refuses to append before anything has been published", async () => {
    const { scope } = await catalogScope();
    const generation = coordinator.beginCatalogPublication(scope);
    // A generation was reserved but no set was installed: there is no
    // authority to add to, and inventing one would publish rows into a
    // snapshot that does not exist.
    expect(() =>
      coordinator.appendCatalogPublishedItems(scope, generation, LIBRARY_ROWS)
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("refuses an append that would cross the authority's own bound", async () => {
    const bounded = makeCoordinator({ maxPublishedCatalogItemKeys: 2 });
    const handle = bounded.acquireCatalog("core-1");
    const scope = await bounded.runCatalog(
      "core-1",
      handle,
      async (session) => session.sessionScope
    );
    const generation = bounded.beginCatalogPublication(scope);
    bounded.replaceCatalogPublishedItems(scope, generation, LIBRARY_ROWS);
    expect(() =>
      bounded.appendCatalogPublishedItems(scope, generation, [
        libraryRow("Invented Album A", "raw-album-a"),
      ])
    ).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));
    bounded.shutdown();
  });

  it("retires named tokens and leaves the rest of the generation alone", async () => {
    const { scope } = await catalogScope();
    const generation = coordinator.beginCatalogPublication(scope);
    const roots = coordinator.replaceCatalogPublishedItems(
      scope,
      generation,
      LIBRARY_ROWS
    );
    const level = coordinator.appendCatalogPublishedItems(scope, generation, [
      libraryRow("Invented Album A", "raw-album-a"),
      libraryRow("Invented Album B", "raw-album-b"),
    ]);

    expect(
      coordinator.retireCatalogPublishedTokens(scope, generation, [
        level[0].token,
      ])
    ).toBe(1);
    expect(() =>
      coordinator.resolveCatalogPublishedItem(scope, generation, level[0].token)
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    // Everything not named is untouched, including the other row of the very
    // same level.
    expect(() =>
      coordinator.resolveCatalogPublishedItem(scope, generation, level[1].token)
    ).not.toThrow();
    expect(() =>
      coordinator.resolveCatalogPublishedItem(scope, generation, roots[0].token)
    ).not.toThrow();
    // Retiring what is already gone is not an error; there is nothing to undo.
    expect(
      coordinator.retireCatalogPublishedTokens(scope, generation, [
        level[0].token,
      ])
    ).toBe(0);
  });

  it("has nothing to retire once the generation itself has moved", async () => {
    const { scope } = await catalogScope();
    const first = coordinator.beginCatalogPublication(scope);
    const published = coordinator.replaceCatalogPublishedItems(
      scope,
      first,
      LIBRARY_ROWS
    );
    coordinator.beginCatalogPublication(scope);
    expect(
      coordinator.retireCatalogPublishedTokens(scope, first, [
        published[0].token,
      ])
    ).toBe(0);
  });

  it("refuses to publish library rows on a Classic channel", async () => {
    const access = modeAccess(await classicHandle());
    const scope = await coordinator.runMode(
      access,
      "classic-browse",
      async (session) => session.sessionScope
    );
    // One channel, one authority. A second publisher would silently retire the
    // first one's references.
    expect(() => coordinator.beginCatalogPublication(scope)).toThrow(
      expect.objectContaining({ code: "INVALID_ROLE" })
    );
  });

  it("refuses a scope whose session is gone", async () => {
    const { scope, handle } = await catalogScope();
    const generation = coordinator.beginCatalogPublication(scope);
    const published = coordinator.replaceCatalogPublishedItems(
      scope,
      generation,
      LIBRARY_ROWS
    );
    await coordinator.releaseCatalog("core-1", handle);

    expect(() =>
      coordinator.resolveCatalogPublishedItem(
        scope,
        generation,
        published[0].token
      )
    ).toThrow(expect.objectContaining({ code: "SESSION_LOST" }));
    expect(() => coordinator.beginCatalogPublication(scope)).toThrow(
      expect.objectContaining({ code: "SESSION_LOST" })
    );
  });

  it("refuses a library publication larger than its own bound", async () => {
    const bounded = makeCoordinator({ maxPublishedCatalogItemKeys: 1 });
    const handle = bounded.acquireCatalog("core-1");
    const scope = await bounded.runCatalog(
      "core-1",
      handle,
      async (session) => session.sessionScope
    );
    const generation = bounded.beginCatalogPublication(scope);
    expect(() =>
      bounded.replaceCatalogPublishedItems(scope, generation, LIBRARY_ROWS)
    ).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));
    bounded.shutdown();
  });

  it("refuses a row that carries no key rather than publishing a dead token", async () => {
    const { scope } = await catalogScope();
    const generation = coordinator.beginCatalogPublication(scope);
    expect(() =>
      coordinator.replaceCatalogPublishedItems(scope, generation, [
        libraryRow("Invented Artist A", "raw-a"),
        libraryRow("Keyless row"),
      ])
    ).toThrow(expect.objectContaining({ code: "BACKPRESSURE" }));
  });

  // `.agents/plans/library-live-view.md` Slice 2. An action on a live library
  // reference runs where the reference means something — the catalog channel
  // that minted it — while everything that makes an action safe stays on the
  // action lease. These tests hold each of those halves down separately.
  describe("library actions", () => {
    async function libraryAction() {
      const mode = await classicHandle();
      const { scope, handle: catalog } = await catalogScope();
      const generation = coordinator.beginCatalogPublication(scope);
      const published = coordinator.replaceCatalogPublishedItems(
        scope,
        generation,
        LIBRARY_ROWS
      );
      const action = coordinator.acquireAction({
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        leaseId: "lease-1",
        zoneId: "zone-1",
        generation: mode.generation,
      });
      return { scope, generation, action, catalog, published };
    }

    it("runs the lease's work on the channel that published the reference", async () => {
      const { scope, generation, action } = await libraryAction();
      service.browse.mockClear();

      const seen = await coordinator.runLibraryAction(
        actionAccess(action),
        { sessionScope: scope, authorityGeneration: generation },
        async (session) => {
          await session.browse({
            hierarchy: "albums",
            zoneId: "zone-1",
            itemKey: "raw-a",
          });
          return session.sessionScope;
        }
      );

      // The work saw the library's own session, not the action lease's, which
      // is the whole point: a key minted there names nothing anywhere else.
      expect(seen).toBe(scope);
      expect(service.browse).toHaveBeenCalledTimes(1);
      expect(service.browse.mock.calls[0][0]).toMatchObject({
        itemKey: "raw-a",
        zoneId: "zone-1",
      });
    });

    it("refuses a reference whose publication generation has been retired", async () => {
      const { scope, generation, action } = await libraryAction();
      // Exactly what a roots re-read does: a fresh publication installs a new
      // authority and retires every outstanding reference at once. The new
      // authority is present and populated, so nothing but the generation
      // comparison can tell the retired reference from a live one.
      coordinator.replaceCatalogPublishedItems(
        scope,
        coordinator.beginCatalogPublication(scope),
        LIBRARY_ROWS
      );

      expect(() =>
        coordinator.runLibraryAction(
          actionAccess(action),
          { sessionScope: scope, authorityGeneration: generation },
          async () => "unreachable"
        )
      ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    });

    it("applies the action lease's zone gate to work on the library channel", async () => {
      const { scope, generation, action } = await libraryAction();

      await expect(
        coordinator.runLibraryAction(
          actionAccess(action),
          { sessionScope: scope, authorityGeneration: generation },
          async (session) => {
            await session.browse({
              hierarchy: "albums",
              zoneId: "zone-2",
              itemKey: "raw-a",
            });
          }
        )
      ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
      // Refused before Roon saw it, which is what the gate is for.
      expect(service.browse).not.toHaveBeenCalledWith(
        expect.objectContaining({ zoneId: "zone-2" }),
        expect.anything()
      );
    });

    it("refuses a library dispatch that never took the execute claim", async () => {
      const { scope, generation, action } = await libraryAction();
      const issued = jest.fn();

      expect(() =>
        coordinator.executeLibraryAction(
          actionAccess(action),
          { sessionScope: scope, authorityGeneration: generation },
          { hierarchy: "albums", zoneId: "zone-1", itemKey: "raw-play" },
          issued
        )
      ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
      expect(issued).not.toHaveBeenCalled();
    });

    it("dispatches once on the claim and refuses the second crossing", async () => {
      const { scope, generation, action } = await libraryAction();
      const anchor = { sessionScope: scope, authorityGeneration: generation };
      expect(coordinator.claimActionExecute(actionAccess(action))).toBe(true);
      const issued = jest.fn();
      service.browse.mockImplementation((_options, lifecycle) => {
        lifecycle.onIssued();
        return Promise.resolve(EMPTY_RESULT);
      });

      await coordinator.executeLibraryAction(
        actionAccess(action),
        anchor,
        { hierarchy: "albums", zoneId: "zone-1", itemKey: "raw-play" },
        issued
      );
      expect(issued).toHaveBeenCalledTimes(1);

      expect(() =>
        coordinator.executeLibraryAction(
          actionAccess(action),
          anchor,
          { hierarchy: "albums", zoneId: "zone-1", itemKey: "raw-play" },
          issued
        )
      ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
      expect(issued).toHaveBeenCalledTimes(1);
    });

    it("refuses a dispatch whose snapshot was retired after the claim", async () => {
      const { scope, generation, action } = await libraryAction();
      expect(coordinator.claimActionExecute(actionAccess(action))).toBe(true);
      coordinator.replaceCatalogPublishedItems(
        scope,
        coordinator.beginCatalogPublication(scope),
        LIBRARY_ROWS
      );
      const issued = jest.fn();

      expect(() =>
        coordinator.executeLibraryAction(
          actionAccess(action),
          { sessionScope: scope, authorityGeneration: generation },
          { hierarchy: "albums", zoneId: "zone-1", itemKey: "raw-play" },
          issued
        )
      ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
      expect(issued).not.toHaveBeenCalled();
    });

    it("refuses a dispatch whose snapshot is retired while it waits on the tail", async () => {
      const { scope, generation, action, catalog } = await libraryAction();
      const anchor = { sessionScope: scope, authorityGeneration: generation };
      expect(coordinator.claimActionExecute(actionAccess(action))).toBe(true);
      // Hold the library channel busy, retire the snapshot underneath, and only
      // then let the queued dispatch reach the front. The entry check passed;
      // the one on the tail is the one that has to catch this.
      const gate = deferred<void>();
      const held = coordinator.runCatalog("core-1", catalog, () => gate.promise);
      const issued = jest.fn();
      const dispatch = coordinator.executeLibraryAction(
        actionAccess(action),
        anchor,
        { hierarchy: "albums", zoneId: "zone-1", itemKey: "raw-play" },
        issued
      );
      const rejection = expect(dispatch).rejects.toMatchObject({
        code: "STALE_GENERATION",
      });
      coordinator.replaceCatalogPublishedItems(
        scope,
        coordinator.beginCatalogPublication(scope),
        LIBRARY_ROWS
      );
      gate.resolve();
      await held;
      await rejection;
      expect(issued).not.toHaveBeenCalled();
    });

    it("quarantines the library channel on timeout, retiring its references", async () => {
      const { scope, generation, action, catalog, published } =
        await libraryAction();
      const late = deferred<void>();
      service.browse.mockImplementationOnce((_options, lifecycle) => {
        lifecycle.onTimeout(late.promise);
        return Promise.reject(new RoonTimeoutError("browse.browse", 15_000));
      });

      await expect(
        coordinator.runLibraryAction(
          actionAccess(action),
          { sessionScope: scope, authorityGeneration: generation },
          async (session) => {
            await session.browse({
              hierarchy: "albums",
              zoneId: "zone-1",
              itemKey: "raw-a",
            });
          }
        )
      ).rejects.toBeInstanceOf(RoonTimeoutError);
      await flushPromises();
      expect(coordinator.diagnostics("core-1").quarantinedSessions).toBe(1);

      // The blast radius is the library, and that is correct: a call that may
      // still settle must not be followed by another on the same stack, and
      // retiring the generation is the recovery every open page already knows.
      expect(() =>
        coordinator.resolveCatalogPublishedItem(
          scope,
          generation,
          published[0].token
        )
      ).toThrow(expect.objectContaining({ code: "SESSION_LOST" }));
      // The channel's own owner is marked lost too. Without that the catalog
      // lease would survive holding a dead channel, `core.catalog` would stay
      // occupied forever, and the library could never reacquire — a wedge, not
      // a recovery.
      expect(() =>
        coordinator.runCatalog("core-1", catalog, async () => undefined)
      ).toThrow(expect.objectContaining({ code: "SESSION_LOST" }));
      late.resolve();
      await flushPromises();
      expect(coordinator.diagnostics("core-1").quarantinedSessions).toBe(0);
      expect(() => coordinator.acquireCatalog("core-1")).not.toThrow();
    });
  });
});
