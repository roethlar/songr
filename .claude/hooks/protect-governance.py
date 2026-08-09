#!/usr/bin/env python3
"""PreToolUse hook: deny file-edit tools access to governance artifacts
installed by the toolkit's refresh. One script, two harnesses.

Installed governance is toolkit-owned (owner ruling 2026-07-16): no in-repo
edit to an installed copy is legitimate; changes route through the toolkit
and propagate by refresh. This hook is defense in depth for the harnesses
with verified blocking hooks - Claude Code and codex - while the primary
layers stay the AGENTS.md invariant and refresh's converge-to-shipped
restore. Blocking uses the JSON permissionDecision deny on stdout with
exit 0: the one shape both harnesses honor (codex logs an exit-2 hook as
failed and lets the tool proceed; Claude Code accepts either - both
probe-verified, see docs/harness-capabilities.md 2026-08-01). Every
failure mode inside the hook exits 0 with no output (fail-open) so a
broken hook can never break editing.

The PROTECTED set is the shipped target list from tools/shipped-set.json,
kept in lockstep by a toolkit test - edit it only via the toolkit.
"""
import json
import os
import sys

PROTECTED = frozenset({
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/commands/catchup.md",
    ".claude/commands/decision.md",
    ".claude/commands/handoff.md",
    ".claude/commands/plan.md",
    ".claude/commands/playbook.md",
    ".claude/commands/codereview.md",
    ".claude/commands/openreview.md",
    ".claude/commands/review.md",
    ".claude/commands/git.md",
    ".claude/commands/toolkit.md",
    ".claude/commands/update-governance.md",
    ".claude/settings.json",
    ".claude/hooks/protect-governance.py",
    ".codex/hooks.json",
    ".agents/playbooks/catchup.md",
    ".agents/playbooks/drift.md",
    ".agents/playbooks/codereview.md",
    ".agents/playbooks/handoff.md",
    ".agents/playbooks/openreview.md",
    ".agents/playbooks/plan.md",
    ".agents/playbooks/git.md",
    ".agents/skills/catchup/SKILL.md",
    ".agents/skills/handoff/SKILL.md",
    ".agents/skills/decision/SKILL.md",
    ".agents/skills/plan/SKILL.md",
    ".agents/skills/playbook/SKILL.md",
    ".agents/skills/update-governance/SKILL.md",
    ".agents/skills/codereview/SKILL.md",
    ".agents/skills/openreview/SKILL.md",
    ".agents/skills/review/SKILL.md",
    ".agents/skills/git/SKILL.md",
    ".agents/skills/toolkit/SKILL.md",
})


# codex apply_patch carries its targets inside the patch envelope in
# tool_input.command (verified on 0.146.0, payload capture 2026-08-01;
# docs/superpowers/specs/2026-06-25-agents-portability-boundary-design.md
# records the same shape). These are the four header forms that name a path.
PATCH_HEADERS = ("*** Add File: ", "*** Update File: ",
                 "*** Delete File: ", "*** Move to: ")


def patch_targets(command):
    """All paths named by an apply_patch envelope, or [] if not one."""
    if "*** Begin Patch" not in command:
        return []
    targets = []
    for line in command.splitlines():
        for header in PATCH_HEADERS:
            if line.startswith(header):
                targets.append(line[len(header):].strip())
    return targets


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        tool_input = payload.get("tool_input") or {}
        raw = tool_input.get("file_path") or tool_input.get("notebook_path")
        if raw:
            candidates = [raw]
        else:
            candidates = patch_targets(tool_input.get("command") or "")
        if not candidates:
            return 0
        # Root precedence: Claude Code exports CLAUDE_PROJECT_DIR; codex
        # does not, but its payload carries the session cwd - and the hook
        # process itself does NOT run from the repo root on codex (verified
        # 2026-08-01), so relative patch paths must resolve against the
        # payload root, never the process cwd.
        root = (os.environ.get("CLAUDE_PROJECT_DIR")
                or payload.get("cwd") or os.getcwd())
        hit, rel = False, ""
        for cand_raw in candidates:
            # realpath both sides: symlinked tmp roots (macOS /var ->
            # /private/var) and symlinks pointed AT protected files must
            # compare equal (join is a no-op for absolute candidates)
            real = os.path.realpath(os.path.join(root, cand_raw))
            rel = os.path.relpath(real, os.path.realpath(root))
            rel = rel.replace(os.sep, "/")
            hit = rel in PROTECTED
            if not hit and os.path.exists(real):
                # Case-insensitive filesystems (macOS, Windows): "agents.md"
                # names the existing AGENTS.md but misses the string lookup -
                # compare identity against each protected file that exists.
                for p in PROTECTED:
                    cand = os.path.join(root, p)
                    if os.path.exists(cand) and os.path.samefile(real, cand):
                        hit = True
                        rel = p
                        break
            if hit:
                break  # any protected path denies the whole call
        if hit:
            reason = (
                "BLOCKED: {} was installed by governance refresh and is "
                "toolkit-owned. Editing installed copies is out of bounds; "
                "any local change is drift and is restored on the next "
                "refresh. Put repo-local rules in .agents/repo-guidance.md "
                "- the file that sticks; changes to installed artifacts "
                "route to the owner for the toolkit.".format(rel))
            sys.stdout.write(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }}) + "\n")
            return 0
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
