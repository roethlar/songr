---
name: catchup
description: Re-ground in this repo's current state, tidy the record, and report. Use when the owner says catchup or asks where things stand.
# toolkit-owned; edits are drift — see AGENTS.md
---

Run the `catchup` operator defined in this repo's `AGENTS.md` (Operator
Requests): read `.agents/playbooks/catchup.md` and follow it — re-ground
in the current state, run the state-hygiene sweep, then report current
state, next action, blockers, and one proposed first action plus what the
sweep cleaned. The playbook is the authoritative definition; this skill is
only a pointer.
