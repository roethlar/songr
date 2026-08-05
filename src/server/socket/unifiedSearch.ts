import type { Logger } from "pino";
import type { Socket } from "socket.io";

import type { BrowseService } from "../../core/roon/BrowseService";
import {
  BrowseSessionCoordinator,
  BrowseSessionCoordinatorError,
  type ClassicPublishedItemBinding,
  type CoordinatedModeActionSession,
  type ModeSessionAccess,
  type ModeSessionHandle,
} from "../../core/roon/BrowseSessionCoordinator";
import {
  SongActionResolutionError,
  SongActionResolver,
  type SongActionResolverPort,
} from "../../core/roon/SongActionResolver";
import {
  LibraryFeatureError,
  type SongRelationshipFeaturePort,
} from "../libraryFeatures";
import {
  UNIFIED_SONG_SEARCH_RESULT_MAX,
  normalizeUnifiedSearchClearRequest,
  normalizeUnifiedSongActionRequest,
  normalizeUnifiedSongRelationshipRequest,
  normalizeUnifiedSongSearchRequest,
  type UnifiedSearchClearAck,
  type UnifiedSearchErrorCode,
  type UnifiedSongActionAck,
  type UnifiedSongActionErrorCode,
  type UnifiedSongRelationshipAck,
  type UnifiedSongRelationshipErrorCode,
  type UnifiedSongSearchAck,
} from "../../shared/unifiedSearchContracts";
import type { Zone } from "../../shared/types";

const USED_ACTION_REQUEST_LIMIT = 256;

type SearchAck = (value: UnifiedSongSearchAck) => void;
type ActionAck = (value: UnifiedSongActionAck) => void;
type RelationshipAck = (value: UnifiedSongRelationshipAck) => void;
type ClearAck = (value: UnifiedSearchClearAck) => void;

export interface UnifiedSearchZonePort {
  getZone(zoneId: string): Zone | undefined;
}

export interface UnifiedSearchSocketDependencies {
  readonly coordinator: BrowseSessionCoordinator;
  readonly browseService: BrowseService;
  readonly zones: UnifiedSearchZonePort;
  readonly songActionResolver?: SongActionResolverPort;
  readonly songRelationships: SongRelationshipFeaturePort;
  readonly getCoreId: () => string | null;
  readonly logger: Logger;
}

class SongActionPhaseError extends Error {
  public constructor(
    public readonly code: UnifiedSongActionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SongActionPhaseError";
    Object.setPrototypeOf(this, SongActionPhaseError.prototype);
  }
}

class SongRelationshipPhaseError extends Error {
  public constructor(
    public readonly code: UnifiedSongRelationshipErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SongRelationshipPhaseError";
    Object.setPrototypeOf(this, SongRelationshipPhaseError.prototype);
  }
}

function modeHandle(session: {
  handleId: string;
  generation: number;
}): ModeSessionHandle {
  return { kind: "mode", mode: "classic", ...session };
}

function modeAccess(
  coreId: string,
  socketId: string,
  request: {
    tabId: string;
    session: { handleId: string; generation: number };
  }
): ModeSessionAccess {
  return {
    coreId,
    socketId,
    tabId: request.tabId,
    handle: modeHandle(request.session),
  };
}

function searchErrorCode(error: unknown): UnifiedSearchErrorCode {
  if (error instanceof BrowseSessionCoordinatorError) {
    if (error.code === "BACKPRESSURE") return "BACKPRESSURE";
    if (error.code === "OWNER_MISMATCH") return "OWNER_MISMATCH";
    if (error.code === "SESSION_LOST") return "SESSION_LOST";
    return "STALE_GENERATION";
  }
  return "INTERNAL_ERROR";
}

function searchFailure(
  code: UnifiedSearchErrorCode,
  error: string
): UnifiedSongSearchAck {
  return {
    success: false,
    code,
    error: error.slice(0, 1_024) || "Song search failed",
  };
}

function clearFailure(
  code: UnifiedSearchErrorCode,
  error: string
): UnifiedSearchClearAck {
  return {
    success: false,
    code,
    error: error.slice(0, 1_024) || "Search close failed",
  };
}

function actionFailure(
  code: UnifiedSongActionErrorCode,
  error: string
): UnifiedSongActionAck {
  return {
    success: false,
    code,
    error: error.slice(0, 1_024) || "Song action failed",
  };
}

function relationshipFailure(
  code: UnifiedSongRelationshipErrorCode,
  error: string
): UnifiedSongRelationshipAck {
  return {
    success: false,
    code,
    error: error.slice(0, 1_024) || "Song relationships are unavailable",
  };
}

function actionErrorCode(error: unknown): UnifiedSongActionErrorCode {
  if (error instanceof SongActionPhaseError) return error.code;
  if (error instanceof SongActionResolutionError) {
    return error.cause
      ? actionErrorCode(error.cause)
      : "ACTION_UNAVAILABLE";
  }
  if (error instanceof BrowseSessionCoordinatorError) {
    if (error.code === "BACKPRESSURE") return "BACKPRESSURE";
    if (error.code === "OWNER_MISMATCH") return "OWNER_MISMATCH";
    if (error.code === "SESSION_LOST") return "SESSION_LOST";
    return "STALE_RESULT";
  }
  return "PRE_ISSUE_FAILED";
}

function relationshipErrorCode(
  error: unknown
): UnifiedSongRelationshipErrorCode {
  if (error instanceof SongRelationshipPhaseError) return error.code;
  // Any failure the library feature layer raises — including the one it
  // raises when the feature is not part of this build — reads to the client
  // as "relationships are unavailable", never as a broken feature.
  if (error instanceof LibraryFeatureError) {
    return "RELATIONSHIP_UNAVAILABLE";
  }
  if (error instanceof BrowseSessionCoordinatorError) {
    if (error.code === "OWNER_MISMATCH") return "OWNER_MISMATCH";
    if (error.code === "SESSION_LOST") return "SESSION_LOST";
    return "STALE_RESULT";
  }
  return "INTERNAL_ERROR";
}

function zoneTopologyFingerprint(
  zone: Zone,
  expectedZoneId: string
): string | null {
  if (zone.zone_id !== expectedZoneId) return null;
  const outputIds = (zone.outputs ?? []).map((output) => output.output_id);
  if (
    outputIds.some(
      (outputId) => typeof outputId !== "string" || outputId.length === 0
    )
  ) {
    return null;
  }
  return JSON.stringify([
    zone.zone_id,
    [...new Set(outputIds)].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    ),
  ]);
}

function sameBinding(
  expected: ClassicPublishedItemBinding,
  current: ClassicPublishedItemBinding
): boolean {
  return (
    expected.authorityGeneration === current.authorityGeneration &&
    expected.item.itemKey === current.item.itemKey &&
    expected.item.title === current.item.title &&
    (expected.item.subtitle ?? null) === (current.item.subtitle ?? null)
  );
}

function rememberRequestId(
  used: Map<string, true>,
  requestId: string
): boolean {
  if (used.has(requestId)) return false;
  used.set(requestId, true);
  while (used.size > USED_ACTION_REQUEST_LIMIT) {
    const oldest = used.keys().next().value;
    if (typeof oldest !== "string") break;
    used.delete(oldest);
  }
  return true;
}

async function restoreTracksPage(input: {
  coordinator: BrowseSessionCoordinator;
  access: ModeSessionAccess;
  session: CoordinatedModeActionSession;
  authorityGeneration: number;
  navigationDepth: number | null;
  zoneId: string;
}): Promise<boolean> {
  const {
    coordinator,
    access,
    session,
    authorityGeneration,
    navigationDepth,
    zoneId,
  } = input;
  if (navigationDepth === 0) return true;
  if (navigationDepth === null) {
    try {
      coordinator.retireClassicPublishedItems(
        access,
        "classic-search",
        authorityGeneration
      );
    } catch {
      // Session loss already retires the owning authority.
    }
    return false;
  }
  try {
    const restored = await session.pop({
      hierarchy: "search",
      zoneId,
      levels: navigationDepth,
      pageSize: UNIFIED_SONG_SEARCH_RESULT_MAX,
    });
    return coordinator.retainClassicPublishedItemsAfterRestore(
      access,
      "classic-search",
      authorityGeneration,
      restored
    );
  } catch {
    try {
      coordinator.retireClassicPublishedItems(
        access,
        "classic-search",
        authorityGeneration
      );
    } catch {
      // Session loss already retires the owning authority.
    }
    return false;
  }
}

export function registerUnifiedSearchSocket(
  socket: Socket,
  dependencies: UnifiedSearchSocketDependencies
): void {
  const {
    coordinator,
    browseService,
    zones,
    songRelationships,
    getCoreId,
    logger,
  } = dependencies;
  const songActionResolver =
    dependencies.songActionResolver ?? new SongActionResolver();
  const usedActionRequestIds = new Map<string, true>();
  const actionResultsInFlight = new Set<string>();

  socket.on(
    "unified-search:search",
    async (value: unknown, ack?: SearchAck): Promise<void> => {
      const request = normalizeUnifiedSongSearchRequest(value);
      if (!request || !ack) {
        ack?.(
          searchFailure("INVALID_REQUEST", "Invalid song search request")
        );
        return;
      }
      const coreId = getCoreId();
      if (!coreId) {
        ack(searchFailure("CORE_UNAVAILABLE", "Roon Core is unavailable"));
        return;
      }
      const access = modeAccess(coreId, socket.id, request);

      let authorityGeneration: number;
      try {
        // This is intentionally synchronous. A newer query invalidates an
        // older in-flight query before either can publish a result ID.
        authorityGeneration = coordinator.beginClassicPublishedItems(
          access,
          "classic-search"
        );
      } catch (error) {
        const code = searchErrorCode(error);
        ack(
          searchFailure(
            code,
            error instanceof Error ? error.message : "Song search failed"
          )
        );
        return;
      }

      try {
        const results = await coordinator.runMode(
          access,
          "classic-search",
          async (session) => {
            const searchPage = await browseService.searchTracksCoordinated(
              session,
              {
                input: request.query,
                popAll: true,
              }
            );
            return coordinator.replaceClassicPublishedItems(
              access,
              "classic-search",
              authorityGeneration,
              searchPage.songs,
              searchPage.page
            );
          }
        );
        ack({
          success: true,
          data: {
            requestId: request.requestId,
            session: request.session,
            query: request.query,
            results: results.map(({ token, item }) => ({
              resultId: token,
              title: item.title,
              subtitle: item.subtitle ?? "",
              imageKey: item.imageKey ?? null,
            })),
          },
        });
      } catch (error) {
        const code = searchErrorCode(error);
        logger.error({ err: error }, "Unified song search failed");
        ack(
          searchFailure(
            code,
            code === "INTERNAL_ERROR"
              ? "Song search failed"
              : error instanceof Error
                ? error.message
                : "Song search failed"
          )
        );
      }
    }
  );

  socket.on(
    "unified-search:relationship",
    async (value: unknown, ack?: RelationshipAck): Promise<void> => {
      const request = normalizeUnifiedSongRelationshipRequest(value);
      if (!request || !ack) {
        ack?.(
          relationshipFailure(
            "INVALID_REQUEST",
            "Invalid song relationship request"
          )
        );
        return;
      }
      const coreId = getCoreId();
      if (!coreId) {
        ack(
          relationshipFailure(
            "CORE_UNAVAILABLE",
            "Roon Core is unavailable"
          )
        );
        return;
      }
      const access = modeAccess(coreId, socket.id, request);
      try {
        const binding = coordinator.resolveClassicPublishedItemBinding(
          access,
          "classic-search",
          request.resultId
        );
        const relationship = await songRelationships.resolve(
          coreId,
          binding.item.title,
          binding.item.subtitle ?? null
        );
        const current = coordinator.resolveClassicPublishedItemBinding(
          access,
          "classic-search",
          request.resultId
        );
        if (!sameBinding(binding, current)) {
          throw new SongRelationshipPhaseError(
            "STALE_RESULT",
            "The song result was replaced"
          );
        }
        ack({
          success: true,
          data: {
            requestId: request.requestId,
            session: request.session,
            resultId: request.resultId,
            songTitle: relationship.songTitle,
            albums: relationship.albums,
            composerLabels: relationship.composerLabels,
          },
        });
      } catch (error) {
        const code = relationshipErrorCode(error);
        if (code === "INTERNAL_ERROR") {
          logger.error(
            { err: error },
            "Unified song relationship lookup failed"
          );
        }
        ack(
          relationshipFailure(
            code,
            code === "INTERNAL_ERROR"
              ? "Song relationships are unavailable"
              : error instanceof Error
                ? error.message
                : "Song relationships are unavailable"
          )
        );
      }
    }
  );

  socket.on(
    "unified-search:action",
    async (value: unknown, ack?: ActionAck): Promise<void> => {
      const request = normalizeUnifiedSongActionRequest(value);
      if (!request || !ack) {
        ack?.(
          actionFailure("INVALID_REQUEST", "Invalid song action request")
        );
        return;
      }
      if (!rememberRequestId(usedActionRequestIds, request.requestId)) {
        ack(
          actionFailure(
            "REQUEST_ID_CONFLICT",
            "The song action request ID was already used"
          )
        );
        return;
      }
      const coreId = getCoreId();
      if (!coreId) {
        ack(actionFailure("CORE_UNAVAILABLE", "Roon Core is unavailable"));
        return;
      }
      const access = modeAccess(coreId, socket.id, request);
      if (actionResultsInFlight.has(request.resultId)) {
        ack(
          actionFailure(
            "BACKPRESSURE",
            "An action for this song is already in progress"
          )
        );
        return;
      }

      let binding: ClassicPublishedItemBinding;
      try {
        binding = coordinator.resolveClassicPublishedItemBinding(
          access,
          "classic-search",
          request.resultId
        );
      } catch (error) {
        ack(
          actionFailure(
            actionErrorCode(error),
            error instanceof Error ? error.message : "The song result is stale"
          )
        );
        return;
      }

      const initialZone = zones.getZone(request.zoneId);
      const initialTopology = initialZone
        ? zoneTopologyFingerprint(initialZone, request.zoneId)
        : null;
      if (!initialTopology) {
        ack(
          actionFailure(
            "ZONE_UNAVAILABLE",
            "The target zone is unavailable"
          )
        );
        return;
      }

      actionResultsInFlight.add(request.resultId);
      let issued = false;
      try {
        const authorityRetired = await coordinator.runModeAction(
          access,
          "classic-search",
          async (session) => {
            const current = coordinator.resolveClassicPublishedItemBinding(
              access,
              "classic-search",
              request.resultId
            );
            if (!sameBinding(binding, current)) {
              throw new SongActionPhaseError(
                "STALE_RESULT",
                "The song result was replaced"
              );
            }

            let navigationDepth: number | null = 0;
            let primaryError: unknown;
            try {
              const resolved = await songActionResolver.resolve(
                session,
                binding.item,
                request.zoneId,
                request.semantic
              );
              navigationDepth = resolved.navigationDepth;
              await session.executeAction(
                {
                  hierarchy: "search",
                  zoneId: request.zoneId,
                  itemKey: resolved.itemKey,
                },
                () => {
                  const beforeIssue =
                    coordinator.resolveClassicPublishedItemBinding(
                      access,
                      "classic-search",
                      request.resultId
                    );
                  if (!sameBinding(binding, beforeIssue)) {
                    throw new SongActionPhaseError(
                      "STALE_RESULT",
                      "The song result changed before execution"
                    );
                  }
                  const currentZone = zones.getZone(request.zoneId);
                  if (!currentZone) {
                    throw new SongActionPhaseError(
                      "ZONE_UNAVAILABLE",
                      "The target zone disappeared"
                    );
                  }
                  if (
                    zoneTopologyFingerprint(currentZone, request.zoneId) !==
                    initialTopology
                  ) {
                    throw new SongActionPhaseError(
                      "ZONE_CHANGED",
                      "The target zone grouping changed"
                    );
                  }
                },
                () => {
                  issued = true;
                }
              );
              if (!issued) {
                throw new SongActionPhaseError(
                  "PRE_ISSUE_FAILED",
                  "The song action was not sent"
                );
              }
            } catch (error) {
              if (error instanceof SongActionResolutionError) {
                navigationDepth = error.navigationDepth;
              }
              primaryError = error;
            }

            const retained = await restoreTracksPage({
              coordinator,
              access,
              session,
              authorityGeneration: binding.authorityGeneration,
              navigationDepth,
              zoneId: request.zoneId,
            });
            if (primaryError instanceof Error) throw primaryError;
            if (primaryError !== undefined) {
              throw new SongActionPhaseError(
                "PRE_ISSUE_FAILED",
                "The song action failed before it could be sent"
              );
            }
            return !retained;
          }
        );

        ack({
          success: true,
          data: {
            requestId: request.requestId,
            session: request.session,
            resultId: request.resultId,
            semantic: request.semantic,
            outcome: "executed",
            authorityRetired,
          },
        });
      } catch (error) {
        if (issued) {
          try {
            coordinator.retireClassicPublishedItems(
              access,
              "classic-search",
              binding.authorityGeneration
            );
          } catch {
            // A lost mode generation has already retired its authority.
          }
          ack(
            actionFailure(
              "OUTCOME_UNKNOWN",
              "Roon received the song action, but its outcome could not be confirmed"
            )
          );
        } else {
          const code = actionErrorCode(error);
          logger.error(
            { err: error, code },
            "Unified song action failed before native issue"
          );
          ack(
            actionFailure(
              code,
              error instanceof Error
                ? error.message
                : "The song action could not be sent"
            )
          );
        }
      } finally {
        actionResultsInFlight.delete(request.resultId);
      }
    }
  );

  socket.on(
    "unified-search:clear",
    (value: unknown, ack?: ClearAck): void => {
      const request = normalizeUnifiedSearchClearRequest(value);
      if (!request || !ack) {
        ack?.(
          clearFailure("INVALID_REQUEST", "Invalid search close request")
        );
        return;
      }
      const coreId = getCoreId();
      if (!coreId) {
        ack(clearFailure("CORE_UNAVAILABLE", "Roon Core is unavailable"));
        return;
      }
      const access = modeAccess(coreId, socket.id, request);
      try {
        coordinator.clearClassicPublishedItems(access, "classic-search");
        ack({
          success: true,
          data: {
            requestId: request.requestId,
            session: request.session,
          },
        });
      } catch (error) {
        const code = searchErrorCode(error);
        ack(
          clearFailure(
            code,
            error instanceof Error ? error.message : "Search close failed"
          )
        );
      }
    }
  );
}
