import { EventEmitter } from "events";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { Logger } from "pino";
import {
  DEFAULT_NAVIGATION_SETTINGS,
  parseNavigationSettingsSnapshot,
  parseNavigationSettingsUpdate,
  type NavigationSettingsSnapshot,
} from "../../shared/navigationSettings";

export class NavigationSettingsUnavailableError extends Error {
  constructor() {
    super("Navigation settings unavailable (persistence degraded)");
  }
}

export class NavigationSettingsInputError extends Error {
  constructor() {
    super("Invalid navigation settings update");
  }
}

export class NavigationSettingsConflictError extends Error {
  constructor(public readonly current: NavigationSettingsSnapshot) {
    super("Navigation settings changed on another client");
  }
}

export class NavigationSettingsPersistenceError extends Error {
  constructor() {
    super("Navigation settings could not be saved");
  }
}

function copy(snapshot: NavigationSettingsSnapshot): NavigationSettingsSnapshot {
  return { ...snapshot, order: [...snapshot.order], pinned: [...snapshot.pinned] };
}

/** One committed navigation configuration for every client of this server. */
export class NavigationSettingsService extends EventEmitter {
  private snapshot = copy(DEFAULT_NAVIGATION_SETTINGS);
  private ready = false;
  private degraded = false;
  private startPromise: Promise<void> | null = null;
  private operations: Promise<unknown> = Promise.resolve();
  private readonly filePath: string;

  constructor(private readonly logger: Logger, options: { filePath: string }) {
    super();
    this.filePath = options.filePath;
  }

  public start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.load();
    return this.startPromise;
  }

  private async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.filePath, "utf-8"));
      const snapshot = parseNavigationSettingsSnapshot(raw);
      if (!snapshot) throw new Error("Persisted navigation settings shape is invalid");
      this.snapshot = snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.degraded = true;
        this.logger.warn(
          { err: error, filePath: this.filePath },
          "Navigation settings unavailable; persisted file left untouched"
        );
      }
    }
    this.ready = true;
  }

  public getSnapshot(): NavigationSettingsSnapshot {
    if (!this.ready || this.degraded) throw new NavigationSettingsUnavailableError();
    return copy(this.snapshot);
  }

  public update(value: unknown): Promise<NavigationSettingsSnapshot> {
    // Normalize before enqueuing so a caller cannot mutate the queued input.
    const input = parseNavigationSettingsUpdate(value);
    if (!input) return Promise.reject(new NavigationSettingsInputError());
    const operation = async (): Promise<NavigationSettingsSnapshot> => {
      await this.start();
      const current = this.getSnapshot();
      if (input.expectedRevision !== current.revision) {
        throw new NavigationSettingsConflictError(current);
      }
      if (
        JSON.stringify(input.order) === JSON.stringify(current.order) &&
        JSON.stringify(input.pinned) === JSON.stringify(current.pinned)
      ) return current;
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new NavigationSettingsPersistenceError();
      }
      const next: NavigationSettingsSnapshot = {
        version: 1,
        revision: current.revision + 1,
        order: [...input.order],
        pinned: [...input.pinned],
      };
      await this.persist(next);
      // Readers and subscribers must never see a configuration that failed to save.
      this.snapshot = next;
      try {
        this.emit("updated", copy(next));
      } catch (error) {
        // Persistence already committed: a subscriber failure must not turn a
        // successful save into a retry that reports a misleading conflict.
        this.logger.error({ err: error }, "Navigation settings subscriber failed");
      }
      return copy(next);
    };
    const run = this.operations.then(operation, operation);
    this.operations = run.catch(() => undefined);
    return run;
  }

  private async persist(snapshot: NavigationSettingsSnapshot): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), "utf-8");
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      this.logger.warn({ err: error }, "Navigation settings save failed; committed state retained");
      throw new NavigationSettingsPersistenceError();
    }
  }
}
