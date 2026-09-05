import pino from "pino";

import { BrowseSessionCoordinatorError } from "../../roon/BrowseSessionCoordinator";
import type {
  CatalogCountSessionHandle,
  CatalogSessionHandle,
  CoordinatedBrowseSession,
} from "../../roon/BrowseSessionCoordinator";
import { RoonTimeoutError } from "../../roon/errors";
import {
  LibraryBrowseSession,
  type LibraryBrowseCoordinator,
} from "../LibraryBrowseSession";

const logger = pino({ level: "silent" });

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const session = {} as CoordinatedBrowseSession;

class FakeCoordinator implements LibraryBrowseCoordinator {
  public readonly acquireCalls: string[] = [];
  public readonly releaseCalls: string[] = [];
  public readonly runCalls: string[] = [];
  public readonly countAcquireCalls: string[] = [];
  public readonly countReleaseCalls: string[] = [];
  public readonly countRunCalls: string[] = [];
  public postRunError: unknown;
  public postCountRunError: unknown;
  private handleSeq = 0;

  public acquireCatalog(coreId: string): CatalogSessionHandle {
    this.acquireCalls.push(coreId);
    this.handleSeq += 1;
    return { id: `catalog-${this.handleSeq}` } as unknown as CatalogSessionHandle;
  }

  public async runCatalog<T>(
    coreId: string,
    _handle: CatalogSessionHandle,
    work: (browse: CoordinatedBrowseSession) => Promise<T>,
  ): Promise<T> {
    this.runCalls.push(coreId);
    const value = await work(session);
    if (this.postRunError) throw this.postRunError;
    return value;
  }

  public async releaseCatalog(coreId: string): Promise<void> {
    this.releaseCalls.push(coreId);
  }

  public acquireCatalogCount(coreId: string): CatalogCountSessionHandle {
    this.countAcquireCalls.push(coreId);
    this.handleSeq += 1;
    return {
      id: `count-${this.handleSeq}`,
    } as unknown as CatalogCountSessionHandle;
  }

  public async runCatalogCount<T>(
    coreId: string,
    _handle: CatalogCountSessionHandle,
    work: (browse: CoordinatedBrowseSession) => Promise<T>,
  ): Promise<T> {
    this.countRunCalls.push(coreId);
    const value = await work(session);
    if (this.postCountRunError) throw this.postCountRunError;
    return value;
  }

  public async releaseCatalogCount(coreId: string): Promise<void> {
    this.countReleaseCalls.push(coreId);
  }
}

describe("LibraryBrowseSession", () => {
  it("serializes work behind an in-flight call on the same retained session", async () => {
    const coordinator = new FakeCoordinator();
    const browse = new LibraryBrowseSession(coordinator, logger);
    const gate = deferred<string>();

    const order: string[] = [];
    const first = browse.run("core-a", async () => {
      order.push("first-start");
      const value = await gate.promise;
      order.push("first-end");
      return value;
    });
    await flushPromises();

    const second = browse.run("core-a", async () => {
      order.push("second");
      return "second";
    });
    await flushPromises();
    expect(order).toEqual(["first-start"]);

    gate.resolve("first");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first-start", "first-end", "second"]);
    // One lease serves both calls.
    expect(coordinator.acquireCalls).toEqual(["core-a"]);
  });

  it("retains the lease across calls and releases it after the idle window", async () => {
    jest.useFakeTimers();
    try {
      const coordinator = new FakeCoordinator();
      const browse = new LibraryBrowseSession(coordinator, logger, {
        idleMs: 1_000,
      });

      await browse.run("core-a", async () => "one");
      await browse.run("core-a", async () => "two");
      expect(coordinator.acquireCalls).toEqual(["core-a"]);
      expect(coordinator.releaseCalls).toEqual([]);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(coordinator.releaseCalls).toEqual(["core-a"]);

      await browse.run("core-a", async () => "three");
      expect(coordinator.acquireCalls).toEqual(["core-a", "core-a"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("drops the retained lease after session loss and reacquires on the next call", async () => {
    const coordinator = new FakeCoordinator();
    const browse = new LibraryBrowseSession(coordinator, logger);

    await browse.run("core-a", async () => "one");
    coordinator.postRunError = new BrowseSessionCoordinatorError(
      "SESSION_LOST",
      "session lost",
    );
    await expect(browse.run("core-a", async () => "two")).rejects.toMatchObject(
      { code: "SESSION_LOST" },
    );
    expect(coordinator.releaseCalls).toEqual(["core-a"]);

    coordinator.postRunError = undefined;
    await browse.run("core-a", async () => "three");
    expect(coordinator.acquireCalls).toEqual(["core-a", "core-a"]);
  });

  it("treats a Roon timeout as loss of the retained lease", async () => {
    const coordinator = new FakeCoordinator();
    const browse = new LibraryBrowseSession(coordinator, logger);

    await browse.run("core-a", async () => "one");
    coordinator.postRunError = new RoonTimeoutError("browse", 15_000);
    await expect(browse.run("core-a", async () => "two")).rejects.toThrow(
      RoonTimeoutError,
    );
    expect(coordinator.releaseCalls).toEqual(["core-a"]);
  });

  it("runs counts on an isolated lease and replaces only that lease after loss", async () => {
    const coordinator = new FakeCoordinator();
    const browse = new LibraryBrowseSession(coordinator, logger);

    await browse.runCount("core-a", async () => "first-count");
    await browse.runCount("core-a", async () => "second-count");
    expect(coordinator.acquireCalls).toEqual(["core-a"]);
    expect(coordinator.countAcquireCalls).toEqual(["core-a"]);
    expect(coordinator.countRunCalls).toEqual(["core-a", "core-a"]);

    coordinator.postCountRunError = new BrowseSessionCoordinatorError(
      "SESSION_LOST",
      "count session lost",
    );
    await expect(
      browse.runCount("core-a", async () => "lost"),
    ).rejects.toMatchObject({ code: "SESSION_LOST" });
    expect(coordinator.countReleaseCalls).toEqual(["core-a"]);

    // The publication lease is untouched: the references it minted still work.
    coordinator.postCountRunError = undefined;
    await expect(
      browse.run("core-a", async () => "publication-still-current"),
    ).resolves.toBe("publication-still-current");
    await browse.runCount("core-a", async () => "replacement");
    expect(coordinator.acquireCalls).toEqual(["core-a"]);
    expect(coordinator.countAcquireCalls).toEqual(["core-a", "core-a"]);
  });

  it("releases the retained lease when the Core disconnects", async () => {
    const coordinator = new FakeCoordinator();
    const browse = new LibraryBrowseSession(coordinator, logger);

    await browse.run("core-a", async () => "one");
    browse.markCoreDisconnected("core-a");
    await flushPromises();
    expect(coordinator.releaseCalls).toEqual(["core-a"]);

    await browse.run("core-a", async () => "two");
    expect(coordinator.acquireCalls).toEqual(["core-a", "core-a"]);
  });

  it("releases every retained lease on shutdown", async () => {
    const coordinator = new FakeCoordinator();
    const browse = new LibraryBrowseSession(coordinator, logger);

    await browse.run("core-a", async () => "a");
    await browse.run("core-b", async () => "b");
    browse.shutdown();
    await flushPromises();
    expect(coordinator.releaseCalls.sort()).toEqual(["core-a", "core-b"]);
  });

  it("refuses an empty core id", () => {
    const browse = new LibraryBrowseSession(new FakeCoordinator(), logger);
    expect(() => browse.run("", async () => "x")).toThrow(TypeError);
    expect(() => browse.runCount("  ", async () => "x")).toThrow(TypeError);
  });
});
