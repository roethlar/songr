<!-- toolkit-owned; edits are drift — see AGENTS.md -->

# Playbook: synchronous cross-harness defect review (`codereview`)

A portable workflow for the defect lifecycle of landed changes on one git
repo: dispatch a reviewer over a pinned commit range to hunt defects, triage
what comes back, and verify each admitted finding's fix with strong per-fix
proof. You — the agent in the harness you launched from — play the **coder**.
The **reviewer** is a second, independent agent harness (`codex`, `agy`,
`grok`, a subagent, …) that you dispatch **headless and one-shot** — per
landed range in the generation half, per finding in the verification half —
to get a different model's eyes on the work.

**Framing (deliberate):** both halves of this loop are deliberately primed —
the generation pass hunts defects in a pinned landed range, and the
verification pass judges a fix against its recorded finding. That priming is
intentional here: it suits defect work, batch triage, and reviewer models
that wander without a rubric. For an unprimed approach-soundness judgment —
"would a fresh reviewer have solved this problem this way?" — use the
`openreview` playbook instead; the owner chooses per invocation, by name.

Invoke it with `codereview <harness> <model> <effort>` (in Claude Code: the
tab-completable `/codereview <harness> <model> <effort>`; see "Dispatch
grammar" for how `<model>` is handled). A trailing pinned range —
`codereview <harness> <model> <effort> <base>..<head>` — dispatches the
generation half ("Change review" below); without one, the verb continues
the active per-finding loop. This file is durable
guidance; it defers to this repo's `AGENTS.md` and
`.agents/` layout wherever they overlap. Where this playbook and the repo's
invariants disagree, the invariants win.

## What this loop is for

The loop exists to converge on **correct** code, not merely on **changed** code. Two
roles only add signal if each can return the unwelcome answer: the reviewer must be
able to find nothing, and the coder must be able to reject a finding. A loop where the
reviewer always finds something and the coder always agrees produces motion without
information — it will "fix" non-problems, accept wrong corrections, and oscillate, while
looking productive. Guard against both halves explicitly:

- **Reviewer inflation.** A reviewer who treats "find an issue" as the task will almost
  always return one. A pass that surfaces no material issue is a valid, complete,
  expected result — not a failure to do the job.
- **Author capitulation.** A coder who treats every finding as valid will "fix" things
  that were never broken and accept critiques that are wrong. Agreement is only signal
  when disagreement was available.

The cure is the same one the repo already trusts elsewhere: **route correctness through
verification, not through agreement.** Two roles agreeing is still opinion. A test that
fails before a fix and passes after is evidence. Every gate below is built so that a
finding has to predict an observable failure and a fix has to demonstrate it closed one.

## Atomic unit

The whole loop rests on one rule, stated in the repo's own commit currency:
**one finding ↔ one commit ↔ one verdict** where repo policy lands work directly
on the default branch, and **one finding ↔ one branch ↔ one verdict** where repo
policy works on branches. That is what keeps each fix independently reviewable
and bisectable. It is the same discipline as the repo's one-item-per-commit
rule, applied across two roles. Broad multi-finding slices are forbidden unless
the owner explicitly asks for a sweep. Per-finding isolation is this loop's
INTERNAL mechanics — its atomic unit and guard-proof isolation — not a
repository branch policy: which mode applies stays repository policy, per
`AGENTS.md` (Git Safety).

## Operator

`codereview <harness> <model> <effort>` is the harness-neutral entry. In Claude
Code it is the tab-completable slash command `/codereview <harness> <model>
<effort>`; on another harness the owner speaks it aloud. `<harness>` names the
reviewer harness to dispatch; `<model>` is the owner's literal word, used
verbatim and checked against no list (see "Dispatch grammar"); `<effort>`
sets the effort level. The
`<agent>` shorthand used elsewhere in this playbook is the same reviewer-harness
token.

With a trailing pinned range — `codereview <harness> <model> <effort>
<base>..<head>` — the same verb dispatches the generation half over landed
commits instead (see "Change review (defect generation)"). Without a range it
continues the active per-finding loop.

The flow is **synchronous by construction**: the coder dispatches the reviewer and
blocks on its verdict before acting on that finding. There is therefore **no
quick/wait toggle and no Strict/Faster WIP mode** — the prior async loop's
parallelism knobs do not apply here. One finding is dispatched, reviewed, recorded,
and acted on before the next is dispatched.

`frontier` is a reserved word in the `<model>` slot: `codereview <harness>
frontier` forces the **frontier** tier for that dispatch (see "Reviewer tiers
and routing") instead of naming a model, and the record carries
`escalated: owner`. It is the only routing modifier. Provider choice stays in
`<harness>` — no
phrase silently re-routes to a different harness.

## Deriving the reviewer incantation (probe-and-verify)

The only harness-specific fact the loop needs is **how to run `<agent>` headless,
non-interactive, one-shot**. This is **not** shipped as a human-maintained table and
**not** derived by parsing `--help` prose into a committed regex — both rot or break
silently. Every command shown below is illustrative only — the verification command
in particular is always this repo's recorded one (see its `AGENTS.md` / `.agents/`
guidance), never a literal copied from here. Instead derive it live, per harness, per
session, by probing — the same thing a capable agent already does when a human says
"codereview this with grok":

1. **Presence + surface.** `command -v <agent>`; then `<agent> --help` and
   `<agent> --version`. The top-level help usually reveals whether the headless entry
   is a subcommand (`<agent> exec …`) or a flag (`<agent> -p …`).
2. **Drill if ambiguous.** If the headless entry is not obvious, drill one level
   (`<agent> exec --help`, `<agent> chat --help`, whichever the top level lists) to
   find the non-interactive flag and how to pass a prompt. Note the harness's JSON
   output flag here too (e.g. `--output-format json`) — the verdict contract uses it.
3. **Capability proof — carried by the real dispatch, not a separate round.**
   A probe that only proves the process launches is what cost issue #6: a bare
   `<agent> exec "say OK"` returned while the reviewer child could not read the
   repo or run the guard, and 291 request variants chased one missing
   capability with no verdict. The proof required is therefore that the child
   demonstrates, in one shot and under the real self-permissioning grant (see
   "Self-permissioning launch"), the two capabilities the review depends on:
   **read a repo file** and **run one allowlisted command**. Fold that proof
   into the review dispatch itself — the reviewer echoes a `capability_ok`
   token in its verdict envelope, absent unless both succeeded — rather than
   paying a separate round-trip for it. A real review exercises those
   capabilities by definition, so a missing token means the transport failed
   and the run is not a clean pass (see the verdict contract). Dispatch a
   standalone smoke prompt only when qualifying a transport with no review to
   run. Keep the usual bounds: a
   **timeout** (a hung process is a failed probe, not a wait); **non-interactive
   detection** (if it opens a TUI / alternate screen / waits on a TTY, the
   incantation is wrong — try the next candidate); and run it **from the real git
   repo** (a canned prompt in an arbitrary temp dir hides launch requirements —
   e.g. codex refuses a non-trusted dir and needs `--skip-git-repo-check`, agy
   must run from the real repo cwd).
4. **Permission/tool denial is terminal.** Distinguish two failure kinds. A bare
   incantation error — wrong flag, TUI opened, untrusted dir — is a flag to
   adjust: try the next candidate. But a **permission or tool denial** — the
   child reaching the repo read or the allowlisted command and being *refused*
   it — means the capability the review needs is not available on this transport,
   and retrying variants only burns the quota issue #6 measured. Retry **once in
   a fresh process**; if the denial repeats, **record it, report the transport
   unsupported, and stop** — do not search for a workaround.
5. **Use the verified incantation** to run the review. Probing is bounded to
   `--help`/`--version`/the capability smoke prompt (a repo read plus the
   allowlisted verification command) — never arbitrary commands beyond that
   grant.

**Session cache (`.agents/review/harnesses.local.json`, machine-local).** Once
verified, record the incantation in this gitignored machine-local file to skip
re-probing next session (the incantation half is convenience, not source of
truth). Harness availability and CLI syntax are machine-specific, so a
`*.local.*` file is the correct home (consistent with the repo's treatment of
`settings.local.json` as untracked machine state); `.gitignore` carries
`.agents/review/*.local.json`, and the cache is **self-authored** — never
hand-maintained. The source of truth for incantations is "re-derive by
probing," so a stale cache self-corrects on the next smoke test.

For **tier routing** the cache is load-bearing, not optional: it is the only
place tier→(model, effort) defaults live — committed text pins no models.

**Two halves, keyed differently — this is load-bearing.** The *incantation*
(transport, headless entry, flags) is version-sensitive: flags move between
releases, so it is keyed by harness version and re-probed automatically when
the version changes. Nobody is asked. The *tier→pair mapping* is an owner
judgment about models, which live server-side and do not change because a CLI
released a point version; it carries **no version key** and survives upgrades
untouched. Conflating the two turns every routine harness upgrade into an
interrogation, which is the failure this split exists to prevent.

```json
"transport": "mcp | cli",
"probed": "<harness version>",
"tiers": {
  "standard": {"model": "<id>", "effort": "<level>", "flags": ["..."]},
  "frontier": {"model": "<id>", "effort": "<level>", "flags": ["..."],
               "grade": "competitive | fallback"}
}
```

The probe additionally discovers the model-selection and effort flags and
verifies the named model resolves. Tier pairs are **recorded when the owner
names or accepts them** — there is no confirmation ritual: a tier with no
recorded pair at all asks the owner once, and the answer is recorded
(`grade` is owner-declared, frontier-only). An owner's dispatch-time
`<model>` word always overrides the recorded pair for that dispatch, without
rewriting it.

**A recorded pair never blocks a dispatch.** Where the recorded pair is
usable, it is used: a harness-version change, a re-probed incantation, or any
other environment shift is a **note on the dispatch record**, never a gate —
the same rule the "Dispatch grammar" section already applies to hooks,
wrappers, and proxies. Review validity comes from the review; a confirmation
ritual standing between the owner and a verdict buys nothing the provenance
line does not already carry. Only a genuinely absent pair, or a harness that
rejects the model at dispatch, stops and asks. A
single-model harness may still differentiate tiers by effort; only when both
pairs are genuinely identical does it record the same pair under both tiers,
explicitly. `transport` is `mcp` where a verified MCP registration exists for
the harness, else `cli` — MCP is preferred where verified (thread continuity
gives the repair-delta natively; parameterized invocation retires flag
drift; no shell-quoting layer), but registrations are machine-local user
config: committed text names transports, never server registrations.

Cache validity is **lazy** — no per-session ping. A hit on unchanged harness
version + profile skips the full probe; each tier's pin is then validated,
envelope and pin together, on its **first real dispatch** of the session. A
model-not-found, connection, or equivalent error invalidates that cache
entry, forces a re-probe, and retries the dispatch once. Model IDs retire
without harness version bumps, so the cache never becomes the sole
unverified pin.

Effort binds at dispatch boundaries: on the MCP route effort is fixed at
conversation creation and follow-ups inherit it, so a redispatch that keeps
the pinned pair rides the in-thread repair-delta at cached-input prices,
while any tier or effort change necessarily opens a fresh conversation at
cold-prime cost — which the fresh-session rule for escalations already
mandates.

### Self-permissioning launch

The reviewer launches with its minimal tool set granted **at launch** — never by
editing `settings.json` or otherwise widening persistent config. A dispatch that
needs the owner to loosen a trust setting by hand is broken, not a step. The set
is bounded and strictly narrower than the coder's — read-only inspection plus a
disposable `git worktree`, no write: reading the workspace, driving its own
worktree, and running the verification command. On Claude Code that is
`--allowedTools Read Grep Glob "Bash(git:*)" "Bash(<verify-cmd>)"`; every harness
has an equivalent launch-scoped grant, recorded in the entry's `flags`.

### Dispatch provenance: the `Reviewer:` line

Every finding record and index row carries one provenance line:

```text
Reviewer: <harness> / <resolved model id> / <effort> / <tier>
  [escalated: <ordered list of ALL matched triggers>]
```

`escalated:` lists **every** matched trigger in order (e.g.
`escalated: T1,T2,T5`), never one arbitrarily chosen ID; an owner force is
recorded as `escalated: owner`; a frontier-ceiling reopen records
`T5 (ceiling)`. The line is copied from the **invocation transcript** where
the harness yields one — the
MCP result envelope or the CLI JSON stream — never from the reviewer's
prose. An unreachable server or a failed call still means the dispatch
failed, whatever text came back. But environment quirks that rewrite or
absorb the invocation — hooks redirecting commands to other tools,
wrappers, proxies — are **recorded as a note on the record, not an
invalidation** (owner ruling 2026-07-23): where no transcript exists for an
environment reason, the line records what was dispatched plus the note, and
validity rests on the review record itself. Dispatch is a direct tool call — no model
sits in the router seat to improvise around a dead server.

## Reviewer tiers and routing

Review dispatch is routed, not ambient. The playbooks own the *meaning* of two
reviewer tiers; committed text pins no concrete models — model names rot,
and rot in an installed artifact is drift, so the owner names models at
dispatch:

- **standard** — the owner-named best-value (model, effort) pair on the
  dispatched harness; sufficient for the tightly framed conformance verdicts
  this playbook issues. Standard defaults to **high** effort when `<effort>`
  is omitted.
- **frontier** — an owner-named pair strictly stronger than standard *as
  configured*; required for escalated findings. Frontier defaults to **xhigh**
  effort when `<effort>` is omitted, whether frontier was reached by escalation
  or owner force. Where the harness does not expose the ruled level, the
  owner-named pair is authoritative as recorded.

Effort is part of tier identity: capability ordering holds only for configured
(model, effort) pairs, never bare model names — a flagship name may
legitimately sit in standard, and tiers on a single-model harness may differ
by effort alone. The monotonic effort ladder `high < xhigh < max` tracks
review depth. There are exactly two tiers, only tiers issue verdicts, and
there is no third role: no economy/cheap-model role exists for any review
work — cheapness comes from routing, not from a weaker tier.

A tier resolves to its (model ID, effort flags) pair at invocation time,
from the machine-local cache (see "Deriving the reviewer
incantation"); each tier→pair mapping is recorded when the owner names or
accepts it. A dispatch whose tier has no recorded pair asks the owner once and
records the answer — nothing guesses, and nothing else blocks: an explicit
`<model>` in the dispatch line is used as given, whatever the cache holds.
Tier strength is an owner judgment, not a probe
inference: neither "stronger" nor "best value" is resolvable from `--help`
output.

A frontier entry is owner-graded `competitive` or `fallback` when named.
A fallback-grade frontier is the same class at more effort, not a strictly
stronger adjudicator — the grade drives the halt rule under "Escalation
triggers" below.

## Dispatch grammar

`/codereview <harness> <model> <effort>`, with `/review` as a pure alias of
`codereview`. **The owner's dispatch word is final** (owner ruling
2026-07-23): `<model>` is the owner's literal word — a model slug, a family
name, plain words — used verbatim. Nothing checks it against a map, a
denylist, a cache, or any other list: no committed list of models exists
anywhere in this toolkit, and none may be created. A name the agent does not
recognize is still used as given — it may be newer than the agent's
knowledge; if the harness rejects it at dispatch, that failure is reported,
never pre-empted. `<effort>` is optional; when omitted the routed tier's
default applies (standard → high, frontier → xhigh; see "Reviewer tiers and
routing"). `frontier` is a reserved word in the `<model>` slot: it forces the
frontier tier rather than naming a model (see the Operator section).

When the owner omits `<model>`, the machine-local cache supplies the recorded
default pair for the routed tier if one exists; otherwise the agent asks the
owner once and records the answer. The cache is a convenience, never a gate.
An inline model named for one dispatch is used verbatim and is **not**
written into the cache unless the owner says to keep it; the dispatch record
carries `(inline, session-only)` provenance so no artifact can launder an
override into a default.

When the owner omits `<harness>` as well — a bare `codereview` with nothing
after it — the agent **asks which reviewer to run**, in one line, and attaches
what the machine-local cache already holds as recall: the harnesses and models
dispatched from this machine before. The list is a reminder, never a menu — a
word that is not on it is used verbatim like any other, and an empty cache asks
with no list. Nothing is probed, scanned, enumerated, or looked up to build it:
reading the cache is the whole operation. The answer is **not** written back as
a bare-invocation default, so the next one asks again and no stored preference
can go stale.

A bare invocation never resolves a reviewer on its own. This toolkit keeps no
list of models and cannot judge one — a local model behind a harness may be a
better adjudicator than a flagship, a second harness may serve worse models
than the one already running, and "harness" has no boundary a machine can test.
Independence and quality come from the owner's word at dispatch; the reviewer
line of the dispatch record names what actually ran, so a review by the coder's
own model is visible in the record rather than prevented by a guess.

Review validity comes from the review itself, never from conformance to an
expected invocation shape: environment quirks — hooks that redirect commands
to other tools, wrappers, proxies, an unfamiliar harness — are recorded as
notes on the dispatch record, not treated as invalidating the review.

## Escalation triggers (standard → frontier)

`codereview` dispatches standard by default. Mechanical triggers are evaluated
deterministically from the diff and the finding record before any reviewer
runs; judgment arrives only via the `reopened` verdict. Any matched trigger
routes that finding's review (or re-review) to frontier:

- **T1 — sensitive path (mechanical, pre-review).** The diff touches a
  sensitive path. Matching is executable, not semantic: changed paths are
  tested against git-pathspec globs. Default globs: `**/auth*`, `**/secret*`,
  `**/*credential*`, `**/crypto*`, `**/migrations/**`, `**/schema*`,
  `**/*.proto`, `**/wire/**`, `**/serializ*`. The committed file
  `.agents/review/sensitive-paths` is the per-repo override, with **replace**
  semantics (present ⇒ it is the whole list). Glob matching is approximate by
  construction; the owner override below is the recourse — never per-session
  invention of new patterns.
- **T2 — recorded severity (mechanical, pre-dispatch).** The finding record's
  committed `**Severity**:` field reads CRITICAL or HIGH (impact line
  required, per the severity gate). Such findings route straight to frontier
  without consuming a standard round. T2 reads the finding record only —
  never the verdict envelope, which carries no severity field.
- **T3 — guard-proof integrity (mechanical, orchestrator-evaluated).** The
  guard proof artifact is missing, its verification command exits nonzero, or
  one orchestrator-run repeat disagrees with the recorded result (flake).
  These checks run outside any reviewer. T3 is a **pre-dispatch blocker,
  not an escalation** (amended 2026-07-18, owner adjudication of OR4): a
  failed integrity check means there is no valid evidence to review, so
  the round halts and returns to the coder (or the owner, if the coder
  cannot reproduce) until a deterministic proof exists — dispatching a
  frontier reviewer at broken evidence would spend the scarcest tier on
  input that no tier can adjudicate. Proof-*quality* judgment is not T3:
  a reviewer that distrusts a *valid* proof issues `reopened`, which
  escalates via T5.
- **T4 — declared-file drift (mechanical, post-repair).** Exact path-set
  comparison of the repair commits against the declared file set snapshotted
  in the repair record. Expansion beyond it does **not** silently trigger a
  replay — it halts the round and routes to the owner as contested,
  preserving the declared-files contract. "Approach drift" is judgment, not
  T4: it reaches the reviewer, who reopens (→ T5), or the owner. Full replay
  happens only on an explicit owner ask.
- **T5 — reopen (mechanical).** Any `reopened` finding escalates one tier on
  redispatch — ceiling at frontier, **within the harness the owner named**;
  no trigger silently consumes another provider's quota. If the prior round
  was already frontier, the reopen re-dispatches frontier in a **fresh
  session** of the same harness and records `escalated: T5 (ceiling)`.
  Switching provider requires an explicit owner dispatch.

**Owner override.** The operator phrase `codereview <harness> frontier` — with
`frontier` the reserved model-slot word (see "Operator") — forces frontier
for that dispatch and is recorded as `escalated: owner`, never by hand-editing
the cache.

**Fallback-grade halt.** Where the frontier entry carries
`"grade": "fallback"`, any trigger that would route to frontier instead halts
the finding as contested to the owner: escalation must buy a strictly stronger
adjudicator, and auto-dispatching the same class at more effort is escalation
theater. At the halt the owner either accepts the
fallback dispatch (recorded `escalated: <triggers> (fallback accepted:
owner)`) or re-dispatches on a competitive-frontier harness via the owner
phrase — provider switching stays owner-only.

Escalation opens a **fresh conversation, always** — a tier or effort change
never rides an existing reviewer thread; the re-prime is the price of fresh
eyes. Mid-thread effort nudges on an existing conversation are rejected as
anchored escalation.

## Change review (defect generation)

`codereview <harness> <model> <effort> <base>..<head>` — a trailing pinned
range dispatches a whole-change **defect hunt** over landed commits; this is
where findings come from when no external pass supplies them. Both endpoints
resolve to commit SHAs at dispatch time, and the reviewer evaluates
`git diff <base-sha>..<head-sha>` from the shared workspace (you do not pipe
it the diff), under the same probe-derived incantation and
self-permissioning launch as every other dispatch here. The mandate is
bounded: find defects in that range — each with evidence and a predicted
observable failure — not restyle the repo, and not judge the approach
(`openreview` owns that question).

Tier routing: standard by default; T1 (sensitive paths) is evaluated against
the range diff before dispatch, and the owner `frontier` phrase forces
frontier as everywhere. T2–T5 are per-finding triggers and do not fire on a
generation pass.

The generation verdict contract (structured, fail-closed) — result payload:

```json
{"verdict":"clean|findings","capability_ok":true,
 "reviewed_sha":"<head-sha>","base_sha":"<base-sha>",
 "findings":[{"title":"…","evidence":"file:line — …",
  "predicted_failure":"…","severity":"CRITICAL|HIGH|MEDIUM|LOW",
  "better_approach":"…"}]}
```

The orchestrator — never the reviewer — computes acceptance, with the same
fail-closed set as the per-finding contract (step 3 below): non-zero exit,
missing/invalid envelope, off-schema payload, `verdict` outside the enum,
either SHA ≠ its dispatched pin, `capability_ok` not literally `true`,
`findings` non-empty with verdict `clean`, or empty with verdict `findings`
→ **not** a clean pass. Recovery is the per-finding contract's: extraction
before rejection, one re-emission-only re-prompt, then contested to the
owner.

A `clean` verdict is a complete, valid result. Record it with provenance
wherever the repo tracks review outcomes — "codereview <agent>
(<model> @ <effort>, <tier>) over <base>..<head>: no material issue" — and
stop; do not re-dispatch shopping for findings. A `findings` verdict yields
**candidate** findings only: every one passes the finding intake and triage
gate below before any work, and DECLINED is an expected fate for the
speculative ones.

## Per-finding flow

For each admitted finding (intake/triage and the coder's own guard proof are done —
see the gate below):

1. **Finish the fix** as its own isolated slice — smallest coherent unit,
   touching only the files the finding doc declares. Default-branch mode: one
   commit per finding, landed at the branch head. Branch mode: a per-finding
   branch `fix/<id>-<slug>`.
2. **Dispatch the reviewer** headless and one-shot, in the harness's **JSON output
   mode** (the flag found while probing), at the routed tier's owner-named
   (model, effort) pair — **standard at high** unless an escalation trigger or
   the owner phrase routes **frontier at xhigh** (see "Reviewer tiers and
   routing"). Pass **explicit pins**: in branch mode the reviewed branch **head
   SHA** and the **base SHA** (the merge-base with the main branch at dispatch
   time); in default-branch mode the fix commit as **head SHA** and its parent
   as **base SHA**. Either way the reviewer evaluates
   `git diff <base-sha>..<head-sha>` against a fixed snapshot — a symbolic
   `main..branch` range is *not* stable if the main branch moves.
   The reviewer reads the code from the **shared workspace** (you do not pipe it the
   diff); it reads `.agents/review/findings/<id>.md`, and **independently performs the
   guard proof** (revert → confirm FAIL → restore → confirm PASS) **in its own `git
   worktree` checked out at the head SHA** — never by mutating your working tree. A
   reviewer that crashes mid-proof leaves only its disposable worktree dirty.
3. **Verdict contract (structured, fail-closed).** The reviewer returns its verdict in
   the JSON envelope. Its result payload must match:
   ```json
   {"verdict":"accepted|reopened|invalid","guard_confirmed":true,
    "capability_ok":true,
    "reviewed_sha":"<head-sha>","base_sha":"<base-sha>","comments":["file:line — …"]}
   ```
   Parse the envelope's result field against this schema. **The orchestrator — never
   the reviewer — computes acceptance**: reviewer-authored fields are inputs to these
   checks, not the decision. **Fail closed:** any of {non-zero exit, missing/!valid
   JSON envelope, payload not matching the schema, `verdict` not in the enum,
   `reviewed_sha` ≠ the dispatched head SHA, `base_sha` ≠ the dispatched base SHA,
   `guard_confirmed` not literally `true`, `capability_ok` not literally `true`}
   → the outcome is **not accepted**. `capability_ok` is the folded-in transport
   proof (see "Capability proof"): the reviewer sets it only after reading a repo
   file and running one allowlisted command in the same shot, so its absence means
   the child never had the capabilities the review depends on — exactly the issue
   #6 failure mode, which the standalone smoke round used to catch.
   **Extraction before rejection:** a prose-wrapped payload is not a parse miss —
   scan it for candidate JSON objects, and when exactly one matches the schema, use
   it; the review already happened, and surrounding prose is never an input to
   acceptance. Zero or multiple schema matches → parse miss. On a parse miss,
   re-prompt once for **re-emission only**: feed the reviewer its own output back
   and ask for schema-only JSON — no re-review, no hint of the expected verdict.
   If that still fails, route the finding to the owner as contested. Never re-run
   a completed review to fix formatting. A parse miss never silently becomes an
   accept. (The
   harness's JSON mode guarantees a valid *envelope*, not that the model filled the
   *payload* to schema — hence the inner parse, not envelope-validity alone.)
4. **Record the verdict** into `.agents/review/findings/<id>.md` `## Reviewer
   comments` **before acting** — the durable trail. Capture: the **`Reviewer:`
   provenance line** (transcript-sourced; see "Dispatch provenance"), reviewer
   **harness name + version**, **reviewed head SHA + base SHA**,
   **`guard_confirmed`**, the **verdict**, a UTC **timestamp**, and the
   comments. Flip the finding **Status** and the index row. State whether this
   record is committed (it should be, as part of the verification history).
5. **Act on the recorded verdict:**
   - **accepted** → default-branch mode: the fix is already landed — close the
     finding and sync its paperwork in the same motion (status, index row,
     records). Branch mode: the branch is ready for an **owner-gated** merge —
     do not merge, push, or rewrite history on agent authority; leave the
     branch (or hand off a `merge-<id>` branch).
   - **reopened** → apply fix-ups — a follow-up commit in default-branch mode
     (never an amend of the reviewed commit), or further commits on the same
     branch in branch mode — then re-run
     `codereview <agent>` as a **repair-delta redispatch** (see below). The
     reopen escalates one tier on redispatch (trigger T5).
   - **invalid** → write `.agents/review/<id>.contested.md` (which kind of
     disagreement, the reason, what the owner must decide) and route to the owner.
     Disagreement is a recorded verdict, never a silent veto. Where a third
     harness holds a verified `harnesses.local.json` entry on this machine, the
     contested record **names it as an available adjudicator** — an offer, not
     a dispatch: engaging it takes an explicit owner go, and no harness
     adjudicates a dispute it authored a side of.

## Repair-delta redispatch (reopened findings)

A redispatch after a repair does not replay the full review. The packet is:
the finding ID + the original finding text + the repair diff + the
verification command + the guard proof. Pin mechanics for the redispatch
round: `base` = the head SHA the finding was raised against (the pre-repair
head), `head` = the current branch head; the **orchestrator computes the
repair diff** from those pins and pipes it to the reviewer — the reviewer
does not rediscover scope from SHAs. This amends the base/head dispatch
contract above for redispatch rounds explicitly; it is not a silent
departure. The guard proof still executes against the full current head in
the reviewer's disposable worktree — only the *review mandate* narrows:
confirm the specific predicted failure is closed and no adjacent regression
exists in the touched surface, NOT re-review the whole branch. Full replay
happens only on an explicit owner ask — including after a T4 halt.
`openreview` remains the whole-change instrument.

## Finding intake and triage

This is the gate the false-positive problem dies at, before any branch is cut. It
applies whether findings come from a human, the coder, a separate review pass, or a
second model.

**A review pass that finds no material issue is a complete, valid result.** Record it
as one plain sentence ("Reviewed <scope>; no material issue found") and stop. Do not
manufacture findings to justify the pass. An empty findings table is a legitimate
outcome of this playbook.

Every candidate finding must carry three things before it can be admitted:

1. **Evidence** — concrete `file:line` citation(s) and the specific input, path, or
   condition that triggers the problem. A finding that cannot point at code is not a
   finding.
2. **Predicted observable failure** — what goes wrong that someone or something could
   detect: a wrong result, a crash, a security exposure, a failing or missing test, a
   measurable regression. "Could be cleaner," "not idiomatic," or "I would have written
   it differently" are not observable failures.
3. **Justified severity** — CRITICAL | HIGH | MEDIUM | LOW, with a one-line reason tied
   to the predicted failure, not to taste.

**Triage each candidate to a verdict:**

- **ADMITTED** → it has evidence, a predicted failure, and a justified severity. Give
  it an id, add a `[ ]` row, write the finding doc.
- **DECLINED** → it lacks evidence or a predicted observable failure, is style-only, is
  out of scope, or duplicates another finding. Record it as a `[-]` row and write one
  line in `.agents/review/<id>.contested.md` stating why. Declining is the expected
  fate of most stylistic or speculative findings; it is the loop working, not failing.

If a single agent is generating and triaging its own findings, it must still write the
DECLINED reasons down — the discipline is in making the rejection explicit and
reviewable, not in who performs it. Severity is not decoration: if you cannot write the
impact line, the finding is a DECLINE or a LOW, not a CRITICAL.

## Per-finding record: `.agents/review/findings/<id>.md`

Written when a finding is admitted; the coder completes the lower half when work starts.

```markdown
# <id>: <title>

**Severity**: CRITICAL | HIGH | MEDIUM | LOW — <one-line justification>
**Status**: Open | In progress | Verified | Contested
**Branch**: `fix/<id-lowercased>-<short-slug>` (branch mode; `—` in default-branch mode)
**Commit**: `<git-sha>` (filled in after commit)

## Evidence
`file:line` citation(s) and the input/condition that triggers the problem.

## Predicted observable failure
What detectably goes wrong, and — where possible — the test or check that would catch
it. This is the claim the fix must prove it closed.

## What
Concise statement of the bug or risk. One paragraph.

## Approach
What was done and why it fixes the root cause rather than the surface symptom. Cite
the new/changed functions and files. 2–6 sentences.

## Files changed
- `path/to/file:lines` — what changed

## Guard proof
- `path/to/test::name` — the assertion. Reverting the fix makes this FAIL; restoring
  makes it PASS. If the change is genuinely untestable, state why and name the manual
  check that was run instead.

## Coder dispute (if any)
If the coder believes the finding is wrong or not worth fixing, state the reason here
instead of implementing, and route to a contested verdict. Empty otherwise.

## Known gaps
Anything uncertain, out of scope, or overlapping another finding the reviewer should
grade explicitly. Empty if nothing.

## Reviewer comments
`Reviewer: <harness> / <resolved model id> / <effort> / <tier>` — plus
`escalated: <ordered trigger list>` when routing escalated — copied from the
invocation transcript, never from reviewer prose. Then: reviewer harness +
version, reviewed/base SHA, guard_confirmed, verdict, UTC timestamp, and the
comments. On reopen the coder addresses these and re-runs the review.
```

## Status index: `.agents/review/index.md`

Short, human-readable scoreboard. Per-finding detail lives in
`.agents/review/findings/<id>.md`; do not turn the index into a discussion log.

```markdown
# Review status

Workflow: see `.agents/playbooks/codereview.md`.
Per-finding detail: see `.agents/review/findings/<id>.md`.

## Legend
- `[ ]` Admitted, open (passed intake triage; not yet started)
- `[~]` In progress / pending review
- `[x]` Verified (awaiting owner-gated merge)
- `[!]` Contested — declined, disputed, or ruled invalid; awaiting owner adjudication
- `[-]` Declined at intake (kept for the record; no work)

## Findings

| ID    | Severity | Impact (one line)            | Status | Branch | Reviewer |
|-------|----------|------------------------------|--------|--------|----------|
| sec-1 | HIGH     | <observable consequence>     | `[ ]`  |        |          |
| ...   | ...      | ...                          | ...    | ...    | ...      |

The Reviewer column carries the same transcript-sourced provenance line as the
finding record, compacted: `<harness>/<model>/<effort>/<tier>` plus
`esc:<triggers>` when routing escalated.
```

Add one line to `.agents/state.md` while a loop is active, e.g. "Active review loop:
see `.agents/review/index.md`." Remove it when the loop is done. `state.md` points;
it does not copy the table.

## Anti-patterns

- **Broad sweeps.** "Fix sec-1..sec-9 in one commit" kills bisection. Owner-request
  only.
- **Manufacturing findings.** Inventing issues so a pass has output. A clean pass is a
  result.
- **Silent veto.** Dropping or overriding a finding without a contested record.
- **Accepting on a parse miss.** A missing, non-JSON, or off-schema verdict is **not**
  an accept. Fail closed: re-prompt once, then route to the owner as contested.
- **Reviewer mutating the coder's tree.** The reviewer's guard proof belongs in its
  own `git worktree`; it must never revert/restore in the coder's working tree.
- **Merging or pushing without an owner go** (branch mode). Accepted is a
  verdict, not merge authority.
- **Rewriting history** (amend/rebase/squash/force-push) on reviewed work without an
  explicit owner go.
- **Editing the index prose freely.** It is a status board; discussion goes in the
  finding or contested doc.
- **Reviewing against a moving base.** Pin the base + head SHAs at dispatch; do not let
  `main..branch` drift mid-review.

## Knobs

- **Single-agent mode**: one agent alternates coder and reviewer hats (no foreign
  harness). Keep the per-finding atomic unit (commit or branch), the guard
  proof, and the recorded-verdict trail. The discipline that matters in this mode is writing the DECLINED and contested
  reasons down even though one mind holds both roles — that is what stops self-agreement
  from collapsing the loop.
- **Adjudicator (optional)**: when coder and reviewer disagree (a contested record), a
  third role — or the owner — reads the finding, the dispute, and the guard proof and
  issues a final ADMIT/DECLINE. Useful when the coder and reviewer are two models prone
  to deferring to each other. Candidate adjudicators are surfaced, never
  self-dispatched: the contested record names third harnesses with verified
  cache entries, and the owner engages one (or rules directly).
