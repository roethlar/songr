import type { Logger } from "pino";

import { CoreLifecycle } from "../CoreLifecycle";

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
} as unknown as Logger;

describe("CoreLifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("captures and invalidates the old Core across direct switches and unpair", () => {
    const order: string[] = [];
    const coordinator = {
      invalidateCore: jest.fn((coreId: string) => {
        order.push(`coordinator:${coreId}`);
        return Promise.resolve();
      }),
      shutdown: jest.fn(),
    };
    const albumActions = {
      invalidateCore: jest.fn((coreId: string) => {
        order.push(`actions:${coreId}`);
      }),
      shutdown: jest.fn(),
    };
    const libraryAlbums = {
      invalidateCore: jest.fn((coreId: string) => {
        order.push(`albums:${coreId}`);
      }),
      shutdown: jest.fn(),
    };
    const lifecycle = new CoreLifecycle(
      coordinator,
      logger,
      albumActions,
      libraryAlbums
    );

    lifecycle.corePaired("core-a");
    lifecycle.corePaired("core-b");
    lifecycle.coreUnpaired();

    // Every session-scoped authority retires before the coordinator session it
    // was minted on: a page retiring afterwards would be holding keys from a
    // session that no longer exists.
    expect(order).toEqual([
      "actions:core-a",
      "albums:core-a",
      "coordinator:core-a",
      "actions:core-b",
      "albums:core-b",
      "coordinator:core-b",
    ]);
    // RoonClient erases the Core identity on unpair; the diagnostic answer is
    // the last one this lifecycle saw, which is what a health reader wants.
    expect(lifecycle.getDiagnosticCoreId()).toBe("core-b");
  });

  it("keeps the current Core active when an activation carries no identity", () => {
    const coordinator = { invalidateCore: jest.fn(), shutdown: jest.fn() };
    const lifecycle = new CoreLifecycle(coordinator, logger);

    lifecycle.corePaired("core-a");
    lifecycle.corePaired("");
    lifecycle.coreUnpaired();

    // The empty activation is refused outright, so the unpair retires core-a
    // exactly once and nothing is invalidated on behalf of a Core that was
    // never named.
    expect(coordinator.invalidateCore.mock.calls).toEqual([["core-a"]]);
    expect(lifecycle.getDiagnosticCoreId()).toBe("core-a");
  });

  it("shuts the coordinator down once and ignores later lifecycle events", () => {
    const coordinator = {
      invalidateCore: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn(),
    };
    const albumActions = { invalidateCore: jest.fn(), shutdown: jest.fn() };
    const libraryAlbums = { invalidateCore: jest.fn(), shutdown: jest.fn() };
    const lifecycle = new CoreLifecycle(
      coordinator,
      logger,
      albumActions,
      libraryAlbums
    );

    lifecycle.corePaired("core-a");
    lifecycle.shutdown();
    lifecycle.shutdown();
    lifecycle.coreUnpaired();
    lifecycle.corePaired("core-b");

    expect(coordinator.shutdown).toHaveBeenCalledTimes(1);
    expect(albumActions.shutdown).toHaveBeenCalledTimes(1);
    expect(libraryAlbums.shutdown).toHaveBeenCalledTimes(1);
    // A lifecycle event after shutdown is a departing process being told about
    // a Core it is no longer listening to; acting on it would reopen work the
    // shutdown just closed.
    expect(coordinator.invalidateCore).not.toHaveBeenCalled();
  });

  it("still shuts the rest down when one shutdown throws", () => {
    const coordinator = { invalidateCore: jest.fn(), shutdown: jest.fn() };
    const albumActions = {
      invalidateCore: jest.fn(),
      shutdown: jest.fn(() => {
        throw new Error("album actions refused");
      }),
    };
    const libraryAlbums = { invalidateCore: jest.fn(), shutdown: jest.fn() };
    const lifecycle = new CoreLifecycle(
      coordinator,
      logger,
      albumActions,
      libraryAlbums
    );

    lifecycle.shutdown();

    expect(libraryAlbums.shutdown).toHaveBeenCalledTimes(1);
    expect(coordinator.shutdown).toHaveBeenCalledTimes(1);
  });

  it("survives a coordinator invalidation that rejects", async () => {
    const coordinator = {
      invalidateCore: jest.fn().mockRejectedValue(new Error("session gone")),
      shutdown: jest.fn(),
    };
    const lifecycle = new CoreLifecycle(coordinator, logger);

    lifecycle.corePaired("core-a");
    lifecycle.coreUnpaired();
    await Promise.resolve();

    // A failed retirement is logged, never thrown: the Core is already gone
    // and there is nobody left to tell.
    expect(coordinator.invalidateCore).toHaveBeenCalledWith("core-a");
  });
});
