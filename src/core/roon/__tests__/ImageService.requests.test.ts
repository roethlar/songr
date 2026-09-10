import { EventEmitter } from "events";
import fs from "fs";
import { Logger } from "pino";
import { ImageService, ImageScale } from "../ImageService";
import { RoonClient } from "../RoonClient";

type ImageResult = { data: Buffer; contentType: string };
type Callback = (error: unknown, contentType?: string, data?: Buffer) => void;
type ImageArguments = [string, ImageScale?, number?, number?, AbortSignal?];

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;

describe("ImageService raw Core request admission", () => {
  let callbacks: Array<{ key: string; callback: Callback }>;
  let api: { get_image: jest.Mock };
  let client: EventEmitter & { getImage: jest.Mock };
  let service: ImageService;

  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const request = (...args: ImageArguments): Promise<ImageResult | Error> =>
    (service.getImage as (...args: ImageArguments) => Promise<ImageResult>)(...args).catch((error: Error) => error);
  const succeed = (index: number, bytes = "image") => callbacks[index].callback(null, "image/png", Buffer.from(bytes));

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    jest.spyOn(fs.promises, "readdir").mockResolvedValue([]);
    jest.spyOn(fs.promises, "readFile").mockRejectedValue(new Error("ENOENT"));
    jest.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);
    jest.spyOn(fs.promises, "utimes").mockResolvedValue(undefined);
    callbacks = [];
    api = { get_image: jest.fn((key: string, _options: unknown, callback: Callback) => callbacks.push({ key, callback })) };
    client = Object.assign(new EventEmitter(), { getImage: jest.fn().mockReturnValue(api) });
    service = new ImageService(client as unknown as RoonClient, logger, "/private/tmp/songr-image-admission-unit");
    service.start();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("starts only four raw calls and admits the fifth after actual settlement", async () => {
    const pending = Array.from({ length: 5 }, (_, i) => request("key-" + i));
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(4);
    succeed(0);
    await pending[0];
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(5);
    expect(callbacks[4].key).toBe("key-4");
  });

  it("retains raw slots and deduplication after every HTTP waiter times out", async () => {
    const initial = Array.from({ length: 4 }, (_, i) => request("key-" + i));
    await flush();
    await jest.advanceTimersByTimeAsync(15_000);
    for (const result of await Promise.all(initial)) expect(result).toMatchObject({ code: "OPERATION_TIMEOUT" });
    const duplicate = request("key-0");
    void request("later-key");
    service.start(); // Repeated lifecycle notification with the same API is not a reset.
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(4);
    succeed(0, "late");
    expect(await duplicate).toMatchObject({ data: Buffer.from("late") });
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(5);
    expect(callbacks[4].key).toBe("later-key");
  });

  it("caches a late success even when its last waiter already timed out", async () => {
    const initial = request("late-key");
    await flush();
    await jest.advanceTimersByTimeAsync(15_000);
    expect(await initial).toMatchObject({ code: "OPERATION_TIMEOUT" });
    succeed(0, "late-cache");
    await flush();
    const cached = request("late-key");
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(1);
    expect(await cached).toMatchObject({ data: Buffer.from("late-cache") });
    expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.any(String), Buffer.from("late-cache"));
  });

  it("deduplicates identical requests while preserving different image dimensions", async () => {
    const one = request("cover", "fit", 256, 256);
    const two = request("cover", "fit", 256, 256);
    const other = request("cover", "fit", 512, 512);
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(2);
    succeed(0, "small");
    succeed(1, "large");
    expect(await one).toMatchObject({ data: Buffer.from("small") });
    expect(await two).toMatchObject({ data: Buffer.from("small") });
    expect(await other).toMatchObject({ data: Buffer.from("large") });
  });

  it("drops an abandoned queued image without releasing a started raw call", async () => {
    const activeAbort = new AbortController();
    const active = request("active-0", undefined, undefined, undefined, activeAbort.signal);
    for (let i = 1; i < 4; i++) void request("active-" + i);
    const queuedAbort = new AbortController();
    const queued = request("abandoned", undefined, undefined, undefined, queuedAbort.signal);
    await flush();
    queuedAbort.abort();
    activeAbort.abort();
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(4);
    expect(await queued).toMatchObject({ name: "AbortError" });
    expect(await active).toMatchObject({ name: "AbortError" });
    succeed(0);
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(4);
    void request("abandoned");
    await flush();
    expect(callbacks[4].key).toBe("abandoned");
  });

  it("expires queued waiters so a late free slot cannot fetch stale images", async () => {
    for (let i = 0; i < 4; i++) void request("active-" + i);
    const queued = request("stale");
    await flush();
    await jest.advanceTimersByTimeAsync(15_000);
    expect(await queued).toMatchObject({ code: "OPERATION_TIMEOUT" });
    succeed(0);
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(4);
  });

  it("bounds queued distinct misses at 32 and still permits an existing-key join", async () => {
    for (let i = 0; i < 36; i++) void request("key-" + i);
    await flush();
    const overflow = request("overflow");
    const joined = request("key-4");
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(4);
    expect(await overflow).toMatchObject({ code: "IMAGE_QUEUE_FULL", statusCode: 503 });
    succeed(0);
    await flush();
    succeed(4, "joined");
    expect(await joined).toMatchObject({ data: Buffer.from("joined") });
  });

  it("retires old work on service identity change without letting late callbacks alter the new pool", async () => {
    const old = Array.from({ length: 5 }, (_, i) => request("old-" + i));
    await flush();
    const replacementCalls: Array<{ key: string; callback: Callback }> = [];
    const replacement = { get_image: jest.fn((key: string, _opts: unknown, callback: Callback) => replacementCalls.push({ key, callback })) };
    client.getImage.mockReturnValue(replacement);
    service.start();
    for (let i = 0; i < 4; i++) void request("new-" + i);
    await flush();
    expect(replacement.get_image).toHaveBeenCalledTimes(4);
    for (const result of await Promise.all(old)) expect(result).toMatchObject({ code: "CORE_UNPAIRED" });
    succeed(0, "obsolete");
    void request("old-0");
    await flush();
    expect(replacement.get_image).toHaveBeenCalledTimes(4);
    replacementCalls[0].callback(null, "image/png", Buffer.from("new"));
    await flush();
    expect(replacement.get_image).toHaveBeenCalledTimes(5);
    expect(replacementCalls[4].key).toBe("old-0");
    expect(fs.promises.writeFile).not.toHaveBeenCalledWith(expect.any(String), Buffer.from("obsolete"));
  });

  it("rejects queued waiters immediately on actual unpair", async () => {
    const pending = Array.from({ length: 5 }, (_, i) => request("key-" + i));
    await flush();
    client.getImage.mockReturnValue(null);
    client.emit("core-status", { coreStatus: "unpaired" });
    await flush();
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ code: "CORE_UNPAIRED" });
    for (const item of callbacks) item.callback("NetworkError");
    expect(api.get_image).toHaveBeenCalledTimes(4);
  });
  it("keeps a queued shared image when only one of its waiters cancels", async () => {
    for (let i = 0; i < 4; i++) void request("active-" + i);
    const controller = new AbortController();
    const abandoned = request("shared", undefined, undefined, undefined, controller.signal);
    const remaining = request("shared");
    await flush();
    controller.abort();
    expect(await abandoned).toMatchObject({ name: "AbortError" });
    succeed(0);
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(5);
    expect(callbacks[4].key).toBe("shared");
    succeed(4, "shared-bytes");
    expect(await remaining).toMatchObject({ data: Buffer.from("shared-bytes") });
  });

  it("releases one raw slot on failure and ignores a duplicate callback", async () => {
    const pending = Array.from({ length: 6 }, (_, i) => request("key-" + i));
    await flush();
    callbacks[0].callback("NetworkError");
    expect(await pending[0]).toMatchObject({ code: "OPERATION_FAILED" });
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(5);
    callbacks[0].callback("NetworkError");
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(5);
    succeed(1);
    await flush();
    expect(api.get_image).toHaveBeenCalledTimes(6);
  });});