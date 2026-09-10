/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Logger } from "pino";
import { RoonClient } from "./RoonClient";
import { CoreUnpairedError, ImageNotFoundError, ImageQueueFullError, RoonOperationError, RoonTimeoutError } from "./errors";
import { DEFAULT_ROON_CALL_TIMEOUT_MS } from "./timeout";

export type ImageScale = "fit" | "fill" | "stretch";

const DEFAULT_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const EVICTION_TARGET_RATIO = 0.9; // evict down to 90% of cap when triggered
const DEFAULT_HOT_CACHE_MAX_BYTES = 32 * 1024 * 1024; // 32 MB
const MAX_ACTIVE_IMAGE_CALLS = 4;
const MAX_QUEUED_IMAGE_CALLS = 32;

type ImageResult = { data: Buffer; contentType: string };
type ImageWaiter = { resolve: (result: ImageResult) => void; reject: (error: Error) => void };
type ImageJob = {
  filename: string;
  imageKey: string;
  options: Record<string, unknown>;
  active: boolean;
  waiters: Set<ImageWaiter>;
};
type ImagePool = { image: any; active: number; jobs: Map<string, ImageJob> };

/**
 * Image Service
 *
 * Provides artwork streaming by image key from Roon.
 * Handles image retrieval with appropriate caching headers and a
 * size-bounded LRU cache on disk.
 */
export class ImageService {
  private pool: ImagePool | null = null;
  private readonly cacheDir: string;
  private readonly cacheMaxBytes: number;
  private readonly hotCacheMaxBytes: number;

  /**
   * In-memory LRU in front of the disk cache: repeat artwork requests
   * (grid re-renders, back/forward navigation) skip two file reads.
   * A Map iterates in insertion order, so re-inserting on hit makes
   * the first key the least recently used. Byte-bounded.
   */
  private readonly hotCache = new Map<string, { data: Buffer; contentType: string }>();
  private hotCacheBytes = 0;

  constructor(
    private roonClient: RoonClient,
    private logger: Logger,
    cacheDir: string,
    cacheMaxBytes: number = DEFAULT_CACHE_MAX_BYTES,
    hotCacheMaxBytes: number = DEFAULT_HOT_CACHE_MAX_BYTES
  ) {
    this.cacheDir = cacheDir;
    this.cacheMaxBytes = cacheMaxBytes;
    this.hotCacheMaxBytes = hotCacheMaxBytes;
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    this.logger.info(
      { cacheDir: this.cacheDir, cacheMaxBytes: this.cacheMaxBytes },
      "Image cache directory initialized"
    );

    // Service objects change with the actual Core connection. A repeated
    // status notification for the same object must not free outstanding calls.
    this.roonClient.on?.("core-status", () => this.refreshImage());

    // Run an LRU sweep once at startup. Subsequent sweeps are triggered
    // opportunistically after writes (see persistToCache).
    this.evictIfOverCap().catch((err) => {
      this.logger.warn({ err }, "Initial cache eviction sweep failed");
    });
  }

  /**
   * Initialize image service
   */
  public start(): void {
    if (!this.refreshImage()) {
      this.logger.warn("Image service not available yet, will retry on core pairing");
      return;
    }

    this.logger.info("ImageService started");
  }

  /**
   * Get image stream by key
   * @param imageKey - Roon image key
   * @param scale - Optional scale (fit, fill, stretch)
   * @param width - Optional width in pixels
   * @param height - Optional height in pixels
   * @param signal - Detach this caller on abort; a started Core call remains counted
   * @returns Promise resolving to image stream and content type
   */
  public async getImage(
    imageKey: string,
    scale?: ImageScale,
    width?: number,
    height?: number,
    signal?: AbortSignal
  ): Promise<ImageResult> {
    signal?.throwIfAborted();
    const pool = this.ensureImage();

    // Validate width/height when scale is provided (Roon API requirement)
    if (scale && (!width || !height)) {
      const error = new Error("width and height are required when scale is specified");
      this.logger.error({ imageKey, scale, width, height }, "Invalid getImage parameters");
      throw error;
    }

    // Hash the full request tuple into a fixed cache filename. Using the raw
    // imageKey (which originates from a route param) at a filesystem boundary
    // would let an encoded "../" escape the cache directory.
    const filename = this.cacheFilename(imageKey, scale, width, height);
    const cachePath = path.join(this.cacheDir, filename);
    const metaPath = cachePath + ".meta";

    // Hot (in-memory) cache first.
    const hot = this.hotCacheGet(filename);
    if (hot) {
      this.logger.debug({ imageKey, filename }, "Image served from hot cache");
      // Keep the disk LRU truthful: a memory hit is still a use of the
      // disk entry backing it.
      const now = new Date();
      void fs.promises.utimes(cachePath, now, now).catch(() => undefined);
      return hot;
    }

    // Check disk cache
    try {
      const [data, contentType] = await Promise.all([
        fs.promises.readFile(cachePath),
        fs.promises.readFile(metaPath, "utf-8"),
      ]);
      this.logger.debug({ imageKey, filename }, "Image served from cache");
      // Touch atime/mtime so LRU eviction sees this as recently used.
      const now = new Date();
      void fs.promises.utimes(cachePath, now, now).catch(() => undefined);
      const result = { data, contentType: contentType.trim() };
      this.hotCachePut(filename, result);
      return result;
    } catch {
      // Cache miss — fetch from Roon
    }

    signal?.throwIfAborted();
    if (this.refreshImage() !== pool) throw new CoreUnpairedError("Image service changed");
    // Another miss may have completed while this request checked the disk.
    const completed = this.hotCacheGet(filename);
    if (completed) return completed;
    return this.enqueueImage(pool, filename, imageKey, scale, width, height, signal);
  }

  private hotCacheGet(filename: string): { data: Buffer; contentType: string } | undefined {
    const hit = this.hotCache.get(filename);
    if (!hit) return undefined;
    // Re-insert to mark as most recently used.
    this.hotCache.delete(filename);
    this.hotCache.set(filename, hit);
    return hit;
  }

  private hotCachePut(filename: string, entry: { data: Buffer; contentType: string }): void {
    // An entry bigger than the whole cap would just flush everything
    // for a single-use tenant; serve it from disk instead.
    if (entry.data.length > this.hotCacheMaxBytes) return;
    const existing = this.hotCache.get(filename);
    if (existing) {
      this.hotCacheBytes -= existing.data.length;
      this.hotCache.delete(filename);
    }
    this.hotCache.set(filename, entry);
    this.hotCacheBytes += entry.data.length;
    while (this.hotCacheBytes > this.hotCacheMaxBytes) {
      const oldest = this.hotCache.keys().next().value as string;
      const evicted = this.hotCache.get(oldest)!;
      this.hotCache.delete(oldest);
      this.hotCacheBytes -= evicted.data.length;
    }
  }

  private async persistToCache(
    filename: string,
    cachePath: string,
    metaPath: string,
    result: { data: Buffer; contentType: string }
  ): Promise<void> {
    try {
      await fs.promises.writeFile(cachePath, result.data);
      await fs.promises.writeFile(metaPath, result.contentType);
    } catch (err) {
      this.logger.warn({ err, filename }, "Failed to write image cache");
      return;
    }

    // Opportunistic eviction. We don't await this on the request path; if the
    // cache is bumping up against the cap, the next write will retry.
    this.evictIfOverCap().catch((err) =>
      this.logger.warn({ err }, "Cache eviction sweep failed")
    );
  }

  /**
   * Walk the cache directory, sum total bytes, and if over `cacheMaxBytes`
   * delete the oldest-by-mtime entries (data + meta together) until total
   * drops below `cacheMaxBytes * EVICTION_TARGET_RATIO`.
   *
   * Cost is O(n) in entry count per sweep. Called at startup and after
   * cache writes; the typical case is a no-op until the cap is reached.
   */
  private async evictIfOverCap(): Promise<void> {
    const entries = await fs.promises.readdir(this.cacheDir).catch(() => []);
    if (entries.length === 0) return;

    type Entry = { name: string; size: number; mtimeMs: number };
    const stats: Entry[] = [];
    for (const name of entries) {
      try {
        const stat = await fs.promises.stat(path.join(this.cacheDir, name));
        if (stat.isFile()) {
          stats.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // Ignore entries that vanished between readdir and stat.
      }
    }

    const totalBytes = stats.reduce((sum, e) => sum + e.size, 0);
    if (totalBytes <= this.cacheMaxBytes) return;

    const target = Math.floor(this.cacheMaxBytes * EVICTION_TARGET_RATIO);
    this.logger.info(
      { totalBytes, cacheMaxBytes: this.cacheMaxBytes, target },
      "Image cache over cap; evicting oldest entries"
    );

    // Sort oldest first. Pair data files with their .meta sidecars by name.
    stats.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let remaining = totalBytes;
    let evictedCount = 0;
    let evictedBytes = 0;
    for (const entry of stats) {
      if (remaining <= target) break;
      try {
        await fs.promises.unlink(path.join(this.cacheDir, entry.name));
        remaining -= entry.size;
        evictedBytes += entry.size;
        evictedCount += 1;
      } catch (err) {
        this.logger.warn({ err, name: entry.name }, "Failed to evict cache entry");
      }
    }

    this.logger.info(
      { evictedCount, evictedBytes, remainingBytes: remaining },
      "Image cache eviction complete"
    );
  }

  private cacheFilename(
    imageKey: string,
    scale?: ImageScale,
    width?: number,
    height?: number
  ): string {
    const tuple = JSON.stringify([imageKey, scale ?? "", width ?? 0, height ?? 0]);
    return crypto.createHash("sha256").update(tuple).digest("hex");
  }

  private enqueueImage(
    pool: ImagePool,
    filename: string,
    imageKey: string,
    scale?: ImageScale,
    width?: number,
    height?: number,
    signal?: AbortSignal
  ): Promise<ImageResult> {
    let job = pool.jobs.get(filename);
    if (!job) {
      if (pool.jobs.size - pool.active >= MAX_QUEUED_IMAGE_CALLS) {
        return Promise.reject(new ImageQueueFullError());
      }
      const options: Record<string, unknown> = {};
      if (scale) options.scale = scale;
      if (width) options.width = width;
      if (height) options.height = height;
      job = { filename, imageKey, options, active: false, waiters: new Set() };
      pool.jobs.set(filename, job);
    }
    const admitted = job;
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanUp = (): boolean => {
        if (finished) return false;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        admitted.waiters.delete(waiter);
        // An abandoned queued job must never reach the Core. An active job
        // retains its slot AND key until the raw callback actually settles.
        if (!admitted.active && admitted.waiters.size === 0 && pool.jobs.get(filename) === admitted) {
          pool.jobs.delete(filename);
        }
        return true;
      };
      const waiter: ImageWaiter = {
        resolve: (result) => { if (cleanUp()) resolve(result); },
        reject: (error) => { if (cleanUp()) reject(error); },
      };
      const onAbort = () => {
        const error = new Error("Image request aborted");
        error.name = "AbortError";
        waiter.reject(error);
      };
      const timer = setTimeout(
        () => waiter.reject(new RoonTimeoutError("getImage", DEFAULT_ROON_CALL_TIMEOUT_MS)),
        DEFAULT_ROON_CALL_TIMEOUT_MS
      );
      timer.unref?.();
      admitted.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      this.drainImages(pool);
    });
  }

  private drainImages(pool: ImagePool): void {
    if (this.refreshImage() !== pool) return;
    for (const job of pool.jobs.values()) {
      if (pool.active >= MAX_ACTIVE_IMAGE_CALLS) break;
      if (job.active || job.waiters.size === 0) continue;
      job.active = true;
      pool.active++;
      this.fetchFromRoon(pool, job);
    }
  }

  private fetchFromRoon(pool: ImagePool, job: ImageJob): void {
    let settled = false;
    const finish = (error?: Error, result?: ImageResult): void => {
      if (settled) return;
      settled = true;
      const current = this.refreshImage() === pool;
      if (result && current) {
        // This runs on raw settlement, even after every HTTP waiter timed
        // out or disconnected. Cache useful late bytes before releasing the
        // slot; otherwise every visible retry repeats that expensive call.
        this.hotCachePut(job.filename, result);
        const cachePath = path.join(this.cacheDir, job.filename);
        void this.persistToCache(job.filename, cachePath, cachePath + ".meta", result);
      }
      for (const waiter of job.waiters) {
        if (error) waiter.reject(error);
        else if (result) waiter.resolve(result);
      }
      job.active = false;
      if (pool.jobs.get(job.filename) === job) pool.jobs.delete(job.filename);
      pool.active--;
      this.drainImages(pool);
    };
    try {
      pool.image.get_image(job.imageKey, job.options, (error: any, contentType: string, imageData: Buffer) => {
        if (error) {
          this.logger.error({ err: error, imageKey: job.imageKey }, "getImage failed");
          finish(new RoonOperationError("getImage", String(error), { imageKey: job.imageKey }));
        } else if (!imageData) {
          this.logger.warn({ imageKey: job.imageKey }, "Image not found");
          finish(new ImageNotFoundError(job.imageKey));
        } else {
          this.logger.debug({ imageKey: job.imageKey, contentType }, "Image retrieved from Roon");
          finish(undefined, { data: imageData, contentType });
        }
      });
    } catch (error) {
      finish(new RoonOperationError("getImage", String(error), { imageKey: job.imageKey }));
    }
  }

  private refreshImage(): ImagePool | null {
    const image = this.roonClient.getImage();
    if ((this.pool?.image ?? null) === image) return this.pool;
    const previous = this.pool;
    this.pool = image ? { image, active: 0, jobs: new Map() } : null;
    if (previous) {
      const error = new CoreUnpairedError("Image service changed");
      for (const job of previous.jobs.values()) {
        for (const waiter of job.waiters) waiter.reject(error);
      }
    }
    return this.pool;
  }

  /**
   * Get cache control headers for image responses
   * Images from Roon are generally static, so we can cache aggressively
   */
  public getCacheHeaders(): Record<string, string> {
    return {
      "Cache-Control": "public, max-age=86400, immutable", // 24 hours
      "Vary": "Accept-Encoding",
    };
  }

  /**
   * Ensure image service is available
   * @throws Error if core not paired or image service unavailable
   */
  private ensureImage(): ImagePool {
    const pool = this.refreshImage();
    if (!pool) {
      this.logger.error("Image operation attempted without paired core");
      throw new CoreUnpairedError("Image service unavailable");
    }
    return pool;
  }
}
