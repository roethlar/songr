---
name: review
description: Pure alias of the codereview skill. Use when the owner says review [<harness> <model> <effort>] [<base>..<head>] — the bare word included.
# toolkit-owned; edits are drift — see AGENTS.md
---

`review` is a pure alias of `codereview`: run the `codereview` skill with
the same arguments (grammar: `codereview <harness> <model> <effort>
[<base>..<head>]`), per `.agents/playbooks/codereview.md`. It never
aliases `openreview`.
