import type { Directory } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { encrypt } from '../lib/crypto.js';
import type {
  DirectoryCreateBody,
  DirectoryUpdateBody,
  GroupMappingCreateBody,
} from '../schemas/directories.js';

// View shape returned upward — deliberately excludes bindPasswordEnc and
// translates it to a boolean `hasBindPassword` so callers can render
// "configured / not configured" without ever seeing the ciphertext.
export interface DirectoryView {
  id: string;
  name: string;
  slug: string;
  kind: Directory['kind'];
  host: string | null;
  port: number | null;
  useTLS: boolean;
  tlsInsecure: boolean;
  bindDN: string | null;
  hasBindPassword: boolean;
  baseDN: string | null;
  userFilter: string | null;
  groupFilter: string | null;
  userIdAttr: string;
  emailAttr: string;
  nameAttr: string;
  groupMemberAttr: string;
  allowJIT: boolean;
  syncRolesFromGroups: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toView(d: Directory): DirectoryView {
  return {
    id: d.id,
    name: d.name,
    slug: d.slug,
    kind: d.kind,
    host: d.host,
    port: d.port,
    useTLS: d.useTLS,
    tlsInsecure: d.tlsInsecure,
    bindDN: d.bindDN,
    hasBindPassword: !!d.bindPasswordEnc,
    baseDN: d.baseDN,
    userFilter: d.userFilter,
    groupFilter: d.groupFilter,
    userIdAttr: d.userIdAttr,
    emailAttr: d.emailAttr,
    nameAttr: d.nameAttr,
    groupMemberAttr: d.groupMemberAttr,
    allowJIT: d.allowJIT,
    syncRolesFromGroups: d.syncRolesFromGroups,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export class DirectoryService {
  async list(): Promise<DirectoryView[]> {
    const rows = await prisma.directory.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toView);
  }

  async get(id: string): Promise<DirectoryView> {
    const row = await prisma.directory.findUnique({ where: { id } });
    if (!row) throw Errors.notFound('Directory not found');
    return toView(row);
  }

  async create(input: DirectoryCreateBody): Promise<DirectoryView> {
    const existing = await prisma.directory.findUnique({ where: { slug: input.slug } });
    if (existing) throw Errors.conflict('Directory slug already in use');
    const row = await prisma.directory.create({
      data: {
        name: input.name,
        slug: input.slug,
        kind: input.kind,
        host: input.host ?? null,
        port: input.port ?? null,
        useTLS: input.useTLS,
        tlsInsecure: input.tlsInsecure,
        bindDN: input.bindDN ?? null,
        bindPasswordEnc: input.bindPassword ? encrypt(input.bindPassword) : null,
        baseDN: input.baseDN ?? null,
        userFilter: input.userFilter ?? null,
        groupFilter: input.groupFilter ?? null,
        userIdAttr: input.userIdAttr,
        emailAttr: input.emailAttr,
        nameAttr: input.nameAttr,
        groupMemberAttr: input.groupMemberAttr,
        allowJIT: input.allowJIT,
        syncRolesFromGroups: input.syncRolesFromGroups,
      },
    });
    return toView(row);
  }

  async update(id: string, input: DirectoryUpdateBody): Promise<DirectoryView> {
    const existing = await prisma.directory.findUnique({ where: { id } });
    if (!existing) throw Errors.notFound('Directory not found');

    // Build the patch carefully. Undefined keys are skipped (Prisma semantics).
    // The bindPassword field is special: undefined = keep existing, empty
    // string = clear, anything else = encrypt + replace.
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.slug !== undefined && input.slug !== existing.slug) {
      const clash = await prisma.directory.findUnique({ where: { slug: input.slug } });
      if (clash) throw Errors.conflict('Directory slug already in use');
      data.slug = input.slug;
    }
    if (input.kind !== undefined) data.kind = input.kind;
    if (input.host !== undefined) data.host = input.host;
    if (input.port !== undefined) data.port = input.port;
    if (input.useTLS !== undefined) data.useTLS = input.useTLS;
    if (input.tlsInsecure !== undefined) data.tlsInsecure = input.tlsInsecure;
    if (input.bindDN !== undefined) data.bindDN = input.bindDN;
    if (input.bindPassword !== undefined) {
      data.bindPasswordEnc = input.bindPassword === '' ? null : encrypt(input.bindPassword);
    }
    if (input.baseDN !== undefined) data.baseDN = input.baseDN;
    if (input.userFilter !== undefined) data.userFilter = input.userFilter;
    if (input.groupFilter !== undefined) data.groupFilter = input.groupFilter;
    if (input.userIdAttr !== undefined) data.userIdAttr = input.userIdAttr;
    if (input.emailAttr !== undefined) data.emailAttr = input.emailAttr;
    if (input.nameAttr !== undefined) data.nameAttr = input.nameAttr;
    if (input.groupMemberAttr !== undefined) data.groupMemberAttr = input.groupMemberAttr;
    if (input.allowJIT !== undefined) data.allowJIT = input.allowJIT;
    if (input.syncRolesFromGroups !== undefined) data.syncRolesFromGroups = input.syncRolesFromGroups;

    const row = await prisma.directory.update({ where: { id }, data });
    return toView(row);
  }

  async delete(id: string): Promise<void> {
    const existing = await prisma.directory.findUnique({ where: { id } });
    if (!existing) throw Errors.notFound('Directory not found');
    // Cascade: User.directoryId is SetNull-on-delete, so users survive but
    // are left without an LDAP binding (they become login-disabled because
    // their passwordHash is also null). Manual cleanup is the admin's call.
    await prisma.directory.delete({ where: { id } });
  }

  // Group mappings ---------------------------------------------------------

  async listMappings(directoryId: string) {
    await this.get(directoryId); // 404 if directory missing
    return prisma.directoryGroupMapping.findMany({
      where: { directoryId },
      orderBy: { externalGroupDn: 'asc' },
    });
  }

  async createMapping(directoryId: string, input: GroupMappingCreateBody) {
    await this.get(directoryId);
    // Sanity: at least one of (globalRole, teamRole+teamId) must be set.
    const hasGlobal = !!input.globalRole;
    const hasTeam = !!input.teamRole && !!input.teamId;
    if (!hasGlobal && !hasTeam) {
      throw Errors.badRequest('Mapping must grant either a globalRole or a (teamId + teamRole)');
    }
    if (hasTeam && !!input.teamId) {
      const team = await prisma.team.findUnique({ where: { id: input.teamId } });
      if (!team) throw Errors.badRequest('teamId references a non-existent team');
    }
    // v1.30.6 (S-6 / S-7): when an explicit roleId is supplied, verify
    // it belongs to the mapping's team — otherwise a typo (or a malicious
    // admin) could pin a membership to a role row in a different team.
    if (input.roleId) {
      if (!input.teamId) {
        throw Errors.badRequest('roleId requires teamId on the same mapping');
      }
      const role = await prisma.role.findUnique({ where: { id: input.roleId } });
      if (!role || role.teamId !== input.teamId) {
        throw Errors.badRequest('roleId does not belong to the mapping team');
      }
    }
    return prisma.directoryGroupMapping.create({
      data: {
        directoryId,
        externalGroupDn: input.externalGroupDn,
        globalRole: input.globalRole,
        teamId: input.teamId,
        teamRole: input.teamRole,
        roleId: input.roleId,
      },
    });
  }

  async deleteMapping(directoryId: string, mappingId: string) {
    await this.get(directoryId);
    const m = await prisma.directoryGroupMapping.findUnique({ where: { id: mappingId } });
    if (!m || m.directoryId !== directoryId) throw Errors.notFound('Mapping not found');
    await prisma.directoryGroupMapping.delete({ where: { id: mappingId } });
  }

  // Internal — used by LdapService. Returns the raw Directory row including
  // the ciphertext field, NOT for upward-facing responses.
  async getRaw(id: string): Promise<Directory> {
    const row = await prisma.directory.findUnique({ where: { id } });
    if (!row) throw Errors.notFound('Directory not found');
    return row;
  }

  // Look up a directory by slug. Used by login to attempt LDAP for a given
  // email/slug pair (or the lone-directory case).
  async findBySlug(slug: string): Promise<Directory | null> {
    return prisma.directory.findUnique({ where: { slug } });
  }

  // All active LDAP directories, in creation order. Used for login fan-out:
  // when an email doesn't match any local user, the auth service can try
  // each directory in turn for a JIT bind.
  async listActiveLdap(): Promise<Directory[]> {
    return prisma.directory.findMany({
      where: { kind: 'LDAP' },
      orderBy: { createdAt: 'asc' },
    });
  }
}
