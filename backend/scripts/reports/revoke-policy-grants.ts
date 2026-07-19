/**
 * Phase 5 — bulk-revoke the grants a policy materialized.
 *
 * THE cleanup path for a mis-scoped policy (risk R-6), and the reason
 * `sourcePolicyId` is a bare string rather than an FK: it must survive the
 * policy's deletion so a deleted policy's grants remain enumerable.
 *
 *   DATABASE_URL='...' npx tsx scripts/reports/revoke-policy-grants.ts <policyId>          # dry run
 *   DATABASE_URL='...' npx tsx scripts/reports/revoke-policy-grants.ts <policyId> --apply
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const policyId = argv.find((a) => !a.startsWith('--'));

async function main(): Promise<number> {
  if (!policyId) {
    console.error('Usage: revoke-policy-grants.ts <policyId> [--apply]');
    return 2;
  }
  const rows = await prisma.projectAccessGrant.findMany({
    where: { sourcePolicyId: policyId },
    include: { project: { select: { name: true } } },
  });
  console.log(`${rows.length} grant(s) stamped by policy ${policyId}:`);
  for (const r of rows.slice(0, 30)) {
    console.log(`  ${r.project.name}: ${r.subjectType} ${r.subjectId} ${r.level} (${r.status})`);
  }
  if (rows.length > 30) console.log(`  … and ${rows.length - 30} more`);
  if (!apply) {
    console.log('\nDRY RUN — re-run with --apply to delete them.');
    return 0;
  }
  const res = await prisma.projectAccessGrant.deleteMany({
    where: { sourcePolicyId: policyId },
  });
  console.log(`Deleted ${res.count} grant(s).`);
  return 0;
}

main()
  .then((c) => { process.exitCode = c; })
  .catch((err) => { console.error('revoke-policy-grants failed:', err); process.exitCode = 2; })
  .finally(() => prisma.$disconnect().catch(() => {}));
