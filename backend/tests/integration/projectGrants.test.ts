import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv, resetEnvCacheForTests } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { ProjectGrantsService } from '../../src/services/projectGrantsService.js';
import { SubtasksService } from '../../src/services/subtasksService.js';
import { resolveProjectAccess } from '../../src/lib/projectAccess.js';

// v2.8 (Phases 2+3) — unified sharing surface + consent flow.
//
// The architectural rule under test everywhere here: THE LEGACY ROW IS WRITTEN
// WHEN AND ONLY WHEN THE GRANT IS ACTIVE. That single invariant is what makes
// consent behave identically across all three ACCESS_UNIFIED_GRANTS modes and
// keeps dual-mode divergence logs clean.

let app: FastifyInstance;
const rnd = () => Math.random().toString(36).slice(2, 8);

function setFlags(opts: { consent?: boolean; grants?: 'off' | 'dual' | 'on' }): void {
  if (opts.consent !== undefined) process.env.ACCESS_GRANT_CONSENT = String(opts.consent);
  if (opts.grants !== undefined) process.env.ACCESS_UNIFIED_GRANTS = opts.grants;
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
  setFlags({ consent: false, grants: 'off' });
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  setFlags({ consent: false, grants: 'off' });
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.notification.deleteMany();
  await prisma.securityAuditEvent.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.task.deleteMany();
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
  setFlags({ consent: false, grants: 'off' });
});

async function makeUser(tag: string) {
  return prisma.user.create({ data: { email: `${tag}-${rnd()}@t.local`, name: tag } });
}
async function makeTeam(name: string) {
  return prisma.team.create({ data: { name: `${name}-${rnd()}`, slug: `${name.toLowerCase()}-${rnd()}` } });
}
async function joinAsManager(userId: string, teamId: string) {
  // Manager-tier via a role granting project.edit + project.share — the real
  // shape after seed-role-tiers, not the legacy enum.
  const role = await prisma.role.create({
    data: {
      teamId, name: `dm-${rnd()}`,
      permissions: { create: [{ permission: 'project.edit' }, { permission: 'project.share' }] },
    },
  });
  return prisma.teamMembership.create({ data: { userId, teamId, role: 'MANAGER', roleId: role.id } });
}
async function joinAsMember(userId: string, teamId: string) {
  return prisma.teamMembership.create({ data: { userId, teamId, role: 'MEMBER' } });
}

const svc = () => new ProjectGrantsService();

describe('consent flow — TEAM subject (cross-team share)', () => {
  async function fixture() {
    const tech = await makeTeam('Technology');
    const apps = await makeTeam('Applications');
    const techMgr = await makeUser('techMgr');
    const appsMgr = await makeUser('appsMgr');
    await joinAsManager(techMgr.id, tech.id);
    await joinAsManager(appsMgr.id, apps.id);
    const project = await prisma.project.create({
      data: { name: `ERP-${rnd()}`, teamId: tech.id, ownerId: techMgr.id },
    });
    return { tech, apps, techMgr, appsMgr, project };
  }

  it('creates PENDING, notifies the target manager, writes NO legacy row until accepted', async () => {
    setFlags({ consent: true });
    const { tech, apps, techMgr, appsMgr, project } = await fixture();

    const grant = await svc().create(tech.id, project.id, techMgr.id, 'MEMBER', {
      subjectType: 'TEAM', subjectId: apps.id, level: 'WRITE',
    });

    expect(grant.status).toBe('PENDING');
    // The consent gate IS the legacy write gate.
    expect(await prisma.projectTeamShare.count({ where: { projectId: project.id } })).toBe(0);
    // The target team's manager was asked.
    const inbox = await prisma.notification.findMany({ where: { userId: appsMgr.id, type: 'GRANT_PENDING' } });
    expect(inbox).toHaveLength(1);
    // And sees it in their approval queue.
    const pending = await svc().pendingForApprover(appsMgr.id);
    expect(pending.map((p) => p.id)).toContain(grant.id);

    // Accept → ACTIVE + the legacy row appears with the right level.
    const decided = await svc().decide(grant.id, appsMgr.id, 'MEMBER', 'accept');
    expect(decided.status).toBe('ACTIVE');
    const share = await prisma.projectTeamShare.findUnique({
      where: { projectId_teamId: { projectId: project.id, teamId: apps.id } },
    });
    expect(share?.level).toBe('FULL');
    // The grantor hears back.
    expect(
      await prisma.notification.count({ where: { userId: techMgr.id, type: 'GRANT_DECIDED' } }),
    ).toBe(1);
  });

  it('a decline leaves no access in ANY flag mode', async () => {
    setFlags({ consent: true });
    const { tech, apps, techMgr, appsMgr, project } = await fixture();
    const guest = await makeUser('guest');
    await joinAsMember(guest.id, apps.id);

    const grant = await svc().create(tech.id, project.id, techMgr.id, 'MEMBER', {
      subjectType: 'TEAM', subjectId: apps.id, level: 'WRITE',
    });
    await svc().decide(grant.id, appsMgr.id, 'MEMBER', 'decline');

    expect(await prisma.projectTeamShare.count({ where: { projectId: project.id } })).toBe(0);
    for (const mode of ['off', 'dual', 'on'] as const) {
      setFlags({ grants: mode });
      expect(await resolveProjectAccess(project.id, tech.id, guest.id, 'MEMBER')).toBe('NONE');
    }
  });

  it('a random member cannot decide; the target-team manager can', async () => {
    setFlags({ consent: true });
    const { tech, apps, techMgr, project } = await fixture();
    const bystander = await makeUser('bystander');
    await joinAsMember(bystander.id, apps.id);
    const grant = await svc().create(tech.id, project.id, techMgr.id, 'MEMBER', {
      subjectType: 'TEAM', subjectId: apps.id, level: 'READ',
    });
    await expect(
      svc().decide(grant.id, bystander.id, 'MEMBER', 'accept'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('global ADMIN keeps the imposed path — ACTIVE immediately', async () => {
    setFlags({ consent: true });
    const { tech, apps, project } = await fixture();
    const admin = await makeUser('admin');
    const grant = await svc().create(tech.id, project.id, admin.id, 'ADMIN', {
      subjectType: 'TEAM', subjectId: apps.id, level: 'READ',
    });
    expect(grant.status).toBe('ACTIVE');
    expect(await prisma.projectTeamShare.count({ where: { projectId: project.id } })).toBe(1);
  });

  it('with the consent flag OFF every grant is created ACTIVE (the rollback lever)', async () => {
    setFlags({ consent: false });
    const { tech, apps, techMgr, project } = await fixture();
    const grant = await svc().create(tech.id, project.id, techMgr.id, 'MEMBER', {
      subjectType: 'TEAM', subjectId: apps.id, level: 'WRITE',
    });
    expect(grant.status).toBe('ACTIVE');
    expect(await prisma.projectTeamShare.count()).toBe(1);
  });

  it('sharing without project.share is refused; owners may share', async () => {
    setFlags({ consent: true });
    const { tech, apps, project } = await fixture();
    const pleb = await makeUser('pleb');
    await joinAsMember(pleb.id, tech.id);
    await expect(
      svc().create(tech.id, project.id, pleb.id, 'MEMBER', {
        subjectType: 'TEAM', subjectId: apps.id, level: 'READ',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('consent flow — unit participation', () => {
  it('unit grants go to the unit MANAGER; COLLAB grants are ACTIVE immediately', async () => {
    setFlags({ consent: true });
    const tech = await makeTeam('Technology');
    const mgr = await makeUser('mgr');
    await joinAsManager(mgr.id, tech.id);
    const project = await prisma.project.create({
      data: { name: `P-${rnd()}`, teamId: tech.id, ownerId: mgr.id },
    });

    const supervisor = await makeUser('supervisor');
    await joinAsMember(supervisor.id, tech.id);
    const unit = await prisma.userGroup.create({
      data: { teamId: tech.id, name: `Net-${rnd()}`, kind: 'UNIT' },
    });
    await prisma.userGroupMember.create({
      data: { groupId: unit.id, userId: supervisor.id, accessLevel: 'FULL', status: 'ACCEPTED', role: 'MANAGER' },
    });
    const collab = await prisma.userGroup.create({
      data: { teamId: tech.id, name: `C-${rnd()}`, kind: 'COLLAB' },
    });

    // UNIT → PENDING for its manager.
    const unitGrant = await svc().create(tech.id, project.id, mgr.id, 'MEMBER', {
      subjectType: 'GROUP', subjectId: unit.id, level: 'WRITE',
    });
    expect(unitGrant.status).toBe('PENDING');
    expect(await prisma.projectGroupGrant.count()).toBe(0);
    expect((await svc().pendingForApprover(supervisor.id)).map((p) => p.id)).toContain(unitGrant.id);

    // COLLAB → consent lives on membership; grant is immediate.
    const collabGrant = await svc().create(tech.id, project.id, mgr.id, 'MEMBER', {
      subjectType: 'GROUP', subjectId: collab.id, level: 'WRITE',
    });
    expect(collabGrant.status).toBe('ACTIVE');
    expect(await prisma.projectGroupGrant.count({ where: { groupId: collab.id } })).toBe(1);

    // Supervisor accepts → legacy row appears.
    await svc().decide(unitGrant.id, supervisor.id, 'MEMBER', 'accept');
    expect(await prisma.projectGroupGrant.count({ where: { groupId: unit.id } })).toBe(1);
  });

  it('a unit with no manager cannot be asked — surfaced as a config error', async () => {
    setFlags({ consent: true });
    const tech = await makeTeam('Technology');
    const mgr = await makeUser('mgr');
    await joinAsManager(mgr.id, tech.id);
    const project = await prisma.project.create({
      data: { name: `P-${rnd()}`, teamId: tech.id, ownerId: mgr.id },
    });
    const unit = await prisma.userGroup.create({
      data: { teamId: tech.id, name: `U-${rnd()}`, kind: 'UNIT' },
    });
    await expect(
      svc().create(tech.id, project.id, mgr.id, 'MEMBER', {
        subjectType: 'GROUP', subjectId: unit.id, level: 'READ',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('revoke — legacy mirror discipline', () => {
  it('revoking the last grant removes the legacy row; a sibling keeps it at its level', async () => {
    setFlags({ consent: false });
    const tech = await makeTeam('Technology');
    const apps = await makeTeam('Applications');
    const mgr = await makeUser('mgr');
    await joinAsManager(mgr.id, tech.id);
    const project = await prisma.project.create({
      data: { name: `P-${rnd()}`, teamId: tech.id, ownerId: mgr.id },
    });

    const write = await svc().create(tech.id, project.id, mgr.id, 'MEMBER', {
      subjectType: 'TEAM', subjectId: apps.id, level: 'WRITE',
    });
    const read = await svc().create(tech.id, project.id, mgr.id, 'MEMBER', {
      subjectType: 'TEAM', subjectId: apps.id, level: 'READ',
    });

    // Revoke WRITE → the READ sibling downgrades the legacy row, not removes it.
    await svc().revoke(tech.id, project.id, write.id, mgr.id, 'MEMBER');
    const share = await prisma.projectTeamShare.findUnique({
      where: { projectId_teamId: { projectId: project.id, teamId: apps.id } },
    });
    expect(share?.level).toBe('READONLY');

    await svc().revoke(tech.id, project.id, read.id, mgr.id, 'MEMBER');
    expect(await prisma.projectTeamShare.count()).toBe(0);
  });
});

describe('the Phase 3 exit scenario, end to end', () => {
  it('share → accept → unit participates → supervisor assigns → specialist self-serves', async () => {
    setFlags({ consent: true, grants: 'dual' });

    // Technology owns the project; Applications is the guest department.
    const tech = await makeTeam('Technology');
    const apps = await makeTeam('Applications');
    const techMgr = await makeUser('techMgr');
    const appsMgr = await makeUser('appsMgr');
    await joinAsManager(techMgr.id, tech.id);
    await joinAsManager(appsMgr.id, apps.id);
    const project = await prisma.project.create({
      data: { name: `ERP-rollout-${rnd()}`, teamId: tech.id, ownerId: techMgr.id },
    });

    // Applications' ERP unit: a supervisor and a specialist.
    const erpUnit = await prisma.userGroup.create({
      data: { teamId: apps.id, name: `ERP-${rnd()}`, kind: 'UNIT' },
    });
    const supervisor = await makeUser('supervisor');
    const specialist = await makeUser('specialist');
    await joinAsMember(supervisor.id, apps.id);
    await joinAsMember(specialist.id, apps.id);
    await prisma.userGroupMember.create({
      data: { groupId: erpUnit.id, userId: supervisor.id, accessLevel: 'FULL', status: 'ACCEPTED', role: 'MANAGER' },
    });
    await prisma.userGroupMember.create({
      data: { groupId: erpUnit.id, userId: specialist.id, accessLevel: 'FULL', status: 'ACCEPTED', role: 'MEMBER' },
    });

    // 1. Technology's manager shares the project to Applications (request).
    const teamGrant = await svc().create(tech.id, project.id, techMgr.id, 'MEMBER', {
      subjectType: 'TEAM', subjectId: apps.id, level: 'WRITE',
    });
    expect(teamGrant.status).toBe('PENDING');
    // Nobody in Applications has access yet — under the DUAL mode running here.
    expect(await resolveProjectAccess(project.id, tech.id, specialist.id, 'MEMBER')).toBe('NONE');

    // 2. Applications' manager accepts.
    await svc().decide(teamGrant.id, appsMgr.id, 'MEMBER', 'accept');
    // FULL share → every Applications member now has WRITE (legacy semantics,
    // which dual returns — and the unified model agrees, so no divergence).
    expect(await resolveProjectAccess(project.id, tech.id, specialist.id, 'MEMBER')).toBe('WRITE');
    expect(
      await prisma.securityAuditEvent.count({ where: { kind: 'access.divergence' } }),
    ).toBe(0);

    // 3. A task exists; the supervisor assigns their specialist to a subtask.
    const task = await prisma.task.create({
      data: {
        title: `Cutover-${rnd()}`, teamId: tech.id, projectId: project.id,
        creatorId: techMgr.id, status: 'TODO', priority: 'HIGH', position: 1000,
      },
    });
    const subSvc = new SubtasksService();
    const subtask = await subSvc.create(
      tech.id, project.id, task.id, supervisor.id, 'MEMBER',
      { title: 'Data migration dry run', assigneeId: specialist.id },
    );
    expect(subtask.assigneeId).toBe(specialist.id);

    // 4. The specialist self-serves status.
    const updated = await subSvc.update(
      tech.id, project.id, task.id, subtask.id, specialist.id, 'MEMBER',
      { status: 'DONE' },
    );
    expect(updated.status).toBe('DONE');

    // Still zero divergence after the whole flow — the dual-write rule held.
    expect(
      await prisma.securityAuditEvent.count({ where: { kind: 'access.divergence' } }),
    ).toBe(0);
  });
});
