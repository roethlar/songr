import { LIBRARY_PREVIEW_CONTRACT, libraryGenrePreviewKind,
  normalizeLibraryPreviewRequest, normalizeLibraryPreviewResponse } from "../libraryPreviewContracts";
import { normalizeLibraryOpenResponse } from "../libraryOpenContracts";

const ref = { generation: "g1", token: "section-1" };
const row = { ref: { ...ref, token: "item-1" }, title: "One", kind: "album" };
const preview = { contract: LIBRARY_PREVIEW_CONTRACT, kind: "preview", generation: "g1",
  title: "Albums", totalCount: 10000, limit: 1, rows: [row] };

describe("library preview contract", () => {
  it.each([1, 100])("accepts the bounded request limit %i", limit => {
    expect(normalizeLibraryPreviewRequest({ ref, limit })).toEqual({ ref, limit });
  });
  it.each([0, -1, 101, 1.5, NaN, Infinity, "1", null, undefined])("rejects invalid limit %s", limit => {
    expect(normalizeLibraryPreviewRequest({ ref, limit })).toBeNull();
  });
  it.each([null, [], {}, { ref }, { ref, limit: 1, itemKey: "raw" },
    { ref: { ...ref, key: "raw" }, limit: 1 }, { ref: { generation: "g1" }, limit: 1 },
    { ref: { ...ref, token: "" }, limit: 1 }])("rejects malformed or expanded request %j", body => {
    expect(normalizeLibraryPreviewRequest(body)).toBeNull();
  });
  it("keeps a prefix distinct from a complete level", () => {
    expect(normalizeLibraryPreviewResponse(preview, 1)).toEqual(preview);
    expect(normalizeLibraryOpenResponse(preview)).toBeNull();
    expect(normalizeLibraryPreviewResponse({ ...preview, kind: "level" }, 1)).toBeNull();
  });
  it.each([0, 1, 17, 10000])("requires exactly the bounded prefix of total %i", totalCount => {
    const limit = 100;
    const rows = Array.from({ length: Math.min(limit, totalCount) }, (_, index) => ({
      ...row, ref: { ...ref, token: `item-${index}` }
    }));
    expect(normalizeLibraryPreviewResponse({ ...preview, limit, totalCount, rows }, limit)?.kind).toBe("preview");
  });
  it.each([
    { limit: 2 }, { totalCount: -1 }, { totalCount: 20001 }, { totalCount: 1.5 },
    { rows: [] }, { rows: [row, row] }, { generation: "" }, { title: 8 },
    { rows: [{ ...row, kind: "action" }] }, { rows: [{ ...row, ref: { ...ref, generation: "g2" } }] },
    { rows: [{ ...row, imageKey: 5 }] }, { rows: [{ ...row, subtitle: 8 }] },
    { contract: "library-open-v1" }
  ])("rejects a corrupt prefix %j", over => {
    expect(normalizeLibraryPreviewResponse({ ...preview, ...over }, 1)).toBeNull();
  });
  it("rejects duplicate references and mixed artist/album rows without collapsing duplicate titles", () => {
    expect(normalizeLibraryPreviewResponse({ ...preview, limit: 2, rows: [row, row] }, 2)).toBeNull();
    const other = { ...row, ref: { ...ref, token: "item-2" } };
    expect(normalizeLibraryPreviewResponse({ ...preview, limit: 2, rows: [row, other] }, 2)?.kind).toBe("preview");
    expect(normalizeLibraryPreviewResponse({ ...preview, limit: 2, rows: [row, { ...other, kind: "artist" }] }, 2)).toBeNull();
  });
  it("distinguishes stale from each unavailable outcome", () => {
    expect(normalizeLibraryPreviewResponse({ contract: LIBRARY_PREVIEW_CONTRACT, kind: "stale" }, 1)?.kind).toBe("stale");
    for (const reason of ["no-core", "core-under-pressure", "read-failed"]) {
      expect(normalizeLibraryPreviewResponse({ contract: LIBRARY_PREVIEW_CONTRACT,
        kind: "unavailable", reason, message: "Not now." }, 1)?.kind).toBe("unavailable");
    }
    expect(normalizeLibraryPreviewResponse({ contract: LIBRARY_PREVIEW_CONTRACT,
      kind: "unavailable", reason: "unknown", message: "Not now." }, 1)).toBeNull();
  });
  it("uses the existing structural classification only under genres", () => {
    expect(libraryGenrePreviewKind({ hierarchy: "genres", kind: "section", title: " Artists " })).toBe("artist");
    expect(libraryGenrePreviewKind({ hierarchy: "genres", kind: "section", title: "Albums" })).toBe("album");
    expect(libraryGenrePreviewKind({ hierarchy: "genres", kind: "genre", title: "Albums" })).toBeNull();
    expect(libraryGenrePreviewKind({ hierarchy: "composers", kind: "section", title: "Albums" })).toBeNull();
    expect(libraryGenrePreviewKind({ hierarchy: "genres", kind: "section", title: "Tracks" })).toBeNull();
  });
});
