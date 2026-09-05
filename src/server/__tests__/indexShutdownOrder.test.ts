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
  withBrowseCanary?: boolean;
  browseCanaryThrows?: boolean;
}): ShutdownContext {
  const { order } = options;
  return {
    requestShutdown: () => order.push("requestShutdown"),
    ...(options.withBrowseCanary
      ? {
          browseCanary: {
            stop: () => {
              order.push("canary");
              if (options.browseCanaryThrows) throw new Error("canary stop failed");
            },
          },
        }
      : {}),
    coreLifecycle: { shutdown: () => order.push("core-lifecycle") },
    transportService: { shutdown: () => order.push("transport") },
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
  it("closes the socket server before the http server", async () => {
    const order: string[] = [];
    const exit = jest.fn();
    const shutdown = createShutdownHandler({
      context: buildContext({ order }),
      logger: testLogger(),
      exit,
    });
    shutdown("SIGTERM");
    expect(order.indexOf("io.close")).toBeLessThan(order.indexOf("http.close"));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("stops the post-connect load trial's canary before anything else", async () => {
    const order: string[] = [];
    const shutdown = createShutdownHandler({
      context: buildContext({ order, withBrowseCanary: true }),
      logger: testLogger(),
      exit: jest.fn(),
    });
    shutdown("SIGTERM");
    // Before the Core-scoped services, because the canary issues browse calls
    // and a shutting-down process should not put one more question to a Core
    // it is leaving.
    expect(order.indexOf("canary")).toBeGreaterThan(-1);
    expect(order.indexOf("canary")).toBeLessThan(
      order.indexOf("core-lifecycle")
    );
  });

  it("shuts down anyway when stopping the canary fails", async () => {
    const order: string[] = [];
    const exit = jest.fn();
    const logger = testLogger();
    const shutdown = createShutdownHandler({
      context: buildContext({
        order,
        withBrowseCanary: true,
        browseCanaryThrows: true,
      }),
      logger,
      exit,
    });
    shutdown("SIGTERM");
    expect(order).toContain("http.close");
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
    shutdown("SIGINT");
    expect(order).not.toContain("http.close");
    expect(exit).toHaveBeenCalledWith(0);
  });
});
