<!-- toolkit-owned; edits are drift — see AGENTS.md -->

# Playbook: `drift` — the isolated state-hygiene sweep

Not an owner verb: this playbook is executed by the throwaway cleanup
agent that `catchup` spawns (owner design 2026-08-02), or directly on
the owner's plain words (`playbook drift`). It exists as its own file so
the cleanup agent never reads `catchup` — an agent handed the catchup
playbook is one obedient read away from re-asking the spawn question or
spawning recursively.

## Contract (cleanup agent)

- Work alone in your own context. **Spawn nothing.** Ask nothing.
- Apply the checklist below to this repo's `.agents/` records only.
- Commit everything you changed as **one tidy commit**.
- Decide nothing contested: anything that needs an owner ruling, or
  whose evidence you cannot verify, becomes a flag in your summary —
  never a change.
- Do not re-ground, plan, or report beyond your final message: reply
  with exactly **one summary line**, e.g.
  "rotated 4, dropped 1 stale fact, flagged 2 for judgment", and stop.

## Checklist (`.agents/` records only)

- Rotate landed or superseded `## Now` entries in `state.md` verbatim to
  `docs/history/state-archive.md` (create on first use).
- Re-verify the recorded basis of every parked or blocked item; move
  anything falsified into `## Blockers` with the new evidence.
- Volatile facts (CI state, counts) carry `as of <commit>` and are
  re-verified or dropped.
- Push status is never recorded in state files — git owns it, sessions
  check it live, and unpushed work is mentioned only in the moment it
  matters — so any recorded push-state line is **deleted on sight**, not
  refreshed (2026-07-11 ruling).
- A count or enumeration another file owns is pointed to, never copied.
- Machine-specific facts live in `.agents/machines.md`; prune stale
  entries there.
- A doc, decision, or guidance claim that disagrees with repo evidence:
  fix the lower-authority source — a repo-owned file in place, a
  refresh-installed copy is report-and-route, never edited — or report
  the unresolved conflict as a flag.
