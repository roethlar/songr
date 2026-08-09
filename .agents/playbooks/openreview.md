<!-- toolkit-owned; edits are drift — see AGENTS.md -->

# Playbook: approach-soundness whole-change review (`openreview`)

A portable workflow for getting one independent, unprimed judgment of a whole
change from a second agent harness: would the reviewer have solved this
problem this way? The reviewed change may be an implementation, a plan or
design document, or a mix — any pinned commit range. You — the agent in the
harness you launched from — play the **coder/orchestrator**. The **reviewer**
is a second, independent agent harness (`codex`, `agy`, `grok`, a
subagent, …) dispatched headless and one-shot over that pinned range.

Invoke it with `openreview <agent>` (in Claude Code: the tab-completable
`/openreview <agent>`). This file is durable guidance; it defers to the repo's
`AGENTS.md` and `.agents/` layout wherever they overlap.

**Framing (deliberate):** where `codereview` hunts defects in a landed change
and verifies each finding's fix against its record, this playbook withholds
every rubric and asks for the reviewer's own approach. The reviewer judges
the change on its own reading of the repository. Priming it — with the plan,
a checklist, suspected risks, or prior conclusions — turns independent review
into confirmation and is this playbook's cardinal defect. Selection between
the two is the owner's per-invocation call: defect review suits landed-code
sweeps and verification passes; the open approach question rewards stronger
reviewers and design-heavy changes. No auto-selection heuristic exists; the
owner names the playbook.

## The question (neutral by construction)

The substantive review prompt is exactly:

> From your own reading of the repository, state the goal this change serves
> and how you would achieve it. Then judge: is the change as made the best
> way to achieve that goal?

That is the whole substantive framing, and it works unchanged whether the
pinned range holds code, a plan, or both. Give the reviewer only the
mechanical coordinates needed to perform the review:

- the repository location (shared workspace — you do not pipe it the diff);
- the exact **base SHA** (merge-base with the main branch at dispatch time) and
  **head SHA**, so it evaluates `git diff <base-sha>..<head-sha>` against a
  fixed snapshot — a `main..branch` range is not stable if the main branch moves;
- permission to inspect the repository to discover the goal;
- disposable-worktree isolation: anything it runs or reverts happens in its own
  `git worktree` checked out at the head SHA — never in your working tree;
- side-effect boundaries (no commits, no pushes, no network mutations);
- the verdict schema below.

Those facts make the review reproducible; they do not tell the reviewer what
conclusion to reach. Do **not** summarize the plan or implementation, enumerate
areas to inspect, supply a risk checklist, suggest findings, repeat claimed
invariants, or disclose prior reviewer conclusions. Plans and finding records
remain repository evidence the reviewer may discover, not a rubric the caller
argues from. The reviewer chooses what to read, which alternatives to consider,
and what evidence matters. A verdict endorsing the change is as valid as a
well-supported call to replace it.

## Dispatch

Derive the reviewer incantation live, per session, by probing — presence,
headless entry, JSON output mode, bounded smoke test — exactly as the
`codereview` playbook's "Deriving the reviewer incantation" section specifies
(that section is the canonical recipe; do not duplicate it here). Dispatch
headless, one-shot, in the harness's JSON output mode.

Launch the reviewer **self-permissioned**, per the `codereview` playbook's
"Self-permissioning launch" rule (canonical): its minimal tool set is granted at
launch — never by editing `settings.json`. openreview's reviewer needs that same
read-only-plus-disposable-worktree set to inspect the repo and run its bounded
smoke test.

Tier routing is fixed: `openreview` always dispatches the harness's
owner-named **frontier** pair at **max** effort (see the `codereview`
playbook's "Reviewer tiers and routing") — no escalation headroom exists
above it, so a contested round resolves by owner adjudication, never a
stronger redispatch.

Eligibility rides the frontier pair's `grade`, which the owner already
declares when naming the pair — there is no second confirmation (supersedes
the `openreview_confirmed` field, 2026-07-25; the field was a separate
version-keyed gate that asked the owner again for a judgment the grade
already carries). A `competitive` grade is openreview-eligible: dispatch it.
A `fallback` grade is a legitimate openreview reviewer but a weaker
adjudicator, so it asks the owner once before dispatching here and its grade
is recorded in the outcome either way.

Model naming rides the `codereview` playbook's "Dispatch
grammar" section (canonical): the owner's literal word is used verbatim,
checked against no list — and a named model confers nothing:
the frontier pair's `grade` above remains the only eligibility gate.

A bare `openreview` with no `<agent>` asks which reviewer to run, with the
machine-local cache's prior dispatches as recall and nothing stored back,
exactly as that same section defines; the named agent's frontier pair then
routes as above. Fixed frontier routing picks the tier, never the reviewer:
it cannot make a dispatch independent of whatever model wrote the change, and
claims no such thing. That independence is the owner's word at dispatch.

## Verdict contract (structured, fail-closed)

The reviewer leads with its own approach, never with a defect list. Its
result payload must match:

```json
{"verdict":"best_approach|acceptable_with_changes|replace",
 "capability_ok":true,
 "reviewed_sha":"<head-sha>","base_sha":"<base-sha>",
 "goal":"<one sentence: the goal the reviewer discovered>",
 "recommended_approach":"<how the reviewer would achieve the goal>",
 "comparison":"<how the reviewed change compares with that approach>",
 "material_changes":["<change that should be made>"],
 "findings":[{"title":"…","evidence":"file:line — …",
  "predicted_failure":"…","severity":"CRITICAL|HIGH|MEDIUM|LOW",
  "better_approach":"…"}]}
```

Verdict semantics: `best_approach` — the change's approach is the one the
reviewer would take, or better; `material_changes` must be empty.
`acceptable_with_changes` — the approach stands, but the listed material
changes should be made; `material_changes` must be non-empty. `replace` —
the reviewer's `recommended_approach` should supplant the change's;
`material_changes` must be non-empty. `findings` is optional at every
verdict (an empty list is valid): discrete evidence-backed defects noticed
along the way, in the `codereview` intake shape — never the review's
required output.

Parse the envelope's result field against this schema. **The orchestrator —
never the reviewer — computes acceptance.** Fail closed: any of {non-zero exit,
missing/invalid JSON envelope, payload not matching the schema, `verdict` not
in the enum, `reviewed_sha` ≠ the dispatched head SHA, `base_sha` ≠ the
dispatched base SHA, `capability_ok` not literally `true`, `material_changes`
empty with verdict `acceptable_with_changes` or `replace`, `material_changes`
non-empty with verdict `best_approach`} → the outcome is **not** an accepted
verdict. `capability_ok` is the folded-in transport proof (see the
`codereview` playbook's "Capability proof"): the reviewer sets it only after
reading a repo file and running one allowlisted command in the same shot, so
its absence means the child never had the capabilities the review needs.
Recover a prose-wrapped or off-schema payload by the `codereview` playbook's
verdict-contract handling (canonical): extraction before rejection, one
re-emission-only re-prompt, then route to the owner as contested — a parse
miss never silently becomes an accepted verdict.

## Downstream: judgments to the owner, findings to codereview

An openreview pass produces a design judgment and, optionally, candidate
findings — never fixes. `recommended_approach`, `comparison`, and
`material_changes` are design judgments, not defects: they route to the
owner, who rules what is adopted — one ruling at a time, per the repo's
owner-gate rules; adopted material changes become plan revisions or new
work. Every entry in `findings` goes through the `codereview` playbook's
**finding intake and triage** gate (evidence, predicted observable failure,
justified severity — ADMITTED or DECLINED, recorded either way), and
admitted findings are worked per that playbook's per-finding flow. This
playbook owns the dispatch and the verdict envelope; `codereview` owns
everything downstream of a finding.

Every outcome records reviewer provenance (amended 2026-07-18, owner
adjudication of OR5): the harness, resolved model id, effort, and grade,
taken from the dispatch record of the session that produced the verdict,
never reconstructed after the fact. The outcome line wherever the repo
tracks review outcomes is
"openreview <agent> (<model> @ <effort>, <grade>) over <base>..<head>:
<verdict>", with the material-change titles alongside when the verdict is
not `best_approach`. An outcome line without provenance is an incomplete
record — a future reader must be able to tell **which** reviewer issued
the judgment.

## Anti-patterns

- **Plan-conformance priming.** Telling the reviewer to validate against a plan,
  or preloading a checklist, suspected risks, preferred mutations, or expected
  findings. Ask only the neutral question; provide only the mechanical
  coordinates and the safety/output contract.
- **Treating `best_approach` as a failed pass.** An unprimed reviewer that
  endorses the change has done the job. Do not re-dispatch shopping for a
  harsher verdict.
- **Manufacturing findings.** The reviewer inventing issues so the pass has
  output; intake triage exists to decline these, and declining is the loop
  working.
- **Skipping intake.** Implementing a returned finding directly because the
  reviewer sounded confident. Every finding passes the evidence/predicted-failure
  gate first.
- **Adopting material changes without a ruling.** Adopted-by-silence does not
  exist: each material change waits for its own owner ruling before any work.
- **Reviewing against a moving base.** Pin base + head SHAs at dispatch.
