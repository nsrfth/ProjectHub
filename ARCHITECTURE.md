# Architecture

**Version:** v1.61.0 (2026-06-09)

This document captures the *why* behind TaskHub's design. The *what* is in the
code; the *how to run* is in [README.md](README.md). User-facing behaviour is
in [USER_MANUAL.md](USER_MANUAL.md) / [USER_MANUAL.fa.md](USER_MANUAL.fa.md);
release notes in [CHANGELOG.md](CHANGELOG.md).

## Goals

1. Self-hostable on a single small server. No cloud-specific services.
2. Secure by default. Cross-tenant data leaks should be structurally hard, not
   merely "we remembered to filter."
3. Boring, well-trodden tech. Easy to hire for, easy to debug.

## Top-level shape

```
Browser ──(HTTPS)── Caddy ──(HTTP, internal)── Fastify (backend)
                       │                            │
                       └─ static SPA (Vite build)   └─ PostgreSQL
                                                    └─ Redis
```

Caddy terminates TLS, serves the SPA's static assets, and reverse-proxies
`/api/*` to the backend. The backend never faces the public internet directly.

## Backend layering

```
routes/        ── Fastify route declarations + Zod schemas (URLs, validation, OpenAPI)
controllers/   ── Translate HTTP <-> domain objects. Call services.
services/      ── Business logic. Transactions. The only layer that calls Prisma directly.
data/          ── Prisma client instance + low-level helpers.
middleware/    ── Cross-cutting: auth, RBAC, centralized error handler.
plugins/       ── Fastify plugins: security headers, CORS, JWT, Swagger.
schemas/       ── Shared Zod schemas (request/response/types).
lib/           ── Pure helpers: hashing, JWT wrapper, duration parsing, errors.
config/        ── Env loader (Zod-validated; crashes fast on bad config).
```

Why this split:

- **Routes don't touch Prisma.** A junior engineer reading a route file should
  see only what the API contract is — not how it's stored. The compiler enforces
  this by where `prisma` is imported.
- **App factory (`app.ts`) vs server (`server.ts`).** Tests build the app and
  call it via Fastify's `inject()` — no TCP, no port collisions, fast.
- **`AuthService` takes a signer interface.** The service doesn't know about
  Fastify. Trivially testable without spinning up a server.

## Multi-tenancy: how cross-team leaks are prevented

Every team-scoped row carries `teamId`. `Task` carries `teamId` denormalized
from its parent `Project` — every list/filter query already filters by `teamId`,
so a hot-path join through Project is wasted work.

Auth is layered:

1. `requireAuth` validates the bearer token and populates `request.user`.
2. `requireTeamRole(...)` looks up `TeamMembership(userId, teamId)`. If there
   is no row, the request is rejected with 403 — independent of any later
   query the route happens to write. The membership row is attached to the
   request so subsequent code can branch on `MANAGER` vs `MEMBER`.
3. Services that touch team data require `teamId` as a parameter and include
   it in every Prisma `where`. This is enforced by code review and by tests
   that try to read another team's data (added with each feature).

Two roles namespaces exist for a reason:

- `GlobalRole = ADMIN | MEMBER` — platform-level. ADMIN manages users / teams.
- `TeamRole = MANAGER | MEMBER` — per-team. MANAGER can create projects, manage
  labels, edit team membership; MEMBER can do day-to-day task work.

Collapsing these into one enum invariably leads to confused checks like "is
this user admin of *this team* or admin of *the system*".

## Auth flow

```
Login (admin-provisioned or LDAP/SCIM JIT — no public register):
  Client POSTs credentials
  Backend issues:
    - access token  (JWT, signed with JWT_ACCESS_SECRET,  TTL 15m default)
    - refresh token (JWT, signed with JWT_REFRESH_SECRET, TTL 30d default)
  Access token  -> response body, kept in JS memory only
  Refresh token -> httpOnly Secure SameSite=Lax cookie scoped to /api/auth

Authenticated request:
  Authorization: Bearer <access>
  On 401, axios interceptor calls POST /api/auth/refresh:
    - Browser auto-sends the refresh cookie
    - Backend verifies the JWT, hashes the raw token, looks up RefreshToken
      row by tokenHash, checks (not revoked, not expired)
    - Backend revokes the old row, issues a new pair (rotation)
    - Replays of the old token are rejected (revokedAt is set)

Logout:
  Backend revokes the row for the presented refresh cookie. Cookie cleared.

Password reset:
  - request: generates a 64-hex-char token, stores SHA-256, expires in 1h.
    Response is identical whether the email exists or not (no enumeration).
    In dev the raw token is returned in the response body; in prod it would
    be emailed (email integration intentionally not wired up per project decision).
  - perform: validates token (lookup by hash, check expiry / used-flag),
    sets the new password, marks the reset used, and revokes every active
    refresh token for that user. Forces re-login everywhere.
```

Why two different JWT secrets: a leaked access secret should not be enough
to mint refresh tokens. Defense in depth at zero cost.

Why hash refresh tokens in the DB: a database dump should not yield usable
session tokens. Same reason we hash passwords.

## Schema decisions

| Decision | Reason |
|---|---|
| `cuid()` IDs | Sortable-ish, URL-safe, no collision concerns at this scale, no exposure of row counts that auto-increments would leak. |
| `Task.teamId` denormalized | Every list/filter query already filters by team; avoids a join on the hot path; composite indexes `[teamId, status]`, `[teamId, assigneeId]`, `[teamId, dueDate]` fall out naturally. |
| Hashed refresh tokens | DB leak should not yield sessions. Costs one SHA-256 per refresh. |
| `position: Int` for ordering | Simple. Trade-off: a drag-drop reorder may need to renumber neighbors. Acceptable at expected scale; can swap to fractional ranks if writes become hot. |
| `Activity.meta: Json` | Activity is read-only audit. Keeping structured meta avoids inventing a column per action. |
| `Attachment.storageKey` ≠ `filename` | User-supplied names never become filesystem paths. Defends against path traversal even if the route handler is wrong. |
| `Notification` model rather than per-feature flags | Single inbox query; consistent shape across notification sources; easy to mark-all-read. |
| Custom field values (v1.58) | Definitions are team-scoped (`CustomFieldDefinition` + `CustomFieldOption`). Values live in `CustomFieldValue` with **typed columns** per field kind (`valueText`, `valueNumber DECIMAL(18,4)`, `valueDate`, `valueBool`, `valueUserId`) and `CustomFieldValueOption` for select types — deliberately **not** a JSON blob so dashboards/automation can filter and sort. One row per `(fieldId, taskId)` with upsert semantics. Project-scoped field restriction is deferred; v1 is team-wide vocabulary like labels. TEXT values do not yet feed `Task.searchVector` (would require tsvector trigger rework). |
| Budget currency (v1.59) | `Currency` enum (`IRR`, `EUR`, `USD`). `Team.defaultCurrency` pre-fills `Project.budgetCurrency` on create; tasks inherit the parent project's currency via join (no task column). Amounts stay `Decimal(18,2)` — IRR displays with 0 fraction digits; no exchange-rate or conversion logic. |
| Automation rules (v1.60) | `AutomationRule` + `AutomationCondition` + `AutomationAction` + `AutomationRun` (team-scoped). Engine runs **after-commit** beside webhooks; loop guard = shared `(ruleId,taskId)` fired-set + max depth 5; actions call real services (tasks, labels, custom fields, comments). Permission: `automation.manage`. |
| Theme tokens (v1.61) | `ThemePreference` enum: `LIGHT`, `DARK`, `SYSTEM`, `MIDNIGHT`, `SOLARIZED`, `HIGH_CONTRAST`, `NORD`. **Stored preference** may be `SYSTEM`; **resolved theme** (what the DOM gets) is always a concrete palette. `SYSTEM` → `matchMedia('(prefers-color-scheme: dark)')` with a live change listener (detached when switching away). `<html>` carries one `theme-*` class; dark-family resolved themes also get legacy `dark` for Tailwind `dark:` during migration. Semantic tokens in `frontend/src/styles/themes.css` (`--color-bg`, `--color-text`, …); Tailwind colors reference `var(--color-*)`. |

## Error responses

Every error funnels through one Fastify error handler and produces:

```json
{ "error": { "code": "STRING_CONSTANT", "message": "...", "details": ... } }
```

Codes are stable; the frontend matches on `error.code`, never on `message`.
Stack traces never reach clients — only the server log.

## Configuration

`src/config/env.ts` loads and validates `process.env` once at startup with a
Zod schema. Anything missing or malformed crashes the process before the
listener binds. This is the single trustworthy source of config — no scattered
`process.env.X` reads elsewhere.

## Frontend shape

- **`features/`** owns feature-scoped code: API client, hooks, components,
  types. Prevents the "300-file `/components` folder" pattern.
- **`AuthProvider`** holds the user in React state. The access token lives in
  the axios module (`src/lib/api.ts`) — never in localStorage, never in
  context, so it can't be exfiltrated by an XSS injection that happens to
  grab `localStorage`.
- **Axios refresh-on-401** is single-flight: concurrent failed requests
  share one in-flight refresh call.
- **Theme runtime** (`frontend/src/lib/theme.ts`): preference vs resolved
  palette (see schema table). Pre-paint bootstrap in `index.html` reads
  `localStorage` and sets `theme-*` + optional `dark` before React mounts.
  `AuthContext.adoptServerTheme()` syncs server preference on login.

## Planner (v1.44)

Task data is still stored per project, but the SPA exposes multiple *views*
over the same rows without duplicating business logic:

```
/planner
  ├── my-tasks   → GET /api/me/tasks (assignee-scoped, paginated)
  ├── board      → project picker → /projects/:id/tasks (kanban + grouping)
  ├── calendar   → GET /api/teams/:teamId/calendar (grid modes)
  │                + timeline: client fan-out listTasks (v1.47 Asana-style Gantt)
  │                views: work-week | week | month | timeline
  ├── charts     → client aggregation + /reports/summary|workload fallback
  │                (status, member, due-date filters via PlannerFilterBar)
  └── grid       → fan-out listTasks per visible project, client filter/sort
                   (PlannerFilterBar; column prefs in localStorage)
```

**Filter bar** (`PlannerFilterBar.tsx`) centralises client-side task scoping
for Grid and Charts. **My Tasks calendar** (`MyTasksCalendar.tsx`) is a
lightweight week strip over `GET /api/me/tasks`, separate from the full team
calendar at `/planner/calendar`.

**Grouping** (`features/planner/grouping.ts`) runs entirely in the browser
on the task list already fetched for a project. Only status-grouped boards
enable drag-and-drop reorder (existing `POST .../reorder`).

**Charts** use Recharts. `aggregations.ts` shapes metrics so future report
endpoints (velocity, burn-down, budget burn) can plug in without new UI
shells.

**My Tasks** is the one new read API: `MeTasksService` filters
`assigneeId = user.sub` and `teamId IN memberships`. Project-owner rules
from v1.39 do *not* apply here — assignment visibility is intentional (a user
must see work assigned to them even on projects they don't own).

## Calendar Timeline (v1.47)

The **Timeline** tab on `/planner/calendar` is a client-side Gantt built in
`frontend/src/features/calendar/timeline/`:

```
AsanaTimelineView
  ├── useTimelineData   → listAllProjects + listTasks fan-out (same as Grid)
  ├── utils/buildTimelineRows → project → task → subtask flat rows
  ├── TimelineBar + useTimelineBarDrag → pointer drag/resize → PATCH task/subtask
  └── DependencyLayer   → empty SVG overlay (phase-2 dependency arrows)
```

Grid/week/month modes still use `GET /api/teams/:teamId/calendar`. Timeline
does **not** — it needs full task graphs with subtasks and start/end pairs,
so it reuses the per-project task list API. Date edits go through the
existing task/subtask PATCH routes (same v1.18 manager date gate applies).

Zoom levels adjust `pxPerDay` and visible window length. Row virtualization
renders only viewport ± buffer rows in the chart body while keeping full
scroll height for the sidebar labels.

## Personal project buckets (v1.45)

Per-user project organization on `/projects` — **not** the removed v1.34–v1.44
*task* buckets. Data lives in `UserProjectBucket` + `UserProjectBucketItem`;
API under `/api/me/project-buckets`. A project may appear in multiple buckets
for the same user. Bucket membership never grants access: `UserProjectBucketsService.assertProjectVisible`
reuses owner/team/admin rules before any assignment write.

```
GET  /api/me/project-buckets              → caller's buckets + projectIds[]
POST /api/me/project-buckets              → create
PUT  /api/me/project-buckets/assignments  → replace memberships for one project
```

UI: `features/projectBuckets/` — `ProjectBucketBoard` (dnd-kit), filters,
`localStorage` for view mode + collapsed columns. Future: shared buckets,
smart/rule-based buckets can extend the same tables with a `scope` column.

## User Groups & project access (v1.50 / v1.51)

Project visibility is **owner-based** by default (v1.39). v1.50 added team **User Groups**
with project grants. v1.51 extends groups with **FULL/READONLY** per-member access levels,
**cross-team members** via invitation handshake (PENDING → ACCEPTED/DECLINED), and
**write enforcement** for READONLY grantees.

```
lib/projectAccess.ts
  resolveProjectAccess(...) → NONE | READ | WRITE
  assertCanWriteProject(...)

middleware/auth.ts
  requireTeamRoleOrGrantedProject — team member OR accepted group grant on :projectId

middleware/requireProjectAccess.ts
  requireProjectAccess / requireProjectWriteAccess
```

Access resolution (highest wins, `scope`: `view` for list/get, `nested` for tasks/…):

1. Global `ADMIN` → WRITE
2. `project.ownerId === userId` → WRITE
3. `project.edit` manager → READ in **view** scope only (rename via separate update gate)
4. ACCEPTED group grant with any FULL membership → WRITE; READONLY only → READ
5. else NONE

External members are **not** given `TeamMembership`; they reach nested routes only via
`requireTeamRoleOrGrantedProject` when `resolveProjectAccess !== NONE`.

Mutations require WRITE (`assertCanWriteProject` / `requireProjectWriteAccess`).

## Dashboard (v1.46)

The dashboard (`DashboardPage.tsx`) fans out `/reports/summary`, `/done`,
`/workload`, `/upcoming`, and `/activity` **per team membership** and merges
client-side (same pattern as Planner Charts cross-team mode). KPIs therefore
reflect all projects/tasks visible within every team the user belongs to.
Reports page remains team-scoped via the team picker.

## Settings shell (v1.46)

Administration surfaces live under `/settings/*`:

- `/settings/trash` — soft-deleted items (was `/trash` in main nav).
- `/settings/admin` — user management (was `/admin` in main nav). **v1.53:** lifecycle
  controls (disable/enable, unlock, force-logout, local profile edit) with token
  revocation on disable so group-granted access cannot outlive a disabled account.

Legacy paths redirect. Main sidebar links to `/settings` (highlights for any
settings sub-route).

## IT demo seed (v1.46)

`prisma/seed-it-demo.ts` — optional dataset for demos/training. Activated via
`SEED_IT_DEMO=1` in `seed-router.ts` or `npm run prisma:seed:it`. Preserves
existing admin credentials from `SEED_ADMIN_EMAIL`; task dates use UTC today.

## LDAP authentication (v1.43)

```
Login POST /api/auth/login
  → AuthService branches on email lookup
  → LOCAL: argon2 verify + password policy + lockout
  → LDAP:  LdapService.search(bind DN) → user bind
           STARTTLS on :389 or LDAPS on :636
           optional tlsInsecure for private-CA AD
  → JIT create User row when directory.allowJIT && no local row
  → sync name / externalId / authSource on every success
```

Bind passwords and SCIM tokens are encrypted with `MASTER_KEY`. LDAP group
→ role mappings run post-bind when `syncRolesFromGroups` is enabled.

## Instance security policy (v1.43)

Local-password rules live in `InstanceSetting` (`security.passwordPolicy`).
`PasswordPolicyService` is the single validator — auth register/change,
admin reset, and the Settings UI all call the same shape. LDAP/SCIM users
skip policy checks on login (IdP is authoritative).

Lockout + `SecurityAuditEvent` rows give admins forensic signal without
exposing whether an email exists on failed login (enumeration-safe responses
unchanged).

## TaskHub server / TLS (v1.43)

Admin-uploaded certs land in a Docker volume (`caddy_custom_certs`). Caddy
reads them on restart — there is no hot reload. Port and HTTPS flags are
instance settings surfaced in Settings → TaskHub; operators still configure
the public hostname in Caddy/env separately.

## What's intentionally not here yet

- Email delivery: per project decision, no SMTP integration. Password reset
  returns the token in non-production responses. Wiring SMTP is a contained
  change to `lib/mailer.ts` (not yet created) + the `AuthService` reset path.
- Background jobs: Redis is provisioned but no BullMQ worker exists yet. The
  `jobs/` folder is reserved for the first job (likely overdue-task notifications).
- Realtime: notifications are pull-based for v1. Add SSE or websockets when
  the UX needs it; the existing `Notification` table is already the source of truth.
- File storage abstraction: uploads land on a local volume. The storage
  interface in `lib/storage.ts` (Feature 4) will accept an S3-compatible
  implementation as a swap-in.

## Testing strategy

- **Unit tests** for pure helpers (hashing, duration parsing).
- **Integration tests** against a real Postgres using Fastify's `inject()`.
  Mocking Prisma was considered and rejected — the value of these tests is
  exercising the actual SQL Prisma generates and the constraints we declared.
- Each feature ships with happy-path + negative-path tests for authorization
  (another team's user must not read this team's data).
