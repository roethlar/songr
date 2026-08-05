#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "[roon-controller] Ensuring backend dependencies..."
if [ ! -d "node_modules" ]; then
  npm install
fi

echo "[roon-controller] Ensuring frontend dependencies..."
if [ ! -d "ui/node_modules" ]; then
  npm --prefix ui install
fi

echo "[roon-controller] Launching backend and frontend (Ctrl+C to stop)..."
npx --yes concurrently \
  "npm run dev" \
  "npm --prefix ui run dev -- --host"
