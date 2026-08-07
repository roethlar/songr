/**
 * Shared TypeScript interfaces for Roon Controller
 *
 * This file contains all data contracts used between:
 * - Backend services (Transport, Browse, Image)
 * - REST API endpoints
 * - Socket.IO events
 * - Frontend (SvelteKit)
 */

import type { CatalogStatus } from './timelineCatalogContracts';

// ========================================
// Transport Types (A.2 - Claude)
// ========================================

/**
 * Playback state for a zone
 */
export type PlaybackState = 'playing' | 'paused' | 'stopped' | 'loading';

/**
 * Loop mode for playback
 */
export type LoopMode = 'disabled' | 'loop' | 'loop_one';

/**
 * Loop mode request value accepted by Roon transport settings.
 * "next" cycles to the next loop mode.
 */
export type LoopModeRequest = LoopMode | 'next';

/**
 * Roon zone representation
 */
export interface Zone {
  /** Unique zone identifier */
  zone_id: string;

  /** Human-readable zone name */
  display_name: string;

  /** Current playback state */
  state: PlaybackState;

  /** Seek position in seconds (if available) */
  seek_position?: number;

  /** Whether zone is currently playing */
  is_play_allowed: boolean;

  /** Whether pause is allowed */
  is_pause_allowed: boolean;

  /** Whether previous track is allowed */
  is_previous_allowed: boolean;

  /** Whether next track is allowed */
  is_next_allowed: boolean;

  /** Whether seek is allowed */
  is_seek_allowed: boolean;

  /** Number of items remaining in queue after current item */
  queue_items_remaining?: number;

  /** Remaining queue duration in seconds */
  queue_time_remaining?: number;

  /** Zone playback settings */
  settings?: ZonePlaybackSettings;

  /** Current volume settings */
  outputs?: ZoneOutput[];
}

/**
 * Playback settings at zone scope
 */
export interface ZonePlaybackSettings {
  loop?: LoopMode;
  shuffle?: boolean;
  auto_radio?: boolean;
}

/**
 * Zone output (speaker/endpoint)
 */
export interface ZoneOutput {
  /** Output identifier */
  output_id: string;

  /** Output name */
  display_name: string;

  /** Volume level (0-100, null if fixed volume) */
  volume?: VolumeSettings;

  /**
   * Source controls — power/standby endpoints exposed by the output.
   * Used by the UI to render per-output standby/wake affordances:
   * - If exactly one entry has `supports_standby: true` → single
   *   power button, click maps to `standby(output_id, control_key)`
   *   (idempotent) or `convenience_switch` (wake).
   * - If multiple → nested menu listing each by `display_name`.
   * - If none → render nothing.
   *
   * `status` values track Roon's vocabulary: `selected` /
   * `deselected` / `standby` / `indeterminate`. Treat anything
   * other than `standby` as "powered on".
   */
  source_controls?: ZoneSourceControl[];
}

export interface ZoneSourceControl {
  /** Stable identifier for this source control within the output. */
  control_key: string;

  /** Display name (e.g. "Naim NAC-N172 XS"). */
  display_name: string;

  /** Current state of the control. */
  status: 'selected' | 'deselected' | 'standby' | 'indeterminate';

  /** True if the control can be put into standby via Roon's standby API. */
  supports_standby: boolean;
}

/**
 * Volume control settings
 *
 * Roon volume types:
 *   - "number"      — absolute integer volume in [min, max]
 *   - "db"          — absolute decibel volume in [min, max]
 *   - "incremental" — relative-only control (no readable level); requests
 *                     must use `relative` mode with a step delta
 */
export type VolumeType = 'number' | 'db' | 'incremental';

export interface VolumeSettings {
  /** Volume type */
  type: VolumeType;

  /** Minimum volume value */
  min: number;

  /** Maximum volume value */
  max: number;

  /** Current volume value */
  value: number;

  /** Current step for incremental volume */
  step?: number;

  /** Whether volume is muted */
  is_muted: boolean;
}

/**
 * Currently playing track information
 */
export interface NowPlaying {
  /** Zone identifier */
  zone_id: string;

  /** Track title */
  title?: string;

  /** Primary artist */
  artist?: string;

  /** Album name */
  album?: string;

  /** Album artist */
  album_artist?: string;

  /** Track duration in seconds */
  duration?: number;

  /** Current seek position in seconds */
  seek_position?: number;

  /** Image key for artwork */
  image_key?: string;

  /** Track number on album */
  track_number?: number;

  /** Disc number */
  disc_number?: number;

  /** Release year */
  year?: number;

  /** Current playback state */
  state: PlaybackState;

  /** Loop mode */
  loop?: LoopMode;

  /** Shuffle enabled */
  shuffle?: boolean;
}

/**
 * One play observed by RecentlyPlayedService. Captured from
 * `now-playing-updated` events and persisted to disk so the welcome
 * view can show "Recently played on this controller". The record
 * carries only normalized display fields — no Roon item_keys, no
 * private state. Track identity for dedupe purposes is the tuple
 * (title, artist, album, duration, image_key); a new entry is
 * suppressed if any prior entry within the effective window has the
 * same identity. The window is `max(configured_floor, duration +
 * 5s grace)` which catches three patterns: Roon's mid-play
 * re-emits, group-play (zones grouped together emit per zone within
 * milliseconds — collapses to one entry, no zone discriminator),
 * and multi-zone interleaving (head can be a different track).
 *
 * Important caveat for UI: the list reflects what played WHILE this
 * controller's backend was running and subscribed to Roon. Plays
 * that happened during service downtime aren't captured. Label the
 * view honestly.
 */
export interface RecentlyPlayedEntry {
  /** Track title at time of play. */
  title?: string;
  /** Primary artist. */
  artist?: string;
  /** Album name. */
  album?: string;
  /** Track duration in seconds, when known. */
  duration?: number;
  /** Roon image key for artwork. Session-scoped. */
  image_key?: string;
  /** Zone where the track played. */
  zone_id: string;
  /** Display name of that zone at the time. */
  zone_name?: string;
  /** Wall-clock time the entry was recorded (ISO 8601). */
  played_at: string;
}

/**
 * Sync metadata on every RP payload (snapshots + delta events).
 *
 * `revision` is a monotonic per-process counter bumped on every state
 * change (insert, cap-drop, clear). Clients use it for ordering: deltas
 * apply only if strictly newer than what's been seen; snapshots apply
 * if newer-or-equal (they're authoritative and can repair missed
 * deltas, including the case where the snapshot is at the same
 * revision as the latest applied delta).
 *
 * `epoch` is a STRICTLY MONOTONIC per-server-process generation
 * persisted to disk alongside entries and incremented on every
 * service start. Clients order events by epoch first, revision
 * second: strictly-newer epoch = new server instance (adopt, and
 * deltas wipe local state first since they don't carry a baseline);
 * strictly-older epoch = stale in-flight payload (reject); equal
 * epoch = same instance, fall through to revision.
 *
 * The persisted-monotonic property is correctness-critical — a
 * repeated or backward-moving epoch would let a fresh server's
 * rev-0 events be rejected as stale by clients carrying higher
 * lastApplied revisions from a prior boot. `Date.now()` is too weak
 * (clock jumps, same-ms restart); the persisted generation is what
 * guarantees the property.
 */
export interface RecentlyPlayedSync {
  revision: number;
  epoch: number;
}

export interface RecentlyPlayedSnapshot extends RecentlyPlayedSync {
  entries: RecentlyPlayedEntry[];
}

export interface RecentlyPlayedInsertedPayload extends RecentlyPlayedSync {
  entry: RecentlyPlayedEntry;
}

export type RecentlyPlayedClearedPayload = RecentlyPlayedSync;

// ========================================
// Favorites
// ========================================

export type FavoriteType = 'track' | 'album' | 'artist';

/**
 * One user-curated favorite. Like RecentlyPlayedEntry, the record
 * carries only normalized display fields — no Roon item_keys (they're
 * session-scoped and stale across restarts). Clicking a favorite
 * re-resolves it against Roon search by title/artist/album, the same
 * strategy Recently Played uses.
 *
 * Identity for dedupe purposes is (type, title, artist, album) —
 * adding the same thing twice is a no-op.
 */
export interface FavoriteEntry {
  /** Server-assigned stable id (UUID) used for removal. */
  id: string;
  type: FavoriteType;
  /** Display name: track title, album title, or artist name. */
  title: string;
  /** Artist context for tracks/albums, when known. */
  artist?: string;
  /** Album context for tracks, when known. */
  album?: string;
  /** Roon image key for artwork, when known. Session-scoped. */
  image_key?: string;
  /** Wall-clock time the favorite was added (ISO 8601). */
  added_at: string;
}

/** Payload for POST /api/favorites. */
export interface AddFavoriteRequest {
  type: FavoriteType;
  title: string;
  artist?: string;
  album?: string;
  image_key?: string;
}

/** Response shape for all /api/favorites endpoints. */
export interface FavoritesResponse {
  entries: FavoriteEntry[];
}

/**
 * Queue entry for a zone
 */
export interface QueueItem {
  /** Queue item identifier understood by Roon transport */
  queue_item_id: number;

  /** Length in seconds (if provided) */
  length?: number;

  /** Artwork key */
  image_key?: string;

  /** One-line display text */
  one_line?: {
    line1?: string;
  };

  /** Two-line display text */
  two_line?: {
    line1?: string;
    line2?: string;
  };

  /** Three-line display text */
  three_line?: {
    line1?: string;
    line2?: string;
    line3?: string;
  };
}

/**
 * Queue snapshot for a zone
 */
export interface ZoneQueue {
  zone_id: string;
  items: QueueItem[];
  max_item_count: number;
  updated_at: string;
}

// ========================================
// Browse Types (A.3 - Reserved for Codex)
// ========================================

/**
 * Options for initiating a browse operation
 */
export interface BrowseOptions {
  /** Roon browse hierarchy (e.g., "browse", "search") */
  hierarchy: string;

  /** Zone or output identifier to scope results */
  zoneId?: string;

  /** Item key to drill down into */
  itemKey?: string;

  /** Optional search/input text */
  input?: string;

  /** Result offset for pagination */
  offset?: number;

  /** Display offset override */
  setDisplayOffset?: number;

  /** Refresh the hierarchy */
  refresh?: boolean;

  /** Independent session key to avoid interfering with other browse sessions */
  multiSessionKey?: string;

  /** Pop all levels to the hierarchy root before navigating */
  popAll?: boolean;

  /**
   * Maximum number of items to fetch in this call. The default is one
   * page (100). Pass a larger number to load more in a single round trip,
   * or `Infinity` to load the full list (used for small action lists).
   */
  pageSize?: number;
}

/**
 * Options for loading additional items within a hierarchy
 */
export interface BrowseLoadOptions {
  /** Roon browse hierarchy */
  hierarchy: string;

  /** Zone or output identifier */
  zoneId?: string;

  /** Item key (unused by Roon load — kept for API compat) */
  itemKey?: string;

  /** Result offset for pagination */
  offset?: number;

  /** Number of results to load */
  count?: number;

  /** Independent session key to avoid interfering with other browse sessions */
  multiSessionKey?: string;
}

/**
 * Options for popping the browse stack
 */
export interface BrowsePopOptions {
  /** Roon browse hierarchy */
  hierarchy: string;

  /**
   * Maximum number of items to fetch after popping. See `BrowseOptions.pageSize`.
   */
  pageSize?: number;

  /** Zone or output identifier */
  zoneId?: string;

  /** Number of levels to pop (defaults to 1) */
  levels?: number;

  /** Refresh the revealed level after popping */
  refresh?: boolean;

  /** Independent session key to avoid interfering with other browse sessions */
  multiSessionKey?: string;
}

/**
 * Normalized browse item returned from Roon
 */
export interface BrowseItem {
  /** Item title */
  title: string;

  /** Additional subtitle/description */
  subtitle?: string;

  /** Roon-provided item key for drilldown */
  itemKey?: string;

  /** Hint for UI (e.g., "track", "album") */
  hint?: string;

  /** Artwork key that can be resolved via ImageService */
  imageKey?: string;

  /** Indicates if item supports load */
  isLoadable: boolean;

  /** Indicates if item supports play */
  isPlayable: boolean;

  /** Optional content group type */
  itemType?: string;

  /**
   * Present when loading this item requires user input (Roon's
   * `input_prompt`, e.g. the Library > Search node). Carries the
   * prompt label ("Search"). The UI must collect text and pass it
   * as `input` instead of drilling the itemKey directly — drilling
   * without input lands on an empty "No results" list.
   */
  inputPrompt?: string;
}

/**
 * Response payload for browse and load operations
 */
export interface BrowseResult {
  /** Result title */
  title?: string;

  /** Result subtitle (e.g. album artist) */
  subtitle?: string;

  /** Current hierarchy level */
  level: number;

  /** Offset applied when fetching items */
  offset: number;

  /** Number of items returned */
  count: number;

  /** Total number of items available */
  totalCount?: number;

  /** Normalized items */
  items: BrowseItem[];
}

/**
 * Options for performing a search within the browse hierarchy
 */
export interface BrowseSearchOptions {
  /** Zone or output identifier */
  zoneId?: string;

  /** Search query */
  input: string;

  /** Result offset for pagination */
  offset?: number;

  /** Independent session key to avoid interfering with other browse sessions */
  multiSessionKey?: string;

  /** Pop all levels to the search root before searching */
  popAll?: boolean;
}

/**
 * Normalized search result item
 */
export interface SearchResult extends BrowseItem {
  /** High-level type classification */
  resultType: 'artist' | 'album' | 'track' | 'playlist' | 'genre' | 'composer' | 'label' | 'radio' | 'unknown';
  /**
   * Set on results that came from a server-expanded search category:
   * the category row's title (e.g. "Tracks") and the total match count
   * Roon reported for it. The UI uses these to offer "See all N" when
   * the expansion's first page truncated the category.
   */
  categoryTitle?: string;
  categoryTotal?: number;
}

// ========================================
// API Request/Response Types (B.1 - REST)
// ========================================

/**
 * Transport control request payload
 */
export interface TransportControlRequest {
  zone_id: string;
}

/**
 * Seek request payload
 */
export interface SeekRequest {
  zone_id: string;
  seconds: number;
}

/**
 * Volume control request payload
 */
export interface VolumeRequest {
  output_id: string;
  value: number;
}

/**
 * Queue subscription request payload
 */
export interface QueueSubscribeRequest {
  zone_id: string;
  max_item_count?: number;
}

/**
 * Queue play-from-here request payload
 */
export interface QueuePlayFromHereRequest {
  zone_id: string;
  queue_item_id: number;
}

/**
 * Zone playback settings request payload
 */
export interface ZonePlaybackSettingsRequest {
  zone_id: string;
  shuffle?: boolean;
  auto_radio?: boolean;
  loop?: LoopModeRequest;
}

/**
 * Standard success response
 */
export interface SuccessResponse {
  success: true;
}

/**
 * Error response
 */
export interface ErrorResponse {
  error: string;
  details?: string;
}

/**
 * Core status response
 */
export interface CoreStatusResponse {
  status: 'discovering' | 'paired' | 'unpaired';
  core?: {
    id: string;
    displayName: string;
    displayVersion: string;
  };
}

/**
 * The product name Roon shows in Settings → Extensions. Each running
 * instance appends its host machine's name — "Songr (living-room-pi)" —
 * because several Songr instances (an appliance and a desktop app, say)
 * may pair with one Core, and identical entries left users enabling the
 * wrong one (public issue #1 follow-up: "I enabled the extension, but
 * nothing").
 */
export const ROON_EXTENSION_DISPLAY_NAME = 'Songr';

/**
 * First-run read model (`GET /api/onboarding`).
 *
 * `CoreStatusResponse.status` cannot answer "is this a first run?": a
 * never-paired install and a paired install whose Core is currently off
 * both report `discovering`. `everPaired` reads the persisted pairing
 * identity instead, so the onboarding flow can show itself to a genuinely
 * new install without ambushing an existing one during a Core outage.
 *
 * `hostname` is this machine's `os.hostname()`. The browser cannot know
 * the host the engine runs on, and the local-playback step needs it to
 * recognise a RoonBridge zone named after this computer.
 */
export interface OnboardingStatusResponse {
  everPaired: boolean;
  hostname: string;
}

/**
 * Zones list response
 */
export interface ZonesResponse {
  zones: Zone[];
}

/**
 * Single zone response
 */
export interface ZoneResponse {
  zone: Zone | null;
}

/**
 * Queue response
 */
export interface QueueResponse {
  queue: ZoneQueue;
}

/**
 * /api/health per-subsystem diagnostics. `recently_played` and
 * `favorites` report critical degraded persistence (unreadable/unwritable
 * state files), while `catalog` is a non-critical diagnostic until Timeline
 * ships. The endpoint answers 503 with this same body when a critical
 * subsystem is degraded, so clients must read the payload on both 200 and 503.
 */
export interface RecentlyPlayedHealth {
  ready: boolean;
  degraded: boolean;
  epoch: number;
  revision: number;
  entry_count: number;
  last_persist_error?: { message: string; ts: string };
}

export interface FavoritesHealth {
  ready: boolean;
  degraded: boolean;
  entry_count: number;
}

export interface CatalogHealth {
  readonly critical: false;
  readonly ready: boolean;
  readonly degraded: boolean;
  readonly status: CatalogStatus;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  ready: boolean;
  timestamp: string;
  subsystems: {
    recently_played?: RecentlyPlayedHealth;
    favorites?: FavoritesHealth;
    catalog?: CatalogHealth;
  };
}

// ========================================
// Error Types (B.3 - Implemented)
// ========================================

// See src/core/roon/errors.ts for complete error hierarchy:
// - RoonError (base class)
// - CoreUnpairedError
// - ServiceUnavailableError
// - ImageNotFoundError
// - RoonOperationError
