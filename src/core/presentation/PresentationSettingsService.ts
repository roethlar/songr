import { EventEmitter } from "events";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { Logger } from "pino";
import {
  DEFAULT_PRESENTATION_SETTINGS,
  parsePresentationSettingsSnapshot,
  parsePresentationSettingsUpdate,
  type PresentationSettingsSnapshot,
} from "../../shared/presentationSettings";

export class PresentationSettingsUnavailableError extends Error {
  constructor() {
    super("Presentation settings unavailable (persistence degraded)");
  }
}

export class PresentationSettingsInputError extends Error {
  constructor() {
    super("Invalid presentation settings update");
  }
}

export class PresentationSettingsConflictError extends Error {
  constructor(public readonly current: PresentationSettingsSnapshot) {
    super("Presentation settings changed on another client");
  }
}

export class PresentationSettingsPersistenceError extends Error {
  constructor() {
    super("Presentation settings could not be saved");
  }
}

function copy(snapshot: PresentationSettingsSnapshot): PresentationSettingsSnapshot {
  return { ...snapshot };
}

/** One committed presentation configuration for every client of this server. */
export class PresentationSettingsService extends EventEmitter {
  private snapshot = copy(DEFAULT_PRESENTATION_SETTINGS);
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
      const snapshot = parsePresentationSettingsSnapshot(raw);
      if (!snapshot) throw new Error("Persisted presentation settings shape is invalid");
      this.snapshot = snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.degraded = true;
        this.logger.warn(
          { err: error, filePath: this.filePath },
          "Presentation settings unavailable; persisted file left untouched"
        );
      }
    }
    this.ready = true;
  }

  public getSnapshot(): PresentationSettingsSnapshot {
    if (!this.ready || this.degraded) throw new PresentationSettingsUnavailableError();
    return copy(this.snapshot);
  }

  public update(value: unknown): Promise<PresentationSettingsSnapshot> {
    // Normalize before enqueuing so a caller cannot mutate the queued input.
    const input = parsePresentationSettingsUpdate(value);
    if (!input) return Promise.reject(new PresentationSettingsInputError());
    const operation = async (): Promise<PresentationSettingsSnapshot> => {
      await this.start();
      const current = this.getSnapshot();
      if (input.expectedRevision !== current.revision) {
        throw new PresentationSettingsConflictError(current);
      }
      if (
        input.actionDisplay === current.actionDisplay &&
        input.smoothScroll === current.smoothScroll && input.interfaceMotion === current.interfaceMotion
      ) return current;
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new PresentationSettingsPersistenceError();
      }
      const next: PresentationSettingsSnapshot = {
        version: 1,
        revision: current.revision + 1,
        actionDisplay: input.actionDisplay,
        smoothScroll: input.smoothScroll,
        interfaceMotion: input.interfaceMotion,
      };
      await this.persist(next);
      // Readers and subscribers must never see a configuration that failed to save.
      this.snapshot = next;
      try {
        this.emit("updated", copy(next));
      } catch (error) {
        // Persistence already committed: a subscriber failure must not turn a
        // successful save into a retry that reports a misleading conflict.
        this.logger.error({ err: error }, "Presentation settings subscriber failed");
      }
      return copy(next);
    };
    const run = this.operations.then(operation, operation);
    this.operations = run.catch(() => undefined);
    return run;
  }

  private async persist(snapshot: PresentationSettingsSnapshot): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), "utf-8");
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      this.logger.warn({ err: error }, "Presentation settings save failed; committed state retained");
      throw new PresentationSettingsPersistenceError();
    }
  }
}
