import express from "express";
import http from "http";
import { AddressInfo } from "net";

import type { RoonClient } from "../../../../core/roon/RoonClient";
import type { OnboardingStatusResponse } from "../../../../shared/types";
import { createOnboardingRouter } from "../onboarding";

function stubClient(hasEverPaired: () => boolean): RoonClient {
  return { hasEverPaired } as unknown as RoonClient;
}

async function serve(
  client: RoonClient,
  readHostname?: () => string
): Promise<{ url: string; close(): Promise<void> }> {
  const app = express();
  app.use("/api/onboarding", createOnboardingRouter(client, readHostname));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function get(
  client: RoonClient,
  readHostname?: () => string
): Promise<{ response: Response; body: OnboardingStatusResponse }> {
  const app = await serve(client, readHostname);
  try {
    const response = await fetch(`${app.url}/api/onboarding`);
    const body = (await response.json()) as OnboardingStatusResponse;
    return { response, body };
  } finally {
    await app.close();
  }
}

describe("GET /api/onboarding", () => {
  it("reports a never-paired install so the first-run flow can show itself", async () => {
    const { response, body } = await get(
      stubClient(() => false),
      () => "studio-desk"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ everPaired: false, hostname: "studio-desk" });
  });

  it("reports everPaired for an install that has paired before", async () => {
    const { body } = await get(
      stubClient(() => true),
      () => "studio-desk"
    );

    expect(body.everPaired).toBe(true);
  });

  it("trims the hostname so it can be compared to zone names verbatim", async () => {
    const { body } = await get(
      stubClient(() => false),
      () => "  studio-desk\n"
    );

    expect(body.hostname).toBe("studio-desk");
  });

  it("answers with an empty hostname rather than failing when the lookup throws", async () => {
    const { response, body } = await get(
      stubClient(() => false),
      () => {
        throw new Error("no hostname on this platform");
      }
    );

    expect(response.status).toBe(200);
    expect(body).toEqual({ everPaired: false, hostname: "" });
  });
});
