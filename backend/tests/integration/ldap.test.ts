import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'ldapts';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// LDAP integration test. Requires OpenLDAP reachable at LDAP_TEST_URL
// (default ldap://localhost:1389). In CI it's a service container; locally
// run `docker compose --profile ldap up -d openldap` first.
//
// The test seeds the directory tree at suite start (idempotent — re-seeding
// is harmless) so it works against either a fresh CI service or a long-
// lived dev container.

const LDAP_URL = process.env.LDAP_TEST_URL ?? 'ldap://localhost:1389';
const BIND_DN = process.env.LDAP_TEST_BIND_DN ?? 'cn=admin,dc=taskhub,dc=local';
const BIND_PASSWORD = process.env.LDAP_TEST_BIND_PASSWORD ?? 'adminpass';
const BASE_DN = process.env.LDAP_TEST_BASE_DN ?? 'dc=taskhub,dc=local';

const ldapEnabled = (() => {
  // Skip the whole suite when LDAP_TEST_URL is explicitly disabled — lets
  // contributors who don't have openldap running locally run `npm test`
  // without a failing file. Set LDAP_TEST_SKIP=1 to suppress.
  return process.env.LDAP_TEST_SKIP !== '1';
})();

let app: FastifyInstance;

async function seedLdap(): Promise<void> {
  // Connect and create the org units + users + groups. Each `add` is wrapped
  // because re-running the test against a long-lived OpenLDAP would fail on
  // "entry already exists" — that's not an error condition.
  const client = new Client({ url: LDAP_URL, timeout: 5000 });
  await client.bind(BIND_DN, BIND_PASSWORD);
  const adds = [
    {
      dn: `ou=People,${BASE_DN}`,
      attrs: { objectClass: 'organizationalUnit', ou: 'People' },
    },
    {
      dn: `ou=Groups,${BASE_DN}`,
      attrs: { objectClass: 'organizationalUnit', ou: 'Groups' },
    },
    {
      dn: `uid=alice,ou=People,${BASE_DN}`,
      attrs: {
        objectClass: 'inetOrgPerson',
        uid: 'alice', cn: 'Alice Ng', sn: 'Ng',
        mail: 'alice@taskhub.local',
        userPassword: 'AlicePass1!',
      },
    },
    {
      dn: `uid=bob,ou=People,${BASE_DN}`,
      attrs: {
        objectClass: 'inetOrgPerson',
        uid: 'bob', cn: 'Bob Park', sn: 'Park',
        mail: 'bob@taskhub.local',
        userPassword: 'BobPass1!',
      },
    },
    {
      dn: `uid=eve,ou=People,${BASE_DN}`,
      attrs: {
        objectClass: 'inetOrgPerson',
        uid: 'eve', cn: 'Eve Outsider', sn: 'Outsider',
        mail: 'eve@taskhub.local',
        userPassword: 'EvePass1!',
      },
    },
    {
      dn: `cn=taskhub-admins,ou=Groups,${BASE_DN}`,
      attrs: {
        objectClass: 'groupOfNames',
        cn: 'taskhub-admins',
        member: `uid=alice,ou=People,${BASE_DN}`,
      },
    },
    {
      dn: `cn=taskhub-members,ou=Groups,${BASE_DN}`,
      attrs: {
        objectClass: 'groupOfNames',
        cn: 'taskhub-members',
        member: `uid=bob,ou=People,${BASE_DN}`,
      },
    },
  ];
  for (const a of adds) {
    try {
      await client.add(a.dn, a.attrs);
    } catch (e) {
      // ldapts throws an AlreadyExistsError (LDAP code 68) when the entry's
      // already there — that's expected on re-runs against a long-lived
      // OpenLDAP. Anything else propagates.
      const name = (e as Error).name;
      if (name !== 'AlreadyExistsError') {
        await client.unbind().catch(() => undefined);
        throw e;
      }
    }
  }
  await client.unbind();
}

beforeAll(async () => {
  if (!ldapEnabled) return;
  // Ensure MASTER_KEY is set so DirectoryService can encrypt the bind password.
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  await seedLdap();
  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  // Guard against beforeAll bailing — app might never have been built.
  if (app) await app.close();
});

beforeEach(async () => {
  if (!ldapEnabled) return;
  await prisma.refreshToken.deleteMany();
  await prisma.directoryGroupMapping.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.directory.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

async function createDirectory(): Promise<string> {
  // Seed an admin so the directory CRUD endpoint accepts the call. The first
  // bootstrapped user gets ADMIN.
  const reg = await bootstrapUser(app, { email: 'root@taskhub.local', name: 'Root', password: 'CorrectHorseBattery9' });
  const token: string = reg.token;

  const url = new URL(LDAP_URL);
  const create = await inject({
    method: 'POST',
    url: '/api/settings/directories',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: 'TestLDAP',
      slug: 'test-ldap',
      kind: 'LDAP',
      host: url.hostname,
      port: Number(url.port || 389),
      useTLS: false,
      bindDN: BIND_DN,
      bindPassword: BIND_PASSWORD,
      baseDN: BASE_DN,
      userIdAttr: 'uid',
      emailAttr: 'mail',
      nameAttr: 'cn',
      groupMemberAttr: 'member',
      allowJIT: true,
      syncRolesFromGroups: true,
    },
  });
  expect(create.statusCode).toBe(201);
  const directoryId: string = create.json().id;

  // Map the LDAP groups to TaskHub roles.
  const addMapping = (body: Record<string, unknown>) =>
    inject({
      method: 'POST',
      url: `/api/settings/directories/${directoryId}/mappings`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  const m1 = await addMapping({
    externalGroupDn: `cn=taskhub-admins,ou=Groups,${BASE_DN}`,
    globalRole: 'ADMIN',
    teamId: null,
    teamRole: null,
  });
  expect(m1.statusCode).toBe(201);
  const m2 = await addMapping({
    externalGroupDn: `cn=taskhub-members,ou=Groups,${BASE_DN}`,
    globalRole: 'MEMBER',
    teamId: null,
    teamRole: null,
  });
  expect(m2.statusCode).toBe(201);

  return directoryId;
}

describe.skipIf(!ldapEnabled)('LDAP integration', () => {
  it('JIT-provisions an LDAP user on first login and assigns the mapped global role', async () => {
    await createDirectory();
    const res = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@taskhub.local', password: 'AlicePass1!' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe('alice@taskhub.local');
    expect(body.user.directoryId).toBeTruthy();
    expect(body.user.externalId).toContain('uid=alice');
    expect(body.user.globalRole).toBe('ADMIN'); // taskhub-admins → ADMIN
  });

  it('assigns the mapped MEMBER role for a non-admin group member', async () => {
    await createDirectory();
    const res = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'bob@taskhub.local', password: 'BobPass1!' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.globalRole).toBe('MEMBER');
  });

  it('rejects an invalid LDAP password with 401', async () => {
    await createDirectory();
    const res = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@taskhub.local', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an LDAP user who isn't in the directory at all", async () => {
    await createDirectory();
    const res = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@taskhub.local', password: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('keeps an LDAP user with no mapped group at their default role (MEMBER)', async () => {
    await createDirectory();
    // Eve is in no group, so syncRolesFromGroups finds no mappings and the
    // newly-provisioned user keeps the default MEMBER role.
    const res = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'eve@taskhub.local', password: 'EvePass1!' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.globalRole).toBe('MEMBER');
  });
});
