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

## Self-upgrade (v1.22) — opt-in, privileged

TaskHub ships a sidecar container that can run the upgrade from inside the
running app. **It is disabled by default** because enabling it adds a
privileged container with access to the host's docker socket — that's
equivalent to root on the host. Read this section in full before turning it
on in production.

### What it is

- A tiny Node HTTP server in [`updater/server.js`](updater/server.js).
- Image built from [`docker/updater.Dockerfile`](docker/updater.Dockerfile) —
  node:20-alpine plus `git` and `docker-cli`.
- Compose service `updater` (under `profiles: ['upgrade']`) with two mounts:
  - `/var/run/docker.sock:/var/run/docker.sock` — so it can call
    `docker compose up -d --build`
  - `.:/repo` — the host repo dir, so it can `git pull`
- Listens on `0.0.0.0:9000` **inside the compose network only**. No port
  mapping. Caddy never proxies through to it.
- Authenticated by a shared token (`UPDATER_TOKEN`) checked against the
  `X-Updater-Token` header.

### Security trade-offs

- The container holds the docker socket. Anyone who reaches it can run
  arbitrary containers on the host — `docker run -v /:/host …` ⇒ root.
- Mitigations: opt-in compose profile, no port mapping, bearer token, no
  auth bypass. But: a backend compromise = an updater compromise =
  host compromise. **If your threat model rules this out, do not enable
  the sidecar.** The manual `git checkout && docker compose up -d --build`
  flow stays available — it's safer.

### Enable it

```bash
# 1. Generate a long random token.
TOKEN=$(openssl rand -base64 48)

# 2. Append to .env on the host.
echo "UPDATER_URL=http://updater:9000" >> .env
echo "UPDATER_TOKEN=$TOKEN" >> .env

# 3. Bring the sidecar up.
docker compose --profile upgrade up -d --build updater

# 4. Recreate the backend so it picks up UPDATER_URL.
docker compose up -d --force-recreate backend
```

### Use it

- Sign in as a global ADMIN; open **About**.
- If GitHub has a newer release than the running `TASKHUB_VERSION`, a
  **Run upgrade now** button appears next to the version field.
- Click it → confirm the prompt → the SPA shows an "Upgrading… page will
  reload when done" badge, polls `/api/health` every 5 s, and reloads
  itself when the backend comes back.
- Logs of each run: `docker exec taskhub-updater-1 cat /tmp/upgrade.log`.

### What the updater actually runs

**Default (no UPDATER_TARGET_REF set):**

```sh
cd /repo \
  && git fetch origin --tags \
  && git pull --ff-only origin main \
  && docker compose up -d --build
```

Tracks `origin/main`.

**Pinned to a release tag (v1.30.9+):**

Set `UPDATER_TARGET_REF=v1.30.0` in the updater container's environment.
The updater then runs:

```sh
cd /repo \
  && git fetch origin --tags \
  && git checkout 'v1.30.0' \
  && docker compose up -d --build
```

Every upgrade lands on exactly that ref. To move forward, change the
env var and re-deploy the updater (or bump it via the same compose
file). Recommended for production — pinning is how you stop chasing
`main` between explicit upgrades.

**Signed-tag verification (opt-in, v1.30.9+):**

Set `UPDATER_REQUIRE_SIGNED_TAG=true` IN ADDITION to a pinned
`UPDATER_TARGET_REF`. The updater inserts a `git verify-tag` step
before the checkout; an unsigned or untrusted tag aborts the upgrade
before the rebuild. For this to work you need:

- Upstream maintainers signing tags with `git tag -s vX.Y.Z`.
- The signing GPG public key imported in the updater container
  (mount the `~/.gnupg` directory into `/root/.gnupg` or bake the
  pubkey into a custom updater image).

If the verification fails the chain short-circuits — the rebuild
doesn't run, and the response includes a failure in
`/status?logTail` so the operator can see what went wrong.

**Concurrent upgrades (v1.30.9+):**

`POST /upgrade` returns **409 Conflict** while a previous upgrade is
still in flight. The flag is cleared when the spawned shell process
exits (success OR failure). The updater is a single Node process so
the mutex is just an in-memory flag — sufficient because there's no
multi-instance updater to coordinate.

### Phase boundary (S-10)

The two pieces NOT shipped here:

- **Automatic post-upgrade rollback** if `/api/health` doesn't come
  back within a window. The SPA already polls; the updater could
  trigger a `git checkout PREVIOUS && docker compose up -d --build`
  on a health-failure timeout. Deferred — needs a careful design on
  what "previous" means (the ref before the last checkout? the most
  recent successful upgrade?) and how to keep it from looping.
- **Updater self-update**. The updater container itself isn't pulled
  by `docker compose up -d --build` because that command rebuilds
  the services declared in compose's run set, not the privileged
  sidecar gated by the `upgrade` profile. To pick up an updater
  patch today, operators must explicitly `docker compose --profile
  upgrade build updater && docker compose --profile upgrade up -d
  updater`. A "self-upgrade the updater" path would invert the
  control flow and deserves its own design.

### Maintenance window during a backup restore (v1.30.4+)

Note that the **backup-restore** flow (Settings → Backups → Restore) goes
through the same kind of maintenance window the self-upgrade above
relies on:

- The backend writes a `system.maintenanceMode` InstanceSetting and the
  early Fastify hook starts returning **503 Retry-After: 30** for every
  route except `GET /api/health` and `GET /health`.
- In-process schedulers (TASK_DUE, WEBHOOK, RECURRENCE, BACKUP) are
  stopped so a tick doesn't race the table drops.
- `pg_restore --exit-on-error` runs; ANY non-zero exit is failure (v1.30.4
  / S-12). On failure the maintenance flag is cleared and pg_restore's
  stderr is returned verbatim to the admin in the 400 response.
- On success the backend responds 200 then schedules `process.exit(0)`.
  Docker compose's `restart: unless-stopped` brings up a fresh
  container; the new boot clears the maintenance flag.

The SPA shows the 503 as a generic "TaskHub is temporarily unavailable
(restoring backup)" banner during the window. Browser tabs that were
mid-action will surface a friendly error rather than a half-applied
write. Typical wall-clock cost: 5–15 seconds for a small instance.

### When it fails

- The SPA polls for 5 minutes. If `/api/health` doesn't come back, you'll
  see "Backend did not come back within 5 minutes." In that case SSH in
  and check `docker compose logs backend`. The most likely cause is a new
  required env var that wasn't in `.env`.
- Rolling back: `git checkout v1.PREVIOUS && docker compose up -d --build`.
  Schema migrations are additive, so the prior code can read the newer
  schema — see "What carries across upgrades" above.

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
