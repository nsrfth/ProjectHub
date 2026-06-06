# Backup & restore

TaskHub's persistent state lives in three Docker named volumes:

| Volume          | What's in it                                      | Loss impact |
| --------------- | ------------------------------------------------- | ----------- |
| `postgres_data` | Users, teams, projects, tasks, comments, activity | **Total.** Catastrophic — every business object lives here. |
| `uploads_data`  | Attachment blobs (the files themselves)           | **High.** Database rows survive but their files become broken links. |
| `redis_data`    | Rate-limit counters, session-adjacent ephemera    | **Low.** Recreated on first request. Optional. |

`caddy_data` / `caddy_config` hold Let's Encrypt certificates — backing them
up isn't strictly necessary (Caddy will re-issue on restart) but it spares
the rate-limited ACME dance.

Compose project name in the examples below is `taskhub` (Docker prepends it to
volume names, so the actual volume is `taskhub_postgres_data`). Adjust if
yours differs.

---

## Postgres (the important one)

Use logical dumps, not file-level volume copies. `pg_dump` runs against a
live container and produces a portable file that restores cleanly across
Postgres minor versions.

### Backup

```powershell
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
docker exec taskhub-postgres-1 pg_dump -U taskhub -d taskhub --format=custom `
  | Set-Content -NoNewline -AsByteStream "backup\taskhub_$stamp.dump"
```

`--format=custom` gives you a compressed binary dump that supports parallel
restore (`pg_restore -j N`) and selective object restore (`pg_restore -L`).

For a SQL-text dump (eyeballable, larger):

```powershell
docker exec taskhub-postgres-1 pg_dumpall -U taskhub > "backup\taskhub_$stamp.sql"
```

### Restore

#### Via the admin UI (v1.30.4+, recommended)

Settings → Backups → click "Restore" on a stored dump (or upload one
first). The restore flow is **orchestrated** so the database isn't being
written to while pg_restore is running:

1. The backend writes a `system.maintenanceMode` InstanceSetting flag.
2. The early Fastify hook starts returning **503 (Retry-After: 30)** to
   every route except `GET /api/health` and `GET /health` (the docker
   healthcheck endpoint).
3. The in-process schedulers (TASK_DUE, WEBHOOK, RECURRENCE, BACKUP) are
   stopped so no tick races the table drops.
4. `pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error`
   runs against the live database. `--exit-on-error` means the first
   SQL error aborts; the backend treats ANY non-zero exit code as
   failure (v1.30.4 / S-12 fix). Failure: the maintenance flag is
   cleared, pg_restore's stderr is returned to the admin in the 400
   response body, and the app keeps serving (schedulers are off — see
   below).
5. On success the backend responds 200, then schedules `process.exit(0)`.
   `docker compose`'s `restart: unless-stopped` brings up a fresh
   container; the new boot clears the maintenance flag and reopens.

The user-facing maintenance window is typically 5–15 seconds for a
small instance — most of it is the container restart, not pg_restore
itself.

**After a failed restore:** the schedulers remain stopped (they were
stopped in step 3 and the failure path doesn't restart them — the
safest assumption is the DB is now in an unknown state). Restart the
backend container with `docker compose restart backend` to bring them
back, or trigger another restore once you've identified the dump
problem.

#### Manual fallback (any version, or recovering a hard-broken instance)

If the admin UI is unreachable (or you're restoring into a freshly
provisioned host), drop to the CLI:

```powershell
# 1. Recreate the empty DB if needed.
docker exec taskhub-postgres-1 psql -U taskhub -d postgres `
  -c "DROP DATABASE IF EXISTS taskhub;" `
  -c "CREATE DATABASE taskhub OWNER taskhub;"

# 2. Restore from the custom-format dump.
Get-Content -AsByteStream "backup\taskhub_2026-05-22_1900.dump" `
  | docker exec -i taskhub-postgres-1 pg_restore -U taskhub -d taskhub --clean --if-exists
```

After restore, run `prisma migrate deploy` from the backend container — if
the dump pre-dates new migrations, this brings the schema forward:

```powershell
docker compose run --rm backend npx prisma migrate deploy
```

### Schedule (Linux host with the same compose stack)

Drop this in `/etc/cron.daily/taskhub-backup` (one daily dump, 14-day retention):

```sh
#!/bin/sh
set -eu
STAMP=$(date -u +%Y-%m-%d)
BACKUP_DIR=/var/backups/taskhub
mkdir -p "$BACKUP_DIR"
docker exec taskhub-postgres-1 pg_dump -U taskhub -d taskhub --format=custom \
  > "$BACKUP_DIR/taskhub_$STAMP.dump"
find "$BACKUP_DIR" -name 'taskhub_*.dump' -mtime +14 -delete
```

For point-in-time recovery, configure WAL archiving on the Postgres container
instead — out of scope for this doc; see the Postgres manual chapter
"Continuous Archiving and Point-in-Time Recovery."

---

## Uploads volume

The attachment blobs sit on the named volume `uploads_data`, mounted at
`/app/uploads` inside the backend container. Filenames there are
server-generated opaque storage keys; the human-readable filename is in the
Postgres `Attachment.filename` row. **Back up Postgres + uploads together** —
restoring one without the other leaves dangling references.

### Backup

```powershell
# Stream a tarball of the volume contents through a throwaway alpine container.
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
docker run --rm `
  -v taskhub_uploads_data:/data:ro `
  -v "${PWD}\backup:/backup" `
  alpine tar -czf "/backup/uploads_$stamp.tar.gz" -C /data .
```

### Restore

```powershell
docker run --rm `
  -v taskhub_uploads_data:/data `
  -v "${PWD}\backup:/backup:ro" `
  alpine sh -c "rm -rf /data/* && tar -xzf /backup/uploads_2026-05-22_1900.tar.gz -C /data"
```

If you've migrated to S3-compatible object storage, none of the above
applies — back up the bucket instead.

---

## Redis (optional)

The compose file already enables AOF (`--appendonly yes`), so durability on
restart is configured. AOF + RDB files live in the `redis_data` volume.

Backing up Redis is **not required** — losing it just resets rate-limit
counters and forces re-login (sessions are JWT-based, so even that depends
on cookie/refresh-token state, which lives in Postgres). Skip unless you
care about preserving in-flight rate-limit windows.

If you do want it:

```powershell
docker exec taskhub-redis-1 redis-cli BGSAVE
# Wait a few seconds for the background save to complete, then snapshot
# the volume the same way as uploads.
docker run --rm `
  -v taskhub_redis_data:/data:ro `
  -v "${PWD}\backup:/backup" `
  alpine tar -czf /backup/redis_$(Get-Date -Format yyyy-MM-dd).tar.gz -C /data .
```

Restore is the inverse `tar -xzf` into the volume, then `docker compose
restart redis`.

---

## Verifying a backup

Untested backups are folklore. After each schedule change:

1. Spin up a throwaway compose project (`COMPOSE_PROJECT_NAME=taskhub-verify
   docker compose up -d postgres`).
2. Restore the latest dump into it.
3. Confirm a known-good query: `SELECT COUNT(*) FROM "Task";` should match
   what you saw on production at the dump time.
4. Tear it down (`docker compose down -v`).

Once a quarter, restore into a real backend container and exercise the UI
for ten minutes — that's the only check that catches restored-but-unusable
state (corrupted blobs, missing migrations, etc.).
