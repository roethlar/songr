/**
 * Strict, keyless wire contracts for the library-album read path. Albums,
 * artists, and tracks are display data only; no browse item keys, zone
 * authority, or action authority ever cross this boundary.
 */

import { TIMELINE_ALBUM_DETAIL_MAX_TRACKS } from "./timelineBrowseContracts";

export const LIBRARY_ALBUM_ID_MAX_LENGTH = 128;
export const LIBRARY_ALBUM_TEXT_MAX_LENGTH = 256;
export const LIBRARY_ALBUM_ERROR_MAX_LENGTH = 1024;
export const LIBRARY_ALBUM_MAX_TRACKS = TIMELINE_ALBUM_DETAIL_MAX_TRACKS;
export const LIBRARY_ALBUM_MAX_CANDIDATES = 32;

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

/**
 * One distinguishable live album edition. A chooser retry echoes the chosen
 * candidate verbatim; the server re-verifies it against a fresh observation.
 */
export interface LibraryAlbumCandidate {
  title: string;
  artist: string;
  /** Live edition qualifier; empty when the live row shows none. */
  editionText: string;
}

export interface LibraryAlbumOpenRequest {
  requestId: string;
  tabId: string;
  albumLocalId: string;
  generation: number;
  /** Chooser retry: resolve exactly this previously offered candidate. */
  candidate?: LibraryAlbumCandidate;
}

export interface LibraryAlbumOpenAcceptedData {
  requestId: string;
  operationId: string;
  resolvingDeadlineAt: number;
}

export type LibraryAlbumOpenAck =
  | { success: true; data: LibraryAlbumOpenAcceptedData }
  | { success: false; error: string; code: LibraryAlbumOpenErrorCode };

export interface LibraryAlbumTrack {
  /** Zero-based, contiguous position in the album's play order. */
  index: number;
  title: string;
}

export interface LibraryAlbumCorrelation {
  requestId: string;
  operationId: string;
  generation: number;
  resolvingDeadlineAt: number;
}

export interface LibraryAlbumResolvedEvent {
  requestId: string;
  operationId: string;
  generation: number;
  artist: string;
  title: string;
  /** True only when public Browse authority can back album/track actions. */
  actionsAvailable: boolean;
  orderedTracks: readonly LibraryAlbumTrack[];
}

export interface LibraryAlbumFailedEvent {
  requestId: string;
  operationId: string;
  generation: number;
  resolvingDeadlineAt: number;
  error: string;
  code: LibraryAlbumFailureCode;
  /** Present only with ALBUM_AMBIGUOUS; the chooser's complete option set. */
  candidates?: readonly LibraryAlbumCandidate[];
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

export function normalizeLibraryAlbumCandidate(
  value: unknown
): LibraryAlbumCandidate | null {
  try {
    const record = plainDataRecord(value);
    return record &&
      hasExactKeys(record, ["title", "artist", "editionText"]) &&
      isBoundedText(record.title, LIBRARY_ALBUM_TEXT_MAX_LENGTH) &&
      isBoundedText(record.artist, LIBRARY_ALBUM_TEXT_MAX_LENGTH) &&
      isBoundedOptionalText(record.editionText, LIBRARY_ALBUM_TEXT_MAX_LENGTH)
      ? {
          title: record.title,
          artist: record.artist,
          editionText: record.editionText,
        }
      : null;
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
    if (!record) return null;
    const withCandidate = hasExactKeys(record, [
      ...LIBRARY_ALBUM_OPEN_KEYS,
      "candidate",
    ]);
    if (
      (!withCandidate && !hasExactKeys(record, [...LIBRARY_ALBUM_OPEN_KEYS])) ||
      !isOpaqueId(record.requestId) ||
      !isOpaqueId(record.tabId) ||
      !isLocalId(record.albumLocalId) ||
      !isGeneration(record.generation)
    ) {
      return null;
    }
    const request: LibraryAlbumOpenRequest = {
      requestId: record.requestId,
      tabId: record.tabId,
      albumLocalId: record.albumLocalId,
      generation: record.generation,
    };
    if (!withCandidate) return request;
    const candidate = normalizeLibraryAlbumCandidate(record.candidate);
    return candidate ? { ...request, candidate } : null;
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
      !hasExactKeys(record, ["index", "title"]) ||
      record.index !== index ||
      !isBoundedText(record.title, LIBRARY_ALBUM_TEXT_MAX_LENGTH)
    ) {
      return null;
    }
    tracks.push({ index, title: record.title });
  }
  return tracks;
}

function normalizeCandidates(value: unknown): LibraryAlbumCandidate[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > LIBRARY_ALBUM_MAX_CANDIDATES
  ) {
    return null;
  }
  const candidates: LibraryAlbumCandidate[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return null;
    const candidate = normalizeLibraryAlbumCandidate(value[index]);
    if (!candidate) return null;
    const identity = JSON.stringify([
      candidate.title,
      candidate.artist,
      candidate.editionText,
    ]);
    if (seen.has(identity)) return null;
    seen.add(identity);
    candidates.push(candidate);
  }
  return candidates;
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
        "artist",
        "title",
        "actionsAvailable",
        "orderedTracks",
      ]) ||
      record.requestId !== expected.requestId ||
      record.operationId !== expected.operationId ||
      record.generation !== expected.generation ||
      !isBoundedText(record.artist, LIBRARY_ALBUM_TEXT_MAX_LENGTH) ||
      !isBoundedText(record.title, LIBRARY_ALBUM_TEXT_MAX_LENGTH) ||
      typeof record.actionsAvailable !== "boolean"
    ) {
      return null;
    }
    const orderedTracks = normalizeOrderedTracks(record.orderedTracks);
    return orderedTracks
      ? {
          requestId: expected.requestId,
          operationId: expected.operationId,
          generation: expected.generation,
          artist: record.artist,
          title: record.title,
          actionsAvailable: record.actionsAvailable,
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
    if (!record) return null;
    const withCandidates = hasExactKeys(record, [
      ...LIBRARY_ALBUM_FAILED_KEYS,
      "candidates",
    ]);
    if (
      (!withCandidates && !hasExactKeys(record, [...LIBRARY_ALBUM_FAILED_KEYS])) ||
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
    if (!withCandidates) return failed;
    if (record.code !== "ALBUM_AMBIGUOUS") return null;
    const candidates = normalizeCandidates(record.candidates);
    return candidates ? { ...failed, candidates } : null;
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
