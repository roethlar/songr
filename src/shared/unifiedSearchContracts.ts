import type { ClassicBrowseSessionRef } from "./classicBrowseContracts";

export const UNIFIED_SEARCH_ID_MAX_LENGTH = 128;
export const UNIFIED_SEARCH_QUERY_MAX_LENGTH = 256;
export const UNIFIED_SEARCH_TEXT_MAX_LENGTH = 512;
export const UNIFIED_SEARCH_ERROR_MAX_LENGTH = 1_024;
export const UNIFIED_SONG_SEARCH_RESULT_MAX = 50;
export const UNIFIED_SONG_RELATIONSHIP_ALBUM_MAX = 200;
export const UNIFIED_SONG_RELATIONSHIP_COMPOSER_MAX = 64;
export const UNIFIED_SEARCH_ACK_TIMEOUT_MS = 75_000;
export const UNIFIED_SONG_ACTION_ACK_TIMEOUT_MS = 75_000;
export const UNIFIED_SONG_RELATIONSHIP_ACK_TIMEOUT_MS = 75_000;

export const UNIFIED_SEARCH_ERROR_CODES = [
  "INVALID_REQUEST",
  "CORE_UNAVAILABLE",
  "BACKPRESSURE",
  "OWNER_MISMATCH",
  "STALE_GENERATION",
  "SESSION_LOST",
  "INTERNAL_ERROR",
] as const;

export type UnifiedSearchErrorCode =
  (typeof UNIFIED_SEARCH_ERROR_CODES)[number];

export const UNIFIED_SONG_ACTION_SEMANTICS = [
  "play-now",
  "add-next",
  "queue",
] as const;

export type UnifiedSongActionSemantic =
  (typeof UNIFIED_SONG_ACTION_SEMANTICS)[number];

export const UNIFIED_SONG_ACTION_ERROR_CODES = [
  "INVALID_REQUEST",
  "REQUEST_ID_CONFLICT",
  "CORE_UNAVAILABLE",
  "BACKPRESSURE",
  "OWNER_MISMATCH",
  "STALE_RESULT",
  "SESSION_LOST",
  "ZONE_UNAVAILABLE",
  "ZONE_CHANGED",
  "ACTION_UNAVAILABLE",
  "PRE_ISSUE_FAILED",
  "OUTCOME_UNKNOWN",
  "INTERNAL_ERROR",
] as const;

export type UnifiedSongActionErrorCode =
  (typeof UNIFIED_SONG_ACTION_ERROR_CODES)[number];

export const UNIFIED_SONG_RELATIONSHIP_ERROR_CODES = [
  "INVALID_REQUEST",
  "CORE_UNAVAILABLE",
  "OWNER_MISMATCH",
  "STALE_RESULT",
  "SESSION_LOST",
  "RELATIONSHIP_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type UnifiedSongRelationshipErrorCode =
  (typeof UNIFIED_SONG_RELATIONSHIP_ERROR_CODES)[number];

export interface UnifiedSongSearchRequest {
  readonly requestId: string;
  readonly tabId: string;
  readonly session: ClassicBrowseSessionRef;
  readonly query: string;
}

export interface UnifiedSongSearchResult {
  readonly resultId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly imageKey: string | null;
}

export type UnifiedSongSearchAck =
  | {
      readonly success: true;
      readonly data: {
        readonly requestId: string;
        readonly session: ClassicBrowseSessionRef;
        readonly query: string;
        readonly results: readonly UnifiedSongSearchResult[];
      };
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: UnifiedSearchErrorCode;
    };

export interface UnifiedSongActionRequest {
  readonly requestId: string;
  readonly tabId: string;
  readonly session: ClassicBrowseSessionRef;
  readonly resultId: string;
  readonly zoneId: string;
  readonly semantic: UnifiedSongActionSemantic;
}

export type UnifiedSongActionAck =
  | {
      readonly success: true;
      readonly data: {
        readonly requestId: string;
        readonly session: ClassicBrowseSessionRef;
        readonly resultId: string;
        readonly semantic: UnifiedSongActionSemantic;
        readonly outcome: "executed";
        readonly authorityRetired: boolean;
      };
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: UnifiedSongActionErrorCode;
    };

export interface UnifiedSongRelationshipRequest {
  readonly requestId: string;
  readonly tabId: string;
  readonly session: ClassicBrowseSessionRef;
  readonly resultId: string;
}

export interface UnifiedSongAlbumRelationship {
  readonly albumLocalId: string;
  readonly artistLocalId: string | null;
  readonly title: string;
  readonly artist: string;
  readonly editionText: string;
}

export interface UnifiedSongRelationship {
  readonly songTitle: string;
  readonly albums: readonly UnifiedSongAlbumRelationship[];
  readonly composerLabels: readonly string[];
}

export type UnifiedSongRelationshipAck =
  | {
      readonly success: true;
      readonly data: {
        readonly requestId: string;
        readonly session: ClassicBrowseSessionRef;
        readonly resultId: string;
        readonly songTitle: string;
        readonly albums: readonly UnifiedSongAlbumRelationship[];
        readonly composerLabels: readonly string[];
      };
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: UnifiedSongRelationshipErrorCode;
    };

export interface UnifiedSearchClearRequest {
  readonly requestId: string;
  readonly tabId: string;
  readonly session: ClassicBrowseSessionRef;
}

export type UnifiedSearchClearAck =
  | {
      readonly success: true;
      readonly data: {
        readonly requestId: string;
        readonly session: ClassicBrowseSessionRef;
      };
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: UnifiedSearchErrorCode;
    };

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;

function plainRecord(value: unknown): Record<string, unknown> | null {
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
  expected: readonly string[]
): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) => typeof key === "string" && expected.includes(key)
    )
  );
}

function boundedOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= UNIFIED_SEARCH_ID_MAX_LENGTH &&
    OPAQUE_ID.test(value)
  );
}

function boundedText(
  value: unknown,
  maximum: number,
  allowEmpty = false
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum &&
    !CONTROL_CHARACTER.test(value)
  );
}

function normalizeSession(value: unknown): ClassicBrowseSessionRef | null {
  const record = plainRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["handleId", "generation"]) ||
    !boundedOpaqueId(record.handleId) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 0
  ) {
    return null;
  }
  return {
    handleId: record.handleId,
    generation: record.generation as number,
  };
}

function normalizeQuery(value: unknown): string | null {
  if (!boundedText(value, UNIFIED_SEARCH_QUERY_MAX_LENGTH)) return null;
  const query = value.trim();
  return query.length > 0 && query.length <= UNIFIED_SEARCH_QUERY_MAX_LENGTH
    ? query
    : null;
}

export function normalizeUnifiedSongSearchRequest(
  value: unknown
): UnifiedSongSearchRequest | null {
  try {
    const record = plainRecord(value);
    if (
      !record ||
      !hasExactKeys(record, ["requestId", "tabId", "session", "query"]) ||
      !boundedOpaqueId(record.requestId) ||
      !boundedOpaqueId(record.tabId)
    ) {
      return null;
    }
    const session = normalizeSession(record.session);
    const query = normalizeQuery(record.query);
    return session && query
      ? {
          requestId: record.requestId,
          tabId: record.tabId,
          session,
          query,
        }
      : null;
  } catch {
    return null;
  }
}

export function normalizeUnifiedSongActionRequest(
  value: unknown
): UnifiedSongActionRequest | null {
  try {
    const record = plainRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "tabId",
        "session",
        "resultId",
        "zoneId",
        "semantic",
      ]) ||
      !boundedOpaqueId(record.requestId) ||
      !boundedOpaqueId(record.tabId) ||
      !boundedOpaqueId(record.resultId) ||
      !boundedOpaqueId(record.zoneId) ||
      !UNIFIED_SONG_ACTION_SEMANTICS.includes(
        record.semantic as UnifiedSongActionSemantic
      )
    ) {
      return null;
    }
    const session = normalizeSession(record.session);
    return session
      ? {
          requestId: record.requestId,
          tabId: record.tabId,
          session,
          resultId: record.resultId,
          zoneId: record.zoneId,
          semantic: record.semantic as UnifiedSongActionSemantic,
        }
      : null;
  } catch {
    return null;
  }
}

export function normalizeUnifiedSongRelationshipRequest(
  value: unknown
): UnifiedSongRelationshipRequest | null {
  try {
    const record = plainRecord(value);
    if (
      !record ||
      !hasExactKeys(record, ["requestId", "tabId", "session", "resultId"]) ||
      !boundedOpaqueId(record.requestId) ||
      !boundedOpaqueId(record.tabId) ||
      !boundedOpaqueId(record.resultId)
    ) {
      return null;
    }
    const session = normalizeSession(record.session);
    return session
      ? {
          requestId: record.requestId,
          tabId: record.tabId,
          session,
          resultId: record.resultId,
        }
      : null;
  } catch {
    return null;
  }
}

export function normalizeUnifiedSearchClearRequest(
  value: unknown
): UnifiedSearchClearRequest | null {
  try {
    const record = plainRecord(value);
    if (
      !record ||
      !hasExactKeys(record, ["requestId", "tabId", "session"]) ||
      !boundedOpaqueId(record.requestId) ||
      !boundedOpaqueId(record.tabId)
    ) {
      return null;
    }
    const session = normalizeSession(record.session);
    return session
      ? {
          requestId: record.requestId,
          tabId: record.tabId,
          session,
        }
      : null;
  } catch {
    return null;
  }
}

export function normalizeUnifiedSongSearchResult(
  value: unknown
): UnifiedSongSearchResult | null {
  try {
    const record = plainRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "resultId",
        "title",
        "subtitle",
        "imageKey",
      ]) ||
      !boundedOpaqueId(record.resultId) ||
      !boundedText(record.title, UNIFIED_SEARCH_TEXT_MAX_LENGTH) ||
      !boundedText(
        record.subtitle,
        UNIFIED_SEARCH_TEXT_MAX_LENGTH,
        true
      ) ||
      (record.imageKey !== null &&
        !boundedText(record.imageKey, UNIFIED_SEARCH_TEXT_MAX_LENGTH))
    ) {
      return null;
    }
    return {
      resultId: record.resultId,
      title: record.title,
      subtitle: record.subtitle,
      imageKey: record.imageKey,
    };
  } catch {
    return null;
  }
}

export function normalizeUnifiedSongAlbumRelationship(
  value: unknown
): UnifiedSongAlbumRelationship | null {
  try {
    const record = plainRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "albumLocalId",
        "artistLocalId",
        "title",
        "artist",
        "editionText",
      ]) ||
      !boundedOpaqueId(record.albumLocalId) ||
      (record.artistLocalId !== null &&
        !boundedOpaqueId(record.artistLocalId)) ||
      !boundedText(record.title, UNIFIED_SEARCH_TEXT_MAX_LENGTH) ||
      !boundedText(
        record.artist,
        UNIFIED_SEARCH_TEXT_MAX_LENGTH,
        true
      ) ||
      !boundedText(
        record.editionText,
        UNIFIED_SEARCH_TEXT_MAX_LENGTH,
        true
      )
    ) {
      return null;
    }
    return {
      albumLocalId: record.albumLocalId,
      artistLocalId: record.artistLocalId,
      title: record.title,
      artist: record.artist,
      editionText: record.editionText,
    };
  } catch {
    return null;
  }
}

export function normalizeUnifiedSongSearchAck(
  value: unknown,
  expected: UnifiedSongSearchRequest
): UnifiedSongSearchAck | null {
  try {
    const record = plainRecord(value);
    if (!record) return null;
    if (record.success === false) {
      if (
        !hasExactKeys(record, ["success", "error", "code"]) ||
        !boundedText(record.error, UNIFIED_SEARCH_ERROR_MAX_LENGTH) ||
        !UNIFIED_SEARCH_ERROR_CODES.includes(
          record.code as UnifiedSearchErrorCode
        )
      ) {
        return null;
      }
      return {
        success: false,
        error: record.error,
        code: record.code as UnifiedSearchErrorCode,
      };
    }
    if (
      record.success !== true ||
      !hasExactKeys(record, ["success", "data"])
    ) {
      return null;
    }
    const data = plainRecord(record.data);
    if (
      !data ||
      !hasExactKeys(data, [
        "requestId",
        "session",
        "query",
        "results",
      ]) ||
      data.requestId !== expected.requestId ||
      data.query !== expected.query ||
      !Array.isArray(data.results) ||
      data.results.length > UNIFIED_SONG_SEARCH_RESULT_MAX
    ) {
      return null;
    }
    const session = normalizeSession(data.session);
    if (
      !session ||
      session.handleId !== expected.session.handleId ||
      session.generation !== expected.session.generation
    ) {
      return null;
    }
    const results: UnifiedSongSearchResult[] = [];
    const resultIds = new Set<string>();
    for (let index = 0; index < data.results.length; index += 1) {
      if (!(index in data.results)) return null;
      const result = normalizeUnifiedSongSearchResult(data.results[index]);
      if (!result || resultIds.has(result.resultId)) return null;
      resultIds.add(result.resultId);
      results.push(result);
    }
    return {
      success: true,
      data: {
        requestId: expected.requestId,
        session,
        query: expected.query,
        results,
      },
    };
  } catch {
    return null;
  }
}

export function normalizeUnifiedSongRelationshipAck(
  value: unknown,
  expected: UnifiedSongRelationshipRequest
): UnifiedSongRelationshipAck | null {
  try {
    const record = plainRecord(value);
    if (!record) return null;
    if (record.success === false) {
      if (
        !hasExactKeys(record, ["success", "error", "code"]) ||
        !boundedText(record.error, UNIFIED_SEARCH_ERROR_MAX_LENGTH) ||
        !UNIFIED_SONG_RELATIONSHIP_ERROR_CODES.includes(
          record.code as UnifiedSongRelationshipErrorCode
        )
      ) {
        return null;
      }
      return {
        success: false,
        error: record.error,
        code: record.code as UnifiedSongRelationshipErrorCode,
      };
    }
    if (
      record.success !== true ||
      !hasExactKeys(record, ["success", "data"])
    ) {
      return null;
    }
    const data = plainRecord(record.data);
    if (
      !data ||
      !hasExactKeys(data, [
        "requestId",
        "session",
        "resultId",
        "songTitle",
        "albums",
        "composerLabels",
      ]) ||
      data.requestId !== expected.requestId ||
      data.resultId !== expected.resultId ||
      !boundedText(data.songTitle, UNIFIED_SEARCH_TEXT_MAX_LENGTH) ||
      !Array.isArray(data.albums) ||
      data.albums.length > UNIFIED_SONG_RELATIONSHIP_ALBUM_MAX ||
      !Array.isArray(data.composerLabels) ||
      data.composerLabels.length > UNIFIED_SONG_RELATIONSHIP_COMPOSER_MAX
    ) {
      return null;
    }
    const session = normalizeSession(data.session);
    if (
      !session ||
      session.handleId !== expected.session.handleId ||
      session.generation !== expected.session.generation
    ) {
      return null;
    }
    const albums: UnifiedSongAlbumRelationship[] = [];
    const albumIds = new Set<string>();
    for (let index = 0; index < data.albums.length; index += 1) {
      if (!(index in data.albums)) return null;
      const album = normalizeUnifiedSongAlbumRelationship(data.albums[index]);
      if (!album || albumIds.has(album.albumLocalId)) return null;
      albumIds.add(album.albumLocalId);
      albums.push(album);
    }
    const composerLabels: string[] = [];
    const seenComposerLabels = new Set<string>();
    for (let index = 0; index < data.composerLabels.length; index += 1) {
      if (!(index in data.composerLabels)) return null;
      const label = data.composerLabels[index];
      if (
        !boundedText(label, UNIFIED_SEARCH_TEXT_MAX_LENGTH) ||
        seenComposerLabels.has(label)
      ) {
        return null;
      }
      seenComposerLabels.add(label);
      composerLabels.push(label);
    }
    return {
      success: true,
      data: {
        requestId: expected.requestId,
        session,
        resultId: expected.resultId,
        songTitle: data.songTitle,
        albums,
        composerLabels,
      },
    };
  } catch {
    return null;
  }
}

export function normalizeUnifiedSongActionAck(
  value: unknown,
  expected: UnifiedSongActionRequest
): UnifiedSongActionAck | null {
  try {
    const record = plainRecord(value);
    if (!record) return null;
    if (record.success === false) {
      if (
        !hasExactKeys(record, ["success", "error", "code"]) ||
        !boundedText(record.error, UNIFIED_SEARCH_ERROR_MAX_LENGTH) ||
        !UNIFIED_SONG_ACTION_ERROR_CODES.includes(
          record.code as UnifiedSongActionErrorCode
        )
      ) {
        return null;
      }
      return {
        success: false,
        error: record.error,
        code: record.code as UnifiedSongActionErrorCode,
      };
    }
    if (
      record.success !== true ||
      !hasExactKeys(record, ["success", "data"])
    ) {
      return null;
    }
    const data = plainRecord(record.data);
    if (
      !data ||
      !hasExactKeys(data, [
        "requestId",
        "session",
        "resultId",
        "semantic",
        "outcome",
        "authorityRetired",
      ]) ||
      data.requestId !== expected.requestId ||
      data.resultId !== expected.resultId ||
      data.semantic !== expected.semantic ||
      data.outcome !== "executed" ||
      typeof data.authorityRetired !== "boolean"
    ) {
      return null;
    }
    const session = normalizeSession(data.session);
    if (
      !session ||
      session.handleId !== expected.session.handleId ||
      session.generation !== expected.session.generation
    ) {
      return null;
    }
    return {
      success: true,
      data: {
        requestId: expected.requestId,
        session,
        resultId: expected.resultId,
        semantic: expected.semantic,
        outcome: "executed",
        authorityRetired: data.authorityRetired,
      },
    };
  } catch {
    return null;
  }
}

export function normalizeUnifiedSearchClearAck(
  value: unknown,
  expected: UnifiedSearchClearRequest
): UnifiedSearchClearAck | null {
  try {
    const record = plainRecord(value);
    if (!record) return null;
    if (record.success === false) {
      if (
        !hasExactKeys(record, ["success", "error", "code"]) ||
        !boundedText(record.error, UNIFIED_SEARCH_ERROR_MAX_LENGTH) ||
        !UNIFIED_SEARCH_ERROR_CODES.includes(
          record.code as UnifiedSearchErrorCode
        )
      ) {
        return null;
      }
      return {
        success: false,
        error: record.error,
        code: record.code as UnifiedSearchErrorCode,
      };
    }
    if (
      record.success !== true ||
      !hasExactKeys(record, ["success", "data"])
    ) {
      return null;
    }
    const data = plainRecord(record.data);
    if (
      !data ||
      !hasExactKeys(data, ["requestId", "session"]) ||
      data.requestId !== expected.requestId
    ) {
      return null;
    }
    const session = normalizeSession(data.session);
    if (
      !session ||
      session.handleId !== expected.session.handleId ||
      session.generation !== expected.session.generation
    ) {
      return null;
    }
    return {
      success: true,
      data: {
        requestId: expected.requestId,
        session,
      },
    };
  } catch {
    return null;
  }
}
