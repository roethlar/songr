import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { RoonClient } from "../RoonClient";

jest.mock("ws", () => {
  return class MockWebSocket {
    static instances: MockWebSocket[] = [];
    on = jest.fn();
    send = jest.fn();
    close = jest.fn();
    onopen!: () => void;
    onclose!: () => void;
    onmessage!: (event: { data: Buffer }) => void;

    constructor(readonly url: string) {
      MockWebSocket.instances.push(this);
    }
  };
});

interface MockSocket {
  readonly url: string;
  onopen(): void;
  onclose(): void;
  onmessage(event: { data: Buffer }): void;
  send: jest.Mock;
  close: jest.Mock;
}

function reply(socket: MockSocket, requestId: number, name: string, body: object, verb = "COMPLETE"): void {
  const json = JSON.stringify(body);
  socket.onmessage({ data: Buffer.from(
    `MOO/1 ${verb} ${name}\nRequest-Id: ${requestId}\nContent-Type: application/json\nContent-Length: ${Buffer.byteLength(json)}\n\n${json}`,
  ) });
}

function identify(socket: MockSocket, coreId: string): unknown {
  socket.onopen();
  reply(socket, 0, "Success", { core_id: coreId, display_name: "Studio Core" });
  const registration = String(socket.send.mock.calls[1][0]);
  return JSON.parse(registration.split("\n\n")[1]);
}

function approve(socket: MockSocket, coreId: string, token: string): void {
  reply(socket, 1, "Registered", {
    core_id: coreId,
    display_name: "Studio Core",
    display_version: "2.0",
    provided_services: [],
    token,
  }, "CONTINUE");
}

it("authorizes and reconnects to the configured Core without opening discovery sockets", () => {
  jest.useFakeTimers();
  const { instances: sockets } = jest.requireMock("ws") as { instances: MockSocket[] };
  const udp = jest.spyOn(dgram, "createSocket");
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "songr-routed-core-"));
  const tokenPath = path.join(directory, "roon-token.json");
  const client = new RoonClient({
    coreAddress: { host: "core.example.net", port: 9444 },
    tokenPath,
    logger: pino({ level: "silent" }),
  });

  try {
    client.start();
    expect(sockets.map((socket) => socket.url)).toEqual(["ws://core.example.net:9444/api"]);
    expect(udp).not.toHaveBeenCalled();

    // A Core that is offline at startup must recover without any UDP traffic.
    sockets[0].onclose();
    jest.runOnlyPendingTimers();
    expect(sockets).toHaveLength(2);
    expect(identify(sockets[1], "core-a")).not.toHaveProperty("token");
    expect(client.getDiscoveryStatus().cores[0]?.phase).toBe("awaiting-approval");
    expect(client.getCoreStatus()).toBe("discovering");
    approve(sockets[1], "core-a", "token-a");
    expect(client.getCoreInfo()?.id).toBe("core-a");
    expect(() => client.switchCore()).toThrow("ROON_CORE_HOST");

    sockets[1].onclose();
    expect(client.getCoreStatus()).toBe("unpaired");
    jest.runOnlyPendingTimers();
    expect(identify(sockets[2], "core-a")).toHaveProperty("token", "token-a");
    approve(sockets[2], "core-a", "token-a");
    expect(client.getCoreInfo()?.id).toBe("core-a");

    // The same hostname can later serve a different Core. Its registration
    // must neither inherit the old token nor remain paired to the old Core.
    sockets[2].onclose();
    jest.runOnlyPendingTimers();
    expect(identify(sockets[3], "core-b")).not.toHaveProperty("token");
    approve(sockets[3], "core-b", "token-b");
    expect(client.getCoreInfo()?.id).toBe("core-b");
    expect(udp).not.toHaveBeenCalled();

    sockets[3].onclose();
    client.stop();
    jest.runOnlyPendingTimers();
    expect(sockets).toHaveLength(4);
  } finally {
    client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
    log.mockRestore();
    udp.mockRestore();
    jest.useRealTimers();
  }
});
