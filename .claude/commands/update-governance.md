---
description: Refresh this repo's governance from the governance toolkit (Bixi). Use when the owner asks to update or refresh governance.
# toolkit-owned; edits are drift — see AGENTS.md
---

Refresh this repo's governance from the governance toolkit (Bixi).

1. Locate the toolkit clone on this machine — never assume a fixed path.
   Check `.agents/machines.md` first (a found clone is recorded there); else
   scan this repo's sibling directories for a checkout containing
   `tools/shipped-set.json`. If none exists, clone one as a sibling of this
   repo and record it in `.agents/machines.md`:
   `git clone https://github.com/roethlar/Bixi.git ../Bixi`.
2. From this repo's root, run the refresh script:
   `py -3 <toolkit>/tools/refresh.py` (Windows) or
   `python3 <toolkit>/tools/refresh.py` (macOS/Linux).
   It syncs the toolkit itself (offline it proceeds on the local copy),
   reconciles this repo to the shipped set, and makes one scoped commit.
   Installed governance is toolkit-owned: content matching no shipped
   version is drift — reported with its introducing commits, then restored.
   Uncommitted changes on touched paths make it refuse. If it flags a
   foreign core file and the owner wants it replaced, re-run with `--force`
   (git history preserves the old content).
3. Report the run's one-line summary in plain English (per-item detail lives
   in the refresh commit message). Surface every DRIFT, FLAG, and
   remediation launch; do not resolve a flagged file without an explicit
   owner decision.
4. If the script flags `AGENTS.md` as foreign and the owner does not want
   `--force`, this repo needs the bootstrap/migration procedure: read
   `<toolkit>/procedures/bootstrap.md` and follow it.

This wrapper adds no write authority: the script's scoped commit is the
refresh; anything beyond it (repo-guidance changes, migrations) goes through
the bootstrap procedure's approval gate.
