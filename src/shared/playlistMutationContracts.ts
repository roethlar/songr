import type { CatalogStatus } from "./catalogContracts";
import {
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  isCatalogLocalId,
  normalizeCatalogStatus,
} from "./catalogContracts";
import type { PlaylistActionEligibility, PlaylistKind } from "./playlistContracts";
import {
  normalizeFocusPlaylistManageSmartInfo,
  type FocusPlaylistManageSmartInfo,
} from "./focusPlaylistContracts";

/**
 * Manual-playlist mutation wire contracts. Full smart-playlist Focus
 * lifecycle contracts live in focusPlaylistContracts.ts.
 * Whole-playlist deletion is deliberately absent from this public contract;
 * the low-level native operation remains only for guarded internal tooling.
 *
 * Honesty contract: a mutation response is served ONLY after the
 * server-side fresh-read verification passed — `detail` carries the exact
 * verification summary. Anything else is an error response carrying the
 * honest reason (conflict, ineligible target, refused acquisition,
 * verification failure); the client never guesses an outcome.
 *
 */

/** The manage read's smart half uses the eligibility shape from playlistContracts. */
export type { PlaylistActionEligibility };

/** GET /api/catalog/playlists/:playlistId/manage — live management read. */
export interface PlaylistManageResponse {
  status: CatalogStatus;
  playlistId: string;
  kind: PlaylistKind;
  name: string;
  /** The Core's current description; null when it has none. */
  description: string | null;
  actions: PlaylistActionEligibility;
  /** Present exactly when the playlist is smart. */
  smart?: FocusPlaylistManageSmartInfo;
}

export interface CreateManualPlaylistRequest {
  name: string;
  description?: string;
}

export interface RenamePlaylistRequest {
  name: string;
}

export interface SetPlaylistDescriptionRequest {
  description: string;
}

/** One catalog track the user picked for insertion (UI acquisition flow). */
export interface PlaylistInsertPick {
  albumLocalId: string;
  /** 0-based index into the album's ordered native track listing. */
  trackIndex: number;
  /** The exact listing title; verified against the live re-resolution. */
  title: string;
}

/** Where inserted tracks land; End is the default (plan Slice 11). */
export type PlaylistInsertionPointInput =
  | { readonly kind: "end" }
  | { readonly kind: "beginning" }
  | {
      readonly kind: "before" | "after";
      /** 0-based position in the current playlist order. */
      readonly position: number;
      /** The item title the UI showed at that position (drift check). */
      readonly title: string;
    };

export interface InsertPlaylistTracksRequest {
  picks: PlaylistInsertPick[];
  insertionPoint: PlaylistInsertionPointInput;
}

export interface RemovePlaylistItemRequest {
  /** 0-based position in the current playlist order. */
  position: number;
  /** The item title the UI showed at that position (drift check). */
  title: string;
}

export interface MovePlaylistItemRequest {
  position: number;
  title: string;
  direction: "up" | "down";
}

/**
 * The verified-mutation response every playlist write endpoint serves.
 * `detail` is the human-honest fresh-read verification summary.
 */
export interface PlaylistMutationResponse {
  status: CatalogStatus;
  /** The target playlist (the created id for creates). */
  playlistId: string;
  operationId: string;
  detail: string;
}

/** One row of the native album track listing the picker displays. */
export interface PlaylistAlbumTrackView {
  /** 0-based index into the album's media/track-ordered listing. */
  index: number;
  title: string;
  trackNumber: number;
  mediaNumber: number;
  lengthSeconds: number | null;
  /** False rows refuse insertion (the Core reports them unavailable). */
  available: boolean;
}

/**
 * GET /api/catalog/playlists-native/albums/:albumLocalId/tracks — the
 * bounded native listing (TrackQuery, media/track order) the insert
 * acquisition flow displays and later re-resolves on the write connection.
 */
export interface PlaylistAlbumTracksResponse {
  status: CatalogStatus;
  albumLocalId: string;
  albumTitle: string;
  albumArtist: string;
  tracks: PlaylistAlbumTrackView[];
}

// ---------------------------------------------------------------------------
// Strict validation (client-side response normalizers and server-side
// request parsers — the same honesty discipline as playlistContracts.ts).
// ---------------------------------------------------------------------------

const CONTROL_CHARACTER = /\p{Cc}/u;
const PLAYLIST_ID = /^[0-9a-f]+$/u;
const MAX_PICKS = 64;

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

function isBoundedName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= CATALOG_DISPLAY_TEXT_MAX_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}

function isDescription(value: unknown): value is string {
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

function isPosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

/** Strict client-side validation of the manage read. */
export function normalizePlaylistManageResponse(
  value: unknown
): PlaylistManageResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      ["status", "playlistId", "kind", "name", "description", "actions"],
      ["smart"]
    )
  ) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  if (!status) return null;
  if (
    !isPlaylistId(record.playlistId) ||
    (record.kind !== "smart" && record.kind !== "manual") ||
    !isBoundedName(record.name) ||
    !(record.description === null || isDescription(record.description))
  ) {
    return null;
  }
  const actions = normalizeEligibility(record.actions);
  if (!actions) return null;
  const hasSmart = Object.prototype.hasOwnProperty.call(record, "smart");
  // The smart info is present exactly for smart playlists.
  if (hasSmart !== (record.kind === "smart")) return null;
  let smart: FocusPlaylistManageSmartInfo | undefined;
  if (hasSmart) {
    smart = normalizeFocusPlaylistManageSmartInfo(record.smart) ?? undefined;
    if (smart === undefined) return null;
  }
  return {
    status,
    playlistId: record.playlistId,
    kind: record.kind,
    name: record.name,
    description: record.description,
    actions,
    ...(smart !== undefined ? { smart } : {}),
  };
}

/** Strict client-side validation of a verified-mutation response. */
export function normalizePlaylistMutationResponse(
  value: unknown
): PlaylistMutationResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["status", "playlistId", "operationId", "detail"])
  ) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  if (!status) return null;
  if (
    !isPlaylistId(record.playlistId) ||
    !isBoundedName(record.operationId) ||
    !isBoundedName(record.detail)
  ) {
    return null;
  }
  return {
    status,
    playlistId: record.playlistId,
    operationId: record.operationId,
    detail: record.detail,
  };
}

/** Strict client-side validation of the picker track listing. */
export function normalizePlaylistAlbumTracksResponse(
  value: unknown
): PlaylistAlbumTracksResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "status",
      "albumLocalId",
      "albumTitle",
      "albumArtist",
      "tracks",
    ])
  ) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  if (!status) return null;
  if (
    !isCatalogLocalId(record.albumLocalId) ||
    !isBoundedName(record.albumTitle) ||
    !isDescription(record.albumArtist) ||
    !Array.isArray(record.tracks) ||
    record.tracks.length > 500
  ) {
    return null;
  }
  const tracks: PlaylistAlbumTrackView[] = [];
  for (const candidate of record.tracks) {
    const row = plainDataRecord(candidate);
    if (
      !row ||
      !hasExactKeys(row, [
        "index",
        "title",
        "trackNumber",
        "mediaNumber",
        "lengthSeconds",
        "available",
      ]) ||
      !isPosition(row.index) ||
      !isBoundedName(row.title) ||
      !isPosition(row.trackNumber) ||
      !isPosition(row.mediaNumber) ||
      !(
        row.lengthSeconds === null ||
        (Number.isInteger(row.lengthSeconds) && (row.lengthSeconds as number) >= 0)
      ) ||
      typeof row.available !== "boolean"
    ) {
      return null;
    }
    tracks.push({
      index: row.index,
      title: row.title,
      trackNumber: row.trackNumber,
      mediaNumber: row.mediaNumber,
      lengthSeconds: row.lengthSeconds as number | null,
      available: row.available,
    });
  }
  return {
    status,
    albumLocalId: record.albumLocalId,
    albumTitle: record.albumTitle,
    albumArtist: record.albumArtist,
    tracks,
  };
}

// ---------------------------------------------------------------------------
// Server-side request parsers (null = invalid; the route answers 400).
// ---------------------------------------------------------------------------

export function normalizeCreateManualPlaylistRequest(
  value: unknown
): CreateManualPlaylistRequest | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["name"], ["description"]) ||
    !isBoundedName(record.name)
  ) {
    return null;
  }
  const hasDescription = Object.prototype.hasOwnProperty.call(
    record,
    "description"
  );
  if (hasDescription && !isDescription(record.description)) return null;
  return {
    name: record.name,
    ...(hasDescription ? { description: record.description as string } : {}),
  };
}

export function normalizeRenamePlaylistRequest(
  value: unknown
): RenamePlaylistRequest | null {
  const record = plainDataRecord(value);
  if (!record || !hasExactKeys(record, ["name"]) || !isBoundedName(record.name)) {
    return null;
  }
  return { name: record.name };
}

export function normalizeSetPlaylistDescriptionRequest(
  value: unknown
): SetPlaylistDescriptionRequest | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["description"]) ||
    !isDescription(record.description)
  ) {
    return null;
  }
  return { description: record.description };
}

function normalizePick(value: unknown): PlaylistInsertPick | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["albumLocalId", "trackIndex", "title"]) ||
    !isCatalogLocalId(record.albumLocalId) ||
    !isPosition(record.trackIndex) ||
    !isBoundedName(record.title)
  ) {
    return null;
  }
  return {
    albumLocalId: record.albumLocalId,
    trackIndex: record.trackIndex,
    title: record.title,
  };
}

function normalizeInsertionPoint(value: unknown): PlaylistInsertionPointInput | null {
  const record = plainDataRecord(value);
  if (!record) return null;
  if (record.kind === "end" || record.kind === "beginning") {
    return hasExactKeys(record, ["kind"]) ? { kind: record.kind } : null;
  }
  if (record.kind === "before" || record.kind === "after") {
    if (
      !hasExactKeys(record, ["kind", "position", "title"]) ||
      !isPosition(record.position) ||
      !isBoundedName(record.title)
    ) {
      return null;
    }
    return {
      kind: record.kind,
      position: record.position,
      title: record.title,
    };
  }
  return null;
}

export function normalizeInsertPlaylistTracksRequest(
  value: unknown
): InsertPlaylistTracksRequest | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["picks", "insertionPoint"]) ||
    !Array.isArray(record.picks) ||
    record.picks.length < 1 ||
    record.picks.length > MAX_PICKS
  ) {
    return null;
  }
  const picks: PlaylistInsertPick[] = [];
  for (const candidate of record.picks) {
    const pick = normalizePick(candidate);
    if (!pick) return null;
    picks.push(pick);
  }
  const insertionPoint = normalizeInsertionPoint(record.insertionPoint);
  if (!insertionPoint) return null;
  return { picks, insertionPoint };
}

export function normalizeRemovePlaylistItemRequest(
  value: unknown
): RemovePlaylistItemRequest | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["position", "title"]) ||
    !isPosition(record.position) ||
    !isBoundedName(record.title)
  ) {
    return null;
  }
  return { position: record.position, title: record.title };
}

export function normalizeMovePlaylistItemRequest(
  value: unknown
): MovePlaylistItemRequest | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["position", "title", "direction"]) ||
    !isPosition(record.position) ||
    !isBoundedName(record.title) ||
    (record.direction !== "up" && record.direction !== "down")
  ) {
    return null;
  }
  return {
    position: record.position,
    title: record.title,
    direction: record.direction,
  };
}
