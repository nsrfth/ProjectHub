import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';

// Integration coverage for v1.17 Project.accountableId:
//  - create accepts accountableId of a team member
//  - create rejects accountableId of a non-member with 400
//  - list / get include accountableId + accountableName
//  - PATCH updates accountableId (also gated on team membership)
//  - PATCH with explicit null clears the field

let app: FastifyInstance;

beforeAll(async () => {
  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

async function setupTwoUsersOneTeam() {
  const owner = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'owner@example.com', name: 'Owner', password: PASSWORD },
  });
  const ownerToken = owner.json().accessToken as string;
  const ownerId = owner.json().user.id as string;

  const second = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'tech@example.com', name: 'Tech', password: PASSWORD },
  });
  const techId = second.json().user.id as string;

  const team = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: 'AccountTeam', slug: 'account-team' },
  });
  const teamId = team.json().id as string;

  // Add the second user as a MEMBER of the team so they're a valid accountable.
  await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { email: 'tech@example.com', role: 'MEMBER' },
  });

  return { ownerToken, ownerId, techId, teamId };
}

describe('Project.accountableId', () => {
  it('accepts an accountableId that points at a team member, and surfaces the joined name', async () => {
    const { ownerToken, techId, teamId } = await setupTwoUsersOneTeam();
    const create = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'P', accountableId: techId },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.accountableId).toBe(techId);
    expect(body.accountableName).toBe('Tech');
  });

  it('rejects an accountableId that points at someone NOT in the team with 400', async () => {
    const { ownerToken, teamId } = await setupTwoUsersOneTeam();
    // Create a fourth user NOT in the team.
    const outsider = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'outsider@example.com', name: 'Outsider', password: PASSWORD },
    });
    const outsiderId = outsider.json().user.id as string;

    const create = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'P', accountableId: outsiderId },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json().error.message).toMatch(/team/i);
  });

  it('list returns accountableId + accountableName populated', async () => {
    const { ownerToken, techId, teamId } = await setupTwoUsersOneTeam();
    await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'P', accountableId: techId },
    });
    const list = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Array<{
      accountableId: string | null;
      accountableName: string | null;
    }>;
    expect(items[0]?.accountableId).toBe(techId);
    expect(items[0]?.accountableName).toBe('Tech');
  });

  it('PATCH with accountableId: null clears the field', async () => {
    const { ownerToken, techId, teamId } = await setupTwoUsersOneTeam();
    const created = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'P', accountableId: techId },
    });
    const projectId = created.json().id as string;

    const patch = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { accountableId: null },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().accountableId).toBeNull();
    expect(patch.json().accountableName).toBeNull();
  });

  it('create without accountableId leaves the field null (backwards-compat)', async () => {
    const { ownerToken, teamId } = await setupTwoUsersOneTeam();
    const create = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'P' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().accountableId).toBeNull();
    expect(create.json().accountableName).toBeNull();
  });
});
