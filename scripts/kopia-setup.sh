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

kopia() { docker compose --profile backup run --rm -T kopia "$@"; }

# --- prefer the policy the admin set in Settings → Backups ----------------
# The app mirrors its online-backup config to /app/backups/online-backup.json
# on the shared volume; use it when present so the UI is the source of truth.
# Falls back to env / built-in defaults on a fresh install.
FOLDER_ID="${KOPIA_GDRIVE_FOLDER_ID:-}"
INTERVAL_HOURS=6 KEEP_DAILY=7 KEEP_WEEKLY=4 KEEP_MONTHLY=6
POLICY_JSON="$(docker compose --profile backup run --rm -T --entrypoint sh kopia \
  -c 'cat /app/backups/online-backup.json 2>/dev/null' 2>/dev/null || true)"
if [ -n "$POLICY_JSON" ] && command -v python3 >/dev/null; then
  eval "$(printf '%s' "$POLICY_JSON" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
def g(k, dv):
    v = d.get(k, dv);
    return v if v not in (None, "") else dv
print(f"APP_FOLDER={g(\"folderId\", \"\")}")
print(f"INTERVAL_HOURS={int(g(\"intervalHours\", 6))}")
print(f"KEEP_DAILY={int(g(\"keepDaily\", 7))}")
print(f"KEEP_WEEKLY={int(g(\"keepWeekly\", 4))}")
print(f"KEEP_MONTHLY={int(g(\"keepMonthly\", 6))}")
' 2>/dev/null || true)"
  [ -n "${APP_FOLDER:-}" ] && FOLDER_ID="$APP_FOLDER" && log "using folder id + policy from the app's Settings → Backups."
fi
[ -n "$FOLDER_ID" ] || die "no Drive folder id — set it in Settings → Backups (or KOPIA_GDRIVE_FOLDER_ID in .env)"
KOPIA_GDRIVE_FOLDER_ID="$FOLDER_ID"

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
log "setting retention policy on /app/backups (daily=$KEEP_DAILY weekly=$KEEP_WEEKLY monthly=$KEEP_MONTHLY)…"
kopia policy set /app/backups \
  --compression=zstd \
  --keep-latest=10 \
  --keep-daily="$KEEP_DAILY" --keep-weekly="$KEEP_WEEKLY" --keep-monthly="$KEEP_MONTHLY" --keep-annual=1

# --- schedule: snapshot /app/backups on the configured interval -----------
log "enabling a ${INTERVAL_HOURS}-hourly snapshot schedule…"
kopia policy set /app/backups --snapshot-interval="${INTERVAL_HOURS}h" || \
  log "note: could not set snapshot-interval (older kopia?) — schedule it from the UI instead."

# --- first snapshot -------------------------------------------------------
log "taking an initial snapshot…"
kopia snapshot create /app/backups || die "initial snapshot failed"

log "done. Start the UI:  docker compose --profile backup up -d kopia"
log "Then open http://<host>:51515 and log in with KOPIA_SERVER_USERNAME/PASSWORD."
