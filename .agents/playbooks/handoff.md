<!-- toolkit-owned; edits are drift — see AGENTS.md -->

# Playbook: `handoff` — fast save-my-place snapshot

Seconds, not minutes (owner constraint: under 30). A handoff is the quick
session-ender: the next session resumes without chat context. The slow
hygiene pass is NOT here — it rides `catchup`.

1. Update `.agents/state.md`:
   - `## Now` — what is in flight, precisely enough to resume: the task,
     where it stands, what is verified.
   - `## Next` — the next action.
   - `## Blockers` — only if something is genuinely live-blocked.
   Volatile facts carry `as of <commit>`; counts owned elsewhere are
   pointed to, never copied; machine-specific facts (CLI paths, local
   tool versions, host layout) go to the tracked `.agents/machines.md`
   under a heading for the current machine, dated, created on first use —
   never into `state.md`, which stays portable.
2. Commit what you wrote as a bookkeeping commit, pushed per
   `.agents/push-policy.md`, no owner ask: the next session and other
   machines read these files only through git, so an uncommitted handoff
   record is a handoff that never happened.

No archive rotation, no re-verification sweep, no mandatory re-anchoring
of volatile facts — that hygiene belongs to `catchup`.
