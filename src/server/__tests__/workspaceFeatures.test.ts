import type { Logger } from "pino";
import type { Socket } from "socket.io";

import {
  absentWorkspaceFeatureLayer,
  loadWorkspaceFeatureLayer,
  WorkspaceFeatureHost,
  WorkspaceFeatureLayer,
} from "../workspaceFeatures";

const IMPLEMENTATION = "../native/workspaceFeatureLayer";
const VIRTUAL = { virtual: true } as const;

function testLogger(): Logger & { info: jest.Mock; error: jest.Mock } {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  } as unknown as Logger & { info: jest.Mock; error: jest.Mock };
}

function testHost(logger: Logger): WorkspaceFeatureHost {
  return {
    logger,
    getCoreId: () => null,
    getCoreAddress: () => null,
    getZones: () => [],
    onZonesChanged: () => () => {},
    onCoreChanged: () => () => {},
  };
}

describe("the absent workspace layer", () => {
  it("attaches nothing and answers every lifecycle call harmlessly", async () => {
    const layer = absentWorkspaceFeatureLayer();
    const socket = { on: jest.fn(), emit: jest.fn() } as unknown as Socket;
    expect(() => layer.attachSocket(socket)).not.toThrow();
    expect((socket.on as jest.Mock).mock.calls).toHaveLength(0);
    expect(() => layer.retireSocket("socket-1")).not.toThrow();
    await expect(layer.shutdown()).resolves.toBeUndefined();
  });
});

describe("loading the workspace features", () => {
  afterEach(() => {
    jest.resetModules();
  });

  it("treats a missing implementation as normal absence, not a fault", () => {
    jest.doMock(
      IMPLEMENTATION,
      () => {
        const absent = new Error(
          "Cannot find module './native/workspaceFeatureLayer'"
        ) as Error & { code?: string };
        absent.code = "MODULE_NOT_FOUND";
        throw absent;
      },
      VIRTUAL
    );
    const logger = testLogger();

    const layer = loadWorkspaceFeatureLayer(testHost(logger));

    const socket = { on: jest.fn() } as unknown as Socket;
    expect(() => layer.attachSocket(socket)).not.toThrow();
    expect((socket.on as jest.Mock).mock.calls).toHaveLength(0);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it("treats a broken implementation as absence, with the fault logged", () => {
    jest.doMock(
      IMPLEMENTATION,
      () => {
        throw new Error("implementation exploded at load time");
      },
      VIRTUAL
    );
    const logger = testLogger();

    const layer = loadWorkspaceFeatureLayer(testHost(logger));

    expect(() => layer.retireSocket("socket-1")).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });

  it("treats a module without the entry point as unusable", () => {
    jest.doMock(IMPLEMENTATION, () => ({}), VIRTUAL);
    const logger = testLogger();

    const layer = loadWorkspaceFeatureLayer(testHost(logger));

    expect(() => layer.attachSocket({ on: jest.fn() } as unknown as Socket)).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });

  it("treats a throwing factory as absence", () => {
    jest.doMock(
      IMPLEMENTATION,
      () => ({
        createWorkspaceFeatureLayer: () => {
          throw new Error("factory refused");
        },
      }),
      VIRTUAL
    );
    const logger = testLogger();

    const layer = loadWorkspaceFeatureLayer(testHost(logger));

    expect(() => layer.attachSocket({ on: jest.fn() } as unknown as Socket)).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns the produced layer when the factory yields a usable one", () => {
    const produced: WorkspaceFeatureLayer & {
      attachSocket: jest.Mock;
      retireSocket: jest.Mock;
    } = {
      attachSocket: jest.fn(),
      retireSocket: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
    jest.doMock(
      IMPLEMENTATION,
      () => ({ createWorkspaceFeatureLayer: () => produced }),
      VIRTUAL
    );
    const logger = testLogger();

    const layer = loadWorkspaceFeatureLayer(testHost(logger));

    const socket = { on: jest.fn() } as unknown as Socket;
    layer.attachSocket(socket);
    layer.retireSocket("socket-9");
    expect(produced.attachSocket).toHaveBeenCalledWith(socket);
    expect(produced.retireSocket).toHaveBeenCalledWith("socket-9");
    expect(logger.error).not.toHaveBeenCalled();
  });
});
