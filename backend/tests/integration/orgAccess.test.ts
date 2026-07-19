import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv, resetEnvCacheForTests } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { resolveProjectAccess } from '../../src/lib/projectAccess.js';
import { applyOrgGrantPolicies, resolveGrantSubjects } from '../../src/lib/projectGrants.js';
import { DirectorySyncService } from '../../src/services/directorySyncService.js';
import type { LdapEnumerationResult, LdapService } from '../../src/services/ldapService.js';

// v2.9 (Phases 4+5) — org membership sync, subtree grant resolution, policies.

let app: FastifyInstance;
const rnd = () => Math.random().toString(36).slice(2, 8);

function setGrants(mode: 'off' | 'dual' | 'on'): void {
  process.env.ACCESS_UNIFIED_GRANTS = mode;
  resetEnvCacheForTests();
}

function fakeLogger() {
  return {
    info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
    trace: () => {}, fatal: () => {}, silent: () => {}, level: 'silent',
    child: () => fakeLogger(),
  } as unknown as ConstructorParameters<typeof DirectorySyncService>[1];
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  process.env.MASTER_KEY ||=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  setGrants('off');
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  setGrants('off');
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.orgUnitGrantPolicy.deleteMany();
  await prisma.orgUnitMembership.deleteMany();
  await prisma.projectAccessGrant.deleteMany();
  await prisma.directoryGroupMapping.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.project.deleteMany();
  await prisma.orgUnit.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.directory.deleteMany();
  setGrants('off');
});

/** Two-root tree: MDL (with site KVSM) and SBC. Returns nodes with real paths. */
async function makeTree() {
  const mdl = await prisma.orgUnit.create({
    data: { type: 'HOLDING', name: 'MDL', code: `MDL-${rnd()}`, path: 'pending' },
  });
  await prisma.orgUnit.update({ where: { id: mdl.id }, data: { path: `/${mdl.id}` } });
  const kvsm = await prisma.orgUnit.create({
    data: { type: 'SITE', name: 'KVSM', code: `KVSM-${rnd()}`, parentId: mdl.id, path: 'pending' },
  });
  await prisma.orgUnit.update({ where: { id: kvsm.id }, data: { path: `/${mdl.id}/${kvsm.id}` } });
  const sbc = await prisma.orgUnit.create({
    data: { type: 'HOLDING', name: 'SBC', code: `SBC-${rnd()}`, path: 'pending' },
  });
  await prisma.orgUnit.update({ where: { id: sbc.id }, data: { path: `/${sbc.id}` } });
  return {
    mdl: { ...mdl, path: `/${mdl.id}` },
    kvsm: { ...kvsm, path: `/${mdl.id}/${kvsm.id}` },
    sbc: { ...sbc, path: `/${sbc.id}` },
  };
}

describe('Phase 4 — org membership sync', () => {
  function ldapWith(users: { dn: string; email: string; groups: string[] }[]): LdapService {
    return {
      async enumerateUsers(): Promise<LdapEnumerationResult> {
        return {
          truncated: false,
          users: users.map((u) => ({
            dn: u.dn, email: u.email, displayName: u.email,
            ldapUsername: null, userPrincipalName: null,
            department: null, jobTitle: null, managerName: null, groups: u.groups,
          })),
        };
      },
      async fetchGroupMembers(): Promise<string[]> { return []; },
    } as unknown as LdapService;
  }
  const RUN = { pageSize: 500, maxUsers: 10000, timeoutSec: 300, revokeGlobalRole: false, dryRun: false };

  it('places, moves, and never touches MANUAL rows', async () => {
    const { mdl, kvsm } = await makeTree();
    const dir = await prisma.directory.create({
      data: {
        name: 'AD', slug: `ad-${rnd()}`, kind: 'LDAP', host: 'x', port: 389,
        useTLS: false, syncEnabled: true, syncTrustMemberOf: true,
      },
    });
    const team = await prisma.team.create({ data: { name: `T-${rnd()}`, slug: `t-${rnd()}` } });
    const gKvsm = 'CN=KVSM,OU=G,DC=t,DC=l';
    const gMdl = 'CN=HQ,OU=G,DC=t,DC=l';
    await prisma.directoryGroupMapping.createMany({
      data: [
        { directoryId: dir.id, externalGroupDn: gKvsm, teamId: team.id, teamRole: 'MEMBER', orgUnitId: kvsm.id },
        { directoryId: dir.id, externalGroupDn: gMdl, teamId: team.id, teamRole: 'MEMBER', orgUnitId: mdl.id },
      ],
    });

    // First run: user is at the KVSM site.
    const res1 = (
      await new DirectorySyncService(
        ldapWith([{ dn: 'CN=W,OU=P,DC=t,DC=l', email: 'w@t.local', groups: [gKvsm] }]),
        fakeLogger(),
      ).run(RUN)
    ).directories[0]!;
    expect(res1.orgMembershipsAssigned).toBe(1);
    const user = await prisma.user.findUnique({ where: { email: 'w@t.local' } });

    // An admin ALSO places them manually at MDL HQ.
    await prisma.orgUnitMembership.create({
      data: { orgUnitId: mdl.id, userId: user!.id, source: 'MANUAL' },
    });

    // Second run: AD moved them to the HQ group. SYNC row moves; the MANUAL
    // row for the same node absorbs the add (upsert no-op), KVSM SYNC row goes.
    const res2 = (
      await new DirectorySyncService(
        ldapWith([{ dn: 'CN=W,OU=P,DC=t,DC=l', email: 'w@t.local', groups: [gMdl] }]),
        fakeLogger(),
      ).run(RUN)
    ).directories[0]!;
    expect(res2.orgMembershipsRemoved).toBe(1);
    const rows = await prisma.orgUnitMembership.findMany({ where: { userId: user!.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgUnitId).toBe(mdl.id);
    expect(rows[0]!.source).toBe('MANUAL'); // admin's row untouched
  });
});

describe('Phase 5 — ORG_UNIT grants resolve downward via the path', () => {
  it('a grant on the holding covers a site member; roots are isolated', async () => {
    const { mdl, kvsm, sbc } = await makeTree();
    const team = await prisma.team.create({ data: { name: `T-${rnd()}`, slug: `t-${rnd()}` } });
    const owner = await prisma.user.create({ data: { email: `o-${rnd()}@t.local`, name: 'O' } });
    const siteWorker = await prisma.user.create({ data: { email: `s-${rnd()}@t.local`, name: 'S' } });
    const sbcWorker = await prisma.user.create({ data: { email: `x-${rnd()}@t.local`, name: 'X' } });
    const project = await prisma.project.create({
      data: { name: `P-${rnd()}`, teamId: team.id, ownerId: owner.id },
    });
    await prisma.orgUnitMembership.create({ data: { orgUnitId: kvsm.id, userId: siteWorker.id } });
    await prisma.orgUnitMembership.create({ data: { orgUnitId: sbc.id, userId: sbcWorker.id } });

    // Grant on the MDL ROOT.
    await prisma.projectAccessGrant.create({
      data: { projectId: project.id, subjectType: 'ORG_UNIT', subjectId: mdl.id, level: 'READ' },
    });

    // Subject resolution: the site worker satisfies KVSM and its ancestor MDL.
    const subjects = await resolveGrantSubjects(siteWorker.id);
    expect(subjects.orgUnitIds).toContain(mdl.id);
    expect(subjects.orgUnitIds).toContain(kvsm.id);

    setGrants('on');
    expect(await resolveProjectAccess(project.id, team.id, siteWorker.id, 'MEMBER')).toBe('READ');
    // Structural isolation: no SBC path contains MDL's id.
    expect(await resolveProjectAccess(project.id, team.id, sbcWorker.id, 'MEMBER')).toBe('NONE');
  });
});

describe('Phase 5 — policies materialize on org attach', () => {
  it('applies subtree policies with sourcePolicyId; sibling subtrees untouched; bulk-revocable', async () => {
    const { mdl, kvsm, sbc } = await makeTree();
    const team = await prisma.team.create({ data: { name: `T-${rnd()}`, slug: `t-${rnd()}` } });
    const owner = await prisma.user.create({ data: { email: `o-${rnd()}@t.local`, name: 'O' } });
    const pmoTeam = await prisma.team.create({ data: { name: `PMO-${rnd()}`, slug: `pmo-${rnd()}` } });

    // Per-root policy: "new MDL projects auto-grant TEAM:PMO READ".
    const policy = await prisma.orgUnitGrantPolicy.create({
      data: {
        name: 'MDL PMO oversight', anchorOrgUnitId: mdl.id,
        subjectType: 'TEAM', subjectId: pmoTeam.id, level: 'READ',
      },
    });

    // A project attached under the MDL subtree (at the KVSM site) gets it…
    const p1 = await prisma.project.create({
      data: { name: `P1-${rnd()}`, teamId: team.id, ownerId: owner.id, orgUnitId: kvsm.id },
    });
    expect(await applyOrgGrantPolicies(p1.id, kvsm.id)).toBe(1);
    const g1 = await prisma.projectAccessGrant.findFirst({ where: { projectId: p1.id } });
    expect(g1?.sourcePolicyId).toBe(policy.id);
    expect(g1?.source).toBe('policy');

    // …applying twice is a no-op…
    expect(await applyOrgGrantPolicies(p1.id, kvsm.id)).toBe(1);
    expect(await prisma.projectAccessGrant.count({ where: { projectId: p1.id } })).toBe(1);

    // …an SBC project does not (sibling-root negative).
    const p2 = await prisma.project.create({
      data: { name: `P2-${rnd()}`, teamId: team.id, ownerId: owner.id, orgUnitId: sbc.id },
    });
    expect(await applyOrgGrantPolicies(p2.id, sbc.id)).toBe(0);

    // Bulk revoke by stamp — even after the policy row is deleted.
    await prisma.orgUnitGrantPolicy.delete({ where: { id: policy.id } });
    const res = await prisma.projectAccessGrant.deleteMany({
      where: { sourcePolicyId: policy.id },
    });
    expect(res.count).toBe(1);
  });
});
