# Architecture

**Version:** v2.5.46 (unified — frontend, backend, and manual share one number) (2026-07-07)

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
    be emailed via `lib/mailer.ts` when SMTP is configured (best-effort).
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
| Project labels (v1.74) | Team-scoped `Label` catalog shared with tasks via `ProjectLabel` join (`projectId`+`labelId`, cascade both ways). `labelIds` on project create/update (replace-set). Cross-team labels rejected (400). |
| Automation rules (v1.60) | `AutomationRule` + `AutomationCondition` + `AutomationAction` + `AutomationRun` (team-scoped). Engine runs **after-commit** beside webhooks; loop guard = shared `(ruleId,taskId)` fired-set + max depth 5; actions call real services (tasks, labels, custom fields, comments). Permission: `automation.manage`. |
| Theme tokens (v1.61) | `ThemePreference` enum: `LIGHT`, `DARK`, `SYSTEM`, `MIDNIGHT`, `SOLARIZED`, `HIGH_CONTRAST`, `NORD`. **Stored preference** may be `SYSTEM`; **resolved theme** (what the DOM gets) is always a concrete palette. `SYSTEM` → `matchMedia('(prefers-color-scheme: dark)')` with a live change listener (detached when switching away). `<html>` carries one `theme-*` class; dark-family resolved themes also get legacy `dark` for Tailwind `dark:` during migration. Semantic tokens in `frontend/src/styles/themes.css` (`--color-bg`, `--color-text`, …); Tailwind colors reference `var(--color-*)`. |
| Holidays (v1.62) | Dedicated **`Holiday`** model (not InstanceSetting JSON) for per-date metadata: `date` at **UTC midnight**, `name`, `recurring`, `source`. Weekends stay in `InstanceSetting` key `calendar.weekend`. Frontend `isOffDay()` = `isWeekend()` OR `isHoliday()`. Bootstrap via `calendarHolidays` on `/api/system/info`. Admin CRUD at `/api/holidays`. |
| Datetime prefs (v1.63) | `User.timeZone` (nullable IANA), `User.timeFormat` (`H12`/`H24`), `User.dualCalendar`. **Display-only** — instants stay UTC in DB. Frontend splits formatters: **`lib/shamsi.ts`** = calendar dates (UTC-midnight, zone-neutral); **`lib/datetime.ts`** = timestamps (user zone + 12h/24h). Invalid IANA → 400 on PATCH. |
| Working-day scheduling (v1.64) | InstanceSetting keys `scheduling.rollOffdayDueDates` + `scheduling.workingDaysOnly` (both default **false**). Backend `WorkingDayCalendar` mirrors frontend `isOffDay`. Rolls apply on create/update/spawn only (not retroactive). `spawnedForPeriod` keyed on spawn date, not rolled due date. Gantt API adds `workingDayCount` per row when enabled. |
| Due reminders (v1.65) | `User.reminderLeadHours` (default 24, 1–168). Scheduler resolves assignee → creator → `TASK_DUE_LEAD_HOURS`. One-shot via `Task.dueNotifiedAt`. InstanceSetting `reminders.skipOffDays` shifts notify instant to prior working day when nominal day is off; fires immediately if shifted time is past. `lib/reminderTiming.ts`. Per-task override deferred. |
| Iranian holiday import (v1.66) | Vendored `src/data/ir-holidays.json` (time.ir dates via shamsi-holidays static files, years 1404–1406). Admin-only `GET/POST /api/holidays/import/*`. `react-date-object` Jalali→UTC midnight (matches frontend). Idempotent upsert (`source: IMPORT`); MANUAL/SYNC dates never overwritten. No network at runtime. |
| Configurable dashboards (v1.67) | `Dashboard` + `DashboardWidget` (team-scoped, owner + optional `shared`). Widget config stored as typed columns + JSON for filters/config. **Data resolution:** `GET /dashboards/:id/widgets/:widgetId/data` → `WidgetDataResolver` builds a team-scoped `TaskWhereInput` from filters, then branches on widget type. Reuses `ReportsService.summary()` / `listWorkload()` for unfiltered status/assignee task-count widgets; otherwise `groupBy`, in-memory due-bucket bucketing, custom-field joins on `CustomFieldValue`/`CustomFieldValueOption`, and Prisma `_sum` for budget/number aggregates. Cross-team custom-field refs → 404. Edit: owner or team MANAGER. |
| Workload capacity view (v1.68) | Extends reports, does not replace `/reports/workload`. **`GET /reports/workload/detail`** → `workloadDetail()` in `ReportsService`, aggregation in `lib/workloadAggregation.ts`. Single `task.findMany` on `[teamId, assigneeId]` / `[teamId, dueDate]` indexes; due buckets: overdue (< today UTC), this_week (+7d), next_week (+14d), later, no_due. Priority weights when `weighted=true`. Threshold is UI-only in v1. |
| Budget / cost report (v1.73) | **`GET /reports/budget`** + **`/budget.csv`**. `ReportsService.budgetReport(teamId)` → `{ projects, rollupByCurrency }`. Per-project rows from `Project.plannedBudget` / `budgetCurrency` only (project `actualSpent` removed in v1.73; task budgets unchanged but not rolled up). `hasBudget` when `plannedBudget` is set. Rollup groups by currency; never sums across IRR/EUR/USD. Read-only. |
| Intake forms (v1.69) | **`form.manage`** permission. Team CRUD at `/teams/:teamId/forms`; submit creates tasks via existing `TasksService` + custom-field validators. **Public submit** is opt-in (`mode=PUBLIC`), mirrors S-9 caution: opaque token, IP rate-limit + honeypot, no team/member leak, assignee/PERSON fields rejected, system user as creator. Render: `GET /public/forms/:token` returns labels/types only. |
| Per-project full-edit delegation (v1.86) | New **`ProjectEditDelegate`** join (`@@id([projectId, userId])`) — a deliberately **separate** signal from project access. The owner (or a global ADMIN) names delegates who get project **WRITE** *and* are lifted past the `manager-only` date gate + the `task.change_responsible` gate, **for that project only**. Kept out of the group/permission branch of `resolveProjectAccess` on purpose: letting WRITE / group-FULL bypass those field gates would nullify them for *every* write-holder. Enforced in `resolveProjectAccess` (delegate → WRITE) + the field gates in `tasksService`/`subtasksService`; managed via `PUT /teams/:teamId/projects/:projectId/delegates` (owner/admin only), self-read via `GET …/delegates/me`. Owner reassignment (also v1.86) reuses `assertOwnerInTeam` and is gated to owner/admin as a non-name field on `updateProjectBody`. |
| Project health / RAG (v1.91) | First PMIS *neutral-core* field. New **`RagStatus`** enum + `Project.ragStatus` (default `GREEN`), `ragReason`, `healthUpdatedAt` (migration `20260630120000_project_health`, additive — no backfill). Set via **`PUT /teams/:teamId/projects/:projectId/health`** gated on project **WRITE** (`assertCanWriteProject`: owner / `project.write_all` / FULL grant); non-writers get the existence-hiding 404. Included on every project response. Manual PM judgement for now — auto-derive from schedule/cost variance + a `ragManual` flag is deferred. Feeds the planned portfolio roll-up across teams/businesses. |
| Project code (v1.92) | Optional `Project.code` (nullable `TEXT`) + **`@@unique([teamId, code])`** (migration `20260701120000_project_code`). Human-facing code (e.g. `EPC-014`), unique within a team when set; nullable so existing projects need no backfill (Postgres NULLs are distinct → many code-less projects per team). Settable on create + update; a duplicate trips P2002 → surfaced as **409 CONFLICT** via `rethrowProjectCodeConflict`. A **non-name field**, so a rename-only manager can't set it (owner/admin only); cross-team reuse is allowed. |
| Task neutral-core schedule/progress (v1.93) | `Task.baselineStart/baselineEnd`, `actualStart/actualEnd` (nullable timestamps) + `Task.percentComplete` (int, default 0, DB CHECK 0..100) — migration `20260702120000_task_baseline_actual_progress`. Baseline/actual dates join the manager-only date gate (`touchesDates` → `EDIT_DATES`); `percentComplete` is an `EDIT_DETAILS` field. Additive; no consumer yet — the substrate for scheduling/CPM, EVM, and portfolio roll-up. |
| Task RACI — Consulted/Informed (v1.94) | Responsible (`Task.responsibleId`) and Accountable (`Project.accountableId`) already exist as scalars; the **many-per-task** C and I legs land in a join table **`TaskRaci {taskId, userId, role}`** + **`RaciRole`** enum (`CONSULTED`/`INFORMED`), `@@unique([taskId, userId, role])`, cascade on task **or** user delete — migration `20260703120000_task_raci`. **Replace-set semantics** (like project delegates / task labels): `GET` reads, **`PUT …/tasks/:taskId/raci {entries:[{userId,role}]}`** replaces the whole set in a transaction (dedup by `(userId,role)`; every user must be a team member → 400 otherwise). Reads need project READ; writes reuse `requireProjectWriteAccess`. The task↔project↔team chain is re-asserted in the service so a cross-tenant id returns the existence-hiding 404. Additive; empty C/I = today's behaviour. |
| PMIS R0 plumbing (v1.95) | Substrate for the PMIS waves; gates nothing yet. **Permissions:** new `pmo.*` (manage/assign/override profiles, set team/group defaults), `core.capture_baseline`, `portfolio.*` (view/manage/attach_project/manage_managers) keys in `lib/permissions.ts` — flat dot strings, *not* the roadmap's `pmo:*` colon form; `core.set_health` deliberately omitted (v1.91 health already gates on project WRITE). New `manageProfiles` team capability (= `pmo.manage_profiles`). Migration `20260704120000_pmis_r0_plumbing` backfills the keys onto every existing system Manager role (new teams get them via `ensureSystemRoles` → `DEFAULT_MANAGER_PERMISSIONS`). **Module registry** (`lib/moduleRegistry.ts`): the authoritative 15-module key list + a hand-authored dependency DAG (`evm`→`baselines`+`cost_control`, etc.) + `expandWithDependencies` closure — R2's `effective-config` resolver will validate against it. **Money:** `lib/money.ts` fixes integer-minor-units (`amountMinor: bigint`) as the standard for all future cost data (existing `Decimal` budgets untouched); scaffolds the global `FxRate` reference table + nullable `Team.reportingCurrency` (consumed from R4). |
| Project baselines + org-unit (v1.96) | **`ProjectBaseline {name, source, isCurrent, snapshot Json, capturedBy, capturedAt}`** + `BaselineSource` enum (`MANUAL`/`CHANGE_REQUEST` — only MANUAL written in R1; CHANGE_REQUEST reserved for R9). `teamId` denormalized (tenancy invariant). Capture snapshots every live task's plan/progress dates into `snapshot`; **exactly one `isCurrent` per project** (a new capture demotes the rest in one transaction). `GET/POST …/projects/:id/baselines`; capture gated **project WRITE + `core.capture_baseline`** (dual gate, same shape as dependencies; ADMIN bypasses the perm). Cross-tenant id → existence-hiding 404. Also adds **`Project.orgUnitId`** — a plain nullable id (no FK yet; the OrgUnit table + FK arrive in R3), indexed for the future portfolio subtree roll-ups. Migration `20260705120000_project_baseline_org_unit`, additive. |
| Task WBS — n-level tree (v1.97) | `Task += parentId? (self-FK, same project, `onDelete: SetNull`) + wbsOrder Int`. **Only the structural fields are stored**; the outline `wbsCode` ("1.2.3"), `wbsDepth`, `isSummary`, and `rollupPercentComplete` are **derived on read** in **`GET …/projects/:id/wbs`** (flat DFS pre-order). *Decision: compute-on-read over stored codes* — keeps task create/move/delete from rewriting the whole project's codes and makes soft-delete/restore self-correcting (a child of a trashed parent floats to a root in the view). Subtask stays the leaf checklist; WBS nests Tasks. `POST …/tasks` accepts `parentId` (appends as last child); **`POST …/tasks/:id/move {newParentId, position}`** reparents/reorders with self-parent, cross-project, cycle (walks the ancestor chain in memory), and depth-cap (`MAX_WBS_DEPTH=20`) guards; both reuse `requireProjectWriteAccess`. Rollup % is a leaf-weighted average over the subtree. Gantt integration deferred to R5. Migration `20260706120000_task_wbs`, additive (no backfill — defaults make every existing task a root). |
| PMIS R4 — Cost Control + Time Tracking (v2.0) | **8 models, money as integer `amountMinor: BigInt` + ISO currency** (R0 `lib/money.ts`). **Timesheets:** `RateCard {scope USER\|ROLE, userId?/role?, costRateMinor, billRateMinor?, currency, effectiveFrom/To}`; `TimesheetPeriod {periodStart/End, status OPEN→SUBMITTED→APPROVED\|REJECTED→REOPENED}`; `TimeEntry {projectId, taskId?, minutes, billable, costRateMinorSnapshot, currencySnapshot, periodId?}`. *Decision: snapshot the cost rate at log time* so historical actuals never drift; *period status is the approval machine* (no shared Approval table — mirrors the task-approval stance). **Cost:** `CostAccount` (per-project CBS tree, materialized `path`, one seeded DEFAULT); `BudgetLine` (planned value, `source MIGRATED\|MANUAL`); `Commitment`; `Expense` (approve → posts an actual); **`ActualCostEntry`** = the **append-only canonical AC ledger** (`source TIMESHEET\|EXPENSE\|INVOICE\|MANUAL`, `baseAmountMinor` in `reportingCurrency`, `fxRateId?`; corrections post a **reversing row**, never edit). *Decision: approving a timesheet posts labour into the ledger in one transaction* (rate × minutes, FX-converted via `lib/fx.ts`); reopening an approved period posts reversals. **Gating:** timesheets routes are **team-scoped** (a weekly sheet spans projects) so the `timesheets` module is enforced **per-entry in the service**; cost routes are **project-scoped** and use `requireModule('cost_control')` on the path. New perms `cost.manage` / `timesheet.approve` / `timesheet.manage_rates` (additive — logging your own time needs none). The per-project **`/cost/summary`** (planned/committed/actual/remaining per currency + reporting-currency base) is the authoritative cost view; the team `/reports/budget` stays legacy planned-only read-through this release. Migration `20260709120000_pmis_r4_cost_time` backfills a DEFAULT account + a MIGRATED budget line from each project's `plannedBudget`, seeds identity FX rows, and grants the new perms to Manager roles. |
| PMIS R9 — Specialized Lifecycle (v2.5) | **`RiskRecord {probability, impact, score, response RiskResponse, mitigationPlan, ownerId, closedAt}`** — risk register per project; score = probability × impact, auto-set on create/update; sequential `RISK-NNN` reference. **`ChangeRequest {status ChangeRequestStatus, scheduleDeltaDays, costImpactMinor, costCurrency, submittedById/At, decidedById/At}`** — CR lifecycle DRAFT→SUBMITTED→APPROVED→APPLIED; `apply()` transaction snapshots a `CHANGE_REQUEST` baseline (flips prior ones to `isCurrent=false`) and optionally posts an `ActualCostEntry`. **`Vendor {name, contactEmail, deletedAt}`** — team-scoped, soft-delete; **`Contract {vendorId, status ContractStatus, valueMinor}`** + **`PurchaseOrder {contractId?, status PoStatus, amountMinor}`** — project-scoped procurement; on PO→ISSUED, auto-creates a `Commitment` via `ensureDefaultCostAccount()`. **`QualityNcr {severity NcrSeverity, disposition NcrDisposition, correctiveTaskId?}`** — NCR linked to optional corrective task. *Decision: one `lifecycleService.ts` for all four domains* to avoid circular deps. Reference numbering: per-entity sequential count → `RISK-001`, `CR-001`, `CON-001`, `PO-001`, `NCR-001`. Permissions: `risk.manage`, `change.manage`, `change.approve`, `procurement.manage`, `quality.manage`. Migration `20260715120000_pmis_r9_lifecycle`. |
| PMIS R8 — Record Framework (v2.4) | **`PmisRecordType {teamId? (NULL=global), key, name, kind BUILTIN\|CUSTOM, statusSet Json, transitions Json, position}`** — type catalog, seeded with 5 built-ins (issue/rfi/document/stakeholder/mom, `teamId=NULL`). **`PmisRecord {recordTypeId, reference, status, fieldValues Json, assigneeId?, closedAt}`** — instance per project; reference = `${rt.key.toUpperCase()}-NNN` (sequential count within project). **`PmisRecordComment {recordId, authorId?, body}`** — discussion thread. *Decision: `Pmis` prefix* to avoid collision with TypeScript's built-in `Record<K,V>` utility type. `listRecordTypes` returns `OR: [{teamId: null}, {teamId}]` so built-ins always appear. Gated by `record.manage` permission. `teamId=null` built-ins survive `ON DELETE CASCADE` only for team-FK rows; the global seed rows have `teamId=null` and are unaffected. Migration `20260714120000_pmis_r8_records`. |
| PMIS R7 — Earned Value Management (v2.3) | **`EvmSnapshot {snapshotDate, bac, pv, ev, ac, cv, sv, cpi, spi, eac, eacMethod EacMethod, vac, tcpi, currency}`** — persisted metric point for S-curve. On-demand compute in `EvmService.computeEvm()`: BAC=Σ BudgetLines; PV=linear interpolation over `BaselineEntry.start/end` × task budget (no stored `plannedValueMinor`); EV=Σ(percentComplete/100 × leafTaskBudget); AC=Σ ActualCostEntry up to `asOf`. *Decision: derive PV from time-fraction × budget* because `BaselineEntry` stores only schedule bars, not a pre-computed value. Three EAC methods: `CPI_BASED` (BAC/CPI), `SPI_BASED` (AC+(BAC-EV)/SPI), `TCPI_BASED` (AC+(BAC-EV), targets CPI=1). Snapshot → S-curve series via `GET …/evm/series`. Module-gated on `evm`. Migration `20260713120000_pmis_r7_evm`. |
| PMIS R6 — Resource Management (v2.2) | **`Resource {type ResourceType, userId?, email?, maxUnits Decimal, costRateMinor?, calendarId?, deletedAt}`** — team-scoped catalog, soft-delete, optional link to a User and `CapacityCalendar`. **`Skill {teamId, name}`** — skill tag catalog. **`ResourceSkill {resourceId, skillId, level Int}`** — join with proficiency (`@@id([resourceId, skillId])`). **`ResourceAssignment {taskId, resourceId, units, plannedHours?, actualHours?}`** — links a resource to a WBS task; unique per `(taskId, resourceId)`. Workload report aggregates `SUM(plannedHours/actualHours)` per resource across a project. *Decision: `setResourceSkills` uses replace-set semantics* (delete-all then re-insert) matching the existing labels/RACI pattern. Gated by `resource.manage` permission. Migration `20260712120000_pmis_r6_resources`. |
| PMIS R5 — Scheduling engine + baselines on Gantt (v2.1) | **`TaskDependency += lag Int, lagUnit LagUnit, calendarMode CalendarMode`** (signed lag/lead on FS/SS/FF edges); **`Task += isMilestone, milestoneKind?`**; **`Project.scheduleVersion Int`** bumped whenever schedule-shaping data changes (task dates, deps, baseline capture/activate) to bust the in-memory CPM cache. **`BaselineEntry {baselineId, taskId, startDate?, endDate?, percentComplete}`** — formal per-task frozen bars (capture writes rows + keeps the legacy `snapshot` JSON); **`POST …/baselines/:id/activate`**, **`GET …/baselines/compare`**, **`GET …/reports/variance`** (slip days vs current/named baseline, gated `baselines`). **`CapacityCalendar` / `CalendarException`** tables scaffold team/resource calendars (runtime CPM still reads `WorkingDayCalendar` until R6). **`lib/cpm.ts`**: on-demand forward/backward CPM over WBS-leaf tasks (summary tasks excluded); cycles → `DEPENDENCY_CYCLE` 409; cache keyed `(projectId, scheduleVersion)`. **`GET …/reports/gantt?include=criticalPath,baseline,milestones`** adds optional `tasks`/`links`/`criticalChain` while legacy subtask `rows` stay unchanged; `criticalPath` gated `cpm_schedule`, `baseline` gated `baselines`. Frontend Gantt overlay: critical-path highlighting, lag labels (`FS+2d`), milestone diamonds, baseline ghost bars. Migration `20260710120000_pmis_r5_schedule` backfills `BaselineEntry` from existing snapshots. |
| PMIS R3 — Portfolio / Program (v1.99) | **`OrgUnit {parentId, type HOLDING\|COMPANY\|PORTFOLIO\|PROGRAM, name, code, path, managerId?, currency?}`** + optional **`TeamOrgUnit`** (team ↔ org-unit hint). `Project.orgUnitId` FK (column since v1.96). *Decision: materialized `path`* for subtree roll-ups (`startsWith` prefix) — move reparents the node and rewrites descendant paths in one transaction. Strict type hierarchy: HOLDING = root only; COMPANY under HOLDING/COMPANY (v2.5.27); PORTFOLIO under HOLDING/COMPANY/PORTFOLIO; PROGRAM under PORTFOLIO/PROGRAM. Global routes at `/api/org-units` (not team-scoped); gated by R0 `portfolio.*` perms. Project attach at `PUT …/org-unit` (`portfolio.attach_project` + project access). Reports reuse team-report math (budget rollups, task % complete, RAG counts) grouped by subtree; EVM stub until R7. Migration seeds `orgunit_holding`. Teams unchanged as security boundary. |
| Org unit — `COMPANY` (v2.5.27) | Additive `OrgUnitType` value for legal subsidiaries, placed between HOLDING and PORTFOLIO. **Placement (D1):** COMPANY under HOLDING or COMPANY; PORTFOLIO's allowed parents extended to `{HOLDING, COMPANY, PORTFOLIO}`; COMPANY may not sit inside a delivery structure (PORTFOLIO/PROGRAM). Migration `20260716120000_orgunit_company` (`ADD VALUE`, no re-parenting). **RBAC (D2 — on record):** COMPANY is *reporting-only*. `Team` remains the sole RBAC boundary; there is deliberately **no** visibility filtering, per-subtree permission, or COMPANY-scoped role. If subsidiary-level isolation is ever required it is a separate design (subtree-path-scoped `portfolio.view`), not a COMPANY property. **Seeding (D3):** subsidiary names are never hardcoded — optional `SEED_ORG_COMPANIES` JSON file drives idempotent COMPANY creation, resolving its `root` HOLDING by `code`. `currency` set at COMPANY level is the natural home for a subsidiary's reporting currency (R4 roll-up consumes it). |
| Personal tasks — `StandaloneTask` (v2.5.28, Option C) | **`StandaloneTask {ownerId, title, description?, status StandaloneTaskStatus, priority TaskPriority?, dueDate?, completedAt?, sortOrder, lastDueNotifiedAt?, promotedTaskId?, deletedAt?}`** — quick-capture personal tasks that live **outside any project/team**. *Decision: full isolation (Option C)* — a separate model with its own `StandaloneTaskStatus {TODO,IN_PROGRESS,DONE}` enum (Subtask precedent: separate lifecycles get separate enums) and **zero edits to `Task`/`Subtask` or any project-scoped service**. **D1 — ownership:** strictly personal; `ownerId` (Cascade), **no teamId**, no sharing/assignment. Every query filters by `ownerId`; other users' rows → 404, never 403 (no existence leak). me-scoped routes under `/api/me/standalone-tasks` (`tasks:read`/`tasks:write`, mirrors `meTasks`). **D5 — reminders:** additive branch in `dueDateScheduler` emits `NotifyType.STANDALONE_TASK_DUE` (one-shot via `lastDueNotifiedAt`, per-owner lead-hours + off-days); `Notification.teamId` made **nullable** to carry team-less personal notifications (list query already filters by `userId` only). **D8 — promote:** one-way `POST …/:id/promote {projectId}` reuses the existing task service (caller needs project WRITE via `resolveProjectAccess`), then soft-deletes the standalone row and records `promotedTaskId` as a **plain string with NO Prisma relation** — isolation over referential integrity, deliberate; partial failure returns `PROMOTE_PARTIAL` rather than a cross-service rollback. **D4 — excluded from v1 (on record):** subtasks/checklists, labels, custom fields, attachments, comments, recurrence, time entries, workload/report inclusion, Excel export, API-token automation. Migration `20260717120000_standalone_tasks` (additive; new model/enum + nullable relax only). |
| PMIS R2 — Project Profiles (v1.98) | **`ProjectProfile {key, name, kind BUILTIN\|CUSTOM, ownerScope SYSTEM\|TEAM, teamId?, version, status DRAFT\|PUBLISHED\|DEPRECATED, basedOnProfileId?}`** + **`ProfileModuleSetting {profileId, moduleKey, enabled, requiredFields/defaults/config Json}`**. `Project += profileId?/profileVersion?/profileOverrides Json?`, `Team/UserGroup += defaultProfileId?`. *Decision: snapshot-at-create* — a project pins `profileId`+`profileVersion` at creation (resolved `group default ▸ team default ▸ system NEUTRAL`) so re-publishing a profile never silently mutates live projects; `effective-config` layers `profileOverrides` on the snapshot then closes the enabled set over `expandWithDependencies` (the `lib/moduleRegistry.ts` DAG). *Decision: published profiles are immutable* — editing requires cloning to a new DRAFT (`version+1`) and publishing. Partial unique indexes (system `key`; per-team `(teamId,key)`) live in the migration only (Prisma can't express them; `@@unique` intentionally omitted — never look up by key). Profile gating is **additive to RBAC**: the reusable **`requireModule(moduleKey)`** preHandler 403s `module_disabled` when off but can only hide a role-granted capability; the neutral core is never gated. Endpoints gated by the R0 `pmo.*` perms (`manage_profiles`/`assign_profile`/`override_profile`/`set_team_defaults`/`set_group_defaults`); cross-tenant id → existence-hiding 404. Migration `20260707120000_pmis_r2_profiles`, **additive + backfills to identity** (4 SYSTEM built-ins NEUTRAL/IT/EPC/OPERATIONS; every project → NEUTRAL v1, every team default → NEUTRAL = all modules OFF = zero behaviour change). Profiles are inert until Wave-B modules read `effective-config`. |
| Task approval gate (v1.87) | New `TaskStatus.PENDING_APPROVAL` + `Task.requiresApproval` / `Task.approverId` (no separate approval table — decisions live on the `Activity` log, matching the "Notification model rather than per-feature flags" stance). Completion is a status→DONE PATCH, so the gate lives **inside `tasksService.update`**: a DONE transition on a require-approval task is rerouted to `PENDING_APPROVAL` unless the actor is a *finalizer* (designated approver, team MANAGER, global ADMIN, or full-edit delegate). `approve`/`reject` are dedicated service methods + `POST …/tasks/:taskId/{approve,reject}` routes that rely on the global `requireProjectAccess` hook (not `requireProjectWriteAccess`, so a READ-only approver can still decide) and re-check the finalizer set; reject requires a reason. Adapted from the supplied Mizito NestJS spec (`docs/TASKS_MODULE.md`) onto the existing Fastify module — no parallel `Task`/`TaskApproval` tables. |

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
- **PWA (v1.70)** — installable app-shell via `vite-plugin-pwa` (Workbox).
  `registerType: 'autoUpdate'` so a new deploy activates a fresh service worker
  without a manual update prompt. The web manifest declares standalone display,
  `#6366f1` theme colour, and PNG icons (192/512 + maskable 512) generated from
  `BrandMark` artwork. **Precache:** built shell assets (JS/CSS/HTML/fonts/icons).
  **Runtime caching:** `StaleWhileRevalidate` for scripts/styles,
  `CacheFirst` for fonts/images, `navigateFallback` → `index.html` for SPA routes
  (denylist `/api/`). **`/api/*` is always `NetworkOnly`** (GET/POST/PUT/PATCH/DELETE)
  — task/comment/auth payloads are never stored in the SW cache. No offline data
  sync. Install requires HTTPS (localhost OK for dev); HTTP-only deployments keep
  working as a plain SPA without install. **Admin HTTPS notice (v1.70.1):** on the
  About page, global admins see an amber warning when `window.isSecureContext` is false
  (plain HTTP — not localhost, not HTTPS), explaining that PWA install requires HTTPS.
  Gated client-side only (`isAdmin && !isSecureContext`); no backend change. i18n EN+FA.

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

## Task dependencies (v1.29; types SS/FF v1.83)

Edges live in `TaskDependency` (`taskId` depends on `dependsOnId`, same project,
denormalized `teamId`). The `DependencyType` enum is `FINISH_TO_START` (FS),
`START_TO_START` (SS), `FINISH_TO_FINISH` (FF), `RELATES_TO`. Enforcement is
**status-based, not date-based**, and is gated by the instance setting
`tasks.dependencyEnforcement` (`off` | `warn` | `block`). `DependenciesService`
owns both the graph writes and the status-transition rules:

```
B depends on A (A = the predecessor/blocker), target status of B:
  FS  → block IN_PROGRESS or DONE  while A != DONE
  SS  → block IN_PROGRESS          while A == TODO        (A must have started)
  FF  → block DONE                 while A != DONE        (start is always free)
  RELATES_TO → never blocks
```

`countBlockersFor(taskId, nextStatus)` returns `{fs, ss, ff}` incomplete-blocker
counts for the requested transition; `tasksService` consults it on every status
PATCH and returns `403 DEPENDENCY_BLOCKED` in `block` mode (advisory only in
`warn`/`off`). Cycle detection (`wouldCreateCycle`) is **type-agnostic** — it
walks the edge graph regardless of type, so an SS or FF edge that closes a loop
is rejected with `409 DEPENDENCY_CYCLE` just like FS. When a task advances,
`notifyUnblocked(tx, transitionedTaskId, newStatus, actorId)` fans out
`TASK_UNBLOCKED` notifications to the freed tasks' assignee + responsible:
`DONE` frees FS and FF dependents, `IN_PROGRESS` frees SS dependents. The kanban
blocker **badge** (`countIncompleteBlockers` / `loadIncompleteBlockerCounts`)
stays FS-only by design — it is a "can't start yet" hint, which only FS expresses.

Gantt/timeline edge **rendering** is still phase-2: `ProjectGanttPage` draws
subtask bars (no task-to-task arrows) and the calendar `DependencyLayer` is a
dormant overlay fed `edges={[]}`. The v1.83 work is backend enforcement + the
per-edge type picker/labels in `DependenciesSection`; arrow drawing is unshipped.

## Comment @-mentions (v1.29 backend; autocomplete + group-aware v1.84)

`commentsService` extracts `@local-part` handles from a comment body and fans a
`MENTION` notification out to the matched users — independent of the
`TASK_COMMENT` row, so a mentioned assignee gets both. v1.84 made two changes:

- **Resolution is group-aware and shares ONE eligibility rule with the picker.**
  `resolveMentionRecipients(teamId, projectId, handles, explicitIds)` resolves
  against `listEligibleTaskResponsibleCandidates` (the existing projectAccess
  helper: team members ∪ **ACCEPTED** group-grant members on this project) —
  the same set the `responsible-candidates` endpoint serves and the composer's
  `MentionInput` calls. Previously resolution queried team membership only, so
  group-granted members were unmentionable.
- **Two input sources, unioned, both filtered to the eligible set.** The
  create payload carries optional `mentionedUserIds[]` (exact picker
  selections); hand-typed `@local-part` tokens are the regex fallback. Anyone
  not eligible is dropped — a forged id or a hand-typed handle for a user
  without project access never produces a notification. Ineligible ids are
  dropped silently (not 400). No schema change: `mentionedUserIds` is transient
  (used to compute recipients, not stored); chips are re-derived client-side by
  matching `@local-part` against the candidate list. The pre-v1.84 failure mode
  was a full-email-local-part match with no picker, so typed handles like
  `@fateme` never matched `fateme.naraghipour@…` and silently notified no one.

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
3. `project.write_all` → WRITE; else `project.edit` manager → READ in **view** scope only
   (rename via separate update gate)
4. `ProjectEditDelegate(projectId, userId)` → WRITE (v1.86 full-edit delegate)
5. ACCEPTED group grant with any FULL membership → WRITE; READONLY only → READ
6. else NONE

External members are **not** given `TeamMembership`; they reach nested routes only via
`requireTeamRoleOrGrantedProject` when `resolveProjectAccess !== NONE`.

Mutations require WRITE (`assertCanWriteProject` / `requireProjectWriteAccess`).

Because `ownerId` is rule #2 (owner → WRITE), the **owner is chosen at project
creation** (v1.85): `projectsService.create(teamId, creatorId, input)` persists
`input.ownerId ?? creatorId` and validates a chosen owner is a team member
(`assertOwnerInTeam` → 400) — ownership grants full access, so it can never go to
a non-member. `creatorId` (the requester) is only the default, kept distinct from
the final owner. Before v1.85 the create body didn't accept an owner and the row
always took the creator.

**Owner reassignment (v1.86).** `updateProjectBody` now accepts `ownerId`, so the
owner can be changed from the edit form. It's a *non-name* field, so only the
owner-or-ADMIN full-edit path may set it (a rename-only manager is rejected); the
new owner is validated as a team member via the same `assertOwnerInTeam`.

**Owner-delegated full edit (v1.86).** `ProjectEditDelegate(projectId, userId)` is a
per-project delegation the **owner or a global ADMIN** manages
(`PUT /teams/:teamId/projects/:projectId/delegates`, replace-set; owner/admin gated
in the service). A delegate is granted project WRITE (rule #4 above, so they can
reach the tasks) **and** is lifted past the two field-level gates — the
`manager-only` date gate (`assertCanEditDate`) and the `task.change_responsible`
permission — in `tasksService`/`subtasksService`, **for that project only**. This is
deliberately a *separate* signal from access: WRITE/group-FULL on its own never
bypasses those field gates (that would nullify them for every write-holder); only
the explicit delegate is elevated. The task UI reads a self-scoped
`GET …/delegates/me` to unlock the Responsible control for a delegate without
exposing the full delegate list.

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

- Email delivery: **now wired** (was "not here yet" through v1.13). `lib/mailer.ts`
  (since v1.14) sends via SMTP when configured (`SMTP_*` env); when unconfigured
  it is a no-op and `mailer.isEnabled()` returns false, so every composer degrades
  gracefully. `emailService` composes verification, password-reset, task-due,
  standalone-task-due, and (W3, v2.5.31) correspondence-referral messages. All
  domain emails are **best-effort**: a send failure never fails the parent
  mutation, and the in-app `Notification` remains the source of truth. Password
  reset still returns the raw token in non-production responses regardless.
- Background jobs: Redis is provisioned but no BullMQ worker exists yet. The
  `jobs/` folder is reserved for the first job (likely overdue-task notifications).
- Realtime: notifications are pull-based for v1. Add SSE or websockets when
  the UX needs it; the existing `Notification` table is already the source of truth.
- File storage abstraction: uploads land on a local volume. The storage
  interface in `lib/storage.ts` (Feature 4) will accept an S3-compatible
  implementation as a swap-in.

## Backups & disaster recovery

Three complementary layers (a backup you have never restored is not a backup):

1. **In-app scheduler** (v1.27+): `backupScheduler` → `backupsService` runs
   `pg_dump --format=custom` into the `backups_data` volume on a schedule
   (`BACKUP_ENABLED`, interval + retention via env/InstanceSetting). Since
   v1.32.3 a backup is a `*.tar.gz` bundle (database.dump + uploads + secrets +
   manifest); legacy/admin single-file `*.dump` is still restorable. This is
   **on-box only** — it does not survive losing the box.
2. **Offsite shipping** (W4, v2.5.32): `scripts/offsite-backup.sh` copies the
   newest dump out of the container and pushes it to an rclone remote or over
   rsync/SSH. Cron'd on the host; never touches local retention. **Or, preferred
   (v2.5.35):** the **Kopia** service (compose `backup` profile) — encrypted,
   deduplicating, versioned snapshots of the dump volume to Google Drive (native
   gdrive backend + service account) with a web UI, retention, and one-click
   restore. Kopia encrypts with `KOPIA_PASSWORD` before upload, so the
   secrets-bearing bundles never reach the cloud in plaintext. Setup:
   `scripts/kopia-setup.sh` + `scripts/README.md`.
3. **Restore verification** (W4, v2.5.32): `scripts/restore-verify.sh` restores
   a dump into a **throwaway** Postgres (never the live DB) and asserts schema +
   applied-migrations + core tables are present, exiting non-zero on any
   failure so monitoring catches a corrupt backup. See `scripts/README.md`.

## Testing strategy

- **Unit tests** for pure helpers (hashing, duration parsing).
- **Integration tests** against a real Postgres using Fastify's `inject()`.
  Mocking Prisma was considered and rejected — the value of these tests is
  exercising the actual SQL Prisma generates and the constraints we declared.
- Each feature ships with happy-path + negative-path tests for authorization
  (another team's user must not read this team's data).
