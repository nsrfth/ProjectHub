/**
 * v2.10 (nomenclature wave, G-1/G-2) — align the seeded tier roles with the
 * organizational vocabulary. Data-only; zero schema, zero service changes.
 *
 *   G-2: rename per-team roles  Supervisor -> سرپرست,  Specialist -> کارشناس.
 *        These are DATA (editable per-team rows, isSystem=false), so a rename
 *        script — not a display map, which would silently fight admin edits.
 *   G-1: the seeded "Department manager" tier is redundant now that the
 *        SYSTEM Manager role displays as «معاون». Delete it per team IFF it
 *        has zero membership assignments; assigned ones are reported as
 *        TIER_STILL_ASSIGNED and never deleted.
 *
 * System roles are NEVER touched here (Q2): seed-role-tiers.ts and the Phase 6
 * Gate B assumptions match on their stored names.
 *
 *   DATABASE_URL='...' npx tsx scripts/reports/rename-role-tiers.ts           # dry run
 *   DATABASE_URL='...' npx tsx scripts/reports/rename-role-tiers.ts --apply
 *
 * Idempotent: a second --apply reports all-skipped. Exits non-zero on any
 * conflict so the operator sees it.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

const RENAMES: { from: string; to: string }[] = [
  { from: 'Supervisor', to: 'سرپرست' },
  { from: 'Specialist', to: 'کارشناس' },
];
const DELETE_IF_UNASSIGNED = 'Department manager';

async function main(): Promise<number> {
  const teams = await prisma.team.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  let renamed = 0;
  let deleted = 0;
  let skipped = 0;
  let conflicts = 0;

  for (const team of teams) {
    const lines: string[] = [];

    for (const { from, to } of RENAMES) {
      // Only isSystem=false — a system role coincidentally named the same
      // (there are none, but the guard is the point) must never be renamed.
      const src = await prisma.role.findFirst({
        where: { teamId: team.id, isSystem: false, name: { equals: from, mode: 'insensitive' } },
        select: { id: true },
      });
      const dst = await prisma.role.findFirst({
        where: { teamId: team.id, name: { equals: to, mode: 'insensitive' } },
        select: { id: true },
      });
      if (!src) {
        // Already renamed (by us or an admin) or never seeded — both fine.
        skipped += 1;
        lines.push(`  = ${from}: not present (already renamed or admin-edited) — skipped`);
        continue;
      }
      if (dst) {
        conflicts += 1;
        lines.push(`  ! ${from}: a role named "${to}" already exists — CONFLICT, not renamed`);
        continue;
      }
      renamed += 1;
      lines.push(`  ~ ${from} -> ${to}`);
      if (apply) {
        await prisma.role.update({ where: { id: src.id }, data: { name: to } });
      }
    }

    const tier = await prisma.role.findFirst({
      where: {
        teamId: team.id,
        isSystem: false,
        name: { equals: DELETE_IF_UNASSIGNED, mode: 'insensitive' },
      },
      select: { id: true, _count: { select: { memberships: true } } },
    });
    if (!tier) {
      skipped += 1;
      lines.push(`  = ${DELETE_IF_UNASSIGNED}: not present — skipped`);
    } else if (tier._count.memberships > 0) {
      conflicts += 1;
      lines.push(
        `  ! TIER_STILL_ASSIGNED: "${DELETE_IF_UNASSIGNED}" has ${tier._count.memberships} ` +
          'assignment(s) — NOT deleted. Move those members to the system Manager ' +
          'role (displays as «معاون») first.',
      );
    } else {
      deleted += 1;
      lines.push(`  - ${DELETE_IF_UNASSIGNED}: zero assignments — ${apply ? 'deleted' : 'would delete'}`);
      if (apply) {
        await prisma.role.delete({ where: { id: tier.id } });
      }
    }

    console.log(`${team.name}`);
    for (const l of lines) console.log(l);
  }

  console.log('');
  console.log(`teams=${teams.length} renamed=${renamed} deleted=${deleted} skipped=${skipped} conflicts=${conflicts}`);
  if (!apply) console.log('DRY RUN — re-run with --apply to write.');
  return conflicts > 0 ? 1 : 0;
}

main()
  .then((c) => { process.exitCode = c; })
  .catch((err) => { console.error('rename-role-tiers failed:', err); process.exitCode = 2; })
  .finally(() => prisma.$disconnect().catch(() => {}));
