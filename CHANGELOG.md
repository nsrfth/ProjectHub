# Changelog

All notable changes to TaskHub are documented in this file. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] — 2026-05-23

Phase 2B — SCIM 2.0 provisioning. Adds a SCIM-compliant `/scim/v2/Users` +
`/scim/v2/Groups` surface so IdPs (Okta, Azure AD, JumpCloud, …) can push
user/team state at TaskHub. Reuses the `Directory` + `User.externalId`
foundation from v1.4.0 — each Directory gets at most one SCIM credential.

### Schema

- New `ScimCredential` model (1:1 per Directory). Stores `tokenHash` (sha256
  of the raw bearer token) and audit fields (`createdAt`, `lastUsedAt`,
  `revokedAt`). The raw token is shown to the admin exactly once at
  generation; never persisted.
- New `User.disabledAt: DateTime?` column. Set when SCIM PATCH/PUT delivers
  `active: false`; cleared on reprovision. Login and refresh both reject
  when this is non-null.
- Migration `20260523120000_add_scim` — additive only.

### SCIM endpoints

All under `/api/scim/v2`:

- **Discovery (no auth)**: `GET /ServiceProviderConfig`, `GET /ResourceTypes`,
  `GET /Schemas` — IdPs probe these at setup time.
- **Users**: `GET /Users` (with `?filter=` + `?startIndex=` + `?count=`),
  `GET /Users/:id`, `POST /Users`, `PUT /Users/:id`, `PATCH /Users/:id`,
  `DELETE /Users/:id`.
- **Groups**: same six methods, mapped to TaskHub `Team` + `TeamMembership`.
- Responses are `application/scim+json` with the proper SCIM envelopes
  (`schemas: [...]`, `meta: { resourceType, location, ... }`,
  `ListResponse` for collections, `Error` for failures).
- Request bodies accept `application/scim+json` (Fastify parser registered
  alongside the default `application/json`).

### Filter parser

Phase 2B supports the single shape IdPs actually send during sync:

`<attr> eq "<value>"` for `userName`, `externalId`, `id`, `emails.value`
(Users) and `displayName`, `id` (Groups). Anything more elaborate
(compound expressions, other operators) returns `400` with
`scimType: invalidFilter`.

### Deprovision (`active: false`)

- Sets `User.disabledAt = now()`.
- Revokes every active refresh token for that user in the same call.
- Login + refresh reject with the same "Invalid credentials" string used
  for bad passwords — no account-state leakage.
- Reprovision (`active: true`) clears `disabledAt`.

### Admin token UI

- New per-directory SCIM panel on
  [Settings → Directories](frontend/src/pages/settings/DirectoriesPage.tsx).
- Shows the SCIM base URL (`<origin>/api/scim/v2`), current token state
  (name / created / last-used / revoked), and Generate / Rotate / Revoke
  actions.
- After Generate, the raw token surfaces in a modal **exactly once**. The
  modal has Copy + "I've saved it" buttons; the value is never stored on
  the frontend either.

### Auth

- New `requireScimAuth` middleware
  ([middleware/auth.ts](backend/src/middleware/auth.ts)) — verifies
  `Authorization: Bearer <token>` against the SCIM credential hash and
  attaches `request.scimDirectoryId`. Separate from the user JWT path; a
  leaked SCIM token can only manipulate resources within its own
  Directory.
- New admin endpoints: `GET/POST/DELETE
  /api/settings/directories/:directoryId/scim`.

### Tests

- New [tests/integration/scim.test.ts](backend/tests/integration/scim.test.ts)
  — 10 cases covering: auth (missing / bad / revoked / valid), Users
  CRUD + filter, PATCH `active: false` soft-disables + revokes refresh
  tokens, DELETE removes the row, Groups create + members + PATCH remove
  member, discovery endpoints. Suite: **132/132** (was 122 → +10 SCIM).

### Verified

- Backend suite green (132).
- Live smoke against the running stack: generate token → SCIM POST /Users
  → PATCH active=false → bad-token 401, all round-trip correctly.
  `bindPasswordEnc` and `tokenHash` never leave the database.

### Known limitations / Phase 2B boundary

- Filter parser intentionally limited to `eq` only. `co`, `sw`, `pr`, and
  compound expressions return 400. Acceptable for sync workflows; would
  need extending for a SCIM search UI.
- SCIM PATCH `members` operations on Groups support `add` (with `value: [{...}]`)
  and `remove` (with `path: members[value eq "..."]`). Other forms IdPs
  *could* send (e.g. `replace` on the whole `members` array) fall back to
  reading the current state.
- No SCIM webhook back to the IdP — TaskHub is read-only from the SCIM
  contract's perspective.

## [1.4.0] — 2026-05-23

Phase 2A — Multi-directory identity. Adds LDAP login on top of the existing
local-password flow, with admin-managed Directory configs, group-to-role
mapping, and JIT user provisioning. Login still goes through `POST /auth/login`
unchanged from the client's perspective; the server branches between
argon2 + LDAP based on whether the user owns a `directoryId`.

### At-rest encryption foundation

- New [lib/crypto.ts](backend/src/lib/crypto.ts) — AES-256-GCM with a single
  `MASTER_KEY` env var (64 hex chars / 32 bytes). Same key feeds Phase 2A
  (LDAP bind passwords), Phase 2C (TOTP secrets), and Phase 3B (webhook
  secrets) — the operator backs it up alongside the database.
- Throws on first use if `MASTER_KEY` is missing, with a generation command
  in the error message. Optional at boot, so deployments not using
  encryption-touching features need no extra setup.

### Schema

- New `Directory` + `DirectoryGroupMapping` models. Migration
  `20260523090000_add_directory` — additive/nullable only, no destructive
  changes to existing data.
- `User.passwordHash` is now nullable — LDAP users have no local password.
- `User.directoryId` + `User.externalId` (+ unique on the pair) link an
  account to its source-of-truth directory.
- `Team.directoryId` for teams that will be wholly directory-managed (the
  membership-sync side lands when 2C/group sync work matures).

### Authz helpers reused from v1.3.0

The settings shell already shipped `requireGlobalAdmin` /
`requireTeamManager` / `requireSelf`. The new directory routes are mounted
under that same admin gate.

### LDAP integration

- New [LdapService](backend/src/services/ldapService.ts) using `ldapts`.
  Search-then-bind: connect → admin-bind → search by `emailAttr` for the
  user → rebind as the found DN with the supplied password → enumerate
  group DNs the user belongs to. RFC 4515 escaping on all user-controlled
  filter input (`\`, `*`, `(`, `)`, NUL).
- New [DirectoryService](backend/src/services/directoryService.ts) for CRUD
  plus at-rest encryption of `bindPassword`. The cipher-text column
  `bindPasswordEnc` NEVER appears in any response schema — Zod's response
  shape excludes it entirely, surfacing `hasBindPassword: boolean` instead.

### Login flow

`authService.login` now branches three ways:

- User exists locally with `directoryId = null` → legacy argon2 check.
- User exists locally with `directoryId` set → LDAP bind against that
  directory; on success, the email/name/externalId fields are re-synced
  from LDAP and group mappings re-applied.
- No local user → walk every active `kind: LDAP` directory with `allowJIT`
  set; on the first successful bind, create the local `User` row with
  `passwordHash = null` and apply group mappings before issuing the
  session. First-ever user becomes ADMIN (matches `register()`).

Group → role mapping logic, when `Directory.syncRolesFromGroups = true`:

- Map's `globalRole` overrides the user's instance-wide role. ADMIN beats
  MEMBER if multiple groups match.
- Map's `(teamId, teamRole)` upserts a `TeamMembership`.
- A directory's mapped teams that the user no longer qualifies for have
  their `TeamMembership` removed — so dropping out of an LDAP group revokes
  team access on the next login.

### CRUD surface

- `POST/GET/PATCH/DELETE /api/settings/directories/...` — directory CRUD.
- `POST /api/settings/directories/:id/test` — admin-driven bind +
  small-sample search, returns `{ ok, message, sampleUserCount }`.
- `GET/POST/DELETE /api/settings/directories/:id/mappings/...` — group →
  role mapping CRUD.

### Frontend

- Settings → Directories sub-page replaces the v1.3.0 placeholder
  ([DirectoriesPage.tsx](frontend/src/pages/settings/DirectoriesPage.tsx)).
  Create, edit, delete, and "Test" buttons; full attribute-mapping form
  with sensible defaults (uid/mail/cn/member). Edit form leaves the bind
  password empty and only sends it when the admin retypes it.
- `AuthUser` interface gains `directoryId` + `externalId` so future
  features (Phase 2C / Phase 3) can disable local-only actions on
  directory-owned accounts.

### Test infrastructure

- New `openldap` service in [docker-compose.yml](docker-compose.yml) under
  the `ldap` profile (`docker compose --profile ldap up -d openldap`).
- Same image pinned in
  [.github/workflows/test.yml](.github/workflows/test.yml) as a service
  container so CI exercises the real LDAP path.
- New [tests/integration/ldap.test.ts](backend/tests/integration/ldap.test.ts)
  — 5 cases covering JIT-provision with group-mapping ADMIN, JIT-provision
  with group-mapping MEMBER, wrong password (401), no-such-user (401), and
  group-less user keeping default MEMBER. The test seeds the directory
  via `ldapts` at suite start so it works against either CI's ephemeral
  service container or a long-lived dev container.

### Verified

- Backend suite: **122/122** (was 117 → +5 LDAP).
- Frontend build: clean.
- Live smoke against the running stack: directory create → `/test`
  (3 sample users found) → `/auth/login` as `alice@taskhub.local`
  with the LDAP password → JIT-creates the `User` row with
  `directoryId` set, `externalId = uid=alice,ou=People,dc=taskhub,dc=local`,
  no local password. `bindPasswordEnc` does not appear in any response
  body.

### Known limitations / Phase 2A boundary

- When a local user with an email matching an LDAP user already exists,
  the local-password path takes precedence — by design, but admins
  migrating onto LDAP need to delete or re-link those rows manually for
  now. A "convert this user to LDAP" admin action lands in a later phase.
- SCIM is reserved on the `DirectoryKind` enum but not implemented; Phase
  2B builds on the same `Directory` table.
- The `Team.directoryId` column is plumbed end-to-end but no logic yet
  makes a directory-managed team behave differently. That logic lands
  alongside Phase 2B's SCIM sync.

## [1.3.0] — 2026-05-23

Phase 1 of the Settings surface — shell only. Adds the foundation for
admin-managed instance configuration without yet shipping any concrete
toggle. Future phases land actual settings (auth policy, audit retention,
webhook config) on top of this skeleton.

### Backend

- New Prisma model `InstanceSetting` (key, JSON value, updatedAt, updatedBy).
  Migration `20260522180000_add_instance_setting`. Value column is JSONB —
  per-key shape is enforced at the consumer, not the schema, so adding new
  toggles is a zero-migration change.
- New reusable authz guards in
  [middleware/auth.ts](backend/src/middleware/auth.ts):
  - `requireGlobalAdmin` — convenience over `requireGlobalRole('ADMIN')`.
  - `requireTeamManager` — convenience over `requireTeamRole('MANAGER')`.
  - `requireSelf` — gates `:userId`-scoped routes (caller must be the user
    OR a GlobalRole.ADMIN). Useful for "edit my profile" / "change my
    password" / "delete my account" surfaces.
- New CRUD endpoints mounted at `/api/settings/instance` (ADMIN-only):
  - `GET /instance` — list all keys.
  - `GET /instance/:key` — read one.
  - `PUT /instance/:key` — create or overwrite (body: `{ value: <any> }`).
  - `DELETE /instance/:key`.
- Zod schemas live in [schemas/settings.ts](backend/src/schemas/settings.ts).
  `value` is `z.unknown()` so the route accepts any JSON.

### Frontend

- New Settings layout at `/settings` with a role-filtered sidebar
  ([SettingsLayout.tsx](frontend/src/features/settings/SettingsLayout.tsx)).
  Sidebar entries declare which roles may see them; users in no matching
  role are bounced to /dashboard. Bare /settings redirects to the first
  item the user can actually see.
- Four placeholder sub-pages, each wiring a real React Query hook against
  `/settings/instance` so the auth + transport path is exercised end-to-end
  even though the UI is a "coming in a future phase" card:
  - Directories
  - Security
  - Audit
  - API & Webhooks
- All four are ADMIN-only in Phase 1.
- New "Settings" link in the dashboard header, rendered only when
  `user.globalRole === 'ADMIN'`.

### Verified

- Backend suite: 117/117 still pass.
- Frontend build: clean.
- Live smoke against `/api/settings/instance`: empty-list → PUT → GET-single →
  list-after-PUT → DELETE → list-after-DELETE round-trips correctly. A
  freshly-registered MEMBER user gets a 403 (`FORBIDDEN: Insufficient role`)
  when reading the list, confirming `requireGlobalAdmin` is wired.

## [1.2.1] — 2026-05-22

Quality pass on v1.2.0 — no user-visible behavior change, just loose ends.

- Rewrote [prisma/seed.ts](backend/prisma/seed.ts) to match the v1.2.0 model:
  `admin@taskhub.local` / `admin`, three additional demo users, 1 team, 3
  projects, 18 tasks with labels, all dates `Date.UTC(...)`-anchored. Dataset
  is designed to hit deliberate Timeliness numbers on a fresh install (7d:
  50% on-time / +0.5d avg / 3 behind plan; 30d: 50% / +0.83d / 3). Seed is
  idempotent — re-runs no-op if admin + projects already exist.
- One-time `UPDATE` on the running dev DB to truncate `completedAt` to UTC
  midnight, closing the time-of-day pollution from pre-v1.2 seeded rows.
- New shared test bootstrap [backend/tests/setup.ts](backend/tests/setup.ts)
  wired in via `setupFiles` in [vitest.config.ts](backend/vitest.config.ts).
  Sets `AUTH_RATE_LIMIT_MAX ??= '10000'` and friends so the suite no longer
  needs explicit env overrides at the runner. Per-file `beforeAll` blocks
  can keep their own JWT/CORS defaults; the `??=` makes the shared file
  yield to any caller that's already set them.
- New integration test
  [backend/tests/integration/timeliness.test.ts](backend/tests/integration/timeliness.test.ts)
  with 5 cases (zero state, single on-time, mixed-variance batch, window
  exclusion, behind-plan filtering). Total suite count is now 117/117.
- New [BACKUP.md](BACKUP.md) covering Postgres logical dumps, the uploads
  volume (tarball via throwaway alpine), Redis AOF/RDB (optional), and a
  short verification ritual.

## [1.2.0] — 2026-05-22

Three-date model for tasks and a new Timeliness report. Distinguishes the hard
deadline from the team's planned target from the actual completion, so the
Reports page can answer "are we hitting our own plan?" alongside "are we
breaching deadlines?".

### Three date fields on Task (breaking API rename)

- `dueDate` — hard deadline (externally-imposed). Drives `TASK_DUE` reminders;
  surfaced as the "Overdue" report. Unchanged from prior versions.
- `plannedDate` — **new**. The team's target completion date. Doesn't trigger
  notifications; powers the new Timeliness report.
- `completedAt` — actual completion. **Renamed from `doneAt`**. Auto-fills on
  first transition to `status = DONE` when not set explicitly; can also be
  backdated manually regardless of status.
- Migration `20260522160549_planned_and_completed_dates`:
  `ALTER TABLE "Task" ADD COLUMN "plannedDate"` +
  `ALTER TABLE "Task" RENAME COLUMN "doneAt" TO "completedAt"`. Postgres
  preserves data and indexes through the rename.
- All API request/response shapes (`createTask`, `updateTask`, list/get,
  `/reports/done`) emit and accept `completedAt` instead of `doneAt`, and
  accept/return `plannedDate`. The Zod schemas drop `doneAt` entirely;
  callers must migrate.

### New `/api/teams/:teamId/reports/timeliness` endpoint

- Trailing-window query (`?days=N`, default 7, cap 365). Evaluates every task
  in the window that has both `plannedDate` and `completedAt`, returning:
  - `onTimeRate` — completed-by-or-before-plan / evaluated count (0..1).
  - `avgVarianceDays` — mean `completedAt − plannedDate` in days. Positive =
    late on average, negative = early.
  - `evaluatedCount` — denominator, for UX transparency when small.
  - `behindPlanCount` — open tasks (`TODO|IN_PROGRESS|REVIEW`) whose
    `plannedDate` is now in the past. This one is unaffected by `?days`.

### Frontend UI

- Task detail page: three pickers in a grid — "Due by", "Planned on",
  "Completed on" — each with its own save/clear and a one-line helper.
- Kanban card date strip now shows up to three dates with distinct colors:
  slate (`مهلت` due), sky (`هدف` planned), emerald (`انجام` completed).
- Reports page:
  - "Tasks done" section renamed to **"Tasks completed"**.
  - New **Timeliness** section with on-time rate (% with traffic-light
    coloring), avg variance days (signed, red/emerald), behind-plan count,
    and window.

### Behavior notes / caveats

- Auto-fill of `completedAt` continues to fire only on the first
  `status → DONE` transition. Status flips back-and-forth don't clobber a
  user-set completion date.
- Pre-existing rows from earlier versions have `plannedDate = NULL` — they
  show no "planned" date and are excluded from Timeliness until set. The
  seeded sample data was updated to include realistic planned dates so the
  new section populates on a fresh install.
- 112 integration tests pass after the rename (no logic regression — the
  rename is internal to Prisma's column mapping and tests exercise the
  service / API layer, not the schema directly).

## [1.1.3] — 2026-05-22

Date-handling correctness pass. Fixes a real timezone bug, separates calendar
dates from timestamps in the helper API, switches recent activity to relative
time, and broadens the TASK_DUE scheduler to include overdue tasks.

### Calendar-date vs timestamp split (bug fix)

- The previous `formatShamsi*` helpers read **local-time** components from
  Date objects stored as **UTC midnight**. For a calendar date the user
  picked as "May 22", a viewer in PST (UTC−8) saw "May 21". Real bug;
  invisible during single-TZ testing.
- [shamsi.ts](frontend/src/lib/shamsi.ts) rewritten with two clear families:
  - `formatShamsiCalendarDate` / `formatShamsiCalendarLong` — read UTC
    components. Use for `dueDate`, `doneAt`. Same date everywhere.
  - `formatShamsiTimestamp` / `formatShamsiTimestampDate` — read local
    components. Use for `createdAt`, `joinedAt`, `updatedAt`. Localizes
    correctly to the viewer's TZ.
- Back-compat aliases (`formatShamsiDate` → calendar, `formatShamsiDateTime`
  → timestamp) preserved so legacy call sites stayed correct without per-line
  rewrites; the few timestamp-field call sites that used `formatShamsiDate`
  were explicitly switched to `formatShamsiTimestampDate`.

### Relative time for activity feeds

- New `formatRelativeTime(iso)` using `Intl.RelativeTimeFormat('fa-IR')`.
  Falls back to `formatShamsiTimestamp` for anything older than 30 days
  (relative wording stops being useful past that).
- Applied on: task-detail comment timestamps, task-detail activity feed,
  attachment "uploaded" timestamps, notification-bell entries. Each one
  carries the precise Shamsi timestamp in the `title` tooltip so hovering
  reveals the exact time.

### TASK_DUE scheduler now includes overdue tasks

- Previous window was `(now, now+leadHours]`. A task whose `dueDate` was
  already in the past at the moment it became known (backfill, schema fix,
  imported data) never fired a reminder.
- New window: `[now−30d, now+leadHours]` AND `status` is OPEN. The 30-day
  floor protects against spamming reminders for ancient overdue tasks.
- Two new scheduler tests cover the overdue case and the 30-day floor.

### Library consolidation

- `jalaali-js` dependency removed (was redundant with `react-date-object`,
  which `react-multi-date-picker` already pulls in). The `types/jalaali-js.d.ts`
  ambient declaration deleted too.
- Frontend bundle module count: 179 → 178.

### Stale code purged

- `dateInputToISO` / `isoToDateInput` helpers (dead since the
  `<input type="date">` → `ShamsiDatePicker` swap in v1.1.1) are gone.

### Tests

- 12 files, **112 tests passing** (was 110 — 2 new scheduler tests).

[1.1.3]: https://github.com/USER/REPO/releases/tag/v1.1.3

## [1.1.2] — 2026-05-22

Reports section expansion. New endpoints, new sections, Dashboard widget,
and a Reports link in every authenticated page header.

### New report endpoints

- `GET /api/teams/:teamId/reports/workload` — open tasks per assignee with
  a per-status breakdown. Unassigned bucket has `assigneeId/Name = null`.
- `GET /api/teams/:teamId/reports/overdue` — open tasks past their
  `dueDate`, oldest first, with `daysOverdue` precomputed server-side.
- `GET /api/teams/:teamId/reports/summary` — single cheap aggregate
  (`doneLast7Days`, `overdueCount`, `openCount`, `byStatus` totals) used
  by the Dashboard widget so it doesn't hit four endpoints on every render.

### Reports page

- Four-up status counter strip at the top (Open / In progress / Done 7d /
  Overdue), red when overdue > 0.
- New "Workload" section: assignee table with per-status columns and a
  total. Sorted by total descending.
- New "Overdue" section: tasks past `dueDate`, oldest first, with project,
  status, assignee, Shamsi-formatted due date, and a days-overdue badge.

### Dashboard widget

- "At a glance" card shows the three headline numbers (Open / Done 7d /
  Overdue) with a "Full reports →" link.

### Cross-page navigation

- Every authenticated page header (Admin, Projects, Tasks, Teams) now
  carries a "Reports" link next to "Back to dashboard" / "← Projects" so
  the report surface is reachable from anywhere.

[1.1.2]: https://github.com/USER/REPO/releases/tag/v1.1.2

## [1.1.1] — 2026-05-22

Polish patch on top of v1.1.0. No new endpoints behind feature flags, no
schema migrations — just UX gaps from the Shamsi / doneAt follow-up list.

### Shamsi sweep

- Notification dropdown timestamps switched from `toLocaleString()` to
  `formatShamsiDateTime` (Persian numerals + Jalali date).
- Member list on the Teams page now shows each member's join date in Shamsi.
- Projects list shows each project's creation date in Shamsi.
- Admin tables gained "Joined" (users) and "Created" (teams) columns,
  both Shamsi.

### True Shamsi date picker

- New `@/lib/ShamsiDatePicker` wrapping `react-multi-date-picker` with the
  `persian` calendar + `persian_fa` locale. Public contract is ISO 8601
  in/out so it slots into anywhere `<input type="date">` was used.
- Task detail page's "Done date" input is now the Persian-calendar picker.
  Removed the previous Gregorian-input-with-Shamsi-label fallback.

### Reports

- New `GET /api/teams/:teamId/reports/done?days=N` endpoint (default 7,
  cap 365). Returns tasks completed in the trailing window with project +
  assignee details joined in for display.
- New `/reports` page with a 7/30/90-day toggle, a most-recent-first task
  list, and a by-assignee tally pivot (computed client-side from the same
  result set).
- Link added on the dashboard next to "View projects".

[1.1.1]: https://github.com/USER/REPO/releases/tag/v1.1.1

## [1.1.0] — 2026-05-22

Closes every feature gap from the v1.0 known-limitations list. Test suite
grew from 98 to **110 integration tests, all green**.

### Realtime notifications (WebSocket)

- New `GET /api/ws/notifications?token=<accessToken>` channel via
  `@fastify/websocket`. Server pushes `{type:'notification:new'}` when a row
  lands for the connected user; the bell invalidates its TanStack Query
  cache on receipt and re-fetches via REST.
- In-memory pub/sub hub (`notificationsHub`) keyed by userId — fine for the
  single-replica Compose deploy. Multi-instance would swap to Redis pub/sub
  on the existing container.
- Frontend auto-reconnects with exponential backoff up to 30 s; subscribes
  to `onTokenChange` so a sign-in / refresh re-establishes the socket.

### Kanban drag-and-drop

- `@dnd-kit/sortable` on the task board: drag a card within its column to
  reorder, or across columns to change status. Per-card status dropdown
  preserved as a keyboard-accessible alternative.
- New `POST /api/.../tasks/:taskId/reorder` endpoint takes
  `{status, beforeTaskId|null}` and computes the new position as the
  midpoint of two neighbors. When gaps collapse to ≤1, the column is
  automatically renumbered at the sparse interval — durable ordering
  without fractional-index complexity.

### TASK_DUE scheduled notifications

- In-process `setInterval` scheduler (`src/scheduler/dueDateScheduler.ts`)
  scans tasks where `dueDate` is within the lead window and emits a
  `TASK_DUE` notification once per (task, dueDate) cycle. BullMQ is the
  natural production upgrade.
- Idempotency via new `Task.dueNotifiedAt` column: set when emitted, reset
  to null whenever `dueDate` changes so rescheduling re-fires the reminder.
- Opt-in via `TASK_DUE_ENABLED=true`; `TASK_DUE_LEAD_HOURS` (default 24)
  and `TASK_DUE_CHECK_INTERVAL_MIN` (default 15) are env-configurable.

### @mention parsing

- Comment bodies parse `@handle` patterns where `handle` matches the
  local-part of a team member's email (`@alice` matches `alice@x.com`).
- Each mentioned member receives a `MENTION` notification separate from
  the per-task `TASK_COMMENT` — a mentioned user who is also the assignee
  gets both.

### Notification click-through

- Every notification payload now carries `projectId` in addition to
  `taskId`, so the bell navigates directly to
  `/projects/:projectId/tasks/:taskId` instead of `/dashboard`.

### Admin pagination

- `GET /api/admin/users` and `/admin/teams` now accept `?cursor=` and
  `?limit=` (default 25, capped at 100) and return `{items, nextCursor}`.
- Admin page accumulates pages with "Load more"; mutations reset the
  accumulator to avoid stale rows mid-list.

### Admin user deletion

- `DELETE /api/admin/users/:userId` implemented.
- Schema migration `user_delete_cascades`:
  - `Project.owner`, `Task.creator`, `Task.assignee`, `Comment.author` →
    `ON DELETE SET NULL`. Content survives with "(deleted user)" attribution.
  - `Activity.actor`, `Attachment.uploader` → `ON DELETE CASCADE`. Activity
    is observability not audit; orphan attachment blobs on disk need their
    own GC pass.
- Same hard invariants as role updates: can't delete yourself, can't
  delete the last ADMIN.

### Email verification

- New `EmailVerification` model + migration. Register auto-issues a
  verification token; in non-prod the controller surfaces it as
  `devVerifyToken` (mirrors `devResetToken`).
- New endpoints:
  - `POST /api/auth/verification/request` — re-issue (anti-enumeration shape)
  - `POST /api/auth/verification/perform` — claim a token, set `emailVerifiedAt`

[1.1.0]: https://github.com/USER/REPO/releases/tag/v1.1.0

## [1.0.0] — 2026-05-22

First public release. Covers every model in the schema with an end-to-end
backend + frontend implementation and a green integration-test suite
(98 tests across 11 files, run on every push via GitHub Actions).

### Auth

- Email + password registration / login with **argon2id** password hashing.
- JWT access tokens (15 min default) + refresh tokens delivered as
  `httpOnly`, `SameSite=Lax` cookies scoped to `/api/auth`.
- Refresh-token rotation; reusing a revoked token is rejected.
- Server-issued password reset (in non-prod the reset token is surfaced in the
  response body to avoid a hard email dependency).
- First-user-becomes-ADMIN promotion on first registration.
- Rate-limited write-side endpoints (env-configurable; defaults to 10/min/IP).

### Teams

- Team CRUD; slug uniqueness enforced.
- Membership with `MANAGER` / `MEMBER` roles.
- Invariant guarded by the service layer: a team must always have at least one
  MANAGER (the last MANAGER can be neither removed nor demoted).

### Projects

- Nested under teams (`/api/teams/:teamId/projects/...`) so `requireTeamRole`
  enforces tenancy via the URL.
- Owner-or-MANAGER edit/delete.
- Cross-tenant probes return 404 — never leak existence.

### Tasks

- CRUD plus a `doneAt` column for completion-date tracking.
- `doneAt` is auto-filled when status transitions to `DONE` if the user hasn't
  set one explicitly; auto-fill is intentionally _not_ logged as a separate
  activity event (it's a side-effect of `task.status_changed`).
- Status filter on list.
- Sparse position scheme (1000-step gaps per `(projectId, status)` column)
  ready for future drag-and-drop reorder.
- Assignee validation: the assignee must be a team member.

### Comments

- Threaded comment list per task, oldest first.
- Author-only edit. Author OR team MANAGER can delete.
- Every mutation wrapped in `prisma.$transaction` so the comment row and its
  activity row commit together.

### Activity log

- Single emit point (`logActivity`) writes rows transactionally alongside the
  triggering mutation.
- Diff-aware: only fields the user explicitly changed produce a
  `task.updated` event; no-op PATCHes emit nothing.
- Known actions: `task.created`, `task.updated`, `task.status_changed`,
  `comment.added`, `comment.edited`, `comment.deleted`.
- Bound to its task — deletions are deliberately not logged (Activity FK
  cascades from Task). A separate non-cascading audit table is future work.

### Notifications

- User-scoped (no team in the path); each query is implicitly filtered to the
  caller.
- Three fan-out triggers: `TASK_ASSIGNED` on assignment, `TASK_COMMENT` on
  comment, `TASK_STATUS` on status change. The actor is always excluded.
- `unread-count` endpoint feeds a bell badge in the top-right of every
  authenticated page; clicking opens a dropdown with the latest 20.

### Labels

- Team-scoped colored tags; name unique per team (409 on duplicate).
- Hex color (`#RRGGBB`) validated. SVG MIME deliberately omitted — see
  Attachments below.
- Attach is idempotent; deleting a label cascade-detaches from every task.
- Surfaced inline on the task response (`labels: [...]`) so kanban cards can
  render chips without an extra round trip. Chips auto-pick black or white
  text via BT.601 luminance.

### Subtasks

- Checklist children of a task (title + done flag + position).
- Surfaced inline on the task response.
- Cross-parent guard: subtaskId must belong to the taskId in the URL.

### Attachments

- Multipart upload via `@fastify/multipart` with `UPLOAD_MAX_BYTES` enforced
  as a streaming limit; oversize uploads stream up to the cap, then the
  partial file is unlinked and the request rejected.
- MIME allowlist (10 types: common image formats, PDF, plain text, markdown,
  CSV, JSON, ZIP). **SVG is explicitly excluded** because inline `<script>`
  in SVG runs in the same origin.
- User-supplied `filename` never touches the filesystem — server generates an
  opaque `storageKey` (`crypto.randomBytes(16).toString('hex')`) for the
  on-disk path. Defense-in-depth path-traversal guard verifies the resolved
  download path is rooted under `UPLOAD_DIR`.
- `Content-Type` on download pinned from the stored MIME type
  (Helmet's `nosniff` reinforces).
- Uploader OR team MANAGER can delete.

### Admin

- `/api/admin` endpoints gated by `requireGlobalRole('ADMIN')`.
- User role promote/demote with two hard guards: can't demote the last ADMIN;
  can't change your own role even when other admins exist.
- Force-delete a team — schema cascade tears down memberships, projects,
  tasks, subtasks, comments, activity, notifications, labels, attachments
  in one transaction.

### Shamsi (Persian/Jalali) calendar

- Storage and API transport stay UTC ISO 8601; only display is Shamsi.
- Helpers in `frontend/src/lib/shamsi.ts`: compact `formatShamsiDate`,
  longer-form `formatShamsiLong`, `formatShamsiDateTime`, and bridge
  utilities between `<input type="date">` and ISO.
- Applied on kanban cards, task detail, comments, activity feed.

### Operations

- Docker Compose deploys Postgres 16, Redis 7, Fastify backend, Vite-built
  SPA, and Caddy 2 as reverse proxy (auto-HTTPS for a real hostname).
- Baseline Prisma migration in version control plus one delta migration for
  `Task.doneAt`. Future schema changes follow the standard
  `prisma migrate dev` flow.
- GitHub Actions CI: backend job spins up Postgres as a service container,
  applies migrations, runs typecheck + vitest; frontend job runs
  typecheck + production bundle. Both gated on every push and PR.

### Security model

- Helmet headers + Caddy adds HSTS, X-Frame-Options, Referrer-Policy.
- CORS is an explicit allowlist; `credentials: true` cannot pair with `*` by
  design.
- All input validated with Zod; Prisma's parameterized queries close the SQL
  injection door.
- Auth endpoints have per-route rate limiting controlled by env.
- Cross-tenant resource access returns 404 (not 403) so the existence of
  another team's data isn't leaked.

### Known limitations

- No within-column drag-and-drop reorder on the kanban yet (the
  `position` field and sparse-position scheme are ready for it).
- `TASK_DUE` notifications and `@mention` parsing not implemented; both need
  additional infrastructure (scheduled job runner; body parser).
- No user-deletion endpoint in admin — `Project.owner`, `Task.creator`, and
  `Comment.author` are RESTRICT relations in Prisma, so user delete needs a
  reassign-ownership flow or a schema migration first.
- Notification click-through routes to the dashboard, not the specific task;
  payloads carry `taskId` but not `projectId` yet.

[1.0.0]: https://github.com/USER/REPO/releases/tag/v1.0.0
