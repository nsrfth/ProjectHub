#!/usr/bin/env bash
#
# W4 (v2.5.32) — ship the newest ProjectHub backup off the box.
#
# The in-app scheduler writes dumps into the `backups_data` Docker volume
# (`/app/backups` inside the backend container): legacy `*.dump` (pg_dump
# custom format) or `*.tar.gz` bundles (database.dump + uploads + secrets +
# manifest). This script copies the MOST RECENT one out of the container and
# pushes it to an offsite destination. Run it from cron on the host, AFTER the
# app has taken its backup (e.g. a few minutes past the backup interval).
#
# It never deletes local backups (the app owns retention there). It is a
# read-and-ship tool — safe to re-run; re-shipping the same file is a no-op for
# rclone/rsync (size+mtime match).
#
# Configuration (environment):
#   OFFSITE_METHOD    rclone | rsync         (required)
#   COMPOSE_DIR       path to the compose project   (default: script's ../ )
#   BACKEND_SERVICE   compose service name          (default: backend)
#   CONTAINER_BACKUP_DIR  dir inside the container   (default: /app/backups)
#
#   # rclone mode (https://rclone.org) — you configure the remote separately:
#   OFFSITE_RCLONE_REMOTE   e.g. "s3:my-bucket/projecthub" or "gdrive:ph"
#   RCLONE_BIN              default: rclone
#
#   # rsync-over-SSH mode:
#   OFFSITE_RSYNC_DEST      e.g. "backup@host:/srv/projecthub-backups/"
#   OFFSITE_SSH_KEY         path to a private key (optional)
#   OFFSITE_SSH_OPTS        extra ssh options (optional)
#
# Exit codes: 0 shipped, non-zero on any failure (so cron/monitoring notices).

set -euo pipefail

log() { printf '[offsite-backup] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BACKEND_SERVICE="${BACKEND_SERVICE:-backend}"
CONTAINER_BACKUP_DIR="${CONTAINER_BACKUP_DIR:-/app/backups}"
METHOD="${OFFSITE_METHOD:-}"

[ -n "$METHOD" ] || die "OFFSITE_METHOD is required (rclone|rsync)"
command -v docker >/dev/null || die "docker not found"

cd "$COMPOSE_DIR"

# Newest backup inside the container (either suffix), by mtime.
newest="$(docker compose exec -T "$BACKEND_SERVICE" sh -c \
  "ls -1t $CONTAINER_BACKUP_DIR/*.tar.gz $CONTAINER_BACKUP_DIR/*.dump 2>/dev/null | head -1" \
  | tr -d '\r' || true)"
[ -n "$newest" ] || die "no backups found in $CONTAINER_BACKUP_DIR — has the app run a backup yet?"
base="$(basename "$newest")"
log "newest backup: $base"

# Stage it on the host in a temp dir we clean up.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
docker compose cp "$BACKEND_SERVICE:$newest" "$stage/$base"
[ -s "$stage/$base" ] || die "staged file is empty: $stage/$base"
size="$(wc -c <"$stage/$base" | tr -d ' ')"
log "staged $base ($size bytes)"

case "$METHOD" in
  rclone)
    [ -n "${OFFSITE_RCLONE_REMOTE:-}" ] || die "OFFSITE_RCLONE_REMOTE is required for rclone mode"
    RCLONE_BIN="${RCLONE_BIN:-rclone}"
    command -v "$RCLONE_BIN" >/dev/null || die "$RCLONE_BIN not found"
    log "rclone copy → $OFFSITE_RCLONE_REMOTE"
    "$RCLONE_BIN" copy "$stage/$base" "$OFFSITE_RCLONE_REMOTE" --no-traverse
    ;;
  rsync)
    [ -n "${OFFSITE_RSYNC_DEST:-}" ] || die "OFFSITE_RSYNC_DEST is required for rsync mode"
    command -v rsync >/dev/null || die "rsync not found"
    ssh_cmd="ssh ${OFFSITE_SSH_OPTS:-}"
    [ -n "${OFFSITE_SSH_KEY:-}" ] && ssh_cmd="$ssh_cmd -i $OFFSITE_SSH_KEY"
    log "rsync → $OFFSITE_RSYNC_DEST"
    rsync -az --partial -e "$ssh_cmd" "$stage/$base" "$OFFSITE_RSYNC_DEST"
    ;;
  *)
    die "unknown OFFSITE_METHOD '$METHOD' (expected rclone|rsync)"
    ;;
esac

log "shipped $base offsite OK"
