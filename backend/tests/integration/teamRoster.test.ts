import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GlobalRole } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { SYSTEM_USER_EMAIL } from '../../src/lib/systemUser.js';
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
  await prisma.projectGroupGrant.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function manager() {
  return bootstrapUser(app, {
    email: 'mgr@example.com',
    name: 'Manager',
    password: PASSWORD,
    globalRole: GlobalRole.MEMBER,
  });
}

async function member(email: string) {
  return bootstrapUser(app, {
    email,
    name: email.split('@')[0]!,
    password: PASSWORD,
    globalRole: GlobalRole.MEMBER,
  });
}

async function teamDetail(token: string, teamId: string) {
  const res = await inject({
    method: 'GET',
    url: `/api/teams/${teamId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    members: Array<{
      userId: string;
      email: string;
      role: string;
      roleName: string | null;
      joinedAt: string;
      disabled: boolean;
      locked: boolean;
      external: boolean;
      groupAccessLevel: 'FULL' | 'READONLY' | null;
    }>;
  };
}

describe('Team roster status + external badges v1.54', () => {
  it('1. disabled member shows Disabled flag; active member does not', async () => {
    const mgr = await manager();
    const victim = await member('disabled@example.com');
    const team = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${mgr.token}` },
        payload: { name: 'T', slug: 'roster-1' },
      })
    ).json() as { id: string };
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { email: victim.email, role: 'MEMBER' },
    });
    await prisma.user.update({
      where: { id: victim.userId },
      data: { disabledAt: new Date() },
    });

    const body = await teamDetail(mgr.token, team.id);
    const disabledRow = body.members.find((m) => m.userId === victim.userId);
    const mgrRow = body.members.find((m) => m.userId === mgr.userId);
    expect(disabledRow?.disabled).toBe(true);
    expect(disabledRow?.external).toBe(false);
    expect(mgrRow?.disabled).toBe(false);
  });

  it('2. locked member shows Locked; past/null lockedUntil does not', async () => {
    const mgr = await manager();
    const locked = await member('locked@example.com');
    const team = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${mgr.token}` },
        payload: { name: 'T', slug: 'roster-2' },
      })
    ).json() as { id: string };
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { email: locked.email, role: 'MEMBER' },
    });
    await prisma.user.update({
      where: { id: locked.userId },
      data: { lockedUntil: new Date(Date.now() + 60 * 60_000) },
    });

    const body = await teamDetail(mgr.token, team.id);
    expect(body.members.find((m) => m.userId === locked.userId)?.locked).toBe(true);

    await prisma.user.update({
      where: { id: locked.userId },
      data: { lockedUntil: new Date(Date.now() - 60_000) },
    });
    const after = await teamDetail(mgr.token, team.id);
    expect(after.members.find((m) => m.userId === locked.userId)?.locked).toBe(false);
  });

  it('3. ACCEPTED external group member appears as External row', async () => {
    const mgr = await manager();
    const external = await member('external@example.com');
    const team = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${mgr.token}` },
        payload: { name: 'T', slug: 'roster-3' },
      })
    ).json() as { id: string };
    const group = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/groups`,
        headers: { authorization: `Bearer ${mgr.token}` },
        payload: { name: 'G' },
      })
    ).json() as { id: string };
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/groups/${group.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { userId: external.userId, accessLevel: 'READONLY' },
    });
    const pending = await prisma.userGroupMember.findFirst({
      where: { userId: external.userId, groupId: group.id },
    });
    expect(pending?.status).toBe('PENDING');
    await inject({
      method: 'POST',
      url: `/api/me/group-invites/${pending!.id}/accept`,
      headers: { authorization: `Bearer ${external.token}` },
    });

    const body = await teamDetail(mgr.token, team.id);
    const row = body.members.find((m) => m.userId === external.userId);
    expect(row).toBeDefined();
    expect(row!.external).toBe(true);
    expect(row!.groupAccessLevel).toBe('READONLY');
    expect(row!.role).toBe('MEMBER');
    expect(row!.roleName).toBeNull();
  });

  it('4. team member in a group appears once as member, not external', async () => {
    const mgr = await manager();
    const insider = await member('insider@example.com');
    const team = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${mgr.token}` },
        payload: { name: 'T', slug: 'roster-4' },
      })
    ).json() as { id: string };
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { email: insider.email, role: 'MEMBER' },
    });
    const group = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/groups`,
        headers: { authorization: `Bearer ${mgr.token}` },
        payload: { name: 'G' },
      })
    ).json() as { id: string };
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/groups/${group.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { userId: insider.userId, accessLevel: 'FULL' },
    });

    const body = await teamDetail(mgr.token, team.id);
    const matches = body.members.filter((m) => m.userId === insider.userId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.external).toBe(false);
    expect(matches[0]!.role).toBe('MEMBER');
  });

  it('5. system user never appears', async () => {
    const mgr = await manager();
    const team = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${mgr.token}` },
        payload: { name: 'T', slug: 'roster-5' },
      })
    ).json() as { id: string };
    const sys = await prisma.user.create({
      data: {
        email: SYSTEM_USER_EMAIL,
        name: 'System',
        passwordHash: 'x',
        globalRole: GlobalRole.ADMIN,
        isSystemUser: true,
      },
    });
    await prisma.teamMembership.create({
      data: { teamId: team.id, userId: sys.id, role: 'MANAGER' },
    });

    const body = await teamDetail(mgr.token, team.id);
    expect(body.members.some((m) => m.email === SYSTEM_USER_EMAIL)).toBe(false);
  });

  it('6. no cross-team external rows', async () => {
    const mgrA = await manager();
    const mgrB = await bootstrapUser(app, {
      email: 'mgrb@example.com',
      name: 'B',
      password: PASSWORD,
      globalRole: GlobalRole.MEMBER,
    });
    const external = await member('cross@example.com');
    const teamA = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${mgrA.token}` },
        payload: { name: 'A', slug: 'roster-6a' },
      })
    ).json() as { id: string };
    const teamB = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${mgrB.token}` },
        payload: { name: 'B', slug: 'roster-6b' },
      })
    ).json() as { id: string };
    const groupB = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamB.id}/groups`,
        headers: { authorization: `Bearer ${mgrB.token}` },
        payload: { name: 'G' },
      })
    ).json() as { id: string };
    await inject({
      method: 'POST',
      url: `/api/teams/${teamB.id}/groups/${groupB.id}/members`,
      headers: { authorization: `Bearer ${mgrB.token}` },
      payload: { userId: external.userId, accessLevel: 'FULL' },
    });
    const pending = await prisma.userGroupMember.findFirst({
      where: { userId: external.userId, groupId: groupB.id },
    });
    await inject({
      method: 'POST',
      url: `/api/me/group-invites/${pending!.id}/accept`,
      headers: { authorization: `Bearer ${external.token}` },
    });

    const bodyA = await teamDetail(mgrA.token, teamA.id);
    expect(bodyA.members.some((m) => m.userId === external.userId)).toBe(false);
  });

  it('7. existing member fields unchanged for team members', async () => {
    const mgr = await manager();
    const bob = await member('bob@example.com');
    const team = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${mgr.token}` },
        payload: { name: 'T', slug: 'roster-7' },
      })
    ).json() as { id: string };
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { email: bob.email, role: 'MEMBER' },
    });

    const body = await teamDetail(mgr.token, team.id);
    const bobRow = body.members.find((m) => m.userId === bob.userId);
    expect(bobRow).toBeDefined();
    expect(bobRow!.role).toBe('MEMBER');
    expect(typeof bobRow!.joinedAt).toBe('string');
    expect(bobRow!.joinedAt.length).toBeGreaterThan(0);
    expect(bobRow!.roleName === null || typeof bobRow!.roleName === 'string').toBe(true);
  });
});
