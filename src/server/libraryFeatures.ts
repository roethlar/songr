/**
 * The single interface between this application and its optional extended
 * library feature layer (Playlists, Most Played, library date ordering, album
 * detail fallback, song relationships).
 *
 * Nothing outside this module may reach into the implementation of those
 * features. Every host site — server wiring, HTTP catalog routes, socket
 * handlers — depends on the ports declared here and on nothing else.
 *
 * Vocabulary rule for this file: every identifier and every comment speaks the
 * product's own language (features, playlists, snapshots, capability answers).
 * Implementation-internal names never appear here, in either direction.
 *
 * Absence mechanics. The implementation is loaded once, at wiring time, through
 * a specifier assembled at runtime, so the type-checker never resolves it and a
 * build whose implementation directory is absent still compiles. A load failure
 * is never fatal: `loadLibraryFeatureLayer` always returns a layer. When the
 * implementation is unreachable the returned layer answers every capability
 * question "unavailable" with an honest reason, which is the same answer the
 * capability state machine already produces when the layer is present but its
 * data is not — so absence reaches the UI as features that are simply not
 * there, never as features that are broken.
 */

import type { Logger } from "pino";

import type { AppConfig } from "../config/env";
import type { CatalogService, CatalogSnapshot } from "../core/catalog/CatalogService";
import type { CoordinatedBrowseSession } from "../core/roon/BrowseSessionCoordinator";
import type { LibraryAlbumFallbackResolverPort } from "../core/roon/LibraryAlbumService";
import type {
  PublicSongSourceVerifier,
} from "../core/roon/PublicSongResolverService";
import type { PublicSongSelectionRegistry } from "../core/roon/PublicSongSelectionRegistry";
import type { RoonCoreAddress } from "../core/roon/RoonClient";
import type {
  FocusPlaylistBootstrapPayload,
  FocusPlaylistScopeCapability,
  FocusPlaylistUneditableReasonCode,
} from "../shared/focusPlaylistContracts";
import type {
  MostPlayedPerformerDrillResponse,
  MostPlayedReleaseDrillResponse,
  MostPlayedResponse,
} from "../shared/mostPlayedContracts";
import type {
  PlaylistActionEligibility,
  PlaylistContentsResponse,
  PlaylistSummaryView,
} from "../shared/playlistContracts";
import type {
  PlaylistInsertPick,
  PlaylistInsertionPointInput,
} from "../shared/playlistMutationContracts";
import type {
  SmartPlaylistFocusCandidateAdoption,
  SmartPlaylistFocusPickerCandidate,
  SmartPlaylistFocusSelectedValue,
} from "../shared/smartPlaylistFocusContracts";
import type {
  SmartPlaylistFocusAxis,
  SmartPlaylistFocusScope,
} from "../shared/smartPlaylistFocusRegistry";
import type { UnifiedSongRelationship } from "../shared/unifiedSearchContracts";

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Base class for every failure the feature layer raises across this interface.
 *
 * The layer's own error classes extend this, so host code recognizes a feature
 * failure without naming any implementation class. The dependency points from
 * the implementation to this module and never the other way, which is what
 * keeps the host compiling when the implementation is absent.
 */
export abstract class LibraryFeatureError extends Error {
  /** Stable machine-readable failure code; clients receive it verbatim. */
  public abstract readonly code: string;
}

/**
 * A feature failure raised while answering an HTTP request. `statusCode` is the
 * status the route must answer with; the layer decides it, because only the
 * layer knows whether a failure is a bad request, a conflict, or a dead end.
 */
export abstract class LibraryFeatureRequestError extends LibraryFeatureError {
  public abstract readonly statusCode: number;
}

/**
 * The failure raised when a feature is asked to do work it cannot do because
 * the feature layer is unavailable in this build. It carries the same 409 plus
 * honest reason that an unavailable capability answer already produces.
 */
export class LibraryFeatureUnavailableError extends LibraryFeatureRequestError {
  public readonly code: string;

  public readonly statusCode = 409;

  /**
   * `code` names the feature the caller asked for, when the caller has a more
   * specific answer to give than "this feature is unavailable".
   */
  public constructor(message: string, code = "FEATURE_UNAVAILABLE") {
    super(message);
    this.name = "LibraryFeatureUnavailableError";
    this.code = code;
    Object.setPrototypeOf(this, LibraryFeatureUnavailableError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Capability answers and snapshot handles
// ---------------------------------------------------------------------------

/**
 * What the feature layer can honestly do for one Core right now.
 *
 * Every answer is paired with a reason, so a host that cannot offer a feature
 * can always say why. `reason` describes the layer's overall state and is the
 * fallback when a per-feature reason is absent.
 */
export interface LibraryFeatureCapability {
  readonly reason: string;
  readonly dateFeaturesAvailable: boolean;
  readonly playFeaturesAvailable: boolean;
  readonly playFeaturesUnavailableReason: string | null;
  readonly playlistFeaturesAvailable: boolean;
  readonly playlistFeaturesUnavailableReason: string | null;
  /**
   * Whether the per-profile album state fields the layer puts on the index
   * (`isFavorite`, `isListenLater`, `isBanned`, `contentSource`) can be
   * trusted for the listening profile configured right now.
   */
  readonly stateFilterFeaturesAvailable: boolean;
  readonly stateFilterFeaturesUnavailableReason: string | null;
}

/**
 * A handle to one pulled play-statistics snapshot. The host learns which Core
 * the snapshot belongs to and hands the handle back to the layer; it never
 * reads the contents.
 */
export interface PlayStatsSnapshotHandle {
  readonly coreId: string;
}

/**
 * A handle to one pulled playlist snapshot. Beyond the Core and the pull time
 * the host shows its user, the only thing it can do with the snapshot is ask
 * the layer to summarize it for the playlist list.
 */
export interface PlaylistSnapshotHandle {
  readonly coreId: string;
  readonly pulledAt: string;
  summarize(options?: { writesAvailable?: boolean }): PlaylistSummaryView[];
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Capability answers plus the snapshot handles they gate. Always present, even
 * when the layer is unavailable, because "unavailable, and here is why" is
 * itself an answer the host must be able to serve.
 */
export interface LibraryFeatureCatalogPort {
  requestRefresh(coreId: string): void;
  getCapability(coreId: string): Promise<LibraryFeatureCapability>;
  getMostPlayedSnapshot(coreId: string): Promise<PlayStatsSnapshotHandle | null>;
  getPlaylistSnapshot(coreId: string): Promise<PlaylistSnapshotHandle | null>;
}

/** The published Most Played lists, before the catalog status is attached. */
export type MostPlayedListView = Omit<MostPlayedResponse, "status">;

/** The Most Played list view and its performer/release drill-downs. */
export interface MostPlayedFeaturePort {
  publishView(
    snapshot: PlayStatsSnapshotHandle,
    catalog: CatalogSnapshot
  ): MostPlayedListView;
  getPerformer(
    coreId: string,
    selectionId: string
  ): Promise<MostPlayedPerformerDrillResponse>;
  getRelease(
    coreId: string,
    selectionId: string
  ): Promise<MostPlayedReleaseDrillResponse>;
}

/** One playlist's ordered contents. */
export type PlaylistContentsData = Omit<PlaylistContentsResponse, "status">;

export interface PlaylistContentsFeaturePort {
  getContents(coreId: string, playlistId: string): Promise<PlaylistContentsData>;
}

/** Whether playlist writes are offered at all, and why not when they are not. */
export interface PlaylistWritesAvailability {
  available: boolean;
  unavailableReason?: string;
}

/** The verified outcome of one playlist write. */
export interface PlaylistWriteSuccess {
  playlistId: string;
  operationId: string;
  detail: string;
}

/** One playlist as the manage surface reads it. */
export interface PlaylistManageRead {
  playlistId: string;
  kind: "smart" | "manual";
  name: string;
  description: string | null;
  actions: PlaylistActionEligibility;
}

/** One track row offered by the album track picker. */
export interface PlaylistAlbumTrackRow {
  index: number;
  title: string;
  trackNumber: number;
  mediaNumber: number;
  lengthSeconds: number | null;
  available: boolean;
}

/** One album's ordered track listing for the picker. */
export interface PlaylistAlbumTracksRead {
  albumLocalId: string;
  albumTitle: string;
  albumArtist: string;
  tracks: PlaylistAlbumTrackRow[];
}

/** Manual playlist management and the writes shared with the Focus editor. */
export interface PlaylistWritesFeaturePort {
  describeWrites(coreId: string): Promise<PlaylistWritesAvailability>;
  getManageRead(coreId: string, playlistId: string): Promise<PlaylistManageRead>;
  createManualPlaylist(
    coreId: string,
    name: string,
    description?: string
  ): Promise<PlaylistWriteSuccess>;
  renamePlaylist(
    coreId: string,
    playlistId: string,
    name: string
  ): Promise<PlaylistWriteSuccess>;
  setPlaylistDescription(
    coreId: string,
    playlistId: string,
    description: string
  ): Promise<PlaylistWriteSuccess>;
  listAlbumTracks(
    coreId: string,
    albumLocalId: string
  ): Promise<PlaylistAlbumTracksRead>;
  insertTracks(
    coreId: string,
    playlistId: string,
    picks: readonly PlaylistInsertPick[],
    insertionPoint: PlaylistInsertionPointInput
  ): Promise<PlaylistWriteSuccess>;
  removeItem(
    coreId: string,
    playlistId: string,
    position: number,
    title: string
  ): Promise<PlaylistWriteSuccess>;
  moveItem(
    coreId: string,
    playlistId: string,
    position: number,
    title: string,
    direction: "up" | "down"
  ): Promise<PlaylistWriteSuccess>;
}

/** One smart playlist as the Focus manage surface reads it. */
export interface FocusPlaylistManageRead {
  readonly playlistId: string;
  readonly name: string;
  readonly scope: SmartPlaylistFocusScope | null;
  readonly summary: string;
  readonly editable: boolean;
  readonly uneditableReasonCode?: FocusPlaylistUneditableReasonCode;
  readonly capabilities: {
    readonly tracks: FocusPlaylistScopeCapability;
    readonly albums: FocusPlaylistScopeCapability;
  };
}

/** One editor session's state as the browser receives it. */
export type FocusPlaylistBootstrap = FocusPlaylistBootstrapPayload;

/** What the picker is being asked for, within an open editor session. */
export interface FocusSelectionPickerQuery {
  readonly axis: SmartPlaylistFocusAxis;
  readonly textFilter?: string;
  readonly maxRows?: number;
}

/** One page of picker candidates for the requested axis and filter. */
export interface FocusSelectionPickerPage {
  readonly generation: number;
  readonly axis: SmartPlaylistFocusAxis;
  readonly textFilter: string;
  readonly candidates: readonly SmartPlaylistFocusPickerCandidate[];
  readonly totalCount: number;
  readonly truncated: boolean;
}

/** The Focus smart playlist editor: session lifecycle, picker, and writes. */
export interface FocusPlaylistFeaturePort {
  getManageRead(
    coreId: string,
    playlistId: string
  ): Promise<FocusPlaylistManageRead>;
  bootstrapCreate(
    coreId: string,
    scope: SmartPlaylistFocusScope,
    options?: { readonly confirmedTakeover?: boolean }
  ): Promise<FocusPlaylistBootstrap>;
  bootstrapEdit(
    coreId: string,
    playlistId: string,
    options?: { readonly confirmedTakeover?: boolean }
  ): Promise<FocusPlaylistBootstrap>;
  updateDocument(coreId: string, value: unknown): Promise<FocusPlaylistBootstrap>;
  retry(coreId: string, value: unknown): Promise<FocusPlaylistBootstrap>;
  heartbeat(coreId: string, value: unknown): Promise<FocusPlaylistBootstrap>;
  pick(
    coreId: string,
    value: unknown,
    request: FocusSelectionPickerQuery
  ): Promise<FocusSelectionPickerPage>;
  adoptCandidates(
    coreId: string,
    value: unknown,
    axis: SmartPlaylistFocusAxis,
    candidates: readonly SmartPlaylistFocusCandidateAdoption[]
  ): Promise<readonly SmartPlaylistFocusSelectedValue[]>;
  close(coreId: string, value: unknown): Promise<void>;
  createSmartPlaylist(
    coreId: string,
    name: string,
    value: unknown
  ): Promise<PlaylistWriteSuccess>;
  updateSmartPlaylist(
    coreId: string,
    playlistId: string,
    value: unknown
  ): Promise<PlaylistWriteSuccess>;
}

/** Other releases carrying a song the user is looking at. */
export interface SongRelationshipFeaturePort {
  resolve(
    coreId: string,
    songTitle: string,
    songSubtitle: string | null
  ): Promise<UnifiedSongRelationship>;
}

// ---------------------------------------------------------------------------
// The layer and its host
// ---------------------------------------------------------------------------

/**
 * Everything the feature layer exposes.
 *
 * `catalog`, `songRelationships`, and `songSourceVerifier` are always present:
 * each has an honest unavailable answer that host code can serve without
 * branching. The remaining ports are absent when the layer is unavailable, and
 * every host site already treats them as optional.
 */
export interface LibraryFeatureLayer {
  readonly catalog: LibraryFeatureCatalogPort;
  readonly songRelationships: SongRelationshipFeaturePort;
  readonly songSourceVerifier: PublicSongSourceVerifier;
  /**
   * Stops the refresh the layer runs on its own schedule, so nothing it armed
   * outlives the process. Always present — a layer with nothing scheduled
   * answers with a no-op — because the host calls it unconditionally while
   * shutting down.
   */
  stopScheduledRefresh(): void;
  readonly mostPlayed?: MostPlayedFeaturePort;
  readonly playlistContents?: PlaylistContentsFeaturePort;
  readonly playlistWrites?: PlaylistWritesFeaturePort;
  readonly focusPlaylists?: FocusPlaylistFeaturePort;
  readonly albumDetailFallback?: LibraryAlbumFallbackResolverPort;
}

/** Runs one unit of work on a serialized server-driven browse lease. */
export type CatalogBrowseRunner = <T>(
  coreId: string,
  work: (session: CoordinatedBrowseSession) => Promise<T>
) => Promise<T>;

/**
 * What the application lends the feature layer. Every member is part of the
 * application proper, so this is also the complete list of what the layer is
 * allowed to know about its host.
 */
export interface LibraryFeatureHost {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly catalog: CatalogService;
  readonly selectionRegistry: PublicSongSelectionRegistry;
  /** The paired Core's address, when one is paired. */
  readonly getCoreAddress: () => RoonCoreAddress | null;
  readonly runCatalogBrowse: CatalogBrowseRunner;
}

/** The layer's entry point: one factory, taking the host, returning the layer. */
export type LibraryFeatureLayerFactory = (
  host: LibraryFeatureHost
) => LibraryFeatureLayer;

// ---------------------------------------------------------------------------
// Loading, and the answer when there is nothing to load
// ---------------------------------------------------------------------------

/** Reason served when this build does not carry the feature layer at all. */
export const LIBRARY_FEATURES_ABSENT_REASON =
  "the extended library features are not part of this build";

/** Reason served when the feature layer is present but could not be started. */
export const LIBRARY_FEATURES_UNUSABLE_REASON =
  "the extended library features could not be started; the server log has the detail";

/** Every capability answered "no", with one honest reason. */
export function unavailableLibraryFeatureCapability(
  reason: string
): LibraryFeatureCapability {
  return {
    reason,
    dateFeaturesAvailable: false,
    playFeaturesAvailable: false,
    playFeaturesUnavailableReason: reason,
    playlistFeaturesAvailable: false,
    playlistFeaturesUnavailableReason: reason,
    stateFilterFeaturesAvailable: false,
    stateFilterFeaturesUnavailableReason: reason,
  };
}

/**
 * The layer served when there is no implementation to load. It answers, it
 * never throws at wiring time, and every answer carries `reason`.
 */
export function unavailableLibraryFeatureLayer(
  reason: string
): LibraryFeatureLayer {
  const capability = unavailableLibraryFeatureCapability(reason);
  return {
    catalog: {
      requestRefresh: () => undefined,
      getCapability: () => Promise.resolve(capability),
      getMostPlayedSnapshot: () => Promise.resolve(null),
      getPlaylistSnapshot: () => Promise.resolve(null),
    },
    songRelationships: {
      resolve: () => Promise.reject(new LibraryFeatureUnavailableError(reason)),
    },
    songSourceVerifier: {
      verify: () => Promise.resolve({ state: "unavailable" }),
    },
    stopScheduledRefresh: () => undefined,
  };
}

/**
 * The implementation directory and entry module, held as separate values so the
 * specifier below is assembled at runtime. This is load-bearing: a specifier
 * the compiler can resolve would make a build without the implementation fail
 * to type-check, which is exactly what this interface exists to prevent.
 */
const IMPLEMENTATION_DIRECTORY = "native";
const IMPLEMENTATION_ENTRY = "libraryFeatureLayer";
const IMPLEMENTATION_FACTORY = "createLibraryFeatureLayer";

/** True when the failure is "there is no such module", not a fault inside it. */
function isModuleAbsence(error: unknown, specifier: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes(specifier);
}

/**
 * Narrows the loaded module to the one export this interface expects. Anything
 * else — not an object, no factory, factory not callable — is treated as an
 * unusable layer rather than trusted.
 */
function readFactory(loaded: unknown): LibraryFeatureLayerFactory | null {
  if (typeof loaded !== "object" || loaded === null) return null;
  const candidate = (loaded as Record<string, unknown>)[IMPLEMENTATION_FACTORY];
  return typeof candidate === "function"
    ? (candidate as LibraryFeatureLayerFactory)
    : null;
}

/** Narrows the produced layer to the members host code relies on always having. */
function isUsableLayer(layer: unknown): layer is LibraryFeatureLayer {
  if (typeof layer !== "object" || layer === null) return false;
  const candidate = layer as Partial<LibraryFeatureLayer>;
  return (
    typeof candidate.catalog?.getCapability === "function" &&
    typeof candidate.catalog?.requestRefresh === "function" &&
    typeof candidate.catalog?.getMostPlayedSnapshot === "function" &&
    typeof candidate.catalog?.getPlaylistSnapshot === "function" &&
    typeof candidate.songRelationships?.resolve === "function" &&
    typeof candidate.songSourceVerifier?.verify === "function" &&
    typeof candidate.stopScheduledRefresh === "function"
  );
}

/**
 * Loads the feature layer, or returns the honest unavailable layer.
 *
 * This never throws and never rejects. A missing implementation is a normal
 * outcome that resolves to "unavailable, because this build does not carry
 * these features"; a present-but-broken implementation is logged and resolves
 * to "unavailable" too, because a half-wired feature is worse than an absent
 * one.
 */
export function loadLibraryFeatureLayer(
  host: LibraryFeatureHost
): LibraryFeatureLayer {
  const specifier = `./${IMPLEMENTATION_DIRECTORY}/${IMPLEMENTATION_ENTRY}`;
  let loaded: unknown;
  try {
    loaded = require(specifier);
  } catch (error) {
    if (isModuleAbsence(error, specifier)) {
      host.logger.info(
        { reason: LIBRARY_FEATURES_ABSENT_REASON },
        "Extended library features are not installed; serving the library without them"
      );
      return unavailableLibraryFeatureLayer(LIBRARY_FEATURES_ABSENT_REASON);
    }
    host.logger.error(
      { err: error },
      "Extended library features failed to load; serving the library without them"
    );
    return unavailableLibraryFeatureLayer(LIBRARY_FEATURES_UNUSABLE_REASON);
  }

  const factory = readFactory(loaded);
  if (!factory) {
    host.logger.error(
      { specifier },
      "Extended library features did not expose their entry point; serving the library without them"
    );
    return unavailableLibraryFeatureLayer(LIBRARY_FEATURES_UNUSABLE_REASON);
  }

  let layer: unknown;
  try {
    layer = factory(host);
  } catch (error) {
    host.logger.error(
      { err: error },
      "Extended library features failed to start; serving the library without them"
    );
    return unavailableLibraryFeatureLayer(LIBRARY_FEATURES_UNUSABLE_REASON);
  }

  if (!isUsableLayer(layer)) {
    host.logger.error(
      { specifier },
      "Extended library features produced an incomplete layer; serving the library without them"
    );
    return unavailableLibraryFeatureLayer(LIBRARY_FEATURES_UNUSABLE_REASON);
  }

  return layer;
}
