import { ReadableStream } from "node:stream/web";
import { ReleaseUpdateService } from "../ReleaseUpdateService";

const START = Date.parse("2026-09-12T12:00:00Z");
const RELEASE_ENDPOINT = "https://api.github.com/repos/roethlar/songr/releases/latest";
const release = (tag = "v1.4.4", extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  tag_name: tag, draft: false, prerelease: false, html_url: "https://untrusted.example/release", ...extra,
}), { headers: { "content-type": "application/json" } });

describe("ReleaseUpdateService", () => {
  let upstream: jest.MockedFunction<typeof fetch>;
  let now: number;
  const service = (currentVersion = "1.4.3") => new ReleaseUpdateService({
    version: currentVersion, fetch: upstream, now: () => now,
  });

  beforeEach(() => {
    now = START;
    upstream = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    upstream.mockImplementation(async () => release());
  });

  afterEach(() => { jest.useRealTimers(); });

  it("reads the actual engine manifest without a GitHub request", () => {
    const installed = new ReleaseUpdateService({ fetch: upstream });
    expect(installed.getVersion()).toBe((require("../../../../package.json") as { version: string }).version);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["1.4.3", "v1.4.2", "ahead"],
    ["1.4.2", "v1.4.3", "update-available"],
    ["1.4.3", "v1.4.3", "current"],
    ["1.9.9", "1.10.0", "update-available"],
    ["1.10.0", "1.9.9", "ahead"],
    ["1.4.3-rc.1", "v1.4.3", "update-available"],
    ["1.4.4-rc.1", "v1.4.3", "ahead"],
    ["1.4.3+local.1", "v1.4.3+public.2", "current"],
    ["v1.4.3", "1.4.4", "update-available"],
  ])("compares installed %s with published %s as %s", async (installed, tag, status) => {
    upstream.mockResolvedValueOnce(release(tag));
    expect(await service(installed).check()).toMatchObject({ currentVersion: installed, status });
  });

  it("returns a trusted tag link and uses only the public endpoint without credentials", async () => {
    const result = await service().check();
    expect(result).toEqual({
      currentVersion: "1.4.3", latestVersion: "1.4.4", status: "update-available",
      releaseUrl: "https://github.com/roethlar/songr/releases/tag/v1.4.4",
      checkedAt: "2026-09-12T12:00:00.000Z",
    });
    expect(upstream).toHaveBeenCalledWith(RELEASE_ENDPOINT, {
      method: "GET", redirect: "error", credentials: "omit", signal: expect.any(AbortSignal),
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Songr-update-check" },
    });
  });

  it.each(["", "unknown", "1.4", "01.4.3", "1.4.3 ", "=1.4.3", "vv1.4.3"])(
    "does not claim an invalid installed version %p is current", async (installed) => {
      expect(await service(installed).check()).toMatchObject({
        currentVersion: installed, status: "unavailable", latestVersion: null, releaseUrl: null,
      });
      expect(upstream).not.toHaveBeenCalled();
    }
  );

  it.each([
    { tag_name: "1.4" }, { tag_name: "01.4.4" }, { tag_name: "v1.4.4-rc.1" },
    { tag_name: "../1.4.4" }, { tag_name: "v1.4.4\n" }, { tag_name: 144 },
    { draft: true }, { prerelease: true }, { draft: undefined }, { prerelease: "false" },
  ])("rejects invalid or non-stable metadata %p", async (metadata) => {
    upstream.mockResolvedValueOnce(release("v1.4.4", metadata));
    expect(await service().check()).toMatchObject({ status: "unavailable", latestVersion: null, releaseUrl: null });
  });

  it.each(["not json", "null", "[]"])("rejects malformed release JSON %p", async (body) => {
    upstream.mockResolvedValueOnce(new Response(body));
    expect(await service().check()).toMatchObject({ status: "unavailable", message: expect.stringContaining("invalid") });
  });

  it("distinguishes no published release from upstream errors", async () => {
    upstream.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await service().check()).toMatchObject({ status: "no-release", latestVersion: null, releaseUrl: null });
    upstream.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(await service().check()).toMatchObject({ status: "unavailable" });
  });

  it("bounds declared and streamed response bytes", async () => {
    upstream.mockResolvedValueOnce(new Response("{}", { headers: { "content-length": String(256 * 1024 + 1) } }));
    expect(await service().check()).toMatchObject({ status: "unavailable", message: expect.stringContaining("invalid") });
    upstream.mockResolvedValueOnce(new Response(" ".repeat(256 * 1024 + 1)));
    expect(await service().check()).toMatchObject({ status: "unavailable", message: expect.stringContaining("invalid") });
  });

  it("coalesces concurrent checks and refreshes success at 60 seconds", async () => {
    let resolve!: (response: Response) => void;
    upstream.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const installed = service();
    const first = installed.check();
    const second = installed.check();
    expect(upstream).toHaveBeenCalledTimes(1);
    resolve(release());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    a.status = "current";
    now += 59_999;
    expect(await installed.check()).toEqual(b);
    expect(upstream).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await installed.check()).toMatchObject({ status: "update-available", checkedAt: new Date(now).toISOString() });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not return stale success on failure and permits an immediate manual retry", async () => {
    const installed = service();
    expect((await installed.check()).status).toBe("update-available");
    now += 60_000;
    upstream.mockRejectedValueOnce(new Error("Network is unreachable"));
    expect(await installed.check()).toMatchObject({ status: "unavailable", latestVersion: null, releaseUrl: null });
    expect((await installed.check()).status).toBe("update-available");
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it.each([
    [429, { "retry-after": "120" }, 120_000],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(START / 1000 + 180) }, 180_000],
    [403, { "retry-after": new Date(START + 90_000).toUTCString() }, 90_000],
    [429, { "retry-after": "15" }, 15_000],
    [429, {}, 60_000],
    [429, { "retry-after": "garbage", "x-ratelimit-reset": "infinity" }, 60_000],
  ])("honors rate-limit status %s headers %p", async (status, headers, delay) => {
    upstream.mockResolvedValueOnce(new Response(null, { status, headers: headers as Record<string, string> }));
    const installed = service();
    const limited = await installed.check();
    expect(limited).toMatchObject({ status: "unavailable", retryAt: new Date(START + delay).toISOString() });
    now += delay - 1;
    expect(await installed.check()).toEqual(limited);
    expect(upstream).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await installed.check()).status).toBe("update-available");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not describe a non-rate-limit 403 as a successful check", async () => {
    upstream.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await service().check()).toMatchObject({ status: "unavailable" });
  });

  it("bounds a hanging request at five seconds and aborts it", async () => {
    jest.useFakeTimers();
    upstream.mockImplementationOnce(() => new Promise(() => undefined));
    const checked = service().check();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(upstream.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await checked).toMatchObject({ status: "unavailable", message: expect.stringContaining("timed out") });
    expect(upstream.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps the five-second bound while the release body is stalled", async () => {
    jest.useFakeTimers();
    upstream.mockImplementationOnce(async (_url, options) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        options?.signal?.addEventListener("abort", () => controller.error(new Error("Aborted")));
      },
    })));
    const checked = service().check();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await checked).toMatchObject({ status: "unavailable", message: expect.stringContaining("timed out") });
    expect(upstream.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
