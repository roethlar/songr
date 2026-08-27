/**
 * Roon editorial prose (biographies, reviews) carries internal link markup
 * of the form `[Display Name](id)`, `[[id[Display Name]]`, or
 * `[[id|Display Name]]`, where the id is a native Roon identifier. Native ids never cross the browser contract
 * (editorial plan §3.5), so the markup is normalized to its plain display
 * text: the label stays, the id is dropped before the text ships.
 *
 * The sanitizer is FAIL-CLOSED (q1-3). After the well-formed pass, any
 * residual link-SHAPED run — a bracket run immediately followed by a paren
 * run, in any malformed configuration (empty label, nested or doubled
 * brackets, empty, nested-paren, or unclosed destination) — keeps only its
 * bracket-stripped label text; the destination and the run's brackets are
 * dropped, so no id token can survive. A dangling `](...)` with no opener
 * loses the whole run. Prose parentheses NOT preceded by bracket structure
 * (`(2018)`, `[sic]`) never match: every residual shape requires a bracket.
 * This helper never throws and never emits a partial bracket run.
 *
 * Performance contract (q1-3 repair): the residual passes are a hand-written
 * single-pass scanner, not regexes — a regex over a maximal near-miss opener
 * run (`[` repeated to the 256KiB prose bound) backtracks quadratically
 * (~85s in test). The scanner consumes every position at most once: a failed
 * link-shape probe emits its scanned region verbatim and jumps past it, and
 * a matched destination is consumed by paren depth, so nested or unclosed
 * destinations cannot leak a tail.
 */

// Well-formed runs: one `[`, one or more non-bracket label chars, one `]`,
// then a non-empty paren destination with no nested parens. Linear: after a
// `[`, the label class either advances or fails in O(1).
const EDITORIAL_LINK_PATTERN = /\[([^\[\]]+)\]\(([^()]+)\)/g;

// The other live wire shape (Q12): `[[id[Label]]`. The regex is purely
// structural — linear negated classes, no grammar inside quantifiers
// (q12-4: a mandatory character between two quantified classes backtracks
// quadratically over digit runs at the prose bound). The id grammar is
// applied to the captured token by the replace callback instead.
const EDITORIAL_DOUBLED_LINK_PATTERN = /\[\[([^\[\]|]+)\[([^\[\]|]+)\]\]/g;

// The pipe-separated live wire shape (Q12b, verified against the live Core
// 2026-08-17): `[[id|Label]]`. Same structural/linear rule; the id run
// additionally excludes the pipe.
const EDITORIAL_PIPE_LINK_PATTERN = /\[\[([^\[\]|]+)\|([^\[\]|]+)\]\]/g;

/**
 * The q12-3 id grammar as an O(token) string check (q12-4): no whitespace,
 * at least one digit — live Roon ids are numeric or hex-hash. Applied to
 * the captured token AFTER the structural match, never inside a quantified
 * regex class.
 */
function isEditorialIdToken(token: string): boolean {
  return !/\s/u.test(token) && /[0-9]/u.test(token);
}

/**
 * Consumes the paren run starting at `start` (which must index a `(`) and
 * returns the index just past it. Nesting is tracked by depth; an unclosed
 * run consumes through the end of the string (fail-closed: the tail belongs
 * to the malformed destination).
 */
function skipParenRun(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

/**
 * Removes residual link-shaped runs the well-formed pass did not match.
 * Single pass; every character is examined once.
 */
function stripResidualLinkShapes(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  // Monotonic cursor for the first `]]` at or after a position (q12-2):
  // each query reuses the cached position or scans a disjoint forward
  // range, so the whole pass stays O(n).
  let doubledCloseAt = -2;
  const findDoubledClose = (from: number): number => {
    if (
      doubledCloseAt === -2 ||
      (doubledCloseAt !== -1 && doubledCloseAt < from)
    ) {
      doubledCloseAt = text.indexOf("]]", from);
    }
    return doubledCloseAt !== -1 && doubledCloseAt >= from ? doubledCloseAt : -1;
  };
  while (i < n) {
    const ch = text[i];
    if (ch === "[") {
      // Probe for the link shape: `[`+ label `]`+ `(`.
      let j = i;
      while (j < n && text[j] === "[") j += 1;
      if (j - i >= 2) {
        // Doubled-opener link families (Q12 `[[id[label]]`, Q12b
        // `[[id|label]]`): an id run is never emitted, only clean label
        // text survives, and a malformed run is consumed whole — never
        // resumed from inside it.
        let k = j;
        while (k < n && text[k] !== "[" && text[k] !== "]" && text[k] !== "|") {
          k += 1;
        }
        // The token up to the first separator or bracket is an id ONLY when
        // it carries no whitespace and at least one digit (q12-3 — live
        // Roon ids are numeric or hex-hash); any other doubled bracket run
        // is ordinary prose and falls through to the generic probe
        // verbatim.
        const token = text.slice(j, k);
        if (token.length === 0 || /\s/u.test(token) || !/[0-9]/u.test(token)) {
          // Not id-shaped: ordinary bracket text; the generic probe below
          // re-reads the same region.
        } else if (k >= n || text[k] === "]") {
          // `[[id]]` or unclosed `[[id` (q12-1): id-shaped markup with no
          // separator and nothing displayable — consume the whole run,
          // emit nothing, never resume mid-run.
          let m = k;
          while (m < n && text[m] === "]") m += 1;
          i = m;
          continue;
        } else if (text[k] === "[" || text[k] === "|") {
          const stopAtPipe = text[k] === "|";
          let l = k + 1;
          while (
            l < n &&
            text[l] !== "[" &&
            text[l] !== "]" &&
            !(stopAtPipe && text[l] === "|")
          ) {
            l += 1;
          }
          const label = text.slice(k + 1, l);
          if (l < n && text[l] === "]" && text[l + 1] === "]") {
            // A proper doubled close: keep the clean label, consume every
            // closer.
            let m = l;
            while (m < n && text[m] === "]") m += 1;
            if (label.length > 0) out.push(label);
            i = m;
            continue;
          }
          // Under-closed, nested, or doubled-separator (q12-2): keep only
          // the clean label-so-far and consume the entire run — through
          // the first later `]]` (all its closers) when one exists, else
          // through the label's own single `]` or the end of the text —
          // never resuming from inside it, never leaving residue.
          if (label.length > 0) out.push(label);
          const rest = l < n && text[l] === "]" ? l + 1 : l;
          const doubled = findDoubledClose(rest);
          if (doubled === -1) {
            i = rest;
            continue;
          }
          let m = doubled;
          while (m < n && text[m] === "]") m += 1;
          i = m;
          continue;
        }
      }
      let k = j;
      while (k < n && text[k] !== "[" && text[k] !== "]") k += 1;
      if (k < n && text[k] === "]") {
        let m = k;
        while (m < n && text[m] === "]") m += 1;
        if (m < n && text[m] === "(") {
          // Link-shaped: keep the bracket-stripped label, drop the
          // destination (by depth, so nested/unclosed parens cannot leak).
          out.push(text.slice(j, k));
          i = skipParenRun(text, m);
          continue;
        }
        // No destination: the bracket run and label are ordinary text.
        out.push(text.slice(i, m));
        i = m;
        continue;
      }
      // No closing bracket at all: nothing link-shaped starts inside this
      // region (a later `[` is re-probed from its own position only when the
      // label scan stopped there).
      if (k < n) {
        // Single opener with the label scan stopped at an inner `[`: emit
        // up to it and re-probe. (Doubled openers never reach this branch;
        // they are intercepted above.)
        out.push(text.slice(i, k));
        i = k;
      } else {
        out.push(text.slice(i));
        i = n;
      }
      continue;
    }
    if (ch === "]" && i + 1 < n && text[i + 1] === "(") {
      // Dangling `](...)` with no opener: drop the whole run.
      i = skipParenRun(text, i + 1);
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/**
 * Replaces every `[Display Name](id)` or `[[id[Display Name]]` run with its
 * plain display text, and neutralizes malformed link-shaped runs so no
 * native id can leak through.
 */
export function stripEditorialMarkup(text: string): string {
  return stripResidualLinkShapes(
    text
      .replace(EDITORIAL_LINK_PATTERN, (_match, label: string) => label)
      .replace(
        EDITORIAL_DOUBLED_LINK_PATTERN,
        (
          match: string,
          id: string,
          label: string,
          offset: number,
          source: string
        ) =>
          isEditorialIdToken(id) &&
          // q12-5: no lookarounds — a match inside a longer bracket run or
          // before a partial closer is handed back unchanged so the
          // whole-run scanner consumes it atomically.
          source[offset - 1] !== "[" &&
          source[offset + match.length] !== "]"
            ? label
            : match
      )
      .replace(
        EDITORIAL_PIPE_LINK_PATTERN,
        (
          match: string,
          id: string,
          label: string,
          offset: number,
          source: string
        ) =>
          isEditorialIdToken(id) &&
          source[offset - 1] !== "[" &&
          source[offset + match.length] !== "]"
            ? label
            : match
      ),
  );
}
