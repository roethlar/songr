import type { ArtistRef } from "../../../shared/catalogContracts";
import type {
  BrowseItem,
  BrowseLoadOptions,
  BrowseOptions,
  BrowsePopOptions,
  BrowseResult,
} from "../../../shared/types";
import type { CoordinatedBrowseSession } from "../BrowseSessionCoordinator";
import { DiscographyResolver } from "../DiscographyResolver";

const ARTIST_ID = "10000000-0000-4000-8000-000000000001";
const AT = "2026-07-15T00:00:00.000Z";

function artist(): ArtistRef {
  return {
    localId: ARTIST_ID,
    coreId: "core-a",
    exactName: "Björk",
    normalizedName: "björk",
    firstSeenAt: AT,
    lastSeenAt: AT,
    resolutionStatus: "unresolved",
  };
}

function amonArtist(): ArtistRef {
  return {
    ...artist(),
    localId: "10000000-0000-4000-8000-000000000002",
    exactName: "Amon Tobin",
    normalizedName: "amon tobin",
  };
}

function row(
  title: string,
  key: string,
  over: Partial<BrowseItem> = {}
): BrowseItem {
  return {
    title,
    itemKey: key,
    hint: "list",
    isLoadable: true,
    isPlayable: false,
    ...over,
  };
}

function page(
  items: BrowseItem[],
  totalCount = items.length,
  offset = 0,
  title?: string
): BrowseResult {
  return {
    ...(title ? { title } : {}),
    level: 1,
    offset,
    count: totalCount,
    totalCount,
    items,
  };
}

class ScriptedSession implements CoordinatedBrowseSession {
  public readonly browse = jest.fn<Promise<BrowseResult>, [BrowseOptions]>();
  public readonly load = jest.fn<Promise<BrowseResult>, [BrowseLoadOptions]>();
  public readonly pop = jest.fn<Promise<BrowseResult>, [BrowsePopOptions]>();

  public constructor(public readonly sessionScope = "scripted-session") {}
}

describe("DiscographyResolver", () => {
  it("credits each album row to its own artist, falling back to the browsed artist", async () => {
    // Roon puts the album's OWN artist credit in the discography row subtitle,
    // and that is what the album's detail header shows. Taking the browsed
    // artist instead minted a phantom record for every album an artist merely
    // appears on — the real "Champions" is credited to Kanye West even when it
    // is read from 2 Chainz's discography — and opening the phantom always
    // failed AlbumDetailResolver's header check with DETAIL_MISMATCH.
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Björk", "artist-target")], 1, 0, "Artists"))
      .mockResolvedValueOnce(
        page(
          [
            row("Play", "action-header", { hint: "action_list" }),
            row("Champions", "album-1", { subtitle: "Kanye West" }),
            row("Debut", "album-2", { subtitle: "  Björk  " }),
            row("Untitled", "album-3"),
          ],
          4,
          0,
          "Björk"
        )
      );

    const result = await new DiscographyResolver().resolve(session, artist());

    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("expected resolution");
    expect(result.observation.albums).toEqual([
      { exactTitle: "Champions", exactArtist: "Kanye West", editionText: "" },
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "" },
      // No subtitle on the row: fall back to the artist being browsed.
      { exactTitle: "Untitled", exactArtist: "Björk", editionText: "" },
    ]);
  });

  it("resolves a normalized-exact artist across pages and retains direct album order", async () => {
    const session = new ScriptedSession();
    const rootFirst = Array.from({ length: 100 }, (_, index) =>
      row(`Other ${index}`, `artist-${index}`)
    );
    session.browse
      .mockResolvedValueOnce(page(rootFirst, 101, 0, "Artists"))
      .mockResolvedValueOnce(
        page(
          [
            row("Play", "action-header", { hint: "action_list" }),
            row("Debut", "album-1", { imageKey: "image/one" }),
            row("Post", "album-2"),
          ],
          3,
          0,
          "Björk"
        )
      );
    session.load.mockResolvedValueOnce(
      page([row("  BJÖRK  ", "artist-target", { imageKey: "artist-image" })], 101, 100)
    );

    const result = await new DiscographyResolver().resolve(
      session,
      artist()
    );

    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("expected resolution");
    expect(result.observation.artist).toEqual({
      exactName: "BJÖRK",
      candidateCount: 1,
      imageKeyHint: "artist-image",
    });
    expect(result.observation.albums).toEqual([
      {
        exactTitle: "Debut",
        exactArtist: "BJÖRK",
        editionText: "",
        imageKeyHint: "image/one",
      },
      { exactTitle: "Post", exactArtist: "BJÖRK", editionText: "" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/itemKey|multiSessionKey|artist-target|album-1/u);
    expect(session.browse).toHaveBeenLastCalledWith({
      hierarchy: "artists",
      itemKey: "artist-target",
      offset: 0,
      pageSize: 100,
    });
    expect(session.pop).not.toHaveBeenCalled();
  });

  it("drills one unique nested Albums path and accepts an empty discography", async () => {
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Björk", "artist")], 1, 0, "Artists"))
      .mockResolvedValueOnce(
        page(
          [row("Albums", "albums-path"), row("Tracks", "tracks-path")],
          2,
          0,
          "Björk"
        )
      )
      .mockResolvedValueOnce(page([], 0, 0, "Björk"));

    const result = await new DiscographyResolver().resolve(
      session,
      artist()
    );

    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("expected resolution");
    expect(result.observation.albums).toEqual([]);
    expect(session.browse).toHaveBeenNthCalledWith(3, {
      hierarchy: "artists",
      itemKey: "albums-path",
      offset: 0,
      pageSize: 100,
    });
  });

  it("never maps explicit track, composition, or other non-album list rows as albums", async () => {
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Björk", "artist")], 1, 0, "Artists"))
      .mockResolvedValueOnce(
        page(
          [
            row("Tracks", "tracks", { itemType: "track" }),
            row("Compositions", "compositions", { itemType: "composition" }),
            row("Videos", "videos", { itemType: "video" }),
          ],
          3,
          0,
          "Björk"
        )
      );

    await expect(
      new DiscographyResolver().resolve(session, artist())
    ).rejects.toMatchObject({ code: "DISCOGRAPHY_PATH_NOT_UNIQUE" });
    expect(session.browse).toHaveBeenCalledTimes(2);
  });

  it("fails closed when explicit album and non-album list rows are mixed", async () => {
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Björk", "artist")], 1, 0, "Artists"))
      .mockResolvedValueOnce(
        page(
          [
            row("Debut", "album", { itemType: "album" }),
            row("Human Behaviour", "track", { itemType: "track" }),
          ],
          2,
          0,
          "Björk"
        )
      );

    await expect(
      new DiscographyResolver().resolve(session, artist())
    ).rejects.toMatchObject({ code: "INVALID_DISCOGRAPHY_ROW" });
  });

  it("inspects and resolves a discography reached after exactly four descents", async () => {
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Björk", "artist")], 1, 0, "Artists"))
      .mockResolvedValueOnce(page([row("Albums", "albums-1")], 1, 0, "Björk"))
      .mockResolvedValueOnce(page([row("Albums", "albums-2")], 1, 0, "Björk"))
      .mockResolvedValueOnce(page([row("Albums", "albums-3")], 1, 0, "Björk"))
      .mockResolvedValueOnce(page([row("Albums", "albums-4")], 1, 0, "Björk"))
      .mockResolvedValueOnce(
        page([row("Debut", "album", { itemType: "album" })], 1, 0, "Albums")
      );

    const result = await new DiscographyResolver().resolve(
      session,
      artist()
    );

    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("expected resolution");
    expect(result.observation.albums).toEqual([
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "" },
    ]);
    expect(session.browse).toHaveBeenCalledTimes(6);
    expect(session.browse).toHaveBeenNthCalledWith(6, {
      hierarchy: "artists",
      itemKey: "albums-4",
      offset: 0,
      pageSize: 100,
    });
  });

  it("rejects a fifth descent without browsing beyond the depth bound", async () => {
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Björk", "artist")], 1, 0, "Artists"))
      .mockResolvedValueOnce(page([row("Albums", "albums-1")], 1, 0, "Björk"))
      .mockResolvedValueOnce(page([row("Albums", "albums-2")], 1, 0, "Björk"))
      .mockResolvedValueOnce(page([row("Albums", "albums-3")], 1, 0, "Björk"))
      .mockResolvedValueOnce(page([row("Albums", "albums-4")], 1, 0, "Björk"))
      .mockResolvedValueOnce(page([row("Albums", "albums-5")], 1, 0, "Björk"))
      .mockResolvedValueOnce(
        page([row("Debut", "album", { itemType: "album" })], 1, 0, "Albums")
      );

    await expect(
      new DiscographyResolver().resolve(session, artist())
    ).rejects.toMatchObject({ code: "DISCOGRAPHY_PATH_NOT_UNIQUE" });
    expect(session.browse).toHaveBeenCalledTimes(6);
    expect(session.browse).not.toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: "albums-5" })
    );
  });

  it("reports zero or duplicate exact artists without drilling either candidate", async () => {
    for (const rootRows of [
      [row("Other", "other")],
      [row("Björk", "one"), row("BJÖRK", "two")],
    ]) {
      const session = new ScriptedSession();
      session.browse.mockResolvedValueOnce(page(rootRows, rootRows.length, 0, "Artists"));
      const result = await new DiscographyResolver().resolve(
        session,
        artist()
      );
      expect(result.kind).toBe(rootRows.length === 1 ? "missing" : "ambiguous");
      expect(result.observation.artist.candidateCount).toBe(
        rootRows.length === 1 ? 0 : 2
      );
      expect(session.browse).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects pagination drift instead of assembling a partial artist root", async () => {
    const session = new ScriptedSession();
    session.browse.mockResolvedValueOnce(
      page(
        Array.from({ length: 100 }, (_, index) => row(`Other ${index}`, `a-${index}`)),
        101,
        0,
        "Artists"
      )
    );
    session.load.mockResolvedValueOnce(page([row("Björk", "target")], 102, 100));

    await expect(
      new DiscographyResolver().resolve(session, artist())
    ).rejects.toMatchObject({ code: "INCOMPLETE_ARTIST_ROOT" });
  });

  it("accepts 500 albums plus one action header but rejects a 501st album", async () => {
    for (const albumCount of [500, 501]) {
      const session = new ScriptedSession();
      const allRows = [
        row("Play", "action", { hint: "action_list" }),
        ...Array.from({ length: albumCount }, (_, index) =>
          row(`Album ${index}`, `album-${index}`, { itemType: "album" })
        ),
      ];
      session.browse
        .mockResolvedValueOnce(page([row("Björk", "artist")], 1, 0, "Artists"))
        .mockResolvedValueOnce(page(allRows.slice(0, 100), allRows.length, 0, "Björk"));
      for (let offset = 100; offset < allRows.length; offset += 100) {
        session.load.mockResolvedValueOnce(
          page(allRows.slice(offset, offset + 100), allRows.length, offset)
        );
      }

      const pending = new DiscographyResolver().resolve(session, artist());
      if (albumCount === 500) {
        const result = await pending;
        expect(result.kind).toBe("resolved");
        if (result.kind === "resolved") {
          expect(result.observation.albums).toHaveLength(500);
        }
      } else {
        await expect(pending).rejects.toMatchObject({
          code: "DISCOGRAPHY_TOO_LARGE",
        });
      }
    }
  });

  it("rejects ambiguous structural menus", async () => {
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Björk", "artist")], 1, 0, "Artists"))
      .mockResolvedValueOnce(
        page(
          [row("Albums", "albums-a"), row("Albums", "albums-b")],
          2,
          0,
          "Björk"
        )
      );

    await expect(
      new DiscographyResolver().resolve(session, artist())
    ).rejects.toMatchObject({ code: "DISCOGRAPHY_PATH_NOT_UNIQUE" });
  });

  it("re-observes the complete retained album level with server-only live rows", async () => {
    const session = new ScriptedSession();
    const firstRows = Array.from({ length: 100 }, (_, index) =>
      row(`Album ${index}`, `old-or-fresh-${index}`, { itemType: "album" })
    );
    session.load
      .mockResolvedValueOnce(page(firstRows, 101, 0, "Björk"))
      .mockResolvedValueOnce(
        page([row("Final Album", "fresh-final", { itemType: "album" })], 101, 100)
      );

    const observed = await new DiscographyResolver().observeCurrent(
      session,
      artist()
    );

    expect(observed.observation.albums).toHaveLength(101);
    expect(observed.observation.albums[100]).toEqual({
      exactTitle: "Final Album",
      exactArtist: "Björk",
      editionText: "",
    });
    expect(observed.liveAlbums[100]).toEqual({
      observationIndex: 100,
      itemKey: "fresh-final",
    });
    expect(JSON.stringify(observed.observation)).not.toContain("fresh-final");
    expect(session.load).toHaveBeenNthCalledWith(1, {
      hierarchy: "artists",
      offset: 0,
      count: 100,
    });
  });

  it("rejects a retained current level that is not the expected discography", async () => {
    const session = new ScriptedSession();
    session.load.mockResolvedValueOnce(
      page([row("Tracks", "tracks", { itemType: "track" })], 1, 0, "Björk")
    );

    await expect(
      new DiscographyResolver().observeCurrent(session, artist())
    ).rejects.toMatchObject({ code: "INCOMPLETE_DISCOGRAPHY" });
  });

  it("reuses a verified cached locator inside one session and skips the artist-root walk", async () => {
    const resolver = new DiscographyResolver();
    const session = new ScriptedSession("catalog:4");
    session.browse
      .mockResolvedValueOnce(
        page(
          [row("Björk", "49:1"), row("Amon Tobin", "49:2")],
          2,
          0,
          "Artists"
        )
      )
      .mockResolvedValueOnce(
        page([row("Debut", "49:10", { itemType: "album" })], 1, 0, "Björk")
      );

    const first = await resolver.resolve(session, artist());
    expect(first.kind).toBe("resolved");
    expect(session.browse).toHaveBeenCalledTimes(2);

    session.browse.mockResolvedValueOnce(
      page(
        [row("Out From Out Where", "49:20", { itemType: "album" })],
        1,
        0,
        "Amon Tobin"
      )
    );

    const second = await resolver.resolve(session, amonArtist());

    expect(second.kind).toBe("resolved");
    if (second.kind !== "resolved") throw new Error("expected resolution");
    expect(second.observation.artist).toEqual({
      exactName: "Amon Tobin",
      candidateCount: 1,
    });
    expect(session.browse).toHaveBeenCalledTimes(3);
    expect(session.browse).toHaveBeenNthCalledWith(3, {
      hierarchy: "artists",
      itemKey: "49:2",
      offset: 0,
      pageSize: 100,
    });
    expect(session.load).not.toHaveBeenCalled();
  });

  it("falls back to the full artist-root scan when the cached locator verifies the wrong artist", async () => {
    const resolver = new DiscographyResolver();
    const session = new ScriptedSession("catalog:4");
    session.browse
      .mockResolvedValueOnce(
        page(
          [row("Björk", "49:1"), row("Amon Tobin", "49:2")],
          2,
          0,
          "Artists"
        )
      )
      .mockResolvedValueOnce(
        page([row("Debut", "49:10", { itemType: "album" })], 1, 0, "Björk")
      );
    await resolver.resolve(session, artist());

    session.browse
      .mockResolvedValueOnce(page([row("Impostor", "49:99")], 1, 0, "Someone Else"))
      .mockResolvedValueOnce(
        page(
          [row("Björk", "50:1"), row("Amon Tobin", "50:2")],
          2,
          0,
          "Artists"
        )
      )
      .mockResolvedValueOnce(
        page(
          [row("Out From Out Where", "50:20", { itemType: "album" })],
          1,
          0,
          "Amon Tobin"
        )
      );

    const result = await resolver.resolve(session, amonArtist());

    expect(result.kind).toBe("resolved");
    expect(session.browse).toHaveBeenNthCalledWith(3, {
      hierarchy: "artists",
      itemKey: "49:2",
      offset: 0,
      pageSize: 100,
    });
    expect(session.browse).toHaveBeenNthCalledWith(4, {
      hierarchy: "artists",
      offset: 0,
      pageSize: 100,
      popAll: true,
      refresh: true,
    });
    expect(session.browse).toHaveBeenNthCalledWith(5, {
      hierarchy: "artists",
      itemKey: "50:2",
      offset: 0,
      pageSize: 100,
    });

    session.browse.mockResolvedValueOnce(
      page([row("Post", "50:11", { itemType: "album" })], 1, 0, "Björk")
    );
    const refreshed = await resolver.resolve(session, artist());
    expect(refreshed.kind).toBe("resolved");
    expect(session.browse).toHaveBeenNthCalledWith(6, {
      hierarchy: "artists",
      itemKey: "50:1",
      offset: 0,
      pageSize: 100,
    });
    expect(session.browse).toHaveBeenCalledTimes(6);
  });

  it("falls back to the full artist-root scan when the cached locator browse fails", async () => {
    const resolver = new DiscographyResolver();
    const session = new ScriptedSession("catalog:4");
    session.browse
      .mockResolvedValueOnce(
        page(
          [row("Björk", "49:1"), row("Amon Tobin", "49:2")],
          2,
          0,
          "Artists"
        )
      )
      .mockResolvedValueOnce(
        page([row("Debut", "49:10", { itemType: "album" })], 1, 0, "Björk")
      );
    await resolver.resolve(session, artist());

    session.browse
      .mockRejectedValueOnce(new Error("browse session lost"))
      .mockResolvedValueOnce(page([row("Amon Tobin", "51:2")], 1, 0, "Artists"))
      .mockResolvedValueOnce(
        page(
          [row("Out From Out Where", "51:20", { itemType: "album" })],
          1,
          0,
          "Amon Tobin"
        )
      );

    const result = await resolver.resolve(session, amonArtist());

    expect(result.kind).toBe("resolved");
    expect(session.browse).toHaveBeenNthCalledWith(4, {
      hierarchy: "artists",
      offset: 0,
      pageSize: 100,
      popAll: true,
      refresh: true,
    });
  });

  it("drops cached locators when the browse session scope rotates", async () => {
    const resolver = new DiscographyResolver();
    const first = new ScriptedSession("catalog:4");
    first.browse
      .mockResolvedValueOnce(
        page(
          [row("Björk", "49:1"), row("Amon Tobin", "49:2")],
          2,
          0,
          "Artists"
        )
      )
      .mockResolvedValueOnce(
        page([row("Debut", "49:10", { itemType: "album" })], 1, 0, "Björk")
      );
    await resolver.resolve(first, artist());

    const rotated = new ScriptedSession("catalog:5");
    rotated.browse
      .mockResolvedValueOnce(page([row("Amon Tobin", "60:2")], 1, 0, "Artists"))
      .mockResolvedValueOnce(
        page(
          [row("Out From Out Where", "60:20", { itemType: "album" })],
          1,
          0,
          "Amon Tobin"
        )
      );

    const result = await resolver.resolve(rotated, amonArtist());

    expect(result.kind).toBe("resolved");
    expect(rotated.browse).toHaveBeenNthCalledWith(1, {
      hierarchy: "artists",
      offset: 0,
      pageSize: 100,
      popAll: true,
      refresh: true,
    });
    expect(rotated.browse).toHaveBeenNthCalledWith(2, {
      hierarchy: "artists",
      itemKey: "60:2",
      offset: 0,
      pageSize: 100,
    });
  });
});
