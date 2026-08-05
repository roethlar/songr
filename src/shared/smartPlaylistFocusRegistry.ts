/**
 * The product's own inventory of smart-playlist Focus options: which axes the
 * editor offers, what each one is called, what kind of value it takes, and what
 * an empty selection means.
 *
 * This is the public half of a field-level split (plan §8.4). Everything here
 * describes the option as the product presents it, so contract validation, the
 * rule menu and the editor can all read one option list instead of growing
 * separate hand-maintained ones. What each axis binds to underneath — its
 * protocol fields, unit types, picker source and identity materializer — is not
 * here; it lives in `src/shared/native/smartPlaylistFocusProtocol.ts`, which
 * imports this module and joins the two halves for the layer that needs both.
 *
 * The dependency runs one way on purpose: a build without the walled tree still
 * type-checks and still validates Focus documents against this inventory.
 */

export type SmartPlaylistFocusScope = "tracks" | "albums";

export type SmartPlaylistFocusCategory =
  | "people"
  | "dates"
  | "availability"
  | "audio"
  | "text"
  | "ordering";

export type SmartPlaylistFocusValueKind =
  | "selection-set"
  | "symbol-set"
  | "integer"
  | "integer-range"
  | "date-range"
  | "state"
  | "text"
  | "ordering";

export type SmartPlaylistFocusPolaritySupport =
  | "none"
  | "include-exclude"
  | "invert-range";

export type SmartPlaylistFocusEmptyRepresentation =
  | "absent"
  | "empty-list"
  | "false"
  | "null-range"
  | "empty-inline";

export type SmartPlaylistFocusDatePrecision = "year" | "partial-date";

export type SmartPlaylistFocusPickerFilterMode =
  | "none"
  | "optional"
  | "required";

export interface SmartPlaylistFocusOption {
  readonly axis: string;
  readonly scope: SmartPlaylistFocusScope;
  readonly label: string;
  readonly category: SmartPlaylistFocusCategory;
  readonly placement: "criteria" | "ordering";
  readonly valueKind: SmartPlaylistFocusValueKind;
  readonly polarity: SmartPlaylistFocusPolaritySupport;
  readonly mode: boolean;
  readonly emptyRepresentation: SmartPlaylistFocusEmptyRepresentation;
  readonly datePrecision?: SmartPlaylistFocusDatePrecision;
  readonly pickerFilter?: SmartPlaylistFocusPickerFilterMode;
  readonly enumSymbols?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export const SMART_PLAYLIST_FOCUS_FILE_FORMATS = Object.freeze([
  "unknown",
  "flac",
  "aac",
  "alac",
  "mp3",
  "wav",
  "ogg",
  "aiff",
  "wma",
  "tidal",
  "dsf",
  "dff",
  "qobuz",
  "kkbox",
] as const);

/** Numeric order of `Roon.Numerics.AudioChannelLayout` in the installed API. */
export const SMART_PLAYLIST_FOCUS_CHANNEL_LAYOUTS = Object.freeze([
  "unknown",
  "mono",
  "stereo",
  "five-point-zero",
  "five-point-one",
  "seven-point-one",
  "one-channel",
  "two-channel",
  "three-channel",
  "four-channel",
  "five-channel",
  "six-channel",
  "seven-channel",
  "eight-channel",
  "two-point-one",
  "quadrophonic",
  "ambisonic-b-format",
] as const);

export const SMART_PLAYLIST_FOCUS_ALBUM_TYPES = Object.freeze([
  "main",
  "single",
  "compilation",
  "other",
  "unknown",
  "extended-play",
  "soundtrack",
  "show",
] as const);

export const SMART_PLAYLIST_FOCUS_IMAGE_SIZES = Object.freeze([
  "small",
  "medium",
  "large",
] as const);

export const SMART_PLAYLIST_TRACK_ORDERINGS = Object.freeze([
  "track-title",
  "date",
  "play-count",
  "last-played",
  "album-performed-by",
  "album-title",
  "track-length",
  "import-date",
  "path",
  "loudness-range",
  "track-main-performer",
  "track-composer",
  "track-number",
  "most-popular",
  "format",
  "random",
] as const);

export const SMART_PLAYLIST_ALBUM_ORDERINGS = Object.freeze([
  "main-performer-name",
  "import-date",
  "date",
  "most-played",
  "title",
  "most-popular",
  "relevance",
  "random",
] as const);

export const SMART_PLAYLIST_ORDERING_DIRECTIONS = Object.freeze([
  "default",
  "ascending",
  "descending",
] as const);

export const SMART_PLAYLIST_ALBUM_DATE_PREFERENCES = Object.freeze([
  "original-release-date",
  "release-date",
] as const);

const INT32_MAX = 2_147_483_647;

function option<
  const Axis extends string,
  const Scope extends SmartPlaylistFocusScope,
  const Kind extends SmartPlaylistFocusValueKind,
>(
  axis: Axis,
  scope: Scope,
  label: string,
  category: SmartPlaylistFocusCategory,
  valueKind: Kind,
  details: Omit<
    SmartPlaylistFocusOption,
    "axis" | "scope" | "label" | "category" | "valueKind"
  >
): SmartPlaylistFocusOption & {
  readonly axis: Axis;
  readonly scope: Scope;
  readonly valueKind: Kind;
} {
  return Object.freeze({
    axis,
    scope,
    label,
    category,
    valueKind,
    ...details,
  });
}

/**
 * One entry per editable Focus axis. The interface language and language
 * preferences are deliberately absent because they remain server-owned.
 * Ordering appears here as option metadata, but in a document it lives in the
 * dedicated `ordering` member rather than in `criteria`.
 */
export const SMART_PLAYLIST_FOCUS_OPTIONS = Object.freeze([
  option(
    "track.mainPerformers",
    "tracks",
    "Main performers",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "track.performers",
    "tracks",
    "Performers",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: true,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "track.production",
    "tracks",
    "Production",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: true,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "track.composers",
    "tracks",
    "Composers",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: true,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "track.tags",
    "tracks",
    "Tags",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "track.labels",
    "tracks",
    "Labels",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: true,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "track.locations",
    "tracks",
    "Storage locations",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "none",
    }
  ),
  option(
    "track.genres",
    "tracks",
    "Genres",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: true,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "track.year",
    "tracks",
    "Release year",
    "dates",
    "date-range",
    {
      placement: "criteria",
      polarity: "invert-range",
      mode: false,
      emptyRepresentation: "null-range",
      datePrecision: "year",
    }
  ),
  option(
    "track.importDate",
    "tracks",
    "Import date",
    "dates",
    "date-range",
    {
      placement: "criteria",
      polarity: "invert-range",
      mode: false,
      emptyRepresentation: "null-range",
      datePrecision: "partial-date",
    }
  ),
  option(
    "track.importedInLastDays",
    "tracks",
    "Imported in the last N days",
    "dates",
    "integer",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "absent",
      minimum: 1,
      maximum: 36_500,
    }
  ),
  option(
    "track.playedInLastDays",
    "tracks",
    "Played in the last N days",
    "dates",
    "integer",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "absent",
      minimum: 1,
      maximum: 36_500,
    }
  ),
  option(
    "track.mostPlayed",
    "tracks",
    "In the most played N",
    "dates",
    "integer",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "absent",
      minimum: 1,
      maximum: INT32_MAX,
    }
  ),
  option(
    "track.ratings",
    "tracks",
    "Rating",
    "dates",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "none",
    }
  ),
  option(
    "track.playCount",
    "tracks",
    "Play count",
    "dates",
    "integer-range",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "null-range",
      minimum: 0,
      maximum: INT32_MAX,
    }
  ),
  option(
    "track.favorite",
    "tracks",
    "Favorite",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.exportable",
    "tracks",
    "Exportable",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.available",
    "tracks",
    "Available",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.live",
    "tracks",
    "Live",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.mqa",
    "tracks",
    "MQA",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.picks",
    "tracks",
    "Picks",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.identified",
    "tracks",
    "Identified",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.corrupt",
    "tracks",
    "Corrupt",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.banned",
    "tracks",
    "Banned",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.lyrics",
    "tracks",
    "Has lyrics",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.local",
    "tracks",
    "Local",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.lossless",
    "tracks",
    "Lossless",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.lossy",
    "tracks",
    "Lossy",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "track.lossyBitRate",
    "tracks",
    "Lossy bitrate",
    "audio",
    "integer-range",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "null-range",
      minimum: 0,
      maximum: INT32_MAX,
    }
  ),
  option(
    "track.sampleRate",
    "tracks",
    "Sample rate",
    "audio",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "none",
    }
  ),
  option(
    "track.bitsPerSample",
    "tracks",
    "Bits per sample",
    "audio",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "none",
    }
  ),
  option(
    "track.channelLayout",
    "tracks",
    "Channel layout",
    "audio",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "none",
      enumSymbols: SMART_PLAYLIST_FOCUS_CHANNEL_LAYOUTS,
    }
  ),
  option(
    "track.fileFormat",
    "tracks",
    "File format",
    "audio",
    "symbol-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      enumSymbols: SMART_PLAYLIST_FOCUS_FILE_FORMATS,
    }
  ),
  option(
    "track.directory",
    "tracks",
    "Containing directory",
    "audio",
    "text",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "absent",
    }
  ),
  option(
    "track.trackTitle",
    "tracks",
    "Track title",
    "text",
    "text",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "absent",
    }
  ),
  option(
    "track.albumTitle",
    "tracks",
    "Album title",
    "text",
    "text",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "absent",
    }
  ),
  option(
    "track.albumPerformedBy",
    "tracks",
    "Album performed by",
    "text",
    "text",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "absent",
    }
  ),
  option(
    "track.trackMainPerformer",
    "tracks",
    "Track main performer",
    "text",
    "text",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "absent",
    }
  ),
  option(
    "track.trackComposer",
    "tracks",
    "Track composer",
    "text",
    "text",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "absent",
    }
  ),
  option(
    "track.path",
    "tracks",
    "Path",
    "text",
    "text",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "absent",
    }
  ),
  option(
    "track.ordering",
    "tracks",
    "Ordering",
    "ordering",
    "ordering",
    {
      placement: "ordering",
      polarity: "none",
      mode: false,
      emptyRepresentation: "empty-inline",
      enumSymbols: SMART_PLAYLIST_TRACK_ORDERINGS,
    }
  ),

  option(
    "album.performers",
    "albums",
    "Performers",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: true,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "album.production",
    "albums",
    "Production",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: true,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "album.composers",
    "albums",
    "Composers",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: true,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "album.tags",
    "albums",
    "Tags",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "album.labels",
    "albums",
    "Labels",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: true,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "album.locations",
    "albums",
    "Storage locations",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "none",
    }
  ),
  option(
    "album.genres",
    "albums",
    "Genres",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: true,
      emptyRepresentation: "empty-list",
      pickerFilter: "optional",
    }
  ),
  option(
    "album.similarAlbums",
    "albums",
    "Similar albums",
    "people",
    "selection-set",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "required",
    }
  ),
  option(
    "album.year",
    "albums",
    "Release year",
    "dates",
    "date-range",
    {
      placement: "criteria",
      polarity: "invert-range",
      mode: false,
      emptyRepresentation: "null-range",
      datePrecision: "year",
    }
  ),
  option(
    "album.importDate",
    "albums",
    "Import date",
    "dates",
    "date-range",
    {
      placement: "criteria",
      polarity: "invert-range",
      mode: false,
      emptyRepresentation: "null-range",
      datePrecision: "partial-date",
    }
  ),
  option(
    "album.importedInLastDays",
    "albums",
    "Imported in the last N days",
    "dates",
    "integer",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "absent",
      minimum: 1,
      maximum: 36_500,
    }
  ),
  option(
    "album.playedInLastDays",
    "albums",
    "Played in the last N days",
    "dates",
    "integer",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "absent",
      minimum: 1,
      maximum: 36_500,
    }
  ),
  option(
    "album.mostPlayed",
    "albums",
    "In the most played N",
    "dates",
    "integer",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "absent",
      minimum: 1,
      maximum: INT32_MAX,
    }
  ),
  option(
    "album.ratings",
    "albums",
    "Rating",
    "dates",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "none",
    }
  ),
  option(
    "album.imageCount",
    "albums",
    "Image count",
    "dates",
    "integer-range",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "null-range",
      minimum: 0,
      maximum: INT32_MAX,
    }
  ),
  option(
    "album.trackCount",
    "albums",
    "Track count",
    "dates",
    "integer-range",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "null-range",
      minimum: 0,
      maximum: INT32_MAX,
    }
  ),
  option(
    "album.mediaCount",
    "albums",
    "Media count",
    "dates",
    "integer-range",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "null-range",
      minimum: 0,
      maximum: INT32_MAX,
    }
  ),
  option(
    "album.lossyBitRate",
    "albums",
    "Lossy bitrate",
    "audio",
    "integer-range",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "null-range",
      minimum: 0,
      maximum: INT32_MAX,
    }
  ),
  option(
    "album.favorite",
    "albums",
    "Favorite",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.exportable",
    "albums",
    "Exportable",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.live",
    "albums",
    "Live",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.mqa",
    "albums",
    "MQA",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.bootleg",
    "albums",
    "Bootleg",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.compilation",
    "albums",
    "Compilation",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.backCover",
    "albums",
    "Has back cover",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.additionalImages",
    "albums",
    "Has additional images",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.linerNotes",
    "albums",
    "Has liner notes",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.pdf",
    "albums",
    "Has PDF",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.hasGenres",
    "albums",
    "Has genres",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.picks",
    "albums",
    "Picks",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.identified",
    "albums",
    "Identified",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.hasDate",
    "albums",
    "Has a date",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.mainImage",
    "albums",
    "Has a main image",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.corruptTracks",
    "albums",
    "Has corrupt tracks",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.banned",
    "albums",
    "Banned",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.duplicates",
    "albums",
    "Duplicates",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.alsoHidden",
    "albums",
    "Also hidden",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.onlyHidden",
    "albums",
    "Only hidden",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.multipleFormats",
    "albums",
    "Multiple formats",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.contiguousTracks",
    "albums",
    "Contiguous tracks",
    "availability",
    "state",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "false",
    }
  ),
  option(
    "album.albumTypes",
    "albums",
    "Album types",
    "audio",
    "symbol-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      enumSymbols: SMART_PLAYLIST_FOCUS_ALBUM_TYPES,
    }
  ),
  option(
    "album.mainImageSizes",
    "albums",
    "Main image size",
    "audio",
    "symbol-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      enumSymbols: SMART_PLAYLIST_FOCUS_IMAGE_SIZES,
    }
  ),
  option(
    "album.sampleRate",
    "albums",
    "Sample rate",
    "audio",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "none",
    }
  ),
  option(
    "album.bitsPerSample",
    "albums",
    "Bits per sample",
    "audio",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "none",
    }
  ),
  option(
    "album.channelLayout",
    "albums",
    "Channel layout",
    "audio",
    "selection-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      pickerFilter: "none",
    }
  ),
  option(
    "album.fileFormat",
    "albums",
    "File format",
    "audio",
    "symbol-set",
    {
      placement: "criteria",
      polarity: "include-exclude",
      mode: false,
      emptyRepresentation: "empty-list",
      enumSymbols: SMART_PLAYLIST_FOCUS_FILE_FORMATS,
    }
  ),
  option(
    "album.text",
    "albums",
    "Album text",
    "text",
    "text",
    {
      placement: "criteria",
      polarity: "none",
      mode: false,
      emptyRepresentation: "absent",
    }
  ),
  option(
    "album.ordering",
    "albums",
    "Ordering",
    "ordering",
    "ordering",
    {
      placement: "ordering",
      polarity: "none",
      mode: false,
      emptyRepresentation: "empty-inline",
      enumSymbols: SMART_PLAYLIST_ALBUM_ORDERINGS,
    }
  ),
] as const);

export type SmartPlaylistFocusOptionDefinition =
  (typeof SMART_PLAYLIST_FOCUS_OPTIONS)[number];
export type SmartPlaylistFocusAxis =
  SmartPlaylistFocusOptionDefinition["axis"];

const optionByAxis = new Map<
  SmartPlaylistFocusAxis,
  SmartPlaylistFocusOptionDefinition
>();
for (const definition of SMART_PLAYLIST_FOCUS_OPTIONS) {
  if (optionByAxis.has(definition.axis)) {
    throw new Error(`duplicate smart-playlist Focus axis ${definition.axis}`);
  }
  optionByAxis.set(definition.axis, definition);
}

export const SMART_PLAYLIST_FOCUS_OPTION_BY_AXIS: ReadonlyMap<
  SmartPlaylistFocusAxis,
  SmartPlaylistFocusOptionDefinition
> = optionByAxis;

export function smartPlaylistFocusOptionsForScope(
  scope: SmartPlaylistFocusScope
): readonly SmartPlaylistFocusOptionDefinition[] {
  return SMART_PLAYLIST_FOCUS_OPTIONS.filter(
    (definition) => definition.scope === scope
  );
}
