/**
 * Active equivalence sweep — Phase 2 / D4 exit gate.
 *
 * The passive `access.divergence` logging in `dual` mode only fires for (user,
 * project) pairs that organic traffic happens to touch, so it can never *prove*
 * the backfill is complete. This sweep makes it active: it enumerates EVERY
 * (user × project) pair and prints the effective access the REAL resolver
 * returns. Run it once per resolution mode and diff the two outputs — an empty
 * diff means legacy and unified agree for every pair, i.e. flipping
 * `ACCESS_UNIFIED_GRANTS=on` cannot change anyone's access.
 *
 *   docker compose exec -e ACCESS_UNIFIED_GRANTS=off -T backend \
 *     npx tsx scripts/reports/access-equivalence-sweep.ts > legacy.txt
 *   docker compose exec -e ACCESS_UNIFIED_GRANTS=on  -T backend \
 *     npx tsx scripts/reports/access-equivalence-sweep.ts > unified.txt
 *   diff legacy.txt unified.txt        # empty == perfect equivalence
 *
 * Read-only and non-disruptive: `off`/`on` never call recordDivergence, both
 * resolvers only SELECT, and `-e` overrides the flag for THIS process only —
 * the running server is untouched and stays in `dual`. (Not baked into the
 * image; copy it in per the grant-backfill I-6 recipe:
 *   CID=$(docker compose ps -q backend)
 *   docker compose exec -T backend mkdir -p /app/scripts/reports
 *   docker cp backend/scripts/reports/access-equivalence-sweep.ts \
 *     "$CID":/app/scripts/reports/access-equivalence-sweep.ts )
 */
import { PrismaClient, type GlobalRole } from '@prisma/client';
import { resolveProjectAccess } from '../../src/lib/projectAccess.js';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, globalRole: true } });
  const projects = await prisma.project.findMany({ select: { id: true, teamId: true } });

  const rows: string[] = [];
  for (const p of projects) {
    for (const u of users) {
      const level = await resolveProjectAccess(
        p.id,
        p.teamId,
        u.id,
        u.globalRole as GlobalRole,
        'nested',
      );
      // NONE == absence; only emit real access so the diff stays readable and
      // still captures every transition (NONE<->READ/WRITE and READ<->WRITE).
      if (level !== 'NONE') rows.push(`${u.id}\t${p.id}\t${level}`);
    }
  }

  rows.sort();
  process.stderr.write(
    `[sweep mode=${process.env.ACCESS_UNIFIED_GRANTS ?? 'off'}] ` +
      `users=${users.length} projects=${projects.length} non-NONE pairs=${rows.length}\n`,
  );
  process.stdout.write(rows.join('\n') + (rows.length ? '\n' : ''));
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
