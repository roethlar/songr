import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { FavoritesService, favoriteDedupeKey } from "../FavoritesService";
import type { FavoriteEntry } from "../../../shared/types";

const stubLogger: any = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
};

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "favorites-test-"));
  return path.join(dir, "favorites.json");
}

describe("FavoritesService", () => {
  it("adds entries newest-first with id and added_at, and persists them", async () => {
    const filePath = await tmpFile();
    const svc = new FavoritesService(stubLogger, {
      filePath,
      now: () => Date.parse("2026-06-10T00:00:00.000Z"),
    });
    await svc.start();

    const first = await svc.add({ type: "track", title: "Hey Jude", artist: "The Beatles" });
    const second = await svc.add({ type: "artist", title: "Tilda Arlen" });

    expect(first.id).toBeTruthy();
    expect(first.added_at).toBe("2026-06-10T00:00:00.000Z");

    const entries = svc.getEntries();
    expect(entries.map((e) => e.title)).toEqual(["Tilda Arlen", "Hey Jude"]);
    expect(second.type).toBe("artist");

    const onDisk = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(onDisk.entries).toHaveLength(2);
    expect(onDisk.entries[0].title).toBe("Tilda Arlen");
  });

  it("is idempotent for same-identity adds (type/title/artist/album)", async () => {
    const svc = new FavoritesService(stubLogger, { filePath: await tmpFile() });
    await svc.start();

    const a = await svc.add({ type: "track", title: "Hey Jude", artist: "The Beatles" });
    const b = await svc.add({ type: "track", title: "Hey Jude", artist: "The Beatles" });

    expect(b.id).toBe(a.id);
    expect(svc.getEntries()).toHaveLength(1);

    // Same title under a different type is a distinct favorite.
    await svc.add({ type: "album", title: "Hey Jude", artist: "The Beatles" });
    expect(svc.getEntries()).toHaveLength(2);
  });

  it("removes by id and persists; unknown id returns false", async () => {
    const filePath = await tmpFile();
    const svc = new FavoritesService(stubLogger, { filePath });
    await svc.start();

    const entry = await svc.add({ type: "album", title: "Abbey Road" });
    expect(await svc.remove("nope")).toBe(false);
    expect(await svc.remove(entry.id)).toBe(true);
    expect(svc.getEntries()).toHaveLength(0);

    const onDisk = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(onDisk.entries).toHaveLength(0);
  });

  it("restores persisted entries on start", async () => {
    const filePath = await tmpFile();
    const first = new FavoritesService(stubLogger, { filePath });
    await first.start();
    await first.add({ type: "artist", title: "Beyoncé" });

    const second = new FavoritesService(stubLogger, { filePath });
    await second.start();
    expect(second.getEntries().map((e) => e.title)).toEqual(["Beyoncé"]);
  });

  it.each([500, 751])("preserves %i existing bookmarks through load, add, and restart", async (count) => {
    const filePath = await tmpFile();
    const types = ["track", "album", "artist"] as const;
    const saved: FavoriteEntry[] = Array.from({ length: count }, (_, index) => ({
      id: `saved-${index}`,
      type: types[index % types.length],
      title: `Saved item ${index}`,
      artist: `Credit ${index}`,
      image_key: `image-${index}`,
      added_at: "2026-06-10T00:00:00.000Z",
    }));
    const persisted = JSON.stringify({ entries: saved });
    await fs.writeFile(filePath, persisted, "utf-8");

    const svc = new FavoritesService(stubLogger, { filePath });
    await svc.start();
    expect(svc.getEntries()).toEqual(saved);
    expect(await fs.readFile(filePath, "utf-8")).toBe(persisted);

    const added = await svc.add({ type: "track", title: "New bookmark", artist: "New artist" });
    const expected = [added, ...saved];
    expect(svc.getEntries()).toEqual(expected);
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual({ entries: expected });

    const restarted = new FavoritesService(stubLogger, { filePath });
    await restarted.start();
    expect(restarted.getEntries()).toEqual(expected);
    // A saved item beyond the former boundary retains its identity on a duplicate add.
    const oldest = saved[saved.length - 1];
    expect(await restarted.add(oldest)).toEqual(oldest);
    expect(restarted.getEntries()).toEqual(expected);
  });

  it("enters degraded mode on a corrupt file and refuses mutations without clobbering it", async () => {
    const filePath = await tmpFile();
    await fs.writeFile(filePath, "{not json", "utf-8");

    const svc = new FavoritesService(stubLogger, { filePath });
    await svc.start();

    expect(svc.isDegraded()).toBe(true);
    await expect(svc.add({ type: "track", title: "X" })).rejects.toThrow(/degraded/);
    // The corrupt file is left untouched for inspection.
    expect(await fs.readFile(filePath, "utf-8")).toBe("{not json");
  });

  it("rolls back the in-memory list when persist fails", async () => {
    const filePath = await tmpFile();
    const svc = new FavoritesService(stubLogger, { filePath });
    await svc.start();
    await svc.add({ type: "track", title: "Keep Me" });

    const writeSpy = jest
      .spyOn(fs, "writeFile")
      .mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(svc.add({ type: "track", title: "Lost" })).rejects.toThrow("disk full");
      expect(svc.getEntries().map((e) => e.title)).toEqual(["Keep Me"]);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("dedupe key distinguishes null vs empty and field positions", () => {
    expect(
      favoriteDedupeKey({ type: "track", title: "A", artist: "B" })
    ).not.toBe(favoriteDedupeKey({ type: "track", title: "A", album: "B" }));
    expect(
      favoriteDedupeKey({ type: "track", title: "A" })
    ).not.toBe(favoriteDedupeKey({ type: "track", title: "A", artist: "" }));
  });
});
