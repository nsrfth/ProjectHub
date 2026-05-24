# Changelog

All notable changes to TaskHub are documented in this file. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
