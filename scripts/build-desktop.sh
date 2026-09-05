#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf desktop/release/artifacts
npm --prefix desktop run package
