import type { BrowseItem } from "../../shared/types";
import {
  censusIdenticalRenderings,
  censusSubtitleDigits,
  holdRow,
  memoryDelta,
  renderingKey,
  sharedRenderingKeys,
  summarizeRootRowShape,
} from "../libraryRootScaleProbe";

function row(over: Partial<BrowseItem> = {}): BrowseItem {
  return {
    title: "Invented Title",
    itemKey: "key-1",
    hint: "list",
    isLoadable: true,
    isPlayable: false,
    ...over,
  };
}

describe("library root scale probe — rendering keys", () => {
  it("keeps a field boundary that a space would erase", () => {
    // The census counts rows Roon renders identically. A key that joined its
    // fields with a space would report `title: "A B"` (no subtitle) and
    // `title: "A", subtitle: "B"` as the same rendering, inventing a duplicate
    // in a library that has none.
    expect(renderingKey(["A B", undefined])).not.toBe(renderingKey(["A", "B"]));
  });

  it("distinguishes a missing field from an empty one", () => {
    // A row Roon sent no subtitle for is not a row whose subtitle is blank.
    expect(renderingKey(["A", undefined])).not.toBe(renderingKey(["A", ""]));
  });

  it("treats identical bytes as identical, and near-misses as different", () => {
    expect(renderingKey(["Björk", "58 Albums"])).toBe(
      renderingKey(["Björk", "58 Albums"])
    );
    // U+2019 against U+0027 in a credit is the live difference this repo has
    // already been bitten by; exact comparison must see it.
    expect(renderingKey(["Voices Carry", "’Til Tuesday"])).not.toBe(
      renderingKey(["Voices Carry", "'Til Tuesday"])
    );
  });
});

describe("library root scale probe — identical-rendering census", () => {
  it("counts renderings and the rows inside them, not just groups", () => {
    const census = censusIdenticalRenderings([
      "a",
      "a",
      "b",
      "c",
      "c",
      "c",
      "d",
    ]);
    expect(census).toEqual({
      rows: 7,
      distinct: 4,
      sharedRenderings: 2,
      rowsSharingARendering: 5,
      largestGroup: 3,
    });
  });

  it("reports nothing shared when every rendering is unique", () => {
    expect(censusIdenticalRenderings(["a", "b", "c"])).toEqual({
      rows: 3,
      distinct: 3,
      sharedRenderings: 0,
      rowsSharingARendering: 0,
      largestGroup: 1,
    });
  });

  it("answers an empty root without inventing a group", () => {
    expect(censusIdenticalRenderings([])).toEqual({
      rows: 0,
      distinct: 0,
      sharedRenderings: 0,
      rowsSharingARendering: 0,
      largestGroup: 0,
    });
  });

  it("lists only the keys more than one row carries", () => {
    expect(sharedRenderingKeys(["a", "b", "a", "c", "c"])).toEqual(["a", "c"]);
    expect(sharedRenderingKeys(["a", "b"])).toEqual([]);
  });
});

describe("library root scale probe — row shape", () => {
  it("separates hints, keys and optional fields", () => {
    const shape = summarizeRootRowShape([
      row(),
      row({ hint: "action_list", subtitle: "" }),
      row({ hint: undefined, itemKey: undefined }),
      row({ hint: "action", isPlayable: true, imageKey: "img", subtitle: "x" }),
      row({ itemType: "album", subtitle: "credit" }),
    ]);
    expect(shape).toEqual({
      rows: 5,
      withItemKey: 4,
      hintList: 2,
      hintActionList: 1,
      hintOther: 1,
      hintAbsent: 1,
      withSubtitle: 3,
      emptySubtitle: 1,
      withImageKey: 1,
      withItemType: 1,
      playable: 1,
    });
  });

  it("counts an empty-string item key as no key", () => {
    // `readCompleteBrowseLevel` refuses a level with a keyless row, so a root
    // whose rows carry empty keys is a finding, not a rounding error.
    expect(summarizeRootRowShape([row({ itemKey: "" })]).withItemKey).toBe(0);
  });
});

describe("library root scale probe — subtitle census", () => {
  it("separates absent, empty, digit-bearing and digit-free subtitles", () => {
    expect(
      censusSubtitleDigits([
        row({ subtitle: "58 Albums" }),
        row({ subtitle: "1 Album" }),
        row({ subtitle: "Albums" }),
        row({ subtitle: "" }),
        row({ subtitle: undefined }),
      ])
    ).toEqual({
      rows: 5,
      absent: 1,
      empty: 1,
      withDigits: 2,
      withoutDigits: 1,
    });
  });
});

describe("library root scale probe — held rows and memory", () => {
  it("holds only the fields the session model will hold", () => {
    const held = holdRow(
      row({
        subtitle: "58 Albums",
        imageKey: "img",
        itemType: "artist",
        inputPrompt: "prompt",
      })
    );
    expect(held).toEqual({
      itemKey: "key-1",
      title: "Invented Title",
      subtitle: "58 Albums",
      imageKey: "img",
      hint: "list",
    });
  });

  it("omits absent fields rather than storing undefined", () => {
    expect(Object.keys(holdRow(row({ hint: undefined })))).toEqual([
      "itemKey",
      "title",
    ]);
  });

  it("subtracts memory samples field by field", () => {
    expect(
      memoryDelta(
        { rssBytes: 100, heapUsedBytes: 40, externalBytes: 5 },
        { rssBytes: 180, heapUsedBytes: 65, externalBytes: 4 }
      )
    ).toEqual({ rssBytes: 80, heapUsedBytes: 25, externalBytes: -1 });
  });
});
