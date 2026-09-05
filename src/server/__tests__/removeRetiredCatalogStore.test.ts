import path from "path";
import type { Logger } from "pino";

import { removeRetiredCatalogStore } from "../removeRetiredCatalogStore";

function testLogger(): Logger & { info: jest.Mock; warn: jest.Mock } {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    level: "info",
  } as unknown as Logger & { info: jest.Mock; warn: jest.Mock };
}

describe("removeRetiredCatalogStore", () => {
  it("removes the store an upgrading install still has, and says so", () => {
    const logger = testLogger();
    const rmSync = jest.fn();

    const outcome = removeRetiredCatalogStore("./data/catalog", logger, {
      existsSync: (() => true) as never,
      rmSync: rmSync as never,
    });

    expect(outcome).toBe("removed");
    expect(rmSync).toHaveBeenCalledWith(path.resolve("./data/catalog"), {
      recursive: true,
      force: true,
    });
    // Deleting a user's files silently is not something a program should do.
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("resolves the directory before deleting anything", () => {
    // A bare relative name would resolve against whatever directory the
    // process happened to start in, which is not a place anything may be
    // deleted from.
    const rmSync = jest.fn();

    removeRetiredCatalogStore("catalog", testLogger(), {
      existsSync: (() => true) as never,
      rmSync: rmSync as never,
    });

    const [target] = rmSync.mock.calls[0] as [string];
    expect(path.isAbsolute(target)).toBe(true);
    expect(target).toBe(path.resolve("catalog"));
  });

  it("says nothing and does nothing on a fresh install", () => {
    const logger = testLogger();
    const rmSync = jest.fn();

    const outcome = removeRetiredCatalogStore("./data/catalog", logger, {
      existsSync: (() => false) as never,
      rmSync: rmSync as never,
    });

    expect(outcome).toBe("absent");
    expect(rmSync).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("leaves the bytes and warns rather than refusing to start", () => {
    // A read-only data directory, or a permission the installer never granted,
    // is a reason to say so — not a reason to refuse to start a controller
    // that no longer depends on those bytes.
    const logger = testLogger();

    const outcome = removeRetiredCatalogStore("./data/catalog", logger, {
      existsSync: (() => true) as never,
      rmSync: (() => {
        throw new Error("EACCES");
      }) as never,
    });

    expect(outcome).toBe("failed");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
