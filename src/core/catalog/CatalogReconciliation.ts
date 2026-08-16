import { createHash } from "crypto";

import {
  AlbumRef,
  ArtistRef,
  CATALOG_ALBUM_EXTENDED_FIELD_KEYS,
  CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  CATALOG_OPAQUE_TEXT_MAX_LENGTH,
  CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
  CatalogReleaseYearEvidence,
  compareCatalogTextByCodePoint,
  isCatalogLocalId,
  normalizeAlbumRef,
  normalizeArtistRef,
  normalizeCatalogText,
} from "../../shared/catalogContracts";

export const CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT =
  "controller-normalized-selected-artist-v1" as const;

export type CatalogObservedDateField =
  | { readonly status: "not-exposed" }
  | { readonly status: "observed"; readonly date: string };

export interface CatalogAlbumDetailObservation {
  readonly sourceContract: typeof CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT;
  readonly fieldInventoryComplete: true;
  readonly headerTitle: string;
  readonly headerSubtitle: string;
  readonly returnedTrackCount: number;
  readonly totalTrackCount: number;
  readonly orderedTrackTitles: readonly string[];
  readonly originalReleaseDateField: CatalogObservedDateField;
  readonly editionReleaseDateField: CatalogObservedDateField;
}

export interface CatalogAlbumObservation {
  readonly exactTitle: string;
  readonly exactArtist: string;
  readonly editionText: string;
  readonly imageKeyHint?: string;
  readonly detail?: CatalogAlbumDetailObservation;
}

interface CatalogObservedArtist {
  readonly exactName: string;
  readonly candidateCount: number;
  readonly imageKeyHint?: string;
}

export interface ResolvedSelectedArtistObservation {
  readonly sourceContract: typeof CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT;
  readonly artist: CatalogObservedArtist & { readonly candidateCount: 1 };
  readonly discographyComplete: true;
  readonly albums: readonly CatalogAlbumObservation[];
}

export type SelectedArtistObservation =
  | ResolvedSelectedArtistObservation
  | {
      readonly sourceContract: typeof CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT;
      readonly artist: CatalogObservedArtist & {
        readonly candidateCount: number;
      };
    };

export interface ReconcileSelectedArtistInput {
  readonly coreId: string;
  readonly selectedArtistLocalId: string | null;
  readonly observation: unknown;
  readonly currentArtists: readonly Readonly<ArtistRef>[];
  readonly currentAlbums: readonly Readonly<AlbumRef>[];
  readonly observedAt: string;
  readonly createLocalId: () => string;
}

export interface ReconciledSelectedArtist {
  readonly artist: ArtistRef;
  readonly albums: readonly AlbumRef[];
  /** Existing placeholders/bindings replaced by this complete working set. */
  readonly suppressedAlbumLocalIds: readonly string[];
}

export type CatalogReconciliationErrorCode =
  | "INVALID_OBSERVATION"
  | "INVALID_STATE"
  | "IDENTITY_CONFLICT";

export class CatalogReconciliationError extends Error {
  public constructor(
    public readonly code: CatalogReconciliationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CatalogReconciliationError";
    Object.setPrototypeOf(this, CatalogReconciliationError.prototype);
  }
}

interface PreparedAlbumObservation extends CatalogAlbumObservation {
  readonly normalizedTitle: string;
  readonly normalizedArtist: string;
  readonly normalizedEditionText: string;
  readonly trackTitleFingerprint?: string;
  readonly originalReleaseYear?: number;
  readonly originalReleaseYearEvidence?: CatalogReleaseYearEvidence & {
    readonly field: "original-release-date";
  };
  readonly editionReleaseYear?: number;
  readonly editionReleaseYearEvidence?: CatalogReleaseYearEvidence & {
    readonly field: "edition-release-date";
  };
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const EVIDENCE_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TRACK_PREFIX =
  /^\s*(?:disc\s*\d+\s*[-.:)]\s*)?(?:(?:\d+\s*[-.:]\s*\d+)|\d+\s*[-.:)])\s*/iu;
const MAX_ARTIST_CANDIDATES = 1_000_000;

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

function denseArray(value: unknown): readonly unknown[] | null {
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
  return (
    keys.every(
      (key) =>
        typeof key === "string" &&
        (required.includes(key) || optional.includes(key))
    ) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  );
}

function canonicalDisplayText(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > CATALOG_DISPLAY_TEXT_MAX_LENGTH) {
    return null;
  }
  const canonical = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return (
    (allowEmpty || canonical.length > 0) &&
      canonical.length <= CATALOG_DISPLAY_TEXT_MAX_LENGTH &&
      !CONTROL_CHARACTER.test(canonical)
      ? canonical
      : null
  );
}

function canonicalOpaqueText(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CATALOG_OPAQUE_TEXT_MAX_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTER.test(value)
  ) {
    return null;
  }
  return value;
}

function canonicalEvidenceDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = EVIDENCE_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] === undefined ? 1 : Number(match[2]);
  const day = match[3] === undefined ? 1 : Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
    ? value
    : null;
}

function normalizeObservedDate(value: unknown): CatalogObservedDateField | null {
  const record = plainRecord(value);
  if (!record || typeof record.status !== "string") return null;
  if (
    record.status === "not-exposed" &&
    hasExactKeys(record, ["status"])
  ) {
    return { status: "not-exposed" };
  }
  if (
    record.status === "observed" &&
    hasExactKeys(record, ["status", "date"])
  ) {
    const date = canonicalEvidenceDate(record.date);
    return date ? { status: "observed", date } : null;
  }
  return null;
}

function normalizeDetail(
  value: unknown,
  albumTitle: string,
  albumArtist: string
): CatalogAlbumDetailObservation | null {
  const record = plainRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "sourceContract",
      "fieldInventoryComplete",
      "headerTitle",
      "headerSubtitle",
      "returnedTrackCount",
      "totalTrackCount",
      "orderedTrackTitles",
      "originalReleaseDateField",
      "editionReleaseDateField",
    ]) ||
    record.sourceContract !== CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT ||
    record.fieldInventoryComplete !== true
  ) {
    return null;
  }
  const headerTitle = canonicalDisplayText(record.headerTitle);
  const headerSubtitle = canonicalDisplayText(record.headerSubtitle);
  const trackValues = denseArray(record.orderedTrackTitles);
  if (
    !headerTitle ||
    !headerSubtitle ||
    normalizeCatalogText(headerTitle) !== normalizeCatalogText(albumTitle) ||
    normalizeCatalogText(headerSubtitle) !== normalizeCatalogText(albumArtist) ||
    !trackValues ||
    trackValues.length < 1 ||
    trackValues.length > 500 ||
    !Number.isSafeInteger(record.returnedTrackCount) ||
    !Number.isSafeInteger(record.totalTrackCount) ||
    record.returnedTrackCount !== trackValues.length ||
    record.totalTrackCount !== trackValues.length
  ) {
    return null;
  }
  const orderedTrackTitles: string[] = [];
  for (const value of trackValues) {
    const title = canonicalDisplayText(value);
    if (!title || normalizeCatalogTrackTitle(title).length === 0) return null;
    orderedTrackTitles.push(title);
  }
  const originalReleaseDateField = normalizeObservedDate(
    record.originalReleaseDateField
  );
  const editionReleaseDateField = normalizeObservedDate(
    record.editionReleaseDateField
  );
  if (!originalReleaseDateField || !editionReleaseDateField) return null;
  return {
    sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
    fieldInventoryComplete: true,
    headerTitle,
    headerSubtitle,
    returnedTrackCount: trackValues.length,
    totalTrackCount: trackValues.length,
    orderedTrackTitles,
    originalReleaseDateField,
    editionReleaseDateField,
  };
}

function normalizeAlbumObservation(value: unknown): CatalogAlbumObservation | null {
  const record = plainRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      ["exactTitle", "exactArtist", "editionText"],
      ["imageKeyHint", "detail"]
    )
  ) {
    return null;
  }
  const exactTitle = canonicalDisplayText(record.exactTitle);
  const exactArtist = canonicalDisplayText(record.exactArtist);
  const editionText = canonicalDisplayText(record.editionText, true);
  if (!exactTitle || !exactArtist || editionText === null) return null;
  const imageKeyHint = Object.prototype.hasOwnProperty.call(record, "imageKeyHint")
    ? canonicalOpaqueText(record.imageKeyHint)
    : undefined;
  if (
    Object.prototype.hasOwnProperty.call(record, "imageKeyHint") &&
    !imageKeyHint
  ) {
    return null;
  }
  const detail = Object.prototype.hasOwnProperty.call(record, "detail")
    ? normalizeDetail(record.detail, exactTitle, exactArtist)
    : undefined;
  if (Object.prototype.hasOwnProperty.call(record, "detail") && !detail) {
    return null;
  }
  return {
    exactTitle,
    exactArtist,
    editionText,
    ...(imageKeyHint ? { imageKeyHint } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function normalizeSelectedArtistObservation(
  value: unknown
): SelectedArtistObservation | null {
  try {
    const record = plainRecord(value);
    if (
      !record ||
      record.sourceContract !==
        CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT ||
      !Object.prototype.hasOwnProperty.call(record, "artist")
    ) {
      return null;
    }
    const artistRecord = plainRecord(record.artist);
    if (
      !artistRecord ||
      !hasExactKeys(
        artistRecord,
        ["exactName", "candidateCount"],
        ["imageKeyHint"]
      ) ||
      !Number.isSafeInteger(artistRecord.candidateCount) ||
      (artistRecord.candidateCount as number) < 0 ||
      (artistRecord.candidateCount as number) > MAX_ARTIST_CANDIDATES
    ) {
      return null;
    }
    const exactName = canonicalDisplayText(artistRecord.exactName);
    const imageKeyHint = Object.prototype.hasOwnProperty.call(
      artistRecord,
      "imageKeyHint"
    )
      ? canonicalOpaqueText(artistRecord.imageKeyHint)
      : undefined;
    if (
      !exactName ||
      (Object.prototype.hasOwnProperty.call(artistRecord, "imageKeyHint") &&
        !imageKeyHint)
    ) {
      return null;
    }
    const candidateCount = artistRecord.candidateCount as number;
    const artist = {
      exactName,
      candidateCount,
      ...(imageKeyHint ? { imageKeyHint } : {}),
    };
    if (candidateCount !== 1) {
      return hasExactKeys(record, ["sourceContract", "artist"])
        ? {
            sourceContract:
              CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
            artist,
          }
        : null;
    }
    if (
      !hasExactKeys(record, [
        "sourceContract",
        "artist",
        "discographyComplete",
        "albums",
      ]) ||
      record.discographyComplete !== true
    ) {
      return null;
    }
    const albumValues = denseArray(record.albums);
    if (!albumValues || albumValues.length > CATALOG_ARTIST_ALBUMS_MAX_LIMIT) {
      return null;
    }
    const albums: CatalogAlbumObservation[] = [];
    for (const albumValue of albumValues) {
      const album = normalizeAlbumObservation(albumValue);
      if (!album) return null;
      albums.push(album);
    }
    return {
      sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
      artist: { ...artist, candidateCount: 1 },
      discographyComplete: true,
      albums,
    };
  } catch {
    return null;
  }
}

export function normalizeCatalogTrackTitle(value: string): string {
  return normalizeCatalogText(value).replace(TRACK_PREFIX, "").trim();
}

export function createCatalogTrackTitleFingerprint(
  orderedTrackTitles: readonly string[]
): string {
  const normalized = orderedTrackTitles.map(normalizeCatalogTrackTitle);
  return createHash("sha256")
    .update(JSON.stringify(["catalog-track-titles-v1", ...normalized]), "utf8")
    .digest("hex");
}

function prepareAlbum(album: CatalogAlbumObservation): PreparedAlbumObservation {
  const detail = album.detail;
  const trackTitleFingerprint = detail
    ? createCatalogTrackTitleFingerprint(detail.orderedTrackTitles)
    : undefined;
  const originalDate =
    detail?.originalReleaseDateField.status === "observed"
      ? detail.originalReleaseDateField.date
      : undefined;
  const editionDate =
    detail?.editionReleaseDateField.status === "observed"
      ? detail.editionReleaseDateField.date
      : undefined;
  return {
    ...album,
    normalizedTitle: normalizeCatalogText(album.exactTitle),
    normalizedArtist: normalizeCatalogText(album.exactArtist),
    normalizedEditionText: normalizeCatalogText(album.editionText),
    ...(trackTitleFingerprint ? { trackTitleFingerprint } : {}),
    ...(originalDate
      ? {
          originalReleaseYear: Number(originalDate.slice(0, 4)),
          originalReleaseYearEvidence: {
            sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
            field: "original-release-date" as const,
            date: originalDate,
          },
        }
      : {}),
    ...(editionDate
      ? {
          editionReleaseYear: Number(editionDate.slice(0, 4)),
          editionReleaseYearEvidence: {
            sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
            field: "edition-release-date" as const,
            date: editionDate,
          },
        }
      : {}),
  };
}

function descriptorKey(value: {
  normalizedTitle: string;
  normalizedArtist: string;
  editionText?: string;
  normalizedEditionText?: string;
}): string {
  const edition =
    value.normalizedEditionText ?? normalizeCatalogText(value.editionText ?? "");
  return JSON.stringify([
    value.normalizedTitle,
    value.normalizedArtist,
    edition,
  ]);
}

function identityToken(
  value: PreparedAlbumObservation | Readonly<AlbumRef>
): string {
  return value.trackTitleFingerprint
    ? `fingerprint:${value.trackTitleFingerprint}`
    : `descriptor:${descriptorKey(value)}`;
}

function groupIndexes<T>(
  values: readonly T[],
  key: (value: T) => string
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  values.forEach((value, index) => {
    const token = key(value);
    const group = groups.get(token) ?? [];
    group.push(index);
    groups.set(token, group);
  });
  return groups;
}

function releaseConflict(
  prior: Readonly<AlbumRef>,
  current: PreparedAlbumObservation
): boolean {
  const editionTextConflict =
    prior.editionText.length > 0 &&
    current.editionText.length > 0 &&
    normalizeCatalogText(prior.editionText) !== current.normalizedEditionText;
  const originalDateConflict =
    prior.originalReleaseYearEvidence !== undefined &&
    current.originalReleaseYearEvidence !== undefined &&
    prior.originalReleaseYearEvidence.date !==
      current.originalReleaseYearEvidence.date;
  const editionDateConflict =
    prior.editionReleaseYearEvidence !== undefined &&
    current.editionReleaseYearEvidence !== undefined &&
    prior.editionReleaseYearEvidence.date !== current.editionReleaseYearEvidence.date;
  return editionTextConflict || originalDateConflict || editionDateConflict;
}

function fingerprintConflict(
  prior: Readonly<AlbumRef>,
  current: PreparedAlbumObservation
): boolean {
  return (
    prior.trackTitleFingerprint !== undefined &&
    current.trackTitleFingerprint !== undefined &&
    prior.trackTitleFingerprint !== current.trackTitleFingerprint
  );
}

function withStatus(
  album: Readonly<AlbumRef>,
  artistLocalId: string,
  resolutionStatus: "ambiguous" | "missing"
): AlbumRef {
  const normalized = normalizeAlbumRef({
    ...album,
    artistLocalId,
    resolutionStatus,
  });
  if (!normalized) {
    throw new CatalogReconciliationError(
      "INVALID_STATE",
      "A retained album descriptor became invalid"
    );
  }
  return normalized;
}

function materializeAlbum(
  coreId: string,
  artistLocalId: string,
  current: PreparedAlbumObservation,
  observedAt: string,
  localId: string,
  firstSeenAt: string,
  resolutionStatus: "resolved" | "ambiguous",
  prior?: Readonly<AlbumRef>
): AlbumRef {
  const descriptor: Record<string, unknown> = {
    localId,
    coreId,
    artistLocalId,
    exactTitle: current.exactTitle,
    exactArtist: current.exactArtist,
    normalizedTitle: current.normalizedTitle,
    normalizedArtist: current.normalizedArtist,
    editionText: current.editionText,
    firstSeenAt,
    lastSeenAt: observedAt,
    resolutionStatus,
  };
  const fingerprint = current.trackTitleFingerprint ?? prior?.trackTitleFingerprint;
  const imageKeyHint = current.imageKeyHint ?? prior?.imageKeyHint;
  if (fingerprint) descriptor.trackTitleFingerprint = fingerprint;
  if (imageKeyHint) descriptor.imageKeyHint = imageKeyHint;
  const originalYear =
    current.originalReleaseYear ?? prior?.originalReleaseYear;
  const originalEvidence =
    current.originalReleaseYearEvidence ?? prior?.originalReleaseYearEvidence;
  const editionYear = current.editionReleaseYear ?? prior?.editionReleaseYear;
  const editionEvidence =
    current.editionReleaseYearEvidence ?? prior?.editionReleaseYearEvidence;
  if (originalYear !== undefined && originalEvidence) {
    descriptor.originalReleaseYear = originalYear;
    descriptor.originalReleaseYearEvidence = originalEvidence;
  }
  if (editionYear !== undefined && editionEvidence) {
    descriptor.editionReleaseYear = editionYear;
    descriptor.editionReleaseYearEvidence = editionEvidence;
  }
  // Native enrichment rides the descriptor's identity across
  // reconciliations, exactly like the release evidence above.
  if (prior) {
    for (const key of CATALOG_ALBUM_EXTENDED_FIELD_KEYS) {
      if (prior[key] !== undefined) descriptor[key] = prior[key];
    }
  }
  const normalized = normalizeAlbumRef(descriptor);
  if (!normalized) {
    throw new CatalogReconciliationError(
      "INVALID_STATE",
      "Reconciliation produced an invalid album descriptor"
    );
  }
  return normalized;
}

function validateTimestamp(value: string): boolean {
  return (
    CANONICAL_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

export function reconcileSelectedArtist(
  input: ReconcileSelectedArtistInput
): ReconciledSelectedArtist {
  const observation = normalizeSelectedArtistObservation(input.observation);
  if (!observation) {
    throw new CatalogReconciliationError(
      "INVALID_OBSERVATION",
      "Selected-artist observation is invalid"
    );
  }
  if (!canonicalOpaqueText(input.coreId) || !validateTimestamp(input.observedAt)) {
    throw new CatalogReconciliationError(
      "INVALID_STATE",
      "Reconciliation Core or timestamp is invalid"
    );
  }
  const currentArtists = input.currentArtists.map((value) => {
    const artist = normalizeArtistRef(value);
    if (!artist || artist.coreId !== input.coreId) {
      throw new CatalogReconciliationError(
        "INVALID_STATE",
        "Current artist state is invalid for this Core"
      );
    }
    return artist;
  });
  const currentAlbums = input.currentAlbums.map((value) => {
    const album = normalizeAlbumRef(value);
    if (!album || album.coreId !== input.coreId) {
      throw new CatalogReconciliationError(
        "INVALID_STATE",
        "Current album state is invalid for this Core"
      );
    }
    return album;
  });
  const usedIds = new Set([
    ...currentArtists.map((artist) => artist.localId),
    ...currentAlbums.map((album) => album.localId),
  ]);
  if (usedIds.size !== currentArtists.length + currentAlbums.length) {
    throw new CatalogReconciliationError(
      "INVALID_STATE",
      "Current catalog state contains duplicate local IDs"
    );
  }
  const allocateLocalId = (): string => {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = input.createLocalId();
      if (!isCatalogLocalId(candidate) || usedIds.has(candidate)) continue;
      usedIds.add(candidate);
      return candidate;
    }
    throw new CatalogReconciliationError(
      "INVALID_STATE",
      "Local ID generator did not produce a unique UUID"
    );
  };

  const normalizedArtistName = normalizeCatalogText(observation.artist.exactName);
  let priorArtist: ArtistRef | undefined;
  if (input.selectedArtistLocalId !== null) {
    if (!isCatalogLocalId(input.selectedArtistLocalId)) {
      throw new CatalogReconciliationError(
        "IDENTITY_CONFLICT",
        "Selected artist local ID is invalid"
      );
    }
    priorArtist = currentArtists.find(
      (artist) => artist.localId === input.selectedArtistLocalId
    );
    if (!priorArtist || priorArtist.normalizedName !== normalizedArtistName) {
      throw new CatalogReconciliationError(
        "IDENTITY_CONFLICT",
        "Selected artist local ID does not identify this exact artist"
      );
    }
  } else {
    const matches = currentArtists.filter(
      (artist) => artist.normalizedName === normalizedArtistName
    );
    if (matches.length > 1) {
      throw new CatalogReconciliationError(
        "IDENTITY_CONFLICT",
        "More than one existing artist has the selected exact name"
      );
    }
    priorArtist = matches[0];
  }

  const boundPriorAlbums = priorArtist
    ? currentAlbums.filter(
        (album) => album.artistLocalId === priorArtist?.localId
      )
    : [];
  if (observation.artist.candidateCount !== 1) {
    if (!priorArtist) {
      throw new CatalogReconciliationError(
        "IDENTITY_CONFLICT",
        "A missing or ambiguous observation needs an existing selected artist"
      );
    }
    const status =
      observation.artist.candidateCount === 0 ? "missing" : "ambiguous";
    const artist = normalizeArtistRef({ ...priorArtist, resolutionStatus: status });
    if (!artist) {
      throw new CatalogReconciliationError(
        "INVALID_STATE",
        "Selected artist status update became invalid"
      );
    }
    return {
      artist,
      albums: boundPriorAlbums.map((album) =>
        withStatus(album, artist.localId, status)
      ),
      suppressedAlbumLocalIds: boundPriorAlbums.map((album) => album.localId),
    };
  }
  const resolvedObservation = observation as ResolvedSelectedArtistObservation;

  const artistLocalId = priorArtist?.localId ?? allocateLocalId();
  const artist = normalizeArtistRef({
    localId: artistLocalId,
    coreId: input.coreId,
    exactName: observation.artist.exactName,
    normalizedName: normalizedArtistName,
    ...(observation.artist.imageKeyHint ?? priorArtist?.imageKeyHint
      ? {
          imageKeyHint:
            observation.artist.imageKeyHint ?? priorArtist?.imageKeyHint,
        }
      : {}),
    firstSeenAt: priorArtist?.firstSeenAt ?? input.observedAt,
    lastSeenAt: input.observedAt,
    resolutionStatus: "resolved",
  });
  if (!artist) {
    throw new CatalogReconciliationError(
      "INVALID_STATE",
      "Reconciliation produced an invalid artist descriptor"
    );
  }

  const sameNameArtists = currentArtists.filter(
    (candidate) => candidate.normalizedName === artist.normalizedName
  );
  const canAdoptRootPlaceholders = sameNameArtists.length <= 1;
  const candidatePool = currentAlbums.filter(
    (album) =>
      album.artistLocalId === artist.localId ||
      (canAdoptRootPlaceholders &&
        album.artistLocalId === undefined &&
        album.normalizedArtist === artist.normalizedName)
  );
  const prepared = resolvedObservation.albums.map(prepareAlbum);
  if (
    prepared.some(
      (album) => album.normalizedArtist !== artist.normalizedName
    )
  ) {
    throw new CatalogReconciliationError(
      "INVALID_OBSERVATION",
      "Every observed album must be bound to the selected exact artist"
    );
  }

  const currentTokenGroups = groupIndexes(prepared, identityToken);
  const priorTokenGroups = groupIndexes(candidatePool, identityToken);
  const currentDescriptorGroups = groupIndexes(prepared, descriptorKey);
  const priorDescriptorGroups = groupIndexes(candidatePool, descriptorKey);
  const consumedCurrent = new Set<number>();
  const consumedPrior = new Set<number>();
  const outputAt = new Map<number, AlbumRef[]>();

  for (const [token, currentIndexes] of currentTokenGroups) {
    const priorIndexes = priorTokenGroups.get(token) ?? [];
    if (currentIndexes.length < 2 && priorIndexes.length < 2) continue;
    const insertAt = Math.min(...currentIndexes);
    const group: AlbumRef[] = [];
    for (const priorIndex of priorIndexes) {
      consumedPrior.add(priorIndex);
      group.push(withStatus(candidatePool[priorIndex], artist.localId, "ambiguous"));
    }
    const deficit = Math.max(0, currentIndexes.length - priorIndexes.length);
    const deterministicCurrent = currentIndexes
      .map((index) => ({ index, album: prepared[index] }))
      .sort((left, right) =>
        compareCatalogTextByCodePoint(
          descriptorKey(left.album),
          descriptorKey(right.album)
        )
      );
    for (let index = 0; index < deficit; index += 1) {
      const current = deterministicCurrent[index]?.album ?? prepared[insertAt];
      group.push(
        materializeAlbum(
          input.coreId,
          artist.localId,
          current,
          input.observedAt,
          allocateLocalId(),
          input.observedAt,
          "ambiguous"
        )
      );
    }
    currentIndexes.forEach((index) => consumedCurrent.add(index));
    outputAt.set(insertAt, group);
  }

  const matched = new Map<number, number>();
  const forcedAmbiguous = new Set<number>();
  for (let index = 0; index < prepared.length; index += 1) {
    if (consumedCurrent.has(index)) continue;
    const current = prepared[index];
    if (!current.trackTitleFingerprint) continue;
    const priorIndexes = priorTokenGroups
      .get(identityToken(current))
      ?.filter((priorIndex) => !consumedPrior.has(priorIndex));
    if (priorIndexes?.length !== 1) continue;
    const priorIndex = priorIndexes[0];
    const prior = candidatePool[priorIndex];
    if (releaseConflict(prior, current)) {
      forcedAmbiguous.add(index);
      continue;
    }
    matched.set(index, priorIndex);
    consumedPrior.add(priorIndex);
  }

  for (let index = 0; index < prepared.length; index += 1) {
    if (consumedCurrent.has(index) || matched.has(index)) continue;
    const current = prepared[index];
    const currentIndexes = currentDescriptorGroups
      .get(descriptorKey(current))
      ?.filter((candidate) => !consumedCurrent.has(candidate) && !matched.has(candidate));
    const priorIndexes = priorDescriptorGroups
      .get(descriptorKey(current))
      ?.filter((candidate) => !consumedPrior.has(candidate));
    if (currentIndexes?.length !== 1 || priorIndexes?.length !== 1) {
      if (
        !current.trackTitleFingerprint &&
        ((currentIndexes?.length ?? 0) > 1 || (priorIndexes?.length ?? 0) > 1)
      ) {
        forcedAmbiguous.add(index);
      }
      continue;
    }
    const priorIndex = priorIndexes[0];
    const prior = candidatePool[priorIndex];
    if (fingerprintConflict(prior, current) || releaseConflict(prior, current)) {
      forcedAmbiguous.add(index);
      continue;
    }
    matched.set(index, priorIndex);
    consumedPrior.add(priorIndex);
  }

  for (let index = 0; index < prepared.length; index += 1) {
    if (consumedCurrent.has(index)) continue;
    const current = prepared[index];
    const priorIndex = matched.get(index);
    const prior = priorIndex === undefined ? undefined : candidatePool[priorIndex];
    const resolutionStatus = forcedAmbiguous.has(index)
      ? "ambiguous"
      : "resolved";
    outputAt.set(index, [
      materializeAlbum(
        input.coreId,
        artist.localId,
        current,
        input.observedAt,
        prior?.localId ?? allocateLocalId(),
        prior?.firstSeenAt ?? input.observedAt,
        resolutionStatus,
        prior
      ),
    ]);
  }

  const albums: AlbumRef[] = [];
  for (let index = 0; index < prepared.length; index += 1) {
    albums.push(...(outputAt.get(index) ?? []));
  }
  for (let priorIndex = 0; priorIndex < candidatePool.length; priorIndex += 1) {
    if (consumedPrior.has(priorIndex)) continue;
    const prior = candidatePool[priorIndex];
    if (prior.artistLocalId === artist.localId) {
      albums.push(withStatus(prior, artist.localId, "missing"));
    }
  }
  if (new Set(albums.map((album) => album.localId)).size !== albums.length) {
    throw new CatalogReconciliationError(
      "INVALID_STATE",
      "Reconciliation produced duplicate album local IDs"
    );
  }
  return {
    artist,
    albums,
    suppressedAlbumLocalIds: candidatePool.map((album) => album.localId),
  };
}
