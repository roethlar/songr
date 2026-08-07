import { ensureInitialCatalogScan } from "../initialCatalogScan";
import type { InitialCatalogScanDeps } from "../initialCatalogScan";
import type { Logger } from "pino";

const fakeLogger = (): Logger =>
  ({ info: jest.fn(), warn: jest.fn() } as unknown as Logger);

function deps(
  overrides: Partial<InitialCatalogScanDeps> = {}
): InitialCatalogScanDeps & { scan: jest.Mock } {
  const scan = jest.fn().mockResolvedValue({ outcome: "published" });
  return {
    featureLayerInstalled: false,
    start: jest.fn().mockResolvedValue(undefined),
    currentCoreId: jest.fn().mockReturnValue("core-1"),
    status: jest.fn().mockReturnValue({
      freshness: "empty",
      persistence: "healthy",
    }),
    scan,
    logger: fakeLogger(),
    ...overrides,
  } as InitialCatalogScanDeps & { scan: jest.Mock };
}

describe("ensureInitialCatalogScan (public issue #1)", () => {
  it("fires the first scan on a fresh install with no feature layer", async () => {
    const d = deps();
    await expect(ensureInitialCatalogScan(d, "core-1")).resolves.toBe(
      "started"
    );
    expect(d.scan).toHaveBeenCalledWith("core-1");
  });

  it("never scans when an installed layer owns refresh", async () => {
    // The private build's first-boot behavior must be untouched: its layer
    // already fires the on-pair pull, and a second trigger here would feed
    // the recorded first-boot thundering herd.
    const d = deps({ featureLayerInstalled: true });
    await expect(ensureInitialCatalogScan(d, "core-1")).resolves.toBe(
      "skipped-layer-installed"
    );
    expect(d.scan).not.toHaveBeenCalled();
  });

  it("never scans a Core that unpaired during the awaited startup (dt9-1)", async () => {
    // The caller's pair-event guard runs before start() is awaited; a Core
    // switch inside that window must be caught by the post-await re-check,
    // exactly as the explicit POST's assertCurrentCore does.
    const d = deps({ currentCoreId: jest.fn().mockReturnValue("core-2") });
    await expect(ensureInitialCatalogScan(d, "core-1")).resolves.toBe(
      "skipped-core-changed"
    );
    expect(d.scan).not.toHaveBeenCalled();
  });

  it("leaves a working install's catalog alone on restart", async () => {
    const d = deps({
      status: () => ({ freshness: "fresh", persistence: "healthy" }),
    });
    await expect(ensureInitialCatalogScan(d, "core-1")).resolves.toBe(
      "skipped-not-empty"
    );
    expect(d.scan).not.toHaveBeenCalled();
  });

  it("refuses to scan into degraded persistence, like the explicit POST", async () => {
    const d = deps({
      status: () => ({ freshness: "empty", persistence: "degraded" }),
    });
    await expect(ensureInitialCatalogScan(d, "core-1")).resolves.toBe(
      "skipped-persistence-degraded"
    );
    expect(d.scan).not.toHaveBeenCalled();
  });

  it("reports a failed persisted-state startup instead of scanning blind", async () => {
    const d = deps({
      start: jest.fn().mockRejectedValue(new Error("corrupt snapshot")),
    });
    await expect(ensureInitialCatalogScan(d, "core-1")).resolves.toBe(
      "start-failed"
    );
    expect(d.scan).not.toHaveBeenCalled();
  });

  it("survives a scan that fails in the background", async () => {
    const d = deps({
      scan: jest.fn().mockRejectedValue(new Error("core went away")),
    });
    await expect(ensureInitialCatalogScan(d, "core-1")).resolves.toBe(
      "started"
    );
    // The rejection is logged, never thrown: pairing must not be disturbed.
    await new Promise((resolve) => setImmediate(resolve));
    expect(d.logger.warn).toHaveBeenCalled();
  });
});
