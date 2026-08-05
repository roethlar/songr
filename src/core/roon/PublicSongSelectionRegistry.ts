import { randomUUID } from "crypto";

export const DEFAULT_PUBLIC_SONG_SELECTION_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_PUBLIC_SONG_SELECTION_LIMIT = 4_096;

const MAX_TEXT_LENGTH = 512;
const MAX_ID_LENGTH = 128;
const CONTROL_CHARACTER = /\p{Cc}/u;
const DECIMAL_ID = /^[1-9][0-9]*$/u;
const PLAYLIST_ID = /^[0-9a-f]+$/u;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type PublicSongSelectionSource =
  | {
      kind: "smart-playlist";
      playlistId: string;
      position: number;
      playlistItemId: string | null;
      nativeTrackId: string | null;
    }
  | {
      kind: "manual-playlist";
      playlistId: string;
      position: number;
    }
  | {
      kind: "most-played";
      snapshotPulledAt: string;
      view: "tracks" | "performer" | "release";
      sourceEntityId: string;
      /**
       * Null only for a performer/release drill anchor. Track rows in every
       * Most Played view retain their positive native track identity.
       */
      nativeTrackId: string | null;
    };

export interface PublicSongSelection {
  coreId: string;
  title: string;
  artist: string;
  albumTitle: string;
  lengthSeconds: number | null;
  source: PublicSongSelectionSource;
}

export interface PublicSongSelectionIssue {
  selectionId: string;
  issueId: string;
  selection: Readonly<PublicSongSelection>;
}

export type PublicSongSelectionRegistryErrorCode =
  | "INVALID_SELECTION"
  | "STALE_SELECTION"
  | "CORE_MISMATCH"
  | "IN_FLIGHT"
  | "BACKPRESSURE"
  | "ISSUE_MISMATCH";

export class PublicSongSelectionRegistryError extends Error {
  public constructor(
    public readonly code: PublicSongSelectionRegistryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PublicSongSelectionRegistryError";
    Object.setPrototypeOf(this, PublicSongSelectionRegistryError.prototype);
    Error.captureStackTrace?.(this, PublicSongSelectionRegistryError);
  }
}

export interface PublicSongSelectionRegistryOptions {
  ttlMs?: number;
  /** Maximum live selections retained independently for each Core. */
  maxEntries?: number;
  now?: () => number;
  randomId?: () => string;
}

interface AvailableEntry {
  state: "available";
  selection: Readonly<PublicSongSelection>;
  createdAt: number;
  expiresAt: number;
}

interface IssuingEntry {
  state: "issuing";
  selection: Readonly<PublicSongSelection>;
  createdAt: number;
  expiresAt: number;
  issueId: string;
}

type Entry = AvailableEntry | IssuingEntry;

function boundedText(value: unknown, allowEmpty: boolean): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= MAX_TEXT_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}

function decimalId(value: unknown): value is string {
  return boundedId(value) && DECIMAL_ID.test(value);
}

function playlistId(value: unknown): value is string {
  return (
    boundedId(value) &&
    value.length % 2 === 0 &&
    PLAYLIST_ID.test(value)
  );
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validSource(value: PublicSongSelectionSource): boolean {
  if (!value || typeof value !== "object") return false;
  if (value.kind === "smart-playlist") {
    return (
      playlistId(value.playlistId) &&
      nonNegativeInteger(value.position) &&
      (value.playlistItemId === null || decimalId(value.playlistItemId)) &&
      (value.nativeTrackId === null || decimalId(value.nativeTrackId))
    );
  }
  if (value.kind === "manual-playlist") {
    return playlistId(value.playlistId) && nonNegativeInteger(value.position);
  }
  if (value.kind === "most-played") {
    return (
      canonicalTimestamp(value.snapshotPulledAt) &&
      (value.view === "tracks" ||
        value.view === "performer" ||
        value.view === "release") &&
      decimalId(value.sourceEntityId) &&
      (value.nativeTrackId === null
        ? value.view === "performer" || value.view === "release"
        : decimalId(value.nativeTrackId))
    );
  }
  return false;
}

function normalizedSelection(
  value: PublicSongSelection
): Readonly<PublicSongSelection> | null {
  if (
    !value ||
    typeof value !== "object" ||
    !boundedId(value.coreId) ||
    !boundedText(value.title, false) ||
    !boundedText(value.artist, true) ||
    !boundedText(value.albumTitle, true) ||
    (value.lengthSeconds !== null &&
      !nonNegativeInteger(value.lengthSeconds)) ||
    !validSource(value.source) ||
    (value.source.kind === "smart-playlist" &&
      value.source.playlistItemId === null &&
      value.source.nativeTrackId === null &&
      (!boundedText(value.artist, false) ||
        !boundedText(value.albumTitle, false) ||
        value.lengthSeconds === null))
  ) {
    return null;
  }
  const source = Object.freeze({ ...value.source });
  return Object.freeze({
    coreId: value.coreId,
    title: value.title,
    artist: value.artist,
    albumTitle: value.albumTitle,
    lengthSeconds: value.lengthSeconds,
    source,
  });
}

/**
 * Bounded, in-memory authority for a displayed track row or Most Played
 * performer/release drill anchor.
 *
 * Browser-visible selection IDs carry no Roon item key and no native object
 * id. The retained source proof is immutable, Core-scoped, short-lived, and
 * single-flight once a song action starts. Old available entries may be
 * evicted under pressure; issuing entries are never displaced.
 */
export class PublicSongSelectionRegistry {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly entries = new Map<string, Entry>();
  private nonce = 0;

  public constructor(options: PublicSongSelectionRegistryOptions = {}) {
    this.ttlMs =
      options.ttlMs ?? DEFAULT_PUBLIC_SONG_SELECTION_TTL_MS;
    this.maxEntries =
      options.maxEntries ?? DEFAULT_PUBLIC_SONG_SELECTION_LIMIT;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new PublicSongSelectionRegistryError(
        "INVALID_SELECTION",
        "selection TTL must be a positive safe integer"
      );
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new PublicSongSelectionRegistryError(
        "INVALID_SELECTION",
        "selection limit must be a positive safe integer"
      );
    }
  }

  public publish(selection: PublicSongSelection): string {
    const normalized = normalizedSelection(selection);
    if (!normalized) {
      throw new PublicSongSelectionRegistryError(
        "INVALID_SELECTION",
        "refusing to publish an invalid public-song selection"
      );
    }
    const now = this.now();
    this.pruneExpired(now);
    this.makeRoom(normalized.coreId);
    const selectionId = this.uniqueId("public-song-selection");
    this.entries.set(selectionId, {
      state: "available",
      selection: normalized,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
    return selectionId;
  }

  public resolve(
    selectionId: string,
    expectedCoreId: string
  ): Readonly<PublicSongSelection> {
    return this.requireAvailable(selectionId, expectedCoreId).selection;
  }

  public beginIssue(
    selectionId: string,
    expectedCoreId: string
  ): PublicSongSelectionIssue {
    const entry = this.requireAvailable(selectionId, expectedCoreId);
    const issueId = this.uniqueId("public-song-issue");
    this.entries.set(selectionId, {
      ...entry,
      state: "issuing",
      issueId,
    });
    return Object.freeze({
      selectionId,
      issueId,
      selection: entry.selection,
    });
  }

  /** Retire a displayed source that a fresh read proved stale or unavailable. */
  public invalidate(selectionId: string, expectedCoreId: string): void {
    this.requireAvailable(selectionId, expectedCoreId);
    this.entries.delete(selectionId);
  }

  /** Exact-handoff assertion for an issue lease retained by an action. */
  public assertIssue(
    issue: PublicSongSelectionIssue
  ): Readonly<PublicSongSelection> {
    return this.requireIssue(issue).selection;
  }

  /**
   * A failure before the Roon action boundary restores the selection when its
   * original TTL is still live. Once expired, it remains stale.
   */
  public restore(issue: PublicSongSelectionIssue): boolean {
    const entry = this.requireIssue(issue);
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(issue.selectionId);
      return false;
    }
    this.entries.set(issue.selectionId, {
      state: "available",
      selection: entry.selection,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    });
    return true;
  }

  /** Success, issued failure, and outcome-unknown all retire the source. */
  public retire(issue: PublicSongSelectionIssue): void {
    this.requireIssue(issue);
    this.entries.delete(issue.selectionId);
  }

  public clearCore(coreId: string): void {
    for (const [selectionId, entry] of this.entries) {
      if (entry.selection.coreId === coreId) {
        this.entries.delete(selectionId);
      }
    }
  }

  public get size(): number {
    this.pruneExpired(this.now());
    return this.entries.size;
  }

  private requireAvailable(
    selectionId: string,
    expectedCoreId: string
  ): AvailableEntry {
    if (!boundedId(selectionId) || !boundedId(expectedCoreId)) {
      throw this.stale();
    }
    const entry = this.entries.get(selectionId);
    if (!entry) throw this.stale();
    if (entry.selection.coreId !== expectedCoreId) {
      throw new PublicSongSelectionRegistryError(
        "CORE_MISMATCH",
        "the track selection belongs to a different Core"
      );
    }
    if (entry.state === "issuing") {
      throw new PublicSongSelectionRegistryError(
        "IN_FLIGHT",
        "the track selection already has an action in flight"
      );
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(selectionId);
      throw this.stale();
    }
    return entry;
  }

  private requireIssue(issue: PublicSongSelectionIssue): IssuingEntry {
    const entry = this.entries.get(issue.selectionId);
    if (
      !entry ||
      entry.state !== "issuing" ||
      entry.issueId !== issue.issueId ||
      entry.selection !== issue.selection
    ) {
      throw new PublicSongSelectionRegistryError(
        "ISSUE_MISMATCH",
        "the public-song issue lease is no longer current"
      );
    }
    return entry;
  }

  private pruneExpired(now: number): void {
    for (const [selectionId, entry] of this.entries) {
      if (entry.state === "available" && entry.expiresAt <= now) {
        this.entries.delete(selectionId);
      }
    }
  }

  private makeRoom(coreId: string): void {
    const coreEntries = (): [string, Entry][] =>
      [...this.entries.entries()].filter(
        ([, entry]) => entry.selection.coreId === coreId
      );
    while (coreEntries().length >= this.maxEntries) {
      const oldestAvailable = [...this.entries.entries()]
        .filter(
          ([, entry]) =>
            entry.selection.coreId === coreId && entry.state === "available"
        )
        .sort(
          ([aId, a], [bId, b]) =>
            a.createdAt - b.createdAt || aId.localeCompare(bId)
        )[0];
      if (!oldestAvailable) {
        throw new PublicSongSelectionRegistryError(
          "BACKPRESSURE",
          "all public-song selection capacity is in flight"
        );
      }
      this.entries.delete(oldestAvailable[0]);
    }
  }

  private uniqueId(prefix: string): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      this.nonce += 1;
      const id = `${prefix}-${this.randomId()}-${this.nonce}`;
      if (id.length <= MAX_ID_LENGTH && !this.entries.has(id)) return id;
    }
    throw new PublicSongSelectionRegistryError(
      "BACKPRESSURE",
      "could not allocate a unique public-song authority id"
    );
  }

  private stale(): PublicSongSelectionRegistryError {
    return new PublicSongSelectionRegistryError(
      "STALE_SELECTION",
      "the track selection expired; refresh the list"
    );
  }
}
