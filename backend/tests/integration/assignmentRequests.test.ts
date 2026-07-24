import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv, resetEnvCacheForTests } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { classifyAssignmentBoundary } from '../../src/lib/assignmentBoundary.js';
import { assertAssignmentAllowed, isUserEligibleTaskResponsible } from '../../src/lib/projectAccess.js';
import { reconcileAssignmentGrantForUsers } from '../../src/lib/projectGrants.js';
import { AssignmentRequestsService } from '../../src/services/assignmentRequestsService.js';

// v-next — cross-unit task assignment workflow (Slices 2–7). Service-level, in
// the unitScope.test.ts style. The flags are toggled per test via the env-cache
// reset; my code reads loadEnv() at call time, so the app built in beforeAll
// need not be rebuilt.

let app: FastifyInstance;
const rnd = () => Math.random().toString(36).slice(2, 8);
const svc = new AssignmentRequestsService();

function setEnv(opts: { workflow?: boolean; unified?: 'off' | 'dual' | 'on' }): void {
  if (opts.workflow !== undefined) process.env.TASK_ASSIGNMENT_WORKFLOW = opts.workflow ? 'true' : 'false';
  if (opts.unified !== undefined) process.env.ACCESS_UNIFIED_GRANTS = opts.unified;
  resetEnvCacheForTests();
}
/** The steady state under which the workflow is actually live (constraint C-A). */
const workflowLive = () => setEnv({ workflow: true, unified: 'on' });

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  process.env.MASTER_KEY ||= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  setEnv({ workflow: false, unified: 'off' });
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  setEnv({ workflow: false, unified: 'off' });
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.notification.deleteMany();
  await prisma.taskAssignmentRequest.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.task.deleteMany();
  await prisma.projectAccessGrant.deleteMany();
  await prisma.projectGroupGrant.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.project.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  setEnv({ workflow: false, unified: 'off' });
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
async function makeProject(teamId: string, ownerId: string) {
  return prisma.project.create({ data: { name: `p-${rnd()}`, teamId, ownerId } });
}
async function makeTask(teamId: string, projectId: string, creatorId: string) {
  return prisma.task.create({
    data: { title: `t-${rnd()}`, teamId, projectId, creatorId, status: 'TODO', priority: 'MEDIUM', position: 1000 },
  });
}

// ---------------------------------------------------------------------------

describe('boundary classifier (A/B/C)', () => {
  it('same department → A (direct)', async () => {
    const div = await makeTeam('Div');
    const dept = await makeUnit(div.id, 'Net');
    const req = await makeUser('req');
    const target = await makeUser('tgt');
    for (const u of [req, target]) await joinTeam(u.id, div.id);
    await placeInUnit(dept.id, req.id);
    await placeInUnit(dept.id, target.id);
    const b = await classifyAssignmentBoundary({ projectTeamId: div.id, requesterUserId: req.id, targetUserId: target.id });
    expect(b.scenario).toBe('A');
  });

  it('cross-department, same division → B with the target department', async () => {
    const div = await makeTeam('Div');
    const net = await makeUnit(div.id, 'Net');
    const sec = await makeUnit(div.id, 'Sec');
    const req = await makeUser('req');
    const target = await makeUser('tgt');
    for (const u of [req, target]) await joinTeam(u.id, div.id);
    await placeInUnit(net.id, req.id);
    await placeInUnit(sec.id, target.id);
    const b = await classifyAssignmentBoundary({ projectTeamId: div.id, requesterUserId: req.id, targetUserId: target.id });
    expect(b).toEqual({ scenario: 'B', targetGroupId: sec.id });
  });

  it('cross-division → C with the target home division', async () => {
    const divA = await makeTeam('A');
    const divB = await makeTeam('B');
    const req = await makeUser('req');
    const target = await makeUser('tgt');
    await joinTeam(req.id, divA.id);
    await joinTeam(target.id, divB.id);
    const deptB = await makeUnit(divB.id, 'NetB');
    await placeInUnit(deptB.id, target.id);
    const b = await classifyAssignmentBoundary({ projectTeamId: divA.id, requesterUserId: req.id, targetUserId: target.id });
    expect(b).toEqual({ scenario: 'C', targetTeamId: divB.id });
  });

  it('division-general staff (in the project division, no department) → A', async () => {
    const div = await makeTeam('Div');
    const dept = await makeUnit(div.id, 'Net');
    const req = await makeUser('req');
    const general = await makeUser('gen');
    for (const u of [req, general]) await joinTeam(u.id, div.id);
    await placeInUnit(dept.id, req.id); // requester has a dept; target has none
    const b = await classifyAssignmentBoundary({ projectTeamId: div.id, requesterUserId: req.id, targetUserId: general.id });
    expect(b.scenario).toBe('A');
  });
});

describe('guard reorder — assertAssignmentAllowed (opt-in, flag-gated)', () => {
  async function crossDeptFixture() {
    const div = await makeTeam('Div');
    const net = await makeUnit(div.id, 'Net');
    const sec = await makeUnit(div.id, 'Sec');
    const owner = await makeUser('owner');
    const req = await makeUser('req');
    const target = await makeUser('tgt');
    for (const u of [owner, req, target]) await joinTeam(u.id, div.id);
    await placeInUnit(net.id, req.id);
    await placeInUnit(sec.id, target.id);
    const project = await makeProject(div.id, owner.id);
    return { div, project, req, target };
  }

  it('flag on + enforce + cross-boundary → ASSIGNMENT_REQUEST_REQUIRED (403)', async () => {
    const { div, project, req, target } = await crossDeptFixture();
    workflowLive();
    await expect(
      assertAssignmentAllowed({
        teamId: div.id, projectId: project.id, actorId: req.id, actorGlobalRole: 'MEMBER',
        targetId: target.id, role: 'assignee', enforceBoundaryWorkflow: true,
      }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_REQUEST_REQUIRED', statusCode: 403 });
  });

  it('flag OFF → same call resolves (no workflow error): opt-in is inert', async () => {
    const { div, project, req, target } = await crossDeptFixture();
    setEnv({ workflow: false, unified: 'on' }); // target is a division member → eligible; scope flag off
    await expect(
      assertAssignmentAllowed({
        teamId: div.id, projectId: project.id, actorId: req.id, actorGlobalRole: 'MEMBER',
        targetId: target.id, role: 'assignee', enforceBoundaryWorkflow: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('flag on but role=responsible (no enforce) → resolves, not the workflow error', async () => {
    // The reorder is opt-in on the Task-assignee sites only. The responsible
    // path never passes enforceBoundaryWorkflow, so it keeps today's ordering:
    // the target is a division member (eligible) and unit-scope is off → passes.
    const { div, project, req, target } = await crossDeptFixture();
    workflowLive();
    await expect(
      assertAssignmentAllowed({
        teamId: div.id, projectId: project.id, actorId: req.id, actorGlobalRole: 'MEMBER',
        targetId: target.id, role: 'responsible', // enforceBoundaryWorkflow omitted
      }),
    ).resolves.toBeUndefined();
  });

  it('ADMIN bypasses the boundary workflow (D1 override lane)', async () => {
    const { div, project, req, target } = await crossDeptFixture();
    workflowLive();
    await expect(
      assertAssignmentAllowed({
        teamId: div.id, projectId: project.id, actorId: req.id, actorGlobalRole: 'ADMIN',
        targetId: target.id, role: 'assignee', enforceBoundaryWorkflow: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('eligibility extension (Slice 3, B1) — unified USER grant', () => {
  async function grantFixture() {
    const div = await makeTeam('Div');
    const owner = await makeUser('owner');
    await joinTeam(owner.id, div.id, 'MANAGER');
    const outsider = await makeUser('out'); // NOT a member of div
    const project = await makeProject(div.id, owner.id);
    await prisma.projectAccessGrant.create({
      data: { projectId: project.id, subjectType: 'USER', subjectId: outsider.id, level: 'WRITE', status: 'ACTIVE', source: 'assignment:x' },
    });
    return { div, project, outsider };
  }

  it('eligible when ACCESS_UNIFIED_GRANTS=on', async () => {
    const { div, project, outsider } = await grantFixture();
    setEnv({ unified: 'on' });
    expect(await isUserEligibleTaskResponsible(div.id, project.id, outsider.id)).toBe(true);
  });

  it('NOT eligible under off/dual (the grant table is not authoritative yet)', async () => {
    const { div, project, outsider } = await grantFixture();
    setEnv({ unified: 'dual' });
    expect(await isUserEligibleTaskResponsible(div.id, project.id, outsider.id)).toBe(false);
  });
});

describe('request lifecycle — scenario B (cross-department)', () => {
  async function fixture() {
    const div = await makeTeam('Div');
    const net = await makeUnit(div.id, 'Net');
    const sec = await makeUnit(div.id, 'Sec');
    const owner = await makeUser('owner');
    const requester = await makeUser('requester');
    const secMgr = await makeUser('secMgr');
    const secMember = await makeUser('secMember');
    for (const u of [owner, requester, secMgr, secMember]) await joinTeam(u.id, div.id);
    await placeInUnit(net.id, requester.id);
    await placeInUnit(sec.id, secMgr.id, 'MANAGER');
    await placeInUnit(sec.id, secMember.id);
    const project = await makeProject(div.id, owner.id);
    const task = await makeTask(div.id, project.id, owner.id);
    return { div, project, task, requester, secMgr, secMember, sec };
  }

  it('create → REQUESTED, GROUP target = the dept, notifies the dept manager', async () => {
    workflowLive();
    const { div, project, task, requester, secMgr, secMember, sec } = await fixture();
    const req = await svc.create(div.id, project.id, task.id, requester.id, { proposedId: secMember.id });
    expect(req.status).toBe('REQUESTED');
    expect(req.targetType).toBe('GROUP');
    expect(req.targetId).toBe(sec.id);
    const note = await prisma.notification.findFirst({ where: { userId: secMgr.id, type: 'ASSIGNMENT_REQUESTED' } });
    expect(note).not.toBeNull();
  });

  it('create for a same-department person → 400 (assignable directly)', async () => {
    workflowLive();
    const div = await makeTeam('Div');
    const dept = await makeUnit(div.id, 'Net');
    const owner = await makeUser('owner');
    const requester = await makeUser('requester');
    const peer = await makeUser('peer');
    for (const u of [owner, requester, peer]) await joinTeam(u.id, div.id);
    await placeInUnit(dept.id, requester.id);
    await placeInUnit(dept.id, peer.id);
    const project = await makeProject(div.id, owner.id);
    const task = await makeTask(div.id, project.id, owner.id);
    await expect(svc.create(div.id, project.id, task.id, requester.id, { proposedId: peer.id }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('create when the target dept has no manager → 400 (designate one first)', async () => {
    workflowLive();
    const div = await makeTeam('Div');
    const net = await makeUnit(div.id, 'Net');
    const sec = await makeUnit(div.id, 'Sec'); // no manager placed
    const owner = await makeUser('owner');
    const requester = await makeUser('requester');
    const secMember = await makeUser('secMember');
    for (const u of [owner, requester, secMember]) await joinTeam(u.id, div.id);
    await placeInUnit(net.id, requester.id);
    await placeInUnit(sec.id, secMember.id); // MEMBER only, no MANAGER
    const project = await makeProject(div.id, owner.id);
    const task = await makeTask(div.id, project.id, owner.id);
    await expect(svc.create(div.id, project.id, task.id, requester.id, { proposedId: secMember.id }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('approve by the dept manager works; a stranger gets 404 (existence not leaked)', async () => {
    workflowLive();
    const { div, project, task, requester, secMgr, secMember } = await fixture();
    const req = await svc.create(div.id, project.id, task.id, requester.id, { proposedId: secMember.id });
    const stranger = await makeUser('stranger');
    await joinTeam(stranger.id, div.id);
    await expect(svc.approve(req.id, stranger.id)).rejects.toMatchObject({ statusCode: 404 });
    const approved = await svc.approve(req.id, secMgr.id);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approverId).toBe(secMgr.id);
  });

  it('assign sets the task assignee and auto-issues the project WRITE grant', async () => {
    workflowLive();
    const { div, project, task, requester, secMgr, secMember } = await fixture();
    const req = await svc.create(div.id, project.id, task.id, requester.id, { proposedId: secMember.id });
    const assigned = await svc.assign(req.id, secMgr.id, secMember.id);
    expect(assigned.status).toBe('ASSIGNED');
    expect(assigned.assigneeId).toBe(secMember.id);
    const t = await prisma.task.findUnique({ where: { id: task.id } });
    expect(t?.assigneeId).toBe(secMember.id);
    const grant = await prisma.projectAccessGrant.findFirst({
      where: { projectId: project.id, subjectType: 'USER', subjectId: secMember.id },
    });
    expect(grant?.level).toBe('WRITE');
    expect(grant?.source).toBe(`assignment:${req.id}`);
  });

  it('assign refuses an assignee outside the approving department', async () => {
    workflowLive();
    const { div, project, task, requester, secMgr, secMember } = await fixture();
    const req = await svc.create(div.id, project.id, task.id, requester.id, { proposedId: secMember.id });
    const notInSec = await makeUser('nope');
    await joinTeam(notInSec.id, div.id); // in the division, but not the sec dept
    await expect(svc.assign(req.id, secMgr.id, notInSec.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('decline requires a reason and lands DECLINED', async () => {
    workflowLive();
    const { div, project, task, requester, secMgr, secMember } = await fixture();
    const req = await svc.create(div.id, project.id, task.id, requester.id, { proposedId: secMember.id });
    await expect(svc.decline(req.id, secMgr.id, '   ')).rejects.toMatchObject({ statusCode: 400 });
    const declined = await svc.decline(req.id, secMgr.id, 'not available');
    expect(declined.status).toBe('DECLINED');
    expect(declined.declineReason).toBe('not available');
  });

  it('the inbox returns enriched rows to the approver, nothing to a stranger', async () => {
    workflowLive();
    const { div, project, task, requester, secMgr, secMember } = await fixture();
    const req = await svc.create(div.id, project.id, task.id, requester.id, { proposedId: secMember.id });
    const inbox = await svc.listMyApprovals(secMgr.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.id).toBe(req.id);
    expect(inbox[0]!.taskTitle).toBe(task.title);
    expect(inbox[0]!.projectName).toBe(project.name);
    expect(inbox[0]!.requesterName).toBe(requester.name);
    expect(inbox[0]!.proposedName).toBe(secMember.name);
    const stranger = await makeUser('stranger2');
    await joinTeam(stranger.id, div.id);
    expect(await svc.listMyApprovals(stranger.id)).toHaveLength(0);
  });
});

describe('request lifecycle — scenario C (cross-division, deputy → forward → assign)', () => {
  it('routes to the deputy, forwards to a dept manager, then assigns', async () => {
    workflowLive();
    const divA = await makeTeam('A');
    const divB = await makeTeam('B');
    const owner = await makeUser('owner');
    const requester = await makeUser('requester');
    const deputyB = await makeUser('deputyB');
    const deptMgrB = await makeUser('deptMgrB');
    const workerB = await makeUser('workerB');
    await joinTeam(owner.id, divA.id, 'MANAGER');
    await joinTeam(requester.id, divA.id);
    await joinTeam(deputyB.id, divB.id, 'MANAGER'); // division deputy
    await joinTeam(deptMgrB.id, divB.id);
    await joinTeam(workerB.id, divB.id);
    const deptB = await makeUnit(divB.id, 'NetB');
    await placeInUnit(deptB.id, deptMgrB.id, 'MANAGER');
    await placeInUnit(deptB.id, workerB.id);
    const project = await makeProject(divA.id, owner.id);
    const task = await makeTask(divA.id, project.id, owner.id);

    const req = await svc.create(divA.id, project.id, task.id, requester.id, { proposedId: workerB.id });
    expect(req.targetType).toBe('TEAM');
    expect(req.targetId).toBe(divB.id);
    const note = await prisma.notification.findFirst({ where: { userId: deputyB.id, type: 'ASSIGNMENT_REQUESTED' } });
    expect(note).not.toBeNull();

    const fwd = await svc.forward(req.id, deputyB.id, deptMgrB.id);
    expect(fwd.status).toBe('FORWARDED');
    expect(fwd.forwardedToId).toBe(deptMgrB.id);

    const assigned = await svc.assign(req.id, deptMgrB.id, workerB.id);
    expect(assigned.status).toBe('ASSIGNED');
    const t = await prisma.task.findUnique({ where: { id: task.id } });
    expect(t?.assigneeId).toBe(workerB.id);
  });
});

describe('reconcile — reference-counted grant reversal (Slice 6)', () => {
  it('keeps the grant while any link remains, revokes it on the last', async () => {
    const div = await makeTeam('Div');
    const owner = await makeUser('owner');
    const person = await makeUser('person');
    await joinTeam(owner.id, div.id, 'MANAGER');
    const project = await makeProject(div.id, owner.id);
    // The assignment-sourced grant, plus two tasks assigned to the person.
    await prisma.projectAccessGrant.create({
      data: { projectId: project.id, subjectType: 'USER', subjectId: person.id, level: 'WRITE', status: 'ACTIVE', source: 'assignment:r1' },
    });
    const t1 = await prisma.task.create({ data: { title: 't1', teamId: div.id, projectId: project.id, creatorId: owner.id, status: 'TODO', priority: 'MEDIUM', position: 1, assigneeId: person.id } });
    const t2 = await prisma.task.create({ data: { title: 't2', teamId: div.id, projectId: project.id, creatorId: owner.id, status: 'TODO', priority: 'MEDIUM', position: 2, assigneeId: person.id } });

    // Remove t1's assignee, then reconcile → grant SURVIVES (t2 still links).
    await prisma.task.update({ where: { id: t1.id }, data: { assigneeId: null } });
    await reconcileAssignmentGrantForUsers(project.id, [person.id]);
    expect(await prisma.projectAccessGrant.count({ where: { projectId: project.id, subjectId: person.id } })).toBe(1);

    // Remove t2's assignee too → reconcile revokes the grant.
    await prisma.task.update({ where: { id: t2.id }, data: { assigneeId: null } });
    await reconcileAssignmentGrantForUsers(project.id, [person.id]);
    expect(await prisma.projectAccessGrant.count({ where: { projectId: project.id, subjectId: person.id } })).toBe(0);
  });

  it('never revokes a human-issued (non-assignment) grant', async () => {
    const div = await makeTeam('Div');
    const owner = await makeUser('owner');
    const person = await makeUser('person');
    await joinTeam(owner.id, div.id, 'MANAGER');
    const project = await makeProject(div.id, owner.id);
    await prisma.projectAccessGrant.create({
      data: { projectId: project.id, subjectType: 'USER', subjectId: person.id, level: 'WRITE', status: 'ACTIVE', source: 'panel' },
    });
    await reconcileAssignmentGrantForUsers(project.id, [person.id]); // person has zero task links
    expect(await prisma.projectAccessGrant.count({ where: { projectId: project.id, subjectId: person.id } })).toBe(1);
  });
});

describe('SLA scheduler (P3) — expiry + one-shot reminder', () => {
  async function pendingRequest() {
    workflowLive();
    const div = await makeTeam('Div');
    const net = await makeUnit(div.id, 'Net');
    const sec = await makeUnit(div.id, 'Sec');
    const owner = await makeUser('owner');
    const requester = await makeUser('requester');
    const secMgr = await makeUser('secMgr');
    const secMember = await makeUser('secMember');
    for (const u of [owner, requester, secMgr, secMember]) await joinTeam(u.id, div.id);
    await placeInUnit(net.id, requester.id);
    await placeInUnit(sec.id, secMgr.id, 'MANAGER');
    await placeInUnit(sec.id, secMember.id);
    const project = await makeProject(div.id, owner.id);
    const task = await makeTask(div.id, project.id, owner.id);
    const req = await svc.create(div.id, project.id, task.id, requester.id, { proposedId: secMember.id });
    return { req, requester, secMgr };
  }

  it('sweepExpired transitions a lapsed request to EXPIRED and notifies the requester', async () => {
    const { req, requester } = await pendingRequest();
    await prisma.taskAssignmentRequest.update({ where: { id: req.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await svc.sweepExpired()).toBe(1);
    const after = await prisma.taskAssignmentRequest.findUnique({ where: { id: req.id } });
    expect(after?.status).toBe('EXPIRED');
    expect(after?.decidedAt).not.toBeNull();
    expect(await prisma.notification.findFirst({ where: { userId: requester.id, type: 'ASSIGNMENT_DECIDED' } })).not.toBeNull();
  });

  it('does not expire a request still within its SLA', async () => {
    const { req } = await pendingRequest();
    expect(await svc.sweepExpired()).toBe(0);
    expect((await prisma.taskAssignmentRequest.findUnique({ where: { id: req.id } }))?.status).toBe('REQUESTED');
  });

  it('remindSoon nudges the approver exactly once (one-shot via remindedAt)', async () => {
    const { secMgr } = await pendingRequest();
    await prisma.notification.deleteMany(); // clear the create-time ASSIGNMENT_REQUESTED
    const lead = 30 * 24 * 3_600_000; // wide enough to cover a 3-working-day SLA
    expect(await svc.remindSoon(lead)).toBe(1);
    expect(await prisma.notification.count({ where: { userId: secMgr.id, type: 'ASSIGNMENT_REQUESTED' } })).toBe(1);
    expect(await svc.remindSoon(lead)).toBe(0); // remindedAt now set → no re-nudge
    expect(await prisma.notification.count({ where: { userId: secMgr.id, type: 'ASSIGNMENT_REQUESTED' } })).toBe(1);
  });

  it('admin report lists a request as pending, then as expired after a sweep', async () => {
    const { req } = await pendingRequest();
    expect((await svc.listForAdmin('pending')).some((r) => r.id === req.id)).toBe(true);
    expect(await svc.listForAdmin('expired')).toHaveLength(0);
    await prisma.taskAssignmentRequest.update({ where: { id: req.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await svc.sweepExpired();
    expect((await svc.listForAdmin('expired')).some((r) => r.id === req.id)).toBe(true);
  });
});
