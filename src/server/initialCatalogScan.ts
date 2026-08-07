import type { Logger } from "pino";

/**
 * The first catalog scan of a build that carries no extended feature layer.
 *
 * When the layer is installed, IT owns every refresh trigger: the on-pair
 * pull, the schedule, and the explicit POST. A build without the layer had
 * no trigger at all — `CatalogService.start()` only loads persisted state —
 * so a fresh install paired, showed "the catalog prepares", and stayed
 * empty forever unless someone hand-POSTed `/api/catalog/refresh`
 * (public issue #1, reported from a fresh 1.1.0 Docker install).
 *
 * This trigger fires on pair, exactly when nothing else owns refresh and
 * the catalog for that Core has never been built. It stays out of the way
 * everywhere else: an installed layer skips it entirely (the private
 * build's first-boot behavior is unchanged), a non-empty catalog skips it
 * (restart of a working install), degraded persistence skips it (the same
 * refusal the explicit POST makes), and the scan itself is per-Core
 * single-flight inside CatalogService, so repeated pair events coalesce.
 */

export type InitialScanOutcome =
  | "skipped-layer-installed"
  | "skipped-core-changed"
  | "skipped-not-empty"
  | "skipped-persistence-degraded"
  | "start-failed"
  | "started";

export interface InitialCatalogScanDeps {
  /** Whether a real extended feature layer is loaded (it owns refresh). */
  readonly featureLayerInstalled: boolean;
  /** `CatalogService.start` — idempotent persisted-state load. */
  start(coreId: string): Promise<void>;
  /** The Core paired RIGHT NOW, for the post-await re-check. */
  currentCoreId(): string | null;
  /** The freshness + persistence the status endpoint reports. */
  status(coreId: string): { freshness: string; persistence: string };
  /** `CatalogService.scan` — per-Core single-flight. */
  scan(coreId: string): Promise<unknown>;
  readonly logger: Logger;
}

export async function ensureInitialCatalogScan(
  deps: InitialCatalogScanDeps,
  coreId: string
): Promise<InitialScanOutcome> {
  if (deps.featureLayerInstalled) {
    return "skipped-layer-installed";
  }

  try {
    await deps.start(coreId);
  } catch (error) {
    deps.logger.warn(
      { err: error, coreId },
      "Initial catalog scan skipped: persisted-state startup failed"
    );
    return "start-failed";
  }

  // The pair-event guard in the caller ran BEFORE the await above; a Core
  // switch during the awaited start would otherwise scan under a stale id.
  // The explicit POST closes the same window with assertCurrentCore after
  // its own identical await (dt9-1) — mirror it.
  if (deps.currentCoreId() !== coreId) {
    deps.logger.warn(
      { coreId, currentCoreId: deps.currentCoreId() },
      "Initial catalog scan skipped: the paired Core changed during startup"
    );
    return "skipped-core-changed";
  }

  const status = deps.status(coreId);
  if (status.freshness !== "empty") {
    return "skipped-not-empty";
  }
  if (status.persistence === "degraded") {
    deps.logger.warn(
      { coreId },
      "Initial catalog scan skipped: catalog persistence is degraded"
    );
    return "skipped-persistence-degraded";
  }

  deps.logger.info(
    { coreId },
    "No extended feature layer and no catalog yet; starting the first scan"
  );
  void deps.scan(coreId).catch((error) => {
    deps.logger.warn(
      { err: error, coreId },
      "Initial catalog scan failed in background"
    );
  });
  return "started";
}

