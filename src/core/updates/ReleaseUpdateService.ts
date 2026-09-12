import { compare, parse, type SemVer } from "semver";
import type { UpdateCheckResult } from "../../shared/updateCheck";

// Both source and the staged dist tree are three levels below the engine manifest.
const { version: PACKAGE_VERSION } = require("../../../package.json") as { version: string };
const RELEASE_ENDPOINT = "https://api.github.com/repos/roethlar/songr/releases/latest";
const RELEASE_PAGE = "https://github.com/roethlar/songr/releases/tag/";
const TIMEOUT_MS = 5_000;
const CACHE_MS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

interface ReleaseUpdateOptions {
  version?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Strict SemVer with only the optional conventional v prefix normalized. */
function version(value: unknown): SemVer | null {
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value) return null;
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  if (!/^\d/.test(normalized)) return null;
  return parse(normalized);
}

function retryTime(headers: Headers, now: number): number {
  const times: number[] = [];
  const after = headers.get("retry-after");
  if (after) {
    const parsed = /^\d+(?:\.\d+)?$/.test(after) ? now + Number(after) * 1000 : Date.parse(after);
    if (Number.isFinite(parsed) && parsed > now && parsed <= 8.64e15) times.push(parsed);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) {
    const parsed = Number(reset) * 1000;
    if (Number.isFinite(parsed) && parsed > now && parsed <= 8.64e15) times.push(parsed);
  }
  return times.length ? Math.max(...times) : now + CACHE_MS;
}

async function boundedJson(response: Response): Promise<unknown> {
  const size = response.headers.get("content-length");
  if (size && Number(size) > MAX_RESPONSE_BYTES) throw new Error("Oversized release metadata");
  if (!response.body) throw new Error("Empty release metadata");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Oversized release metadata");
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** One server-wide manual check, independent of Roon and of any desktop version. */
export class ReleaseUpdateService {
  private readonly currentVersion: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private inFlight: Promise<UpdateCheckResult> | null = null;
  private cached: { until: number; result: UpdateCheckResult } | null = null;

  constructor(options: ReleaseUpdateOptions = {}) {
    this.currentVersion = options.version ?? PACKAGE_VERSION;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  public getVersion(): string {
    return this.currentVersion;
  }

  public check(): Promise<UpdateCheckResult> {
    if (this.inFlight) return this.inFlight.then((result) => ({ ...result }));
    if (this.cached && this.now() < this.cached.until) {
      return Promise.resolve({ ...this.cached.result });
    }
    // An expired success must never survive a failed refresh.
    this.cached = null;
    this.inFlight = this.performCheck().then((result) => {
      const until = result.retryAt ? Date.parse(result.retryAt) : this.now() + CACHE_MS;
      if (result.status !== "unavailable" || result.retryAt) this.cached = { until, result };
      return result;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight.then((result) => ({ ...result }));
  }

  private result(status: UpdateCheckResult["status"], message?: string): UpdateCheckResult {
    return {
      currentVersion: this.currentVersion,
      status,
      latestVersion: null,
      releaseUrl: null,
      checkedAt: new Date(this.now()).toISOString(),
      ...(message ? { message } : {}),
    };
  }

  private async performCheck(): Promise<UpdateCheckResult> {
    const installed = version(this.currentVersion);
    if (!installed) return this.result("unavailable", "The installed server version could not be compared.");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Release check timed out"));
      }, TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.fetchRelease(installed, controller.signal), deadline]);
    } catch {
      return this.result("unavailable", controller.signal.aborted
        ? "The update check timed out. Try again."
        : "The update check could not be completed. Try again.");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async fetchRelease(installed: SemVer, signal: AbortSignal): Promise<UpdateCheckResult> {
    const response = await this.fetch(RELEASE_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Songr-update-check" },
      credentials: "omit",
      redirect: "error",
      signal,
    });
    if (response.status === 404) return this.result("no-release", "No published stable release is available.");
    if (response.status === 429 || (response.status === 403 && (
      response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")
    ))) {
      return {
        ...this.result("unavailable", "GitHub has temporarily limited update checks. Try again later."),
        retryAt: new Date(retryTime(response.headers, this.now())).toISOString(),
      };
    }
    if (!response.ok) return this.result("unavailable", "GitHub could not complete the update check. Try again.");
    let raw: unknown;
    try {
      raw = await boundedJson(response);
    } catch (error) {
      if (signal.aborted) throw error;
      return this.result("unavailable", "GitHub returned invalid release information. Try again.");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return this.result("unavailable", "GitHub returned invalid release information. Try again.");
    }
    const release = raw as Record<string, unknown>;
    const published = version(release.tag_name);
    if (!published || published.prerelease.length || release.draft !== false || release.prerelease !== false) {
      return this.result("unavailable", "GitHub returned invalid stable release information. Try again.");
    }
    const ordering = compare(published, installed);
    return {
      ...this.result(ordering > 0 ? "update-available" : ordering === 0 ? "current" : "ahead"),
      latestVersion: published.version,
      releaseUrl: `${RELEASE_PAGE}${encodeURIComponent(release.tag_name as string)}`,
    };
  }
}
