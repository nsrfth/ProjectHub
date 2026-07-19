/**
 * Phase 0d-i — roleId coverage report.
 *
 * Gate for Phase 1B (the roleId backfill), which is itself a hard gate before
 * any new permission key may be introduced.
 *
 * Why this matters
 * ----------------
 * The permission middleware is dual-path: it consults the custom role only when
 * `TeamMembership.roleId` is non-null, and otherwise falls back to the legacy
 * `TeamRole` enum defaults. The manager default is the *entire* permission
 * array. So every permission key added to the codebase is automatically granted
 * to every legacy-manager membership still sitting on the fallback path, and
 * seeded role templates change nothing for those memberships.
 *
 * This report answers the only question that gates 1B: how many memberships are
 * still on the fallback path, and is each team ready to receive a backfill?
 *
 * Usage
 * -----
 *   cd backend
 *   DATABASE_URL='postgresql://...' npx tsx scripts/reports/role-coverage.ts
 *   DATABASE_URL='postgresql://...' npx tsx scripts/reports/role-coverage.ts --json
 *
 * Read-only. This script performs no writes.
 */

import { PrismaClient, type TeamRole } from '@prisma/client';

const prisma = new PrismaClient();

const asJson = process.argv.includes('--json');

interface TeamRow {
  teamId: string;
  teamName: string;
  total: number;
  withRole: number;
  nullRole: number;
  nullByLegacyRole: Record<TeamRole, number>;
  systemRoles: { manager: string | null; member: string | null; systemRoleNames: string[] };
  backfillReady: boolean;
  blockers: string[];
}

async function main() {
  // One consistent snapshot. Read separately, a team created between queries
  // would surface as a phantom "orphaned membership" below.
  const [teams, memberships, roles] = await prisma.$transaction([
    prisma.team.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.teamMembership.findMany({
      select: { teamId: true, roleId: true, role: true },
    }),
    // System roles are the backfill targets.
    prisma.role.findMany({
      where: { isSystem: true },
      select: { id: true, teamId: true, name: true },
    }),
  ]);

  // System roles are seeded as "Manager" / "Member" but the schema documents
  // them as editable — a team may have renamed them. Name matching alone would
  // then report a false blocker on a team that is perfectly backfillable, and
  // this report gates Phase 1B, so a false blocker stalls real work.
  //
  // Distinguish the two cases: no system roles at all (genuinely blocked, needs
  // seeding) versus system roles present but not name-matchable (needs a human
  // to pick the target, not a seed).
  const rolesByTeam = new Map<
    string,
    { manager: string | null; member: string | null; systemRoleNames: string[] }
  >();
  for (const r of roles) {
    const entry =
      rolesByTeam.get(r.teamId) ?? { manager: null, member: null, systemRoleNames: [] };
    const n = r.name.trim().toLowerCase();
    if (n === 'manager') entry.manager = r.id;
    if (n === 'member') entry.member = r.id;
    entry.systemRoleNames.push(r.name);
    rolesByTeam.set(r.teamId, entry);
  }

  const rows: TeamRow[] = teams.map((t) => {
    const mine = memberships.filter((m) => m.teamId === t.id);
    const nulls = mine.filter((m) => m.roleId === null);

    const nullByLegacyRole = { MANAGER: 0, MEMBER: 0 } as Record<TeamRole, number>;
    for (const m of nulls) nullByLegacyRole[m.role] = (nullByLegacyRole[m.role] ?? 0) + 1;

    const systemRoles =
      rolesByTeam.get(t.id) ?? { manager: null, member: null, systemRoleNames: [] };
    const hasSystemRoles = systemRoles.systemRoleNames.length > 0;

    const blockers: string[] = [];
    for (const [legacyRole, targetId] of [
      ['MANAGER', systemRoles.manager],
      ['MEMBER', systemRoles.member],
    ] as const) {
      if (nullByLegacyRole[legacyRole] === 0 || targetId) continue;
      blockers.push(
        hasSystemRoles
          ? `no system role named "${legacyRole === 'MANAGER' ? 'Manager' : 'Member'}" — ` +
            `team has system role(s) [${systemRoles.systemRoleNames.join(', ')}], ` +
            'so a backfill target must be chosen by hand rather than seeded'
          : `no system roles on this team at all — seed them before backfilling ${legacyRole}`,
      );
    }

    return {
      teamId: t.id,
      teamName: t.name,
      total: mine.length,
      withRole: mine.length - nulls.length,
      nullRole: nulls.length,
      nullByLegacyRole,
      systemRoles,
      backfillReady: nulls.length === 0 || blockers.length === 0,
      blockers,
    };
  });

  // Memberships whose team no longer resolves would be invisible above.
  const knownTeamIds = new Set(teams.map((t) => t.id));
  const orphaned = memberships.filter((m) => !knownTeamIds.has(m.teamId)).length;

  const totals = {
    teams: rows.length,
    memberships: memberships.length,
    withRole: memberships.filter((m) => m.roleId !== null).length,
    nullRole: memberships.filter((m) => m.roleId === null).length,
    orphanedMemberships: orphaned,
    teamsWithNulls: rows.filter((r) => r.nullRole > 0).length,
    teamsBlocked: rows.filter((r) => r.blockers.length > 0).length,
  };

  // Exit code is the machine-readable gate: 0 means Phase 1B's precondition is
  // already met instance-wide; 1 means a backfill is still required.
  const gatePassed = totals.nullRole === 0;

  if (asJson) {
    console.log(
      JSON.stringify(
        { generatedAt: new Date().toISOString(), gatePassed, totals, teams: rows },
        null,
        2,
      ),
    );
    return gatePassed;
  }

  const pct =
    totals.memberships === 0 ? 100 : (totals.withRole / totals.memberships) * 100;

  console.log('');
  console.log('roleId coverage — Phase 0d-i');
  console.log('='.repeat(72));
  console.log(`Generated        ${new Date().toISOString()}`);
  console.log(`Teams            ${totals.teams}`);
  console.log(`Memberships      ${totals.memberships}`);
  console.log(`  with roleId    ${totals.withRole}  (${pct.toFixed(1)}%)`);
  console.log(`  null roleId    ${totals.nullRole}   <-- on the legacy fallback path`);
  if (totals.orphanedMemberships > 0) {
    console.log(`  orphaned       ${totals.orphanedMemberships}   <-- teamId does not resolve`);
  }
  console.log('');

  const offenders = rows.filter((r) => r.nullRole > 0);

  if (offenders.length === 0) {
    console.log('Every membership points at a role record.');
  } else {
    const nameWidth = Math.max(4, ...offenders.map((r) => r.teamName.length));
    console.log(
      `${'TEAM'.padEnd(nameWidth)}  ${'NULL'.padStart(6)}  ${'TOTAL'.padStart(6)}  ${'MGR'.padStart(5)}  ${'MEM'.padStart(5)}  READY`,
    );
    console.log('-'.repeat(nameWidth + 40));
    for (const r of offenders) {
      console.log(
        `${r.teamName.padEnd(nameWidth)}  ${String(r.nullRole).padStart(6)}  ${String(r.total).padStart(6)}  ` +
          `${String(r.nullByLegacyRole.MANAGER).padStart(5)}  ${String(r.nullByLegacyRole.MEMBER).padStart(5)}  ` +
          `${r.blockers.length === 0 ? 'yes' : 'NO'}`,
      );
      for (const b of r.blockers) console.log(`${' '.repeat(nameWidth)}    ! ${b}`);
    }
  }

  console.log('');
  console.log('-'.repeat(72));
  if (gatePassed) {
    console.log('GATE PASSED — zero memberships on the fallback path.');
    console.log('Phase 1B backfill is not required. New permission keys may be introduced,');
    console.log('and the Phase 6 removal of the TeamRole fallback is unblocked.');
  } else {
    console.log(`GATE NOT PASSED — ${totals.nullRole} membership(s) on the fallback path.`);
    console.log('');
    console.log('Until this reaches zero:');
    console.log('  - any new permission key is auto-granted to every legacy manager above');
    console.log('  - edits to seeded role templates do not affect these memberships');
    console.log('  - Phase 1C and Phase 2 must not introduce their new permission keys');
    if (totals.teamsBlocked > 0) {
      console.log('');
      console.log(`  ${totals.teamsBlocked} team(s) cannot be backfilled yet — see the "!" lines.`);
    }
  }
  console.log('');

  return gatePassed;
}

main()
  .then((passed) => {
    process.exitCode = passed ? 0 : 1;
  })
  .catch((err) => {
    console.error('role-coverage report failed:', err);
    process.exitCode = 2;
  })
  // Swallow disconnect failures deliberately. An unhandled rejection here would
  // make Node exit 1 and overwrite the exit code, turning a passed gate into an
  // apparent failure (or masking the genuine exit 2 above).
  .finally(() => prisma.$disconnect().catch(() => {}));
