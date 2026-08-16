/**
 * Strict, keyless wire contracts for the two-phase album-action flow.
 * Labels are display data only. Only an opaque actionId can request execution.
 */

import { ALBUM_DETAIL_MAX_TRACKS } from "./libraryAlbumContracts";

export const ALBUM_ACTION_MAX_CHOICES = 32;
export const ALBUM_ACTION_ID_MAX_LENGTH = 128;
export const ALBUM_ACTION_LABEL_MAX_LENGTH = 256;
export const ALBUM_ACTION_ERROR_MAX_LENGTH = 1024;

export const ALBUM_ACTION_BEGIN_ERROR_CODES = [
  "INVALID_REQUEST",
  "ZONE_NOT_FOUND",
  "BACKPRESSURE",
  "REQUEST_ID_CONFLICT",
  "SESSION_LOST",
] as const;

export type AlbumActionBeginErrorCode =
  (typeof ALBUM_ACTION_BEGIN_ERROR_CODES)[number];

export const ALBUM_ACTION_FAILURE_CODES = [
  "ALBUM_NOT_FOUND",
  "ALBUM_AMBIGUOUS",
  "ALBUM_CHANGED",
  "TRACK_NOT_FOUND",
  "TRACK_MISMATCH",
  "ACTION_PATH_NOT_FOUND",
  "NO_SUPPORTED_ACTIONS",
  "ZONE_NOT_FOUND",
  "ZONE_CHANGED",
  "RESOLUTION_TIMEOUT",
  "CANCELED",
  "SESSION_LOST",
  "INTERNAL_ERROR",
] as const;

export type AlbumActionFailureCode =
  (typeof ALBUM_ACTION_FAILURE_CODES)[number];

export const ALBUM_ACTION_SEMANTICS = [
  "play-now",
  "add-next",
  "queue",
  "other",
] as const;

export type AlbumActionSemantic = (typeof ALBUM_ACTION_SEMANTICS)[number];

export interface AlbumActionTrackSelector {
  /** Zero-based position in the resolved album's ordered track list. */
  index: number;
  /** Exact display title the client observed at that position. */
  title: string;
}

export interface AlbumActionBeginRequest {
  requestId: string;
  /** Opaque retained album-page operation. */
  pageId: string;
  /** Opaque version selected within that page. */
  versionId: string;
  zoneId: string;
  tabId: string;
  generation: number;
  /** Optional track scope; when present, both fields must identify one track. */
  track?: AlbumActionTrackSelector;
}

export interface AlbumActionBeginAcceptedData {
  requestId: string;
  operationId: string;
  resolvingDeadlineAt: number;
}

export type AlbumActionBeginAck =
  | { success: true; data: AlbumActionBeginAcceptedData }
  | { success: false; error: string; code: AlbumActionBeginErrorCode };

export interface AlbumActionChoice {
  actionId: string;
  /** Exact bounded Roon display label; never accepted as execution authority. */
  label: string;
  semantic: AlbumActionSemantic;
}

export interface AlbumActionResolutionCorrelation {
  requestId: string;
  operationId: string;
  generation: number;
  resolvingDeadlineAt: number;
}

export interface AlbumActionResolvedEvent {
  requestId: string;
  operationId: string;
  generation: number;
  choosingDeadlineAt: number;
  actions: readonly AlbumActionChoice[];
}

export interface AlbumActionFailedEvent {
  requestId: string;
  operationId: string;
  generation: number;
  resolvingDeadlineAt: number;
  error: string;
  code: AlbumActionFailureCode;
}

export type AlbumActionCancelRequest =
  | { requestId: string }
  | { operationId: string };

export interface AlbumActionExecuteRequest {
  actionId: string;
}

export type AlbumActionCancelAck =
  | { success: true; data: { claimed: boolean } }
  | { success: false; error: string; code: "INVALID_REQUEST" };

export const ALBUM_ACTION_EXECUTE_REJECTION_CODES = [
  "ZONE_NOT_FOUND",
  "ZONE_CHANGED",
  "ALBUM_UNRESOLVED",
  "ACTION_UNAVAILABLE",
  "EXPIRED",
] as const;

export type AlbumActionExecuteRejectionCode =
  (typeof ALBUM_ACTION_EXECUTE_REJECTION_CODES)[number];

export type AlbumActionExecuteResult =
  | { claimed: false }
  | { claimed: true; outcome: "executed" }
  | {
      claimed: true;
      outcome: "rejected";
      code: AlbumActionExecuteRejectionCode;
      error: string;
    }
  | { claimed: true; outcome: "outcome-unknown"; error: string };

export type AlbumActionExecuteAck =
  | { success: true; data: AlbumActionExecuteResult }
  | { success: false; error: string; code: "INVALID_REQUEST" };

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

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
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
    value.length <= ALBUM_ACTION_ID_MAX_LENGTH &&
    OPAQUE_ID.test(value)
  );
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

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => candidate === value);
}

function isCorrelation(value: AlbumActionResolutionCorrelation): boolean {
  return (
    isOpaqueId(value.requestId) &&
    isOpaqueId(value.operationId) &&
    isGeneration(value.generation) &&
    isDeadline(value.resolvingDeadlineAt)
  );
}

const ALBUM_ACTION_BEGIN_KEYS = [
  "requestId",
  "pageId",
  "versionId",
  "zoneId",
  "tabId",
  "generation",
] as const;

export function normalizeAlbumActionTrackSelector(
  value: unknown
): AlbumActionTrackSelector | null {
  try {
    const record = plainDataRecord(value);
    return record &&
      hasExactKeys(record, ["index", "title"]) &&
      Number.isSafeInteger(record.index) &&
      (record.index as number) >= 0 &&
      (record.index as number) < ALBUM_DETAIL_MAX_TRACKS &&
      isBoundedText(record.title, ALBUM_ACTION_LABEL_MAX_LENGTH)
      ? { index: record.index as number, title: record.title }
      : null;
  } catch {
    return null;
  }
}

export function normalizeAlbumActionBeginRequest(
  value: unknown
): AlbumActionBeginRequest | null {
  try {
    const record = plainDataRecord(value);
    if (!record) return null;
    const withTrack = hasExactKeys(record, [...ALBUM_ACTION_BEGIN_KEYS, "track"]);
    if (
      (!withTrack && !hasExactKeys(record, [...ALBUM_ACTION_BEGIN_KEYS])) ||
      !isOpaqueId(record.requestId) ||
      !isOpaqueId(record.pageId) ||
      !isOpaqueId(record.versionId) ||
      !isOpaqueId(record.zoneId) ||
      !isOpaqueId(record.tabId) ||
      !isGeneration(record.generation)
    ) {
      return null;
    }
    const request: AlbumActionBeginRequest = {
      requestId: record.requestId,
      pageId: record.pageId,
      versionId: record.versionId,
      zoneId: record.zoneId,
      tabId: record.tabId,
      generation: record.generation,
    };
    if (!withTrack) return request;
    const track = normalizeAlbumActionTrackSelector(record.track);
    return track ? { ...request, track } : null;
  } catch {
    return null;
  }
}

export function normalizeAlbumActionBeginAck(
  value: unknown,
  expectedRequestId: string
): AlbumActionBeginAck | null {
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
      isBoundedText(record.error, ALBUM_ACTION_ERROR_MAX_LENGTH) &&
      includes(ALBUM_ACTION_BEGIN_ERROR_CODES, record.code)
    ) {
      return { success: false, error: record.error, code: record.code };
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeAlbumActionChoice(value: unknown): AlbumActionChoice | null {
  try {
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, ["actionId", "label", "semantic"]) ||
      !isOpaqueId(record.actionId) ||
      !isBoundedText(record.label, ALBUM_ACTION_LABEL_MAX_LENGTH) ||
      !includes(ALBUM_ACTION_SEMANTICS, record.semantic)
    ) {
      return null;
    }
    return {
      actionId: record.actionId,
      label: record.label,
      semantic: record.semantic,
    };
  } catch {
    return null;
  }
}

function normalizeChoices(value: unknown): AlbumActionChoice[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > ALBUM_ACTION_MAX_CHOICES
  ) {
    return null;
  }
  const choices: AlbumActionChoice[] = [];
  const actionIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return null;
    const choice = normalizeAlbumActionChoice(value[index]);
    if (!choice || actionIds.has(choice.actionId)) return null;
    actionIds.add(choice.actionId);
    choices.push(choice);
  }
  return choices;
}

export function normalizeAlbumActionResolvedEvent(
  value: unknown,
  expected: AlbumActionResolutionCorrelation
): AlbumActionResolvedEvent | null {
  try {
    if (!isCorrelation(expected)) return null;
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "operationId",
        "generation",
        "choosingDeadlineAt",
        "actions",
      ]) ||
      record.requestId !== expected.requestId ||
      record.operationId !== expected.operationId ||
      record.generation !== expected.generation ||
      !isDeadline(record.choosingDeadlineAt) ||
      record.choosingDeadlineAt < expected.resolvingDeadlineAt
    ) {
      return null;
    }
    const actions = normalizeChoices(record.actions);
    return actions
      ? {
          requestId: expected.requestId,
          operationId: expected.operationId,
          generation: expected.generation,
          choosingDeadlineAt: record.choosingDeadlineAt,
          actions,
        }
      : null;
  } catch {
    return null;
  }
}

export function normalizeAlbumActionFailedEvent(
  value: unknown,
  expected: AlbumActionResolutionCorrelation
): AlbumActionFailedEvent | null {
  try {
    if (!isCorrelation(expected)) return null;
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "requestId",
        "operationId",
        "generation",
        "resolvingDeadlineAt",
        "error",
        "code",
      ]) ||
      record.requestId !== expected.requestId ||
      record.operationId !== expected.operationId ||
      record.generation !== expected.generation ||
      record.resolvingDeadlineAt !== expected.resolvingDeadlineAt ||
      !isBoundedText(record.error, ALBUM_ACTION_ERROR_MAX_LENGTH) ||
      !includes(ALBUM_ACTION_FAILURE_CODES, record.code)
    ) {
      return null;
    }
    return {
      requestId: expected.requestId,
      operationId: expected.operationId,
      generation: expected.generation,
      resolvingDeadlineAt: expected.resolvingDeadlineAt,
      error: record.error,
      code: record.code,
    };
  } catch {
    return null;
  }
}

export function normalizeAlbumActionCancelRequest(
  value: unknown
): AlbumActionCancelRequest | null {
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

export function normalizeAlbumActionExecuteRequest(
  value: unknown
): AlbumActionExecuteRequest | null {
  try {
    const record = plainDataRecord(value);
    return record && hasExactKeys(record, ["actionId"]) && isOpaqueId(record.actionId)
      ? { actionId: record.actionId }
      : null;
  } catch {
    return null;
  }
}

function normalizeInvalidRequestFailure(
  record: Record<string, unknown>
): { success: false; error: string; code: "INVALID_REQUEST" } | null {
  return record.success === false &&
    hasExactKeys(record, ["success", "error", "code"]) &&
    isBoundedText(record.error, ALBUM_ACTION_ERROR_MAX_LENGTH) &&
    record.code === "INVALID_REQUEST"
    ? { success: false, error: record.error, code: "INVALID_REQUEST" }
    : null;
}

export function normalizeAlbumActionCancelAck(value: unknown): AlbumActionCancelAck | null {
  try {
    const record = plainDataRecord(value);
    if (!record) return null;
    if (record.success === true) {
      if (!hasExactKeys(record, ["success", "data"])) return null;
      const data = plainDataRecord(record.data);
      return data && hasExactKeys(data, ["claimed"]) && typeof data.claimed === "boolean"
        ? { success: true, data: { claimed: data.claimed } }
        : null;
    }
    return normalizeInvalidRequestFailure(record);
  } catch {
    return null;
  }
}

function normalizeExecuteResult(value: unknown): AlbumActionExecuteResult | null {
  const record = plainDataRecord(value);
  if (!record || typeof record.claimed !== "boolean") return null;
  if (record.claimed === false) {
    return hasExactKeys(record, ["claimed"]) ? { claimed: false } : null;
  }
  if (record.outcome === "executed" && hasExactKeys(record, ["claimed", "outcome"])) {
    return { claimed: true, outcome: "executed" };
  }
  if (
    record.outcome === "rejected" &&
    hasExactKeys(record, ["claimed", "outcome", "code", "error"]) &&
    includes(ALBUM_ACTION_EXECUTE_REJECTION_CODES, record.code) &&
    isBoundedText(record.error, ALBUM_ACTION_ERROR_MAX_LENGTH)
  ) {
    return {
      claimed: true,
      outcome: "rejected",
      code: record.code,
      error: record.error,
    };
  }
  if (
    record.outcome === "outcome-unknown" &&
    hasExactKeys(record, ["claimed", "outcome", "error"]) &&
    isBoundedText(record.error, ALBUM_ACTION_ERROR_MAX_LENGTH)
  ) {
    return { claimed: true, outcome: "outcome-unknown", error: record.error };
  }
  return null;
}

export function normalizeAlbumActionExecuteAck(value: unknown): AlbumActionExecuteAck | null {
  try {
    const record = plainDataRecord(value);
    if (!record) return null;
    if (record.success === true) {
      if (!hasExactKeys(record, ["success", "data"])) return null;
      const data = normalizeExecuteResult(record.data);
      return data ? { success: true, data } : null;
    }
    return normalizeInvalidRequestFailure(record);
  } catch {
    return null;
  }
}
