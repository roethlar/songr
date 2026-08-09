<!-- toolkit-owned; edits are drift — see AGENTS.md -->

# Playbook: `catchup` — re-ground, tidy, report

Two jobs in one word: bring you back up to speed, and keep the record
honest — without spending this session's window on the tidying. The
state-hygiene sweep lives in `.agents/playbooks/drift.md` and still
rides this pass, never a separate owner word — but it runs in a
throwaway agent, so the main context pays one summary line (owner
design, 2026-08-02).

## Step 0 — offer the sweep

Ask exactly one question before anything else:
"Running the catchup playbook. Spawn a cleanup agent first? [Y/n]"
Default yes. "n" is the tactical opt-out: skip the sweep entirely for
this run, note "sweep skipped" in the report, and go straight to
re-grounding.

## Step 1 — the cleanup agent (isolated)

Where this harness can spawn an isolated subagent: spawn one throwaway
agent whose entire instruction is to execute
`.agents/playbooks/drift.md` in this repo — that file carries its
contract (work alone, spawn nothing, one tidy commit, contested items
become flags, reply with exactly one summary line). Never hand the
cleanup agent this playbook. Wait for its summary line before reading
state files: re-grounding happens after the tidy, never in parallel
with it.

Where no subagent facility exists: run no sweep in this window. Report
staleness flags only — counts and candidates observed in the files the
re-ground reads anyway — and fix nothing. (The owner can run the sweep
standalone any time with `playbook drift`.)

## Step 2 — re-ground

Read `AGENTS.md` (the Prime Invariants in full), `.agents/repo-guidance.md`,
`.agents/state.md`, and any active repo docs (plans in flight, open
decisions). Note untracked or ignored agent-control files that affect the
work.

## Report

Summarize, bottom line first: current state, next action, blockers, and
one proposed first action — plus the cleanup agent's summary line (or
"sweep skipped", or the flags-only counts). Make no other changes until
the human responds.
