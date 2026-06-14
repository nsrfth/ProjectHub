import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { AuthService } from '../../src/services/authService.js';

// v1.30.6 (S-6 / S-7) regression suite.
//
// The original LDAP test sits behind a live-OpenLDAP gate (the docker
// `ldap` profile must be running, and the CI service container was the
// long-standing S-21 problem this codebase tracks). Putting the roleId
// assertions there would mean they never run by default — exactly the
// "verifies nothing" failure the user called out.
//
// The actual bug is DB-driven: applyDirectoryGroups takes a list of
// group DNs (already extracted from the LDAP bind), looks up
// DirectoryGroupMapping rows for the directory, and upserts the
// resulting TeamMembership rows. None of that needs a live LDAP
// server. v1.30.6 made `applyDirectoryGroups` a public method on
// AuthService for exactly this reason; the LDAP integration test
// remains as the end-to-end smoke when OpenLDAP IS available, but the
// roleId correctness is pinned here.

let app: FastifyInstance;
let authService: AuthService;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  process.env.MASTER_KEY ||=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
  // applyDirectoryGroups doesn't need any signer — it's a pure DB
  // operation — but the AuthService constructor requires the signer
  // bundle. Wire the same closures buildApp's auth route uses so the
  // instance is functionally identical to the real one.
  authService = new AuthService(loadEnv(), {
    signAccess: app.signAccess.bind(app),
    signRefresh: app.signRefresh.bind(app),
    verifyRefresh: app.verifyRefresh.bind(app),
    signPending: app.signPending.bind(app),
    verifyPending: app.verifyPending.bind(app),
  });
});

afterAll(async () => {
  // Tear down so other test files (e.g. auth.test.ts) that don't wipe
  // Directory in their own beforeEach don't see our leftover LDAP
  // directory rows — which would otherwise route their "unknown user"
  // login through a JIT bind path and surface a 400 instead of the
  // expected 401.
  await prisma.rolePermission.deleteMany().catch(() => undefined);
  await prisma.teamMembership.deleteMany().catch(() => undefined);
  await prisma.role.deleteMany().catch(() => undefined);
  await prisma.directoryGroupMapping.deleteMany().catch(() => undefined);
  await prisma.team.deleteMany().catch(() => undefined);
  await prisma.directory.deleteMany().catch(() => undefined);
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.directoryGroupMapping.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.team.deleteMany();
  await prisma.directory.deleteMany();
  await prisma.user.deleteMany();
});

async function setupDirectoryAndUser(): Promise<{
  directoryId: string;
  userId: string;
  teamId: string;
}> {
  const dir = await prisma.directory.create({
    data: {
      name: 'TestLDAP',
      slug: 'test-ldap-' + Math.random().toString(36).slice(2, 6),
      kind: 'LDAP',
      host: 'localhost',
      port: 389,
      useTLS: false,
      // syncRolesFromGroups MUST be true for applyDirectoryGroups to
      // do anything — otherwise it short-circuits.
      syncRolesFromGroups: true,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: 'ldap-user@example.com',
      name: 'LDAP User',
      directoryId: dir.id,
      externalId: 'uid=ldap-user,ou=People,dc=test,dc=local',
      globalRole: 'MEMBER',
    },
  });
  const team = await prisma.team.create({
    data: { name: 'Team Alpha', slug: 'team-alpha-' + Math.random().toString(36).slice(2, 6) },
  });
  return { directoryId: dir.id, userId: user.id, teamId: team.id };
}

describe('S-6 / S-7 directory group mappings populate roleId', () => {
  it('JIT-provisioned membership has roleId pointing at the team system Member role', async () => {
    const { directoryId, userId, teamId } = await setupDirectoryAndUser();
    const groupDn = 'cn=team-alpha-members,ou=Groups,dc=test,dc=local';
    await prisma.directoryGroupMapping.create({
      data: {
        directoryId,
        externalGroupDn: groupDn,
        teamId,
        teamRole: 'MEMBER',
        // roleId intentionally NULL — the service must derive the team's
        // system Member role.
      },
    });

    await authService.applyDirectoryGroups(userId, directoryId, [groupDn]);

    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe('MEMBER');
    expect(membership!.roleId).not.toBeNull();
    // The system Member role for this team was auto-created.
    const memberRole = await prisma.role.findUnique({
      where: { id: membership!.roleId! },
    });
    expect(memberRole).not.toBeNull();
    expect(memberRole!.teamId).toBe(teamId);
    expect(memberRole!.name).toBe('Member');
    expect(memberRole!.isSystem).toBe(true);
  });

  it('JIT-provisioned MANAGER mapping resolves to the team system Manager role', async () => {
    const { directoryId, userId, teamId } = await setupDirectoryAndUser();
    const groupDn = 'cn=team-alpha-managers,ou=Groups,dc=test,dc=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId, externalGroupDn: groupDn, teamId, teamRole: 'MANAGER' },
    });

    await authService.applyDirectoryGroups(userId, directoryId, [groupDn]);

    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    expect(membership!.roleId).not.toBeNull();
    const role = await prisma.role.findUnique({ where: { id: membership!.roleId! } });
    expect(role!.name).toBe('Manager');
    expect(role!.isSystem).toBe(true);
  });

  it('mapping with an explicit custom roleId honors it AND a second sync does NOT downgrade', async () => {
    const { directoryId, userId, teamId } = await setupDirectoryAndUser();
    // The bug this test pins: pre-v1.30.6, a second LDAP login for a
    // user whose mapping carried a custom role wrote `role` (the
    // legacy enum) onto the membership but left `roleId` either null
    // or stomped by the system default. Here the mapping carries an
    // explicit custom roleId; both syncs must preserve it.
    const customRole = await prisma.role.create({
      data: {
        teamId,
        name: 'QA Lead',
        description: 'Custom role wired up via SCIM/LDAP mapping',
        isSystem: false,
        permissions: { create: [{ permission: 'task.delete' }] },
      },
    });
    const groupDn = 'cn=qa-leads,ou=Groups,dc=test,dc=local';
    await prisma.directoryGroupMapping.create({
      data: {
        directoryId,
        externalGroupDn: groupDn,
        teamId,
        teamRole: 'MEMBER',
        roleId: customRole.id,
      },
    });

    // First sync.
    await authService.applyDirectoryGroups(userId, directoryId, [groupDn]);
    let m = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    expect(m!.roleId).toBe(customRole.id);

    // Second sync — must NOT downgrade.
    await authService.applyDirectoryGroups(userId, directoryId, [groupDn]);
    m = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    expect(m!.roleId).toBe(customRole.id);
  });

  it('removing a user from the LDAP group on a subsequent sync revokes the membership', async () => {
    // Sanity: the existing strip-stale-memberships logic still works
    // after the roleId change. Not a security fix on its own; the
    // assertion guards against an accidental regression while we were
    // poking applyDirectoryGroups.
    const { directoryId, userId, teamId } = await setupDirectoryAndUser();
    const groupDn = 'cn=team-alpha-members,ou=Groups,dc=test,dc=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId, externalGroupDn: groupDn, teamId, teamRole: 'MEMBER' },
    });

    await authService.applyDirectoryGroups(userId, directoryId, [groupDn]);
    expect(
      await prisma.teamMembership.findUnique({
        where: { userId_teamId: { userId, teamId } },
      }),
    ).not.toBeNull();

    // User no longer in that LDAP group on the next bind.
    await authService.applyDirectoryGroups(userId, directoryId, []);
    expect(
      await prisma.teamMembership.findUnique({
        where: { userId_teamId: { userId, teamId } },
      }),
    ).toBeNull();
  });

  it('mapping with syncRolesFromGroups=false is a no-op (existing fallback)', async () => {
    const { directoryId, userId, teamId } = await setupDirectoryAndUser();
    await prisma.directory.update({
      where: { id: directoryId },
      data: { syncRolesFromGroups: false },
    });
    const groupDn = 'cn=team-alpha-members,ou=Groups,dc=test,dc=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId, externalGroupDn: groupDn, teamId, teamRole: 'MEMBER' },
    });
    await authService.applyDirectoryGroups(userId, directoryId, [groupDn]);
    expect(
      await prisma.teamMembership.findUnique({
        where: { userId_teamId: { userId, teamId } },
      }),
    ).toBeNull();
  });

  it('matches group DNs case-insensitively (AD memberOf vs admin mapping)', async () => {
    const { directoryId, userId, teamId } = await setupDirectoryAndUser();
    const mappingDn = 'CN=Team-Alpha-Members,OU=Groups,DC=modalalco,DC=com';
    await prisma.directoryGroupMapping.create({
      data: { directoryId, externalGroupDn: mappingDn, teamId, teamRole: 'MEMBER' },
    });
    const adMemberOf = 'cn=team-alpha-members,ou=groups,dc=modalalco,dc=com';
    await authService.applyDirectoryGroups(userId, directoryId, [adMemberOf]);

    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe('MEMBER');
    expect(membership!.roleId).not.toBeNull();
  });
});
