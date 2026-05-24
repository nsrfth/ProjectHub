# TaskHub — Upgrade guide

How upgrades work, why they're safe, and the exact steps. Companion to
[INSTALL.md](INSTALL.md) (initial install) and [BACKUP.md](BACKUP.md)
(restore + backup mechanics).

---

## TL;DR — Your data survives every upgrade

**Upgrades do not delete your data. Ever.** Every release follows three rules
the project enforces by design:

1. **Persistent state lives in named Docker volumes**, not container
   filesystems. `docker compose up -d --build` rebuilds the *images* — it
   does **not** touch the volumes. Your Postgres data, uploaded
   attachments, and Let's Encrypt certificates carry across every
   rebuild.
2. **Schema migrations are additive-only.** Every release ships SQL that
   only adds columns / indexes / tables. None of the historical
   migrations drop or rename columns, drop tables, or destroy data.
   Prisma's `migrate deploy` applies them in order at backend boot —
   newer rows pick up new columns with their defaults; older rows are
   untouched.
3. **The only destructive command is `docker compose down -v`** (note
   the `-v` for "volumes"). Nothing in the upgrade flow uses it. The
   troubleshooting section calls this out explicitly so you don't run
   it by accident.

If a release ever needed to drop or rename a column, it would land in two
phases — a deprecation release that adds the new shape, followed by a
removal release months later after you've had time to migrate. That hasn't
happened yet through v1.17.0 and isn't planned.

---

## The standard upgrade

```bash
# 1. Snapshot first (5 seconds; see BACKUP.md for the full retention plan).
docker exec taskhub-postgres-1 pg_dump -U taskhub -d taskhub --format=custom \
  > "backup-$(date +%F).dump"

# 2. Get the new release.
git fetch --tags
git checkout v1.X.Y

# 3. Diff env vars (in case the release added one).
diff .env.example .env || true
# Add any new entries to .env that the release expects. See
# CHANGELOG.md → ### Env / ops under the release section.

# 4. Rebuild + recreate. Backend runs `prisma migrate deploy` at boot.
docker compose up -d --build

# 5. Confirm health.
curl -fsS http://localhost/api/health
# → {"status":"ok"}
```

That's it. Five steps, no manual database surgery, no data loss.

The backend's startup sequence is:

1. Container starts → `npx prisma migrate deploy` runs all pending
   migrations in order
2. Fastify binds the port → `/api/health` starts answering 200
3. Background schedulers (TASK_DUE / webhooks / recurrence) start if
   their env flag is on

If step 1 fails, the container exits and Compose's `restart: unless-stopped`
keeps restarting it; nothing else starts until migrations succeed. The
frontend SPA keeps working from Caddy's `frontend_dist` volume — users see
the UI but API calls 502 until the backend recovers.

---

## What carries across upgrades

| Lives in | Survives `docker compose up -d --build`? | Survives `docker compose down`? | Survives `docker compose down -v`? |
|---|---|---|---|
| Postgres rows (users, teams, projects, tasks, comments, …) | ✅ | ✅ | ❌ — wiped |
| Uploaded attachments (`uploads_data`) | ✅ | ✅ | ❌ — wiped |
| Redis state (rate-limit counters) | ✅ | ✅ | ❌ — wiped |
| Caddy TLS certificates | ✅ | ✅ | ❌ — wiped |
| Backend / frontend container filesystem | ❌ — rebuilt | ❌ — destroyed | ❌ — destroyed |
| Your `.env` file | ✅ — on host, not in containers | ✅ | ✅ |

**Translation:** any command except `down -v` is recoverable. Avoid `-v`
unless you're deliberately resetting the install.

---

## What to do before you upgrade

1. **Back up.** Five-second `pg_dump` from step 1 above. Stash off-host.
2. **Read the CHANGELOG section** for the version you're moving to —
   each release lists new env vars (`### Env / ops`) and explicit
   `### Phase boundary` notes about anything intentionally deferred.
3. **Check for new env vars.** If a release expects a new var and your
   `.env` is missing it, the backend's Zod validator crashes at boot
   with a clear `Invalid environment: X is required` message. Add the
   missing entries and recreate.
4. **If you've enabled SMTP, LDAP, webhooks, or 2FA, back up `MASTER_KEY`
   separately** from Postgres. Losing it makes those encrypted values
   unrecoverable — Postgres rows survive but they can't be decrypted.

---

## What to do after you upgrade

1. **Probe `/api/health`** (curl snippet above). Should return 200.
2. **Probe `/api/system/info`** — `version` should match the tag you
   checked out. If it still says `dev`, set `TASKHUB_VERSION=v1.X.Y` in
   `.env` and recreate the backend; the deploy pipeline can also inject
   this automatically.
3. **Sign in** with your existing admin account. Existing users + data
   are untouched.
4. **Glance at the About page** (`/about`) — if the v1.16 update check
   is enabled, the badge will refresh on the next 6-hour cache cycle.

---

## Rollback

If an upgrade behaves unexpectedly, **rolling code back is one
command**:

```bash
git checkout v1.PREVIOUS
docker compose up -d --build
```

The schema is forward-compatible: a v1.17 schema (with extra columns) is
still readable by v1.16 code (which ignores the new columns). Rolling
**data** back requires the `pg_dump` you took before the upgrade — see
[BACKUP.md § Restore](BACKUP.md).

The rollback caveat: if v1.X added a NEW table you've already written
rows to, rolling back to v1.(X-1) won't crash but those rows become
orphaned (not visible to the old code). Restoring the pre-upgrade dump
removes them too.

---

## Upgrading across multiple releases (e.g. v1.10 → v1.17)

Skipping releases is fine — `prisma migrate deploy` walks every
intermediate migration in order, atomically. You don't have to step
through one release at a time. Two real considerations:

- **Env diff matters more.** Multiple releases may have added their own
  env vars (`MASTER_KEY` in v1.4, `WEBHOOK_DISPATCH_ENABLED` in v1.8,
  `RECURRENCE_ENABLED` in v1.9, `TASK_DUE_ENABLED` revised, `SMTP_*` in
  v1.14, `UPDATE_CHECK_ENABLED` in v1.16, `TASKHUB_VERSION` /
  `TASKHUB_BUILD_TIME` plumbed in v1.17, …). Walk the CHANGELOG from
  your current version to the target and add every new var.
- **Read every `### Phase boundary` between your version and the
  target** — those call out behaviour that was deliberately deferred or
  changed in opt-in ways. Most don't affect existing data; a few
  (e.g. v1.13.0's Persian UI under `languagePreference=FA`) may
  surprise users without warning.

---

## What's NOT safe

Three things you might run that DO delete data — flagged here so they
don't surprise you:

- **`docker compose down -v`** — `-v` removes the named volumes. Wipes
  Postgres + uploads + Redis. Use this only when you're deliberately
  resetting the install (e.g. before a clean re-seed).
- **`docker volume rm taskhub_postgres_data`** — same effect, more
  precise. Wipes only Postgres.
- **Pointing your test suite at the production database.** The backend
  integration tests call `prisma.user.deleteMany()` in `beforeEach`.
  Always export a separate `DATABASE_URL` for tests
  (see [INSTALL.md § Common operations](INSTALL.md#common-operations)).

None of these are part of any release's upgrade flow.

---

## Questions?

Anything in this document unclear, or you hit a surprise during upgrade?
File an issue on the repo or open the user manual via the 📖 corner
button.
