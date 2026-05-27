import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { ensureSystemRoles } from '../lib/teamRoles.js';
import {
  groupResource,
  parsePagination,
  parsePatchOps,
  parseScimFilter,
  userResource,
  type ScimGroupResource,
  type ScimListResponse,
  type ScimMemberRef,
  type ScimUserResource,
  SCIM_LIST_SCHEMA,
} from '../lib/scim.js';

// SCIM Users + Groups, scoped to a single Directory. The directoryId comes
// from `requireScimAuth` so every operation is naturally tenant-isolated:
// a leaked SCIM token can only affect resources within its own directory.

type AnyRecord = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}
function asBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function pickPrimaryEmail(body: AnyRecord): string | undefined {
  if (!Array.isArray(body.emails)) return undefined;
  const emails = body.emails as AnyRecord[];
  const primary = emails.find((e) => e && (e.primary === true)) ?? emails[0];
  return primary ? asString(primary.value) : undefined;
}
function pickName(body: AnyRecord): { givenName?: string; familyName?: string } {
  if (!body.name || typeof body.name !== 'object') return {};
  const n = body.name as AnyRecord;
  return { givenName: asString(n.givenName), familyName: asString(n.familyName) };
}
function combinedName(parts: { displayName?: string; givenName?: string; familyName?: string; userName?: string }): string {
  if (parts.displayName) return parts.displayName;
  const fl = [parts.givenName, parts.familyName].filter(Boolean).join(' ').trim();
  if (fl) return fl;
  return parts.userName ?? '';
}

export class ScimService {
  constructor(private readonly baseUrl: string) {}

  // ── Users ────────────────────────────────────────────────────────────
  async listUsers(
    directoryId: string,
    query: { filter?: string; startIndex?: unknown; count?: unknown },
  ): Promise<ScimListResponse<ScimUserResource>> {
    const { startIndex, count } = parsePagination(query);
    const where: AnyRecord = { directoryId };

    if (query.filter) {
      const f = parseScimFilter(query.filter);
      if (f === null) {
        // No filter. List all.
      } else if (!f.ok) {
        throw Errors.badRequest(f.detail);
      } else {
        switch (f.attribute) {
          case 'userName':
            where.email = f.value;
            break;
          case 'externalId':
            where.externalId = f.value;
            break;
          case 'id':
            where.id = f.value;
            break;
          case 'emails.value':
            where.email = f.value;
            break;
          default:
            throw Errors.badRequest(`Unsupported filter attribute: ${f.attribute}`);
        }
      }
    }

    const [total, rows] = await prisma.$transaction([
      prisma.user.count({ where: where as never }),
      prisma.user.findMany({
        where: where as never,
        orderBy: { createdAt: 'asc' },
        skip: startIndex - 1,
        take: count,
      }),
    ]);
    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((u) => this.userToResource(u)),
    };
  }

  async getUser(directoryId: string, id: string): Promise<ScimUserResource> {
    const u = await prisma.user.findFirst({ where: { id, directoryId } });
    if (!u) throw Errors.notFound('User not found');
    return this.userToResource(u);
  }

  async createUser(directoryId: string, body: AnyRecord): Promise<ScimUserResource> {
    const userName = asString(body.userName);
    if (!userName) throw Errors.badRequest('userName is required');

    const externalId = asString(body.externalId);
    const displayName = asString(body.displayName);
    const name = pickName(body);
    const email = pickPrimaryEmail(body) ?? userName;
    const active = asBoolean(body.active, true);

    // If a user with this externalId already exists in this directory, return
    // it — most IdPs treat the POST/PUT distinction loosely on first sync,
    // and returning the existing row is friendlier than 409.
    if (externalId) {
      const existing = await prisma.user.findFirst({ where: { directoryId, externalId } });
      if (existing) return this.userToResource(existing);
    }
    // Same for userName collisions inside the directory.
    const byEmail = await prisma.user.findFirst({ where: { directoryId, email } });
    if (byEmail) return this.userToResource(byEmail);

    const created = await prisma.user.create({
      data: {
        directoryId,
        externalId: externalId ?? null,
        email,
        name: combinedName({ displayName, ...name, userName }),
        passwordHash: null,
        emailVerifiedAt: new Date(),
        globalRole: (await prisma.user.count()) === 0 ? 'ADMIN' : 'MEMBER',
        disabledAt: active ? null : new Date(),
      },
    });
    return this.userToResource(created);
  }

  // Full-replace PUT. SCIM semantics: every attribute the resource defines
  // is replaced by the supplied value (or cleared, if absent).
  async replaceUser(directoryId: string, id: string, body: AnyRecord): Promise<ScimUserResource> {
    const existing = await prisma.user.findFirst({ where: { id, directoryId } });
    if (!existing) throw Errors.notFound('User not found');

    const userName = asString(body.userName) ?? existing.email;
    const externalId = asString(body.externalId) ?? null;
    const displayName = asString(body.displayName);
    const name = pickName(body);
    const email = pickPrimaryEmail(body) ?? userName;
    const active = asBoolean(body.active, true);

    const updated = await prisma.user.update({
      where: { id },
      data: {
        email,
        externalId,
        name: combinedName({ displayName, ...name, userName }),
        ...(active ? { disabledAt: null } : await this.deprovisionFields(id)),
      },
    });
    return this.userToResource(updated);
  }

  // PATCH — process Operations[]. We only honour the ones IdPs actually
  // send: replace on `active`, replace on top-level scalars (userName,
  // displayName, name.*, emails[primary].value).
  async patchUser(directoryId: string, id: string, body: AnyRecord): Promise<ScimUserResource> {
    const existing = await prisma.user.findFirst({ where: { id, directoryId } });
    if (!existing) throw Errors.notFound('User not found');

    const ops = parsePatchOps(body);
    if (!ops) throw Errors.badRequest('Invalid PATCH body');

    const data: AnyRecord = {};
    for (const op of ops) {
      if (op.op === 'remove') {
        // SCIM remove on `active` is rare; we ignore unsupported removes.
        continue;
      }
      // Path-less replace with an object value — IdP sent the whole user.
      if (!op.path && op.value && typeof op.value === 'object') {
        const v = op.value as AnyRecord;
        if (asString(v.userName)) data.email = asString(v.userName);
        if (asString(v.displayName)) data.name = asString(v.displayName);
        if (typeof v.active === 'boolean') {
          if (v.active === false) Object.assign(data, await this.deprovisionFields(id));
          else data.disabledAt = null;
        }
        continue;
      }
      // Path-scoped replace.
      switch (op.path) {
        case 'active':
          if (op.value === false) Object.assign(data, await this.deprovisionFields(id));
          else data.disabledAt = null;
          break;
        case 'userName':
          if (asString(op.value)) data.email = asString(op.value);
          break;
        case 'displayName':
          if (asString(op.value)) data.name = asString(op.value);
          break;
        case 'name.givenName':
        case 'name.familyName':
          // Skip — we synthesise name from displayName in toResource.
          break;
        default:
          // Unsupported path. Spec says ignore; we accept silently.
          break;
      }
    }
    const updated = await prisma.user.update({ where: { id }, data: data as never });
    return this.userToResource(updated);
  }

  // Hard delete. SCIM IdPs sometimes call DELETE; we soft-disable AND remove
  // the row to mirror what the IdP expects. The TaskHub `User.creatorId`
  // and similar FK constraints SetNull on delete, so activity/comments
  // survive as "(deleted user)".
  async deleteUser(directoryId: string, id: string): Promise<void> {
    const existing = await prisma.user.findFirst({ where: { id, directoryId } });
    if (!existing) throw Errors.notFound('User not found');
    await prisma.user.delete({ where: { id } });
  }

  // ── Groups ───────────────────────────────────────────────────────────
  async listGroups(
    directoryId: string,
    query: { filter?: string; startIndex?: unknown; count?: unknown },
  ): Promise<ScimListResponse<ScimGroupResource>> {
    const { startIndex, count } = parsePagination(query);
    const where: AnyRecord = { directoryId };
    if (query.filter) {
      const f = parseScimFilter(query.filter);
      if (f && !f.ok) throw Errors.badRequest(f.detail);
      if (f && f.ok) {
        switch (f.attribute) {
          case 'displayName': where.name = f.value; break;
          case 'id': where.id = f.value; break;
          default: throw Errors.badRequest(`Unsupported filter attribute: ${f.attribute}`);
        }
      }
    }
    const [total, rows] = await prisma.$transaction([
      prisma.team.count({ where: where as never }),
      prisma.team.findMany({
        where: where as never,
        orderBy: { createdAt: 'asc' },
        skip: startIndex - 1,
        take: count,
        include: { memberships: { include: { user: true } } },
      }),
    ]);
    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((t) => this.groupToResource(t)),
    };
  }

  async getGroup(directoryId: string, id: string): Promise<ScimGroupResource> {
    const t = await prisma.team.findFirst({
      where: { id, directoryId },
      include: { memberships: { include: { user: true } } },
    });
    if (!t) throw Errors.notFound('Group not found');
    return this.groupToResource(t);
  }

  async createGroup(directoryId: string, body: AnyRecord): Promise<ScimGroupResource> {
    const displayName = asString(body.displayName);
    if (!displayName) throw Errors.badRequest('displayName is required');
    const slug = (asString(body.externalId) ?? displayName)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    // Slug collision: tack on a short random suffix.
    const finalSlug = (await prisma.team.findUnique({ where: { slug } }))
      ? `${slug}-${Math.random().toString(36).slice(2, 6)}`
      : slug;

    const memberIds = Array.isArray(body.members)
      ? (body.members as AnyRecord[]).map((m) => asString(m.value)).filter((v): v is string => !!v)
      : [];

    // v1.30.6 (S-6 / S-7): every membership must carry a roleId. Create
    // the team first (without nested memberships) so we have a teamId
    // to seed system roles against; then upsert the memberships with
    // the right roleId.
    const team = await prisma.team.create({
      data: { name: displayName, slug: finalSlug, directoryId },
    });
    if (memberIds.length > 0) {
      const { memberId } = await ensureSystemRoles(team.id);
      for (const uid of memberIds) {
        await prisma.teamMembership.upsert({
          where: { userId_teamId: { userId: uid, teamId: team.id } },
          update: { role: 'MEMBER', roleId: memberId },
          create: { userId: uid, teamId: team.id, role: 'MEMBER', roleId: memberId },
        });
      }
    }
    const reloaded = await prisma.team.findUnique({
      where: { id: team.id },
      include: { memberships: { include: { user: true } } },
    });
    return this.groupToResource(reloaded!);
  }

  async replaceGroup(directoryId: string, id: string, body: AnyRecord): Promise<ScimGroupResource> {
    const existing = await prisma.team.findFirst({ where: { id, directoryId } });
    if (!existing) throw Errors.notFound('Group not found');
    const displayName = asString(body.displayName) ?? existing.name;

    const memberIds = Array.isArray(body.members)
      ? (body.members as AnyRecord[]).map((m) => asString(m.value)).filter((v): v is string => !!v)
      : null;

    // Replace semantics: members list is fully overwritten when provided.
    // v1.30.6 (S-6 / S-7): every recreated membership carries roleId.
    if (memberIds === null) {
      const updated = await prisma.team.update({
        where: { id },
        data: { name: displayName },
        include: { memberships: { include: { user: true } } },
      });
      return this.groupToResource(updated);
    }
    const { memberId } = await ensureSystemRoles(id);
    const updated = await prisma.team.update({
      where: { id },
      data: {
        name: displayName,
        memberships: {
          deleteMany: {},
          create: memberIds.map((uid) => ({
            userId: uid,
            role: 'MEMBER' as const,
            roleId: memberId,
          })),
        },
      },
      include: { memberships: { include: { user: true } } },
    });
    return this.groupToResource(updated);
  }

  // PATCH on Groups — typically members add/remove from Okta/Azure AD.
  async patchGroup(directoryId: string, id: string, body: AnyRecord): Promise<ScimGroupResource> {
    const existing = await prisma.team.findFirst({ where: { id, directoryId } });
    if (!existing) throw Errors.notFound('Group not found');
    const ops = parsePatchOps(body);
    if (!ops) throw Errors.badRequest('Invalid PATCH body');

    for (const op of ops) {
      // Replace whole `displayName`.
      if (op.path === 'displayName' && asString(op.value)) {
        await prisma.team.update({ where: { id }, data: { name: asString(op.value) } });
        continue;
      }
      // Members add: extract value[].value, upsert memberships.
      // v1.30.6 (S-6 / S-7): newly added members must carry roleId.
      // Existing memberships keep their (possibly admin-curated) roleId
      // — we only set roleId on the create branch.
      if (op.op === 'add' && (op.path === 'members' || !op.path) && Array.isArray(op.value)) {
        const ids = (op.value as AnyRecord[]).map((m) => asString(m.value)).filter((v): v is string => !!v);
        if (ids.length > 0) {
          const { memberId } = await ensureSystemRoles(id);
          for (const uid of ids) {
            await prisma.teamMembership.upsert({
              where: { userId_teamId: { userId: uid, teamId: id } },
              update: {},
              create: { userId: uid, teamId: id, role: 'MEMBER', roleId: memberId },
            });
          }
        }
        continue;
      }
      // Members remove: SCIM uses path filter like `members[value eq "..."]`.
      if (op.op === 'remove' && op.path?.startsWith('members')) {
        const m = /value\s+eq\s+"([^"]+)"/.exec(op.path);
        if (m) {
          await prisma.teamMembership
            .delete({ where: { userId_teamId: { userId: m[1]!, teamId: id } } })
            .catch(() => undefined);
        }
        continue;
      }
    }
    return this.getGroup(directoryId, id);
  }

  async deleteGroup(directoryId: string, id: string): Promise<void> {
    const existing = await prisma.team.findFirst({ where: { id, directoryId } });
    if (!existing) throw Errors.notFound('Group not found');
    await prisma.team.delete({ where: { id } });
  }

  // ── Internals ────────────────────────────────────────────────────────
  // Deprovision: set disabledAt + revoke every active refresh token. Used
  // by PUT/PATCH whenever active=false is observed.
  private async deprovisionFields(userId: string): Promise<{ disabledAt: Date }> {
    const now = new Date();
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return { disabledAt: now };
  }

  private userToResource(u: {
    id: string;
    email: string;
    name: string;
    externalId: string | null;
    disabledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): ScimUserResource {
    // We don't store givenName/familyName separately; split name on first
    // space as a best-effort surface for IdPs that read those fields.
    const [given, ...rest] = u.name.split(' ');
    const family = rest.join(' ').trim();
    return userResource({
      id: u.id,
      externalId: u.externalId,
      userName: u.email,
      displayName: u.name,
      name: { givenName: given, familyName: family || undefined },
      emails: [{ value: u.email, primary: true }],
      active: u.disabledAt === null,
      created: u.createdAt,
      lastModified: u.updatedAt,
      baseUrl: this.baseUrl,
    });
  }

  private groupToResource(t: {
    id: string;
    name: string;
    createdAt: Date;
    memberships: { userId: string; user?: { id: string; name: string } | null }[];
  }): ScimGroupResource {
    return groupResource({
      id: t.id,
      displayName: t.name,
      members: t.memberships.map((m): { value: string; display?: string } => ({
        value: m.userId,
        display: m.user?.name,
      })) as ScimMemberRef[],
      created: t.createdAt,
      lastModified: t.createdAt, // Team has no updatedAt projected here.
      baseUrl: this.baseUrl,
    });
  }
}
