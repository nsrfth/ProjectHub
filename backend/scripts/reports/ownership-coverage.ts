/**
 * Phase 1C — ownership-policy violations report.
 *
 * Lists projects whose owner does NOT hold a manager-tier role (= a role
 * granting `project.edit`) in the project's home team. The policy is enforced
 * only at create/transfer and only while ACCESS_UNIT_SCOPE is on — existing
 * projects are never retroactively broken — so this report is how you find
 * and fix the backlog BEFORE enabling the flag, per the plan's
 * "violations report first" rule.
 *
 * Read-only.  DATABASE_URL='...' npx tsx scripts/reports/ownership-coverage.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<number> {
  const projects = await prisma.project.findMany({
    select: {
      id: true,
      name: true,
      teamId: true,
      ownerId: true,
      team: { select: { name: true } },
      owner: { select: { name: true, email: true, globalRole: true } },
    },
    orderBy: { name: 'asc' },
  });

  const violations: { project: string; team: string; owner: string; reason: string }[] = [];

  for (const p of projects) {
    if (!p.ownerId || !p.owner) {
      violations.push({
        project: p.name,
        team: p.team.name,
        owner: '(none)',
        reason: 'no owner at all',
      });
      continue;
    }
    if (p.owner.globalRole === 'ADMIN') continue;

    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: p.ownerId, teamId: p.teamId } },
      select: { roleId: true, role: true },
    });
    if (!membership) {
      violations.push({
        project: p.name,
        team: p.team.name,
        owner: p.owner.email,
        reason: 'owner is not a member of the home team',
      });
      continue;
    }

    let holdsProjectEdit: boolean;
    if (membership.roleId) {
      holdsProjectEdit = !!(await prisma.rolePermission.findUnique({
        where: { roleId_permission: { roleId: membership.roleId, permission: 'project.edit' } },
        select: { roleId: true },
      }));
    } else {
      // Legacy fallback path: MANAGER enum implies the full default set.
      holdsProjectEdit = membership.role === 'MANAGER';
    }
    if (!holdsProjectEdit) {
      violations.push({
        project: p.name,
        team: p.team.name,
        owner: p.owner.email,
        reason: 'owner role does not grant project.edit',
      });
    }
  }

  console.log('');
  console.log('Ownership policy — Phase 1C violations report');
  console.log('='.repeat(66));
  console.log(`Projects checked ${projects.length}`);
  console.log(`Violations       ${violations.length}`);
  if (violations.length) {
    console.log('');
    for (const v of violations) {
      console.log(`  ${v.team} / ${v.project}`);
      console.log(`      owner ${v.owner} — ${v.reason}`);
    }
    console.log('');
    console.log('Fix these (transfer ownership or grant a manager-tier role) BEFORE');
    console.log('enabling ACCESS_UNIT_SCOPE; enforcement applies to create/transfer only,');
    console.log('so existing rows stay functional but violate the target model.');
  }
  console.log('');
  return violations.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('ownership-coverage failed:', err);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
