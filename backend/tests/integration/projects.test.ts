import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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

  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.passwordReset.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function registerUser(email: string, name = 'User'): Promise<string> {
  const r = await bootstrapUser(app, { email, name, password: PASSWORD });
  return r.token;
}

// v1.39 tests: explicit MEMBER (not the auto-ADMIN promotion the first
// bootstrap user gets). Pair with `registerAdmin` to control globalRole.
async function registerMember(email: string, name = 'User'): Promise<string> {
  const r = await bootstrapUser(app, {
    email,
    name,
    password: PASSWORD,
    globalRole: 'MEMBER',
  });
  return r.token;
}

async function registerAdmin(email: string, name = 'Admin'): Promise<string> {
  const r = await bootstrapUser(app, {
    email,
    name,
    password: PASSWORD,
    globalRole: 'ADMIN',
  });
  return r.token;
}

async function createTeam(token: string, slug = 'team-a', name = 'Team A') {
  const res = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name, slug },
  });
  if (res.statusCode !== 201) throw new Error(`createTeam failed: ${res.statusCode}`);
  return res.json();
}

async function addMember(managerToken: string, teamId: string, email: string, role: 'MEMBER' | 'MANAGER') {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${managerToken}` },
    payload: { email, role },
  });
  if (res.statusCode !== 201) throw new Error(`addMember failed: ${res.statusCode}`);
  return res.json();
}

describe('POST /api/teams/:teamId/projects', () => {
  it('creates a project owned by the caller', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Mobile App', description: 'iOS first' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('Mobile App');
    expect(body.teamId).toBe(team.id);
    expect(body.status).toBe('ACTIVE');
  });

  it('rejects non-members with 403', async () => {
    const tokenA = await registerUser('a@example.com');
    const tokenB = await registerUser('b@example.com');
    const team = await createTeam(tokenA, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: 'Spy Project' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      payload: { name: 'Mobile App' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/teams/:teamId/projects', () => {
  it('lists only that teams projects (multi-tenancy)', async () => {
    const tokenA = await registerUser('a@example.com');
    const tokenB = await registerUser('b@example.com');
    const teamA = await createTeam(tokenA, 'acme');
    const teamB = await createTeam(tokenB, 'beta');

    await inject({
      method: 'POST',
      url: `/api/teams/${teamA.id}/projects`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'A1' },
    });
    await inject({
      method: 'POST',
      url: `/api/teams/${teamB.id}/projects`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: 'B1' },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamA.id}/projects`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('A1');
  });
});

describe('GET /api/teams/:teamId/projects/:projectId', () => {
  it('returns 404 (not 200) when project belongs to a different team', async () => {
    const tokenA = await registerUser('a@example.com');
    const tokenB = await registerUser('b@example.com');
    const teamA = await createTeam(tokenA, 'acme');
    const teamB = await createTeam(tokenB, 'beta');
    // B creates a project in team B, then A tries to fetch it via team A's URL.
    const projB = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamB.id}/projects`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { name: 'B-only' },
      })
    ).json();

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamA.id}/projects/${projB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    // The route requireTeamRole passes (A is a member of teamA), but the
    // service guard catches the cross-tenant id and returns 404 — never leak
    // existence of another team's resources.
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/teams/:teamId/projects/:projectId', () => {
  it('allows the owner to update their own project', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Old' },
      })
    ).json();

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'New', status: 'ARCHIVED' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('New');
    expect(res.json().status).toBe('ARCHIVED');
  });

  // v1.39 (BREAKING): non-owner non-ADMIN now sees the project as 404
  // (visibility gate), not 403. The status-code expectation was 403
  // pre-v1.39 when the gate was the v1.23 `project.edit` permission
  // check; today the project simply isn't visible.
  it('returns 404 when a MEMBER tries to edit someone elses project (v1.39 visibility gate)', async () => {
    const tokenOwner = await registerUser('owner@example.com');
    const tokenMember = await registerUser('member@example.com');
    const team = await createTeam(tokenOwner, 'acme');
    await addMember(tokenOwner, team.id, 'member@example.com', 'MEMBER');

    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: { name: 'OwnerProj' },
      })
    ).json();

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${tokenMember}` },
      payload: { name: 'Hijacked' },
    });
    expect(res.statusCode).toBe(404);
  });

  // v1.39 (BREAKING): a team MANAGER no longer auto-bypasses the
  // visibility gate. Only ADMIN bypasses; everyone else (MANAGER + MEMBER)
  // can only edit projects they own. Pre-v1.39 the manager could edit
  // any project in their team via the `project.edit` permission.
  it('returns 404 when a team MANAGER tries to edit someone elses project (v1.39 visibility gate)', async () => {
    // Bootstrap an admin to own the team (first user auto-promotes to ADMIN),
    // then create an explicit MEMBER-globalRole user that we hand the team
    // MANAGER role to. v1.39: being a team MANAGER no longer bypasses the
    // visibility gate — only globalRole === 'ADMIN' does.
    const tokenAdmin = await registerUser('admin@example.com');
    const tokenManager = await registerMember('mgr@example.com');
    const tokenOwner = await registerMember('owner@example.com');
    const team = await createTeam(tokenAdmin, 'acme');
    await addMember(tokenAdmin, team.id, 'mgr@example.com', 'MANAGER');
    await addMember(tokenAdmin, team.id, 'owner@example.com', 'MEMBER');

    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: { name: 'MemberProj' },
      })
    ).json();

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${tokenManager}` },
      payload: { status: 'ON_HOLD' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/teams/:teamId/projects/:projectId', () => {
  // v1.39 (BREAKING): non-owner non-ADMIN gets 404 (visibility gate),
  // not 403. Same reasoning as the PATCH tests above.
  it('returns 404 when a non-owner non-ADMIN tries to delete (v1.39 visibility gate)', async () => {
    const tokenOwner = await registerUser('owner@example.com');
    const tokenMember = await registerUser('member@example.com');
    const team = await createTeam(tokenOwner, 'acme');
    await addMember(tokenOwner, team.id, 'member@example.com', 'MEMBER');

    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: { name: 'OwnerProj' },
      })
    ).json();

    const res = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${tokenMember}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('allows the owner to delete', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'OwnerProj' },
      })
    ).json();

    const res = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
  });
});

// v1.39 (BREAKING) — project visibility tiering:
//   - globalRole === 'ADMIN' → sees / manages every project in the team
//   - everyone else (incl. team MANAGER)  → sees / manages only their
//     own projects (Project.ownerId === userId)
// The cascade middleware extends the same rule to /projects/:projectId/*
// nested routes (tasks, comments, etc.) so URL-guessing past
// the projects list filter returns 404.
describe('v1.39 project visibility tiering', () => {
  it('list — MEMBER sees only projects they own', async () => {
    // The first bootstrapped user is an admin (auto-promote). Use that
    // as the team-owner / counterparty, then make a plain MEMBER with
    // an explicit role.
    const adminToken = await registerUser('admin@example.com');
    const memberToken = await registerMember('member@example.com');
    const team = await createTeam(adminToken, 'acme');
    await addMember(adminToken, team.id, 'member@example.com', 'MEMBER');

    // Admin creates one; member creates one of their own.
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Admin Project' },
    });
    const mine = (await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { name: 'Mine' },
    })).json();

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ id: string; name: string }>;
    expect(items.map((p) => p.id)).toEqual([mine.id]);
  });

  it('list — global ADMIN sees every project on the team', async () => {
    const adminToken = await registerAdmin('admin@example.com');
    const otherToken = await registerMember('other@example.com');
    const team = await createTeam(adminToken, 'acme');
    await addMember(adminToken, team.id, 'other@example.com', 'MEMBER');

    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { name: 'Theirs' },
    });
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Mine' },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ name: string }>;
    expect(items.map((p) => p.name).sort()).toEqual(['Mine', 'Theirs']);
  });

  it('GET single — MEMBER 404 on a project they do not own', async () => {
    const adminToken = await registerUser('admin@example.com');
    const memberToken = await registerMember('member@example.com');
    const team = await createTeam(adminToken, 'acme');
    await addMember(adminToken, team.id, 'member@example.com', 'MEMBER');

    const proj = (await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Admin Project' },
    })).json();

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET single — global ADMIN bypass on someone elses project', async () => {
    const adminToken = await registerAdmin('admin@example.com');
    const otherToken = await registerMember('other@example.com');
    const team = await createTeam(adminToken, 'acme');
    await addMember(adminToken, team.id, 'other@example.com', 'MEMBER');

    const proj = (await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { name: 'Theirs' },
    })).json();

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(proj.id);
  });

  it('cascade — MEMBER 404 on /tasks under someone elses project (URL-guess bypass blocked)', async () => {
    const adminToken = await registerUser('admin@example.com');
    const memberToken = await registerMember('member@example.com');
    const team = await createTeam(adminToken, 'acme');
    await addMember(adminToken, team.id, 'member@example.com', 'MEMBER');

    const proj = (await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Admin Project' },
    })).json();

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('owner can still see, edit, and delete their own project end-to-end', async () => {
    const adminToken = await registerUser('admin@example.com');
    const memberToken = await registerMember('member@example.com');
    const team = await createTeam(adminToken, 'acme');
    await addMember(adminToken, team.id, 'member@example.com', 'MEMBER');

    const proj = (await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { name: 'Mine' },
    })).json();

    const get = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(get.statusCode).toBe(200);

    const patch = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { name: 'Mine (renamed)' },
    });
    expect(patch.statusCode).toBe(200);

    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(del.statusCode).toBe(204);
  });
});

// v1.40: cross-team list endpoint at GET /api/projects (no :teamId in the
// URL). Returns every project the caller can see across every team they
// belong to, with each row carrying the parent team's name and slug.
// Same visibility rule as the per-team list (owner-only for non-ADMINs;
// global ADMIN sees everything on the instance).
describe('v1.40 cross-team /api/projects list', () => {
  it('MEMBER sees their projects across multiple teams, with team name on each row', async () => {
    const adminToken = await registerUser('admin@example.com');
    const memberToken = await registerMember('member@example.com');
    const teamA = await createTeam(adminToken, 'team-a', 'Team A');
    const teamB = await createTeam(adminToken, 'team-b', 'Team B');
    await addMember(adminToken, teamA.id, 'member@example.com', 'MEMBER');
    await addMember(adminToken, teamB.id, 'member@example.com', 'MEMBER');

    // Member creates one project in each team; admin owns a third invisible to member.
    const mineA = (await inject({
      method: 'POST',
      url: `/api/teams/${teamA.id}/projects`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { name: 'MineA' },
    })).json();
    const mineB = (await inject({
      method: 'POST',
      url: `/api/teams/${teamB.id}/projects`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { name: 'MineB' },
    })).json();
    await inject({
      method: 'POST',
      url: `/api/teams/${teamA.id}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'AdminOnly' },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/projects`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{
      id: string;
      name: string;
      teamId: string;
      teamName: string;
      teamSlug: string;
    }>;
    expect(items.map((p) => p.id).sort()).toEqual([mineA.id, mineB.id].sort());
    const byId = new Map(items.map((p) => [p.id, p]));
    expect(byId.get(mineA.id)?.teamName).toBe('Team A');
    expect(byId.get(mineB.id)?.teamName).toBe('Team B');
  });

  it('global ADMIN sees every project on the instance across all teams', async () => {
    const adminToken = await registerAdmin('admin@example.com');
    const memberToken = await registerMember('member@example.com');
    const teamA = await createTeam(adminToken, 'team-a', 'Team A');
    const teamB = await createTeam(adminToken, 'team-b', 'Team B');
    await addMember(adminToken, teamA.id, 'member@example.com', 'MEMBER');

    await inject({
      method: 'POST',
      url: `/api/teams/${teamA.id}/projects`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { name: 'Theirs' },
    });
    await inject({
      method: 'POST',
      url: `/api/teams/${teamB.id}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Mine' },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const names = (res.json() as Array<{ name: string }>).map((p) => p.name).sort();
    expect(names).toEqual(['Mine', 'Theirs']);
  });

  it('budget fields — create with values, fixed-2 string echo', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Budgeted', plannedBudget: '1000', actualSpent: 250.5 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().plannedBudget).toBe('1000.00');
    expect(res.json().actualSpent).toBe('250.50');
  });

  it('budget fields — create without values defaults to null', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'NoBudget' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().plannedBudget).toBeNull();
    expect(res.json().actualSpent).toBeNull();
  });

  it('budget fields — PATCH sets and PATCH null clears', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'X' },
      })
    ).json();
    const set = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { plannedBudget: '500.75', actualSpent: '0' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().plannedBudget).toBe('500.75');
    expect(set.json().actualSpent).toBe('0.00');

    const clear = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { plannedBudget: null, actualSpent: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().plannedBudget).toBeNull();
    expect(clear.json().actualSpent).toBeNull();
  });

  it('budget fields — rejects negative values (400)', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Neg', plannedBudget: '-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('budget fields — rejects non-numeric strings (400)', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'NaN', plannedBudget: 'abc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('budget fields — rejects more than 2 fractional digits (400)', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'TooPrecise', plannedBudget: '1.234' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('user with no team memberships gets an empty list, not 500', async () => {
    // Bootstrap an admin so the auto-promote path doesn't fire on the orphan.
    await registerUser('admin@example.com');
    const orphan = await registerMember('orphan@example.com');
    const res = await inject({
      method: 'GET',
      url: `/api/projects`,
      headers: { authorization: `Bearer ${orphan}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
