import http from "http";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import type { AddressInfo } from "net";
import type { Logger } from "pino";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { createHttpApp } from "../../http/app";
import { registerNavigationSettingsBroadcast } from "../navigationSettings";
import { NavigationSettingsService } from "../../../core/navigation/NavigationSettingsService";
import type { RoonClient } from "../../../core/roon/RoonClient";
import type { TransportService } from "../../../core/roon/TransportService";
import type { ImageService } from "../../../core/roon/ImageService";
import type { RecentlyPlayedService } from "../../../core/recently-played/RecentlyPlayedService";
import type { FavoritesService } from "../../../core/favorites/FavoritesService";
import {
  DEFAULT_NAVIGATION_SETTINGS,
  NAVIGATION_SETTINGS_EVENT,
  type NavigationSettingsSnapshot,
} from "../../../shared/navigationSettings";

const publicId = (path: unknown): string => `public:${encodeURIComponent(JSON.stringify(path))}`;

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
const update = (expectedRevision = 0) => ({
  expectedRevision,
  order: [...DEFAULT_NAVIGATION_SETTINGS.order].reverse(),
  pinned: ["surprise", "recently-played"],
});

function event<T>(socket: Socket, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`Timed out waiting for ${name}`)); }, 2000);
    socket.once(name, (value: T) => { clearTimeout(timer); resolve(value); });
  });
}

describe("server-owned navigation settings HTTP and broadcasts", () => {
  let directory: string;
  let filePath: string;
  let service: NavigationSettingsService;
  let server: http.Server;
  let io: Server;
  let url: string;
  let unregister: () => void;
  const clients: Socket[] = [];

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "songr-navigation-http-"));
    filePath = path.join(directory, "navigation-preferences.json");
    service = new NavigationSettingsService(logger, { filePath });
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
      service
    );
    server = http.createServer(app);
    io = new Server(server);
    unregister = registerNavigationSettingsBroadcast(service, io);
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings/navigation`;
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
    expect(firstInitial).toEqual(DEFAULT_NAVIGATION_SETTINGS);
    expect(secondInitial).toEqual(firstInitial);
    const firstUpdate = event<NavigationSettingsSnapshot>(first, NAVIGATION_SETTINGS_EVENT);
    const secondUpdate = event<NavigationSettingsSnapshot>(second, NAVIGATION_SETTINGS_EVENT);
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

  it("shares a newly discovered public page and its position with both clients and the next HTTP reader", async () => {
    const first = await client();
    const second = await client();
    const id = publicId([{ title: "Library" }, { title: "My selections", subtitle: "Saved / 100% 🎵" }]);
    const input = { expectedRevision: 0,
      order: [id, ...DEFAULT_NAVIGATION_SETTINGS.order], pinned: [id, "albums"] };
    const firstUpdate = event<NavigationSettingsSnapshot>(first, NAVIGATION_SETTINGS_EVENT);
    const secondUpdate = event<NavigationSettingsSnapshot>(second, NAVIGATION_SETTINGS_EVENT);
    const [response, firstReceived, secondReceived] = await Promise.all([
      put(input), firstUpdate, secondUpdate,
    ]);
    expect(response.status).toBe(200);
    const committed = await response.json();
    expect(committed).toEqual({ version: 1, revision: 1, order: input.order, pinned: input.pinned });
    expect(firstReceived).toEqual(committed);
    expect(secondReceived).toEqual(committed);
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(committed);
    await client();
    expect(await (await fetch(url)).json()).toEqual(committed);
    const restarted = new NavigationSettingsService(logger, { filePath });
    await restarted.start();
    expect(restarted.getSnapshot()).toEqual(committed);
  });

  it.each([
    ["malformed encoding", { order: [...DEFAULT_NAVIGATION_SETTINGS.order, "public:%ZZ"], pinned: [] }],
    ["action-bearing identity", { order: [...DEFAULT_NAVIGATION_SETTINGS.order,
      publicId([{ title: "Qobuz", action: "play" }])], pinned: [] }],
    ["oversized identity", { order: [...DEFAULT_NAVIGATION_SETTINGS.order,
      publicId([{ title: "漢".repeat(256), subtitle: "漢".repeat(256) }])], pinned: [] }],
    ["pin absent from order", { order: DEFAULT_NAVIGATION_SETTINGS.order, pinned: [publicId([{ title: "Qobuz" }])] }],
    ["missing built-in", { order: [...DEFAULT_NAVIGATION_SETTINGS.order.slice(1),
      publicId([{ title: "Qobuz" }])], pinned: [] }],
  ])("returns 400 for %s and emits no public navigation change", async (_description, choices) => {
    const socket = await client();
    const received: unknown[] = [];
    socket.on(NAVIGATION_SETTINGS_EVENT, (snapshot: unknown) => { received.push(snapshot); });
    expect((await put({ expectedRevision: 0, ...choices })).status).toBe(400);
    expect(await (await fetch(url)).json()).toEqual(DEFAULT_NAVIGATION_SETTINGS);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    // Fence the stream with a successful save; no earlier rejected update may appear.
    const following = event<NavigationSettingsSnapshot>(socket, NAVIGATION_SETTINGS_EVENT);
    const response = await put(update());
    expect(response.status).toBe(200);
    const committed = await following;
    expect(received).toEqual([committed]);
    expect(committed.revision).toBe(1);
  });

  it("returns 409 and the current snapshot when two clients save the same revision", async () => {
    const results = await Promise.all([put(update()), put({ ...update(), pinned: [] })]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const committed = await results.find((result) => result.status === 200)!.json();
    const conflict = await results.find((result) => result.status === 409)!.json() as { current: unknown };
    expect(conflict.current).toEqual(committed);
    expect(await (await fetch(url)).json()).toEqual(committed);
  });

  it.each([
    null,
    { ...update(), unexpected: true },
    { ...update(), expectedRevision: -1 },
    { ...update(), expectedRevision: 0.5 },
    { ...update(), pinned: ["recent"] },
    { ...update(), pinned: ["artists", "artists"] },
    { ...update(), order: ["albums"] },
  ])("returns 400 for an invalid document without changing server state (%j)", async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(await (await fetch(url)).json()).toEqual(DEFAULT_NAVIGATION_SETTINGS);
  });

  it("returns 400 for malformed JSON through the existing application error handler", async () => {
    const response = await fetch(url, {
      method: "PUT", headers: { "content-type": "application/json" }, body: '{"expectedRevision":',
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBeTruthy();
  });

  it("returns 500 on write failure, broadcasts nothing, and retains the committed snapshot", async () => {
    const socket = await client();
    const received: unknown[] = [];
    socket.on(NAVIGATION_SETTINGS_EVENT, (snapshot: unknown) => { received.push(snapshot); });
    const initialBroadcast = event<NavigationSettingsSnapshot>(socket, NAVIGATION_SETTINGS_EVENT);
    const committed = await (await put(update())).json();
    await initialBroadcast;
    jest.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("ENOSPC"));
    const failure = await put({ ...update(1), pinned: [] });
    expect(failure.status).toBe(500);
    expect(await (await fetch(url)).json()).toEqual(committed);
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual(committed);
    // A later successful event is a stream fence for any failed-update event.
    const following = event<NavigationSettingsSnapshot>(socket, NAVIGATION_SETTINGS_EVENT);
    const next = await put({ ...update(1), pinned: [] });
    expect(next.status).toBe(200);
    const nextSnapshot = await following;
    expect(received).toEqual([committed, nextSnapshot]);
    expect(nextSnapshot.revision).toBe(2);
  });

  it("reports corrupt persisted data as 503 on GET and PUT without clobbering it", async () => {
    await fs.writeFile(filePath, "{corrupt");
    const degraded = new NavigationSettingsService(logger, { filePath });
    await degraded.start();
    // The startup-loaded service is used by both handlers; replace only this
    // fixture's method bindings to exercise the same production route instance.
    jest.spyOn(service, "getSnapshot").mockImplementation(() => degraded.getSnapshot());
    jest.spyOn(service, "update").mockImplementation((value) => degraded.update(value));
    expect((await fetch(url)).status).toBe(503);
    expect((await put(update())).status).toBe(503);
    expect(await fs.readFile(filePath, "utf-8")).toBe("{corrupt");
  });
});
