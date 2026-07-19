import { randomUUID } from 'node:crypto';
import type { Directory, DirectoryGroupMapping, GlobalRole, TeamRole } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../data/prisma.js';
import type { LdapService } from './ldapService.js';
import { groupDnsMatch, hasEscapedComma, mergeGroupDns, normalizeLdapDn } from '../lib/ldapDn.js';
import { systemRoleIdFor } from '../lib/teamRoles.js';

// v2.6 (Phase 0a): scheduled directory synchronisation.
//
// Group mapping is applied at login only (authService.applyDirectoryGroups),
// so a user who has not signed in since a mapping was entered derives nothing
// from it. Under unit-scoped assignment that user has no unit and therefore no
// supervisor can assign them work — and the population least likely to have
// signed in is exactly the field staff this matters for.
//
// This service evaluates mappings for EVERY user the directory reports,
// independent of login activity.
//
// It deliberately does NOT reuse authService.applyDirectoryGroups. That
// function resolves conflicts by silent precedence ("highest global role
// wins", "last team mapping processed wins"). At an interactive login that is
// tolerable — one user, an admin present to notice. In an unattended job that
// touches every account it is a silent privilege-escalation path, so the rules
// below report conflicts and decline to act instead.
//
// Full rationale, including the revocation and truncation policies:
// docs/DIRECTORY_SYNC.md

export type DirectorySyncConflictCode =
  | 'GLOBAL_ROLE_CONFLICT'
  | 'TEAM_ROLE_CONFLICT'
  | 'MAPPING_TARGET_MISSING'
  | 'MAPPING_DN_COLLISION'
  | 'MAPPING_DN_ESCAPED'
  | 'IDENTITY_COLLISION'
  | 'USER_MISSING_EMAIL'
  | 'LAST_ADMIN_PROTECTED';

export interface DirectorySyncConflict {
  code: DirectorySyncConflictCode;
  message: string;
  userId?: string;
  externalId?: string;
  teamId?: string;
  mappingIds?: string[];
}

export interface DirectorySyncDirectoryResult {
  directoryId: string;
  directorySlug: string;
  status: 'OK' | 'ABORTED' | 'SKIPPED';
  abortReason?: string;

  usersEnumerated: number;
  usersMatched: number;
  /** Enumerated but matched no mapping — the coverage gap Phase 1C gates on. */
  usersUnmatched: number;
  usersProvisioned: number;
  /** Absent locally, but the directory forbids JIT so they were not created. */
  usersSkippedNoJit: number;

  membershipsAdded: number;
  membershipsUpdated: number;
  membershipsRemoved: number;
  globalRolesChanged: number;

  conflicts: DirectorySyncConflict[];
}

export interface DirectorySyncSummary {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  dryRun: boolean;
  directories: DirectorySyncDirectoryResult[];
}

export interface DirectorySyncRunOptions {
  pageSize: number;
  maxUsers: number;
  timeoutSec: number;
  revokeGlobalRole: boolean;
  dryRun: boolean;
}

/** A mapping that survived pre-flight validation. */
interface UsableMapping {
  id: string;
  externalGroupDn: string;
  globalRole: GlobalRole | null;
  teamId: string | null;
  teamRole: TeamRole | null;
  roleId: string | null;
}

interface TeamGrant {
  teamId: string;
  teamRole: TeamRole;
  roleId: string | null;
  mappingIds: string[];
}

function emptyResult(dir: Pick<Directory, 'id' | 'slug'>): DirectorySyncDirectoryResult {
  return {
    directoryId: dir.id,
    directorySlug: dir.slug,
    status: 'OK',
    usersEnumerated: 0,
    usersMatched: 0,
    usersUnmatched: 0,
    usersProvisioned: 0,
    usersSkippedNoJit: 0,
    membershipsAdded: 0,
    membershipsUpdated: 0,
    membershipsRemoved: 0,
    globalRolesChanged: 0,
    conflicts: [],
  };
}

export class DirectorySyncService {
  constructor(
    private readonly ldap: LdapService,
    private readonly logger: FastifyBaseLogger,
  ) {}

  /** Sync every LDAP directory that has opted in. */
  async run(opts: DirectorySyncRunOptions): Promise<DirectorySyncSummary> {
    const runId = randomUUID();
    const startedAt = new Date();

    const directories = await prisma.directory.findMany({
      where: { kind: 'LDAP', syncEnabled: true },
      orderBy: { createdAt: 'asc' },
    });

    const results: DirectorySyncDirectoryResult[] = [];
    for (const dir of directories) {
      results.push(await this.syncDirectory(dir, opts, runId));
    }

    return { runId, startedAt, finishedAt: new Date(), dryRun: opts.dryRun, directories: results };
  }

  /**
   * Sync one directory by id, bypassing the syncEnabled gate.
   *
   * Used by the admin "run now / dry run" endpoint so an operator can rehearse
   * against a directory before opting it in permanently.
   */
  async runForDirectory(
    directoryId: string,
    opts: DirectorySyncRunOptions,
  ): Promise<DirectorySyncSummary> {
    const runId = randomUUID();
    const startedAt = new Date();
    const dir = await prisma.directory.findUnique({ where: { id: directoryId } });

    const directories: DirectorySyncDirectoryResult[] = [];
    if (!dir) {
      // Caller (controller) has already 404'd on a missing directory; this is
      // only reachable on a delete racing the run.
      return { runId, startedAt, finishedAt: new Date(), dryRun: opts.dryRun, directories };
    }
    if (dir.kind !== 'LDAP') {
      directories.push({
        ...emptyResult(dir),
        status: 'SKIPPED',
        abortReason: `directory kind is ${dir.kind}; SCIM directories maintain their own memberships`,
      });
      return { runId, startedAt, finishedAt: new Date(), dryRun: opts.dryRun, directories };
    }

    directories.push(await this.syncDirectory(dir, opts, runId));
    return { runId, startedAt, finishedAt: new Date(), dryRun: opts.dryRun, directories };
  }

  // ------------------------------------------------------------------

  private async syncDirectory(
    dir: Directory,
    opts: DirectorySyncRunOptions,
    runId: string,
  ): Promise<DirectorySyncDirectoryResult> {
    const result = emptyResult(dir);
    const deadline = Date.now() + opts.timeoutSec * 1000;

    try {
      const rawMappings = await prisma.directoryGroupMapping.findMany({
        where: { directoryId: dir.id },
      });

      if (rawMappings.length === 0) {
        result.status = 'SKIPPED';
        result.abortReason = 'no group mappings configured — sync would grant nothing';
        await this.persistState(dir.id, result, opts.dryRun);
        return result;
      }

      const preflight = await this.preflightMappings(rawMappings, result);
      if (preflight === null) {
        // Aborting condition already recorded on `result`.
        await this.persistState(dir.id, result, opts.dryRun);
        return result;
      }
      const mappings = preflight;

      // --- pass 1: paged enumeration --------------------------------
      const enumeration = await this.ldap.enumerateUsers(dir, {
        pageSize: opts.pageSize,
        maxUsers: opts.maxUsers,
      });

      if (enumeration.truncated) {
        // A partial user set is worse than none: every revocation rule below
        // reads "absent from the directory" as "no longer entitled".
        result.status = 'ABORTED';
        result.abortReason =
          enumeration.truncationReason ?? 'directory enumeration was truncated';
        await this.persistState(dir.id, result, opts.dryRun);
        return result;
      }

      result.usersEnumerated = enumeration.users.length;

      // --- pass 2: expand each mapped group's members ---------------
      // Bounded by mapping count, not user count. Skipped when the operator
      // has confirmed memberOf is reliable on this directory.
      const groupMembership = dir.syncTrustMemberOf
        ? new Map<string, string[]>()
        : await this.expandMappedGroups(dir, mappings);

      // --- per-user application -------------------------------------
      const demotionCandidates: { userId: string; email: string }[] = [];

      for (const entry of enumeration.users) {
        if (Date.now() > deadline) {
          result.status = 'ABORTED';
          result.abortReason =
            `exceeded DIRECTORY_SYNC_TIMEOUT_SEC (${opts.timeoutSec}s) after ` +
            `${result.usersMatched + result.usersUnmatched} of ${result.usersEnumerated} users`;
          await this.persistState(dir.id, result, opts.dryRun);
          return result;
        }

        const extraGroups = groupMembership.get(normalizeLdapDn(entry.dn)) ?? [];
        const groups = mergeGroupDns(entry.groups, extraGroups);

        await this.applyUser(dir, mappings, { ...entry, groups }, opts, result, demotionCandidates);
      }

      // --- global-role revocation -----------------------------------
      if (opts.revokeGlobalRole && demotionCandidates.length > 0) {
        await this.applyDemotions(demotionCandidates, opts, result, runId);
      }

      await this.persistState(dir.id, result, opts.dryRun);
      return result;
    } catch (err) {
      result.status = 'ABORTED';
      result.abortReason = (err as Error).message;
      this.logger.error({ err, directoryId: dir.id, runId }, 'directory sync failed');
      await this.persistState(dir.id, result, opts.dryRun).catch(() => undefined);
      return result;
    }
  }

  /**
   * Validate mappings once per run. Returns null when the directory must be
   * aborted outright rather than partially processed.
   */
  private async preflightMappings(
    raw: DirectoryGroupMapping[],
    result: DirectorySyncDirectoryResult,
  ): Promise<UsableMapping[] | null> {
    // DN collisions make every downstream match untrustworthy, so they abort
    // the directory rather than skipping a mapping.
    const byNormalised = new Map<string, string[]>();
    for (const m of raw) {
      const key = normalizeLdapDn(m.externalGroupDn);
      byNormalised.set(key, [...(byNormalised.get(key) ?? []), m.externalGroupDn]);
    }
    for (const [key, dns] of byNormalised) {
      if (dns.length < 2) continue;
      result.status = 'ABORTED';
      result.abortReason = `mapping DN collision on "${key}"`;
      result.conflicts.push({
        code: 'MAPPING_DN_COLLISION',
        message:
          `${dns.length} distinct group DNs normalise to "${key}" — ${dns.join(' | ')}. ` +
          'Members of one group would be matched against a mapping for the other.',
      });
      return null;
    }

    // DirectoryGroupMapping.teamId has NO foreign key — it is a bare string
    // validated only at creation time, so a team deleted afterwards leaves the
    // mapping dangling. Resolve once per run, not once per user.
    const teamIds = [...new Set(raw.map((m) => m.teamId).filter((id): id is string => !!id))];
    const teams = await prisma.team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true },
    });
    const liveTeamIds = new Set(teams.map((t) => t.id));

    const usable: UsableMapping[] = [];
    for (const m of raw) {
      if (hasEscapedComma(m.externalGroupDn)) {
        result.conflicts.push({
          code: 'MAPPING_DN_ESCAPED',
          message:
            `mapping ${m.id} DN contains an RFC 4514 escaped comma (${m.externalGroupDn}); ` +
            'lib/ldapDn.ts does not parse these, so the mapping is skipped rather than guessed at.',
          mappingIds: [m.id],
        });
        continue;
      }
      if (m.teamId && !liveTeamIds.has(m.teamId)) {
        result.conflicts.push({
          code: 'MAPPING_TARGET_MISSING',
          message: `mapping ${m.id} (${m.externalGroupDn}) targets team ${m.teamId}, which no longer exists`,
          mappingIds: [m.id],
          teamId: m.teamId,
        });
        continue;
      }
      if (m.teamId && !m.teamRole) {
        result.conflicts.push({
          code: 'MAPPING_TARGET_MISSING',
          message: `mapping ${m.id} sets teamId without teamRole and grants nothing`,
          mappingIds: [m.id],
          teamId: m.teamId,
        });
        continue;
      }
      usable.push({
        id: m.id,
        externalGroupDn: m.externalGroupDn,
        globalRole: m.globalRole,
        teamId: m.teamId,
        teamRole: m.teamRole,
        roleId: m.roleId,
      });
    }

    return usable;
  }

  /**
   * Pass 2 — read the members of each distinct mapped group.
   *
   * Returns normalised member DN -> group DNs. One search per MAPPED GROUP.
   * The naive alternative (fetchGroups per user) issues an unbounded subtree
   * search per account.
   */
  private async expandMappedGroups(
    dir: Directory,
    mappings: UsableMapping[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const distinct = [...new Set(mappings.map((m) => m.externalGroupDn))];

    for (const groupDn of distinct) {
      let members: string[];
      try {
        members = await this.ldap.fetchGroupMembers(dir, groupDn);
      } catch (err) {
        // A group that cannot be read is an under-grant, not a reason to fail
        // the whole run — memberOf may still cover it.
        this.logger.warn({ err, directoryId: dir.id, groupDn }, 'mapped group expansion failed');
        continue;
      }
      for (const memberDn of members) {
        const key = normalizeLdapDn(memberDn);
        out.set(key, [...(out.get(key) ?? []), groupDn]);
      }
    }

    return out;
  }

  private async applyUser(
    dir: Directory,
    mappings: UsableMapping[],
    entry: { dn: string; email: string; displayName: string; groups: string[] },
    opts: DirectorySyncRunOptions,
    result: DirectorySyncDirectoryResult,
    demotionCandidates: { userId: string; email: string }[],
  ): Promise<void> {
    const matched = mappings.filter((m) => groupDnsMatch(entry.groups, m.externalGroupDn));

    // A user who matches NOTHING is not skipped: they are the leaver case.
    // Removing them from every directory-granted team is exactly what the
    // login path already does (desiredTeamIds empty => toRemove = all mapped
    // teams), so returning early here would make the scheduled job WEAKER than
    // the login it is meant to backstop. We only decline to *provision* an
    // unmatched user, since there would be nothing to grant them.
    const unmatched = matched.length === 0;
    if (unmatched) result.usersUnmatched += 1;
    else result.usersMatched += 1;

    // --- global role: report disagreement, never pick a winner -------
    const globalRoles = [...new Set(matched.map((m) => m.globalRole).filter((r): r is GlobalRole => !!r))];
    let desiredGlobal: GlobalRole | null = null;
    // Tracked separately from `desiredGlobal === null`, because the two mean
    // opposite things downstream: "no mapping grants a role" is a revocation
    // signal, "mappings disagree" must produce NO change at all. Collapsing
    // them would let a conflict demote an admin — the exact silent privilege
    // change this module's header promises not to make.
    let globalRoleConflicted = false;
    if (globalRoles.length > 1) {
      globalRoleConflicted = true;
      result.conflicts.push({
        code: 'GLOBAL_ROLE_CONFLICT',
        message:
          `${entry.email} matches mappings granting different global roles ` +
          `(${globalRoles.join(', ')}); no global-role change applied`,
        externalId: entry.dn,
        mappingIds: matched.filter((m) => m.globalRole).map((m) => m.id),
      });
    } else if (globalRoles.length === 1) {
      desiredGlobal = globalRoles[0]!;
    }

    // --- team grants: one per team, disagreement skips that team -----
    const grants = new Map<string, TeamGrant>();
    const conflictedTeams = new Set<string>();
    for (const m of matched) {
      if (!m.teamId || !m.teamRole) continue;
      const existing = grants.get(m.teamId);
      if (!existing) {
        grants.set(m.teamId, {
          teamId: m.teamId,
          teamRole: m.teamRole,
          roleId: m.roleId,
          mappingIds: [m.id],
        });
        continue;
      }
      if (existing.teamRole !== m.teamRole || (existing.roleId ?? null) !== (m.roleId ?? null)) {
        conflictedTeams.add(m.teamId);
        result.conflicts.push({
          code: 'TEAM_ROLE_CONFLICT',
          message:
            `${entry.email} matches mappings granting different roles in team ${m.teamId}; ` +
            'that team is skipped for this user',
          externalId: entry.dn,
          teamId: m.teamId,
          mappingIds: [...existing.mappingIds, m.id],
        });
        continue;
      }
      existing.mappingIds.push(m.id);
    }
    for (const teamId of conflictedTeams) grants.delete(teamId);

    // --- resolve the local account ----------------------------------
    const existingUser = await prisma.user.findFirst({
      where: { directoryId: dir.id, externalId: entry.dn },
      select: { id: true, email: true, globalRole: true, disabledAt: true },
    });

    let user = existingUser;

    if (!user) {
      // An entry with no usable mail attribute would be provisioned with its
      // DN in User.email — a unique column the rest of the app treats as an
      // address. Service accounts and computer objects that slip past
      // userFilter are the usual source. Report and skip rather than create
      // junk identities that then collide.
      if (!entry.email.includes('@') || entry.email === entry.dn) {
        result.conflicts.push({
          code: 'USER_MISSING_EMAIL',
          message:
            `${entry.dn} has no usable "${dir.emailAttr}" attribute; skipped rather than ` +
            'provisioned with its DN as an email address',
          externalId: entry.dn,
        });
        return;
      }

      const byEmail = await prisma.user.findUnique({
        where: { email: entry.email },
        select: {
          id: true, email: true, globalRole: true, disabledAt: true,
          directoryId: true, authSource: true,
        },
      });

      if (byEmail) {
        // Never merge accounts from a background job. Linking a local account
        // to a directory identity is an administrative decision that needs an
        // audit trail, not something a nightly scan infers from an email match.
        if (byEmail.directoryId !== dir.id || byEmail.authSource !== 'LDAP') {
          result.conflicts.push({
            code: 'IDENTITY_COLLISION',
            message:
              `${entry.email} exists locally as a ${byEmail.authSource} account ` +
              '(different directory or auth source); skipped rather than merged',
            userId: byEmail.id,
            externalId: entry.dn,
          });
          return;
        }
        user = {
          id: byEmail.id,
          email: byEmail.email,
          globalRole: byEmail.globalRole,
          disabledAt: byEmail.disabledAt,
        };
      }
    }

    // Nothing to grant and nothing to revoke — don't create an account for
    // someone no mapping covers.
    if (!user && unmatched) return;

    if (!user) {
      if (!dir.allowJIT) {
        // Respect the directory's existing provisioning policy rather than
        // quietly overriding it. Surfaced in the summary so the operator can
        // see that opting out of JIT also opts out of sync provisioning.
        result.usersSkippedNoJit += 1;
        return;
      }
      result.usersProvisioned += 1;
      if (!opts.dryRun) {
        const created = await prisma.user.create({
          data: {
            email: entry.email,
            name: entry.displayName,
            directoryId: dir.id,
            externalId: entry.dn,
            authSource: 'LDAP',
            ldapSyncedAt: new Date(),
          },
          select: { id: true, email: true, globalRole: true, disabledAt: true },
        });
        user = created;
      } else {
        // Dry run: nothing to mutate below, but the counts above are real.
        return;
      }
    }

    const resolved = user;

    // --- collect a demotion candidate, do not act yet ----------------
    // The last-admin interlock needs the whole run's picture first.
    //
    // Three conditions, each load-bearing:
    //   - !globalRoleConflicted: disagreeing mappings must produce NO change,
    //     never a demotion (see the flag's declaration above)
    //   - disabledAt === null: the interlock counts only ENABLED admins, so
    //     admitting a disabled one here would under-count the survivors and
    //     block demotions that are actually safe
    //   - not already collected: the same account can surface twice if the
    //     directory returns duplicate entries, which would double-subtract
    if (
      !desiredGlobal &&
      !globalRoleConflicted &&
      resolved.globalRole === 'ADMIN' &&
      resolved.disabledAt === null &&
      !demotionCandidates.some((c) => c.userId === resolved.id)
    ) {
      demotionCandidates.push({ userId: resolved.id, email: resolved.email });
    }

    // --- resolve role ids before opening a transaction --------------
    const desiredTeams = [...grants.values()];
    const resolvedRoleIds = new Map<string, string | null>();
    for (const g of desiredTeams) {
      if (g.roleId) {
        resolvedRoleIds.set(g.teamId, g.roleId);
        continue;
      }
      if (opts.dryRun) {
        // systemRoleIdFor CREATES the system roles when absent. A dry run must
        // not write, so read instead and leave it null if it doesn't exist yet.
        const sys = await prisma.role.findFirst({
          where: {
            teamId: g.teamId,
            isSystem: true,
            name: g.teamRole === 'MANAGER' ? 'Manager' : 'Member',
          },
          select: { id: true },
        });
        resolvedRoleIds.set(g.teamId, sys?.id ?? null);
      } else {
        resolvedRoleIds.set(g.teamId, await systemRoleIdFor(g.teamId, g.teamRole));
      }
    }

    // Removal is scoped to teams this directory's mappings reference, exactly
    // as the login path does — teams managed by hand are never touched.
    const mappedTeamIds = new Set(mappings.map((m) => m.teamId).filter((id): id is string => !!id));
    const desiredTeamIds = new Set(desiredTeams.map((g) => g.teamId));
    const toRemove = [...mappedTeamIds].filter(
      (id) => !desiredTeamIds.has(id) && !conflictedTeams.has(id),
    );

    const current = await prisma.teamMembership.findMany({
      where: { userId: resolved.id },
      select: { teamId: true, role: true, roleId: true },
    });
    const currentByTeam = new Map(current.map((m) => [m.teamId, m]));

    let added = 0;
    let updated = 0;
    for (const g of desiredTeams) {
      const existing = currentByTeam.get(g.teamId);
      const roleId = resolvedRoleIds.get(g.teamId) ?? null;
      if (!existing) {
        added += 1;
        continue;
      }
      // In a dry run a null roleId can mean "the team has no system role YET",
      // not "the live run would write null" — systemRoleIdFor would create it.
      // Counting that as an update would over-report changes in the rehearsal
      // that the real run never makes.
      if (opts.dryRun && roleId === null && existing.roleId !== null) continue;
      if (existing.role !== g.teamRole || (existing.roleId ?? null) !== roleId) updated += 1;
    }
    const removed = toRemove.filter((id) => currentByTeam.has(id)).length;

    result.membershipsAdded += added;
    result.membershipsUpdated += updated;
    result.membershipsRemoved += removed;

    const globalRoleChanges = desiredGlobal && resolved.globalRole !== desiredGlobal ? 1 : 0;
    result.globalRolesChanged += globalRoleChanges;

    if (opts.dryRun) return;

    // One transaction per user. Per user rather than per run: a directory-wide
    // transaction would hold locks for the length of the scan. The login path
    // issues these as separate statements, which is why a concurrent login can
    // currently interleave with itself.
    await prisma.$transaction(async (tx) => {
      if (desiredGlobal && resolved.globalRole !== desiredGlobal) {
        await tx.user.update({
          where: { id: resolved.id },
          data: { globalRole: desiredGlobal },
        });
      }

      for (const g of desiredTeams) {
        const roleId = resolvedRoleIds.get(g.teamId) ?? null;
        await tx.teamMembership.upsert({
          where: { userId_teamId: { userId: resolved.id, teamId: g.teamId } },
          update: { role: g.teamRole, roleId },
          create: { userId: resolved.id, teamId: g.teamId, role: g.teamRole, roleId },
        });
      }

      if (toRemove.length) {
        await tx.teamMembership.deleteMany({
          where: { userId: resolved.id, teamId: { in: toRemove } },
        });
      }

      await tx.user.update({
        where: { id: resolved.id },
        data: { ldapSyncedAt: new Date() },
      });
    });
  }

  /**
   * Global-role demotion, with the last-admin interlock.
   *
   * Never runs on an aborted directory: the caller only reaches this after a
   * complete enumeration, because "absent from the directory" and "we failed
   * to see the whole directory" are indistinguishable downstream.
   */
  private async applyDemotions(
    candidates: { userId: string; email: string }[],
    opts: DirectorySyncRunOptions,
    result: DirectorySyncDirectoryResult,
    runId: string,
  ): Promise<void> {
    const adminCount = await prisma.user.count({
      where: { globalRole: 'ADMIN', disabledAt: null },
    });

    if (adminCount - candidates.length < 1) {
      result.conflicts.push({
        code: 'LAST_ADMIN_PROTECTED',
        message:
          `refusing to demote ${candidates.length} of ${adminCount} global admin(s) — ` +
          'the instance would be left with none. No demotions applied.',
      });
      return;
    }

    result.globalRolesChanged += candidates.length;
    if (opts.dryRun) return;

    for (const c of candidates) {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: c.userId }, data: { globalRole: 'MEMBER' } });
        await tx.securityAuditEvent.create({
          data: {
            kind: 'directory_sync.global_role_revoked',
            actorId: null,
            details: { runId, userId: c.userId, email: c.email, from: 'ADMIN', to: 'MEMBER' },
          },
        });
      });
    }
  }

  /** Record the outcome on the Directory row for the admin UI. */
  private async persistState(
    directoryId: string,
    result: DirectorySyncDirectoryResult,
    dryRun: boolean,
  ): Promise<void> {
    // A dry run must leave no trace, including its own bookkeeping — otherwise
    // "last sync" would claim a sync happened when nothing was applied.
    if (dryRun) return;
    await prisma.directory.update({
      where: { id: directoryId },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: result.status,
        lastSyncSummary: JSON.parse(JSON.stringify(result)),
      },
    });
  }
}
