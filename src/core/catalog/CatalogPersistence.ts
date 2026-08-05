import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

export interface CatalogPersistence {
  read(coreId: string): Promise<unknown | null>;
  write(coreId: string, value: unknown): Promise<void>;
}

export interface CatalogPersistenceFileSystem {
  readFile(filePath: string): Promise<Buffer>;
  mkdir(
    directory: string,
    options: { recursive: true; mode: number }
  ): Promise<unknown>;
  writeFile(
    filePath: string,
    data: string,
    options: { encoding: "utf8"; mode: number; flag: "wx" }
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export interface FileCatalogPersistenceOptions {
  directory: string;
  maxBytes?: number;
  createNonce?: () => string;
  fileSystem?: CatalogPersistenceFileSystem;
  /**
   * File name suffix; defaults to `.catalog-v1.json`. Sibling stores (the
   * native album snapshot) pick their own suffix so stores sharing a Core ID
   * never collide on disk.
   */
  fileSuffix?: string;
}

export type CatalogPersistenceErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_CORE_ID"
  | "PAYLOAD_TOO_LARGE";

export class CatalogPersistenceError extends Error {
  public constructor(
    public readonly code: CatalogPersistenceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CatalogPersistenceError";
    Object.setPrototypeOf(this, CatalogPersistenceError.prototype);
    Error.captureStackTrace?.(this, CatalogPersistenceError);
  }
}

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const ABSOLUTE_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_CORE_ID_LENGTH = 2_048;
const CONTROL_CHARACTER = /\p{Cc}/u;
const SAFE_NONCE = /^[a-zA-Z0-9-]+$/u;
const DEFAULT_FILE_SUFFIX = ".catalog-v1.json";
const SAFE_FILE_SUFFIX = /^\.[a-z0-9-]+\.json$/u;

const nodeFileSystem: CatalogPersistenceFileSystem = {
  readFile: (filePath) => fs.readFile(filePath),
  mkdir: (directory, options) => fs.mkdir(directory, options),
  writeFile: (filePath, data, options) => fs.writeFile(filePath, data, options),
  rename: (from, to) => fs.rename(from, to),
  unlink: (filePath) => fs.unlink(filePath),
};

/**
 * Atomic, Core-scoped JSON storage for the Timeline catalog read model.
 *
 * Core IDs are opaque Roon values, so they are hashed rather than interpolated
 * into a path. Schema validation belongs to CatalogService; this class owns
 * only bounded bytes, JSON parsing, and same-directory temp-write/rename.
 */
export class FileCatalogPersistence implements CatalogPersistence {
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly createNonce: () => string;
  private readonly fileSystem: CatalogPersistenceFileSystem;
  private readonly fileSuffix: string;

  public constructor(options: FileCatalogPersistenceOptions) {
    this.directory = path.resolve(options.directory);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.createNonce = options.createNonce ?? randomUUID;
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.fileSuffix = options.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > ABSOLUTE_MAX_BYTES
    ) {
      throw new CatalogPersistenceError(
        "INVALID_CONFIGURATION",
        "Catalog persistence byte limit is invalid"
      );
    }
    if (!SAFE_FILE_SUFFIX.test(this.fileSuffix)) {
      throw new CatalogPersistenceError(
        "INVALID_CONFIGURATION",
        "Catalog persistence file suffix is invalid"
      );
    }
  }

  public async read(coreId: string): Promise<unknown | null> {
    const filePath = this.filePathForCore(coreId);
    let bytes: Buffer;
    try {
      bytes = await this.fileSystem.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new CatalogPersistenceError(
        "PAYLOAD_TOO_LARGE",
        "Persisted catalog exceeds the configured byte limit"
      );
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
  }

  public async write(coreId: string, value: unknown): Promise<void> {
    const filePath = this.filePathForCore(coreId);
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.maxBytes) {
      throw new CatalogPersistenceError(
        "PAYLOAD_TOO_LARGE",
        "Catalog snapshot exceeds the configured byte limit"
      );
    }
    const nonce = this.createNonce();
    if (!SAFE_NONCE.test(nonce)) {
      throw new CatalogPersistenceError(
        "INVALID_CONFIGURATION",
        "Catalog persistence nonce is invalid"
      );
    }
    const temporaryPath = `${filePath}.${process.pid}.${nonce}.tmp`;
    try {
      await this.fileSystem.mkdir(this.directory, {
        recursive: true,
        mode: 0o700,
      });
      await this.fileSystem.writeFile(temporaryPath, payload, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await this.fileSystem.rename(temporaryPath, filePath);
    } catch (error) {
      await this.fileSystem.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  public filePathForCore(coreId: string): string {
    this.assertCoreId(coreId);
    const digest = createHash("sha256").update(coreId, "utf8").digest("hex");
    return path.join(this.directory, `${digest}${this.fileSuffix}`);
  }

  private assertCoreId(coreId: string): void {
    if (
      typeof coreId !== "string" ||
      coreId.length < 1 ||
      coreId.length > MAX_CORE_ID_LENGTH ||
      coreId.trim() !== coreId ||
      CONTROL_CHARACTER.test(coreId)
    ) {
      throw new CatalogPersistenceError(
        "INVALID_CORE_ID",
        "Catalog Core ID is invalid"
      );
    }
  }
}
