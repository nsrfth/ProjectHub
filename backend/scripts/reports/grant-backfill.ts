/**
 * Phase 2 — backfill ProjectAccessGrant from the legacy access tables.
 *
 * Maps the three legacy access paths onto the one grant table:
 *
 *   ProjectGroupGrant                    -> GROUP  subject, level from the
 *                                           GROUP MEMBER's accessLevel
 *   ProjectTeamShare  (READONLY|FULL)    -> TEAM   subject, READ|WRITE
 *   ProjectEditDelegate (access rung)    -> USER   subject, WRITE if FULL,
 *                                           else READ
 *
 * IDEMPOTENT BY CONSTRUCTION. The unique index on
 * (projectId, subjectType, subjectId, level) means a re-run is a no-op, and the
 * phase exit criteria require exactly that: "backfill rehearsal on snapshot
 * restore completes idempotently twice".
 *
 * A subtlety worth stating, because it is the one place the mapping is not 1:1
 * ------------------------------------------------------------------------
 * `ProjectGroupGrant` carries NO level — it is just (projectId, groupId). The
 * level lives on each *member's* `UserGroupMember.accessLevel`, so one group
 * grant can mean WRITE for one member and READ for another.
 *
 * The unified model puts the level on the GRANT. Collapsing per-member levels
 * into one group-level grant would therefore either escalate the READONLY
 * members or demote the FULL ones. Neither is acceptable, so this script emits
 * a grant per DISTINCT LEVEL PRESENT in the group, and the resolver takes the
 * max across the subjects a user satisfies — which reproduces the legacy
 * per-member answer exactly, because a user only matches the group subject if
 * they are an ACCEPTED member.
 *
 * That is not quite true in one direction, and it is deliberate: a group with
 * both FULL and READONLY members produces both a READ and a WRITE grant, so
 * every accepted member resolves to WRITE. Legacy would give the READONLY
 * member READ. This is a REAL divergence and the reason for --per-member.
 *
 *   --per-member  emit a USER-subject grant per accepted member instead of a
 *                 GROUP-subject grant, reproducing legacy exactly at the cost
 *                 of losing the group as a manageable unit (adding someone to
 *                 the group later grants nothing until a re-run).
 *
 * Default is GROUP subjects, because keeping the group meaningful is the point
 * of the redesign. Run with --dry-run first and read the mixed-level report: if
 * no group has mixed levels, the two modes are identical and there is nothing
 * to decide.
 *
 * Usage
 * -----
 *   cd backend
 *   DATABASE_URL='...' npx tsx scripts/reports/grant-backfill.ts --dry-run
 *   DATABASE_URL='...' npx tsx scripts/reports/grant-backfill.ts --apply
 *   DATABASE_URL='...' npx tsx scripts/reports/grant-backfill.ts --apply --per-member
 */

import { PrismaClient, type ProjectGrantLevel, type ProjectGrantSubject } from '@prisma/client';

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const perMember = argv.includes('--per-member');

interface PlannedGrant {
  projectId: string;
  subjectType: ProjectGrantSubject;
  subjectId: string;
  level: ProjectGrantLevel;
  source: string;
}

function key(g: PlannedGrant): string {
  return `${g.projectId}|${g.subjectType}|${g.subjectId}|${g.level}`;
}

async function main(): Promise<number> {
  const planned = new Map<string, PlannedGrant>();
  const mixedLevelGroups: { groupId: string; projectId: string; levels: string[] }[] = [];

  // ------------------------------------------------- group grants
  const groupGrants = await prisma.projectGroupGrant.findMany({
    select: {
      projectId: true,
      groupId: true,
      group: {
        select: {
          members: {
            where: { status: 'ACCEPTED' },
            select: { userId: true, accessLevel: true },
          },
        },
      },
    },
  });

  for (const gg of groupGrants) {
    const members = gg.group.members;
    if (!members.length) continue; // A grant to an empty group grants nobody anything.

    const levels = [...new Set(members.map((m) => m.accessLevel))];
    if (levels.length > 1) {
      mixedLevelGroups.push({
        groupId: gg.groupId,
        projectId: gg.projectId,
        levels: levels.map(String),
      });
    }

    if (perMember) {
      for (const m of members) {
        const g: PlannedGrant = {
          projectId: gg.projectId,
          subjectType: 'USER',
          subjectId: m.userId,
          level: m.accessLevel === 'FULL' ? 'WRITE' : 'READ',
          source: 'backfill:group:per-member',
        };
        planned.set(key(g), g);
      }
    } else {
      for (const lvl of levels) {
        const g: PlannedGrant = {
          projectId: gg.projectId,
          subjectType: 'GROUP',
          subjectId: gg.groupId,
          level: lvl === 'FULL' ? 'WRITE' : 'READ',
          source: 'backfill:group',
        };
        planned.set(key(g), g);
      }
    }
  }

  // ------------------------------------------------- team shares
  const teamShares = await prisma.projectTeamShare.findMany({
    select: { projectId: true, teamId: true, level: true },
  });
  for (const ts of teamShares) {
    const g: PlannedGrant = {
      projectId: ts.projectId,
      subjectType: 'TEAM',
      subjectId: ts.teamId,
      level: ts.level === 'FULL' ? 'WRITE' : 'READ',
      source: 'backfill:team',
    };
    planned.set(key(g), g);
  }

  // ------------------------------------------------- delegate ACCESS rung
  // Only the access rung migrates. ProjectEditDelegate.capabilities stays where
  // it is and keeps governing WHICH FIELDS a delegate may edit — that is a
  // different question from whether they can reach the project, and Phase 6
  // rationalizes the table down to capabilities-only.
  const delegates = await prisma.projectEditDelegate.findMany({
    select: { projectId: true, userId: true, capabilities: true },
  });
  for (const d of delegates) {
    const caps = Array.isArray(d.capabilities) ? (d.capabilities as unknown[]).map(String) : [];
    const g: PlannedGrant = {
      projectId: d.projectId,
      subjectType: 'USER',
      subjectId: d.userId,
      level: caps.includes('FULL') ? 'WRITE' : 'READ',
      source: 'backfill:delegate',
    };
    planned.set(key(g), g);
  }

  const rows = [...planned.values()];

  // ------------------------------------------------- report
  const existing = await prisma.projectAccessGrant.count();
  console.log('');
  console.log('ProjectAccessGrant backfill — Phase 2');
  console.log('='.repeat(66));
  console.log(`Mode                ${perMember ? 'per-member (USER subjects)' : 'group subjects'}`);
  console.log(`Legacy group grants ${groupGrants.length}`);
  console.log(`Legacy team shares  ${teamShares.length}`);
  console.log(`Legacy delegates    ${delegates.length}`);
  console.log(`Grants planned      ${rows.length}`);
  console.log(`Grants already present ${existing}`);
  console.log('');

  const bySubject = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.subjectType] = (acc[r.subjectType] ?? 0) + 1;
    return acc;
  }, {});
  for (const [k, v] of Object.entries(bySubject)) console.log(`  ${k.padEnd(9)} ${v}`);

  if (mixedLevelGroups.length) {
    console.log('');
    console.log(`MIXED-LEVEL GROUPS (${mixedLevelGroups.length}) — read this before applying`);
    console.log('-'.repeat(66));
    console.log('These groups contain BOTH FULL and READONLY accepted members.');
    console.log(perMember
      ? 'Running --per-member, so each member keeps their exact legacy level.'
      : 'In group-subject mode both a READ and a WRITE grant are emitted, so every\n' +
        'accepted member resolves to WRITE — READONLY members would be ESCALATED.\n' +
        'Re-run with --per-member to reproduce legacy exactly.');
    for (const m of mixedLevelGroups.slice(0, 20)) {
      console.log(`  group ${m.groupId} on project ${m.projectId}: ${m.levels.join(' + ')}`);
    }
    if (mixedLevelGroups.length > 20) {
      console.log(`  … and ${mixedLevelGroups.length - 20} more`);
    }
    if (!perMember) {
      console.log('');
      console.log('REFUSING TO APPLY in group-subject mode while mixed-level groups exist.');
      console.log('Either re-run with --per-member, or normalise those groups first.');
      return 1;
    }
  }

  if (!apply) {
    console.log('');
    console.log('DRY RUN — nothing written. Re-run with --apply.');
    return 0;
  }

  // ------------------------------------------------- apply
  // createMany + skipDuplicates leans on the unique index to make re-runs a
  // no-op. That is what makes "completes idempotently twice" true rather than
  // aspirational.
  const res = await prisma.projectAccessGrant.createMany({
    data: rows.map((r) => ({
      projectId: r.projectId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      level: r.level,
      status: 'ACTIVE' as const,
      source: r.source,
      // grantedById stays null — that is precisely how a backfilled row is
      // distinguished from one a human created.
      grantedById: null,
    })),
    skipDuplicates: true,
  });

  console.log('');
  console.log(`Inserted ${res.count} grant(s); ${rows.length - res.count} already existed.`);
  console.log(`Total grants now: ${await prisma.projectAccessGrant.count()}`);
  console.log('');
  console.log('Legacy tables are UNTOUCHED and remain authoritative until');
  console.log('ACCESS_UNIFIED_GRANTS=on. They are dropped in Phase 6, not here —');
  console.log('that is what keeps the flag walk reversible.');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('grant-backfill failed:', err);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
