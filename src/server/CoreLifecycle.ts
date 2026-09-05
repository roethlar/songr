import type { Logger } from "pino";

export interface CoreLifecycleCoordinator {
  invalidateCore(coreId: string): Promise<void>;
  shutdown(): void;
}

export interface AlbumActionLifecycleService {
  invalidateCore(coreId: string): void;
  shutdown(): void;
}

export interface LibraryAlbumLifecycleService {
  invalidateCore(coreId: string): void;
  shutdown(): void;
}

/**
 * Captures paired Core identity before RoonClient erases it on unpair, and
 * owns the coordinator side of Core lifecycle transitions.
 *
 * This was `CatalogLifecycle`, and it started the catalog's own crawl as its
 * first act. The catalog is gone (`.agents/plans/library-live-view.md` Slice
 * 4) and what is left is the part that was never about the catalog: on a Core
 * change every session-scoped authority — album action leases, album pages,
 * and the browse coordinator's own sessions — has to be retired before
 * anything reads under the new Core, in that order, because a page retiring
 * after its coordinator session would be holding keys from a session that no
 * longer exists.
 */
export class CoreLifecycle {
  private activeCoreId: string | null = null;
  private lastCoreId: string | null = null;
  private stopped = false;

  public constructor(
    private readonly coordinator: CoreLifecycleCoordinator,
    private readonly logger: Logger,
    private readonly albumActions?: AlbumActionLifecycleService,
    private readonly libraryAlbums?: LibraryAlbumLifecycleService
  ) {}

  public corePaired(coreId: string): void {
    if (this.stopped) return;
    if (typeof coreId !== "string" || coreId.trim() === "") {
      this.logger.warn("Core activation was rejected: no Core identity");
      return;
    }

    const previousCoreId = this.activeCoreId;
    this.activeCoreId = coreId;
    this.lastCoreId = coreId;
    if (previousCoreId && previousCoreId !== coreId) {
      this.disconnectCore(previousCoreId);
    }
  }

  public coreUnpaired(): void {
    if (this.stopped) return;
    const previousCoreId = this.activeCoreId;
    this.activeCoreId = null;
    if (previousCoreId) this.disconnectCore(previousCoreId);
  }

  public getDiagnosticCoreId(): string | null {
    return this.activeCoreId ?? this.lastCoreId;
  }

  public shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.albumActions?.shutdown();
    } catch (error) {
      this.logger.warn({ err: error }, "Album action shutdown was rejected");
    }
    try {
      this.libraryAlbums?.shutdown();
    } catch (error) {
      this.logger.warn({ err: error }, "Library album shutdown was rejected");
    }
    this.coordinator.shutdown();
  }

  private disconnectCore(coreId: string): void {
    try {
      this.albumActions?.invalidateCore(coreId);
    } catch (error) {
      this.logger.warn(
        { err: error, coreId },
        "Album action Core invalidation was rejected"
      );
    }
    try {
      this.libraryAlbums?.invalidateCore(coreId);
    } catch (error) {
      this.logger.warn(
        { err: error, coreId },
        "Library album Core invalidation was rejected"
      );
    }
    try {
      void this.coordinator.invalidateCore(coreId).catch((error) => {
        this.logger.warn(
          { err: error, coreId },
          "Browse-session invalidation failed"
        );
      });
    } catch (error) {
      this.logger.warn(
        { err: error, coreId },
        "Browse-session invalidation was rejected"
      );
    }
  }
}
