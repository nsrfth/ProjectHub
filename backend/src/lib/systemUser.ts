import type { TeamMembership, User } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from './errors.js';
import { DEFAULT_MANAGER_PERMISSIONS } from './permissions.js';
import { ensureSystemRoles, systemRoleIdFor } from './teamRoles.js';
import { logActivity } from '../services/activityLogger.js';

/** Canonical email for the hidden system team manager. */
export const SYSTEM_USER_EMAIL = 'admin@taskhub.local';

let cachedSystemUserId: string | null | undefined;

export function clearSystemUserCache(): void {
  cachedSystemUserId = undefined;
}

export async function getSystemUser(): Promise<User | null> {
  return prisma.user.findFirst({
    where: { email: { equals: SYSTEM_USER_EMAIL, mode: 'insensitive' } },
  });
}

export async function getSystemUserId(): Promise<string | null> {
  if (cachedSystemUserId !== undefined) return cachedSystemUserId;
  const u = await getSystemUser();
  cachedSystemUserId = u?.id ?? null;
  return cachedSystemUserId;
}

export function isSystemUser(
  user: Pick<User, 'isSystemUser' | 'email'> | { isSystemUser?: boolean; email?: string },
): boolean {
  if (user.isSystemUser) return true;
  return (user.email ?? '').toLowerCase() === SYSTEM_USER_EMAIL;
}

export function isSystemUserId(userId: string, systemUserId: string | null): boolean {
  return !!systemUserId && userId === systemUserId;
}

export async function assertNotSystemUserTarget(
  targetUserId: string,
  message = 'This system account cannot be modified',
): Promise<void> {
  const systemUserId = await getSystemUserId();
  if (isSystemUserId(targetUserId, systemUserId)) {
    throw Errors.conflict(message);
  }
}

export function maskActorName(
  actor: Pick<User, 'name' | 'isSystemUser' | 'email'> | null | undefined,
  actorId: string | null,
): string | null {
  if (!actorId) return null;
  if (actor && isSystemUser(actor)) return null;
  return actor?.name ?? '(deleted user)';
}

export function filterVisibleMembers<T extends { userId: string }>(
  members: T[],
  systemUserId: string | null,
): T[] {
  if (!systemUserId) return members;
  return members.filter((m) => m.userId !== systemUserId);
}

/** Managers excluding the hidden system account (for last-manager guards). */
export async function countHumanManagers(teamId: string): Promise<number> {
  const systemUserId = await getSystemUserId();
  return prisma.teamMembership.count({
    where: {
      teamId,
      role: 'MANAGER',
      ...(systemUserId ? { userId: { not: systemUserId } } : {}),
    },
  });
}

/**
 * Idempotently ensure admin@taskhub.local is MANAGER on the given team.
 * No-op when the system user row does not exist yet (e.g. empty test DB).
 */
export async function ensureSystemManagerOnTeam(teamId: string): Promise<'created' | 'exists' | 'skipped'> {
  const systemUser = await getSystemUser();
  if (!systemUser) return 'skipped';

  await ensureSystemRoles(teamId);
  const managerRoleId = await systemRoleIdFor(teamId, 'MANAGER');

  const existing = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId: systemUser.id, teamId } },
  });
  if (existing) {
    if (existing.role !== 'MANAGER' || existing.roleId !== managerRoleId) {
      await prisma.teamMembership.update({
        where: { userId_teamId: { userId: systemUser.id, teamId } },
        data: { role: 'MANAGER', roleId: managerRoleId },
      });
    }
    return 'exists';
  }

  await prisma.teamMembership.create({
    data: {
      userId: systemUser.id,
      teamId,
      role: 'MANAGER',
      roleId: managerRoleId,
    },
  });
  return 'created';
}

/** Backfill hidden system manager on every existing team. Safe to run on every boot. */
export async function bootstrapSystemManagerOnAllTeams(): Promise<{
  created: number;
  teams: number;
}> {
  const teams = await prisma.team.findMany({ select: { id: true } });
  let created = 0;
  for (const { id } of teams) {
    if ((await ensureSystemManagerOnTeam(id)) === 'created') created++;
  }
  if (created > 0) {
    await logActivity(prisma, {
      actorId: null,
      teamId: null,
      action: 'system.manager_backfill',
      meta: { created, teams: teams.length },
    });
  }
  return { created, teams: teams.length };
}

/**
 * Resolve team membership for auth. System user is treated as MANAGER even
 * if the row is momentarily missing (self-heals via ensureSystemManagerOnTeam).
 */
export async function resolveTeamMembership(
  userId: string,
  teamId: string,
): Promise<TeamMembership | null> {
  const existing = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId, teamId } },
  });
  if (existing) return existing;

  const systemUserId = await getSystemUserId();
  if (!isSystemUserId(userId, systemUserId)) return null;

  await ensureSystemManagerOnTeam(teamId);
  return prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId, teamId } },
  });
}

export function systemUserHasManagerPermission(permission: string): boolean {
  return (DEFAULT_MANAGER_PERMISSIONS as readonly string[]).includes(permission);
}
