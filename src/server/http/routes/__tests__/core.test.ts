import express from "express";
import http from "http";
import { AddressInfo } from "net";

import type { RoonClient } from "../../../../core/roon/RoonClient";
import type {
  CoreStatusResponse,
  CoreSwitchResponse,
  ErrorResponse,
} from "../../../../shared/types";
import { createCoreRouter } from "../core";

interface CoreClientStub {
  readonly client: RoonClient;
  readonly switchCore: jest.Mock<boolean, []>;
}

function stubClient(): CoreClientStub {
  const switchCore = jest.fn(() => true);
  return {
    client: {
      getCoreStatus: () => "paired",
      getCoreInfo: () => ({
        id: "core-a",
        displayName: "Core A",
        displayVersion: "2.0",
      }),
      switchCore,
    } as unknown as RoonClient,
    switchCore,
  };
}

async function serve(client: RoonClient): Promise<{ url: string; close(): Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use("/api/core", createCoreRouter(client));
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(500).json({ error: error.message } satisfies ErrorResponse);
    }
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function request(
  client: RoonClient,
  path = "",
  init?: RequestInit
): Promise<{ response: Response; body: unknown }> {
  const app = await serve(client);
  try {
    const response = await fetch(`${app.url}/api/core${path}`, init);
    return { response, body: await response.json() };
  } finally {
    await app.close();
  }
}

describe("core HTTP routes", () => {
  it("keeps reporting the current Core", async () => {
    const { client } = stubClient();
    const { response, body } = await request(client);

    expect(response.status).toBe(200);
    expect(body as CoreStatusResponse).toEqual({
      status: "paired",
      core: { id: "core-a", displayName: "Core A", displayVersion: "2.0" },
    });
  });

  it.each([
    ["a bodyless request", undefined],
    ["a false confirmation", { confirmed: false }],
    ["an extra field", { confirmed: true, coreId: "core-b" }],
  ])("rejects %s without touching pairing state", async (_label, body) => {
    const { client, switchCore } = stubClient();
    const { response } = await request(client, "/switch", {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });

    expect(response.status).toBe(400);
    expect(switchCore).not.toHaveBeenCalled();
  });

  it("accepts only the exact destructive confirmation", async () => {
    const { client, switchCore } = stubClient();
    const { response, body } = await request(client, "/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });

    expect(response.status).toBe(202);
    expect(body as CoreSwitchResponse).toEqual({ accepted: true, status: "discovering" });
    expect(switchCore).toHaveBeenCalledTimes(1);
  });

  it("never reports acceptance when the persisted-state transition fails", async () => {
    const { client, switchCore } = stubClient();
    switchCore.mockImplementation(() => {
      throw new Error("pairing state is not writable");
    });

    const { response, body } = await request(client, "/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "pairing state is not writable" });
  });
});
