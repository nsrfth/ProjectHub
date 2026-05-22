# Architecture

This document captures the *why* behind TaskHub's design. The *what* is in the
code; the *how to run* is in [README.md](README.md).

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
Login / Register:
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
