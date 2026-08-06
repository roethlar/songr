/**
 * Durable, keyless catalog contracts shared by the server and Timeline UI.
 *
 * These parsers intentionally accept only controller-normalized data. Roon
 * browse/session keys are neither descriptor identity nor valid payload fields.
 */

export const CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT =
  "controller-normalized-browse-album-detail-v1" as const;

export const CATALOG_RESOLUTION_STATUSES = [
  "unresolved",
  "resolved",
  "ambiguous",
  "missing",
] as const;

export type CatalogResolutionStatus =
  (typeof CATALOG_RESOLUTION_STATUSES)[number];

export type CatalogReleaseYearEvidenceField =
  | "original-release-date"
  | "edition-release-date";

export interface CatalogReleaseYearEvidence {
  sourceContract: typeof CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT;
  field: CatalogReleaseYearEvidenceField;
  /** Canonical YYYY, YYYY-MM, or YYYY-MM-DD evidence text. */
  date: string;
}

export interface ArtistRef {
  localId: string;
  coreId: string;
  exactName: string;
  normalizedName: string;
  imageKeyHint?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolutionStatus: CatalogResolutionStatus;
}

/**
 * A release date known only to some precision: integer parts, with 0 for
 * month and day when only the coarser parts are known. Carried on enriched
 * catalog albums as-is, so a year-only date stays year-only rather than being
 * rounded to January 1st.
 */
export interface CatalogPartialDate {
  year: number;
  /** 0 when only the year is known. */
  month: number;
  /** 0 when only year/month are known. */
  day: number;
}

interface AlbumRefBase {
  localId: string;
  coreId: string;
  artistLocalId?: string;
  exactTitle: string;
  exactArtist: string;
  normalizedTitle: string;
  normalizedArtist: string;
  /** Canonical display text; empty string means no edition text was observed. */
  editionText: string;
  /** Lowercase SHA-256 over the normalized ordered track-title sequence. */
  trackTitleFingerprint?: string;
  imageKeyHint?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolutionStatus: CatalogResolutionStatus;
  /**
   * Fields the extended feature layer contributes (catalog persistence v3).
   * Present only on albums the layer matched to the catalog exactly; ambiguous
   * and unmatched albums carry none of them. The two id fields are opaque
   * identity tokens the layer hands back to itself on later runs to recognize
   * an album it has already matched; nothing outside the layer interprets
   * them. They are decimal strings because the values do not fit JSON numbers.
   */
  extendedAlbumId?: string;
  extendedRoonAlbumId?: string;
  originalReleaseDate?: CatalogPartialDate;
  releaseDate?: CatalogPartialDate;
  /** Canonical ISO timestamp for when the album entered the library. */
  importDate?: string;
  /** Play count for the configured listening profile. */
  playCount?: number;
  /** Canonical ISO last-played instant for the configured profile. */
  lastPlayedAt?: string;
  /**
   * Where the album's audio comes from, as the extended layer's own opaque
   * enumeration value (owned files versus one streaming provider or another).
   * Never interpreted here; the surface that renders it owns the mapping.
   */
  contentSource?: number;
  /**
   * The configured listening profile's library state for this album.
   *
   * Each is present only when the extended layer established it. An ABSENT
   * field means "not known for this album" and must not be read as `false`;
   * `false` is a positive answer meaning the profile does not have the flag
   * set. Whether the set as a whole can be trusted is a separate, snapshot-
   * wide question the capability answer carries.
   */
  isFavorite?: boolean;
  isListenLater?: boolean;
  isBanned?: boolean;
}

/** The optional AlbumRef fields the extended layer owns (strip-and-set). */
export const CATALOG_ALBUM_EXTENDED_FIELD_KEYS = [
  "extendedAlbumId",
  "extendedRoonAlbumId",
  "originalReleaseDate",
  "releaseDate",
  "importDate",
  "playCount",
  "lastPlayedAt",
  "contentSource",
  "isFavorite",
  "isListenLater",
  "isBanned",
] as const;

/** The extended-layer field bag applied to a matched catalog album. */
export type CatalogAlbumExtendedFields = Partial<
  Pick<AlbumRef, (typeof CATALOG_ALBUM_EXTENDED_FIELD_KEYS)[number]>
>;

/** True when any extended-layer field is present on the album. */
export function albumHasExtendedEnrichment(
  album: Readonly<AlbumRef>
): boolean {
  return CATALOG_ALBUM_EXTENDED_FIELD_KEYS.some(
    (key) => album[key] !== undefined
  );
}

type OriginalReleaseArm =
  | {
      originalReleaseYear: number;
      originalReleaseYearEvidence: CatalogReleaseYearEvidence & {
        field: "original-release-date";
      };
    }
  | {
      originalReleaseYear?: never;
      originalReleaseYearEvidence?: never;
    };

type EditionReleaseArm =
  | {
      editionReleaseYear: number;
      editionReleaseYearEvidence: CatalogReleaseYearEvidence & {
        field: "edition-release-date";
      };
    }
  | {
      editionReleaseYear?: never;
      editionReleaseYearEvidence?: never;
    };

export type AlbumRef = AlbumRefBase & OriginalReleaseArm & EditionReleaseArm;

export type CatalogTimelinePlacement =
  | {
      readonly kind: "calendar";
      /** Zero-based source-discography order; never an identity input. */
      readonly ordinal: number;
      readonly year: number;
      readonly evidence: CatalogReleaseYearEvidence & {
        readonly field: "original-release-date";
      };
    }
  | {
      readonly kind: "undated";
      /** Zero-based source-discography order; never an identity input. */
      readonly ordinal: number;
      readonly label: "Undated";
      readonly reason:
        | "no-proven-original-release-date"
        | "album-not-resolved";
    };

export type CatalogFreshness = "empty" | "fresh" | "stale";
export type CatalogStaleReason =
  | "restored"
  | "core-disconnected"
  | "scan-failed"
  | "persistence-failed";
export type CatalogStatusProblemCode =
  | "PERSISTENCE_READ_FAILED"
  | "PERSISTENCE_WRITE_FAILED"
  | "SCAN_FAILED";

export interface CatalogStatusProblem {
  readonly code: CatalogStatusProblemCode;
  readonly occurredAt: string;
}

export interface CatalogStatus {
  readonly coreId: string;
  readonly freshness: CatalogFreshness;
  readonly staleReason?: CatalogStaleReason;
  readonly persistence: "healthy" | "degraded";
  readonly refresh: "idle" | "running";
  readonly available: boolean;
  readonly complete: boolean;
  readonly revision: number;
  readonly artistCount: number;
  readonly albumCount: number;
  readonly updatedAt?: string;
  readonly lastCompleteScanAt?: string;
  readonly lastProblem?: CatalogStatusProblem;
}

export interface CatalogArtistSearchResponse {
  readonly status: CatalogStatus;
  readonly query: string;
  readonly limit: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly artists: readonly ArtistRef[];
}

export interface CatalogArtistAlbumsResponse {
  readonly status: CatalogStatus;
  readonly artist: ArtistRef;
  readonly limit: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly albums: readonly AlbumRef[];
}

export interface CatalogRefreshAcceptedResponse {
  readonly status: CatalogStatus;
}

export const CATALOG_DISPLAY_TEXT_MAX_LENGTH = 512;
export const CATALOG_OPAQUE_TEXT_MAX_LENGTH = 2048;
export const CATALOG_ARTIST_QUERY_MAX_LENGTH = 256;
export const CATALOG_ARTIST_SEARCH_DEFAULT_LIMIT = 20;
export const CATALOG_ARTIST_SEARCH_MAX_LIMIT = 40;
export const CATALOG_ARTIST_ALBUMS_DEFAULT_LIMIT = 200;
export const CATALOG_ARTIST_ALBUMS_MAX_LIMIT = 500;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const EVIDENCE_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u;
const DECIMAL_TOKEN = /^[0-9]+$/u;
const DECIMAL_TOKEN_MAX_LENGTH = 32;
const CONTROL_CHARACTER = /\p{Cc}/u;

function isDecimalToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= DECIMAL_TOKEN_MAX_LENGTH &&
    DECIMAL_TOKEN.test(value)
  );
}

function isCatalogPartialDate(value: unknown): value is CatalogPartialDate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === 3 &&
    Number.isInteger(record.year) &&
    Number.isInteger(record.month) &&
    Number.isInteger(record.day) &&
    (record.year as number) >= 0 &&
    (record.year as number) <= 9999 &&
    (record.month as number) >= 0 &&
    (record.month as number) <= 12 &&
    (record.day as number) >= 0 &&
    (record.day as number) <= 31
  );
}

const ARTIST_REQUIRED_KEYS = [
  "localId",
  "coreId",
  "exactName",
  "normalizedName",
  "firstSeenAt",
  "lastSeenAt",
  "resolutionStatus",
] as const;
const ARTIST_OPTIONAL_KEYS = ["imageKeyHint"] as const;

const ALBUM_REQUIRED_KEYS = [
  "localId",
  "coreId",
  "exactTitle",
  "exactArtist",
  "normalizedTitle",
  "normalizedArtist",
  "editionText",
  "firstSeenAt",
  "lastSeenAt",
  "resolutionStatus",
] as const;
const ALBUM_OPTIONAL_KEYS = [
  "artistLocalId",
  "trackTitleFingerprint",
  "imageKeyHint",
  "originalReleaseYear",
  "originalReleaseYearEvidence",
  "editionReleaseYear",
  "editionReleaseYearEvidence",
  "extendedAlbumId",
  "extendedRoonAlbumId",
  "originalReleaseDate",
  "releaseDate",
  "importDate",
  "playCount",
  "lastPlayedAt",
  "contentSource",
  "isFavorite",
  "isListenLater",
  "isBanned",
] as const;

function canonicalDisplayText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/** Catalog comparison text. Display fields remain separately preserved. */
export function normalizeCatalogText(value: string): string {
  return canonicalDisplayText(value).toLocaleLowerCase("en-US");
}

/** Deterministic Unicode scalar-value order without host-locale/ICU behavior. */
export function compareCatalogTextByCodePoint(
  left: string,
  right: string
): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index].codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index].codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length < rightPoints.length
    ? -1
    : leftPoints.length > rightPoints.length
      ? 1
      : 0;
}

export function catalogArtistSearchRank(
  normalizedName: string,
  normalizedQuery: string
): 0 | 1 | 2 | 3 {
  return normalizedName === normalizedQuery
    ? 0
    : normalizedName.startsWith(normalizedQuery)
      ? 1
      : normalizedName.includes(normalizedQuery)
        ? 2
        : 3;
}

export function isCatalogLocalId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

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
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string")) return false;
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    return false;
  }
  return keys.every(
    (key) =>
      typeof key === "string" &&
      (required.includes(key) || optional.includes(key))
  );
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isCanonicalDisplayText(
  value: unknown,
  allowEmpty = false,
  maxLength = CATALOG_DISPLAY_TEXT_MAX_LENGTH
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0) &&
    value === canonicalDisplayText(value) &&
    !CONTROL_CHARACTER.test(value)
  );
}

function isBoundedOpaqueText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CATALOG_OPAQUE_TEXT_MAX_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTER.test(value)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function isCanonicalCatalogEvidenceDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = EVIDENCE_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = match[2] === undefined ? 1 : Number(match[2]);
  const day = match[3] === undefined ? 1 : Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function isResolutionStatus(value: unknown): value is CatalogResolutionStatus {
  return CATALOG_RESOLUTION_STATUSES.some((status) => status === value);
}

function normalizeReleaseEvidence(
  value: unknown,
  expectedField: CatalogReleaseYearEvidenceField,
  expectedYear: number
): CatalogReleaseYearEvidence | null {
  const record = plainDataRecord(value);
  if (!record || !hasExactKeys(record, ["sourceContract", "field", "date"])) {
    return null;
  }
  if (
    record.sourceContract !== CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT ||
    record.field !== expectedField ||
    !isCanonicalCatalogEvidenceDate(record.date) ||
    Number(record.date.slice(0, 4)) !== expectedYear
  ) {
    return null;
  }
  return {
    sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
    field: expectedField,
    date: record.date,
  };
}

function normalizeReleaseArm(
  record: Record<string, unknown>,
  yearKey: "originalReleaseYear" | "editionReleaseYear",
  evidenceKey: "originalReleaseYearEvidence" | "editionReleaseYearEvidence",
  field: CatalogReleaseYearEvidenceField
): { year: number; evidence: CatalogReleaseYearEvidence } | null | undefined {
  const hasYear = hasOwn(record, yearKey);
  const hasEvidence = hasOwn(record, evidenceKey);
  if (hasYear !== hasEvidence) return null;
  if (!hasYear) return undefined;
  const year = record[yearKey];
  if (!Number.isInteger(year) || (year as number) < 1000 || (year as number) > 9999) {
    return null;
  }
  const evidence = normalizeReleaseEvidence(record[evidenceKey], field, year as number);
  return evidence ? { year: year as number, evidence } : null;
}

function timestampsAreOrdered(firstSeenAt: string, lastSeenAt: string): boolean {
  return Date.parse(firstSeenAt) <= Date.parse(lastSeenAt);
}

export function normalizeArtistRef(value: unknown): ArtistRef | null {
  try {
    const record = plainDataRecord(value);
    if (!record || !hasExactKeys(record, ARTIST_REQUIRED_KEYS, ARTIST_OPTIONAL_KEYS)) {
      return null;
    }
    if (
      typeof record.localId !== "string" ||
      !UUID.test(record.localId) ||
      !isBoundedOpaqueText(record.coreId) ||
      !isCanonicalDisplayText(record.exactName) ||
      !isCanonicalDisplayText(record.normalizedName) ||
      record.normalizedName !== normalizeCatalogText(record.exactName) ||
      !isCanonicalTimestamp(record.firstSeenAt) ||
      !isCanonicalTimestamp(record.lastSeenAt) ||
      !timestampsAreOrdered(record.firstSeenAt, record.lastSeenAt) ||
      !isResolutionStatus(record.resolutionStatus)
    ) {
      return null;
    }
    if (hasOwn(record, "imageKeyHint") && !isBoundedOpaqueText(record.imageKeyHint)) {
      return null;
    }

    const artist: ArtistRef = {
      localId: record.localId,
      coreId: record.coreId,
      exactName: record.exactName,
      normalizedName: record.normalizedName,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      resolutionStatus: record.resolutionStatus,
    };
    if (typeof record.imageKeyHint === "string") {
      artist.imageKeyHint = record.imageKeyHint;
    }
    return artist;
  } catch {
    return null;
  }
}

export function normalizeAlbumRef(value: unknown): AlbumRef | null {
  try {
    const record = plainDataRecord(value);
    if (!record || !hasExactKeys(record, ALBUM_REQUIRED_KEYS, ALBUM_OPTIONAL_KEYS)) {
      return null;
    }
    if (
      typeof record.localId !== "string" ||
      !UUID.test(record.localId) ||
      !isBoundedOpaqueText(record.coreId) ||
      !isCanonicalDisplayText(record.exactTitle) ||
      !isCanonicalDisplayText(record.exactArtist) ||
      !isCanonicalDisplayText(record.normalizedTitle) ||
      !isCanonicalDisplayText(record.normalizedArtist) ||
      record.normalizedTitle !== normalizeCatalogText(record.exactTitle) ||
      record.normalizedArtist !== normalizeCatalogText(record.exactArtist) ||
      !isCanonicalDisplayText(record.editionText, true) ||
      !isCanonicalTimestamp(record.firstSeenAt) ||
      !isCanonicalTimestamp(record.lastSeenAt) ||
      !timestampsAreOrdered(record.firstSeenAt, record.lastSeenAt) ||
      !isResolutionStatus(record.resolutionStatus)
    ) {
      return null;
    }
    if (
      hasOwn(record, "artistLocalId") &&
      (typeof record.artistLocalId !== "string" || !UUID.test(record.artistLocalId))
    ) {
      return null;
    }
    if (
      hasOwn(record, "trackTitleFingerprint") &&
      (typeof record.trackTitleFingerprint !== "string" ||
        !SHA256.test(record.trackTitleFingerprint))
    ) {
      return null;
    }
    if (hasOwn(record, "imageKeyHint") && !isBoundedOpaqueText(record.imageKeyHint)) {
      return null;
    }
    if (
      (hasOwn(record, "extendedAlbumId") &&
        !isDecimalToken(record.extendedAlbumId)) ||
      (hasOwn(record, "extendedRoonAlbumId") &&
        !isDecimalToken(record.extendedRoonAlbumId)) ||
      (hasOwn(record, "originalReleaseDate") &&
        !isCatalogPartialDate(record.originalReleaseDate)) ||
      (hasOwn(record, "releaseDate") &&
        !isCatalogPartialDate(record.releaseDate)) ||
      (hasOwn(record, "importDate") &&
        !isCanonicalTimestamp(record.importDate)) ||
      (hasOwn(record, "playCount") &&
        (!Number.isInteger(record.playCount) ||
          (record.playCount as number) < 0)) ||
      (hasOwn(record, "lastPlayedAt") &&
        !isCanonicalTimestamp(record.lastPlayedAt)) ||
      (hasOwn(record, "contentSource") &&
        (!Number.isInteger(record.contentSource) ||
          (record.contentSource as number) < 0)) ||
      (hasOwn(record, "isFavorite") && typeof record.isFavorite !== "boolean") ||
      (hasOwn(record, "isListenLater") &&
        typeof record.isListenLater !== "boolean") ||
      (hasOwn(record, "isBanned") && typeof record.isBanned !== "boolean")
    ) {
      return null;
    }

    const original = normalizeReleaseArm(
      record,
      "originalReleaseYear",
      "originalReleaseYearEvidence",
      "original-release-date"
    );
    const edition = normalizeReleaseArm(
      record,
      "editionReleaseYear",
      "editionReleaseYearEvidence",
      "edition-release-date"
    );
    if (original === null || edition === null) return null;

    const album: Record<string, unknown> = {
      localId: record.localId,
      coreId: record.coreId,
      exactTitle: record.exactTitle,
      exactArtist: record.exactArtist,
      normalizedTitle: record.normalizedTitle,
      normalizedArtist: record.normalizedArtist,
      editionText: record.editionText,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      resolutionStatus: record.resolutionStatus,
    };
    for (const key of ["artistLocalId", "trackTitleFingerprint", "imageKeyHint"] as const) {
      if (typeof record[key] === "string") album[key] = record[key];
    }
    for (const key of CATALOG_ALBUM_EXTENDED_FIELD_KEYS) {
      if (!hasOwn(record, key)) continue;
      const field = record[key];
      album[key] =
        key === "originalReleaseDate" || key === "releaseDate"
          ? { ...(field as CatalogPartialDate) }
          : field;
    }
    if (original) {
      album.originalReleaseYear = original.year;
      album.originalReleaseYearEvidence = original.evidence;
    }
    if (edition) {
      album.editionReleaseYear = edition.year;
      album.editionReleaseYearEvidence = edition.evidence;
    }
    return album as unknown as AlbumRef;
  } catch {
    return null;
  }
}

/**
 * Derive the only chronology model the Timeline UI may render.
 *
 * Edition/reissue evidence is deliberately ignored here. An album also stays
 * Undated while its exact edition is unresolved, even if older evidence is
 * retained on its descriptor for later reconciliation.
 */
export function deriveCatalogTimelinePlacement(
  value: unknown,
  ordinalValue: unknown
): CatalogTimelinePlacement | null {
  const album = normalizeAlbumRef(value);
  if (
    !album ||
    typeof ordinalValue !== "number" ||
    !Number.isSafeInteger(ordinalValue) ||
    ordinalValue < 0
  ) {
    return null;
  }
  const ordinal = ordinalValue;
  if (
    album.resolutionStatus === "resolved" &&
    album.originalReleaseYear !== undefined &&
    album.originalReleaseYearEvidence !== undefined
  ) {
    return {
      kind: "calendar",
      ordinal,
      year: album.originalReleaseYear,
      evidence: { ...album.originalReleaseYearEvidence },
    };
  }
  return {
    kind: "undated",
    ordinal,
    label: "Undated",
    reason:
      album.resolutionStatus === "resolved"
        ? "no-proven-original-release-date"
        : "album-not-resolved",
  };
}

function normalizeCatalogStatusProblem(
  value: unknown
): CatalogStatusProblem | null {
  const record = plainDataRecord(value);
  if (!record || !hasExactKeys(record, ["code", "occurredAt"])) return null;
  if (
    record.code !== "PERSISTENCE_READ_FAILED" &&
    record.code !== "PERSISTENCE_WRITE_FAILED" &&
    record.code !== "SCAN_FAILED"
  ) {
    return null;
  }
  if (!isCanonicalTimestamp(record.occurredAt)) return null;
  return { code: record.code, occurredAt: record.occurredAt };
}

export function normalizeCatalogStatus(value: unknown): CatalogStatus | null {
  try {
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(
        record,
        [
          "coreId",
          "freshness",
          "persistence",
          "refresh",
          "available",
          "complete",
          "revision",
          "artistCount",
          "albumCount",
        ],
        [
          "staleReason",
          "updatedAt",
          "lastCompleteScanAt",
          "lastProblem",
        ]
      ) ||
      !isBoundedOpaqueText(record.coreId) ||
      (record.freshness !== "empty" &&
        record.freshness !== "fresh" &&
        record.freshness !== "stale") ||
      (record.persistence !== "healthy" && record.persistence !== "degraded") ||
      (record.refresh !== "idle" && record.refresh !== "running") ||
      typeof record.available !== "boolean" ||
      typeof record.complete !== "boolean" ||
      typeof record.revision !== "number" ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0 ||
      typeof record.artistCount !== "number" ||
      !Number.isSafeInteger(record.artistCount) ||
      record.artistCount < 0 ||
      typeof record.albumCount !== "number" ||
      !Number.isSafeInteger(record.albumCount) ||
      record.albumCount < 0
    ) {
      return null;
    }
    const staleReason = record.staleReason;
    const validStaleReason =
      staleReason === "restored" ||
      staleReason === "core-disconnected" ||
      staleReason === "scan-failed" ||
      staleReason === "persistence-failed";
    if (
      hasOwn(record, "staleReason") !== (record.freshness === "stale") ||
      (record.freshness === "stale" && !validStaleReason) ||
      record.available !== (record.freshness !== "empty") ||
      (record.available && record.revision < 1) ||
      (!record.available &&
        (record.revision !== 0 ||
          record.artistCount !== 0 ||
          record.albumCount !== 0 ||
          hasOwn(record, "updatedAt") ||
          hasOwn(record, "lastCompleteScanAt"))) ||
      (hasOwn(record, "updatedAt") && !isCanonicalTimestamp(record.updatedAt)) ||
      record.available !== hasOwn(record, "updatedAt") ||
      (hasOwn(record, "lastCompleteScanAt") &&
        !isCanonicalTimestamp(record.lastCompleteScanAt)) ||
      record.complete !== hasOwn(record, "lastCompleteScanAt")
    ) {
      return null;
    }
    if (
      typeof record.updatedAt === "string" &&
      typeof record.lastCompleteScanAt === "string" &&
      Date.parse(record.lastCompleteScanAt) > Date.parse(record.updatedAt)
    ) {
      return null;
    }
    const lastProblem = hasOwn(record, "lastProblem")
      ? normalizeCatalogStatusProblem(record.lastProblem)
      : undefined;
    if (hasOwn(record, "lastProblem") && !lastProblem) return null;
    if (
      (record.persistence === "degraded") !==
        (lastProblem?.code === "PERSISTENCE_READ_FAILED" ||
          lastProblem?.code === "PERSISTENCE_WRITE_FAILED") ||
      (staleReason === "scan-failed" && lastProblem?.code !== "SCAN_FAILED") ||
      (staleReason === "persistence-failed" &&
        (record.persistence !== "degraded" ||
          lastProblem?.code !== "PERSISTENCE_WRITE_FAILED"))
    ) {
      return null;
    }

    return {
      coreId: record.coreId,
      freshness: record.freshness,
      ...(validStaleReason ? { staleReason } : {}),
      persistence: record.persistence,
      refresh: record.refresh,
      available: record.available,
      complete: record.complete,
      revision: record.revision,
      artistCount: record.artistCount,
      albumCount: record.albumCount,
      ...(typeof record.updatedAt === "string"
        ? { updatedAt: record.updatedAt }
        : {}),
      ...(typeof record.lastCompleteScanAt === "string"
        ? { lastCompleteScanAt: record.lastCompleteScanAt }
        : {}),
      ...(lastProblem ? { lastProblem } : {}),
    };
  } catch {
    return null;
  }
}

export function normalizeCatalogRefreshAcceptedResponse(
  value: unknown
): CatalogRefreshAcceptedResponse | null {
  try {
    const record = plainDataRecord(value);
    if (!record || !hasExactKeys(record, ["status"])) return null;
    const status = normalizeCatalogStatus(record.status);
    return status ? { status } : null;
  } catch {
    return null;
  }
}

export function normalizeCatalogArtistSearchResponse(
  value: unknown
): CatalogArtistSearchResponse | null {
  try {
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "status",
        "query",
        "limit",
        "total",
        "truncated",
        "artists",
      ])
    ) {
      return null;
    }
    const status = normalizeCatalogStatus(record.status);
    const artistValues = plainDataArray(record.artists);
    if (
      !status ||
      !isCanonicalDisplayText(
        record.query,
        true,
        CATALOG_ARTIST_QUERY_MAX_LENGTH
      ) ||
      typeof record.limit !== "number" ||
      !Number.isSafeInteger(record.limit) ||
      record.limit < 1 ||
      record.limit > CATALOG_ARTIST_SEARCH_MAX_LIMIT ||
      typeof record.total !== "number" ||
      !Number.isSafeInteger(record.total) ||
      record.total < 0 ||
      typeof record.truncated !== "boolean" ||
      !artistValues ||
      artistValues.length > record.limit ||
      record.total < artistValues.length ||
      artistValues.length !== Math.min(record.total, record.limit) ||
      record.truncated !== (record.total > record.limit) ||
      record.total > status.artistCount ||
      (record.query.length === 0 && record.total !== 0)
    ) {
      return null;
    }
    const artists: ArtistRef[] = [];
    const normalizedQuery = normalizeCatalogText(record.query);
    for (const artistValue of artistValues) {
      const artist = normalizeArtistRef(artistValue);
      if (
        !artist ||
        artist.coreId !== status.coreId ||
        !artist.normalizedName.includes(normalizedQuery)
      ) {
        return null;
      }
      artists.push(artist);
    }
    if (
      new Set(artists.map((artist) => artist.localId)).size !== artists.length
    ) {
      return null;
    }
    for (let index = 1; index < artists.length; index += 1) {
      const left = artists[index - 1];
      const right = artists[index];
      const order =
        catalogArtistSearchRank(left.normalizedName, normalizedQuery) -
          catalogArtistSearchRank(right.normalizedName, normalizedQuery) ||
        compareCatalogTextByCodePoint(left.normalizedName, right.normalizedName) ||
        compareCatalogTextByCodePoint(left.exactName, right.exactName) ||
        compareCatalogTextByCodePoint(left.localId, right.localId);
      if (order > 0) return null;
    }
    return {
      status,
      query: record.query,
      limit: record.limit,
      total: record.total,
      truncated: record.truncated,
      artists,
    };
  } catch {
    return null;
  }
}

export function normalizeCatalogArtistAlbumsResponse(
  value: unknown
): CatalogArtistAlbumsResponse | null {
  try {
    const record = plainDataRecord(value);
    if (
      !record ||
      !hasExactKeys(record, [
        "status",
        "artist",
        "limit",
        "total",
        "truncated",
        "albums",
      ])
    ) {
      return null;
    }
    const status = normalizeCatalogStatus(record.status);
    const artist = normalizeArtistRef(record.artist);
    const albumValues = plainDataArray(record.albums);
    if (
      !status ||
      !artist ||
      artist.coreId !== status.coreId ||
      typeof record.limit !== "number" ||
      !Number.isSafeInteger(record.limit) ||
      record.limit < 1 ||
      record.limit > CATALOG_ARTIST_ALBUMS_MAX_LIMIT ||
      typeof record.total !== "number" ||
      !Number.isSafeInteger(record.total) ||
      record.total < 0 ||
      typeof record.truncated !== "boolean" ||
      !albumValues ||
      albumValues.length > record.limit ||
      record.total < albumValues.length ||
      albumValues.length !== Math.min(record.total, record.limit) ||
      record.truncated !== (record.total > record.limit) ||
      !status.available ||
      status.artistCount < 1 ||
      record.total > status.albumCount
    ) {
      return null;
    }
    const albums: AlbumRef[] = [];
    for (const albumValue of albumValues) {
      const album = normalizeAlbumRef(albumValue);
      if (
        !album ||
        album.coreId !== status.coreId ||
        album.artistLocalId !== artist.localId ||
        album.localId === artist.localId
      ) {
        return null;
      }
      albums.push(album);
    }
    if (new Set(albums.map((album) => album.localId)).size !== albums.length) {
      return null;
    }
    return {
      status,
      artist,
      limit: record.limit,
      total: record.total,
      truncated: record.truncated,
      albums,
    };
  } catch {
    return null;
  }
}
