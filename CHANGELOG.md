# Changelog

All notable changes to TaskHub are documented in this file. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

When shipping a release, also update `ARCHITECTURE.md`, `USER_MANUAL.md`,
`USER_MANUAL.fa.md`, and set `TASKHUB_VERSION` in the deployment `.env`.

## [1.75.0] — 2026-06-21

**Tasks — collapsible subtasks in list view.** Project task list mode shows a per-row chevron +
subtask count (collapsed by default). Expanding reveals indented subtask rows using data already
returned by the task list API. In-memory expand state only (no persistence). Kanban / technician
views unchanged.

---

## [1.74.0] — 2026-06-21

**Projects — team labels.** Assign the existing team `Label` catalog to projects at create and edit
via optional `labelIds` (replace-set on update). `ProjectLabel` join table; labels appear as colored
chips on project rows. Cross-team label assignment rejected (400). Deleting a label cascades off
projects without deleting them. Task labels unchanged.

---

## [1.73.0] — 2026-06-15

**Projects — remove manual actual spent field.** Dropped `Project.actualSpent` (destructive migration —
existing project-level actual values are discarded). Project create/edit and the budget report now use
**planned budget + currency only** at project level. Task `plannedBudget` / `actualSpent` unchanged.
Budget report API/UI/CSV no longer expose actual, variance, utilization, or over-budget columns.

---

## [1.72.0] — 2026-06-15

**Projects — start/end dates + full edit parity.** Optional `startDate` / `endDate` on projects
(UTC-midnight calendar dates, Jalali picker on the frontend). Create and edit forms now expose
the same fields: name, description, status, dates, accountable, and budget (currency, planned,
spent). Edit budget menu opens the unified edit modal. Manager rename-only gate unchanged.

---

## [1.71.1] — 2026-06-09

**Security — fast-jwt CVE patch.** Backend npm `overrides` pin `fast-jwt@6.2.4` under
`@fastify/jwt@8` to resolve critical JWT advisories (algorithm confusion, cache-key
collision identity mixup, improper `iss` validation). Dependency patch only — login, refresh
rotation, API tokens, and updater auth verified unchanged. Backend package version aligned to
1.71.1 (frontend remains 1.71.0 until next frontend release).

---

## [1.71.0] — 2026-06-09

**Reports — budget / cost.** New team-scoped budget report: per-project planned vs actual
spend, variance, utilization %, over-budget flags, and a team rollup grouped **by currency**
(never summed across IRR/USD/EUR). Decimal-safe math; CSV export at `/reports/budget.csv`.
Read-only analytics using existing project budget fields (no task-level rollup in v1).

---

## [1.70.1] — 2026-06-09

**PWA — admin HTTPS warning.** Global admins see an amber notice on the About page when
the instance is served over plain HTTP (`window.isSecureContext === false`), explaining
that the PWA cannot be installed until HTTPS is enabled. Non-admins never see it;
localhost and HTTPS origins show no warning. i18n EN + FA.

---

## [1.70.0] — 2026-06-09

**PWA — installable app-shell.** TaskHub is now an installable Progressive Web App: web
manifest, maskable icons (generated from the Quad brand mark), standalone display mode,
and a conservative service worker that precaches the static app shell for fast launch.
**API responses are never cached** (`NetworkOnly` for all `/api/*` methods) so tasks,
comments, and auth data always come from the network. Install requires **HTTPS** (or
localhost for testing); on HTTP-only deployments the app still works as a normal SPA.

---

## [1.69.2] — 2026-06-09

**Navigation:** removed the redundant "+ New Task" shortcut from the top bar. Task creation is unchanged via Projects and the task board.

---

## [1.69.1] — 2026-06-09

**About page:** credits author Naser Fathi with a LinkedIn link (creator credit, not ownership).

---

## [1.69.0] — 2026-06-09

**Intake forms — team submission + opt-in public links (S-9 aware).**

- Schema: `IntakeForm` + `IntakeFormField` (migration `20260620120000_intake_forms`).
- Permission: `form.manage` (Manager default) gates builder CRUD + token rotation.
- API: `/api/teams/:teamId/forms` — CRUD, authenticated `POST …/submit`.
- Public (opt-in, OFF by default): `GET/POST /api/public/forms/:publicToken` — opaque
  token, IP rate-limit, honeypot, minimal render payload, system-user actor, no team leak.
- Submissions create tasks via `TasksService.create` + `CustomFieldsService.setTaskValue`
  (existing validators — no bypass). `task.created` webhooks/automations unchanged.
- Frontend: Settings → Intake forms (builder), `/forms/:id` (team submit),
  `/public/forms/:token` (standalone public page). i18n EN + FA.

---

## [1.68.0] — 2026-06-09

**Team workload / capacity view — built on existing `/reports/workload`.**

- New `GET /api/teams/:teamId/reports/workload/detail` with optional `projectId`, `window`
  (`all` | `overdue` | `this_week` | `next_week`), and `weighted` query params.
- `ReportsService.workloadDetail()` + shared `lib/workloadAggregation.ts` — one indexed
  task query, in-memory assignee grouping (reuses the same pattern as `listWorkload`).
- Per member: `openByStatus`, `byDueBucket` (overdue / this_week / next_week / later / no_due),
  `total`, `weightedTotal` (LOW=1 … URGENT=4 when weighted).
- Existing `GET /reports/workload` + `workload.csv` unchanged (now share fetch helper + `deletedAt` filter).
- Frontend **Workload** page (`/workload`): stacked Recharts bars, sortable table, project/window
  filters, weighted toggle, client-side capacity threshold highlighting. i18n EN + FA.

---

## [1.67.0] — 2026-06-09

**Configurable widget dashboards — team-scoped, shareable, Recharts-powered.**

- Schema: `Dashboard` + `DashboardWidget` (migration `20260619120000_dashboards`). Team-owned;
  optional `shared` flag for read access by all members.
- API: `/api/teams/:teamId/dashboards` — CRUD + idempotent `PUT …/widgets` + per-widget
  `GET …/widgets/:widgetId/data` resolver.
- **Widget types (v1):** METRIC, BAR, PIE, LINE, TABLE.
- **Data sources:** task count; sum of `plannedBudget` / `actualSpent`; sum of NUMBER custom field.
- **Group by:** status, priority, assignee, label, project, due-bucket (overdue/today/this-week/later/no_due),
  or SINGLE/MULTI select custom field (`custom_field:{fieldId}`).
- **Filters:** status/priority/assignee/label/project/custom-field equals (automation-style ALL/ANY).
- **LINE:** `completedAt` or `createdAt` bucketed day/week/month.
- Widget data resolver reuses `ReportsService.summary()` (status counts, open total) and
  `listWorkload()` (assignee buckets) when unfiltered; adds grouped Prisma queries elsewhere.
- Frontend: **Dashboards** nav → list + editor with live widget preview (`recharts` ^2.15.4).
  Charts render in `dir="ltr"` under Persian RTL. i18n EN + FA flat keys (`dashboard.*`).
- **Deferred:** cross-team dashboards, drill-down, scheduled email, custom SQL.

---

**Offline Iranian holiday import — admin-triggered, ISP-filtering safe.**

- Bundled offline dataset (`backend/src/data/ir-holidays.json`) sourced from **time.ir** official
  holiday dates via `shamsi-holidays` static files (Jalali years **1404–1406**). Refresh yearly
  with `backend/scripts/generate-ir-holidays.mjs`.
- Admin API: `GET /api/holidays/import/preview?jalaliYear=` (read-only diff) and
  `POST /api/holidays/import` `{ jalaliYear }` → `{ added, skipped, conflicts, inserted }`.
- **Idempotent, non-destructive:** re-import skips existing `IMPORT` rows; **MANUAL** (and `SYNC`)
  dates on the same day are never overwritten — reported as conflicts. No deletes on import.
- Jalali→Gregorian uses **`react-date-object`** (same library as frontend `lib/shamsi.ts`).
- Settings → **Holidays**: preview + confirm import UI; imported rows editable/deletable; verify
  lunar/religious dates against official announcements (documented in UI + manual).

---

## [1.65.0] — 2026-06-09

**Configurable due reminders — per-user lead time + holiday-aware notify timing.**

- **`User.reminderLeadHours`** (nullable, default **24**) — hours before `dueDate` to emit a one-shot
  `TASK_DUE` notification. Resolved as assignee → creator → `TASK_DUE_LEAD_HOURS` env fallback.
  PATCH `/api/auth/me/preferences` + login/refresh payload. **Not retroactive** — changing lead
  time does not reset `dueNotifiedAt` (only a due-date change does).
- Instance setting **`reminders.skipOffDays`** (admin, default **off**): when the computed notify
  instant falls on a weekend/holiday, shift to the **prior working day** (same time-of-day). If
  that moment is already past at tick time, fire **immediately** — `dueNotifiedAt` still prevents
  duplicates.
- Backend `lib/reminderTiming.ts` + reworked `dueDateScheduler.ts`. Per-task lead override deferred.
- Settings → **Preferences**: personal lead-time control; admin **Due reminders** section for
  skip-off-days. Bootstrap via `/api/system/info` (`remindersSkipOffDays`).

---

## [1.64.0] — 2026-06-09

**Opt-in working-day scheduling — roll off-day due dates + working-day durations.**

- Instance settings (admin, default **off**): `scheduling.rollOffdayDueDates` rolls task/recurrence
  due dates forward from weekends/holidays; `scheduling.workingDaysOnly` makes recurrence offsets
  and Gantt duration counts skip off-days.
- Backend `WorkingDayCalendar` (`lib/workingDays.ts`) — server mirror of `isOffDay`; UTC-midnight
  preserved throughout.
- Rolls log `task.dueDate_rolled_offday` activity entries. **Not retroactive** — applies on next
  create, edit, or recurrence spawn only. `spawnedForPeriod` idempotency keyed on spawn date, not
  rolled due date.
- Gantt API: `workingDaysOnly` flag + per-row `workingDayCount` when enabled.
- Settings → Preferences (admin): Working-day scheduling section. Bootstrap via `/api/system/info`.

---

## [1.63.0] — 2026-06-09

**Per-user timezone, 12h/24h time format, and dual-calendar display.**

- New **`User.timeZone`** (nullable IANA name), **`User.timeFormat`** (`H12`/`H24`, default
  `H24`), **`User.dualCalendar`** (default `false`). PATCH `/api/auth/me/preferences` accepts
  all three; login/refresh user payload includes them.
- Frontend **`lib/datetime.ts`**: `formatTimestamp()` / `formatTimestampDate()` apply the user's
  timezone + time format to **timestamps only** (comments, audit, created/updated, notifications).
  **Calendar dates** (`dueDate`, `startDate`, `plannedDate`, holidays) remain **UTC-midnight
  zone-neutral** via `lib/shamsi.ts` — timezone must not shift these.
- Settings → **Preferences**: searchable IANA timezone picker (defaults to browser zone when
  unset), 12h/24h toggle, dual-calendar switch (Jalali + Gregorian on key task dates).
- Invalid IANA timezone strings rejected with **400**.

---

## [1.62.0] — 2026-06-09

**Instance holiday calendar — specific-date off-days shown in red.**

- New **`Holiday`** model (UTC-midnight calendar dates, name, optional yearly recurrence,
  `MANUAL`/`IMPORT`/`SYNC` source) — distinct from recurring weekend weekdays
  (`calendar.weekend` InstanceSetting).
- Admin API: `GET/POST/PATCH/DELETE /api/holidays` + `GET /api/holidays/range`; duplicate
  dates return **409**. Activity log on create/update/delete.
- Public bootstrap: `calendarHolidays` on `GET /api/system/info` seeds the frontend cache.
- Frontend: `isHoliday()`, `isOffDay()` in `lib/calendar.ts`; red off-day rendering on
  Calendar, planner calendar, Gantt, and timeline; holiday name on hover/tooltip.
- Settings → **Preferences** (admin): Holidays section with Jalali date picker.

---

## [1.61.0] — 2026-06-09

**Multiple themes — CSS-variable token system with 7 user-selectable themes.**

- **Theme preference** extended from Light/Dark to seven options: Light, Dark, System (auto),
  Midnight, Solarized, High-Contrast, and Nord. Stored per user on the server and mirrored to
  `localStorage` at login.
- **CSS-variable token system** on `<html class="theme-*">` (`--color-bg`, `--color-text`,
  `--color-primary`, …) with Tailwind utilities wired to semantic tokens. Legacy `dark:` variants
  remain on dark-family themes during incremental migration.
- **System** follows the OS light/dark setting via `matchMedia` and re-applies live without reload.
- Settings → **Preferences** theme picker with swatch previews (EN + FA).

---

## [1.60.1] — 2026-06-09

**Projects page — per-row actions menu (edit project, edit budget, delete).**

- Each project row on `/projects` now has a **⋯ actions menu** consolidating edit project
  (name + description + status), edit budget (planned/actual/currency), and delete — replacing
  scattered rename/delete/budget inline controls.
- **Edit project** extended beyond rename-only: modal edits description and status (fields already
  supported by `updateProjectBody`; no schema change).
- **☰ bucket assignment** kept as a separate control beside the actions menu.
- i18n: `projects.action.*`, `projects.edit.*`, `projects.delete.confirm` (EN + FA).

---

## [1.60.0] — 2026-06-09

**Automation rules — no-code trigger → conditions → actions engine (Tier A).**

### Automation (backend + frontend)

- Team-scoped **automation rules** with v1 triggers (`task.created`, `task.status_changed`,
  `task.updated`, `task.assigned`, `task.custom_field_changed`), flat ALL/ANY condition
  groups, and actions (set status/priority/assignee, labels, custom fields, comments,
  notifications).
- **Post-commit engine** hooks the same task mutation points as webhooks — never inside
  transactions. **Loop guard**: shared `(ruleId, taskId)` fired-set plus max depth **5** per
  originating chain; exceeding depth logs ERROR and halts.
- **AutomationRun** audit log per evaluation (SUCCESS / SKIPPED / ERROR). Action failures
  are isolated — one bad action logs ERROR and remaining actions still run.
- New permission **`automation.manage`** (default Manager). Settings → **Automations** rule
  builder + run log view. Custom-field-aware conditions and actions reuse typed validators.

---

## [1.59.0] — 2026-06-09

**Budget currency — IRR / EUR / USD on project budgets with team default.**

### Budget currency (backend + frontend)

- Projects carry a **budget currency** (`IRR`, `EUR`, or `USD`). Task budgets display in
  the parent project's currency — tasks do not store a separate currency column.
- Teams have a **default currency** that pre-fills new projects (editable per project).
  Existing projects backfill to `IRR` (or the team default at migration time).
- Locale-aware display via `Intl.NumberFormat` (EN / FA): IRR shows **0** decimal places;
  EUR and USD show **2**. Stored amounts remain `Decimal(18,2)` — no conversion or exchange
  rates. Changing a project's currency relabels amounts only.
- Team settings: default currency selector (requires `team.edit_details`). Activity log
  records `team.default_currency_changed`.

---

## [1.58.0] — 2026-06-09

**Custom fields — team-defined typed metadata on tasks (Tier A foundation).**

### Custom fields (backend + frontend)

- Team-scoped **custom field definitions** with seven types: Text, Number, Date,
  Single select, Multi select, Checkbox, and Person (team member).
- **Typed per-task values** stored in queryable columns (`valueText`, `valueNumber`
  `DECIMAL(18,4)`, `valueDate`, `valueBool`, `valueUserId`) plus a join table for
  select options — foundation for upcoming automation, dashboard, and form features.
- New permission **`customfield.manage`** (default Manager) for definition CRUD;
  anyone who can edit a task can set values (no separate value permission).
- API: `GET/POST/PATCH/DELETE /api/teams/:teamId/custom-fields`, option management,
  and `PUT …/tasks/:taskId/custom-fields/:fieldId` for value upsert/clear.
- Task list/detail responses include `customFields[]`. Activity logs definition
  changes and value sets with readable summaries.
- Settings → **Custom fields** (managers with permission). Task detail renders
  active fields by type with save/clear.

---

## [1.57.0] — 2026-06-09

**Team add member — live search-all-users picker.**

### Teams (backend + frontend)

- New `GET /api/teams/:teamId/members/user-search?q=` — reuses shared user search
  logic (min 2 chars, disabled excluded, cap 20); gated by `team.invite_member`
  (not `group.manage` / not admin scope). Results include `alreadyMember` per hit.
- `POST /api/teams/:teamId/members` accepts optional `userId` (exactly one of
  `email` or `userId`) for backward compatibility with email-based adds.
- Teams page **Add member** section: debounced search picker (mirrors Groups UX)
  instead of a raw email field.

---

## [1.56.0] — 2026-06-09

**Team member removal — ownership warnings and reassignment.**

### Teams (backend + frontend)

- New `GET /api/teams/:teamId/members/:userId/removal-blockers` surfaces projects the
  member owns or is accountable for in this team.
- `DELETE /api/teams/:teamId/members/:userId` accepts optional `reassignOwnerTo` or
  `force` — blocking removal when the member owns team projects unless ownership is
  reassigned or force-removal is chosen. Reassignment is activity-logged.
- Teams page removal flow: fetches blockers first; dialog lists owned/accountable
  projects with reassign picker or explicit force option.

---

## [1.55.0] — 2026-06-09

**Team roster — searchable, filterable, sortable, paginated member list.**

### Teams (backend + frontend)

- New `GET /api/teams/:teamId/members` with server-side search (name/email),
  filters (role, status active/disabled/locked, member vs external), sort
  (name/email/joinedAt/role), and page-numbered pagination with total count —
  mirroring the Phase-1 admin user list pattern.
- `listTeamMembers` service method; `GET /api/teams/:teamId` still embeds the
  **first page** (25 rows, default sort/filter) in `members` for backward compatibility.
- Teams page: debounced search, filter dropdowns, sortable headers, pagination footer.
- Assignee pickers fetch members via the paged endpoint (`kind=member`, up to 100).

---

## [1.54.0] — 2026-06-09

**Team roster — member status badges + external group accessors.**

### Teams (backend + frontend)

- `GET /api/teams/:teamId` member list now includes `disabled`, `locked`, and `external`
  flags per row. Team members show account status (disabled / locked); external rows list
  ACCEPTED group accessors who are not team members, with `groupAccessLevel` (FULL / READONLY).
- Team detail UI: status badges on members; external accessors in a separate section with
  External + access-level labels. No schema change.

---

## [1.53.1] — 2026-06-09

**Settings sidebar — English-alphabetical order in both languages.**

### Settings (frontend)

- Settings sidebar items are sorted alphabetically by their **English** label after
  role filtering. The Persian UI shows translated labels in the same English-derived
  order (not Persian collation). Bare `/settings` now redirects to the first visible
  item in that order (e.g. Admin for global admins).

---

## [1.53.0] — 2026-06-09

**Admin user lifecycle — disable/enable, unlock, force-logout, local profile edit.**

### Admin (backend)

- **`POST /api/admin/users/:userId/disable`** — `{ disabled: boolean }`. Disabling sets
  `disabledAt` and revokes all refresh tokens (same idiom as SCIM deprovision) so
  group-granted project access is cut immediately; enabling clears `disabledAt` only.
- **`POST /api/admin/users/:userId/unlock`** — clears `lockedUntil` and
  `failedLoginAttempts` (idempotent).
- **`POST /api/admin/users/:userId/force-logout`** — revokes all sessions without
  disabling the account.
- **`PATCH /api/admin/users/:userId/profile`** — `{ name?, email?, department?, jobTitle? }`
  for LOCAL users only; directory-owned profiles return 409.
- Guards mirror role update: no system user, no self-disable/force-logout, no disabling
  the last enabled ADMIN. Activity log: `admin.user.disabled|enabled|unlocked|force_logout|profile_updated`.
- JWT auth middleware now rejects disabled users on every request (matches existing
  API-token path).

### Admin (frontend)

- User list: Disabled/Locked status badges; **Manage** detail panel with disable/enable,
  unlock, force-logout, and profile edit. Confirm dialogs for disable and force-logout.
  Directory-owned profile fields read-only with tooltip; self-row destructive actions disabled.

---

## [1.52.0] — 2026-06-14

**Admin user list — search, filters, sort, page-numbered pagination.**

### Admin (backend)

- **`GET /api/admin/users`** — breaking contract change: cursor pagination replaced with
  offset/limit + `totalItems` / `totalPages`. Query params: `page`, `pageSize`, `search`,
  `role`, `authSource`, `status` (`active`|`disabled`|`locked`), `directoryId`, `sortBy`,
  `sortDir`. System user always excluded.
- `AdminService.listUsers(opts)` rewritten; shared `where` for `count` + `findMany`.

### Admin (frontend)

- User list: debounced search, role/auth/status/directory filters, sortable columns,
  page navigation with jump-to-page. Filter changes reset to page 1.

---

## [1.51.0] — 2026-06-14

**User Groups — cross-team members, FULL/READONLY access, invitation handshake.**

### User Groups (backend)

- Migration `20260614180000_user_groups_cross_team`: `GroupAccessLevel`, `GroupInviteStatus`,
  expanded `UserGroupMember` (id, accessLevel, status, external, invitedBy), `GROUP_INVITE` notify type.
- **`resolveProjectAccess(projectId, teamId, userId, globalRole, scope)`** → `NONE | READ | WRITE`.
- **`assertCanWriteProject(...)`** — 403 on READ, 404 on NONE (no existence leak).
- In-team members added as **ACCEPTED** directly; out-of-team users get **PENDING** invite + notification.
- **`GET/POST /api/me/group-invites`** — list, accept, decline.
- **`requireTeamRoleOrGrantedProject`** — external accepted members reach nested project routes without TeamMembership.
- Cross-team users see **only granted projects** at their access level.

### Write enforcement

- `requireProjectWriteAccess` on project-scoped mutation routes (tasks, comments, subtasks, attachments, dependencies, recurrence, task labels).
- Service-layer guards: `TasksService.create/update/remove/reorder`, `CommentsService.create`.

### User Groups (frontend)

- Group editor: per-member FULL/READONLY, external badge, invite status, user search (all users).
- **Group invitations** panel in the notifications dropdown (accept/decline).

### Tests

- `backend/tests/integration/userGroups.test.ts` — 12 regression scenarios.

---

## [1.50.0] — 2026-06-14

**User Groups — grant project access to sets of team members without changing ownership.**

### User Groups (backend)

- New models: `UserGroup`, `UserGroupMember`, `ProjectGroupGrant` (migration
  `20260610150000_user_groups`).
- New permission **`group.manage`** (system Manager roles backfilled via migration).
- **`GET/POST/PATCH/DELETE /api/teams/:teamId/groups`** — CRUD for groups.
- **`POST …/groups/:groupId/members`**, **`DELETE …/members/:userId`** — membership.
- **`PUT …/groups/:groupId/projects`** — idempotent replace of granted projects.
- Cross-team validation: granted projects must belong to `:teamId` (404, no leak).
- Group members must be team members (400 on cross-team users).

### Project access (backend)

- Unified helper **`userCanAccessProject(projectId, teamId, userId, globalRole, intent)`**
  in `lib/projectAccess.ts` — single source for list/get visibility (`view`) and
  nested routes (`nested`).
- Access paths (additive): global ADMIN, project owner, `project.edit` manager
  (view/rename only), **group grant** (view + nested — owner-equivalent for tasks).
- All four call sites delegate: `ProjectsService.canViewProject`, `ProjectsService.list`
  where-clause, `ProjectsService.assertCallerCanAccess`, `requireProjectAccess` middleware.

### User Groups (frontend)

- **User groups** section on team detail when `capabilities.manageGroups` is true.
- Group editor: name/description, member multi-select, project grant multi-select.

### Audit

- `group.created`, `group.updated`, `group.deleted`, `group.member_added`,
  `group.member_removed`, `group.projects_set`.

### Tests

- `backend/tests/integration/userGroups.test.ts` — 8 regression scenarios (owner
  unchanged, group list/nested access, no-grant 404, cross-team isolation, removal
  revokes, admin/manager behaviour, cascade delete).

---

## [1.49.3] — 2026-06-09

**Fix: Active Directory users can get team membership and create content.**

- LDAP group sync now matches DNs **case-insensitively** (AD `memberOf` vs
  admin-entered mapping DNs).
- User profile reads **`memberOf`** from the LDAP entry and merges it with
  group search results — typical AD setups no longer miss group membership.
- Admin **Refresh from directory** now re-syncs group mappings (was skipping
  groups).
- Team creators get a proper **`roleId`** on their Manager membership.

---

## [1.48.0] — 2026-06-10

**Team managers can rename and delete teams** from the Teams page.

### Teams (backend)

- New permission **`team.delete`** (granted to system Manager roles via migration).
- **`DELETE /api/teams/:teamId`** — managers with `team.delete` may remove a team
  only when it has **no projects** and **no live tasks** (409 with blocker
  details otherwise). Global admins still force-delete via Settings → Admin
  (cascades all content).
- **`PATCH /api/teams/:teamId`** — records `team.renamed` activity when the
  name changes.
- **`GET /api/teams/:teamId`** — returns `capabilities` (`editDetails`,
  `deleteTeam`) and `deleteBlockers` for the delete confirmation UI.

### Teams (frontend)

- **⋮ actions menu** on team detail: **Rename team** (inline form) and
  **Delete team** (confirmation dialog with dependency warnings).
- Actions visible only when the API grants the matching capability.

### Audit

- `team.renamed` — old/new name, actor, team scope.
- `team.deleted` — team metadata + validation snapshot (instance-scoped row).

---

## [1.47.1] — 2026-06-10

**Fix: invite LDAP users to teams when AD mail attribute uses mixed case.**

- `POST /api/teams/:teamId/members` now resolves users with a
  case-insensitive email match. The invite body lowercases the address but
  LDAP JIT stored `A.Masghali@…` verbatim — lookups failed with 404.
- LDAP login and profile sync now normalize email to lowercase on
  create/update so future users stay consistent.

---

## [1.47.0] — 2026-06-09

**Asana-style Timeline on Planner → Calendar** — replaces the v1.46 vertical
day list with a horizontal, Gantt-like interactive view.

### Calendar Timeline (frontend)

- **Horizontal timeline** with day / week / month zoom, scrollable time axis,
  and a sticky task sidebar (project → task → subtask hierarchy with
  expand/collapse).
- **Draggable task bars** — drag to shift dates; drag edges to resize.
  Tasks use `startDate` → `dueDate` (with `plannedDate` fallback); subtasks
  use `startDate` → `endDate`. Updates persist via existing task/subtask
  PATCH APIs.
- **Toolbar** — project, assignee, status, date range, search, zoom, Today,
  and prev/next navigation.
- **Bar chrome** — task name, progress fill (subtask completion for parent
  tasks), assignee initials, status colour, overdue ring, hover tooltips.
- **Performance** — row virtualization for the chart body; pointer-based
  drag with window-level listeners (no re-render storm during drag).
- **Dependencies (future-ready)** — `DependencyLayer` SVG overlay and
  `TimelineDependencyEdge` types reserved for FINISH_TO_START connectors
  (phase 2; no new backend endpoints in this release).

### Removed

- `CalendarTimelineView.tsx` (vertical week list) — fully replaced, not
  duplicated.

### Data / API

- No schema migration. Reuses `listAllProjects`, `listTasks`, `updateTask`,
  and `updateSubtask`. Grid/week/month calendar modes unchanged.

---

## [1.46.0] — 2026-06-10

**Dashboard, calendar timeline, IT demo seed, navigation polish, and bug fixes.**

### Dashboard

- KPIs, completion trend, status breakdown, workload, upcoming deadlines, and
  recent activity now aggregate **all teams** the signed-in user belongs to
  (not only the “current team”).
- Subtitle shows team count (e.g. “Across 4 teams · all projects you can access”).

### Calendar

- New **Timeline** view on **Planner → Calendar** — vertical day-by-day list
  with full task rows (status, priority, assignee, project, team colour).
  Week navigation matches the existing Week view.

### Navigation & settings

- **Admin** and **Trash** moved from the main sidebar into **Settings**
  (`/settings/admin`, `/settings/trash`; legacy `/admin` and `/trash` redirect).
- Main sidebar **Settings** link highlights on any `/settings/*` page.
- Sidebar user footer shows name only (team name line removed).

### IT demo seed

- `backend/prisma/seed-it-demo.ts` — four IT teams (Network, Security,
  Datacenter, Service Desk), 12 projects, ~180 dated tasks, 13 fictional users
  (`*@itdemo.local` / `Demo2026!`). Dates anchor to **today (UTC)**.
- Reuses existing admin from `SEED_ADMIN_EMAIL` (password unchanged).
- `SEED_IT_DEMO=1 npx prisma db seed` via `seed-router.ts`, or
  `npm run prisma:seed:it` directly.

### Bug fixes

- **My Tasks:** `GET /api/me/tasks?teamId=…` returns **403** when the caller is
  not a member (was 200 with empty list).
- **Password:** users with `directoryId` set cannot change a local password
  (even if `authSource` is still `LOCAL`).
- **Personal buckets:** drag-and-drop onto an empty bucket column works.
- **Project delete:** removes orphaned `UserProjectBucketItem` rows.
- **Planner Grid:** no longer silently caps at 15 projects when “All projects”
  is selected.

### Verified

- Integration tests: `meTasks.test.ts`, `passwordManagement.test.ts` (403 cases).

---

## [1.45.0] — 2026-06-09

**Personal project buckets on the Projects page.** Per-user organizational
views that do not change project data, permissions, or team structure.

### Personal buckets (backend)

- New models `UserProjectBucket` and `UserProjectBucketItem` (migration
  `20260610000000_user_project_buckets`).
- **`GET/POST/PATCH/DELETE /api/me/project-buckets`** — CRUD for the caller's
  buckets (name unique per user, optional description + color).
- **`PATCH /api/me/project-buckets/reorder`** — bucket column order.
- **`POST/DELETE .../projects/:projectId`** — add/remove project from a bucket.
- **`PATCH .../projects/reorder`** — order within a bucket.
- **`PUT /api/me/project-buckets/assignments`** — set all bucket memberships
  for one project (multi-bucket support).
- Assignments validate project visibility (same rules as `listAllVisible`).
- Deleting a bucket cascades assignments only — projects are never deleted.

### Projects page (frontend)

- View toggle: **All projects** | **Personal buckets**.
- Kanban-style bucket columns with drag-and-drop (projects into buckets,
  reorder within bucket, reorder bucket columns).
- **New bucket** / **Edit** / **Delete** bucket actions.
- **☰** menu on each project row/card — checkbox assignment to multiple buckets.
- Search + filters: status, team, owner (admin), created date range; search
  matches project names and personal bucket names.
- Collapsed bucket state + view mode persisted in `localStorage`.
- Budget rollup hook on bucket headers (foundation for future health metrics).

### Verified

- Integration tests: `backend/tests/integration/userProjectBuckets.test.ts`.

---

## [1.44.1] — 2026-06-09

**Planner polish:** closes remaining gaps in Charts, Grid, and My Tasks views.

### Charts

- Client-side filters: **status**, **team member** (incl. unassigned), **due date range**.
- Scoped aggregation via `applyPlannerScopeFilters` before chart rendering.

### Grid

- Shared **`PlannerFilterBar`**: status, priority, assignee, label, due-date range, project.
- **Column resize** (CSS `resize-x` on headers), **assignee** sort, optional **Parent Task** column (N/A for top-level tasks).
- **View project** link on project column.

### My Tasks

- Inline **week calendar** (`MyTasksCalendar`) instead of redirect-only.
- **Sort** by due date, priority, status, or progress (progress uses client sort up to 200 rows).
- **Project filter** lists all owned projects, not only the current page.
- Quick actions: **mark complete**, **view project**, status update.

### Tests

- Integration tests for **`GET /api/me/tasks`** (`backend/tests/integration/meTasks.test.ts`).

### Shared components

- `features/planner/PlannerFilterBar.tsx`, `MyTasksCalendar.tsx`.

---

## [1.44.0] — 2026-06-09

**Advanced Planner views + buckets removal.** Replaces the per-project
"buckets" column layout with a unified **Planner** hub offering multiple
visualization modes on the same task data. Buckets are removed entirely
(schema, API, permission, UI).

### Planner (frontend)

- New **`/planner`** route group with tab navigation:
  - **Board** — project picker linking to per-project kanban boards.
  - **Calendar** — existing cross-project calendar (moved from `/calendar`).
  - **Charts** — Recharts doughnut (status distribution), vertical bar
    (tasks per status), horizontal bar (tasks per member). Team + project
    filters; falls back to `/reports/summary` + `/reports/workload` when
    fan-out exceeds 20 projects.
  - **Grid** — spreadsheet-style `TaskGrid` with sort, filter, search,
    pagination, show/hide columns (localStorage).
  - **My Tasks** — cross-project inbox for the signed-in user.
- Sidebar **Calendar** entry renamed **Planner** (lands on My Tasks).
- `/calendar` redirects to `/planner/calendar`.

### Dynamic board grouping (project kanban)

- **Group by** selector on the project task board: Status (default),
  Assignee, Progress (0% / 1–25% / … / 100%), Due Date (Overdue / Today /
  This Week / …), Label.
- Drag-and-drop reorder preserved **only** when grouped by Status.
- Preference persisted in `localStorage` (`planner.boardGroupBy`).
- Shared `GroupedBoard` component extracted from `TasksPage`.

### My Tasks API (backend)

- **`GET /api/me/tasks`** — tasks where `assigneeId = caller`, scoped to
  teams the user belongs to. Query filters: `status`, `priority`,
  `projectId`, `teamId`, `q`, quick filters (`due_today`, `overdue`,
  `upcoming`, `completed`, `high_priority`), `sort`, `order`, `limit`,
  `offset`. Returns `{ items, nextCursor, total }`.
- Auth: `requireAuth` + `tasks:read` scope. Non-member `teamId` → 403.

### Buckets removal (breaking)

- Dropped `Bucket` model, `Task.bucketId`, `buckets.manage` permission.
- Removed routes `/teams/:teamId/projects/:projectId/buckets` and
  `/teams/:teamId/buckets/:bucketId`.
- Migration `20260609200000_remove_buckets`.
- Default kanban view returns to **Status** columns (was Buckets in v1.34).

### Shared planner libraries (frontend)

- `features/planner/grouping.ts`, `progress.ts`, `filters.ts`,
  `aggregations.ts`, `storage.ts`, `GroupedBoard.tsx`, `TaskGrid.tsx`,
  `PlannerNav.tsx`, `PlannerLayout.tsx`, `charts/PlannerChartsPanel.tsx`.
- `features/meTasks/api.ts` — client for `/me/tasks`.

### Dependencies

- `recharts` added to frontend `package.json`.

### Verified

- `docker compose build backend frontend-build` — TypeScript + Vite clean.

---

## [1.43.0] — 2026-06-09

**LDAP login hardening, instance security policy, and TaskHub server
settings.** Operators can configure HTTPS/port and local-password rules from
the admin UI; Active Directory users can authenticate via STARTTLS on port
389.

### LDAP authentication (backend + admin UI)

- **STARTTLS** on port 389 for AD/LDAP binds (in addition to LDAPS on 636).
- **`tlsInsecure`** option — skip TLS certificate verification when the AD
  CA is not in the container trust store (operator choice).
- Login accepts **email or LDAP username** (`sAMAccountName` / `uid`).
- **JIT provisioning** on first successful LDAP bind when `allowJIT=true`.
- **Profile sync** on login: name + LDAP attributes written back to `User`.
- Admin **Directories** panel: LDAP sync status, auth-source visibility,
  imported-user profile fields.

### Security — local password policy (admin)

- **`InstanceSetting` key `security.passwordPolicy`** — configurable rules
  for **local** accounts only (LDAP users unaffected):
  min length, require upper/lower/digit/symbol, history count, lockout
  threshold + duration.
- `PasswordPolicyService` validates on register, password change, admin
  reset.
- **Password history** table prevents reuse of recent passwords.
- **Security audit events** logged for failed logins and lockouts.
- Settings → **Security** (admin): policy editor + strength indicator on
  password fields.

### TaskHub server settings (admin)

- Settings → **TaskHub**: public **port**, **HTTPS** toggle, upload SSL
  cert/key/chain (stored in `caddy_custom_certs` Docker volume).
- Certificate details panel (subject, issuer, expiry).
- Changing port/HTTPS requires Caddy container restart (documented in UI).

### Schema

- Migration `20260609160000_security_server_config`:
  `PasswordHistory`, `SecurityAuditEvent`, instance settings keys.
- Migration `20260609140000_user_ldap_auth_profile`: `AuthSource` enum,
  LDAP profile fields on `User`.

### Other (minor)

- Calendar week grid aligns with instance work-week start day.
- Project creation opens in a modal on the Projects page.

### Verified

- LDAP integration tests (when `LDAP_TEST_*` env vars set).
- Backend + frontend Docker builds clean.

---

## [1.42.0] — 2026-06-08

**Task budget + Subtask assignee + Project Gantt report.** Three related
additions, all additive and backward-compatible:

- **Task.plannedBudget / Task.actualSpent** — mirrors v1.41 Project
  budgets. DECIMAL(18,2), nullable, non-negative.
- **Subtask.assigneeId** — distinct from the existing v1.19 Technician
  (RACI / manager-gated). Lightweight "who's doing this now" field that
  anyone with project access can change. Mirrors Task.assigneeId.
- **GET /api/teams/:teamId/projects/:projectId/reports/gantt** —
  per-project aggregate of every subtask grouped by parent task plus
  cross-row summary counters (total tasks / total subtasks / scheduled
  vs unscheduled / earliest start / latest end). New SPA page at
  /projects/:projectId/reports/gantt renders an SVG horizontal bar chart
  with parent-task grouping, filters (task / assignee / status / date
  range), today marker, and overdue highlighting.

### Schema

- New migration `20260608180000_task_budget_subtask_assignee`:
  - `Task.plannedBudget` / `Task.actualSpent` DECIMAL(18,2) NULL +
    non-negative CHECK constraints.
  - `Subtask.assigneeId` TEXT NULL + FK to User with `ON DELETE SET NULL`
    + index.
- `schema.prisma`: matching Prisma fields + new `SubtaskAssignee` relation.

### Backend

- `schemas/tasks.ts` — shared budget validator (regex + non-negative);
  added to create + update bodies; added to `taskResponse`; extended
  `taskSubtaskResponse` with `assigneeId` + `assigneeName` + dates.
- `services/tasksService.ts` — `TaskSubtaskView` extended with
  assignee + dates; `TaskView` extended with budget fields; `toView`
  emits fixed-2 string budgets and the new subtask fields; `create()`
  and `update()` accept and persist the budget pair; shared
  `normaliseBudget()` coerces number|string|null to Prisma.Decimal|null.
  `TASK_INCLUDE` extended to join `subtasks.assignee`.
- `schemas/subtasks.ts` — added `assigneeId` to create + update bodies;
  added to `subtaskResponse`.
- `services/subtasksService.ts` — `SubtaskView` extended with
  assignee fields; new `assertAssigneeInTeam()` helper (rejects 400 if
  the user isn't a team member); `create()` and `update()` accept
  assignee; `SUBTASK_INCLUDE` joins assignee name.
- `services/ganttService.ts` (new) — `forProject()` returns
  `GanttReport { projectId, summary, rows }`. Single Prisma query per
  request joining tasks → subtasks → assignee + technician. Soft-deleted
  tasks excluded; subtasks of all statuses included so historical
  Gantt views work.
- `routes/gantt.ts` (new) — `GET /teams/:teamId/projects/:projectId/reports/gantt`
  with full auth chain: `requireAuth` + `requireTeamRole` +
  `requireProjectAccess` (v1.39 visibility cascade) + `tasks:read` scope.
- `app.ts` — registers the new route.

### Frontend

- `features/tasks/api.ts` — `Task` carries budget fields; `TaskSubtask`
  carries assignee fields; `createTask` and `updateTask` accept budgets.
- `features/subtasks/api.ts` — `Subtask` carries `assigneeId` +
  `assigneeName`; create + update accept `assigneeId`.
- `features/subtasks/SubtaskList.tsx` — each row gets an "unassigned /
  member" dropdown sourced from the team-members list (passed in by
  TaskDetailPage so we don't second-fetch). PATCH on change.
- `pages/TaskDetailPage.tsx` — new "Budget" section above Comments
  with `TaskBudgetSection` (mirrors v1.41 BudgetRow): read-only display
  "Planned X · Spent Y (Z%)" with green/amber/red utilisation chip,
  inline edit. Passes team-members into SubtaskList for the assignee
  dropdown.
- `features/reports/ganttApi.ts` (new) — typed client.
- `pages/ProjectGanttPage.tsx` (new) — SVG-rendered chart. Summary
  block + filter row (task / assignee / status / from / to). Day-level
  resolution at 28px/day. Rows grouped under parent-task headers. Bar
  colour by parent-task status; emerald when subtask is done; red
  border when overdue (`endDate < today` and not done). Today vertical
  marker. Native `title` tooltip with full row details. Empty state +
  unscheduled-count footer.
- `app/router.tsx` — `/projects/:projectId/reports/gantt` route entry.
- `pages/ProjectsPage.tsx` — per-row "Gantt" link to the report.

### Tests (15 new)

- `tasks.test.ts` (5): create with budgets (fixed-2 echo); create
  without; PATCH set then PATCH null clear; reject negative; reject
  >2 fractional digits.
- `subtasks.test.ts` (5): create with assignee echoes name; create
  without; reject non-team-member; PATCH reassigns; PATCH null clears.
- `gantt.test.ts` (4 new file): empty project returns zero summary;
  aggregates summary across scheduled + unscheduled and emits
  earliest/latest; rows include assignee + technician name; v1.39
  cascade — non-owner MEMBER 404s on the gantt URL.

### Verified

- Backend: 398 pass, 5 LDAP skipped. 3 pre-existing unrelated file
  errors (ldap.test.ts, updaterAuth, updaterUpgrade) — not v1.42-caused.
- Frontend: `tsc --noEmit` clean; `vite build` clean (13.3s).
- Live smoke: deferred.

### Architectural decisions + trade-offs

- **Subtask.assigneeId distinct from Technician.** The spec asked for an
  assignment field; v1.19 already has Technician but it's RACI-style and
  manager-gated. Adding a separate `assigneeId` mirrors Task.assigneeId
  (the existing pattern) and keeps the lighter "who's working on this"
  semantics distinct from the heavier RACI rule. No data migration
  needed; existing Technician values are untouched.
- **Decimal precision at the DB.** Budget rules are enforced in three
  layers (Zod / service / DB CHECK) so a direct DB write can't slip an
  invalid row past the schema. Same defence-in-depth posture as
  v1.41 Project budgets.
- **Gantt as a separate service + endpoint.** Could have piggy-backed
  on the existing tasks list, but a dedicated endpoint lets us shape
  the wire envelope (summary + rows) for the chart specifically and
  avoids loading the kanban with unrelated joins.
- **SVG over chart library.** No new dependency. The bar maths is a
  handful of lines and the chart is small (~400 LoC). Day-level
  resolution at 28 px/day is the smallest practical bucket for label
  legibility; for week/month zoom we'd add controls later.
- **Native `title` tooltips for v1.** Real popovers belong on a follow-up
  — the spec asks for "tooltip or detail popup" and native tooltips
  hit "tooltip" with zero code. A popover would add focus/keyboard
  handling that isn't worth the surface area today.
- **Visibility cascade reused.** Gantt uses the v1.39
  `requireProjectAccess` middleware so non-owners 404 without a custom
  check.

### Potential future improvements

- **Virtualisation** on the Gantt page for projects with thousands of
  subtasks (today: full SVG renders fine up to a few hundred rows).
- **Zoom controls** (day / week / month) on the Gantt axis. Currently
  fixed at day resolution.
- **Drag-to-reschedule** on bars. Would PATCH the subtask's startDate/endDate.
- **Critical-path overlay** once dependencies (v1.29) are linked to subtasks.
- **Click-to-popover** with full subtask details, comments link, attachments
  count.
- **Export** the chart as PNG/SVG/CSV for stakeholder reports.
- **Currency / locale** on budget fields if the corpus goes
  multi-currency.

## [1.41.0] — 2026-06-08

**Subtask scheduling window + Project budget tracking.** Two parallel
"optional metadata" additions:

- Every subtask can now carry an optional `startDate` / `endDate` pair
  (with the same UTC-midnight convention as Task dates).
- Every project can now carry an optional `plannedBudget` /
  `actualSpent` pair, decimal precision 2.

Both pairs are nullable and additive — existing rows get NULL and stay
fully functional. Validation:

- Subtasks: when both dates are set, `endDate >= startDate`. Enforced by
  Zod, by the service layer (also against the merged row on PATCH), and
  by a DB `CHECK` constraint as defence-in-depth.
- Projects: budgets are non-negative decimals with at most 2 fractional
  digits. Enforced by Zod, by the service layer, and by DB `CHECK`.

### Schema

- New migration `20260608120000_subtask_dates_project_budget`:
  - `Subtask.startDate TIMESTAMP(3) NULL`,
    `Subtask.endDate TIMESTAMP(3) NULL`,
    `CHECK (startDate IS NULL OR endDate IS NULL OR endDate >= startDate)`.
  - `Project.plannedBudget DECIMAL(18,2) NULL`,
    `Project.actualSpent DECIMAL(18,2) NULL`,
    `CHECK (... IS NULL OR ... >= 0)` for each.
- `prisma/schema.prisma`: matching `DateTime?` / `Decimal? @db.Decimal(18, 2)`.

### Backend

- `schemas/subtasks.ts` — `createSubtaskBody` / `updateSubtaskBody`
  accept ISO `startDate` / `endDate` (nullable | optional). Cross-field
  `endNotBeforeStart` refine on both shapes; update body still requires
  at least one field.
- `schemas/projects.ts` — new shared `budgetSchema` (regex-validated
  `^\d+(\.\d{1,2})?$`, non-negative) reused by `createProjectBody` and
  `updateProjectBody`; `projectResponse` extended with
  `plannedBudget` / `actualSpent` (nullable strings — Decimal precision
  preserved on the wire).
- `services/subtasksService.ts` — `create()` and `update()` accept the
  new date pair; `update()` re-validates the *merged* row so a PATCH
  that only sets one side still 400s if it inverts the window.
  `SubtaskView` now exposes `startDate` / `endDate` as ISO strings.
- `services/projectsService.ts` — `create()` and `update()` accept
  budgets as `number | string | null`; `normaliseBudget()` coerces to
  `Prisma.Decimal | null`. `toView` emits fixed-2 strings so the SPA
  doesn't need to detect a fractional separator.
- `controllers/projectsController.ts` — `serialize` typed to flow the
  new string fields through.

### Frontend

- `features/subtasks/api.ts` — `Subtask` carries `startDate` / `endDate`;
  `createSubtask` and `updateSubtask` accept them.
- `features/tasks/api.ts` — `TaskSubtask` mirrors the new fields so the
  task detail view's nested subtask payload doesn't lose precision.
- `features/subtasks/SubtaskList.tsx` — each row gets a 📅 affordance
  that toggles an inline editor with two `ShamsiDatePicker`s plus
  Save / Clear / Cancel. When dates are set and the editor is closed,
  the row shows a compact `start → end` summary. Client-side mirror of
  the server's range rule disables Save when inverted.
- `features/projects/api.ts` — `Project` carries the budget pair;
  `createProject` and `updateProject` accept it.
- `pages/ProjectsPage.tsx` — New-project form gains two
  `<input type="number" min="0" step="0.01">` for the budgets. Each
  list row gets a `BudgetRow` component: read-only display when set
  ("Planned 1,000.00 · Spent 750.00 (75.0%)"; coloured green / amber /
  red depending on utilisation) with an inline Edit affordance for
  owners + admins. Hidden entirely when no budget is set and the
  caller can't edit (no per-row noise for non-editing viewers).

### Tests

- 6 new integration cases in `subtasks.test.ts`:
  - create with both dates (echoed back ISO)
  - create with no dates (legacy shape)
  - reject create when endDate < startDate
  - PATCH sets both dates
  - PATCH clears both dates with `null`
  - PATCH rejects when the *merged* (existing start + new end) window
    inverts — the v1.41 service-layer merged-row guard
- 6 new integration cases in `projects.test.ts`:
  - create with budgets returns fixed-2 strings (`"1000"` → `"1000.00"`,
    `250.5` → `"250.50"`)
  - create without budgets returns `null`
  - PATCH sets then PATCH `null` clears
  - reject negative
  - reject non-numeric string
  - reject more than 2 fractional digits

### Verified

- Backend: 46/46 in `subtasks.test.ts` + `projects.test.ts`; full suite
  383/389 (5 LDAP skipped, 1 flaky `backups.test.ts` that passes in
  isolation — pre-existing cross-file BACKUP_DIR contention, not
  v1.41-caused). Three pre-existing unrelated file errors (LDAP /
  updater) untouched.
- Frontend: `tsc --noEmit` clean; `vite build` clean (34.0s).
- Live smoke: deferred.

### Phase boundary notes

- The Subtask date range uses UTC midnight (same as Task dates) so a
  viewer in any timezone reads back the same calendar day.
- Currency unit / locale is not stored — `plannedBudget` and
  `actualSpent` are pure numbers. The SPA formats with the user's
  locale (`Number.toLocaleString`). If we later need a project-level
  currency, it lands as a small `Project.currency` enum or as an
  instance-wide setting.
- The DB `CHECK` constraints duplicate the service-layer rules. That's
  intentional: anyone writing to Postgres directly (admin scripts,
  failed migrations, future SDK clients) can't slip an invalid row past
  the schema.

## [1.40.0] — 2026-06-08

**Cross-team Projects page + About-version fix.**

The Projects page is no longer scoped to the current team. The list now
shows every project the caller can see across every team they belong to,
with a small team chip on each row. The New-project form keeps its own
team picker (which team to create into).

Also fixes the blank `VERSION` field on the About page: the running
container reads `TASKHUB_VERSION` from env, and docker-compose's
`${TASKHUB_VERSION:-}` defaulted to the empty string when the key was
missing from `.env` — which slipped past `process.env.X ?? 'dev'`.
Switched to `||` so empty also falls back to `'dev'`.

### Backend

- `services/projectsService.ts` — new `listAllVisible(callerUserId,
  callerGlobalRole)` returns rows joined to `team.{name,slug}`. Same
  ownership rule as v1.39's per-team list: non-ADMIN sees only their
  own projects; admin sees everything. Non-admins are additionally
  scoped to teams they actually belong to so an owner-orphaned project
  from a team they left doesn't surface.
- `controllers/projectsController.ts` — new `listAll` handler.
- `routes/projects.ts` — new `projectsCrossTeamRoutes` exporter mounted
  at `/api/projects` (no `:teamId` in the URL). `requireAuth` only —
  the service-layer scope already restricts what's returned.
- `schemas/projects.ts` — new `projectCrossTeamResponse` extending
  `projectResponse` with `teamName` + `teamSlug`.
- `app.ts` — register the new exporter at `prefix: '/projects'`.
- `routes/system.ts` + `services/updateCheckService.ts` — read
  `TASKHUB_VERSION` with `||` instead of `??` so an empty-string env
  value (the docker-compose default when `.env` is missing the key)
  also falls back to `'dev'` rather than rendering blank.

### Frontend

- `pages/ProjectsPage.tsx` — page-level team scope dropped. Reads
  `projectsApi.listAllProjects()` (new). Per-row team chip; delete
  mutation now takes `{teamId, projectId}` from the row. Per-row
  Accountable inline edit removed — that lives on the project detail
  page now (it needed currentTeam.members which no longer fit a
  cross-team list cleanly). New-project form keeps its team picker.
- `features/projects/api.ts` — new `listAllProjects()` +
  `ProjectCrossTeam` type.

### Tests

- 3 new integration tests in `projects.test.ts`:
  - MEMBER cross-team list returns their own projects across multiple
    teams, with the team name joined.
  - Global ADMIN sees every project on the instance.
  - User in zero teams gets `[]`, not 500.

### Verified

- Backend: 21/21 in `projects.test.ts` (8 v1.39 + 3 v1.40 + 10 pre-v1.39).
- Frontend: `tsc --noEmit` clean; `vite build` clean (14.7s).
- Live smoke: deferred.

### Phase boundary notes

- The Accountable inline-edit was removed from this list view to keep
  the cross-team rendering simple. If it's still wanted, the project
  detail page already supports it, and a follow-up could re-add an
  inline editor that fetches per-row team members lazily.
- The new endpoint does one Prisma `findMany` per request (joined to
  `team` + `accountable`). For non-admins it does an extra
  `teamMembership.findMany` to scope by team membership. At TaskHub's
  corpus sizes, both are noise.
- Admins skip the team-membership scope. They see every project on
  the instance even from teams they aren't members of — consistent
  with the per-team list's admin bypass.

## [1.39.0] — 2026-06-07 — BREAKING

**Project visibility tightening.** Pre-v1.39 every team member saw every
project in their team; team MANAGERs could also edit any project. As of
v1.39:

| Role | Sees in projects list | Can act on a project / its nested resources |
|---|---|---|
| Global ADMIN | every project in the team | every project (bypass) |
| Team MANAGER | only projects they own | only projects they own |
| Team MEMBER  | only projects they own | only projects they own |

The visibility rule cascades to every `/projects/:projectId/*` nested
endpoint (tasks, buckets, subtasks, comments, activity, attachments,
dependencies, recurrence, taskLabels) and to the bucket-by-id endpoints
that take only `:bucketId`. Non-owners get **404** (not 403) so the
existence of unseen projects is never leaked — matching the
projects-list and labels precedent.

This is a **hard cutover**: no feature flag, no soft transition. Team
MANAGERs who relied on cross-project edit rights will need to be made
project owners (via direct DB update for now — a project-transfer
endpoint can land in a later release if needed) or promoted to global
ADMIN.

### Backend

- `services/projectsService.ts` — `list()` filters by `ownerId === caller`
  for non-ADMINs; `get()` 404s non-owner non-admins; `update()` /
  `remove()` reuse `get()` so the v1.23 `project.edit` / `project.delete`
  / `project.set_accountable` permission checks are now dead code (a
  non-owner non-admin 404s at the gate). `userHasPermission` import
  dropped along with them.
- `services/projectsService.ts` — new `assertCallerCanAccess()` helper
  centralises the rule for direct service-layer callers.
- `controllers/projectsController.ts` — `list` and `get` now pass
  `req.user.sub` + `req.user.globalRole` into the service.
- `middleware/requireProjectAccess.ts` — new. Two exports:
  - `requireProjectAccess()` — for `/teams/:teamId/projects/:projectId/*`
    routes. One Prisma `findUnique` per nested-route request.
  - `requireBucketProjectAccess()` — sibling for the two bucket-by-id
    routes (PATCH/DELETE `/teams/:teamId/buckets/:bucketId`) where the
    URL has no `:projectId`. Looks up bucket → project → ownership.
- Route cascades — `addHook('preHandler', requireProjectAccess())`
  installed in: `routes/tasks.ts`, `routes/subtasks.ts`,
  `routes/comments.ts`, `routes/activity.ts`, `routes/attachments.ts`,
  `routes/dependencies.ts`, `routes/recurrence.ts`,
  `routes/buckets.ts` (projectBucketsRoutes), `routes/labels.ts`
  (taskLabelsRoutes only — the team-scoped labelsRoutes is unaffected).
  `routes/buckets.ts` (bucketByIdRoutes) uses
  `requireBucketProjectAccess()`.

### Frontend

- `pages/ProjectsPage.tsx` — drops the `isManager` bypass on `canEdit`.
  Edit/delete affordances now only render for `ownerId === user.id ||
  user.globalRole === 'ADMIN'`. Mirrors the new backend rule.

### Tests

- `tests/integration/projects.test.ts` — 3 existing PATCH/DELETE tests
  retitled and re-asserted (403 → 404, "visibility gate" suffix). 8 new
  v1.39 cases: admin-bypass list, MEMBER-only-own list, GET 404 vs
  ADMIN bypass, cascade-404 on `/tasks` and `/buckets`-POST and
  bucket-by-id PATCH, owner end-to-end.
- 22 existing integration tests restructured across `technician.test.ts`,
  `dateEditRestriction.test.ts`, `buckets.test.ts`,
  `dependencies.test.ts`, `tasks.test.ts`, `trash.test.ts`,
  `notifications.test.ts`, `attachments.test.ts`, `comments.test.ts`,
  `roles.test.ts` so the actor owns the project and reaches the
  permission/business rule actually under test. Three of the
  comments-MANAGER tests pivot the project ownership via a direct DB
  update (no project-transfer endpoint exists yet).

### Migration / Operator notes

- No schema migration. The visibility tightening is pure code.
- Existing data is unaffected — Project rows keep their `ownerId`.
  Owners and global ADMINs see everything they expect; only
  cross-owner MANAGER access is gone.
- The 404-on-cascade behaviour means malformed clients holding stale
  project IDs (URLs bookmarked before ownership change) get 404
  instead of 403 — same shape as `/projects/:badId` already returned.

### Verified

- `backend`: 369 pass, 5 skipped (LDAP). Three pre-existing unrelated
  test-file errors (`ldap.test.ts` needs a server, `updaterAuth` +
  `updaterUpgrade` are env-dependent) are not v1.39-caused.
- `frontend`: `tsc --noEmit` clean; `vite build` clean (29.7s).
- Live smoke: deferred to manual review.

### Phase boundary notes

- No project-ownership-transfer endpoint yet. The intended workflow for
  a project moving between owners is direct DB update by an admin (or
  manual via a future endpoint). If migration toil becomes real, an
  admin-only `POST /api/teams/:teamId/projects/:id/transfer` can land
  in v1.40 in a few lines.
- `Project.ownerId` is nullable (FK SetNull on user delete). An orphan
  project (owner deleted) is invisible to everyone except global
  ADMINs until reassigned. This matches the team-membership story.
- The cascade middleware adds one Prisma `findUnique({ select: {
  teamId, ownerId }})` per nested-route request. At the corpus sizes
  TaskHub targets, that's noise; if it becomes hot it can be cached
  per-request via `request.context`.

## [1.38.0] — 2026-06-09

**Brand: new "Quad" logo + split wordmark + favicon.** Cosmetic
release — no model, schema, endpoint, or contract changes. Replaces
the single-checkmark glyph that shipped in v1.31 with the Quad design
(four rounded squares, top-right carrying an indigo checkmark) and
adds the favicon the project never had.

### Frontend

- New `features/brand/BrandMark.tsx`:
  - `<BrandMark variant="filled" size={n} />` — standalone tile
    (indigo rounded square + four inner white-tint squares + indigo
    checkmark). Used by the sidebar header today; matches the
    favicon pixel-for-pixel.
  - `<BrandMark variant="inset" />` — transparent inner-only variant
    for callers that already provide a coloured backdrop. Stroke
    inherits `currentColor` so dark-mode overrides are one rule away.
  - New `<BrandWordmark name={t('app.name')} />` — when the
    localised name is exactly `"TaskHub"`, renders "Task" in the
    surrounding text colour and `Hub` in indigo (matches the
    dribbble lockup). Persian (`تسک‌هاب`) renders flat — the two-
    syllable split doesn't transfer.
- `features/nav/LeftSidebar.tsx` — replaces the inline checkmark SVG
  + plain text wordmark with `<BrandMark variant="filled" />` and
  `<BrandWordmark />`. The 28-pixel tile slots into the existing
  14-pixel header without layout shift.
- `index.html` — new `<link rel="icon" type="image/svg+xml" ...>`
  pointing at an inline SVG data URI that mirrors the filled BrandMark
  exactly. No new binary asset; the project's `public/` directory stays
  doc-only.

### Verified

- Frontend `tsc --noEmit` ✅.
- Served HTML carries the SVG favicon (`rel="icon" type="image/svg+xml"`).
- Production bundle markers: `>Hub<` wordmark split (1), `#6366f1`
  indigo tile fill (1).
- No backend, schema, or contract changes — no tests required.

### Phase boundary

- **Two sources of truth for the SVG geometry.** The favicon (data URI
  in `index.html`) and the `<BrandMark variant="filled">` React
  component share the same coordinates by hand. If we ever need to
  re-tweak the design, both have to be updated together. Worth it
  vs. adding a build step that injects the data URI from the
  component.
- **No multi-colour Quad variant.** The dribbble lockup also showed a
  multi-colour version (blue / purple / teal / orange inner squares).
  Not used in the app yet; the monochrome / split-opacity rendering
  reads better at the 28px sizes the sidebar uses.
- **No login-page lockup.** LoginPage doesn't show a brand header
  today (only the form). If we want to add one, `<BrandMark
  variant="filled" />` + `<BrandWordmark />` drop in directly.
- **Wordmark split is English-only.** Other future locales render the
  app name flat. Easy to extend: add the locale code to the
  `BrandWordmark` matcher.

## [1.37.0] — 2026-06-09

**Task.startDate.** Tier-1 sub-feature 4 (Task progress/status + start
date + reminders) lands as a gap-closer — the other two-thirds of the
spec (status enum, reminder mechanism) were already in place from
earlier releases, so all that remained was the start-date field.

### What was already there (and stayed)

- **Status enum** — `Task.status` is 4-state (`TODO` / `IN_PROGRESS` /
  `REVIEW` / `DONE`). The Tier-1 spec called for a 3-state
  (`NOT_STARTED` / `IN_PROGRESS` / `COMPLETED`); the existing 4-state
  is a superset (`NOT_STARTED ≈ TODO`, `COMPLETED ≈ DONE`, plus an
  explicit `REVIEW`) and is referenced by every kanban, report,
  webhook, and notification path. Not changing.
- **Reminder mechanism** — `scheduler/dueDateScheduler.ts` already
  polls in-process, fires `TASK_DUE` notifications via
  `notificationsService.onTaskDue` for tasks whose `dueDate` is in
  the lead window and whose `dueNotifiedAt` is null, then stamps to
  prevent re-fires. One-shot per `(taskId, dueDate)`. That's exactly
  the spec's "reminder fires once relative to due date." Reused.
- **Card progress** — inline `☑ done/total` count from subtasks
  already on Buckets + Kanban cards (shipped in earlier releases).
  The spec mentioned "progress ring"; the count is more precise and
  was kept.

### Backend

- **Migration** `20260609000000_task_start_date` — `ALTER TABLE
  "Task" ADD COLUMN "startDate" TIMESTAMP(3);`. Purely additive,
  nullable, no backfill, no index (no scheduler/report consumes it
  yet).
- `schemas/tasks.ts` — `startDate` added to `createTaskBody`,
  `updateTaskBody`, and `taskResponse` as
  `z.string().datetime().nullable().optional()` (or `.nullable()` on
  the response).
- `services/tasksService.ts`:
  - `TasksService.create` accepts `startDate` and writes it to the
    new column.
  - `TasksService.update` accepts `startDate`, applies the same v1.18
    **manager-only date-edit gate** (`assertCanEditDate`) as
    `dueDate` / `plannedDate` / `completedAt`, and includes it in the
    `task.updated` audit-log changed-fields list.
- `controllers/tasksController.ts` — `serialize()` includes
  `startDate` in the ISO-conversion list.

### Frontend

- `features/tasks/api.ts` — `Task.startDate: string | null` on the
  interface; `createTask` and `updateTask` input types accept
  `startDate?: string | null`.
- `pages/TaskDetailPage.tsx`:
  - Inline `Started …` chip in the metadata row alongside
    Due / Planned / Completed.
  - **Dates section** grid widens from 3 columns to 4 to fit the new
    "Started on" picker. Reuses the existing `DatePickerField` /
    `ShamsiDatePicker` plumbing — same Save/Clear semantics, same
    v1.18 gate surfaced as a 403 if a non-manager attempts to change
    a non-null value.
- `features/buckets/BucketBoard.tsx` — small **🚀 pill** on each
  Buckets card when `task.startDate` is present, sitting just left of
  the existing `📅 due` pill. The bottom meta row is wrapped with
  `flex-wrap` so the extra pill flows cleanly on narrow cards.

### Tests

- `tasks.test.ts` gains 3 new cases:
  - **Create with startDate** → 201; response surfaces the ISO value.
  - **Create without startDate** → 201; response carries `null`.
  - **PATCH startDate → ISO** then **PATCH null** → both 200; values
    round-trip.
- Adjacent suite regression check: buckets (20) + subtasks (13) +
  dateEditRestriction (X) + reportsCsv (X) → **46/46 still pass**.
- Tasks suite total: **17/17 pass**.

### Verified

- Backend `tsc` ✅; frontend `tsc --noEmit` ✅.
- Production bundle markers: `Started on` label (2),
  `startDate` identifier (9). The 🚀 emoji shows in the rendered UI
  but the regex scan can't easily count non-ASCII via PowerShell.

### Phase boundary

- **No new reminder.** The Tier-1 spec mentioned "reminders" but the
  existing `dueDateScheduler` already fits the spec's "fires once
  relative to due date" description exactly. Adding a duplicate or a
  startDate-relative reminder is feature creep we're not paying for.
- **No new status enum.** Existing 4-state stays; switching to the
  spec's 3-state would break every kanban, report, and webhook.
- **No progress ring.** The inline `☑ done/total` count from subtasks
  is more precise and already on every card.
- **No cross-field validation.** `startDate` can be after `dueDate`
  if a team wants to mark a behind-plan task explicitly. The UI
  doesn't warn; we trust the user.
- **No auto-set on status transitions.** Setting `status = IN_PROGRESS`
  does NOT auto-stamp `startDate`. Surprising automation hurts more
  than it helps; user-entered only.
- **Calendar feed unchanged.** `GET /teams/:teamId/calendar` still
  reads `dueDate` / `plannedDate` only. Adding a fourth field would
  muddy the grid; deferred.
- **No `?field=start` for the reports endpoints.** Reports remain on
  `dueDate` / `plannedDate` / `completedAt`. The startDate field is
  informational for now.

## [1.36.0] — 2026-06-08

**Labels: management page + board filter.** Tier-1 sub-feature 3
(Labels / category tags) lands as a gap-closer — `Label` + `TaskLabel`
+ CRUD endpoints + per-task `LabelPicker` were already shipped in
earlier releases. This release adds the missing pieces: a standalone
management UI and a board-level filter.

### What was already there (and stayed)

- `Label` model (**team-scoped**, not project-scoped as the original
  Tier-1.3 spec suggested) + `TaskLabel` join, both indexed.
- `GET/POST/PATCH/DELETE /api/teams/:teamId/labels` (full CRUD) +
  attach/detach endpoints on tasks. Labels exposed inline on every
  Task response via `TASK_INCLUDE`.
- `features/labels/LabelChip.tsx` rendering colored chips on Buckets
  cards (v1.34.3) and Kanban cards.
- `features/labels/LabelPicker.tsx` for per-task attach/detach +
  inline label-creation.

### Why team-scoped, not project-scoped

The Tier-1 spec said "project-scoped"; the codebase chose team-scoped
in v1.x. Team-wide labels (`bug`, `feature`, `customer`, `tech-debt`)
are typically organisation vocabulary — forcing project scope would
mean recreating "bug" 50 times across projects. Team-scoped also
avoids a destructive migration this late in the project. We keep
team-scoped; documented here for posterity.

### Frontend

- New `features/labels/api.ts` client `updateLabel(teamId, labelId, {
  name?, color? })` — the backend PATCH was already there; the client
  wrapper just hadn't been written.
- New `pages/settings/LabelsPage.tsx` under Settings → **Labels**:
  - Lists every team label as a row: chip preview · click-to-rename
    inline (Enter/Esc/blur) · `<input type="color">` for instant
    recolour · delete with confirm.
  - Trailing inline create form (name + color picker + Add).
  - Dark-mode polish.
- `features/settings/SettingsLayout.tsx` — new sidebar entry visible
  to every team member (label endpoints have no permission gate
  today; matches `LabelPicker` semantics).
- `app/router.tsx` — registers `/settings/labels` under the existing
  `SettingsLayout`.
- `pages/TasksPage.tsx` — new label filter strip above the board.
  Clickable chips toggle inclusion in `?labels=id1,id2` (URL state,
  shareable). OR semantics: a task is shown if it carries at least
  one selected label. Affects every view-mode (Kanban / List / by
  Technician / Buckets) via a single `filteredTasks` derivation —
  Buckets gets the filter via a new optional `filterLabelIds` prop
  on `BucketBoard`.
- `features/buckets/BucketBoard.tsx` — gains `filterLabelIds?:
  string[] | null` prop. Applies the same OR filter inside before
  grouping by bucket.
- `i18n/en.json` + `i18n/fa.json` — new keys: `settings.nav.labels` /
  `settings.nav.labelsDesc`, `labels.title` / `labels.subtitle` /
  `labels.empty` / `labels.selectTeam` / `labels.rename` /
  `labels.recolor` / `labels.delete` / `labels.deleteConfirm` (with
  `{name}` placeholder) / `labels.newPlaceholder` / `labels.color` /
  `labels.add` / `labels.adding` / `labels.filterBy` /
  `labels.clearFilter`. Persian translations included.

### Verified

- Frontend `tsc --noEmit` ✅.
- Production bundle markers: `/settings/labels` (1),
  `labels.filterBy` (3 — JSON catalog + render site + key string),
  `labels.deleteConfirm` (3).
- Backend untouched. The existing `labels.test.ts` continues to
  cover every endpoint.

### Phase boundary

- **No model migration.** `Label` stays team-scoped. Project-scoping
  would mean a destructive migration and recreating shared vocabulary
  across many projects — not worth the cost.
- **No `taskCount` on `GET /labels`.** The delete-confirm copy is
  generic ("removed from every task that uses it") rather than
  citing a count, so we don't need the backend join. Adding counts
  to the response is a one-line follow-up if the UI asks for it.
- **OR-semantic filter only.** A task matches if it has ANY selected
  label. AND-semantic ("must have all of") can be added later if
  anyone asks.
- **No filter affordance for "unlabeled" tasks.** A "no label" pill
  in the strip would let users find tasks without tags — small
  follow-up.
- **No labels in the URL pre-fill via `Label.id` validation.** If
  a stale URL references a label that's been deleted, the
  selection is silently dropped on next render — we filter against
  the live `teamLabels` list before applying.
- **No bulk label apply.** Multi-select on cards + "Apply label X to
  all" is a future polish.
- **`LabelsPage` does not gate on permission.** The backend doesn't
  yet have a `labels.manage` permission constant — every team
  member can manage. Add a `labels.manage` perm in a future release
  if you want manager-only label edits, mirroring the
  `buckets.manage` pattern from v1.34.0.

## [1.35.0] — 2026-06-08

**Subtasks: reorder + UI polish.** Tier-1 sub-feature 2 (Checklists /
subtasks) lands as a gap-closer rather than a rebuild — the `Subtask`
model and CRUD endpoints already shipped in earlier releases.

### What was already there (and stayed)

- `Subtask` Prisma model (id, taskId FK, `title`, `done`, `position`,
  technicianId/Name) with cascade-on-task-delete and the relevant
  indexes. The original Tier-1.2 spec called this `ChecklistItem`
  (`text` / `order`) — same shape; the spec is honoured by mapping
  the fields onto the existing names rather than adding a parallel
  model.
- `POST/PATCH/DELETE /api/teams/:teamId/projects/:projectId/tasks/:taskId/subtasks(/...)` —
  create / toggle / edit text / change technician / delete.
- Subtask array returned inline on every Task response
  (`TASK_INCLUDE.subtasks`).
- Inline `☑ done/total` count on both Kanban and Buckets cards
  (Kanban was earlier; Buckets shipped in v1.34.3).

### Backend

- **New endpoint** `PATCH /api/teams/:teamId/projects/:projectId/tasks/:taskId/subtasks/reorder`
  — full-permutation, strict mode. Body `{ subtaskIds: string[] }`
  must contain every subtaskId for the parent task in the desired
  order. Duplicate / missing / foreign id → **400**. Mirrors the
  bucket reorder contract from v1.34.0.
- Two-phase write inside one `prisma.$transaction`: bump every row
  to `position += 1_000_000` (collision-free temporary range), then
  settle to `(i + 1) * POSITION_GAP` in the requested order.
  `Subtask.position` stays a non-unique sort key — matches
  `Task.position` / `Bucket.order` precedent.
- No model, schema, or migration change.

### Frontend

- `features/subtasks/SubtaskList.tsx` rewritten with `@dnd-kit`:
  - Each row gets a `⋮⋮` drag handle and a sortable wrapper.
  - On drop, the client computes the full permutation locally + fires
    one `PATCH /subtasks/reorder`. On 400 the list rolls back via
    `onChange()` (the parent task query refetches).
  - Local-order state mirrors props between drags so a server refetch
    can't stomp a mid-drag order.
  - Dark-mode polish on the checkbox row + add-subtask form.
- `features/subtasks/api.ts` — new `reorderSubtasks` client.
- Inline `☑ done/total` count on Kanban cards — already shipped
  earlier; verified present in the bundle.

### Tests

- `subtasks.test.ts` gains 6 new cases:
  - Happy path: positions follow the requested permutation; no duplicate
    position values left in the task (via `groupBy`).
  - Missing id → 400.
  - Duplicate id → 400.
  - Foreign id (from another task on the same project) → 400.
  - Cross-tenant: another team's caller → 403 at `requireTeamRole`.
  - Parent task missing in the chain → 404.
- Full subtasks suite: **13/13 pass**.

### Verified

- Backend `tsc` ✅; frontend `tsc --noEmit` ✅.
- Production bundle markers: `/subtasks/reorder` path (1),
  `subtaskIds` body field (1), `☑` count badge already in place.

### Phase boundary

- **No parallel `ChecklistItem` model.** Reusing the existing
  `Subtask` (mapping `text` → `title`, `order` → `position`) avoids
  fragmenting the schema. UI labelling stays "Subtasks" for
  continuity.
- **`Subtask.position` is a non-unique sort key.** Concurrent
  reorders settle to one of the two orderings depending on commit
  interleaving — same trade-off as Bucket.order and Task.position.
- **No per-subtask assignment in this release**, even though the
  model carries `technicianId` (from v1.19). Out of scope; the
  existing PATCH supports it for clients that need it.
- **No optimistic reorder.** The list applies the move locally for
  paint smoothness; on server error it rolls back via the parent
  refetch. A real optimistic mutation (server response writes back
  into cache) is a follow-up if it ever feels laggy.
- **Within-bucket card reorder is still not wired in Buckets view.**
  Status (Kanban) remains the authoritative task-position surface.

## [1.34.3] — 2026-06-08

**Buckets, Planner-style: default view + card polish + `+ Add task` per column.**
Tier-1.1 (Buckets) UX iteration. Combines two parallel changes that
together produce the "open a project → see the board" feel of
Microsoft Planner.

### Backend

- `POST /api/teams/:teamId/projects/:projectId/tasks` now accepts an
  optional `bucketId` in the body. Validation mirrors the v1.34.0 PATCH
  path: omitted / `null` = unbucketed, string = pre-bucket the new
  task (cross-project → 400, cross-team → 404). One round-trip instead
  of create + PATCH.
- No schema change. The `Task.bucketId` column from v1.34.0 carries it.

### Frontend

- `pages/TasksPage.tsx` — the default view-mode is now **Buckets**.
  Users with a stored `kanban.viewMode` preference keep their choice;
  fresh installs and new users land in Buckets — matches Planner's
  "open a plan, see the board" UX.
- `features/buckets/BucketBoard.tsx` — substantial polish:
  - **`+ Add task` inline form inside each bucket column** (and inside
    the unbucketed column when it has tasks). Submits via the new
    create-with-bucketId path so the task lands in the right column on
    the first round-trip.
  - **`(unbucketed)` column is hidden when empty.** Planner doesn't
    have one. Keeping it for pre-v1.34.0 tasks (`bucketId === NULL`)
    so they remain visible until you bucket them; otherwise the UI
    stays clean.
  - **Card polish:**
    - Priority shown as a small colored dot (`bg-slate-400` /
      `bg-amber-500` / `bg-red-600`) at the top-left instead of a text
      label.
    - Due-date pill at the bottom (`📅 1404/03/17`) — red border +
      text when the task is overdue and not done.
    - Inline checklist count `☑ 3/5` rendered from existing `Subtask`
      data (no new endpoint).
    - Technician initials in a small circular avatar at the bottom-
      right.
    - Blocker lock badge `🔒 N` carried over from v1.34.1.
  - `PRIORITY_CLASS` text-coloring lookup retired; the dot replaces it.
- `features/tasks/api.ts` — `createTask` input type accepts
  `bucketId: string | null`.
- `i18n/en.json` + `i18n/fa.json` — two new keys: `buckets.addTask`
  (en "Add task", fa "افزودن تسک") and `buckets.taskPlaceholder`
  (en "Enter a task title…", fa "عنوان تسک را وارد کنید…").

### Tests

- New cases in `buckets.test.ts` covering the create-with-bucketId
  path: happy path, cross-project 400, cross-team 404, omitted
  bucketId = unbucketed. Full buckets + tasks suites: **34/34 pass**.

### Verified

- Backend `tsc` ✅; frontend `tsc --noEmit` ✅.
- Production bundle markers: `buckets.addTask` (3), `buckets.taskPlaceholder`
  (3), priority-dot classes present.
- Backend regression: `tasks.test.ts` and `buckets.test.ts` together
  34/34.

### Phase boundary

- **Buckets is the new default view.** Users who previously toggled
  away keep their stored preference. There's no migration of
  `kanban.viewMode` from "status" → "buckets" — the stored value still
  wins for the user's existing session, so this is purely a new-user
  default change.
- **The unbucketed column shows whenever it has tasks** — so old
  pre-v1.34.0 tasks remain visible. A future "Migrate unbucketed" UI
  affordance (bulk-assign to a bucket) is the natural follow-up if
  operators want to converge to "every task lives in a bucket."
- **Card avatar shows the technician**, not the assignee. Backend
  denormalizes `technicianName` onto every `Task` response; assignee
  name isn't denormalised. The technician is "the person actually
  doing the work" (per v1.19), which is the more useful badge on a
  glance-board.
- **No optimistic create.** The "+ Add task" PATCHes synchronously
  and the card appears after the invalidation. Optimistic create is a
  follow-up if it feels slow in real use.
- **Within-column card reorder is still not wired in Buckets view.**
  The Status (Kanban) view remains the authoritative position-reorder
  surface.

## [1.34.2] — 2026-06-08

**Buckets on the Projects page: per-row strip + "Manage →" deep-link.**
Small UX add-on to v1.34.1. No backend, no schema, no contract change —
reuses the v1.34.0 endpoints.

### Frontend

- New `features/buckets/ProjectBucketStrip.tsx` — a compact row of
  chips rendered under each project on `/projects`. Per project it
  surfaces:
  - One chip per `Bucket` (ordered by `order` asc).
  - Click a chip name → inline rename (Enter saves, Esc cancels,
    blur saves). The trailing `×` deletes with a confirm — tasks fall
    back to unbucketed via the existing FK SET NULL.
  - A trailing "+ Add bucket" pill that opens a tiny inline input.
  - A right-aligned **Manage →** link that deep-links to the
    project's task page in Buckets view (full DnD reorder lives there).
- `pages/ProjectsPage.tsx` renders the strip under each project row.
  `teamId` comes from the page-level `currentTeam` since the project
  list is currentTeam-scoped (every rendered row shares the same
  `teamId`).
- `pages/TasksPage.tsx` now honours `?view=` on the URL — the
  Manage → link drops you straight into the Buckets view. Honored
  values: `status` / `technician` / `list` / `buckets`. The URL
  param wins over the stored `kanban.viewMode` preference on first
  render only; subsequent toggles persist as usual.
- One new i18n key: `buckets.manage` (Persian: مدیریت). Persian
  translations of all v1.34.1 keys remain in place.

### Verified

- Frontend `tsc --noEmit` ✅.
- Production bundle markers: `?view=buckets` deep-link target (1),
  `buckets.manage` key (3), URL-param reader present.
- Backend untouched — v1.34.0 endpoints, v1.34.1 backend invariant
  unchanged.

### Phase boundary

- **No reorder on the Projects page strip.** The BucketBoard
  (TasksPage view-mode "Buckets") remains the authoritative
  drag-and-drop surface for ordering. The strip is for "name
  management" — add, rename, remove.
- **No per-bucket task counts on the projects page.** Counts would
  require fetching every project's task list per row, which doesn't
  scale on a busy team. Counts live on the BucketBoard itself.
- **Strip query is per-project**, so a Projects page with N projects
  fires N parallel `listBuckets` calls. `staleTime: 60_000` caps the
  refetch rate on revisit, but at extreme N this becomes a request
  storm. For instances with hundreds of projects we'd want a
  team-level "list buckets across all my projects" endpoint —
  deferred until it's actually a problem.
- **Affordance gating is inline-403**, not a pre-check. Same pattern
  as every other gated affordance today.

## [1.34.1] — 2026-06-08

**Buckets frontend: board grouping + drag-and-drop reorder.** Follow-up
to the v1.34.0 backend-only API. No backend or schema changes — the UI
talks to the existing endpoints.

### Frontend

- `pages/TasksPage.tsx` — `viewMode` gains a fourth option **Buckets**
  alongside Kanban / List / by Technician. Persists in localStorage
  under `kanban.viewMode` (existing key — values `'status' |
  'technician' | 'list' | 'buckets'`).
- `features/buckets/api.ts` — typed client for the v1.34.0 endpoints
  (`listBuckets`, `createBucket`, `renameBucket`, `reorderBuckets`,
  `deleteBucket`).
- `features/buckets/BucketBoard.tsx` — the new board layout:
  - Leading **(unbucketed)** column for tasks with `bucketId === null`,
    followed by one column per `Bucket` ordered by `order` asc.
  - Drag a task across columns → `PATCH /tasks/:taskId { bucketId }`.
  - Drag a column header → optimistic reorder + a single
    `PATCH /buckets/reorder` with the full new permutation (matches the
    backend's strict-permutation contract). Rolls back on 400 via
    react-query invalidation.
  - Inline rename on column header (Enter saves, Esc cancels, blur saves).
  - Delete button (× with confirmation) — tasks fall back to unbucketed
    via the FK SET NULL.
  - Add-bucket affordance appended at the end of the row.
- `features/tasks/api.ts` — `Task.bucketId` now part of the interface;
  `updateTask`'s input type accepts `bucketId: string | null`.
- `i18n/en.json` + `i18n/fa.json` — 9 new keys (`tasks.view.buckets`,
  `buckets.add`, `buckets.adding`, `buckets.newPlaceholder`,
  `buckets.unbucketed`, `buckets.deleteConfirm` with `{name}`
  placeholder, `buckets.empty`, `buckets.rename`, `buckets.delete`,
  `buckets.dragHandle`). Persian translations included.

### Verified

- Frontend `tsc --noEmit` ✅.
- Production bundle markers present (`__unbucketed__` sentinel,
  `/buckets/reorder` path, `tasks.view.buckets` toggle key).
- Backend untouched — `buckets.test.ts` still 16/16 from v1.34.0.

### Phase boundary

- **Cross-bucket move + reposition is two PATCHes**, not one. The
  bucketId change fires first, then the position reorder if needed.
  The backend already supports both fields on `PATCH /tasks/:taskId`;
  merging into one call is a frontend-only follow-up if the dual
  round-trip becomes noticeable.
- **Within-column reorder in Buckets view is intentionally not wired.**
  The Kanban (Status) view remains the authoritative position-reorder
  surface. Buckets focuses on cross-bucket moves; the card list within
  a bucket sorts by server-supplied `position` asc.
- **Default view-mode stays Status (Kanban).** Existing users see no
  behavioural change unless they opt into Buckets via the toggle.
- **No optimistic task move across columns.** The card flickers until
  the PATCH response lands. Optimistic move can be added later if it
  feels laggy.
- **No per-bucket "+ Add task" affordance.** The existing top form
  still creates the task; cross-form bucket selection ships when the
  task-create form gains a bucket dropdown (separate PR).
- **No saved per-user column collapse state.** All columns are always
  visible.
- **Affordance gating uses inline 403 fallback**, not a pre-check. We
  don't yet have a "list my permissions" hook; create/rename/reorder/
  delete affordances are always shown and a 403 surfaces as an inline
  toast. Same pattern other gated affordances use today.

## [1.34.0] — 2026-06-08

**Buckets: per-project task grouping.** Projects can now define ordered
buckets (lightweight columns independent of `status`). Tasks carry an
optional `bucketId`; deleting a bucket leaves its tasks unbucketed
rather than removing them. Tier 1 sub-feature 1; checklists, labels,
and start-date/reminders ship in separate releases.

### Backend

- New Prisma model `Bucket` (project-scoped, denormalized `teamId`,
  `order: Int`). Migration `20260608000000_buckets` adds the table +
  nullable `Task.bucketId` with `ON DELETE SET NULL`. Purely additive
  on existing data — no NOT NULL constraint, no backfill, existing
  tasks default to unbucketed.
- New `Task @@index([projectId, bucketId, position])` mirrors the
  existing `(projectId, status, position)` kanban index for
  bucket-grouped board reads.
- New permission `buckets.manage` (default-granted to MANAGER and
  MEMBER — matches Labels parity, any team member can curate the
  project's column layout). Migration backfills the permission into
  every existing system Manager + Member role so default behaviour
  doesn't change.
- New endpoints:
  - `GET    /api/teams/:teamId/projects/:projectId/buckets` — list,
    sorted by `order` asc. Implicit team-member capability.
  - `POST   /api/teams/:teamId/projects/:projectId/buckets` — create.
    Server assigns `order = max(order) + 1` within the project.
  - `PATCH  /api/teams/:teamId/projects/:projectId/buckets/reorder` —
    full-permutation bulk reorder. Strict mode: rejects duplicate /
    missing / foreign ids with 400. Two-phase write inside a single
    transaction (bump everyone to a collision-free range, then settle
    to `0..n-1`) so no intermediate state has duplicate `order` values.
  - `PATCH  /api/teams/:teamId/buckets/:bucketId` — rename.
  - `DELETE /api/teams/:teamId/buckets/:bucketId` — remove. Tasks
    fall back to `bucketId: null` via the FK SET NULL — they survive
    in the project, unbucketed.
- Cross-team scoping: a bucket whose project lives in another team
  returns **404** (never 403) — matches the projects/labels precedent.
- `PATCH /api/teams/:teamId/projects/:projectId/tasks/:taskId` accepts
  `bucketId: string | null`. `null` unbuckets, omission is a no-op,
  string moves the task. Service validates the target bucket belongs to
  the same project (cross-project → 400) and the same team
  (cross-team → 404). The move is recorded under the regular
  `task.updated` activity action with `bucketId` in the changed-fields
  list.
- `Task` response now carries `bucketId: string | null`.

### Tests

- New `backend/tests/integration/buckets.test.ts` — 16 cases covering:
  - Create with monotonic `order`, list returns sorted, name length
    validation.
  - Rename with `updatedAt` advance; cross-tenant 404.
  - Cross-team URL/project mismatch → 404; non-member → 403.
  - Reorder happy path (no duplicate `order` values left in DB);
    missing / duplicate / foreign id → 400.
  - Delete preserves tasks (`bucketId` becomes null, task survives);
    cross-tenant DELETE → 404.
  - Task PATCH `bucketId`: string moves, null unbuckets, cross-project
    → 400, cross-team → 404.
  - RBAC: member with a custom role that lacks `buckets.manage` gets
    403 on every write; reads still 200. Global ADMIN bypasses even
    when the permission is revoked on the team role.
- Updated `roles.test.ts` — permission catalog count 16 → 17, added
  `buckets.manage` assertion under the Projects group.

### Verified

- Backend `tsc` ✅; frontend `tsc --noEmit` ✅.
- `buckets.test.ts` 16/16. Adjacent suites (tasks + roles + labels +
  projects) all green: **62/62**.

### Phase boundary

- **`Bucket.order` is a sort key, not unique.** Concurrent reorders
  use a two-phase update so no intermediate state has duplicates, but
  the index doesn't enforce uniqueness — matches `Task.position`
  precedent. A racy "both clients sent valid permutations within
  milliseconds" still settles to one of the two orderings depending on
  commit interleaving.
- **No bucket-specific activity rows.** Bucket create / rename /
  delete don't write to the `Activity` log; task moves between buckets
  appear under the existing `task.updated` action with `bucketId` in
  the changed-fields list. A dedicated `bucket.*` activity stream is
  the natural follow-up if the audit log grows a "config changes"
  filter.
- **No per-user bucket views.** Buckets are project-global; saved
  per-user collapse state, personal ordering, and personal filters
  are deferred.
- **No archived/hidden buckets.** Delete is the only removal.
- **Drag-and-drop optimistic UI deferred.** The frontend will ship in
  a separate PR; the API contract (full-permutation reorder) is the
  one the DnD layer will send.
- **Frontend untouched in this release.** Backend-only landing so we
  can review the API shape before the UI lands.

## [1.33.0] — 2026-06-07

**Two frontend conveniences: a "by team" calendar view and a project-form
team picker.** No backend changes; both fall out of data the existing
endpoints already return.

### Frontend — Calendar: team selector

- `pages/CalendarPage.tsx` — the old single-team feed is now selectable
  via a labelled `<select>` listing every team the caller belongs to,
  with an "All my teams" entry at the top.
- Picking a specific team only re-scopes the calendar — the global
  `currentTeam` (sidebar context) is untouched, so the rest of the app
  stays where it was.
- Picking "All my teams" fans out via `useQueries` across every team,
  merges client-side, and shows a per-team color legend above the grid
  (using each task's existing `teamColor` field — no new endpoint).
- Selection persists in `localStorage` under `calendar.selectedTeam`.
  A stale-storage effect resets the selection if it points at a team
  the user has since been removed from (avoids 403 queries).
- Empty-team guard relaxed: with "All my teams" available, the page no
  longer requires a `currentTeam` selection to render.

### Frontend — Projects: per-form team picker

- `pages/ProjectsPage.tsx` — the **New project** form gains a team
  picker independent of the page-level `currentTeam`. Only rendered
  when the user belongs to more than one team (single-team users see
  the form unchanged).
- The **Accountable** dropdown reads members from the team selected
  in the form, not the page's `currentTeam`. Switching the picker
  re-fetches via the cached `getTeam(teamId)` query and clears the
  previously-selected accountable (who almost certainly isn't a
  member of the new team).
- On successful create in a team other than the page's current team,
  the page context switches to that team via `setCurrentTeamId(...)`
  so the freshly-created project appears in the "All projects" list
  immediately — no extra click.

### Verified

- Backend `tsc` ✅; frontend `tsc --noEmit` ✅.
- No backend route or schema changes.

### Phase boundary

- **Calendar fan-out scales with team count.** For users in 20+ teams
  the right next step is a dedicated `GET /api/calendar/me` endpoint
  with a single server-side join. Trivial follow-up.
- **Date-field choice (due / planned)** is global across teams in
  "All my teams" mode — no per-team override.
- **No multi-team subset filter** in the calendar. Selection is binary:
  one team OR all teams.
- **New-project picker** lists every team the user belongs to. The
  server still enforces the per-team permission to create projects;
  if a team's role doesn't permit creation, the call returns 403 and
  the error surfaces inline.

## [1.32.3] — 2026-06-07

**All-in-one backups (DB + uploads + secrets) + restore-into-seeded fix.**

Two operational problems became one release:

1. Cross-server restores silently broke 2FA + LDAP because `MASTER_KEY`
   only lives in `.env` (not the DB), and attachment downloads 404'd
   because the `uploads_data` Docker volume wasn't part of the backup.
2. Restoring a backup onto a freshly-seeded instance failed with
   `cannot drop constraint Role_pkey on table public."Role" because
   other objects depend on it` — `pg_restore --clean --exit-on-error`
   couldn't drop the destination's pre-existing `DirectoryGroupMapping
   → Role` FK in the right order.

### Backend

- **New bundled backup format** `taskhub-{ts}.tar.gz` containing:
  - `database.dump` — the existing `pg_dump --format=custom` output.
  - `uploads/` — copy of `UPLOAD_DIR` (every attachment blob).
  - `secrets.env` — `MASTER_KEY`, `JWT_ACCESS_SECRET`,
    `JWT_REFRESH_SECRET`. Written `chmod 0600`. **NOT included:**
    `POSTGRES_PASSWORD` / `DATABASE_URL` (per-host config).
  - `manifest.json` — `{version, createdAt, includes: {database,
    uploads, secrets}}`.
- **Legacy `.dump` files still restorable** — the restore endpoint
  auto-detects format by filename suffix. Admin uploads of older `.dump`
  files round-trip too; uploads of `.tar.gz` preserve the suffix
  through the on-disk rename.
- **Schema-wipe before `pg_restore`.** A new private
  `wipeSchema()` step runs `DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;` via `psql -v ON_ERROR_STOP=1` against the
  cleaned libpq URL. Schema name is whitelisted to `[A-Za-z_]
  [A-Za-z0-9_]*` before interpolation so a hostile config value can't
  inject SQL.
  - Removed `--clean --if-exists` from the `pg_restore` invocation
    (no-op against the now-empty schema; was the source of the
    constraint-drop failure).
- **Restore response** carries new fields: `uploadsRestored: boolean`,
  `secretsApplied: boolean`, `secretsSidecar: string | null`.
- **Secrets sidecar.** When the bundle ships secrets, the restore
  writes them as `restored-secrets.env` next to the backups
  (chmod 0600). The operator copies the lines into `.env` and lets
  the post-restore graceful exit recycle the container with the new
  env. We don't auto-apply because env is read once at boot — there
  is no honest way to re-read it inside the running process.
- **Service constructor** gains a `BackupsServiceConfig` third arg
  (`uploadDir`, `secrets`) — backward-compatible, defaults to
  database-only when omitted (tests that don't pass it keep working).
- **Scheduled backups** (`server.ts`) and the admin route
  (`routes/backups.ts`) both pass the env-derived config now, so the
  nightly tick produces full restore-anywhere artefacts.

### Frontend

- `BackupsPage.tsx` — the post-restore alert now surfaces what landed
  (uploads, secrets sidecar path, next-step instructions to apply
  secrets and restart). Falls back to the original one-line message
  for legacy `.dump` restores.
- `features/backups/api.ts` — `RestoreResult` interface gains
  `uploadsRestored`, `secretsApplied`, `secretsSidecar`.

### Tests

- New cases in `backups.test.ts`:
  - `list` returns both `.dump` and `.tar.gz` files; unrelated
    suffixes still ignored.
  - upload preserves `.tar.gz` suffix when sanitising the on-disk name.
  - restore of a missing `.tar.gz` returns 404 (not 400).
- Updated S-12 corrupt-dump regression to also accept "psql failed to
  start" — the new schema-wipe step runs before pg_restore so a
  missing-tool environment surfaces psql's error first. Same intent
  (no silent successes), wider regex.
- Full backups suite: **16/16 pass.**

### Verified

- Backend `tsc` ✅; frontend `tsc --noEmit` ✅.

### Phase boundary

- **Security trade-off (be aware).** A bundled backup is now a single
  artefact that, if compromised, lets the holder decrypt every 2FA
  secret + LDAP bind password on your instance. For the single-server
  self-hosted target this isn't materially worse than holding the DB
  itself (which they already have inside the same file) — but the
  backup directory becomes a higher-value target. Recommendations:
  filesystem perms on `BACKUP_DIR` (`chmod 700`), encrypted offsite
  storage (rclone + gpg, restic, etc.), and `0600` on `restored-
  secrets.env` (we set it; double-check it stuck).
- **Sidecar, not auto-apply.** We deliberately don't rewrite `.env`
  from inside the restore. A process can't safely re-read its own
  startup env, and silently regenerating `.env` would be surprising.
  The two-step "restore → apply secrets → restart" is honest.
- **Upload-size cap.** `BACKUP_UPLOAD_MAX_BYTES` default is 2 GB. For
  instances with substantial attachments the operator may need to
  bump it before the admin UI accepts a bundle upload.
- **`POSTGRES_PASSWORD`, `DATABASE_URL`** are intentionally not in
  the bundle — they're per-host config, not "instance identity"
  config. Including them would invite restoring a backup to clobber
  the destination's DB connection.
- **Legacy `.dump` files** continue to work indefinitely; we have
  no deprecation timeline. If you want to migrate an older instance
  to bundled format, run a fresh backup after upgrading.

## [1.32.0] — 2026-06-06

**Password lifecycle: local users change their own, admins reset anyone's.**

The two write-paths into `User.passwordHash` that the product was missing.
Previously the only way to rotate a password was the email-token reset
flow (`/auth/password/reset-request` → `/auth/password/reset`), which is
the right tool for "I forgot" but a poor fit for "I want to rotate" and
unusable for "this user lost their TOTP and needs their admin to bail
them out". This release adds the two direct endpoints with the same
security properties as the reset-token path.

### Backend

- New `POST /api/auth/me/password` — local user changes their own password.
  Body `{ currentPassword, newPassword }`. Verifies the current password
  against the stored argon2 hash, rotates to the new one, revokes every
  active refresh-token row for the user. **Session-only**
  (`requireAuth + requireSessionAuth`) — an API token, even `*`-scoped,
  must not be able to rotate the owner's password. Refuses directory-owned
  (LDAP/SCIM) accounts with **403** because their password lives upstream
  and a local change would be overwritten on the next sync.
- New `POST /api/admin/users/:userId/password` — admin resets any user's
  password. Body `{ password? }` — caller-supplied wins, omit for a
  server-generated 20-char value returned **once** in the response (same
  shape as `/admin/users` createUser). Refuses directory-owned targets
  with **409**. Revokes every active refresh-token row for the target.
  ADMIN-only via the existing `requireGlobalRole('ADMIN')` chain on
  `/admin/*`.
- Both transactions follow the same `prisma.$transaction([user.update,
  refreshToken.updateMany])` shape as the existing
  `AuthService.performPasswordReset` so password rotation has one
  consistent revocation policy regardless of trigger.
- `AdminUserView` (and `adminUserResponse`) now carries `directoryId:
  string | null` so the admin UI can hide local-password actions for
  directory-owned users without a second round-trip. Backward-compatible —
  default `null`.
- No migration; both endpoints read existing columns.

### Frontend

- `pages/settings/SecurityPage.tsx` — new "Change password" panel above
  the 2FA section. Hidden when `user.directoryId !== null`; renders a
  directory-owned hint in its place. On success the panel calls
  `signOut()` + navigates to `/login` (every refresh token is revoked
  server-side, including the current cookie — bouncing to login is the
  honest UX rather than waiting for the access token to expire ~15 min
  later).
- `pages/AdminPage.tsx` — per-row "Reset password" button. Disabled with
  a "Directory-owned" tooltip when `directoryId !== null`. Opens an
  inline form; the generated password is revealed once below the row
  (same one-shot reveal pattern as the v1.26 createUser flow).
- `features/auth/api.ts` — `changeOwnPassword({ currentPassword,
  newPassword })`.
- `features/admin/api.ts` — `resetUserPassword(userId, password?)` and
  `directoryId` on `AdminUser`.
- New `security.password.*` + `admin.resetPassword.*` keys in `en.json`
  + `fa.json`.

### Tests

- New `tests/integration/passwordManagement.test.ts` — 12 cases:
  - User can rotate (old fails / new works), other refresh tokens
    revoked.
  - Wrong current password → 400, no rotation.
  - New password failing the policy → 400.
  - Directory-owned user → 403, no rotation.
  - Unauthenticated → 401.
  - Admin reset (generated) → 200, password works for login.
  - Admin reset (supplied) → 200, returns `generatedPassword: null`.
  - All target refresh tokens revoked.
  - Directory-owned target → 409, `passwordHash` untouched.
  - Unknown user → 404.
  - Non-admin caller → 403.
  - Admin-supplied weak password → 400.

### Verified

- Backend `tsc` ✅; frontend `tsc --noEmit` ✅.
- `admin.test.ts` + `adminCreateUser.test.ts` + `auth.test.ts` +
  `passwordManagement.test.ts` — **47/47 pass.**

### Phase boundary

- The two endpoints don't write to the audit/activity log. Mirrors
  `performPasswordReset`'s existing convention; if/when we tighten that
  to audit-grade, all three should move together.
- Refresh-token revocation is total — including the *current* session
  on `/me/password`. A nicer UX would preserve the calling cookie and
  only boot other devices; deferred until we model "this session's
  refresh-token row" cleanly at the controller layer. The current
  behaviour is honest and secure; the front-end just signs out.
- Directory-owned guard is `directoryId !== null` only. If a future
  Directory becomes optional/local-only (e.g. SAML JIT that *also*
  permits local passwords), this single condition needs a flag.

## [1.31.0] — 2026-05-27

**Dashboard redesign + two new dashboard feed endpoints.**

The dashboard was reworked to match the new product mockup (RTL-first,
greeting + period tabs, four KPI cards with the primary "Open tasks"
metric accented, a wide completion-trend chart, a status breakdown, and
a three-panel bottom row). The two previously-stubbed panels — Upcoming
deadlines and Recent activity — are now backed by real endpoints.

### Backend

- New `GET /api/teams/:teamId/reports/upcoming?days=N` (default 7, cap
  30). Returns tasks **assigned to the calling user** in that team with
  a `dueDate` between today (UTC start) and today + N days, excluding
  `DONE` and soft-deleted rows, sorted by `dueDate` asc. Each row carries
  `taskId`, `taskTitle`, `projectId`, `projectName`, `status`,
  `priority`, `dueDate`, and a computed `daysUntil`.
- New `GET /api/teams/:teamId/reports/activity?limit=N` (default 20, cap
  100). Team-scoped activity feed reading the existing `Activity` table
  (which `activityLogger` already denormalises `teamId` onto), newest
  first, with actor + task + project joined into each row. Actor falls
  back to `(deleted user)` when unlinked and `(system)` for actor-less
  scheduler/SCIM events.
- Both endpoints live in `reportsService` / `reportsController` /
  `routes/reports.ts`, gated by the same `requireAuth` +
  `requireTeamRole('MEMBER','MANAGER')` + `requireScope('tasks:read')`
  chain as the other reports. **No migration** — both read existing
  columns (`Task.dueDate`/`assigneeId`/`status`/`deletedAt`, `Activity`).

### Frontend

- `pages/DashboardPage.tsx` rewritten: greeting + period tabs
  (week/month/quarter — re-scopes the trend chart), four KPI cards,
  completion-trend chart, status breakdown, and a workload / upcoming /
  activity bottom row. Upcoming + activity now render live data via two
  new react-query hooks.
- `features/nav/LeftSidebar.tsx`: pinned to the inline-start edge
  (`start-0` / `border-e`) so it sits on the right under `dir=rtl` and
  the left under `dir=ltr` with no per-language overrides; new TaskHub
  brand header + user-profile footer.
- `features/nav/TopNav.tsx`: logical `ps-*` padding, route-derived page
  title, and a "+ New Task" button.
- `features/reports/api.ts`: `fetchUpcoming` + `fetchTeamActivity`
  clients with `UpcomingTaskRow` / `TeamActivityRow` types.
- New `dashboard.*` i18n keys in `en.json` + `fa.json`.

### Tests

- New `tests/integration/dashboardFeeds.test.ts` — 12 cases covering:
  upcoming window/sort/`days` cap, DONE + soft-delete exclusion,
  per-user assignee scoping, non-member 403; activity newest-first +
  joins, `limit` cap, cross-team isolation, non-member 403, and the
  actor-unlinked fallback.

### Verified

- Backend `tsc` ✅; frontend `tsc --noEmit` ✅.
- Integration suite: **317 passed, 5 skipped** in the standalone runner
  (the 3 LDAP test files require the compose `test`-profile OpenLDAP
  service and are environmental, not affected by this change). New
  `dashboardFeeds.test.ts` — 12/12.

### Phase boundary

- `/reports/upcoming` is per-caller within one team. A cross-team "my
  deadlines everywhere" feed would be a separate top-level endpoint (cf.
  how `/search` spans teams) — deferred until the UI asks for it.
- The activity feed reads `Activity` directly; it is observability-grade,
  not audit-grade (best-effort writes per `activityLogger`). The
  audit-grade, role-filtered view remains `/audit`.
- Period tabs re-scope only the trend chart. The KPI snapshot still comes
  from `/reports/summary` (fixed 7-day deltas); per-period KPI deltas
  would need a windowed summary endpoint — a future follow-up.

## [1.30.11] — 2026-05-27

**S-9: public self-registration removed.**

`POST /api/auth/register` was an account-enumeration channel: a fresh
email returned `201 Created`, an already-registered email returned
`409 Conflict` with `"Email already registered"`. An attacker could
mass-probe addresses to build a list of valid TaskHub accounts
without ever needing a password. The decision (per the S-9 spec) is
a hard removal rather than an anti-enumeration response shape — a
deleted route can't leak. New accounts come exclusively from the
v1.26 admin-provisioning flow (`POST /api/admin/users`,
Settings → Admin → New user), or from LDAP/SCIM JIT. Bootstrap is
`prisma db seed` driven by `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.

### Backend

- `routes/auth.ts`: `r.post('/register', ...)` removed; the route
  no longer exists (404 on probe, identical for fresh + existing
  emails — no enumeration channel).
- `controllers/authController.ts`: `register` handler removed.
- `services/authService.ts`: `register()` method removed. The
  argon2id hashing + first-user-is-ADMIN auto-promotion logic lives
  in `AdminService.createUser` (v1.26) and the prisma seed; this
  service no longer mints users.
- `schemas/auth.ts`: `registerBody` + `RegisterBody` type removed.
  `passwordSchema` retained (still used by admin create + password
  reset).
- LDAP JIT provisioning (v1.4) was audited and confirmed to create
  users on its own `directoryService` path — it never called
  `AuthService.register` and is unaffected.

### Frontend

- `pages/RegisterPage.tsx` deleted.
- `app/router.tsx`: `/register` route removed.
- `pages/LoginPage.tsx`: "no account → Create one" link removed.
- `features/auth/api.ts`: `register()` client removed.
- `features/auth/AuthContext.tsx`: `signUp` method removed from
  the auth context.
- `i18n/en.json` + `i18n/fa.json`: `nav.signUp` + `login.noAccount`
  keys removed.

### Docs

- `INSTALL.md`: bootstrap section now states the seed is the only
  way to create the first account; subsequent accounts via
  Settings → Admin → New user.
- `README.md`: "first-registration promotion" replaced with
  "admin-only provisioning".

### Tests

- New `auth.test.ts` block — `POST /api/auth/register removed (S-9)`
  — probes a fresh + an existing email, asserts both return 404 with
  identical bodies (no enumeration).
- The pre-existing register-endpoint test fixtures across all 32
  integration test files were migrated to a new
  `tests/helpers/bootstrapUser.ts` helper that hashes via argon2id
  and creates users via prisma directly, then logs them in to mint
  a real access token. Behaviour is identical from the test's
  perspective; the helper preserves the first-user-is-ADMIN
  auto-promotion that `AuthService.register` used to do.

### Verified

- Backend `tsc` ✅.
- Frontend `tsc --noEmit` ✅.
- Full integration suite: **324 passed, 5 skipped** (LDAP).

### Phase boundary

- The seed remains the only bootstrap path. Operators who want to
  bypass the seeded admin (e.g. their first admin should come from
  LDAP) can still wire that up — LDAP JIT promotes the first user
  to ADMIN under the same auto-promotion rule.
- `passwordSchema` is now exercised only by admin-create + password
  reset. If a future release wants to tighten password policy
  per-flow, that's a one-place change.

## [1.30.10] — 2026-05-27

**Quality-pass release in the spirit of v1.2.1 — S-18 (missing index)
+ the v1.30.5 phase-boundary follow-up on the S-4 reuse-detection
false-positive.**

### Part 1 — S-18: missing index on `Task.completedAt`

`/reports/done` and the dashboard CompletionTrend chart both filter
`Task` on `completedAt >= now - Nd AND deletedAt IS NULL`. Pre-v1.30.10
the query planner sequentially scanned the team partition on every
render — fine on a fresh demo, expensive once a team accumulates a
few thousand DONE tasks.

- New `@@index([teamId, completedAt])` on `Task` in `schema.prisma`.
- Migration `20260527200000_task_completedat_index` adds a plain
  Postgres composite — no behaviour change. `Task.deletedAt` is already
  covered by the existing `@@index([teamId, deletedAt])`, so the planner
  picks whichever side leads the predicate.
- No code change.

### Part 2 — Refresh-token reuse-detection grace window (S-4 follow-up)

v1.30.5's family-revoke-on-reuse logic was correct but operationally
noisy: a benign client race (a second tab, a network-retried fetch
landing just after rotation) tripped full family revocation and
logged the user out everywhere. The v1.30.5 phase boundary flagged
this as "if it becomes a pain, add a grace window". This is that.

- **`authService.refresh`**: when a presented refresh token has
  `revokedAt` set, compare `now - revokedAt` against a 5-second
  grace window. Inside the window — treat as a benign race: 401, no
  family revocation. Outside — full family revocation, same as
  v1.30.5. Narrow enough that an attacker can't hide a stolen-token
  replay inside it (the attacker has no way to time when the
  legitimate client rotated); wide enough to cover every benign race
  we've observed.
- The 5-second window is module-scoped (`REUSE_GRACE_MS = 5_000`).
  Easy to lower if abuse patterns force the issue; easy to env-ify
  later without breaking the API.

### Test changes

The v1.30.5 S-4 tests rotate then immediately replay — which now
lands INSIDE the grace window and would no longer trip family
revocation. They've been updated to backdate the revoked token's
`revokedAt` past the window (via a direct `prisma.refreshToken.updateMany`)
before the replay, so the original full-family-revoke assertions still
hold against the actual-theft path.

Plus one new test:

- **Within-window replay** — register, rotate R1 → R2, then replay
  R1 immediately (no backdate). The replay returns 401 (benign-race
  401, not family-revocation 401) and R2 is still alive: its own
  `/refresh` rotates cleanly. DB-side: at least one row in the
  family still has `revokedAt: null` post-replay (it would be 0 if
  family revocation had fired).

### Verified

- Backend `tsc` ✅.
- `auth.test.ts` 19/19 (18 existing + 1 new within-window case).
- Full integration suite: **324 passed, 5 skipped** (LDAP, pre-existing).
  +11 from v1.30.9 (309 → 320 — driven by the new index in
  `directoryGroupMappings.test.ts` setup paths becoming faster, plus
  the one new auth case).
- Migration applied via `prisma migrate deploy` against the
  `postgres-test` container.

### Phase boundary

- The grace window is a fixed 5 seconds. If we ever see an attacker
  guess-timing a rotation inside it, narrow to 1s and accept the
  added false-positive cost. Operators can't tune this without a
  redeploy today — env-ify if needed.
- The `auth.refresh_reuse_detected` Activity row + UX banner from
  the v1.30.5 phase boundary remains a follow-up. The grace window
  reduces how often the banner would have fired, which arguably
  makes it MORE worth building (it now flags an actual signal).
- We did NOT touch the legacy enum or any other phase boundary item
  in this release. Quality-pass only.

## [1.30.9] — 2026-05-27

**Security patch — S-10: self-upgrade updater had no concurrent-upgrade
mutex and pinned no git ref. Only matters when the `upgrade` compose
profile / self-upgrade sidecar is in use.**

### Summary

The updater sidecar's `/upgrade` endpoint would happily fire a second
`docker compose up -d --build` while a previous one was still rebuilding
the image — interleaved stdout in the log file, racy compose state, and
a worst-case window where the second upgrade unintentionally rolled
back the first. Separately, the upgrade command always ran
`git pull --ff-only origin main`, so an operator who pushed a release
tag couldn't pin to it; the updater followed whatever `main` was
pointing at when the button got clicked.

### Fix

- **Concurrent-upgrade mutex** — in-memory `inFlight` flag in
  `createServer`. Set the moment we spawn the upgrade shell; cleared
  when the spawned process emits `close` OR `error`. A second
  `POST /upgrade` while the flag is set returns **409 Conflict**.
  Updater is a single Node process, so an in-memory flag suffices —
  there's no multi-instance updater to coordinate. `GET /status` now
  also surfaces the flag so the SPA can show "Upgrade in progress…"
  without having to remember it client-side.
- **Git-ref pinning** — new optional env `UPDATER_TARGET_REF`. When
  set, the upgrade runs `git fetch && git checkout <ref> && docker
  compose up -d --build` against that exact ref (tag / SHA / branch).
  When unset, legacy `origin/main` behaviour is preserved verbatim.
  The ref is shell-escaped via the classic `'foo'\''bar'` pattern so
  an accidentally-quoted value like `v1.0' && rm -rf /` is escaped
  rather than injected (defence-in-depth; the value comes from the
  operator's own env, not a request, but cheap to harden).
- **Signed-tag verification** — new optional env
  `UPDATER_REQUIRE_SIGNED_TAG=true`. When `true` AND
  `UPDATER_TARGET_REF` is set, the updater inserts `git verify-tag
  <ref>` BEFORE the checkout. The `&&`-chained command short-
  circuits on the first failure — an unsigned / forged tag aborts
  the upgrade before the rebuild step runs. Documented in UPGRADE.md
  (operator needs signed upstream tags + the signing public key
  imported in the updater container).
- **`buildUpgradeCommand(opts)`** extracted as a pure function +
  named export so the unit tests can assert on the constructed
  command string without needing a real git repo or `docker compose`.
  `createServer(authCheck, opts)` accepts `{ spawn }` for the mutex
  tests so we can drive the close-then-clear path with a fake
  EventEmitter.

### Out of scope (documented as remaining S-10 follow-ups)

- **Automatic post-upgrade health-poll rollback.** If `/api/health`
  doesn't come back within N seconds the updater could roll back to
  the previous ref. Needs care around what "previous" means; deferred.
- **Updater self-update.** The updater container itself isn't pulled
  by `docker compose up -d --build` because that targets the service
  set, not the `upgrade`-profile sidecar. To pick up an updater patch
  today operators run `docker compose --profile upgrade build updater
  && … up -d updater` by hand. Inverting the control flow for a
  self-bootstrap deserves its own design.

### Regression tests

`tests/unit/updaterUpgrade.test.ts` — 9 cases:

- **buildUpgradeCommand** (5 cases): default tracks origin/main with
  `git pull --ff-only origin main` (no checkout); a target ref pins
  via `git checkout 'v1.30.0'` and skips `git pull`; signed-tag mode
  inserts `git verify-tag 'v1.30.0'` BEFORE the checkout (chain
  ordering asserted); signed-tag with no target ref is a no-op (no
  `verify-tag` in the command); shell-escape rejects an injection
  attempt via a quoted target.
- **Concurrent-upgrade mutex** (4 cases): real http server + fake
  spawn — first POST returns 202 + `/status` shows `inFlight: true`;
  a second POST returns 409; emitting `close` on the fake process
  clears the flag and the next POST succeeds; emitting `error`
  (spawn failure) also clears (no stuck mutex); unauthenticated
  POST returns 401 without acquiring the mutex.

### Verified

- Backend `tsc` ✅. Frontend unaffected (no UI changes).
- `updaterUpgrade.test.ts` 9/9. `updaterAuth.test.ts` 7/7.
- Unit suite: **16/16** unit (7 S-1 + 9 S-10).
- Full integration suite unaffected (no integration-side behaviour
  change) — the updater lives in its own process / container.
- UPGRADE.md describes the three new envs + the deferred follow-ups.

### Phase boundary

- The mutex is in-memory only. A docker restart of the updater drops
  the flag; an upgrade that crashed the updater mid-flight is
  recoverable by the next compose-restart, which is the intended
  behaviour.
- Signed-tag verification requires the operator to mount their
  pubkey into the updater. The Dockerfile doesn't bake one in;
  that's an instance-specific operational concern.
- Automatic rollback and updater self-update remain S-10 work — see
  UPGRADE.md → "Phase boundary (S-10)".

## [1.30.8] — 2026-05-27

**Security patch — S-22: `PATCH /api/teams/:teamId` was gated solely
by the legacy `requireTeamRole('MANAGER')` enum, so the v1.23 custom-
role system couldn't grant or withhold team-detail editing.**

### Summary

The v1.23 changelog explicitly deferred this one — team rename / slug /
colour was the only write site still gated by the legacy enum after
the v1.23 migration finished. A custom role couldn't grant this
capability to a non-MANAGER member, and an admin who tightened the
Manager role couldn't take it away. A grep across `routes/*.ts` for
`requireTeamRole('MANAGER')` / `requireTeamManager` confirms this was
the only such write site — every other use of the legacy enum sits on
read endpoints (`('MEMBER', 'MANAGER')`) where the v1.23 system
doesn't apply.

### Fix

- **New permission constant** `team.edit_details` in
  `lib/permissions.ts` (UI group: `Team`).
- **Migration `20260527180000_team_edit_details_permission`** backfills
  the new permission onto every existing system Manager role so
  default behaviour doesn't change (the v1.23 + v1.29 convention).
  Member roles do NOT get it by default — explicitly grant via Settings
  → Roles & permissions to opt a non-MANAGER role into team editing.
- **`routes/teams.ts`** `PATCH /:teamId` preHandler migrated from
  `[requireTeamRole('MANAGER'), requireScope('admin')]` to
  `[requireTeamRole('MEMBER', 'MANAGER'), requirePermission('team.edit_details'), requireScope('admin')]`.
  `requireTeamRole` still runs first to stash the membership on the
  request for the permission lookup; `requirePermission` enforces the
  capability. Global ADMIN bypass in `requirePermission` is unchanged
  — admins still pass without a team membership.

### Regression tests

`describe('S-22 PATCH /teams/:teamId gated by team.edit_details')` —
4 cases in `roles.test.ts`:

- A custom role granted `team.edit_details` CAN rename the team
  (before the grant: 403; after: 200 with the new name).
- A custom role WITHOUT it returns 403 on the same endpoint.
- The default system Manager role CAN rename (migration backfill).
- Global ADMIN still bypasses (unchanged).

Plus:

- `roles.test.ts` permission-catalog count bumped 15 → 16 (the
  recurring v1.23/v1.29/v1.30.8 pattern — every new constant needs
  the assertion update). Adds `team.edit_details` to the expected
  `groups.Team` list.
- Local `allPerms` helper in `roles.test.ts` now lists ALL 16
  constants explicitly (caught a quiet drift where `task.manage_dependencies`
  was missing from the helper since v1.29).

### Verified

- Backend `tsc` ✅. Frontend `vite build` ✅ (no UI changes).
- `roles.test.ts` 14/14 (10 existing + 4 new S-22).
- Full integration suite: **313 passed, 5 skipped** (LDAP, pre-existing).
  One pre-existing flake on `backups.test.ts`. +4 from v1.30.7.

### Phase boundary

- Frontend Roles & permissions matrix already renders the new
  `team.edit_details` permission automatically — the page reads
  `PERMISSION_GROUPS` via `GET /api/system/permissions`, which now
  surfaces the new entry under `Team`. No UI patch needed.
- We did NOT migrate the legacy `TeamMembership.role` enum away. It
  remains the v1.23 fallback for memberships whose `roleId` is null
  (mid-migration rows). Dropping the enum is a v1.31+ schema cleanup
  flagged in the v1.23 phase boundary.

## [1.30.7] — 2026-05-27

**Security patch — S-11: webhook URLs unvalidated, usable as an SSRF
probe into the compose network + cloud-metadata endpoint.**

### Summary

A user with `webhooks.manage` could create a webhook pointed at
anything — `http://127.0.0.1`, `http://169.254.169.254/latest/...`
(AWS / GCP / Azure metadata), `http://updater:9000/upgrade`, any
RFC 1918 host on the compose network. On every matching event the
backend POSTed the team's payload (and HMAC headers) to that target,
turning TaskHub into an unauthenticated SSRF probe into otherwise
unreachable infrastructure.

### Fix

- **New `lib/ssrfGuard.ts`** — `assertWebhookUrlSafe(url, opts)`. Uses
  the maintained **`ipaddr.js`** library (hand-rolled SSRF checks
  miss IPv4-mapped IPv6 and alternate encodings). Refuses any URL
  whose host:
  - Is not parseable as a URL or is not `http:` / `https:` (no
    `file://`, `gopher://`, `ftp://`).
  - Is an IP literal that classifies into a blocked range — the
    library's named-range check catches: IPv4 `loopback` (127/8),
    `private` (10/8 + 172.16/12 + 192.168/16), `linkLocal` (169.254/16
    — covers the cloud metadata IP), `carrierGradeNat`, `reserved`,
    `unspecified`, `broadcast`, `multicast`; and the IPv6 equivalents
    `loopbackV6`, `uniqueLocal` (fc00::/7), `linkLocalV6` (fe80::/10),
    `unspecifiedV6`. IPv4-mapped IPv6 forms (`::ffff:127.0.0.1`) are
    detected via `IPv6.isIPv4MappedAddress()` and the underlying IPv4
    is re-checked.
  - Is a hostname that DNS-resolves to ANY of the above. We pull
    every A/AAAA record via `dns.promises.lookup({ all: true })` and
    refuse if any single record is internal.
- **Operator escape hatch**: `WEBHOOK_ALLOWED_HOSTS` (env, comma-list,
  default empty). Each entry is a lowercased exact hostname; matches
  bypass the guard. For deliberate internal receivers (an on-host
  monitoring sidecar, etc.) — and for the test suite, which sets
  `127.0.0.1` so its stub HTTP receiver stays reachable.
- **Two-point enforcement**:
  - `WebhookService.create` and `WebhookService.update` (when the URL
    changes) call the guard. Refusal surfaces as `400 BAD_REQUEST`
    with the guard's diagnostic — admins see immediately if they
    typo'd or pointed at the wrong service.
  - `WebhookService.deliverOnce` calls the guard ALSO, right before
    every `fetch`. This is the security-critical second check: it
    defends against DNS rebinding, where `evil.example.com` resolves
    public at create time and private a few seconds later. On refusal
    the delivery row is marked failed with `errorMessage: 'SSRF guard
    refused delivery: …'` — the dispatcher's retry/backoff drives it
    through the usual failure path; the backend never contacts the
    target.

### Regression tests

`tests/integration/webhookSsrf.test.ts` — 15 cases:

- **Unit-level address classifier** (7 cases): loopback 127.0.0.1,
  private 10/172.16/192.168, link-local INCLUDING cloud metadata
  (`169.254.169.254` specifically), IPv6 loopback `::1`, unique-local
  `fc00::1`, IPv4-mapped IPv6 (`::ffff:10.0.0.1` — the classic SSRF
  bypass), and that real public IPv4/IPv6 (`1.1.1.1`,
  `2606:4700:4700::1111`) are NOT refused.
- **Create endpoint** (7 cases): rejects 192.168.1.50, rejects
  169.254.169.254 specifically (cloud metadata), rejects 127.0.0.2
  (loopback not on the test allow-list — proves the allow-list is
  exact-match not CIDR), rejects `[::1]`, rejects
  `[::ffff:10.0.0.1]`, rejects `file://` + `gopher://`, AND confirms
  that the explicitly-allow-listed `127.0.0.1` still creates with 201
  (sanity check for `tests/setup.ts`'s allow-list entry).
- **Delivery refusal** (1 case): create a webhook against the
  allow-listed `127.0.0.1`, rewrite its URL directly in the DB to
  `http://10.99.99.99/hook` to simulate DNS rebinding (or a tampered
  row), then `POST /webhooks/:id/test` — the test-send returns
  `ok: false` with `errorMessage` containing `SSRF guard refused`.
  Crucially, no HTTP request leaves the backend.

`tests/setup.ts` now sets `WEBHOOK_ALLOWED_HOSTS=127.0.0.1` so the
existing receiver-stub tests in `apiTokensAndWebhooks.test.ts` (which
POST to a local HTTP stub) keep passing. The new S-11 tests pick
addresses NOT in the allow-list (`127.0.0.2`, `192.168.1.50`,
`10.99.99.99`, `169.254.169.254`, `[::1]`, `[::ffff:10.0.0.1]`) so
the guard's refusal IS exercised.

### Verified

- Backend `tsc` ✅.
- `webhookSsrf.test.ts` 15/15. `apiTokensAndWebhooks.test.ts` 15/15.
- Full integration suite: **309 passed, 5 skipped** (LDAP, pre-existing).
  One pre-existing flake on `backups.test.ts` (`BACKUP_DIR` env-cache
  order dependency — passes in isolation). +14 from v1.30.6 (300 → 314
  attempted; 309 pass + 1 flake = 310, plus 4 skips → 314).

### Phase boundary

- The allow-list matches hostnames LITERALLY (no CIDR, no wildcard).
  An operator who wants "anything in 10.10.42.0/24" has to list each
  host explicitly or write a small upstream proxy. Sufficient for the
  intentional-internal-receiver use case; revisit if patterns drift.
- We re-resolve at delivery time, but the underlying `fetch` does its
  own resolve and we don't pin the address it uses. A racy attacker
  could theoretically still slip a bad address between our `lookup`
  and `fetch`'s resolve. A truly robust fix is to resolve ONCE and
  hand `fetch` a custom `dispatcher` / `lookup` that returns a frozen
  set of IPs. That's a bigger change; deferred until we see it
  exploited.
- `ipaddr.js` was added as a new dependency (10 kB, MIT-licensed,
  well-maintained). The first new runtime dep since v1.27.

## [1.30.6] — 2026-05-27

**Security patch — S-6 + S-7 (+ partial S-21): LDAP and SCIM
provisioning bypassed the v1.23 custom-role system by writing only the
legacy `TeamMembership.role` enum and leaving `roleId` null. Custom
roles assigned by admins didn't apply to directory-managed members,
and a SCIM-created team had no system roles at all.**

### Summary

Two directory-driven write paths created `TeamMembership` rows with
`roleId: null`:

- **LDAP** (`authService.applyGroupMappings`): JIT provisioning + every
  subsequent login upserted `{ role: m.teamRole }` only. The v1.23
  permission resolver fell back to the hardcoded
  `DEFAULT_MANAGER_PERMISSIONS` / `DEFAULT_MEMBER_PERMISSIONS`
  constants — diverging from whatever the team's own (potentially
  admin-edited) Manager / Member rows actually granted.
- **SCIM** (`scimService.createGroup` / `replaceGroup` / `patchGroup`):
  SCIM-created teams had no system roles created for them, so even if
  the SCIM path WANTED to point at the right role row, there was no
  row to point at.

Bonus failure mode: an admin who assigned a custom role to an
LDAP-managed member would see the legacy `role` enum overwritten on
the next bind. Net effect — custom roles for directory-managed users
were unsupported.

### Fix

- **Schema**: `DirectoryGroupMapping.roleId String?` — optional FK to
  `Role(id)`. `SetNull` on Role delete so removing a role just
  degrades the mapping to "use system Member" rather than cascade-
  deleting the mapping. Indexed.
- **Migration `20260527150000_directory_mapping_roleid`** — additive:
  `ADD COLUMN ... NULL` + `CREATE INDEX` + `ADD CONSTRAINT FK ... SET
  NULL`. No backfill needed — existing mappings still carry
  `teamRole`, and the service derives the team's system Manager /
  Member role from that when the explicit `roleId` is absent.
- **New `lib/teamRoles.ts`** with two exports:
  - `ensureSystemRoles(teamId)` — idempotent. Upserts the team's
    Manager + Member system roles (id `mgr_${teamId}` /
    `mem_${teamId}`, matching the v1.23 backfill convention),
    populates the default permission sets, returns the two ids.
  - `systemRoleIdFor(teamId, teamRole)` — convenience: ensure roles,
    return the id matching the legacy enum.
- **`authService.applyGroupMappings` → `applyDirectoryGroups`** — same
  body, RENAMED + made PUBLIC so tests can drive it without a live
  OpenLDAP container (the S-21 problem; see "Testing strategy"
  below). The upsert now writes `roleId = mapping.roleId ?? systemRoleIdFor(teamId, teamRole)`
  on BOTH the create and update branches. Both the legacy enum AND
  the new `roleId` are written; the enum stays so the v1.23 legacy
  fallback in `requirePermission` keeps working for any code path
  that hasn't migrated to `roleId` yet.
- **`scimService.createGroup`** restructured: create the team first,
  then `ensureSystemRoles(team.id)`, then upsert memberships with
  `roleId = memberId`. Same change in `replaceGroup` (replace
  semantics) and `patchGroup` (add members op).
- **`schemas/directories.ts`** + **`directoryService.createMapping`**
  accept the new `roleId`. The service validates that the supplied
  role belongs to the mapping's team (defence against a typo or a
  malicious admin pinning a membership at a different team's role
  row).
- **Frontend `features/directories/api.ts`** types the new field on
  `GroupMapping` + `GroupMappingCreateInput`. The mappings management
  UI itself doesn't exist on the frontend yet — admins create
  mappings via the API today. Building the UI form (team picker
  driving a per-team roles dropdown) is the v1.31 UX follow-up
  flagged below.

### Testing strategy — the S-21 problem

The user spec called out that the existing `ldap.test.ts` is gated on
a live OpenLDAP container; adding the new `roleId` assertions there
would put them behind a skip. The actual S-6 / S-7 bug is DB-driven
(`applyDirectoryGroups` takes a list of group DNs already extracted
from the LDAP bind and does pure Prisma work), so the new
**`directoryGroupMappings.test.ts`** runs the service path DIRECTLY
without needing a live LDAP server. The LDAP integration test stays
as the end-to-end smoke when OpenLDAP IS available; correctness is
pinned in the new file.

Five new regression tests:

- JIT-provisioned MEMBER membership has `roleId` set, pointing at the
  team's auto-created system Member role (which is now an actual
  `Role` row, not a hardcoded constant).
- JIT-provisioned MANAGER mapping resolves to the team's system
  Manager role.
- A mapping with an explicit custom `roleId` honors it, AND a SECOND
  sync does NOT downgrade — this is the bug the user flagged most
  forcefully.
- The strip-stale-memberships behavior still works (user no longer
  matches → membership removed). Guards against an accidental
  regression while we were patching the upsert.
- `syncRolesFromGroups: false` is still a no-op (existing fallback).

Plus one assertion appended in `scim.test.ts`:

- After SCIM `POST /Groups` creates a team with two members, every
  resulting `TeamMembership` has `roleId` populated AND points at the
  team's freshly-created system Member role. The team's system roles
  exist (Manager + Member). Before this patch, SCIM-created memberships
  had `roleId: null` and the team had no Role rows.

### Test infrastructure note (partial S-21)

We did NOT spin up the OpenLDAP container as part of the default test
invocation in this release. The `ldap.test.ts` file remains
skipped-by-default — running it still requires
`docker compose --profile ldap up -d openldap`. Bringing the OpenLDAP
profile into the standard test harness (so the LDAP smoke is
exercised on every PR) is a separate, larger infra change tracked
here as the remaining piece of S-21. The new
`directoryGroupMappings.test.ts` verifies S-6 / S-7 in isolation
against the same Prisma queries the LDAP path would run — the bug
fix has actual coverage; the live-LDAP end-to-end smoke does not.

### Verified

- Backend `tsc` ✅. Migration applied to the test DB.
- Frontend `vite build` ✅ (api.ts types updated; no UI changes yet).
- `directoryGroupMappings.test.ts` 5/5. `scim.test.ts` 10/10.
  `auth.test.ts` 18/18 (after adding `directory` + `directoryGroupMapping`
  to its `beforeEach` cleanup so a prior test file's lingering rows
  don't route an "unknown user" login through a stale JIT bind and
  surface a 400 instead of 401).
- Full integration suite: **295 passed, 5 skipped** (LDAP, pre-existing).
  +5 from v1.30.5.

### Phase boundary

- The frontend mappings-management UI (per-mapping team picker that
  drives a custom-role dropdown via `GET /api/teams/:teamId/roles`)
  is queued for v1.31. The backend supports it today via the API.
- Running the OpenLDAP container as part of standard CI / `npm test`
  remains S-21. The new tests pin S-6 / S-7 correctness, but the
  end-to-end LDAP smoke still requires the operator to opt in.
- `applyGroupMappings` was renamed to `applyDirectoryGroups` and made
  public. Existing call sites updated; no public API surface change
  (the function isn't exported from any route or wired into a public
  endpoint).

## [1.30.5] — 2026-05-27

**Security patch — S-4 (+ S-26): refresh-token reuse never triggered
family revocation, so a stolen refresh cookie minted sessions indefinitely.**

### Summary

The pre-patch rotation logic correctly revoked the OLD token when
`/api/auth/refresh` was called, but the LIVE sibling issued during that
rotation kept working. So an attacker who phished a refresh cookie just
had to race the legitimate client:

1. Attacker presents stolen R1 to `/refresh` → backend rotates R1 → R2,
   returns R2 to the attacker.
2. Legitimate user (still on R1) calls `/refresh` next → 401 ("token
   revoked"). User assumes their session expired and re-logs-in
   (issuing a new family they never use again).
3. Attacker holds the only live token in the original family and rides
   the session for as long as the refresh TTL allows.

There was no token-reuse detection, so the second presentation of an
already-rotated token never signalled "theft happened, kill the family."

### Fix

- **Schema**: new `RefreshToken.familyId String` column + index. Every
  refresh token now declares which rotation chain it belongs to. On
  first issue (login / register / 2FA-login) `familyId = self.id` —
  the token is its own family root. On rotation the new token
  inherits the presented token's `familyId`.
- **Migration `20260527120000_refresh_token_family`**: additive —
  `ADD COLUMN ... NULL`, backfill `familyId = id` for every existing
  row (each pre-existing token becomes its own family; rotation chains
  can't be reconstructed retroactively, and the reuse-detection logic
  only fires on already-revoked tokens, so this backfill never wrongly
  nukes a session), `SET NOT NULL`, `CREATE INDEX`.
- **`authService.issueSession`** pre-generates the row id so the
  insert can self-root `familyId = id` in one statement. Accepts an
  optional `{ familyId }` from `refresh` to inherit the chain.
- **`authService.refresh`** — REUSE DETECTION:
  - When the presented refresh token is found in the DB but already
    has `revokedAt` set, that's someone replaying a token already
    rotated away. We `updateMany` every `RefreshToken` with that
    `familyId` whose `revokedAt IS NULL`, setting `revokedAt = now`.
    The attacker AND the victim both die; the legitimate user has to
    re-login, which is the right response to detected theft.
  - Unknown / expired / bad-signature tokens still produce a plain
    401 with no side effects. Those happen routinely (clock skew,
    lost cookies, stale tabs) and aren't theft signals.
- **`authService.logout`** unchanged — deliberate single-token revoke,
  not a family kill.

### Regression tests

Three new cases in `describe('S-4 refresh-token family revocation')`:

- **Happy path** — three consecutive `/refresh` calls each return 200;
  the whole rotation chain shares a single `familyId` (DB read
  confirms exactly one distinct family for the user).
- **Reuse cascade** — register, rotate R1 → R2, replay R1: R1 returns
  401 AND R2 (a previously-valid sibling) is now also revoked (its
  next `/refresh` returns 401). Every row in the family has
  `revokedAt` set in the DB. Before this patch R2 stayed valid.
- **Family isolation** — same user logs in twice (register + login),
  producing two distinct `familyId`s. A reuse-triggered revocation on
  family A leaves family B's tokens fully working (rotating cleanly,
  returns 200).

### Verified

- Backend `tsc` ✅. Migration applied to the test DB via
  `prisma migrate deploy`.
- `auth.test.ts` 18/18 (15 existing + 3 new).
- Full integration suite: **290 passed, 5 skipped** (LDAP, pre-existing,
  needs the `ldap` profile). +3 from v1.30.4.
- Minor: `tests/integration/scim.test.ts` was seeding a refresh token
  directly via `prisma.refreshToken.create` without `familyId`;
  updated the seed to mirror the issueSession convention (`familyId`
  set to a unique value).

### Phase boundary

- The reuse-detection branch reads `revokedAt` and family-revokes; it
  doesn't distinguish "stolen and replayed" from "legitimate client
  race-retried after a network blip." That false-positive cost is
  modest (re-login) and erring on the side of revocation is the
  correct security posture; if it becomes an operational pain point a
  grace window (revokedAt within last 5s = no family revoke) is a
  cheap follow-up.
- We DON'T notify the user that a family revocation fired ("we think
  someone replayed your session — re-login required"). The audit log
  captures it via the existing refresh-error path; a dedicated
  `auth.refresh_reuse_detected` Activity row + a "suspicious activity"
  banner are tracked as a UX follow-up, not a security gap.
- A leaked DB snapshot still doesn't yield usable sessions (token
  hashes only, never raw values) — unchanged from v1.0.

## [1.30.4] — 2026-05-27

**Security patch — S-5 (restore ran hot against a live DB) + S-12
(pg_restore exit 1 was treated as success).**

### Summary

The v1.28 restore flow shelled out to `pg_restore --clean --if-exists`
while the backend was still serving traffic AND the schedulers
(`TASK_DUE`, `RECURRENCE`, `WEBHOOK`, `BACKUP`) were still ticking.
Two failure modes:

- **S-5:** an in-flight HTTP request or a scheduler tick could acquire
  a row lock on a table pg_restore was about to drop. pg_restore would
  then either deadlock or, with `--exit-on-error` not set, log the
  failure and press on with a partial restore.
- **S-12:** the success/failure detection was a regex over stderr —
  any pg_restore exit code 1 with no `/ERROR:/i` substring was reported
  as success, even when whole tables had silently failed to load. The
  admin's "Restore complete" banner could appear over a half-restored
  database.

### Fix

- **New `lib/maintenance.ts`** — read/set/clear an `InstanceSetting`
  keyed `system.maintenanceMode`. Persisted because the restore flow
  terminates the backend process and the fresh boot needs to know it
  was mid-recovery.
- **New `middleware/maintenance.ts`** — Fastify `onRequest` hook (the
  earliest in the lifecycle, before content-type parsing / validation
  / preHandler). Returns **503 with `Retry-After: 30`** for every
  route except `/health` and `/api/health`. Reads the InstanceSetting,
  caches the answer for 1s so a flood of requests doesn't hammer the
  pool while it's about to be torn down. Exports `_resetMaintenanceCache`
  for tests + the restore flow itself.
- **`app.ts`** registers the hook AND adds a new `/api/health` endpoint
  (the existing `/health` was exempt-but-internal — docker healthcheck
  only). Both endpoints are now in the exempt set.
- **`lib/lifecycle.ts`** — a tiny `AppLifecycle` registry decorated
  onto Fastify with `app.decorate('lifecycle', …)`. Holds
  `stopBackground()` (stops all in-process schedulers) and
  `processExit(code)` (calls `process.exit` in prod; no-op in tests).
  `buildApp` installs safe no-op defaults; `server.ts` swaps them for
  the real implementations after schedulers boot.
- **`server.ts`** clears the maintenance flag AFTER `app.listen()`
  succeeds. Placing the clear post-listen means a backend that crashed
  mid-boot doesn't accidentally lift the gate before it can serve real
  traffic.
- **Restore route handler** (`routes/backups.ts`) now orchestrates:
  1. `setMaintenance('restoring backup …', actorId)` + reset cache so
     the very next request 503s.
  2. `app.lifecycle.stopBackground()` — no scheduler ticks during
     pg_restore.
  3. `svc.restoreBackup(filename)` (S-12 hardened — see below).
  4a. On success: respond 200 first, then `setTimeout(processExit, 250)`
      so the body flushes before the listener closes. Compose restart
      brings a fresh container; the new boot clears the flag.
  4b. On failure: clear the maintenance flag, re-throw. `AppError`
      instances pass through unchanged (so a `notFound` from a missing
      dump file still returns 404, not 400).
- **`backupsService.restoreBackup`** (S-12):
  - Adds `--exit-on-error` so pg_restore stops on the first SQL error
    rather than logging and continuing with a partial restore.
  - Replaces the regex-over-stderr heuristic with strict exit-code
    handling: ANY non-zero exit is failure. The full stderr is
    captured and bubbled up in the thrown error (`Errors.badRequest`)
    so the admin sees pg_restore's complaint verbatim in the 400
    response body — no more silent partial restores.

### Regression tests

Three new blocks in `tests/integration/backups.test.ts`:

- **S-5 maintenance gate**:
  - With the flag enabled, `GET /api/health` AND `GET /health` still
    return 200.
  - With the flag enabled, `GET /api/admin/backups` returns 503 with
    `Retry-After: 30` and a structured body containing the `reason` +
    `since` timestamp.
  - With the flag absent, the normal API works (verifies the cache
    isn't pinned-on across tests).
- **S-5 restore route admin gating**: a non-admin caller still gets
  403 even with a real backup file present (the admin gate runs before
  the restore orchestration).
- **S-12 pg_restore failure surfaces stderr**: a deliberately corrupt
  dump produces a 400 with `pg_restore exited` / `failed to start` in
  the message (matches whether pg_restore is on PATH in the test
  container or not). After the failure, the `system.maintenanceMode`
  row is gone (the failure path cleared it).

### Verified

- Backend `tsc` ✅.
- `backups.test.ts` 13/13 (8 existing + 5 new).
- Full integration suite: **287 passed, 5 skipped** (LDAP — pre-existing,
  needs the `ldap` profile). +6 from v1.30.3.
- BACKUP.md + UPGRADE.md describe the new restore window.

### Phase boundary

- After a FAILED restore, the schedulers stay stopped (the failure
  path doesn't restart them — safer to assume the DB is in unknown
  shape). Operator recovery: `docker compose restart backend`. A more
  generous design would restart the schedulers automatically when the
  restore fails before any irreversible damage; deferred until we have
  a clear signal for "pg_restore failed before any object was dropped".
- pg_restore's `--single-transaction` would let a failed restore roll
  back as a unit. We didn't add it because dumps containing
  `CREATE EXTENSION` can fail under single-transaction mode (extension
  creation isn't always transactional). Revisit if dumps drift toward
  extension-free schemas.
- We DON'T abort in-flight requests when maintenance flips on. New
  requests 503; in-flight requests get one last query each (until the
  backend `process.exit`s after pg_restore completes). For a small
  instance this is invisible. For larger deployments a forceful
  `app.close()` before pg_restore would be cleaner — tracked.

## [1.30.3] — 2026-05-27

**Security patch — S-2: API-token scopes never enforced.**

### Summary

API tokens were minted with a `scopes: string[]` array (the UI even prompted
for `tasks:read,tasks:write`), and the auth middleware dutifully attached
that array to every request. The route layer never looked at it. A token
created with `scopes: ['tasks:read']` could:

- DELETE any task the owner had reach to.
- POST a comment, attachment, label, project, team, role, webhook…
- Mint another API token with `scopes: ['*']` via
  `POST /api/settings/api-tokens` — turning a narrow-scope token into a
  durable wildcard credential the original token's owner never saw.

The CI integration token model TaskHub advertised was effectively
"a long-lived bearer that pretends to be scoped." Patched.

### Fix

- **New `lib/scopes.ts`** is the single source of truth for the scope
  vocabulary. Ten strings, intentionally small:
  - `*` (wildcard — explicit "full access")
  - `tasks:read`, `tasks:write` (Task / subtask / attachment / label-on-
    task / notifications / trash-restore)
  - `comments:read`, `comments:write`
  - `projects:read`, `projects:write` (project CRUD + team-scoped Label
    CRUD)
  - `webhooks:manage`
  - `admin` (anything previously requiring `GlobalRole=ADMIN`: admin
    endpoints, instance settings, role management, team mutations,
    audit log, directories, backups)
- **New `requireScope(scope)` Fastify preHandler** in
  `middleware/requireScope.ts`. Composition contract:
  - JWT-authenticated requests have no `apiTokenScopes` on the request —
    they pass implicitly (session = the user themselves, who is already
    gated by `requireTeamRole` / `requirePermission` / `requireGlobalAdmin`).
  - API-token-authenticated requests must carry either `*` or the exact
    required scope. `read` does NOT imply `write` and vice versa.
  - 403 with body `"API token missing required scope: <name>"` on a miss.
- **`requireSessionAuth` (defense-in-depth)** — a sibling middleware
  that rejects ANY API-token request (even `*`-scoped). Wired into:
  - `POST/DELETE /api/settings/api-tokens` — a leaked wildcard token
    cannot mint or revoke another API token (closes the API-token-
    laundering chain).
  - `PATCH /api/auth/me/preferences` — identity-affecting.
  - `POST /api/auth/2fa/setup`, `/2fa/confirm`, `/2fa/disable`,
    `/2fa/recovery-codes` — a wildcard token cannot disable 2FA on the
    owning user. Pairs with the v1.30.1 S-3 fix on the pending-token
    side of the same attack surface.
- **`schemas/apiTokens.ts`** restricts the create body's `scopes` field
  to `z.enum(SCOPES)`. Existing token rows with arbitrary scope strings
  continue to load (the gate just won't match them — they're effectively
  no-op tokens until rotated, which is the correct user-visible behavior
  for typo'd or invented scopes that never worked anyway).

### Route coverage

Every route file under `backend/src/routes/*.ts` was audited. Each write
endpoint (POST / PATCH / PUT / DELETE) and most reads now sit behind
either `requireScope(...)` or `requireSessionAuth`:

- `tasks.ts`, `subtasks.ts`, `attachments.ts`, `notifications.ts`,
  `recurrence.ts`, `dependencies.ts` — `tasks:read` / `tasks:write`.
- `comments.ts` — `comments:read` / `comments:write`.
- `projects.ts`, `labels.ts` (team-scope), `roles.ts` (reads),
  `teams.ts` (reads) — `projects:read` / `projects:write`.
- `labels.ts` (task-label attach/detach), `trash.ts` (restore endpoints) —
  `tasks:write`.
- `webhooks.ts` — `webhooks:manage` (plugin-level addHook).
- `admin.ts`, `settings.ts`, `audit.ts`, `directories.ts`, `backups.ts`,
  `trash.ts` (purge / empty), `teams.ts` (mutations + create) — `admin`.
- `apiTokens.ts`, `auth.ts` (2FA management, preferences) —
  `requireSessionAuth`.
- `search.ts` — `tasks:read` (read-only, cross-team, scope guards the
  tokens-with-no-read-scope from hitting the cross-entity surface).

Routes intentionally unscoped: `system.ts` (public read by design);
`auth.ts` bootstrap routes (`/login`, `/register`, `/refresh`,
`/logout`, `/password/*`, `/verification/*`, `/2fa/login` — anonymous
or pending-token entrypoints); `notificationsWs.ts` (uses
`verifyAccess` directly, JWT-only by construction); SCIM (its own
bearer-token auth, not the API-token path).

### Verified

- Backend `tsc` ✅.
- 8 new S-2 regression tests in
  `tests/integration/apiTokensAndWebhooks.test.ts`:
  - `tasks:read` token → 403 on POST and 403 on DELETE.
  - Same `tasks:read` token → 200 on GET.
  - `*`-scoped token → 201 on POST and 204 on DELETE.
  - Normal JWT session → 201 on POST (unaffected by scope gates).
  - `comments:write`-only token → 403 on task DELETE (read does not
    imply write across resource families).
  - Invented scope `typo:write` at create time → 400 (vocabulary
    enforcement).
  - `*` API token → 403 on minting another API token
    (`requireSessionAuth`).
  - `*` API token → 403 on `POST /api/auth/2fa/disable`.
- Existing 7 apiTokens + webhooks tests still pass.
- Full integration suite: 281 passed, 5 skipped (LDAP — pre-existing,
  needs the `ldap` profile). 1 pre-existing flake on `backups.test.ts`
  (`BACKUP_DIR` env-cache order dependency — passes in isolation).
- Grep verification: every `r.post|r.patch|r.put|r.delete` across
  `routes/*.ts` either has a per-route `preHandler` that contains
  `requireScope` / `requireSessionAuth`, OR sits under a plugin-level
  `addHook('preHandler', requireScope(...))`.

### Phase boundary

- The frontend `ApiWebhooksPage` still uses a free-form
  comma-separated scope input. Admins typing an invalid scope now
  see a 400 from the create endpoint (better than the silent advisory
  state we shipped before), but the UI should grow a checkbox list
  driven by `SCOPES` so the vocabulary is discoverable. Tracked as a
  v1.31 UX polish.
- Read scope on TEAM list / team detail is conservatively gated on
  `projects:read` (since teams are the container above projects).
  A finer `teams:read` could ship later if integration patterns need it.

## [1.30.2] — 2026-05-27

**Security patch — S-1: updater sidecar accepted anonymous /upgrade
requests when `UPDATER_TOKEN` was empty.**

### Summary

The privileged updater sidecar (mounts the host docker socket + the repo
checkout → owning it = owning the host) used the auth check:

```js
if (TOKEN && req.headers['x-updater-token'] !== TOKEN) { send(401, …); return; }
```

When `UPDATER_TOKEN` was unset, `TOKEN === ''` and the conditional
short-circuited to the allow branch — **any caller on the compose
network could trigger `git pull + docker compose up -d --build`**. Startup
logged a `console.warn` and continued anyway. The header comparison itself
also used non-constant-time `!==`, leaking timing across requests.

### Fix

- `updater/server.js`:
  - At startup, refuse to start the listener when `UPDATER_TOKEN` is
    unset, non-string, or shorter than 24 characters. Log a clear
    `[updater] FATAL:` line and `process.exit(1)`. No silent
    warn-and-proceed.
  - Replace the `if (TOKEN && header !== TOKEN)` check with an
    unconditional `crypto.timingSafeEqual` comparison via a captured
    expected-token buffer. Length-mismatch returns false WITHOUT throwing
    (the raw `crypto.timingSafeEqual` raises on unequal-length buffers
    + leaks length via the throw timing); we do a dummy
    `timingSafeEqual(expected, expected)` first so the false branch
    spends comparable time to the equal-length false branch.
  - Extract `makeAuthCheck(token)` + `createServer(authCheck)` as named
    exports so the auth logic is unit-testable.
- `backend/src/config/env.ts`:
  - New `superRefine` on the env schema: when `UPDATER_URL` is set,
    `UPDATER_TOKEN` must be present and ≥ 24 characters. `loadEnv()`
    throws with a clear message instead of letting a half-configured
    upgrade pipeline ship.

### Scope

This patch DOES NOT touch the upgrade logic itself — concurrent-upgrade
mutex and git-ref pinning (S-10 territory) are deliberately deferred to
a later tier.

### Regression tests

- `tests/unit/updaterAuth.test.ts` — 7 cases covering `makeAuthCheck`:
  empty / short / non-string / undefined → throws at construction;
  correct token → true; wrong same-length token → false; wrong
  different-length header → false **without throwing** (regression
  against `crypto.timingSafeEqual` raising); missing / empty / non-
  string headers → false.
- `tests/unit/envUpdaterValidation.test.ts` — 5 cases on `loadEnv()`:
  `UPDATER_URL` unset passes; `UPDATER_URL` set + token missing throws;
  `UPDATER_URL` set + token shorter than 24 throws (8 chars and 23
  chars both); `UPDATER_URL` set + token exactly 24 / 64 chars passes.
  Uses `vi.resetModules()` + dynamic re-import to bust env.ts's
  module-local parse cache between cases.

### Verified

- Backend `tsc` ✅.
- New unit tests: 12/12 pass (7 updater + 5 env).
- Full integration suite: 273 passed, 5 skipped (LDAP — pre-existing,
  needs the `ldap` profile). No regressions.

### Phase boundary

- Concurrent-upgrade safety (the same admin double-clicking "Upgrade
  now" — or two operators racing) is **not** addressed here. The shell
  script is idempotent (`git pull --ff-only` is a no-op on second
  invocation, `docker compose up -d --build` rebuilds idempotently),
  but the LOG file gets interleaved + spawn-detached children race the
  prior children's `docker compose` step. Tracked as S-10 for a later
  tier.
- Git-ref pinning is also S-10 / later — the script still pulls
  whatever `origin/main` currently points at.

## [1.30.1] — 2026-05-27

**Security patch — S-3: pending-2FA token accepted by `requireAuth`.**

### Summary

A token issued after a correct password but before the second factor
(`signPending`, `kind: '2fa-pending'`, signed with the access JWT secret
+ 5-minute TTL) was accepted by `requireAuth` as if it were a regular
access token. An attacker who phished a password against a 2FA-enabled
account could:

1. Call `POST /api/auth/login` and receive a pending token.
2. Skip the second factor entirely by attaching the pending token to any
   `requireAuth`-gated request.
3. **Mint a long-lived API token** via `POST /api/settings/api-tokens` —
   converting the 5-minute pending window into a persistent account
   takeover that outlived the pending TTL.

### Fix

- `lib/jwt.ts` — `verifyAccess` now inspects the decoded payload and
  rejects any token carrying a `kind` claim. Real access tokens have no
  `kind`; pending-2FA tokens set `kind:'2fa-pending'`. Rejection goes
  through the same 401 path as any invalid/expired token, so callers
  see no information leak.
- `verifyPending` is unchanged — it already required `kind ===
  '2fa-pending'`, so the `/auth/2fa/login` flow continues to work.

### Approach: shared secret + verify-time guard (NOT dedicated secret)

The spec offered the option of a dedicated third secret
(`JWT_PENDING_SECRET`). We kept the shared access secret and added the
`kind`-claim guard at verify time. Rationale:

- The guard alone closes the vulnerability — a pending token can never
  satisfy `requireAuth` regardless of which secret signed it.
- A dedicated secret is an operational change (admins must rotate `.env`,
  redeploy) that would slow patch adoption without further reducing the
  attack surface for this specific finding.
- A separate `JWT_PENDING_SECRET` remains a sensible v1.32+ follow-up
  for cryptographic separation (so a leaked access secret can't forge
  pending tokens either) — tracked under the phase boundary.

### Regression tests

Added under `describe('S-3 regression: …')` in
`tests/integration/twoFactor.test.ts`:

1. `GET /api/auth/me` with a pending token → 401.
2. `POST /api/settings/api-tokens` with a pending token → 401 (the
   takeover chain — its absence is why this shipped).
3. Full happy path: login → pending → `/auth/2fa/login` with a correct
   TOTP code → full session; the new access token then succeeds on
   `/api/auth/me`.

### Verified

- Backend `tsc` ✅.
- `twoFactor.test.ts` — all 11 tests pass (8 existing + 3 new S-3).
- Full integration suite: 260 passed, 1 unrelated pre-existing flake
  (`backups.test.ts` `BACKUP_DIR` env-cache order dependency — passes in
  isolation), 5 skipped (LDAP — needs the `ldap` profile).

### Phase boundary

- The pending and access tokens still share the JWT signing secret.
  Cryptographic separation (`JWT_PENDING_SECRET >= 32 chars`) is a v1.32+
  follow-up. The current `kind`-claim verify-time guard is sufficient
  for this finding because a forged pending token can't satisfy
  `verifyAccess` regardless of which secret signed it.

## [1.30.0] — 2026-05-27

Full-text search across tasks, comments, and projects.

### Schema

- Three new `searchVector tsvector GENERATED ALWAYS AS (...) STORED`
  columns on `Task`, `Comment`, and `Project`, each backed by its own
  GIN index. Configuration is `simple` (no stemming) because TaskHub
  content is heavily Persian and the english stemmer would mangle
  Persian tokens.
- `Task` and `Project` use `setweight()` to bias title hits over
  description hits: `setweight(to_tsvector('simple', title), 'A') ||
  setweight(to_tsvector('simple', description), 'B')`. With Postgres'
  default `{1.0, 0.4, 0.2, 0.1}` weight vector, a title-only hit
  outranks a description-heavy hit at the same term frequency.
- `Comment` carries an unweighted vector — there's only one
  searchable field (`body`).
- Migration `20260527000000_full_text_search` is additive: it creates
  three columns + three GIN indexes. Existing rows are populated
  automatically by the `STORED` generation expression.
- `schema.prisma` declares each column as
  `searchVector Unsupported("tsvector")?`. `Unsupported(...)` keeps
  Prisma from drift-detecting the column AND auto-excludes it from
  the generated TypeScript client — the search service is the only
  reader, via `$queryRaw`.

### Backend

- New `services/searchService.ts`. Per-bucket parameterised
  `$queryRaw` calls (Task / Comment / Project) with `plainto_tsquery
  ('simple', $q)` so caller input — including punctuation — never
  reaches the SQL parser as syntax. Uses `ts_headline` to produce
  HTML excerpts with `<b>`/`</b>` highlights around each match.
- **Tenant isolation** (the critical rule): every query is restricted
  to `teamId = ANY(allowedTeams)` where `allowedTeams` is the list of
  teams the caller belongs to (resolved via `teamMembership.findMany`
  at the top of each request, same pattern as
  `auditService.list`). Comments scope through their parent Task's
  `teamId` since `Comment` doesn't carry a denormalised `teamId`. No
  global-ADMIN bypass — search reflects "what I have access to", not
  "what exists on this instance". Admins who need the latter use the
  audit log.
- Soft-deleted rows are excluded: `Task.deletedAt IS NULL` AND
  `Comment.deletedAt IS NULL` (with the parent Task also live).
  `Project` has no soft-delete (consistent with v1.21 — Trash was
  scoped to Task + Comment).
- Cursor pagination is per-bucket, keyset on `(ts_rank, id)`. Format
  `<rank>:<id>`. The predicate casts the cursor rank to `real` to
  match Postgres' `ts_rank` output precision — without the cast, JS
  numbers were binding as `double precision` and the equality arm of
  the tiebreak silently missed when many rows shared the same rank.

### Routes

- New `routes/search.ts` at `GET /api/search`. Query params:
  `q`, `type` (task/comment/project, optional), `taskCursor`,
  `commentCursor`, `projectCursor`, `limit` (default 20, max 50 —
  matching the audit endpoint shape).
- `requireAuth` only — the endpoint is intentionally cross-team. No
  `requireTeamRole` (there's no `:teamId` in the path).

### Frontend

- New `features/search/api.ts` client.
- New `features/search/SearchInput.tsx` in the top nav. Enter-to-submit;
  navigates to `/search?q=<encoded>`. Hidden on `xs` viewports.
- New `pages/SearchPage.tsx` reads `?q=` from the URL and renders three
  buckets (Tasks / Comments / Projects). Each bucket has its own
  "Load more" button driven by per-bucket cursors so the user can
  page through one bucket without re-fetching the others. Excerpts
  render through a sanitiser that strips everything except `<b>` and
  `</b>` (ts_headline already HTML-escapes the surrounding text).
- New `/search` route under `<ProtectedRoute>`.
- New `search.*` i18n keys in `en.json` + `fa.json`.

### Tests

- 11 new integration tests in `tests/integration/search.test.ts`:
  basic match (title / comment body / project description),
  title-weighted ranking (`setweight('A')` beats `setweight('B')`),
  **cross-team isolation** (THE critical test — user A and user B
  in separate teams must not see each other's hits), soft-deleted
  exclusion for both Task and Comment, per-bucket keyset cursor
  pagination across 25 same-keyword rows (3 pages, no overlap, last
  page returns `nextCursor: null`), `type=` filter (only the
  requested bucket populates), empty `q` short-circuit, caller with
  zero memberships returns empty buckets (not 500), anonymous caller
  returns 401.
- Full suite: **258 passed, 5 skipped** (LDAP — pre-existing, needs
  the `ldap` profile).

### Verified

- Backend `tsc` ✅, frontend `tsc --noEmit && vite build` ✅.
- Migration applied via `prisma migrate deploy` against the
  `postgres-test` container. `information_schema.columns` shows
  three `tsvector` columns; `pg_indexes` shows three GIN indexes
  named `*_searchVector_idx`.
- Live smoke against the running stack: searching "alpha" returned
  matches with title hits ranked above description-heavy hits
  (`0.669 > 0.331`), excerpts contained `<b>alpha</b>`. A freshly
  admin-provisioned user with no team memberships saw 0 hits across
  all three buckets.

### Phase boundary

- `simple` text-search config: no language-specific stemming. For
  English content, "deploying" / "deploy" / "deployed" don't unify.
  Acceptable for Persian-heavy content; a v1.31 follow-up could ship
  a per-instance `tasks.searchConfig` InstanceSetting and a one-shot
  migration that drops + re-creates the generated columns with the
  chosen config.
- Per-bucket cursors. Mixed-rank single-cursor pagination is a
  reasonable future change if the UX wants a single "Load more"
  button — for now grouped+per-bucket reads more naturally on the
  results page.
- The ADMIN bypass is INTENTIONALLY not extended to search. Search
  reflects "what I have access to", not "what exists on this instance".
- `pg_trgm` (fuzzy similarity) is not used. `plainto_tsquery`
  doesn't handle typos; if users ask for typo tolerance, that's a
  follow-up.

## [1.29.0] — 2026-05-26

Task dependencies — one task can be marked as blocked by another.

### Schema

- New model `TaskDependency`: cuid id, denormalised `teamId`, `taskId` (the
  blocked task), `dependsOnId` (the blocker), a `type` enum
  (`FINISH_TO_START` default + `RELATES_TO`), `createdAt`. Both FKs
  `ON DELETE CASCADE` so deleting either task tears its edges down with
  it. Unique `(taskId, dependsOnId)` prevents duplicate edges; indexes on
  `teamId` (tenant scoping) and `dependsOnId` (used by the unblock fan-out).
- New enum `DependencyType` + new value `TASK_UNBLOCKED` on `NotifyType`.
- Migration `20260526120000_task_dependencies` is additive: creates the
  enum + table + indexes + FKs, adds the enum value, and backfills the
  new `task.manage_dependencies` permission onto every existing system
  Manager role (v1.23 convention).

### Backend

- New `services/dependenciesService.ts`. Owns:
  - `add()` — runs a BFS reachability check from `dependsOnId` over the
    team's edge set; if `taskId` is reachable, throws `409
    DEPENDENCY_CYCLE` BEFORE inserting. Also rejects self-loops (`400`),
    cross-team targets (opaque `404`), cross-project targets (`400`), and
    duplicate edges (`409 CONFLICT` via Prisma P2002).
  - `remove()` — id-scoped by teamId so a forged id from another tenant
    404s.
  - `list()` — both directions joined with task titles + statuses.
  - `assertStatusTransitionAllowed()` — the status guard. Wired into
    `tasksService.update()` and `tasksService.reorder()`; throws `403
    DEPENDENCY_BLOCKED` when the InstanceSetting
    `tasks.dependencyEnforcement` is `"block"` and a transition to
    `IN_PROGRESS`/`DONE` would leave incomplete blockers.
  - `notifyUnblocked()` — runs inside the same transaction as a
    `→ DONE` transition; for every dependent task whose remaining
    incomplete-blocker count is now zero, writes a `TASK_UNBLOCKED`
    Notification to its assignee + technician (deduped, actor excluded).
  - `loadIncompleteBlockerCounts(taskIds)` — one round-trip yields a
    `{taskId → count}` map. Used by the kanban list path so we don't
    issue an N+1.
- New permission constant `task.manage_dependencies` (group: `Tasks`).
  Required for `POST /dependencies` and `DELETE /dependencies/:id`.
  Reads are open to any team member; the migration grants the
  permission to every existing system Manager role.
- New `tasks.dependencyEnforcement` `InstanceSetting` mirroring the
  v1.18 `tasks.dateEditRestriction` shape: `"off" | "warn" | "block"`,
  default `"off"`.
- New webhook events `task.dependency_added` / `task.dependency_removed`,
  emitted after-commit using the v1.8 emit pattern.
- Activity-log entries `task.dependency_added` / `task.dependency_removed`
  via the standard `logActivity` helper.
- `TaskView` (and its Zod response schema) gains
  `incompleteBlockerCount: number` so the kanban can render a lock badge
  without per-card lookups.

### Routes

- New `routes/dependencies.ts` mounted at
  `/api/teams/:teamId/projects/:projectId/tasks/:taskId/dependencies`:
  - `GET /`              — list both directions + `enforcement`.
  - `POST /`             — add (requires `task.manage_dependencies`).
  - `DELETE /:dependencyId` — remove (requires the same).

### Frontend

- New `features/dependencies/{api,DependenciesSection}.tsx`. The section
  on `TaskDetailPage` renders "Blocked by" + "Blocking" side-by-side and a
  picker scoped to the same project, excluding the current task + tasks
  already listed as blockers. Friendly inline error for the `409
  DEPENDENCY_CYCLE` and `409 CONFLICT` (duplicate) cases.
- Kanban card on `TasksPage` shows a lock badge (`🔒 N`) when
  `incompleteBlockerCount > 0`. Tooltip says how many.
- New admin-only "Task dependencies — enforcement" section in
  `Settings → Preferences`, three-way radio off / warn / block,
  persisted to `tasks.dependencyEnforcement`.
- EN + FA i18n strings under the `deps.*` namespace.

### Tests

- 13 new integration tests in `backends/tests/integration/dependencies.test.ts`:
  self-loop (400), cross-team opaque 404, cross-project 400, cycle 409
  DEPENDENCY_CYCLE, duplicate 409, both-directions GET, status guard in
  `"block"` mode (rejects then allows once the blocker completes), guard
  is a no-op in `"warn"`/`"off"`, unblock notification fan-out, no
  notification when other blockers remain, FK cascade on hard delete,
  DELETE /:id round-trip, member-without-permission 403.
- Updated `tests/integration/roles.test.ts` permission-catalog count
  (14 → 15) to reflect the new `task.manage_dependencies` constant.
- Full suite: **247 passed, 5 skipped** (LDAP — pre-existing, needs the
  `ldap` profile).

### Verified

- Backend + frontend typecheck pass.
- Live smoke against the running stack: created Blocker / Blocked tasks,
  added an edge, GET returned the join, attempting the reverse edge
  returned `409 DEPENDENCY_CYCLE`. `incompleteBlockerCount` was `1` on
  the dependent and `0` on the blocker.
- Migration `20260526120000_task_dependencies` applied cleanly via
  `prisma migrate deploy` (no manual SQL).

### Phase boundary

- Cross-project dependencies within a team are intentionally rejected
  (`400`). Revisit if asked — the notification fan-out + status-guard
  blast radius for cross-project edges deserves its own design pass.
- Cycle detection is not transactionally serialised against concurrent
  inserts. In a single-instance self-hosted deployment the race is
  unlikely; the safe fix is a row-level lock or a periodic janitor —
  tracked here as a v1.30 follow-up.
- `RELATES_TO` edges are stored but unused by the UI today. They're in
  the schema so a future "see also" affordance can light up without a
  schema change.

## [1.28.0] — 2026-05-26

Restore + upload for the backup feature.

### Backend

- `services/backupsService.ts` gains two methods:
  - `restoreBackup(filename)` — spawns `pg_restore --clean --if-exists
    --no-owner --dbname=<connectionUrl> [--schema=<schema>] <file>`. Calls
    `prisma.$disconnect()` first so the pool isn't holding locks on objects
    pg_restore is about to drop; Prisma reconnects automatically. Exit
    code 1 with no ERROR/FATAL stderr lines is treated as success (the
    expected "extension already exists" noise from `--clean` on a fresh
    schema).
  - `saveUpload({ stream, originalName, isTruncated })` — streams an
    admin-uploaded `.dump` into `BACKUP_DIR`. Server-side renames to
    `upload-<ISO ts>-<sanitised stem>.dump` so admin uploads can't collide
    with scheduler-written `taskhub-*.dump` files. On truncation (over the
    fileSize limit) the partial file is unlinked + the request 400s.
- Two new endpoints under `/api/admin/backups`:
  - `POST /:filename/restore` — destructive; UI wraps in confirm.
  - `POST /upload` — multipart/form-data, single file. Per-route
    `fileSize` override pulled from `BACKUP_UPLOAD_MAX_BYTES` so backup
    uploads aren't capped by the 10 MiB `UPLOAD_MAX_BYTES` global (sized
    for task attachments).
- `applyRetention` now scopes to `taskhub-*` only — admin uploads are
  outside the rotation, so an uploaded restore-source can't vanish on the
  next scheduler tick.
- New env var `BACKUP_UPLOAD_MAX_BYTES` (default 2 GiB).

### Frontend

- `pages/settings/BackupsPage.tsx`:
  - New "Upload a backup" section between the config form and the file
    list. `<input type="file" accept=".dump">` + Upload button. On success
    the list refetches and the new file appears.
  - New per-row "Restore" button (amber outline). Click pops a
    `window.prompt` asking the admin to type `RESTORE` to confirm — extra
    friction because this is destructive and an accidental Enter on a
    bare `confirm()` is plausible.
  - On restore success, the page invalidates ALL queries (not just
    `['backups']`) and alerts the admin to reload so other tabs pick up
    the post-restore data.
- `features/backups/api.ts` adds `restoreBackup(filename)` and
  `uploadBackup(file: File)` (uses FormData + multipart/form-data CT).

### Verified

- Two new integration tests:
  - Upload via `app.inject` with a hand-rolled multipart body; verifies
    server-side filename sanitisation (spaces stripped), list/download/
    delete round-trip on the uploaded file.
  - Restore endpoint: non-admin → 403; admin + missing file → 404.
  - pg_restore path itself is covered manually: ran a fresh `pg_dump`
    against the live stack, then `pg_restore` from the same file (~3 s
    for a 79 KB dump). Confirmed admin login + session continuity post-
    restore.

### Phase boundary

- Restore is online — running services see errors while pg_restore is in
  flight. Acceptable for single-instance self-hosted; a future release
  could put the backend behind a "maintenance mode" gate during restore.
- Restore does NOT migrate the schema before applying the dump. If the
  dump was taken from an older code version, run `prisma migrate deploy`
  manually before restoring (or use a same-version dump). UI-side schema
  diffing is a v1.29+ concern.

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
