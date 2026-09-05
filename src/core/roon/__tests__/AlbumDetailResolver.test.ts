import { BrowseItem, BrowseResult } from "../../../shared/types";
import { CoordinatedBrowseSession } from "../BrowseSessionCoordinator";
import { AlbumDetailResolver } from "../AlbumDetailResolver";

function row(
  title: string,
  itemKey: string,
  overrides: Partial<BrowseItem> = {}
): BrowseItem {
  return {
    title,
    itemKey,
    hint: "action_list",
    isLoadable: true,
    isPlayable: false,
    ...overrides,
  };
}

function detail(
  titles: readonly string[],
  overrides: Partial<BrowseResult> = {}
): BrowseResult {
  const items = [
    ...titles.map((title, index) =>
      row(title, `track-${index}`, {
        subtitle: "Björk",
        itemType: "track",
      })
    ),
    row("Play Album", "play-album"),
  ];
  return {
    title: "Debut",
    subtitle: "Björk",
    level: 2,
    offset: 0,
    count: items.length,
    totalCount: items.length,
    items,
    ...overrides,
  };
}

class ScriptedSession implements CoordinatedBrowseSession {
  public readonly sessionScope = "scripted-session";
  public readonly browse = jest.fn();
  public readonly load = jest.fn();
  public readonly pop = jest.fn();
}

describe("AlbumDetailResolver.readDetailRows", () => {
  it("reads an opened level's track titles in Roon's own order", async () => {
    const session = new ScriptedSession();
    session.browse.mockResolvedValueOnce(detail(["Human Behaviour", "Crying"]));

    const titles = await new AlbumDetailResolver().readDetailRows(
      session,
      "genres",
      "album-key",
      "Debut"
    );

    expect(titles).toEqual(["Human Behaviour", "Crying"]);
    expect(session.browse).toHaveBeenCalledWith(
      expect.objectContaining({ hierarchy: "genres", itemKey: "album-key", offset: 0 })
    );
  });

  it("checks the header title and not the credit line", async () => {
    const session = new ScriptedSession();
    // A drill row's credit may be absent, so a present header subtitle is
    // never compared against it — only the title has to agree.
    session.browse.mockResolvedValueOnce(
      detail(["Human Behaviour"], { subtitle: "Someone Else Entirely" })
    );

    await expect(
      new AlbumDetailResolver().readDetailRows(session, "genres", "k", "Debut")
    ).resolves.toEqual(["Human Behaviour"]);
  });

  it("refuses a level whose header names a different album", async () => {
    const session = new ScriptedSession();
    session.browse.mockResolvedValueOnce(
      detail(["Human Behaviour"], { title: "Post" })
    );

    await expect(
      new AlbumDetailResolver().readDetailRows(session, "genres", "k", "Debut")
    ).rejects.toMatchObject({ code: "DETAIL_MISMATCH" });
  });

  it("refuses a partial page rather than reporting a short track list", async () => {
    const session = new ScriptedSession();
    const partial = detail(["Human Behaviour", "Crying"]);
    session.browse.mockResolvedValueOnce({ ...partial, totalCount: 9 });

    await expect(
      new AlbumDetailResolver().readDetailRows(session, "genres", "k", "Debut")
    ).rejects.toMatchObject({ code: "DETAIL_INCOMPLETE" });
  });

  it("refuses a duplicate or non-structural row", async () => {
    const resolver = new AlbumDetailResolver();

    const duplicated = new ScriptedSession();
    const base = detail(["Human Behaviour"]);
    duplicated.browse.mockResolvedValueOnce({
      ...base,
      items: [base.items[0], base.items[0]],
      count: 2,
      totalCount: 2,
    });
    await expect(
      resolver.readDetailRows(duplicated, "genres", "k", "Debut")
    ).rejects.toMatchObject({ code: "DETAIL_INCOMPLETE" });

    const playable = new ScriptedSession();
    playable.browse.mockResolvedValueOnce({
      ...base,
      items: [{ ...base.items[0], isPlayable: true }, base.items[1]],
    });
    await expect(
      resolver.readDetailRows(playable, "genres", "k", "Debut")
    ).rejects.toMatchObject({ code: "DETAIL_INCOMPLETE" });
  });

  it("refuses a level mixing typed and untyped track evidence", async () => {
    const session = new ScriptedSession();
    const base = detail(["Human Behaviour"]);
    session.browse.mockResolvedValueOnce({
      ...base,
      items: [
        base.items[0],
        row("Crying", "untyped-1", { subtitle: "Björk" }),
        base.items[1],
      ],
      count: 3,
      totalCount: 3,
    });

    await expect(
      new AlbumDetailResolver().readDetailRows(session, "genres", "k", "Debut")
    ).rejects.toMatchObject({ code: "DETAIL_INCOMPLETE" });
  });

  it("refuses a level with no track rows at all", async () => {
    const session = new ScriptedSession();
    const base = detail([]);
    session.browse.mockResolvedValueOnce(base);

    await expect(
      new AlbumDetailResolver().readDetailRows(session, "genres", "k", "Debut")
    ).rejects.toMatchObject({ code: "DETAIL_INCOMPLETE" });
  });

  it("refuses a track title Roon rendered as control characters", async () => {
    const session = new ScriptedSession();
    session.browse.mockResolvedValueOnce(detail(["HumanBehaviour"]));

    await expect(
      new AlbumDetailResolver().readDetailRows(session, "genres", "k", "Debut")
    ).rejects.toMatchObject({ code: "DETAIL_INCOMPLETE" });
  });
});
