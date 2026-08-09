---
description: Run the codereview playbook with a named reviewer harness — hunt defects in a landed range or verify the current finding against its record. Use when the owner says codereview [<harness> <model> <effort>] [<base>..<head>] — the bare word included.
# toolkit-owned; edits are drift — see AGENTS.md
---

Run the `codereview` playbook operator: read
`.agents/playbooks/codereview.md` and follow it. Grammar:
`/codereview <harness> <model> <effort> [<base>..<head>]` (e.g.
`/codereview codex <model> xhigh`); a trailing pinned range dispatches
the defect-generation half over landed commits, and without one the verb
continues the active per-finding loop. `<model>` is the owner's literal
word, used verbatim and checked against no list, per the playbook's
"Dispatch grammar" section, and `/review` is a
pure alias of this command. The named harness is the reviewer; it is
dispatched headless and one-shot per the playbook. If the
playbook does not exist in this repo, say so rather than guessing. The
playbook is the authoritative definition; this file is only a pointer.
