import type {
  AlbumRef,
  ArtistRef,
  CatalogPartialDate,
  CatalogResolutionStatus,
  CatalogStatus,
} from "./catalogContracts";
import {
  CATALOG_DISPLAY_TEXT_MAX_LENGTH,
  CATALOG_OPAQUE_TEXT_MAX_LENGTH,
  CATALOG_RESOLUTION_STATUSES,
  isCatalogLocalId,
  normalizeCatalogStatus,
} from "./catalogContracts";

/**
 * Bulk library index served by GET /api/catalog/index — a read view over
 * the existing catalog snapshot for the Unified Library surface.
 *
 * Honesty contract: unbound or ambiguous albums are preserved, never
 * dropped. `knownAlbumCount` counts only albums bound to the artist;
 * `countComplete` is true only when every album in the snapshot carries a
 * binding, because a single unbound album could belong to any artist.
 * The native date/play fields (originalReleaseDate, releaseDate,
 * importDate, playCount, lastPlayedAt — catalog persistence v3) are served
 * exactly when the album carries them and omitted cleanly otherwise; the
 * native identity binding is internal and never leaves the server here.
 */

export interface CatalogIndexArtist {
  localId: string;
  name: string;
  knownAlbumCount: number;
  countComplete: boolean;
}

/**
 * The native capability state machine's feature answers, served on the
 * index so native-driven UI features (release-year sort, recently added,
 * most played) enable or degrade honestly. Omitted only when the server
 * could not evaluate it; clients treat omission as unavailable with their
 * own fallback reason.
 */
export interface CatalogIndexNativeFeatures {
  readonly dateFeaturesAvailable: boolean;
  /**
   * The exact capability reason; present exactly when date features are
   * unavailable, never when they are available.
   */
  readonly dateFeaturesUnavailableReason?: string;
  /** Play-count-driven features (most played). */
  readonly playFeaturesAvailable: boolean;
  /**
   * The exact capability reason; present exactly when play features are
   * unavailable, never when they are available.
   */
  readonly playFeaturesUnavailableReason?: string;
  /** Playlist reads (Slice 7) — the base native capability, no date/play gate. */
  readonly playlistFeaturesAvailable: boolean;
  /**
   * The exact capability reason; present exactly when playlist features
   * are unavailable, never when they are available.
   */
  readonly playlistFeaturesUnavailableReason?: string;
  /**
   * The per-profile album state fields below (`contentSource`, `isFavorite`,
   * `isListenLater`, `isBanned`). False means the index's state fields cannot
   * be trusted for the current listening profile — the snapshot predates them
   * or was pulled for a different profile — and the surfaces that filter on
   * them are absent rather than showing an empty result.
   */
  readonly stateFilterFeaturesAvailable: boolean;
  /**
   * The exact capability reason; present exactly when the state filters are
   * unavailable, never when they are available.
   */
  readonly stateFilterFeaturesUnavailableReason?: string;
}

export interface CatalogIndexAlbum {
  localId: string;
  artistLocalId?: string;
  resolutionStatus: CatalogResolutionStatus;
  title: string;
  artist: string;
  imageKeyHint?: string;
  originalReleaseDate?: CatalogPartialDate;
  releaseDate?: CatalogPartialDate;
  /** Canonical ISO import timestamp from the native snapshot. */
  importDate?: string;
  /** Play count for the native snapshot's configured profile. */
  playCount?: number;
  /** Canonical ISO last-played instant for the configured profile. */
  lastPlayedAt?: string;
  /** Opaque audio-origin enumeration value; the surface owns the mapping. */
  contentSource?: number;
  /**
   * The configured profile's library state. Each is served exactly when the
   * album carries it. An absent field means "not known for this album" and is
   * never `false`; `false` is the positive answer that the profile does not
   * have the flag set. `stateFilterFeaturesAvailable` on `native` says
   * whether the whole set is trustworthy.
   */
  isFavorite?: boolean;
  isListenLater?: boolean;
  isBanned?: boolean;
}

export interface CatalogIndexResponse {
  status: CatalogStatus;
  artists: CatalogIndexArtist[];
  albums: CatalogIndexAlbum[];
  native?: CatalogIndexNativeFeatures;
}

export function buildCatalogIndexResponse(
  status: CatalogStatus,
  snapshot: {
    readonly artists: readonly ArtistRef[];
    readonly albums: readonly AlbumRef[];
  },
  native?: CatalogIndexNativeFeatures
): CatalogIndexResponse {
  const boundCounts = new Map<string, number>();
  let unbound = 0;
  for (const album of snapshot.albums) {
    if (album.artistLocalId === undefined) {
      unbound += 1;
      continue;
    }
    boundCounts.set(
      album.artistLocalId,
      (boundCounts.get(album.artistLocalId) ?? 0) + 1
    );
  }
  const countComplete = unbound === 0;

  const artists = snapshot.artists.map(
    (artist: ArtistRef): CatalogIndexArtist => ({
      localId: artist.localId,
      name: artist.exactName,
      knownAlbumCount: boundCounts.get(artist.localId) ?? 0,
      countComplete,
    })
  );
  const albums = snapshot.albums.map(
    (album: AlbumRef): CatalogIndexAlbum => ({
      localId: album.localId,
      ...(album.artistLocalId !== undefined
        ? { artistLocalId: album.artistLocalId }
        : {}),
      resolutionStatus: album.resolutionStatus,
      title: album.exactTitle,
      artist: album.exactArtist,
      ...(album.imageKeyHint !== undefined
        ? { imageKeyHint: album.imageKeyHint }
        : {}),
      ...(album.originalReleaseDate !== undefined
        ? { originalReleaseDate: { ...album.originalReleaseDate } }
        : {}),
      ...(album.releaseDate !== undefined
        ? { releaseDate: { ...album.releaseDate } }
        : {}),
      ...(album.importDate !== undefined
        ? { importDate: album.importDate }
        : {}),
      ...(album.playCount !== undefined
        ? { playCount: album.playCount }
        : {}),
      ...(album.lastPlayedAt !== undefined
        ? { lastPlayedAt: album.lastPlayedAt }
        : {}),
      ...(album.contentSource !== undefined
        ? { contentSource: album.contentSource }
        : {}),
      ...(album.isFavorite !== undefined
        ? { isFavorite: album.isFavorite }
        : {}),
      ...(album.isListenLater !== undefined
        ? { isListenLater: album.isListenLater }
        : {}),
      ...(album.isBanned !== undefined ? { isBanned: album.isBanned } : {}),
    })
  );
  return {
    status,
    artists,
    albums,
    ...(native !== undefined ? { native: { ...native } } : {}),
  };
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isIndexNativeDate(value: unknown): value is CatalogPartialDate {
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

function isIndexTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

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

/**
 * Strict native-capability validation with the honesty rule pinned: each
 * unavailable reason is present exactly when its feature is unavailable.
 */
function normalizeIndexNativeFeatures(
  value: unknown
): CatalogIndexNativeFeatures | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      [
        "dateFeaturesAvailable",
        "playFeaturesAvailable",
        "playlistFeaturesAvailable",
        "stateFilterFeaturesAvailable",
      ],
      [
        "dateFeaturesUnavailableReason",
        "playFeaturesUnavailableReason",
        "playlistFeaturesUnavailableReason",
        "stateFilterFeaturesUnavailableReason",
      ]
    ) ||
    typeof record.dateFeaturesAvailable !== "boolean" ||
    typeof record.playFeaturesAvailable !== "boolean" ||
    typeof record.playlistFeaturesAvailable !== "boolean" ||
    typeof record.stateFilterFeaturesAvailable !== "boolean"
  ) {
    return null;
  }
  const hasReason = Object.prototype.hasOwnProperty.call(
    record,
    "dateFeaturesUnavailableReason"
  );
  if (hasReason && !isBoundedDisplayText(record.dateFeaturesUnavailableReason)) {
    return null;
  }
  if (record.dateFeaturesAvailable === hasReason) return null;
  const hasPlayReason = Object.prototype.hasOwnProperty.call(
    record,
    "playFeaturesUnavailableReason"
  );
  if (
    hasPlayReason &&
    !isBoundedDisplayText(record.playFeaturesUnavailableReason)
  ) {
    return null;
  }
  if (record.playFeaturesAvailable === hasPlayReason) return null;
  const hasPlaylistReason = Object.prototype.hasOwnProperty.call(
    record,
    "playlistFeaturesUnavailableReason"
  );
  if (
    hasPlaylistReason &&
    !isBoundedDisplayText(record.playlistFeaturesUnavailableReason)
  ) {
    return null;
  }
  if (record.playlistFeaturesAvailable === hasPlaylistReason) return null;
  const hasStateFilterReason = Object.prototype.hasOwnProperty.call(
    record,
    "stateFilterFeaturesUnavailableReason"
  );
  if (
    hasStateFilterReason &&
    !isBoundedDisplayText(record.stateFilterFeaturesUnavailableReason)
  ) {
    return null;
  }
  if (record.stateFilterFeaturesAvailable === hasStateFilterReason) return null;
  return {
    dateFeaturesAvailable: record.dateFeaturesAvailable,
    ...(hasReason
      ? {
          dateFeaturesUnavailableReason:
            record.dateFeaturesUnavailableReason as string,
        }
      : {}),
    playFeaturesAvailable: record.playFeaturesAvailable,
    ...(hasPlayReason
      ? {
          playFeaturesUnavailableReason:
            record.playFeaturesUnavailableReason as string,
        }
      : {}),
    playlistFeaturesAvailable: record.playlistFeaturesAvailable,
    ...(hasPlaylistReason
      ? {
          playlistFeaturesUnavailableReason:
            record.playlistFeaturesUnavailableReason as string,
        }
      : {}),
    stateFilterFeaturesAvailable: record.stateFilterFeaturesAvailable,
    ...(hasStateFilterReason
      ? {
          stateFilterFeaturesUnavailableReason:
            record.stateFilterFeaturesUnavailableReason as string,
        }
      : {}),
  };
}

function isBoundedOpaqueText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= CATALOG_OPAQUE_TEXT_MAX_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}

/**
 * Strict client-side validation of GET /api/catalog/index. Beyond shape,
 * this enforces the index honesty semantics: `knownAlbumCount` must equal
 * the actual bound-album count, `countComplete` must equal "no unbound
 * albums exist", every binding must reference a listed artist, and IDs
 * must be unique. Anything else is rejected as a whole.
 */
export function normalizeCatalogIndexResponse(
  value: unknown
): CatalogIndexResponse | null {
  const record = plainDataRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["status", "artists", "albums"], ["native"])
  ) {
    return null;
  }
  const status = normalizeCatalogStatus(record.status);
  if (!status) return null;
  if (!Array.isArray(record.artists) || !Array.isArray(record.albums)) {
    return null;
  }
  const hasNative = Object.prototype.hasOwnProperty.call(record, "native");
  let native: CatalogIndexNativeFeatures | undefined;
  if (hasNative) {
    const parsed = normalizeIndexNativeFeatures(record.native);
    if (parsed === null) return null;
    native = parsed;
  }

  const albums: CatalogIndexAlbum[] = [];
  const albumIds = new Set<string>();
  const boundCounts = new Map<string, number>();
  let unbound = 0;
  for (const candidate of record.albums) {
    const album = plainDataRecord(candidate);
    if (
      !album ||
      !hasExactKeys(
        album,
        ["localId", "resolutionStatus", "title", "artist"],
        [
          "artistLocalId",
          "imageKeyHint",
          "originalReleaseDate",
          "releaseDate",
          "importDate",
          "playCount",
          "lastPlayedAt",
          "contentSource",
          "isFavorite",
          "isListenLater",
          "isBanned",
        ]
      ) ||
      !isCatalogLocalId(album.localId) ||
      albumIds.has(album.localId) ||
      !CATALOG_RESOLUTION_STATUSES.includes(
        album.resolutionStatus as CatalogResolutionStatus
      ) ||
      !isBoundedDisplayText(album.title) ||
      !isBoundedDisplayText(album.artist)
    ) {
      return null;
    }
    const hasBinding = Object.prototype.hasOwnProperty.call(
      album,
      "artistLocalId"
    );
    if (hasBinding && !isCatalogLocalId(album.artistLocalId)) return null;
    const hasImageHint = Object.prototype.hasOwnProperty.call(
      album,
      "imageKeyHint"
    );
    if (hasImageHint && !isBoundedOpaqueText(album.imageKeyHint)) return null;
    // These two locals are named for the product concept rather than the wire
    // key they check. Boundary §4 denylists the extended layer's own spellings
    // of these two fields, and a camelCase local that embeds the spelling
    // reintroduces it; the wire keys themselves are generic music-metadata
    // names and stay exactly as they are. The key each one tests is on the
    // line below it, so nothing is hidden by the indirection.
    const hasOriginalRelease = Object.prototype.hasOwnProperty.call(
      album,
      "originalReleaseDate"
    );
    if (hasOriginalRelease && !isIndexNativeDate(album.originalReleaseDate)) {
      return null;
    }
    const hasReleaseDate = Object.prototype.hasOwnProperty.call(
      album,
      "releaseDate"
    );
    if (hasReleaseDate && !isIndexNativeDate(album.releaseDate)) return null;
    const hasImportTimestamp = Object.prototype.hasOwnProperty.call(
      album,
      "importDate"
    );
    if (hasImportTimestamp && !isIndexTimestamp(album.importDate)) return null;
    const hasPlayCount = Object.prototype.hasOwnProperty.call(
      album,
      "playCount"
    );
    if (
      hasPlayCount &&
      (!Number.isInteger(album.playCount) || (album.playCount as number) < 0)
    ) {
      return null;
    }
    const hasLastPlayedAt = Object.prototype.hasOwnProperty.call(
      album,
      "lastPlayedAt"
    );
    if (hasLastPlayedAt && !isIndexTimestamp(album.lastPlayedAt)) return null;
    const hasAudioOrigin = Object.prototype.hasOwnProperty.call(
      album,
      "contentSource"
    );
    if (
      hasAudioOrigin &&
      (!Number.isInteger(album.contentSource) ||
        (album.contentSource as number) < 0)
    ) {
      return null;
    }
    // Each state flag is validated as a strict boolean. `hasOwnProperty` is
    // what decides presence, never truthiness: a served `false` is a real
    // answer and must survive the round trip as one.
    const stateFlagKeys = ["isFavorite", "isListenLater", "isBanned"] as const;
    const presentStateFlags = stateFlagKeys.filter((key) =>
      Object.prototype.hasOwnProperty.call(album, key)
    );
    if (presentStateFlags.some((key) => typeof album[key] !== "boolean")) {
      return null;
    }
    albumIds.add(album.localId);
    if (hasBinding) {
      const artistLocalId = album.artistLocalId as string;
      boundCounts.set(artistLocalId, (boundCounts.get(artistLocalId) ?? 0) + 1);
    } else {
      unbound += 1;
    }
    albums.push({
      localId: album.localId,
      ...(hasBinding ? { artistLocalId: album.artistLocalId as string } : {}),
      resolutionStatus: album.resolutionStatus as CatalogResolutionStatus,
      title: album.title,
      artist: album.artist,
      ...(hasImageHint ? { imageKeyHint: album.imageKeyHint as string } : {}),
      ...(hasOriginalRelease
        ? {
            originalReleaseDate: {
              ...(album.originalReleaseDate as CatalogPartialDate),
            },
          }
        : {}),
      ...(hasReleaseDate
        ? { releaseDate: { ...(album.releaseDate as CatalogPartialDate) } }
        : {}),
      ...(hasImportTimestamp ? { importDate: album.importDate as string } : {}),
      ...(hasPlayCount ? { playCount: album.playCount as number } : {}),
      ...(hasAudioOrigin ? { contentSource: album.contentSource as number } : {}),
      ...Object.fromEntries(
        presentStateFlags.map((key) => [key, album[key] as boolean])
      ),
      ...(hasLastPlayedAt
        ? { lastPlayedAt: album.lastPlayedAt as string }
        : {}),
    });
  }

  const expectedCountComplete = unbound === 0;
  const artists: CatalogIndexArtist[] = [];
  const artistIds = new Set<string>();
  for (const candidate of record.artists) {
    const artist = plainDataRecord(candidate);
    if (
      !artist ||
      !hasExactKeys(artist, [
        "localId",
        "name",
        "knownAlbumCount",
        "countComplete",
      ]) ||
      !isCatalogLocalId(artist.localId) ||
      artistIds.has(artist.localId) ||
      !isBoundedDisplayText(artist.name) ||
      typeof artist.knownAlbumCount !== "number" ||
      !Number.isSafeInteger(artist.knownAlbumCount) ||
      artist.knownAlbumCount !== (boundCounts.get(artist.localId) ?? 0) ||
      artist.countComplete !== expectedCountComplete
    ) {
      return null;
    }
    artistIds.add(artist.localId);
    artists.push({
      localId: artist.localId,
      name: artist.name,
      knownAlbumCount: artist.knownAlbumCount,
      countComplete: artist.countComplete,
    });
  }
  for (const boundArtistId of boundCounts.keys()) {
    if (!artistIds.has(boundArtistId)) return null;
  }
  return {
    status,
    artists,
    albums,
    ...(native !== undefined ? { native } : {}),
  };
}
