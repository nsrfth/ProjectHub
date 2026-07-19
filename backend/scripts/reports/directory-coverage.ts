/**
 * Phase 0d-ii — directory coverage and mapping-health report.
 *
 * Tooling that Phase 1C's unit-coverage exception report is built on. Run it
 * now to establish the baseline and to validate mapping hygiene before the
 * scheduled sync job (Phase 0a) starts applying mappings unattended.
 *
 * A LIMIT YOU MUST UNDERSTAND BEFORE READING THE OUTPUT
 * ----------------------------------------------------
 * LDAP users are provisioned just-in-time, at their first successful sign-in.
 * A directory user who has never signed in therefore has NO ROW in this
 * database at all — they are not an under-covered user, they are an absent one.
 *
 * That population is exactly the one Phase 1C's scoping rules would strand, and
 * it is the reason the sync job is a hard gate. It CANNOT be counted from the
 * database. Counting it requires enumerating the directory, which is the
 * `enumerateUsers` capability specified in docs/DIRECTORY_SYNC.md §4.
 *
 * So: every population figure below is a LOWER BOUND on the real directory
 * population. This report becomes complete only once Phase 0a ships, at which
 * point its dry-run summary supplies the true denominator.
 *
 * What this report CAN tell you today:
 *   - the known local population per directory, and how it authenticates
 *   - which local users derive no team membership from any mapping
 *   - mapping health: dangling targets, inert mappings, and DN collisions
 *
 * Usage
 * -----
 *   cd backend
 *   DATABASE_URL='postgresql://...' npx tsx scripts/reports/directory-coverage.ts
 *   DATABASE_URL='postgresql://...' npx tsx scripts/reports/directory-coverage.ts --json
 *
 * Read-only. This script performs no writes and makes no LDAP connections.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const asJson = process.argv.includes('--json');

/**
 * The normaliser as it ships today (backend/src/lib/ldapDn.ts).
 * `\s+` strips ALL whitespace, including whitespace inside attribute values,
 * so `CN=Ops Team` and `CN=OpsTeam` collapse to the same key.
 */
function normalizeCurrent(dn: string): string {
  return dn.trim().replace(/\s+/g, '').toLowerCase();
}

/**
 * The corrected normaliser proposed in docs/DIRECTORY_SYNC.md §5.5 — separators
 * only, intra-value whitespace preserved.
 *
 * Two deliberate details:
 *
 * - The `=` replace is intentionally NOT global. Only the first `=` in an RDN
 *   separates the attribute type from its value; a later `=` belongs to the
 *   value and must be left alone.
 * - Splitting on `,` does not honour RFC 4514 escaping, so a DN with an escaped
 *   comma inside a value (`CN=Smith\, John,OU=x`) is split into bogus RDNs.
 *   Out of scope here: this is a comparison report, and both normalisers are
 *   equally wrong on such a DN, so the diff it reports stays valid. A real DN
 *   parser belongs in lib/ldapDn.ts if the estate turns out to contain them —
 *   the MAPPING_DN_ESCAPED finding below flags whether any do.
 */
function normalizeProposed(dn: string): string {
  return dn
    .trim()
    .split(',')
    .map((rdn) => rdn.trim().replace(/\s*=\s*/, '='))
    .join(',')
    .toLowerCase();
}

interface Finding {
  code: string;
  severity: 'ERROR' | 'WARN';
  message: string;
}

async function main() {
  // One consistent snapshot. Read separately, a team created between the
  // mapping read and the team read would be reported as a dangling mapping
  // target — a false ERROR on a healthy install.
  const [directories, mappings, teams, users] = await prisma.$transaction([
    prisma.directory.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        kind: true,
        allowJIT: true,
        syncRolesFromGroups: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.directoryGroupMapping.findMany({
      select: {
        id: true,
        directoryId: true,
        externalGroupDn: true,
        globalRole: true,
        teamId: true,
        teamRole: true,
      },
    }),
    prisma.team.findMany({ select: { id: true, name: true } }),
    prisma.user.findMany({
      where: { disabledAt: null, isSystemUser: false },
      select: {
        id: true,
        directoryId: true,
        authSource: true,
        ldapSyncedAt: true,
        memberships: { select: { teamId: true } },
      },
    }),
  ]);

  const teamById = new Map(teams.map((t) => [t.id, t.name]));

  const findings: Finding[] = [];
  const perDirectory = directories.map((dir) => {
    const dirMappings = mappings.filter((m) => m.directoryId === dir.id);
    const dirUsers = users.filter((u) => u.directoryId === dir.id);

    // Users known locally who hold no team membership at all. Under Phase 1C
    // these are the accounts nobody can assign work to.
    const withoutMembership = dirUsers.filter((u) => u.memberships.length === 0);

    // --- mapping health -------------------------------------------------

    if (dir.kind === 'LDAP' && dirMappings.length > 0 && !dir.syncRolesFromGroups) {
      findings.push({
        code: 'MAPPINGS_INERT',
        severity: 'ERROR',
        message:
          `${dir.name}: ${dirMappings.length} group mapping(s) configured but ` +
          `syncRolesFromGroups is off — none of them apply, at login or on sync.`,
      });
    }

    if (dir.kind === 'LDAP' && dirMappings.length === 0) {
      findings.push({
        code: 'NO_MAPPINGS',
        severity: 'WARN',
        message: `${dir.name}: no group mappings configured — sync would grant nothing.`,
      });
    }

    for (const m of dirMappings) {
      if (m.teamId && !teamById.has(m.teamId)) {
        findings.push({
          code: 'MAPPING_TARGET_MISSING',
          severity: 'ERROR',
          message:
            `${dir.name}: mapping ${m.id} (${m.externalGroupDn}) targets team ` +
            `${m.teamId}, which does not exist. DirectoryGroupMapping.teamId has ` +
            `no foreign key, so this dangles silently.`,
        });
      }
      if (m.teamId && !m.teamRole) {
        findings.push({
          code: 'MAPPING_INCOMPLETE',
          severity: 'WARN',
          message: `${dir.name}: mapping ${m.id} sets teamId without teamRole — it grants nothing.`,
        });
      }
      if (!m.globalRole && !m.teamId) {
        findings.push({
          code: 'MAPPING_EMPTY',
          severity: 'WARN',
          message: `${dir.name}: mapping ${m.id} grants neither a global role nor a team.`,
        });
      }
    }

    // --- DN collision detection (docs/DIRECTORY_SYNC.md §5.5) -----------

    // @@unique([directoryId, externalGroupDn]) guarantees the raw DNs in one
    // directory are already distinct, so any group of size > 1 here is a
    // genuine normalisation collision, not a duplicate row.
    const byCurrent = new Map<string, string[]>();
    for (const m of dirMappings) {
      const c = normalizeCurrent(m.externalGroupDn);
      byCurrent.set(c, [...(byCurrent.get(c) ?? []), m.externalGroupDn]);
    }

    let collisions = 0;
    for (const [key, dns] of byCurrent) {
      if (dns.length < 2) continue;
      collisions += 1;
      const stillColliding = new Set(dns.map(normalizeProposed)).size < dns.length;
      findings.push({
        code: 'MAPPING_DN_COLLISION',
        severity: 'ERROR',
        message:
          `${dir.name}: ${dns.length} distinct group DNs normalise to the same key ` +
          `"${key}" under the current normaliser — ${dns.join(' | ')}. ` +
          (stillColliding
            ? 'They collide under the proposed normaliser too — inspect these by hand.'
            : 'The proposed normaliser (DIRECTORY_SYNC.md §5.5) separates them. ' +
              'Members of one group are currently matching the other.'),
      });
    }

    // Escaped commas defeat the naive split in both normalisers. Report them so
    // we know whether a real DN parser is needed before the sync job ships.
    for (const m of dirMappings) {
      if (/\\,/.test(m.externalGroupDn)) {
        findings.push({
          code: 'MAPPING_DN_ESCAPED',
          severity: 'WARN',
          message:
            `${dir.name}: mapping ${m.id} DN contains an escaped comma ` +
            `(${m.externalGroupDn}). Neither normaliser parses RFC 4514 escaping — ` +
            'lib/ldapDn.ts needs a real DN parser before this mapping can be trusted.',
        });
      }
    }

    // Mappings whose normalised key CHANGES under the fix will start or stop
    // matching real directory groups when the fix ships.
    const shifting = dirMappings.filter(
      (m) => normalizeCurrent(m.externalGroupDn) !== normalizeProposed(m.externalGroupDn),
    );

    return {
      directoryId: dir.id,
      name: dir.name,
      slug: dir.slug,
      kind: dir.kind,
      allowJIT: dir.allowJIT,
      syncRolesFromGroups: dir.syncRolesFromGroups,
      mappings: dirMappings.length,
      mappedTeams: new Set(dirMappings.map((m) => m.teamId).filter(Boolean)).size,
      knownUsers: dirUsers.length,
      knownUsersWithoutMembership: withoutMembership.length,
      neverProfileSynced: dirUsers.filter((u) => u.ldapSyncedAt === null).length,
      dnCollisions: collisions,
      dnKeyShiftsUnderFix: shifting.length,
    };
  });

  const localUsers = users.filter((u) => u.directoryId === null);

  const totals = {
    directories: directories.length,
    ldapDirectories: directories.filter((d) => d.kind === 'LDAP').length,
    mappings: mappings.length,
    activeUsers: users.length,
    directoryUsers: users.filter((u) => u.directoryId !== null).length,
    localUsers: localUsers.length,
    usersWithoutMembership: users.filter((u) => u.memberships.length === 0).length,
    errors: findings.filter((f) => f.severity === 'ERROR').length,
    warnings: findings.filter((f) => f.severity === 'WARN').length,
  };

  const gatePassed = totals.errors === 0;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          gatePassed,
          incompleteBecause:
            'Directory users who have never signed in have no database row. ' +
            'Population figures are lower bounds until Phase 0a enumeration ships.',
          totals,
          directories: perDirectory,
          findings,
        },
        null,
        2,
      ),
    );
    return gatePassed;
  }

  console.log('');
  console.log('Directory coverage & mapping health — Phase 0d-ii');
  console.log('='.repeat(72));
  console.log(`Generated             ${new Date().toISOString()}`);
  console.log(`Directories           ${totals.directories} (${totals.ldapDirectories} LDAP)`);
  console.log(`Group mappings        ${totals.mappings}`);
  console.log(`Active users          ${totals.activeUsers}`);
  console.log(`  directory-backed    ${totals.directoryUsers}`);
  console.log(`  local               ${totals.localUsers}`);
  console.log(`  no team membership  ${totals.usersWithoutMembership}`);
  console.log('');

  if (perDirectory.length === 0) {
    console.log('No directories configured.');
  } else {
    for (const d of perDirectory) {
      console.log(`${d.name}  [${d.slug}]  kind=${d.kind}`);
      console.log(
        `  syncRolesFromGroups=${d.syncRolesFromGroups}  allowJIT=${d.allowJIT}  ` +
          `mappings=${d.mappings}  mappedTeams=${d.mappedTeams}`,
      );
      console.log(
        `  known users=${d.knownUsers}  without membership=${d.knownUsersWithoutMembership}  ` +
          `never profile-synced=${d.neverProfileSynced}`,
      );
      if (d.dnKeyShiftsUnderFix > 0) {
        console.log(
          `  ${d.dnKeyShiftsUnderFix} mapping DN(s) change normalised key under the §5.5 fix`,
        );
      }
      console.log('');
    }
  }

  if (findings.length > 0) {
    console.log('Findings');
    console.log('-'.repeat(72));
    for (const f of findings.filter((x) => x.severity === 'ERROR')) {
      console.log(`  [ERROR] ${f.code}`);
      console.log(`          ${f.message}`);
    }
    for (const f of findings.filter((x) => x.severity === 'WARN')) {
      console.log(`  [WARN ] ${f.code}`);
      console.log(`          ${f.message}`);
    }
    console.log('');
  }

  console.log('-'.repeat(72));
  console.log('INCOMPLETE BY CONSTRUCTION');
  console.log('  Directory users who have never signed in have no row in this database,');
  console.log('  because LDAP provisioning is just-in-time at first login. Every count');
  console.log('  above is a lower bound. The true directory population is only knowable');
  console.log('  once Phase 0a enumeration ships — see docs/DIRECTORY_SYNC.md §4.');
  console.log('');
  console.log(
    gatePassed
      ? `MAPPING HEALTH OK — ${totals.warnings} warning(s), no errors.`
      : `MAPPING HEALTH FAILED — ${totals.errors} error(s), ${totals.warnings} warning(s).`,
  );
  console.log('');

  return gatePassed;
}

main()
  .then((passed) => {
    process.exitCode = passed ? 0 : 1;
  })
  .catch((err) => {
    console.error('directory-coverage report failed:', err);
    process.exitCode = 2;
  })
  // Swallow disconnect failures deliberately — an unhandled rejection here would
  // make Node exit 1 and overwrite the exit code set above.
  .finally(() => prisma.$disconnect().catch(() => {}));
