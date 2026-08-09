---
description: Run the openreview playbook with a named reviewer agent for an unprimed approach-soundness review of a whole change — implementation or plan. Use when the owner says openreview [<agent>] — the bare word included.
# toolkit-owned; edits are drift — see AGENTS.md
---

Run the `openreview` playbook operator: read
`.agents/playbooks/openreview.md` and follow it to get one unprimed
approach-soundness judgment of a whole change — implementation or plan —
from the agent named in your request (e.g. `/openreview codex`,
`/openreview grok`, `/openreview agy`). The named agent is the reviewer
harness; it is dispatched headless and one-shot over a pinned base..head
range per the playbook. If the playbook does not exist in this repo, say so
rather than guessing. The playbook is the authoritative definition; this
file is only a pointer.
