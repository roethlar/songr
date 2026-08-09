<!-- toolkit-owned; edits are drift — see AGENTS.md -->

# Playbook: delegated git operations (`git`)

A portable workflow for operating git on the owner's behalf. The owner does
not operate git directly: never assume fluency with branches, merges,
remotes, or recovery. These operations are delegation shorthand, not
automation — the owner invokes one, you gather facts, explain the situation
in plain English, and act only within the contract below.

Invoke an operation with `git <operation> …` (in Claude Code: the
tab-completable `/git <operation> …`):

- `git push [local|remote|all]`
- `git reconcile [local|remote|all]`
- `git add-remote <server>`
- `git branch-cleanup`

Scope words are literal — `push remote`, `push all` — never composed forms
like `push remote(all)`; suggest follow-ups to the owner in exactly this
grammar.

This file is durable guidance; it defers to the repo's `AGENTS.md` (Git
Safety above all) and `.agents/` layout wherever they overlap.

## The delegation contract (binding on every operation)

1. **Plain English, always.** Name what an action does to the owner's work,
   never the git mechanics: "this branch's changes are already in main by
   another route, so deleting it loses nothing" — not "ancestry-merged but
   content-verified". No jargon in questions, proposals, or reports.
2. **Facts first.** Gather state read-only and report the situation before
   changing anything.
3. **Act freely only when reversible.** Fetching, pruning stale
   remote-tracking references, and fast-forwarding a local branch onto
   already-published work may proceed without asking; report what was done.
4. **Ask before anything irreversible, destructive, or outward-facing** —
   deleting a branch that carries unlanded work, any merge, resolving
   diverged history, creating a repository on a server. State the proposal
   in plain English and wait for a yes. One question at a time, never a
   batch.
5. **Never rewrite history.** No rebase, amend, squash, or force-push, per
   `AGENTS.md` Git Safety — do not offer them as options. If a situation
   seems to require one, explain the situation and stop.
6. **Never move refs over a dirty working tree.** Report the uncommitted
   work and stop.
7. **Repo-specific rules outrank this playbook.** `.agents/repo-guidance.md`
   may declare, e.g., an expected mirror lag that `reconcile` must report as
   "expected, no action", never as a discrepancy.
8. **Machine facts go to `.agents/machines.md`** (forge CLI paths, auth
   state), dated under the current machine's heading, per the handoff rule.

## Remote classification (`local|remote|all`)

Classify each configured remote by its URL host, deterministically, with no
per-repo configuration: a public forge host (`github.com`, `gitlab.com`,
`bitbucket.org`) is **remote**; any other host (LAN names, IP addresses,
self-hosted forges) is **local**; **all** is every configured remote. If the
requested class matches no configured remote, or a URL defies
classification, say so plainly and ask — never guess.

## `git push [local|remote|all]`

Scope defaults to `all` when omitted. Push the current branch, and its tags,
to each remote in scope, creating the branch on the remote where it does not
exist yet. **This executes immediately. Typing the operation is the
authorization — never prompt for confirmation of a push the owner just
asked for.** The repo's push policy governs pushes the agent would make on
its own initiative, after a commit; it does not re-gate an instruction the
owner has already given. Say what will be pushed where as you do it, not as
a question. A push a remote rejects
(non-fast-forward, permissions, unreachable host) is reported in plain
English with a proposed next step — never retried with force. After pushing,
mention any other local branches that still carry unpushed work.

## `git reconcile [local|remote|all]`

Fetch from every remote in scope, then for each remote × branch pair report
one of four states and act per the contract:

- **In sync** — say so.
- **Behind** (the remote has work this clone lacks, and the local branch can
  simply catch up) — fast-forward and report what arrived (contract §3).
- **Ahead** (local work is unpublished) — offer to push; push on yes.
- **Diverged** (each side has work the other lacks) — explain in plain
  English what each side holds (commit count and subjects), propose a
  resolution — normally merging the remote work into the local branch with a
  plain merge commit — and wait for a yes (contract §4). Rebase is never
  offered (contract §5).

A lag that `.agents/repo-guidance.md` declares expected is reported as
"expected, no action" (contract §7).

## `git add-remote <server>`

`<server>` is a forge shorthand or URL. Resolve the target from, in order:
an existing configured remote's host, an entry in `.agents/machines.md`, or
the URL as given. If the repository does not exist on that server, create
it — `gh` for GitHub, `tea` for gitea, otherwise the forge's API with
existing credentials — after stating exactly what will be created (name, and
visibility defaulting to private) and getting a yes (contract §4). Then add
the remote, verify it with a fetch, and report. Never store or prompt for
credentials; if the CLI or API is unauthenticated, explain in plain English
what the owner must run to log in, and stop.

## `git branch-cleanup`

1. Inventory local branches and stale remote-tracking references; prune the
   stale references (contract §3).
2. Classify every local branch by **content**, never ancestry alone
   (`AGENTS.md` Git Safety): a branch is *landed* only when it provably
   introduces nothing absent from the main branch — content-equivalence
   (`git cherry`) or a direct diff against main; `git branch --merged` alone
   is never sufficient. Everything else is *carrying work*.
3. Present the inventory in plain English: landed branches are proposed for
   deletion as one batch — one yes covers the batch, since deleting them
   loses nothing. Each work-carrying branch is described by what it changes,
   with its options — merge it (a plain merge commit, then re-verify it is
   landed, then propose deleting it), keep it, or delete it (explicitly
   flagged as discarding that work, requiring its own yes) — one branch at a
   time (contract §4).
4. Report the end state: which branches remain and why.

## Anti-patterns

- **Jargon dialog.** Asking the owner to choose between "merge" and "rebase"
  or to interpret ref names is a contract failure; translate to what happens
  to their work, and never offer what §5 bans.
- **Silent destruction.** Deleting, merging, or resolving anything without
  its explicit yes — even when the action looks obviously right.
- **Force as a fallback.** A rejected push or tangled state never escalates
  to `--force`, rebase, or history surgery; explain and stop.
- **Guessing remote identity.** An unclassifiable remote or an ambiguous
  `<server>` gets a plain-English question, not a best guess.
- **Batched questions.** A wall of decisions is how mistakes get approved;
  one question, one answer, then the next.
- **Approval as an override.** When a tool or harness warns an action is
  destructive, prior approval of a *different* step is not a license to
  proceed. Re-verify the fact that makes this action safe (e.g., the work
  is fully contained in the main branch), state that verification, then
  proceed — or ask again.
