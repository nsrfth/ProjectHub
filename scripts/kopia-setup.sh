#!/usr/bin/env bash
#
# Kopia one-time setup for ProjectHub (v2.5.35).
#
# Creates (or connects to) the encrypted Kopia repository on Google Drive,
# sets a retention policy on the app's backup dumps, and takes a first
# snapshot. Run this ONCE on the host, from the compose project dir, after you
# have:
#   1. put a Google Cloud service-account key at  secrets/kopia-gdrive-sa.json
#   2. shared a Drive folder with that service account and copied its folder id
#   3. set these in .env:
#        KOPIA_PASSWORD           long random string — the repo encryption key
#        KOPIA_SERVER_USERNAME    web-UI login user
#        KOPIA_SERVER_PASSWORD    web-UI login password
#        KOPIA_GDRIVE_FOLDER_ID   the Drive folder id
#   (full walkthrough: scripts/README.md → "Kopia + Google Drive")
#
# After this succeeds, start the UI:  docker compose --profile backup up -d kopia
# Then open  http://<host>:51515  and log in with the KOPIA_SERVER_* creds.

set -euo pipefail
log() { printf '[kopia-setup] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$COMPOSE_DIR"

# --- preflight ------------------------------------------------------------
[ -f secrets/kopia-gdrive-sa.json ] || die "secrets/kopia-gdrive-sa.json missing — add the service-account key first"
# shellcheck disable=SC1091
set -a; [ -f .env ] && . ./.env; set +a
[ -n "${KOPIA_PASSWORD:-}" ]         || die "KOPIA_PASSWORD not set in .env"
[ -n "${KOPIA_GDRIVE_FOLDER_ID:-}" ] || die "KOPIA_GDRIVE_FOLDER_ID not set in .env"

kopia() { docker compose --profile backup run --rm kopia "$@"; }

# --- connect, or create if the repo doesn't exist yet ---------------------
log "connecting to the Google Drive repository…"
if kopia repository connect gdrive \
     --credentials-file=/app/sa.json \
     --folder-id="$KOPIA_GDRIVE_FOLDER_ID" >/dev/null 2>&1; then
  log "connected to an existing repository."
else
  log "no repository found — creating a new one…"
  kopia repository create gdrive \
    --credentials-file=/app/sa.json \
    --folder-id="$KOPIA_GDRIVE_FOLDER_ID" \
    || die "repository create failed (check the folder id + that the folder is shared with the service account)"
  log "repository created."
fi

# --- retention + compression policy on the dump directory -----------------
log "setting retention policy on /app/backups…"
kopia policy set /app/backups \
  --compression=zstd \
  --keep-latest=10 --keep-daily=7 --keep-weekly=4 --keep-monthly=6 --keep-annual=1

# --- schedule: snapshot /app/backups every 6h while the server runs -------
log "enabling a 6-hourly snapshot schedule…"
kopia policy set /app/backups --snapshot-interval=6h || \
  log "note: could not set snapshot-interval (older kopia?) — schedule it from the UI instead."

# --- first snapshot -------------------------------------------------------
log "taking an initial snapshot…"
kopia snapshot create /app/backups || die "initial snapshot failed"

log "done. Start the UI:  docker compose --profile backup up -d kopia"
log "Then open http://<host>:51515 and log in with KOPIA_SERVER_USERNAME/PASSWORD."
