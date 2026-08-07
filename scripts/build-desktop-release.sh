#!/usr/bin/env bash
# Build the complete desktop artifact set this machine can produce, for THIS
# tree's identity: a private checkout builds "Songr Private"
# (app.songr.desktop.private), an export tree builds the public "Songr" —
# the identity follows the tree marker, never a flag (see
# desktop/scripts/package-app.mjs).
#
#   ./scripts/build-desktop-release.sh
#
# Produces, under desktop/release/artifacts/ (cleared first, so nothing
# stale from an earlier version lingers):
#   dmg (arm64 + x64) · AppImage (arm64 + x64) · deb (arm64 + x64)
#   Windows installer · server tarball · rpm (Linux hosts only — macOS
#   rpmbuild cannot cross-build Linux rpms; fpm dies inside
#   `rpmbuild --target x86_64-unknown-linux`, so on a Mac the rpms come
#   from the release CI or a Linux machine)
#
# Two invocations, deliberately: Linux targets are passed as values of
# electron-builder's `--linux` array flag (this version rejects them as
# bare positionals and a repeated -c.linux.target override keeps only the
# last value), and that array must not swallow the mac/win platform flags.
set -euo pipefail
cd "$(dirname "$0")/.."

LINUX_TARGETS=(AppImage deb)
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "note: building on macOS — rpm targets are skipped (see header)." >&2
elif command -v rpmbuild >/dev/null 2>&1; then
  LINUX_TARGETS+=(rpm)
else
  echo "rpmbuild is required for the rpm targets on Linux hosts:" >&2
  echo "  apt-get install rpm  (or your distro's equivalent)" >&2
  exit 1
fi

rm -rf desktop/release/artifacts

# Leg 1 builds everything (backend, UI, shell) and packages mac + windows,
# wrapping the server tarball on the way.
npm --prefix desktop run package -- --mac --win --server-tar -- --arm64 --x64

# Leg 2 reuses those builds and packages the Linux set.
npm --prefix desktop run package -- --linux --skip-builds -- \
  "${LINUX_TARGETS[@]}" --arm64 --x64

echo
echo "Artifacts in desktop/release/artifacts/:"
# find+du rather than ls/awk: artifact names carry spaces ("Songr Private…").
find desktop/release/artifacts -maxdepth 1 -type f \
  \( -name '*.dmg' -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \
     -o -name '*.exe' -o -name '*.tar.gz' \) -exec du -h {} + | sed 's/^/  /'
