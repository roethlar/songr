import http from "http";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import type { AddressInfo } from "net";
import type { Logger } from "pino";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { createHttpApp } from "../../http/app";
import { registerPresentationSettingsBroadcast } from "../presentationSettings";
import { PresentationSettingsService } from "../../../core/presentation/PresentationSettingsService";
import type { RoonClient } from "../../../core/roon/RoonClient";
import type { TransportService } from "../../../core/roon/TransportService";
import type { ImageService } from "../../../core/roon/ImageService";
import type { RecentlyPlayedService } from "../../../core/recently-played/RecentlyPlayedService";
import type { FavoritesService } from "../../../core/favorites/FavoritesService";
import {
  DEFAULT_PRESENTATION_SETTINGS,
  PRESENTATION_SETTINGS_EVENT,
  type PresentationSettingsSnapshot,
} from "../../../shared/presentationSettings";


const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
const update = (expectedRevision = 0) => ({
  expectedRevision,
  actionDisplay: "both", smoothScroll: false, interfaceMotion: false,
});

function event<T>(socket: Socket, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`Timed out waiting for ${name}`)); }, 2000);
    socket.once(name, (value: T) => { clearTimeout(timer); resolve(value); });
  });
}

describe("server-owned presentation settings HTTP and broadcasts", () => {
  let directory: string;
  let filePath: string;
  let service: PresentationSettingsService;
  let server: http.Server;
  let io: Server;
  let url: string;
  let unregister: () => void;
  const clients: Socket[] = [];

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "songr-presentation-http-"));
    filePath = path.join(directory, "presentation-preferences.json");
    service = new PresentationSettingsService(logger, { filePath });
    await service.start();
    // Use the production HTTP app: proves registration precedes its API 404 and
    // needs no Core pairing, playback service, or desktop-specific machinery.
    const app = createHttpApp(
      {} as RoonClient,
      {} as TransportService,
      {} as ImageService,
      {} as RecentlyPlayedService,
      {} as FavoritesService,
      logger,
      undefined,
      undefined,
      service
    );
    server = http.createServer(app);
    io = new Server(server);
    unregister = registerPresentationSettingsBroadcast(service, io);
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings/presentation`;
  });

  afterEach(async () => {
    clients.splice(0).forEach((client) => { client.disconnect(); });
    unregister();
    await new Promise<void>((resolve) => { io.close(() => { resolve(); }); });
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const put = (body: unknown) => fetch(url, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  async function client(): Promise<Socket> {
    const socket = connect(new URL(url).origin, {
      autoConnect: false, transports: ["websocket"], forceNew: true, reconnection: false,
    });
    clients.push(socket);
    const connected = event<void>(socket, "connect");
    socket.connect();
    await connected;
    return socket;
  }

  it("shares one persisted update with two live clients and hydrates a newly opened client", async () => {
    const first = await client();
    const second = await client();
    const firstInitial = await (await fetch(url)).json();
    const secondInitial = await (await fetch(url)).json();
    expect(firstInitial).toEqual(DEFAULT_PRESENTATION_SETTINGS);
    expect(secondInitial).toEqual(firstInitial);
    const firstUpdate = event<PresentationSettingsSnapshot>(first, PRESENTATION_SETTINGS_EVENT);
    const secondUpdate = event<PresentationSettingsSnapshot>(second, PRESENTATION_SETTINGS_EVENT);
    const response = await put(update());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const committed = await response.json();
    expect(await firstUpdate).toEqual(committed);
    expect(await secondUpdate).toEqual(committed);
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(committed);
    await client();
    const fresh = await fetch(url);
    expect(fresh.headers.get("cache-control")).toBe("no-store");
    expect(await fresh.json()).toEqual(committed);
  });


  it("returns conflicts and invalid input without replacing the current committed snapshot", async () => {
    const committed = await (await put(update())).json();
    const stale = await put({ ...update(), actionDisplay: "text" });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ current: committed });
    const invalid = await put({ ...update(1), smoothScroll: "false" });
    expect(invalid.status).toBe(400);
    expect(await (await fetch(url)).json()).toEqual(committed);
  });
});
