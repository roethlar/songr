/**
 * The serialized browse session the live library view runs on.
 *
 * Every server-driven browse read for the library — the roots read, an open,
 * a root-count check — goes through one FIFO per process and one retained
 * Roon session per Core. That is not an optimization; it is what makes the
 * published references mean anything. The coordinator mints an opaque token
 * for a row and binds it to the Roon item key the browse session produced.
 * Roon's key space is per-session and is re-rooted by `pop_all` and
 * `refresh_list`, so a second tail browsing the same session would invalidate
 * keys the UI is still holding. Serializing removes the possibility.
 *
 * TWO CHANNELS, DELIBERATELY. `run()` uses the publication channel whose item
 * keys back live UI references. `runCount()` uses a distinct retained session,
 * because a count check re-roots the hierarchy it runs on and must never
 * re-root the one whose keys were published. This was not a precaution: it was
 * measured. A held key survived plain and refreshed re-rooting of the *other*
 * hierarchy and failed with `InvalidItemKey` after either re-rooting of the
 * *same* one (`.agents/state.md` 2026-09-03).
 *
 * THE LEASE IS RETAINED, NOT PER-CALL, so session-scoped observations survive
 * between serialized calls. It is released after an idle window, on session
 * loss, and on Core disconnect. Release is enqueued on the same tail as the
 * work, so an idle expiry can never race an acquire.
 *
 * Extracted from `CatalogService` when the saved catalog model was deleted
 * (`.agents/plans/library-live-view.md` Slice 4). The mechanism was always the
 * live view's, not the catalog's; the catalog merely happened to own it.
 */
import type { Logger } from "pino";

import {
  BrowseSessionCoordinatorError,
  type CatalogCountSessionHandle,
  type CatalogSessionHandle,
  type CoordinatedBrowseSession,
} from "../roon/BrowseSessionCoordinator";
import { RoonTimeoutError } from "../roon/errors";

/**
 * The coordinator surface this session needs. `BrowseSessionCoordinator`
 * satisfies it structurally.
 */
export interface LibraryBrowseCoordinator {
  acquireCatalog(coreId: string): CatalogSessionHandle;
  runCatalog<T>(
    coreId: string,
    handle: CatalogSessionHandle,
    work: (session: CoordinatedBrowseSession) => Promise<T>,
  ): Promise<T>;
  releaseCatalog(coreId: string, handle: CatalogSessionHandle): Promise<void>;
  acquireCatalogCount(coreId: string): CatalogCountSessionHandle;
  runCatalogCount<T>(
    coreId: string,
    handle: CatalogCountSessionHandle,
    work: (session: CoordinatedBrowseSession) => Promise<T>,
  ): Promise<T>;
  releaseCatalogCount(
    coreId: string,
    handle: CatalogCountSessionHandle,
  ): Promise<void>;
}

export interface LibraryBrowseSessionOptions {
  /** How long a lease is kept after the last call before it is released. */
  readonly idleMs?: number;
}

const DEFAULT_SESSION_IDLE_MS = 5 * 60 * 1_000;

interface RetainedSession {
  readonly handle: CatalogSessionHandle;
  countHandle?: CatalogCountSessionHandle;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class LibraryBrowseSession {
  private readonly idleMs: number;
  private tail: Promise<void> = Promise.resolve();
  private readonly retained = new Map<string, RetainedSession>();

  public constructor(
    private readonly coordinator: LibraryBrowseCoordinator,
    private readonly logger: Logger,
    options: LibraryBrowseSessionOptions = {},
  ) {
    this.idleMs = options.idleMs ?? DEFAULT_SESSION_IDLE_MS;
  }

  /**
   * Run one unit of browse work on the shared FIFO and its retained session.
   * Every in-process library consumer serializes here, so no second tail can
   * race the coordinator's singleton lease.
   */
  public run<T>(
    coreId: string,
    work: (session: CoordinatedBrowseSession) => Promise<T>,
  ): Promise<T> {
    this.assertCoreId(coreId);
    return this.enqueue(coreId, work, "catalog");
  }

  /**
   * Run root-count checks on a distinct retained session. `pop_all` and
   * `refresh_list` both re-root Roon's key space, so this channel must never
   * be the publication channel whose item keys back live UI references.
   */
  public runCount<T>(
    coreId: string,
    work: (session: CoordinatedBrowseSession) => Promise<T>,
  ): Promise<T> {
    this.assertCoreId(coreId);
    return this.enqueue(coreId, work, "catalog-count");
  }

  /** Drop the Core's retained lease; the next caller reacquires. */
  public markCoreDisconnected(coreId: string): void {
    this.assertCoreId(coreId);
    const retained = this.retained.get(coreId);
    if (retained) this.enqueueRelease(coreId, retained);
  }

  /** Release every retained lease. */
  public shutdown(): void {
    for (const [coreId, retained] of this.retained) {
      this.enqueueRelease(coreId, retained);
    }
  }

  private assertCoreId(coreId: string): void {
    if (typeof coreId !== "string" || coreId.trim() === "") {
      throw new TypeError("coreId must be a non-empty string");
    }
  }

  private enqueue<T>(
    coreId: string,
    work: (session: CoordinatedBrowseSession) => Promise<T>,
    channel: "catalog" | "catalog-count",
  ): Promise<T> {
    const prior = this.tail;
    const run = prior.then(
      () => this.withSession(coreId, work, channel),
      () => this.withSession(coreId, work, channel),
    );
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withSession<T>(
    coreId: string,
    work: (session: CoordinatedBrowseSession) => Promise<T>,
    channel: "catalog" | "catalog-count",
  ): Promise<T> {
    const retained = this.acquire(coreId);
    let value: T | undefined;
    let failed = false;
    let primaryError: unknown;
    try {
      if (channel === "catalog-count") {
        const countHandle =
          retained.countHandle ?? this.coordinator.acquireCatalogCount(coreId);
        retained.countHandle = countHandle;
        value = await this.coordinator.runCatalogCount(
          coreId,
          countHandle,
          work,
        );
      } else {
        value = await this.coordinator.runCatalog(coreId, retained.handle, work);
      }
    } catch (error) {
      failed = true;
      primaryError = error;
    }

    if (failed && LibraryBrowseSession.isSessionLoss(primaryError)) {
      if (channel === "catalog-count") {
        await this.releaseCount(coreId, retained);
        this.scheduleIdle(coreId, retained);
      } else {
        await this.release(coreId, retained);
      }
    } else {
      this.scheduleIdle(coreId, retained);
    }
    if (failed) throw primaryError;
    return value as T;
  }

  /**
   * Reuse the Core's singleton lease across serialized calls so session-scoped
   * observations survive between them. The coordinator's physical session cap
   * still applies at acquire time.
   */
  private acquire(coreId: string): RetainedSession {
    const existing = this.retained.get(coreId);
    if (existing) {
      LibraryBrowseSession.clearIdle(existing);
      return existing;
    }
    const retained: RetainedSession = {
      handle: this.coordinator.acquireCatalog(coreId),
    };
    this.retained.set(coreId, retained);
    return retained;
  }

  private scheduleIdle(coreId: string, retained: RetainedSession): void {
    if (this.retained.get(coreId) !== retained) return;
    LibraryBrowseSession.clearIdle(retained);
    retained.idleTimer = setTimeout(() => {
      retained.idleTimer = undefined;
      this.enqueueRelease(coreId, retained);
    }, this.idleMs);
    retained.idleTimer.unref?.();
  }

  private static clearIdle(retained: RetainedSession): void {
    if (retained.idleTimer) clearTimeout(retained.idleTimer);
    retained.idleTimer = undefined;
  }

  /** Release on the shared tail so an idle expiry never races an acquire. */
  private enqueueRelease(coreId: string, retained: RetainedSession): void {
    const run = this.tail.then(() => this.release(coreId, retained));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
  }

  private async release(
    coreId: string,
    retained: RetainedSession,
  ): Promise<void> {
    if (this.retained.get(coreId) !== retained) return;
    this.retained.delete(coreId);
    LibraryBrowseSession.clearIdle(retained);
    await this.releaseCount(coreId, retained, true);
    try {
      await this.coordinator.releaseCatalog(coreId, retained.handle);
    } catch (error) {
      this.logger.warn(
        { err: error, coreId },
        "Retained library browse session release failed",
      );
    }
  }

  private async releaseCount(
    coreId: string,
    retained: RetainedSession,
    parentAlreadyRemoved = false,
  ): Promise<void> {
    if (!parentAlreadyRemoved && this.retained.get(coreId) !== retained) return;
    const handle = retained.countHandle;
    if (handle === undefined) return;
    retained.countHandle = undefined;
    try {
      await this.coordinator.releaseCatalogCount(coreId, handle);
    } catch (error) {
      this.logger.warn(
        { err: error, coreId },
        "Retained library count session release failed",
      );
    }
  }

  /**
   * A timeout or a coordinator session-loss error means the retained lease is
   * dead (its channel was quarantined on timeout); drop it so the next caller
   * reacquires instead of failing on the stale generation.
   */
  private static isSessionLoss(error: unknown): boolean {
    if (error instanceof RoonTimeoutError) return true;
    return (
      error instanceof BrowseSessionCoordinatorError &&
      (error.code === "SESSION_LOST" ||
        error.code === "STALE_GENERATION" ||
        error.code === "INVALID_HANDLE")
    );
  }
}
