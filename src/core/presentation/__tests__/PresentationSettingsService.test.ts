import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { Logger } from "pino";
import { PresentationSettingsService, PresentationSettingsConflictError, PresentationSettingsInputError,
  PresentationSettingsPersistenceError, PresentationSettingsUnavailableError } from "../PresentationSettingsService";
import { DEFAULT_PRESENTATION_SETTINGS, type PresentationSettingsUpdate } from "../../../shared/presentationSettings";
const logger = { warn: jest.fn(), error: jest.fn() } as unknown as Logger;
const input = (expectedRevision = 0): PresentationSettingsUpdate => ({ expectedRevision, actionDisplay: "both", smoothScroll: false, interfaceMotion: true });
describe("server presentation preferences", () => {
  let directory: string, filePath: string, service: PresentationSettingsService;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "songr-presentation-"));
    filePath = path.join(directory, "data", "presentation-preferences.json");
    service = new PresentationSettingsService(logger, { filePath });
  });
  afterEach(async () => { jest.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
  it("does not offer defaults before startup and persists all choices across restart", async () => {
    expect(() => service.getSnapshot()).toThrow(PresentationSettingsUnavailableError);
    await service.start(); expect(service.getSnapshot()).toEqual(DEFAULT_PRESENTATION_SETTINGS);
    const saved = await service.update(input());
    expect(saved).toEqual({ version: 1, revision: 1, actionDisplay: "both", smoothScroll: false, interfaceMotion: true });
    const restarted = new PresentationSettingsService(logger, { filePath }); await restarted.start();
    expect(restarted.getSnapshot()).toEqual(saved);
  });
  it("only publishes and broadcasts after the atomic file commit", async () => {
    await service.start(); const listener = jest.fn(); service.on("updated", listener);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rename = fs.rename.bind(fs);
    const entered = new Promise<void>(resolve => {
      jest.spyOn(fs, "rename").mockImplementation(async (from, to) => { resolve(); await gate; await rename(from, to); });
    });
    const pending = service.update(input()); await entered;
    expect(service.getSnapshot()).toEqual(DEFAULT_PRESENTATION_SETTINGS); expect(listener).not.toHaveBeenCalled();
    release(); const saved = await pending;
    expect(listener).toHaveBeenCalledWith(saved);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(saved);
  });
  it("retains committed choices and emits nothing when persistence fails", async () => {
    await service.start(); const saved = await service.update(input());
    const listener = jest.fn(); service.on("updated", listener);
    jest.spyOn(fs, "rename").mockRejectedValue(new Error("disk failure"));
    await expect(service.update({ ...input(1), interfaceMotion: false })).rejects.toThrow(PresentationSettingsPersistenceError);
    expect(service.getSnapshot()).toEqual(saved); expect(listener).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(saved);
  });
  it("serializes concurrent revisions so a stale client cannot replace another client's change", async () => {
    await service.start(); const first = service.update(input());
    const second = service.update({ ...input(), actionDisplay: "text" });
    await expect(first).resolves.toMatchObject({ revision: 1, actionDisplay: "both" });
    await expect(second).rejects.toThrow(PresentationSettingsConflictError);
    expect(service.getSnapshot().actionDisplay).toBe("both");
  });
  it.each([
    { ...input(), actionDisplay: "pictures" }, { ...input(), smoothScroll: "false" },
    { ...input(), interfaceMotion: 0 }, { ...input(), expectedRevision: -1 },
    { ...input(), expectedRevision: 1.5 }, { ...input(), selectionMode: "checkbox" },
    { expectedRevision: 0, actionDisplay: "icons", smoothScroll: true },
  ])("rejects invalid or extra fields without a save", async value => {
    await service.start(); const listener = jest.fn(); service.on("updated", listener);
    await expect(service.update(value)).rejects.toThrow(PresentationSettingsInputError);
    expect(service.getSnapshot()).toEqual(DEFAULT_PRESENTATION_SETTINGS); expect(listener).not.toHaveBeenCalled();
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves a corrupt file instead of silently resetting the user's choices", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, "invalid");
    await service.start(); expect(() => service.getSnapshot()).toThrow(PresentationSettingsUnavailableError);
    await expect(service.update(input())).rejects.toThrow(PresentationSettingsUnavailableError);
    expect(await fs.readFile(filePath, "utf8")).toBe("invalid");
  });
});
