import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv, resetEnvCacheForTests } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { resolveProjectAccess } from '../../src/lib/projectAccess.js';

// v2.6 (Phase 2) — unified project-access grants.
//
// The property that matters most is PARITY: under `dual` the legacy answer is
// returned unchanged, and under `on` the unified resolver must give the SAME
// answer for every legacy access shape. A resolver rewrite on the hottest
// authorization path cannot be signed off by reading a diff.
//
// Each test therefore asserts the same scenario twice — once with the flag off
// (legacy) and once with it on (unified) — and requires identical results.

let app: FastifyInstance;

const rnd = () => Math.random().toString(36).slice(2, 8);

/** Re-read env after mutating a flag; loadEnv memoizes. */
function setFlag(mode: 'off' | 'dual' | 'on'): void {
  process.env.ACCESS_UNIFIED_GRANTS = mode;
  resetEnvCacheForTests();
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  process.env.MASTER_KEY ||=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  setFlag('off');
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  setFlag('off');
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.securityAuditEvent.deleteMany();
  await prisma.projectAccessGrant.deleteMany();
  await prisma.projectGroupGrant.deleteMany();
  await prisma.projectTeamShare.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.project.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  setFlag('off');
});

async function makeUser(email: string) {
  return prisma.user.create({ data: { email, name: email.split('@')[0]! } });
}
async function makeTeam(name: string) {
  return prisma.team.create({ data: { name, slug: `${name.toLowerCase()}-${rnd()}` } });
}
async function makeProject(teamId: string, ownerId: string, name = 'P') {
  return prisma.project.create({ data: { name: `${name}-${rnd()}`, teamId, ownerId } });
}

/**
 * Assert legacy and unified agree, and return the shared answer.
 * A divergence here is the exact thing the dual-mode window exists to catch.
 */
async function bothAgree(
  projectId: string,
  teamId: string,
  userId: string,
  globalRole: 'ADMIN' | 'MEMBER' = 'MEMBER',
  scope: 'view' | 'nested' = 'nested',
): Promise<string> {
  setFlag('off');
  const legacy = await resolveProjectAccess(projectId, teamId, userId, globalRole, scope);
  setFlag('on');
  const unified = await resolveProjectAccess(projectId, teamId, userId, globalRole, scope);
  setFlag('off');
  expect({ legacy, unified }).toEqual({ legacy, unified: legacy });
  return unified;
}

describe('unified grants — parity with legacy resolution', () => {
  it('owner gets WRITE under both resolvers', async () => {
    const owner = await makeUser(`owner-${rnd()}@t.local`);
    const team = await makeTeam('Alpha');
    const project = await makeProject(team.id, owner.id);
    expect(await bothAgree(project.id, team.id, owner.id)).toBe('WRITE');
  });

  it('an unrelated team member gets NONE under both', async () => {
    const owner = await makeUser(`o-${rnd()}@t.local`);
    const other = await makeUser(`x-${rnd()}@t.local`);
    const team = await makeTeam('Bravo');
    await prisma.teamMembership.create({
      data: { userId: other.id, teamId: team.id, role: 'MEMBER' },
    });
    const project = await makeProject(team.id, owner.id);
    expect(await bothAgree(project.id, team.id, other.id)).toBe('NONE');
  });

  it('a FULL group grant yields WRITE under both', async () => {
    const owner = await makeUser(`o-${rnd()}@t.local`);
    const member = await makeUser(`m-${rnd()}@t.local`);
    const team = await makeTeam('Charlie');
    const project = await makeProject(team.id, owner.id);
    const group = await prisma.userGroup.create({
      data: { teamId: team.id, name: `g-${rnd()}` },
    });
    await prisma.userGroupMember.create({
      data: { groupId: group.id, userId: member.id, accessLevel: 'FULL', status: 'ACCEPTED' },
    });
    await prisma.projectGroupGrant.create({
      data: { projectId: project.id, groupId: group.id },
    });
    // The unified path reads ProjectAccessGrant, so the backfill's output is
    // what makes parity hold — mirror it here.
    await prisma.projectAccessGrant.create({
      data: {
        projectId: project.id, subjectType: 'GROUP', subjectId: group.id,
        level: 'WRITE', source: 'backfill:group',
      },
    });
    expect(await bothAgree(project.id, team.id, member.id)).toBe('WRITE');
  });

  it('a PENDING group membership yields NONE under both', async () => {
    // Consent lives on group MEMBERSHIP, not on the grant. Phase 2 must not
    // change that — grant-level PENDING is Phase 3.
    const owner = await makeUser(`o-${rnd()}@t.local`);
    const member = await makeUser(`m-${rnd()}@t.local`);
    const team = await makeTeam('Delta');
    const project = await makeProject(team.id, owner.id);
    const group = await prisma.userGroup.create({
      data: { teamId: team.id, name: `g-${rnd()}` },
    });
    await prisma.userGroupMember.create({
      data: { groupId: group.id, userId: member.id, accessLevel: 'FULL', status: 'PENDING' },
    });
    await prisma.projectGroupGrant.create({
      data: { projectId: project.id, groupId: group.id },
    });
    await prisma.projectAccessGrant.create({
      data: {
        projectId: project.id, subjectType: 'GROUP', subjectId: group.id,
        level: 'WRITE', source: 'backfill:group',
      },
    });
    expect(await bothAgree(project.id, team.id, member.id)).toBe('NONE');
  });

  it('a READONLY whole-team share yields READ under both', async () => {
    const owner = await makeUser(`o-${rnd()}@t.local`);
    const guest = await makeUser(`g-${rnd()}@t.local`);
    const home = await makeTeam('Home');
    const guestTeam = await makeTeam('Guest');
    const project = await makeProject(home.id, owner.id);
    await prisma.teamMembership.create({
      data: { userId: guest.id, teamId: guestTeam.id, role: 'MEMBER' },
    });
    await prisma.projectTeamShare.create({
      data: { projectId: project.id, teamId: guestTeam.id, level: 'READONLY' },
    });
    await prisma.projectAccessGrant.create({
      data: {
        projectId: project.id, subjectType: 'TEAM', subjectId: guestTeam.id,
        level: 'READ', source: 'backfill:team',
      },
    });
    expect(await bothAgree(project.id, home.id, guest.id)).toBe('READ');
  });
});

describe('unified grants — behaviour that is new, not inherited', () => {
  it('an expired grant is ignored immediately, not at a sweep', async () => {
    const owner = await makeUser(`o-${rnd()}@t.local`);
    const member = await makeUser(`m-${rnd()}@t.local`);
    const team = await makeTeam('Echo');
    const project = await makeProject(team.id, owner.id);
    await prisma.projectAccessGrant.create({
      data: {
        projectId: project.id, subjectType: 'USER', subjectId: member.id,
        level: 'WRITE', expiresAt: new Date(Date.now() - 60_000),
      },
    });
    setFlag('on');
    expect(await resolveProjectAccess(project.id, team.id, member.id, 'MEMBER')).toBe('NONE');
  });

  it('a PENDING grant yields no access (Phase 3 forward-compat)', async () => {
    const owner = await makeUser(`o-${rnd()}@t.local`);
    const member = await makeUser(`m-${rnd()}@t.local`);
    const team = await makeTeam('Foxtrot');
    const project = await makeProject(team.id, owner.id);
    await prisma.projectAccessGrant.create({
      data: {
        projectId: project.id, subjectType: 'USER', subjectId: member.id,
        level: 'WRITE', status: 'PENDING',
      },
    });
    setFlag('on');
    expect(await resolveProjectAccess(project.id, team.id, member.id, 'MEMBER')).toBe('NONE');
  });

  it('an ORG_UNIT grant resolves to NONE until Phase 5', async () => {
    const owner = await makeUser(`o-${rnd()}@t.local`);
    const member = await makeUser(`m-${rnd()}@t.local`);
    const team = await makeTeam('Golf');
    const project = await makeProject(team.id, owner.id);
    await prisma.projectAccessGrant.create({
      data: {
        projectId: project.id, subjectType: 'ORG_UNIT', subjectId: 'ou_anything',
        level: 'WRITE',
      },
    });
    setFlag('on');
    expect(await resolveProjectAccess(project.id, team.id, member.id, 'MEMBER')).toBe('NONE');
  });
});

describe('unified grants — dual mode', () => {
  it('returns the LEGACY answer and records the divergence', async () => {
    const owner = await makeUser(`o-${rnd()}@t.local`);
    const member = await makeUser(`m-${rnd()}@t.local`);
    const team = await makeTeam('Hotel');
    const project = await makeProject(team.id, owner.id);

    // A grant with no legacy counterpart: unified says WRITE, legacy says NONE.
    await prisma.projectAccessGrant.create({
      data: {
        projectId: project.id, subjectType: 'USER', subjectId: member.id, level: 'WRITE',
      },
    });

    setFlag('dual');
    const answer = await resolveProjectAccess(project.id, team.id, member.id, 'MEMBER');

    // Behaviour is bit-identical to `off` — that is the safety property.
    expect(answer).toBe('NONE');

    const events = await prisma.securityAuditEvent.findMany({
      where: { kind: 'access.divergence' },
    });
    expect(events).toHaveLength(1);
    const details = events[0]!.details as Record<string, unknown>;
    expect(details.legacy).toBe('NONE');
    expect(details.unified).toBe('WRITE');
    expect(details.direction).toBe('unified_more_permissive');
  });

  it('records nothing when the two resolvers agree', async () => {
    const owner = await makeUser(`o-${rnd()}@t.local`);
    const team = await makeTeam('India');
    const project = await makeProject(team.id, owner.id);

    setFlag('dual');
    expect(await resolveProjectAccess(project.id, team.id, owner.id, 'MEMBER')).toBe('WRITE');
    expect(await prisma.securityAuditEvent.count({ where: { kind: 'access.divergence' } })).toBe(0);
  });
});

describe('unified grants — tenancy', () => {
  it('a grant never crosses the project teamId check', async () => {
    // The house rule: every feature ships a negative authorization test.
    const owner = await makeUser(`o-${rnd()}@t.local`);
    const attacker = await makeUser(`a-${rnd()}@t.local`);
    const teamA = await makeTeam('Alpha');
    const teamB = await makeTeam('Bravo');
    const project = await makeProject(teamA.id, owner.id);

    await prisma.projectAccessGrant.create({
      data: {
        projectId: project.id, subjectType: 'USER', subjectId: attacker.id, level: 'WRITE',
      },
    });

    setFlag('on');
    // Asking for the project under the WRONG team must fail regardless of the
    // grant — the teamId mismatch short-circuits before any grant is read.
    expect(await resolveProjectAccess(project.id, teamB.id, attacker.id, 'MEMBER')).toBe('NONE');
    // Under the right team the grant does apply, proving the test above failed
    // for the tenancy reason and not because the grant was broken.
    expect(await resolveProjectAccess(project.id, teamA.id, attacker.id, 'MEMBER')).toBe('WRITE');
  });
});
