import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Logger } from "pino";
import type { FavoriteEntry, FavoriteType } from "../../shared/types";

export interface FavoritesServiceOptions {
  /**
   * On-disk path for the persisted JSON list. The directory is
   * created if it doesn't exist.
   */
  filePath: string;
  /** Maximum number of entries kept. Oldest dropped beyond it. */
  cap?: number;
  /** Optional clock for tests (ms since epoch). */
  now?: () => number;
}

export interface AddFavoriteInput {
  type: FavoriteType;
  title: string;
  artist?: string;
  album?: string;
  image_key?: string;
}

const FAVORITE_TYPES: ReadonlySet<string> = new Set([
  "track",
  "album",
  "artist",
]);

export function isFavoriteType(value: unknown): value is FavoriteType {
  return typeof value === "string" && FAVORITE_TYPES.has(value);
}

/**
 * Identity key for dedupe: same (type, title, artist, album) is the
 * same favorite. JSON-tuple serialization for the same delimiter-
 * collision reasons as recentlyPlayedDedupeKey.
 */
export function favoriteDedupeKey(entry: {
  type: FavoriteType;
  title: string;
  artist?: string;
  album?: string;
}): string {
  return JSON.stringify([
    entry.type,
    entry.title,
    entry.artist ?? null,
    entry.album ?? null,
  ]);
}

/**
 * FavoritesService — user-curated list of favorite tracks / albums /
 * artists, persisted to disk. Deliberately simpler than
 * RecentlyPlayedService: mutations only arrive via explicit REST
 * calls (no Roon event ingestion), there's no socket broadcast, and
 * therefore no epoch/revision ordering machinery. Multiple open
 * clients converge on their next GET.
 *
 * Concurrency: all mutations serialize through `opChain` so two
 * concurrent POSTs can't interleave their snapshot/mutate/persist
 * sequences. Persist failures roll back the in-memory list so memory
 * always matches disk.
 *
 * Degraded mode: if the persisted file exists but can't be parsed
 * (or read fails with anything but ENOENT), the service refuses
 * mutations and GETs 503 rather than clobbering the file with an
 * empty list. Fix the file and restart to recover.
 */
export class FavoritesService {
  private entries: FavoriteEntry[] = [];
  private degraded = false;
  private startPromise: Promise<void> | null = null;
  private opChain: Promise<unknown> = Promise.resolve();
  private readonly filePath: string;
  private readonly cap: number;
  private readonly now: () => number;

  constructor(
    private readonly logger: Logger,
    options: FavoritesServiceOptions
  ) {
    this.filePath = options.filePath;
    this.cap = Math.max(1, Math.floor(options.cap ?? 500));
    this.now = options.now ?? (() => Date.now());
  }

  /** Load the persisted list. Idempotent. */
  public start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const rawEntries =
        parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
          ? ((parsed as { entries: unknown[] }).entries)
          : null;
      if (rawEntries === null) {
        this.degraded = true;
        this.logger.warn(
          { filePath: this.filePath },
          "FavoritesService: persisted shape invalid — entering degraded mode (file left untouched)"
        );
        return;
      }
      this.entries = rawEntries
        .filter((it): it is FavoriteEntry => isPlausibleFavorite(it))
        .slice(0, this.cap);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return; // legit first run
      this.degraded = true;
      this.logger.warn(
        { err, filePath: this.filePath },
        "FavoritesService: persisted state unreadable — entering degraded mode (file left untouched)"
      );
    }
  }

  public isDegraded(): boolean {
    return this.degraded;
  }

  /** Snapshot, newest first. */
  public getEntries(): FavoriteEntry[] {
    return [...this.entries];
  }

  /**
   * Add a favorite. Idempotent: a same-identity entry returns the
   * existing record without touching disk. Resolves once the write
   * is durable; rejects (with in-memory rollback) if persist fails.
   */
  public add(input: AddFavoriteInput): Promise<FavoriteEntry> {
    return this.enqueue(async () => {
      this.assertNotDegraded();
      const key = favoriteDedupeKey(input);
      const existing = this.entries.find(
        (e) => favoriteDedupeKey(e) === key
      );
      if (existing) return existing;

      const entry: FavoriteEntry = {
        id: randomUUID(),
        type: input.type,
        title: input.title,
        artist: input.artist,
        album: input.album,
        image_key: input.image_key,
        added_at: new Date(this.now()).toISOString(),
      };

      const previous = this.entries;
      const next = [entry, ...this.entries];
      if (next.length > this.cap) next.length = this.cap;
      this.entries = next;
      try {
        await this.persist();
      } catch (err) {
        this.entries = previous;
        throw err;
      }
      return entry;
    });
  }

  /**
   * Remove by id. Returns false when the id isn't present (no disk
   * write). Rejects with rollback on persist failure.
   */
  public remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      this.assertNotDegraded();
      const previous = this.entries;
      const next = this.entries.filter((e) => e.id !== id);
      if (next.length === previous.length) return false;
      this.entries = next;
      try {
        await this.persist();
      } catch (err) {
        this.entries = previous;
        throw err;
      }
      return true;
    });
  }

  private assertNotDegraded(): void {
    if (this.degraded) {
      throw new Error("FavoritesService is degraded; mutation refused");
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(op, op);
    this.opChain = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.tmp`;
    const payload = JSON.stringify({ entries: this.entries }, null, 2);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, payload, "utf-8");
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      this.logger.warn(
        { err, filePath: this.filePath },
        "FavoritesService: persist failed; mutation rolled back"
      );
      void fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}

function isPlausibleFavorite(value: unknown): value is FavoriteEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return false;
  if (!isFavoriteType(v.type)) return false;
  if (typeof v.title !== "string" || v.title.length === 0) return false;
  if (typeof v.added_at !== "string" || v.added_at.length === 0) return false;
  if (v.artist !== undefined && typeof v.artist !== "string") return false;
  if (v.album !== undefined && typeof v.album !== "string") return false;
  if (v.image_key !== undefined && typeof v.image_key !== "string") return false;
  return true;
}
