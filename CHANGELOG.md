# Changelog

All notable changes to TaskHub are documented in this file. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
