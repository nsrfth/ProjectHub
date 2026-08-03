import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { AdminService } from '../../src/services/adminService.js';
import { AuthService } from '../../src/services/authService.js';
import { ScimService } from '../../src/services/scimService.js';
import { DirectorySyncService } from '../../src/services/directorySyncService.js';
import type { LdapEnumerationResult, LdapService } from '../../src/services/ldapService.js';
import { ENABLED_ADMIN_WHERE } from '../../src/lib/adminInvariant.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v2.23.3 (S-14): the last-enabled-administrator invariant under
// concurrency.
//
// Every admin-removing path used to count administrators in one
// statement and mutate in another. Two administrators acting at the same
// moment both read "2 admins", both concluded "safe", and both removed
// the other — leaving an instance nobody can administer, which cannot be
// repaired from inside the app.
//
// These tests fire the two operations CONCURRENTLY. Prisma's pool hands
// each call its own connection, so the two transactions are genuinely
// separate — which is the only way to exercise the advisory lock (a
// process-local mutex would pass a same-connection test and still lose in
// production, where several backend processes run).
//
// The invariant asserted after every case is the same one the app
// depends on: at least one User with globalRole=ADMIN, disabledAt IS
// NULL, isSystemUser=false.

let app: FastifyInstance;
const admin = new AdminService();
const scim = new ScimService('http://localhost:4000/scim/v2');

const PASSWORD = 'CorrectHorseBattery9';

beforeAll(async () => {
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.securityAuditEvent.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function makeAdmins(): Promise<{ a: string; b: string }> {
  const a = await bootstrapUser(app, {
    email: 'a@example.com',
    name: 'Admin A',
    password: PASSWORD,
    globalRole: 'ADMIN',
  });
  const b = await bootstrapUser(app, {
    email: 'b@example.com',
    name: 'Admin B',
    password: PASSWORD,
    globalRole: 'ADMIN',
  });
  return { a: a.userId, b: b.userId };
}

async function enabledAdminCount(): Promise<number> {
  return prisma.user.count({ where: ENABLED_ADMIN_WHERE });
}

/** Run both operations at once and report how many succeeded. */
async function race(
  first: Promise<unknown>,
  second: Promise<unknown>,
): Promise<{ fulfilled: number; rejected: unknown[] }> {
  const results = await Promise.allSettled([first, second]);
  return {
    fulfilled: results.filter((r) => r.status === 'fulfilled').length,
    rejected: results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason),
  };
}

describe('S-14 last-enabled-admin invariant under concurrency', () => {
  it('two admins demoting each other: exactly one succeeds', async () => {
    const { a, b } = await makeAdmins();
    // Each demotes the OTHER, so neither trips the self-demotion guard.
    const { fulfilled, rejected } = await race(
      admin.updateUserRole(a, b, 'MEMBER'),
      admin.updateUserRole(b, a, 'MEMBER'),
    );
    expect(fulfilled).toBe(1);
    expect((rejected[0] as { statusCode: number }).statusCode).toBe(409);
    expect(await enabledAdminCount()).toBe(1);
  });

  it('two admins disabling each other: exactly one succeeds', async () => {
    const { a, b } = await makeAdmins();
    const { fulfilled, rejected } = await race(
      admin.setUserDisabled(a, b, true),
      admin.setUserDisabled(b, a, true),
    );
    expect(fulfilled).toBe(1);
    expect((rejected[0] as { statusCode: number }).statusCode).toBe(409);
    expect(await enabledAdminCount()).toBe(1);
  });

  it('two admins deleting each other: exactly one succeeds', async () => {
    const { a, b } = await makeAdmins();
    const { fulfilled, rejected } = await race(
      admin.deleteUser(a, b),
      admin.deleteUser(b, a),
    );
    expect(fulfilled).toBe(1);
    expect((rejected[0] as { statusCode: number }).statusCode).toBe(409);
    expect(await enabledAdminCount()).toBe(1);
  });

  it('a demotion racing a deletion cannot remove both administrators', async () => {
    const { a, b } = await makeAdmins();
    const { fulfilled } = await race(admin.updateUserRole(a, b, 'MEMBER'), admin.deleteUser(b, a));
    expect(fulfilled).toBe(1);
    expect(await enabledAdminCount()).toBe(1);
  });

  it('a SCIM deprovision racing an admin demotion cannot remove both', async () => {
    const dir = await prisma.directory.create({
      data: { name: 'IdP', slug: `idp-${Date.now()}`, host: 'ldap.test' },
    });
    const a = await bootstrapUser(app, {
      email: 'scim-a@example.com',
      name: 'A',
      password: PASSWORD,
      globalRole: 'ADMIN',
    });
    const b = await bootstrapUser(app, {
      email: 'scim-b@example.com',
      name: 'B',
      password: PASSWORD,
      globalRole: 'ADMIN',
    });
    // B is the directory-owned account the IdP can deprovision.
    await prisma.user.update({
      where: { id: b.userId },
      data: { directoryId: dir.id, authSource: 'SCIM' },
    });

    const { fulfilled } = await race(
      // IdP: active=false on B.
      scim.patchUser(dir.id, b.userId, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
      // Admin: demote A.
      admin.updateUserRole(b.userId, a.userId, 'MEMBER'),
    );
    expect(fulfilled).toBe(1);
    expect(await enabledAdminCount()).toBe(1);
    await prisma.directory.deleteMany({ where: { id: dir.id } });
  });

  it('a directory-sync demotion racing an admin demotion cannot remove both', async () => {
    // Real sync run: the mapping says "this group is MEMBER", so the
    // directory-owned admin is a demotion candidate. Meanwhile an admin
    // demotes the OTHER administrator from the UI.
    const dir = await prisma.directory.create({
      data: {
        name: 'SyncRace',
        slug: `sync-race-${Date.now()}`,
        kind: 'LDAP',
        host: 'localhost',
        port: 389,
        useTLS: false,
        syncEnabled: true,
        syncTrustMemberOf: true,
      },
    });
    const groupDn = 'CN=Staff,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, globalRole: 'MEMBER' },
    });
    const dirAdmin = await prisma.user.create({
      data: {
        email: 'sync-admin@test.local',
        name: 'Sync Admin',
        globalRole: 'ADMIN',
        directoryId: dir.id,
        externalId: 'CN=SyncAdmin,OU=People,DC=test,DC=local',
        authSource: 'LDAP',
      },
    });
    const localAdmin = await bootstrapUser(app, {
      email: 'local-admin@example.com',
      name: 'Local Admin',
      password: PASSWORD,
      globalRole: 'ADMIN',
    });

    const sync = new DirectorySyncService(
      fakeLdap([
        {
          dn: 'CN=SyncAdmin,OU=People,DC=test,DC=local',
          email: 'sync-admin@test.local',
          groups: [groupDn],
        },
      ]),
      fakeLogger(),
    );

    await race(
      sync.run({
        pageSize: 500,
        maxUsers: 10_000,
        timeoutSec: 300,
        revokeGlobalRole: false,
        dryRun: false,
      }),
      admin.updateUserRole(dirAdmin.id, localAdmin.userId, 'MEMBER'),
    );

    // Whichever ordering the two transactions took, exactly one demotion
    // landed and an administrator is still standing.
    expect(await enabledAdminCount()).toBe(1);
    const roles = await prisma.user.findMany({
      where: { id: { in: [dirAdmin.id, localAdmin.userId] } },
      select: { globalRole: true },
    });
    expect(roles.filter((r) => r.globalRole === 'ADMIN')).toHaveLength(1);
    await prisma.directoryGroupMapping.deleteMany({ where: { directoryId: dir.id } });
    await prisma.directory.deleteMany({ where: { id: dir.id } });
  });

  it('records a security-audit event when the invariant blocks an operation', async () => {
    const { a, b } = await makeAdmins();
    await admin.updateUserRole(a, b, 'MEMBER');
    await expect(admin.updateUserRole(b, a, 'MEMBER')).rejects.toMatchObject({ statusCode: 409 });
    const kinds = await prisma.securityAuditEvent.findMany({ select: { kind: true } });
    expect(kinds.map((k) => k.kind)).toContain('admin.last_admin_protected');
  });

  it('a blocked operation leaves NO partial change (role, tokens, audit trail)', async () => {
    const { a, b } = await makeAdmins();
    await admin.updateUserRole(a, b, 'MEMBER'); // now `a` is the only admin
    const before = await prisma.refreshToken.count({ where: { userId: a, revokedAt: null } });
    await expect(admin.updateUserRole(b, a, 'MEMBER')).rejects.toMatchObject({ statusCode: 409 });
    const after = await prisma.user.findUnique({ where: { id: a } });
    expect(after!.globalRole).toBe('ADMIN');
    // The token revocation is inside the same transaction, so it rolled
    // back with the refused role change.
    expect(await prisma.refreshToken.count({ where: { userId: a, revokedAt: null } })).toBe(before);
    expect(
      await prisma.activity.count({ where: { action: 'admin.user.role_changed' } }),
    ).toBe(1);
  });

  it('a disabled admin does not count as a survivor', async () => {
    const { a, b } = await makeAdmins();
    // Disable B: A is now the only ENABLED admin.
    await admin.setUserDisabled(a, b, true);
    expect(await enabledAdminCount()).toBe(1);
    // Deleting A must be refused even though a second ADMIN row exists.
    await expect(admin.deleteUser(b, a)).rejects.toMatchObject({ statusCode: 409 });
    // …and so must demoting A.
    await expect(admin.updateUserRole(b, a, 'MEMBER')).rejects.toMatchObject({ statusCode: 409 });
    expect(await enabledAdminCount()).toBe(1);
  });

  it('demoting an ALREADY DISABLED admin is allowed — it removes no enabled admin', async () => {
    const { a, b } = await makeAdmins();
    await admin.setUserDisabled(a, b, true);
    await expect(admin.updateUserRole(a, b, 'MEMBER')).resolves.toMatchObject({
      globalRole: 'MEMBER',
    });
    expect(await enabledAdminCount()).toBe(1);
  });

  it('SCIM cannot disable or delete the last enabled administrator', async () => {
    const dir = await prisma.directory.create({
      data: { name: 'IdP2', slug: `idp2-${Date.now()}`, host: 'ldap.test' },
    });
    const solo = await bootstrapUser(app, {
      email: 'solo@example.com',
      name: 'Solo',
      password: PASSWORD,
      globalRole: 'ADMIN',
    });
    await prisma.user.update({
      where: { id: solo.userId },
      data: { directoryId: dir.id, authSource: 'SCIM' },
    });
    await expect(
      scim.patchUser(dir.id, solo.userId, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(scim.deleteUser(dir.id, solo.userId)).rejects.toMatchObject({ statusCode: 409 });
    expect(await enabledAdminCount()).toBe(1);
    await prisma.directory.deleteMany({ where: { id: dir.id } });
  });

  it('an LDAP login whose group mapping says MEMBER cannot demote the last enabled admin', async () => {
    // The login-time mapping runs unattended on every sign-in. It must
    // not be the thing that empties the admin population — but it must
    // also not fail the login when it is refused.
    const dir = await prisma.directory.create({
      data: {
        name: 'LoginIdP',
        slug: `login-idp-${Date.now()}`,
        kind: 'LDAP',
        host: 'ldap.test',
        syncRolesFromGroups: true,
      },
    });
    const groupDn = 'CN=Staff,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, globalRole: 'MEMBER' },
    });
    const solo = await bootstrapUser(app, {
      email: 'ldap-solo@example.com',
      name: 'Solo',
      password: PASSWORD,
      globalRole: 'ADMIN',
    });
    await prisma.user.update({
      where: { id: solo.userId },
      data: { directoryId: dir.id, authSource: 'LDAP' },
    });

    // applyDirectoryGroups is a pure DB operation, but the constructor
    // wants the signer bundle — same wiring directoryGroupMappings.test.ts
    // uses.
    const auth = new AuthService(loadEnv(), {
      signAccess: app.signAccess.bind(app),
      signRefresh: app.signRefresh.bind(app),
      verifyRefresh: app.verifyRefresh.bind(app),
      signPending: app.signPending.bind(app),
      verifyPending: app.verifyPending.bind(app),
    });
    // Does not throw: the login continues, the demotion is skipped.
    await auth.applyDirectoryGroups(solo.userId, dir.id, [groupDn]);
    const after = await prisma.user.findUnique({ where: { id: solo.userId } });
    expect(after!.globalRole).toBe('ADMIN');
    expect(await enabledAdminCount()).toBe(1);
    const kinds = await prisma.securityAuditEvent.findMany({ select: { kind: true } });
    expect(kinds.map((k) => k.kind)).toContain('admin.last_admin_protected');

    // With a second administrator present the same mapping DOES demote.
    await bootstrapUser(app, {
      email: 'ldap-second@example.com',
      name: 'Second',
      password: PASSWORD,
      globalRole: 'ADMIN',
    });
    await auth.applyDirectoryGroups(solo.userId, dir.id, [groupDn]);
    const demoted = await prisma.user.findUnique({ where: { id: solo.userId } });
    expect(demoted!.globalRole).toBe('MEMBER');
    expect(await enabledAdminCount()).toBe(1);

    await prisma.directoryGroupMapping.deleteMany({ where: { directoryId: dir.id } });
    await prisma.directory.deleteMany({ where: { id: dir.id } });
  });

  it('self-demotion, self-disable and self-delete stay blocked', async () => {
    const { a } = await makeAdmins();
    await expect(admin.updateUserRole(a, a, 'MEMBER')).rejects.toMatchObject({ statusCode: 409 });
    await expect(admin.setUserDisabled(a, a, true)).rejects.toMatchObject({ statusCode: 409 });
    await expect(admin.deleteUser(a, a)).rejects.toMatchObject({ statusCode: 409 });
    expect(await enabledAdminCount()).toBe(2);
  });
});

// ── directory-sync doubles ───────────────────────────────────────────
// Same shape as directorySync.test.ts: the LdapService is injected, so a
// full sync run needs no LDAP server.
function fakeLogger(): ConstructorParameters<typeof DirectorySyncService>[1] {
  const log = {
    info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
    trace: () => {}, fatal: () => {}, silent: () => {},
    level: 'silent',
    child: () => log,
  };
  return log as unknown as ConstructorParameters<typeof DirectorySyncService>[1];
}

function fakeLdap(users: { dn: string; email: string; groups: string[] }[]): LdapService {
  return {
    async enumerateUsers(): Promise<LdapEnumerationResult> {
      return {
        truncated: false,
        users: users.map((u) => ({
          dn: u.dn,
          email: u.email,
          displayName: u.email,
          ldapUsername: null,
          userPrincipalName: null,
          department: null,
          jobTitle: null,
          managerName: null,
          groups: u.groups,
        })),
      };
    },
    async fetchGroupMembers(): Promise<string[]> {
      return [];
    },
  } as unknown as LdapService;
}
