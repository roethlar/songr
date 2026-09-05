/**
 * The structural proof for `.agents/plans/library-walk-binding.md` Slice 7.
 *
 * Every other test in this repository proves a behavior. This one proves an
 * ABSENCE, which behavioral tests are bad at: a deleted join leaves no
 * failing assertion behind when somebody writes it again, and the next
 * plausible-looking name match compiles, passes, and quietly puts one
 * artist's records on another artist's page — which is exactly the failure
 * this plan spent its slices removing.
 *
 * So this reads the source. It is a grep with a reason attached, and it is
 * deliberately literal: it names the symbols that were deleted and the call
 * sites that are allowed to remain, and it fails when either list grows.
 *
 * WHAT IT IS NOT. It cannot prove the invariant — nobody can grep for "this
 * comparison is between two surfaces". It proves that the specific things
 * this plan removed stayed removed. Every join the plan named is now gone,
 * so nothing here is an allowance any more; each assertion is an absence.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..");

/**
 * Tracked files, from git rather than a directory walk.
 *
 * The same source the publication gates take their file list from, and for
 * the same reason: a scratch copy, a build output or an untracked
 * experiment must not be able to make this pass or fail.
 */
function trackedSources(predicate: (path: string) => boolean): string[] {
  const stdout = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean).filter(predicate);
}

function isProductionSource(path: string): boolean {
  if (!/\.(ts|svelte)$/u.test(path)) return false;
  if (!path.startsWith("src/") && !path.startsWith("ui/src/")) return false;
  return !/(^|\/)__tests__\//u.test(path) && !/\.test\.ts$/u.test(path);
}

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * Source with its comments removed.
 *
 * Every assertion below is about what the code DOES, and a file explaining
 * which join it no longer performs necessarily names that join. Scanning the
 * raw text would make writing the explanation the thing that fails, which
 * would teach the next author to delete the explanation.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

function filesContaining(needle: string, paths: string[]): string[] {
  return paths.filter((path) => code(path).includes(needle));
}

describe("cross-surface name joins stay deleted (Slice 7)", () => {
  const production = trackedSources(isProductionSource);

  it("finds production sources to scan at all", () => {
    // A scan over an empty list passes every assertion below while proving
    // nothing. This is the guard against that. The floor was 200 until the
    // private build was deleted (2026-09-04) and the tree shrank to 186
    // production sources; it is set below the current count, not at it, so
    // ordinary churn does not turn a real scan into a failing one.
    expect(production.length).toBeGreaterThan(150);
    expect(production).toContain("ui/src/lib/libraryEntries.ts");
    expect(production).toContain("src/core/roon/CollectionDrillResolver.ts");
  });

  it("has no display-name folding helper anywhere in the UI", () => {
    // `foldCatalogNameKey` folded typographic variants — U+2019 against
    // U+0027, en dash against hyphen — so an artist row and an album credit
    // line could be compared as if they were one surface. Deleted with its
    // last caller; a reintroduction is a reintroduction of the join.
    expect(filesContaining("foldCatalogNameKey", production)).toEqual([]);
  });

  it("keeps no saved library model to join anything against", () => {
    // The strongest form of this proof, and the one Slice 4 bought: there is no
    // stored library on either side any more, so a name join has nothing left
    // to join TO. These paths are gone, and a tracked file appearing at one of
    // them again is a saved model coming back.
    for (const path of [
      "src/core/catalog/CatalogService.ts",
      "src/core/catalog/CatalogReconciliation.ts",
      "src/shared/catalogIndexContracts.ts",
      "src/shared/artistAlbumWalkContracts.ts",
      "ui/src/lib/stores/libraryIndexStore.ts",
    ]) {
      expect(production).not.toContain(path);
    }
    // And no production source reaches for anything they exported: the count
    // queue and its repair, the walk's attachment rule, the snapshot itself.
    expect(filesContaining("CatalogSnapshot", production)).toEqual([]);
    expect(filesContaining("artistCountQueues", production)).toEqual([]);
    expect(filesContaining("knownAlbumCount", production)).toEqual([]);
    expect(filesContaining("attachArtistAlbumListsToRoot", production)).toEqual([]);
  });

  it("gives a browse row no borrowed identity by matching its text", () => {
    // A collection drill's live rows were looked up in the stored catalog by
    // normalized title and artist, and whatever the lookup found — identity,
    // artist, version count, release dates — was pinned onto the live row.
    // The rows now carry only what the drill showed, so the function that
    // did the pinning is gone by name and no drill row is given a catalog
    // local id anywhere in the store.
    expect(filesContaining("reconcileBrowseAlbumsToCatalog", production)).toEqual(
      []
    );
    // Renderer convergence deleted the classic drill preparation path too.
    // Keeping that symbol absent is stronger than constraining its old
    // parameter list: live rows now flow straight from Roon's level response.
    expect(filesContaining("prepareDrillAlbums", production)).toEqual([]);
  });

  it("has no recently-played artist ranking left to wire", () => {
    // B6c ranked the binding sweep's artists by what had lately been played.
    // Its input was a now-playing display string, so ranking by it was a
    // name match across two surfaces — the careful kind, exact and
    // unique-or-nothing, but still one. It went dormant first and then went
    // with the sweep. It comes back when a backend reports an id with a play
    // event, which is the multi-backend plan.
    expect(filesContaining("recentlyPlayedArtistOrder", production)).toEqual(
      []
    );
  });

  it("has no performer-name search left anywhere", () => {
    // The extended layer's binding pass searched Roon's performer index by
    // an artist's display name, which is a different surface from the
    // Artists root the name was read on. It was the last structural join
    // still standing, and the last source of `album.artistLocalId` outside
    // the walk. The pass is retired, so this is now an absence like the
    // rest, with no allowance attached.
    expect(filesContaining("resolvePerformerName(", production)).toEqual([]);
  });

  it("opens a collection row by its exact rendering, never a folded one", () => {
    // The artist walk's own root match went with the catalog. What is left on
    // this surface is the collection drill, and it is held to the same rule: a
    // row is found by the exact text it rendered, never by a normalized key
    // that could fold two distinguishable rows into one.
    const contracts = code("src/shared/collectionDrillContracts.ts");
    expect(contracts).toContain("readonly exactTitle: string;");
    expect(contracts).not.toContain("normalizedTitle");
  });
});
