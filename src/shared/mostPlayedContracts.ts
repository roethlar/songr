import type { CatalogStatus } from "./timelineCatalogContracts";
import {
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  CATALOG_OPAQUE_TEXT_MAX_LENGTH,
  isCatalogLocalId,
  normalizeCatalogStatus,
  normalizeCatalogText,
} from "./timelineCatalogContracts";
import {
  isPublicSongSelectionId,
  normalizePublicSongRowAuthority,
  type PublicSongRowAuthority,
} from "./publicSongResolverContracts";

/**
 * All-time Most Played read model served by GET /api/catalog/most-played.
 *
 * The play-statistics pull supplies exact listening minutes for
 * performers/releases, and the track listing supplies the selected profile's
 * own play counts for tracks. No browser
 * period switch remains: every section is all time and each list is already
 * ordered by its declared metric.
 */

export interface MostPlayedPerformerView {
  name: string;
  minutes: number;
  /** Opaque authority for the native performer drill. */
  selectionId: string;
}

export interface MostPlayedReleaseView {
  title: string;
  /** The release's performed-by display text (empty when the Core has none). */
  artist: string;
  /** The release's edition text (empty when the Core has none). */
  version: string;
  minutes: number;
  /** Opaque authority for the native release drill/freshness proof. */
  selectionId: string;
  /** Optional public-catalog accelerator; native identity remains canonical. */
  albumLocalId?: string;
  imageKeyHint?: string;
}

export interface MostPlayedTrackView {
  title: string;
  albumTitle: string;
  artist: string;
  mediaNumber: number;
  trackNumber: number;
  available: boolean;
  playCount: number;
  authority: MostPlayedTrackAuthority;
  /** Optional public-catalog accelerator for album art/navigation. */
  albumLocalId?: string;
  imageKeyHint?: string;
}

export type MostPlayedTrackAuthority = Exclude<
  PublicSongRowAuthority,
  { state: "public-authorized" }
>;

export interface MostPlayedResponse {
  status: CatalogStatus;
  pulledAt: string;
  topPerformers: MostPlayedPerformerView[];
  topReleases: MostPlayedReleaseView[];
  topTracks: MostPlayedTrackView[];
}

export interface MostPlayedDrillTrackView {
  title: string;
  artist: string;
  albumTitle: string;
  lengthSeconds: number | null;
  mediaNumber: number;
  trackNumber: number;
  available: boolean;
  authority: MostPlayedTrackAuthority;
}

export interface MostPlayedPerformerReleaseView {
  title: string;
  artist: string;
  version: string;
  albumLocalId?: string;
  imageKeyHint?: string;
  /** Native disc/track order within this release. */
  tracks: MostPlayedDrillTrackView[];
}

export interface MostPlayedPerformerDrillResponse {
  snapshotPulledAt: string;
  name: string;
  /** Deterministic native-release grouping; raw native identity stays server-side. */
  releases: MostPlayedPerformerReleaseView[];
}

export interface MostPlayedReleaseDrillResponse {
  snapshotPulledAt: string;
  title: string;
  artist: string;
  version: string;
  albumLocalId?: string;
  imageKeyHint?: string;
  tracks: MostPlayedDrillTrackView[];
}

const MAX_ENTRIES = 50;
export const MOST_PLAYED_DRILL_MAX_TRACKS = 500;
const CONTROL_CHARACTER = /\p{Cc}/u;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const EXCLUDED_PERFORMER_LABELS = new Set(
  [
    "Various Artists",
    "Various Performers",
    "Unknown Artist",
    "Unknown Artists",
  ].map(normalizeCatalogText)
);

function plainDataRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(record);
  return (
    keys.every((key) => typeof key === "string" && allowed.has(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  );
}

function boundedDisplayText(
  value: unknown,
  options: { allowEmpty: boolean }
): value is string {
  return (
    typeof value === "string" &&
    value.length <= CATALOG_DISPLAY_TEXT_MAX_LENGTH &&
    (options.allowEmpty || value.length > 0) &&
    value.trim() === value &&
    !CONTROL_CHARACTER.test(value) &&
    (options.allowEmpty || normalizeCatalogText(value).length > 0)
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CANONICAL_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function optionalCatalogFields(
  record: Record<string, unknown>
): { albumLocalId?: string; imageKeyHint?: string } | null {
  const hasLocalId = Object.prototype.hasOwnProperty.call(
    record,
    "albumLocalId"
  );
  const hasImage = Object.prototype.hasOwnProperty.call(record, "imageKeyHint");
  if (hasLocalId && !isCatalogLocalId(record.albumLocalId)) return null;
  if (
    hasImage &&
    (typeof record.imageKeyHint !== "string" ||
      record.imageKeyHint.length < 1 ||
      record.imageKeyHint.length > CATALOG_OPAQUE_TEXT_MAX_LENGTH ||
      CONTROL_CHARACTER.test(record.imageKeyHint))
  ) {
    return null;
  }
  return {
    ...(hasLocalId ? { albumLocalId: record.albumLocalId as string } : {}),
    ...(hasImage ? { imageKeyHint: record.imageKeyHint as string } : {}),
  };
}

function normalizePerformer(
  value: unknown
): MostPlayedPerformerView | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["name", "minutes", "selectionId"]) ||
    !boundedDisplayText(record.name, { allowEmpty: false }) ||
    EXCLUDED_PERFORMER_LABELS.has(normalizeCatalogText(record.name)) ||
    !positiveInteger(record.minutes) ||
    !isPublicSongSelectionId(record.selectionId)
  ) {
    return null;
  }
  return {
    name: record.name,
    minutes: record.minutes,
    selectionId: record.selectionId,
  };
}

function normalizeRelease(value: unknown): MostPlayedReleaseView | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      ["title", "artist", "version", "minutes", "selectionId"],
      ["albumLocalId", "imageKeyHint"]
    ) ||
    !boundedDisplayText(record.title, { allowEmpty: false }) ||
    !boundedDisplayText(record.artist, { allowEmpty: true }) ||
    !boundedDisplayText(record.version, { allowEmpty: true }) ||
    !positiveInteger(record.minutes) ||
    !isPublicSongSelectionId(record.selectionId)
  ) {
    return null;
  }
  const catalogFields = optionalCatalogFields(record);
  if (!catalogFields) return null;
  return {
    title: record.title,
    artist: record.artist,
    version: record.version,
    minutes: record.minutes,
    selectionId: record.selectionId,
    ...catalogFields,
  };
}

function normalizeTrack(value: unknown): MostPlayedTrackView | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      [
        "title",
        "albumTitle",
        "artist",
        "mediaNumber",
        "trackNumber",
        "available",
        "playCount",
        "authority",
      ],
      ["albumLocalId", "imageKeyHint"]
    ) ||
    !boundedDisplayText(record.title, { allowEmpty: false }) ||
    !boundedDisplayText(record.albumTitle, { allowEmpty: false }) ||
    !boundedDisplayText(record.artist, { allowEmpty: true }) ||
    !nonNegativeInteger(record.mediaNumber) ||
    !nonNegativeInteger(record.trackNumber) ||
    typeof record.available !== "boolean" ||
    !positiveInteger(record.playCount)
  ) {
    return null;
  }
  const authority = normalizePublicSongRowAuthority(record.authority);
  if (!authority || authority.state === "public-authorized") return null;
  if ((authority.state === "resolver-capable") !== record.available) return null;
  const catalogFields = optionalCatalogFields(record);
  if (!catalogFields) return null;
  return {
    title: record.title,
    albumTitle: record.albumTitle,
    artist: record.artist,
    mediaNumber: record.mediaNumber,
    trackNumber: record.trackNumber,
    available: record.available,
    playCount: record.playCount,
    authority,
    ...catalogFields,
  };
}

function compareText(left: string, right: string): number {
  const normalizedLeft = normalizeCatalogText(left);
  const normalizedRight = normalizeCatalogText(right);
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return left.localeCompare(right, "en-US", { sensitivity: "variant" });
}

function performersOrdered(
  left: MostPlayedPerformerView,
  right: MostPlayedPerformerView
): number {
  return right.minutes - left.minutes || compareText(left.name, right.name);
}

function releasesOrdered(
  left: MostPlayedReleaseView,
  right: MostPlayedReleaseView
): number {
  return (
    right.minutes - left.minutes ||
    compareText(left.title, right.title) ||
    compareText(left.artist, right.artist) ||
    compareText(left.version, right.version)
  );
}

function tracksOrdered(
  left: MostPlayedTrackView,
  right: MostPlayedTrackView
): number {
  return (
    right.playCount - left.playCount ||
    compareText(left.title, right.title) ||
    compareText(left.albumTitle, right.albumTitle) ||
    compareText(left.artist, right.artist) ||
    left.mediaNumber - right.mediaNumber ||
    left.trackNumber - right.trackNumber
  );
}

function normalizeOrderedList<T>(
  value: unknown,
  normalize: (candidate: unknown) => T | null,
  compare: (left: T, right: T) => number,
  maxEntries = MAX_ENTRIES
): T[] | null {
  if (!Array.isArray(value) || value.length > maxEntries) return null;
  const out: T[] = [];
  for (const candidate of value) {
    const entry = normalize(candidate);
    if (!entry) return null;
    out.push(entry);
  }
  for (let index = 1; index < out.length; index += 1) {
    if (compare(out[index - 1], out[index]) > 0) return null;
  }
  return out;
}

/** Strict client-side validation of GET /api/catalog/most-played. */
export function normalizeMostPlayedResponse(
  value: unknown
): MostPlayedResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "status",
      "pulledAt",
      "topPerformers",
      "topReleases",
      "topTracks",
    ])
  ) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  if (
    !status ||
    !canonicalTimestamp(record.pulledAt)
  ) {
    return null;
  }
  const topPerformers = normalizeOrderedList(
    record.topPerformers,
    normalizePerformer,
    performersOrdered
  );
  const topReleases = normalizeOrderedList(
    record.topReleases,
    normalizeRelease,
    releasesOrdered
  );
  const topTracks = normalizeOrderedList(
    record.topTracks,
    normalizeTrack,
    tracksOrdered
  );
  if (!topPerformers || !topReleases || !topTracks) return null;
  const selectionIds = [
    ...topPerformers.map((entry) => entry.selectionId),
    ...topReleases.map((entry) => entry.selectionId),
    ...topTracks.flatMap((entry) =>
      entry.authority.state === "resolver-capable"
        ? [entry.authority.selectionId]
        : []
    ),
  ];
  if (new Set(selectionIds).size !== selectionIds.length) return null;
  return {
    status,
    pulledAt: record.pulledAt,
    topPerformers,
    topReleases,
    topTracks,
  };
}

function normalizeDrillTrack(
  value: unknown
): MostPlayedDrillTrackView | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "title",
      "artist",
      "albumTitle",
      "lengthSeconds",
      "mediaNumber",
      "trackNumber",
      "available",
      "authority",
    ]) ||
    !boundedDisplayText(record.title, { allowEmpty: false }) ||
    !boundedDisplayText(record.artist, { allowEmpty: true }) ||
    !boundedDisplayText(record.albumTitle, { allowEmpty: false }) ||
    !(
      record.lengthSeconds === null ||
      nonNegativeInteger(record.lengthSeconds)
    ) ||
    !nonNegativeInteger(record.mediaNumber) ||
    !nonNegativeInteger(record.trackNumber) ||
    typeof record.available !== "boolean"
  ) {
    return null;
  }
  const authority = normalizePublicSongRowAuthority(record.authority);
  if (
    !authority ||
    authority.state === "public-authorized" ||
    (authority.state === "resolver-capable") !== record.available
  ) {
    return null;
  }
  return {
    title: record.title,
    artist: record.artist,
    albumTitle: record.albumTitle,
    lengthSeconds: record.lengthSeconds,
    mediaNumber: record.mediaNumber,
    trackNumber: record.trackNumber,
    available: record.available,
    authority,
  };
}

function drillTracksOrdered(
  left: MostPlayedDrillTrackView,
  right: MostPlayedDrillTrackView
): number {
  return (
    left.mediaNumber - right.mediaNumber ||
    left.trackNumber - right.trackNumber ||
    compareText(left.title, right.title) ||
    compareText(left.artist, right.artist)
  );
}

function normalizeDrillTracks(value: unknown): MostPlayedDrillTrackView[] | null {
  return normalizeOrderedList(
    value,
    normalizeDrillTrack,
    drillTracksOrdered,
    MOST_PLAYED_DRILL_MAX_TRACKS
  );
}

function normalizePerformerRelease(
  value: unknown
): MostPlayedPerformerReleaseView | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      ["title", "artist", "version", "tracks"],
      ["albumLocalId", "imageKeyHint"]
    ) ||
    !boundedDisplayText(record.title, { allowEmpty: false }) ||
    !boundedDisplayText(record.artist, { allowEmpty: true }) ||
    !boundedDisplayText(record.version, { allowEmpty: true })
  ) {
    return null;
  }
  const catalogFields = optionalCatalogFields(record);
  const tracks = normalizeDrillTracks(record.tracks);
  if (!catalogFields || !tracks) return null;
  return {
    title: record.title,
    artist: record.artist,
    version: record.version,
    ...catalogFields,
    tracks,
  };
}

function performerReleasesOrdered(
  left: MostPlayedPerformerReleaseView,
  right: MostPlayedPerformerReleaseView
): number {
  return (
    compareText(left.artist, right.artist) ||
    compareText(left.title, right.title) ||
    compareText(left.version, right.version)
  );
}

/** Strict client validation for the native performer-identity drill. */
export function normalizeMostPlayedPerformerDrillResponse(
  value: unknown
): MostPlayedPerformerDrillResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["snapshotPulledAt", "name", "releases"]) ||
    !canonicalTimestamp(record.snapshotPulledAt) ||
    !boundedDisplayText(record.name, { allowEmpty: false }) ||
    !Array.isArray(record.releases) ||
    record.releases.length > MOST_PLAYED_DRILL_MAX_TRACKS
  ) {
    return null;
  }
  const releases: MostPlayedPerformerReleaseView[] = [];
  let totalTracks = 0;
  const selectionIds = new Set<string>();
  for (const candidate of record.releases) {
    const release = normalizePerformerRelease(candidate);
    if (!release) return null;
    totalTracks += release.tracks.length;
    if (totalTracks > MOST_PLAYED_DRILL_MAX_TRACKS) return null;
    for (const track of release.tracks) {
      if (track.authority.state !== "resolver-capable") continue;
      if (selectionIds.has(track.authority.selectionId)) return null;
      selectionIds.add(track.authority.selectionId);
    }
    releases.push(release);
  }
  for (let index = 1; index < releases.length; index += 1) {
    if (performerReleasesOrdered(releases[index - 1], releases[index]) > 0) {
      return null;
    }
  }
  return {
    snapshotPulledAt: record.snapshotPulledAt,
    name: record.name,
    releases,
  };
}

/** Strict client validation for the native release-identity drill. */
export function normalizeMostPlayedReleaseDrillResponse(
  value: unknown
): MostPlayedReleaseDrillResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      ["snapshotPulledAt", "title", "artist", "version", "tracks"],
      ["albumLocalId", "imageKeyHint"]
    ) ||
    !canonicalTimestamp(record.snapshotPulledAt) ||
    !boundedDisplayText(record.title, { allowEmpty: false }) ||
    !boundedDisplayText(record.artist, { allowEmpty: true }) ||
    !boundedDisplayText(record.version, { allowEmpty: true })
  ) {
    return null;
  }
  const catalogFields = optionalCatalogFields(record);
  const tracks = normalizeDrillTracks(record.tracks);
  if (!catalogFields || !tracks) return null;
  const selectionIds = tracks.flatMap((track) =>
    track.authority.state === "resolver-capable"
      ? [track.authority.selectionId]
      : []
  );
  if (new Set(selectionIds).size !== selectionIds.length) return null;
  return {
    snapshotPulledAt: record.snapshotPulledAt,
    title: record.title,
    artist: record.artist,
    version: record.version,
    ...catalogFields,
    tracks,
  };
}
