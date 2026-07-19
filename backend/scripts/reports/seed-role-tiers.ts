/**
 * Phase 1C — seed the three role tiers and make flag-on survivable.
 *
 * Does two things, both idempotent:
 *
 * 1. Grants `task.assign_any` + `project.share` to every team's SYSTEM
 *    Manager role, as explicit RolePermission rows.
 *
 *    This is the step that makes ACCESS_UNIT_SCOPE=on safe to enable. The two
 *    keys are deliberately excluded from the legacy fallback set (the R-1
 *    fix), and the v1.23-era seeded Manager roles predate them — so without
 *    this, NOBODY holds task.assign_any, every unresolved-unit user is
 *    assignable by no one, and enforcement bricks assignment instead of
 *    scoping it. Behaviour-preserving: managers can assign anyone today;
 *    after flag-on they still can, now via an explicit, revocable grant.
 *
 * 2. Seeds the three role-tier templates per team, as ORDINARY editable roles
 *    (isSystem=false — teams may rename, adjust, or delete them):
 *
 *      Department manager  full lifecycle, assign anywhere in the team
 *      Supervisor          create + assign within their unit and granted
 *                          collaborators (the scope rule does the confining —
 *                          the role simply lacks task.assign_any)
 *      Specialist          act on own assignments, comment. Assignment
 *                          self-service comes from the subtask self-service
 *                          rung, not from a permission.
 *
 * Usage
 * -----
 *   DATABASE_URL='...' npx tsx scripts/reports/seed-role-tiers.ts           # dry run
 *   DATABASE_URL='...' npx tsx scripts/reports/seed-role-tiers.ts --apply
 */

import { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from '../../src/lib/permissions.js';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

const MANAGER_ADDITIONS = ['task.assign_any', 'project.share'] as const;

const TIERS: { name: string; description: string; permissions: readonly string[] }[] = [
  {
    name: 'Department manager',
    description:
      'Full lifecycle. Assigns work anywhere in the team (task.assign_any) and shares projects outward.',
    permissions: PERMISSIONS,
  },
  {
    name: 'Supervisor',
    description:
      'Creates and assigns work within their own unit and granted collaborators. ' +
      'Unit confinement comes from ACCESS_UNIT_SCOPE, not from a permission.',
    permissions: [
      'task.delete',
      'task.modify_dates',
      'task.change_responsible',
      'task.change_assignee',
      'task.manage_dependencies',
      'correspondence.read',
    ],
  },
  {
    name: 'Specialist',
    description: 'Acts on own assignments and comments. Status self-service is built in.',
    permissions: ['correspondence.read'],
  },
];

async function main(): Promise<number> {
  const teams = await prisma.team.findMany({ select: { id: true, name: true } });
  let managerGrants = 0;
  let rolesCreated = 0;
  let rolesExisting = 0;

  for (const team of teams) {
    // ---- 1. explicit grants onto the system Manager role ----------------
    const systemManager = await prisma.role.findFirst({
      where: { teamId: team.id, isSystem: true, name: { equals: 'Manager', mode: 'insensitive' } },
      select: { id: true },
    });
    if (!systemManager) {
      console.log(`  ! ${team.name}: no system Manager role — run backfill:roles first`);
    } else {
      const missing: string[] = [];
      for (const p of MANAGER_ADDITIONS) {
        const has = await prisma.rolePermission.findUnique({
          where: { roleId_permission: { roleId: systemManager.id, permission: p } },
          select: { roleId: true },
        });
        if (!has) missing.push(p);
      }
      managerGrants += missing.length;
      if (apply && missing.length) {
        await prisma.rolePermission.createMany({
          data: missing.map((permission) => ({ roleId: systemManager.id, permission })),
          skipDuplicates: true,
        });
      }
    }

    // ---- 2. tier templates ---------------------------------------------
    for (const tier of TIERS) {
      const existing = await prisma.role.findFirst({
        where: { teamId: team.id, name: { equals: tier.name, mode: 'insensitive' } },
        select: { id: true },
      });
      if (existing) {
        // Never touch an existing role's permissions — "editable per-team
        // copies" means the team's edits win over the template, always.
        rolesExisting += 1;
        continue;
      }
      rolesCreated += 1;
      if (!apply) continue;
      await prisma.role.create({
        data: {
          teamId: team.id,
          name: tier.name,
          description: tier.description,
          isSystem: false,
          permissions: {
            createMany: {
              data: tier.permissions.map((permission) => ({ permission })),
            },
          },
        },
      });
    }
  }

  console.log('');
  console.log(`Teams                      ${teams.length}`);
  console.log(`Manager grants ${apply ? 'added' : 'to add'}     ${managerGrants} (task.assign_any / project.share)`);
  console.log(`Tier roles ${apply ? 'created' : 'to create'}       ${rolesCreated}`);
  console.log(`Tier roles already present ${rolesExisting} (left untouched — team edits win)`);
  if (!apply) console.log('\nDRY RUN — re-run with --apply to write.');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('seed-role-tiers failed:', err);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
