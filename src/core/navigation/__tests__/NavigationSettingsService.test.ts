import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { Logger } from "pino";
import {
  NavigationSettingsConflictError,
  NavigationSettingsInputError,
  NavigationSettingsPersistenceError,
  NavigationSettingsService,
  NavigationSettingsUnavailableError,
} from "../NavigationSettingsService";
import {
  DEFAULT_NAVIGATION_SETTINGS,
  type NavigationSettingsSnapshot,
  type NavigationSettingsUpdate,
} from "../../../shared/navigationSettings";

const publicId = (path: unknown): string => `public:${encodeURIComponent(JSON.stringify(path))}`;

const logger = { warn: jest.fn(), error: jest.fn() } as unknown as Logger;
const updateFor = (revision = 0): NavigationSettingsUpdate => ({
  expectedRevision: revision,
  order: [...DEFAULT_NAVIGATION_SETTINGS.order].reverse(),
  pinned: ["surprise", "recently-played"],
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("NavigationSettingsService", () => {
  let directory: string;
  let filePath: string;
  let service: NavigationSettingsService;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "songr-navigation-service-"));
    filePath = path.join(directory, "data", "navigation-preferences.json");
    service = new NavigationSettingsService(logger, { filePath });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("uses defaults only for a missing file and refuses reads until initialized", async () => {
    expect(() => service.getSnapshot()).toThrow(NavigationSettingsUnavailableError);
    await service.start();
    expect(service.getSnapshot()).toEqual(DEFAULT_NAVIGATION_SETTINGS);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves order/pins and revision across a service restart, including an empty pin list", async () => {
    await service.start();
    const saved = await service.update(updateFor());
    expect(saved.revision).toBe(1);
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(saved);
    const restarted = new NavigationSettingsService(logger, { filePath });
    await restarted.start();
    expect(restarted.getSnapshot()).toEqual(saved);
    const unpinned = await restarted.update({ ...updateFor(1), pinned: [] });
    expect(unpinned).toMatchObject({ revision: 2, pinned: [] });
    const reopened = new NavigationSettingsService(logger, { filePath });
    await reopened.start();
    expect(reopened.getSnapshot()).toEqual(unpinned);
  });

  it("persists discovered public page pins and order across restarts without migrating a v1 file", async () => {
    const legacy = { ...DEFAULT_NAVIGATION_SETTINGS, revision: 7,
      order: [...DEFAULT_NAVIGATION_SETTINGS.order].reverse(), pinned: ["albums", "artists"] };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacy));
    await service.start();
    expect(service.getSnapshot()).toEqual(legacy);
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(legacy);

    const provider = `public:${encodeURIComponent(JSON.stringify([{ title: "Qobuz", itemType: "list" }]))}`;
    const collection = `public:${encodeURIComponent(JSON.stringify([
      { title: "Library" }, { title: "My selections", subtitle: "Saved / 100% 🎵", itemType: "list" },
    ]))}`;
    const input = { expectedRevision: 7,
      order: [provider, ...legacy.order, collection], pinned: ["albums", collection, provider] };
    const saved = await service.update(input);
    expect(saved).toEqual({ version: 1, revision: 8, order: input.order, pinned: input.pinned });
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(saved);
    const restarted = new NavigationSettingsService(logger, { filePath });
    await restarted.start();
    expect(restarted.getSnapshot()).toEqual(saved);

    // Availability is runtime-only: an ordinary later save must preserve the
    // custom page's durable position even when it is no longer pinned.
    const unpinned = await restarted.update({ expectedRevision: 8,
      order: saved.order, pinned: [collection] });
    const reopened = new NavigationSettingsService(logger, { filePath });
    await reopened.start();
    expect(reopened.getSnapshot()).toEqual({ ...saved, revision: 9, pinned: [collection] });
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(unpinned);
  });

  it("keeps GET and broadcasts on the prior committed snapshot until atomic replacement finishes", async () => {
    await service.start();
    const first = await service.update(updateFor());
    const entered = deferred();
    const release = deferred();
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      entered.resolve();
      await release.promise;
      await rename(from, to);
    });
    const events: NavigationSettingsSnapshot[] = [];
    service.on("updated", (snapshot: NavigationSettingsSnapshot) => { events.push(snapshot); });
    const saving = service.update({ ...updateFor(1), pinned: [] });
    await entered.promise;
    try {
      expect(service.getSnapshot()).toEqual(first);
      expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(first);
      expect(events).toEqual([]);
    } finally {
      release.resolve();
    }
    const committed = await saving;
    expect(events).toEqual([committed]);
    expect(service.getSnapshot()).toEqual(committed);
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(committed);
  });

  it("does not publish or lose the old file after replacement fails and can save again", async () => {
    await service.start();
    const first = await service.update(updateFor());
    const listener = jest.fn();
    service.on("updated", listener);
    jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk full"));
    await expect(service.update({ ...updateFor(1), pinned: [] }))
      .rejects.toThrow(NavigationSettingsPersistenceError);
    expect(service.getSnapshot()).toEqual(first);
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(first);
    expect(listener).not.toHaveBeenCalled();
    expect(await fs.readdir(path.dirname(filePath))).toEqual(["navigation-preferences.json"]);
    const next = await service.update({ ...updateFor(1), pinned: [] });
    expect(next.revision).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("serializes simultaneous saves and rejects the stale client with the committed snapshot", async () => {
    await service.start();
    const [first, second] = await Promise.allSettled([
      service.update(updateFor()),
      service.update({ ...updateFor(), pinned: [] }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (first.status !== "fulfilled" || second.status !== "rejected") throw new Error("Expected conflict");
    expect(second.reason).toBeInstanceOf(NavigationSettingsConflictError);
    expect(second.reason.current).toEqual(first.value);
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(first.value);
  });

  it.each(["{broken", JSON.stringify({ ...DEFAULT_NAVIGATION_SETTINGS, version: 2 }),
    JSON.stringify({ ...DEFAULT_NAVIGATION_SETTINGS, order: ["artists"] })])(
    "preserves unreadable or invalid persisted state instead of resetting it (%s)", async (contents) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents);
      await service.start();
      expect(() => service.getSnapshot()).toThrow(NavigationSettingsUnavailableError);
      await expect(service.update(updateFor())).rejects.toThrow(NavigationSettingsUnavailableError);
      expect(await fs.readFile(filePath, "utf-8")).toBe(contents);
    }
  );

  it("treats a filesystem read error as unavailable, not as a first run", async () => {
    await fs.mkdir(filePath, { recursive: true });
    await service.start();
    expect(() => service.getSnapshot()).toThrow(NavigationSettingsUnavailableError);
    await expect(service.update(updateFor())).rejects.toThrow(NavigationSettingsUnavailableError);
    expect((await fs.stat(filePath)).isDirectory()).toBe(true);
  });

  it("rejects malformed requests without writing or emitting", async () => {
    await service.start();
    const listener = jest.fn();
    service.on("updated", listener);
    await expect(service.update({ ...updateFor(), pinned: ["albums", "albums"] }))
      .rejects.toThrow(NavigationSettingsInputError);
    await expect(service.update({ ...updateFor(), expectedRevision: -1 }))
      .rejects.toThrow(NavigationSettingsInputError);
    expect(service.getSnapshot()).toEqual(DEFAULT_NAVIGATION_SETTINGS);
    expect(listener).not.toHaveBeenCalled();
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the maximum 64 unique public pages while retaining every built-in position", async () => {
    await service.start();
    const custom = Array.from({ length: 64 }, (_, index) => publicId([{ title: `Collection ${index}` }]));
    const saved = await service.update({ expectedRevision: 0,
      order: [...DEFAULT_NAVIGATION_SETTINGS.order, ...custom], pinned: custom });
    expect(saved.order).toHaveLength(DEFAULT_NAVIGATION_SETTINGS.order.length + 64);
    expect(saved.pinned).toEqual(custom);
    const restarted = new NavigationSettingsService(logger, { filePath });
    await restarted.start();
    expect(restarted.getSnapshot()).toEqual(saved);
  });

  it.each([
    ["malformed URI encoding", "public:%ZZ"],
    ["invalid JSON", "public:%7Bbroken"],
    ["missing path", publicId([])],
    ["non-array path", publicId({ title: "Qobuz" })],
    ["path deeper than two segments", publicId([{ title: "Library" }, { title: "Qobuz" }, { title: "Albums" }])],
    ["missing title", publicId([{ subtitle: "Qobuz" }])],
    ["blank title", publicId([{ title: "   " }])],
    ["oversized title", publicId([{ title: "a".repeat(257) }])],
    ["oversized subtitle", publicId([{ title: "Qobuz", subtitle: "a".repeat(257) }])],
    ["oversized item type", publicId([{ title: "Qobuz", itemType: "a".repeat(65) }])],
    ["oversized encoded ID", publicId([{ title: "漢".repeat(256), subtitle: "漢".repeat(256) }])],
    ["live item key", publicId([{ title: "Qobuz", itemKey: "unstable-session-key" }])],
    ["action-bearing path", publicId([{ title: "Qobuz", action: "play" }])],
    ["prototype-shaped property", `public:${encodeURIComponent('[{"title":"Qobuz","__proto__":{"polluted":true}}]')}`],
    ["noncanonical key order", publicId([{ subtitle: "Saved", title: "Qobuz" }])],
  ])("rejects a public ID with %s without writing or broadcasting", async (_description, id) => {
    await service.start();
    const listener = jest.fn();
    service.on("updated", listener);
    await expect(service.update({ ...updateFor(),
      order: [...DEFAULT_NAVIGATION_SETTINGS.order, id], pinned: [id] }))
      .rejects.toThrow(NavigationSettingsInputError);
    expect(service.getSnapshot()).toEqual(DEFAULT_NAVIGATION_SETTINGS);
    expect(listener).not.toHaveBeenCalled();
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing built-ins, duplicate or excess public pages, and pins absent from order", async () => {
    await service.start();
    const custom = publicId([{ title: "Qobuz" }]);
    const invalid = [
      { order: [...DEFAULT_NAVIGATION_SETTINGS.order.slice(1), custom], pinned: [custom] },
      { order: [...DEFAULT_NAVIGATION_SETTINGS.order, custom, custom], pinned: [custom] },
      { order: DEFAULT_NAVIGATION_SETTINGS.order, pinned: [custom] },
      { order: [...DEFAULT_NAVIGATION_SETTINGS.order, ...Array.from({ length: 65 },
        (_, index) => publicId([{ title: `Collection ${index}` }]))], pinned: [] },
    ];
    const listener = jest.fn();
    service.on("updated", listener);
    for (const choices of invalid) {
      await expect(service.update({ expectedRevision: 0, ...choices }))
        .rejects.toThrow(NavigationSettingsInputError);
    }
    expect(service.getSnapshot()).toEqual(DEFAULT_NAVIGATION_SETTINGS);
    expect(listener).not.toHaveBeenCalled();
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a malformed public destination on disk and reports unavailable instead of resetting it", async () => {
    const badId = publicId([{ title: "Qobuz", itemKey: "expired-key" }]);
    const contents = JSON.stringify({ ...DEFAULT_NAVIGATION_SETTINGS, revision: 12,
      order: [...DEFAULT_NAVIGATION_SETTINGS.order, badId], pinned: [badId] });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
    await service.start();
    expect(() => service.getSnapshot()).toThrow(NavigationSettingsUnavailableError);
    await expect(service.update(updateFor(12))).rejects.toThrow(NavigationSettingsUnavailableError);
    expect(await fs.readFile(filePath, "utf-8")).toBe(contents);
  });

  it("treats an unchanged save as a no-op while still enforcing its expected revision", async () => {
    await service.start();
    const listener = jest.fn();
    service.on("updated", listener);
    const unchanged = {
      expectedRevision: 0,
      order: DEFAULT_NAVIGATION_SETTINGS.order,
      pinned: DEFAULT_NAVIGATION_SETTINGS.pinned,
    };
    expect(await service.update(unchanged)).toEqual(DEFAULT_NAVIGATION_SETTINGS);
    expect(listener).not.toHaveBeenCalled();
    await expect(service.update({ ...unchanged, expectedRevision: 1 }))
      .rejects.toThrow(NavigationSettingsConflictError);
  });

  it("copies caller-owned input and snapshots so local mutation cannot alter persisted preferences", async () => {
    await service.start();
    const input = { ...updateFor(), order: [...updateFor().order], pinned: [...updateFor().pinned] };
    const pending = service.update(input);
    input.order.reverse();
    input.pinned.length = 0;
    const saved = await pending;
    expect(saved.order).toEqual(updateFor().order);
    expect(saved.pinned).toEqual(updateFor().pinned);
    (saved.pinned as string[]).length = 0;
    expect(service.getSnapshot().pinned).toEqual(updateFor().pinned);
  });
});
