import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';

// SCIM 2.0 integration coverage. Walks through the IdP-facing happy path:
// admin generates a token → IdP uses it to create + update + deprovision +
// delete a user → IdP creates a group and edits its members. Plus the
// auth-failure path (no token, bad token, revoked token).

let app: FastifyInstance;
let adminToken: string;

const ADMIN_EMAIL = 'scim-admin@example.com';
const PASSWORD = 'CorrectHorseBattery9';

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  // Order matters — FKs cascade where SetNull, but explicit teardown is safest.
  await prisma.refreshToken.deleteMany();
  await prisma.scimCredential.deleteMany();
  await prisma.directoryGroupMapping.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.directory.deleteMany();

  // Recreate an admin user + admin JWT for every test so directory/SCIM CRUD
  // calls always go through fresh.
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: ADMIN_EMAIL, name: 'Admin', password: PASSWORD },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  adminToken = res.json().accessToken;
});

async function createDirectory(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/settings/directories',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'SCIM-Dir', slug: 'scim-dir', kind: 'SCIM' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function generateScimToken(directoryId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/settings/directories/${directoryId}/scim`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'test' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().rawToken;
}

function scim(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, token: string | null, payload?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/scim+json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.inject({ method, url: `/api/scim/v2${path}`, headers, payload: payload as never });
}

describe('SCIM auth', () => {
  it('rejects missing token (401)', async () => {
    await createDirectory();
    const res = await scim('GET', '/Users', null);
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.schemas[0]).toContain('Error');
    expect(body.status).toBe('401');
  });

  it('rejects an invalid token (401)', async () => {
    await createDirectory();
    const res = await scim('GET', '/Users', 'definitely-not-a-real-token');
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked token (401)', async () => {
    const dir = await createDirectory();
    const token = await generateScimToken(dir);
    await app.inject({
      method: 'DELETE',
      url: `/api/settings/directories/${dir}/scim`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const res = await scim('GET', '/Users', token);
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid token (200)', async () => {
    const dir = await createDirectory();
    const token = await generateScimToken(dir);
    const res = await scim('GET', '/Users', token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('scim+json');
  });
});

describe('SCIM /Users', () => {
  it('lists, creates, fetches, and filters users', async () => {
    const dir = await createDirectory();
    const token = await generateScimToken(dir);

    // Create.
    const create = await scim('POST', '/Users', token, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'jane@example.com',
      name: { givenName: 'Jane', familyName: 'Doe' },
      emails: [{ value: 'jane@example.com', primary: true }],
      active: true,
      externalId: 'idp-jane-001',
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created.userName).toBe('jane@example.com');
    expect(created.externalId).toBe('idp-jane-001');
    expect(created.active).toBe(true);
    expect(created.meta.location).toContain(`/Users/${created.id}`);

    // GET single.
    const get = await scim('GET', `/Users/${created.id}`, token);
    expect(get.statusCode).toBe(200);
    expect(get.json().userName).toBe('jane@example.com');

    // List (no filter).
    const list = await scim('GET', '/Users', token);
    expect(list.statusCode).toBe(200);
    expect(list.json().totalResults).toBe(1);

    // Filter by userName.
    const filtered = await scim('GET', '/Users?filter=userName eq "jane@example.com"', token);
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().totalResults).toBe(1);

    // Filter by externalId.
    const byExt = await scim('GET', '/Users?filter=externalId eq "idp-jane-001"', token);
    expect(byExt.statusCode).toBe(200);
    expect(byExt.json().totalResults).toBe(1);

    // Unsupported filter operator → 400.
    const bad = await scim('GET', '/Users?filter=userName co "jane"', token);
    expect(bad.statusCode).toBe(400);
  });

  it('PATCH active=false soft-disables and revokes refresh tokens', async () => {
    const dir = await createDirectory();
    const token = await generateScimToken(dir);

    const create = await scim('POST', '/Users', token, {
      userName: 'turn-off@example.com',
      name: { givenName: 'Turn', familyName: 'Off' },
      active: true,
      externalId: 'turnoff-001',
    });
    const userId = create.json().id;

    // Seed a refresh token directly so we can confirm revocation.
    const rt = await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: 'hash-' + Math.random().toString(36).slice(2),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    // SCIM PATCH active=false.
    const patch = await scim('PATCH', `/Users/${userId}`, token, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().active).toBe(false);

    // The local User row was soft-disabled (disabledAt set).
    const reread = await prisma.user.findUnique({ where: { id: userId } });
    expect(reread?.disabledAt).toBeTruthy();

    // The refresh token was revoked.
    const rtReread = await prisma.refreshToken.findUnique({ where: { id: rt.id } });
    expect(rtReread?.revokedAt).toBeTruthy();
  });

  it('DELETE removes the user row', async () => {
    const dir = await createDirectory();
    const token = await generateScimToken(dir);
    const create = await scim('POST', '/Users', token, {
      userName: 'delete-me@example.com',
      name: { givenName: 'Del', familyName: 'Eteme' },
    });
    const userId = create.json().id;
    const del = await scim('DELETE', `/Users/${userId}`, token);
    expect(del.statusCode).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
  });
});

describe('SCIM /Groups', () => {
  it('creates a group + members, lists, fetches, and removes a member via PATCH', async () => {
    const dir = await createDirectory();
    const token = await generateScimToken(dir);

    // Pre-create two users so we can add them as members.
    const u1 = (await scim('POST', '/Users', token, {
      userName: 'alpha@example.com',
      name: { givenName: 'Alpha', familyName: 'One' },
    })).json();
    const u2 = (await scim('POST', '/Users', token, {
      userName: 'beta@example.com',
      name: { givenName: 'Beta', familyName: 'Two' },
    })).json();

    // Create group with both members.
    const gres = await scim('POST', '/Groups', token, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Demo Team',
      externalId: 'idp-grp-001',
      members: [
        { value: u1.id, display: 'Alpha' },
        { value: u2.id, display: 'Beta' },
      ],
    });
    expect(gres.statusCode).toBe(201);
    const group = gres.json();
    expect(group.displayName).toBe('Demo Team');
    expect(group.members).toHaveLength(2);

    // List.
    const list = await scim('GET', '/Groups', token);
    expect(list.json().totalResults).toBe(1);

    // Remove one member via PATCH.
    const patch = await scim('PATCH', `/Groups/${group.id}`, token, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'remove', path: `members[value eq "${u1.id}"]` },
      ],
    });
    expect(patch.statusCode).toBe(200);
    const after = patch.json();
    expect(after.members).toHaveLength(1);
    expect(after.members[0].value).toBe(u2.id);
  });
});

describe('SCIM discovery (public)', () => {
  it('GET /ServiceProviderConfig returns the config without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scim/v2/ServiceProviderConfig' });
    expect(res.statusCode).toBe(200);
    expect(res.json().schemas[0]).toContain('ServiceProviderConfig');
  });

  it('GET /ResourceTypes returns Users + Groups', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scim/v2/ResourceTypes' });
    expect(res.statusCode).toBe(200);
    const types = (res.json().Resources as { id: string }[]).map((r) => r.id);
    expect(types).toContain('User');
    expect(types).toContain('Group');
  });
});
