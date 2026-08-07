#!/usr/bin/env bash
# Roon Controller — Linux installer
# Builds from source and installs as a systemd service.
# Must be run as root (or via sudo) from the repository root.
#
# Usage:
#   sudo ./scripts/install.sh [options]
#
# Options:
#   --port PORT       HTTP port (default: 3333; on reinstall, an existing
#                     .env PORT wins unless --port is passed explicitly)
#   --install-dir DIR Install path (default: /opt/roon-controller)
#   --user USER       Service user to create/use (default: roon; on
#                     reinstall, the existing unit's User= wins unless
#                     --user is passed explicitly)
#   --no-start        Install but do not start the service
#   --reinstall       Overwrite an existing installation. Preserved across
#                     reinstall: config/ (pairing token), data/ (caches,
#                     recently-played), .env (live service config; only the
#                     PORT line is synced when --port is passed). Rebuilt:
#                     dist/, ui/build, node_modules, and the systemd unit
#                     (backed up first if it was hand-edited).
#   --help            Show this message

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
INSTALL_DIR="/opt/roon-controller"
SERVICE_USER="roon"
USER_EXPLICIT=false
SERVICE_NAME="roon-controller"
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

detect_url_host() {
  local host_ip=""

  if command -v ip >/dev/null 2>&1; then
    host_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}' || true)"
  fi

  if [[ -z "$host_ip" ]] && command -v hostname >/dev/null 2>&1; then
    host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi

  echo "${host_ip:-localhost}"
}

# ── Argument parsing ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)        PORT="$2"; PORT_EXPLICIT=true; shift 2 ;;
    --install-dir) INSTALL_DIR="$2";  shift 2 ;;
    --user)        SERVICE_USER="$2"; USER_EXPLICIT=true; shift 2 ;;
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

# Capture the invoking user so build steps run without root privileges,
# keeping source-tree file ownership clean.
INVOKING_USER="${SUDO_USER:-}"
if [[ -z "$INVOKING_USER" ]]; then
  die "Could not determine the invoking user. Run via sudo, not as a root login shell."
fi

# Must be run from the repo root
[[ -f "package.json" && -d "src" && -d "ui" ]] \
  || die "Run this script from the repository root (directory containing package.json, src/, ui/)."

# Require systemd
command -v systemctl &>/dev/null \
  || die "systemd is required but systemctl was not found."

# Detect node
NODE_BIN=$(command -v node 2>/dev/null || true)
[[ -n "$NODE_BIN" ]] || die "Node.js is not installed.  Install Node 20+ and re-run."

NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[[ "$NODE_MAJOR" -ge 20 ]] \
  || die "Node.js 20 or newer is required (found $("$NODE_BIN" --version))."

# Detect npm
command -v npm &>/dev/null || die "npm is not installed."

# Guard against overwriting an existing install without --reinstall
if [[ -d "$INSTALL_DIR" && "$REINSTALL" == false ]]; then
  die "$INSTALL_DIR already exists.  Use --reinstall to overwrite."
fi

# ── Resolve effective SERVICE_USER against any existing unit ──────────────────
# Reinstall without --user must not silently flip the service back to the
# default user (and re-chown the install away from a custom one): the
# existing unit's User= is the sticky default; explicit --user wins.
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
if [[ "$USER_EXPLICIT" == false && -f "$UNIT_PATH" ]]; then
  EXISTING_UNIT_USER=""
  if grep -qE '^User=' "$UNIT_PATH"; then
    EXISTING_UNIT_USER=$(grep -E '^User=' "$UNIT_PATH" | head -1 | cut -d= -f2 | tr -d '[:space:]')
  fi
  if [[ -n "$EXISTING_UNIT_USER" && "$EXISTING_UNIT_USER" != "$SERVICE_USER" ]]; then
    info "Keeping existing service user '${EXISTING_UNIT_USER}' (pass --user to change)."
    SERVICE_USER="$EXISTING_UNIT_USER"
  fi
fi

# ── Resolve effective PORT against any existing .env ──────────────────────────
# An existing .env is preserved so user customizations (CLIENT_ORIGIN,
# tweaked LOG_LEVEL, etc.) survive --reinstall. But the PORT line gets
# special handling so the summary below — and the actual systemd service —
# agree about what port the service listens on.
ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  # Lookup must be tolerant of a .env without an active PORT= line. Under
  # `set -euo pipefail`, a failed grep would abort the installer before
  # the summary, so guard with `grep -q` and only run the parse pipeline
  # when there's actually a match.
  EXISTING_PORT=""
  if grep -qE '^PORT=' "$ENV_FILE"; then
    EXISTING_PORT=$(grep -E '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '[:space:]')
  fi

  if [[ "$PORT_EXPLICIT" == true ]]; then
    # Explicit --port wins — update the .env so the service actually uses it.
    if [[ -n "$EXISTING_PORT" ]]; then
      if [[ "$EXISTING_PORT" != "$PORT" ]]; then
        info "Updating PORT in existing .env: ${EXISTING_PORT} → ${PORT}"
        sed -i "s/^PORT=.*/PORT=${PORT}/" "$ENV_FILE"
      fi
    else
      # No PORT= line in the existing .env. Append one — without this,
      # the explicit --port would be silently dropped and the service
      # would fall back to the app default.
      info "Appending PORT=${PORT} to existing .env (no PORT= line found)"
      # Make sure the file ends with a newline before appending so we
      # don't merge our line onto the previous one.
      if [[ -s "$ENV_FILE" && -n "$(tail -c 1 "$ENV_FILE")" ]]; then
        echo "" >> "$ENV_FILE"
      fi
      echo "PORT=${PORT}" >> "$ENV_FILE"
    fi
  else
    # No --port passed; honour the .env so summary/URL match reality.
    if [[ -n "$EXISTING_PORT" ]]; then
      PORT="$EXISTING_PORT"
    fi
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo
info "Roon Controller installer"
info "  Install dir : $INSTALL_DIR"
info "  Service user: $SERVICE_USER"
info "  Port        : $PORT"
info "  Node        : $("$NODE_BIN" --version)"
echo

# ── Build (run as invoking user to keep source tree ownership clean) ───────────
# Use runuser (not su) — runuser is designed for root→user switching and does
# not go through PAM authentication, so it cannot trigger account lockouts.
run_as_user() {
  runuser -s /bin/bash -l "$INVOKING_USER" -c "cd '$PWD' && $*"
}

info "Installing backend dependencies..."
run_as_user "npm ci --prefer-offline" 2>&1 | sed 's/^/  /'

info "Building backend..."
run_as_user "npm run build" 2>&1 | sed 's/^/  /'

info "Installing frontend dependencies..."
run_as_user "npm --prefix ui ci --prefer-offline" 2>&1 | sed 's/^/  /'

info "Building frontend..."
run_as_user "npm --prefix ui run build" 2>&1 | sed 's/^/  /'

success "Build complete."

# ── Stop existing service ──────────────────────────────────────────────────────
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  info "Stopping existing service..."
  systemctl stop "$SERVICE_NAME"
fi

# ── Deploy files ───────────────────────────────────────────────────────────────
info "Deploying to $INSTALL_DIR..."

mkdir -p "$INSTALL_DIR/config" "$INSTALL_DIR/data/image-cache" "$INSTALL_DIR/ui"

# Wipe build artefacts before re-copying so files removed in a newer build
# don't survive as stale leftovers. config/ and data/ are NOT touched.
rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/ui/build" "$INSTALL_DIR/vendor"

# Copy built artefacts, vendored dependencies (the file: deps in package.json
# resolve to this directory), and manifests (not source, not node_modules)
cp -r dist               "$INSTALL_DIR/"
cp -r ui/build           "$INSTALL_DIR/ui/"
cp -r vendor             "$INSTALL_DIR/"
cp    package.json       "$INSTALL_DIR/"
cp    package-lock.json  "$INSTALL_DIR/"

# Production node_modules (no devDependencies)
info "Installing production dependencies in $INSTALL_DIR..."
npm ci --omit=dev --prefix "$INSTALL_DIR" --prefer-offline 2>&1 | sed 's/^/  /'

# ── Environment file ───────────────────────────────────────────────────────────
# Keep this template in sync with .env.example at the repo root. PORT
# resolution against any existing .env happened earlier so $PORT here is
# the value that will end up in the file (and used by the service).
if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists — preserving (PORT was synced if --port was passed)."
else
  info "Writing .env..."
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production

# Server host/interface to bind to.
# 0.0.0.0 makes the controller reachable on the LAN — appropriate for a
# single-purpose home appliance. Set HOST=127.0.0.1 to restrict to
# localhost (recommended when running behind a reverse proxy).
HOST=0.0.0.0

# HTTP port for the backend API and socket server.
PORT=${PORT}

# Pino log level (fatal|error|warn|info|debug|trace|silent).
# Set to "trace" temporarily to capture raw Roon subscribe_zones and
# subscribe_queue payloads for queue-debugging purposes.
LOG_LEVEL=info

# Location of the Roon pairing token.
ROON_TOKEN_PATH=${INSTALL_DIR}/config/roon-token.json

# Directory for cached artwork from Roon.
IMAGE_CACHE_PATH=${INSTALL_DIR}/data/image-cache

# Maximum size of the on-disk image cache in bytes. When exceeded, the
# oldest entries (by mtime) are evicted down to ~90% of this cap.
# Default: 10 GB.
IMAGE_CACHE_MAX_BYTES=10737418240

# JSON file for "Recently played on this controller" persistence.
# Atomic write, mode 0o600.
RECENTLY_PLAYED_PATH=${INSTALL_DIR}/data/recently-played.json

# Max entries kept in the rolling Recently Played list (1-1000).
# RECENTLY_PLAYED_CAP=50

# Comma-separated list of allowed origins for Socket.IO CORS, or "*" for any.
# Tighten this when fronting the controller with a reverse proxy or
# exposing beyond the LAN.
# CLIENT_ORIGIN=http://roon.lan,http://192.168.1.10:${PORT}

# Set to "true" if running behind a reverse proxy so rate limits identify
# clients by their forwarded IP rather than the proxy IP.
# TRUST_PROXY=true
EOF
fi

# ── Service user ───────────────────────────────────────────────────────────────
if ! id "$SERVICE_USER" &>/dev/null; then
  info "Creating system user '$SERVICE_USER'..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ── Systemd service ────────────────────────────────────────────────────────────
info "Installing systemd service..."

# The unit is generated — hand edits to it do NOT survive reinstall (put
# persistent overrides in /etc/systemd/system/${SERVICE_NAME}.service.d/
# drop-ins instead; the installer never touches those). As a safety net,
# an existing unit that differs from what we are about to write is backed
# up next to itself before being replaced.
NEW_UNIT=$(mktemp)
cat > "$NEW_UNIT" <<EOF
[Unit]
Description=Roon Controller
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} dist/index.js
EnvironmentFile=${INSTALL_DIR}/.env
Restart=on-failure
RestartSec=5
User=${SERVICE_USER}
Group=${SERVICE_USER}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

if [[ -f "$UNIT_PATH" ]] && ! cmp -s "$NEW_UNIT" "$UNIT_PATH"; then
  UNIT_BACKUP="${UNIT_PATH}.bak-$(date +%Y%m%d%H%M%S)"
  warn "Existing unit differs from the generated one — backing it up to:"
  warn "  ${UNIT_BACKUP}"
  warn "Persistent customizations belong in ${SERVICE_NAME}.service.d/ drop-ins."
  cp -p "$UNIT_PATH" "$UNIT_BACKUP"
fi
install -m 0644 "$NEW_UNIT" "$UNIT_PATH"
rm -f "$NEW_UNIT"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

# ── Start ──────────────────────────────────────────────────────────────────────
if [[ "$START_SERVICE" == true ]]; then
  info "Starting service..."
  systemctl start "$SERVICE_NAME"
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    success "Service is running."
  else
    warn "Service did not start cleanly. Check logs:"
    warn "  journalctl -u $SERVICE_NAME -n 50"
    exit 1
  fi
else
  info "Skipping service start (--no-start was set)."
  info "Start manually with: systemctl start $SERVICE_NAME"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo
success "Installation complete!"
echo
URL_HOST="$(detect_url_host)"
echo "  URL        : http://${URL_HOST}:${PORT}"
echo "  Logs       : journalctl -u ${SERVICE_NAME} -f"
echo "  Stop       : systemctl stop ${SERVICE_NAME}"
echo "  Uninstall  : systemctl disable --now ${SERVICE_NAME} && rm -rf ${INSTALL_DIR}"
echo
echo "  First run: open Roon → Settings → Extensions → enable 'Songr (this machine''s name)'"
echo

