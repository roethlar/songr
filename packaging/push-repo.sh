#!/usr/bin/env bash
# Pushes a rendered manifest tree into a destination repository over SSH.
#
# Deploy keys rather than a personal access token: a deploy key is scoped to
# exactly one repository, so the release workflow can write the Homebrew tap
# and the Scoop bucket without holding a credential that reaches anything else.
# That also means one key per destination, hence --key.
#
# Committing nothing is success, not failure: re-running a release for an
# unchanged version must not fail the workflow.

set -euo pipefail

key=""
repo=""
from=""
message=""

while [ $# -gt 0 ]; do
  case "$1" in
    --key) key="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --from) from="$2"; shift 2 ;;
    --message) message="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for required in key repo from message; do
  if [ -z "${!required}" ]; then
    echo "--$required is required" >&2
    exit 2
  fi
done

if [ ! -d "$from" ]; then
  echo "nothing rendered at $from" >&2
  exit 1
fi

# $from is referenced again after this script cd's into its own clone, so a
# relative path silently resolves to nothing there. That exact miss shipped:
# the v1.1.4 run printed "no manifest change to publish" with a fully
# rendered manifest sitting in the caller's cwd, and exited 0. Absolute,
# always — and an empty source is an error, never a quiet no-op.
from=$(cd "$from" && pwd)
if [ -z "$(cd "$from" && find . -type f -print -quit)" ]; then
  echo "no files under $from" >&2
  exit 1
fi

workdir=$(mktemp -d)
keyfile="$workdir/deploy_key"
checkout="$workdir/checkout"

cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

# A key pasted into a GitHub secret usually loses its trailing newline, and
# ssh rejects a key without one with a bare "invalid format".
printf '%s\n' "$key" > "$keyfile"
chmod 600 "$keyfile"

# GitHub's host key is pinned rather than fetched with `ssh-keyscan github.com`.
# A keyscan is a live network call on port 22 in the middle of the job -- one
# more thing that can hang or fail for reasons that have nothing to do with
# publishing a manifest, and under `set -e` its failure silently kills the
# whole script before it ever attempts the push (caught in local testing: this
# sandbox blocks outbound 22 entirely, and the failure produced no error
# output at all, just a dead script). Pinning is also the more correct
# security posture -- a keyscan is trust-on-first-use, and a pinned key is not.
# Values are GitHub's own published host keys: https://api.github.com/meta,
# `ssh_keys`, re-verified 2026-08-08.
mkdir -p ~/.ssh
cat >> ~/.ssh/known_hosts <<'KNOWN_HOSTS'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
KNOWN_HOSTS

export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"

git clone --depth 1 "$repo" "$checkout"

cd "$checkout"
git config user.name "Songr Release"
git config user.email "release@songr.invalid"

# Staging is driven off the file list in $from, not off "whatever the checkout
# directory contains" -- `git add -A` after a plain overlay copy would stage
# anything that happens to be sitting in that directory for any reason.
# Caught in local testing: something in the machine's own tooling wrote
# unrelated scratch files into this exact checkout path mid-run, and a bare
# `rm` of the checkout before copying was not enough to keep them out, because
# they appeared again between the copy and the `git add -A` -- i.e. the risk is
# not "leftover cruft" but "anything that can write here during the run", which
# a clear-then-copy step cannot close.
#
# The removal this does is scoped to exactly the top-level paths $from
# contains, NOT the whole destination repo. Caught for real against the live
# repos, not merely in theory: an earlier version of this script did
# `git rm -rq -- .` (the whole tree) before restaging, which deleted
# homebrew-tap's README.md and its brew-tap-new-generated CI workflows, and
# scoop-bucket's README.md, on the very first real push -- both had to be
# restored by hand. A destination repo legitimately carries files this script
# has no business touching (a README, CI config, LICENSE); only the
# subtree(s) $from actually owns should ever be cleared and restaged, so a
# renamed or removed package file is still cleaned up without anything
# outside that subtree ever being at risk.
# A glob, not `find -printf`: -printf is a GNU find extension and is silently
# rejected by BSD find (macOS) with no matching top-level entries produced --
# caught locally, where this step then cleared nothing and the test only
# looked correct because that particular run never exercised removal.
for top in "$from"/* "$from"/.[!.]*; do
  [ -e "$top" ] || continue
  git rm -rq --ignore-unmatch -- "$(basename "$top")"
done

while IFS= read -r -d '' relative; do
  relative="${relative#./}"
  mkdir -p "$(dirname "$relative")"
  cp "$from/$relative" "$relative"
  git add -- "$relative"
done < <(cd "$from" && find . -type f -print0)

if git diff --cached --quiet; then
  echo "no manifest change to publish"
  exit 0
fi

git commit -m "$message"
git push
echo "published to $repo"
