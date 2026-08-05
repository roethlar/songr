/**
 * Strict browser contracts for the full native Focus editor.
 *
 * Native ids, query-info object ids, and picker candidate ids are not
 * representable in a Focus document. HTTP lifecycle envelopes live in
 * focusPlaylistContracts.ts so this module remains the pure document contract.
 */
import {
  SMART_PLAYLIST_ALBUM_DATE_PREFERENCES,
  SMART_PLAYLIST_ALBUM_ORDERINGS,
  SMART_PLAYLIST_FOCUS_OPTION_BY_AXIS,
  SMART_PLAYLIST_FOCUS_OPTIONS,
  SMART_PLAYLIST_ORDERING_DIRECTIONS,
  SMART_PLAYLIST_TRACK_ORDERINGS,
} from "./smartPlaylistFocusRegistry";
import type {
  SmartPlaylistFocusAxis,
  SmartPlaylistFocusOptionDefinition,
  SmartPlaylistFocusScope,
  SmartPlaylistFocusValueKind,
} from "./smartPlaylistFocusRegistry";

export const SMART_PLAYLIST_FOCUS_DOCUMENT_VERSION = 1 as const;
export const SMART_PLAYLIST_FOCUS_TEXT_MAX_LENGTH = 512;
export const SMART_PLAYLIST_FOCUS_SELECTION_MAX_VALUES = 100;

export type SmartPlaylistFocusPolarity = "include" | "exclude";
export type SmartPlaylistFocusRuleMode = "and" | "or";
export type SmartPlaylistFocusPartialDate = string;

type AxisForKind<Kind extends SmartPlaylistFocusValueKind> = Extract<
  SmartPlaylistFocusOptionDefinition,
  { readonly valueKind: Kind }
>["axis"];

interface SmartPlaylistFocusRuleBase<
  Kind extends SmartPlaylistFocusValueKind,
> {
  readonly axis: AxisForKind<Kind>;
  readonly kind: Kind;
  readonly polarity?: SmartPlaylistFocusPolarity;
  readonly mode?: SmartPlaylistFocusRuleMode;
}

export interface SmartPlaylistFocusSelectionSetRule
  extends SmartPlaylistFocusRuleBase<"selection-set"> {
  /** Stable editor-bound value-selection ids; never picker candidate ids. */
  readonly values: readonly string[];
}

export interface SmartPlaylistFocusSymbolSetRule
  extends SmartPlaylistFocusRuleBase<"symbol-set"> {
  /** Registry-declared symbols, never native enum integers. */
  readonly values: readonly string[];
}

export interface SmartPlaylistFocusIntegerRule
  extends SmartPlaylistFocusRuleBase<"integer"> {
  readonly value: number;
}

export interface SmartPlaylistFocusIntegerRangeRule
  extends SmartPlaylistFocusRuleBase<"integer-range"> {
  readonly min?: number;
  readonly max?: number;
}

export interface SmartPlaylistFocusDateRangeRule
  extends SmartPlaylistFocusRuleBase<"date-range"> {
  readonly min?: SmartPlaylistFocusPartialDate;
  readonly max?: SmartPlaylistFocusPartialDate;
}

export type SmartPlaylistFocusStateRule =
  SmartPlaylistFocusRuleBase<"state">;

export interface SmartPlaylistFocusTextRule
  extends SmartPlaylistFocusRuleBase<"text"> {
  readonly value: string;
}

export type SmartPlaylistFocusRule =
  | SmartPlaylistFocusSelectionSetRule
  | SmartPlaylistFocusSymbolSetRule
  | SmartPlaylistFocusIntegerRule
  | SmartPlaylistFocusIntegerRangeRule
  | SmartPlaylistFocusDateRangeRule
  | SmartPlaylistFocusStateRule
  | SmartPlaylistFocusTextRule;

type AxisForScope<Scope extends SmartPlaylistFocusScope> = Extract<
  SmartPlaylistFocusOptionDefinition,
  { readonly scope: Scope }
>["axis"];

export type SmartPlaylistTrackFocusRule = SmartPlaylistFocusRule & {
  readonly axis: AxisForScope<"tracks">;
};
export type SmartPlaylistAlbumFocusRule = SmartPlaylistFocusRule & {
  readonly axis: AxisForScope<"albums">;
};

export type SmartPlaylistTrackOrderSymbol =
  (typeof SMART_PLAYLIST_TRACK_ORDERINGS)[number];
export type SmartPlaylistAlbumOrderSymbol =
  (typeof SMART_PLAYLIST_ALBUM_ORDERINGS)[number];
export type SmartPlaylistOrderingDirection =
  (typeof SMART_PLAYLIST_ORDERING_DIRECTIONS)[number];
export type SmartPlaylistAlbumDatePreference =
  (typeof SMART_PLAYLIST_ALBUM_DATE_PREFERENCES)[number];

export interface SmartPlaylistPreservedLegacyOrdering {
  /**
   * No bytes or enum integer cross HTTP. The baseline revision separately
   * binds the fresh stored legacy-ordering digest.
   */
  readonly kind: "preserved-legacy";
}

export interface SmartPlaylistTrackCurrentOrdering {
  readonly kind: "current";
  readonly ordering: SmartPlaylistTrackOrderSymbol;
  readonly direction: SmartPlaylistOrderingDirection;
  readonly orderByLastFirstName: boolean;
  readonly orderComposersByLastFirstName: boolean;
  readonly albumDatePreference: SmartPlaylistAlbumDatePreference;
  readonly randomSeed: number;
}

export interface SmartPlaylistAlbumCurrentOrdering {
  readonly kind: "current";
  readonly ordering: SmartPlaylistAlbumOrderSymbol;
  readonly direction: SmartPlaylistOrderingDirection;
  readonly orderByLastFirstName: boolean;
  readonly orderComposersByLastFirstName: boolean;
  readonly orderVariousArtistsByAlbumTitle: boolean;
  readonly albumDatePreference: SmartPlaylistAlbumDatePreference;
  readonly randomSeed: number;
  readonly variousArtistsSortKey: string;
}

export type SmartPlaylistTrackOrder =
  | SmartPlaylistTrackCurrentOrdering
  | SmartPlaylistPreservedLegacyOrdering;
export type SmartPlaylistAlbumOrder =
  | SmartPlaylistAlbumCurrentOrdering
  | SmartPlaylistPreservedLegacyOrdering;

export interface SmartPlaylistTrackFocusDocument {
  readonly version: typeof SMART_PLAYLIST_FOCUS_DOCUMENT_VERSION;
  readonly scope: "tracks";
  readonly criteria: readonly SmartPlaylistTrackFocusRule[];
  readonly ordering: SmartPlaylistTrackOrder;
}

export interface SmartPlaylistAlbumFocusDocument {
  readonly version: typeof SMART_PLAYLIST_FOCUS_DOCUMENT_VERSION;
  readonly scope: "albums";
  readonly criteria: readonly SmartPlaylistAlbumFocusRule[];
  readonly ordering: SmartPlaylistAlbumOrder;
}

export type SmartPlaylistFocusDocument =
  | SmartPlaylistTrackFocusDocument
  | SmartPlaylistAlbumFocusDocument;

export interface SmartPlaylistEditorState {
  /** Random opaque server lease id. */
  readonly editorId: string;
  /** Monotonic document generation within this editor lease. */
  readonly generation: number;
  /** Server-minted edit precondition; absent exactly for a create bootstrap. */
  readonly baselineRevision?: string;
  readonly document: SmartPlaylistFocusDocument;
}

export type SmartPlaylistFocusSelectionAxis =
  AxisForKind<"selection-set">;

export interface SmartPlaylistFocusSelectedValue {
  /** Stable editor-bound value-selection id; never a native identity. */
  readonly selectionId: string;
  readonly displayLabel: string;
}

export interface SmartPlaylistFocusAxisSelections {
  readonly axis: SmartPlaylistFocusSelectionAxis;
  readonly values: readonly SmartPlaylistFocusSelectedValue[];
}

export interface SmartPlaylistFocusPickerCandidate {
  readonly candidateId: string;
  /**
   * Present only when this candidate reuses an already adopted value.
   * It remains editor-bound and never exposes a stable native identity.
   */
  readonly selectionId?: string;
  readonly displayLabel: string;
}

export interface SmartPlaylistFocusPickerRequest {
  readonly generation: number;
  readonly axis: SmartPlaylistFocusSelectionAxis;
  readonly textFilter: string;
}

export interface SmartPlaylistFocusPickerResult {
  readonly generation: number;
  readonly axis: SmartPlaylistFocusSelectionAxis;
  readonly textFilter: string;
  readonly candidates: readonly SmartPlaylistFocusPickerCandidate[];
  readonly totalCount: number;
  readonly truncated: boolean;
}

export interface SmartPlaylistFocusCandidateAdoption {
  readonly candidateId: string;
  /** Exact candidate-label echo consumed by the server. */
  readonly displayLabel: string;
}

export interface SmartPlaylistFocusAdoptionRequest {
  readonly generation: number;
  readonly axis: SmartPlaylistFocusSelectionAxis;
  readonly candidates: readonly SmartPlaylistFocusCandidateAdoption[];
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const OPAQUE_ID = /^[A-Za-z0-9_-]{32,128}$/u;
const OPAQUE_BASELINE = /^[A-Za-z0-9_-]{32,512}$/u;
const PARTIAL_DATE = /^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?$/u;
const INT32_MAX = 2_147_483_647;

export const DEFAULT_TRACK_FOCUS_ORDERING: SmartPlaylistTrackCurrentOrdering =
  Object.freeze({
    kind: "current",
    ordering: "album-performed-by",
    direction: "ascending",
    orderByLastFirstName: false,
    orderComposersByLastFirstName: false,
    albumDatePreference: "original-release-date",
    randomSeed: 0,
  });

export const DEFAULT_ALBUM_FOCUS_ORDERING: SmartPlaylistAlbumCurrentOrdering =
  Object.freeze({
    kind: "current",
    ordering: "main-performer-name",
    direction: "ascending",
    orderByLastFirstName: false,
    orderComposersByLastFirstName: false,
    orderVariousArtistsByAlbumTitle: false,
    albumDatePreference: "original-release-date",
    randomSeed: 0,
    variousArtistsSortKey: "",
  });

function plainDataRecord(value: unknown): Record<string, unknown> | null {
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
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return false;
    }
  }
  return Object.keys(record).every(
    (key) => required.includes(key) || optional.includes(key)
  );
}

function isOpaqueSelectionId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function normalizeFocusDisplayLabel(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= SMART_PLAYLIST_FOCUS_TEXT_MAX_LENGTH &&
    value === value.trim() &&
    !CONTROL_CHARACTER.test(value)
    ? value
    : null;
}

function optionForAxis(
  value: unknown
): SmartPlaylistFocusOptionDefinition | null {
  if (typeof value !== "string") {
    return null;
  }
  return (
    SMART_PLAYLIST_FOCUS_OPTION_BY_AXIS.get(
      value as SmartPlaylistFocusAxis
    ) ?? null
  );
}

function normalizeFocusSelectedValue(
  value: unknown,
  idKey: "selectionId" | "candidateId",
  additionalKeys: readonly string[] = []
): { id: string; displayLabel: string } | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [idKey, ...additionalKeys, "displayLabel"]) ||
    !isOpaqueSelectionId(record[idKey])
  ) {
    return null;
  }
  const displayLabel = normalizeFocusDisplayLabel(record.displayLabel);
  return displayLabel === null
    ? null
    : { id: record[idKey], displayLabel };
}

export function normalizeSmartPlaylistFocusAxisSelections(
  value: unknown,
  documentValue: unknown
): readonly SmartPlaylistFocusAxisSelections[] | null {
  const document = normalizeSmartPlaylistFocusDocument(documentValue);
  if (!document || !Array.isArray(value)) {
    return null;
  }
  const selectionRules = document.criteria.filter(
    (rule) => rule.kind === "selection-set"
  );
  if (value.length !== selectionRules.length) {
    return null;
  }
  const byAxis = new Map<
    SmartPlaylistFocusSelectionAxis,
    SmartPlaylistFocusAxisSelections
  >();
  const seenSelectionIds = new Set<string>();
  for (const candidate of value) {
    const record = plainDataRecord(candidate);
    const option = record ? optionForAxis(record.axis) : null;
    if (
      !record ||
      !hasExactKeys(record, ["axis", "values"]) ||
      !option ||
      option.scope !== document.scope ||
      option.valueKind !== "selection-set" ||
      !Array.isArray(record.values) ||
      record.values.length < 1 ||
      record.values.length > SMART_PLAYLIST_FOCUS_SELECTION_MAX_VALUES ||
      byAxis.has(option.axis)
    ) {
      return null;
    }
    const values: SmartPlaylistFocusSelectedValue[] = [];
    for (const selected of record.values) {
      const normalized = normalizeFocusSelectedValue(
        selected,
        "selectionId"
      );
      if (!normalized || seenSelectionIds.has(normalized.id)) {
        return null;
      }
      seenSelectionIds.add(normalized.id);
      values.push({
        selectionId: normalized.id,
        displayLabel: normalized.displayLabel,
      });
    }
    byAxis.set(option.axis, {
      axis: option.axis,
      values,
    });
  }
  const normalized: SmartPlaylistFocusAxisSelections[] = [];
  for (const rule of selectionRules) {
    const selections = byAxis.get(rule.axis);
    if (
      !selections ||
      selections.values.length !== rule.values.length ||
      selections.values.some(
        (selected, index) => selected.selectionId !== rule.values[index]
      )
    ) {
      return null;
    }
    normalized.push(selections);
  }
  return normalized;
}

export function normalizeSmartPlaylistFocusPickerResult(
  value: unknown
): SmartPlaylistFocusPickerResult | null {
  const record = plainDataRecord(value);
  const option = record ? optionForAxis(record.axis) : null;
  if (
    !record ||
    !hasExactKeys(record, [
      "generation",
      "axis",
      "textFilter",
      "candidates",
      "totalCount",
      "truncated",
    ]) ||
    typeof record.generation !== "number" ||
    !Number.isSafeInteger(record.generation) ||
    record.generation < 1 ||
    !option ||
    option.valueKind !== "selection-set" ||
    typeof record.textFilter !== "string" ||
    record.textFilter.length > SMART_PLAYLIST_FOCUS_TEXT_MAX_LENGTH ||
    CONTROL_CHARACTER.test(record.textFilter) ||
    !Array.isArray(record.candidates) ||
    record.candidates.length > SMART_PLAYLIST_FOCUS_SELECTION_MAX_VALUES ||
    typeof record.totalCount !== "number" ||
    !Number.isSafeInteger(record.totalCount) ||
    record.totalCount < record.candidates.length ||
    typeof record.truncated !== "boolean"
  ) {
    return null;
  }
  const candidates: SmartPlaylistFocusPickerCandidate[] = [];
  const seen = new Set<string>();
  const seenSelections = new Set<string>();
  for (const candidate of record.candidates) {
    const candidateRecord = plainDataRecord(candidate);
    const reusesSelection =
      candidateRecord !== null &&
      Object.prototype.hasOwnProperty.call(
        candidateRecord,
        "selectionId"
      );
    if (
      !candidateRecord ||
      !hasExactKeys(
        candidateRecord,
        reusesSelection
          ? ["candidateId", "selectionId", "displayLabel"]
          : ["candidateId", "displayLabel"]
      )
    ) {
      return null;
    }
    const normalized = normalizeFocusSelectedValue(
      candidate,
      "candidateId",
      reusesSelection ? ["selectionId"] : []
    );
    const selectionId = reusesSelection
      ? candidateRecord.selectionId
      : undefined;
    if (
      !normalized ||
      seen.has(normalized.id) ||
      (selectionId !== undefined &&
        (!isOpaqueSelectionId(selectionId) ||
          seenSelections.has(selectionId)))
    ) {
      return null;
    }
    seen.add(normalized.id);
    if (selectionId !== undefined) {
      seenSelections.add(selectionId);
    }
    candidates.push({
      candidateId: normalized.id,
      ...(selectionId === undefined ? {} : { selectionId }),
      displayLabel: normalized.displayLabel,
    });
  }
  return {
    generation: record.generation,
    axis: option.axis,
    textFilter: record.textFilter,
    candidates,
    totalCount: record.totalCount,
    truncated: record.truncated,
  };
}

export function normalizeSmartPlaylistFocusAdoptedSelections(
  value: unknown
): readonly SmartPlaylistFocusSelectedValue[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SMART_PLAYLIST_FOCUS_SELECTION_MAX_VALUES
  ) {
    return null;
  }
  const selections: SmartPlaylistFocusSelectedValue[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const normalized = normalizeFocusSelectedValue(
      candidate,
      "selectionId"
    );
    if (!normalized || seen.has(normalized.id)) {
      return null;
    }
    seen.add(normalized.id);
    selections.push({
      selectionId: normalized.id,
      displayLabel: normalized.displayLabel,
    });
  }
  return selections;
}

export interface SmartPlaylistFocusParsedPartialDate {
  canonical: string;
  year: number;
  month: number | null;
  day: number | null;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap =
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseSmartPlaylistFocusPartialDate(
  value: unknown
): SmartPlaylistFocusParsedPartialDate | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = PARTIAL_DATE.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = match[2] === undefined ? null : Number(match[2]);
  const day = match[3] === undefined ? null : Number(match[3]);
  if (
    year < 1 ||
    year > 9_999 ||
    (month !== null && (month < 1 || month > 12)) ||
    (day !== null && month === null)
  ) {
    return null;
  }
  if (day !== null) {
    if (day < 1 || day > daysInMonth(year, month as number)) {
      return null;
    }
  }
  return { canonical: value, year, month, day };
}

function partialDateLowerBound(
  value: SmartPlaylistFocusParsedPartialDate
): number {
  return value.year * 372 + (value.month ?? 1) * 31 + (value.day ?? 1);
}

function partialDateUpperBound(
  value: SmartPlaylistFocusParsedPartialDate
): number {
  const month = value.month ?? 12;
  const day = value.day ?? daysInMonth(value.year, month);
  return value.year * 372 + month * 31 + day;
}

function normalizePolarityAndMode(
  record: Record<string, unknown>,
  option: SmartPlaylistFocusOptionDefinition,
  target: Record<string, unknown>
): boolean {
  if (option.polarity === "none") {
    if (Object.prototype.hasOwnProperty.call(record, "polarity")) {
      return false;
    }
  } else {
    if (record.polarity !== "include" && record.polarity !== "exclude") {
      return false;
    }
    target.polarity = record.polarity;
  }

  if (!option.mode) {
    if (Object.prototype.hasOwnProperty.call(record, "mode")) {
      return false;
    }
  } else {
    if (record.mode !== "and" && record.mode !== "or") {
      return false;
    }
    target.mode = record.mode;
  }
  return true;
}

function conditionalRuleKeys(
  option: SmartPlaylistFocusOptionDefinition
): string[] {
  return [
    ...(option.polarity === "none" ? [] : ["polarity"]),
    ...(option.mode ? ["mode"] : []),
  ];
}

function normalizeSelectionValues(
  value: unknown,
  predicate: (candidate: unknown) => candidate is string
): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SMART_PLAYLIST_FOCUS_SELECTION_MAX_VALUES
  ) {
    return null;
  }
  const values: string[] = [];
  for (const candidate of value) {
    if (!predicate(candidate) || values.includes(candidate)) {
      return null;
    }
    values.push(candidate);
  }
  return values;
}

function isBoundedInteger(
  value: unknown,
  option: SmartPlaylistFocusOptionDefinition
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (option.minimum === undefined || (value as number) >= option.minimum) &&
    (option.maximum === undefined || (value as number) <= option.maximum)
  );
}

function normalizeFocusRule(
  value: unknown,
  scope: SmartPlaylistFocusScope
): SmartPlaylistFocusRule | null {
  const record = plainDataRecord(value);
  if (!record) {
    return null;
  }
  const option = optionForAxis(record.axis);
  if (
    !option ||
    option.scope !== scope ||
    option.placement !== "criteria" ||
    record.kind !== option.valueKind
  ) {
    return null;
  }
  const conditionalKeys = conditionalRuleKeys(option);
  const normalized: Record<string, unknown> = {
    axis: option.axis,
    kind: option.valueKind,
  };

  switch (option.valueKind) {
    case "selection-set": {
      if (
        !hasExactKeys(record, ["axis", "kind", "values", ...conditionalKeys])
      ) {
        return null;
      }
      const values = normalizeSelectionValues(
        record.values,
        isOpaqueSelectionId
      );
      if (!values) {
        return null;
      }
      normalized.values = values;
      break;
    }
    case "symbol-set": {
      if (
        !hasExactKeys(record, ["axis", "kind", "values", ...conditionalKeys])
      ) {
        return null;
      }
      const symbols = option.enumSymbols ?? [];
      const values = normalizeSelectionValues(
        record.values,
        (candidate): candidate is string =>
          typeof candidate === "string" && symbols.includes(candidate)
      );
      if (!values) {
        return null;
      }
      normalized.values = values;
      break;
    }
    case "integer":
      if (
        !hasExactKeys(record, ["axis", "kind", "value", ...conditionalKeys]) ||
        !isBoundedInteger(record.value, option)
      ) {
        return null;
      }
      normalized.value = record.value;
      break;
    case "integer-range": {
      if (
        !hasExactKeys(
          record,
          ["axis", "kind", ...conditionalKeys],
          ["min", "max"]
        ) ||
        (!Object.prototype.hasOwnProperty.call(record, "min") &&
          !Object.prototype.hasOwnProperty.call(record, "max")) ||
        (Object.prototype.hasOwnProperty.call(record, "min") &&
          !isBoundedInteger(record.min, option)) ||
        (Object.prototype.hasOwnProperty.call(record, "max") &&
          !isBoundedInteger(record.max, option))
      ) {
        return null;
      }
      const min = record.min as number | undefined;
      const max = record.max as number | undefined;
      if (min !== undefined && max !== undefined && min > max) {
        return null;
      }
      if (min !== undefined) {
        normalized.min = min;
      }
      if (max !== undefined) {
        normalized.max = max;
      }
      break;
    }
    case "date-range": {
      if (
        !hasExactKeys(
          record,
          ["axis", "kind", ...conditionalKeys],
          ["min", "max"]
        ) ||
        (!Object.prototype.hasOwnProperty.call(record, "min") &&
          !Object.prototype.hasOwnProperty.call(record, "max"))
      ) {
        return null;
      }
      const min = Object.prototype.hasOwnProperty.call(record, "min")
        ? parseSmartPlaylistFocusPartialDate(record.min)
        : null;
      const max = Object.prototype.hasOwnProperty.call(record, "max")
        ? parseSmartPlaylistFocusPartialDate(record.max)
        : null;
      if (
        (Object.prototype.hasOwnProperty.call(record, "min") && !min) ||
        (Object.prototype.hasOwnProperty.call(record, "max") && !max) ||
        !option.datePrecision ||
        (option.datePrecision === "year" &&
          ((min && (min.month !== null || min.day !== null)) ||
            (max && (max.month !== null || max.day !== null)))) ||
        (min &&
          max &&
          partialDateLowerBound(min) > partialDateUpperBound(max))
      ) {
        return null;
      }
      if (min) {
        normalized.min = min.canonical;
      }
      if (max) {
        normalized.max = max.canonical;
      }
      break;
    }
    case "state":
      if (!hasExactKeys(record, ["axis", "kind", ...conditionalKeys])) {
        return null;
      }
      break;
    case "text":
      if (
        !hasExactKeys(record, ["axis", "kind", "value", ...conditionalKeys]) ||
        typeof record.value !== "string" ||
        record.value.length < 1 ||
        record.value.length > SMART_PLAYLIST_FOCUS_TEXT_MAX_LENGTH ||
        record.value !== record.value.trim() ||
        CONTROL_CHARACTER.test(record.value)
      ) {
        return null;
      }
      normalized.value = record.value;
      break;
    case "ordering":
      return null;
  }

  if (!normalizePolarityAndMode(record, option, normalized)) {
    return null;
  }
  return normalized as unknown as SmartPlaylistFocusRule;
}

function validDirection(
  value: unknown
): value is SmartPlaylistOrderingDirection {
  return SMART_PLAYLIST_ORDERING_DIRECTIONS.includes(
    value as SmartPlaylistOrderingDirection
  );
}

function validDatePreference(
  value: unknown
): value is SmartPlaylistAlbumDatePreference {
  return SMART_PLAYLIST_ALBUM_DATE_PREFERENCES.includes(
    value as SmartPlaylistAlbumDatePreference
  );
}

function validRandomSeed(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= INT32_MAX
  );
}

function normalizeTrackOrder(
  value: unknown
): SmartPlaylistTrackOrder | null {
  const record = plainDataRecord(value);
  if (!record) {
    return null;
  }
  if (record.kind === "preserved-legacy") {
    return hasExactKeys(record, ["kind"])
      ? { kind: "preserved-legacy" }
      : null;
  }
  if (
    record.kind !== "current" ||
    !hasExactKeys(record, [
      "kind",
      "ordering",
      "direction",
      "orderByLastFirstName",
      "orderComposersByLastFirstName",
      "albumDatePreference",
      "randomSeed",
    ]) ||
    !SMART_PLAYLIST_TRACK_ORDERINGS.includes(
      record.ordering as SmartPlaylistTrackOrderSymbol
    ) ||
    !validDirection(record.direction) ||
    typeof record.orderByLastFirstName !== "boolean" ||
    typeof record.orderComposersByLastFirstName !== "boolean" ||
    !validDatePreference(record.albumDatePreference) ||
    !validRandomSeed(record.randomSeed)
  ) {
    return null;
  }
  return {
    kind: "current",
    ordering: record.ordering as SmartPlaylistTrackOrderSymbol,
    direction: record.direction,
    orderByLastFirstName: record.orderByLastFirstName,
    orderComposersByLastFirstName:
      record.orderComposersByLastFirstName,
    albumDatePreference: record.albumDatePreference,
    randomSeed: record.randomSeed,
  };
}

function normalizeAlbumOrder(
  value: unknown
): SmartPlaylistAlbumOrder | null {
  const record = plainDataRecord(value);
  if (!record) {
    return null;
  }
  if (record.kind === "preserved-legacy") {
    return hasExactKeys(record, ["kind"])
      ? { kind: "preserved-legacy" }
      : null;
  }
  if (
    record.kind !== "current" ||
    !hasExactKeys(record, [
      "kind",
      "ordering",
      "direction",
      "orderByLastFirstName",
      "orderComposersByLastFirstName",
      "orderVariousArtistsByAlbumTitle",
      "albumDatePreference",
      "randomSeed",
      "variousArtistsSortKey",
    ]) ||
    !SMART_PLAYLIST_ALBUM_ORDERINGS.includes(
      record.ordering as SmartPlaylistAlbumOrderSymbol
    ) ||
    !validDirection(record.direction) ||
    typeof record.orderByLastFirstName !== "boolean" ||
    typeof record.orderComposersByLastFirstName !== "boolean" ||
    typeof record.orderVariousArtistsByAlbumTitle !== "boolean" ||
    !validDatePreference(record.albumDatePreference) ||
    !validRandomSeed(record.randomSeed) ||
    typeof record.variousArtistsSortKey !== "string" ||
    record.variousArtistsSortKey.length >
      SMART_PLAYLIST_FOCUS_TEXT_MAX_LENGTH ||
    CONTROL_CHARACTER.test(record.variousArtistsSortKey)
  ) {
    return null;
  }
  return {
    kind: "current",
    ordering: record.ordering as SmartPlaylistAlbumOrderSymbol,
    direction: record.direction,
    orderByLastFirstName: record.orderByLastFirstName,
    orderComposersByLastFirstName:
      record.orderComposersByLastFirstName,
    orderVariousArtistsByAlbumTitle:
      record.orderVariousArtistsByAlbumTitle,
    albumDatePreference: record.albumDatePreference,
    randomSeed: record.randomSeed,
    variousArtistsSortKey: record.variousArtistsSortKey,
  };
}

export function normalizeSmartPlaylistFocusDocument(
  value: unknown
): SmartPlaylistFocusDocument | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["version", "scope", "criteria", "ordering"]) ||
    record.version !== SMART_PLAYLIST_FOCUS_DOCUMENT_VERSION ||
    (record.scope !== "tracks" && record.scope !== "albums") ||
    !Array.isArray(record.criteria)
  ) {
    return null;
  }
  const scope = record.scope;
  const maximumRules = SMART_PLAYLIST_FOCUS_OPTIONS.filter(
    (option) => option.scope === scope && option.placement === "criteria"
  ).length;
  if (record.criteria.length > maximumRules) {
    return null;
  }

  const criteria: SmartPlaylistFocusRule[] = [];
  const axes = new Set<SmartPlaylistFocusAxis>();
  for (const candidate of record.criteria) {
    const rule = normalizeFocusRule(candidate, scope);
    if (!rule || axes.has(rule.axis)) {
      return null;
    }
    axes.add(rule.axis);
    criteria.push(rule);
  }

  if (scope === "tracks") {
    const ordering = normalizeTrackOrder(record.ordering);
    return ordering
      ? {
          version: SMART_PLAYLIST_FOCUS_DOCUMENT_VERSION,
          scope,
          criteria: criteria as SmartPlaylistTrackFocusRule[],
          ordering,
        }
      : null;
  }
  const ordering = normalizeAlbumOrder(record.ordering);
  return ordering
    ? {
        version: SMART_PLAYLIST_FOCUS_DOCUMENT_VERSION,
        scope,
        criteria: criteria as SmartPlaylistAlbumFocusRule[],
        ordering,
      }
    : null;
}

export function normalizeSmartPlaylistEditorState(
  value: unknown
): SmartPlaylistEditorState | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      ["editorId", "generation", "document"],
      ["baselineRevision"]
    ) ||
    typeof record.editorId !== "string" ||
    !OPAQUE_ID.test(record.editorId) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    (Object.prototype.hasOwnProperty.call(record, "baselineRevision") &&
      (typeof record.baselineRevision !== "string" ||
        !OPAQUE_BASELINE.test(record.baselineRevision)))
  ) {
    return null;
  }
  const document = normalizeSmartPlaylistFocusDocument(record.document);
  if (!document) {
    return null;
  }
  return {
    editorId: record.editorId,
    generation: record.generation as number,
    ...(typeof record.baselineRevision === "string"
      ? { baselineRevision: record.baselineRevision }
      : {}),
    document,
  };
}
