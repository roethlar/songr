/**
 * Strict, keyless wire contracts for loading one artist into the server-owned
 * Timeline interactive session. Roon item/session keys never cross this
 * boundary; the client receives only an opaque controller handle/generation.
 */

import {
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  isCatalogLocalId,
  normalizeAlbumRef,
  normalizeArtistRef,
  normalizeCatalogArtistAlbumsResponse,
  type AlbumRef,
  type ArtistRef,
  type CatalogArtistAlbumsResponse,
} from "./timelineCatalogContracts";

export const TIMELINE_BROWSE_ID_MAX_LENGTH = 128;
export const TIMELINE_BROWSE_ERROR_MAX_LENGTH = 1_024;
export const TIMELINE_ALBUM_DETAIL_MAX_TRACKS = 500;

export const TIMELINE_ARTIST_LOAD_ERROR_CODES = [
  "INVALID_REQUEST",
  "REQUEST_ID_CONFLICT",
  "CORE_UNAVAILABLE",
  "CATALOG_UNAVAILABLE",
  "ARTIST_NOT_FOUND",
  "ARTIST_AMBIGUOUS",
  "DISCOGRAPHY_UNAVAILABLE",
  "BACKPRESSURE",
  "STALE_GENERATION",
  "SESSION_LOST",
  "INTERNAL_ERROR",
] as const;

export type TimelineArtistLoadErrorCode =
  (typeof TIMELINE_ARTIST_LOAD_ERROR_CODES)[number];

export interface TimelineArtistLoadRequest {
  readonly requestId: string;
  readonly tabId: string;
  readonly artistLocalId: string;
}

export interface TimelineBrowseSessionRef {
  readonly handleId: string;
  readonly generation: number;
}

export interface TimelineArtistLoadCorrelation {
  readonly requestId: string;
  readonly session: TimelineBrowseSessionRef;
  readonly loadingDeadlineAt: number;
}

export type TimelineArtistLoadBeginAck =
  | {
      readonly success: true;
      readonly data: TimelineArtistLoadCorrelation;
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: TimelineArtistLoadErrorCode;
    };

export interface TimelineArtistLoadedEvent
  extends TimelineArtistLoadCorrelation {
  readonly discography: CatalogArtistAlbumsResponse;
}

export interface TimelineArtistLoadFailedEvent
  extends TimelineArtistLoadCorrelation {
  readonly error: string;
  readonly code: TimelineArtistLoadErrorCode;
}

export const TIMELINE_ALBUM_DETAIL_ERROR_CODES = [
  "INVALID_REQUEST",
  "REQUEST_ID_CONFLICT",
  "CORE_UNAVAILABLE",
  "CATALOG_UNAVAILABLE",
  "ARTIST_NOT_FOUND",
  "ARTIST_AMBIGUOUS",
  "ALBUM_NOT_FOUND",
  "ALBUM_AMBIGUOUS",
  "DETAIL_UNAVAILABLE",
  "BACKPRESSURE",
  "STALE_GENERATION",
  "SESSION_LOST",
  "INTERNAL_ERROR",
] as const;

export type TimelineAlbumDetailErrorCode =
  (typeof TIMELINE_ALBUM_DETAIL_ERROR_CODES)[number];

/** Stable semantic target resolved inside the retained Timeline session. */
export interface TimelineAlbumDetailRequest {
  readonly requestId: string;
  readonly tabId: string;
  readonly session: TimelineBrowseSessionRef;
  readonly artistLocalId: string;
  readonly albumLocalId: string;
}

export interface TimelineAlbumDetailCorrelation {
  readonly requestId: string;
  readonly session: TimelineBrowseSessionRef;
  readonly artistLocalId: string;
  readonly albumLocalId: string;
  readonly loadingDeadlineAt: number;
}

export type TimelineAlbumDetailBeginAck =
  | {
      readonly success: true;
      readonly data: TimelineAlbumDetailCorrelation;
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: TimelineAlbumDetailErrorCode;
    };

/** Display-only album detail. Array order is track order and grants no authority. */
export interface TimelineAlbumDetailSnapshot {
  readonly artist: ArtistRef;
  readonly album: AlbumRef;
  readonly orderedTrackTitles: readonly string[];
}

export interface TimelineAlbumDetailLoadedEvent
  extends TimelineAlbumDetailCorrelation {
  readonly detail: TimelineAlbumDetailSnapshot;
}

export interface TimelineAlbumDetailFailedEvent
  extends TimelineAlbumDetailCorrelation {
  readonly error: string;
  readonly code: TimelineAlbumDetailErrorCode;
}

export const TIMELINE_SESSION_RECONNECT_ERROR_CODES = [
  "INVALID_REQUEST",
  "CORE_UNAVAILABLE",
  "STALE_GENERATION",
  "SESSION_LOST",
  "INTERNAL_ERROR",
] as const;

export type TimelineSessionReconnectErrorCode =
  (typeof TIMELINE_SESSION_RECONNECT_ERROR_CODES)[number];

/** Grace-period ownership transfer; semantic re-resolution is a separate flow. */
export interface TimelineSessionReconnectRequest {
  readonly requestId: string;
  readonly tabId: string;
  readonly session: TimelineBrowseSessionRef;
}

export type TimelineSessionReconnectAck =
  | {
      readonly success: true;
      readonly data: {
        readonly requestId: string;
        readonly session: TimelineBrowseSessionRef;
      };
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: TimelineSessionReconnectErrorCode;
    };

export const TIMELINE_SESSION_RELEASE_ERROR_CODES = [
  "INVALID_REQUEST",
  "CORE_UNAVAILABLE",
  "STALE_GENERATION",
  "SESSION_LOST",
  "INTERNAL_ERROR",
] as const;

export type TimelineSessionReleaseErrorCode =
  (typeof TIMELINE_SESSION_RELEASE_ERROR_CODES)[number];

/** Best-effort release of one exact socket/tab-owned interactive generation. */
export interface TimelineSessionReleaseRequest {
  readonly requestId: string;
  readonly tabId: string;
  readonly session: TimelineBrowseSessionRef;
}

export type TimelineSessionReleaseAck =
  | {
      readonly success: true;
      readonly data: {
        readonly requestId: string;
        readonly session: TimelineBrowseSessionRef;
      };
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: TimelineSessionReleaseErrorCode;
    };

export const TIMELINE_ALBUM_DETAIL_CLOSE_ERROR_CODES = [
  "INVALID_REQUEST",
  "REQUEST_ID_CONFLICT",
  "CORE_UNAVAILABLE",
  "CATALOG_UNAVAILABLE",
  "ARTIST_NOT_FOUND",
  "ARTIST_AMBIGUOUS",
  "DISCOGRAPHY_UNAVAILABLE",
  "BACKPRESSURE",
  "STALE_GENERATION",
  "SESSION_LOST",
  "INTERNAL_ERROR",
] as const;

export type TimelineAlbumDetailCloseErrorCode =
  (typeof TIMELINE_ALBUM_DETAIL_CLOSE_ERROR_CODES)[number];

/**
 * Closes one live detail. Equal base/detail artists permit coherent pop;
 * differing IDs require a stable-ID re-resolution of the base artist.
 */
export interface TimelineAlbumDetailCloseRequest {
  readonly requestId: string;
  readonly tabId: string;
  readonly session: TimelineBrowseSessionRef;
  readonly baseArtistLocalId: string;
  readonly detailArtistLocalId: string;
  readonly albumLocalId: string;
}

export interface TimelineAlbumDetailCloseCorrelation {
  readonly requestId: string;
  readonly session: TimelineBrowseSessionRef;
  readonly baseArtistLocalId: string;
  readonly detailArtistLocalId: string;
  readonly albumLocalId: string;
  readonly closingDeadlineAt: number;
}

export type TimelineAlbumDetailCloseAck =
  | {
      readonly success: true;
      readonly data: TimelineAlbumDetailCloseCorrelation;
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: TimelineAlbumDetailCloseErrorCode;
    };

export interface TimelineAlbumDetailClosedEvent
  extends TimelineAlbumDetailCloseCorrelation {
  readonly discography: CatalogArtistAlbumsResponse;
}

export interface TimelineAlbumDetailCloseFailedEvent
  extends TimelineAlbumDetailCloseCorrelation {
  readonly error: string;
  readonly code: TimelineAlbumDetailCloseErrorCode;
}

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

function plainDataArray(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => typeof key !== "string")
  ) {
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
  }
  return value;
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
    value.length <= TIMELINE_BROWSE_ID_MAX_LENGTH &&
    OPAQUE_ID.test(value)
  );
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDeadline(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isErrorText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= TIMELINE_BROWSE_ERROR_MAX_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTER.test(value)
  );
}

function isErrorCode(value: unknown): value is TimelineArtistLoadErrorCode {
  return TIMELINE_ARTIST_LOAD_ERROR_CODES.some((code) => code === value);
}

function includesCode<T extends string>(
  values: readonly T[],
  value: unknown
): value is T {
  return values.some((candidate) => candidate === value);
}

function isCanonicalDisplayText(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CATALOG_DISPLAY_TEXT_MAX_LENGTH ||
    CONTROL_CHARACTER.test(value)
  ) {
    return false;
  }
  return value === value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function normalizeSession(
  value: unknown
): TimelineBrowseSessionRef | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["handleId", "generation"]) ||
    !isOpaqueId(record.handleId) ||
    !isGeneration(record.generation)
  ) {
    return null;
  }
  return { handleId: record.handleId, generation: record.generation };
}

function sessionsMatch(
  left: TimelineBrowseSessionRef,
  right: TimelineBrowseSessionRef
): boolean {
  return (
    left.handleId === right.handleId && left.generation === right.generation
  );
}

function normalizeCorrelation(
  record: Record<string, unknown>,
  expectedRequestId: string,
  expectedSession?: TimelineBrowseSessionRef
): TimelineArtistLoadCorrelation | null {
  const session = normalizeSession(record.session);
  if (
    record.requestId !== expectedRequestId ||
    !session ||
    !isDeadline(record.loadingDeadlineAt) ||
    (expectedSession !== undefined &&
      (session.handleId !== expectedSession.handleId ||
        session.generation !== expectedSession.generation))
  ) {
    return null;
  }
  return {
    requestId: expectedRequestId,
    session,
    loadingDeadlineAt: record.loadingDeadlineAt,
  };
}

export function normalizeTimelineArtistLoadRequest(
  value: unknown
): TimelineArtistLoadRequest | null {
  try {
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, ["requestId", "tabId", "artistLocalId"]) ||
      !isOpaqueId(record.requestId) ||
      !isOpaqueId(record.tabId) ||
      !isCatalogLocalId(record.artistLocalId)
    ) {
      return null;
    }
    return {
      requestId: record.requestId,
      tabId: record.tabId,
      artistLocalId: record.artistLocalId,
    };
  } catch {
    return null;
  }
}

export function normalizeTimelineArtistLoadBeginAck(
  value: unknown,
  expectedRequestId: string
): TimelineArtistLoadBeginAck | null {
  try {
    if (!isOpaqueId(expectedRequestId)) return null;
    const record = plainDataRecord(value);
    if (!record) return null;
    if (record.success === true) {
      if (!hasExactKeys(record, ["success", "data"])) return null;
      const data = plainDataRecord(record.data);
      if (!data || !hasExactKeys(data, ["requestId", "session", "loadingDeadlineAt"])) {
        return null;
      }
      const correlation = normalizeCorrelation(data, expectedRequestId);
      return correlation ? { success: true, data: correlation } : null;
    }
    if (
      record.success !== false ||
      !hasExactKeys(record, ["success", "error", "code"]) ||
      !isErrorText(record.error) ||
      !isErrorCode(record.code)
    ) {
      return null;
    }
    return { success: false, error: record.error, code: record.code };
  } catch {
    return null;
  }
}

export function normalizeTimelineArtistLoadedEvent(
  value: unknown,
  expected: TimelineArtistLoadCorrelation
): TimelineArtistLoadedEvent | null {
  try {
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "session",
        "loadingDeadlineAt",
        "discography",
      ])
    ) {
      return null;
    }
    const correlation = normalizeCorrelation(
      record,
      expected.requestId,
      expected.session
    );
    const discography = normalizeCatalogArtistAlbumsResponse(
      record.discography
    );
    if (
      !correlation ||
      correlation.loadingDeadlineAt !== expected.loadingDeadlineAt ||
      !discography
    ) {
      return null;
    }
    return { ...correlation, discography };
  } catch {
    return null;
  }
}

export function normalizeTimelineArtistLoadFailedEvent(
  value: unknown,
  expected: TimelineArtistLoadCorrelation
): TimelineArtistLoadFailedEvent | null {
  try {
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "session",
        "loadingDeadlineAt",
        "error",
        "code",
      ]) ||
      !isErrorText(record.error) ||
      !isErrorCode(record.code)
    ) {
      return null;
    }
    const correlation = normalizeCorrelation(
      record,
      expected.requestId,
      expected.session
    );
    if (
      !correlation ||
      correlation.loadingDeadlineAt !== expected.loadingDeadlineAt
    ) {
      return null;
    }
    return {
      ...correlation,
      error: record.error,
      code: record.code,
    };
  } catch {
    return null;
  }
}

function readTimelineAlbumDetailCorrelation(
  record: Record<string, unknown>
): TimelineAlbumDetailCorrelation | null {
  const session = normalizeSession(record.session);
  if (
    !isOpaqueId(record.requestId) ||
    !session ||
    !isCatalogLocalId(record.artistLocalId) ||
    !isCatalogLocalId(record.albumLocalId) ||
    record.artistLocalId === record.albumLocalId ||
    !isDeadline(record.loadingDeadlineAt)
  ) {
    return null;
  }
  return {
    requestId: record.requestId,
    session,
    artistLocalId: record.artistLocalId,
    albumLocalId: record.albumLocalId,
    loadingDeadlineAt: record.loadingDeadlineAt,
  };
}

function normalizeTimelineAlbumDetailCorrelationValue(
  value: unknown
): TimelineAlbumDetailCorrelation | null {
  const record = plainDataRecord(value);
  return record &&
    hasExactKeys(record, [
      "requestId",
      "session",
      "artistLocalId",
      "albumLocalId",
      "loadingDeadlineAt",
    ])
    ? readTimelineAlbumDetailCorrelation(record)
    : null;
}

function albumDetailCorrelationMatchesRequest(
  correlation: TimelineAlbumDetailCorrelation,
  request: TimelineAlbumDetailRequest
): boolean {
  return (
    correlation.requestId === request.requestId &&
    sessionsMatch(correlation.session, request.session) &&
    correlation.artistLocalId === request.artistLocalId &&
    correlation.albumLocalId === request.albumLocalId
  );
}

function albumDetailCorrelationsMatch(
  left: TimelineAlbumDetailCorrelation,
  right: TimelineAlbumDetailCorrelation
): boolean {
  return (
    left.requestId === right.requestId &&
    sessionsMatch(left.session, right.session) &&
    left.artistLocalId === right.artistLocalId &&
    left.albumLocalId === right.albumLocalId &&
    left.loadingDeadlineAt === right.loadingDeadlineAt
  );
}

export function normalizeTimelineAlbumDetailRequest(
  value: unknown
): TimelineAlbumDetailRequest | null {
  try {
    const record = plainDataRecord(value);
    const session = record ? normalizeSession(record.session) : null;
    if (
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "tabId",
        "session",
        "artistLocalId",
        "albumLocalId",
      ]) ||
      !isOpaqueId(record.requestId) ||
      !isOpaqueId(record.tabId) ||
      !session ||
      !isCatalogLocalId(record.artistLocalId) ||
      !isCatalogLocalId(record.albumLocalId) ||
      record.artistLocalId === record.albumLocalId
    ) {
      return null;
    }
    return {
      requestId: record.requestId,
      tabId: record.tabId,
      session,
      artistLocalId: record.artistLocalId,
      albumLocalId: record.albumLocalId,
    };
  } catch {
    return null;
  }
}

export function normalizeTimelineAlbumDetailBeginAck(
  value: unknown,
  expectedRequest: TimelineAlbumDetailRequest
): TimelineAlbumDetailBeginAck | null {
  try {
    const request = normalizeTimelineAlbumDetailRequest(expectedRequest);
    const record = plainDataRecord(value);
    if (!request || !record) return null;
    if (record.success === true) {
      if (!hasExactKeys(record, ["success", "data"])) return null;
      const correlation = normalizeTimelineAlbumDetailCorrelationValue(
        record.data
      );
      return correlation && albumDetailCorrelationMatchesRequest(correlation, request)
        ? { success: true, data: correlation }
        : null;
    }
    if (
      record.success !== false ||
      !hasExactKeys(record, ["success", "error", "code"]) ||
      !isErrorText(record.error) ||
      !includesCode(TIMELINE_ALBUM_DETAIL_ERROR_CODES, record.code)
    ) {
      return null;
    }
    return { success: false, error: record.error, code: record.code };
  } catch {
    return null;
  }
}

export function normalizeTimelineAlbumDetailSnapshot(
  value: unknown,
  expectedArtistLocalId: string,
  expectedAlbumLocalId: string
): TimelineAlbumDetailSnapshot | null {
  try {
    if (
      !isCatalogLocalId(expectedArtistLocalId) ||
      !isCatalogLocalId(expectedAlbumLocalId) ||
      expectedArtistLocalId === expectedAlbumLocalId
    ) {
      return null;
    }
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, ["artist", "album", "orderedTrackTitles"])
    ) {
      return null;
    }
    const artist = normalizeArtistRef(record.artist);
    const album = normalizeAlbumRef(record.album);
    const trackValues = plainDataArray(record.orderedTrackTitles);
    if (
      !artist ||
      !album ||
      artist.localId !== expectedArtistLocalId ||
      album.localId !== expectedAlbumLocalId ||
      artist.resolutionStatus !== "resolved" ||
      album.resolutionStatus !== "resolved" ||
      album.artistLocalId !== artist.localId ||
      album.coreId !== artist.coreId ||
      album.trackTitleFingerprint === undefined ||
      !trackValues ||
      trackValues.length < 1 ||
      trackValues.length > TIMELINE_ALBUM_DETAIL_MAX_TRACKS
    ) {
      return null;
    }
    const orderedTrackTitles: string[] = [];
    for (const title of trackValues) {
      if (!isCanonicalDisplayText(title)) return null;
      orderedTrackTitles.push(title);
    }
    return { artist, album, orderedTrackTitles };
  } catch {
    return null;
  }
}

export function normalizeTimelineAlbumDetailLoadedEvent(
  value: unknown,
  expected: TimelineAlbumDetailCorrelation
): TimelineAlbumDetailLoadedEvent | null {
  try {
    const expectedCorrelation =
      normalizeTimelineAlbumDetailCorrelationValue(expected);
    const record = plainDataRecord(value);
    if (
      !expectedCorrelation ||
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "session",
        "artistLocalId",
        "albumLocalId",
        "loadingDeadlineAt",
        "detail",
      ])
    ) {
      return null;
    }
    const correlation = readTimelineAlbumDetailCorrelation(record);
    if (
      !correlation ||
      !albumDetailCorrelationsMatch(correlation, expectedCorrelation)
    ) {
      return null;
    }
    const detail = normalizeTimelineAlbumDetailSnapshot(
      record.detail,
      correlation.artistLocalId,
      correlation.albumLocalId
    );
    return detail ? { ...correlation, detail } : null;
  } catch {
    return null;
  }
}

export function normalizeTimelineAlbumDetailFailedEvent(
  value: unknown,
  expected: TimelineAlbumDetailCorrelation
): TimelineAlbumDetailFailedEvent | null {
  try {
    const expectedCorrelation =
      normalizeTimelineAlbumDetailCorrelationValue(expected);
    const record = plainDataRecord(value);
    if (
      !expectedCorrelation ||
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "session",
        "artistLocalId",
        "albumLocalId",
        "loadingDeadlineAt",
        "error",
        "code",
      ]) ||
      !isErrorText(record.error) ||
      !includesCode(TIMELINE_ALBUM_DETAIL_ERROR_CODES, record.code)
    ) {
      return null;
    }
    const correlation = readTimelineAlbumDetailCorrelation(record);
    return correlation &&
      albumDetailCorrelationsMatch(correlation, expectedCorrelation)
      ? { ...correlation, error: record.error, code: record.code }
      : null;
  } catch {
    return null;
  }
}

export function normalizeTimelineSessionReconnectRequest(
  value: unknown
): TimelineSessionReconnectRequest | null {
  try {
    const record = plainDataRecord(value);
    const session = record ? normalizeSession(record.session) : null;
    if (
      !record ||
      !hasExactKeys(record, ["requestId", "tabId", "session"]) ||
      !isOpaqueId(record.requestId) ||
      !isOpaqueId(record.tabId) ||
      !session
    ) {
      return null;
    }
    return { requestId: record.requestId, tabId: record.tabId, session };
  } catch {
    return null;
  }
}

export function normalizeTimelineSessionReconnectAck(
  value: unknown,
  expectedRequest: TimelineSessionReconnectRequest
): TimelineSessionReconnectAck | null {
  try {
    const request = normalizeTimelineSessionReconnectRequest(expectedRequest);
    const record = plainDataRecord(value);
    if (!request || !record) return null;
    if (record.success === true) {
      if (!hasExactKeys(record, ["success", "data"])) return null;
      const data = plainDataRecord(record.data);
      const session = data ? normalizeSession(data.session) : null;
      if (
        !data ||
        !hasExactKeys(data, ["requestId", "session"]) ||
        data.requestId !== request.requestId ||
        !session ||
        !sessionsMatch(session, request.session)
      ) {
        return null;
      }
      return {
        success: true,
        data: { requestId: request.requestId, session },
      };
    }
    if (
      record.success !== false ||
      !hasExactKeys(record, ["success", "error", "code"]) ||
      !isErrorText(record.error) ||
      !includesCode(TIMELINE_SESSION_RECONNECT_ERROR_CODES, record.code)
    ) {
      return null;
    }
    return { success: false, error: record.error, code: record.code };
  } catch {
    return null;
  }
}

export function normalizeTimelineSessionReleaseRequest(
  value: unknown
): TimelineSessionReleaseRequest | null {
  try {
    const record = plainDataRecord(value);
    const session = record ? normalizeSession(record.session) : null;
    if (
      !record ||
      !hasExactKeys(record, ["requestId", "tabId", "session"]) ||
      !isOpaqueId(record.requestId) ||
      !isOpaqueId(record.tabId) ||
      !session
    ) {
      return null;
    }
    return { requestId: record.requestId, tabId: record.tabId, session };
  } catch {
    return null;
  }
}

export function normalizeTimelineSessionReleaseAck(
  value: unknown,
  expectedRequest: TimelineSessionReleaseRequest
): TimelineSessionReleaseAck | null {
  try {
    const request = normalizeTimelineSessionReleaseRequest(expectedRequest);
    const record = plainDataRecord(value);
    if (!request || !record) return null;
    if (record.success === true) {
      if (!hasExactKeys(record, ["success", "data"])) return null;
      const data = plainDataRecord(record.data);
      const session = data ? normalizeSession(data.session) : null;
      if (
        !data ||
        !hasExactKeys(data, ["requestId", "session"]) ||
        data.requestId !== request.requestId ||
        !session ||
        !sessionsMatch(session, request.session)
      ) {
        return null;
      }
      return {
        success: true,
        data: { requestId: request.requestId, session },
      };
    }
    if (
      record.success !== false ||
      !hasExactKeys(record, ["success", "error", "code"]) ||
      !isErrorText(record.error) ||
      !includesCode(TIMELINE_SESSION_RELEASE_ERROR_CODES, record.code)
    ) {
      return null;
    }
    return { success: false, error: record.error, code: record.code };
  } catch {
    return null;
  }
}

function readTimelineAlbumDetailCloseCorrelation(
  record: Record<string, unknown>
): TimelineAlbumDetailCloseCorrelation | null {
  const session = normalizeSession(record.session);
  if (
    !isOpaqueId(record.requestId) ||
    !session ||
    !isCatalogLocalId(record.baseArtistLocalId) ||
    !isCatalogLocalId(record.detailArtistLocalId) ||
    !isCatalogLocalId(record.albumLocalId) ||
    record.albumLocalId === record.baseArtistLocalId ||
    record.albumLocalId === record.detailArtistLocalId ||
    !isDeadline(record.closingDeadlineAt)
  ) {
    return null;
  }
  return {
    requestId: record.requestId,
    session,
    baseArtistLocalId: record.baseArtistLocalId,
    detailArtistLocalId: record.detailArtistLocalId,
    albumLocalId: record.albumLocalId,
    closingDeadlineAt: record.closingDeadlineAt,
  };
}

function normalizeTimelineAlbumDetailCloseCorrelationValue(
  value: unknown
): TimelineAlbumDetailCloseCorrelation | null {
  const record = plainDataRecord(value);
  return record &&
    hasExactKeys(record, [
      "requestId",
      "session",
      "baseArtistLocalId",
      "detailArtistLocalId",
      "albumLocalId",
      "closingDeadlineAt",
    ])
    ? readTimelineAlbumDetailCloseCorrelation(record)
    : null;
}

function albumDetailCloseCorrelationMatchesRequest(
  correlation: TimelineAlbumDetailCloseCorrelation,
  request: TimelineAlbumDetailCloseRequest
): boolean {
  return (
    correlation.requestId === request.requestId &&
    sessionsMatch(correlation.session, request.session) &&
    correlation.baseArtistLocalId === request.baseArtistLocalId &&
    correlation.detailArtistLocalId === request.detailArtistLocalId &&
    correlation.albumLocalId === request.albumLocalId
  );
}

function albumDetailCloseCorrelationsMatch(
  left: TimelineAlbumDetailCloseCorrelation,
  right: TimelineAlbumDetailCloseCorrelation
): boolean {
  return (
    left.requestId === right.requestId &&
    sessionsMatch(left.session, right.session) &&
    left.baseArtistLocalId === right.baseArtistLocalId &&
    left.detailArtistLocalId === right.detailArtistLocalId &&
    left.albumLocalId === right.albumLocalId &&
    left.closingDeadlineAt === right.closingDeadlineAt
  );
}

export function normalizeTimelineAlbumDetailCloseRequest(
  value: unknown
): TimelineAlbumDetailCloseRequest | null {
  try {
    const record = plainDataRecord(value);
    const session = record ? normalizeSession(record.session) : null;
    if (
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "tabId",
        "session",
        "baseArtistLocalId",
        "detailArtistLocalId",
        "albumLocalId",
      ]) ||
      !isOpaqueId(record.requestId) ||
      !isOpaqueId(record.tabId) ||
      !session ||
      !isCatalogLocalId(record.baseArtistLocalId) ||
      !isCatalogLocalId(record.detailArtistLocalId) ||
      !isCatalogLocalId(record.albumLocalId) ||
      record.albumLocalId === record.baseArtistLocalId ||
      record.albumLocalId === record.detailArtistLocalId
    ) {
      return null;
    }
    return {
      requestId: record.requestId,
      tabId: record.tabId,
      session,
      baseArtistLocalId: record.baseArtistLocalId,
      detailArtistLocalId: record.detailArtistLocalId,
      albumLocalId: record.albumLocalId,
    };
  } catch {
    return null;
  }
}

export function normalizeTimelineAlbumDetailCloseAck(
  value: unknown,
  expectedRequest: TimelineAlbumDetailCloseRequest
): TimelineAlbumDetailCloseAck | null {
  try {
    const request = normalizeTimelineAlbumDetailCloseRequest(expectedRequest);
    const record = plainDataRecord(value);
    if (!request || !record) return null;
    if (record.success === true) {
      if (!hasExactKeys(record, ["success", "data"])) return null;
      const correlation = normalizeTimelineAlbumDetailCloseCorrelationValue(
        record.data
      );
      return correlation &&
        albumDetailCloseCorrelationMatchesRequest(correlation, request)
        ? { success: true, data: correlation }
        : null;
    }
    if (
      record.success !== false ||
      !hasExactKeys(record, ["success", "error", "code"]) ||
      !isErrorText(record.error) ||
      !includesCode(TIMELINE_ALBUM_DETAIL_CLOSE_ERROR_CODES, record.code)
    ) {
      return null;
    }
    return { success: false, error: record.error, code: record.code };
  } catch {
    return null;
  }
}

export function normalizeTimelineAlbumDetailClosedEvent(
  value: unknown,
  expected: TimelineAlbumDetailCloseCorrelation
): TimelineAlbumDetailClosedEvent | null {
  try {
    const expectedCorrelation =
      normalizeTimelineAlbumDetailCloseCorrelationValue(expected);
    const record = plainDataRecord(value);
    if (
      !expectedCorrelation ||
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "session",
        "baseArtistLocalId",
        "detailArtistLocalId",
        "albumLocalId",
        "closingDeadlineAt",
        "discography",
      ])
    ) {
      return null;
    }
    const correlation = readTimelineAlbumDetailCloseCorrelation(record);
    const discography = normalizeCatalogArtistAlbumsResponse(
      record.discography
    );
    return correlation &&
      albumDetailCloseCorrelationsMatch(correlation, expectedCorrelation) &&
      discography?.artist.localId === correlation.baseArtistLocalId
      ? { ...correlation, discography }
      : null;
  } catch {
    return null;
  }
}

export function normalizeTimelineAlbumDetailCloseFailedEvent(
  value: unknown,
  expected: TimelineAlbumDetailCloseCorrelation
): TimelineAlbumDetailCloseFailedEvent | null {
  try {
    const expectedCorrelation =
      normalizeTimelineAlbumDetailCloseCorrelationValue(expected);
    const record = plainDataRecord(value);
    if (
      !expectedCorrelation ||
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "session",
        "baseArtistLocalId",
        "detailArtistLocalId",
        "albumLocalId",
        "closingDeadlineAt",
        "error",
        "code",
      ]) ||
      !isErrorText(record.error) ||
      !includesCode(TIMELINE_ALBUM_DETAIL_CLOSE_ERROR_CODES, record.code)
    ) {
      return null;
    }
    const correlation = readTimelineAlbumDetailCloseCorrelation(record);
    return correlation &&
      albumDetailCloseCorrelationsMatch(correlation, expectedCorrelation)
      ? { ...correlation, error: record.error, code: record.code }
      : null;
  } catch {
    return null;
  }
}
