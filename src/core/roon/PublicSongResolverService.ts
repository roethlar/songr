import type {
  PublicSongActionErrorCode,
  PublicSongCandidate,
  PublicSongResolution,
  PublicSongUnavailableCode,
} from "../../shared/publicSongResolverContracts";
import { PUBLIC_SONG_UNAVAILABLE_MESSAGES } from "../../shared/publicSongResolverContracts";
import { normalizeCatalogText } from "../../shared/timelineCatalogContracts";
import {
  UNIFIED_SONG_SEARCH_RESULT_MAX,
  UnifiedSongActionSemantic,
} from "../../shared/unifiedSearchContracts";
import type { BrowseItem, Zone } from "../../shared/types";
import type { BrowseService } from "./BrowseService";
import {
  BrowseSessionCoordinator,
  BrowseSessionCoordinatorError,
  ClassicPublishedItemBinding,
  CoordinatedModeActionSession,
  ModeSessionAccess,
} from "./BrowseSessionCoordinator";
import {
  PublicSongSelection,
  PublicSongSelectionIssue,
  PublicSongSelectionRegistry,
  PublicSongSelectionRegistryError,
} from "./PublicSongSelectionRegistry";
import {
  SongActionResolutionError,
  SongActionResolver,
  SongActionResolverPort,
} from "./SongActionResolver";

export type PublicSongSourceVerification =
  | { state: "current" }
  | { state: "changed" }
  | { state: "unavailable" };

export interface PublicSongSourceVerifier {
  verify(
    selection: Readonly<PublicSongSelection>
  ): Promise<PublicSongSourceVerification>;
}

export interface PublicSongResolverZonePort {
  getZone(zoneId: string): Zone | undefined;
}

export interface PublicSongResolverServiceOptions {
  coordinator: BrowseSessionCoordinator;
  browseService: Pick<BrowseService, "searchTracksCoordinated">;
  selectionRegistry: PublicSongSelectionRegistry;
  sourceVerifier: PublicSongSourceVerifier;
  zones: PublicSongResolverZonePort;
  songActionResolver?: SongActionResolverPort;
}

export interface PublicSongResolveInput {
  access: ModeSessionAccess;
  selectionId: string;
}

export interface PublicSongExecuteInput extends PublicSongResolveInput {
  candidateId: string;
  zoneId: string;
  semantic: UnifiedSongActionSemantic;
}

export interface PublicSongExecuteResult {
  authorityRetired: true;
}

export class PublicSongResolverError extends Error {
  public constructor(
    public readonly code: PublicSongActionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PublicSongResolverError";
    Object.setPrototypeOf(this, PublicSongResolverError.prototype);
    Error.captureStackTrace?.(this, PublicSongResolverError);
  }
}

function unavailable(code: PublicSongUnavailableCode): PublicSongResolution {
  return {
    kind: "unavailable",
    reason: {
      code,
      message: PUBLIC_SONG_UNAVAILABLE_MESSAGES[code],
    },
  };
}

function sourceArtistIsSpecific(artist: string): boolean {
  const normalized = normalizeCatalogText(artist);
  return (
    normalized.length > 0 &&
    normalized !== "various artists" &&
    normalized !== "various performers" &&
    normalized !== "various" &&
    normalized !== "unknown artist" &&
    normalized !== "unknown artists" &&
    normalized !== "[unknown artist]"
  );
}

function subtitleLabels(value: string): string[] {
  return value
    .split(/[,;]/u)
    .map((label) => normalizeCatalogText(label))
    .filter((label) => label.length > 0);
}

export function publicSongCandidateMatchesSelection(
  item: Pick<BrowseItem, "title" | "subtitle">,
  selection: Pick<PublicSongSelection, "title" | "artist">
): boolean {
  if (
    normalizeCatalogText(item.title) !== normalizeCatalogText(selection.title)
  ) {
    return false;
  }
  if (!sourceArtistIsSpecific(selection.artist)) return true;
  return subtitleLabels(item.subtitle ?? "").includes(
    normalizeCatalogText(selection.artist)
  );
}

function candidate(token: string, item: BrowseItem): PublicSongCandidate {
  return {
    candidateId: token,
    title: item.title,
    subtitle: item.subtitle ?? "",
    imageKey: item.imageKey ?? null,
  };
}

function completeSearchPage(
  result: Awaited<ReturnType<BrowseService["searchTracksCoordinated"]>>
): boolean {
  const total = result.page.totalCount;
  return (
    Number.isSafeInteger(total) &&
    (total as number) >= 0 &&
    (total as number) <= UNIFIED_SONG_SEARCH_RESULT_MAX &&
    result.page.offset === 0 &&
    result.page.items.length === total &&
    result.songs.length === total
  );
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

function registryError(error: PublicSongSelectionRegistryError): PublicSongResolverError {
  if (error.code === "IN_FLIGHT" || error.code === "BACKPRESSURE") {
    return new PublicSongResolverError(error.code, error.message);
  }
  return new PublicSongResolverError("STALE_SELECTION", error.message);
}

function coordinatorError(
  error: BrowseSessionCoordinatorError
): PublicSongResolverError {
  if (
    error.code === "BACKPRESSURE" ||
    error.code === "OWNER_MISMATCH" ||
    error.code === "SESSION_LOST"
  ) {
    return new PublicSongResolverError(error.code, error.message);
  }
  return new PublicSongResolverError("STALE_CANDIDATE", error.message);
}

/**
 * On-demand bridge from a displayed native/public row to Roon's own public
 * Tracks authority. The class owns no socket state: its caller supplies the
 * current Classic mode access, while the coordinator isolates resolver
 * generations from Unified palette generations.
 */
export class PublicSongResolverService {
  private readonly coordinator: BrowseSessionCoordinator;
  private readonly browseService: Pick<
    BrowseService,
    "searchTracksCoordinated"
  >;
  private readonly selectionRegistry: PublicSongSelectionRegistry;
  private readonly sourceVerifier: PublicSongSourceVerifier;
  private readonly zones: PublicSongResolverZonePort;
  private readonly songActionResolver: SongActionResolverPort;

  public constructor(options: PublicSongResolverServiceOptions) {
    this.coordinator = options.coordinator;
    this.browseService = options.browseService;
    this.selectionRegistry = options.selectionRegistry;
    this.sourceVerifier = options.sourceVerifier;
    this.zones = options.zones;
    this.songActionResolver =
      options.songActionResolver ?? new SongActionResolver();
  }

  public async resolve(
    input: PublicSongResolveInput
  ): Promise<PublicSongResolution> {
    let selection: Readonly<PublicSongSelection>;
    try {
      selection = this.selectionRegistry.resolve(
        input.selectionId,
        input.access.coreId
      );
    } catch (error) {
      if (error instanceof PublicSongSelectionRegistryError) {
        throw registryError(error);
      }
      throw error;
    }

    const authorityGeneration = this.coordinator.beginClassicPublishedItems(
      input.access,
      "classic-search"
    );
    const verification = await this.sourceVerifier.verify(selection);
    if (verification.state !== "current") {
      try {
        this.selectionRegistry.invalidate(
          input.selectionId,
          input.access.coreId
        );
      } catch (error) {
        if (error instanceof PublicSongSelectionRegistryError) {
          throw registryError(error);
        }
        throw error;
      }
      return unavailable(
        verification.state === "changed"
          ? "source-changed"
          : "source-unavailable"
      );
    }

    try {
      return await this.coordinator.runMode(
        input.access,
        "classic-search",
        async (session) => {
          const search = await this.browseService.searchTracksCoordinated(
            session,
            {
              input: selection.title,
              popAll: true,
            }
          );
          if (!completeSearchPage(search)) {
            return unavailable("search-incomplete");
          }
          const published = this.coordinator.replaceClassicPublishedItems(
            input.access,
            "classic-search",
            authorityGeneration,
            search.songs,
            search.page
          );
          const matches = published.filter(({ item }) =>
            publicSongCandidateMatchesSelection(item, selection)
          );
          if (matches.length === 0) {
            this.coordinator.retireClassicPublishedItems(
              input.access,
              "classic-search",
              authorityGeneration
            );
            return unavailable("no-exact-match");
          }
          const candidates = matches.map(({ token, item }) =>
            candidate(token, item)
          );
          return candidates.length === 1 &&
            sourceArtistIsSpecific(selection.artist)
            ? { kind: "authorized", candidate: candidates[0] }
            : { kind: "choice-required", candidates };
        }
      );
    } catch (error) {
      if (error instanceof BrowseSessionCoordinatorError) throw error;
      return unavailable("public-api-unavailable");
    }
  }

  public async execute(
    input: PublicSongExecuteInput
  ): Promise<PublicSongExecuteResult> {
    let selection: Readonly<PublicSongSelection>;
    let binding: ClassicPublishedItemBinding;
    try {
      selection = this.selectionRegistry.resolve(
        input.selectionId,
        input.access.coreId
      );
      binding = this.coordinator.resolveClassicPublishedItemBinding(
        input.access,
        "classic-search",
        input.candidateId
      );
    } catch (error) {
      throw this.normalizeActionError(error);
    }
    if (!publicSongCandidateMatchesSelection(binding.item, selection)) {
      throw new PublicSongResolverError(
        "STALE_CANDIDATE",
        "the retained public song does not match this track selection"
      );
    }
    const initialZone = this.zones.getZone(input.zoneId);
    const initialTopology = initialZone
      ? zoneTopologyFingerprint(initialZone, input.zoneId)
      : null;
    if (!initialTopology) {
      throw new PublicSongResolverError(
        "ZONE_UNAVAILABLE",
        "the target zone is unavailable"
      );
    }

    let issue: PublicSongSelectionIssue;
    try {
      issue = this.selectionRegistry.beginIssue(
        input.selectionId,
        input.access.coreId
      );
    } catch (error) {
      throw this.normalizeActionError(error);
    }
    let issued = false;
    let sourceRetired = false;
    try {
      await this.coordinator.runModeAction(
        input.access,
        "classic-search",
        async (session) => {
          const currentBinding =
            this.coordinator.resolveClassicPublishedItemBinding(
              input.access,
              "classic-search",
              input.candidateId
            );
          if (!sameBinding(binding, currentBinding)) {
            throw new PublicSongResolverError(
              "STALE_CANDIDATE",
              "the public song candidate was replaced"
            );
          }
          const verification = await this.sourceVerifier.verify(selection);
          if (verification.state !== "current") {
            this.selectionRegistry.retire(issue);
            sourceRetired = true;
            throw new PublicSongResolverError(
              "SOURCE_CHANGED",
              verification.state === "changed"
                ? PUBLIC_SONG_UNAVAILABLE_MESSAGES["source-changed"]
                : PUBLIC_SONG_UNAVAILABLE_MESSAGES["source-unavailable"]
            );
          }

          let navigationDepth: number | null = 0;
          let primaryError: unknown;
          try {
            const resolved = await this.songActionResolver.resolve(
              session,
              binding.item,
              input.zoneId,
              input.semantic
            );
            navigationDepth = resolved.navigationDepth;
            await session.executeAction(
              {
                hierarchy: "search",
                zoneId: input.zoneId,
                itemKey: resolved.itemKey,
              },
              () => {
                const exactSelection =
                  this.selectionRegistry.assertIssue(issue);
                if (exactSelection !== selection) {
                  throw new PublicSongResolverError(
                    "STALE_SELECTION",
                    "the track selection changed before execution"
                  );
                }
                const exactBinding =
                  this.coordinator.resolveClassicPublishedItemBinding(
                    input.access,
                    "classic-search",
                    input.candidateId
                  );
                if (!sameBinding(binding, exactBinding)) {
                  throw new PublicSongResolverError(
                    "STALE_CANDIDATE",
                    "the public song candidate changed before execution"
                  );
                }
                const currentZone = this.zones.getZone(input.zoneId);
                if (!currentZone) {
                  throw new PublicSongResolverError(
                    "ZONE_UNAVAILABLE",
                    "the target zone disappeared"
                  );
                }
                if (
                  zoneTopologyFingerprint(currentZone, input.zoneId) !==
                  initialTopology
                ) {
                  throw new PublicSongResolverError(
                    "ZONE_CHANGED",
                    "the target zone grouping changed"
                  );
                }
              },
              () => {
                issued = true;
              }
            );
            if (!issued) {
              throw new PublicSongResolverError(
                "PRE_ISSUE_FAILED",
                "the song action was not sent"
              );
            }
          } catch (error) {
            if (error instanceof SongActionResolutionError) {
              navigationDepth = error.navigationDepth;
            }
            primaryError = error;
          }

          const retained = await this.restoreTracksPage({
            access: input.access,
            session,
            authorityGeneration: binding.authorityGeneration,
            navigationDepth,
            zoneId: input.zoneId,
          });
          if (primaryError instanceof Error) throw primaryError;
          if (primaryError !== undefined) {
            throw new PublicSongResolverError(
              "PRE_ISSUE_FAILED",
              "the song action failed before it could be sent"
            );
          }
          return !retained;
        }
      );
      this.selectionRegistry.retire(issue);
      return { authorityRetired: true };
    } catch (error) {
      if (issued) {
        try {
          this.selectionRegistry.retire(issue);
        } catch {
          // A concurrent Core reset or terminal source check already retired it.
        }
        try {
          this.coordinator.retireClassicPublishedItems(
            input.access,
            "classic-search",
            binding.authorityGeneration
          );
        } catch {
          // A lost mode generation has already retired its authority.
        }
        throw new PublicSongResolverError(
          "OUTCOME_UNKNOWN",
          "Roon received the song action, but its outcome could not be confirmed"
        );
      }
      if (!sourceRetired) {
        try {
          this.selectionRegistry.restore(issue);
        } catch {
          // If the issue itself is no longer current, fail closed as stale.
        }
      }
      throw this.normalizeActionError(error);
    }
  }

  private async restoreTracksPage(input: {
    access: ModeSessionAccess;
    session: CoordinatedModeActionSession;
    authorityGeneration: number;
    navigationDepth: number | null;
    zoneId: string;
  }): Promise<boolean> {
    if (input.navigationDepth === 0) return true;
    if (input.navigationDepth === null) {
      try {
        this.coordinator.retireClassicPublishedItems(
          input.access,
          "classic-search",
          input.authorityGeneration
        );
      } catch {
        // Session loss already retires the owning authority.
      }
      return false;
    }
    try {
      const restored = await input.session.pop({
        hierarchy: "search",
        zoneId: input.zoneId,
        levels: input.navigationDepth,
        pageSize: UNIFIED_SONG_SEARCH_RESULT_MAX,
      });
      return this.coordinator.retainClassicPublishedItemsAfterRestore(
        input.access,
        "classic-search",
        input.authorityGeneration,
        restored
      );
    } catch {
      try {
        this.coordinator.retireClassicPublishedItems(
          input.access,
          "classic-search",
          input.authorityGeneration
        );
      } catch {
        // Session loss already retires the owning authority.
      }
      return false;
    }
  }

  private normalizeActionError(error: unknown): PublicSongResolverError {
    if (error instanceof PublicSongResolverError) return error;
    if (error instanceof PublicSongSelectionRegistryError) {
      return registryError(error);
    }
    if (error instanceof SongActionResolutionError) {
      return error.cause
        ? this.normalizeActionError(error.cause)
        : new PublicSongResolverError("ACTION_UNAVAILABLE", error.message);
    }
    if (error instanceof BrowseSessionCoordinatorError) {
      return coordinatorError(error);
    }
    return new PublicSongResolverError(
      "PRE_ISSUE_FAILED",
      error instanceof Error
        ? error.message
        : "the song action failed before it could be sent"
    );
  }
}
