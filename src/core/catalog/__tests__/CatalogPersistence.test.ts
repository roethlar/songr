import os from "os";
import path from "path";
import { promises as fs } from "fs";

import {
  CatalogPersistenceFileSystem,
  FileCatalogPersistence,
} from "../CatalogPersistence";

describe("FileCatalogPersistence", () => {
  const directories: string[] = [];

  async function temporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-store-"));
    directories.push(directory);
    return directory;
  }

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
      )
    );
  });

  it("round-trips one atomic private JSON file per opaque Core ID", async () => {
    const directory = await temporaryDirectory();
    const store = new FileCatalogPersistence({
      directory,
      createNonce: () => "nonce-a",
    });
    const hostileCoreId = "../../Core/With Spaces";
    const otherCoreId = "other-core";
    const firstValue = { version: 1, coreId: hostileCoreId, snapshot: { revision: 7 } };
    const secondValue = { version: 1, coreId: otherCoreId, snapshot: { revision: 2 } };

    await store.write(hostileCoreId, firstValue);
    await store.write(otherCoreId, secondValue);

    expect(await store.read(hostileCoreId)).toEqual(firstValue);
    expect(await store.read(otherCoreId)).toEqual(secondValue);
    expect(await store.read("missing-core")).toBeNull();

    const firstPath = store.filePathForCore(hostileCoreId);
    const secondPath = store.filePathForCore(otherCoreId);
    expect(path.dirname(firstPath)).toBe(path.resolve(directory));
    expect(path.basename(firstPath)).toMatch(/^[a-f0-9]{64}\.catalog-v1\.json$/u);
    expect(firstPath).not.toContain("Core");
    expect(firstPath).not.toBe(secondPath);
    expect((await fs.stat(firstPath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(directory)).sort()).toEqual(
      [path.basename(firstPath), path.basename(secondPath)].sort()
    );
  });

  it("preserves the prior file and cleans its temp file when rename fails", async () => {
    const directory = await temporaryDirectory();
    const seed = new FileCatalogPersistence({
      directory,
      createNonce: () => "seed",
    });
    await seed.write("core-a", { revision: 1 });

    const realFileSystem: CatalogPersistenceFileSystem = {
      readFile: (filePath) => fs.readFile(filePath),
      mkdir: (target, options) => fs.mkdir(target, options),
      writeFile: (filePath, data, options) => fs.writeFile(filePath, data, options),
      rename: async () => {
        throw Object.assign(new Error("simulated rename failure"), {
          code: "EIO",
        });
      },
      unlink: (filePath) => fs.unlink(filePath),
    };
    const failing = new FileCatalogPersistence({
      directory,
      createNonce: () => "failure",
      fileSystem: realFileSystem,
    });

    await expect(failing.write("core-a", { revision: 2 })).rejects.toThrow(
      "simulated rename failure"
    );
    expect(await seed.read("core-a")).toEqual({ revision: 1 });
    expect(await fs.readdir(directory)).toEqual([
      path.basename(seed.filePathForCore("core-a")),
    ]);
  });

  it("rejects oversized input without touching an existing file", async () => {
    const directory = await temporaryDirectory();
    const seed = new FileCatalogPersistence({ directory, createNonce: () => "seed" });
    await seed.write("core-a", { revision: 1 });
    const bytesBefore = await fs.readFile(seed.filePathForCore("core-a"));
    const bounded = new FileCatalogPersistence({
      directory,
      maxBytes: 32,
      createNonce: () => "bounded",
    });

    await expect(
      bounded.write("core-a", { value: "x".repeat(64) })
    ).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(await fs.readFile(seed.filePathForCore("core-a"))).toEqual(bytesBefore);
    await fs.writeFile(seed.filePathForCore("core-a"), Buffer.alloc(33, "x"));
    await expect(bounded.read("core-a")).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("leaves malformed JSON byte-for-byte unchanged", async () => {
    const directory = await temporaryDirectory();
    const store = new FileCatalogPersistence({ directory });
    const filePath = store.filePathForCore("core-a");
    const malformed = Buffer.from("{ definitely not JSON\n", "utf8");
    await fs.writeFile(filePath, malformed);

    await expect(store.read("core-a")).rejects.toBeInstanceOf(SyntaxError);
    expect(await fs.readFile(filePath)).toEqual(malformed);
  });

  it.each(["", " core-a", "core-a ", "core\nA"])(
    "rejects an invalid Core ID without filesystem access (%j)",
    async (coreId) => {
      const directory = await temporaryDirectory();
      const store = new FileCatalogPersistence({ directory });
      await expect(store.read(coreId)).rejects.toMatchObject({
        code: "INVALID_CORE_ID",
      });
      expect(await fs.readdir(directory)).toEqual([]);
    }
  );

  it("keeps sibling stores apart through a validated custom file suffix", async () => {
    const directory = await temporaryDirectory();
    const catalog = new FileCatalogPersistence({
      directory,
      createNonce: () => "nonce-a",
    });
    const native = new FileCatalogPersistence({
      directory,
      createNonce: () => "nonce-b",
      fileSuffix: ".native-albums-v1.json",
    });

    await catalog.write("core-a", { kind: "catalog" });
    await native.write("core-a", { kind: "native" });

    expect(await catalog.read("core-a")).toEqual({ kind: "catalog" });
    expect(await native.read("core-a")).toEqual({ kind: "native" });
    expect(path.basename(native.filePathForCore("core-a"))).toMatch(
      /^[a-f0-9]{64}\.native-albums-v1\.json$/u
    );

    for (const badSuffix of ["native.json", "../x.json", ".has space.json", ".UPPER.json"]) {
      expect(
        () =>
          new FileCatalogPersistence({ directory, fileSuffix: badSuffix })
      ).toThrow(
        expect.objectContaining({ code: "INVALID_CONFIGURATION" }) as Error
      );
    }
  });
});
