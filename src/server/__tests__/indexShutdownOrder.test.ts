/**
 * ms1-2 guard: the shutdown sequence must AWAIT the optional workspace
 * layer's asynchronous cleanup before closing the socket server or
 * exiting. The load-bearing case delays that cleanup by a tick — with the
 * pre-fix fire-and-forget ordering, the socket server closes first and
 * this suite fails.
 */
import type { Logger } from "pino";

import { createShutdownHandler, ShutdownContext } from "../shutdown";

function testLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  } as unknown as Logger;
}

function buildContext(options: {
  order: string[];
  workspaceDelayTicks?: number;
  workspaceRejects?: boolean;
  listening?: boolean;
}): ShutdownContext {
  const { order } = options;
  return {
    requestShutdown: () => order.push("requestShutdown"),
    catalogLifecycle: { shutdown: () => order.push("catalog") },
    transportService: { shutdown: () => order.push("transport") },
    workspaceFeatures: {
      shutdown: async () => {
        order.push("workspace:start");
        for (let tick = 0; tick < (options.workspaceDelayTicks ?? 2); tick += 1) {
          await Promise.resolve();
        }
        if (options.workspaceRejects) {
          order.push("workspace:reject");
          throw new Error("cleanup failed");
        }
        order.push("workspace:done");
      },
    },
    socketContext: {
      io: {
        close: (done?: () => void) => {
          order.push("io.close");
          done?.();
        },
      },
    },
    isListening: () => options.listening ?? true,
    httpServer: {
      close: (done: (error?: Error) => void) => {
        order.push("http.close");
        done();
      },
    },
  };
}

describe("the shutdown sequence", () => {
  it("settles workspace cleanup before closing the socket server", async () => {
    const order: string[] = [];
    const exit = jest.fn();
    const shutdown = createShutdownHandler({
      context: buildContext({ order }),
      logger: testLogger(),
      exit,
    });
    await shutdown("SIGTERM");
    expect(order.indexOf("workspace:done")).toBeGreaterThan(-1);
    expect(order.indexOf("workspace:done")).toBeLessThan(order.indexOf("io.close"));
    expect(order.indexOf("io.close")).toBeLessThan(order.indexOf("http.close"));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still shuts down when workspace cleanup fails", async () => {
    const order: string[] = [];
    const exit = jest.fn();
    const logger = testLogger();
    const shutdown = createShutdownHandler({
      context: buildContext({ order, workspaceRejects: true }),
      logger,
      exit,
    });
    await shutdown("SIGTERM");
    expect(order.indexOf("workspace:reject")).toBeLessThan(order.indexOf("io.close"));
    expect((logger.warn as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits without an http close during the deferred-listen window", async () => {
    const order: string[] = [];
    const exit = jest.fn();
    const shutdown = createShutdownHandler({
      context: buildContext({ order, listening: false }),
      logger: testLogger(),
      exit,
    });
    await shutdown("SIGINT");
    expect(order).not.toContain("http.close");
    expect(order.indexOf("workspace:done")).toBeLessThan(order.indexOf("io.close"));
    expect(exit).toHaveBeenCalledWith(0);
  });
});
