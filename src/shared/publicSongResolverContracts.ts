import type { ClassicBrowseSessionRef } from "./classicBrowseContracts";
import {
  UNIFIED_SONG_ACTION_SEMANTICS,
} from "./unifiedSearchContracts";
import type { UnifiedSongActionSemantic } from "./unifiedSearchContracts";

export const PUBLIC_SONG_SELECTION_ID_MAX_LENGTH = 128;
export const PUBLIC_SONG_CANDIDATE_MAX = 50;
export const PUBLIC_SONG_TEXT_MAX_LENGTH = 512;
export const PUBLIC_SONG_ERROR_MAX_LENGTH = 1_024;
export const PUBLIC_SONG_RESOLVE_ACK_TIMEOUT_MS = 75_000;
export const PUBLIC_SONG_ACTION_ACK_TIMEOUT_MS = 75_000;

export const PUBLIC_SONG_UNAVAILABLE_MESSAGES = Object.freeze({
  "source-unavailable": "this track is not available in the current source",
  "source-changed": "this track changed; refresh the list",
  "selection-expired": "this track selection expired; refresh the list",
  "search-incomplete":
    "Roon returned an incomplete song search; no action was taken",
  "no-exact-match": "no exact library track matched this row",
  "ambiguous-match": "more than one library track still matches this row",
  "public-api-unavailable": "Roon song search is unavailable",
});

export type PublicSongUnavailableCode =
  keyof typeof PUBLIC_SONG_UNAVAILABLE_MESSAGES;

export interface PublicSongUnavailableReason {
  code: PublicSongUnavailableCode;
  message: (typeof PUBLIC_SONG_UNAVAILABLE_MESSAGES)[PublicSongUnavailableCode];
}

export interface PublicSongCandidate {
  candidateId: string;
  title: string;
  subtitle: string;
  imageKey: string | null;
}

export type PublicSongRowAuthority =
  | {
      state: "unavailable";
      reason: PublicSongUnavailableReason;
    }
  | {
      state: "resolver-capable";
      selectionId: string;
    }
  | {
      state: "public-authorized";
      selectionId: string;
      candidate: PublicSongCandidate;
    };

export interface PublicSongResolveRequest {
  requestId: string;
  tabId: string;
  session: ClassicBrowseSessionRef;
  selectionId: string;
}

export type PublicSongResolution =
  | {
      kind: "authorized";
      candidate: PublicSongCandidate;
    }
  | {
      kind: "choice-required";
      candidates: readonly PublicSongCandidate[];
    }
  | {
      kind: "unavailable";
      reason: PublicSongUnavailableReason;
    };

export const PUBLIC_SONG_RESOLVE_ERROR_CODES = [
  "INVALID_REQUEST",
  "CORE_UNAVAILABLE",
  "BACKPRESSURE",
  "OWNER_MISMATCH",
  "STALE_GENERATION",
  "SESSION_LOST",
  "STALE_SELECTION",
  "SOURCE_CHANGED",
  "IN_FLIGHT",
  "INTERNAL_ERROR",
] as const;

export type PublicSongResolveErrorCode =
  (typeof PUBLIC_SONG_RESOLVE_ERROR_CODES)[number];

export type PublicSongResolveAck =
  | {
      success: true;
      data: {
        requestId: string;
        session: ClassicBrowseSessionRef;
        selectionId: string;
        resolution: PublicSongResolution;
      };
    }
  | {
      success: false;
      error: string;
      code: PublicSongResolveErrorCode;
    };

export interface PublicSongActionRequest
  extends PublicSongResolveRequest {
  candidateId: string;
  zoneId: string;
  semantic: UnifiedSongActionSemantic;
}

export const PUBLIC_SONG_ACTION_ERROR_CODES = [
  ...PUBLIC_SONG_RESOLVE_ERROR_CODES,
  "REQUEST_ID_CONFLICT",
  "STALE_CANDIDATE",
  "ZONE_UNAVAILABLE",
  "ZONE_CHANGED",
  "ACTION_UNAVAILABLE",
  "PRE_ISSUE_FAILED",
  "OUTCOME_UNKNOWN",
] as const;

export type PublicSongActionErrorCode =
  (typeof PUBLIC_SONG_ACTION_ERROR_CODES)[number];

export type PublicSongActionAck =
  | {
      success: true;
      data: {
        requestId: string;
        session: ClassicBrowseSessionRef;
        selectionId: string;
        candidateId: string;
        semantic: UnifiedSongActionSemantic;
        outcome: "executed";
        authorityRetired: true;
      };
    }
  | {
      success: false;
      error: string;
      code: PublicSongActionErrorCode;
    };

const CONTROL_CHARACTER = /\p{Cc}/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[]
): boolean {
  return (
    required.every((key) =>
      Object.prototype.hasOwnProperty.call(record, key)
    ) &&
    Object.keys(record).every((key) => required.includes(key))
  );
}

function boundedText(
  value: unknown,
  maxLength: number,
  allowEmpty = false
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maxLength &&
    !CONTROL_CHARACTER.test(value)
  );
}

function opaqueId(value: unknown): value is string {
  return (
    boundedText(value, PUBLIC_SONG_SELECTION_ID_MAX_LENGTH) &&
    OPAQUE_ID.test(value)
  );
}

/** Shared strict check for browser-visible opaque selection authorities. */
export function isPublicSongSelectionId(value: unknown): value is string {
  return opaqueId(value);
}

function session(value: unknown): ClassicBrowseSessionRef | null {
  const record = plainRecord(value);
  if (
    !record ||
    !exactKeys(record, ["handleId", "generation"]) ||
    !opaqueId(record.handleId) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) <= 0
  ) {
    return null;
  }
  return {
    handleId: record.handleId,
    generation: record.generation as number,
  };
}

function unavailableReason(value: unknown): PublicSongUnavailableReason | null {
  const record = plainRecord(value);
  if (
    !record ||
    !exactKeys(record, ["code", "message"]) ||
    typeof record.code !== "string" ||
    !Object.prototype.hasOwnProperty.call(
      PUBLIC_SONG_UNAVAILABLE_MESSAGES,
      record.code
    )
  ) {
    return null;
  }
  const code = record.code as PublicSongUnavailableCode;
  const message = PUBLIC_SONG_UNAVAILABLE_MESSAGES[code];
  if (record.message !== message) return null;
  return { code, message };
}

function candidate(value: unknown): PublicSongCandidate | null {
  const record = plainRecord(value);
  if (
    !record ||
    !exactKeys(record, ["candidateId", "title", "subtitle", "imageKey"]) ||
    !opaqueId(record.candidateId) ||
    !boundedText(record.title, PUBLIC_SONG_TEXT_MAX_LENGTH) ||
    !boundedText(record.subtitle, PUBLIC_SONG_TEXT_MAX_LENGTH, true) ||
    (record.imageKey !== null &&
      !boundedText(record.imageKey, PUBLIC_SONG_TEXT_MAX_LENGTH))
  ) {
    return null;
  }
  return {
    candidateId: record.candidateId,
    title: record.title,
    subtitle: record.subtitle,
    imageKey: record.imageKey,
  };
}

function uniqueCandidates(value: unknown): PublicSongCandidate[] | null {
  if (!Array.isArray(value) || value.length > PUBLIC_SONG_CANDIDATE_MAX) {
    return null;
  }
  const normalized: PublicSongCandidate[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const current = candidate(item);
    if (!current || ids.has(current.candidateId)) return null;
    ids.add(current.candidateId);
    normalized.push(current);
  }
  return normalized;
}

export function normalizePublicSongRowAuthority(
  value: unknown
): PublicSongRowAuthority | null {
  const record = plainRecord(value);
  if (!record || typeof record.state !== "string") return null;
  if (record.state === "unavailable") {
    if (!exactKeys(record, ["state", "reason"])) return null;
    const reason = unavailableReason(record.reason);
    return reason ? { state: "unavailable", reason } : null;
  }
  if (record.state === "resolver-capable") {
    return exactKeys(record, ["state", "selectionId"]) &&
      opaqueId(record.selectionId)
      ? { state: "resolver-capable", selectionId: record.selectionId }
      : null;
  }
  if (record.state === "public-authorized") {
    if (
      !exactKeys(record, ["state", "selectionId", "candidate"]) ||
      !opaqueId(record.selectionId)
    ) {
      return null;
    }
    const normalizedCandidate = candidate(record.candidate);
    return normalizedCandidate
      ? {
          state: "public-authorized",
          selectionId: record.selectionId,
          candidate: normalizedCandidate,
        }
      : null;
  }
  return null;
}

export function normalizePublicSongResolveRequest(
  value: unknown
): PublicSongResolveRequest | null {
  const record = plainRecord(value);
  if (
    !record ||
    !exactKeys(record, ["requestId", "tabId", "session", "selectionId"]) ||
    !opaqueId(record.requestId) ||
    !opaqueId(record.tabId) ||
    !opaqueId(record.selectionId)
  ) {
    return null;
  }
  const normalizedSession = session(record.session);
  return normalizedSession
    ? {
        requestId: record.requestId,
        tabId: record.tabId,
        session: normalizedSession,
        selectionId: record.selectionId,
      }
    : null;
}

function resolution(value: unknown): PublicSongResolution | null {
  const record = plainRecord(value);
  if (!record || typeof record.kind !== "string") return null;
  if (record.kind === "authorized") {
    if (!exactKeys(record, ["kind", "candidate"])) return null;
    const normalized = candidate(record.candidate);
    return normalized ? { kind: "authorized", candidate: normalized } : null;
  }
  if (record.kind === "choice-required") {
    if (!exactKeys(record, ["kind", "candidates"])) return null;
    const candidates = uniqueCandidates(record.candidates);
    return candidates && candidates.length >= 2
      ? { kind: "choice-required", candidates }
      : null;
  }
  if (record.kind === "unavailable") {
    if (!exactKeys(record, ["kind", "reason"])) return null;
    const reason = unavailableReason(record.reason);
    return reason ? { kind: "unavailable", reason } : null;
  }
  return null;
}

function errorAck<T extends string>(
  record: Record<string, unknown>,
  codes: readonly T[]
): { success: false; error: string; code: T } | null {
  if (
    !exactKeys(record, ["success", "error", "code"]) ||
    record.success !== false ||
    !boundedText(record.error, PUBLIC_SONG_ERROR_MAX_LENGTH) ||
    typeof record.code !== "string" ||
    !codes.includes(record.code as T)
  ) {
    return null;
  }
  return {
    success: false,
    error: record.error,
    code: record.code as T,
  };
}

function sameSession(
  left: ClassicBrowseSessionRef,
  right: ClassicBrowseSessionRef
): boolean {
  return (
    left.handleId === right.handleId &&
    left.generation === right.generation
  );
}

export function normalizePublicSongResolveAck(
  value: unknown,
  request: PublicSongResolveRequest
): PublicSongResolveAck | null {
  const record = plainRecord(value);
  if (!record || typeof record.success !== "boolean") return null;
  if (!record.success) {
    return errorAck(record, PUBLIC_SONG_RESOLVE_ERROR_CODES);
  }
  if (!exactKeys(record, ["success", "data"])) return null;
  const data = plainRecord(record.data);
  if (
    !data ||
    !exactKeys(data, [
      "requestId",
      "session",
      "selectionId",
      "resolution",
    ]) ||
    data.requestId !== request.requestId ||
    data.selectionId !== request.selectionId
  ) {
    return null;
  }
  const normalizedSession = session(data.session);
  const normalizedResolution = resolution(data.resolution);
  if (
    !normalizedSession ||
    !sameSession(normalizedSession, request.session) ||
    !normalizedResolution
  ) {
    return null;
  }
  return {
    success: true,
    data: {
      requestId: request.requestId,
      session: normalizedSession,
      selectionId: request.selectionId,
      resolution: normalizedResolution,
    },
  };
}

function semantic(value: unknown): value is UnifiedSongActionSemantic {
  return UNIFIED_SONG_ACTION_SEMANTICS.includes(
    value as UnifiedSongActionSemantic
  );
}

export function normalizePublicSongActionRequest(
  value: unknown
): PublicSongActionRequest | null {
  const record = plainRecord(value);
  if (
    !record ||
    !exactKeys(record, [
      "requestId",
      "tabId",
      "session",
      "selectionId",
      "candidateId",
      "zoneId",
      "semantic",
    ]) ||
    !opaqueId(record.requestId) ||
    !opaqueId(record.tabId) ||
    !opaqueId(record.selectionId) ||
    !opaqueId(record.candidateId) ||
    !opaqueId(record.zoneId) ||
    !semantic(record.semantic)
  ) {
    return null;
  }
  const normalizedSession = session(record.session);
  return normalizedSession
    ? {
        requestId: record.requestId,
        tabId: record.tabId,
        session: normalizedSession,
        selectionId: record.selectionId,
        candidateId: record.candidateId,
        zoneId: record.zoneId,
        semantic: record.semantic,
      }
    : null;
}

export function normalizePublicSongActionAck(
  value: unknown,
  request: PublicSongActionRequest
): PublicSongActionAck | null {
  const record = plainRecord(value);
  if (!record || typeof record.success !== "boolean") return null;
  if (!record.success) {
    return errorAck(record, PUBLIC_SONG_ACTION_ERROR_CODES);
  }
  if (!exactKeys(record, ["success", "data"])) return null;
  const data = plainRecord(record.data);
  if (
    !data ||
    !exactKeys(data, [
      "requestId",
      "session",
      "selectionId",
      "candidateId",
      "semantic",
      "outcome",
      "authorityRetired",
    ]) ||
    data.requestId !== request.requestId ||
    data.selectionId !== request.selectionId ||
    data.candidateId !== request.candidateId ||
    data.semantic !== request.semantic ||
    data.outcome !== "executed" ||
    data.authorityRetired !== true
  ) {
    return null;
  }
  const normalizedSession = session(data.session);
  if (!normalizedSession || !sameSession(normalizedSession, request.session)) {
    return null;
  }
  return {
    success: true,
    data: {
      requestId: request.requestId,
      session: normalizedSession,
      selectionId: request.selectionId,
      candidateId: request.candidateId,
      semantic: request.semantic,
      outcome: "executed",
      authorityRetired: true,
    },
  };
}
