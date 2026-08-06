import {
  DEFAULT_FORCE_EXIT_AFTER_MS,
  attachParentDisconnectWatchdog,
} from "../parentDisconnectWatchdog";
import type { WatchdogProcess } from "../parentDisconnectWatchdog";

/**
 * The real `process` is never touched here: every test drives a fake with the
 * same shape, so nothing can exit the Jest runner and the IPC-present and
 * IPC-absent cases are both reachable in-band.
 */
interface FakeProcess extends WatchdogProcess {
  fireDisconnect(): void;
  readonly exitCalls: number[];
  readonly listenerCount: number;
}

const makeProcess = (options?: {
  hasIpc?: boolean;
  connected?: boolean;
}): FakeProcess => {
  const listeners: (() => void)[] = [];
  const exitCalls: number[] = [];

  return {
    send: (options?.hasIpc ?? true) ? (): boolean => true : undefined,
    connected: options?.connected,
    once(_event: "disconnect", listener: () => void) {
      listeners.push(listener);
      return this;
    },
    exit(code?: number) {
      exitCalls.push(code ?? 0);
      return undefined;
    },
    fireDisconnect() {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    exitCalls,
    get listenerCount() {
      return listeners.length;
    },
  };
};

const makeLogger = () => ({ info: jest.fn(), warn: jest.fn() });

describe("parent disconnect watchdog", () => {
  it("shuts the engine down when the parent closes the IPC channel", () => {
    const proc = makeProcess();
    const onDisconnect = jest.fn();

    const armed = attachParentDisconnectWatchdog({
      onDisconnect,
      proc,
      scheduleForceExit: () => undefined,
    });

    expect(armed).toBe(true);
    expect(onDisconnect).not.toHaveBeenCalled();

    proc.fireDisconnect();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("is a strict no-op without an IPC channel (appliance install)", () => {
    const proc = makeProcess({ hasIpc: false });
    const onDisconnect = jest.fn();
    const logger = makeLogger();

    const armed = attachParentDisconnectWatchdog({
      onDisconnect,
      proc,
      logger,
      scheduleForceExit: () => undefined,
    });

    expect(armed).toBe(false);
    expect(proc.listenerCount).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();

    // Even if something did emit `disconnect`, nothing is listening.
    proc.fireDisconnect();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(proc.exitCalls).toEqual([]);
  });

  it("does not touch the real process when there is no IPC channel", () => {
    const original = process.send;
    delete (process as NodeJS.Process & { send?: typeof process.send }).send;
    try {
      expect(
        attachParentDisconnectWatchdog({ onDisconnect: jest.fn() })
      ).toBe(false);
    } finally {
      if (original !== undefined) {
        process.send = original;
      }
    }
  });

  it("exits anyway when the graceful shutdown never finishes", () => {
    const proc = makeProcess();
    let forced: (() => void) | null = null;
    let scheduledMs: number | null = null;

    attachParentDisconnectWatchdog({
      // A shutdown that hangs — an HTTP server draining a connection that
      // never closes is the real-world version of this.
      onDisconnect: () => undefined,
      proc,
      scheduleForceExit: (callback, ms) => {
        forced = callback;
        scheduledMs = ms;
      },
    });

    proc.fireDisconnect();
    expect(scheduledMs).toBe(DEFAULT_FORCE_EXIT_AFTER_MS);
    expect(proc.exitCalls).toEqual([]);

    (forced as unknown as () => void)();
    expect(proc.exitCalls).toEqual([0]);
  });

  it("exits immediately when the shutdown throws", () => {
    const proc = makeProcess();
    const logger = makeLogger();

    attachParentDisconnectWatchdog({
      onDisconnect: () => {
        throw new Error("shutdown exploded");
      },
      proc,
      logger,
      scheduleForceExit: () => undefined,
    });

    proc.fireDisconnect();

    expect(proc.exitCalls).toEqual([0]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("handles a parent that already died before the watchdog was armed", () => {
    const proc = makeProcess({ connected: false });
    const onDisconnect = jest.fn();

    const armed = attachParentDisconnectWatchdog({
      onDisconnect,
      proc,
      scheduleForceExit: () => undefined,
    });

    // No `disconnect` event is ever coming — it already fired. Arming has to
    // mean shutting down now, not waiting forever.
    expect(armed).toBe(true);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("still waits for the event when the channel is live", () => {
    const proc = makeProcess({ connected: true });
    const onDisconnect = jest.fn();

    attachParentDisconnectWatchdog({
      onDisconnect,
      proc,
      scheduleForceExit: () => undefined,
    });

    expect(onDisconnect).not.toHaveBeenCalled();
    expect(proc.listenerCount).toBe(1);
  });
});
