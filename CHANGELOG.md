# Changelog

All notable changes to TaskHub are documented in this file. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.27.0] — 2026-05-26

Automatic Postgres backups, admin-configurable.

### Backend

- New `services/backupsService.ts` shells out to `pg_dump --format=custom`,
  writes to `BACKUP_DIR` (default `/app/backups`), prunes oldest files past
  the retention count after every successful run. Strips Prisma-specific
  query params (`?schema=public`, `connection_limit`) before handing the
  URL to libpq + lifts `schema` into the proper `--schema` flag so pg_dump
  doesn't 400 on unknown query keys.
- New `scheduler/backupScheduler.ts` — same opt-in shape as the TASK_DUE /
  WEBHOOK / RECURRENCE schedulers. `BACKUP_ENABLED=true` opts the loop in;
  `BACKUP_CHECK_INTERVAL_MIN` (default 15 min) is the tick granularity.
  Per-tick logic reads the admin-set config + `backup.lastRunAt`
  InstanceSetting, fires `pg_dump` when `(now - lastRunAt) >= intervalHours`.
- Five new admin-only endpoints under `/api/admin/backups`:
  - `GET /` — config + lastRunAt + nextRunAt + file list
  - `PUT /config` — partial update of `{ enabled, intervalHours, retention }`
  - `POST /run` — synchronous pg_dump now
  - `GET /:filename/download` — streams the dump (Bearer-auth, octet-stream)
  - `DELETE /:filename` — removes one dump
  Filename sanitisation rejects path traversal + anything outside the
  `taskhub-*.dump` shape.
- `docker/backend.Dockerfile`: install `postgresql16-client` in the runner
  stage so `pg_dump` is available. `mkdir -p /app/backups` + chown to the
  `app` user so the named volume inherits the right ownership on first
  mount (named volumes copy ownership from the image path).
- `docker-compose.yml`: new `backups_data` named volume mounted at
  `/app/backups` in the backend service.
- New env vars (all sensible-default + opt-in):
  `BACKUP_ENABLED=false`, `BACKUP_DIR=/app/backups`,
  `BACKUP_CHECK_INTERVAL_MIN=15`. Admin tunes period + retention in the UI.

### Frontend

- New `pages/settings/BackupsPage.tsx` — ADMIN-only page in Settings.
  Toggle scheduler, set period in hours (1..720), set retention (1..365),
  "Run backup now" button (synchronous; surfaces filename + size +
  duration on success). Lists every stored dump with timestamp, size,
  Download + Delete per row. Download uses a blob fetch (axios with auth
  header) since the Bearer token doesn't ride on plain `<a>` clicks.
- New `features/backups/api.ts` client.
- New sidebar entry in Settings, gated to `globalRole === 'ADMIN'`.

### Verified

- Six new integration tests in `backups.test.ts` — admin gate (member 403),
  config defaults, config persistence, range clamping (`intervalHours
  99999` → 400), file listing, download, delete, and filename-sanitisation
  rejection of `../etc/passwd` + non-backup filenames. pg_dump path is
  covered by manual end-to-end against the running compose stack — the
  test runner doesn't bundle Postgres client tools.
- Manual: enabled scheduler at 1 h interval / 3 retention, ran 4 backups
  back-to-back, confirmed the oldest dump was pruned after each new write.

### Phase boundary

- Backup files are dumped to a docker named volume on the backend host.
  Off-host replication (S3, restic) is a deliberate v1.28 follow-up — the
  primary risk this release closes is "I have no recent dump at all," not
  "my host's disk died."
- Restore is a documented manual procedure (`pg_restore --clean --no-owner
  --dbname=$DATABASE_URL …`); a one-click restore UI is also a v1.28
  follow-up. Restore-from-UI introduces enough write-side risk
  (overwriting live data while users are connected) that it warrants its
  own design pass.

## [1.16.0] — 2026-05-24

Opt-in "update available" check.

### Backend

- New `services/updateCheckService.ts` — fetches the latest release tag from
  the hardcoded `nsrfth/taskhub` GitHub repo, caches the answer in-process
  for `UPDATE_CHECK_CACHE_HOURS` (default 6 h), single-flights concurrent
  callers, semver-compares against `TASKHUB_VERSION`. 10-second fetch
  timeout; network errors cache a "no info" answer rather than retrying
  on every admin click.
- New admin-only endpoint `GET /api/admin/update-check` returns
  `{ currentVersion, enabled, latestVersion, updateAvailable, releaseUrl,
  publishedAt, checkedAt }`. Returns `enabled: false` when the operator
  hasn't opted in.
- Two new env vars (both off / sensible-default by design):
  `UPDATE_CHECK_ENABLED` (default `false`) and `UPDATE_CHECK_CACHE_HOURS`
  (default `6`). Read directly from `process.env` so an operator can flip
  them with a `docker compose up -d --force-recreate backend`.

### Frontend

- `pages/AboutPage.tsx` shows a quiet emerald "↑ Update available: vX.Y.Z"
  pill next to the version field, **only** when the viewer is a global
  ADMIN, the operator enabled the check, and GitHub reported a strictly
  newer tag. Pill links to the release notes on GitHub.
- React Query gates the fetch on `globalRole === 'ADMIN'` so members never
  trigger a 403.

### Tests

- 13 new tests (178 → 191 total). 8 unit tests on the semver compare
  (handles `v` prefix, pre-release suffix, equal/older/newer, null inputs).
  5 integration tests on the endpoint (auth/role gates, disabled default,
  GitHub fetch mocked via `fetch` stub for higher + equal tags).

### Verified

- Suite: 186/191 passing + 5 skipped (lone failing file is the
  pre-existing LDAP integration test).
- Backend typecheck clean; frontend build clean.

### Phase boundary

- Hardcoded to `nsrfth/taskhub`. Forks that want a different upstream edit
  the `GITHUB_REPO` constant in `services/updateCheckService.ts`.
- No notification when a new release lands — admins still need to open
  the About page to see the badge. A toast / nav-banner is the obvious
  follow-up if "I missed the release" becomes a real complaint.
- Cache is in-memory per replica. In a multi-replica deploy each backend
  gets its own GitHub call; harmless at ~4 calls/day/replica.

## [1.26.0] — 2026-05-25

Admin-provisioned user accounts.

### What's new

- Admins can create a new user with email + name + password directly from
  the Admin page. The new account can sign in immediately with the
  supplied credentials — no self-registration / no invite email required.
- If the admin omits the password, the server generates a 20-char URL-safe
  one and surfaces it ONCE in the response. The UI shows it inline so the
  admin can copy-paste it to the new user.
- Admin-provisioned accounts default to `emailVerifiedAt = now()` — the
  admin vouches for the address.
- Global role can be set on create (defaults to MEMBER).

### Backend

- New `POST /api/admin/users` route. Admin-only.
- `AdminService.createUser` hashes the password with argon2id (same as
  the self-register path), creates the user, returns the new shape plus
  `generatedPassword: string | null`. Nothing is logged.
- Schema validates the supplied password against the existing policy
  (≥ 12 chars, letters + digits); duplicate emails → 409.

### Frontend

- "New user" section on AdminPage with email / name / password / role
  fields. **Auto** button clears the password so the server generates one.
- Success state shows a green inline box with the credentials. Password
  is `select-all` so a single click + Ctrl-C grabs it cleanly. Dismiss
  button when copied.

### Tests

- 6 new integration tests: admin-only gate, explicit-password login
  works, auto-generated-password login works, duplicate email 409, weak
  password 400, promote-to-admin on create.

### Verified

- Backend + frontend typecheck clean.
- Suite: 226/231 passing + 5 skipped (lone failing file is the
  pre-existing LDAP env-specific test).
- Backend rebuilt + frontend bundle redeployed.

### Phase boundary

- No "send invite by email" alternative — the admin must hand the
  password over manually. Adding an email-invite flow would need a new
  table (invite tokens) + an SMTP-gated path. Easy follow-up.
- No optional "add to team on create" step — admin creates the user,
  then uses the existing team UI to add them. Two clicks instead of one;
  keeps the endpoint focused.

## [1.25.0] — 2026-05-25

Three charts on the Dashboard.

### Frontend

- New `features/dashboard/StatusDonut.tsx` — pure-SVG donut of `byStatus`
  counts (TODO / IN_PROGRESS / REVIEW / DONE). Centre label shows the
  open-task total. Legend on the right.
- New `features/dashboard/CompletionTrend.tsx` — 30-day daily-bars chart
  with a 7-day moving-average overlay. Header carries "X total · +N vs
  prior 7d" so the trend reads at a glance.
- New `features/dashboard/WorkloadBar.tsx` — horizontal stacked bars per
  assignee (top 6 by open-task count), split by status. Truncated tail
  ("+ N open across M others") for teams with more than 6 active people.
- `DashboardPage` grows a responsive grid of three chart cards under
  the existing "At a glance" headline numbers. Max width bumped from
  `3xl` to `5xl` so the three-up layout breathes on xl screens.
- All charts read **existing** `/reports/summary`, `/reports/done`, and
  `/reports/workload` endpoints — zero new backend work, zero new
  dependencies. ~280 LoC total of inline SVG.

### Verified

- Frontend typecheck + production build clean.
- Bundle: +6 KiB gzipped from v1.24 (three small components).
- Frontend bundle redeployed to `frontend_dist` volume.

### Phase boundary

- No interactivity yet — bars/slices have title tooltips on hover but
  no click-through to filtered task lists. Easy follow-up: each donut
  slice and each workload row can `nav('/projects')` with a status /
  assignee filter once that filter exists on the task list page.
- Throughput chart's tooltips are HTML `<title>` elements, which means
  they only show on mouse hover. Touch users see the bars but not the
  per-day count. A v2 could wire `pointerdown` + a custom tooltip.
- No weekly / monthly throughput option. The 30-day window is hardcoded
  matching the most-asked "how are we trending lately?" question.

## [1.24.0] — 2026-05-25

Nav redesign: left sidebar + slim top bar + user-menu dropdown.

### Frontend

- New **left sidebar** (`features/nav/LeftSidebar.tsx`): primary nav
  (Dashboard / Projects / Calendar / Reports / Teams / Trash / Admin)
  in a 16rem fixed rail on md+; collapses to a slide-in drawer on
  narrow viewports, toggled by a hamburger in the top bar.
- New **user menu** (`features/nav/UserMenu.tsx`): avatar circle with
  initials + dropdown containing About / Help / Settings / Sign out.
  Replaces the loose grid of fixed-position corner buttons.
- **TopNav slimmed** to: hamburger (mobile) · flex spacer ·
  notifications bell · user menu. ~60 lines, down from 110.
- **NotificationBell unfix**: was `position: fixed` overlay since
  v1.0; now sits in the TopNav flex row with the same dropdown
  behavior and WS feed. Uses the new IconBell SVG.
- **Inline SVG icon set** (`features/nav/icons.tsx`): Lucide-style
  strokes, 14 icons (~150 lines), no new dependency.
- **Active-state refinement**: replaced the full bg-invert pill with
  a subtle tinted bg + accented icon. Much quieter visually.
- Page layout: `<main className="md:pl-64">` in `ProtectedRoute`
  offsets content right of the sidebar. Existing pages keep their
  own `max-w-Xxl mx-auto` centering inside the available space.

### Deleted

- `features/system/AboutButton.tsx` — folded into UserMenu.
- `features/help/HelpButton.tsx` — folded into UserMenu.

### Verified

- Frontend build clean (typecheck + Vite bundle).
- Frontend bundle redeployed to the `frontend_dist` volume.

### Phase boundary

- No avatar image upload — only initials. Can add a `User.avatarUrl`
  column later if you want.
- Sidebar width is fixed at 16rem; no "collapse to icon-only" toggle.
  Drawer behaviour below md handles the cramped-space case.
- The user-menu dropdown closes on outside-click + Escape but anchors
  to `right: 0` in both LTR and RTL. Acceptable since the menu sits
  at the top-right corner in both directions.

## [1.23.0] — 2026-05-25

Per-team custom roles + permission system (RBAC).

### Schema

- New `Role` (id, teamId, name, description, isSystem). Unique on
  `(teamId, name)`. Indexed on `teamId`.
- New `RolePermission` (roleId, permission). Junction table. PK on the
  pair.
- `TeamMembership.roleId` (FK → Role, SET NULL). Coexists with the legacy
  `role` enum for one release as a fallback; v1.24 will drop the enum.
- Migration `20260525000000_rbac`: additive. Backfills two system roles
  (`Manager`, `Member`) per team with the documented default permission
  sets, then sets `TeamMembership.roleId` to whichever system role matches
  each member's legacy enum value. Zero behavioural drift post-upgrade.

### Backend

- New `lib/permissions.ts` — **14 hardcoded permission constants** grouped
  into 5 buckets (Tasks, Comments, Projects, Team, Integrations, Trash).
  Permissions are bound to code paths; the service rejects writes of any
  string outside the constant list.
- New `middleware/requirePermission.ts`. `requirePermission('X')` for
  route gating; `userHasPermission(userId, teamId, globalRole, X)` for
  service-layer gates. Global `ADMIN` always bypasses — lockout-proof
  escape hatch.
- New `services/rolesService.ts` + `routes/roles.ts` mounted at
  `/api/teams/:teamId/roles`:
  - `GET /` — list roles in this team (open to any member; powers the
    role-assignment dropdown).
  - `GET /:roleId` — single role + its permissions.
  - `POST /` — create custom role *(requires `team.manage_roles`)*.
  - `PATCH /:roleId` — update name/description *(same gate)*. System
    role names cannot be changed.
  - `PUT /:roleId/permissions` — replace the permission set (idempotent).
  - `DELETE /:roleId` — delete a custom role. Rejects `isSystem`; rejects
    roles still assigned to memberships (409 with friendly message).
- New `GET /api/system/permissions` — code-bound catalog + UI grouping.
  Auth-less by design (matches the rest of `/system`); powers the matrix.
- **Refactored ~7 service-layer gates** from `if (role === 'MANAGER')`
  to `if (!await userHasPermission(...))`:
  - `tasks.update` technician change → `task.change_technician`
  - `subtasks.update` technician change → `task.change_technician`
  - `projects.update` non-owner edit → `project.edit`
  - `projects.update` set accountable → `project.set_accountable`
  - `projects.remove` non-owner delete → `project.delete`
  - `comments.remove` non-author → `comment.delete_others`
  - `trash.purge` (still gated by the v1.21 InstanceSetting on top) → `trash.purge`
- **3 route-level gates** refactored: invite, remove, change role on
  `/api/teams/:teamId/members/*`. Webhooks routes too.
- `PATCH /api/teams/:teamId/members/:userId` now accepts EITHER the
  legacy `{ role: 'MANAGER' | 'MEMBER' }` body OR the new
  `{ roleId: <Role.id> }`. Both routes update the same membership;
  legacy enum kept for one release for backwards-compat callers.
- Member responses now carry `roleId` + `roleName` joined for the UI.

### Frontend

- New `/settings/roles` page (`pages/settings/RolesPage.tsx`): lists every
  role in the current team, expand-to-edit, permission matrix grouped by
  resource (5 sections, 14 checkboxes total). System roles render with a
  "System" pill and a disabled-name input. Create / save / delete.
- New entry in the Settings sidebar: "Roles & permissions" (visible to
  all team members; mutations gated server-side).
- Team detail page: every member row now has an **inline role dropdown**
  that PATCHes the membership with the chosen `roleId`. Read-only label
  for non-managers.
- i18n: `settings.nav.roles` + `settings.nav.rolesDesc` in EN + FA.

### InstanceSetting interactions (the second-layer policy)

- `tasks.dateEditRestriction` (v1.18) and `trash.emptyAllowedRoles` (v1.21)
  still apply ON TOP of the per-role permission check. A user with
  `task.modify_dates` is **still** gated when the InstanceSetting is set
  to `manager-only` AND their TeamMembership.role enum is `MEMBER`. The
  intent: instance-wide operator policy is a separate (and stronger)
  layer than per-role permissions. Documented in code + the plan doc.

### Tests

- 10 new integration tests in `tests/integration/roles.test.ts`:
  - list / create / unknown-permission rejected / member-403 / system-role
    cannot be deleted / role-with-members cannot be deleted / role-id PATCH /
    legacy+roleId mutex / end-to-end permission gate flip / catalog response.
- Updated `technician.test.ts` to match the new permission-style error
  message.
- Suite: 219/225 passing + 5 skipped (the lone failing file is the
  pre-existing LDAP env-specific test).

### Migration risks + their mitigations

1. **Mis-mapped role**: legacy `role` enum stays as a fallback; service
   reads `roleId` first. Manual recovery: clear `roleId` in DB.
2. **Admin revokes everything from every role**: global `ADMIN` always
   bypasses every permission check. Cannot lock out.
3. **Typo permission in DB**: service-layer write validates against the
   constant list; reads filter out unknowns.

### Phase boundary

- **`labels.manage` was planned but dropped** from the 14 permissions —
  labels are currently open to any team member in the codebase, not
  manager-only as the plan assumed. Adding it as a gated permission
  would be a breaking change in default behaviour. Labels stay open;
  recurrence stays open. If you want to lock them down, that's a small
  follow-up (add the constants + flip the route's preHandler).
- **Team rename / slug / colour edits** stay on the legacy
  `requireTeamRole('MANAGER')` check. They're a small surface (3 fields)
  and didn't warrant a permission constant. They'll move to a permission
  if/when the matrix needs more granular team-meta control.
- **Per-input UI disabled state** based on permissions isn't wired —
  buttons + dropdowns still show; the server returns 403 with a friendly
  message that the existing mutation-error handlers surface inline.

## [1.22.0] — 2026-05-24

In-app self-upgrade (opt-in, privileged sidecar).

### New sidecar

- New `updater/server.js` — ~80-line Node HTTP server. POST `/upgrade`
  spawns a detached `sh -c "git fetch && git pull --ff-only origin main
  && docker compose up -d --build"`; GET `/status` returns last run +
  log tail. Single-token bearer auth (`X-Updater-Token`).
- New `docker/updater.Dockerfile` — node:20-alpine plus the
  `git`, `docker-cli`, and `docker-cli-compose` packages.
- New compose service `updater` under `profiles: ['upgrade']`. Mounts
  `/var/run/docker.sock` and the host repo dir at `/repo`. **No port
  mapping** — reachable only from inside the compose network.

### Backend

- New env vars `UPDATER_URL` (default unset) + `UPDATER_TOKEN`. Both
  blank = self-upgrade disabled; the admin endpoint returns 503.
- New admin-only `POST /api/admin/upgrade` — proxies to the updater
  sidecar with the shared token, 10-second connect timeout. Returns
  202 with `startedAt` on success; 503 with a friendly error when the
  sidecar isn't configured / unreachable / rejecting the token.

### Frontend

- New "Run upgrade now" pill button on the About page, next to the
  v1.16 update-available badge. Visible only when:
  - viewer is global ADMIN
  - the update-check is enabled
  - GitHub returned a strictly newer tag
- On click: confirmation prompt (reminds the operator to back up
  Postgres per UPGRADE.md), POST to admin endpoint, then shows an
  "Upgrading… page will reload when done" badge and polls
  `/api/health` every 5 s. Reloads the SPA the first time health
  answers 200. Hard timeout at 5 minutes.

### Docs

- New `UPGRADE.md § Self-upgrade` — explains what the sidecar is, the
  security model (docker socket = root on the host), how to enable it,
  what the upgrade command actually runs, and what to do when it fails.
  Explicit "do not enable in production unless you've thought through
  the threat model" callout.
- `.env.example` (both root + backend) carry the new env vars,
  disabled by default with a comment pointing at UPGRADE.md.
- `docker-compose.yml` pipes `UPDATER_URL` + `UPDATER_TOKEN` to the
  backend.

### Verified

- Backend + frontend typecheck clean.
- Endpoint not smoke-tested live (would require setting up the
  sidecar against the running stack which the user can do); contract
  is exercised by typechecking + the read of the admin route schema.

### Phase boundary — caveats

- **Self-upgrade is the highest-risk surface in this codebase.** A
  compromised backend can reach the updater can take over the docker
  daemon can run anything on the host. Mitigation: opt-in profile,
  bearer token, no port mapping. The manual upgrade path (`git
  checkout && docker compose up -d --build`) remains the documented
  default in UPGRADE.md.
- The updater pulls `origin/main` — not a specific tag. If you want
  a specific version, `git checkout vX.Y.Z` on the host first.
- No rollback button. A failed upgrade requires SSH access and a
  `git checkout v1.PREVIOUS && docker compose up -d --build`.
- The updater container itself is not self-upgrading. After a future
  release that touches `updater/server.js` or
  `docker/updater.Dockerfile`, you'll need `docker compose --profile
  upgrade up -d --build updater` to roll the sidecar forward.

## [1.21.0] — 2026-05-24

Trash: soft-delete for Tasks + Comments, restore, admin-gated purge.

### Schema

- `Task.deletedAt` + `Task.deletedById` (FK → User SET NULL).
  Index `(teamId, deletedAt)`.
- `Comment.deletedAt` + `Comment.deletedById` (same shape).
  Index `(taskId, deletedAt)`.
- Migration `20260524150000_trash`, additive — existing rows get
  `deletedAt = NULL` (live).

### Backend

- `tasksService.remove` + `commentsService.remove` now SOFT-delete:
  stamp `deletedAt = now()` + `deletedById = actorId`. The row
  survives. Every read path (`list`, `get`) filters `deletedAt IS NULL`,
  so existing API behaviour is identical from the caller's point of
  view: DELETE then GET returns 404, as before.
- New `services/trashService.ts` + `routes/trash.ts` mounted at
  `/api/teams/:teamId/trash`:
  - `GET /` — list deleted tasks + comments scoped to the team,
    newest first, with `deletedByName` joined for the UI
  - `POST /tasks/:id/restore` + `POST /comments/:id/restore` — any
    team member can undo
  - `DELETE /tasks/:id` + `DELETE /comments/:id` — hard delete
    (purge); role-gated
  - `POST /empty` — bulk hard-delete every soft-deleted row in the
    team's trash; same role gate; returns
    `{ tasksPurged, commentsPurged }` counts
- New InstanceSetting key `trash.emptyAllowedRoles`
  (`"admin"` default · `"admin-and-manager"`). Default = global
  ADMINs only can purge or empty. The setting echoes back in the
  trash list response so the SPA greys out unavailable buttons
  without trial-and-error.

### Frontend

- New `/trash` route + `pages/TrashPage.tsx`:
  - Two sections: Tasks and Comments, with relative-time deletion
    timestamps + the user who deleted each item
  - Restore button on every row (any team member)
  - "Delete forever" + "Empty trash" buttons greyed out when the
    viewer's role doesn't satisfy `emptyAllowedRoles`
  - Confirmation prompts on permanent delete
- Trash link in the TopNav after Teams.

### Tests

- 5 new trash integration tests: soft-delete-then-list filter,
  any-member restore, MEMBER purge forbidden (403), ADMIN purge +
  empty with counts, MANAGER-can-purge when setting is widened.
- Existing 22 task + comment tests still pass (soft-delete is
  invisible to the existing 404-on-delete expectations).

### Verified

- Backend typecheck clean; frontend build clean.

### Phase boundary

- **Projects, subtasks, attachments, labels keep hard-delete in this
  release.** Soft-deleting a project would require breaking the
  current Prisma cascade-delete (which would otherwise drag every
  child task with it) — a much bigger surgery. Same for the
  remaining entity types. The trash UI shows only what's in scope.
- No retention policy yet. Trash grows until someone empties it.
  A scheduler-driven auto-purge (e.g. "anything older than 30 days
  is permanently deleted") is the obvious next iteration.
- No per-row "deleted by" reason / undo notification — restore is
  silent.

## [1.20.0] — 2026-05-24

Kanban view-mode toggle: "by Status" / "by Technician".

### Frontend

- `pages/TasksPage.tsx` gains a small pill-toggle in the header:
  - **by Status** — the existing kanban (TODO / IN_PROGRESS / REVIEW / DONE
    columns, drag-and-drop, status changes).
  - **by Technician** — read-only swimlanes, one column per Technician
    (alphabetical, "(unassigned)" pinned last), each card showing
    title + status + priority. Click a card to open the task detail page.
- Choice persists in `localStorage` (`kanban.viewMode`).
- Drag-and-drop is intentionally **disabled** in the Technician view —
  dropping a card onto another swimlane would be a Technician reassignment,
  which is role-gated (v1.19) and would silently fail for members. The
  UX is "switch view → open task → reassign there".

### Verified

- Frontend build clean (730 KB bundle, 226 KB gzipped — +3 KB from v1.19
  for the new view + toggle).

### Phase boundary

- No drag-to-reassign-technician in the new view (by design — see above).
  A manager-only DnD swimlane reorder is the obvious upgrade if you want
  to drag cards between technicians.
- Columns aren't team-scoped — they're project-scoped (the same scope as
  the existing kanban). A team-wide "everyone's tasks across every project,
  grouped by Technician" view would live on the Calendar / Reports surface,
  not here.

## [1.19.0] — 2026-05-24

Assigned Technician field on Task + Subtask.

### Schema

- `Task.technicianId` + `Subtask.technicianId` (both nullable, FK → User,
  ON DELETE SET NULL). Matching indexes `Task(teamId, technicianId)` and
  `Subtask(technicianId)`.
- Migration `20260524140000_technician`: additive columns + FKs + a
  backfill that sets `Task.technicianId = creatorId` and `Subtask.
  technicianId = parentTask.technicianId` for existing rows. Existing
  data is preserved.

### Backend

- `tasksService.create` / `subtasksService.create` default
  `technicianId = creatorId` so the person who clicked "New task" is on
  the hook by default.
- `tasksService.update` / `subtasksService.update` now take
  `(actorTeamRole, actorGlobalRole)` and gate technician changes:
  - Members → 403 with friendly message
  - Team MANAGERS + global ADMINS → allowed
  - Target must be a member of the same team (400 otherwise) when not
    clearing to null
- Both controllers thread the resolved membership through; same pattern
  as the v1.18 date-edit gate.
- Read paths join `User.name` so `technicianName` is on the wire in
  every list/get response — no second round-trip.

### Frontend

- `Task` + `TaskSubtask` types extended with `technicianId` +
  `technicianName`.
- TaskDetailPage: "Technician: \<name\>" badge in the metadata row,
  always visible. Reassignment dropdown beneath the title — gated to
  managers/admins (team members feed pre-fetched via `getTeam`).
- `updateSubtask` API takes optional `technicianId` for future subtask
  UI surfacing.

### Tests

- 6 new integration tests + 7 existing subtask + 14 existing task =
  27/27 in the relevant files.

### Verified

- Backend + frontend typecheck clean.

### Phase boundary

- Subtask Technician change UI not surfaced yet — backend supports it,
  needs a UI in `SubtaskList`. Small follow-up.
- Reports don't yet pivot by Technician (Kanban-by-Technician lands in
  v1.20.0 and that's the natural surface; a Reports breakdown can
  follow if you want one).

## [1.18.0] — 2026-05-24

Admin-controlled task-date editing restriction.

### Backend

- New InstanceSetting key `tasks.dateEditRestriction` (`"open"` |
  `"manager-only"`). Default is unset → behaves as `"open"`, preserving
  pre-v1.18 behaviour.
- `tasksService.update()` now takes `actorTeamRole` + `actorGlobalRole`
  and consults the setting. When `manager-only` AND the caller is a
  team MEMBER (not a MANAGER, not a global ADMIN):
  - ADDING a date to a task where the field was null → allowed
  - MODIFYING an existing non-null date → 403
  - CLEARING an existing non-null date → 403
  Applies independently to `dueDate`, `plannedDate`, and `completedAt`.
- `tasksController.update` reads the resolved team membership from the
  request context (already stashed by `requireTeamRole`) and threads
  both roles through.
- `/api/system/info` now exposes `dateEditRestriction` so the SPA
  knows the active rule without an auth round-trip (the
  /settings endpoints are admin-only).

### Frontend

- New admin-only "Task dates — who can change them?" section in
  Settings → Preferences. Two radios (Open / Manager-only); PUT to
  `/settings/instance/tasks.dateEditRestriction` and invalidates the
  cached `system/info` so other components pick up the change without
  a hard reload.
- `SystemInfo` type extended with the new field.
- 403 from the date-edit gate flows through the existing TaskDetail
  mutation-error handler — the user sees the friendly
  "dueDate can only be changed by team managers or admins" message
  inline. No per-input disabled state added in this release; that's a
  small follow-up if you want it.

### Tests

- 8 new integration tests covering: default open behaviour,
  manager-only add-allowed, manager-only modify-forbidden,
  manager-only clear-forbidden, ADMIN bypass, non-date PATCH still
  works for members, and the public system/info exposure of the
  setting. 22/22 in the relevant files (14 existing task tests +
  8 new) pass.

### Verified

- Backend typecheck clean; frontend build clean.

### Phase boundary

- Per-input disabled state on the date pickers isn't wired this
  release — the server-side rule is the source of truth and the 403
  surfaces as a toast. If you want the inputs greyed out before the
  attempt, surface specific pages and I'll do a small follow-up.

## [1.17.0] — 2026-05-24

Project Accountable field · dark-theme sweep · upgrade-safety doc.

### Schema

- `Project.accountableId` (nullable, FK → User, ON DELETE SET NULL) +
  matching index. Migration `20260524130000_project_accountable`,
  additive — existing rows get `accountableId = NULL`.

### Backend

- `services/projectsService.ts` — accept `accountableId` on create + update;
  validate the chosen user is a member of the same team (returns 400
  otherwise). All read shapes (`list`, `get`, `update`) eagerly join
  `accountable.name` so the wire response carries `accountableName`
  alongside the id and the UI doesn't need a second round-trip.
- Zod schemas (`createProjectBody`, `updateProjectBody`, `projectResponse`)
  extended with the new optional field. PATCH with `accountableId: null`
  clears the field; omitting it leaves the value as-is.
- 5 new integration tests covering create-with-accountable, create-with-
  non-member-400, list joins, PATCH-clears, and backwards-compat create.

### Frontend

- `pages/ProjectsPage.tsx` — Accountable dropdown in the create-project
  form, and an inline per-project selector in the list (visible to
  owners + managers, same gate as Delete). Read-only label "Accountable:
  Tech Name" for everyone else. Re-uses `getTeam(teamId)` for the member
  list, cached 30 s by React Query.
- **Dark-mode sweep.** New safety-net stylesheet in `index.css` that maps
  unthemed `bg-white` / `text-slate-N` / `border-slate-N` / inputs to
  dark-friendly values inside `.dark`, using `:where(:not([class*="dark:..."]))`
  selectors so any component that already opted into a different dark
  colour wins. Caught the entire "deep-page polish" deferral from v1.13:
  ProjectsPage, TasksPage, TaskDetailPage, TeamsPage, AdminPage,
  ReportsPage, CalendarPage, RegisterPage now render correctly in dark
  mode without per-file edits. ProjectsPage and RegisterPage also got
  explicit per-element dark variants where the safety net wasn't enough
  (form inputs, action buttons).

### Docs

- New [UPGRADE.md](UPGRADE.md) — formalises the data-safety guarantees
  the project has always followed: persistent state in named volumes,
  additive-only migrations, only `docker compose down -v` is destructive.
  Covers the standard upgrade flow, what survives each compose command,
  before/after checklists, rollback, multi-release jumps, and the three
  commands that DO delete data so they don't surprise anyone.
- README points at UPGRADE.md alongside INSTALL.md. INSTALL.md's
  "Upgrading" section now references UPGRADE.md for the full version.

### Verified

- Backend typecheck clean · frontend build clean · 15 project tests pass
  (10 existing + 5 new).
- Live admin probe: `GET /api/teams/:teamId/projects` returns
  `accountableId` + `accountableName` fields (null on legacy rows from
  the seed, as designed).
- Docker stack redeployed: backend + frontend rebuilt and serving the
  new code.

### Phase boundary

- Accountable is currently visible only on the Projects page. Showing it
  on TaskDetailPage / TasksPage as breadcrumb context is the obvious
  next iteration.
- Dark-mode safety net is conservative — it only overrides classes when
  no `dark:` variant exists for that property. A few rare components may
  still have low-contrast text where a `dark:text-X` was set but to the
  wrong shade; surface any specific page and I'll do a per-element pass.

## Unreleased

### Tooling

- New interactive installers at the repo root: `install.sh` (Linux / macOS /
  WSL) and `install.ps1` (Windows PowerShell). Each prompts only for things
  that need a human decision (site host, ACME email, admin email + password)
  and auto-generates the rest (JWT secrets, MASTER_KEY, Postgres password).
  Writes `.env`, brings the stack up, waits for backend health, then seeds
  with the chosen admin credentials. Optional integrations (SMTP, LDAP,
  schedulers) are left as "off" defaults — flip in `.env` later.

### Backend

- `prisma/seed.ts` now reads `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` env
  vars and falls back to the legacy `admin@taskhub.local` / `admin` defaults
  when unset. The installers use this hook to land an operator-chosen admin
  on first seed.

### Docs

- New [INSTALL.md](INSTALL.md) — full deployment walkthrough: prerequisites,
  compose + local-dev paths, full env catalog (v1.0 → v1.15), HTTPS with
  Caddy, optional integrations (SMTP / LDAP / SCIM / webhooks / API tokens
  / recurrence), background schedulers, verification probes, common ops,
  upgrade flow, troubleshooting. Now leads with the installer for the
  easy path.
- README quick-start updated to call out the post-`up` seed step and link
  to INSTALL.md. Stale `admin@example.com` / `ChangeMe123!` reference
  corrected to the current `admin@taskhub.local` / `admin` seed.

## [1.15.0] — 2026-05-24

Persistent top navigation bar.

### Frontend

- New `features/nav/TopNav.tsx` — sticky bar at the top of every signed-in
  page. Brand link → Dashboard, primary destinations (Dashboard / Projects /
  Calendar / Reports / Teams), Admin link gated on `globalRole === 'ADMIN'`,
  Settings + Sign out on the right. `<NavLink>` drives the active-pill state.
  Right-padding (`pr-32`) keeps clear of the three fixed corner buttons
  (About / Help / Notifications).
- `ProtectedRoute` mounts the `TopNav` once so every authenticated route
  picks it up automatically — no per-page boilerplate.
- Per-page H1 rows trimmed across Dashboard, Reports, Calendar, Tasks,
  Projects, Teams, Admin, Help, About, TaskDetail, Settings. Page-specific
  controls (the new-task form, calendar view tabs, report window filters,
  CSV export buttons, sub-page sub-nav in Settings) are unchanged — only
  the redundant title row + "Back to dashboard" link disappear.
- `Settings` link in the nav resolves to whatever Settings sub-page the
  user is currently on (preserves deep-link state), or `/settings/preferences`
  by default.

### Verified

- `npm run build` clean (typecheck + Vite production bundle).
- `docker compose up --build frontend-build` redeployed the bundle to the
  served `frontend_dist` volume; Caddy serves the new `index-tDGej8h1.js`
  on the next request, no reload required.

### Phase boundary

- Nav is fully horizontal — no mobile hamburger collapse. Below ~640 px
  the links will horizontally scroll inside their flex container; legible
  but not ideal. A hamburger menu for narrow viewports is the obvious
  next iteration.
- No user avatar / account menu yet; Sign out is a bare text button.

## [1.14.0] — 2026-05-24

SMTP email delivery and CSV exports for reports.

### Backend

- New `lib/mailer.ts` — singleton `nodemailer` transport, lazy + dependency-injected
  from `env.SMTP_*`. `isEnabled()` is false when `SMTP_HOST` is unset; every
  `sendMail` is then a no-op. The mailer never throws into the request path —
  failures surface via `{ accepted: false }`.
- New `services/emailService.ts` composes verification, password-reset and
  TASK_DUE messages. Plain-text + HTML bodies, links built from `PUBLIC_APP_URL`
  with a CORS-origin fallback. HTML output escapes user-supplied fields.
- `authService.requestPasswordReset` + `createVerificationToken` now call the
  mailer best-effort. Non-prod responses still surface `devResetToken` /
  `devVerifyToken` so dev/test flows don't need a real SMTP server.
- `scheduler/dueDateScheduler` fans out a `sendTaskDue` email to the assignee +
  creator after the in-app notification commits. Email failure cannot suppress
  the bell.
- New `lib/csv.ts` — RFC 4180 serializer with BOM prefix, CRLF rows, and a
  CSV-injection neutraliser that prefixes `=+-@` with `'` so Excel/Sheets
  treat them as literal text. Dates auto-format to ISO-8601.
- Four new endpoints — `GET /api/teams/:teamId/reports/{done,workload,overdue,timeliness}.csv`.
  Reuse the existing service methods, return `text/csv; charset=utf-8` with
  `Content-Disposition: attachment; filename="<name>-<YYYY-MM-DD>.csv"` and
  `Cache-Control: no-store`.

### Frontend

- `features/reports/api.ts` adds `downloadReportCsv(...)` — fetches the CSV
  as a blob (because Bearer auth is required), parses the filename out of
  `Content-Disposition`, and triggers a download via a temporary object URL.
- `pages/ReportsPage.tsx` adds an "Export CSV" pill button in each section
  (Tasks completed, Timeliness, Workload, Overdue).

### Env / ops

- New env vars: `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURE`
  (default false → STARTTLS), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`,
  `PUBLIC_APP_URL`. Documented in both `.env.example` files and wired into
  `docker-compose.yml`. Leaving `SMTP_HOST` blank disables outbound mail
  entirely — same shape every release has had.

### Tests

- 13 new tests added (165 → 178 total). 5× CSV serializer corner cases
  (BOM, CRLF, quoting, dates, CSV-injection prefix). 3× mailer no-op
  behaviour + `publicAppUrl()` fallback. 5× CSV-endpoint integration:
  headers, column order, `(unassigned)` rendering, days-overdue, auth.
- Fixed a pre-existing stale assertion in `preferences.test.ts` (expected
  `{ calendar }`, the v1.13 PATCH returns the full triple).

### Verified

- Suite: 173/178 passing + 5 skipped (the lone failing file is the LDAP
  integration test, which connects to `localhost:1389` and is environment-
  specific to host networking, unchanged by this work).
- Backend typecheck clean. Frontend build clean.

### Phase boundary

- Verification + password-reset links assume the frontend exposes
  `/verify-email?token=` and `/reset-password?token=` routes. The link
  builder is in `services/emailService.ts` — if those routes ever rename,
  update there.
- Templates are not localised yet — emails always render in English
  regardless of `user.languagePreference`. The composer is the obvious
  branching point when this comes up.
- No retry / dead-letter queue for failed sends. A best-effort dispatch
  fits the current single-instance footprint; a multi-instance deploy
  should swap nodemailer for a queue-backed sender or move outbound mail
  to a side process.

## [1.13.0] — 2026-05-24

Dark theme + Persian UI + RTL. Two new per-user preferences (`theme`,
`language`) plus updated user manuals.

### Schema

- New enums `ThemePreference` (`LIGHT` / `DARK`) + `LanguagePreference`
  (`EN` / `FA`).
- `User.themePreference` + `User.languagePreference` columns, `LIGHT` +
  `EN` defaults — pre-v1.13 users see no surprise.
- Migration `20260524120000_user_theme_language`, additive.

### Backend

- `userResponse` Zod carries `themePreference` + `languagePreference`;
  `IssuedSession.user` + `issueSession` updated to surface both.
- `PATCH /api/auth/me/preferences` now accepts `{ theme?, language? }`
  alongside `calendar?`. Response is the full triple so the frontend
  mirrors everything to localStorage in one call.

### Frontend

- [lib/theme.ts](frontend/src/lib/theme.ts) — module-level active theme
  from localStorage; `setTheme` toggles `<html class="dark">`.
- [lib/i18n.ts](frontend/src/lib/i18n.ts) + EN/FA catalogues in
  `frontend/src/i18n/{en,fa}.json` — `useT()` hook, sets `<html lang dir>`,
  EN fallback per key so adding a new English string never breaks FA.
- `tailwind.config.ts` switches to `darkMode: 'class'`. `index.html`
  pre-React script reads cached theme + language and applies them to
  `<html>` before first paint — no FOUC on dark or Persian accounts.
- AuthContext `adoptUserPrefs(user)` syncs calendar + theme + language
  at every signed-in entry (initial refresh, signIn, signInWith2fa, signUp).
- **Preferences page rewritten** — calendar + theme + language radios +
  the admin-only Workweek section from v1.11.
- `dark:` variants on the highest-traffic surfaces (Dashboard, Settings
  layout, Login, corner buttons, Preferences). Body's base
  `dark:bg-slate-900 dark:text-slate-100` covers the rest by default.

### User manuals

- [USER_MANUAL.md](USER_MANUAL.md) updated for v1.11–v1.13 surface
  (corner buttons, team colours, calendar views, workweek admin
  setting, unified Display preferences section).
- New [USER_MANUAL.fa.md](USER_MANUAL.fa.md) — full Persian translation.
- `scripts/copy-manual.mjs` syncs both files into `frontend/public/` at
  every build. `docker/frontend.Dockerfile` COPIes both into the build
  context.
- `/help` HelpPage fetches the manual matching the active language with
  EN fallback if the FA file is missing.

### Verified

- Live: PATCH `{ theme: 'DARK', language: 'FA' }` → fresh login persists
  → reset. Both manuals served (`/USER_MANUAL.md` 23 KB, `/USER_MANUAL.fa.md`
  33 KB).
- Frontend + backend build clean.

### Phase boundary

- i18n coverage = high-traffic surfaces only. Kanban / task detail /
  reports / audit log / directories / webhooks / recurrence / calendar
  still render in English under FA. Untranslated strings fall back to EN
  explicitly (not blanks) so the UI stays usable.
- Dark variants applied to "most-visible" components. Deep-page polish
  (nested modals, secondary forms) may still show light fragments; each
  is a per-file follow-up.

## [1.12.0] — 2026-05-24

Team colours + cross-project Calendar views page. The Calendar page reads
every task in the current team across every project, lays them on a date
grid (work-week / week / month), paints each task pill with its team's
accent colour, and tints admin-configured off-days red.

### Schema

- `Team.color: String?` — hex like `#3b82f6`; null = default slate.
  Migration `20260524100000_team_color`, additive.

### Backend

- Team routes accept + return `color` (validated as `^#[0-9a-fA-F]{6}$`).
  Service layer + Zod schemas updated.
- Default seed team gets `#3b82f6` so fresh installs show colour immediately.
- New `GET /api/teams/:teamId/calendar?since=ISO&until=ISO&field=due|planned`
  returning every task whose chosen date sits in the window, with the
  joined `projectName` + `teamName` + `teamColor` attached.

### Frontend

- **Teams page** — manager-only colour picker on each team detail: 8
  presets + a native `<input type="color">` + a Clear button. Saving
  invalidates `teams.detail` + the team list cache so every consumer
  picks up the new colour without a refresh.
- **Kanban cards** ([TasksPage](frontend/src/pages/TasksPage.tsx)) — left
  border now uses the active team's colour. Falls back to slate.
- **Bug fix** carried over: the `/about` route from v1.11.0 was wired to
  AboutButton but missing from the router. Now registered.
- **New Calendar page** ([CalendarPage.tsx](frontend/src/pages/CalendarPage.tsx))
  at `/calendar`. Linked from the Dashboard.
  - Three view modes:
    - **Work-week** — 5 cells starting on the first non-off-day. With
      Sat+Sun off the cursor lands on Monday; with Thu+Fri off it lands
      on Saturday. Pure off-day-driven, no separate config.
    - **Week** — 7 cells, Sun-leading.
    - **Month** — 6-week grid (42 cells), days outside the current
      month dimmed.
  - Off-days painted red (header label + cell background tint).
  - Tasks render as coloured pills inside each day cell; click → task
    detail. Pill colour = team accent. Cells show up to 8 tasks in
    week / work-week modes, 3 + "+N more" in month mode.
  - Toolbar: view tabs, previous / today / next nav, month label,
    and a "Date field" dropdown to switch between `dueDate` (default)
    and `plannedDate` bucketing.

### Verified

- Live: PATCH team colour → calendar feed returns it on every item →
  picker tints kanban cards.
- Frontend + backend build clean.

### Phase boundary

- Calendar is read-only — no drag-and-drop reschedule yet (a follow-up
  would PATCH the task's `dueDate` from the source cell to the drop cell).
- Work-week mode shows the 5 cells starting from the cursor's first
  workday. A "previous / next" click jumps by 7 calendar days; the
  cursor then re-aligns to the next workday on render. This is the
  obvious behaviour; users wanting strict "work-week N → work-week N+1"
  iteration can simply click next twice on a Friday.

## [1.11.1] — 2026-05-24

Workweek presets. The v1.11.0 admin Workweek section is now driven by two
one-click presets (the two conventions admins actually use); the 7-checkbox
custom picker stays available as a `<details>` "Or pick custom days"
disclosure.

- **Saturday + Sunday off** — Western workweek (sets `calendar.weekend =
  [0, 6]`).
- **Thursday + Friday off** — Iranian / Gulf workweek (sets `[4, 5]`).
- Active preset highlights so the current choice is unambiguous.
- Custom subsets (Fri-only, M/W/F three-day weekends, …) still possible
  via the disclosed checkboxes.

No schema change, no backend change — pure UI polish on top of the
v1.11.0 InstanceSetting key/JSON store.

## [1.11.0] — 2026-05-24

Three small polish items: in-app user manual, About page, and an
admin-configurable workweek that paints off-days red in every date
picker.

### User manual + Help button

- Existing repo-root [USER_MANUAL.md](USER_MANUAL.md) now ships inside
  the SPA. The frontend build syncs it via
  [scripts/copy-manual.mjs](frontend/scripts/copy-manual.mjs) before
  `vite build` / `vite dev` so a single edit at the repo root reaches
  both GitHub readers and the in-app `/help` route.
- New 📖 button in the top-right (next to the notification bell). Click
  → `/help`. The page fetches the markdown and renders it via
  `react-markdown` + `remark-gfm` (tables, autolinks, checklists).
- The Docker frontend-build context moved from `./frontend` to the repo
  root (with a new `.dockerignore`) so the prebuild script can see the
  manual.

### About button + page

- New ℹ️ button next to the help button. Click → `/about`.
- New public-ish `GET /api/system/info` endpoint returning app name +
  version + build time + env + the off-day set + headline counts. Used
  by the About page; cached via React Query so the corner buttons cost
  one request per session.
- Version comes from `TASKHUB_VERSION` env (defaults to `dev`), build
  time from `TASKHUB_BUILD_TIME` — set these in the deploy pipeline.

### Admin-configurable off-days (workweek)

- New "Workweek (admin · instance-wide)" section on Settings →
  Preferences, visible only to GlobalRole=ADMIN.
- Seven weekday checkboxes (Sun..Sat). Save → PUT to the existing
  `/api/settings/instance/calendar.weekend` endpoint (Phase 1 key/JSON
  store) with `value: number[]` (JS `getUTCDay` convention, 0=Sun..6=Sat).
- Default `[0, 6]` (Sat + Sun) when unset.
- `/system/info` sanitises on read — non-integers and out-of-range values
  drop out, the result is de-duped and sorted for stable wire output.
- Frontend `lib/calendar.ts` caches the active set in localStorage,
  `adoptServerWeekend` syncs from `/system/info` at app boot, and
  `isWeekend(date)` is the single source of truth used by the picker.
- [ShamsiDatePicker](frontend/src/lib/ShamsiDatePicker.tsx) uses the
  library's `mapDays` callback to paint every configured off-day red.
  Works under both Shamsi and Gregorian.

### Verified

- Frontend + backend build clean.
- Live: `GET /system/info` → default `[0, 6]` → admin PUT `[4, 5]` →
  `GET /system/info` reflects → reset to `[0, 6]`. End-to-end.
- Help button loads the manual; About button shows version + counts +
  off-day names.

### Notes for ops

- Set `TASKHUB_VERSION` + `TASKHUB_BUILD_TIME` in your `.env` (or
  CI/CD) to surface real values on the About page. Without them the
  page shows `dev` + `—`.

## [1.10.0] — 2026-05-24

Per-user Gregorian / Shamsi calendar preference. TaskHub was Persian-leaning
by default; v1.10 lets each user pick the calendar that shows up in their
formatters, kanban cards, reports, audit log, comments, and date pickers.

### Schema

- New `CalendarPreference` enum (`SHAMSI` / `GREGORIAN`).
- `User.calendarPreference` column with `SHAMSI` default — matches pre-v1.10
  behaviour for every existing user.
- Migration `20260524000000_add_calendar_preference` — additive only.

### Backend

- `userResponse` (the shape returned by /auth/login + refresh + register +
  2FA-login) gains `calendarPreference`.
- New `PATCH /api/auth/me/preferences` endpoint. Body: `{ calendar?:
  'SHAMSI' | 'GREGORIAN' }`. PATCH semantics — omitted fields stay
  unchanged. Response: `{ calendar }`.

### Frontend

- New [lib/calendar.ts](frontend/src/lib/calendar.ts) — module-level active
  calendar seeded from `localStorage('taskhub.calendar')`. `setCalendar`
  writes through; `adoptServerCalendar` syncs from the user response after
  every login / refresh.
- [lib/shamsi.ts](frontend/src/lib/shamsi.ts) formatters now branch
  internally — SHAMSI renders Persian digits + Jalali calendar; GREGORIAN
  delegates to native Intl + Date (`May 22, 2026`, `2026-05-22 19:00`).
  Relative-time helper flips locale (`fa-IR` ↔ `en-US`) on the same flag.
- [ShamsiDatePicker](frontend/src/lib/ShamsiDatePicker.tsx) picks the
  right calendar + locale at render. UTC-midnight emission unchanged so
  a Persian-preferring user and an English-preferring user picking the
  same day produce the same underlying ISO string.
- New [Settings → Preferences](frontend/src/pages/settings/PreferencesPage.tsx)
  sub-page with the toggle. Save → mirror to localStorage →
  `window.location.reload()` so every mounted formatter + picker picks
  up the new calendar cleanly.
- Sidebar gets "Preferences" as the first item, visible to all roles.
- `AuthContext` mirrors `user.calendarPreference` into localStorage on
  refresh / login / register / 2FA-login.

### Tests

- New [preferences.test.ts](backend/tests/integration/preferences.test.ts)
  — 4 cases (default SHAMSI, PATCH persists across fresh login, unknown
  enum 400, no-op PATCH non-destructive). Suite: **165/165** (was 161).

### Verified

- Live smoke: PATCH SHAMSI → GREGORIAN → fresh login confirms persistence
  → PATCH back to SHAMSI.

### Notes for users

- Toggle at **Settings → Preferences**. Saving reloads the page so every
  date everywhere flips immediately.
- Storage is unchanged — calendar dates remain UTC midnight ISO strings.
  Two users viewing the same task see the same DAY, formatted in each
  one's chosen calendar.

## [1.9.1] — 2026-05-24

QUARTERLY recurrence frequency. Mathematically equivalent to MONTHLY
with `interval=3` but a first-class enum value so the UI shows
"Quarterly" instead of asking admins to interpret "every 3 months".

- `RecurrenceFrequency` enum gains `QUARTERLY` (ordered between MONTHLY
  and YEARLY). Migration `20260523220000_recurrence_quarterly` —
  `ALTER TYPE ... ADD VALUE 'QUARTERLY' BEFORE 'YEARLY'`. Additive,
  zero-downtime on Postgres 12+.
- [lib/recurrence.ts](backend/src/lib/recurrence.ts) `nextOccurrenceAfter`
  handles QUARTERLY as `addMonths(current, step * 3)`, so `interval=2`
  becomes "every 2 quarters" (6 months) as expected.
- Zod schema + frontend type + dropdown + summary humaniser all updated.
- One new integration test: QUARTERLY tick on Jan 1 → next run = Apr 1
  → next tick → next run = Jul 1. Suite: **161/161** (was 160 → +1).
- Live smoke verified end-to-end: rule starting Jan 1 2026, anchored to
  today (May 24), first tick spawned + advanced `nextRunAt` to Aug 24.

## [1.9.0] — 2026-05-23

Phase 4 — Recurring tasks. A task can now carry a recurrence rule; the
scheduler materialises a fresh copy of it on each occurrence. Spawned
tasks link back to the source via `spawnedFromTemplateId` for traceability,
and a unique `(templateId, period)` key prevents a retried tick from
double-spawning the same period.

### Schema

- New `TaskTemplate` model (one per task via unique `sourceTaskId`):
  `frequency` enum (DAILY/WEEKLY/MONTHLY/YEARLY), `interval`, `byWeekday`
  (int[], for WEEKLY), `startsOn`, optional `endsOn`, optional
  `maxCount`, optional `dueOffsetDays` / `plannedOffsetDays`, `nextRunAt`,
  `spawnedCount`, `active`.
- `Task.spawnedFromTemplateId` (nullable FK, `SetNull` on template
  delete) + `Task.spawnedForPeriod` (e.g. `"2026-05-23"`). Unique
  `(spawnedFromTemplateId, spawnedForPeriod)` is the idempotency key —
  the spawn transaction relies on the constraint to reject a duplicate
  insert from a concurrent tick.
- Migration `20260523200000_add_task_template` — additive only.

### Backend

- New [lib/recurrence.ts](backend/src/lib/recurrence.ts) — UTC-midnight
  date math (`utcMidnight`, `addDays`, `addMonths`, `addYears`,
  `nextOccurrenceAfter`, `firstOccurrenceOnOrAfter`). Calendar dates
  stay UTC-midnight per the v1.1.3 three-picker rules. Subset of RRULE:
  frequency + interval + (for WEEKLY) byWeekday.
- New [TaskTemplatesService](backend/src/services/taskTemplatesService.ts):
  - `upsert` re-computes `nextRunAt` from `max(startsOn, today)` on every
    save so a paused-then-resumed rule doesn't replay missed periods.
  - `spawnDue(now)`:
    1. Finds active templates with `nextRunAt <= now`.
    2. Per template, checks the cap (`maxCount`) and the cutoff
       (`endsOn` — applied to the spawn PERIOD, not to `now`, so a
       tick that runs late still owes the rule its in-window periods).
    3. In one transaction: inserts the spawned `Task` (copying title /
       description / priority / assigneeId, fresh labels + subtasks,
       NEVER `completedAt` or `status`), then advances `nextRunAt` and
       increments `spawnedCount`.
    4. Catches `P2002` (duplicate `spawnedForPeriod` key) and advances
       past the period anyway, so a concurrent tick can't loop forever.
- New [recurrenceScheduler](backend/src/scheduler/recurrenceScheduler.ts)
  — opt-in via `RECURRENCE_ENABLED=true`, mirrors the other two background
  loops. Default off so tests don't materialise tasks unexpectedly.
- Endpoints under `/api/teams/:teamId/projects/:projectId/tasks/:taskId/recurrence`
  (any team MEMBER+):
  - `GET /` — returns the rule, or 204.
  - `PUT /` — create or replace.
  - `DELETE /` — remove (already-spawned tasks survive via SetNull).
  - `POST /tick` — manual scheduler kick for ops + tests.

### Frontend

- New [RecurrenceSection](frontend/src/features/recurrence/RecurrenceSection.tsx)
  rendered on the Task detail page between Attachments and Dates. When
  no rule exists: a single "Set up recurrence" button. When one exists:
  a human-readable summary ("Every 2 weeks on Mon, Wed · next run … ·
  spawned N of M") plus Edit / Remove. Form uses `ShamsiDatePicker` for
  `startsOn` / `endsOn` so calendar dates stay UTC-midnight; checkbox
  weekday picker appears only when `frequency=WEEKLY`.

### Tests

- New [tests/integration/recurrence.test.ts](backend/tests/integration/recurrence.test.ts)
  — 8 cases:
  - PUT then GET round-trip; 204 when no rule.
  - DELETE removes template but keeps spawned tasks (FK SetNull verified).
  - `spawnDue` spawns once per period; re-tick before `nextRunAt` no-ops.
  - Spawned task copies labels + subtasks (with `done=false`); never copies
    `completedAt`; applies due/planned offsets.
  - WEEKLY byWeekday advances to the next matching weekday after each spawn.
  - `maxCount` cap deactivates the template after the Nth spawn.
  - `endsOn` cutoff applied to the period: late ticks still settle in-window
    spawns, but skip after-cutoff periods.
- Suite: **160/160** (was 152 → +8 recurrence).

### Verified

- Live smoke against the running stack: PUT a daily rule on an existing
  task (startsOn=−2 days) → `POST /tick` spawns 1 row for today's period
  with `spawnedFromTemplateId` set + `spawnedForPeriod=2026-05-23` →
  second `/tick` returns `spawned: 0` (nextRunAt already advanced past
  now) → DELETE returns 204 and the spawned task survives.

### Phase 4 boundary

- Single-instance scheduling. Multi-instance deploys must enable
  `RECURRENCE_ENABLED=true` on exactly one node (the unique constraint
  protects correctness, but each N-th instance would generate N-1
  wasted insert-and-rollback round-trips per period).
- RRULE subset only — no `BYMONTHDAY`, no `BYSETPOS`, no `COUNT/UNTIL`
  combinations beyond what `maxCount` + `endsOn` cover. The schema can
  grow into these without an API rename.
- The scheduler default interval is 60 minutes (`RECURRENCE_CHECK_INTERVAL_MIN`).
  Sub-minute resolution isn't supported anyway because the period key is
  `YYYY-MM-DD`.

## [1.8.0] — 2026-05-23

Phase 3B — API tokens + outbound webhooks. Adds a second authentication
shape (per-user Bearer tokens for server-to-server / scripting use) and a
team-scoped webhook subscription system with HMAC-signed deliveries +
retry/backoff.

### Schema

- New `ApiToken` model — per-user, hashed (`sha256`), with `prefix`
  (first 11 chars for disambiguation), `scopes` (TEXT[]), optional
  `expiresAt`, `lastUsedAt`, `revokedAt`. Raw value surfaced ONCE at
  generation.
- New `Webhook` model — team-scoped, with `secretEnc` (AES-256-GCM via
  the existing `MASTER_KEY`), `events: String[]`, `active`. Raw signing
  secret returned once at creation.
- New `WebhookDelivery` model — doubles as the queue. `status` enum
  (`PENDING|DELIVERED|FAILED`), `attempt`, `maxAttempts` (default 5),
  `nextAttemptAt`, `httpStatus`, `errorMessage`. Two indexes:
  `(status, nextAttemptAt)` for the dispatcher poll,
  `(webhookId, createdAt)` for the per-webhook delivery log.
- Migration `20260523180000_api_tokens_webhooks`.

### Backend

- New [ApiTokensService](backend/src/services/apiTokensService.ts). Token
  format `th_<48 hex>`; the `th_` prefix is the cheap-to-recognise marker
  the auth middleware uses to branch into the token-verification path.
- [requireAuth](backend/src/middleware/auth.ts) now accepts both JWTs
  and API tokens. API-token auth resolves the owning user, populates
  `request.user` as if they'd logged in, and attaches the token's scopes
  for future scope-aware gates. `User.disabledAt` is rechecked so
  SCIM-deprovisioned accounts can't keep their API tokens working.
- New [WebhookService](backend/src/services/webhookService.ts):
  - CRUD over `Webhook` rows.
  - `emit(teamId, eventType, payload)` — inserts one `WebhookDelivery`
    row per active webhook that matches the event (or `*`). Best-effort:
    failures don't bubble into the caller.
  - `drainOnce(limit)` — the dispatcher's work loop. Picks up
    `status=PENDING AND nextAttemptAt <= now`, POSTs with an
    `X-TaskHub-Signature: sha256=<hmac>` header, retries on failure
    with exponential backoff (`30s × 2^(attempt-1)`, capped at 30 min,
    max 5 attempts).
  - `testSend(webhookId)` — synchronous fire-and-return for the UI's
    "Test" button.
- New [webhookDispatcher](backend/src/scheduler/webhookDispatcher.ts) —
  opt-in via `WEBHOOK_DISPATCH_ENABLED=true`, mirrors `TASK_DUE_ENABLED`.
  Default off so tests + small dev runs don't fire outbound HTTP.
- [tasksService](backend/src/services/tasksService.ts) +
  [commentsService](backend/src/services/commentsService.ts) now emit
  `task.created`, `task.updated`, `task.status_changed`, `task.deleted`,
  and `comment.added` events after their transactions commit. Emit is
  awaited (not fire-and-forget) so the delivery row is durable before
  the API response returns.

### Endpoints

- API tokens (per-user):
  - `GET /api/settings/api-tokens` — list mine (redacted).
  - `POST /api/settings/api-tokens` — generate; returns raw token ONCE.
  - `DELETE /api/settings/api-tokens/:id` — revoke.
- Webhooks (team MANAGER):
  - `GET /api/teams/:teamId/webhooks` — list.
  - `POST /api/teams/:teamId/webhooks` — create; returns raw secret ONCE.
  - `PATCH /api/teams/:teamId/webhooks/:webhookId` — update (toggle
    `active`, rotate secret, etc.).
  - `DELETE …` — remove.
  - `POST …/test` — synchronous test delivery.
  - `GET …/deliveries?limit=N` — recent attempts.

### Frontend

- [ApiWebhooksPage](frontend/src/pages/settings/ApiWebhooksPage.tsx)
  replaces the v1.3.0 placeholder. Two sections:
  - **API tokens** — visible to all signed-in users; manages their own
    tokens with a one-shot reveal modal on generate.
  - **Webhooks** — visible to MANAGERs of the current team (admins via
    the same gate). Create form with checkbox event picker; per-webhook
    Test / Pause / Resume / Delete; expandable "Show recent deliveries"
    panel with status colouring.
- Settings sidebar opens the entry to MEMBER + MANAGER (the page
  internally renders sub-sections based on what the user can manage).

### Tests

- New [tests/integration/apiTokensAndWebhooks.test.ts](backend/tests/integration/apiTokensAndWebhooks.test.ts)
  — 6 cases:
  - API token list/generate/use, raw never surfaces after creation.
  - Revoke + retry returns 401.
  - Webhook delivery to a local `http.createServer` stub, HMAC verified
    against `crypto.createHmac('sha256', rawSecret)`.
  - 5xx → row stays `PENDING` with bumped `nextAttemptAt`; manual
    nudge + drain → `DELIVERED` on the next attempt.
  - `POST .../test` fires synchronously and returns `{ ok, httpStatus }`.
  - Paused webhook (`active=false`) emits no deliveries.
- Suite: **152/152** (was 146 → +6).

### Verified

- Live smoke against the running stack: generate API token via the JWT
  session → `GET /auth/me` with the raw token works → revoke → same
  call returns 401.

### Phase 3B boundary

- Scopes are advisory in v1.8.0. API tokens grant the owner's full
  permissions; route handlers don't yet enforce `tasks:read` vs `*`
  etc. A scope-aware route guard can land later without an API change.
- Single-instance dispatch only. Multi-instance deploys MUST run
  `WEBHOOK_DISPATCH_ENABLED=true` on exactly one node to avoid
  double-delivery — there's no row-level lock yet. Proper fix is
  `SELECT … FOR UPDATE SKIP LOCKED` in `drainOnce`.
- HMAC algorithm fixed at `sha256`. No signature versioning header in
  the request (`X-TaskHub-Signature: sha256=<hex>`) — receivers parse
  the algorithm prefix today, but if we ever rotate algorithms we'd
  bump this format.

## [1.7.0] — 2026-05-23

Phase 3A — Audit-log viewer. Adds a paginated, filterable read surface
over the existing `Activity` table. ADMIN sees the whole instance; team
MANAGERs see the teams they manage; everyone else gets 403.

### Schema

- `Activity.teamId String?` — denormalized so the team-scoped query
  (the common case) hits one index instead of joining `Activity → Task →
  Project`.
- `Activity.taskId String?` — was required. Loosened so future emitters
  (LDAP/SCIM/2FA/webhook/token/recurring) can write rows that aren't
  task-scoped without another migration.
- `Activity.actorId String?` — was required + CASCADE. Loosened to
  optional + `SetNull` on user delete so the audit trail survives the
  actor being removed.
- Three new indexes for the viewer's common filters:
  `(teamId, createdAt)`, `(actorId, createdAt)`, `(action, createdAt)`.
  Existing `(taskId, createdAt)` kept for the per-task drill-down.
- Migration `20260523160000_audit_log_teamid` — additive + a one-pass
  backfill (`UPDATE … SET teamId = Task.teamId`) for existing rows.

### Backend

- `logActivity` now accepts `teamId` (and a nullable `actorId`). When the
  caller supplies `taskId` but not `teamId`, the helper auto-resolves the
  team from `Task.teamId` — so existing callers don't need to thread
  `teamId` everywhere.
- New [AuditService](backend/src/services/auditService.ts) — performs the
  role gating in-service (depends on dynamic team membership, not just
  `globalRole`):
  - ADMIN: any filter, any team. Omitting `teamId` returns instance-wide.
  - Team MANAGER: server clamps the scope to teams they manage. Passing a
    `teamId` they don't manage returns 403.
  - Everyone else: 403.
- Cursor pagination on `(createdAt desc, id desc)`. `limit` capped at 200.
- New `GET /api/audit` endpoint with the filter/cursor query schema in
  [schemas/audit.ts](backend/src/schemas/audit.ts).

### Frontend

- New [AuditPage](frontend/src/pages/settings/AuditPage.tsx) replaces the
  v1.3.0 placeholder. Filters: action substring, team (admin-only), actor
  id, date range. Infinite-scroll-style pagination via React Query's
  `useInfiniteQuery` + "Load more" button. Timestamps via
  `formatShamsiTimestamp`.
- The table renders arbitrary action types — Phase 3A doesn't hard-code
  the task vocabulary, so future emitters (`directory.created`,
  `user.provisioned`, `auth.2fa_enabled`, `token.created`, `webhook.*`)
  show up without UI changes.
- Settings sidebar opens "Audit" to team MANAGERs. The layout now derives
  effective roles from `globalRole` + `teams[].myRole` so the entry
  appears whenever the user manages at least one team.

### Tests

- New [tests/integration/audit.test.ts](backend/tests/integration/audit.test.ts)
  — 6 cases: end-to-end create-task-then-read-audit (verifies
  denormalized teamId), ADMIN cross-team visibility, MANAGER team
  isolation, MEMBER → 403, MANAGER asking for another team's data → 403,
  filter + cursor pagination.
- Suite: **146/146** (was 140 → +6 audit).

### Verified

- Live smoke against the running stack: PATCH on a real task → audit
  row appears with `teamName`/`taskTitle`/`actorName` populated. A
  freshly-registered non-manager gets 403 on the same endpoint.

### Phase 3A boundary

- Action types are still only the existing task + comment vocabulary
  (`task.created`, `task.updated`, `task.status_changed`,
  `comment.added/edited/deleted`). The auth-side emitters
  (`auth.2fa_enabled`, `directory.created`, etc.) land alongside the
  features they describe — the table can already render them, but
  nothing writes them yet.
- Date filters use absolute ISO timestamps from `<input type="datetime-local">`.
  Relative quick-picks ("last 24h", "this week") can land later if the
  filter bar gets crowded.

## [1.6.0] — 2026-05-23

Phase 2C — Per-user TOTP 2FA. Adds an opt-in second factor on top of the
existing password + LDAP login paths, with one-shot recovery codes for the
"my phone is in another country" case. `/auth/login` returns a short-lived
pending challenge when the user has 2FA enabled; the client follows up with
`/auth/2fa/login` to get the full session.

### Schema

- `User.totpSecretEnc: String?` — AES-256-GCM ciphertext of the shared
  secret. Only written after the user confirms a code; cleared on disable.
- `User.totpEnabled: Boolean @default(false)` — explicit flag (lighter on
  the login hot path than `totpSecretEnc IS NOT NULL`).
- New `RecoveryCode` model — `userId`, `codeHash` (sha256 of the
  normalised code), `usedAt?`. Raw code shown to the user exactly once at
  generation; only the hash persists.
- Migration `20260523140000_add_two_factor` — additive only.

### Backend

- New [lib/totp.ts](backend/src/lib/totp.ts) wrapping `otplib` (SHA-1, 6
  digits, 30s step, ±1 window for clock skew) + `qrcode` for the PNG data
  URL. The frontend renders the QR in an `<img>` tag — no client-side QR
  library needed.
- New [TwoFactorService](backend/src/services/twoFactorService.ts) — setup
  (returns ephemeral material, persists nothing), confirmSetup (verifies
  the first code, encrypts + stores the secret, generates 10 recovery
  codes), disable (requires a fresh TOTP or recovery proof), verifyForLogin
  (TOTP or burn-on-use recovery), regenerateRecoveryCodes.
- JWT layer gains `signPending(sub)` / `verifyPending(token)` for the
  5-minute "2fa-pending" intermediate token. Signed with the access secret
  but carries `kind: '2fa-pending'` so it can't be replayed as a normal
  access token (verifyPending explicitly checks the claim).
- `authService.login` is wrapped by `loginOutcome`: on `totpEnabled=true`
  it revokes the just-issued refresh token and returns
  `{ kind: 'pending2fa', pendingToken }`. `completeLoginWith2fa` verifies
  the pending token + code and mints the full session.

### New endpoints

- `POST /auth/2fa/setup` — returns `{ secret, uri, qrDataUrl }`. Nothing
  persists yet; the user can call setup repeatedly until they confirm.
- `POST /auth/2fa/confirm` — body `{ secret, code }`. Verifies the code,
  persists the encrypted secret, flips `totpEnabled`, returns 10 recovery
  codes (ONCE).
- `POST /auth/2fa/disable` — body `{ code }`. Accepts a current TOTP code
  OR a recovery code as proof. 204 on success.
- `POST /auth/2fa/recovery-codes` — wipe + regenerate the recovery code
  set. Returns the new plaintext codes (ONCE).
- `POST /auth/2fa/login` — second step of the login. Body
  `{ pendingToken, code }`. Returns the same shape `/auth/login` returns
  for non-2FA users.
- The existing `/auth/login` response is now either the legacy
  `{ accessToken, user }` OR `{ pending2fa: true, pendingToken }` — the
  frontend dispatches on the `pending2fa` flag.

### Frontend

- New two-step LoginPage
  ([LoginPage.tsx](frontend/src/pages/LoginPage.tsx)). Step 1 unchanged;
  step 2 is a TOTP / recovery-code input with autoFocus and a "back to
  sign-in" escape hatch. Pending token lives only in component state — a
  page reload drops it and the user starts over.
- Settings → Security replaced with a real enrolment flow
  ([SecurityPage.tsx](frontend/src/pages/settings/SecurityPage.tsx)):
  `Enable 2FA` → QR + manual-key display → 6-digit input → one-shot
  recovery-code reveal with Copy. When enabled: disable form (TOTP-only
  guard against session-hijack) and recovery-code regenerate.
- `AuthContext` gains `signInWith2fa` and `patchUser` — the 2FA panel
  flips `user.totpEnabled` locally on enrol/disable without a refresh
  round-trip.
- Settings sidebar opens up the "Security" item to all roles (not just
  ADMIN) so members can enrol themselves. Other sub-pages stay
  admin-only.
- Dashboard header now shows the "Settings" link to every signed-in user;
  "Admin" stays admin-only.

### Tests

- New [tests/integration/twoFactor.test.ts](backend/tests/integration/twoFactor.test.ts)
  — 8 cases: enrol happy path, wrong confirm code blocked, pending2fa →
  step-2 happy path, step-2 with wrong TOTP returns 401, recovery code
  logs in and burns on first use, disable wipes secret + recovery codes,
  recovery-code regenerate invalidates the previous set, non-2FA login
  keeps the legacy single-step response shape.
- Suite: **140/140** (was 132 → +8 TOTP).

### Verified

- Live round-trip against the running stack: setup → confirm
  (10 recovery codes) → login returns `pending2fa: true` → step-2 with
  TOTP succeeds → step-2 with a recovery code succeeds → disable clears
  `totpEnabled` + `totpSecretEnc` + recovery codes.

### Known limitations / Phase 2C boundary

- 2FA is per-user opt-in. There is no instance-wide "require 2FA for
  admins" policy yet — that's a Settings → Security policy addition for
  a later phase.
- The pending token is sent in the response body and not bound to the
  IP / user-agent. A perfectly-timed MITM with a captured pending token
  could theoretically attempt the second factor; the 5-minute TTL +
  401-on-wrong-code make brute force impractical.
- LDAP-bound users *can* enrol TOTP (the branches are orthogonal). When
  they do, both factors are required at login.

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
