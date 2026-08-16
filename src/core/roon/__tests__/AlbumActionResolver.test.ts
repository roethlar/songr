import {
  CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
  createCatalogTrackTitleFingerprint,
} from "../../catalog/CatalogReconciliation";
import {
  AlbumActionResolutionError,
  AlbumActionResolver,
  createAlbumVersionDetailDigest,
} from "../AlbumActionResolver";
import { CoordinatedBrowseSession } from "../BrowseSessionCoordinator";
import { DiscographyResolver, ObservedDiscography } from "../DiscographyResolver";
import { AlbumRef, ArtistRef } from "../../../shared/catalogContracts";
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

function detail(trackTitles: string[], includePlayAlbum = true): BrowseResult {
  const tracks = trackTitles.map((title, index) =>
    item(title, `track-${index}`, {
      subtitle: "Artist",
      hint: "action_list",
      itemType: "track",
    })
  );
  return result(
    includePlayAlbum
      ? [
          ...tracks,
          item("Play Album", "play-album", { hint: "action_list" }),
        ]
      : tracks,
    { title: "Album", subtitle: "Artist", level: 2 }
  );
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

function album(trackTitles = ["1. First", "2. Second"]): AlbumRef {
  return {
    localId: "018f0f64-3f31-7a9b-8c2d-8f572cb18a12",
    coreId: "core-1",
    artistLocalId: "018f0f64-3f31-7a9b-8c2d-8f572cb18a13",
    exactTitle: "Album",
    exactArtist: "Artist",
    normalizedTitle: "album",
    normalizedArtist: "artist",
    editionText: "",
    trackTitleFingerprint: createCatalogTrackTitleFingerprint(trackTitles),
    firstSeenAt: "2026-07-14T00:00:00.000Z",
    lastSeenAt: "2026-07-14T00:00:00.000Z",
    resolutionStatus: "resolved",
  };
}

function artist(): ArtistRef {
  return {
    localId: "018f0f64-3f31-7a9b-8c2d-8f572cb18a13",
    coreId: "core-1",
    exactName: "Artist",
    normalizedName: "artist",
    firstSeenAt: "2026-07-14T00:00:00.000Z",
    lastSeenAt: "2026-07-14T00:00:00.000Z",
    resolutionStatus: "resolved",
  };
}

function observed(itemKeys = ["row-a", "row-b"]): ObservedDiscography {
  return {
    observation: {
      sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
      artist: { exactName: "Artist", candidateCount: 1 },
      discographyComplete: true,
      albums: itemKeys.map(() => ({
        exactTitle: "Album",
        exactArtist: "Artist",
        editionText: "",
      })),
    },
    liveAlbums: itemKeys.map((itemKey, observationIndex) => ({
      itemKey,
      observationIndex,
    })),
  };
}

class ScriptedSession implements CoordinatedBrowseSession {
  public readonly calls: Array<{
    method: "browse" | "load" | "pop";
    options: Record<string, unknown>;
  }> = [];

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
  const resolver = new AlbumActionResolver();

  function retainedResolver(discography = observed()): AlbumActionResolver {
    return new AlbumActionResolver({
      resolve: () =>
        Promise.resolve({ kind: "resolved", observation: discography.observation }),
      observeCurrent: () => Promise.resolve(discography),
    } as unknown as DiscographyResolver);
  }

  function retainedSource(
    tracks = ["1. First", "2. Second"],
    versionCount = 2
  ) {
    return {
      album: album(tracks),
      artist: artist(),
      detailDigest: createAlbumVersionDetailDigest("Album", "Artist", tracks),
      versionCount,
    };
  }

  it("matches the selected digest across session-local row keys and resolves its album actions", async () => {
    const session = new ScriptedSession([
      detail(["Different"]),
      result([]),
      detail(["1. First", "2. Second"]),
      result([]),
      detail(["1. First", "2. Second"]),
      actionLeaves(),
    ]);

    await expect(
      retainedResolver().resolveSelectedVersion(
        session,
        retainedSource(),
        "zone-1"
      )
    ).resolves.toEqual({
      actions: [
        { label: "Play Now", semantic: "play-now", itemKey: "play-now" },
        { label: "Add Next", semantic: "add-next", itemKey: "add-next" },
        { label: "Queue", semantic: "queue", itemKey: "queue" },
      ],
    });
    expect(session.calls.map((call) => call.method)).toEqual([
      "browse",
      "pop",
      "browse",
      "pop",
      "browse",
      "browse",
    ]);
    expect(session.calls[0]).toMatchObject({
      method: "browse",
      options: { hierarchy: "artists", itemKey: "row-a", zoneId: "zone-1" },
    });
    expect(session.calls[2]).toMatchObject({
      method: "browse",
      options: { hierarchy: "artists", itemKey: "row-b", zoneId: "zone-1" },
    });
    expect(session.calls[4]).toMatchObject({
      method: "browse",
      options: { hierarchy: "artists", itemKey: "row-b", zoneId: "zone-1" },
    });
    expect(session.calls[5]).toMatchObject({
      options: { hierarchy: "artists", itemKey: "play-album", zoneId: "zone-1" },
    });
  });

  it("binds a track action to the exact index and title on the digest-matched row", async () => {
    const session = new ScriptedSession([
      detail(["Different"]),
      result([]),
      detail(["1. First", "2. Second"]),
      result([]),
      detail(["1. First", "2. Second"]),
      actionLeaves(),
    ]);

    await retainedResolver().resolveSelectedVersion(
      session,
      retainedSource(),
      "zone-1",
      { index: 1, title: "2. Second" }
    );
    expect(session.calls[5].options.itemKey).toBe("track-1");
  });

  it("fails when the action session sees a different version set", async () => {
    const session = new ScriptedSession([]);
    await expect(
      retainedResolver(observed(["row-a"])).resolveSelectedVersion(
        session,
        retainedSource(),
        "zone-1"
      )
    ).rejects.toMatchObject<Partial<AlbumActionResolutionError>>({
      code: "ALBUM_CHANGED",
    });
    expect(session.calls).toEqual([]);
  });

  it("fails when no action-session row has the selected digest or the track selector drifts", async () => {
    await expect(
      retainedResolver().resolveSelectedVersion(
        new ScriptedSession([
          detail(["Changed A"]),
          result([]),
          detail(["Changed B"]),
          result([]),
        ]),
        retainedSource(),
        "zone-1"
      )
    ).rejects.toMatchObject<Partial<AlbumActionResolutionError>>({
      code: "ALBUM_CHANGED",
    });

    await expect(
      retainedResolver().resolveSelectedVersion(
        new ScriptedSession([
          detail(["Different"]),
          result([]),
          detail(["1. First", "2. Second"]),
          result([]),
          detail(["1. First", "2. Second"]),
        ]),
        retainedSource(),
        "zone-1",
        { index: 1, title: "Wrong title" }
      )
    ).rejects.toMatchObject<Partial<AlbumActionResolutionError>>({
      code: "TRACK_MISMATCH",
    });
  });

  it("fails instead of choosing the first duplicate when digests are identical", async () => {
    await expect(
      retainedResolver().resolveSelectedVersion(
        new ScriptedSession([
          detail(["1. First", "2. Second"]),
          result([]),
          detail(["1. First", "2. Second"]),
          result([]),
        ]),
        retainedSource(),
        "zone-1"
      )
    ).rejects.toMatchObject<Partial<AlbumActionResolutionError>>({
      code: "ALBUM_AMBIGUOUS",
    });
  });

  it("resolves exact fingerprint-bound leaves through the Albums category", async () => {
    const candidate = item("Album", "album-1", { subtitle: "Artist" });
    const parent = result([candidate], { level: 1 });
    const session = new ScriptedSession([
      result([item("Albums", "albums-category")]),
      parent,
      detail(["1. First", "2. Second"]),
      parent,
      detail(["1. First", "2. Second"]),
      actionLeaves(),
    ]);

    await expect(resolver.resolve(session, album(), "zone-1")).resolves.toEqual({
      actions: [
        { label: "Play Now", semantic: "play-now", itemKey: "play-now" },
        { label: "Add Next", semantic: "add-next", itemKey: "add-next" },
        { label: "Queue", semantic: "queue", itemKey: "queue" },
      ],
    });
    expect(session.calls.map((call) => call.method)).toEqual([
      "browse",
      "browse",
      "browse",
      "pop",
      "browse",
      "browse",
    ]);
    expect(session.calls.every((call) => call.options.zoneId === "zone-1")).toBe(
      true
    );
  });

  it("unwraps one exact Search album row before fingerprinting its detail", async () => {
    const candidate = item("Album", "album-1", { subtitle: "Artist" });
    const nested = item("Album", "nested-album-1", { subtitle: "Artist" });
    const parent = result([candidate], { level: 1 });
    const wrapper = result([nested], {
      title: "Album",
      subtitle: "Artist",
      level: 2,
    });
    const session = new ScriptedSession([
      result([item("Albums", "albums-category")]),
      parent,
      wrapper,
      detail(["1. First", "2. Second"]),
      parent,
      wrapper,
      detail(["1. First", "2. Second"]),
      actionLeaves(),
    ]);

    await expect(resolver.resolve(session, album(), "zone-1")).resolves.toMatchObject({
      actions: expect.any(Array),
    });
    expect(session.calls.map((call) => call.method)).toEqual([
      "browse",
      "browse",
      "browse",
      "browse",
      "pop",
      "browse",
      "browse",
      "browse",
    ]);
    expect(session.calls[4].options.levels).toBe(2);
    expect(session.calls[6].options.itemKey).toBe("nested-album-1");
  });

  it("resolves a track selector against the verified live track row", async () => {
    const candidate = item("Album", "album-1", { subtitle: "Artist" });
    const parent = result([candidate], { level: 1 });
    const session = new ScriptedSession([
      result([item("Albums", "albums-category")]),
      parent,
      detail(["1. First", "2. Second"]),
      parent,
      detail(["1. First", "2. Second"]),
      actionLeaves(),
    ]);

    const resolved = await resolver.resolve(session, album(), "zone-1", {
      index: 1,
      title: "2. Second",
    });

    expect(resolved.actions).toHaveLength(3);
    // The action path descends from the selected track, never Play Album.
    expect(session.calls[5].options.itemKey).toBe("track-1");
  });

  it("rejects a track index beyond the live track list", async () => {
    const candidate = item("Album", "album-1", { subtitle: "Artist" });
    const parent = result([candidate], { level: 1 });
    const session = new ScriptedSession([
      result([item("Albums", "albums-category")]),
      parent,
      detail(["1. First", "2. Second"]),
      parent,
      detail(["1. First", "2. Second"]),
    ]);

    await expect(
      resolver.resolve(session, album(), "zone-1", { index: 2, title: "Third" })
    ).rejects.toMatchObject({ code: "TRACK_NOT_FOUND" });
  });

  it("rejects a track whose live title drifted from the selector", async () => {
    const candidate = item("Album", "album-1", { subtitle: "Artist" });
    const parent = result([candidate], { level: 1 });
    const session = new ScriptedSession([
      result([item("Albums", "albums-category")]),
      parent,
      detail(["1. First", "2. Second"]),
      parent,
      detail(["1. First", "2. Second"]),
    ]);

    await expect(
      resolver.resolve(session, album(), "zone-1", { index: 1, title: "2. Renamed" })
    ).rejects.toMatchObject({ code: "TRACK_MISMATCH" });
  });

  it("probes every duplicate descriptor and selects only one fingerprint match", async () => {
    const first = item("Album", "album-a", { subtitle: "Artist" });
    const second = item("Album", "album-b", { subtitle: "Artist" });
    const parent = result([first, second]);
    const session = new ScriptedSession([
      parent,
      detail(["Wrong"]),
      parent,
      detail(["1. First", "2. Second"]),
      parent,
      detail(["1. First", "2. Second"]),
      actionLeaves(),
    ]);

    const resolved = await resolver.resolve(session, album(), "zone-1");

    expect(resolved.actions).toHaveLength(3);
    expect(session.calls[5].options.itemKey).toBe("album-b");
  });

  it("fails closed when duplicate editions share the same fingerprint", async () => {
    const first = item("Album", "album-a", { subtitle: "Artist" });
    const second = item("Album", "album-b", { subtitle: "Artist" });
    const parent = result([first, second]);
    const session = new ScriptedSession([
      parent,
      detail(["1. First", "2. Second"]),
      parent,
      detail(["1. First", "2. Second"]),
      parent,
    ]);

    await expect(resolver.resolve(session, album(), "zone-1")).rejects.toMatchObject({
      code: "ALBUM_AMBIGUOUS",
    });
  });

  it("fails closed when the catalog edition text cannot be reproved", async () => {
    const target: AlbumRef = { ...album(), editionText: "Deluxe Edition" };
    const session = new ScriptedSession([]);

    await expect(resolver.resolve(session, target, "zone-1")).rejects.toMatchObject({
      code: "ALBUM_AMBIGUOUS",
    });
    expect(session.calls).toHaveLength(0);
  });

  it("rejects a mixed typed and untyped track set instead of hashing a subset", async () => {
    const candidate = item("Album", "album-1", { subtitle: "Artist" });
    const parent = result([candidate]);
    const mixedDetail = result(
      [
        item("1. First", "track-1", {
          subtitle: "Artist",
          hint: "action_list",
          itemType: "track",
        }),
        item("2. Second", "track-2", {
          subtitle: "Artist",
          hint: "action_list",
          itemType: "track",
        }),
        item("3. Bonus", "track-3", {
          subtitle: "Artist",
          hint: "action_list",
        }),
        item("Play Album", "play-album", { hint: "action_list" }),
      ],
      { title: "Album", subtitle: "Artist", level: 2 }
    );
    const session = new ScriptedSession([
      parent,
      mixedDetail,
      parent,
      mixedDetail,
      actionLeaves(),
    ]);

    await expect(resolver.resolve(session, album(), "zone-1")).rejects.toMatchObject({
      code: "ALBUM_AMBIGUOUS",
    });
  });

  it("rejects incomplete candidate lists before using any item key", async () => {
    const session = new ScriptedSession([
      result([item("Album", "album-1", { subtitle: "Artist" })], {
        count: 2,
        totalCount: 2,
      }),
    ]);

    await expect(resolver.resolve(session, album(), "zone-1")).rejects.toBeInstanceOf(
      AlbumActionResolutionError
    );
    expect(session.calls).toHaveLength(1);
  });

  it("rejects a fingerprint match without one exact Play Album path", async () => {
    const candidate = item("Album", "album-1", { subtitle: "Artist" });
    const parent = result([candidate]);
    const session = new ScriptedSession([
      parent,
      detail(["1. First", "2. Second"], false),
      parent,
      detail(["1. First", "2. Second"], false),
    ]);

    await expect(resolver.resolve(session, album(), "zone-1")).rejects.toMatchObject({
      code: "ACTION_PATH_NOT_FOUND",
    });
  });

  it("keeps the 500-track bound independent from bounded detail action rows", async () => {
    const titles = Array.from(
      { length: 500 },
      (_, index) => `${index + 1}. Track ${index + 1}`
    );
    const candidate = item("Album", "album-1", { subtitle: "Artist" });
    const parent = result([candidate]);
    const fullDetail = detail(titles);
    const session = new ScriptedSession([
      parent,
      fullDetail,
      parent,
      fullDetail,
      actionLeaves(),
    ]);

    await expect(resolver.resolve(session, album(titles), "zone-1")).resolves.toMatchObject({
      actions: expect.any(Array),
    });
    expect(session.calls[1].options.pageSize).toBeGreaterThan(500);
  });
});
