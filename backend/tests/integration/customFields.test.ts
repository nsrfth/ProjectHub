import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GlobalRole } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
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
  await prisma.notification.deleteMany();
  await prisma.customFieldValueOption.deleteMany();
  await prisma.customFieldValue.deleteMany();
  await prisma.customFieldOption.deleteMany();
  await prisma.customFieldDefinition.deleteMany();
  await prisma.projectGroupGrant.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function registerUser(email: string, globalRole?: GlobalRole) {
  return bootstrapUser(app, {
    email,
    name: email,
    password: PASSWORD,
    globalRole: globalRole ?? GlobalRole.MEMBER,
  });
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

async function addMember(
  mgrToken: string,
  teamId: string,
  email: string,
  role: 'MEMBER' | 'MANAGER',
) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${mgrToken}` },
    payload: { email, role },
  });
  expect(res.statusCode).toBe(201);
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
  return res.json() as { id: string; customFields: unknown[] };
}

async function createField(
  token: string,
  teamId: string,
  body: Record<string, unknown>,
) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/custom-fields`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  return res;
}

async function setValue(
  token: string,
  teamId: string,
  projectId: string,
  taskId: string,
  fieldId: string,
  body: Record<string, unknown>,
) {
  return inject({
    method: 'PUT',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/custom-fields/${fieldId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe('v1.58 Custom fields', () => {
  it('1) creates one field of each type with correct type + options', async () => {
    const mgr = await registerUser('cf-mgr-1@test.local');
    const team = await createTeam(mgr.token, 'cf-team-1');

    const types = [
      { name: 'Text F', type: 'TEXT' },
      { name: 'Num F', type: 'NUMBER' },
      { name: 'Date F', type: 'DATE' },
      { name: 'Single F', type: 'SINGLE_SELECT', options: [{ label: 'A' }] },
      { name: 'Multi F', type: 'MULTI_SELECT', options: [{ label: 'X' }, { label: 'Y' }] },
      { name: 'Check F', type: 'CHECKBOX' },
      { name: 'Person F', type: 'PERSON' },
    ] as const;

    const ids: string[] = [];
    for (const spec of types) {
      const res = await createField(mgr.token, team.id, spec);
      expect(res.statusCode).toBe(201);
      const row = res.json() as { id: string; type: string; options: unknown[] };
      expect(row.type).toBe(spec.type);
      ids.push(row.id);
      if ('options' in spec) {
        expect(row.options).toHaveLength(spec.options.length);
      }
    }

    const list = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/custom-fields`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as unknown[]).length).toBe(7);
    expect(ids.length).toBe(7);
  });

  it('2) sets and reads each value type on a task', async () => {
    const mgr = await registerUser('cf-mgr-2@test.local');
    const member = await registerUser('cf-mem-2@test.local');
    const team = await createTeam(mgr.token, 'cf-team-2');
    await addMember(mgr.token, team.id, member.email, 'MEMBER');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');

    const textF = (await createField(mgr.token, team.id, { name: 'T', type: 'TEXT' }).then((r) => r.json())) as { id: string };
    const numF = (await createField(mgr.token, team.id, { name: 'N', type: 'NUMBER' }).then((r) => r.json())) as { id: string };
    const dateF = (await createField(mgr.token, team.id, { name: 'D', type: 'DATE' }).then((r) => r.json())) as { id: string };
    const singleF = (await createField(mgr.token, team.id, {
      name: 'S',
      type: 'SINGLE_SELECT',
      options: [{ label: 'Red' }],
    }).then((r) => r.json())) as { id: string; options: Array<{ id: string }> };
    const multiF = (await createField(mgr.token, team.id, {
      name: 'M',
      type: 'MULTI_SELECT',
      options: [{ label: 'A' }, { label: 'B' }],
    }).then((r) => r.json())) as { id: string; options: Array<{ id: string }> };
    const checkF = (await createField(mgr.token, team.id, { name: 'C', type: 'CHECKBOX' }).then((r) => r.json())) as { id: string };
    const personF = (await createField(mgr.token, team.id, { name: 'P', type: 'PERSON' }).then((r) => r.json())) as { id: string };

    expect((await setValue(mgr.token, team.id, project.id, task.id, textF.id, { valueText: 'hello' })).statusCode).toBe(200);
    expect((await setValue(mgr.token, team.id, project.id, task.id, numF.id, { valueNumber: '12.3456' })).statusCode).toBe(200);
    expect((await setValue(mgr.token, team.id, project.id, task.id, dateF.id, { valueDate: '2026-06-01T00:00:00.000Z' })).statusCode).toBe(200);
    expect((await setValue(mgr.token, team.id, project.id, task.id, singleF.id, { optionIds: [singleF.options[0].id] })).statusCode).toBe(200);
    expect((await setValue(mgr.token, team.id, project.id, task.id, multiF.id, { optionIds: multiF.options.map((o) => o.id) })).statusCode).toBe(200);
    expect((await setValue(mgr.token, team.id, project.id, task.id, checkF.id, { valueBool: true })).statusCode).toBe(200);
    expect((await setValue(mgr.token, team.id, project.id, task.id, personF.id, { valueUserId: member.userId })).statusCode).toBe(200);

    const get = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    const body = get.json() as {
      customFields: Array<{
        fieldId: string;
        valueText: string | null;
        valueNumber: string | null;
        valueBool: boolean | null;
        valueUserId: string | null;
        optionIds: string[];
      }>;
    };
    const byId = new Map(body.customFields.map((cf) => [cf.fieldId, cf]));
    expect(byId.get(textF.id)?.valueText).toBe('hello');
    expect(byId.get(numF.id)?.valueNumber).toBe('12.3456');
    expect(byId.get(checkF.id)?.valueBool).toBe(true);
    expect(byId.get(personF.id)?.valueUserId).toBe(member.userId);
    expect(byId.get(singleF.id)?.optionIds).toEqual([singleF.options[0].id]);
    expect(byId.get(multiF.id)?.optionIds).toHaveLength(2);
  });

  it('3) SINGLE_SELECT rejects >1 option; MULTI_SELECT accepts set; foreign option → 400', async () => {
    const mgr = await registerUser('cf-mgr-3@test.local');
    const team = await createTeam(mgr.token, 'cf-team-3');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');

    const single = (await createField(mgr.token, team.id, {
      name: 'S',
      type: 'SINGLE_SELECT',
      options: [{ label: 'A' }, { label: 'B' }],
    }).then((r) => r.json())) as { id: string; options: Array<{ id: string }> };
    const multi = (await createField(mgr.token, team.id, {
      name: 'M',
      type: 'MULTI_SELECT',
      options: [{ label: 'X' }],
    }).then((r) => r.json())) as { id: string; options: Array<{ id: string }> };

    const tooMany = await setValue(mgr.token, team.id, project.id, task.id, single.id, {
      optionIds: [single.options[0].id, single.options[1].id],
    });
    expect(tooMany.statusCode).toBe(400);

    const okMulti = await setValue(mgr.token, team.id, project.id, task.id, multi.id, {
      optionIds: [multi.options[0].id],
    });
    expect(okMulti.statusCode).toBe(200);

    const foreign = await setValue(mgr.token, team.id, project.id, task.id, single.id, {
      optionIds: [multi.options[0].id],
    });
    expect(foreign.statusCode).toBe(400);
  });

  it('4) PERSON accepts team member, rejects outsider', async () => {
    const mgr = await registerUser('cf-mgr-4@test.local');
    const member = await registerUser('cf-mem-4@test.local');
    const outsider = await registerUser('cf-out-4@test.local');
    const team = await createTeam(mgr.token, 'cf-team-4');
    await addMember(mgr.token, team.id, member.email, 'MEMBER');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');
    const personF = (await createField(mgr.token, team.id, { name: 'P', type: 'PERSON' }).then((r) => r.json())) as { id: string };

    expect((await setValue(mgr.token, team.id, project.id, task.id, personF.id, { valueUserId: member.userId })).statusCode).toBe(200);
    expect((await setValue(mgr.token, team.id, project.id, task.id, personF.id, { valueUserId: outsider.userId })).statusCode).toBe(400);
  });

  it('5) NUMBER stores decimal precision; bad type → 400', async () => {
    const mgr = await registerUser('cf-mgr-5@test.local');
    const team = await createTeam(mgr.token, 'cf-team-5');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');
    const numF = (await createField(mgr.token, team.id, { name: 'N', type: 'NUMBER' }).then((r) => r.json())) as { id: string };

    await setValue(mgr.token, team.id, project.id, task.id, numF.id, { valueNumber: '99.1234' });
    const row = await prisma.customFieldValue.findFirst({ where: { fieldId: numF.id } });
    expect(row?.valueNumber?.toString()).toBe('99.1234');

    const bad = await setValue(mgr.token, team.id, project.id, task.id, numF.id, { valueNumber: 'not-a-number' });
    expect(bad.statusCode).toBe(400);
  });

  it('6) clearing deletes value row; task detail omits populated value', async () => {
    const mgr = await registerUser('cf-mgr-6@test.local');
    const team = await createTeam(mgr.token, 'cf-team-6');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');
    const textF = (await createField(mgr.token, team.id, { name: 'T', type: 'TEXT' }).then((r) => r.json())) as { id: string };

    await setValue(mgr.token, team.id, project.id, task.id, textF.id, { valueText: 'x' });
    expect(await prisma.customFieldValue.count({ where: { fieldId: textF.id } })).toBe(1);

    await setValue(mgr.token, team.id, project.id, task.id, textF.id, { clear: true });
    expect(await prisma.customFieldValue.count({ where: { fieldId: textF.id } })).toBe(0);

    const get = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    const cf = (get.json() as { customFields: Array<{ fieldId: string; valueText: string | null }> }).customFields.find(
      (c) => c.fieldId === textF.id,
    );
    expect(cf?.valueText).toBeNull();
  });

  it('7) field from team A cannot be set on task in team B → 404', async () => {
    const mgr = await registerUser('cf-mgr-7@test.local');
    const teamA = await createTeam(mgr.token, 'cf-team-7a');
    const teamB = await createTeam(mgr.token, 'cf-team-7b');
    const projectB = await createProject(mgr.token, teamB.id, 'PB');
    const taskB = await createTask(mgr.token, teamB.id, projectB.id, 'TB');
    const fieldA = (await createField(mgr.token, teamA.id, { name: 'A', type: 'TEXT' }).then((r) => r.json())) as { id: string };

    const res = await setValue(mgr.token, teamB.id, projectB.id, taskB.id, fieldA.id, { valueText: 'leak' });
    expect(res.statusCode).toBe(404);
  });

  it('8) deleting field removes values + options; task intact', async () => {
    const mgr = await registerUser('cf-mgr-8@test.local');
    const team = await createTeam(mgr.token, 'cf-team-8');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');
    const field = (await createField(mgr.token, team.id, {
      name: 'S',
      type: 'SINGLE_SELECT',
      options: [{ label: 'A' }],
    }).then((r) => r.json())) as { id: string; options: Array<{ id: string }> };

    await setValue(mgr.token, team.id, project.id, task.id, field.id, { optionIds: [field.options[0].id] });
    expect(await prisma.customFieldValue.count()).toBe(1);
    expect(await prisma.customFieldOption.count()).toBe(1);

    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/custom-fields/${field.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(del.statusCode).toBe(204);
    expect(await prisma.customFieldValue.count()).toBe(0);
    expect(await prisma.customFieldOption.count()).toBe(0);
    expect(await prisma.customFieldDefinition.count()).toBe(0);

    const taskStill = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(taskStill.statusCode).toBe(200);
  });

  it('9) active=false rejects writes; existing values still readable', async () => {
    const mgr = await registerUser('cf-mgr-9@test.local');
    const team = await createTeam(mgr.token, 'cf-team-9');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');
    const field = (await createField(mgr.token, team.id, { name: 'T', type: 'TEXT' }).then((r) => r.json())) as { id: string };

    await setValue(mgr.token, team.id, project.id, task.id, field.id, { valueText: 'before' });

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/custom-fields/${field.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { active: false },
    });

    const blocked = await setValue(mgr.token, team.id, project.id, task.id, field.id, { valueText: 'after' });
    expect(blocked.statusCode).toBe(400);

    const get = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    const cf = (get.json() as { customFields: Array<{ fieldId: string; valueText: string | null; active: boolean }> }).customFields.find(
      (c) => c.fieldId === field.id,
    );
    expect(cf?.valueText).toBe('before');
    expect(cf?.active).toBe(false);
  });

  it('10) non-manager without customfield.manage gets 403 on field CRUD but CAN set task value', async () => {
    const mgr = await registerUser('cf-mgr-10@test.local');
    const member = await registerUser('cf-mem-10@test.local');
    const team = await createTeam(mgr.token, 'cf-team-10');
    await addMember(mgr.token, team.id, member.email, 'MEMBER');
    const project = await createProject(member.token, team.id, 'P');
    const task = await createTask(member.token, team.id, project.id, 'T');

    const field = (await createField(mgr.token, team.id, { name: 'T', type: 'TEXT' }).then((r) => r.json())) as { id: string };

    const denied = await createField(member.token, team.id, { name: 'X', type: 'TEXT' });
    expect(denied.statusCode).toBe(403);

    const allowed = await setValue(member.token, team.id, project.id, task.id, field.id, { valueText: 'by member' });
    expect(allowed.statusCode).toBe(200);
  });

  it('11) activity log records definition changes and task value changes', async () => {
    const mgr = await registerUser('cf-mgr-11@test.local');
    const team = await createTeam(mgr.token, 'cf-team-11');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'T');

    const createRes = await createField(mgr.token, team.id, { name: 'Notes', type: 'TEXT' });
    const field = createRes.json() as { id: string };

    await setValue(mgr.token, team.id, project.id, task.id, field.id, { valueText: 'audit me' });

    const teamActs = await prisma.activity.findMany({
      where: { teamId: team.id, taskId: null, action: { startsWith: 'customfield.' } },
    });
    expect(teamActs.some((a) => a.action === 'customfield.created')).toBe(true);

    const taskActs = await prisma.activity.findMany({
      where: { taskId: task.id, action: 'task.customfield_set' },
    });
    expect(taskActs.length).toBeGreaterThan(0);
    const meta = taskActs[0].meta as { fieldName?: string; summary?: string };
    expect(meta.fieldName).toBe('Notes');
    expect(meta.summary).toContain('audit');
  });

  it('12) legacy task without required field still loads and saves', async () => {
    const mgr = await registerUser('cf-mgr-12@test.local');
    const team = await createTeam(mgr.token, 'cf-team-12');
    const project = await createProject(mgr.token, team.id, 'P');
    const task = await createTask(mgr.token, team.id, project.id, 'Legacy');

    await createField(mgr.token, team.id, { name: 'Required later', type: 'TEXT', required: true });

    const get = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(get.statusCode).toBe(200);

    const patch = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { title: 'Legacy updated' },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { title: string }).title).toBe('Legacy updated');
  });
});
