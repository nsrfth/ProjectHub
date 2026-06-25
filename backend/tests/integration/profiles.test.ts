import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';
import { requireModule } from '../../src/middleware/requireModule.js';
import { AppError } from '../../src/lib/errors.js';
import { MODULE_KEYS } from '../../src/lib/moduleRegistry.js';

// v1.98 (PMIS R2 — project profiles).
//
// Covers:
//   - identity backfill: a fresh project lands on NEUTRAL → every module off
//   - assigning EPC flips its modules on in effective-config
//   - dependency closure: enabling only `evm` pulls in baselines + cost_control
//   - project overrides layer on top of the snapshotted profile
//   - team default feeds project-create resolution
//   - a non-PMO project owner → 403 on assign + overrides
//   - a cross-team caller → existence-hiding 404 on the project profile routes
//   - requireModule(): 403 module_disabled on NEUTRAL, passes on EPC

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  // Wipe tenant data but KEEP the system-seeded built-in profiles (teamId null).
  await prisma.projectProfile.deleteMany({ where: { ownerScope: 'TEAM' } });
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.instanceSetting.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function register(email: string, name = 'User') {
  return bootstrapUser(app, { email, name, password: PASSWORD });
}

async function createTeam(token: string, slug: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  if (r.statusCode !== 201) throw new Error(`createTeam failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createProject(
  token: string,
  teamId: string,
  name: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name, ...body },
  });
  if (r.statusCode !== 201) throw new Error(`createProject failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function systemProfileId(key: string): Promise<string> {
  const r = await app.inject({ method: 'GET', url: '/api/system/profiles' });
  const items = r.json().items as Array<{ id: string; key: string }>;
  const hit = items.find((p) => p.key === key);
  if (!hit) throw new Error(`system profile ${key} not found`);
  return hit.id;
}

function effectiveConfig(token: string, teamId: string, projectId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/teams/${teamId}/projects/${projectId}/effective-config`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function assignProfile(token: string, teamId: string, projectId: string, profileId: string) {
  return app.inject({
    method: 'PUT',
    url: `/api/teams/${teamId}/projects/${projectId}/profile`,
    headers: { authorization: `Bearer ${token}` },
    payload: { profileId },
  });
}

describe('Project profiles (PMIS R2)', () => {
  it('serves the system module catalog + 4 built-in profiles', async () => {
    const modules = await app.inject({ method: 'GET', url: '/api/system/modules' });
    expect(modules.statusCode).toBe(200);
    expect((modules.json().modules as unknown[]).length).toBe(MODULE_KEYS.length);

    const profiles = await app.inject({ method: 'GET', url: '/api/system/profiles' });
    const keys = (profiles.json().items as Array<{ key: string }>).map((p) => p.key).sort();
    expect(keys).toEqual(['EPC', 'IT', 'NEUTRAL', 'OPERATIONS']);
  });

  it('backfills a fresh project to NEUTRAL — every module off', async () => {
    const a = await register('a@example.com', 'Alice');
    const teamId = await createTeam(a.token, 'pf-a');
    const projectId = await createProject(a.token, teamId, 'P');

    const res = await effectiveConfig(a.token, teamId, projectId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { profileName: string; modules: Record<string, { enabled: boolean }> };
    expect(body.profileName).toBe('Neutral');
    for (const key of MODULE_KEYS) {
      expect(body.modules[key]?.enabled, `${key} should be off`).toBe(false);
    }
  });

  it('assigning EPC flips its modules on', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'pf-a');
    const projectId = await createProject(a.token, teamId, 'P');
    const epc = await systemProfileId('EPC');

    expect((await assignProfile(a.token, teamId, projectId, epc)).statusCode).toBe(200);

    const body = (await effectiveConfig(a.token, teamId, projectId)).json() as {
      profileName: string;
      modules: Record<string, { enabled: boolean }>;
    };
    expect(body.profileName).toBe('EPC');
    // EPC enables every module.
    for (const key of MODULE_KEYS) {
      expect(body.modules[key]?.enabled, `${key} should be on for EPC`).toBe(true);
    }
  });

  it('closes the enabled set over dependsOn (evm → baselines + cost_control)', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'pf-a');
    const projectId = await createProject(a.token, teamId, 'P');

    // Author a custom profile that turns ON only `evm`.
    const create = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/profiles`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { name: 'EVM only', key: 'EVM_ONLY', modules: [{ moduleKey: 'evm', enabled: true }] },
    });
    expect(create.statusCode).toBe(201);
    const profileId = create.json().id as string;

    const pub = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/profiles/${profileId}/publish`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(pub.statusCode).toBe(200);

    expect((await assignProfile(a.token, teamId, projectId, profileId)).statusCode).toBe(200);

    const m = (await effectiveConfig(a.token, teamId, projectId)).json().modules as Record<
      string,
      { enabled: boolean }
    >;
    expect(m.evm.enabled).toBe(true);
    expect(m.baselines.enabled).toBe(true);
    expect(m.cost_control.enabled).toBe(true);
    // A module with no edge stays off.
    expect(m.risk.enabled).toBe(false);
  });

  it('layers project overrides on the snapshotted profile', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'pf-a');
    const projectId = await createProject(a.token, teamId, 'P'); // NEUTRAL

    const ov = await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/projects/${projectId}/profile/overrides`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { overrides: { cost_control: { enabled: true } } },
    });
    expect(ov.statusCode).toBe(200);

    const m = (await effectiveConfig(a.token, teamId, projectId)).json().modules as Record<
      string,
      { enabled: boolean }
    >;
    expect(m.cost_control.enabled).toBe(true);
    expect(m.timesheets.enabled).toBe(false);
  });

  it('feeds project-create resolution from the team default', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'pf-a');
    const epc = await systemProfileId('EPC');

    const setDefault = await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/defaults/profile`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { profileId: epc },
    });
    expect(setDefault.statusCode).toBe(200);

    const projectId = await createProject(a.token, teamId, 'P2');
    const body = (await effectiveConfig(a.token, teamId, projectId)).json() as {
      profileName: string;
    };
    expect(body.profileName).toBe('EPC');
  });

  it('blocks a non-PMO project owner from assigning / overriding (403)', async () => {
    const admin = await register('admin@example.com');
    const b = await register('owner@example.com', 'Bob');
    const teamId = await createTeam(admin.token, 'pf-a');
    await prisma.teamMembership.create({ data: { userId: b.userId, teamId, role: 'MEMBER' } });
    const projectId = await createProject(b.token, teamId, 'P'); // B owns it (→ WRITE access)
    const epc = await systemProfileId('EPC');

    expect((await assignProfile(b.token, teamId, projectId, epc)).statusCode).toBe(403);
    const ov = await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/projects/${projectId}/profile/overrides`,
      headers: { authorization: `Bearer ${b.token}` },
      payload: { overrides: { cost_control: { enabled: true } } },
    });
    expect(ov.statusCode).toBe(403);
  });

  it('hides another team\'s project profile from a cross-team caller (404)', async () => {
    const a = await register('a@example.com');
    const b = await register('b@example.com', 'Bob');
    const teamA = await createTeam(a.token, 'pf-a');
    await createTeam(b.token, 'pf-b');
    const projA = await createProject(a.token, teamA, 'PA');
    const epc = await systemProfileId('EPC');

    expect((await effectiveConfig(b.token, teamA, projA)).statusCode).toBe(404);
    expect((await assignProfile(b.token, teamA, projA, epc)).statusCode).toBe(404);
    const getProf = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamA}/projects/${projA}/profile`,
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(getProf.statusCode).toBe(404);
  });

  it('requireModule gates on the project profile (module_disabled vs pass)', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'pf-a');
    const neutralProject = await createProject(a.token, teamId, 'N');
    const epcProject = await createProject(a.token, teamId, 'E');
    const epc = await systemProfileId('EPC');
    await assignProfile(a.token, teamId, epcProject, epc);

    const gate = requireModule('cost_control');
    const reqFor = (projectId: string) =>
      ({
        user: { sub: a.userId, globalRole: 'ADMIN' },
        params: { teamId, projectId },
      }) as never;

    // NEUTRAL project → cost_control disabled → AppError(module_disabled).
    await expect(gate(reqFor(neutralProject), {} as never)).rejects.toMatchObject({
      statusCode: 403,
      code: 'module_disabled',
    });
    await expect(gate(reqFor(neutralProject), {} as never)).rejects.toBeInstanceOf(AppError);

    // EPC project → cost_control enabled → passes (resolves).
    await expect(gate(reqFor(epcProject), {} as never)).resolves.toBeUndefined();
  });
});
