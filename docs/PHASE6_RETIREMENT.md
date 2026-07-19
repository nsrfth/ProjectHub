# Phase 6 — Retirement & Hardening: Runbook (PREPARED, NOT EXECUTED)

**Status: prepared artifacts only.** Phase 6 is the one phase with **no online
rollback** — its own plan line reads *"Destructive — restore-from-backup only"* — and its
preconditions are calendar facts that are not yet true:

- [ ] `ACCESS_UNIFIED_GRANTS=on` in production for ≥2 weeks, zero unexplained divergence
- [ ] Phase 3 consent flow enforced in production (`ACCESS_GRANT_CONSENT=true` after `on`)
- [ ] Phase 5 shipped and exercised in production
- [ ] A **verified** backup taken immediately before execution
- [ ] The 410 deprecation period below completed

Do not run any step in §3 until every box above is checked, in writing.

## 1. What Phase 6 removes, and why it must wait

| Removal | Why it cannot happen earlier |
|---|---|
| `ProjectGroupGrant` + `ProjectTeamShare` tables | They are **authoritative** under `off`/`dual`, and the grants service dual-writes them. Dropping them while the flag can still be walked back destroys the rollback. |
| Legacy team-shares / group-projects endpoints (→ 410 `ENDPOINT_RETIRED`) | Same dependency; the unified panel replaced the UI, but API consumers may exist. |
| `requirePermission` TeamRole fallback | Precondition (0 null `roleId`) was verified in v2.7.0 ✅ — but removal ships with the same release as the drops, so one release carries all of Phase 6. |
| `ProjectEditDelegate` access rung (capabilities stay) | Delegate access rows were backfilled into grants; capabilities remain a separate concern. |

## 2. Verification gates (run before AND after)

```bash
# Gate A: no null roleIds (1B still holding)
npm run report:role-coverage

# Gate B: zero authorization reads of the TeamRole enum outside the fallback
bash scripts/phase6/verify-no-teamrole-authz.sh

# Gate C: legacy tables and grant table agree (must be EMPTY before drops)
# — any row here is a share that would be lost:
docker exec <postgres> psql -U taskhub -d taskhub -c "
  SELECT s.\"projectId\", s.\"teamId\" FROM \"ProjectTeamShare\" s
  LEFT JOIN \"ProjectAccessGrant\" g ON g.\"projectId\" = s.\"projectId\"
    AND g.\"subjectType\" = 'TEAM' AND g.\"subjectId\" = s.\"teamId\" AND g.status = 'ACTIVE'
  WHERE g.id IS NULL;"
```

## 3. Execution (one release, in this order)

1. Take + verify a backup (`pg_restore --list` on the dump, not just `ls`).
2. Ship the release that turns the legacy endpoints into 410 `ENDPOINT_RETIRED`.
3. **Wait the deprecation window (≥2 weeks)** watching for 410 hits in logs.
4. Apply `scripts/phase6/drop-legacy-tables.sql.draft` — after renaming it and moving it
   into a real Prisma migration. It is deliberately stored OUTSIDE `prisma/migrations/`
   so no deploy can auto-apply it.
5. Remove the TeamRole fallback from `requirePermission.ts` (all four helpers) and the
   dual resolver path from `projectAccess.ts`; delete the dual-write branches in
   `projectGrantsService`, `projectsService.setTeamShares`, `userGroupsService.setProjects`.
6. Run Gate B again — it must return zero.

## 4. Quarterly access review (ISO 27001 A.5.18) — effective immediately

This part of Phase 6 is procedural and needs no code removal; it starts now.

- **Owner:** D&T Technology Director (or delegate named in writing)
- **Cadence:** first week of each quarter
- **Procedure:** export `GET /api/admin/access-report` → review every ACTIVE grant with
  the granting manager (does this person/team/unit still need this level?) → revoke
  what is no longer justified via the Sharing panel → archive the CSV + a one-paragraph
  disposition note in the ISMS evidence store.
- **Evidence:** the archived CSV pair (before/after) per quarter.
