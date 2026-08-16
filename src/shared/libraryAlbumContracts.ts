/**
 * Strict, keyless wire contracts for the library-album read path. Albums,
 * artists, and tracks are display data only; no browse item keys, zone
 * authority, or action authority ever cross this boundary.
 */

export const ALBUM_DETAIL_MAX_TRACKS = 500;

export const LIBRARY_ALBUM_ID_MAX_LENGTH = 128;
export const LIBRARY_ALBUM_TEXT_MAX_LENGTH = 256;
export const LIBRARY_ALBUM_ERROR_MAX_LENGTH = 1024;
export const LIBRARY_ALBUM_MAX_TRACKS = ALBUM_DETAIL_MAX_TRACKS;
export const LIBRARY_ALBUM_MAX_VERSIONS = 32;

export const LIBRARY_ALBUM_OPEN_ERROR_CODES = [
  "INVALID_REQUEST",
  "BACKPRESSURE",
  "REQUEST_ID_CONFLICT",
] as const;

export type LibraryAlbumOpenErrorCode =
  (typeof LIBRARY_ALBUM_OPEN_ERROR_CODES)[number];

export const LIBRARY_ALBUM_FAILURE_CODES = [
  "ALBUM_NOT_FOUND",
  "ALBUM_AMBIGUOUS",
  "DETAIL_INCOMPLETE",
  "DETAIL_MISMATCH",
  "RESOLUTION_TIMEOUT",
  "SUPERSEDED",
  "CANCELED",
  "SESSION_LOST",
  "INTERNAL_ERROR",
] as const;

export type LibraryAlbumFailureCode =
  (typeof LIBRARY_ALBUM_FAILURE_CODES)[number];

/** One page-scoped live version; versionId is opaque outside the server. */
export interface LibraryAlbumVersionSummary {
  versionId: string;
  /** Live edition qualifier; empty when Roon exposes none. */
  editionText: string;
  /** Display-only artwork hint; never version identity. */
  imageKeyHint?: string;
  /** Product-facing source label when the page has exact version evidence. */
  sourceLabel?: string;
  /** Bounded display date (`YYYY`, `YYYY-MM`, or `YYYY-MM-DD`). */
  releaseDate?: string;
  /** Detail-derived fields are absent until an exact listing has been read. */
  trackCount?: number;
  durationSeconds?: number;
  available?: boolean;
  /** Optional selected-profile metadata from an installed feature layer. */
  playCount?: number;
  lastPlayedAt?: string;
  isFavorite?: boolean;
  isListenLater?: boolean;
  isBanned?: boolean;
}

export interface LibraryAlbumOpenRequest {
  requestId: string;
  tabId: string;
  albumLocalId: string;
  generation: number;
}

export interface LibraryAlbumOpenAcceptedData {
  requestId: string;
  operationId: string;
  resolvingDeadlineAt: number;
}

export type LibraryAlbumOpenAck =
  | { success: true; data: LibraryAlbumOpenAcceptedData }
  | { success: false; error: string; code: LibraryAlbumOpenErrorCode };

export interface LibraryAlbumSelectRequest {
  operationId: string;
  versionId: string;
}

export interface LibraryAlbumSelectAcceptedData {
  operationId: string;
  versionId: string;
  resolvingDeadlineAt: number;
}

export type LibraryAlbumSelectAck =
  | { success: true; data: LibraryAlbumSelectAcceptedData }
  | {
      success: false;
      error: string;
      code: "INVALID_REQUEST" | "BACKPRESSURE" | "SESSION_LOST";
    };

export interface LibraryAlbumTrack {
  /** Zero-based, contiguous position in the album's play order. */
  index: number;
  title: string;
  /** Exact version metadata when the installed feature layer supplied it. */
  trackNumber?: number;
  mediaNumber?: number;
  lengthSeconds?: number | null;
  available?: boolean;
}

export interface LibraryAlbumCorrelation {
  requestId: string;
  operationId: string;
  generation: number;
  resolvingDeadlineAt: number;
}

export interface LibraryAlbumVersionsEvent {
  requestId: string;
  operationId: string;
  generation: number;
  artist: string;
  title: string;
  versions: readonly LibraryAlbumVersionSummary[];
}

export interface LibraryAlbumResolvedEvent {
  requestId: string;
  operationId: string;
  generation: number;
  versionId: string;
  artist: string;
  title: string;
  /** True only when public Browse authority can back album/track actions. */
  actionsAvailable: boolean;
  /** Updated selected-version summary. */
  versionSummary: LibraryAlbumVersionSummary;
  orderedTracks: readonly LibraryAlbumTrack[];
}

export interface LibraryAlbumFailedEvent {
  requestId: string;
  operationId: string;
  generation: number;
  resolvingDeadlineAt: number;
  error: string;
  code: LibraryAlbumFailureCode;
}

export interface LibraryAlbumVersionFailedEvent extends LibraryAlbumFailedEvent {
  versionId: string;
}

export type LibraryAlbumCancelRequest =
  | { requestId: string }
  | { operationId: string };

export type LibraryAlbumCancelAck =
  | { success: true; data: { claimed: boolean } }
  | { success: false; error: string; code: "INVALID_REQUEST" };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;

function plainDataRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const ownKeys = Reflect.ownKeys(record);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string" && keys.includes(key))
  );
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  const ownKeys = Reflect.ownKeys(record);
  return (
    required.every((key) => ownKeys.includes(key)) &&
    ownKeys.every(
      (key) =>
        typeof key === "string" &&
        (required.includes(key) || optional.includes(key))
    )
  );
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= LIBRARY_ALBUM_ID_MAX_LENGTH &&
    OPAQUE_ID.test(value)
  );
}

function isLocalId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDeadline(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !CONTROL_CHARACTER.test(value)
  );
}

/** Like isBoundedText, but the empty string is a legal value. */
function isBoundedOptionalText(value: unknown, maxLength: number): value is string {
  return (
    value === "" || (typeof value === "string" && isBoundedText(value, maxLength))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedCount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= LIBRARY_ALBUM_MAX_TRACKS
  );
}

function isBoundedDuration(value: unknown): value is number {
  return Number.isFinite(value) && (value as number) >= 0 && (value as number) <= 31_536_000;
}

function isReleaseDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  return (
    year >= 1 &&
    year <= 9999 &&
    (month === undefined || (month >= 1 && month <= 12)) &&
    (day === undefined || (day >= 1 && day <= 31))
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function includes<T extends string>(
  values: readonly T[],
  value: unknown
): value is T {
  return values.some((candidate) => candidate === value);
}

function isCorrelation(value: LibraryAlbumCorrelation): boolean {
  return (
    isOpaqueId(value.requestId) &&
    isOpaqueId(value.operationId) &&
    isGeneration(value.generation) &&
    isDeadline(value.resolvingDeadlineAt)
  );
}

export function normalizeLibraryAlbumVersionSummary(
  value: unknown
): LibraryAlbumVersionSummary | null {
  try {
    const record = plainDataRecord(value);
    const optionalKeys = [
      "imageKeyHint",
      "sourceLabel",
      "releaseDate",
      "trackCount",
      "durationSeconds",
      "available",
      "playCount",
      "lastPlayedAt",
      "isFavorite",
      "isListenLater",
      "isBanned",
    ] as const;
    if (
      !record ||
      !hasOnlyKeys(record, ["versionId", "editionText"], optionalKeys) ||
      !isOpaqueId(record.versionId) ||
      !isBoundedOptionalText(record.editionText, LIBRARY_ALBUM_TEXT_MAX_LENGTH) ||
      ("imageKeyHint" in record &&
        !isBoundedText(record.imageKeyHint, LIBRARY_ALBUM_ID_MAX_LENGTH)) ||
      ("sourceLabel" in record &&
        !isBoundedText(record.sourceLabel, LIBRARY_ALBUM_TEXT_MAX_LENGTH)) ||
      ("releaseDate" in record && !isReleaseDate(record.releaseDate)) ||
      ("trackCount" in record && !isBoundedCount(record.trackCount)) ||
      ("durationSeconds" in record &&
        !isBoundedDuration(record.durationSeconds)) ||
      ("available" in record && typeof record.available !== "boolean") ||
      ("playCount" in record && !isNonNegativeInteger(record.playCount)) ||
      ("lastPlayedAt" in record &&
        !isCanonicalTimestamp(record.lastPlayedAt)) ||
      ("isFavorite" in record && typeof record.isFavorite !== "boolean") ||
      ("isListenLater" in record &&
        typeof record.isListenLater !== "boolean") ||
      ("isBanned" in record && typeof record.isBanned !== "boolean")
    ) {
      return null;
    }
    return {
      versionId: record.versionId,
      editionText: record.editionText,
      ...("imageKeyHint" in record
        ? { imageKeyHint: record.imageKeyHint as string }
        : {}),
      ...("sourceLabel" in record
        ? { sourceLabel: record.sourceLabel as string }
        : {}),
      ...("releaseDate" in record
        ? { releaseDate: record.releaseDate as string }
        : {}),
      ...("trackCount" in record
        ? { trackCount: record.trackCount as number }
        : {}),
      ...("durationSeconds" in record
        ? { durationSeconds: record.durationSeconds as number }
        : {}),
      ...("available" in record
        ? { available: record.available as boolean }
        : {}),
      ...("playCount" in record
        ? { playCount: record.playCount as number }
        : {}),
      ...("lastPlayedAt" in record
        ? { lastPlayedAt: record.lastPlayedAt as string }
        : {}),
      ...("isFavorite" in record
        ? { isFavorite: record.isFavorite as boolean }
        : {}),
      ...("isListenLater" in record
        ? { isListenLater: record.isListenLater as boolean }
        : {}),
      ...("isBanned" in record
        ? { isBanned: record.isBanned as boolean }
        : {}),
    };
  } catch {
    return null;
  }
}

const LIBRARY_ALBUM_OPEN_KEYS = [
  "requestId",
  "tabId",
  "albumLocalId",
  "generation",
] as const;

export function normalizeLibraryAlbumOpenRequest(
  value: unknown
): LibraryAlbumOpenRequest | null {
  try {
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [...LIBRARY_ALBUM_OPEN_KEYS]) ||
      !isOpaqueId(record.requestId) ||
      !isOpaqueId(record.tabId) ||
      !isLocalId(record.albumLocalId) ||
      !isGeneration(record.generation)
    ) {
      return null;
    }
    return {
      requestId: record.requestId,
      tabId: record.tabId,
      albumLocalId: record.albumLocalId,
      generation: record.generation,
    };
  } catch {
    return null;
  }
}

export function normalizeLibraryAlbumOpenAck(
  value: unknown,
  expectedRequestId: string
): LibraryAlbumOpenAck | null {
  try {
    if (!isOpaqueId(expectedRequestId)) return null;
    const record = plainDataRecord(value);
    if (!record) return null;
    if (record.success === true) {
      if (!hasExactKeys(record, ["success", "data"])) return null;
      const data = plainDataRecord(record.data);
      if (
        !data ||
        !hasExactKeys(data, ["requestId", "operationId", "resolvingDeadlineAt"]) ||
        data.requestId !== expectedRequestId ||
        !isOpaqueId(data.operationId) ||
        !isDeadline(data.resolvingDeadlineAt)
      ) {
        return null;
      }
      return {
        success: true,
        data: {
          requestId: expectedRequestId,
          operationId: data.operationId,
          resolvingDeadlineAt: data.resolvingDeadlineAt,
        },
      };
    }
    if (
      record.success === false &&
      hasExactKeys(record, ["success", "error", "code"]) &&
      isBoundedText(record.error, LIBRARY_ALBUM_ERROR_MAX_LENGTH) &&
      includes(LIBRARY_ALBUM_OPEN_ERROR_CODES, record.code)
    ) {
      return { success: false, error: record.error, code: record.code };
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeLibraryAlbumSelectRequest(
  value: unknown
): LibraryAlbumSelectRequest | null {
  try {
    const record = plainDataRecord(value);
    return record &&
      hasExactKeys(record, ["operationId", "versionId"]) &&
      isOpaqueId(record.operationId) &&
      isOpaqueId(record.versionId)
      ? { operationId: record.operationId, versionId: record.versionId }
      : null;
  } catch {
    return null;
  }
}

export function normalizeLibraryAlbumSelectAck(
  value: unknown,
  expected: { operationId: string; versionId: string }
): LibraryAlbumSelectAck | null {
  try {
    if (!isOpaqueId(expected.operationId) || !isOpaqueId(expected.versionId)) {
      return null;
    }
    const record = plainDataRecord(value);
    if (!record) return null;
    if (record.success === true) {
      if (!hasExactKeys(record, ["success", "data"])) return null;
      const data = plainDataRecord(record.data);
      return data &&
        hasExactKeys(data, ["operationId", "versionId", "resolvingDeadlineAt"]) &&
        data.operationId === expected.operationId &&
        data.versionId === expected.versionId &&
        isDeadline(data.resolvingDeadlineAt)
        ? {
            success: true,
            data: {
              operationId: expected.operationId,
              versionId: expected.versionId,
              resolvingDeadlineAt: data.resolvingDeadlineAt,
            },
          }
        : null;
    }
    return record.success === false &&
      hasExactKeys(record, ["success", "error", "code"]) &&
      isBoundedText(record.error, LIBRARY_ALBUM_ERROR_MAX_LENGTH) &&
      includes(
        ["INVALID_REQUEST", "BACKPRESSURE", "SESSION_LOST"] as const,
        record.code
      )
      ? {
          success: false,
          error: record.error,
          code: record.code,
        }
      : null;
  } catch {
    return null;
  }
}

function normalizeOrderedTracks(value: unknown): LibraryAlbumTrack[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > LIBRARY_ALBUM_MAX_TRACKS
  ) {
    return null;
  }
  const tracks: LibraryAlbumTrack[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return null;
    const record = plainDataRecord(value[index]);
    if (
      !record ||
      !hasOnlyKeys(record, ["index", "title"], [
        "trackNumber",
        "mediaNumber",
        "lengthSeconds",
        "available",
      ]) ||
      record.index !== index ||
      !isBoundedText(record.title, LIBRARY_ALBUM_TEXT_MAX_LENGTH) ||
      ("trackNumber" in record && !isNonNegativeInteger(record.trackNumber)) ||
      ("mediaNumber" in record && !isNonNegativeInteger(record.mediaNumber)) ||
      ("lengthSeconds" in record &&
        record.lengthSeconds !== null &&
        !isBoundedDuration(record.lengthSeconds)) ||
      ("available" in record && typeof record.available !== "boolean")
    ) {
      return null;
    }
    tracks.push({
      index,
      title: record.title,
      ...("trackNumber" in record
        ? { trackNumber: record.trackNumber as number }
        : {}),
      ...("mediaNumber" in record
        ? { mediaNumber: record.mediaNumber as number }
        : {}),
      ...("lengthSeconds" in record
        ? { lengthSeconds: record.lengthSeconds as number | null }
        : {}),
      ...("available" in record
        ? { available: record.available as boolean }
        : {}),
    });
  }
  return tracks;
}

function normalizeVersions(value: unknown): LibraryAlbumVersionSummary[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > LIBRARY_ALBUM_MAX_VERSIONS
  ) {
    return null;
  }
  const versions: LibraryAlbumVersionSummary[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return null;
    const version = normalizeLibraryAlbumVersionSummary(value[index]);
    if (!version || seen.has(version.versionId)) return null;
    seen.add(version.versionId);
    versions.push(version);
  }
  return versions;
}

export function normalizeLibraryAlbumVersionsEvent(
  value: unknown,
  expected: LibraryAlbumCorrelation
): LibraryAlbumVersionsEvent | null {
  try {
    if (!isCorrelation(expected)) return null;
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "operationId",
        "generation",
        "artist",
        "title",
        "versions",
      ]) ||
      record.requestId !== expected.requestId ||
      record.operationId !== expected.operationId ||
      record.generation !== expected.generation ||
      !isBoundedText(record.artist, LIBRARY_ALBUM_TEXT_MAX_LENGTH) ||
      !isBoundedText(record.title, LIBRARY_ALBUM_TEXT_MAX_LENGTH)
    ) {
      return null;
    }
    const versions = normalizeVersions(record.versions);
    return versions
      ? {
          requestId: expected.requestId,
          operationId: expected.operationId,
          generation: expected.generation,
          artist: record.artist,
          title: record.title,
          versions,
        }
      : null;
  } catch {
    return null;
  }
}

export function normalizeLibraryAlbumResolvedEvent(
  value: unknown,
  expected: LibraryAlbumCorrelation
): LibraryAlbumResolvedEvent | null {
  try {
    if (!isCorrelation(expected)) return null;
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "operationId",
        "generation",
        "versionId",
        "artist",
        "title",
        "actionsAvailable",
        "versionSummary",
        "orderedTracks",
      ]) ||
      record.requestId !== expected.requestId ||
      record.operationId !== expected.operationId ||
      record.generation !== expected.generation ||
      !isOpaqueId(record.versionId) ||
      !isBoundedText(record.artist, LIBRARY_ALBUM_TEXT_MAX_LENGTH) ||
      !isBoundedText(record.title, LIBRARY_ALBUM_TEXT_MAX_LENGTH) ||
      typeof record.actionsAvailable !== "boolean"
    ) {
      return null;
    }
    const orderedTracks = normalizeOrderedTracks(record.orderedTracks);
    const versionSummary = normalizeLibraryAlbumVersionSummary(record.versionSummary);
    if (!versionSummary || versionSummary.versionId !== record.versionId) {
      return null;
    }
    return orderedTracks
      ? {
          requestId: expected.requestId,
          operationId: expected.operationId,
          generation: expected.generation,
          versionId: record.versionId,
          artist: record.artist,
          title: record.title,
          actionsAvailable: record.actionsAvailable,
          versionSummary,
          orderedTracks,
        }
      : null;
  } catch {
    return null;
  }
}

const LIBRARY_ALBUM_FAILED_KEYS = [
  "requestId",
  "operationId",
  "generation",
  "resolvingDeadlineAt",
  "error",
  "code",
] as const;

export function normalizeLibraryAlbumFailedEvent(
  value: unknown,
  expected: LibraryAlbumCorrelation
): LibraryAlbumFailedEvent | null {
  try {
    if (!isCorrelation(expected)) return null;
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [...LIBRARY_ALBUM_FAILED_KEYS]) ||
      record.requestId !== expected.requestId ||
      record.operationId !== expected.operationId ||
      record.generation !== expected.generation ||
      record.resolvingDeadlineAt !== expected.resolvingDeadlineAt ||
      !isBoundedText(record.error, LIBRARY_ALBUM_ERROR_MAX_LENGTH) ||
      !includes(LIBRARY_ALBUM_FAILURE_CODES, record.code)
    ) {
      return null;
    }
    const failed: LibraryAlbumFailedEvent = {
      requestId: expected.requestId,
      operationId: expected.operationId,
      generation: expected.generation,
      resolvingDeadlineAt: expected.resolvingDeadlineAt,
      error: record.error,
      code: record.code,
    };
    return failed;
  } catch {
    return null;
  }
}

export function normalizeLibraryAlbumVersionFailedEvent(
  value: unknown,
  expected: LibraryAlbumCorrelation & { versionId: string }
): LibraryAlbumVersionFailedEvent | null {
  try {
    if (!isCorrelation(expected) || !isOpaqueId(expected.versionId)) return null;
    const record = plainDataRecord(value);
    if (!record || !hasExactKeys(record, [...LIBRARY_ALBUM_FAILED_KEYS, "versionId"])) {
      return null;
    }
    const base = { ...record } as Record<string, unknown>;
    delete base.versionId;
    const failed = normalizeLibraryAlbumFailedEvent(base, expected);
    return failed && record.versionId === expected.versionId
      ? { ...failed, versionId: expected.versionId }
      : null;
  } catch {
    return null;
  }
}

export function normalizeLibraryAlbumCancelRequest(
  value: unknown
): LibraryAlbumCancelRequest | null {
  try {
    const record = plainDataRecord(value);
    if (!record) return null;
    if (hasExactKeys(record, ["requestId"]) && isOpaqueId(record.requestId)) {
      return { requestId: record.requestId };
    }
    if (hasExactKeys(record, ["operationId"]) && isOpaqueId(record.operationId)) {
      return { operationId: record.operationId };
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeLibraryAlbumCancelAck(
  value: unknown
): LibraryAlbumCancelAck | null {
  try {
    const record = plainDataRecord(value);
    if (!record) return null;
    if (record.success === true) {
      if (!hasExactKeys(record, ["success", "data"])) return null;
      const data = plainDataRecord(record.data);
      return data &&
        hasExactKeys(data, ["claimed"]) &&
        typeof data.claimed === "boolean"
        ? { success: true, data: { claimed: data.claimed } }
        : null;
    }
    return record.success === false &&
      hasExactKeys(record, ["success", "error", "code"]) &&
      isBoundedText(record.error, LIBRARY_ALBUM_ERROR_MAX_LENGTH) &&
      record.code === "INVALID_REQUEST"
      ? { success: false, error: record.error, code: "INVALID_REQUEST" }
      : null;
  } catch {
    return null;
  }
}
