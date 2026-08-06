import type { Logger } from "pino";

import { CatalogLifecycle } from "../CatalogLifecycle";

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
} as unknown as Logger;

describe("CatalogLifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("captures and invalidates the old Core across direct switches and unpair", () => {
    const order: string[] = [];
    const service = {
      start: jest.fn().mockResolvedValue(undefined),
      markCoreDisconnected: jest.fn((coreId: string) => {
        order.push(`catalog:${coreId}`);
      }),
    };
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
    const timelineBrowse = {
      invalidateCore: jest.fn((coreId: string) => {
        order.push(`timeline:${coreId}`);
      }),
      shutdown: jest.fn(),
    };
    const lifecycle = new CatalogLifecycle(
      service,
      coordinator,
      logger,
      albumActions,
      timelineBrowse
    );

    lifecycle.corePaired("core-a");
    lifecycle.corePaired("core-b");
    lifecycle.coreUnpaired();

    expect(service.start.mock.calls).toEqual([["core-a"], ["core-b"]]);
    expect(service.markCoreDisconnected.mock.calls).toEqual([
      ["core-a"],
      ["core-b"],
    ]);
    expect(coordinator.invalidateCore.mock.calls).toEqual([
      ["core-a"],
      ["core-b"],
    ]);
    expect(albumActions.invalidateCore.mock.calls).toEqual([
      ["core-a"],
      ["core-b"],
    ]);
    expect(timelineBrowse.invalidateCore.mock.calls).toEqual([
      ["core-a"],
      ["core-b"],
    ]);
    expect(order).toEqual([
      "timeline:core-a",
      "actions:core-a",
      "catalog:core-a",
      "coordinator:core-a",
      "timeline:core-b",
      "actions:core-b",
      "catalog:core-b",
      "coordinator:core-b",
    ]);
    expect(lifecycle.getDiagnosticCoreId()).toBe("core-b");
  });

  it("keeps the current Core active when a replacement activation is rejected", () => {
    const service = {
      start: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => {
          throw new Error("invalid Core");
        }),
      markCoreDisconnected: jest.fn(),
    };
    const coordinator = {
      invalidateCore: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn(),
    };
    const lifecycle = new CatalogLifecycle(service, coordinator, logger);

    lifecycle.corePaired("core-a");
    lifecycle.corePaired("");
    lifecycle.coreUnpaired();

    expect(service.markCoreDisconnected).toHaveBeenCalledTimes(1);
    expect(service.markCoreDisconnected).toHaveBeenCalledWith("core-a");
    expect(coordinator.invalidateCore).toHaveBeenCalledWith("core-a");
    expect(lifecycle.getDiagnosticCoreId()).toBe("core-a");
  });

  it("shuts down the coordinator once and ignores later lifecycle events", () => {
    const order: string[] = [];
    const service = {
      start: jest.fn().mockResolvedValue(undefined),
      markCoreDisconnected: jest.fn(),
    };
    const coordinator = {
      invalidateCore: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn(() => order.push("coordinator")),
    };
    const albumActions = {
      invalidateCore: jest.fn(),
      shutdown: jest.fn(() => order.push("actions")),
    };
    const timelineBrowse = {
      invalidateCore: jest.fn(),
      shutdown: jest.fn(() => order.push("timeline")),
    };
    // The extended library features refresh their own snapshot on a schedule.
    // Shutting the catalog down has to stop it, or a timer keeps pulling
    // against a Core nothing is listening to.
    const scheduledRefresh = {
      stopScheduledRefresh: jest.fn(() => order.push("scheduled-refresh")),
    };
    const lifecycle = new CatalogLifecycle(
      service,
      coordinator,
      logger,
      albumActions,
      timelineBrowse,
      undefined,
      scheduledRefresh
    );

    lifecycle.corePaired("core-a");
    lifecycle.shutdown();
    lifecycle.shutdown();
    lifecycle.coreUnpaired();
    lifecycle.corePaired("core-b");

    expect(coordinator.shutdown).toHaveBeenCalledTimes(1);
    expect(albumActions.shutdown).toHaveBeenCalledTimes(1);
    expect(timelineBrowse.shutdown).toHaveBeenCalledTimes(1);
    expect(scheduledRefresh.stopScheduledRefresh).toHaveBeenCalledTimes(1);
    // Stopping what would START new catalog work comes before tearing down the
    // services that work runs through.
    expect(order).toEqual([
      "scheduled-refresh",
      "timeline",
      "actions",
      "coordinator",
    ]);
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.markCoreDisconnected).not.toHaveBeenCalled();
  });

  it("still shuts the rest down when stopping the scheduled refresh throws", () => {
    const service = {
      start: jest.fn().mockResolvedValue(undefined),
      markCoreDisconnected: jest.fn(),
    };
    const coordinator = {
      invalidateCore: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn(),
    };
    const scheduledRefresh = {
      stopScheduledRefresh: jest.fn(() => {
        throw new Error("the feature layer refused to stop its schedule");
      }),
    };
    const lifecycle = new CatalogLifecycle(
      service,
      coordinator,
      logger,
      undefined,
      undefined,
      undefined,
      scheduledRefresh
    );

    lifecycle.shutdown();

    expect(coordinator.shutdown).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});
