import type { CatalogStatus } from "./timelineCatalogContracts";
import {
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  normalizeCatalogStatus,
} from "./timelineCatalogContracts";
import {
  normalizePublicSongRowAuthority,
  type PublicSongRowAuthority,
} from "./publicSongResolverContracts";

/**
 * Playlist read model served by GET /api/catalog/playlists and
 * GET /api/catalog/playlists/:playlistId/contents — Slice 7 of
 * `.agents/plans/native-read-features.md`.
 *
 * Honesty contract: every playlist the Core lists stays in the list;
 * `openable` is the plan §2 method-specific predicate answer evaluated
 * server-side, and `unopenableReason` is present exactly when a playlist
 * cannot be opened. Contents come from the Core's own evaluation (the
 * extended layer's live listing query for smart playlists, the public Browse
 * playlist path for manual ones) — criteria are never re-executed. A contents item
 * carries an opaque on-demand public-song authority when its source identity
 * can be freshly rebound; otherwise it stays in the list with a typed honest
 * reason. `truncated` is the honest capped-read marker (the Core-reported
 * `totalCount` exceeds the served page).
 */

/** Bounded contents read (the Core's total may be larger). */
export const PLAYLIST_CONTENTS_MAX_ITEMS = 500;

/**
 * Exact-key playlist action bundles changed when whole-playlist deletion left
 * every public/browser surface. The header fences stale open bundles before
 * they receive a response shape their strict normalizers cannot understand.
 */
export const PLAYLIST_ACTIONS_CONTRACT_HEADER =
  "X-Roon-Controller-Playlist-Actions";
export const PLAYLIST_ACTIONS_CONTRACT_VERSION = "2";
export const PLAYLIST_ACTIONS_RELOAD_REQUIRED_MESSAGE =
  "Playlist controls changed in this build. Reload this page to continue.";

export type PlaylistKind = "smart" | "manual";

/**
 * Server-evaluated per-target write-action eligibility (Slice 11; plan §2
 * predicates: smart vs manual, read-only, and source). The UI only
 * offers the actions this structure marks true; every mutation
 * re-evaluates the predicates live before encoding.
 */
export interface PlaylistActionEligibility {
  /** Smart, local Source: criteria edit (803/804 path). */
  editCriteria: boolean;
  /** Manual, local Source, not read-only. */
  rename: boolean;
  /** Manual, local Source, not read-only. */
  setDescription: boolean;
  /** Manual, local Source, not read-only: insert/remove/reorder. */
  manageItems: boolean;
}

export interface PlaylistSummaryView {
  /** Native Playlist::PlaylistId sooid, lowercase hex (the wire key). */
  playlistId: string;
  name: string;
  kind: PlaylistKind;
  /** Playlist::TrackCount; null when the Core does not report one. */
  trackCount: number | null;
  openable: boolean;
  /** The exact honest reason; present exactly when openable is false. */
  unopenableReason?: string;
  /**
   * Slice 11 write eligibility; present exactly when the response's
   * `writes.available` is true (writes hidden otherwise).
   */
  actions?: PlaylistActionEligibility;
}

/**
 * The global write-availability answer (Slice 11). Writes are hidden with
 * the exact honest reason whenever the capability state machine does not
 * serve playlist features (PROTOCOL_INCOMPATIBLE carries its pin reason)
 * or no native profile is configured.
 */
export interface PlaylistWritesInfo {
  available: boolean;
  /** The exact honest reason; present exactly when available is false. */
  unavailableReason?: string;
}

export interface PlaylistsResponse {
  status: CatalogStatus;
  /** Canonical ISO pull instant of the native playlist snapshot. */
  pulledAt: string;
  playlists: PlaylistSummaryView[];
  writes: PlaylistWritesInfo;
}

export type PlaylistTrackAuthority = Exclude<
  PublicSongRowAuthority,
  { state: "public-authorized" }
>;

export interface PlaylistTrackView {
  /** 0-based position in the Core-evaluated playlist order. */
  position: number;
  title: string;
  /** Display artist text (empty when the Core has none). */
  artist: string;
  /** Display album title (empty when the Core/browse row has none). */
  albumTitle: string;
  lengthSeconds: number | null;
  /** Opaque resolver authority, or the exact typed reason actions are unavailable. */
  authority: PlaylistTrackAuthority;
}

export interface PlaylistContentsResponse {
  status: CatalogStatus;
  playlistId: string;
  name: string;
  kind: PlaylistKind;
  /** The Core-reported total; null when the source cannot report one. */
  totalCount: number | null;
  /** Honest capped-read marker: totalCount exceeds the served items. */
  truncated: boolean;
  items: PlaylistTrackView[];
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PLAYLIST_ID = /^[0-9a-f]+$/u;
const MAX_PLAYLISTS = 256;

function plainDataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  return value as Record<string, unknown>;
}

function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return false;
  }
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) return false;
  }
  return true;
}

function isBoundedDisplayText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= CATALOG_DISPLAY_TEXT_MAX_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}

function isDisplayText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= CATALOG_DISPLAY_TEXT_MAX_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}

function isPlaylistId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.length % 2 === 0 &&
    PLAYLIST_ID.test(value)
  );
}

function isKind(value: unknown): value is PlaylistKind {
  return value === "smart" || value === "manual";
}

function isCount(value: unknown): boolean {
  return value === null || (Number.isInteger(value) && (value as number) >= 0);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function normalizeEligibility(value: unknown): PlaylistActionEligibility | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "editCriteria",
      "rename",
      "setDescription",
      "manageItems",
    ]) ||
    typeof record.editCriteria !== "boolean" ||
    typeof record.rename !== "boolean" ||
    typeof record.setDescription !== "boolean" ||
    typeof record.manageItems !== "boolean"
  ) {
    return null;
  }
  return {
    editCriteria: record.editCriteria,
    rename: record.rename,
    setDescription: record.setDescription,
    manageItems: record.manageItems,
  };
}

function normalizeSummary(value: unknown): PlaylistSummaryView | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      ["playlistId", "name", "kind", "trackCount", "openable"],
      ["unopenableReason", "actions"]
    ) ||
    !isPlaylistId(record.playlistId) ||
    !isBoundedDisplayText(record.name) ||
    !isKind(record.kind) ||
    !isCount(record.trackCount) ||
    typeof record.openable !== "boolean"
  ) {
    return null;
  }
  const hasReason = Object.prototype.hasOwnProperty.call(
    record,
    "unopenableReason"
  );
  if (hasReason && !isBoundedDisplayText(record.unopenableReason)) return null;
  // Honesty invariant: the reason is present exactly when not openable.
  if (record.openable === hasReason) return null;
  const hasActions = Object.prototype.hasOwnProperty.call(record, "actions");
  let actions: PlaylistActionEligibility | undefined;
  if (hasActions) {
    const normalized = normalizeEligibility(record.actions);
    if (!normalized) return null;
    actions = normalized;
  }
  return {
    playlistId: record.playlistId,
    name: record.name,
    kind: record.kind,
    trackCount: record.trackCount as number | null,
    openable: record.openable,
    ...(hasReason ? { unopenableReason: record.unopenableReason as string } : {}),
    ...(actions !== undefined ? { actions } : {}),
  };
}

/** Strict client-side validation of GET /api/catalog/playlists. */
export function normalizePlaylistsResponse(
  value: unknown
): PlaylistsResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["status", "pulledAt", "playlists", "writes"])
  ) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  if (!status) return null;
  if (!isCanonicalTimestamp(record.pulledAt)) return null;
  if (!Array.isArray(record.playlists) || record.playlists.length > MAX_PLAYLISTS) {
    return null;
  }
  const writesRecord = plainDataRecord(record.writes);
  if (
    !writesRecord ||
    !hasExactKeys(writesRecord, ["available"], ["unavailableReason"]) ||
    typeof writesRecord.available !== "boolean"
  ) {
    return null;
  }
  const hasWritesReason = Object.prototype.hasOwnProperty.call(
    writesRecord,
    "unavailableReason"
  );
  if (hasWritesReason && !isBoundedDisplayText(writesRecord.unavailableReason)) {
    return null;
  }
  // Honesty invariant: the reason is present exactly when writes are unavailable.
  if (writesRecord.available === hasWritesReason) return null;
  const writes: PlaylistWritesInfo = {
    available: writesRecord.available,
    ...(hasWritesReason
      ? { unavailableReason: writesRecord.unavailableReason as string }
      : {}),
  };
  const playlists: PlaylistSummaryView[] = [];
  const seen = new Set<string>();
  for (const candidate of record.playlists) {
    const summary = normalizeSummary(candidate);
    if (!summary || seen.has(summary.playlistId)) return null;
    // Honesty invariant: per-playlist actions arrive exactly when writes
    // are globally available.
    if ((summary.actions !== undefined) !== writes.available) return null;
    seen.add(summary.playlistId);
    playlists.push(summary);
  }
  return { status, pulledAt: record.pulledAt, playlists, writes };
}

function normalizeTrack(value: unknown): PlaylistTrackView | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "position",
      "title",
      "artist",
      "albumTitle",
      "lengthSeconds",
      "authority",
    ]) ||
    !Number.isSafeInteger(record.position) ||
    (record.position as number) < 0 ||
    !isBoundedDisplayText(record.title) ||
    !isDisplayText(record.artist) ||
    !isDisplayText(record.albumTitle) ||
    !isCount(record.lengthSeconds)
  ) {
    return null;
  }
  const authority = normalizePublicSongRowAuthority(record.authority);
  if (!authority || authority.state === "public-authorized") return null;
  const position = record.position as number;
  return {
    position,
    title: record.title,
    artist: record.artist,
    albumTitle: record.albumTitle,
    lengthSeconds: record.lengthSeconds as number | null,
    authority,
  };
}

/** Strict client-side validation of GET /api/catalog/playlists/:id/contents. */
export function normalizePlaylistContentsResponse(
  value: unknown
): PlaylistContentsResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "status",
      "playlistId",
      "name",
      "kind",
      "totalCount",
      "truncated",
      "items",
    ])
  ) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  if (!status) return null;
  if (
    !isPlaylistId(record.playlistId) ||
    !isBoundedDisplayText(record.name) ||
    !isKind(record.kind) ||
    !isCount(record.totalCount) ||
    typeof record.truncated !== "boolean" ||
    !Array.isArray(record.items) ||
    record.items.length > PLAYLIST_CONTENTS_MAX_ITEMS
  ) {
    return null;
  }
  const items: PlaylistTrackView[] = [];
  for (const candidate of record.items) {
    const track = normalizeTrack(candidate);
    if (!track) return null;
    items.push(track);
  }
  // The truncated marker must be honest: it can only be set when the served
  // page is below the Core-reported total.
  if (
    record.truncated === true &&
    (record.totalCount === null || items.length >= (record.totalCount as number))
  ) {
    return null;
  }
  return {
    status,
    playlistId: record.playlistId,
    name: record.name,
    kind: record.kind,
    totalCount: record.totalCount as number | null,
    truncated: record.truncated,
    items,
  };
}
