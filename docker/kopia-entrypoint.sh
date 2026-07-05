#!/bin/sh
# v2.5.37 — self-configuring Kopia entrypoint.
#
# ProjectHub's backend writes everything the admin enters in Settings → Backups
# to the shared `kopia_secrets` volume (mounted here at /app/secrets) + the
# policy to /app/backups/online-backup.json. This script reads that, connects or
# creates the encrypted Google Drive repository, applies the retention/schedule
# policy, starts the Kopia server (UI + scheduled snapshots), and reconciles on
# file-based triggers the backend drops (reinit / backup-now). No SSH needed.
#
# It reports state back to /app/secrets/status.json so the app can show it.
set -u

SECRETS=/app/secrets
BACKUPS=/app/backups
PW_FILE="$SECRETS/repo-password"
SA_FILE="$SECRETS/kopia-gdrive-sa.json"
POLICY_FILE="$BACKUPS/online-backup.json"
STATUS_FILE="$SECRETS/status.json"
CONNECTED_MARK="$SECRETS/.connected"
SERVER_PID=""

log() { echo "[kopia-entrypoint] $*"; }

# Extract a JSON string/number value by key (crude, no jq in the image).
jval() { grep -o "\"$2\"[[:space:]]*:[[:space:]]*[^,}]*" "$1" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//; s/^"//; s/"$//'; }

write_status() { # initialized(true|false) error
  _init="$1"; _err="$2"; _last=null; _count=0
  if [ "$_init" = "true" ]; then
    _snaps="$(kopia snapshot list "$BACKUPS" --json 2>/dev/null || true)"
    _count="$(printf '%s' "$_snaps" | grep -o '"startTime"' | wc -l | tr -d ' ')"
    _lt="$(printf '%s' "$_snaps" | grep -o '"startTime":"[^"]*"' | tail -1 | sed 's/.*"startTime":"//; s/"$//')"
    [ -n "$_lt" ] && _last="\"$_lt\""
  fi
  _errj=null; [ -n "$_err" ] && _errj="\"$(printf '%s' "$_err" | sed 's/"/\\"/g' | cut -c1-300)\""
  cat > "$STATUS_FILE" <<EOF
{"initialized":$_init,"lastSnapshotAt":$_last,"snapshotCount":$_count,"error":$_errj,"updatedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
}

apply_policy() {
  [ -f "$POLICY_FILE" ] || return 0
  _iv="$(jval "$POLICY_FILE" intervalHours)"
  _kd="$(jval "$POLICY_FILE" keepDaily)"; _kw="$(jval "$POLICY_FILE" keepWeekly)"; _km="$(jval "$POLICY_FILE" keepMonthly)"
  kopia policy set "$BACKUPS" --compression=zstd --keep-latest=10 --keep-annual=1 \
    ${_kd:+--keep-daily=$_kd} ${_kw:+--keep-weekly=$_kw} ${_km:+--keep-monthly=$_km} >/dev/null 2>&1 || true
  [ -n "$_iv" ] && kopia policy set "$BACKUPS" --snapshot-interval="${_iv}h" >/dev/null 2>&1 || true
}

init_repo() {
  rm -f "$CONNECTED_MARK"
  if [ ! -f "$PW_FILE" ] || [ ! -f "$SA_FILE" ]; then
    write_status false "Waiting for the Google service-account key + repository password (set them in Settings → Backups)."
    return 1
  fi
  KOPIA_PASSWORD="$(cat "$PW_FILE")"; export KOPIA_PASSWORD
  _folder=""; [ -f "$POLICY_FILE" ] && _folder="$(jval "$POLICY_FILE" folderId)"
  if [ -z "$_folder" ]; then write_status false "No Google Drive folder id set."; return 1; fi
  if ! kopia repository connect gdrive --credentials-file="$SA_FILE" --folder-id="$_folder" >/tmp/k.log 2>&1; then
    if ! kopia repository create gdrive --credentials-file="$SA_FILE" --folder-id="$_folder" >>/tmp/k.log 2>&1; then
      write_status false "$(tail -3 /tmp/k.log | tr '\n' ' ')"
      return 1
    fi
  fi
  apply_policy
  touch "$CONNECTED_MARK"
  write_status true ""
  log "repository connected + policy applied."
  return 0
}

start_server() {
  [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null && return 0
  [ -f "$CONNECTED_MARK" ] || return 0
  KOPIA_PASSWORD="$(cat "$PW_FILE" 2>/dev/null)"; export KOPIA_PASSWORD
  log "starting kopia server on :51515"
  kopia server start --address=0.0.0.0:51515 --insecure \
    --server-username="${KOPIA_SERVER_USERNAME:-admin}" \
    --server-password="${KOPIA_SERVER_PASSWORD:-admin}" &
  SERVER_PID=$!
}

# First attempt (no-op if creds not uploaded yet — the loop keeps the container
# alive so the admin can finish setup from the UI without a restart).
init_repo || log "not initialized yet — waiting for config from Settings → Backups."
start_server

while true; do
  if [ -f "$SECRETS/reinit" ]; then
    rm -f "$SECRETS/reinit"; log "reinit trigger"; init_repo || true; start_server
  fi
  if [ -f "$SECRETS/backup-now" ]; then
    rm -f "$SECRETS/backup-now"
    if [ -f "$CONNECTED_MARK" ]; then
      log "backup-now trigger"
      if kopia snapshot create "$BACKUPS" >/tmp/snap.log 2>&1; then write_status true ""; else write_status true "$(tail -2 /tmp/snap.log | tr '\n' ' ')"; fi
    fi
  fi
  # Refresh status counters periodically while connected.
  [ -f "$CONNECTED_MARK" ] && write_status true ""
  sleep 10
done
