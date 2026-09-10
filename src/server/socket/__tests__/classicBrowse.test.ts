import { registerClassicBrowseSocket } from "../classicBrowse";
import { BrowseSessionCoordinator, BrowseSessionCoordinatorError } from "../../../core/roon/BrowseSessionCoordinator";
import { CLASSIC_BROWSE_ERROR_MAX_LENGTH } from "../../../shared/classicBrowseContracts";

class FakeSocket {
  public readonly id = "socket-1";
  public readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  public readonly emitted: unknown[][] = [];

  on(event: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(event, handler);
  }

  emit(...args: unknown[]): void {
    this.emitted.push(args);
  }

  trigger(event: string, ...args: unknown[]): unknown {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`missing handler ${event}`);
    return handler(...args);
  }
}

const logger = {
  error: jest.fn(),
  warn: jest.fn(),
};

function request(
  session = { handleId: "handle-1", generation: 1 },
  operation: "browse" | "load" | "pop" | "search" = "browse"
) {
  const options =
    operation === "search"
      ? { input: "query", popAll: true }
      : operation === "load"
        ? { hierarchy: "browse", offset: 0, count: 10 }
        : operation === "pop"
          ? { hierarchy: "browse", levels: 1 }
          : { hierarchy: "browse", popAll: true };
  return {
    requestId: "request-1",
    tabId: "tab-1",
    session,
	role: operation === "search" ? "classic-search" : "classic-browse",
	operation,
	options,
  };
}

describe("Classic browse socket adapter", () => {
  let socket: FakeSocket;
  let coordinator: {
    acquireMode: jest.Mock;
    onModeRetired: jest.Mock;
    releaseMode: jest.Mock;
    runMode: jest.Mock;
    resolveClassicItemKey: jest.Mock;
    beginClassicPublishedItems: jest.Mock;
    publishClassicBrowseResult: jest.Mock;
  };
  let browseService: { searchCoordinated: jest.Mock };
  let sessionBrowse: jest.Mock;
  let sessionPop: jest.Mock;
  let modeRetiredListener:
    | ((event: {
        coreId: string;
        socketId: string;
        tabId: string;
        session: {
          kind: "mode";
          mode: "classic";
          handleId: string;
          generation: number;
        };
        reason: "SESSION_LOST";
      }) => void)
    | undefined;
  let unsubscribeModeRetired: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    socket = new FakeSocket();
    sessionBrowse = jest.fn().mockResolvedValue({
      title: "Root",
      level: 0,
      offset: 0,
      count: 0,
      items: [],
    });
    sessionPop = jest.fn().mockResolvedValue({ level: 0, offset: 0, count: 0, items: [] });
    unsubscribeModeRetired = jest.fn(() => {
      modeRetiredListener = undefined;
    });
    coordinator = {
      onModeRetired: jest.fn((listener) => {
        modeRetiredListener = listener;
        return unsubscribeModeRetired;
      }),
      acquireMode: jest.fn(() => ({
        kind: "mode",
        mode: "classic",
        handleId: "handle-1",
        generation: 1,
      })),
      releaseMode: jest.fn().mockResolvedValue(undefined),
      runMode: jest.fn(async (_access, _role, work) =>
        work({
          browse: sessionBrowse,
          load: jest.fn().mockResolvedValue({ level: 0, offset: 0, count: 0, items: [] }),
          pop: sessionPop,
        })
      ),
      resolveClassicItemKey: jest.fn((_access, _role, token) => `raw:${token}`),
      beginClassicPublishedItems: jest.fn().mockReturnValue(1),
      publishClassicBrowseResult: jest.fn((_access, _role, result) => result),
    };
    browseService = { searchCoordinated: jest.fn() };
    registerClassicBrowseSocket(socket as never, {
      coordinator: coordinator as never,
      browseService: browseService as never,
      getCoreId: () => "core-1",
      logger: logger as never,
    });
  });

  it("emits only this socket's exact unsolicited retirement and tears down once", () => {
    const event = {
      coreId: "core-1",
      socketId: "socket-2",
      tabId: "tab-1",
      session: {
        kind: "mode" as const,
        mode: "classic" as const,
        handleId: "handle-1",
        generation: 1,
      },
      reason: "SESSION_LOST" as const,
    };

    modeRetiredListener?.(event);
    expect(socket.emitted).toEqual([]);

    modeRetiredListener?.({ ...event, socketId: "socket-1" });
    expect(socket.emitted).toEqual([
      [
        "classic-session:retired",
        {
          contract: "classic-session-retired-v1",
          tabId: "tab-1",
          session: { handleId: "handle-1", generation: 1 },
          reason: "SESSION_LOST",
        },
      ],
    ]);

    socket.trigger("disconnect");
    socket.trigger("disconnect");
    expect(unsubscribeModeRetired).toHaveBeenCalledTimes(1);
  });

  it("acquires a fresh socket/tab-owned Classic generation without exposing its role", () => {
    const ack = jest.fn();
    socket.trigger(
      "classic-session:acquire",
      { requestId: "acquire-1", tabId: "tab-1" },
      ack
    );

    expect(coordinator.acquireMode).toHaveBeenCalledWith({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
	  replaceDisconnected: true,
    });
    expect(ack).toHaveBeenCalledWith({
      success: true,
      data: {
        requestId: "acquire-1",
        session: { handleId: "handle-1", generation: 1 },
      },
    });
    expect(JSON.stringify(ack.mock.calls)).not.toMatch(/multiSessionKey|classic-browse/u);
  });

  it("routes correlated commands through the requested coordinator role only", async () => {
    const ack = jest.fn();
    await socket.trigger("browse:browse", request(), ack);

    expect(coordinator.runMode).toHaveBeenCalledWith(
      expect.objectContaining({
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        handle: expect.objectContaining({ handleId: "handle-1", generation: 1 }),
      }),
      "classic-browse",
      expect.any(Function)
    );
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          requestId: "request-1",
          session: { handleId: "handle-1", generation: 1 },
        }),
      })
    );
    expect(socket.emitted).toEqual([]);
  });

  it("translates an incoming item token before the BrowseService call", async () => {
    const ack = jest.fn();
    await socket.trigger(
      "browse:browse",
      { ...request(), options: { hierarchy: "browse", itemKey: "opaque-item-1" } },
      ack
    );

    expect(coordinator.resolveClassicItemKey).toHaveBeenCalledWith(
      expect.objectContaining({ handle: expect.objectContaining({ generation: 1 }) }),
      "classic-browse",
      "opaque-item-1"
    );
    expect(sessionBrowse).toHaveBeenCalledWith({
      hierarchy: "browse",
      itemKey: "raw:opaque-item-1",
    });
  });

  it.each([
    ["browse", { hierarchy: "browse", popAll: true }],
    ["browse", { hierarchy: "browse", refresh: true }],
    ["pop", { hierarchy: "browse", levels: 1, refresh: true }],
  ] as const)("retires old published authority before %s reset/refresh dispatch", async (operation, options) => {
    const order: string[] = [];
    coordinator.beginClassicPublishedItems.mockImplementation(() => { order.push("retire"); return 1; });
    const dispatched = operation === "pop" ? sessionPop : sessionBrowse;
    dispatched.mockImplementation(async () => { order.push("dispatch"); return { level: 0, offset: 0, count: 0, items: [] }; });
    const ack = jest.fn();
    await socket.trigger(`browse:${operation}`, { ...request(undefined, operation), options }, ack);
    expect(order).toEqual(["retire", "dispatch"]);
    expect(coordinator.beginClassicPublishedItems).toHaveBeenCalledWith(expect.anything(), "classic-browse");
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("resolves a selected token before retiring its authority for an explicit refresh", async () => {
    const order: string[] = [];
    coordinator.resolveClassicItemKey.mockImplementation(() => { order.push("resolve"); return "exact-raw-key"; });
    coordinator.beginClassicPublishedItems.mockImplementation(() => { order.push("retire"); return 1; });
    sessionBrowse.mockImplementation(async () => { order.push("dispatch"); return { level: 0, offset: 0, count: 0, items: [] }; });
    await socket.trigger("browse:browse", {
      ...request(), options: { hierarchy: "browse", itemKey: "opaque-row", refresh: true },
    }, jest.fn());
    expect(order).toEqual(["resolve", "retire", "dispatch"]);
    expect(sessionBrowse).toHaveBeenCalledWith({ hierarchy: "browse", itemKey: "exact-raw-key", refresh: true });
  });

  it.each([
    ["browse", { hierarchy: "browse", itemKey: "opaque-row" }],
    ["pop", { hierarchy: "browse", levels: 1 }],
    ["load", { hierarchy: "browse", offset: 100, count: 100 }],
  ] as const)("keeps retained parent tokens through ordinary %s navigation", async (operation, options) => {
    const ack = jest.fn();
    await socket.trigger(`browse:${operation}`, { ...request(undefined, operation), options }, ack);
    expect(coordinator.beginClassicPublishedItems).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("rejects a retired token when a new root reuses the same native row key", async () => {
    const realSocket = new FakeSocket();
    let title = "Old root row";
    const nativeBrowse = jest.fn(async () => ({
      title: "Browse", level: 0, offset: 0, count: 1, totalCount: 1,
      items: [{ title, itemKey: "reused-native-key", isLoadable: true, isPlayable: false }],
    }));
    const realCoordinator = new BrowseSessionCoordinator({
      browse: nativeBrowse, load: jest.fn(), pop: jest.fn(), reRoot: jest.fn().mockResolvedValue(undefined),
    } as never);
    try {
      registerClassicBrowseSocket(realSocket as never, {
        coordinator: realCoordinator, browseService: browseService as never,
        getCoreId: () => "core-1", logger: logger as never,
      });
      const acquired = realCoordinator.acquireMode({ coreId: "core-1", socketId: "socket-1", tabId: "tab-1", mode: "classic" });
      const handle = { handleId: acquired.handleId, generation: acquired.generation };
      const initialAck = jest.fn();
      await realSocket.trigger("browse:browse", request(handle), initialAck);
      const oldToken = initialAck.mock.calls[0][0].data.result.items[0].itemKey;
      title = "Different root row";
      const nextAck = jest.fn();
      await realSocket.trigger("browse:browse", request(handle), nextAck);
      const newToken = nextAck.mock.calls[0][0].data.result.items[0].itemKey;
      expect(newToken).not.toBe(oldToken);
      const rejected = jest.fn();
      await realSocket.trigger("browse:browse", {
        ...request(handle), options: { hierarchy: "browse", itemKey: oldToken },
      }, rejected);
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: "STALE_GENERATION" }));
      expect(nativeBrowse).toHaveBeenCalledTimes(2);
      const accepted = jest.fn();
      await realSocket.trigger("browse:browse", {
        ...request(handle), options: { hierarchy: "browse", itemKey: newToken },
      }, accepted);
      expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(nativeBrowse).toHaveBeenLastCalledWith(expect.objectContaining({ itemKey: "reused-native-key" }), expect.anything());

      // A failed refresh cannot restore the old authority: the Core may have
      // changed its list before reporting failure or losing the response.
      const beforeFailure = nativeBrowse.mock.calls.length;
      nativeBrowse.mockRejectedValueOnce(new Error("Refresh failed"));
      const failedRefresh = jest.fn();
      await realSocket.trigger("browse:browse", {
        ...request(handle), options: { hierarchy: "browse", refresh: true },
      }, failedRefresh);
      expect(failedRefresh).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: "INTERNAL_ERROR" }));
      const retiredAfterFailure = jest.fn();
      await realSocket.trigger("browse:browse", {
        ...request(handle), options: { hierarchy: "browse", itemKey: newToken },
      }, retiredAfterFailure);
      expect(retiredAfterFailure).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: "STALE_GENERATION" }));
      expect(nativeBrowse).toHaveBeenCalledTimes(beforeFailure + 1);
    } finally {
      realCoordinator.shutdown();
    }
  });

  it("publishes only the coordinator-tokenized BrowseResult", async () => {
    sessionBrowse.mockResolvedValueOnce({
      level: 1,
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
    coordinator.publishClassicBrowseResult.mockImplementationOnce((_access, _role, result) => ({
      ...result,
      items: [{ ...result.items[0], itemKey: "opaque-item-1" }],
    }));
    const ack = jest.fn();
    await socket.trigger("browse:browse", request(), ack);

    const payload = ack.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).toContain("opaque-item-1");
    expect(JSON.stringify(payload)).not.toContain("raw-roon-key");
  });

  it.each([
    ["browse:browse", "browse"],
    ["browse:load", "load"],
    ["browse:pop", "pop"],
    ["browse:search", "search"],
  ] as const)("binds %s to its matching %s operation", async (event, operation) => {
    const ack = jest.fn();
    await socket.trigger(event, request(undefined, operation), ack);
    expect(coordinator.runMode).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it.each([
    ["browse:browse", "load"],
    ["browse:load", "pop"],
    ["browse:pop", "search"],
    ["browse:search", "browse"],
  ] as const)("rejects %s carrying a %s operation", async (event, operation) => {
    const ack = jest.fn();
    await socket.trigger(event, request(undefined, operation), ack);
    expect(coordinator.runMode).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: "INVALID_REQUEST" })
    );
  });

  it("rejects raw client session keys before coordinator work", async () => {
    const ack = jest.fn();
    await socket.trigger(
      "browse:browse",
      { ...request(), options: { hierarchy: "browse", multiSessionKey: "raw" } },
      ack
    );
    expect(coordinator.runMode).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: "INVALID_REQUEST" })
    );
  });

  it("rejects an unknown hierarchy before coordinator work", async () => {
    const ack = jest.fn();
    await socket.trigger(
      "browse:browse",
      { ...request(), options: { hierarchy: "invented-hierarchy" } },
      ack
    );
    expect(coordinator.runMode).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: "INVALID_REQUEST" })
    );
  });

  it("rejects an operation that does not match its socket event", async () => {
    const ack = jest.fn();
    await socket.trigger(
      "browse:load",
      { ...request(), operation: "browse" },
      ack
    );
    expect(coordinator.runMode).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: "INVALID_REQUEST" })
    );
  });

  it("returns a late old-generation rejection without publishing a result", async () => {
    coordinator.runMode.mockRejectedValueOnce(
      new BrowseSessionCoordinatorError("STALE_GENERATION", "old generation")
    );
    const ack = jest.fn();
    await socket.trigger("browse:browse", request(), ack);
    expect(ack).toHaveBeenCalledWith({
      success: false,
      code: "STALE_GENERATION",
      error: "old generation",
    });
    expect(socket.emitted).toEqual([]);
  });

  it("does not expose an upstream raw item key in a protocol failure", async () => {
    coordinator.runMode.mockRejectedValueOnce(
      new Error("InvalidItemKey for raw-roon-key-that-must-stay-server-only")
    );
    const ack = jest.fn();
    await socket.trigger("browse:browse", request(), ack);

    expect(ack).toHaveBeenCalledWith({
      success: false,
      code: "INTERNAL_ERROR",
      error: "Classic browse command failed",
    });
    expect(JSON.stringify(ack.mock.calls)).not.toContain("raw-roon-key");
  });

  it("bounds controlled coordinator error text before returning it", async () => {
    coordinator.runMode.mockRejectedValueOnce(
      new BrowseSessionCoordinatorError("STALE_GENERATION", "x".repeat(2_048))
    );
    const ack = jest.fn();
    await socket.trigger("browse:browse", request(), ack);

    expect(ack).toHaveBeenCalledWith({
      success: false,
      code: "STALE_GENERATION",
      error: "x".repeat(CLASSIC_BROWSE_ERROR_MAX_LENGTH),
    });
  });

  it("releases the exact opaque socket/tab generation", async () => {
    const ack = jest.fn();
    await socket.trigger(
      "classic-session:release",
      {
        requestId: "release-1",
        tabId: "tab-1",
        session: { handleId: "handle-1", generation: 1 },
      },
      ack
    );
    expect(coordinator.releaseMode).toHaveBeenCalledWith({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      handle: {
        kind: "mode",
        mode: "classic",
        handleId: "handle-1",
        generation: 1,
      },
    });
    expect(ack).toHaveBeenCalledWith({
      success: true,
      data: { requestId: "release-1" },
    });
  });
});
