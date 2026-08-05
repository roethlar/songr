import type { Logger } from "pino";

export interface CatalogLifecycleService {
  start(coreId: string): Promise<void>;
  markCoreDisconnected(coreId: string): void;
}

export interface CatalogLifecycleCoordinator {
  invalidateCore(coreId: string): Promise<void>;
  shutdown(): void;
}

export interface AlbumActionLifecycleService {
  invalidateCore(coreId: string): void;
  shutdown(): void;
}

export interface TimelineBrowseLifecycleService {
  invalidateCore(coreId: string): void;
  shutdown(): void;
}

export interface LibraryAlbumLifecycleService {
  invalidateCore(coreId: string): void;
  shutdown(): void;
}

/**
 * Captures paired Core identity before RoonClient erases it on unpair and owns
 * the catalog/coordinator side of Core lifecycle transitions.
 */
export class CatalogLifecycle {
  private activeCoreId: string | null = null;
  private lastCoreId: string | null = null;
  private stopped = false;

  public constructor(
    private readonly catalogService: CatalogLifecycleService,
    private readonly coordinator: CatalogLifecycleCoordinator,
    private readonly logger: Logger,
    private readonly albumActions?: AlbumActionLifecycleService,
    private readonly timelineBrowse?: TimelineBrowseLifecycleService,
    private readonly libraryAlbums?: LibraryAlbumLifecycleService
  ) {}

  public corePaired(coreId: string): void {
    if (this.stopped) return;

    let start: Promise<void>;
    try {
      start = this.catalogService.start(coreId);
    } catch (error) {
      this.logger.warn({ err: error }, "Catalog Core activation was rejected");
      return;
    }

    const previousCoreId = this.activeCoreId;
    this.activeCoreId = coreId;
    this.lastCoreId = coreId;
    if (previousCoreId && previousCoreId !== coreId) {
      this.disconnectCore(previousCoreId);
    }
    void start.catch((error) => {
      this.logger.warn(
        { err: error, coreId },
        "Catalog persisted-state startup failed"
      );
    });
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
      this.timelineBrowse?.shutdown();
    } catch (error) {
      this.logger.warn({ err: error }, "Timeline browse shutdown was rejected");
    }
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
      this.timelineBrowse?.invalidateCore(coreId);
    } catch (error) {
      this.logger.warn(
        { err: error, coreId },
        "Timeline browse Core invalidation was rejected"
      );
    }
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
    this.catalogService.markCoreDisconnected(coreId);
    try {
      void this.coordinator.invalidateCore(coreId).catch((error) => {
        this.logger.warn(
          { err: error, coreId },
          "Catalog browse-session invalidation failed"
        );
      });
    } catch (error) {
      this.logger.warn(
        { err: error, coreId },
        "Catalog browse-session invalidation was rejected"
      );
    }
  }
}
