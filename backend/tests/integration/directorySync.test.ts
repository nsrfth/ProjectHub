import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import {
  DirectorySyncService,
  type DirectorySyncRunOptions,
} from '../../src/services/directorySyncService.js';
import type { LdapEnumerationResult, LdapService } from '../../src/services/ldapService.js';

// v2.6 (Phase 0a) — scheduled directory sync.
//
// LdapService is injected, so the whole scan is exercised against a fake
// directory and none of this needs a live OpenLDAP server. That matters: the
// existing live-LDAP suite sits behind a docker profile gate and does not run
// by default, so correctness pinned only there would verify nothing in CI.
//
// The case that proves the phase's purpose is the first one: a user who has
// NEVER logged in receives memberships. Login-time mapping cannot do that,
// because a user who never logged in has no local row for it to act on.

let app: FastifyInstance;

function fakeLogger() {
  return {
    info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
    trace: () => {}, fatal: () => {}, silent: () => {},
    level: 'silent',
    child: () => fakeLogger(),
  } as unknown as ConstructorParameters<typeof DirectorySyncService>[1];
}

interface FakeUser {
  dn: string;
  email: string;
  displayName?: string;
  groups: string[];
}

/** An LdapService stand-in. Only the two bulk methods are ever called. */
function fakeLdap(opts: {
  users?: FakeUser[];
  truncated?: boolean;
  truncationReason?: string;
  groupMembers?: Record<string, string[]>;
}): LdapService {
  return {
    async enumerateUsers(): Promise<LdapEnumerationResult> {
      if (opts.truncated) {
        return {
          users: [],
          truncated: true,
          truncationReason: opts.truncationReason ?? 'size limit exceeded',
        };
      }
      return {
        truncated: false,
        users: (opts.users ?? []).map((u) => ({
          dn: u.dn,
          email: u.email,
          displayName: u.displayName ?? u.email,
          ldapUsername: null,
          userPrincipalName: null,
          department: null,
          jobTitle: null,
          managerName: null,
          groups: u.groups,
        })),
      };
    },
    async fetchGroupMembers(_dir: unknown, groupDn: string): Promise<string[]> {
      return opts.groupMembers?.[groupDn] ?? [];
    },
  } as unknown as LdapService;
}

const RUN: DirectorySyncRunOptions = {
  pageSize: 500,
  maxUsers: 10000,
  timeoutSec: 300,
  revokeGlobalRole: false,
  dryRun: false,
};

function svc(ldap: LdapService): DirectorySyncService {
  return new DirectorySyncService(ldap, fakeLogger());
}

const rnd = () => Math.random().toString(36).slice(2, 8);

async function makeDirectory(over: Record<string, unknown> = {}) {
  return prisma.directory.create({
    data: {
      name: 'TestLDAP',
      slug: 'sync-ldap-' + rnd(),
      kind: 'LDAP',
      host: 'localhost',
      port: 389,
      useTLS: false,
      syncEnabled: true,
      // Trust memberOf by default so tests don't need pass-2 stubs unless
      // they're specifically exercising it.
      syncTrustMemberOf: true,
      ...over,
    },
  });
}

async function makeTeam(name: string) {
  return prisma.team.create({ data: { name, slug: name.toLowerCase() + '-' + rnd() } });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  process.env.MASTER_KEY ||=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  // Other suites don't wipe Directory in their own beforeEach, and a leftover
  // LDAP directory routes their "unknown user" logins through a JIT bind path.
  await prisma.securityAuditEvent.deleteMany().catch(() => undefined);
  await prisma.rolePermission.deleteMany().catch(() => undefined);
  await prisma.teamMembership.deleteMany().catch(() => undefined);
  await prisma.role.deleteMany().catch(() => undefined);
  await prisma.directoryGroupMapping.deleteMany().catch(() => undefined);
  await prisma.team.deleteMany().catch(() => undefined);
  await prisma.user.deleteMany().catch(() => undefined);
  await prisma.directory.deleteMany().catch(() => undefined);
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.securityAuditEvent.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.directoryGroupMapping.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.directory.deleteMany();
});

describe('directory sync — the phase objective', () => {
  it('grants membership to a user who has NEVER logged in', async () => {
    const dir = await makeDirectory();
    const team = await makeTeam('Network');
    const groupDn = 'CN=Network,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });

    // The crucial precondition: no local row exists for this person. Login-time
    // mapping has nothing to act on; only an enumeration can reach them.
    expect(await prisma.user.count()).toBe(0);

    const summary = await svc(
      fakeLdap({ users: [{ dn: 'CN=Ali,OU=People,DC=test,DC=local', email: 'ali@test.local', groups: [groupDn] }] }),
    ).run(RUN);

    const res = summary.directories[0]!;
    expect(res.status).toBe('OK');
    expect(res.usersProvisioned).toBe(1);
    expect(res.membershipsAdded).toBe(1);

    const user = await prisma.user.findUnique({ where: { email: 'ali@test.local' } });
    expect(user).not.toBeNull();
    expect(user!.authSource).toBe('LDAP');

    const m = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: user!.id, teamId: team.id } },
    });
    expect(m).not.toBeNull();
    expect(m!.role).toBe('MEMBER');
    // roleId must be populated, not left on the legacy fallback path.
    expect(m!.roleId).not.toBeNull();
  });

  it('is idempotent — a second run changes nothing', async () => {
    const dir = await makeDirectory();
    const team = await makeTeam('Security');
    const groupDn = 'CN=Security,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MANAGER' },
    });
    const ldap = fakeLdap({
      users: [{ dn: 'CN=Sara,OU=People,DC=test,DC=local', email: 'sara@test.local', groups: [groupDn] }],
    });

    const first = (await svc(ldap).run(RUN)).directories[0]!;
    expect(first.usersProvisioned).toBe(1);
    expect(first.membershipsAdded).toBe(1);

    const second = (await svc(ldap).run(RUN)).directories[0]!;
    expect(second.usersProvisioned).toBe(0);
    expect(second.membershipsAdded).toBe(0);
    expect(second.membershipsUpdated).toBe(0);
    expect(second.membershipsRemoved).toBe(0);
    expect(second.conflicts).toHaveLength(0);
  });
});

describe('directory sync — conflicts are reported, never silently resolved', () => {
  it('GLOBAL_ROLE_CONFLICT leaves the existing global role untouched', async () => {
    const dir = await makeDirectory();
    const adminGroup = 'CN=Admins,OU=Groups,DC=test,DC=local';
    const memberGroup = 'CN=Staff,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.createMany({
      data: [
        { directoryId: dir.id, externalGroupDn: adminGroup, globalRole: 'ADMIN' },
        { directoryId: dir.id, externalGroupDn: memberGroup, globalRole: 'MEMBER' },
      ],
    });
    await prisma.user.create({
      data: {
        email: 'both@test.local',
        name: 'Both',
        directoryId: dir.id,
        externalId: 'CN=Both,OU=People,DC=test,DC=local',
        authSource: 'LDAP',
        globalRole: 'MEMBER',
      },
    });

    const res = (
      await svc(
        fakeLdap({
          users: [
            {
              dn: 'CN=Both,OU=People,DC=test,DC=local',
              email: 'both@test.local',
              groups: [adminGroup, memberGroup],
            },
          ],
        }),
      ).run(RUN)
    ).directories[0]!;

    expect(res.conflicts.map((c) => c.code)).toContain('GLOBAL_ROLE_CONFLICT');
    expect(res.globalRolesChanged).toBe(0);
    // The login path would silently pick ADMIN here. The job must not.
    const user = await prisma.user.findUnique({ where: { email: 'both@test.local' } });
    expect(user!.globalRole).toBe('MEMBER');
  });

  it('TEAM_ROLE_CONFLICT skips only the disputed team', async () => {
    const dir = await makeDirectory();
    const disputed = await makeTeam('Disputed');
    const clean = await makeTeam('Clean');
    const g1 = 'CN=G1,OU=Groups,DC=test,DC=local';
    const g2 = 'CN=G2,OU=Groups,DC=test,DC=local';
    const g3 = 'CN=G3,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.createMany({
      data: [
        { directoryId: dir.id, externalGroupDn: g1, teamId: disputed.id, teamRole: 'MANAGER' },
        { directoryId: dir.id, externalGroupDn: g2, teamId: disputed.id, teamRole: 'MEMBER' },
        { directoryId: dir.id, externalGroupDn: g3, teamId: clean.id, teamRole: 'MEMBER' },
      ],
    });

    const res = (
      await svc(
        fakeLdap({
          users: [{ dn: 'CN=X,OU=People,DC=test,DC=local', email: 'x@test.local', groups: [g1, g2, g3] }],
        }),
      ).run(RUN)
    ).directories[0]!;

    expect(res.conflicts.map((c) => c.code)).toContain('TEAM_ROLE_CONFLICT');
    const user = await prisma.user.findUnique({ where: { email: 'x@test.local' } });
    const memberships = await prisma.teamMembership.findMany({ where: { userId: user!.id } });
    expect(memberships.map((m) => m.teamId)).toEqual([clean.id]);
  });

  it('MAPPING_TARGET_MISSING skips a mapping whose team was deleted', async () => {
    const dir = await makeDirectory();
    const groupDn = 'CN=Ghost,OU=Groups,DC=test,DC=local';
    // teamId has NO foreign key, so a bogus value persists happily.
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: 'team_deleted_xyz', teamRole: 'MEMBER' },
    });

    const res = (
      await svc(
        fakeLdap({ users: [{ dn: 'CN=Y,OU=People,DC=test,DC=local', email: 'y@test.local', groups: [groupDn] }] }),
      ).run(RUN)
    ).directories[0]!;

    expect(res.conflicts.map((c) => c.code)).toContain('MAPPING_TARGET_MISSING');
    expect(await prisma.teamMembership.count()).toBe(0);
  });

  it('MAPPING_DN_COLLISION aborts the directory and writes nothing', async () => {
    const dir = await makeDirectory();
    const team = await makeTeam('Ops');
    // A GENUINE collision under the corrected normaliser: these two DNs differ
    // only in attribute-type case and in whitespace around the separators,
    // both of which the normaliser folds by design. They are the same group
    // entered twice, and matching either would be ambiguous.
    //
    // Note what is deliberately NOT used here: "CN=Ops Team" vs "CN=ops  team".
    // Those collided under the OLD normaliser (which stripped intra-value
    // whitespace) and are correctly distinct now — using them would test the
    // bug rather than the fix.
    await prisma.directoryGroupMapping.createMany({
      data: [
        { directoryId: dir.id, externalGroupDn: 'CN=Ops Team,OU=G,DC=t,DC=l', teamId: team.id, teamRole: 'MEMBER' },
        { directoryId: dir.id, externalGroupDn: 'cn = Ops Team , ou=G , dc=t,dc=l', teamId: team.id, teamRole: 'MANAGER' },
      ],
    });

    const res = (
      await svc(
        fakeLdap({ users: [{ dn: 'CN=Z,OU=P,DC=t,DC=l', email: 'z@test.local', groups: [] }] }),
      ).run(RUN)
    ).directories[0]!;

    expect(res.status).toBe('ABORTED');
    expect(res.conflicts.map((c) => c.code)).toContain('MAPPING_DN_COLLISION');
    expect(await prisma.user.count()).toBe(0);
  });

  it('distinguishes "Ops Team" from "OpsTeam" — the §5.5 normaliser fix', async () => {
    const dir = await makeDirectory();
    const spaced = await makeTeam('Spaced');
    const solid = await makeTeam('Solid');
    const dnSpaced = 'CN=Ops Team,OU=Groups,DC=test,DC=local';
    const dnSolid = 'CN=OpsTeam,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.createMany({
      data: [
        { directoryId: dir.id, externalGroupDn: dnSpaced, teamId: spaced.id, teamRole: 'MEMBER' },
        { directoryId: dir.id, externalGroupDn: dnSolid, teamId: solid.id, teamRole: 'MEMBER' },
      ],
    });

    const res = (
      await svc(
        fakeLdap({
          users: [{ dn: 'CN=Only,OU=P,DC=test,DC=local', email: 'only@test.local', groups: [dnSolid] }],
        }),
      ).run(RUN)
    ).directories[0]!;

    // Under the old normaliser both mappings shared a key: this would have
    // aborted as a collision, and the user would have matched both teams.
    expect(res.status).toBe('OK');
    const user = await prisma.user.findUnique({ where: { email: 'only@test.local' } });
    const memberships = await prisma.teamMembership.findMany({ where: { userId: user!.id } });
    expect(memberships.map((m) => m.teamId)).toEqual([solid.id]);
  });

  it('IDENTITY_COLLISION never merges a local account into a directory identity', async () => {
    const dir = await makeDirectory();
    const team = await makeTeam('Finance');
    const groupDn = 'CN=Finance,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });
    const local = await prisma.user.create({
      data: { email: 'shared@test.local', name: 'Local Person', authSource: 'LOCAL' },
    });

    const res = (
      await svc(
        fakeLdap({
          users: [{ dn: 'CN=Shared,OU=P,DC=test,DC=local', email: 'shared@test.local', groups: [groupDn] }],
        }),
      ).run(RUN)
    ).directories[0]!;

    expect(res.conflicts.map((c) => c.code)).toContain('IDENTITY_COLLISION');
    const after = await prisma.user.findUnique({ where: { id: local.id } });
    expect(after!.authSource).toBe('LOCAL');
    expect(after!.directoryId).toBeNull();
    expect(await prisma.teamMembership.count()).toBe(0);
  });
});

describe('directory sync — truncation and revocation safety', () => {
  it('aborts on a truncated enumeration and writes nothing', async () => {
    const dir = await makeDirectory();
    const team = await makeTeam('Ghosted');
    const groupDn = 'CN=Ghosted,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });
    const existing = await prisma.user.create({
      data: {
        email: 'stays@test.local',
        name: 'Stays',
        directoryId: dir.id,
        externalId: 'CN=Stays,OU=P,DC=t,DC=l',
        authSource: 'LDAP',
      },
    });
    await prisma.teamMembership.create({
      data: { userId: existing.id, teamId: team.id, role: 'MEMBER' },
    });

    const res = (await svc(fakeLdap({ truncated: true })).run(RUN)).directories[0]!;

    expect(res.status).toBe('ABORTED');
    expect(res.abortReason).toContain('size limit');
    // The membership must survive: a truncated view is indistinguishable from
    // "everyone was removed from the directory".
    expect(await prisma.teamMembership.count()).toBe(1);
  });

  it('suppresses global-role revocation when the run aborted', async () => {
    const dir = await makeDirectory();
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: 'CN=Any,OU=G,DC=t,DC=l', globalRole: 'ADMIN' },
    });
    await prisma.user.create({
      data: {
        email: 'admin1@test.local', name: 'A1', globalRole: 'ADMIN',
        directoryId: dir.id, externalId: 'CN=A1,OU=P,DC=t,DC=l', authSource: 'LDAP',
      },
    });
    await prisma.user.create({
      data: { email: 'admin2@test.local', name: 'A2', globalRole: 'ADMIN' },
    });

    const res = (
      await svc(fakeLdap({ truncated: true })).run({ ...RUN, revokeGlobalRole: true })
    ).directories[0]!;

    expect(res.status).toBe('ABORTED');
    expect(await prisma.user.count({ where: { globalRole: 'ADMIN' } })).toBe(2);
  });

  it('demotes an admin who lost the granting group, when revocation is enabled', async () => {
    const dir = await makeDirectory();
    const team = await makeTeam('Plain');
    const groupDn = 'CN=Plain,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });
    await prisma.user.create({
      data: {
        email: 'demote@test.local', name: 'D', globalRole: 'ADMIN',
        directoryId: dir.id, externalId: 'CN=D,OU=P,DC=t,DC=l', authSource: 'LDAP',
      },
    });
    // A second admin so the interlock does not fire.
    await prisma.user.create({
      data: { email: 'keeper@test.local', name: 'K', globalRole: 'ADMIN' },
    });

    const res = (
      await svc(
        fakeLdap({ users: [{ dn: 'CN=D,OU=P,DC=t,DC=l', email: 'demote@test.local', groups: [groupDn] }] }),
      ).run({ ...RUN, revokeGlobalRole: true })
    ).directories[0]!;

    expect(res.status).toBe('OK');
    const demoted = await prisma.user.findUnique({ where: { email: 'demote@test.local' } });
    expect(demoted!.globalRole).toBe('MEMBER');
    const audit = await prisma.securityAuditEvent.findMany({
      where: { kind: 'directory_sync.global_role_revoked' },
    });
    expect(audit).toHaveLength(1);
  });

  it('LAST_ADMIN_PROTECTED refuses to demote the only remaining admin', async () => {
    const dir = await makeDirectory();
    const team = await makeTeam('Solo');
    const groupDn = 'CN=Solo,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });
    await prisma.user.create({
      data: {
        email: 'only-admin@test.local', name: 'Only', globalRole: 'ADMIN',
        directoryId: dir.id, externalId: 'CN=Only,OU=P,DC=t,DC=l', authSource: 'LDAP',
      },
    });

    const res = (
      await svc(
        fakeLdap({
          users: [{ dn: 'CN=Only,OU=P,DC=t,DC=l', email: 'only-admin@test.local', groups: [groupDn] }],
        }),
      ).run({ ...RUN, revokeGlobalRole: true })
    ).directories[0]!;

    expect(res.conflicts.map((c) => c.code)).toContain('LAST_ADMIN_PROTECTED');
    const still = await prisma.user.findUnique({ where: { email: 'only-admin@test.local' } });
    expect(still!.globalRole).toBe('ADMIN');
  });

  it('a GLOBAL_ROLE_CONFLICT never demotes, even with revocation enabled', async () => {
    // Regression: "mappings disagree" and "no mapping grants a role" both left
    // desiredGlobal null, so a conflicted admin fell into the demotion path —
    // the silent privilege change this service exists to prevent.
    const dir = await makeDirectory();
    const adminGroup = 'CN=Admins,OU=G,DC=t,DC=l';
    const memberGroup = 'CN=Staff,OU=G,DC=t,DC=l';
    await prisma.directoryGroupMapping.createMany({
      data: [
        { directoryId: dir.id, externalGroupDn: adminGroup, globalRole: 'ADMIN' },
        { directoryId: dir.id, externalGroupDn: memberGroup, globalRole: 'MEMBER' },
      ],
    });
    await prisma.user.create({
      data: {
        email: 'conflicted@test.local', name: 'C', globalRole: 'ADMIN',
        directoryId: dir.id, externalId: 'CN=C,OU=P,DC=t,DC=l', authSource: 'LDAP',
      },
    });
    await prisma.user.create({
      data: { email: 'other-admin@test.local', name: 'O', globalRole: 'ADMIN' },
    });

    const res = (
      await svc(
        fakeLdap({
          users: [
            {
              dn: 'CN=C,OU=P,DC=t,DC=l',
              email: 'conflicted@test.local',
              groups: [adminGroup, memberGroup],
            },
          ],
        }),
      ).run({ ...RUN, revokeGlobalRole: true })
    ).directories[0]!;

    expect(res.conflicts.map((c) => c.code)).toContain('GLOBAL_ROLE_CONFLICT');
    const user = await prisma.user.findUnique({ where: { email: 'conflicted@test.local' } });
    expect(user!.globalRole).toBe('ADMIN');
    expect(await prisma.securityAuditEvent.count()).toBe(0);
  });

  it('revokes team membership from a full leaver who matches no mapping', async () => {
    // Regression: an early return on matched.length === 0 meant a user removed
    // from EVERY mapped group kept their memberships forever — making the
    // scheduled job weaker than the login path it backstops.
    const dir = await makeDirectory();
    const team = await makeTeam('Left');
    const groupDn = 'CN=Left,OU=G,DC=t,DC=l';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });
    const leaver = await prisma.user.create({
      data: {
        email: 'leaver@test.local', name: 'L',
        directoryId: dir.id, externalId: 'CN=L,OU=P,DC=t,DC=l', authSource: 'LDAP',
      },
    });
    await prisma.teamMembership.create({
      data: { userId: leaver.id, teamId: team.id, role: 'MEMBER' },
    });

    // Still in the directory, but no longer in the mapped group.
    const res = (
      await svc(
        fakeLdap({ users: [{ dn: 'CN=L,OU=P,DC=t,DC=l', email: 'leaver@test.local', groups: [] }] }),
      ).run(RUN)
    ).directories[0]!;

    expect(res.usersUnmatched).toBe(1);
    expect(res.membershipsRemoved).toBe(1);
    expect(await prisma.teamMembership.count({ where: { userId: leaver.id } })).toBe(0);
  });

  it('skips a directory entry with no usable mail attribute', async () => {
    const dir = await makeDirectory();
    const team = await makeTeam('Svc');
    const groupDn = 'CN=Svc,OU=G,DC=t,DC=l';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });

    // profileFromEntry falls back to the DN when the mail attribute is absent.
    // Provisioning that would put a DN in User.email, a unique column.
    const dn = 'CN=svc-account,OU=Service,DC=t,DC=l';
    const res = (
      await svc(fakeLdap({ users: [{ dn, email: dn, groups: [groupDn] }] })).run(RUN)
    ).directories[0]!;

    expect(res.conflicts.map((c) => c.code)).toContain('USER_MISSING_EMAIL');
    expect(res.usersProvisioned).toBe(0);
    expect(await prisma.user.count()).toBe(0);
  });

  it('revocation stays off by default', async () => {
    const dir = await makeDirectory();
    const team = await makeTeam('Default');
    const groupDn = 'CN=Default,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });
    await prisma.user.create({
      data: {
        email: 'keeps-admin@test.local', name: 'K', globalRole: 'ADMIN',
        directoryId: dir.id, externalId: 'CN=K,OU=P,DC=t,DC=l', authSource: 'LDAP',
      },
    });

    await svc(
      fakeLdap({ users: [{ dn: 'CN=K,OU=P,DC=t,DC=l', email: 'keeps-admin@test.local', groups: [groupDn] }] }),
    ).run(RUN);

    const user = await prisma.user.findUnique({ where: { email: 'keeps-admin@test.local' } });
    expect(user!.globalRole).toBe('ADMIN');
  });
});

describe('directory sync — dry run', () => {
  it('reports what it would do and writes nothing at all', async () => {
    const dir = await makeDirectory();
    const team = await makeTeam('Rehearsal');
    const groupDn = 'CN=Rehearsal,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });

    const res = (
      await svc(
        fakeLdap({ users: [{ dn: 'CN=Dry,OU=P,DC=t,DC=l', email: 'dry@test.local', groups: [groupDn] }] }),
      ).run({ ...RUN, dryRun: true })
    ).directories[0]!;

    expect(res.usersProvisioned).toBe(1);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.teamMembership.count()).toBe(0);

    // A dry run must not even record itself — otherwise "last sync" claims a
    // sync happened when nothing was applied.
    const after = await prisma.directory.findUnique({ where: { id: dir.id } });
    expect(after!.lastSyncAt).toBeNull();
    expect(after!.lastSyncStatus).toBeNull();
  });
});

describe('directory sync — scoping and tenancy', () => {
  it('a mapping for team A never produces a membership in team B', async () => {
    const dir = await makeDirectory();
    const teamA = await makeTeam('Alpha');
    const teamB = await makeTeam('Bravo');
    const groupA = 'CN=Alpha,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupA, teamId: teamA.id, teamRole: 'MEMBER' },
    });

    await svc(
      fakeLdap({ users: [{ dn: 'CN=T,OU=P,DC=t,DC=l', email: 't@test.local', groups: [groupA] }] }),
    ).run(RUN);

    const user = await prisma.user.findUnique({ where: { email: 't@test.local' } });
    const memberships = await prisma.teamMembership.findMany({ where: { userId: user!.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.teamId).toBe(teamA.id);
    expect(await prisma.teamMembership.count({ where: { teamId: teamB.id } })).toBe(0);
  });

  it('skips SCIM directories entirely', async () => {
    const dir = await makeDirectory({ kind: 'SCIM' });
    const summary = await svc(fakeLdap({ users: [] })).run(RUN);
    // run() filters on kind LDAP, so a SCIM directory is never even visited.
    expect(summary.directories).toHaveLength(0);

    // The explicit per-directory path reports why rather than silently no-oping.
    const direct = await svc(fakeLdap({ users: [] })).runForDirectory(dir.id, RUN);
    expect(direct.directories[0]!.status).toBe('SKIPPED');
    expect(direct.directories[0]!.abortReason).toContain('SCIM');
  });

  it('skips a directory that has not opted in', async () => {
    await makeDirectory({ syncEnabled: false });
    const summary = await svc(fakeLdap({ users: [] })).run(RUN);
    expect(summary.directories).toHaveLength(0);
  });

  it('does not provision when the directory forbids JIT, and says so', async () => {
    const dir = await makeDirectory({ allowJIT: false });
    const team = await makeTeam('NoJit');
    const groupDn = 'CN=NoJit,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });

    const res = (
      await svc(
        fakeLdap({ users: [{ dn: 'CN=N,OU=P,DC=t,DC=l', email: 'n@test.local', groups: [groupDn] }] }),
      ).run(RUN)
    ).directories[0]!;

    expect(res.usersSkippedNoJit).toBe(1);
    expect(res.usersProvisioned).toBe(0);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('directory sync — pass 2 group expansion', () => {
  it('finds membership via mapped-group expansion when memberOf is empty', async () => {
    // OpenLDAP without the memberof overlay: the user entry carries no
    // memberOf at all, so pass 1 alone would grant nothing.
    const dir = await makeDirectory({ syncTrustMemberOf: false });
    const team = await makeTeam('Overlayless');
    const groupDn = 'CN=Overlayless,OU=Groups,DC=test,DC=local';
    await prisma.directoryGroupMapping.create({
      data: { directoryId: dir.id, externalGroupDn: groupDn, teamId: team.id, teamRole: 'MEMBER' },
    });

    const userDn = 'CN=Hidden,OU=People,DC=test,DC=local';
    const res = (
      await svc(
        fakeLdap({
          users: [{ dn: userDn, email: 'hidden@test.local', groups: [] }],
          groupMembers: { [groupDn]: [userDn] },
        }),
      ).run(RUN)
    ).directories[0]!;

    expect(res.membershipsAdded).toBe(1);
    const user = await prisma.user.findUnique({ where: { email: 'hidden@test.local' } });
    const m = await prisma.teamMembership.findFirst({ where: { userId: user!.id } });
    expect(m!.teamId).toBe(team.id);
  });
});
