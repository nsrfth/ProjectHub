/**
 * Phase 1B — `roleId` backfill.
 *
 * THE hard gate of Phase 1. Until this reports zero remaining null-`roleId`
 * memberships instance-wide:
 *   - `hasPermission` still falls back to the legacy TeamRole enum for those
 *     rows, so edits to seeded role templates do not affect them
 *   - the Phase 6 removal of that fallback path cannot proceed
 *
 * What it does, in order:
 *   1. Ensure every team has its system roles (Manager / Member / PMO)
 *   2. Point every null-`roleId` membership at the role matching its legacy
 *      TeamRole enum
 *   3. Verify zero remain
 *
 * Every changed row id is written to a rollback file BEFORE the write, so the
 * change is reversible: `--rollback <file>` re-nulls exactly those rows and
 * nothing else. That matters because re-nulling *every* roleId would destroy
 * genuine role assignments made after the backfill.
 *
 * Usage
 * -----
 *   cd backend
 *   DATABASE_URL='...' npx tsx scripts/reports/role-backfill.ts --dry-run
 *   DATABASE_URL='...' npx tsx scripts/reports/role-backfill.ts --apply
 *   DATABASE_URL='...' npx tsx scripts/reports/role-backfill.ts --rollback backfill-<ts>.json
 *
 * Dry run is the default. `--apply` is required to write anything.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { PrismaClient, type TeamRole } from '@prisma/client';

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const rollbackIdx = argv.indexOf('--rollback');
const rollbackFile = rollbackIdx >= 0 ? argv[rollbackIdx + 1] : undefined;

interface RollbackRecord {
  generatedAt: string;
  /** Membership ids this run set a roleId on. Rollback re-nulls exactly these. */
  membershipIds: string[];
  /** Roles this run created, so a rollback can report (not delete) them. */
  createdRoleIds: string[];
}

async function ensureSystemRolesForTeam(teamId: string): Promise<{
  manager: string;
  member: string;
  created: string[];
}> {
  const created: string[] = [];
  const existing = await prisma.role.findMany({
    where: { teamId, isSystem: true },
    select: { id: true, name: true },
  });

  const find = (name: string) =>
    existing.find((r) => r.name.trim().toLowerCase() === name.toLowerCase())?.id;

  let manager = find('Manager');
  let member = find('Member');

  if (!manager) {
    const r = await prisma.role.create({
      data: { teamId, name: 'Manager', isSystem: true },
      select: { id: true },
    });
    manager = r.id;
    created.push(r.id);
  }
  if (!member) {
    const r = await prisma.role.create({
      data: { teamId, name: 'Member', isSystem: true },
      select: { id: true },
    });
    member = r.id;
    created.push(r.id);
  }

  return { manager, member, created };
}

async function main(): Promise<number> {
  // ---------------------------------------------------------------- rollback
  if (rollbackFile) {
    const rec = JSON.parse(readFileSync(rollbackFile, 'utf8')) as RollbackRecord;
    console.log(`Rolling back ${rec.membershipIds.length} membership(s) from ${rollbackFile}`);
    if (!apply) {
      console.log('DRY RUN — pass --apply to actually re-null these rows.');
      return 0;
    }
    const res = await prisma.teamMembership.updateMany({
      where: { id: { in: rec.membershipIds } },
      data: { roleId: null },
    });
    console.log(`Re-nulled ${res.count} membership(s).`);
    if (rec.createdRoleIds.length) {
      console.log(
        `\nNOTE: this run also created ${rec.createdRoleIds.length} system role(s), which are ` +
          'NOT deleted. They may since have been assigned to other memberships, and a ' +
          'team without system roles is a broken state. Remove them by hand if you are sure.',
      );
    }
    return 0;
  }

  // ---------------------------------------------------------------- backfill
  const nulls = await prisma.teamMembership.findMany({
    where: { roleId: null },
    select: { id: true, teamId: true, userId: true, role: true },
  });

  if (nulls.length === 0) {
    console.log('Nothing to do — zero memberships on the legacy fallback path.');
    console.log('Phase 1B precondition is already met.');
    return 0;
  }

  const byTeam = new Map<string, typeof nulls>();
  for (const m of nulls) {
    byTeam.set(m.teamId, [...(byTeam.get(m.teamId) ?? []), m]);
  }

  console.log(`${nulls.length} membership(s) across ${byTeam.size} team(s) need a roleId.\n`);

  const record: RollbackRecord = {
    generatedAt: new Date().toISOString(),
    membershipIds: [],
    createdRoleIds: [],
  };

  // Plan first, write second — so a dry run reports exactly what --apply does.
  const plan: { membershipId: string; roleId: string; teamId: string; legacy: TeamRole }[] = [];

  for (const [teamId, members] of byTeam) {
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } });
    if (!team) {
      // TeamMembership.teamId IS a real FK with cascade delete, so this is only
      // reachable if a team is dropped between the read above and here.
      console.log(`  ! team ${teamId} vanished mid-run; skipping ${members.length} row(s)`);
      continue;
    }

    let roles: { manager: string; member: string; created: string[] };
    if (apply) {
      roles = await ensureSystemRolesForTeam(teamId);
      record.createdRoleIds.push(...roles.created);
    } else {
      const existing = await prisma.role.findMany({
        where: { teamId, isSystem: true },
        select: { id: true, name: true },
      });
      const find = (n: string) =>
        existing.find((r) => r.name.trim().toLowerCase() === n.toLowerCase())?.id;
      roles = { manager: find('Manager') ?? '(would create)', member: find('Member') ?? '(would create)', created: [] };
    }

    for (const m of members) {
      const roleId = m.role === 'MANAGER' ? roles.manager : roles.member;
      plan.push({ membershipId: m.id, roleId, teamId, legacy: m.role });
    }

    const mgr = members.filter((m) => m.role === 'MANAGER').length;
    console.log(`  ${team.name}: ${members.length} row(s) — ${mgr} MANAGER, ${members.length - mgr} MEMBER`);
  }

  if (!apply) {
    console.log(`\nDRY RUN — ${plan.length} membership(s) would be updated. Nothing written.`);
    console.log('Re-run with --apply to perform the backfill.');
    return 0;
  }

  // Write the rollback record BEFORE mutating, so a crash mid-backfill still
  // leaves a usable record of what was in flight.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = `backfill-${stamp}.json`;
  record.membershipIds = plan.map((p) => p.membershipId);
  writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`\nRollback record written to ${outFile} (${record.membershipIds.length} row ids).`);

  // Group by target roleId so this is a handful of updateMany calls rather than
  // one round trip per membership.
  const byRole = new Map<string, string[]>();
  for (const p of plan) {
    byRole.set(p.roleId, [...(byRole.get(p.roleId) ?? []), p.membershipId]);
  }

  let updated = 0;
  for (const [roleId, ids] of byRole) {
    const res = await prisma.teamMembership.updateMany({
      where: { id: { in: ids }, roleId: null },
      data: { roleId },
    });
    updated += res.count;
  }
  console.log(`Updated ${updated} membership(s).`);

  // ---------------------------------------------------------------- verify
  const remaining = await prisma.teamMembership.count({ where: { roleId: null } });
  console.log('');
  if (remaining === 0) {
    console.log('GATE PASSED — zero memberships remain on the legacy fallback path.');
    console.log('Phase 1C may now introduce task.assign_any, and Phase 2 project.share.');
    console.log('Phase 6 may remove the requirePermission TeamRole fallback.');
    return 0;
  }
  console.log(`GATE NOT PASSED — ${remaining} membership(s) still have a null roleId.`);
  console.log('Investigate before proceeding; re-running is safe (the update is idempotent).');
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('role-backfill failed:', err);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
