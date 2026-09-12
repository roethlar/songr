import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { createHttpApp } from "../../http/app";
import { ReleaseUpdateService } from "../../../core/updates/ReleaseUpdateService";
import type { RoonClient } from "../../../core/roon/RoonClient";
import type { TransportService } from "../../../core/roon/TransportService";
import type { ImageService } from "../../../core/roon/ImageService";
import type { RecentlyPlayedService } from "../../../core/recently-played/RecentlyPlayedService";
import type { FavoritesService } from "../../../core/favorites/FavoritesService";

describe("connected server update HTTP API", () => {
  let server: http.Server;
  let url: string;
  let upstream: jest.MockedFunction<typeof fetch>;

  beforeEach(async () => {
    upstream = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    const service = new ReleaseUpdateService({ version: "1.4.3", fetch: upstream });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
    const app = createHttpApp(
      {} as RoonClient, {} as TransportService, {} as ImageService,
      {} as RecentlyPlayedService, {} as FavoritesService, logger,
      undefined, undefined, undefined, service,
    );
    server = http.createServer(app);
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/updates`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
  });

  it("reports installed server metadata without contacting GitHub or needing a Core", async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ currentVersion: "1.4.3" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("ignores client destinations and versions, returning only the checked server release", async () => {
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ tag_name: "v1.4.2", draft: false, prerelease: false })));
    const response = await fetch(`${url}/check?url=http://127.0.0.1/private`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentVersion: "0.0.1", url: "https://untrusted.example", desktopVersion: "0.0.1" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ currentVersion: "1.4.3", status: "ahead", latestVersion: "1.4.2" });
    expect(upstream.mock.calls[0][0]).toBe("https://api.github.com/repos/roethlar/songr/releases/latest");
    expect(upstream.mock.calls[0][1]?.body).toBeUndefined();
  });

  it("returns an unavailable result with HTTP 503 and rate-limit retry time", async () => {
    upstream.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    const response = await fetch(`${url}/check`, { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      currentVersion: "1.4.3", status: "unavailable", latestVersion: null, releaseUrl: null, retryAt: expect.any(String),
    });
  });

  it("keeps no published release distinct from a failed check", async () => {
    upstream.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const response = await fetch(`${url}/check`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "no-release", latestVersion: null });
  });
});
