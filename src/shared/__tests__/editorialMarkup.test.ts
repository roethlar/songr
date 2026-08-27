import { stripEditorialMarkup } from "../editorialMarkup";

describe("stripEditorialMarkup", () => {
  it("reduces a well-formed link run to its display label and drops the id", () => {
    expect(stripEditorialMarkup("A protégé of [Miles Davis](1234567).")).toBe(
      "A protégé of Miles Davis."
    );
  });

  it("strips every run in prose with several links", () => {
    const stripped = stripEditorialMarkup(
      "[Nils Frahm](1001) recorded with [Ólafur Arnalds](1002) at [Durton Studio](1003)."
    );
    expect(stripped).toBe(
      "Nils Frahm recorded with Ólafur Arnalds at Durton Studio."
    );
    expect(stripped).not.toContain("[");
    expect(stripped).not.toContain("1001");
  });

  it("passes markup-free prose through unchanged", () => {
    const text = "A quiet, patient record (2018) [sic] — brackets as prose.";
    expect(stripEditorialMarkup(text)).toBe(text);
  });

  it("leaves an unclosed bracket run without a paren tail as-is", () => {
    const text = "An [unclosed link and a [Closed](42) inside.";
    expect(stripEditorialMarkup(text)).toBe(
      "An [unclosed link and a Closed inside."
    );
  });

  it("drops an empty-label run entirely, destination included (q1-3)", () => {
    const stripped = stripEditorialMarkup("Empty [](1234567) label run.");
    expect(stripped).toBe("Empty  label run.");
    expect(stripped).not.toContain("1234567");
  });

  it("drops an empty destination and keeps the label (q1-3)", () => {
    expect(stripEditorialMarkup("Empty [label]() id run.")).toBe(
      "Empty label id run."
    );
  });

  it("neutralizes nested-bracket runs: the label survives, never the id (q1-3)", () => {
    const stripped = stripEditorialMarkup("Nested [[Miles Davis]](1234567) brackets.");
    expect(stripped).toBe("Nested Miles Davis brackets.");
    expect(stripped).not.toContain("1234567");
    expect(stripped).not.toContain("[");
  });

  it("drops the unclosed destination tail of a link-shaped run (q1-3)", () => {
    // An unclosed `(...` tail is suspect from the opener onward: the run
    // loses everything from `(` to the next `)` or the end of the text.
    const stripped = stripEditorialMarkup("An unclosed [Miles Davis](1234567 tail.");
    expect(stripped).toBe("An unclosed Miles Davis");
    expect(stripped).not.toContain("1234567");
    expect(stripped).not.toContain("(");
  });

  it("drops a dangling close with its destination (q1-3)", () => {
    const stripped = stripEditorialMarkup("A stray ](55) with no opener.");
    expect(stripped).toBe("A stray  with no opener.");
    expect(stripped).not.toContain("55");
  });

  it("drops a nested-parenthesis dangling run, token included (q1-3)", () => {
    // The paren run is consumed by depth, so `]((1234567))` loses the
    // whole destination instead of leaking `(1234567))`.
    const stripped = stripEditorialMarkup("A stray ]((1234567)) with no opener.");
    expect(stripped).toBe("A stray  with no opener.");
    expect(stripped).not.toContain("1234567");
  });

  it("drops a nested-parenthesis destination after an opener (q1-3)", () => {
    const stripped = stripEditorialMarkup("Nested [a]((1234567)) parens.");
    expect(stripped).toBe("Nested a parens.");
    expect(stripped).not.toContain("1234567");
    expect(stripped).not.toContain("(");
  });

  it(
    "runs in linear time over worst-case opener runs (q1-3)",
    () => {
      // Editorial text permits 262,144 chars; a near-miss opener run at
      // that bound must not stall the sanitizer. With the reverted regex
      // passes this input takes ~85s (quadratic backtracking) and blows
      // the 10s budget; the scanner is one O(n) pass.
      const brackets = "[".repeat(262_144);
      expect(stripEditorialMarkup(brackets)).toBe(brackets);
      // A link-shaped run at scale: the well-formed pass drops the id,
      // the scanner passes the bracket-only prefix through verbatim.
      const linkRun = "[".repeat(100_000) + "x](1234567)";
      const stripped = stripEditorialMarkup(linkRun);
      expect(stripped).toBe("[".repeat(99_999) + "x");
      expect(stripped).not.toContain("1234567");
    },
    10_000
  );

  it("reduces the well-formed [[id[Label]] run to its label, dropping the id (Q12)", () => {
    // The exact live-observed forms (2026-08-16, core "Q" album reviews).
    expect(stripEditorialMarkup("On [[2289530[Chairlift]]'s sophomore album,")).toBe(
      "On Chairlift's sophomore album,"
    );
    expect(stripEditorialMarkup("[[3051898[Caroline Polacheck]]'s pretty")).toBe(
      "Caroline Polacheck's pretty"
    );
  });

  it("keeps ordinary parens adjacent to a doubled link run (Q12)", () => {
    expect(stripEditorialMarkup("links ([[2289530[Chairlift]]) adjacency")).toBe(
      "links (Chairlift) adjacency"
    );
  });

  it("fails closed on malformed doubled-link variants without leaking the id (Q12)", () => {
    for (const [input, expected] of [
      // Unclosed: one or both closers missing — the label survives, the id
      // and every bracket of the run do not.
      ["unclosed [[2289530[Chairlift] tail", "unclosed Chairlift tail"],
      ["unclosed [[2289530[Chairlift", "unclosed Chairlift"],
      // Empty label: the whole run is dropped, brackets included.
      ["empty label [[2289530[]] run", "empty label  run"],
      // Empty id: no id token exists; the run is ordinary bracket text.
      ["empty id [[[Chairlift]]] run", "empty id [[[Chairlift]]] run"],
      // Doubled inner opener: the id is dropped; the run is consumed
      // through its doubled close without resuming from inside it (q12-2).
      ["doubled [[2289530[[Chairlift]] inner", "doubled  inner"],
      // Nested opener inside the label: the id never survives and no
      // bracket residue remains (q12-2).
      ["nested [[2289530[la[bl]]] deep", "nested la deep"],
    ] as const) {
      const stripped = stripEditorialMarkup(input);
      expect(stripped).toBe(expected);
      expect(stripped).not.toContain("2289530");
    }
  });

  it("runs the doubled-link passes in linear time at the prose bound (Q12)", () => {
    // The worst case for the new passes: a maximal doubled-opener run with
    // no inner opener, and a maximal well-formed doubled link chain.
    const openers = "[".repeat(262_144);
    expect(stripEditorialMarkup(openers)).toBe(openers);
    const chained = "[[9[x]]".repeat(30_000);
    expect(stripEditorialMarkup(chained)).toBe("x".repeat(30_000));
  }, 10_000);

  it("reduces the well-formed [[id|Label]] run to its label, dropping the id (Q12b)", () => {
    // The exact live-observed forms (2026-08-17, core "Q" album review,
    // verified via browser textContent).
    expect(
      stripEditorialMarkup(
        "On [[2289530|Chairlift]]'s sophomore album, with [[3051898|Caroline Polacheck]]'s…"
      )
    ).toBe("On Chairlift's sophomore album, with Caroline Polacheck's…");
  });

  it("keeps ordinary parens adjacent to a pipe link run (Q12b)", () => {
    expect(stripEditorialMarkup("adjacent ([[2289530|Chairlift]]) parens")).toBe(
      "adjacent (Chairlift) parens"
    );
  });

  it("fails closed on malformed pipe-link variants without leaking the id (Q12b)", () => {
    for (const [input, expected] of [
      // Unclosed: one or both closers missing — the label survives, the id
      // and the run's brackets do not.
      ["unclosed [[2289530|Chairlift] tail", "unclosed Chairlift tail"],
      ["unclosed [[2289530|Chairlift", "unclosed Chairlift"],
      // Empty label: the whole run is dropped.
      ["empty label [[2289530|]] run", "empty label  run"],
      // Empty id: no id-shaped token (q12-3 grammar), so the run is
      // ordinary bracket text and survives verbatim.
      ["empty id [[|Chairlift]] run", "empty id [[|Chairlift]] run"],
      // Doubled separator: the run is consumed through its doubled close
      // without resuming from inside it (q12-2).
      ["doubled pipe [[2289530|Chair|lift]] here", "doubled pipe Chair here"],
      // Nested opener inside the label: the id never survives and no
      // bracket residue remains (q12-2).
      ["nested [[2289530|la[bl]]] deep", "nested la deep"],
      // Plain pipe prose is not markup.
      ["plain pipe prose a | b stays", "plain pipe prose a | b stays"],
    ] as const) {
      const stripped = stripEditorialMarkup(input);
      expect(stripped).toBe(expected);
      expect(stripped).not.toContain("2289530");
    }
  });

  it("runs the pipe-link passes in linear time at the prose bound (Q12b)", () => {
    const openers = "[".repeat(262_144);
    expect(stripEditorialMarkup(openers)).toBe(openers);
    const chained = "[[9|x]]".repeat(30_000);
    expect(stripEditorialMarkup(chained)).toBe("x".repeat(30_000));
  }, 10_000);

  it("runs the grammar-gated passes in linear time over digit-only near-misses (q12-4)", () => {
    // A digit-only run after a doubled opener is the worst case for the
    // well-formed passes: with the id grammar inlined into the regex
    // classes this input backtracks quadratically (~30-60 s at this size,
    // measured 2026-08-17). A synchronous blowup also starves the timer, so
    // the budget alone cannot catch it — assert the wall clock directly.
    const digits = "[[" + "9".repeat(262_144);
    const started = Date.now();
    expect(stripEditorialMarkup(digits)).toBe("");
    expect(Date.now() - started).toBeLessThan(1_000);
    const chained = "[[9[x]]".repeat(30_000);
    expect(stripEditorialMarkup(chained)).toBe("x".repeat(30_000));
  }, 10_000);

  it("never leaves bracket residue from a bracket-cut label (q12-2)", () => {
    for (const [input, expected] of [
      ["[[2289530[La]bel]]", "La"],
      ["[[2289530[la[bl]]]", "la"],
      ["[[2289530|La]bel]]", "La"],
      ["[[2289530|la[bl]]]", "la"],
    ] as const) {
      const stripped = stripEditorialMarkup(input);
      expect(stripped).toBe(expected);
      expect(stripped).not.toContain("2289530");
      expect(stripped).not.toContain("[");
      expect(stripped).not.toContain("]");
    }
  });

  it("consumes an id-shaped doubled run with no separator fail-closed (q12-1)", () => {    // A doubled opener whose id run terminates at a bracket with no
    // separator is id-shaped markup with nothing displayable: the whole
    // run is consumed, never emitted verbatim.
    expect(stripEditorialMarkup("see [[2289530]] here")).toBe("see  here");
    expect(stripEditorialMarkup("see [[2289530")).toBe("see ");
    // A token without a digit is not an id: the run is ordinary prose.
    expect(stripEditorialMarkup("see [[note]] here")).toBe("see [[note]] here");
  });

  it("hands malformed delimiter runs to the whole-run scanner atomically (q12-5)", () => {
    for (const [input, expected] of [
      // A match inside a longer opener run: the regex must not fire, the
      // scanner consumes the run as one atom.
      ["[[[1|x]]", "x"],
      ["[[[1[x]]", "x"],
      // A match before a partial closer: same.
      ["[[1|x]]]", "x"],
      ["[[1[x]]]", "x"],
    ] as const) {
      const stripped = stripEditorialMarkup(input);
      expect(stripped).toBe(expected);
      expect(stripped).not.toContain("[");
      expect(stripped).not.toContain("]");
      expect(stripped).not.toContain("1");
    }
    // The live-valid forms still strip.
    expect(stripEditorialMarkup("see [[2289530[Chairlift]] here")).toBe(
      "see Chairlift here"
    );
    expect(stripEditorialMarkup("see [[2289530|Chairlift]] here")).toBe(
      "see Chairlift here"
    );
  });

  it("treats whitespace-bearing doubled runs as ordinary prose (q12-3)", () => {    // `[[note …` has no id-shaped token (whitespace, no digit): preserve
    // verbatim instead of mangling it as markup.
    const text = "Editorial [[note [sic] wording]] remains.";
    expect(stripEditorialMarkup(text)).toBe(text);
    const digits = "Editorial [[1984 [sic] wording]] remains.";
    expect(stripEditorialMarkup(digits)).toBe(digits);
    // The well-formed passes carry the same grammar: a whitespace-bearing
    // token is not an id even with a doubled close present.
    const closed = "Editorial [[1984 [sic]]] remains.";
    expect(stripEditorialMarkup(closed)).toBe(closed);
    // An id-shaped token with letters and digits (hex-hash form) still
    // parses as markup in both separator families.
    expect(stripEditorialMarkup("see [[abc123def[Chairlift]] here")).toBe(
      "see Chairlift here"
    );
    expect(stripEditorialMarkup("see [[abc123def|Chairlift]] here")).toBe(
      "see Chairlift here"
    );
  });
});
