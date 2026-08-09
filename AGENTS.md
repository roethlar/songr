# Agent Guidance

## Prime Invariants

- Answer in words first; act only on an explicit go. A handed-over plan, report, or spec is not a go. A go covers exactly what it names — nothing more.
- No code change without an approved plan. Edits that change nothing the repo ships need none; when unsure, treat it as code.
- Commit each slice as it lands; close its paperwork (trackers, records) in the same motion. History rewrites and destructive or outward-facing actions always need their own explicit go. Push policy: `.agents/push-policy.md`.
- Repo is memory. Durable truth lives in repo files — never chat, session memory, or out-of-repo stores. Under context pressure, re-ground from this file; prefer a fresh session when degraded.

## Repo-Specific Guidance

@.agents/repo-guidance.md

The repo's own rules live in `.agents/repo-guidance.md`; the more specific rule wins. Flag a contradiction you cannot reconcile.

## Invariants

- Record durable facts, decisions, and open questions in `.agents/` files, written to stand without the conversation that produced them; label unverified inferences as assumptions.
- One canonical location per truth; pointers over copies. `.agents/state.md` is the single current-state entry point, kept current by the working agent as work lands.
- Never bypass a roadblock — failing test, guard, lint, ignore rule, refusal, CI gate — without establishing it is not load-bearing. If you cannot, stop or ask.
- Escalate on stalled progress, never duration: after ~2–3 consecutive cycles with no verifiable delta, stop and surface to a human.
- This file is governance only and stays portable; anything true only of this repo lives in `.agents/`. Refresh-governed artifacts (this file, playbooks, skills, wrappers, hooks) are toolkit-owned — route changes to the owner; refresh restores divergence. Seeded policy files (`.agents/push-policy.md`) are repo-owned and editable.

## Session Startup

Read this file, `.agents/repo-guidance.md`, and `.agents/state.md` before changing anything. Verify clone freshness (`git ls-remote` against the local ref) before trusting recorded state; unreachable remote — proceed with a one-line caveat. If your harness gates this repo's governance hooks behind a trust step, say what the hooks do and run it only on an explicit go.

## Source of Truth

Human request → this file and `.agents/repo-guidance.md` → `.agents/state.md`, `.agents/decisions.md`, approved playbooks → code, tests, and CI as evidence of behavior → other docs. On disagreement, flag it and fix the lower source, or ask.

## Operator Requests

Owner process words; where a playbook exists, `.agents/playbooks/<name>.md` is the authoritative procedure, read at invoke time.

- `catchup` — re-ground and report; change nothing else until the owner responds.
- `handoff` — fast state snapshot; seconds, not minutes.
- `decision` — record a settled decision in `.agents/decisions.md`; update affected guidance.
- `plan` — draft or update a durable plan; owner decisions come one at a time, in plain words.
- `playbook <name>` — run it; if it doesn't exist, say so.
- `toolkit` — list the owner verbs, one plain line each.

## Owner Gates

Write every ask for an owner arriving cold: a line of context, the question, what changes under each option, your recommendation. Silence never authorizes proceeding.

## Verification

Run the entry point recorded in `.agents/repo-guidance.md` (Verification) before claiming completion; docs-only changes need `git diff --check` unless they affect behavior. Prove a new test bites: revert the fix, watch it fail, restore. If a check was not run, say so plainly.

## Git Safety

No amend, rebase, squash, or force-push on existing commits without explicit approval — a go for a commit never covers rewriting it. One finding per commit. Before treating a branch as merged or deleting it, verify the content arrived (`git diff`); ancestry alone can lie.

## Final Response

Bottom line first. While queued work remains, end by naming the next item and one proposed action — never a bare "blocked on X."
