import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { HOLDING_ROOT_ID } from '../../src/lib/orgUnitTree.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.99 (PMIS R3 — portfolio / program): OrgUnit tree + project attach +
// subtree roll-up reports.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.projectBaseline.deleteMany();
  await prisma.task.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamOrgUnit.deleteMany();
  // Keep system HOLDING; remove team-created nodes only.
  await prisma.orgUnit.deleteMany({ where: { id: { not: HOLDING_ROOT_ID } } });
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.instanceSetting.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function register(email: string, name = 'User'): Promise<{ token: string; userId: string }> {
  const r = await bootstrapUser(app, { email, name, password: PASSWORD });
  return { token: r.token, userId: r.userId };
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

async function createProject(token: string, teamId: string, name: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  if (r.statusCode !== 201) throw new Error(`createProject failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

describe('Org units (PMIS R3)', () => {
  it('seeds the HOLDING root and lists the tree', async () => {
    const a = await register('a@example.com');
    const tree = await app.inject({
      method: 'GET',
      url: '/api/org-units/tree',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(tree.statusCode).toBe(200);
    const items = tree.json().items as Array<{ id: string; type: string }>;
    expect(items.some((n) => n.id === HOLDING_ROOT_ID && n.type === 'HOLDING')).toBe(true);
  });

  it('creates a PORTFOLIO under HOLDING and attaches a project', async () => {
    const a = await register('a@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/org-units',
      headers: { authorization: `Bearer ${a.token}` },
      payload: {
        parentId: HOLDING_ROOT_ID,
        type: 'PORTFOLIO',
        name: 'Infrastructure',
        code: 'INFRA',
      },
    });
    expect(create.statusCode).toBe(201);
    const portfolioId = create.json().id as string;

    const teamId = await createTeam(a.token, 'pf-a');
    const projectId = await createProject(a.token, teamId, 'Bridge');

    const attach = await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/projects/${projectId}/org-unit`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { orgUnitId: portfolioId },
    });
    expect(attach.statusCode).toBe(200);
    expect(attach.json()).toMatchObject({
      projectId,
      orgUnitId: portfolioId,
      orgUnitName: 'Infrastructure',
    });

    const summary = await app.inject({
      method: 'GET',
      url: `/api/org-units/${portfolioId}/reports/summary`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().projectCount).toBe(1);
  });

  it('rolls up RAG counts for attached projects', async () => {
    const a = await register('a@example.com');
    const pf = await app.inject({
      method: 'POST',
      url: '/api/org-units',
      headers: { authorization: `Bearer ${a.token}` },
      payload: { parentId: HOLDING_ROOT_ID, type: 'PORTFOLIO', name: 'Ops', code: 'OPS' },
    });
    const portfolioId = pf.json().id as string;
    const teamId = await createTeam(a.token, 'rag-team');
    const projectId = await createProject(a.token, teamId, 'P1');
    await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/projects/${projectId}/health`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { ragStatus: 'AMBER', ragReason: 'slipping' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/projects/${projectId}/org-unit`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { orgUnitId: portfolioId },
    });

    const rag = await app.inject({
      method: 'GET',
      url: `/api/org-units/${portfolioId}/reports/rag`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(rag.statusCode).toBe(200);
    expect(rag.json().byStatus.AMBER).toBe(1);
  });

  it('blocks a team MEMBER without portfolio.view from listing org units (403)', async () => {
    const mgr = await register('mgr@example.com', 'Mgr');
    const teamId = await createTeam(mgr.token, 'pf-b');

    const member = await register('mem@example.com', 'Mem');
    await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { email: 'mem@example.com', role: 'MEMBER' },
    });

    // Strip portfolio.view from the Member system role for this team.
    const memberRole = await prisma.role.findFirst({
      where: { teamId, name: 'Member', isSystem: true },
      select: { id: true },
    });
    await prisma.rolePermission.deleteMany({
      where: {
        roleId: memberRole!.id,
        permission: { startsWith: 'portfolio.' },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/org-units',
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates COMPANY under HOLDING/COMPANY, rejects it under PORTFOLIO (400), allows PORTFOLIO under COMPANY', async () => {
    const a = await register('a@example.com');
    const H = { authorization: `Bearer ${a.token}` };
    const mk = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/org-units', headers: H, payload });

    // COMPANY under HOLDING → ok.
    const co = await mk({ parentId: HOLDING_ROOT_ID, type: 'COMPANY', name: 'NIOC', code: 'NIOC' });
    expect(co.statusCode).toBe(201);
    const companyId = co.json().id as string;

    // COMPANY under COMPANY (sub-subsidiary) → ok.
    const sub = await mk({ parentId: companyId, type: 'COMPANY', name: 'NIOC-Sub', code: 'NSUB' });
    expect(sub.statusCode).toBe(201);

    // PORTFOLIO under the COMPANY → ok (additive parent).
    const pf = await mk({ parentId: companyId, type: 'PORTFOLIO', name: 'Delivery', code: 'DLV' });
    expect(pf.statusCode).toBe(201);

    // COMPANY under a PORTFOLIO → 400, stable badRequest code.
    const bad = await mk({ parentId: pf.json().id, type: 'COMPANY', name: 'Illegal', code: 'ILL' });
    expect(bad.statusCode).toBe(400);
  });

  it('moves a PORTFOLIO under a COMPANY and rewrites descendant paths + rolls up the subtree', async () => {
    const a = await register('a@example.com');
    const H = { authorization: `Bearer ${a.token}` };
    const mk = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/org-units', headers: H, payload });

    const co = await mk({ parentId: HOLDING_ROOT_ID, type: 'COMPANY', name: 'Co', code: 'CO' });
    const companyId = co.json().id as string;
    // PORTFOLIO starts under HOLDING with a PROGRAM child.
    const pf = await mk({ parentId: HOLDING_ROOT_ID, type: 'PORTFOLIO', name: 'PF', code: 'PF' });
    const portfolioId = pf.json().id as string;
    const pg = await mk({ parentId: portfolioId, type: 'PROGRAM', name: 'PG', code: 'PG' });
    const programId = pg.json().id as string;

    // Move the PORTFOLIO under the COMPANY.
    const move = await app.inject({
      method: 'POST',
      url: `/api/org-units/${portfolioId}/move`,
      headers: H,
      payload: { newParentId: companyId },
    });
    expect(move.statusCode).toBe(200);

    // Descendant PROGRAM path was rewritten under the company subtree.
    const company = await prisma.orgUnit.findUnique({ where: { id: companyId } });
    const program = await prisma.orgUnit.findUnique({ where: { id: programId } });
    expect(program!.path.startsWith(`${company!.path}/`)).toBe(true);
    expect(program!.path).toContain(`/${portfolioId}/`);

    // Roll-up over the COMPANY subtree includes a project attached to its portfolio.
    const teamId = await createTeam(a.token, 'co-team');
    const projectId = await createProject(a.token, teamId, 'P');
    await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/projects/${projectId}/org-unit`,
      headers: H,
      payload: { orgUnitId: portfolioId },
    });
    const summary = await app.inject({
      method: 'GET',
      url: `/api/org-units/${companyId}/reports/summary`,
      headers: H,
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().projectCount).toBe(1);
  });

  it('hides a cross-team project attach as existence-hiding 404', async () => {
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    const pf = await app.inject({
      method: 'POST',
      url: '/api/org-units',
      headers: { authorization: `Bearer ${a.token}` },
      payload: { parentId: HOLDING_ROOT_ID, type: 'PORTFOLIO', name: 'X', code: 'X' },
    });
    const portfolioId = pf.json().id as string;
    const teamA = await createTeam(a.token, 'team-a');
    const projectId = await createProject(a.token, teamA, 'Secret');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamA}/projects/${projectId}/org-unit`,
      headers: { authorization: `Bearer ${b.token}` },
      payload: { orgUnitId: portfolioId },
    });
    expect(res.statusCode).toBe(404);
  });
});
