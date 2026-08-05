import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AlbumActionBoundaryHarness,
  type ActionResolution,
  type BoundaryPorts,
} from "./support/albumActionBoundaryHarness";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: Deferred<T>["resolve"];
  let rejectPromise!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeHarness(
  overrides: Partial<BoundaryPorts<string>> = {},
  now?: () => number
): {
  harness: AlbumActionBoundaryHarness<string>;
  executeAction: jest.Mock<Promise<void>, [string]>;
} {
  const executeAction = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
  const ports: BoundaryPorts<string> = {
    resolveAction: () => Promise.resolve({ kind: "supported", action: "play-now" }),
    executeAction,
    ...overrides,
  };
  return {
    harness: new AlbumActionBoundaryHarness(ports, {
      callTimeoutMs: 100,
      quarantineReapMs: 1_000,
      now,
    }),
    executeAction,
  };
}

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    return entry.isFile() && /\.(?:js|svelte|ts)$/u.test(entry.name) ? [path] : [];
  });
}

describe("test-only album action boundary", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps the harness unreachable from production server and UI graphs", () => {
    const repoRoot = resolve(__dirname, "../../..");
    const productionRoots = [join(repoRoot, "src"), join(repoRoot, "ui", "src")];
    const offenders = productionRoots
      .flatMap(productionSourceFiles)
      .filter((file) => readFileSync(file, "utf8").includes("albumActionBoundaryHarness"));

    expect(offenders).toEqual([]);
  });

  it("sends no command for a missing action and cleanly releases once", async () => {
    const { harness, executeAction } = makeHarness({
      resolveAction: () => Promise.resolve({ kind: "missing" }),
    });

    await expect(harness.run()).resolves.toEqual({
      code: "MISSING_ACTION",
      executeIssued: false,
    });
    expect(executeAction).not.toHaveBeenCalled();
    expect(harness.snapshot()).toMatchObject({
      phase: "terminal",
      executeIssued: false,
      choiceValid: false,
      leaseHeld: false,
      cleanupCount: 1,
      cleanupDisposition: "clean-release",
    });
  });

  it("sends no command for an unsupported action and cleanly releases once", async () => {
    const { harness, executeAction } = makeHarness({
      resolveAction: () => Promise.resolve({ kind: "unsupported" }),
    });

    await expect(harness.run()).resolves.toEqual({
      code: "UNSUPPORTED_ACTION",
      executeIssued: false,
    });
    expect(executeAction).not.toHaveBeenCalled();
    expect(harness.snapshot()).toMatchObject({
      phase: "terminal",
      executeIssued: false,
      choiceValid: false,
      leaseHeld: false,
      cleanupCount: 1,
      cleanupDisposition: "clean-release",
    });
  });

  it("quarantines a pre-execute timeout and ignores a late action", async () => {
    const resolution = deferred<ActionResolution<string>>();
    const { harness, executeAction } = makeHarness({
      resolveAction: () => resolution.promise,
    });

    const result = harness.run();
    jest.advanceTimersByTime(100);
    await expect(result).resolves.toEqual({
      code: "PRE_EXECUTE_TIMEOUT",
      executeIssued: false,
    });
    expect(harness.snapshot()).toMatchObject({
      phase: "quarantined",
      executeIssued: false,
      choiceValid: false,
      leaseHeld: true,
      quarantineReason: "pre-execute-timeout",
      cleanupCount: 0,
    });
    expect(executeAction).not.toHaveBeenCalled();
    await expect(harness.run()).rejects.toThrow("one-shot");

    resolution.resolve({ kind: "supported", action: "play-now" });
    await flushMicrotasks();

    expect(executeAction).not.toHaveBeenCalled();
    expect(harness.snapshot()).toMatchObject({
      phase: "terminal",
      outcome: { code: "PRE_EXECUTE_TIMEOUT", executeIssued: false },
      cleanupCount: 1,
      cleanupDisposition: "tainted-discard",
    });
  });

  it("reports a post-execute timeout as unknown and never retries", async () => {
    const execution = deferred<void>();
    const executeAction = jest.fn<Promise<void>, [string]>(() => execution.promise);
    const { harness } = makeHarness({ executeAction });

    const result = harness.run();
    await flushMicrotasks();
    expect(executeAction).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(100);
    await expect(result).resolves.toEqual({
      code: "OUTCOME_UNKNOWN",
      executeIssued: true,
    });
    expect(harness.snapshot()).toMatchObject({
      phase: "quarantined",
      executeIssued: true,
      choiceValid: false,
      leaseHeld: true,
      quarantineReason: "post-execute-timeout",
      cleanupCount: 0,
    });

    jest.advanceTimersByTime(300);
    expect(executeAction).toHaveBeenCalledTimes(1);
    await expect(harness.run()).rejects.toThrow("one-shot");

    execution.resolve();
    await flushMicrotasks();

    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(harness.snapshot()).toMatchObject({
      phase: "terminal",
      outcome: { code: "OUTCOME_UNKNOWN", executeIssued: true },
      cleanupCount: 1,
      cleanupDisposition: "tainted-discard",
    });
  });

  it("makes bounded reap and late settlement converge on one cleanup", async () => {
    const resolution = deferred<ActionResolution<string>>();
    const { harness } = makeHarness({
      resolveAction: () => resolution.promise,
    });

    const result = harness.run();
    jest.advanceTimersByTime(100);
    await result;
    jest.advanceTimersByTime(1_000);

    expect(harness.snapshot()).toMatchObject({
      phase: "terminal",
      cleanupCount: 1,
      cleanupDisposition: "tainted-discard",
    });

    resolution.resolve({ kind: "supported", action: "play-now" });
    await flushMicrotasks();

    expect(harness.snapshot()).toMatchObject({
      phase: "terminal",
      outcome: { code: "PRE_EXECUTE_TIMEOUT", executeIssued: false },
      cleanupCount: 1,
      cleanupDisposition: "tainted-discard",
    });
  });

  it("uses the common cleanup path for deterministic success", async () => {
    const { harness, executeAction } = makeHarness();

    await expect(harness.run()).resolves.toEqual({
      code: "EXECUTED",
      executeIssued: true,
    });
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(executeAction).toHaveBeenCalledWith("play-now");
    expect(harness.snapshot()).toMatchObject({
      phase: "terminal",
      executeIssued: true,
      choiceValid: false,
      leaseHeld: false,
      cleanupCount: 1,
      cleanupDisposition: "clean-release",
    });
  });

  it("fails closed when settlement is observed exactly at the deadline", async () => {
    let clock = 0;
    const execution = deferred<void>();
    const executeAction = jest.fn<Promise<void>, [string]>(() => execution.promise);
    const { harness } = makeHarness({ executeAction }, () => clock);

    const result = harness.run();
    await flushMicrotasks();
    expect(executeAction).toHaveBeenCalledTimes(1);

    clock = 100;
    execution.resolve();
    await flushMicrotasks();

    await expect(result).resolves.toEqual({
      code: "OUTCOME_UNKNOWN",
      executeIssued: true,
    });
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(harness.snapshot()).toMatchObject({
      phase: "terminal",
      outcome: { code: "OUTCOME_UNKNOWN", executeIssued: true },
      cleanupCount: 1,
      cleanupDisposition: "tainted-discard",
    });
  });
});
