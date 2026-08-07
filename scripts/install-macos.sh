#!/usr/bin/env bash
# Roon Controller — macOS installer
# Builds from source and installs as a launchd service.
# Must be run as root (or via sudo) from the repository root.
#
# Usage:
#   sudo ./scripts/install-macos.sh [options]
#
# Options:
#   --port PORT       HTTP port (default: 3333; on reinstall, an existing
#                     .env PORT wins unless --port is passed explicitly)
#   --install-dir DIR Install path (default: /opt/roon-controller)
#   --no-start        Install but do not start the service
#   --reinstall       Overwrite an existing installation. Preserved across
#                     reinstall: config/ (pairing token), data/ (caches,
#                     recently-played), .env — which is the SOURCE OF TRUTH
#                     for the regenerated launchd plist, so .env edits
#                     survive and take effect on reinstall. Rebuilt: dist/,
#                     ui/build, node_modules, and the plist (backed up
#                     first if it was hand-edited).
#   --help            Show this message

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
INSTALL_DIR="/opt/roon-controller"
SERVICE_LABEL="com.roon.controller"
PLIST_PATH="/Library/LaunchDaemons/${SERVICE_LABEL}.plist"
LOG_DIR="/Library/Logs/RoonController"
PORT="3333"
PORT_EXPLICIT=false
START_SERVICE=true
REINSTALL=false

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[install]${NC} $*"; }
success() { echo -e "${GREEN}[install]${NC} $*"; }
warn()    { echo -e "${YELLOW}[install]${NC} $*"; }
die()     { echo -e "${RED}[install] ERROR:${NC} $*" >&2; exit 1; }

# ── Argument parsing ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)        PORT="$2"; PORT_EXPLICIT=true; shift 2 ;;
    --install-dir) INSTALL_DIR="$2";  shift 2 ;;
    --no-start)    START_SERVICE=false; shift ;;
    --reinstall)   REINSTALL=true;    shift ;;
    --help)
      sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $1  (use --help for usage)" ;;
  esac
done

# ── Pre-flight checks ──────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "This script must be run as root.  Try: sudo $0 $*"

INVOKING_USER="${SUDO_USER:-}"
if [[ -z "$INVOKING_USER" ]]; then
  die "Could not determine the invoking user. Run via sudo, not as a root login shell."
fi

[[ "$(uname)" == "Darwin" ]] || die "This installer is for macOS only."

[[ -f "package.json" && -d "src" && -d "ui" ]] \
  || die "Run this script from the repository root (directory containing package.json, src/, ui/)."

# Detect node — check common Homebrew and nvm locations
NODE_BIN=$(command -v node 2>/dev/null || true)
if [[ -z "$NODE_BIN" ]]; then
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
[[ -n "$NODE_BIN" ]] || die "Node.js is not installed.  Install Node 20+ (e.g. brew install node) and re-run."

NODE_MAJOR=$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[[ "$NODE_MAJOR" -ge 20 ]] \
  || die "Node.js 20 or newer is required (found $("$NODE_BIN" --version))."

NPM_BIN=$(command -v npm 2>/dev/null || dirname "$NODE_BIN")/npm
[[ -x "$NPM_BIN" ]] || NPM_BIN=$(command -v npm 2>/dev/null || true)
[[ -n "$NPM_BIN" ]] || die "npm is not installed."

if [[ -d "$INSTALL_DIR" && "$REINSTALL" == false ]]; then
  die "$INSTALL_DIR already exists.  Use --reinstall to overwrite."
fi

# ── Resolve effective config against any existing .env ────────────────────────
# The plist below is REGENERATED from .env on every install, so .env is the
# single source of truth for service config on macOS (mirrors the Linux
# installer, where systemd reads .env directly). An existing .env is
# preserved; only its PORT line is synced when --port is passed explicitly.
ENV_FILE="$INSTALL_DIR/.env"

# Read KEY from .env, falling back to DEFAULT. Tolerates a missing file or
# a missing/commented-out line.
env_get() {
  local value=""
  if [[ -f "$ENV_FILE" ]] && grep -qE "^$1=" "$ENV_FILE"; then
    value=$(grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-)
  fi
  echo "${value:-$2}"
}

if [[ -f "$ENV_FILE" ]]; then
  if [[ "$PORT_EXPLICIT" == true ]]; then
    EXISTING_PORT=$(env_get PORT "")
    if [[ -n "$EXISTING_PORT" ]]; then
      if [[ "$EXISTING_PORT" != "$PORT" ]]; then
        info "Updating PORT in existing .env: ${EXISTING_PORT} → ${PORT}"
        sed -i '' "s/^PORT=.*/PORT=${PORT}/" "$ENV_FILE"
      fi
    else
      info "Appending PORT=${PORT} to existing .env (no PORT= line found)"
      if [[ -s "$ENV_FILE" && -n "$(tail -c 1 "$ENV_FILE")" ]]; then
        echo "" >> "$ENV_FILE"
      fi
      echo "PORT=${PORT}" >> "$ENV_FILE"
    fi
  else
    # No --port passed; the existing .env wins so a reinstall never
    # silently resets a customized port back to the script default.
    PORT=$(env_get PORT "$PORT")
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo
info "Roon Controller macOS installer"
info "  Install dir : $INSTALL_DIR"
info "  Port        : $PORT"
info "  Node        : $("$NODE_BIN" --version)"
echo

# ── Build (as invoking user) ──────────────────────────────────────────────────
run_as_user() {
  sudo -u "$INVOKING_USER" bash -c "cd '$PWD' && $*"
}

info "Installing backend dependencies..."
run_as_user "$NPM_BIN ci --prefer-offline" 2>&1 | sed 's/^/  /'

info "Building backend..."
run_as_user "$NPM_BIN run build" 2>&1 | sed 's/^/  /'

info "Installing frontend dependencies..."
run_as_user "$NPM_BIN --prefix ui ci --prefer-offline" 2>&1 | sed 's/^/  /'

info "Building frontend..."
run_as_user "$NPM_BIN --prefix ui run build" 2>&1 | sed 's/^/  /'

success "Build complete."

# ── Stop existing service ──────────────────────────────────────────────────────
if launchctl list "$SERVICE_LABEL" &>/dev/null; then
  info "Stopping existing service..."
  launchctl bootout system/"$SERVICE_LABEL" 2>/dev/null || true
fi

# ── Deploy files ───────────────────────────────────────────────────────────────
info "Deploying to $INSTALL_DIR..."

mkdir -p "$INSTALL_DIR/config" "$INSTALL_DIR/data/image-cache" "$INSTALL_DIR/ui" "$LOG_DIR"

# Wipe build artefacts before re-copying so files removed in a newer build
# don't survive as stale leftovers. config/ and data/ are NOT touched.
rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/ui/build" "$INSTALL_DIR/vendor"

cp -R dist               "$INSTALL_DIR/"
cp -R ui/build           "$INSTALL_DIR/ui/"
cp -R vendor             "$INSTALL_DIR/"
cp    package.json       "$INSTALL_DIR/"
cp    package-lock.json  "$INSTALL_DIR/"

info "Installing production dependencies in $INSTALL_DIR..."
"$NPM_BIN" ci --omit=dev --prefix "$INSTALL_DIR" --prefer-offline 2>&1 | sed 's/^/  /'

# ── Environment file ───────────────────────────────────────────────────────────
# launchd doesn't support EnvironmentFile, so the plist below carries the
# runtime environment — but the plist is GENERATED FROM this .env, which is
# the file to edit. After editing .env, re-run the installer with
# --reinstall (or hand-sync the plist) to apply.
# Keep this template in sync with .env.example at the repo root.
if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists — preserving (PORT was synced if --port was passed)."
else
  info "Writing .env (the plist is generated from it)..."
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=${PORT}
LOG_LEVEL=info
ROON_TOKEN_PATH=${INSTALL_DIR}/config/roon-token.json
IMAGE_CACHE_PATH=${INSTALL_DIR}/data/image-cache
IMAGE_CACHE_MAX_BYTES=10737418240
RECENTLY_PLAYED_PATH=${INSTALL_DIR}/data/recently-played.json
# RECENTLY_PLAYED_CAP=50
# CLIENT_ORIGIN=http://roon.lan,http://192.168.1.10:${PORT}
# TRUST_PROXY=true
EOF
fi

# ── launchd plist ──────────────────────────────────────────────────────────────
info "Installing launchd service..."

# Every env value below is read from the preserved .env so hand edits
# there survive reinstall and take effect. Optional keys (CLIENT_ORIGIN,
# TRUST_PROXY, RECENTLY_PLAYED_CAP) are included only when set in .env.
PL_HOST=$(env_get HOST "0.0.0.0")
PL_LOG_LEVEL=$(env_get LOG_LEVEL "info")
PL_TOKEN_PATH=$(env_get ROON_TOKEN_PATH "${INSTALL_DIR}/config/roon-token.json")
PL_IMG_PATH=$(env_get IMAGE_CACHE_PATH "${INSTALL_DIR}/data/image-cache")
PL_IMG_MAX=$(env_get IMAGE_CACHE_MAX_BYTES "10737418240")
PL_RP_PATH=$(env_get RECENTLY_PLAYED_PATH "${INSTALL_DIR}/data/recently-played.json")
PL_RP_CAP=$(env_get RECENTLY_PLAYED_CAP "")
PL_CLIENT_ORIGIN=$(env_get CLIENT_ORIGIN "")
PL_TRUST_PROXY=$(env_get TRUST_PROXY "")

OPTIONAL_PLIST_KEYS=""
if [[ -n "$PL_RP_CAP" ]]; then
  OPTIONAL_PLIST_KEYS+="
      <key>RECENTLY_PLAYED_CAP</key>
      <string>${PL_RP_CAP}</string>"
fi
if [[ -n "$PL_CLIENT_ORIGIN" ]]; then
  OPTIONAL_PLIST_KEYS+="
      <key>CLIENT_ORIGIN</key>
      <string>${PL_CLIENT_ORIGIN}</string>"
fi
if [[ -n "$PL_TRUST_PROXY" ]]; then
  OPTIONAL_PLIST_KEYS+="
      <key>TRUST_PROXY</key>
      <string>${PL_TRUST_PROXY}</string>"
fi

NEW_PLIST=$(mktemp)
cat > "$NEW_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${INSTALL_DIR}/dist/index.js</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>NODE_ENV</key>
      <string>production</string>
      <key>HOST</key>
      <string>${PL_HOST}</string>
      <key>PORT</key>
      <string>${PORT}</string>
      <key>LOG_LEVEL</key>
      <string>${PL_LOG_LEVEL}</string>
      <key>ROON_TOKEN_PATH</key>
      <string>${PL_TOKEN_PATH}</string>
      <key>IMAGE_CACHE_PATH</key>
      <string>${PL_IMG_PATH}</string>
      <key>IMAGE_CACHE_MAX_BYTES</key>
      <string>${PL_IMG_MAX}</string>
      <key>RECENTLY_PLAYED_PATH</key>
      <string>${PL_RP_PATH}</string>${OPTIONAL_PLIST_KEYS}
    </dict>

    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/out.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/error.log</string>
  </dict>
</plist>
EOF

# The plist is generated — edit .env and reinstall rather than editing it.
# As a safety net, an existing plist that differs from the generated one is
# backed up before being replaced.
if [[ -f "$PLIST_PATH" ]] && ! cmp -s "$NEW_PLIST" "$PLIST_PATH"; then
  PLIST_BACKUP="${PLIST_PATH}.bak-$(date +%Y%m%d%H%M%S)"
  warn "Existing plist differs from the generated one — backing it up to:"
  warn "  ${PLIST_BACKUP}"
  cp -p "$PLIST_PATH" "$PLIST_BACKUP"
fi
install -m 0644 "$NEW_PLIST" "$PLIST_PATH"
rm -f "$NEW_PLIST"

# ── Start ──────────────────────────────────────────────────────────────────────
if [[ "$START_SERVICE" == true ]]; then
  info "Starting service..."
  launchctl bootstrap system "$PLIST_PATH"
  sleep 2
  if launchctl list "$SERVICE_LABEL" &>/dev/null; then
    success "Service is running."
  else
    warn "Service did not start cleanly. Check logs:"
    warn "  cat ${LOG_DIR}/error.log"
    exit 1
  fi
else
  info "Skipping service start (--no-start was set)."
  info "Start manually with: sudo launchctl bootstrap system $PLIST_PATH"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo
success "Installation complete!"
echo
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "localhost")
echo "  URL        : http://${LOCAL_IP}:${PORT}"
echo "  Logs       : tail -f ${LOG_DIR}/out.log"
echo "  Stop       : sudo launchctl bootout system/${SERVICE_LABEL}"
echo "  Uninstall  : sudo launchctl bootout system/${SERVICE_LABEL}; sudo rm -rf ${INSTALL_DIR} ${PLIST_PATH}"
echo
echo "  First run: open Roon > Settings > Extensions > enable 'Songr (this machine''s name)'"
echo

