import { registerClassicBrowseSocket } from "../classicBrowse";
import { BrowseSessionCoordinatorError } from "../../../core/roon/BrowseSessionCoordinator";
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
    releaseMode: jest.Mock;
    runMode: jest.Mock;
    resolveClassicItemKey: jest.Mock;
    publishClassicBrowseResult: jest.Mock;
  };
  let browseService: { searchCoordinated: jest.Mock };
  let sessionBrowse: jest.Mock;

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
    coordinator = {
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
          pop: jest.fn().mockResolvedValue({ level: 0, offset: 0, count: 0, items: [] }),
        })
      ),
      resolveClassicItemKey: jest.fn((_access, _role, token) => `raw:${token}`),
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
