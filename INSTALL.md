# TaskHub — Installation guide

This document walks a fresh host through bringing TaskHub up end-to-end —
prerequisites, configuration, first sign-in, optional integrations, and the
operations you'll do later (upgrade, re-seed, run migrations, run tests).

For the *why* behind the design, see [ARCHITECTURE.md](ARCHITECTURE.md).
For backups + restore, see [BACKUP.md](BACKUP.md). The day-to-day user-facing
manual lives in [USER_MANUAL.md](USER_MANUAL.md) (English) and
[USER_MANUAL.fa.md](USER_MANUAL.fa.md) (Persian).

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Quick start (Docker Compose)](#quick-start-docker-compose)
3. [Local development (no Docker for the apps)](#local-development-no-docker-for-the-apps)
4. [First admin sign-in](#first-admin-sign-in)
5. [Environment variables — full catalog](#environment-variables--full-catalog)
6. [HTTPS with Caddy](#https-with-caddy)
7. [Optional integrations](#optional-integrations)
   - [SMTP (verification + password reset + due-date emails)](#smtp)
   - [LDAP / Active Directory](#ldap--active-directory)
   - [SCIM 2.0 provisioning](#scim-20-provisioning)
   - [Webhooks](#webhooks)
   - [API tokens](#api-tokens)
   - [Recurring tasks](#recurring-tasks)
8. [Background schedulers](#background-schedulers)
9. [Verifying the install](#verifying-the-install)
10. [Common operations](#common-operations)
11. [Upgrading](#upgrading)
12. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Component | Minimum | Notes |
|---|---|---|
| Docker Engine | 24+ | Includes `docker compose` (v2) sub-command. |
| Disk | 2 GiB free | Postgres + uploads grow over time; plan accordingly. |
| RAM | 1 GiB free | Each replica ≈ 200–300 MiB. |
| Open ports | 80 (and 443 for HTTPS) | Only on the host running Caddy. |
| DNS | A record → host's public IP | Only needed for automatic HTTPS. |

Local-development setup (running the apps on your laptop instead of in
containers) additionally needs:

- Node.js 20+ and npm
- A reachable Postgres 16 + Redis 7 (the easiest way is still
  `docker compose up -d postgres redis`)

---

## Quick start (Docker Compose)

The compose stack is five services: `postgres`, `redis`, `backend`,
`frontend-build` (one-shot), and `caddy`. There is also an `openldap` service
behind the `ldap` profile (off by default).

### Easiest: the interactive installer

If you just want to get TaskHub up, run the installer for your shell — it
prompts only for things that need a human decision (site host, admin email,
admin password) and auto-generates the rest (JWT secrets, MASTER_KEY,
Postgres password). It writes `.env`, brings the stack up, waits for the
backend to be healthy, then seeds with your chosen admin credentials.

```bash
# Linux / macOS / WSL
./install.sh
```

```powershell
# Windows PowerShell
.\install.ps1
```

Optional integrations (SMTP, LDAP, schedulers) are intentionally **not**
prompted — the installer writes "off" defaults so you can flip them by
editing `.env` later. See [Optional integrations](#optional-integrations).

If you'd rather configure `.env` by hand, follow the manual steps below
instead.

### Manual configuration

### 1. Clone + configure

```bash
git clone <your-fork> taskhub
cd taskhub
cp .env.example .env
```

### 2. Generate secrets

`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must be different long random
strings (≥ 32 chars). `MASTER_KEY` is a 64-character lowercase-hex value
(32 bytes) — required only if you'll use LDAP, 2FA, or webhooks.

```bash
# Linux / macOS / WSL:
openssl rand -base64 48                   # JWT_ACCESS_SECRET
openssl rand -base64 48                   # JWT_REFRESH_SECRET
openssl rand -hex 32                      # MASTER_KEY
```

```powershell
# Windows PowerShell:
[Convert]::ToBase64String((1..36|%{Get-Random -Max 256}))   # JWT secret
-join ((1..32|%{Get-Random -Max 256 | ForEach-Object { '{0:x2}' -f $_ }}))  # MASTER_KEY
```

### 3. Edit `.env`

The minimum set you must touch:

| Variable | Why |
|---|---|
| `POSTGRES_PASSWORD` | Postgres bootstrap password — change from `change_me_please`. |
| `DATABASE_URL` | Update the password segment to match `POSTGRES_PASSWORD`. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Paste from step 2. |
| `SITE_HOST` | Public hostname (e.g. `taskhub.example.com`) or `:80` for local-only HTTP. |
| `ACME_EMAIL` | Real email for Let's Encrypt — only used when `SITE_HOST` is a real hostname. |
| `CORS_ORIGINS` | The origin(s) the SPA is served from, e.g. `https://taskhub.example.com`. |

See [Environment variables — full catalog](#environment-variables--full-catalog)
below for everything else (SMTP, schedulers, rate limits, optional features).

### 4. Bring the stack up

```bash
docker compose up -d --build
```

This will:

- Build the backend (TypeScript → `dist/`) and the frontend (Vite → static
  bundle copied into the shared `frontend_dist` volume).
- Start Postgres and Redis with healthchecks.
- Start the backend, which runs `prisma migrate deploy` at boot to bring the
  schema forward.
- Start Caddy, which reverse-proxies `/api/*` to the backend and serves the
  SPA from `frontend_dist`.

First boot takes 1–3 minutes (image builds). `docker compose logs -f` to follow.

### 5. Seed the first admin

The schema is created by the auto-migrate but the seed is **not** run
automatically. Run it once:

```bash
docker compose exec backend npx prisma db seed
```

That creates `admin@taskhub.local` / `admin` plus three demo members and an
18-task fixture in a "Demo Team". **Change the admin password immediately**
after first sign-in (Settings → Security, or `POST /api/auth/password/reset-request`).

v1.30.11 (S-9): public self-registration is **removed**. `POST /api/auth/register`
no longer exists, and the frontend has no "Sign up" link. The seed above is the
only way to create the first account; every subsequent user is provisioned by an
admin via **Settings → Admin → New user** (`POST /api/admin/users`, v1.26), or
by a Directory (LDAP/SCIM) JIT path. Set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
in the env before seeding to override the default bootstrap credentials.

### 6. Open the app

- SPA: `http://<SITE_HOST>/` (or `https://` with a real hostname).
- API docs (Swagger UI): `http://<SITE_HOST>/api/docs`.

---

## Local development (no Docker for the apps)

If you want to iterate on backend or frontend with hot reload, run only the
infra in Docker and the apps on your host:

```bash
docker compose up -d postgres redis

# Backend
cd backend
cp .env.example .env
npm install
npx prisma migrate dev               # creates schema + applies any new migrations
npx prisma db seed                   # admin@taskhub.local / admin + demo data
npm run dev                          # listens on http://localhost:4000

# Frontend (new terminal)
cd frontend
cp .env.example .env                 # default VITE_API_BASE_URL=/api works with Caddy; for `npm run dev` set it to http://localhost:4000/api
npm install
npm run dev                          # listens on http://localhost:5173
```

`npm run dev` in the frontend uses Vite's dev server with a proxy — if you
want the dev server to talk directly to a local backend, edit
`frontend/.env`:

```env
VITE_API_BASE_URL=http://localhost:4000/api
```

---

## First admin sign-in

After `prisma db seed`:

| Field | Value |
|---|---|
| URL | `https://<SITE_HOST>/login` |
| Email | `admin@taskhub.local` |
| Password | `admin` |

**Change this immediately.** The seed deliberately ships with a weak password
so the install completes without `MASTER_KEY` / SMTP plumbing being mandatory,
but it is not safe to leave on a public host.

Three other accounts are created with password `demo1234`:
`maya@taskhub.local`, `jordan@taskhub.local`, `riley@taskhub.local`. Delete
them in the Admin panel once you've set up your real users.

---

## Environment variables — full catalog

Every backend variable is validated by Zod at startup. A missing or malformed
value crashes the process at boot with a clear message — by design.

### Required

| Variable | Description |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Postgres bootstrap creds (compose-only). |
| `DATABASE_URL` | Backend's Postgres connection string. |
| `JWT_ACCESS_SECRET` | Signs short-lived access tokens. ≥ 32 chars random. |
| `JWT_REFRESH_SECRET` | Signs refresh tokens. Must differ from access secret. ≥ 32 chars random. |
| `CORS_ORIGINS` | Comma-separated allowlist of origins the SPA is served from. |

### Tunables (sensible defaults)

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `production` | `development` / `test` change logging + verification-token behaviour. |
| `PORT` | `4000` | Backend HTTP port (inside the container). |
| `JWT_ACCESS_TTL` | `15m` | Access-token lifetime. |
| `JWT_REFRESH_TTL` | `30d` | Refresh-token lifetime. |
| `COOKIE_DOMAIN` | _(empty)_ | Set when the API and SPA live on different sub-domains. |
| `COOKIE_SECURE` | `true` | Set `false` only when serving the SPA over plain HTTP in dev. |
| `UPLOAD_MAX_BYTES` | `10485760` (10 MiB) | Cap on a single attachment. |
| `UPLOAD_DIR` | `/app/uploads` | Where attachments land inside the container. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Requests-per-window on `/api/auth/*` per IP. |
| `AUTH_RATE_LIMIT_WINDOW` | `1 minute` | Window for the rate-limit counter. |
| `REDIS_URL` | _(optional)_ | If set, used for rate-limit backing. Otherwise in-memory. |

### Optional features

| Variable | Default | What it unlocks |
|---|---|---|
| `MASTER_KEY` | _(empty)_ | 64-hex / 32-byte symmetric key. Required for LDAP bind-password storage, TOTP shared secrets, and webhook secrets. Lose it and those values are unrecoverable — back it up separately from Postgres. |
| `TASK_DUE_ENABLED` | `false` | In-process scheduler that emits `TASK_DUE` notifications (+ emails when SMTP is on). Enable on exactly one replica. |
| `TASK_DUE_LEAD_HOURS` | `24` | Server fallback when a user's `reminderLeadHours` is unset (assignee → creator → this env). Users can override 1–168 h on **Settings → Preferences**. |
| `TASK_DUE_CHECK_INTERVAL_MIN` | `15` | How often the scheduler scans. |
| `WEBHOOK_DISPATCH_ENABLED` | `false` | Outbound webhook delivery loop. Enable on exactly one replica. |
| `WEBHOOK_DISPATCH_INTERVAL_SEC` | `5` | Dispatcher tick interval. |
| `WEBHOOK_DISPATCH_BATCH` | `10` | Max deliveries per tick. |
| `RECURRENCE_ENABLED` | `false` | Recurrence scheduler that spawns repeating tasks. Enable on exactly one replica. |
| `RECURRENCE_CHECK_INTERVAL_MIN` | `60` | How often the recurrence scheduler runs. |
| `SMTP_HOST` | _(empty)_ | Enables outbound mail. With it unset, the mailer is a no-op and dev/test flows surface tokens in the API response. |
| `SMTP_PORT` | `587` | STARTTLS port; `465` for implicit TLS. |
| `SMTP_SECURE` | `false` | `true` for SMTPS (port 465), `false` for STARTTLS / plain (587). |
| `SMTP_USER`, `SMTP_PASS` | _(empty)_ | Auth — omit for an open relay or sendmail-style local handoff. |
| `SMTP_FROM` | _(empty)_ | Required when `SMTP_HOST` is set. `Name <addr@host>` or bare `addr@host`. |
| `PUBLIC_APP_URL` | first CORS origin | Used to build links inside emails. |

### Frontend (build-time)

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `/api` | The bundle hits the same origin via Caddy. Set to `http://localhost:4000/api` for the Vite dev server talking to a local backend. |

### Caddy

| Variable | Description |
|---|---|
| `SITE_HOST` | `taskhub.example.com` for real HTTPS; `:80` for local-only HTTP. |
| `ACME_EMAIL` | Email Let's Encrypt should contact. Required when `SITE_HOST` is a real hostname. |

---

## HTTPS with Caddy

Caddy gets a Let's Encrypt certificate automatically when:

1. `SITE_HOST` is set to a real public hostname (no port suffix).
2. `ACME_EMAIL` is a reachable address.
3. DNS for `SITE_HOST` resolves to the host's public IP.
4. Inbound ports **80 and 443** are open at firewall + cloud-security-group
   level.

If any of these are missing, Caddy will keep retrying ACME and log noisy
warnings. For LAN-only deployments, set `SITE_HOST=:80` and leave `ACME_EMAIL`
blank — TaskHub will serve plain HTTP. **Set `COOKIE_SECURE=false`** in that
case, otherwise the refresh cookie won't be accepted by the browser and
sign-in will appear to succeed but immediately fall back to the login page.

---

## Optional integrations

### SMTP

Set the `SMTP_*` block in `.env` (plus `PUBLIC_APP_URL` so the links in
outbound mail are clickable). Outbound mail kicks in for:

- Email verification (token sent on register)
- Password reset (token sent on request)
- TASK_DUE notifications (assignee + creator, after the in-app bell fires)

Without SMTP, all three flows still work — verification + reset tokens are
returned in the API response in non-prod for the dev/test flow, and the bell
still rings — but no email is sent. See [USER_MANUAL.md § Email delivery](USER_MANUAL.md#email-delivery-v114).

### LDAP / Active Directory

Provide `MASTER_KEY` first (LDAP bind passwords are encrypted at rest).
Sign in as an admin, open **Settings → Directories**, click **New directory**,
fill in the URL (`ldap://server:389` or `ldaps://server:636`), base DN, bind
DN + password, and the LDAP attribute holding the user's email. Optionally
toggle JIT provisioning so users who don't yet have a TaskHub row are created
on first successful bind. Group → role mappings (LDAP group DN → TaskHub
global role / team role) live in the same admin view.

The included `openldap` compose service (gated by the `ldap` profile) is a
disposable test directory. Bring it up with
`docker compose --profile ldap up -d openldap` and point a directory at
`ldap://openldap:389` with bind DN `cn=admin,dc=taskhub,dc=local` and password
`adminpass`.

### SCIM 2.0 provisioning

For Okta / Azure AD / OneLogin-style external provisioning:

1. **Settings → API & Webhooks → SCIM credentials** → **Generate**. Copy the
   bearer token shown once.
2. In your IdP, configure a SCIM 2.0 connector pointing at
   `https://<SITE_HOST>/api/scim/v2` with that bearer token.
3. Users / Groups assigned to the TaskHub app in the IdP appear as TaskHub
   users and team memberships.

Filter operators supported: `eq` (and only `eq`). PATCH with
`replace` on individual fields works; replacing the entire `members` array on
a Group is not implemented (Phase-2B boundary).

### Webhooks

A team manager can register one or more webhooks per team in
**Webhooks** (under the team settings). Each webhook subscribes to one or
more event types (`task.created`, `task.updated`, `task.deleted`,
`comment.added`). Outbound deliveries carry an HMAC-SHA-256 signature in
`X-TaskHub-Signature` and a stable `X-TaskHub-Delivery` UUID for idempotent
receivers.

For delivery to actually happen, the dispatcher loop must be running —
`WEBHOOK_DISPATCH_ENABLED=true` on one replica. Failed deliveries are retried
with exponential back-off up to 6 attempts.

### API tokens

Personal API tokens (Settings → API & Webhooks → API tokens) authenticate
non-interactive callers. Tokens carry an explicit scope (e.g. `tasks:read`,
`tasks:write`) and a server-side hash; the raw token is shown exactly once at
creation.

Use them with `Authorization: Bearer <token>` on any `/api/*` endpoint.

### Recurring tasks

Set `RECURRENCE_ENABLED=true` on one replica. From the task detail page,
click **Recurrence** to open a template editor (daily / weekly / monthly /
quarterly, with weekday filters and offset days for due/planned). The
scheduler scans every `RECURRENCE_CHECK_INTERVAL_MIN` minutes and spawns
new tasks from active templates.

---

## Background schedulers

Three in-process schedulers are gated by env flags and **disabled by default**
because tests + small dev runs shouldn't accidentally fire timers:

| Scheduler | Flag | Default interval | What it does |
|---|---|---|---|
| Due-date | `TASK_DUE_ENABLED` | every 15 min | Emits `TASK_DUE` notifications (and emails when SMTP is on). |
| Webhook dispatcher | `WEBHOOK_DISPATCH_ENABLED` | every 5 sec | Drains `WebhookDelivery` queue, signs + POSTs payloads. |
| Recurrence | `RECURRENCE_ENABLED` | every 60 min | Spawns tasks from active templates. |

In a single-replica deployment (the default `docker compose up`) you turn on
the ones you want. In a multi-replica deployment, enable each on **exactly
one** replica — running two TASK_DUE schedulers will fire duplicate
notifications, two webhook dispatchers will double-deliver, two recurrence
schedulers will double-spawn.

---

## Verifying the install

After `docker compose up -d`:

```bash
# 1. All containers up
docker compose ps

# 2. Health endpoint (no auth required)
curl -fsS http://localhost/api/health
# → {"status":"ok"}

# 3. System info (no auth required)
curl -fsS http://localhost/api/system/info
# → {"version":"dev","buildTime":"...","environment":"production",...}

# 4. SPA reachable
curl -sI http://localhost/ | head -1
# → HTTP/1.1 200 OK

# 5. Login works end-to-end (use the seeded admin)
curl -sX POST http://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@taskhub.local","password":"admin"}' | head -c 80
# → {"accessToken":"eyJ...
```

If step 5 returns `401`, the seed never ran (or you've already changed the
password). Re-seed via `docker compose exec backend npx prisma db seed`, or
sign in with the password you set.

---

## Common operations

```bash
# Tail backend logs
docker compose logs -f backend

# Run prisma migrations (auto-runs at backend boot; manual run if you need it)
docker compose exec backend npx prisma migrate deploy

# Re-seed (idempotent — refuses if admin + projects already exist)
docker compose exec backend npx prisma db seed

# Open a psql shell on the database
docker compose exec postgres psql -U taskhub -d taskhub

# Reset the database (DESTRUCTIVE — wipes all data)
docker compose down -v   # also wipes uploads + redis + caddy certs
docker compose up -d --build
docker compose exec backend npx prisma db seed

# Rebuild only the frontend (after a code change in frontend/)
docker compose up --build frontend-build

# Restart just the backend (after env changes)
docker compose up -d --force-recreate backend

# Run the test suite against a DISPOSABLE Postgres
#   Integration tests call prisma.user.deleteMany() in beforeEach. v1.23
#   adds a guard in tests/setup.ts that refuses to run unless DATABASE_URL
#   clearly identifies a test DB — but the right workflow is to use the
#   `postgres-test` compose service:
docker compose --profile test up -d postgres-test
docker run --rm --network taskhub_default \
  -e DATABASE_URL=postgresql://taskhub:taskhub@postgres-test:5432/taskhub_test?schema=public \
  -v "$(pwd)/backend:/app" -w /app node:20-alpine \
  sh -c "apk add --no-cache openssl >/dev/null && npx prisma migrate deploy && npm test"
# The test DB lives on a tmpfs — tear it down with:
docker compose --profile test down postgres-test
```

---

## Upgrading

The full upgrade guide — including the data-safety guarantees, rollback
path, and what every release does to your volumes — lives in
[UPGRADE.md](UPGRADE.md). Quick version:

1. **Back up first.** `pg_dump` per [BACKUP.md](BACKUP.md), and snapshot the
   `uploads_data` volume.
2. **Pull the new tag.**
   ```bash
   git fetch --tags
   git checkout v1.X.Y
   ```
3. **Diff `.env.example`** against your `.env` for new variables (every release
   that adds them lists them in [CHANGELOG.md](CHANGELOG.md) under the
   `### Env / ops` heading).
4. **Rebuild and recreate.**
   ```bash
   docker compose up -d --build
   ```
   The backend container runs `prisma migrate deploy` at boot, so schema
   migrations apply automatically.
5. **Verify** with the curl probes in [Verifying the install](#verifying-the-install).

If a release introduces a new optional feature you want to enable, set the
relevant flag in `.env` and `docker compose up -d --force-recreate backend`.

---

## Troubleshooting

**`Invalid environment: JWT_ACCESS_SECRET: String must contain at least 32 character(s)`** at backend boot.
You missed a secret. Generate one (`openssl rand -base64 48`) and paste it
into `.env`, then `docker compose up -d --force-recreate backend`.

**Login lands on the login page again immediately after a 200 response.**
The refresh cookie was rejected by the browser. Most common cause: serving
the SPA over plain HTTP with `COOKIE_SECURE=true`. Set `COOKIE_SECURE=false`
in `.env`, recreate the backend. For HTTPS deployments check that
`COOKIE_DOMAIN` is empty unless the API and SPA live on different sub-domains.

**Caddy keeps logging ACME failures.**
DNS for `SITE_HOST` isn't resolving to the host, port 80 isn't open, or
`SITE_HOST=:80` is set (no certificate needed in that case — the warnings
disappear once you wipe the obsolete `caddy_data` volume:
`docker compose down && docker volume rm taskhub_caddy_data && docker compose up -d`).

**`MASTER_KEY must be 64 hex chars (32 bytes)`** at backend boot.
`openssl rand -hex 32` produces the right shape. Don't paste the base-64
output of `rand -base64` — that's the wrong character set.

**Database migrations failed at boot.**
Inspect with `docker compose logs backend | grep -i migrat`. If you've been
running a pre-1.0 fork, the schema may have diverged — restore from the most
recent backup before the failing release, then re-run the upgrade.

**Email verification / password reset never arrives.**
Either SMTP isn't configured (`SMTP_HOST` blank → mailer is a no-op) or the
SMTP credentials are wrong. Tail `docker compose logs backend` while you
trigger the action; failures surface as `accepted: false` and an error line.

**Tests are wiping live data.**
You pointed `DATABASE_URL` at the production Postgres while running
`npm test`. The suite calls `prisma.user.deleteMany()` in `beforeEach`. Always
run tests against a disposable database (see the snippet in
[Common operations](#common-operations)).
