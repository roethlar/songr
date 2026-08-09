<!-- toolkit-owned; edits are drift — see AGENTS.md -->

# Playbook: `plan` — the plan contract

Draft or update a durable plan before broad implementation work.

**Plan documents are written for agents, never the owner.** A plan must be
self-contained and implementable by a completely cold, less-capable agent
than the one that wrote it: technical, free of human-facing summary prose,
free of chat or session references that need the originating conversation
to make sense. The owner does not read plan documents.

**Owner decisions come in chat, one at a time, never a batch** — each
stating the problem, the change, and the cost or risk. Silence
authorizes nothing: each decision waits for its own go.

**Record the owner's approved wording durably** (the decisions log, the
plan's status line) so the approval survives the chat. There is no
separate executive-summary document type.

A plan that needs a decision the owner has not ruled on yet says so in
its status line; work proceeds only behind the rulings it has.
