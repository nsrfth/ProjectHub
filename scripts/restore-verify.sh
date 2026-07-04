#!/usr/bin/env bash
#
# W4 (v2.5.32) — prove a ProjectHub backup actually restores.
#
# A backup you have never restored is a backup you do not have. This script
# takes a dump (newest by default, or a path you pass), restores it into a
# THROWAWAY Postgres container that never touches your live database, and runs
# sanity checks (schema present, Prisma migrations table populated, core tables
# queryable). It cleans up after itself and exits non-zero if anything fails —
# wire it into cron/monitoring so a silently-corrupt backup gets caught.
#
# It reads, never writes, your real data. The only thing it mutates is a
# temporary container + temp dir, both removed on exit.
#
# Usage:
#   scripts/restore-verify.sh [path-to-backup]
#     no arg → newest *.tar.gz / *.dump in the backend container's backup dir.
#     arg    → a host-path .dump or .tar.gz to verify instead.
#
# Configuration (environment):
#   COMPOSE_DIR           compose project dir     (default: script's ../ )
#   BACKEND_SERVICE       compose service         (default: backend)
#   CONTAINER_BACKUP_DIR  dir inside container     (default: /app/backups)
#   PG_IMAGE              throwaway image          (default: postgres:16)

set -euo pipefail

log() { printf '[restore-verify] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BACKEND_SERVICE="${BACKEND_SERVICE:-backend}"
CONTAINER_BACKUP_DIR="${CONTAINER_BACKUP_DIR:-/app/backups}"
PG_IMAGE="${PG_IMAGE:-postgres:16}"

command -v docker >/dev/null || die "docker not found"
cd "$COMPOSE_DIR"

stage="$(mktemp -d)"
CID=""
cleanup() {
  [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1 || true
  rm -rf "$stage"
}
trap cleanup EXIT

# 1. Resolve the backup source into $stage/backup.<suffix>.
src="${1:-}"
if [ -n "$src" ]; then
  [ -s "$src" ] || die "backup file not found or empty: $src"
  cp "$src" "$stage/$(basename "$src")"
  picked="$stage/$(basename "$src")"
  log "verifying provided file: $(basename "$src")"
else
  newest="$(docker compose exec -T "$BACKEND_SERVICE" sh -c \
    "ls -1t $CONTAINER_BACKUP_DIR/*.tar.gz $CONTAINER_BACKUP_DIR/*.dump 2>/dev/null | head -1" \
    | tr -d '\r' || true)"
  [ -n "$newest" ] || die "no backups found in $CONTAINER_BACKUP_DIR"
  base="$(basename "$newest")"
  docker compose cp "$BACKEND_SERVICE:$newest" "$stage/$base"
  picked="$stage/$base"
  log "verifying newest backup: $base"
fi

# 2. Extract database.dump from a bundle, or use the .dump directly.
case "$picked" in
  *.tar.gz)
    tar -xzf "$picked" -C "$stage" || die "could not untar bundle"
    dump="$(find "$stage" -name 'database.dump' -print -quit)"
    [ -n "$dump" ] || die "bundle has no database.dump"
    ;;
  *.dump)
    dump="$picked"
    ;;
  *)
    die "unrecognised backup suffix (expected .tar.gz or .dump): $picked"
    ;;
esac

# 3. pg_restore can inspect the archive without a server — a cheap integrity gate.
docker run --rm -i -v "$stage:/w" "$PG_IMAGE" \
  pg_restore --list "/w/$(basename "$dump")" >/dev/null \
  || die "pg_restore --list failed — the dump is unreadable/corrupt"
log "archive TOC readable ✓"

# 4. Spin up a throwaway Postgres and restore into it.
CID="$(docker run -d -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify "$PG_IMAGE")"
log "throwaway postgres: ${CID:0:12}"
for i in $(seq 1 30); do
  if docker exec "$CID" pg_isready -U postgres -d verify >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && die "throwaway postgres never became ready"
  sleep 1
done

docker exec -i "$CID" pg_restore --no-owner --no-acl -U postgres -d verify \
  < "$dump" 2>"$stage/restore.err" \
  || { log "pg_restore reported issues:"; tail -5 "$stage/restore.err" >&2; die "restore failed"; }
log "restored into throwaway DB ✓"

# 5. Sanity checks on the restored schema.
q() { docker exec "$CID" psql -U postgres -d verify -tAc "$1" 2>/dev/null | tr -d '\r'; }

tables="$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
[ "${tables:-0}" -gt 0 ] || die "restored DB has no public tables"
log "public tables: $tables"

migrations="$(q "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL;")"
[ "${migrations:-0}" -gt 0 ] || die "no applied Prisma migrations in the restore"
log "applied migrations: $migrations"

# Core tables must at least be queryable (row count may legitimately be 0).
for tbl in User Team Project; do
  n="$(q "SELECT count(*) FROM \"$tbl\";")" || die "core table \"$tbl\" not queryable"
  log "\"$tbl\" rows: ${n:-?}"
done

log "RESTORE VERIFIED OK ✓"
