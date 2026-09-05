import {
  LIBRARY_LEVEL_ROWS_MAX,
  LIBRARY_OPEN_CONTRACT,
  libraryImpliedChildKind,
  libraryRowKind,
  normalizeLibraryOpenRequest,
  normalizeLibraryOpenResponse,
  normalizeLibraryRowReference,
  type LibraryLevelRow,
} from "../libraryOpenContracts";

/**
 * Names here are invented. Structures are not: every hint, subtitle shape and
 * verb label below was read off the owner's Core on 2026-09-03 by
 * `src/tooling` probe and recorded in `.agents/state.md`.
 */
const GENERATION = "9f1c2e7a-0000-4000-8000-000000000001";

function row(over: Partial<LibraryLevelRow> = {}): LibraryLevelRow {
  return {
    ref: { generation: GENERATION, token: "library-row-a-1" },
    title: "Invented Album",
    kind: "album",
    ...over,
  };
}

function level(over: Record<string, unknown> = {}): Record<string, unknown> {
  const rows = [row()];
  return {
    contract: LIBRARY_OPEN_CONTRACT,
    kind: "level",
    generation: GENERATION,
    title: "Invented Artist",
    count: rows.length,
    rows,
    ...over,
  };
}

describe("libraryOpenContracts", () => {
  describe("normalizeLibraryOpenResponse", () => {
    it("accepts a level whose rows all belong to its generation", () => {
      const parsed = normalizeLibraryOpenResponse(level());
      expect(parsed?.kind).toBe("level");
      if (parsed?.kind !== "level") throw new Error("not a level");
      expect(parsed.generation).toBe(GENERATION);
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].kind).toBe("album");
    });

    it("refuses a level whose row names another generation", () => {
      const rows = [
        row({ ref: { generation: "some-other-generation", token: "t" } }),
      ];
      expect(
        normalizeLibraryOpenResponse(level({ rows, count: rows.length }))
      ).toBeNull();
    });

    it("refuses a level whose count disagrees with its rows", () => {
      expect(normalizeLibraryOpenResponse(level({ count: 2 }))).toBeNull();
    });

    it("refuses a level carrying more rows than the bound", () => {
      expect(
        normalizeLibraryOpenResponse(
          level({ count: LIBRARY_LEVEL_ROWS_MAX + 1 })
        )
      ).toBeNull();
    });

    it("refuses a row whose kind is not one of the known kinds", () => {
      const rows = [{ ...row(), kind: "sculpture" }];
      expect(
        normalizeLibraryOpenResponse(level({ rows, count: rows.length }))
      ).toBeNull();
    });

    it("reads the stale answer, which carries nothing else", () => {
      const parsed = normalizeLibraryOpenResponse({
        contract: LIBRARY_OPEN_CONTRACT,
        kind: "stale",
      });
      expect(parsed).toEqual({
        contract: LIBRARY_OPEN_CONTRACT,
        kind: "stale",
      });
    });

    it("reads each unavailable reason, and refuses an invented one", () => {
      for (const reason of ["no-core", "core-under-pressure", "read-failed"]) {
        const parsed = normalizeLibraryOpenResponse({
          contract: LIBRARY_OPEN_CONTRACT,
          kind: "unavailable",
          reason,
          message: "Not now.",
        });
        expect(parsed?.kind).toBe("unavailable");
      }
      expect(
        normalizeLibraryOpenResponse({
          contract: LIBRARY_OPEN_CONTRACT,
          kind: "unavailable",
          reason: "tired",
          message: "Not now.",
        })
      ).toBeNull();
    });

    it("refuses anything carrying another contract", () => {
      expect(
        normalizeLibraryOpenResponse(level({ contract: "library-open-v2" }))
      ).toBeNull();
    });
  });

  describe("normalizeLibraryOpenRequest", () => {
    it("accepts one reference and drops everything else in the body", () => {
      expect(
        normalizeLibraryOpenRequest({
          ref: { generation: GENERATION, token: "library-row-a-1" },
          itemKey: "should-not-be-here",
        })
      ).toEqual({
        ref: { generation: GENERATION, token: "library-row-a-1" },
      });
    });

    it("refuses a half reference", () => {
      expect(
        normalizeLibraryOpenRequest({ ref: { generation: GENERATION } })
      ).toBeNull();
      expect(normalizeLibraryRowReference({ token: "t" })).toBeNull();
    });
  });

  describe("what a level's rows are", () => {
    it("names each child from the row it was reached through", () => {
      expect(
        libraryImpliedChildKind({ kind: "artist", title: "Invented Artist" })
      ).toBe("album");
      expect(
        libraryImpliedChildKind({ kind: "album", title: "Invented Album" })
      ).toBe("track");
      // Measured, not assumed: a composer drills to compositions on this Core.
      expect(
        libraryImpliedChildKind({ kind: "composer", title: "Invented Composer" })
      ).toBe("composition");
      expect(
        libraryImpliedChildKind({ kind: "composition", title: "Invented Work" })
      ).toBe("track");
      expect(
        libraryImpliedChildKind({ kind: "genre", title: "Invented Genre" })
      ).toBe("genre");
    });

    it("lets a section's own label decide what it holds", () => {
      expect(libraryImpliedChildKind({ kind: "section", title: "Albums" })).toBe(
        "album"
      );
      expect(
        libraryImpliedChildKind({ kind: "section", title: "Artists" })
      ).toBe("artist");
      expect(
        libraryImpliedChildKind({ kind: "section", title: "Something Else" })
      ).toBe("entry");
    });

    it("marks Roon's verb rows, which carry no subtitle", () => {
      expect(
        libraryRowKind("album", { title: "Play Album", hint: "action_list" })
      ).toBe("action");
      expect(
        libraryRowKind("album", { title: "Play Artist", hint: "action_list" })
      ).toBe("action");
      expect(libraryRowKind("album", { title: "Anything", hint: "action" })).toBe(
        "action"
      );
    });

    it("keeps a track that has no credited performers", () => {
      // The live shape: an album's track rows carry `action_list` exactly like
      // its Play row does, so the subtitle is not what tells them apart. A
      // track with no subtitle must stay a track — dropping it would shorten a
      // track list the reader is looking at.
      expect(
        libraryRowKind("track", {
          title: "1. Invented Song",
          hint: "action_list",
        })
      ).toBe("track");
      expect(
        libraryRowKind("track", {
          title: "Play Album",
          subtitle: "Invented Artist",
          hint: "action_list",
        })
      ).toBe("track");
    });

    it("finds a genre node's own sections without touching the subgenres", () => {
      expect(
        libraryRowKind("genre", { title: "Albums", hint: "list" })
      ).toBe("section");
      expect(
        libraryRowKind("genre", { title: "Artists", hint: "list" })
      ).toBe("section");
      expect(
        libraryRowKind("genre", {
          title: "Invented Subgenre",
          subtitle: "12 Artists, 40 Albums",
          hint: "list",
        })
      ).toBe("genre");
    });
  });
});
