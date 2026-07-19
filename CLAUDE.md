# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TaskHub — self-hosted team task management. Monorepo with `backend/` (Fastify API) and
`frontend/` (React SPA). Fronted by Caddy (TLS + SPA hosting), backed by PostgreSQL 16 (Prisma)
and Redis 7.

**Versioning (from v2.5.0):** frontend, backend, the user manual, and `TASKHUB_VERSION` share a
**single unified version number**, currently **2.13.0**. **Bump it on every change** (patch by
default) and keep all version stamps in lockstep — see the Deploy workflow section.

The deep design docs are worth reading before non-trivial work:
- [ARCHITECTURE.md](ARCHITECTURE.md) — the *why* of every major subsystem, with a per-feature
  schema-decisions table. The single most useful file for getting oriented.
- [CHANGELOG.md](CHANGELOG.md) — version history (features land as `v1.NN` slices).
- [USER_MANUAL.md](USER_MANUAL.md) / `.fa.md` — user-facing behaviour (English + Farsi).

## Commands

All commands run from `backend/` or `frontend/` — there is no root-level package.json.

### Backend (`cd backend`)
```bash
npm run dev          # tsx watch, http://localhost:4000
npm run build        # tsc + copy-data.mjs into dist/
npm test             # vitest run (integration + unit)
npm run test:watch   # vitest watch
npm run typecheck    # tsc --noEmit
npx prisma migrate dev      # create/apply a migration in dev
npx prisma generate         # regenerate the Prisma client after schema edits
npx prisma db seed          # seed admin@taskhub.local / admin (routes via seed-router.ts)
SEED_IT_DEMO=1 npx prisma db seed   # optional IT demo dataset (~180 tasks)
```

### Frontend (`cd frontend`)
```bash
npm run dev          # vite, http://localhost:5173 (proxies /api to backend)
npm run build        # tsc --noEmit && vite build  (typecheck + bundle)
npm test             # vitest run
npm run typecheck    # tsc --noEmit
```

### Running a single backend test
Integration tests run against a **real Postgres** and `setup.ts` refuses to run unless
`DATABASE_URL` looks like a test DB (contains `taskhub_test`, `schema=test`, or port `5433`).
Bring up the test container first, then point at it:
```bash
docker compose --profile test up -d postgres-test     # exposes 5433 on the host
cd backend
DATABASE_URL='postgresql://taskhub:taskhub@localhost:5433/taskhub_test?schema=public' \
  npx prisma migrate deploy
DATABASE_URL='postgresql://taskhub:taskhub@localhost:5433/taskhub_test?schema=public' \
  npx vitest run tests/integration/tasks.test.ts          # single file
# add -t "substring" to filter to one test within the file
```
Tests use Fastify's `inject()` (no TCP). The suite shares one DB and wipes it in `beforeEach`,
so `vitest.config.ts` forces a single fork and disables file parallelism — do not parallelize.

## Architecture essentials

### Backend layering (strict — enforced by where `prisma` may be imported)
```
routes/       Fastify route decls + Zod schemas (URLs, validation, OpenAPI). Never touch Prisma.
controllers/  HTTP <-> domain translation. Call services.
services/     Business logic + transactions. THE ONLY layer that calls Prisma.
data/         Prisma client instance + low-level helpers.
middleware/   auth, permission/role checks, project-access gates, central error handler.
plugins/      Fastify plugins (helmet, cors, jwt, swagger).
lib/          Pure helpers (hashing, jwt, projectAccess, calendar/shamsi, permissions, …).
config/env.ts Zod-validated env loader — reads process.env ONCE at startup, crashes fast.
```
`app.ts` is the testable app factory; `server.ts` binds the listener and starts schedulers.
Don't read `process.env.X` outside `config/env.ts`.

### Multi-tenancy (the core invariant — cross-team leaks must be structurally hard)
- Every team-scoped row carries `teamId`; `Task.teamId` is denormalized from its Project so
  list/filter queries never join through Project.
- Auth layers: `requireAuth` → `requireTeamRole(...)` (looks up `TeamMembership`, 403 if absent)
  → services take `teamId` as a parameter and put it in every Prisma `where`.
- **Two role namespaces, kept separate on purpose:** `GlobalRole = ADMIN | MEMBER` (platform)
  vs `TeamRole = MANAGER | MEMBER` (per-team). Never collapse them.
- Every feature ships happy-path **and** a negative authorization test (another team's user must
  not read this team's data). Match the existing pattern when adding features.

### Permissions / RBAC (v1.23+)
Capability strings live in [backend/src/lib/permissions.ts](backend/src/lib/permissions.ts)
(`task.delete`, `project.write_all`, `automation.manage`, `form.manage`, etc.). That file has a
**NEW PERMISSION CHECKLIST** at the top — follow it when adding one (add to `PERMISSIONS`,
`PERMISSION_GROUPS`, the Manager default, the seed/migration, then gate via
`requirePermission(...)`). Global ADMIN bypasses permission checks; project owners bypass at the
service layer for their own projects.

### Project access (v1.50/v1.51 group grants)
Project visibility is **owner-based** by default, extended by team User Groups with FULL/READONLY
grants (cross-team members via PENDING→ACCEPTED handshake). Resolution lives in
[backend/src/lib/projectAccess.ts](backend/src/lib/projectAccess.ts) (`resolveProjectAccess` →
NONE|READ|WRITE) and is enforced by `middleware/requireProjectAccess.ts` and
`requireTeamRoleOrGrantedProject`. Mutations require WRITE.

### Errors
Every error funnels through one Fastify error handler and emits
`{ "error": { "code": "STRING_CONSTANT", "message": "...", "details": ... } }`. Codes are stable;
the frontend matches on `error.code`, never on `message`. Use the helpers in `lib/errors.ts`.

### Frontend shape
- `features/<name>/` owns each feature's API client, hooks, components, types — avoid a flat
  `components/` dump. `pages/` and `app/` wire routing.
- Access token lives in the axios module (`src/lib/api.ts`) memory only — never localStorage,
  never context (XSS-resistant). Axios refresh-on-401 is single-flight.
- TanStack Query for server state; Tailwind with semantic CSS tokens in `styles/themes.css`
  (theme switching sets a `theme-*` class on `<html>`). i18n is EN + FA (`i18n/`).
- The `/planner` route exposes multiple *views* (my-tasks, board, calendar, charts, grid) over
  the same task rows without duplicating business logic — see ARCHITECTURE.md "Planner".

## Conventions & gotchas

- **Zod schemas are the single source of truth** for request validation AND the OpenAPI doc
  (`fastify-type-provider-zod`). Swagger UI is at `/api/docs`, JSON at `/api/docs/json`.
- **Dates:** instants are stored UTC; display formatting is user-zone/12h-24h aware. Calendar
  *dates* (UTC-midnight, zone-neutral) and *timestamps* use different formatters —
  `lib/shamsi*`/`calendarDate` vs `lib/time`. Jalali (Shamsi) calendar support is first-class.
- **IDs** are `cuid()`. **Refresh tokens** are stored as SHA-256 hashes; passwords use argon2id.
- **Email delivery IS wired** (since v1.14): `lib/mailer.ts` sends via SMTP when `SMTP_*` env is
  set, else `mailer.isEnabled()` is false and every composer is a graceful no-op. All domain
  emails (verification, reset, task-due, standalone-task-due, correspondence-referral) are
  best-effort; the in-app `Notification` stays the source of truth; reset still returns the raw
  token in dev. **No background-job queue, no realtime push** yet (Redis provisioned but unused;
  notifications pull-based). See ARCHITECTURE.md "What's intentionally not here yet".
- Schedulers (`backend/src/scheduler/`: due-date reminders, recurrence, backups, webhook
  dispatch) start in `server.ts`, not `app.ts`, so tests don't trigger them.

## Deploy workflow (from .cursor/rules)

**Always implement and verify locally before touching production.** Production is
`taskhub.modalalco.com` (SSH user `taskhub`, app at `/home/taskhub/taskhub`), Docker Compose:
```bash
cd ~/taskhub && git pull && docker compose up -d --build
# rebuild only what changed: --build backend  or  --build frontend-build (then restart caddy)
```
Frontend and backend must **both** be rebuilt when their code changes — rebuilding one alone can
leave the app broken. When shipping a release, bump the version in `CHANGELOG.md`,
`ARCHITECTURE.md`, both `USER_MANUAL*.md`, `frontend/package.json`, `backend/package.json`,
this `CLAUDE.md` (the stamp near the top), and `TASKHUB_VERSION` in the server `.env`.
