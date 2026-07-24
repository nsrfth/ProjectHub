# Cross-Unit Task Assignment Workflow — P1 Implementation Spec

**Status:** ready to build. Derived from the reviewed plan (v7), verified against the code at
v2.19.0. This is the developer-facing execution spec for **P1 — Workflow core**; P2 (UX) and P3
(Ops) are sketched at the end.

Companion docs: [ACCESS_MIGRATION_ROADMAP.md](ACCESS_MIGRATION_ROADMAP.md) (the P0 prerequisite),
[TASKS_MODULE.md](TASKS_MODULE.md), [CORRESPONDENCE_MODULE.md](CORRESPONDENCE_MODULE.md) (the
route-mounting precedent this reuses).

---

## 0. Two constraints that govern the whole build

Read these before writing any code — they decide sequencing, not just correctness.

### C-A — The workflow is inert until P0 completes (`ACCESS_UNIFIED_GRANTS=on`)

The access side-effect (auto-issue a `ProjectAccessGrant` on final assignment) only produces
**effective** access when the unified resolver is authoritative. Under `off`/`dual`, the legacy
resolver answers and the auto-grant grants nothing usable. Likewise the Slice 3 eligibility
extension reads `ProjectAccessGrant`, which is not authoritative until `on`.

**Therefore:** all of P1 may be *built and merged* now, but the workflow's *active* behaviour
(the guard reorder's rejection + the auto-grant path) must sit behind an enablement flag and must
not be switched on before the runbook reaches `on`. Add:

```
# config/env.ts — default off, inert like the other access flags
TASK_ASSIGNMENT_WORKFLOW: z.string().default('false').transform((v) => v === 'true'),
```

Gate the active paths on `TASK_ASSIGNMENT_WORKFLOW && ACCESS_UNIFIED_GRANTS === 'on'`. This mirrors
the existing `ACCESS_*` flag discipline (build dormant, flip later after a soak).

### C-B — The guard reorder must not go live before the request-creation endpoint exists

Slice 4 makes cross-boundary direct assigns return `ASSIGNMENT_REQUEST_REQUIRED` ("request it").
If that ships/enables before Slice 5's `POST …/assignment-requests` exists, users are told to
request with no way to request. **Slice 4 implements the option; Slice 5 wires and enables it.**
Never enable the reorder in isolation.

### Per-slice discipline (repo conventions)

- Each slice is one shippable PR and bumps the unified version (patch by default) across
  `CHANGELOG.md`, `ARCHITECTURE.md`, both `USER_MANUAL*.md` (when user-facing), `frontend/` +
  `backend/package.json`, `CLAUDE.md`, and `TASKHUB_VERSION`. See the Deploy workflow section of
  CLAUDE.md.
- Every slice ships **happy-path + a negative-authorization test** (another division's user must
  not act) — the multi-tenancy rule. No exceptions.
- Integration tests run against the real test Postgres (`taskhub_test` / port 5433). Bring the
  container up first; the suite is single-fork by design — do not parallelize.
- Backend layering is enforced: `routes/` never touch Prisma; only `services/` do; pure logic in
  `lib/`. Keep the classifier and reconcile in `lib/`, orchestration in `services/`.

---

## 1. Slice sequence (dependency-ordered)

```
Slice 1  Data layer + primitives        (ships inert)         ── no deps
Slice 2  Boundary classifier            (ships inert)         ── no deps
Slice 3  Eligibility extension (B1)     (improves current)    ── flag-aware, indep.
Slice 4  Guard reorder opt-in           (implement only)      ── deps 1(error), 2
Slice 5  Request lifecycle + endpoints  (enables 4)           ── deps 1,2,3,4  + auto-grant
Slice 6  reconcileAssignmentGrant       (reversal)            ── deps 1,5
Slice 7  Indirect-path governance       (D7 + templates)      ── deps 2,3,5
```

Slices 2 and 3 can be built in parallel with 1. Everything downstream of 4 is serial.

---

## 2. Slice 1 — Data layer + primitives

**Goal:** land the schema, enums, migration, and the new error. Wires into nothing; ships inert.

### Prisma schema (`backend/prisma/schema.prisma`)

```prisma
enum AssignmentTargetType {
  GROUP   // department = UserGroup kind UNIT
  TEAM    // division
}

enum AssignmentRequestStatus {
  REQUESTED
  APPROVED
  FORWARDED
  ASSIGNED
  DECLINED
  EXPIRED
}

model TaskAssignmentRequest {
  id            String   @id @default(cuid())
  teamId        String   // tenancy invariant — every team-scoped row carries teamId
  taskId        String
  projectId     String   // denormalized; task↔project↔team re-asserted in the service
  requesterId   String
  targetType    AssignmentTargetType
  targetId      String   // UserGroup.id (GROUP) or Team.id (TEAM)
  proposedId    String?  // advisory candidate assignee
  status        AssignmentRequestStatus @default(REQUESTED)
  approverId    String?
  forwardedToId String?
  assigneeId    String?
  declineReason String?
  expiresAt     DateTime
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  decidedAt     DateTime?

  // DECISION (confirm at implementation, needs `prisma validate`): add relations, or keep bare
  // FK strings? ProjectAccessGrant uses relations; this plan's draft used bare strings. Recommend
  // adding the three ownership relations with onDelete: Cascade so a deleted task/project/division
  // cannot strand a pending request (this resolves the "pending request vs deleted task" edge
  // flagged in review). User FKs stay bare or SetNull — do NOT cascade-delete requests when a user
  // is removed.
  task    Task    @relation(fields: [taskId], references: [id], onDelete: Cascade)
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  team    Team    @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@index([teamId, status])
  @@index([taskId])
  @@index([targetType, targetId, status]) // approver inbox lookup
  @@index([requesterId, status])          // requester's outbox
}
```

Add the matching back-relations on `Task`, `Project`, `Team` (`taskAssignmentRequests
TaskAssignmentRequest[]`) or `prisma generate` fails.

### NotifyType — native Postgres enum (⚠ two-step migration)

`NotifyType` is a **native pg enum** (`backend/prisma/schema.prisma`, currently 11 values). Adding
values is `ALTER TYPE … ADD VALUE`, which **cannot be used in the same transaction that also
references the new value** — and Prisma wraps a migration in one transaction. This repo has already
hit the same class of issue with the theme enum.

```prisma
enum NotifyType {
  # …existing 11…
  ASSIGNMENT_REQUESTED   // approver: a request awaits your decision
  ASSIGNMENT_DECIDED     // requester: approved / declined / assigned
}
```

Generate the migration, then **verify it is a standalone `ALTER TYPE … ADD VALUE` with no INSERT
using the value in the same file**. If Prisma bundles them, split into two migrations (add values
first, use them later). No code emits these notifications until Slice 5, so the split is free here.

### Error (`backend/src/lib/errors.ts`)

Follow the `assigneeOutOfScope` precedent exactly (403, own stable code, SPA matches on `code`):

```ts
// The target is a valid person; the actor simply lacks the reach to assign directly across the
// org boundary. 403 (not 400) for the same reason as ASSIGNEE_OUT_OF_SCOPE; the SPA renders the
// "request assignment" affordance off this code.
assignmentRequestRequired: (targetName?: string) =>
  new AppError(
    403,
    'ASSIGNMENT_REQUEST_REQUIRED',
    targetName
      ? `${targetName} is in another unit — request the assignment; their manager will assign.`
      : 'This person is in another unit — request the assignment; their manager will assign.',
  ),
```

### Migration & verify

```bash
cd backend
npx prisma migrate dev --name add_task_assignment_request
npx prisma generate
npm run typecheck && npm test
```

**Tests:** a migration smoke test (table exists, enums present) is enough — no behaviour yet.

---

## 3. Slice 2 — Boundary classifier

**Goal:** a pure-ish `lib/` function classifying an assignment A/B/C and resolving the approver.
Flag-independent (does **not** read `ACCESS_UNIT_SCOPE`). Ships inert (nothing calls it yet).

`backend/src/lib/assignmentBoundary.ts`:

```ts
export type AssignmentBoundary =
  | { scenario: 'A' }                                             // same department → direct
  | { scenario: 'B'; approverKind: 'DEPT_MANAGER'; targetGroupId: string }
  | { scenario: 'C'; approverKind: 'DEPUTY'; targetTeamId: string };

/**
 * Classify from the *target's* org placement relative to the project's home division.
 * Reuses the denormalized, trigger-maintained UserGroupMember unit lookup that
 * isWithinAssignmentScope already performs (single indexed read on the hot path) — do NOT add a
 * third round trip. Division-level staff (no department) are handled explicitly: a target with no
 * UNIT membership in the project's division is scenario A if same-division, else C.
 */
export async function classifyAssignmentBoundary(opts: {
  projectTeamId: string;        // the project's home division (Project.teamId)
  targetUserId: string;
}): Promise<AssignmentBoundary>;
```

Resolution rules (D1 default): same department → A; different department, same division →
B (approver = that department's single `GroupRole.MANAGER`); different division → C (approver =
target division's Deputy = the division `MANAGER`). The classifier returns the *kind* and the
target id; **resolving the concrete approver user and the D4 "no approver" block happens in the
service** (Slice 5), so the classifier stays free of failure-mode policy.

**Tests (integration — placement needs DB):** A/B/C each; division-level staff (no dept) both
directions; a target in a second holding root (structural isolation still holds).

---

## 4. Slice 3 — Eligibility extension (fixes B1)

**Goal:** `isUserEligibleTaskResponsible` (`backend/src/lib/projectAccess.ts:594`) must also accept
a user holding a live unified `ProjectAccessGrant` (USER subject) — flag-aware — so that once an
assignment is approved and the grant issued, the person is actually assignable. Without this the
workflow issues a grant and then rejects the assignment.

Append one branch (after the existing team/group/FULL-share checks), gated so it changes nothing
until unified grants are authoritative:

```ts
// Unified USER grant (v-next): only when the unified resolver is authoritative, so behaviour is
// unchanged under off/dual. Reuse the existing liveGrantWhere/subjectClause helpers in
// lib/projectGrants.ts rather than hand-rolling the expiry/status predicate.
if (loadEnv().ACCESS_UNIFIED_GRANTS === 'on') {
  const grant = await prisma.projectAccessGrant.findFirst({
    where: {
      projectId,
      subjectType: 'USER',
      subjectId: userId,
      status: 'ACTIVE',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  });
  if (grant) return true;
}
```

**Tests:** cross-division user with an ACTIVE USER grant is eligible under `on`, not eligible under
`off`/`dual`; expired grant is not eligible. This slice is safe to ship ahead of the rest — it only
ever *loosens*, and only under `on`.

---

## 5. Slice 4 — Guard reorder (opt-in; implement only, enable in Slice 5)

**Goal:** let the two Task-assignee call sites classify-before-eligibility, leaving the other five
guard sites untouched. See plan §3.1 for why only these two.

`assertAssignmentAllowed` (`backend/src/lib/projectAccess.ts:520`) gains an opt-in option — the
`role` argument alone can't distinguish task from subtask (subtasks also pass `'assignee'`):

```ts
export async function assertAssignmentAllowed(opts: {
  teamId; projectId; actorId; actorGlobalRole;
  targetId: string | null | undefined;
  role: 'assignee' | 'responsible';
  enforceBoundaryWorkflow?: boolean;   // NEW — default false = today's behaviour
}): Promise<void> {
  const { …, targetId, enforceBoundaryWorkflow } = opts;
  if (targetId === null || targetId === undefined) return;   // unchanged: clearing always allowed

  // NEW: classify FIRST, but only when opted in AND the workflow is live. Without this, scenario C
  // dies on the generic eligibility throw below before the classifier is ever consulted.
  if (
    enforceBoundaryWorkflow &&
    loadEnv().TASK_ASSIGNMENT_WORKFLOW &&
    loadEnv().ACCESS_UNIFIED_GRANTS === 'on' &&
    actorGlobalRole !== 'ADMIN'                               // D1 override lane
    // NOTE: also skip when the actor holds task.assign_any (D1). Factor the existing
    // assign_any check out of isWithinAssignmentScope so both call sites share it.
  ) {
    const boundary = await classifyAssignmentBoundary({ projectTeamId: /* project.teamId */, targetUserId: targetId });
    if (boundary.scenario !== 'A') throw Errors.assignmentRequestRequired();
  }

  // …unchanged: eligibility check, then isWithinAssignmentScope…
}
```

Then set `enforceBoundaryWorkflow: true` at **only** `tasksService.ts:420` (create-assignee) and
`tasksService.ts:803` (update-assignee). Leave `:467`, `:904` (responsible) and all three
subtask sites (`subtasksService.ts:126/263/287`) exactly as they are.

**Telemetry (D6 default):** when the flag is on and a boundary rejection fires, still emit the
scope-violation event so the `ACCESS_UNIT_SCOPE` pilot metric doesn't go dark — return
`ASSIGNMENT_REQUEST_REQUIRED` to the user, log the `ASSIGNEE_OUT_OF_SCOPE`-equivalent event for
metrics.

**Tests:** with the flag off, all seven sites behave exactly as before (regression lock). With the
flag on: task-assignee cross-boundary → `ASSIGNMENT_REQUEST_REQUIRED`; responsible + subtask
cross-boundary → unchanged (eligibility/scope path); ADMIN and `task.assign_any` → bypass.

---

## 6. Slice 5 — Request lifecycle service + endpoints (enables Slice 4)

**Goal:** the workflow itself. New `services/assignmentRequestsService.ts`, routes split across the
task router (creation) and a standalone router (decisions + inbox).

### Service surface

```
create(teamId, projectId, taskId, actorId, actorGlobalRole, { proposedId? })
  → classify (Slice 2). Scenario A shouldn't reach here (direct assign handled it).
  → resolve concrete approver: B = the target dept's single MANAGER; C = the target division's
    Deputy (division MANAGER). If none exists → Errors (D4 default: block, "designate a manager").
  → compute expiresAt via the working-day calendar (the cal.* API taskTemplatesService uses —
    addWorkingDays, NOT naive +3d). SLA = 3 working days (D5).
  → create TaskAssignmentRequest(status REQUESTED); Notification ASSIGNMENT_REQUESTED to approver
    (+ best-effort email via emailService). Return the row.

approve(reqId, actorId)  — approver only; REQUESTED → APPROVED.
forward(reqId, actorId, toDeptManagerId)  — scenario C deputy only; APPROVED → FORWARDED,
        forwardedToId set; notify the dept manager.
assign(reqId, actorId, assigneeId)  — approver (B) / deputy or forwarded manager (C). Validates
        assigneeId is inside the approver's unit. TERMINAL:
          • set Task.assigneeId (in a tx)
          • auto-issue ProjectAccessGrant: subjectType USER, level WRITE (D3), status ACTIVE,
            source = `assignment:${reqId}` (provenance only — see Slice 6), via the projectGrants
            upsert (higher-wins dedup; a no-op when an equal/greater grant already exists).
          • status → ASSIGNED, decidedAt set. Notify requester ASSIGNMENT_DECIDED.
decline(reqId, actorId, reason)  — approver; → DECLINED, reason required; notify requester.
```

All decision methods **re-assert the tenancy chain** (task↔project↔team) and gate on approver
identity themselves — the routes carry no project-access hook (see below).

### Routes — the correspondence v2.5.33 mounting lesson

- **Creation** under the task router: `POST /teams/:teamId/projects/:projectId/tasks/:id/assignment-requests`.
  The requester has project access by definition, so the existing plugin-level
  `requireProjectAccess()` at `routes/tasks.ts:37` is correct here.
- **Decisions + inbox** in a **new standalone router** (e.g. `routes/meAssignmentApprovals.ts`,
  sibling of `routes/meReferrals.ts`), mounted **outside** the task router with **no**
  `requireProjectAccess()` hook — a cross-division approver has no project access and would be 404'd
  by it (exactly the bug correspondence fixed for referral recipients, `correspondence.ts:50-55`).
  The service is the gate:
  - `GET /me/assignment-approvals` — user-scoped cross-team inbox, mirroring `meReferrals.ts`
    (aggregate where the caller is the resolved approver / forwarded manager, any team).
  - `POST /me/assignment-approvals/:reqId/{approve|forward|assign|decline}`.

### Enable Slice 4

Flip `enforceBoundaryWorkflow: true` live (it's already wired at the two sites). The request path
now exists, satisfying C-B.

**Tests:** full lifecycle A/B/C; **negative auth** — a different division's user cannot approve,
forward, assign, or read another approver's inbox; D4 no-manager block; assign issues exactly one
grant; forwarded-manager can assign; decline requires a reason. Assert the decision routes return
403/404 for non-approvers *without* leaking task existence.

---

## 7. Slice 6 — `reconcileAssignmentGrant` (reference-counted reversal)

**Goal:** correctly reverse the auto-grant. A per-request `source` tag can't invert the lifecycle —
the grant engine dedups to **one row per (project, person)**, so many approved requests ride one
grant. Revoke-by-tag would strip still-valid assignments; scope-to-one-task leaks the grant. Count
instead.

`backend/src/lib/projectGrants.ts` (or a small `lib/assignmentGrants.ts`):

```ts
/**
 * Called after any event that may end a person's work in a project. Nulls nothing itself — the
 * caller has already cleared the specific assignee row — then revokes the assignment-sourced grant
 * ONLY when the person has zero remaining assignee/responsible rows (task AND subtask) in the
 * project. source='assignment:*' is provenance, never the revocation key.
 */
export async function reconcileAssignmentGrant(
  projectId: string,
  userId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const [taskRows, subtaskRows] = await Promise.all([
    tx.task.count({ where: { projectId, OR: [{ assigneeId: userId }, { responsibleId: userId }] } }),
    tx.subtask.count({ where: { task: { projectId }, OR: [{ assigneeId: userId }, { responsibleId: userId }] } }),
  ]);
  if (taskRows + subtaskRows > 0) return;                    // still working here — keep the grant
  await tx.projectAccessGrant.deleteMany({
    where: { projectId, subjectType: 'USER', subjectId: userId, source: { startsWith: 'assignment:' } },
  });
}
```

**Wire into all four removal paths, inside the mutation's transaction:**
1. **Unassign / reassign** — `tasksService.update` where `assigneeId` transitions away from a user
   (the guard site at `:803`; run reconcile for the *previous* assignee after the write).
2. **Subtask unassign / reassign** — `subtasksService` update paths.
3. **Task delete** — `tasksService.remove` (`:1877`). The grant hangs on `Project`, not `Task`, so
   a `Task` cascade alone orphans it — reconcile the deleted task's assignee/responsible explicitly.
4. **Automation `set_assignee` to null / another user** — `automationEngine.ts:221` clears via the
   guard (clearing always passes); reconcile the displaced user.

**Concurrency (implementation-level, real):** two simultaneous removals, or a removal racing a new
assign, can miscount. Run reconcile in the same transaction as the assignee write and rely on the
DB's read-committed snapshot; if load warrants, take a row lock on the grant. Cover with a test that
removes two of a user's three assignments and asserts the grant survives, then removes the last and
asserts it's gone.

---

## 8. Slice 7 — Indirect-path governance (D7 + templates)

**D7 — automation `set_assignee` (default: validate at save time against the rule owner).**
Today `automationEngine.ts:223` fires `set_assignee` as `actorGlobalRole='ADMIN'`, which sails
through both the scope check and the D1 override lane — the workflow's widest bypass. Close it at
authoring: in `validateReferences` (`automationRulesService.ts:54`, reached from create `:166` and
update `:224/233/243`), when an action is `set_assignee` with a `userId`, classify that target
against **the rule owner's** placement for the rule's project; a cross-boundary target fails
validation with `ASSIGNMENT_REQUEST_REQUIRED`. Fire-time failure would be a rule that silently
stops working — validate at save instead.

**Template spawn (spawn-time eligibility drop).** `taskTemplatesService.ts:225` copies
`assigneeId` into a raw `tx.task.create` with no guard, and a template spawning *after* a
revocation re-creates an assignee no removal event will ever reconcile. Fix at spawn: drop the
copied `assigneeId` when the person fails `isUserEligibleTaskResponsible` (post-Slice-3, this
includes unified grants) — the spawned task arrives unassigned, consistent with the field's
low-ceremony intent.

**Tests:** save a cross-boundary `set_assignee` rule → rejected; template whose source assignee has
since lost access → spawns unassigned.

---

## 9. Decision-gate → slice map

| Gate | Default (from plan) | Blocks |
|---|---|---|
| D1 routing matrix + override lane | dept-mgr / deputy / deputy-forwards; ADMIN + `task.assign_any` bypass | Slice 2, 4, 5 |
| D2 assignee authority | approver selects; proposed is advisory | Slice 5 |
| D3 access side-effect | auto USER grant at WRITE, provenance source, reconciled reversal | Slice 5, 6 |
| D4 missing approver | block at creation | Slice 5 |
| D5 SLA | 3 working days, T-1 reminder, auto-expire | Slice 5, P3 |
| D6 sequencing + pilot telemetry | P0 before enable; dual-signal telemetry | C-A, Slice 4 |
| D7 automation | validate at save vs rule owner | Slice 7 |

All defaults are sensible to build against; none need re-litigating to start. Confirm D3 (WRITE
exposure) and D7 (governance posture) with leadership before Slice 5/7 *enable*, since those are
the two with organizational rather than technical consequences.

---

## 10. P2 / P3 (out of P1 scope — pointers)

- **P2 UX:** assignee-picker "outside your department → request" affordance (match on
  `error.code === 'ASSIGNMENT_REQUEST_REQUIRED'`); approvals inbox (consume `GET
  /me/assignment-approvals`); approval screen that **states the full project-WRITE exposure** before
  the approver assigns; EN+FA i18n. Frontend feature folder `features/assignment-requests/`.
- **P3 Ops:** SLA reminder + auto-expiry in a new `scheduler/assignmentSlaScheduler.ts` (starts in
  `server.ts`, not `app.ts`, like the other schedulers); admin report of pending/expired requests;
  audit events on every state transition.
- **P4:** escalation on expiry (notify requester's manager), metrics, e2e smoke.

---

## 11. Build/verify loop (this environment can't run the toolchain)

The agent shell here has no Node toolchain, so each slice is: spec/code written → **you** run, from
`backend/`:

```bash
npm run typecheck
docker compose --profile test up -d postgres-test
DATABASE_URL='postgresql://taskhub:taskhub@localhost:5433/taskhub_test?schema=public' npx prisma migrate deploy
DATABASE_URL='…5433…' npx vitest run tests/integration/<slice>.test.ts
```

Report failures back and we iterate on that slice before moving on. Ship each slice (version bump +
both frontend/backend rebuilt where relevant) only after its tests are green.
