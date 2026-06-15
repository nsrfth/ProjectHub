import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv, resetEnvCacheForTests } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';
import { getSystemUserId, clearSystemUserCache, SYSTEM_USER_EMAIL } from '../../src/lib/systemUser.js';

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
  clearSystemUserCache();
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhook.deleteMany();
  await prisma.intakeFormField.deleteMany();
  await prisma.intakeForm.deleteMany();
  await prisma.customFieldValueOption.deleteMany();
  await prisma.customFieldValue.deleteMany();
  await prisma.customFieldOption.deleteMany();
  await prisma.customFieldDefinition.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.taskLabel.deleteMany();
  await prisma.task.deleteMany();
  await prisma.label.deleteMany();
  await prisma.project.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

const defaultFields = [
  { label: 'Title', target: 'title' as const, required: true, position: 0 },
  { label: 'Description', target: 'description' as const, required: false, position: 1 },
];

async function setupTeam(slug: string) {
  const manager = await bootstrapUser(app, {
    email: `${slug}-mgr@test.local`,
    name: 'Manager',
    password: PASSWORD,
    globalRole: 'MEMBER',
  });
  const member = await bootstrapUser(app, {
    email: `${slug}-mem@test.local`,
    name: 'Member',
    password: PASSWORD,
  });

  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${manager.token}` },
      payload: { name: `Team ${slug}`, slug },
    })
  ).json() as { id: string };

  await inject({
    method: 'POST',
    url: `/api/teams/${team.id}/members`,
    headers: { authorization: `Bearer ${manager.token}` },
    payload: { email: member.email, role: 'MEMBER' },
  });

  const project = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${manager.token}` },
      payload: { name: 'Intake Project' },
    })
  ).json() as { id: string };

  return { manager, member, teamId: team.id, projectId: project.id };
}

async function createForm(
  token: string,
  teamId: string,
  projectId: string,
  fields = defaultFields,
  extra: { mode?: 'TEAM' | 'PUBLIC'; enabled?: boolean } = {},
) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/forms`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      projectId,
      name: 'Bug report',
      mode: extra.mode ?? 'TEAM',
      enabled: extra.enabled ?? true,
      fields,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; fields: { id: string; target: string }[]; publicToken: string | null };
}

describe('Intake forms', () => {
  it('authenticated member submit creates task with mapped values and task.created side effects', async () => {
    const { manager, member, teamId, projectId } = await setupTeam('form-a');

    const cf = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamId}/custom-fields`,
        headers: { authorization: `Bearer ${manager.token}` },
        payload: { name: 'Severity', type: 'TEXT', required: false },
      })
    ).json() as { id: string };

    const form = await createForm(manager.token, teamId, projectId, [
      { label: 'Title', target: 'title', required: true, position: 0 },
      { label: 'Priority', target: 'priority', required: false, position: 1 },
      {
        label: 'Severity',
        target: 'customField',
        customFieldId: cf.id,
        required: true,
        position: 2,
      },
    ]);

    const titleField = form.fields.find((f) => f.target === 'title')!;
    const priorityField = form.fields.find((f) => f.target === 'priority')!;
    const cfField = form.fields.find((f) => f.target === 'customField')!;

    const submit = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/forms/${form.id}/submit`,
      headers: { authorization: `Bearer ${member.token}` },
      payload: {
        values: {
          [titleField.id]: 'Login broken',
          [priorityField.id]: 'HIGH',
          [cfField.id]: 'Critical',
        },
      },
    });
    expect(submit.statusCode).toBe(200);
    const { taskId } = submit.json() as { taskId: string };

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    expect(task?.projectId).toBe(projectId);
    expect(task?.title).toBe('Login broken');
    expect(task?.priority).toBe('HIGH');

    const cfVal = await prisma.customFieldValue.findFirst({
      where: { taskId, fieldId: cf.id },
    });
    expect(cfVal?.valueText).toBe('Critical');

    const activity = await prisma.activity.findFirst({
      where: { taskId, action: 'task.created' },
    });
    expect(activity).toBeTruthy();

    const formActivity = await prisma.activity.findFirst({
      where: { action: 'form.submitted', taskId },
    });
    expect(formActivity).toBeTruthy();
  });

  it('required-field validation rejects incomplete submissions', async () => {
    const { manager, member, teamId, projectId } = await setupTeam('form-req');
    const form = await createForm(manager.token, teamId, projectId);
    const titleField = form.fields.find((f) => f.target === 'title')!;

    const res = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/forms/${form.id}/submit`,
      headers: { authorization: `Bearer ${member.token}` },
      payload: { values: { [titleField.id]: '' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('custom-field values validated by type', async () => {
    const { manager, member, teamId, projectId } = await setupTeam('form-cf');
    const cf = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamId}/custom-fields`,
        headers: { authorization: `Bearer ${manager.token}` },
        payload: { name: 'Count', type: 'NUMBER', required: true },
      })
    ).json() as { id: string };

    const form = await createForm(manager.token, teamId, projectId, [
      { label: 'Title', target: 'title', required: true, position: 0 },
      {
        label: 'Count',
        target: 'customField',
        customFieldId: cf.id,
        required: true,
        position: 1,
      },
    ]);

    const titleField = form.fields.find((f) => f.target === 'title')!;
    const cfField = form.fields.find((f) => f.target === 'customField')!;

    const res = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/forms/${form.id}/submit`,
      headers: { authorization: `Bearer ${member.token}` },
      payload: {
        values: {
          [titleField.id]: 'Bad number',
          [cfField.id]: 'not-a-number',
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.task.count()).toBe(0);
  });

  it('public endpoint 404s for TEAM-mode form', async () => {
    const { manager, teamId, projectId } = await setupTeam('form-team');
    const form = await createForm(manager.token, teamId, projectId, defaultFields, { mode: 'TEAM' });
    expect(form.publicToken).toBeNull();

    const res = await inject({
      method: 'GET',
      url: '/api/public/forms/fake-token-xyz',
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUBLIC submit works when enabled; disabled or wrong token rejected', async () => {
    await bootstrapUser(app, {
      email: SYSTEM_USER_EMAIL,
      password: PASSWORD,
      isSystemUser: true,
      globalRole: 'ADMIN',
    });

    const { manager, teamId, projectId } = await setupTeam('form-pub');
    const form = await createForm(manager.token, teamId, projectId, defaultFields, { mode: 'PUBLIC' });
    expect(form.publicToken).toBeTruthy();

    const titleField = form.fields.find((f) => f.target === 'title')!;
    const ok = await inject({
      method: 'POST',
      url: `/api/public/forms/${form.publicToken}/submit`,
      payload: { values: { [titleField.id]: 'Anonymous issue' } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ success: true });
    expect(await prisma.task.count()).toBe(1);

    await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/forms/${form.id}`,
      headers: { authorization: `Bearer ${manager.token}` },
      payload: { enabled: false },
    });

    const disabled = await inject({
      method: 'POST',
      url: `/api/public/forms/${form.publicToken}/submit`,
      payload: { values: { [titleField.id]: 'Should fail' } },
    });
    expect(disabled.statusCode).toBe(404);
  });

  it('public render does not leak team members or assignee fields', async () => {
    await bootstrapUser(app, {
      email: SYSTEM_USER_EMAIL,
      password: PASSWORD,
      isSystemUser: true,
      globalRole: 'ADMIN',
    });

    const { manager, teamId, projectId } = await setupTeam('form-leak');
    const form = await createForm(manager.token, teamId, projectId, defaultFields, { mode: 'PUBLIC' });

    const res = await inject({
      method: 'GET',
      url: `/api/public/forms/${form.publicToken}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.teamId).toBeUndefined();
    expect(body.projectId).toBeUndefined();
    expect(body.members).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(manager.email);

    const withAssignee = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/forms/${form.id}`,
      headers: { authorization: `Bearer ${manager.token}` },
      payload: {
        mode: 'PUBLIC',
        fields: [
          { label: 'Title', target: 'title', required: true, position: 0 },
          { label: 'Owner', target: 'assignee', required: false, position: 1 },
        ],
      },
    });
    expect(withAssignee.statusCode).toBe(400);
  });

  it('public submit honeypot and system actor; no privileged owner', async () => {
    await bootstrapUser(app, {
      email: SYSTEM_USER_EMAIL,
      password: PASSWORD,
      isSystemUser: true,
      globalRole: 'ADMIN',
    });
    clearSystemUserCache();
    const systemUserId = await getSystemUserId();
    expect(systemUserId).toBeTruthy();

    const { manager, teamId, projectId } = await setupTeam('form-hp');
    const form = await createForm(manager.token, teamId, projectId, defaultFields, { mode: 'PUBLIC' });
    const titleField = form.fields.find((f) => f.target === 'title')!;

    const before = await prisma.task.count();
    const bot = await inject({
      method: 'POST',
      url: `/api/public/forms/${form.publicToken}/submit`,
      payload: {
        website: 'http://spam.example',
        values: { [titleField.id]: 'Bot spam' },
      },
    });
    expect(bot.statusCode).toBe(200);
    expect(await prisma.task.count()).toBe(before);

    const human = await inject({
      method: 'POST',
      url: `/api/public/forms/${form.publicToken}/submit`,
      payload: { values: { [titleField.id]: 'Real report' } },
    });
    expect(human.statusCode).toBe(200);
    const task = await prisma.task.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(task?.creatorId).toBe(systemUserId);
    expect(task?.assigneeId).toBeNull();
  });

  it('token rotation invalidates previous URL', async () => {
    await bootstrapUser(app, {
      email: SYSTEM_USER_EMAIL,
      password: PASSWORD,
      isSystemUser: true,
      globalRole: 'ADMIN',
    });

    const { manager, teamId, projectId } = await setupTeam('form-rot');
    const form = await createForm(manager.token, teamId, projectId, defaultFields, { mode: 'PUBLIC' });
    const oldToken = form.publicToken!;

    const rotated = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/forms/${form.id}/rotate-token`,
      headers: { authorization: `Bearer ${manager.token}` },
    });
    expect(rotated.statusCode).toBe(200);
    const newToken = (rotated.json() as { publicToken: string }).publicToken;
    expect(newToken).not.toBe(oldToken);

    const oldGet = await inject({ method: 'GET', url: `/api/public/forms/${oldToken}` });
    expect(oldGet.statusCode).toBe(404);

    const newGet = await inject({ method: 'GET', url: `/api/public/forms/${newToken}` });
    expect(newGet.statusCode).toBe(200);
  });

  it('non-manager cannot create forms or rotate tokens', async () => {
    const { manager, member, teamId, projectId } = await setupTeam('form-403');

    const create = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/forms`,
      headers: { authorization: `Bearer ${member.token}` },
      payload: {
        projectId,
        name: 'Nope',
        fields: defaultFields,
      },
    });
    expect(create.statusCode).toBe(403);

    const form = await createForm(manager.token, teamId, projectId, defaultFields, { mode: 'PUBLIC' });
    const rotate = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/forms/${form.id}/rotate-token`,
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(rotate.statusCode).toBe(403);
  });

  it('cross-team isolation — form only creates tasks in its team/project', async () => {
    const a = await setupTeam('form-x-a');
    const b = await setupTeam('form-x-b');
    const form = await createForm(a.manager.token, a.teamId, a.projectId);

    const submitOther = await inject({
      method: 'POST',
      url: `/api/teams/${b.teamId}/forms/${form.id}/submit`,
      headers: { authorization: `Bearer ${b.member.token}` },
      payload: {
        values: {
          [form.fields.find((f) => f.target === 'title')!.id]: 'Cross team',
        },
      },
    });
    expect(submitOther.statusCode).toBe(404);
    expect(await prisma.task.count()).toBe(0);
  });

  it('public submit is rate-limited', async () => {
    const prevMax = process.env.PUBLIC_FORM_RATE_LIMIT_MAX;
    const prevWindow = process.env.PUBLIC_FORM_RATE_LIMIT_WINDOW;
    process.env.PUBLIC_FORM_RATE_LIMIT_MAX = '1';
    process.env.PUBLIC_FORM_RATE_LIMIT_WINDOW = '1 minute';
    resetEnvCacheForTests();
    const limitedApp = await buildApp(loadEnv());

    try {
      await bootstrapUser(limitedApp, {
        email: SYSTEM_USER_EMAIL,
        password: PASSWORD,
        isSystemUser: true,
        globalRole: 'ADMIN',
      });

      const manager = await bootstrapUser(limitedApp, {
        email: 'rl-mgr@test.local',
        password: PASSWORD,
        globalRole: 'MEMBER',
      });
      const team = (
        await limitedApp.inject({
          method: 'POST',
          url: '/api/teams',
          headers: { authorization: `Bearer ${manager.token}` },
          payload: { name: 'RL Team', slug: 'rl-team' },
        })
      ).json() as { id: string };
      const project = (
        await limitedApp.inject({
          method: 'POST',
          url: `/api/teams/${team.id}/projects`,
          headers: { authorization: `Bearer ${manager.token}` },
          payload: { name: 'P' },
        })
      ).json() as { id: string };

      const created = await limitedApp.inject({
        method: 'POST',
        url: `/api/teams/${team.id}/forms`,
        headers: { authorization: `Bearer ${manager.token}` },
        payload: {
          projectId: project.id,
          name: 'RL',
          mode: 'PUBLIC',
          fields: defaultFields,
        },
      });
      const form = created.json() as { publicToken: string; fields: { id: string; target: string }[] };
      const titleId = form.fields.find((f) => f.target === 'title')!.id;

      const first = await limitedApp.inject({
        method: 'POST',
        url: `/api/public/forms/${form.publicToken}/submit`,
        payload: { values: { [titleId]: 'T0' } },
      });
      expect(first.statusCode).toBe(200);

      const blocked = await limitedApp.inject({
        method: 'POST',
        url: `/api/public/forms/${form.publicToken}/submit`,
        payload: { values: { [titleId]: 'Over limit' } },
      });
      expect(blocked.statusCode).toBe(429);
    } finally {
      process.env.PUBLIC_FORM_RATE_LIMIT_MAX = prevMax;
      process.env.PUBLIC_FORM_RATE_LIMIT_WINDOW = prevWindow;
      resetEnvCacheForTests();
      await limitedApp.close();
    }
  }, 90_000);
});
