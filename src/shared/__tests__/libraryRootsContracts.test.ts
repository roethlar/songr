import {
  LIBRARY_INVALIDATION_REASONS,
  LIBRARY_OPAQUE_MAX_LENGTH,
  LIBRARY_ROOTS_CONTRACT,
  LIBRARY_SESSION_RETIRED_CONTRACT,
  normalizeLibrarySessionRetiredEvent,
  normalizeLibraryRootsResponse,
  normalizeLibraryRootsUnavailable,
  parseRoonArtistAlbumCount,
} from "../libraryRootsContracts";

const GENERATION = "11111111-2222-3333-4444-555555555555";

function row(title: string, token: string, over: Record<string, unknown> = {}) {
  return {
    ref: { generation: GENERATION, token },
    title,
    ...over,
  };
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    contract: LIBRARY_ROOTS_CONTRACT,
    kind: "snapshot",
    generation: GENERATION,
    coreId: "core-a",
    readAt: "2026-09-03T00:20:13.190Z",
    artists: {
      count: 2,
      rows: [
        row("Invented Artist A", "t1", { subtitle: "3 Albums", imageKey: "i1" }),
        row("Invented Artist B", "t2", { subtitle: "1 Album" }),
      ],
    },
    albums: {
      count: 1,
      rows: [row("Invented Album", "t3", { subtitle: "Invented Artist A" })],
    },
    ...over,
  };
}

describe("library roots contract", () => {
  it("accepts only exact library retirement events", () => {
    for (const reason of LIBRARY_INVALIDATION_REASONS) {
      expect(
        normalizeLibrarySessionRetiredEvent({
          contract: LIBRARY_SESSION_RETIRED_CONTRACT,
          coreId: "core-a",
          retired: reason === "connect" ? null : GENERATION,
          reason,
        })
      ).toEqual({
        contract: LIBRARY_SESSION_RETIRED_CONTRACT,
        coreId: "core-a",
        retired: reason === "connect" ? null : GENERATION,
        reason,
      });
    }

    const retired = {
      contract: LIBRARY_SESSION_RETIRED_CONTRACT,
      coreId: "core-a",
      retired: GENERATION,
      reason: "session-lost",
    };
    const prototypeBearing = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      retired
    );
    for (const malformed of [
      { ...retired, extra: true },
      { contract: retired.contract, coreId: retired.coreId, retired: GENERATION },
      { ...retired, contract: "library-session-retired-v2" },
      { ...retired, coreId: "" },
      { ...retired, coreId: "x".repeat(LIBRARY_OPAQUE_MAX_LENGTH + 1) },
      { ...retired, retired: "" },
      { ...retired, retired: "x".repeat(LIBRARY_OPAQUE_MAX_LENGTH + 1) },
      { ...retired, reason: "invented" },
      prototypeBearing,
    ]) {
      expect(normalizeLibrarySessionRetiredEvent(malformed)).toBeNull();
    }
  });

  it("accepts a snapshot and keeps Roon's own text", () => {
    const parsed = normalizeLibraryRootsResponse(snapshot());
    expect(parsed).not.toBeNull();
    if (parsed === null || parsed.kind !== "snapshot") throw new Error("no");
    expect(parsed.artists.rows[0]).toEqual({
      ref: { generation: GENERATION, token: "t1" },
      title: "Invented Artist A",
      subtitle: "3 Albums",
      imageKey: "i1",
    });
    expect(parsed.albums.count).toBe(1);
  });

  it("refuses a row whose reference names a different snapshot", () => {
    // The one failure that would let a reader hold a reference the envelope
    // does not vouch for. It is refused whole rather than repaired.
    const payload = snapshot();
    payload.artists.rows[1].ref = { generation: "other-generation", token: "t2" };
    expect(normalizeLibraryRootsResponse(payload)).toBeNull();
  });

  it("refuses a root that disagrees with its own count", () => {
    expect(
      normalizeLibraryRootsResponse(
        snapshot({ albums: { count: 4, rows: [row("One", "t9")] } })
      )
    ).toBeNull();
  });

  it("refuses a row with no reference, an empty token, or no title", () => {
    expect(
      normalizeLibraryRootsResponse(
        snapshot({ albums: { count: 1, rows: [{ title: "No ref" }] } })
      )
    ).toBeNull();
    expect(
      normalizeLibraryRootsResponse(
        snapshot({
          albums: {
            count: 1,
            rows: [{ ref: { generation: GENERATION, token: "" }, title: "x" }],
          },
        })
      )
    ).toBeNull();
    expect(
      normalizeLibraryRootsResponse(
        snapshot({
          albums: {
            count: 1,
            rows: [{ ref: { generation: GENERATION, token: "t" }, title: 7 }],
          },
        })
      )
    ).toBeNull();
  });

  it("keeps an empty title, which Roon is entitled to send", () => {
    const parsed = normalizeLibraryRootsResponse(
      snapshot({ albums: { count: 1, rows: [row("", "t4")] } })
    );
    if (parsed === null || parsed.kind !== "snapshot") throw new Error("no");
    expect(parsed.albums.rows[0].title).toBe("");
  });

  it("refuses another contract version outright", () => {
    expect(
      normalizeLibraryRootsResponse(snapshot({ contract: "library-roots-v2" }))
    ).toBeNull();
    expect(normalizeLibraryRootsResponse(snapshot({ kind: "other" }))).toBeNull();
    expect(normalizeLibraryRootsResponse(null)).toBeNull();
    expect(normalizeLibraryRootsResponse("snapshot")).toBeNull();
  });

  it("accepts the cheap 'still current' answer, which carries no rows", () => {
    const parsed = normalizeLibraryRootsResponse({
      contract: LIBRARY_ROOTS_CONTRACT,
      kind: "current",
      generation: GENERATION,
      coreId: "core-a",
    });
    expect(parsed).toEqual({
      contract: LIBRARY_ROOTS_CONTRACT,
      kind: "current",
      generation: GENERATION,
      coreId: "core-a",
    });
  });

  it("reads the three unavailable reasons and refuses a fourth", () => {
    for (const reason of ["no-core", "core-under-pressure", "read-failed"]) {
      expect(
        normalizeLibraryRootsUnavailable({
          contract: LIBRARY_ROOTS_CONTRACT,
          kind: "unavailable",
          reason,
          message: "A sentence for a reader.",
        })
      ).toMatchObject({ reason });
    }
    expect(
      normalizeLibraryRootsUnavailable({
        contract: LIBRARY_ROOTS_CONTRACT,
        kind: "unavailable",
        reason: "because",
        message: "A sentence for a reader.",
      })
    ).toBeNull();
  });
});

describe("the album count on an Artists row", () => {
  it("reads Roon's own subtitle, including a grouped thousands separator", () => {
    expect(parseRoonArtistAlbumCount("58 Albums")).toBe(58);
    expect(parseRoonArtistAlbumCount("1 Album")).toBe(1);
    expect(parseRoonArtistAlbumCount("1,204 Albums")).toBe(1204);
  });

  it("answers null rather than 0 when the row said nothing", () => {
    // 0 is an answer. Rendering absence as 0 would tell a reader something the
    // library never said.
    expect(parseRoonArtistAlbumCount(undefined)).toBeNull();
    expect(parseRoonArtistAlbumCount("")).toBeNull();
    expect(parseRoonArtistAlbumCount("Albums")).toBeNull();
  });

  it("reads a real zero as zero", () => {
    expect(parseRoonArtistAlbumCount("0 Albums")).toBe(0);
  });
});
