import type {
  BrowseItem,
  BrowseLoadOptions,
  BrowseOptions,
  BrowsePopOptions,
  BrowseResult,
} from "../../../shared/types";
import type { CoordinatedBrowseSession } from "../BrowseSessionCoordinator";
import { readCompleteBrowseLevel } from "../browseLevelReader";

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

class Refusal extends Error {}
class TooLarge extends Error {}

function options(over: Partial<Parameters<typeof readCompleteBrowseLevel>[2]> = {}) {
  return {
    hierarchy: "genres" as const,
    label: "test level",
    pageSize: 2,
    maxRows: 100,
    maxPages: 50,
    refuse: (message: string) => new Refusal(message),
    ...over,
  };
}

describe("readCompleteBrowseLevel", () => {
  it("assembles every page of a level in order", async () => {
    const session = new ScriptedSession();
    session.load
      .mockResolvedValueOnce(page([row("c", "k3"), row("d", "k4")], 5, 2))
      .mockResolvedValueOnce(page([row("e", "k5")], 5, 4));

    const rows = await readCompleteBrowseLevel(
      session,
      page([row("a", "k1"), row("b", "k2")], 5, 0),
      options()
    );

    expect(rows.map((item) => item.itemKey)).toEqual(["k1", "k2", "k3", "k4", "k5"]);
    expect(session.load).toHaveBeenCalledWith({
      hierarchy: "genres",
      offset: 2,
      count: 2,
    });
    // The last page asks for exactly the remainder, never a full page past
    // the end: a caller that over-asked would get a short page and refuse it.
    expect(session.load).toHaveBeenLastCalledWith({
      hierarchy: "genres",
      offset: 4,
      count: 1,
    });
  });

  it("reads a single-page level without loading anything further", async () => {
    const session = new ScriptedSession();
    const rows = await readCompleteBrowseLevel(
      session,
      page([row("a", "k1")], 1, 0),
      options()
    );
    expect(rows).toHaveLength(1);
    expect(session.load).not.toHaveBeenCalled();
  });

  it("reads an empty level as empty rather than refusing it", async () => {
    const session = new ScriptedSession();
    await expect(
      readCompleteBrowseLevel(session, page([], 0, 0), options())
    ).resolves.toEqual([]);
  });

  it("refuses a page that arrives at the wrong offset", async () => {
    const session = new ScriptedSession();
    session.load.mockResolvedValueOnce(page([row("c", "k3")], 3, 99));
    await expect(
      readCompleteBrowseLevel(
        session,
        page([row("a", "k1"), row("b", "k2")], 3, 0),
        options()
      )
    ).rejects.toThrow("test level pagination changed");
  });

  it("refuses a level whose total changes underneath the read", async () => {
    // The list moved while it was being read. Whatever comes back is a mix of
    // two lists, and no count taken from it means anything.
    const session = new ScriptedSession();
    session.load.mockResolvedValueOnce(page([row("c", "k3")], 9, 2));
    await expect(
      readCompleteBrowseLevel(
        session,
        page([row("a", "k1"), row("b", "k2")], 3, 0),
        options()
      )
    ).rejects.toThrow("test level pagination changed");
  });

  it("refuses a page carrying the wrong number of rows", async () => {
    const session = new ScriptedSession();
    session.load.mockResolvedValueOnce(page([row("c", "k3")], 4, 2));
    await expect(
      readCompleteBrowseLevel(
        session,
        page([row("a", "k1"), row("b", "k2")], 4, 0),
        options()
      )
    ).rejects.toThrow("test level pagination changed");
  });

  it("refuses a row with no item key", async () => {
    const session = new ScriptedSession();
    await expect(
      readCompleteBrowseLevel(
        session,
        page([row("a", "k1"), { ...row("b", "k2"), itemKey: undefined }], 2, 0),
        options()
      )
    ).rejects.toThrow("test level contained a missing or duplicate row key");
  });

  it("refuses a key that repeats within the level", async () => {
    // A repeated key means one row was served twice, so a uniqueness answer
    // taken from this list would be counting the same row as two rivals.
    const session = new ScriptedSession();
    session.load.mockResolvedValueOnce(page([row("c", "k1"), row("d", "k4")], 4, 2));
    await expect(
      readCompleteBrowseLevel(
        session,
        page([row("a", "k1"), row("b", "k2")], 4, 0),
        options()
      )
    ).rejects.toThrow("test level contained a missing or duplicate row key");
  });

  it("refuses a total that is absent, negative or not a whole number", async () => {
    const session = new ScriptedSession();
    for (const totalCount of [undefined, -1, 1.5, Number.NaN]) {
      await expect(
        readCompleteBrowseLevel(
          session,
          { ...page([row("a", "k1")], 1, 0), totalCount } as BrowseResult,
          options()
        )
      ).rejects.toThrow("test level reported an invalid total");
    }
  });

  it("refuses a level larger than its row bound", async () => {
    const session = new ScriptedSession();
    await expect(
      readCompleteBrowseLevel(
        session,
        page([row("a", "k1")], 101, 0),
        options({ maxRows: 100 })
      )
    ).rejects.toThrow("test level reported an invalid total");
  });

  it("reports an over-bound level through the caller's own outcome when it has one", async () => {
    // `DiscographyResolver` distinguishes "this list is too big" from "this
    // list is malformed", because they are different news. A caller without
    // that distinction falls through to the generic refusal.
    const session = new ScriptedSession();
    await expect(
      readCompleteBrowseLevel(
        session,
        page([row("a", "k1")], 101, 0),
        options({ maxRows: 100, tooLarge: () => new TooLarge("too large") })
      )
    ).rejects.toBeInstanceOf(TooLarge);
  });

  it("refuses a level needing more pages than the caller allowed", async () => {
    // No production caller can reach this today: every one of them derives its
    // page bound from its row bound, so the row bound refuses first. It is
    // covered here so the rule is proven rather than assumed, and so a future
    // caller with a tighter page bound gets the behaviour it asked for.
    const session = new ScriptedSession();
    await expect(
      readCompleteBrowseLevel(
        session,
        page([row("a", "k1"), row("b", "k2")], 10, 0),
        options({ maxRows: 100, maxPages: 2 })
      )
    ).rejects.toThrow("test level exceeded its page bound");
  });

  // The final tally — "assembled N of M rows" — has deliberately no test here,
  // and the reason is worth writing down rather than leaving as a gap in the
  // list. Every page is already checked to carry exactly the rows its offset
  // and total imply, and the loop covers every offset, so the sum is total by
  // construction: no input can reach that refusal. It is kept as a backstop
  // for a future change to the paging arithmetic, not because anything today
  // can trip it. A test would have to defeat the per-page checks to get there,
  // and would then be proving something about the test rather than the reader.

  it("stops at the first checkpoint after an await when the caller has moved on", async () => {
    // Every await is a place the page may already have been superseded. The
    // read stops there rather than spending the rest of the level on an answer
    // nobody is waiting for.
    const session = new ScriptedSession();
    session.load
      .mockResolvedValueOnce(page([row("c", "k3"), row("d", "k4")], 6, 2))
      .mockResolvedValueOnce(page([row("e", "k5"), row("f", "k6")], 6, 4));
    let calls = 0;

    await expect(
      readCompleteBrowseLevel(
        session,
        page([row("a", "k1"), row("b", "k2")], 6, 0),
        options({
          assertCurrent: () => {
            calls += 1;
            throw new Error("superseded");
          },
        })
      )
    ).rejects.toThrow("superseded");

    expect(calls).toBe(1);
    expect(session.load).toHaveBeenCalledTimes(1);
  });
});
