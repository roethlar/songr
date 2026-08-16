import type {
  BrowseLoadOptions,
  BrowseOptions,
  BrowsePopOptions,
  BrowseResult,
  BrowseSearchOptions,
  SearchResult,
} from "./types";
import { isAllowedBrowseHierarchy } from "./browseHierarchies";

export const CLASSIC_BROWSE_ID_MAX_LENGTH = 128;
export const CLASSIC_BROWSE_ERROR_MAX_LENGTH = 1_024;

export const CLASSIC_BROWSE_ROLES = [
  "classic-browse",
  "classic-search",
  "classic-explore",
  // The composition surface owns its own Roon-side hierarchy state: its
  // full composers walk must never share a list cursor with the palette's
  // named-counts drain on classic-explore (ri8-3).
  "classic-composition",
] as const;
export type ClassicBrowseRole = (typeof CLASSIC_BROWSE_ROLES)[number];

export const CLASSIC_BROWSE_OPERATIONS = ["browse", "load", "pop", "search"] as const;
export type ClassicBrowseOperation = (typeof CLASSIC_BROWSE_OPERATIONS)[number];

export const CLASSIC_SESSION_ACK_TIMEOUT_MS = 20_000;
/** Browse/pop may perform one browse plus one bounded page load. */
export const CLASSIC_BROWSE_ACK_TIMEOUT_MS = 40_000;
/** Explicit paging maps to one native Roon load call. */
export const CLASSIC_LOAD_ACK_TIMEOUT_MS = 20_000;
export const CLASSIC_BROWSE_PAGE_SIZE_MAX = 100;
export const CLASSIC_LOAD_COUNT_MAX = 5_000;
/** Grouped search may expand several categories before restoring its root. */
/** Bound grouped-search work and the number of semantic rows it can fan out through. */
// The shared search taxonomy is finite: artist, album, track, playlist,
// genre, composer, label, and radio. The deadline remains the runtime bound.
export const CLASSIC_SEARCH_MAX_CATEGORIES = 8;
export const CLASSIC_SEARCH_RESULT_MAX = 500;
export const CLASSIC_SEARCH_EXPANSION_DEADLINE_MS = 45_000;
/**
 * A coordinator call can occupy roughly two native timeout windows while its
 * timed-out generation is retired. At most one expansion plus the mandatory
 * root restore may start around the soft deadline; the protocol timeout keeps
 * a further 15-second scheduling margin beyond that mathematical ceiling.
 */
export const CLASSIC_SEARCH_COORDINATED_CALL_CEILING_MS = 30_000;
export const CLASSIC_SEARCH_ACK_TIMEOUT_MS =
  CLASSIC_SEARCH_EXPANSION_DEADLINE_MS +
  2 * CLASSIC_SEARCH_COORDINATED_CALL_CEILING_MS +
  15_000;

export interface ClassicBrowseSessionRef {
  readonly handleId: string;
  readonly generation: number;
}

export interface ClassicSessionAcquireRequest {
  readonly requestId: string;
  readonly tabId: string;
}

export interface ClassicSessionReleaseRequest extends ClassicSessionAcquireRequest {
  readonly session: ClassicBrowseSessionRef;
}

export type ClassicBrowseOptions = Omit<BrowseOptions, "multiSessionKey"> & {
  readonly multiSessionKey?: never;
};
export type ClassicBrowseLoadOptions = Omit<BrowseLoadOptions, "multiSessionKey"> & {
  readonly multiSessionKey?: never;
};
export type ClassicBrowsePopOptions = Omit<BrowsePopOptions, "multiSessionKey"> & {
  readonly multiSessionKey?: never;
};
export type ClassicBrowseSearchOptions = Omit<BrowseSearchOptions, "multiSessionKey"> & {
  readonly multiSessionKey?: never;
};
export type ClassicBrowseCommandOptions =
  | ClassicBrowseOptions
  | ClassicBrowseLoadOptions
  | ClassicBrowsePopOptions
  | ClassicBrowseSearchOptions;

export interface ClassicBrowseCommandRequest extends ClassicSessionReleaseRequest {
  readonly role: ClassicBrowseRole;
  readonly operation: ClassicBrowseOperation;
  readonly options: ClassicBrowseCommandOptions;
}

export const CLASSIC_BROWSE_ERROR_CODES = [
  "INVALID_REQUEST",
  "CORE_UNAVAILABLE",
  "BACKPRESSURE",
  "OWNER_MISMATCH",
  "STALE_GENERATION",
  "SESSION_LOST",
  "INTERNAL_ERROR",
] as const;
export type ClassicBrowseErrorCode = (typeof CLASSIC_BROWSE_ERROR_CODES)[number];

export type ClassicSessionAcquireAck =
  | {
      readonly success: true;
      readonly data: {
        readonly requestId: string;
        readonly session: ClassicBrowseSessionRef;
      };
    }
  | ClassicFailureAck;

export type ClassicSessionReleaseAck =
  | {
      readonly success: true;
      readonly data: { readonly requestId: string };
    }
  | ClassicFailureAck;

export type ClassicBrowseCommandResult = BrowseResult | readonly SearchResult[];

export type ClassicBrowseCommandAck<T = ClassicBrowseCommandResult> =
  | {
      readonly success: true;
      readonly data: {
        readonly requestId: string;
        readonly session: ClassicBrowseSessionRef;
        readonly result: T;
      };
    }
  | ClassicFailureAck;

interface ClassicFailureAck {
  readonly success: false;
  readonly error: string;
  readonly code: ClassicBrowseErrorCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CLASSIC_BROWSE_ID_MAX_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CLASSIC_BROWSE_ERROR_MAX_LENGTH
  );
}

function isOptionalBoundedText(value: unknown): value is string | undefined {
  return value === undefined || isBoundedText(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function normalizeSession(value: unknown): ClassicBrowseSessionRef | null {
  if (!isRecord(value) || !hasExactKeys(value, ["handleId", "generation"])) return null;
  if (!isOpaqueId(value.handleId) || !isNonNegativeInteger(value.generation)) return null;
  return { handleId: value.handleId, generation: value.generation };
}

function normalizeBrowseOptions(value: unknown): ClassicBrowseOptions | null {
  const keys = [
    "hierarchy",
    "zoneId",
    "itemKey",
    "input",
    "offset",
    "setDisplayOffset",
    "refresh",
    "popAll",
    "pageSize",
  ];
  if (!isRecord(value) || !Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key))) return null;
  if (!isAllowedBrowseHierarchy(value.hierarchy) || !isOptionalBoundedText(value.zoneId) || !isOptionalBoundedText(value.itemKey)) return null;
  if (value.input !== undefined && !isBoundedText(value.input)) return null;
  if (value.offset !== undefined && !isNonNegativeInteger(value.offset)) return null;
  if (value.setDisplayOffset !== undefined && !isNonNegativeInteger(value.setDisplayOffset)) return null;
  if (!isOptionalBoolean(value.refresh) || !isOptionalBoolean(value.popAll)) return null;
  if (
    value.pageSize !== undefined &&
    (!isPositiveInteger(value.pageSize) || value.pageSize > CLASSIC_BROWSE_PAGE_SIZE_MAX)
  ) return null;
  return { ...value } as unknown as ClassicBrowseOptions;
}

function normalizeLoadOptions(value: unknown): ClassicBrowseLoadOptions | null {
  const keys = ["hierarchy", "zoneId", "itemKey", "offset", "count"];
  if (!isRecord(value) || !Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key))) return null;
  if (!isAllowedBrowseHierarchy(value.hierarchy) || !isOptionalBoundedText(value.zoneId) || !isOptionalBoundedText(value.itemKey)) return null;
  if (value.offset !== undefined && !isNonNegativeInteger(value.offset)) return null;
  if (
    value.count !== undefined &&
    (!isPositiveInteger(value.count) || value.count > CLASSIC_LOAD_COUNT_MAX)
  ) return null;
  return { ...value } as unknown as ClassicBrowseLoadOptions;
}

function normalizePopOptions(value: unknown): ClassicBrowsePopOptions | null {
  const keys = ["hierarchy", "pageSize", "zoneId", "levels", "refresh"];
  if (!isRecord(value) || !Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key))) return null;
  if (!isAllowedBrowseHierarchy(value.hierarchy) || !isOptionalBoundedText(value.zoneId)) return null;
  if (
    value.pageSize !== undefined &&
    (!isPositiveInteger(value.pageSize) || value.pageSize > CLASSIC_BROWSE_PAGE_SIZE_MAX)
  ) return null;
  if (value.levels !== undefined && !isPositiveInteger(value.levels)) return null;
  if (!isOptionalBoolean(value.refresh)) return null;
  return { ...value } as unknown as ClassicBrowsePopOptions;
}

function normalizeSearchOptions(value: unknown): ClassicBrowseSearchOptions | null {
  const keys = ["zoneId", "input", "offset", "popAll"];
  if (!isRecord(value) || !Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key))) return null;
  if (!isOptionalBoundedText(value.zoneId) || !isBoundedText(value.input) || value.input.trim().length === 0) return null;
  if (value.offset !== undefined && !isNonNegativeInteger(value.offset)) return null;
  if (!isOptionalBoolean(value.popAll)) return null;
  return { ...value } as unknown as ClassicBrowseSearchOptions;
}

export function normalizeClassicSessionAcquireRequest(
  value: unknown
): ClassicSessionAcquireRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["requestId", "tabId"])) return null;
  if (!isOpaqueId(value.requestId) || !isOpaqueId(value.tabId)) return null;
  return { requestId: value.requestId, tabId: value.tabId };
}

export function normalizeClassicSessionReleaseRequest(
  value: unknown
): ClassicSessionReleaseRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["requestId", "tabId", "session"])) return null;
  if (!isOpaqueId(value.requestId) || !isOpaqueId(value.tabId)) return null;
  const session = normalizeSession(value.session);
  return session ? { requestId: value.requestId, tabId: value.tabId, session } : null;
}

export function normalizeClassicBrowseCommandRequest(
  value: unknown
): ClassicBrowseCommandRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["requestId", "tabId", "session", "role", "operation", "options"]) ||
    !isOpaqueId(value.requestId) ||
    !isOpaqueId(value.tabId) ||
    !CLASSIC_BROWSE_ROLES.includes(value.role as ClassicBrowseRole) ||
    !CLASSIC_BROWSE_OPERATIONS.includes(value.operation as ClassicBrowseOperation)
  ) return null;
  const session = normalizeSession(value.session);
  if (!session) return null;
  const operation = value.operation as ClassicBrowseOperation;
  const options =
    operation === "browse"
      ? normalizeBrowseOptions(value.options)
      : operation === "load"
        ? normalizeLoadOptions(value.options)
        : operation === "pop"
          ? normalizePopOptions(value.options)
          : normalizeSearchOptions(value.options);
  if (!options) return null;
  const role = value.role as ClassicBrowseRole;
  const hierarchy = "hierarchy" in options ? options.hierarchy : "search";
  if (
    (role === "classic-search" && hierarchy !== "search") ||
    (role !== "classic-search" && hierarchy === "search") ||
    (operation === "search" && role !== "classic-search")
  ) return null;
  return { requestId: value.requestId, tabId: value.tabId, session, role, operation, options };
}

function normalizeFailure(value: unknown): ClassicFailureAck | null {
  if (!isRecord(value) || !hasExactKeys(value, ["success", "error", "code"])) return null;
  if (
    value.success !== false ||
    typeof value.error !== "string" ||
    value.error.length === 0 ||
    value.error.length > CLASSIC_BROWSE_ERROR_MAX_LENGTH ||
    !CLASSIC_BROWSE_ERROR_CODES.includes(value.code as ClassicBrowseErrorCode)
  ) return null;
  return { success: false, error: value.error, code: value.code as ClassicBrowseErrorCode };
}

const SEARCH_RESULT_TYPES = [
  "artist",
  "album",
  "track",
  "playlist",
  "genre",
  "composer",
  "label",
  "radio",
  "unknown",
] as const;

function isBrowseItem(value: unknown): value is BrowseResult["items"][number] {
  if (!isRecord(value) || !isBoundedText(value.title)) return false;
  for (const field of ["subtitle", "itemKey", "hint", "imageKey", "itemType", "inputPrompt"] as const) {
    if (!isOptionalBoundedText(value[field])) return false;
  }
  return typeof value.isLoadable === "boolean" && typeof value.isPlayable === "boolean";
}

function isBrowseResult(value: unknown): value is BrowseResult {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > CLASSIC_LOAD_COUNT_MAX) {
    return false;
  }
  if (!isOptionalBoundedText(value.title) || !isOptionalBoundedText(value.subtitle)) return false;
  if (
    !isNonNegativeInteger(value.level) ||
    !isNonNegativeInteger(value.offset) ||
    !isNonNegativeInteger(value.count) ||
    (value.totalCount !== undefined && !isNonNegativeInteger(value.totalCount))
  ) return false;
  return value.items.every(isBrowseItem);
}

function isSearchResult(value: unknown): value is SearchResult {
  if (!isBrowseItem(value) || !isRecord(value)) return false;
  if (value.itemKey !== undefined) return false;
  if (!SEARCH_RESULT_TYPES.includes(value.resultType as SearchResult["resultType"])) return false;
  if (!isOptionalBoundedText(value.categoryTitle)) return false;
  return value.categoryTotal === undefined || isNonNegativeInteger(value.categoryTotal);
}

export function normalizeClassicSessionAcquireAck(
  value: unknown,
  expected: ClassicSessionAcquireRequest
): ClassicSessionAcquireAck | null {
  const failure = normalizeFailure(value);
  if (failure) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["success", "data"]) || value.success !== true) return null;
  if (!isRecord(value.data) || !hasExactKeys(value.data, ["requestId", "session"]) || value.data.requestId !== expected.requestId) return null;
  const session = normalizeSession(value.data.session);
  return session ? { success: true, data: { requestId: expected.requestId, session } } : null;
}

export function normalizeClassicSessionReleaseAck(
  value: unknown,
  expected: ClassicSessionReleaseRequest
): ClassicSessionReleaseAck | null {
  const failure = normalizeFailure(value);
  if (failure) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["success", "data"]) || value.success !== true) return null;
  if (!isRecord(value.data) || !hasExactKeys(value.data, ["requestId"]) || value.data.requestId !== expected.requestId) return null;
  return { success: true, data: { requestId: expected.requestId } };
}

export function normalizeClassicBrowseCommandAck<T>(
  value: unknown,
  expected: ClassicBrowseCommandRequest
): ClassicBrowseCommandAck<T> | null {
  const failure = normalizeFailure(value);
  if (failure) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["success", "data"]) || value.success !== true) return null;
  if (!isRecord(value.data) || !hasExactKeys(value.data, ["requestId", "session", "result"]) || value.data.requestId !== expected.requestId) return null;
  const session = normalizeSession(value.data.session);
  if (!session || session.handleId !== expected.session.handleId || session.generation !== expected.session.generation) return null;
  const resultIsValid =
    expected.operation === "search"
	  ? Array.isArray(value.data.result) &&
		value.data.result.length <= CLASSIC_SEARCH_RESULT_MAX &&
		value.data.result.every(isSearchResult)
      : isBrowseResult(value.data.result);
  if (!resultIsValid) return null;
  return { success: true, data: { requestId: expected.requestId, session, result: value.data.result as T } };
}
