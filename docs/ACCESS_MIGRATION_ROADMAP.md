# Roadmap — Transfer access from Teams → Departments (production)

> **Version 2 (corrected).** Supersedes the first draft, which omitted the grant backfill and
> mis-sequenced the consent handshake. Every code claim below was verified against the deployed tree
> at commit `1e6d8cd` (v2.18.0) on 2026-07-21 — re-confirm per §1.1 before executing.
> Target instance: `projecthub.modalalco.com` (172.16.1.150), v2.18.0. Repo: `nsrfth/ProjectHub`.
> Nature of work: a production **access migration** (ops + at most one data-normalization pass), not
> a feature build. No frontend/i18n changes unless **D2** selects the consent flow.

## Core constraint (shapes everything)
Transfer **access**, not project **ownership**. **Teams are the tenancy/access root**; a project
belongs to exactly one Team (`Project.teamId`), and `Task.teamId` is denormalized from it. A
**Department is a `UserGroup` of kind UNIT**. There is no "project belongs to a department" — the
link is an **access grant**. So "move to a department" = **grant the department access**
(low-risk, reversible). Changing `teamId` (Phase 7) is the only ownership move and is out of scope.

## Baseline (prod, after Phase 5 team cleanup — 2026-07-21)
- **5 teams remain**, all holding projects: DataCenter (11), CS-SBC-Tehran (6), Security (6),
  Network (3), Technology (1). The 9 empty teams were deleted (Phase 5, done).
- `Technology` models the departments (UNIT groups: Datacenter, IT-Support, Network, Security,
  OnSite IT-Support) + sub-units (KDJ, KVSMM, KVSMS, NABDANEH).
- Access engine: `ACCESS_UNIFIED_GRANTS=off`; **`ProjectAccessGrant` is EMPTY** (unified grants = 0)
  — the backfill has not run. This is the single most important fact for sequencing (see I-1).

## Team → Department mapping (locked)
| Source team | Projects | → Department under `Technology` |
|---|---|---|
| Network | 3 | Network |
| Security | 6 | Security |
| DataCenter | 11 | Datacenter |
| CS-SBC-Tehran | 6 | IT-Support |
| *(Technology itself)* | 1 | *the anchor division* |

---

## 1. Non-negotiables (every step)
1. **Verify against code before acting.** Shallow-clone and confirm each §3 citation still holds at
   the deployed commit *before* running anything. Citations are from v2.18.0 and may drift.
2. **Backup before each phase.** `pg_dump -Fc` + a `~/taskhub` snapshot; record the dump filename.
3. **Tenancy invariant, re-checked after every change.** No user sees a team/project they shouldn't;
   `Task.teamId` always equals its Project's `teamId`.
4. **Reversible only.** No destructive delete until the replacement is verified in prod for a soak
   window. `ACCESS_UNIFIED_GRANTS=off` is the master rollback and must stay instant — legacy tables
   keep being written under `on`; do **not** "clean up" legacy write paths (that is a later, separate
   phase in the code's own numbering).
5. **The three access flags are instance-wide.** `ACCESS_UNIFIED_GRANTS`, `ACCESS_UNIT_SCOPE`,
   `ACCESS_GRANT_CONSENT` are global env vars (`config/env.ts`). "Pilot on Network" applies only to
   **data** operations (which members/grants you create). A flag flip changes behaviour for **all 5**
   teams at once — pilot means "watch Network first after a global flip," never "scope the flag."

## 2. Open decisions — `[DEFAULT — confirm]`
- **D1 — Backfill subject mode.** `[DEFAULT: group subjects; normalize any mixed-level department to
  one accessLevel first]`. Alt: `--per-member` (exact legacy fidelity, but abandons the group as a
  live access unit — contradicts the department goal). The backfill `--dry-run` mixed-level report
  tells you objectively whether any normalization is even needed.
- **D2 — Consent in Phase 3.** `[DEFAULT: OFF — admin-imposed grants, no handshake]`. Alt:
  `ACCESS_GRANT_CONSENT=true` **before** granting, grants issued by a non-admin, with an ACCEPTED
  `MANAGER` per department. Steady-state consent policy can be decided separately after `on` is stable.
- **D3 — `ACCESS_UNIT_SCOPE`.** `[DEFAULT: defer until after the on cutover is stable]`. Global flag;
  changes who-can-assign-whom across all teams.
- **D4 — Active equivalence sweep.** `[DEFAULT: build it]`. Read-only script enumerating (user,
  project) pairs comparing legacy vs unified resolution. The passive divergence log alone is
  insufficient to green-light `on`.

## 3. Issues fixed vs the first draft (verified against v2.18.0)
- **I-1 — the backfill was never run (blocking).** `ProjectAccessGrant` is created empty by migration
  `20260731120000` (1 `CREATE TABLE`, 0 INSERTs); it is populated only by the manual script
  `backend/scripts/reports/grant-backfill.ts` (`npm run backfill:grants`). Flip to `dual` without it
  and the unified resolver returns NONE for every user whose access comes from a pre-existing group
  grant / team share / delegate → `access.divergence` (`unified_less_permissive`) for each, and an
  **actual lockout at `on`**. Fix: backfill is the first action of Phase 2.
- **I-2 — mixed-level departments block the group backfill (new gate).** `ProjectGroupGrant` carries
  no level; the level is per-member on `UserGroupMember.accessLevel` (FULL/READONLY). Group mode
  emits one grant per distinct level, so a dept with both would escalate READONLY members to WRITE —
  the script **refuses to apply** in that case (`grant-backfill.ts:204-209`). See D1.
- **I-3 — the consent handshake was mis-sequenced.** Consent only fires when
  `ACCESS_GRANT_CONSENT=true && actor≠ADMIN && approvers>0`
  (`projectGrantsService.ts:219`); otherwise grants are created **ACTIVE, no acceptance step**
  (`status = needsConsent ? 'PENDING' : 'ACTIVE'`). Enabling consent in Phase 4 does nothing to
  grants already issued. Also: grant status enum is `PENDING/ACTIVE/DECLINED` (no "ACCEPTED" — that's
  `GroupInviteStatus`); a unit is approvable only if it has a `MANAGER` with membership
  `status='ACCEPTED'`, else the service throws (`:221`). See D2.
- **I-4 — `/access-report` is not a before-picture.** It reads the unified `ProjectAccessGrant` table
  (`admin.ts:63`), empty pre-backfill, and is a grant ledger (omits owner, ADMIN,
  `read_all`/`write_all`, team membership, delegate caps). The real baseline enumerates **effective**
  access per (user, project) via `resolveProjectAccess`; the grant export belongs **after** backfill.
- **I-5 — the divergence soak is a passive sampler.** `access.divergence` is written only when
  `resolveProjectAccess` is invoked (dual branch → `recordDivergence`). Low-activity users/projects
  produce no signal. Add an active equivalence sweep (D4).

---

## 4. Corrected runbook

### Phase 0 — Freeze, decide, baseline (no changes)
- Mapping locked (above).
- Full `pg_dump -Fc`; snapshot `~/taskhub`.
- **Baseline effective-access export:** enumerate (user, project) → `resolveProjectAccess` for the
  in-scope projects; store the CSV. **Do not** use `/access-report` as the before-picture (I-4).

### Phase 1 — Model departments (reversible)
- Ensure a `UNIT` department exists under `Technology` for each source team (all already exist).
- Place people into their department via app/API (not SQL), tagged into the right unit, respecting
  **one-department-per-person** (partial unique index `UserGroupMember_one_unit_per_team WHERE
  isUnit`, trigger-maintained). **Blocker to surface, not a migration step:** anyone who draws access
  from two source teams today (e.g. Network **and** Security) can hold only one department — the org
  must decide which. Surface every such person during the Network pilot.
- Pilot on Network's members first; verify each lands in exactly one department.

### Phase 2 — Backfill, then observe (I-1, I-2, I-4, I-5)
> **I-6 (run mechanics — the script is NOT in the container image).** `docker/backend.Dockerfile`
> ships only `dist/`, `src/`, `prisma/`, `package.json`, `tsconfig.json` and `node_modules` — it
> does **not** copy `scripts/`. So `docker compose exec backend npx tsx scripts/reports/…` fails
> with *file not found*. The script is git-tracked, so it IS on the host at
> `~/taskhub/backend/scripts/reports/grant-backfill.ts` (from the extracted tarball). It imports
> only `@prisma/client`, so copy it into the running container (which already has `tsx` + the
> generated client + `DATABASE_URL` in its env) and run it there:
> ```bash
> cd ~/taskhub
> CID=$(docker compose ps -q backend)
> docker cp backend/scripts/reports/grant-backfill.ts "$CID":/app/grant-backfill.ts
> docker compose exec -T backend npx tsx grant-backfill.ts --dry-run   # DATABASE_URL inherited
> ```
1. `pg_dump -Fc` (fresh) — **only before `--apply`; the dry-run writes nothing, so run it first.**
2. **Backfill dry-run** (read-only, copy the script in per I-6 above, then
   `… npx tsx grant-backfill.ts --dry-run`). Read the mixed-level report.
3. **D1 gate:** if mixed-level departments exist → normalize member `accessLevel` within them (or
   pick `--per-member`, accepting its downside). Re-run `--dry-run` until group mode reports no
   mixed-level groups — it otherwise refuses to apply.
4. **Apply:** `… npx tsx grant-backfill.ts --apply` (group subjects per D1). Run it **again** — the
   second run must insert **0** (idempotency; unique index guarantees it).
5. Export `/access-report` as the after-backfill grant inventory; the effective access it implies
   must match the Phase-0 baseline.
6. Set `ACCESS_UNIFIED_GRANTS=dual` in prod `.env`; restart backend; confirm boot via
   `docker compose logs backend` (v2.18.0 passes the equal-secrets guard — keep the JWT secrets
   distinct).
7. **D4:** run the active equivalence sweep immediately — it must be clean **before** the soak
   starts, else the backfill was incomplete.
8. Soak ≥1–2 weeks. Exit: **zero** unexplained `access.divergence` in **both** directions
   (`unified_more_permissive` = escalation → blocks the flip; `unified_less_permissive` = lockout)
   **and** a clean end-of-soak sweep.

### Phase 3 — Grant departments access to their projects (I-3)
Resolve **D2** first.
- **D2 = OFF (default):** leave `ACCESS_GRANT_CONSENT=false`. Admin issues each department a grant on
  its projects → created **ACTIVE**, the legacy `ProjectGroupGrant` row is dual-written
  (`projectGrantsService.ts:252` → `writeLegacyRow`), and the `dual` (legacy-authoritative) resolver
  grants access. **No manager-acceptance step.**
- **D2 = ON:** set `ACCESS_GRANT_CONSENT=true` **before** issuing; ensure each department has a
  `MANAGER` with membership `status='ACCEPTED'` (else the grant is unapprovable and the service
  throws); issue grants as a **non-admin** (the admin path is always imposed/ACTIVE). Managers accept
  via the pending-approval inbox.

Sequence (either branch):
- Pilot: Network dept → its 3 projects; confirm members can open them.
- Then: IT-Support → CS-SBC-Tehran (6); Security → Security (6); Datacenter → DataCenter (11).
- **Level:** legacy `accessLevel` is FULL/READONLY; unified grant level is **READ/WRITE**
  (FULL→WRITE, READONLY→READ). FULL members resolve WRITE. Confirm each department's resolved level.
- **D3:** `ACCESS_UNIT_SCOPE` stays deferred.

### Phase 4 — Make unified authoritative
- Precondition: clean dual soak **and** clean active sweep (Phase 2 exit met).
- Set `ACCESS_UNIFIED_GRANTS=on`; restart; verify. Legacy tables still written → `off` is an instant
  rollback. Do **not** drop legacy tables.
- Enabling `ACCESS_GRANT_CONSENT` now affects only **future** grants, not the Phase-3 grants.

### Phase 5 — Retire emptied teams
**DONE (2026-07-21).** 9 zero-project teams deleted; backup
`~/taskhub_pre_teamdel_20260721_102708.dump`. Nothing further.

### Phase 6 — Wire the org chart (reporting-only, no access impact)
Link each remaining division-team to its Company node (`TeamOrgUnit`; `OrgUnitType` has `COMPANY`).
Sites (BIK/KDJ/KVSM…) are `SITE` org-units — a separate hierarchy from department `SUBUNIT` tagging;
do not conflate.

### Phase 7 — Consolidate ownership (OUT OF SCOPE)
`teamId` re-parenting is unsupported and orphans `Task.teamId`, owner membership, and team-scoped
custom fields/labels/roles/automations/webhooks. Phases 3–4 already deliver department access; owning
teams simply remain divisions.

## 5. Verification & rollback
- **After every step:** re-assert the tenancy invariant (§1.3) and diff effective access vs the
  Phase-0 baseline for the in-scope projects.
- **Rollback ladder:** `ACCESS_UNIFIED_GRANTS=on → dual → off` (instant; legacy authoritative);
  grants are individually revocable; the per-phase `pg_dump` is the floor. Backfilled rows are
  distinguishable by `grantedById = null` / `source = backfill:*` for targeted cleanup.

## 6. Execution checklist
- [ ] Repo cloned; §3 citations re-confirmed at deployed commit
- [ ] D1–D4 confirmed
- [ ] Phase 0 backup + effective-access baseline captured (not via `/access-report`)
- [ ] Phase 1 members placed; one-department-per-person verified on Network pilot; dual-team people surfaced
- [ ] Backfill `--dry-run` clean of mixed-level groups (or D1 = per-member)
- [ ] Backfill `--apply`; second run inserts 0 (idempotent)
- [ ] After-backfill effective access == Phase-0 baseline
- [ ] `dual` set; backend boots; active sweep clean at soak start
- [ ] ≥1–2 week soak: zero unexplained divergence (both directions) + clean end-of-soak sweep
- [ ] Phase 3 grants issued per D2; per-department resolved level confirmed
- [ ] `on` set only after clean soak + sweep; `off` rollback rehearsed
- [ ] Phase 6 org-chart links (optional, reporting-only)

## Change log
- 2026-07-21 — Initial draft. CS-SBC-Tehran → IT-Support.
- 2026-07-21 — Phase 5 executed (9 empty teams deleted); 5 project-holding teams remain.
- 2026-07-21 — **v2 rewrite.** Fixed I-1..I-5 (backfill-first, mixed-level gate, consent sequencing,
  effective-access baseline, active sweep); added decisions D1–D4; corrected terminology
  (READ/WRITE vs FULL/READONLY, PENDING/ACTIVE/DECLINED, global flags). All claims verified against
  code at `1e6d8cd`.
