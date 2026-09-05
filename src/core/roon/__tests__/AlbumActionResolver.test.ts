import {
  AlbumActionResolutionError,
  AlbumActionResolver,
  createAlbumVersionDetailDigest,
} from "../AlbumActionResolver";
import { CoordinatedBrowseSession } from "../BrowseSessionCoordinator";
import {
  CollectionDrillResolution,
  CollectionDrillResolver,
} from "../CollectionDrillResolver";
import { COLLECTION_DRILL_SOURCE_CONTRACT } from "../../../shared/collectionDrillContracts";
import { BrowseItem, BrowseResult } from "../../../shared/types";

function item(
  title: string,
  itemKey: string,
  patch: Partial<BrowseItem> = {}
): BrowseItem {
  return {
    title,
    itemKey,
    hint: "list",
    isLoadable: true,
    isPlayable: false,
    ...patch,
  };
}

function result(
  items: BrowseItem[],
  patch: Partial<BrowseResult> = {}
): BrowseResult {
  return {
    level: 0,
    offset: 0,
    count: items.length,
    totalCount: items.length,
    items,
    ...patch,
  };
}

function actionLeaves(): BrowseResult {
  return result(
    [
      item("Play Now", "play-now", {
        hint: "action",
        isLoadable: false,
        isPlayable: true,
      }),
      item("Add Next", "add-next", {
        hint: "action",
        isLoadable: false,
        isPlayable: true,
      }),
      item("Queue", "queue", {
        hint: "action",
        isLoadable: false,
        isPlayable: true,
      }),
    ],
    { level: 3 }
  );
}

class ScriptedSession implements CoordinatedBrowseSession {
  public readonly calls: Array<{
    method: "browse" | "load" | "pop";
    options: Record<string, unknown>;
  }> = [];
  public readonly sessionScope = "scripted-session";

  public constructor(private readonly script: BrowseResult[]) {}

  public browse(options: Parameters<CoordinatedBrowseSession["browse"]>[0]) {
    return this.next("browse", options);
  }

  public load(options: Parameters<CoordinatedBrowseSession["load"]>[0]) {
    return this.next("load", options);
  }

  public pop(options: Parameters<CoordinatedBrowseSession["pop"]>[0]) {
    return this.next("pop", options);
  }

  private next(
    method: "browse" | "load" | "pop",
    options: Record<string, unknown>
  ): Promise<BrowseResult> {
    this.calls.push({ method, options });
    const next = this.script.shift();
    if (!next) return Promise.reject(new Error(`Unexpected ${method} call`));
    return Promise.resolve(next);
  }
}

describe("AlbumActionResolver", () => {
  // `.agents/plans/library-live-view.md` Slice 2. The live path has no album to
  // find: the reader clicked a row Roon rendered, so the reference IS the
  // subject and the only work left is asking Roon what can be done with it.
  describe("a live library reference", () => {
    it("browses the reference's own key with the zone bound and returns its leaves", async () => {
      const session = new ScriptedSession([actionLeaves()]);

      const resolved = await new AlbumActionResolver().resolveReference(
        session,
        {
          itemKey: "live-play-album-key",
          hierarchy: "albums",
          title: "Play Album",
        },
        "zone-7"
      );

      expect(resolved.actions.map((action) => action.label)).toEqual([
        "Play Now",
        "Add Next",
        "Queue",
      ]);
      // One call, on the reference's own key, on the reference's own
      // hierarchy, carrying the zone — which is the only reason Roon renders
      // playback leaves at all.
      expect(session.calls).toHaveLength(1);
      expect(session.calls[0].options).toMatchObject({
        itemKey: "live-play-album-key",
        hierarchy: "albums",
        zoneId: "zone-7",
      });
      // Nothing was searched for, matched or fingerprinted along the way.
      expect(resolved.actions.every((action) => action.hierarchy === "albums")).toBe(
        true
      );
    });

    it("descends one nested action list before binding, still zone-bound", async () => {
      const session = new ScriptedSession([
        result([item("More", "nested-list", { hint: "action_list" })], {
          level: 2,
        }),
        actionLeaves(),
      ]);

      const resolved = await new AlbumActionResolver().resolveReference(
        session,
        { itemKey: "live-track-key", hierarchy: "artists", title: "Tideline" },
        "zone-7"
      );

      expect(resolved.actions).toHaveLength(3);
      expect(session.calls.map((call) => call.options.itemKey)).toEqual([
        "live-track-key",
        "nested-list",
      ]);
      for (const call of session.calls) {
        expect(call.options.zoneId).toBe("zone-7");
        expect(call.options.hierarchy).toBe("artists");
      }
    });

    it("refuses an ambiguous continuation rather than picking one", async () => {
      const session = new ScriptedSession([
        result(
          [
            item("More", "nested-a", { hint: "action_list" }),
            item("Other", "nested-b", { hint: "action_list" }),
          ],
          { level: 2 }
        ),
      ]);

      await expect(
        new AlbumActionResolver().resolveReference(
          session,
          { itemKey: "live-key", hierarchy: "albums", title: "Play Album" },
          "zone-7"
        )
      ).rejects.toMatchObject({ code: "ACTION_PATH_NOT_FOUND" });
    });
  });

  describe("a page opened from a collection drill", () => {
    const COLLECTION_LOCATOR = {
      sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
      hierarchy: "genres" as const,
      collectionExactName: "Bright Machinery",
      rendering: {
        exactTitle: "Harbour Lantern",
        exactCredit: "The Paper Fleet",
      },
    };

    function collectionResolver(
      resolution: CollectionDrillResolution = {
        kind: "resolved",
        hierarchy: "genres",
        itemKey: "live-row-key",
        rendering: COLLECTION_LOCATOR.rendering,
      }
    ): AlbumActionResolver {
      return new AlbumActionResolver({
        resolve: () => Promise.resolve(resolution),
      } as unknown as CollectionDrillResolver);
    }

    function collectionDetail(
      trackTitles: string[],
      includePlayAlbum = true
    ): BrowseResult {
      const tracks = trackTitles.map((title, index) =>
        item(title, `track-${index}`, {
          subtitle: "The Paper Fleet",
          hint: "action_list",
          itemType: "track",
        })
      );
      return result(
        includePlayAlbum
          ? [...tracks, item("Play Album", "play-album", { hint: "action_list" })]
          : tracks,
        { title: "Harbour Lantern", subtitle: "The Paper Fleet", level: 2 }
      );
    }

    function digestOf(trackTitles: readonly string[]): string {
      return createAlbumVersionDetailDigest(
        "Harbour Lantern",
        "The Paper Fleet",
        trackTitles
      );
    }

    const TRACKS = ["1. Tideline", "2. Cable Run"];
    const DIGEST = digestOf(TRACKS);

    it("reads its actions in the hierarchy its key came from, never in artists", async () => {
      const session = new ScriptedSession([
        collectionDetail(TRACKS),
        actionLeaves(),
      ]);

      const resolved = await collectionResolver().resolveCollectionVersion(
        session,
        { locator: COLLECTION_LOCATOR, detailDigest: DIGEST },
        "zone-1"
      );

      expect(resolved.actions.map((action) => action.hierarchy)).toEqual([
        "genres",
        "genres",
        "genres",
      ]);
      // Roon's keys mean nothing outside the hierarchy that issued them, so
      // every browse on this path names the drill's own hierarchy.
      for (const call of session.calls) {
        expect(call.options.hierarchy).toBe("genres");
      }
    });

    it("refuses when the album's track list moved under the page", async () => {
      const session = new ScriptedSession([
        collectionDetail(["1. Tideline", "2. A Different Song"]),
      ]);

      await expect(
        collectionResolver().resolveCollectionVersion(
          session,
          { locator: COLLECTION_LOCATOR, detailDigest: DIGEST },
          "zone-1"
        )
      ).rejects.toMatchObject({ code: "ALBUM_CHANGED" });
    });

    it.each([
      ["missing", "ALBUM_NOT_FOUND"],
      ["ambiguous", "ALBUM_AMBIGUOUS"],
    ] as const)(
      "reports a %s locator as %s rather than acting on a guess",
      async (kind, code) => {
        const session = new ScriptedSession([]);

        await expect(
          collectionResolver({
            kind,
            stage: "entry",
            matchCount: kind === "missing" ? 0 : 2,
          }).resolveCollectionVersion(
            session,
            { locator: COLLECTION_LOCATOR, detailDigest: DIGEST },
            "zone-1"
          )
        ).rejects.toMatchObject({ code });
        expect(session.calls).toEqual([]);
      }
    );

    it("resolves a track selector against the verified live track row", async () => {
      const session = new ScriptedSession([
        collectionDetail(TRACKS),
        actionLeaves(),
      ]);

      const resolved = await collectionResolver().resolveCollectionVersion(
        session,
        { locator: COLLECTION_LOCATOR, detailDigest: DIGEST },
        "zone-1",
        { index: 1, title: "2. Cable Run" }
      );

      expect(resolved.actions).toHaveLength(3);
      // The action path descends from the selected track, never Play Album.
      expect(session.calls[1].options.itemKey).toBe("track-1");
    });

    it("rejects a track index beyond the live track list", async () => {
      const session = new ScriptedSession([collectionDetail(TRACKS)]);

      await expect(
        collectionResolver().resolveCollectionVersion(
          session,
          { locator: COLLECTION_LOCATOR, detailDigest: DIGEST },
          "zone-1",
          { index: 2, title: "3. Third" }
        )
      ).rejects.toMatchObject({ code: "TRACK_NOT_FOUND" });
    });

    it("rejects a track whose live title drifted from the selector", async () => {
      const session = new ScriptedSession([collectionDetail(TRACKS)]);

      await expect(
        collectionResolver().resolveCollectionVersion(
          session,
          { locator: COLLECTION_LOCATOR, detailDigest: DIGEST },
          "zone-1",
          { index: 1, title: "2. Renamed" }
        )
      ).rejects.toMatchObject({ code: "TRACK_MISMATCH" });
    });

    it("rejects a mixed typed and untyped track set instead of hashing a subset", async () => {
      const mixedDetail = result(
        [
          item("1. Tideline", "track-0", {
            subtitle: "The Paper Fleet",
            hint: "action_list",
            itemType: "track",
          }),
          item("2. Cable Run", "track-1", {
            subtitle: "The Paper Fleet",
            hint: "action_list",
            itemType: "track",
          }),
          item("3. Bonus", "track-2", {
            subtitle: "The Paper Fleet",
            hint: "action_list",
          }),
          item("Play Album", "play-album", { hint: "action_list" }),
        ],
        { title: "Harbour Lantern", subtitle: "The Paper Fleet", level: 2 }
      );
      const session = new ScriptedSession([mixedDetail]);

      await expect(
        collectionResolver().resolveCollectionVersion(
          session,
          { locator: COLLECTION_LOCATOR, detailDigest: DIGEST },
          "zone-1"
        )
      ).rejects.toMatchObject({ code: "ALBUM_AMBIGUOUS" });
    });

    it("rejects an incomplete detail list before using any of its row keys", async () => {
      const complete = collectionDetail(TRACKS);
      const session = new ScriptedSession([
        { ...complete, count: 9, totalCount: 9 },
      ]);

      await expect(
        collectionResolver().resolveCollectionVersion(
          session,
          { locator: COLLECTION_LOCATOR, detailDigest: DIGEST },
          "zone-1"
        )
      ).rejects.toBeInstanceOf(AlbumActionResolutionError);
      // Only the detail read happened: no track or Play Album key was used.
      expect(session.calls).toHaveLength(1);
    });

    it("rejects a digest-matched detail without one exact Play Album path", async () => {
      const session = new ScriptedSession([collectionDetail(TRACKS, false)]);

      await expect(
        collectionResolver().resolveCollectionVersion(
          session,
          { locator: COLLECTION_LOCATOR, detailDigest: DIGEST },
          "zone-1"
        )
      ).rejects.toMatchObject({ code: "ACTION_PATH_NOT_FOUND" });
    });

    it("keeps the 500-track bound independent from bounded detail action rows", async () => {
      const titles = Array.from(
        { length: 500 },
        (_, index) => `${index + 1}. Track ${index + 1}`
      );
      const session = new ScriptedSession([
        collectionDetail(titles),
        actionLeaves(),
      ]);

      await expect(
        collectionResolver().resolveCollectionVersion(
          session,
          { locator: COLLECTION_LOCATOR, detailDigest: digestOf(titles) },
          "zone-1"
        )
      ).resolves.toMatchObject({ actions: expect.any(Array) });
      expect(session.calls[0].options.pageSize).toBeGreaterThan(500);
    });
  });
});
