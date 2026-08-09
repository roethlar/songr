---
name: playbook
description: Read the named playbook under .agents/playbooks/ and follow it. Use when the owner says playbook <name>.
# toolkit-owned; edits are drift — see AGENTS.md
---

Run the `playbook` operator defined in this repo's `AGENTS.md` (Operator
Requests): read the named playbook at `.agents/playbooks/<name>.md` - the
name comes from the request - and follow it. If the named playbook does not
exist, say so rather than guessing. `AGENTS.md` is the authoritative
definition; this skill is only a pointer.
