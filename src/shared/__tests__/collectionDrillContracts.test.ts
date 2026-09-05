import { CATALOG_DISPLAY_TEXT_MAX_LENGTH } from "../catalogContracts";
import {
  COLLECTION_DRILL_MAX_ALBUMS,
  COLLECTION_DRILL_SOURCE_CONTRACT,
  CollectionDrillAlbumRendering,
  canonicalCollectionDrillText,
  collectionDrillAlbumIsOpenable,
  collectionDrillOpenLocator,
  collectionDrillCreditFallback,
  collectionDrillRenderingOf,
  collectionDrillRenderingsEqual,
  isCollectionDrillHierarchy,
  normalizeCollectionDrillAlbumRendering,
  normalizeCollectionDrillOpenFailure,
  normalizeCollectionDrillOpenLocator,
  resolveCollectionDrillAlbum,
  resolveCollectionRow,
} from "../collectionDrillContracts";

function rendering(
  exactTitle: string,
  exactCredit = ""
): CollectionDrillAlbumRendering {
  return { exactTitle, exactCredit };
}

describe("collection drill hierarchies", () => {
  it("accepts exactly the hierarchies whose rows drill to an album list", () => {
    expect(isCollectionDrillHierarchy("genres")).toBe(true);
    expect(isCollectionDrillHierarchy("composers")).toBe(true);
    // An artist's discography is one of these drills: a root row, drilled to
    // an album list whose rows carry their own credits. A stored walk row has
    // no catalog identity to open by, and this is the shape that reopens it.
    expect(isCollectionDrillHierarchy("artists")).toBe(true);
  });

  it("rejects the surfaces that are not one row drilled to an album list", () => {
    // A locator is bound to the surface it was read from. `albums` is a flat
    // root of albums, not a collection drilled to one, so a locator resolved
    // against it would be looking for a row that is not there.
    for (const hierarchy of ["albums", "browse", "search", ""]) {
      expect(isCollectionDrillHierarchy(hierarchy)).toBe(false);
    }
    expect(isCollectionDrillHierarchy(undefined)).toBe(false);
    expect(isCollectionDrillHierarchy(null)).toBe(false);
  });
});

describe("collectionDrillRenderingsEqual", () => {
  it("is exact on every rendered field", () => {
    expect(
      collectionDrillRenderingsEqual(
        rendering("Voices", "Alf Linder"),
        rendering("Voices", "Alf Linder")
      )
    ).toBe(true);
    expect(
      collectionDrillRenderingsEqual(
        rendering("Voices", "Alf Linder"),
        rendering("Voices", "Andrew Parrott")
      )
    ).toBe(false);
  });

  it("does not fold typographic variants", () => {
    // U+2019 against U+0027 is the exact pair that made the old binding scheme
    // look correct while merging records the library keeps apart. A comparison
    // that folds is a comparison that guesses.
    expect(
      collectionDrillRenderingsEqual(
        rendering("’Til Tuesday", "Ellery Vance"),
        rendering("'Til Tuesday", "Ellery Vance")
      )
    ).toBe(false);
  });

  it("does not fold case", () => {
    expect(
      collectionDrillRenderingsEqual(rendering("Voices"), rendering("voices"))
    ).toBe(false);
  });

  it("treats an absent credit as its own value, not a wildcard", () => {
    expect(
      collectionDrillRenderingsEqual(rendering("Voices", ""), rendering("Voices", "Alf Linder"))
    ).toBe(false);
    expect(
      collectionDrillRenderingsEqual(rendering("Voices", ""), rendering("Voices", ""))
    ).toBe(true);
  });
});

describe("resolveCollectionRow", () => {
  const root = (...names: string[]) =>
    names.map((exactName) => ({ exactName, exactSubtitle: "" }));

  it("resolves a unique collection row to its position", () => {
    expect(resolveCollectionRow(root("Ambient", "Baroque", "Jazz"), { exactName: "Baroque" })).toEqual({
      kind: "resolved",
      index: 1,
    });
  });

  it("reports missing with the count it observed", () => {
    expect(resolveCollectionRow(root("Ambient", "Jazz"), { exactName: "Baroque" })).toEqual({
      kind: "missing",
      matchCount: 0,
    });
  });

  it("refuses a repeated collection name rather than taking the first", () => {
    expect(
      resolveCollectionRow(root("Baroque", "Jazz", "Baroque"), { exactName: "Baroque" })
    ).toEqual({ kind: "ambiguous", matchCount: 2 });
  });

  it("counts every duplicate, not just the first two", () => {
    expect(
      resolveCollectionRow(root("Jazz", "Jazz", "Jazz"), { exactName: "Jazz" })
    ).toEqual({ kind: "ambiguous", matchCount: 3 });
  });

  it("finds nothing in an empty root", () => {
    expect(resolveCollectionRow([], { exactName: "Baroque" })).toEqual({
      kind: "missing",
      matchCount: 0,
    });
  });
});

describe("resolveCollectionDrillAlbum", () => {
  const rows = [
    rendering("Voices", "Alf Linder"),
    rendering("Vespers", "Andrew Parrott"),
    rendering("Voices", "Olle Persson"),
  ];

  it("resolves on the whole rendering, not the title alone", () => {
    // Two rows share a title here. Comparing the composite still resolves
    // them; a title-only comparison would have to call both ambiguous.
    expect(resolveCollectionDrillAlbum(rows, rendering("Voices", "Olle Persson"))).toEqual(
      { kind: "resolved", index: 2 }
    );
  });

  it("reports an album that left the collection as missing", () => {
    expect(
      resolveCollectionDrillAlbum(rows, rendering("Voices", "Ann Monoyios"))
    ).toEqual({ kind: "missing", matchCount: 0 });
  });

  it("refuses two rows it cannot tell apart", () => {
    const twins = [
      rendering("Vespers", "Andrew Parrott"),
      rendering("Vespers", "Andrew Parrott"),
    ];
    expect(
      resolveCollectionDrillAlbum(twins, rendering("Vespers", "Andrew Parrott"))
    ).toEqual({ kind: "ambiguous", matchCount: 2 });
  });
});

describe("collectionDrillAlbumIsOpenable", () => {
  it("marks a row unique within its own drill as openable", () => {
    const rows = [rendering("Voices", "Alf Linder"), rendering("Vespers", "Andrew Parrott")];
    expect(collectionDrillAlbumIsOpenable(rows, 0)).toBe(true);
    expect(collectionDrillAlbumIsOpenable(rows, 1)).toBe(true);
  });

  it("marks a rendering that repeats inside the same drill as non-openable", () => {
    // Re-drilling returns the same two rows and cannot break the tie either,
    // so the card says so before anyone clicks it rather than after.
    const rows = [
      rendering("Vespers", "Andrew Parrott"),
      rendering("Vespers", "Andrew Parrott"),
    ];
    expect(collectionDrillAlbumIsOpenable(rows, 0)).toBe(false);
    expect(collectionDrillAlbumIsOpenable(rows, 1)).toBe(false);
  });

  it("is false for an index that names no row", () => {
    expect(collectionDrillAlbumIsOpenable([rendering("Voices")], 1)).toBe(false);
    expect(collectionDrillAlbumIsOpenable([], 0)).toBe(false);
    expect(collectionDrillAlbumIsOpenable([rendering("Voices")], -1)).toBe(false);
  });
});

describe("collectionDrillOpenLocator", () => {
  const rows = [rendering("Voices", "Alf Linder"), rendering("Vespers", "Andrew Parrott")];

  it("carries the hierarchy, the collection and the row's rendering", () => {
    expect(collectionDrillOpenLocator("genres", { exactName: "Baroque" }, rows, 1)).toEqual({
      sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
      hierarchy: "genres",
      collectionExactName: "Baroque",
      rendering: { exactTitle: "Vespers", exactCredit: "Andrew Parrott" },
    });
  });

  it("keeps the two hierarchies apart", () => {
    const genre = collectionDrillOpenLocator("genres", { exactName: "Baroque" }, rows, 0);
    const composer = collectionDrillOpenLocator("composers", { exactName: "Baroque" }, rows, 0);
    expect(genre?.hierarchy).toBe("genres");
    expect(composer?.hierarchy).toBe("composers");
    expect(genre).not.toEqual(composer);
  });

  it("carries no key, no index and no image hint", () => {
    // Every one of those would be either session-bound or a tie-break. The
    // locator is durable precisely because it holds none of them.
    const locator = collectionDrillOpenLocator("genres", { exactName: "Baroque" }, rows, 0);
    expect(Object.keys(locator ?? {}).sort()).toEqual([
      "collectionExactName",
      "hierarchy",
      "rendering",
      "sourceContract",
    ]);
    expect(Object.keys(locator?.rendering ?? {}).sort()).toEqual([
      "exactCredit",
      "exactTitle",
    ]);
  });

  it("is null for an index that names no row", () => {
    expect(collectionDrillOpenLocator("genres", { exactName: "Baroque" }, rows, 2)).toBeNull();
    expect(collectionDrillOpenLocator("genres", { exactName: "Baroque" }, [], 0)).toBeNull();
  });
});

describe("normalizeCollectionDrillAlbumRendering", () => {
  it("accepts a canonical rendering, with or without a credit", () => {
    expect(
      normalizeCollectionDrillAlbumRendering({
        exactTitle: "Voices",
        exactCredit: "Alf Linder",
      })
    ).toEqual({ exactTitle: "Voices", exactCredit: "Alf Linder" });
    expect(
      normalizeCollectionDrillAlbumRendering({ exactTitle: "Voices", exactCredit: "" })
    ).toEqual({ exactTitle: "Voices", exactCredit: "" });
  });

  it("refuses a title that is empty or non-canonical", () => {
    expect(
      normalizeCollectionDrillAlbumRendering({ exactTitle: "", exactCredit: "" })
    ).toBeNull();
    expect(
      normalizeCollectionDrillAlbumRendering({ exactTitle: " Voices", exactCredit: "" })
    ).toBeNull();
    expect(
      normalizeCollectionDrillAlbumRendering({ exactTitle: "Voi  ces", exactCredit: "" })
    ).toBeNull();
  });

  it("refuses control characters", () => {
    expect(
      normalizeCollectionDrillAlbumRendering({
        exactTitle: "Voices\u0007",
        exactCredit: "",
      })
    ).toBeNull();
    expect(
      normalizeCollectionDrillAlbumRendering({
        exactTitle: "Voices",
        exactCredit: "Alf\u0000Linder",
      })
    ).toBeNull();
  });

  it("refuses extra or missing keys", () => {
    expect(
      normalizeCollectionDrillAlbumRendering({
        exactTitle: "Voices",
        exactCredit: "",
        imageKey: "abc",
      })
    ).toBeNull();
    expect(normalizeCollectionDrillAlbumRendering({ exactTitle: "Voices" })).toBeNull();
  });

  it("refuses anything that is not a plain record", () => {
    for (const value of [null, undefined, 7, "Voices", [], new Date()]) {
      expect(normalizeCollectionDrillAlbumRendering(value)).toBeNull();
    }
  });
});

describe("normalizeCollectionDrillOpenLocator", () => {
  const valid = {
    sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
    hierarchy: "genres",
    collectionExactName: "Baroque",
    rendering: { exactTitle: "Vespers", exactCredit: "Andrew Parrott" },
  };

  it("accepts a well-formed locator", () => {
    expect(normalizeCollectionDrillOpenLocator(valid)).toEqual(valid);
  });

  it("refuses another contract's record", () => {
    expect(
      normalizeCollectionDrillOpenLocator({
        ...valid,
        sourceContract: "controller-walk-artist-albums-v1",
      })
    ).toBeNull();
  });

  it("refuses a hierarchy that is not one this locator can be walked in", () => {
    // The hierarchy is part of the locator's identity: `artists` is carried
    // here now, and a locator minted in it must still never be resolved
    // against `albums`, where there is no collection row to descend through.
    expect(
      normalizeCollectionDrillOpenLocator({ ...valid, hierarchy: "albums" })
    ).toBeNull();
    expect(
      normalizeCollectionDrillOpenLocator({ ...valid, hierarchy: "browse" })
    ).toBeNull();
    expect(
      normalizeCollectionDrillOpenLocator({ ...valid, hierarchy: "artists" })
    ).toMatchObject({ hierarchy: "artists" });
  });

  it("refuses an empty or non-canonical collection name", () => {
    expect(
      normalizeCollectionDrillOpenLocator({ ...valid, collectionExactName: "" })
    ).toBeNull();
    expect(
      normalizeCollectionDrillOpenLocator({ ...valid, collectionExactName: "Baroque " })
    ).toBeNull();
  });

  it("refuses a malformed rendering", () => {
    expect(
      normalizeCollectionDrillOpenLocator({
        ...valid,
        rendering: { exactTitle: "", exactCredit: "" },
      })
    ).toBeNull();
    expect(
      normalizeCollectionDrillOpenLocator({ ...valid, rendering: null })
    ).toBeNull();
  });

  it("refuses extra keys", () => {
    expect(
      normalizeCollectionDrillOpenLocator({ ...valid, itemKey: "opaque-token" })
    ).toBeNull();
  });

  it("round-trips through JSON, because page state persists it", () => {
    const locator = normalizeCollectionDrillOpenLocator(valid);
    expect(normalizeCollectionDrillOpenLocator(JSON.parse(JSON.stringify(locator)))).toEqual(
      valid
    );
  });
});

describe("normalizeCollectionDrillOpenFailure", () => {
  it("accepts each stage with a count that agrees with its reason", () => {
    expect(
      normalizeCollectionDrillOpenFailure({
        kind: "missing",
        stage: "collection",
        matchCount: 0,
      })
    ).toEqual({ kind: "missing", stage: "collection", matchCount: 0 });
    expect(
      normalizeCollectionDrillOpenFailure({
        kind: "ambiguous",
        stage: "entry",
        matchCount: 2,
      })
    ).toEqual({ kind: "ambiguous", stage: "entry", matchCount: 2 });
  });

  it("refuses a count that contradicts the reason", () => {
    // There must be nowhere in this shape to put a fabricated number: a
    // surface that read "two rows match" over an answer that found none would
    // be reporting something nobody observed.
    expect(
      normalizeCollectionDrillOpenFailure({
        kind: "missing",
        stage: "entry",
        matchCount: 2,
      })
    ).toBeNull();
    expect(
      normalizeCollectionDrillOpenFailure({
        kind: "ambiguous",
        stage: "entry",
        matchCount: 0,
      })
    ).toBeNull();
    expect(
      normalizeCollectionDrillOpenFailure({
        kind: "ambiguous",
        stage: "entry",
        matchCount: 1,
      })
    ).toBeNull();
  });

  it("refuses a resolved kind, which is not a failure", () => {
    expect(
      normalizeCollectionDrillOpenFailure({
        kind: "resolved",
        stage: "entry",
        matchCount: 1,
      })
    ).toBeNull();
  });

  it("refuses an unknown stage", () => {
    expect(
      normalizeCollectionDrillOpenFailure({
        kind: "missing",
        stage: "artist",
        matchCount: 0,
      })
    ).toBeNull();
  });

  it("refuses a count that is not a whole non-negative number", () => {
    for (const matchCount of [-1, 1.5, Number.NaN, "0", null]) {
      expect(
        normalizeCollectionDrillOpenFailure({
          kind: "missing",
          stage: "collection",
          matchCount,
        })
      ).toBeNull();
    }
  });
});

describe("canonicalCollectionDrillText", () => {
  it("collapses whitespace and normalizes to the one comparable form", () => {
    expect(canonicalCollectionDrillText("  Voices  ")).toBe("Voices");
    expect(canonicalCollectionDrillText("Two  Spaces")).toBe("Two Spaces");
    // NFD "e" + combining acute must land on the same string as NFC "é", or
    // one reader would store a row the other could never find.
    expect(canonicalCollectionDrillText("Cafe\u0301")).toBe("Caf\u00e9");
  });

  it("produces text its own normalizer accepts", () => {
    // The two must agree by construction: anything this returns is fed
    // straight into a locator, and a locator that failed validation on its own
    // canonical output would make every such row permanently unopenable.
    for (const raw of ["  Voices  ", "Two  Spaces", "Cafe\u0301", "’Til Tuesday"]) {
      const canonical = canonicalCollectionDrillText(raw) as string;
      expect(
        normalizeCollectionDrillAlbumRendering({
          exactTitle: canonical,
          exactCredit: "",
        })
      ).toEqual({ exactTitle: canonical, exactCredit: "" });
    }
  });

  it("does not fold what only a guess could fold", () => {
    // Canonicalization is not folding: case and typographic variants survive,
    // because merging them is what put one artist's records on another's page.
    expect(canonicalCollectionDrillText("’Til Tuesday")).toBe("’Til Tuesday");
    expect(canonicalCollectionDrillText("'Til Tuesday")).toBe("'Til Tuesday");
    expect(canonicalCollectionDrillText("VOICES")).toBe("VOICES");
  });

  it("returns null for text that cannot serve as a rendering", () => {
    for (const value of ["", "   ", undefined, null, 7, "Voices\u0007"]) {
      expect(canonicalCollectionDrillText(value)).toBeNull();
    }
    expect(
      canonicalCollectionDrillText("x".repeat(CATALOG_DISPLAY_TEXT_MAX_LENGTH + 1))
    ).toBeNull();
  });
});

describe("collectionDrillRenderingOf", () => {
  it("reads a row's title and subtitle into the comparable form", () => {
    expect(collectionDrillRenderingOf("  Voices ", " Alf Linder ")).toEqual({
      exactTitle: "Voices",
      exactCredit: "Alf Linder",
    });
  });

  it("records an absent credit as absent rather than substituting one", () => {
    for (const subtitle of [undefined, null, "", "   "]) {
      expect(collectionDrillRenderingOf("Voices", subtitle)).toEqual({
        exactTitle: "Voices",
        exactCredit: "",
      });
    }
  });

  it("substitutes the level's own fallback for a credit-less row when it has one", () => {
    // The artists level has one: `DiscographyResolver` publishes an `AlbumRef`
    // from it and that shape rejects an empty artist, so a credit-less row is
    // rendered as the browsed artist by every reader of that level. This
    // reader has to agree or a stored credit-less entry could never be found
    // again in its own drill.
    for (const subtitle of [undefined, null, "", "   "]) {
      expect(
        collectionDrillRenderingOf("Voices", subtitle, "Alf Linder")
      ).toEqual({ exactTitle: "Voices", exactCredit: "Alf Linder" });
    }
    // A credit the row actually rendered always wins over the fallback.
    expect(
      collectionDrillRenderingOf("Voices", "Vera Solberg", "Alf Linder")
    ).toEqual({ exactTitle: "Voices", exactCredit: "Vera Solberg" });
  });

  it("names the artists level as the only one that substitutes", () => {
    expect(collectionDrillCreditFallback("artists", "Alf Linder")).toBe(
      "Alf Linder"
    );
    // A genre is not a credit. Substituting one would say Roon credited this
    // album to "Baroque", which it never did.
    expect(collectionDrillCreditFallback("genres", "Baroque")).toBeUndefined();
    expect(
      collectionDrillCreditFallback("composers", "Alf Linder")
    ).toBeUndefined();
  });

  it("is null for a row with no usable title", () => {
    // A row nobody can render cannot be located again either, so it is neither
    // offered as an openable card nor counted as a rival for uniqueness.
    for (const title of [undefined, null, "", "   ", 7]) {
      expect(collectionDrillRenderingOf(title, "Alf Linder")).toBeNull();
    }
  });

  it("makes both readers of one row agree exactly", () => {
    // The surface mints a locator from the row it rendered; the server re-reads
    // the same row later. Same input, same output, or the open reports missing
    // about two strings rather than about the library.
    const fromSurface = collectionDrillRenderingOf("Two  Spaces", "Cafe\u0301");
    const fromServer = collectionDrillRenderingOf("Two Spaces", "Caf\u00e9");
    expect(fromSurface).toEqual(fromServer);
    expect(collectionDrillRenderingsEqual(fromSurface!, fromServer!)).toBe(true);
  });
});

describe("collection drill bounds", () => {
  it("bounds one drill read at the size the UI already pages to", () => {
    // The two must stay equal: a card rendered past the server's bound would
    // fail to open with `missing`, a true statement about a truncated read and
    // a false one about the library.
    expect(COLLECTION_DRILL_MAX_ALBUMS).toBe(10_000);
  });
});
