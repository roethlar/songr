import {
  COLLECTION_DRILL_SOURCE_CONTRACT,
  CollectionDrillOpenLocator,
} from "../../../shared/collectionDrillContracts";
import type {
  BrowseItem,
  BrowseLoadOptions,
  BrowseOptions,
  BrowsePopOptions,
  BrowseResult,
} from "../../../shared/types";
import type { CoordinatedBrowseSession } from "../BrowseSessionCoordinator";
import {
  CollectionDrillResolver,
  CollectionDrillResolverError,
} from "../CollectionDrillResolver";

function row(title: string, key: string, over: Partial<BrowseItem> = {}): BrowseItem {
  return {
    title,
    itemKey: key,
    hint: "list",
    isLoadable: true,
    isPlayable: false,
    ...over,
  };
}

function page(items: BrowseItem[], totalCount = items.length, offset = 0): BrowseResult {
  return { level: 1, offset, count: items.length, totalCount, items };
}

class ScriptedSession implements CoordinatedBrowseSession {
  public readonly browse = jest.fn<Promise<BrowseResult>, [BrowseOptions]>();
  public readonly load = jest.fn<Promise<BrowseResult>, [BrowseLoadOptions]>();
  public readonly pop = jest.fn<Promise<BrowseResult>, [BrowsePopOptions]>();

  public constructor(public readonly sessionScope = "scripted-session") {}
}

function locator(
  over: Partial<CollectionDrillOpenLocator> = {}
): CollectionDrillOpenLocator {
  return {
    sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
    hierarchy: "genres",
    collectionExactName: "Baroque",
    rendering: { exactTitle: "Vespers", exactCredit: "Andrew Parrott" },
    ...over,
  };
}

/** Root -> genre node (a section list) -> Albums level. */
function scriptGenreDrill(session: ScriptedSession, albumRows: BrowseItem[]): void {
  session.browse
    .mockResolvedValueOnce(page([row("Ambient", "g1"), row("Baroque", "g2")]))
    .mockResolvedValueOnce(
      page([
        row("Play Genre", "a1", { hint: "action_list" }),
        row("Albums", "g2-albums"),
        row("Artists", "g2-artists"),
      ])
    )
    .mockResolvedValueOnce(page(albumRows));
}

describe("CollectionDrillResolver", () => {
  it("re-walks the drill and returns the live key of the unique matching row", async () => {
    const session = new ScriptedSession();
    scriptGenreDrill(session, [
      row("Voices", "alb-1", { subtitle: "Alf Linder" }),
      row("Vespers", "alb-2", { subtitle: "Andrew Parrott" }),
    ]);

    const result = await new CollectionDrillResolver().resolve(session, locator());

    expect(result).toEqual({
      kind: "resolved",
      hierarchy: "genres",
      itemKey: "alb-2",
      rendering: { exactTitle: "Vespers", exactCredit: "Andrew Parrott" },
    });
    // The root is re-read from the top of the hierarchy every time, because a
    // durable locator says nothing about where the session currently sits.
    expect(session.browse).toHaveBeenNthCalledWith(1, {
      hierarchy: "genres",
      offset: 0,
      pageSize: 100,
      popAll: true,
      refresh: true,
    });
  });

  it("walks the hierarchy the locator names, not a hard-coded one", async () => {
    const session = new ScriptedSession();
    // A composer node drills straight to its albums: no Albums child.
    session.browse
      .mockResolvedValueOnce(page([row("Byrd", "c1"), row("Tallis", "c2")]))
      .mockResolvedValueOnce(page([row("Cantiones", "alb-9", { subtitle: "Tallis Scholars" })]));

    const result = await new CollectionDrillResolver().resolve(
      session,
      locator({
        hierarchy: "composers",
        collectionExactName: "Tallis",
        rendering: { exactTitle: "Cantiones", exactCredit: "Tallis Scholars" },
      })
    );

    expect(result).toMatchObject({ kind: "resolved", hierarchy: "composers", itemKey: "alb-9" });
    for (const call of session.browse.mock.calls) {
      expect(call[0].hierarchy).toBe("composers");
    }
  });

  it("walks an artist's discography as the drill it is, action row and all", async () => {
    const session = new ScriptedSession();
    // The live shape of an artist node, as measured against the owner's Core:
    // it opens STRAIGHT onto the albums, headed by a `Play Artist` action row
    // that is not an album and must not be counted as one.
    session.browse
      .mockResolvedValueOnce(
        page([row("Fenwick’s Ladder", "ar-1"), row("Vera Solberg", "ar-2")])
      )
      .mockResolvedValueOnce(
        page([
          row("Play Artist", "act-1", { hint: "action_list" }),
          row("Voices Downstairs", "alb-1", { subtitle: "Fenwick's Ladder" }),
          row("Harbour Lights", "alb-2", { subtitle: "Vera Solberg" }),
        ])
      );

    // The row this artist merely appears on: credited to somebody else, and
    // opened by that credit, which is what the stored walk row carries.
    const result = await new CollectionDrillResolver().resolve(
      session,
      locator({
        hierarchy: "artists",
        collectionExactName: "Fenwick’s Ladder",
        rendering: { exactTitle: "Harbour Lights", exactCredit: "Vera Solberg" },
      })
    );

    expect(result).toMatchObject({
      kind: "resolved",
      hierarchy: "artists",
      itemKey: "alb-2",
    });
    for (const call of session.browse.mock.calls) {
      expect(call[0].hierarchy).toBe("artists");
    }
  });

  it("tells two root rows with one name apart by the rest of what they render", async () => {
    // Two artist entities with one name: Roon draws two rows differing only in
    // the subtitle. A locator naming the name alone matches both and opens
    // neither; naming the whole rendering opens the one it was minted from.
    const session = new ScriptedSession();
    const root = page([
      row("Aster Vale", "ar-1", { subtitle: "2 Albums" }),
      row("Aster Vale", "ar-2", { subtitle: "1 Album" }),
    ]);
    session.browse
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce(page([row("The Long Way Home", "alb-3")]));

    await expect(
      new CollectionDrillResolver().resolve(
        session,
        locator({
          hierarchy: "artists",
          collectionExactName: "Aster Vale",
          collectionExactSubtitle: "1 Album",
          rendering: {
            exactTitle: "The Long Way Home",
            exactCredit: "Aster Vale",
          },
        })
      )
    ).resolves.toMatchObject({ kind: "resolved", itemKey: "alb-3" });
    expect(session.browse.mock.calls[1][0].itemKey).toBe("ar-2");

    // And without one, the honest answer about that root is ambiguous.
    const nameOnly = new ScriptedSession();
    nameOnly.browse.mockResolvedValueOnce(root);
    await expect(
      new CollectionDrillResolver().resolve(
        nameOnly,
        locator({
          hierarchy: "artists",
          collectionExactName: "Aster Vale",
          rendering: {
            exactTitle: "The Long Way Home",
            exactCredit: "Aster Vale",
          },
        })
      )
    ).resolves.toEqual({
      kind: "ambiguous",
      stage: "collection",
      matchCount: 2,
    });
  });

  it("renders a credit-less row on an artist level as the browsed artist", async () => {
    // The artists level substitutes; genres and composers record the absence.
    // The walk stores the substituted form because `DiscographyResolver` — the
    // other reader of this same level — publishes an `AlbumRef` that refuses an
    // empty artist. If this reader disagreed, a stored credit-less entry would
    // report `missing` while sitting in plain sight in its own drill.
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Fenwick’s Ladder", "ar-1")]))
      .mockResolvedValueOnce(page([row("Untitled Sessions", "alb-7")]));

    await expect(
      new CollectionDrillResolver().resolve(
        session,
        locator({
          hierarchy: "artists",
          collectionExactName: "Fenwick’s Ladder",
          rendering: {
            exactTitle: "Untitled Sessions",
            exactCredit: "Fenwick’s Ladder",
          },
        })
      )
    ).resolves.toMatchObject({ kind: "resolved", itemKey: "alb-7" });
  });

  it("reports a collection the library no longer carries", async () => {
    const session = new ScriptedSession();
    session.browse.mockResolvedValueOnce(page([row("Ambient", "g1"), row("Jazz", "g3")]));

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).resolves.toEqual({ kind: "missing", stage: "collection", matchCount: 0 });
    // Nothing was drilled: there was no honest row to drill into.
    expect(session.browse).toHaveBeenCalledTimes(1);
  });

  it("refuses a collection name carried by two rows rather than taking one", async () => {
    const session = new ScriptedSession();
    session.browse.mockResolvedValueOnce(
      page([row("Baroque", "g1"), row("Jazz", "g2"), row("Baroque", "g3")])
    );

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).resolves.toEqual({ kind: "ambiguous", stage: "collection", matchCount: 2 });
    expect(session.browse).toHaveBeenCalledTimes(1);
  });

  it("reports an album that has left the collection", async () => {
    const session = new ScriptedSession();
    scriptGenreDrill(session, [row("Voices", "alb-1", { subtitle: "Alf Linder" })]);

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).resolves.toEqual({ kind: "missing", stage: "entry", matchCount: 0 });
  });

  it("refuses two album rows it cannot tell apart", async () => {
    // Re-drilling returned the same two rows, exactly as the surface predicted
    // when it marked the card non-openable. Neither read can break the tie.
    const session = new ScriptedSession();
    scriptGenreDrill(session, [
      row("Vespers", "alb-2", { subtitle: "Andrew Parrott" }),
      row("Vespers", "alb-3", { subtitle: "Andrew Parrott" }),
    ]);

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).resolves.toEqual({ kind: "ambiguous", stage: "entry", matchCount: 2 });
  });

  it("distinguishes rows that share a title by their credit", async () => {
    const session = new ScriptedSession();
    scriptGenreDrill(session, [
      row("Vespers", "alb-2", { subtitle: "Olle Persson" }),
      row("Vespers", "alb-3", { subtitle: "Andrew Parrott" }),
    ]);

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).resolves.toMatchObject({ kind: "resolved", itemKey: "alb-3" });
  });

  it("does not fold a typographic variant into a match", async () => {
    // The whole plan exists because folding U+2019 onto U+0027 put one
    // artist's records on another's page. A re-walk that folded would reopen
    // the wrong album and say nothing about it.
    const session = new ScriptedSession();
    scriptGenreDrill(session, [row("’Til Tuesday", "alb-7", { subtitle: "Ellery Vance" })]);

    await expect(
      new CollectionDrillResolver().resolve(
        session,
        locator({
          rendering: { exactTitle: "'Til Tuesday", exactCredit: "Ellery Vance" },
        })
      )
    ).resolves.toEqual({ kind: "missing", stage: "entry", matchCount: 0 });
  });

  it("matches a credit-less row on its absent credit", async () => {
    const session = new ScriptedSession();
    scriptGenreDrill(session, [row("Untitled", "alb-4")]);

    await expect(
      new CollectionDrillResolver().resolve(
        session,
        locator({ rendering: { exactTitle: "Untitled", exactCredit: "" } })
      )
    ).resolves.toMatchObject({ kind: "resolved", itemKey: "alb-4" });
  });

  it("canonicalizes a live row the way the surface canonicalized it", async () => {
    // The surface minted the locator from the row it rendered. If the server
    // compared Roon's raw text instead, a row with a double space would be
    // stored in one form and sought in another, and the open would report
    // `missing` about two strings rather than about the library.
    const session = new ScriptedSession();
    scriptGenreDrill(session, [row("  Two  Spaces ", "alb-5", { subtitle: " Alf Linder " })]);

    await expect(
      new CollectionDrillResolver().resolve(
        session,
        locator({ rendering: { exactTitle: "Two Spaces", exactCredit: "Alf Linder" } })
      )
    ).resolves.toMatchObject({ kind: "resolved", itemKey: "alb-5" });
  });

  it("ignores action rows when counting matches", async () => {
    // The action row is given the SAME rendering as the album, so counting it
    // would make the album ambiguous and refuse a row that is in fact unique.
    // Play/Shuffle verbs are not albums, on either reader.
    const session = new ScriptedSession();
    scriptGenreDrill(session, [
      row("Vespers", "act-1", { hint: "action", subtitle: "Andrew Parrott" }),
      row("Vespers", "alb-2", { subtitle: "Andrew Parrott" }),
    ]);

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).resolves.toMatchObject({ kind: "resolved", itemKey: "alb-2" });
  });

  it("pages a long album list to completion before deciding", async () => {
    // A match answer taken from a partial list is not an answer. The album
    // being sought is on the second page here.
    const session = new ScriptedSession();
    const first = Array.from({ length: 100 }, (_, index) =>
      row(`Album ${index}`, `alb-${index}`, { subtitle: "Someone" })
    );
    session.browse
      .mockResolvedValueOnce(page([row("Baroque", "g2")]))
      .mockResolvedValueOnce(page([row("Albums", "g2-albums")]))
      .mockResolvedValueOnce(page(first, 101, 0));
    session.load.mockResolvedValueOnce(
      page([row("Vespers", "alb-100", { subtitle: "Andrew Parrott" })], 101, 100)
    );

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).resolves.toMatchObject({ kind: "resolved", itemKey: "alb-100" });
    expect(session.load).toHaveBeenCalledWith({
      hierarchy: "genres",
      offset: 100,
      count: 1,
    });
  });

  it("refuses a drill whose pages disagree rather than deciding on part of it", async () => {
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Baroque", "g2")]))
      .mockResolvedValueOnce(page([row("Albums", "g2-albums")]))
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, index) => row(`Album ${index}`, `alb-${index}`)),
          101,
          0
        )
      );
    session.load.mockResolvedValueOnce(page([row("Vespers", "alb-100")], 999, 100));

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).rejects.toThrow(CollectionDrillResolverError);
  });

  it("refuses a duplicate row key inside one drill", async () => {
    const session = new ScriptedSession();
    scriptGenreDrill(session, [row("Voices", "same"), row("Vespers", "same")]);

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).rejects.toThrow("collection drill contained a missing or duplicate row key");
  });

  it("refuses a collection offering two album lists", async () => {
    // Choosing between them would be exactly the guess this path avoids.
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Baroque", "g2")]))
      .mockResolvedValueOnce(page([row("Albums", "g2-a"), row("Albums", "g2-b")]));

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).rejects.toThrow(
      expect.objectContaining({ code: "COLLECTION_ALBUMS_PATH_NOT_UNIQUE" })
    );
  });

  it("reports a drill past its bound as too large, not as a missing album", async () => {
    const session = new ScriptedSession();
    session.browse
      .mockResolvedValueOnce(page([row("Baroque", "g2")]))
      .mockResolvedValueOnce(page([row("Albums", "g2-albums")]))
      .mockResolvedValueOnce(page([row("Album 0", "alb-0")], 10_001, 0));

    await expect(
      new CollectionDrillResolver().resolve(session, locator())
    ).rejects.toThrow(
      expect.objectContaining({ code: "COLLECTION_DRILL_TOO_LARGE" })
    );
  });

  it("stops at the first checkpoint after an await when the page has moved on", async () => {
    const session = new ScriptedSession();
    scriptGenreDrill(session, [row("Vespers", "alb-2", { subtitle: "Andrew Parrott" })]);
    let checks = 0;

    await expect(
      new CollectionDrillResolver().resolve(session, locator(), {
        assertCurrent: () => {
          checks += 1;
          throw new Error("superseded");
        },
      })
    ).rejects.toThrow("superseded");

    expect(checks).toBe(1);
    // The root browse happened; nothing after its checkpoint did.
    expect(session.browse).toHaveBeenCalledTimes(1);
  });
});
