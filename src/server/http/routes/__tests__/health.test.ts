import express from "express";
import http from "http";
import { AddressInfo } from "net";

import type { CatalogService } from "../../../../core/catalog/CatalogService";
import type { CatalogStatus } from "../../../../shared/timelineCatalogContracts";
import type { HealthResponse } from "../../../../shared/types";
import { createHealthRouter } from "../health";

const OBSERVED_AT = "2026-07-15T00:00:00.000Z";

const freshStatus = (): CatalogStatus => ({
  coreId: "core-a",
  freshness: "fresh",
  persistence: "healthy",
  refresh: "idle",
  available: true,
  complete: true,
  revision: 1,
  artistCount: 1,
  albumCount: 1,
  updatedAt: OBSERVED_AT,
  lastCompleteScanAt: OBSERVED_AT,
});

const degradedStatus = (): CatalogStatus => ({
  coreId: "core-a",
  freshness: "stale",
  staleReason: "persistence-failed",
  persistence: "degraded",
  refresh: "idle",
  available: true,
  complete: true,
  revision: 1,
  artistCount: 1,
  albumCount: 1,
  updatedAt: OBSERVED_AT,
  lastCompleteScanAt: OBSERVED_AT,
  lastProblem: {
    code: "PERSISTENCE_WRITE_FAILED",
    occurredAt: OBSERVED_AT,
  },
});

const emptyStatus = (): CatalogStatus => ({
  coreId: "core-a",
  freshness: "empty",
  persistence: "healthy",
  refresh: "idle",
  available: false,
  complete: false,
  revision: 0,
  artistCount: 0,
  albumCount: 0,
});

async function serve(
  catalogService: Pick<CatalogService, "getStatus">,
  getCoreId: () => string | null = () => "core-a"
): Promise<{ url: string; close(): Promise<void> }> {
  const app = express();
  app.use(createHealthRouter(undefined, undefined, catalogService, getCoreId));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function fetchHealth(
  status: CatalogStatus
): Promise<{ response: Response; body: HealthResponse }> {
  const app = await serve({ getStatus: () => status });
  try {
    const response = await fetch(`${app.url}/api/health`);
    const body = (await response.json()) as HealthResponse;
    return { response, body };
  } finally {
    await app.close();
  }
}

describe("catalog health diagnostics", () => {
  it("reports a stale degraded catalog without degrading Classic readiness", async () => {
    const { response, body } = await fetchHealth(degradedStatus());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.status).toBe("ok");
    expect(body.ready).toBe(true);
    expect(body.subsystems.catalog).toEqual({
      critical: false,
      ready: false,
      degraded: true,
      status: degradedStatus(),
    });
  });

  it("reports a complete fresh catalog as ready", async () => {
    const { response, body } = await fetchHealth(freshStatus());

    expect(response.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.subsystems.catalog).toEqual({
      critical: false,
      ready: true,
      degraded: false,
      status: freshStatus(),
    });
  });

  it("reports an empty catalog as not ready but not degraded", async () => {
    const { response, body } = await fetchHealth(emptyStatus());

    expect(response.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.subsystems.catalog).toEqual({
      critical: false,
      ready: false,
      degraded: false,
      status: emptyStatus(),
    });
  });

  it("reports a first failed scan as degraded without degrading Classic", async () => {
    const failed: CatalogStatus = {
      ...emptyStatus(),
      lastProblem: { code: "SCAN_FAILED", occurredAt: OBSERVED_AT },
    };
    const { response, body } = await fetchHealth(failed);

    expect(response.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.subsystems.catalog).toEqual({
      critical: false,
      ready: false,
      degraded: true,
      status: failed,
    });
  });

  it("omits catalog diagnostics when no Core is paired", async () => {
    const getStatus = jest.fn(() => freshStatus());
    const app = await serve({ getStatus }, () => null);
    try {
      const response = await fetch(`${app.url}/api/health`);
      const body = (await response.json()) as HealthResponse;

      expect(response.status).toBe(200);
      expect(body.ready).toBe(true);
      expect(body.subsystems.catalog).toBeUndefined();
      expect(getStatus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("omits diagnostics returned for a different Core", async () => {
    const app = await serve({
      getStatus: () => ({ ...freshStatus(), coreId: "core-b" }),
    });
    try {
      const response = await fetch(`${app.url}/api/health`);
      const body = (await response.json()) as HealthResponse;

      expect(response.status).toBe(200);
      expect(body.ready).toBe(true);
      expect(body.subsystems.catalog).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("contains a failing diagnostic and never leaks its error", async () => {
    const app = await serve({
      getStatus: () => {
        throw new Error("/private/secret/catalog.json");
      },
    });
    try {
      const response = await fetch(`${app.url}/api/health`);
      const body = (await response.json()) as HealthResponse;

      expect(response.status).toBe(200);
      expect(body.ready).toBe(true);
      expect(body.subsystems.catalog).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("/private/secret");
    } finally {
      await app.close();
    }
  });

  it("contains a failing diagnostic Core lookup", async () => {
    const app = await serve({ getStatus: () => freshStatus() }, () => {
      throw new Error("/private/secret/core-lookup.json");
    });
    try {
      const response = await fetch(`${app.url}/api/health`);
      const body = (await response.json()) as HealthResponse;

      expect(response.status).toBe(200);
      expect(body.ready).toBe(true);
      expect(body.subsystems.catalog).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("/private/secret");
    } finally {
      await app.close();
    }
  });
});
