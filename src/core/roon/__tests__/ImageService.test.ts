import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { Logger } from "pino";

import { ImageService } from "../ImageService";
import { RoonClient } from "../RoonClient";

const stubLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
} as unknown as Logger;

describe("ImageService — in-memory hot cache", () => {
  let cacheDir: string;
  let getImageMock: jest.Mock;
  let roonClient: RoonClient;

  beforeEach(async () => {
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "roon-img-"));
    getImageMock = jest.fn(
      (key: string, _opts: unknown, cb: (err: unknown, ct?: string, data?: Buffer) => void) => {
        cb(null, "image/jpeg", Buffer.from(`payload-${key}`));
      }
    );
    roonClient = {
      getImage: jest.fn().mockReturnValue({ get_image: getImageMock }),
    } as unknown as RoonClient;
  });

  afterEach(async () => {
    // Retries absorb a fire-and-forget persist landing mid-removal.
    await fsp.rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  async function wipeDiskCache() {
    for (const name of await fsp.readdir(cacheDir)) {
      await fsp.unlink(path.join(cacheDir, name));
    }
  }

  /**
   * The disk persist is fire-and-forget off the request path — poll
   * for the data + meta pair instead of sleeping a fixed interval,
   * which flakes under full-suite load.
   */
  async function waitForDiskPersist(minFiles = 2): Promise<void> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const entries = await fsp.readdir(cacheDir);
      if (entries.length >= minFiles) return;
      if (Date.now() > deadline) {
        throw new Error(`disk persist did not land: ${entries.join(", ")}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("serves a repeat request from memory — no Roon call, no disk read", async () => {
    const service = new ImageService(roonClient, stubLogger, cacheDir);
    service.start();

    const first = await service.getImage("key-1");
    expect(first.data.toString()).toBe("payload-key-1");
    expect(getImageMock).toHaveBeenCalledTimes(1);

    // Remove the disk copy: only the hot cache can satisfy the repeat.
    await waitForDiskPersist();
    await wipeDiskCache();

    const second = await service.getImage("key-1");
    expect(second.data.toString()).toBe("payload-key-1");
    expect(second.contentType).toBe("image/jpeg");
    expect(getImageMock).toHaveBeenCalledTimes(1);
  });

  it("hydrates the hot cache from a disk hit", async () => {
    // First service instance fills the disk cache…
    const writer = new ImageService(roonClient, stubLogger, cacheDir);
    writer.start();
    await writer.getImage("key-1");
    await waitForDiskPersist();

    // A fresh instance (empty memory) reads disk once, then memory.
    const reader = new ImageService(roonClient, stubLogger, cacheDir);
    reader.start();
    await reader.getImage("key-1");
    expect(getImageMock).toHaveBeenCalledTimes(1); // disk hit, no Roon

    await wipeDiskCache();
    const again = await reader.getImage("key-1");
    expect(again.data.toString()).toBe("payload-key-1");
    expect(getImageMock).toHaveBeenCalledTimes(1); // memory hit
  });

  it("evicts least-recently-used entries when over the byte cap", async () => {
    // Cap fits two payloads ("payload-key-N" = 13 bytes) but not three.
    const service = new ImageService(roonClient, stubLogger, cacheDir, undefined, 30);
    service.start();

    await service.getImage("key-1");
    await service.getImage("key-2");
    // Touch key-1 so key-2 becomes the LRU…
    await service.getImage("key-1");
    // …then key-3 pushes the cache over cap, evicting key-2.
    await service.getImage("key-3");
    expect(getImageMock).toHaveBeenCalledTimes(3);

    await waitForDiskPersist(6); // 3 keys × (data + meta)
    await wipeDiskCache();

    await service.getImage("key-1"); // still hot
    await service.getImage("key-3"); // still hot
    expect(getImageMock).toHaveBeenCalledTimes(3);

    await service.getImage("key-2"); // evicted → back to Roon
    expect(getImageMock).toHaveBeenCalledTimes(4);
    // Drain the refetch's fire-and-forget persist before teardown.
    await waitForDiskPersist(2);
  });

  it("never caches an entry larger than the whole cap", async () => {
    getImageMock.mockImplementation(
      (key: string, _opts: unknown, cb: (err: unknown, ct?: string, data?: Buffer) => void) => {
        cb(null, "image/jpeg", Buffer.alloc(100, 1));
      }
    );
    const service = new ImageService(roonClient, stubLogger, cacheDir, undefined, 30);
    service.start();

    await service.getImage("huge");
    await waitForDiskPersist();
    await wipeDiskCache();
    await service.getImage("huge");
    // Not hot-cached (over cap) and disk wiped → refetched.
    expect(getImageMock).toHaveBeenCalledTimes(2);
    // Drain the refetch's fire-and-forget persist before teardown.
    await waitForDiskPersist(2);
  });

  it("disk cache files still get written (hot cache is additive)", async () => {
    const service = new ImageService(roonClient, stubLogger, cacheDir);
    service.start();
    await service.getImage("key-1");
    await waitForDiskPersist();

    const entries = await fsp.readdir(cacheDir);
    expect(entries.some((n) => n.endsWith(".meta"))).toBe(true);
    expect(entries.some((n) => !n.endsWith(".meta"))).toBe(true);
    expect(fs.existsSync(cacheDir)).toBe(true);
  });
});
