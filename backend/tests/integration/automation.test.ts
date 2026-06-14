import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GlobalRole } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { clearSystemUserCache, SYSTEM_USER_EMAIL } from '../../src/lib/systemUser.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.automationRun.deleteMany();
  await prisma.automationAction.deleteMany();
  await prisma.automationCondition.deleteMany();
  await prisma.automationRule.deleteMany();
  await prisma.customFieldValueOption.deleteMany();
  await prisma.customFieldValue.deleteMany();
  await prisma.customFieldOption.deleteMany();
  await prisma.customFieldDefinition.deleteMany();
  await prisma.taskLabel.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.label.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  clearSystemUserCache();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function ensureSystemUser() {
  return bootstrapUser(app, {
    email: SYSTEM_USER_EMAIL,
    name: 'System',
    password: 'SysAdminPass9!',
    globalRole: GlobalRole.ADMIN,
    isSystemUser: true,
  });
}

async function registerUser(email: string) {
  return bootstrapUser(app, { email, name: email, password: PASSWORD });
}

async function createTeam(token: string, slug: string) {
  const res = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function createProject(token: string, teamId: string, name: string) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function createTask(token: string, teamId: string, projectId: string, title: string) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; priority: string; status: string };
}

async function createRule(token: string, teamId: string, body: Record<string, unknown>) {
  return inject({
    method: 'POST',
    url: `/api/teams/${teamId}/automations`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe('v1.60 Automation rules', () => {
  it('1) status→DONE rule sets priority LOW on that transition only', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-1@test.local');
    const team = await createTeam(mgr.token, 'auto-1');
    const project = await createProject(mgr.token, team.id, 'P1');
    const task = await createTask(mgr.token, team.id, project.id, 'T1');

    const ruleRes = await createRule(mgr.token, team.id, {
      name: 'Done → LOW',
      triggerType: 'task.status_changed',
      conditions: [{ factType: 'status', operator: 'is', valueJson: { status: 'DONE' } }],
      actions: [{ actionType: 'set_priority', valueJson: { priority: 'LOW' } }],
    });
    expect(ruleRes.statusCode).toBe(201);

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { status: 'IN_PROGRESS' },
    });

    const mid = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(mid.json().priority).toBe('MEDIUM');

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { status: 'DONE' },
    });

    const done = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(done.json().priority).toBe('LOW');
  });

  it('2) ALL-match requires both conditions; ANY-match requires one', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-2@test.local');
    const team = await createTeam(mgr.token, 'auto-2');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');

    const allRule = await createRule(mgr.token, team.id, {
      name: 'ALL',
      triggerType: 'task.status_changed',
      conditionMatch: 'ALL',
      conditions: [
        { factType: 'status', operator: 'is', valueJson: { status: 'DONE' } },
        { factType: 'priority', operator: 'is', valueJson: { priority: 'HIGH' } },
      ],
      actions: [{ actionType: 'add_comment', valueJson: { text: 'ALL fired' } }],
    });
    expect(allRule.statusCode).toBe(201);
    const allId = allRule.json().id as string;

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { status: 'DONE' },
    });
    let runs = await prisma.automationRun.findMany({ where: { ruleId: allId } });
    expect(runs.some((r) => r.status === 'SUCCESS')).toBe(false);

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { priority: 'HIGH' },
    });
    runs = await prisma.automationRun.findMany({ where: { ruleId: allId } });
    expect(runs.filter((r) => r.status === 'SUCCESS').length).toBe(0);

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { status: 'DONE' },
    });
    runs = await prisma.automationRun.findMany({ where: { ruleId: allId, status: 'SUCCESS' } });
    expect(runs.length).toBe(0);

    const anyRule = await createRule(mgr.token, team.id, {
      name: 'ANY',
      triggerType: 'task.updated',
      conditionMatch: 'ANY',
      conditions: [
        { factType: 'status', operator: 'is', valueJson: { status: 'DONE' } },
        { factType: 'priority', operator: 'is', valueJson: { priority: 'URGENT' } },
      ],
      actions: [{ actionType: 'add_comment', valueJson: { text: 'ANY fired' } }],
    });
    const anyId = anyRule.json().id as string;

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { title: 'Updated title' },
    });
    runs = await prisma.automationRun.findMany({ where: { ruleId: anyId, status: 'SUCCESS' } });
    expect(runs.length).toBeGreaterThan(0);
  });

  it('3) custom-field condition evaluates NUMBER and PERSON types', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-3@test.local');
    const team = await createTeam(mgr.token, 'auto-3');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');

    const numField = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/custom-fields`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'Score', type: 'NUMBER' },
    });
    const fieldId = numField.json().id as string;

    await createRule(mgr.token, team.id, {
      name: 'Score high',
      triggerType: 'task.custom_field_changed',
      conditions: [
        {
          factType: 'custom_field',
          operator: 'gt',
          customFieldId: fieldId,
          valueJson: { number: 10 },
        },
      ],
      actions: [{ actionType: 'set_priority', valueJson: { priority: 'HIGH' } }],
    });

    await inject({
      method: 'PUT',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}/custom-fields/${fieldId}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { valueNumber: 15 },
    });

    const t1 = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(t1.json().priority).toBe('HIGH');
  });

  it('4) set custom field action validates; invalid value logs ERROR', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-4@test.local');
    const team = await createTeam(mgr.token, 'auto-4');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');

    const field = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/custom-fields`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'Num', type: 'NUMBER' },
    });
    const fieldId = field.json().id as string;

    const rule = await createRule(mgr.token, team.id, {
      name: 'Bad set',
      triggerType: 'task.updated',
      conditions: [],
      actions: [
        {
          actionType: 'set_custom_field',
          customFieldId: fieldId,
          valueJson: { valueNumber: 'not-a-number' },
        },
      ],
    });
    expect(rule.statusCode).toBe(201);
    const ruleId = rule.json().id as string;

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { title: 'trigger rule' },
    });

    const runs = await prisma.automationRun.findMany({ where: { ruleId } });
    expect(runs.some((r) => r.status === 'ERROR')).toBe(true);
  });

  it('5) loop guard: rule fires at most once per chain on re-entrant events', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-5@test.local');
    const team = await createTeam(mgr.token, 'auto-5');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');

    const rule = await createRule(mgr.token, team.id, {
      name: 'Loop',
      triggerType: 'task.updated',
      conditions: [],
      actions: [{ actionType: 'set_priority', valueJson: { priority: 'HIGH' } }],
    });
    const ruleId = rule.json().id as string;

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { title: 'Change triggers rule' },
    });

    const runs = await prisma.automationRun.findMany({ where: { ruleId } });
    const success = runs.filter((r) => r.status === 'SUCCESS');
    const skipped = runs.filter((r) => r.status === 'SKIPPED' && r.detail?.includes('already fired'));
    expect(success.length).toBe(1);
    expect(skipped.length).toBeGreaterThanOrEqual(1);
  });

  it('6) failing action logs ERROR; original user write already succeeded', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-6@test.local');
    const team = await createTeam(mgr.token, 'auto-6');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'Original');

    const field = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/custom-fields`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'N', type: 'NUMBER' },
    });
    const fieldId = field.json().id as string;

    const ruleRes = await createRule(mgr.token, team.id, {
      name: 'Partial fail',
      triggerType: 'task.updated',
      conditions: [],
      actions: [
        { actionType: 'add_comment', valueJson: { text: 'Automation ok' } },
        {
          actionType: 'set_custom_field',
          customFieldId: fieldId,
          valueJson: { valueNumber: 'not-a-number' },
        },
      ],
    });
    expect(ruleRes.statusCode).toBe(201);

    const patch = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { title: 'User edit succeeded' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().title).toBe('User edit succeeded');
    const comments = await prisma.comment.findMany({ where: { taskId: task.id } });
    expect(comments.some((c) => c.body.includes('Automation ok'))).toBe(true);
    const ruleRuns = await prisma.automationRun.findMany({
      where: { taskId: task.id, status: 'ERROR' },
    });
    expect(ruleRuns.length).toBeGreaterThan(0);
  });

  it('7) disabled rule does not evaluate; re-enable resumes', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-7@test.local');
    const team = await createTeam(mgr.token, 'auto-7');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');

    const created = await createRule(mgr.token, team.id, {
      name: 'Toggle',
      enabled: false,
      triggerType: 'task.status_changed',
      conditions: [{ factType: 'status', operator: 'is', valueJson: { status: 'DONE' } }],
      actions: [{ actionType: 'set_priority', valueJson: { priority: 'LOW' } }],
    });
    const ruleId = created.json().id as string;

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { status: 'DONE' },
    });
    expect(await prisma.automationRun.count({ where: { ruleId } })).toBe(0);

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/automations/${ruleId}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { enabled: true },
    });
    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { status: 'IN_PROGRESS' },
    });
    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { status: 'DONE' },
    });
    const get = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(get.json().priority).toBe('LOW');
  });

  it('8) cross-team reference at create returns 404', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-8@test.local');
    const teamA = await createTeam(mgr.token, 'auto-8a');
    const teamB = await createTeam(mgr.token, 'auto-8b');
    const labelB = await inject({
      method: 'POST',
      url: `/api/teams/${teamB.id}/labels`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'B-only', color: '#ff0000' },
    });

    const res = await createRule(mgr.token, teamA.id, {
      name: 'Cross',
      triggerType: 'task.updated',
      conditions: [{ factType: 'label', operator: 'has', valueJson: { labelId: labelB.json().id } }],
      actions: [{ actionType: 'set_priority', valueJson: { priority: 'LOW' } }],
    });
    expect(res.statusCode).toBe(404);
  });

  it('9) member without automation.manage gets 403 on CRUD', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-9@test.local');
    const member = await registerUser('auto-mem-9@test.local');
    const team = await createTeam(mgr.token, 'auto-9');
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { email: 'auto-mem-9@test.local', role: 'MEMBER' },
    });
    const res = await createRule(member.token, team.id, {
      name: 'Nope',
      triggerType: 'task.created',
      actions: [{ actionType: 'set_priority', valueJson: { priority: 'LOW' } }],
    });
    expect(res.statusCode).toBe(403);
  });

  it('10) runs endpoint paginates with SUCCESS/SKIPPED/ERROR detail', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-10@test.local');
    const team = await createTeam(mgr.token, 'auto-10');
    const project = await createProject(mgr.token, team.id, 'P');
    await createTask(mgr.token, team.id, project.id, 'T');

    const rule = await createRule(mgr.token, team.id, {
      name: 'Runs',
      triggerType: 'task.created',
      actions: [{ actionType: 'set_priority', valueJson: { priority: 'LOW' } }],
    });
    expect(rule.statusCode).toBe(201);
    const ruleId = rule.json().id as string;

    await createTask(mgr.token, team.id, project.id, 'Trigger run');

    const runs = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/automations/${ruleId}/runs?page=1&pageSize=10`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(runs.statusCode).toBe(200);
    const body = runs.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.page).toBe(1);
    expect(['SUCCESS', 'SKIPPED', 'ERROR']).toContain(body.items[0].status);
  });

  it('11) reorder changes rule execution order', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-11@test.local');
    const team = await createTeam(mgr.token, 'auto-11');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');

    const r1 = await createRule(mgr.token, team.id, {
      name: 'First LOW',
      triggerType: 'task.updated',
      position: 0,
      conditions: [],
      actions: [{ actionType: 'set_priority', valueJson: { priority: 'LOW' } }],
    });
    const r2 = await createRule(mgr.token, team.id, {
      name: 'Second URGENT',
      triggerType: 'task.updated',
      position: 1,
      conditions: [],
      actions: [{ actionType: 'set_priority', valueJson: { priority: 'URGENT' } }],
    });

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { title: 'x' },
    });
    let get = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(get.json().priority).toBe('URGENT');

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/automations/reorder`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { orderedIds: [r2.json().id, r1.json().id] },
    });

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { title: 'y' },
    });
    get = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(get.json().priority).toBe('LOW');
  });

  it('12) deleting rule cascades conditions/actions/runs; tasks intact', async () => {
    await ensureSystemUser();
    const mgr = await registerUser('auto-mgr-12@test.local');
    const team = await createTeam(mgr.token, 'auto-12');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'Keep me');

    const rule = await createRule(mgr.token, team.id, {
      name: 'Delete me',
      triggerType: 'task.created',
      conditions: [{ factType: 'status', operator: 'is', valueJson: { status: 'TODO' } }],
      actions: [{ actionType: 'set_priority', valueJson: { priority: 'LOW' } }],
    });
    const ruleId = rule.json().id as string;

    await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/automations/${ruleId}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });

    expect(await prisma.automationRule.count({ where: { id: ruleId } })).toBe(0);
    expect(await prisma.automationCondition.count({ where: { ruleId } })).toBe(0);
    expect(await prisma.automationAction.count({ where: { ruleId } })).toBe(0);
    expect(await prisma.automationRun.count({ where: { ruleId } })).toBe(0);

    const get = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().title).toBe('Keep me');
  });
});
