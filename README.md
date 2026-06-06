# TaskHub

Self-hostable team task management. React + Fastify + Postgres + Prisma + Redis,
fronted by Caddy with automatic HTTPS.

> Status: **scaffold + Feature 1 (Auth) complete.** Teams, projects, tasks,
> kanban board, comments, activity, notifications, and admin panel are queued
> as separate features.

## Stack

- **Frontend** — React 18, TypeScript, Vite, TailwindCSS, TanStack Query, React Router
- **Backend** — Node.js 20, Fastify, TypeScript, Zod (request validation + OpenAPI)
- **Database** — PostgreSQL 16 via Prisma ORM (migrations + seed included)
- **Auth** — argon2id password hashing, JWT access tokens, httpOnly refresh-cookie rotation
- **Cache** — Redis 7 (reserved for background jobs / rate-limit backing in future features)
- **Reverse proxy** — Caddy 2 (TLS termination + SPA hosting)
- **Tests** — Vitest + Fastify `inject` (no Supertest needed; `inject` is faster)

## Quick start (production-style, Docker Compose)

```bash
git clone <your-fork> taskhub && cd taskhub
cp .env.example .env
# Generate strong secrets:
#   openssl rand -base64 48   # JWT_ACCESS_SECRET
#   openssl rand -base64 48   # JWT_REFRESH_SECRET
# Edit .env: secrets, SITE_HOST, ACME_EMAIL, CORS_ORIGINS, POSTGRES_PASSWORD.
docker compose up -d --build
docker compose exec backend npx prisma db seed
```

Caddy listens on ports 80 and 443. Set `SITE_HOST` to your public hostname and
`ACME_EMAIL` to a real address to get automatic HTTPS via Let's Encrypt. For
local-only HTTP, leave `SITE_HOST=:80`.

Visit `http://<host>/` for the SPA and `http://<host>/api/docs` for the
OpenAPI / Swagger UI.

**For the full install walkthrough** — every env var, optional integrations
(SMTP / LDAP / SCIM / webhooks), background schedulers, and troubleshooting —
see [INSTALL.md](INSTALL.md). **Upgrading?** See [UPGRADE.md](UPGRADE.md) for
the data-safety guarantees, rollback path, and step-by-step flow.

## Quick start (local development)

Run Postgres + Redis from compose, run the apps on the host:

```bash
docker compose up -d postgres redis

# Backend
cd backend
cp .env.example .env
npm install
npx prisma migrate dev
npx prisma db seed     # creates admin@taskhub.local / admin (+ 3 demo members + demo data)
npm run dev            # http://localhost:4000

# Frontend (new terminal)
cd frontend
cp .env.example .env
npm install
npm run dev            # http://localhost:5173 (proxies /api to backend)
```

## First admin user

Two options:

1. **Seed**: `npx prisma db seed` creates `admin@example.com` /
   `ChangeMe123!`. **Change the password immediately** via
   `POST /api/auth/password/reset-request` (in dev the reset token is returned
   in the response).
2. **Admin-only provisioning** (v1.30.11, S-9): public self-registration is
   removed. The seeded admin is the only bootstrap path; subsequent accounts are
   created by an admin via **Settings → Admin → New user**
   (`POST /api/admin/users`), or appear via LDAP/SCIM JIT. There is no
   `POST /api/auth/register` endpoint.

## Environment variables

See [`.env.example`](.env.example) for the canonical list. Every backend var is
validated by Zod at startup — missing or malformed values crash the process
fast rather than failing mysteriously at request time.

The most important ones:

| Variable | What it does | Notes |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Required |
| `JWT_ACCESS_SECRET` | Signs short-lived access tokens | ≥ 32 chars random |
| `JWT_REFRESH_SECRET` | Signs refresh tokens (different secret) | ≥ 32 chars random |
| `JWT_ACCESS_TTL` | Access token lifetime | Default `15m` |
| `JWT_REFRESH_TTL` | Refresh token lifetime | Default `30d` |
| `COOKIE_SECURE` | `true` in prod (HTTPS), `false` in dev | |
| `CORS_ORIGINS` | Comma-separated allowlist | No `*` in prod |
| `AUTH_RATE_LIMIT_MAX` | Requests per `WINDOW` to auth endpoints | Default 10 |
| `UPLOAD_MAX_BYTES` | File upload size cap | Default 10 MiB |

## Running tests

```bash
cd backend
npm test
```

Integration tests use Fastify's `inject()` against a real Postgres. Point
`DATABASE_URL` at a disposable test database before running. CI should
provision an ephemeral Postgres, run `npx prisma migrate deploy`, then `npm test`.

## API documentation

Swagger UI is served by Fastify at `/api/docs`. The OpenAPI JSON is at
`/api/docs/json` and is generated from the same Zod schemas used for request
validation.

## Backups (Postgres)

Data lives in the named volume `postgres_data`. Two recommended approaches:

**Logical dump** — best for portability, version-skew tolerance:

```bash
docker compose exec -T postgres pg_dump -U $POSTGRES_USER -d $POSTGRES_DB \
  --no-owner --no-privileges --format=custom > backup-$(date +%F).dump
```

Restore: `pg_restore -d $POSTGRES_DB backup-YYYY-MM-DD.dump`.

**Volume snapshot** — fastest but ties you to the same Postgres minor version:

```bash
docker run --rm -v taskhub_postgres_data:/data -v "$PWD:/out" alpine \
  tar czf /out/pg-volume-$(date +%F).tgz -C /data .
```

Schedule one of these via cron (or `systemd-timer`) and rotate the output to
off-host storage.

**Uploads** live in the `uploads_data` volume; back it up the same way.

## Security model

- Passwords hashed with **argon2id**. Never logged.
- Access tokens: short-lived (15 min default), sent as `Authorization: Bearer`.
- Refresh tokens: longer-lived, stored as a **SHA-256 hash** in Postgres and
  delivered to the browser as an **httpOnly, SameSite=Lax** cookie scoped to
  `/api/auth`. Each refresh **rotates** the token; reuse of a revoked token is
  rejected.
- Helmet sets a sane default header set; Caddy adds HSTS, X-Frame-Options,
  Referrer-Policy.
- CORS is allowlist-only. `credentials: true` requires an explicit origin
  match — the wildcard combination is impossible by design.
- Auth endpoints are rate-limited (configurable, default 10 req/min/IP).
- All input validated with Zod; Prisma uses parameterized queries exclusively.
- File uploads (Feature 4): MIME-type allowlist, size cap, stored under an
  opaque `storageKey` separate from the user-supplied `filename` — no path
  traversal vector.

## Project layout

```
backend/   Fastify API (routes -> controllers -> services -> data)
frontend/  React SPA built by Vite
docker/    Dockerfiles + Caddyfile
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the why behind the choices.

## License

Choose your own; not pre-applied.
