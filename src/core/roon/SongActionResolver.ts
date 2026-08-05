import {
  type UnifiedSongActionSemantic,
} from "../../shared/unifiedSearchContracts";
import { type BrowseItem, type BrowseResult } from "../../shared/types";
import {
  type CoordinatedBrowseSession,
} from "./BrowseSessionCoordinator";

const SONG_ACTION_MAX_ROWS = 32;
const SONG_ACTION_MAX_DEPTH = 4;

const SEMANTIC_LABELS: Readonly<
  Record<UnifiedSongActionSemantic, string>
> = Object.freeze({
  "play-now": "Play Now",
  "add-next": "Add Next",
  queue: "Queue",
});

export class SongActionResolutionError extends Error {
  public constructor(
    message: string,
    /**
     * Successful action-list descents that must be popped to restore Tracks.
     * `null` means a failed Roon call made the navigation depth unprovable.
     */
    public readonly navigationDepth: number | null,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "SongActionResolutionError";
    Object.setPrototypeOf(this, SongActionResolutionError.prototype);
  }
}

export interface ResolvedSongAction {
  /** Ephemeral Roon authority; it never leaves the server operation. */
  readonly itemKey: string;
  readonly navigationDepth: number;
}

export interface SongActionResolverPort {
  resolve(
    session: CoordinatedBrowseSession,
    song: Readonly<BrowseItem & { itemKey: string }>,
    zoneId: string,
    semantic: UnifiedSongActionSemantic
  ): Promise<ResolvedSongAction>;
}

/**
 * Resolve one named song action from the retained Tracks-page row.
 *
 * The walk is deliberately narrow: only one `action_list` row may continue
 * the path, and only one exact named `action` leaf may finish it.
 */
export class SongActionResolver implements SongActionResolverPort {
  public async resolve(
    session: CoordinatedBrowseSession,
    song: Readonly<BrowseItem & { itemKey: string }>,
    zoneId: string,
    semantic: UnifiedSongActionSemantic
  ): Promise<ResolvedSongAction> {
    if (
      song.hint !== "action_list" ||
      song.isPlayable ||
      typeof song.itemKey !== "string" ||
      song.itemKey.length === 0
    ) {
      throw new SongActionResolutionError(
        "The retained song does not expose an action list",
        0
      );
    }

    const label = SEMANTIC_LABELS[semantic];
    let cursor: BrowseItem & { itemKey: string } = { ...song };
    let navigationDepth = 0;

    for (let depth = 0; depth < SONG_ACTION_MAX_DEPTH; depth += 1) {
      let result: BrowseResult;
      try {
        result = await session.browse({
          hierarchy: "search",
          zoneId,
          itemKey: cursor.itemKey,
          pageSize: SONG_ACTION_MAX_ROWS + 1,
        });
      } catch (error) {
        throw new SongActionResolutionError(
          "The song action path could not be loaded",
          null,
          error
        );
      }
      navigationDepth += 1;
      this.assertComplete(result, navigationDepth);

      const matching = result.items.filter(
        (item) => item.hint === "action" && item.title === label
      );
      if (matching.length > 0) {
        const leaf = matching[0];
        if (
          matching.length !== 1 ||
          leaf.isPlayable !== true ||
          typeof leaf.itemKey !== "string" ||
          leaf.itemKey.length === 0
        ) {
          throw new SongActionResolutionError(
            `Roon did not expose one exact ${label} action`,
            navigationDepth
          );
        }
        return Object.freeze({
          itemKey: leaf.itemKey,
          navigationDepth,
        });
      }

      const nested = result.items.filter(
        (item): item is BrowseItem & { itemKey: string } =>
          item.hint === "action_list" &&
          item.isPlayable !== true &&
          typeof item.itemKey === "string" &&
          item.itemKey.length > 0
      );
      if (nested.length !== 1) {
        throw new SongActionResolutionError(
          `Roon did not expose a unique path to ${label}`,
          navigationDepth
        );
      }
      cursor = nested[0];
    }

    throw new SongActionResolutionError(
      "The song action path exceeded its depth bound",
      navigationDepth
    );
  }

  private assertComplete(
    result: BrowseResult,
    navigationDepth: number
  ): void {
    const total = result.totalCount ?? result.count;
    if (
      result.offset !== 0 ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total > SONG_ACTION_MAX_ROWS ||
      result.items.length !== total
    ) {
      throw new SongActionResolutionError(
        "Roon returned an incomplete or oversized song action list",
        navigationDepth
      );
    }
  }
}
