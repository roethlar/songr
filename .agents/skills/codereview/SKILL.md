---
name: codereview
description: Run the codereview playbook with a named reviewer harness — hunt defects in a landed range or verify the current finding against its record. Use when the owner says codereview [<harness> <model> <effort>] [<base>..<head>] — the bare word included.
# toolkit-owned; edits are drift — see AGENTS.md
---

Run the `codereview` playbook operator: read
`.agents/playbooks/codereview.md` and follow it, with the reviewer harness
named in the request. Grammar:
`codereview <harness> <model> <effort> [<base>..<head>]` (for example
`codereview codex <model> xhigh`), with `review` as a pure alias; a
trailing pinned range dispatches the defect-generation half over landed
commits, and without one the verb continues the active per-finding loop.
The playbook's "Dispatch grammar" section defines how `<model>` is
handled — the owner's literal word, used verbatim and checked against no
list. The named harness is the reviewer; it is dispatched headless and
one-shot per the playbook. If the playbook does not exist in this repo,
say so rather than guessing. The playbook is the authoritative
definition; this skill is only a pointer.
