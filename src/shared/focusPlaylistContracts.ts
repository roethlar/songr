import {
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  normalizeCatalogStatus,
  type CatalogStatus,
} from "./catalogContracts";
import {
  SMART_PLAYLIST_FOCUS_SELECTION_MAX_VALUES,
  SMART_PLAYLIST_FOCUS_TEXT_MAX_LENGTH,
  normalizeSmartPlaylistEditorState,
  normalizeSmartPlaylistFocusAdoptedSelections,
  normalizeSmartPlaylistFocusAxisSelections,
  normalizeSmartPlaylistFocusPickerResult,
  type SmartPlaylistEditorState,
  type SmartPlaylistFocusAdoptionRequest,
  type SmartPlaylistFocusAxisSelections,
  type SmartPlaylistFocusPickerRequest,
  type SmartPlaylistFocusPickerResult,
  type SmartPlaylistFocusSelectedValue,
  type SmartPlaylistFocusSelectionAxis,
} from "./smartPlaylistFocusContracts";
import {
  SMART_PLAYLIST_FOCUS_OPTION_BY_AXIS,
  type SmartPlaylistFocusScope,
} from "./smartPlaylistFocusRegistry";

/**
 * Strict HTTP contracts for the product Focus editor. Native identities,
 * object references, profile ids, and picker source values are deliberately
 * absent: the browser carries only editor-bound opaque ids.
 */

export const FOCUS_PLAYLIST_UNEDITABLE_REASON_CODES = [
  "target-ineligible",
  "criteria-missing",
  "criteria-mixed-scope",
  "criteria-unreadable",
  "editor-capability-unavailable",
] as const;

export type FocusPlaylistUneditableReasonCode =
  (typeof FOCUS_PLAYLIST_UNEDITABLE_REASON_CODES)[number];

export const FOCUS_PLAYLIST_ERROR_CODES = [
  "CAPABILITY_UNAVAILABLE",
  "PLAYLIST_NOT_FOUND",
  "PLAYLIST_INELIGIBLE",
  "EDITOR_BUSY",
  "EDITOR_UNAVAILABLE",
  "EDITOR_CONFLICT",
  "SELECTION_STALE",
  "VERIFICATION_FAILED",
  "WRITE_FAILED",
  "WRITE_FAILED_RETIRED",
  "OUTCOME_UNKNOWN",
  "INVALID_REQUEST",
] as const;

export type FocusPlaylistErrorCode =
  (typeof FOCUS_PLAYLIST_ERROR_CODES)[number];

export interface FocusPlaylistScopeCapability {
  readonly fullEditor: boolean;
  readonly filteredCount: boolean;
  readonly unavailableReason?: string;
}

export interface FocusPlaylistManageSmartInfo {
  readonly scope: SmartPlaylistFocusScope | null;
  readonly summary: string;
  readonly editable: boolean;
  readonly uneditableReasonCode?: FocusPlaylistUneditableReasonCode;
  readonly capabilities: {
    readonly tracks: FocusPlaylistScopeCapability;
    readonly albums: FocusPlaylistScopeCapability;
  };
}

export interface FocusPlaylistBootstrapPayload {
  readonly state: SmartPlaylistEditorState;
  readonly previewCount: number;
  readonly selections: readonly SmartPlaylistFocusAxisSelections[];
}

export interface FocusPlaylistBootstrapResponse
  extends FocusPlaylistBootstrapPayload {
  readonly status: CatalogStatus;
}

export interface FocusPlaylistCreateBootstrapRequest {
  readonly scope: SmartPlaylistFocusScope;
  readonly confirmedTakeover?: boolean;
}

export interface FocusPlaylistEditBootstrapRequest {
  readonly confirmedTakeover?: boolean;
}

export interface FocusPlaylistStateRequest {
  readonly state: SmartPlaylistEditorState;
}

export interface FocusPlaylistPickerHttpRequest {
  readonly state: SmartPlaylistEditorState;
  readonly request: SmartPlaylistFocusPickerRequest;
}

export interface FocusPlaylistPickerResponse
  extends SmartPlaylistFocusPickerResult {
  readonly status: CatalogStatus;
}

export interface FocusPlaylistAdoptionHttpRequest {
  readonly state: SmartPlaylistEditorState;
  readonly request: SmartPlaylistFocusAdoptionRequest;
}

export interface FocusPlaylistAdoptionResponse {
  readonly status: CatalogStatus;
  readonly selections: readonly SmartPlaylistFocusSelectedValue[];
}

export interface FocusPlaylistCloseResponse {
  readonly status: CatalogStatus;
  readonly closed: true;
}

export interface FocusPlaylistCreateRequest {
  readonly name: string;
  readonly state: SmartPlaylistEditorState;
}

export interface FocusPlaylistUpdateRequest {
  readonly state: SmartPlaylistEditorState;
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const OPAQUE_ID = /^[A-Za-z0-9_-]{32,128}$/u;

function plainDataRecord(
  value: unknown
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  if (
    required.some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key)
    )
  ) {
    return false;
  }
  return Object.keys(record).every(
    (key) => required.includes(key) || optional.includes(key)
  );
}

function boundedText(
  value: unknown,
  options: { readonly allowEmpty?: boolean } = {}
): value is string {
  return (
    typeof value === "string" &&
    (options.allowEmpty === true || value.length > 0) &&
    value.length <= CATALOG_DISPLAY_TEXT_MAX_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}

function normalizeScopeCapability(
  value: unknown
): FocusPlaylistScopeCapability | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      ["fullEditor", "filteredCount"],
      ["unavailableReason"]
    ) ||
    typeof record.fullEditor !== "boolean" ||
    typeof record.filteredCount !== "boolean"
  ) {
    return null;
  }
  const hasReason = Object.prototype.hasOwnProperty.call(
    record,
    "unavailableReason"
  );
  if (
    hasReason === (record.fullEditor && record.filteredCount) ||
    (hasReason && !boundedText(record.unavailableReason))
  ) {
    return null;
  }
  return {
    fullEditor: record.fullEditor,
    filteredCount: record.filteredCount,
    ...(hasReason
      ? { unavailableReason: record.unavailableReason as string }
      : {}),
  };
}

export function normalizeFocusPlaylistManageSmartInfo(
  value: unknown
): FocusPlaylistManageSmartInfo | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      ["scope", "summary", "editable", "capabilities"],
      ["uneditableReasonCode"]
    ) ||
    !(
      record.scope === null ||
      record.scope === "tracks" ||
      record.scope === "albums"
    ) ||
    !boundedText(record.summary) ||
    typeof record.editable !== "boolean"
  ) {
    return null;
  }
  const capabilitiesRecord = plainDataRecord(record.capabilities);
  if (
    !capabilitiesRecord ||
    !hasExactKeys(capabilitiesRecord, ["tracks", "albums"])
  ) {
    return null;
  }
  const tracks = normalizeScopeCapability(capabilitiesRecord.tracks);
  const albums = normalizeScopeCapability(capabilitiesRecord.albums);
  if (!tracks || !albums) {
    return null;
  }
  const hasReason = Object.prototype.hasOwnProperty.call(
    record,
    "uneditableReasonCode"
  );
  if (
    record.editable === hasReason ||
    (hasReason &&
      !FOCUS_PLAYLIST_UNEDITABLE_REASON_CODES.includes(
        record.uneditableReasonCode as FocusPlaylistUneditableReasonCode
      )) ||
    (record.editable &&
      (record.scope === null ||
        !(record.scope === "tracks"
          ? tracks.fullEditor
          : albums.fullEditor)))
  ) {
    return null;
  }
  return {
    scope: record.scope,
    summary: record.summary,
    editable: record.editable,
    ...(hasReason
      ? {
          uneditableReasonCode:
            record.uneditableReasonCode as FocusPlaylistUneditableReasonCode,
        }
      : {}),
    capabilities: { tracks, albums },
  };
}

function normalizeTakeover(
  value: unknown,
  includeScope: boolean
):
  | FocusPlaylistCreateBootstrapRequest
  | FocusPlaylistEditBootstrapRequest
  | null {
  const record = plainDataRecord(value);
  const required = includeScope ? ["scope"] : [];
  if (
    !record ||
    !hasExactKeys(record, required, ["confirmedTakeover"]) ||
    (includeScope &&
      record.scope !== "tracks" &&
      record.scope !== "albums")
  ) {
    return null;
  }
  const hasTakeover = Object.prototype.hasOwnProperty.call(
    record,
    "confirmedTakeover"
  );
  if (hasTakeover && typeof record.confirmedTakeover !== "boolean") {
    return null;
  }
  return {
    ...(includeScope
      ? { scope: record.scope as SmartPlaylistFocusScope }
      : {}),
    ...(hasTakeover
      ? { confirmedTakeover: record.confirmedTakeover as boolean }
      : {}),
  } as
    | FocusPlaylistCreateBootstrapRequest
    | FocusPlaylistEditBootstrapRequest;
}

export function normalizeFocusPlaylistCreateBootstrapRequest(
  value: unknown
): FocusPlaylistCreateBootstrapRequest | null {
  return normalizeTakeover(
    value,
    true
  ) as FocusPlaylistCreateBootstrapRequest | null;
}

export function normalizeFocusPlaylistEditBootstrapRequest(
  value: unknown
): FocusPlaylistEditBootstrapRequest | null {
  return normalizeTakeover(
    value,
    false
  ) as FocusPlaylistEditBootstrapRequest | null;
}

export function normalizeFocusPlaylistStateRequest(
  value: unknown
): FocusPlaylistStateRequest | null {
  const record = plainDataRecord(value);
  if (!record || !hasExactKeys(record, ["state"])) {
    return null;
  }
  const state = normalizeSmartPlaylistEditorState(record.state);
  return state ? { state } : null;
}

function normalizePickerRequest(
  value: unknown,
  state: SmartPlaylistEditorState
): SmartPlaylistFocusPickerRequest | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["generation", "axis", "textFilter"]) ||
    record.generation !== state.generation ||
    typeof record.axis !== "string" ||
    typeof record.textFilter !== "string" ||
    record.textFilter.length > SMART_PLAYLIST_FOCUS_TEXT_MAX_LENGTH ||
    CONTROL_CHARACTER.test(record.textFilter)
  ) {
    return null;
  }
  const option = SMART_PLAYLIST_FOCUS_OPTION_BY_AXIS.get(
    record.axis as SmartPlaylistFocusSelectionAxis
  );
  if (
    !option ||
    option.scope !== state.document.scope ||
    option.valueKind !== "selection-set" ||
    option.pickerFilter === undefined ||
    (option.pickerFilter === "none" && record.textFilter !== "") ||
    (option.pickerFilter === "required" &&
      (record.textFilter.length === 0 ||
        record.textFilter !== record.textFilter.trim()))
  ) {
    return null;
  }
  return {
    generation: state.generation,
    axis: option.axis,
    textFilter: record.textFilter,
  };
}

export function normalizeFocusPlaylistPickerHttpRequest(
  value: unknown
): FocusPlaylistPickerHttpRequest | null {
  const record = plainDataRecord(value);
  if (!record || !hasExactKeys(record, ["state", "request"])) {
    return null;
  }
  const state = normalizeSmartPlaylistEditorState(record.state);
  if (!state) {
    return null;
  }
  const request = normalizePickerRequest(record.request, state);
  return request ? { state, request } : null;
}

function normalizeAdoptionRequest(
  value: unknown,
  state: SmartPlaylistEditorState
): SmartPlaylistFocusAdoptionRequest | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["generation", "axis", "candidates"]) ||
    record.generation !== state.generation ||
    typeof record.axis !== "string" ||
    !Array.isArray(record.candidates) ||
    record.candidates.length < 1 ||
    record.candidates.length > SMART_PLAYLIST_FOCUS_SELECTION_MAX_VALUES
  ) {
    return null;
  }
  const option = SMART_PLAYLIST_FOCUS_OPTION_BY_AXIS.get(
    record.axis as SmartPlaylistFocusSelectionAxis
  );
  if (
    !option ||
    option.scope !== state.document.scope ||
    option.valueKind !== "selection-set"
  ) {
    return null;
  }
  const seen = new Set<string>();
  const candidates: Array<{
    candidateId: string;
    displayLabel: string;
  }> = [];
  for (const valueCandidate of record.candidates) {
    const candidate = plainDataRecord(valueCandidate);
    if (
      !candidate ||
      !hasExactKeys(candidate, ["candidateId", "displayLabel"]) ||
      typeof candidate.candidateId !== "string" ||
      !OPAQUE_ID.test(candidate.candidateId) ||
      seen.has(candidate.candidateId) ||
      !boundedText(candidate.displayLabel)
    ) {
      return null;
    }
    seen.add(candidate.candidateId);
    candidates.push({
      candidateId: candidate.candidateId,
      displayLabel: candidate.displayLabel,
    });
  }
  return {
    generation: state.generation,
    axis: option.axis,
    candidates,
  };
}

export function normalizeFocusPlaylistAdoptionHttpRequest(
  value: unknown
): FocusPlaylistAdoptionHttpRequest | null {
  const record = plainDataRecord(value);
  if (!record || !hasExactKeys(record, ["state", "request"])) {
    return null;
  }
  const state = normalizeSmartPlaylistEditorState(record.state);
  if (!state) {
    return null;
  }
  const request = normalizeAdoptionRequest(record.request, state);
  return request ? { state, request } : null;
}

export function normalizeFocusPlaylistCreateRequest(
  value: unknown
): FocusPlaylistCreateRequest | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["name", "state"]) ||
    !boundedText(record.name)
  ) {
    return null;
  }
  const state = normalizeSmartPlaylistEditorState(record.state);
  if (!state || state.baselineRevision !== undefined) {
    return null;
  }
  return { name: record.name, state };
}

export function normalizeFocusPlaylistUpdateRequest(
  value: unknown
): FocusPlaylistUpdateRequest | null {
  const normalized = normalizeFocusPlaylistStateRequest(value);
  return normalized?.state.baselineRevision === undefined
    ? null
    : normalized;
}

export function normalizeFocusPlaylistBootstrapResponse(
  value: unknown
): FocusPlaylistBootstrapResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "status",
      "state",
      "previewCount",
      "selections",
    ])
  ) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  const state = normalizeSmartPlaylistEditorState(record.state);
  if (
    !status ||
    !state ||
    !Number.isSafeInteger(record.previewCount) ||
    (record.previewCount as number) < 0
  ) {
    return null;
  }
  const selections = normalizeSmartPlaylistFocusAxisSelections(
    record.selections,
    state.document
  );
  return selections
    ? {
        status,
        state,
        previewCount: record.previewCount as number,
        selections,
      }
    : null;
}

export function normalizeFocusPlaylistPickerResponse(
  value: unknown
): FocusPlaylistPickerResponse | null {
  const record = plainDataRecord(value);
  if (!record) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  if (!status) {
    return null;
  }
  const pickerValue = { ...record };
  delete pickerValue.status;
  const picker = normalizeSmartPlaylistFocusPickerResult(pickerValue);
  return picker ? { status, ...picker } : null;
}

export function normalizeFocusPlaylistAdoptionResponse(
  value: unknown
): FocusPlaylistAdoptionResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["status", "selections"])
  ) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  const selections = normalizeSmartPlaylistFocusAdoptedSelections(
    record.selections
  );
  return status && selections ? { status, selections } : null;
}

export function normalizeFocusPlaylistCloseResponse(
  value: unknown
): FocusPlaylistCloseResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["status", "closed"]) ||
    record.closed !== true
  ) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  return status ? { status, closed: true } : null;
}

export function isFocusPlaylistErrorCode(
  value: unknown
): value is FocusPlaylistErrorCode {
  return FOCUS_PLAYLIST_ERROR_CODES.includes(
    value as FocusPlaylistErrorCode
  );
}
