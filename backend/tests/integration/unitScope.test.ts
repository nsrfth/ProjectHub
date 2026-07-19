import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv, resetEnvCacheForTests } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import {
  assertAssignmentAllowed,
  filterCandidatesToAssignerScope,
  isWithinAssignmentScope,
} from '../../src/lib/projectAccess.js';
import { SubtasksService } from '../../src/services/subtasksService.js';
import { UserGroupsService } from '../../src/services/userGroupsService.js';
import { DirectorySyncService } from '../../src/services/directorySyncService.js';
import type { LdapEnumerationResult, LdapService } from '../../src/services/ldapService.js';

// v2.6 (Phase 1) — units, assignment scoping, self-service.
//
// The scope rule in one sentence: with ACCESS_UNIT_SCOPE on, you may assign
// yourself, anyone in your own unit, or — if you hold task.assign_any —
// anyone eligible; a person with NO unit is assignable only by assign_any
// holders (the legible-degradation rule), and an assigner with no unit can
// reach only unitless targets... which resolves to nobody but themselves.

let app: FastifyInstance;
const rnd = () => Math.random().toString(36).slice(2, 8);

function setScope(on: boolean): void {
  process.env.ACCESS_UNIT_SCOPE = on ? 'true' : 'false';
  resetEnvCacheForTests();
}

function fakeLogger() {
  return {
    info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
    trace: () => {}, fatal: () => {}, silent: () => {},
    level: 'silent',
    child: () => fakeLogger(),
  } as unknown as ConstructorParameters<typeof DirectorySyncService>[1];
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  process.env.MASTER_KEY ||=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  setScope(false);
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  setScope(false);
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.securityAuditEvent.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.task.deleteMany();
  await prisma.projectAccessGrant.deleteMany();
  await prisma.projectGroupGrant.deleteMany();
  await prisma.projectTeamShare.deleteMany();
  await prisma.directoryGroupMapping.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.project.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.directory.deleteMany();
  setScope(false);
});

async function makeUser(tag: string) {
  return prisma.user.create({ data: { email: `${tag}-${rnd()}@t.local`, name: tag } });
}
async function makeTeam(name: string) {
  return prisma.team.create({ data: { name, slug: `${name.toLowerCase()}-${rnd()}` } });
}
async function joinTeam(userId: string, teamId: string, role: 'MANAGER' | 'MEMBER' = 'MEMBER') {
  return prisma.teamMembership.create({ data: { userId, teamId, role } });
}
async function makeUnit(teamId: string, name: string) {
  return prisma.userGroup.create({ data: { teamId, name: `${name}-${rnd()}`, kind: 'UNIT' } });
}
async function placeInUnit(groupId: string, userId: string, role: 'MANAGER' | 'MEMBER' = 'MEMBER') {
  return prisma.userGroupMember.create({
    data: { groupId, userId, accessLevel: 'FULL', status: 'ACCEPTED', role },
  });
}
/** Grant task.assign_any via a custom role, the way a real installation would. */
async function grantAssignAny(teamId: string, userId: string) {
  const role = await prisma.role.create({
    data: {
      teamId,
      name: `mgr-${rnd()}`,
      permissions: { create: [{ permission: 'task.assign_any' }] },
    },
  });
  await prisma.teamMembership.update({
    where: { userId_teamId: { userId, teamId } },
    data: { roleId: role.id },
  });
}

describe('unit scoping — the allow/deny matrix', () => {
  it('is fully permissive while the flag is off', async () => {
    const team = await makeTeam('Tech');
    const a = await makeUser('a');
    const b = await makeUser('b');
    await joinTeam(a.id, team.id);
    await joinTeam(b.id, team.id);
    expect(await isWithinAssignmentScope(team.id, a.id, b.id, 'MEMBER')).toBe(true);
  });

  it('same unit allows; different unit denies; assign_any overrides', async () => {
    setScope(true);
    const team = await makeTeam('Tech');
    const network = await makeUnit(team.id, 'Network');
    const security = await makeUnit(team.id, 'Security');
    const sup = await makeUser('sup');
    const peer = await makeUser('peer');
    const outsider = await makeUser('outsider');
    const mgr = await makeUser('mgr');
    for (const u of [sup, peer, outsider, mgr]) await joinTeam(u.id, team.id);
    await placeInUnit(network.id, sup.id, 'MANAGER');
    await placeInUnit(network.id, peer.id);
    await placeInUnit(security.id, outsider.id);
    await grantAssignAny(team.id, mgr.id);

    // Same unit — allowed.
    expect(await isWithinAssignmentScope(team.id, sup.id, peer.id, 'MEMBER')).toBe(true);
    // Cross-unit — denied.
    expect(await isWithinAssignmentScope(team.id, sup.id, outsider.id, 'MEMBER')).toBe(false);
    // Self — always allowed.
    expect(await isWithinAssignmentScope(team.id, outsider.id, outsider.id, 'MEMBER')).toBe(true);
    // assign_any holder — anyone.
    expect(await isWithinAssignmentScope(team.id, mgr.id, outsider.id, 'MEMBER')).toBe(true);
    // ADMIN — anyone.
    expect(await isWithinAssignmentScope(team.id, sup.id, outsider.id, 'ADMIN')).toBe(true);
  });

  it('a unitless target is assignable ONLY by assign_any holders (legible degradation)', async () => {
    setScope(true);
    const team = await makeTeam('Tech');
    const network = await makeUnit(team.id, 'Network');
    const sup = await makeUser('sup');
    const drifter = await makeUser('drifter'); // no unit — never synced
    const mgr = await makeUser('mgr');
    for (const u of [sup, drifter, mgr]) await joinTeam(u.id, team.id);
    await placeInUnit(network.id, sup.id, 'MANAGER');
    await grantAssignAny(team.id, mgr.id);

    expect(await isWithinAssignmentScope(team.id, sup.id, drifter.id, 'MEMBER')).toBe(false);
    expect(await isWithinAssignmentScope(team.id, mgr.id, drifter.id, 'MEMBER')).toBe(true);
  });

  it('assertAssignmentAllowed surfaces ASSIGNEE_OUT_OF_SCOPE with its own code', async () => {
    setScope(true);
    const team = await makeTeam('Tech');
    const owner = await makeUser('owner');
    const network = await makeUnit(team.id, 'Network');
    const security = await makeUnit(team.id, 'Security');
    const sup = await makeUser('sup');
    const outsider = await makeUser('outsider');
    for (const u of [owner, sup, outsider]) await joinTeam(u.id, team.id);
    await placeInUnit(network.id, sup.id);
    await placeInUnit(security.id, outsider.id);
    const project = await prisma.project.create({
      data: { name: `p-${rnd()}`, teamId: team.id, ownerId: owner.id },
    });

    await expect(
      assertAssignmentAllowed({
        teamId: team.id,
        projectId: project.id,
        actorId: sup.id,
        actorGlobalRole: 'MEMBER',
        targetId: outsider.id,
        role: 'assignee',
      }),
    ).rejects.toMatchObject({ code: 'ASSIGNEE_OUT_OF_SCOPE', statusCode: 403 });

    // Clearing is never blocked.
    await expect(
      assertAssignmentAllowed({
        teamId: team.id,
        projectId: project.id,
        actorId: sup.id,
        actorGlobalRole: 'MEMBER',
        targetId: null,
        role: 'assignee',
      }),
    ).resolves.toBeUndefined();
  });

  it('the candidates filter agrees with the write-path rule', async () => {
    setScope(true);
    const team = await makeTeam('Tech');
    const network = await makeUnit(team.id, 'Network');
    const security = await makeUnit(team.id, 'Security');
    const sup = await makeUser('sup');
    const peer = await makeUser('peer');
    const outsider = await makeUser('outsider');
    const drifter = await makeUser('drifter');
    for (const u of [sup, peer, outsider, drifter]) await joinTeam(u.id, team.id);
    await placeInUnit(network.id, sup.id);
    await placeInUnit(network.id, peer.id);
    await placeInUnit(security.id, outsider.id);

    const candidates = [sup, peer, outsider, drifter].map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
    }));
    const filtered = await filterCandidatesToAssignerScope(team.id, sup.id, 'MEMBER', candidates);
    expect(filtered.map((c) => c.userId).sort()).toEqual([sup.id, peer.id].sort());
  });
});

describe('eligibility loosening — group-grant members are now assignable', () => {
  it('an ACCEPTED group-grant member passes the shared guard as subtask assignee', async () => {
    // The old assertAssigneeInTeam (bare team membership) rejected exactly
    // this person despite their legitimate WRITE via the group grant.
    const home = await makeTeam('Home');
    const owner = await makeUser('owner');
    await joinTeam(owner.id, home.id, 'MANAGER');
    const guest = await makeUser('guest'); // NOT a team member
    const project = await prisma.project.create({
      data: { name: `p-${rnd()}`, teamId: home.id, ownerId: owner.id },
    });
    const group = await prisma.userGroup.create({
      data: { teamId: home.id, name: `g-${rnd()}` },
    });
    await prisma.userGroupMember.create({
      data: { groupId: group.id, userId: guest.id, accessLevel: 'FULL', status: 'ACCEPTED', external: true },
    });
    await prisma.projectGroupGrant.create({
      data: { projectId: project.id, groupId: group.id },
    });

    await expect(
      assertAssignmentAllowed({
        teamId: home.id,
        projectId: project.id,
        actorId: owner.id,
        actorGlobalRole: 'MEMBER',
        targetId: guest.id,
        role: 'assignee',
      }),
    ).resolves.toBeUndefined();

    // A total stranger still fails eligibility (BAD_REQUEST, not scope).
    const stranger = await makeUser('stranger');
    await expect(
      assertAssignmentAllowed({
        teamId: home.id,
        projectId: project.id,
        actorId: owner.id,
        actorGlobalRole: 'MEMBER',
        targetId: stranger.id,
        role: 'assignee',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('subtask self-service — both gating paths', () => {
  async function fixture() {
    const team = await makeTeam('Tech');
    const owner = await makeUser('owner');
    const specialist = await makeUser('spec');
    await joinTeam(owner.id, team.id, 'MANAGER');
    await joinTeam(specialist.id, team.id);
    const project = await prisma.project.create({
      data: { name: `p-${rnd()}`, teamId: team.id, ownerId: owner.id },
    });
    // Give the specialist READ so they can reach the subtask at all — a
    // READONLY group grant, the realistic shape for a unit member on a
    // project their unit participates in.
    const group = await prisma.userGroup.create({ data: { teamId: team.id, name: `g-${rnd()}` } });
    await prisma.userGroupMember.create({
      data: { groupId: group.id, userId: specialist.id, accessLevel: 'READONLY', status: 'ACCEPTED' },
    });
    await prisma.projectGroupGrant.create({ data: { projectId: project.id, groupId: group.id } });
    const task = await prisma.task.create({
      data: {
        title: `t-${rnd()}`, teamId: team.id, projectId: project.id,
        creatorId: owner.id, status: 'TODO', priority: 'MEDIUM', position: 1000,
      },
    });
    const subtask = await prisma.subtask.create({
      data: {
        taskId: task.id, title: `s-${rnd()}`, position: 1000,
        responsibleId: owner.id, assigneeId: specialist.id,
      },
    });
    return { team, owner, specialist, project, task, subtask };
  }

  it('the assignee can set status via the full PATCH path without WRITE', async () => {
    const { team, specialist, project, task, subtask } = await fixture();
    const svc = new SubtasksService();
    const updated = await svc.update(
      team.id, project.id, task.id, subtask.id,
      specialist.id, 'MEMBER',
      { status: 'IN_PROGRESS' },
    );
    expect(updated.status).toBe('IN_PROGRESS');
  });

  it('self-service does NOT extend past status/done — title still 403s', async () => {
    const { team, specialist, project, task, subtask } = await fixture();
    const svc = new SubtasksService();
    await expect(
      svc.update(
        team.id, project.id, task.id, subtask.id,
        specialist.id, 'MEMBER',
        { status: 'DONE', title: 'renamed by specialist' },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('a non-assignee with READ still cannot self-serve', async () => {
    const { team, project, task, subtask } = await fixture();
    const bystander = await makeUser('bystander');
    await joinTeam(bystander.id, team.id);
    // READ via the same group as the specialist.
    const grant = await prisma.projectGroupGrant.findFirst({
      where: { projectId: project.id }, select: { groupId: true },
    });
    await prisma.userGroupMember.create({
      data: { groupId: grant!.groupId, userId: bystander.id, accessLevel: 'READONLY', status: 'ACCEPTED' },
    });
    const svc = new SubtasksService();
    await expect(
      svc.update(
        team.id, project.id, task.id, subtask.id,
        bystander.id, 'MEMBER',
        { status: 'DONE' },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('the focused setStatus path agrees (same allowance set)', async () => {
    const { team, specialist, project, task, subtask } = await fixture();
    const svc = new SubtasksService();
    const updated = await svc.setStatus(
      team.id, project.id, task.id, subtask.id, specialist.id, 'MEMBER', 'DONE',
    );
    expect(updated.status).toBe('DONE');
    expect(updated.done).toBe(true);
  });
});

describe('units — service semantics and the one-unit rule', () => {
  it('unit membership is direct, FULL-pinned, and single per team', async () => {
    const team = await makeTeam('Tech');
    const admin = await makeUser('admin');
    const person = await makeUser('person');
    await joinTeam(admin.id, team.id, 'MANAGER');
    await joinTeam(person.id, team.id);
    const svc = new UserGroupsService();

    const unitA = await svc.create(team.id, admin.id, { name: `Net-${rnd()}`, kind: 'UNIT' });
    const unitB = await svc.create(team.id, admin.id, { name: `Sec-${rnd()}`, kind: 'UNIT' });

    // READONLY is silently pinned to FULL on a unit.
    const detail = await svc.addMember(team.id, unitA.id, admin.id, person.id, 'READONLY', 'MANAGER');
    const m = detail.members.find((x) => x.userId === person.id)!;
    expect(m.accessLevel).toBe('FULL');
    expect(m.status).toBe('ACCEPTED');
    expect(m.role).toBe('MANAGER');

    // Second unit in the same team → friendly 409, not a raw P2002.
    await expect(
      svc.addMember(team.id, unitB.id, admin.id, person.id, 'FULL'),
    ).rejects.toMatchObject({ statusCode: 409 });

    // A COLLAB group in the same team is still fine (the index is partial).
    const collab = await svc.create(team.id, admin.id, { name: `C-${rnd()}` });
    await expect(
      svc.addMember(team.id, collab.id, admin.id, person.id, 'FULL'),
    ).resolves.toBeDefined();
  });

  it('a unit refuses non-team members and access-level changes', async () => {
    const team = await makeTeam('Tech');
    const admin = await makeUser('admin');
    const stranger = await makeUser('stranger');
    await joinTeam(admin.id, team.id, 'MANAGER');
    const svc = new UserGroupsService();
    const unit = await svc.create(team.id, admin.id, { name: `U-${rnd()}`, kind: 'UNIT' });

    await expect(
      svc.addMember(team.id, unit.id, admin.id, stranger.id, 'FULL'),
    ).rejects.toMatchObject({ statusCode: 400 });

    const person = await makeUser('person');
    await joinTeam(person.id, team.id);
    await svc.addMember(team.id, unit.id, admin.id, person.id, 'FULL');
    await expect(
      svc.updateMemberAccess(team.id, unit.id, person.id, admin.id, 'READONLY'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('directory sync — the unit pass', () => {
  function ldapWith(users: { dn: string; email: string; groups: string[] }[]): LdapService {
    return {
      async enumerateUsers(): Promise<LdapEnumerationResult> {
        return {
          truncated: false,
          users: users.map((u) => ({
            dn: u.dn, email: u.email, displayName: u.email,
            ldapUsername: null, userPrincipalName: null,
            department: null, jobTitle: null, managerName: null,
            groups: u.groups,
          })),
        };
      },
      async fetchGroupMembers(): Promise<string[]> { return []; },
    } as unknown as LdapService;
  }
  const RUN = { pageSize: 500, maxUsers: 10000, timeoutSec: 300, revokeGlobalRole: false, dryRun: false };

  async function syncFixture() {
    const dir = await prisma.directory.create({
      data: {
        name: 'AD', slug: `ad-${rnd()}`, kind: 'LDAP', host: 'x', port: 389,
        useTLS: false, syncEnabled: true, syncTrustMemberOf: true,
      },
    });
    const team = await makeTeam('Tech');
    const unit = await makeUnit(team.id, 'Network');
    return { dir, team, unit };
  }

  it('places a mapped user into the unit, and moves them when the group changes', async () => {
    const { dir, team, unit } = await syncFixture();
    const groupDn = 'CN=Net,OU=G,DC=t,DC=l';
    await prisma.directoryGroupMapping.create({
      data: {
        directoryId: dir.id, externalGroupDn: groupDn,
        teamId: team.id, teamRole: 'MEMBER', userGroupId: unit.id,
      },
    });

    const svc = new DirectorySyncService(
      ldapWith([{ dn: 'CN=A,OU=P,DC=t,DC=l', email: 'a@t.local', groups: [groupDn] }]),
      fakeLogger(),
    );
    const res = (await svc.run(RUN)).directories[0]!;
    expect(res.status).toBe('OK');
    expect(res.unitsAssigned).toBe(1);

    const user = await prisma.user.findUnique({ where: { email: 'a@t.local' } });
    const membership = await prisma.userGroupMember.findUnique({
      where: { groupId_userId: { groupId: unit.id, userId: user!.id } },
    });
    expect(membership).not.toBeNull();
    expect(membership!.accessLevel).toBe('FULL');
    expect(membership!.status).toBe('ACCEPTED');
    // Trigger stamped the denorm columns.
    expect(membership!.teamId).toBe(team.id);
    expect(membership!.isUnit).toBe(true);

    // Move: user now matches a mapping for a DIFFERENT unit. Remove-then-add
    // inside one transaction must survive the one-unit index.
    const unit2 = await makeUnit(team.id, 'Security');
    const groupDn2 = 'CN=Sec,OU=G,DC=t,DC=l';
    await prisma.directoryGroupMapping.create({
      data: {
        directoryId: dir.id, externalGroupDn: groupDn2,
        teamId: team.id, teamRole: 'MEMBER', userGroupId: unit2.id,
      },
    });
    const svc2 = new DirectorySyncService(
      ldapWith([{ dn: 'CN=A,OU=P,DC=t,DC=l', email: 'a@t.local', groups: [groupDn2] }]),
      fakeLogger(),
    );
    const res2 = (await svc2.run(RUN)).directories[0]!;
    expect(res2.status).toBe('OK');
    expect(res2.unitsAssigned).toBe(1);
    expect(res2.unitsRemoved).toBe(1);
    const after = await prisma.userGroupMember.findMany({
      where: { userId: user!.id, isUnit: true },
    });
    expect(after).toHaveLength(1);
    expect(after[0]!.groupId).toBe(unit2.id);
  });

  it('two mapped units in one team → UNIT_CONFLICT, neither applied', async () => {
    const { dir, team, unit } = await syncFixture();
    const unit2 = await makeUnit(team.id, 'Security');
    const g1 = 'CN=Net,OU=G,DC=t,DC=l';
    const g2 = 'CN=Sec,OU=G,DC=t,DC=l';
    await prisma.directoryGroupMapping.createMany({
      data: [
        { directoryId: dir.id, externalGroupDn: g1, teamId: team.id, teamRole: 'MEMBER', userGroupId: unit.id },
        { directoryId: dir.id, externalGroupDn: g2, teamId: team.id, teamRole: 'MEMBER', userGroupId: unit2.id },
      ],
    });
    const svc = new DirectorySyncService(
      ldapWith([{ dn: 'CN=B,OU=P,DC=t,DC=l', email: 'b@t.local', groups: [g1, g2] }]),
      fakeLogger(),
    );
    const res = (await svc.run(RUN)).directories[0]!;
    expect(res.conflicts.map((c) => c.code)).toContain('UNIT_CONFLICT');
    expect(res.unitsAssigned).toBe(0);
    const user = await prisma.user.findUnique({ where: { email: 'b@t.local' } });
    // Team membership still applied — only the unit placement is withheld.
    expect(await prisma.teamMembership.count({ where: { userId: user!.id } })).toBe(1);
    expect(await prisma.userGroupMember.count({ where: { userId: user!.id } })).toBe(0);
  });

  it('never overrides a manually-placed unit membership', async () => {
    const { dir, team, unit } = await syncFixture();
    const manual = await makeUnit(team.id, 'HandPicked');
    const groupDn = 'CN=Net,OU=G,DC=t,DC=l';
    await prisma.directoryGroupMapping.create({
      data: {
        directoryId: dir.id, externalGroupDn: groupDn,
        teamId: team.id, teamRole: 'MEMBER', userGroupId: unit.id,
      },
    });
    // The person already sits in an UNMAPPED unit, placed by an admin.
    const person = await prisma.user.create({
      data: {
        email: 'c@t.local', name: 'C', directoryId: dir.id,
        externalId: 'CN=C,OU=P,DC=t,DC=l', authSource: 'LDAP',
      },
    });
    await joinTeam(person.id, team.id);
    await placeInUnit(manual.id, person.id);

    const svc = new DirectorySyncService(
      ldapWith([{ dn: 'CN=C,OU=P,DC=t,DC=l', email: 'c@t.local', groups: [groupDn] }]),
      fakeLogger(),
    );
    const res = (await svc.run(RUN)).directories[0]!;
    expect(res.status).toBe('OK');
    expect(res.conflicts.map((c) => c.code)).toContain('UNIT_CONFLICT');
    // Still exactly where the admin put them.
    const units = await prisma.userGroupMember.findMany({
      where: { userId: person.id, isUnit: true },
    });
    expect(units).toHaveLength(1);
    expect(units[0]!.groupId).toBe(manual.id);
  });
});
