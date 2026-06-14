import { prisma } from '../data/prisma.js';

/** Shared user search for team add-member and group invite pickers. */
export async function searchUsers(
  query: string,
  limit = 20,
): Promise<Array<{ id: string; email: string; name: string }>> {
  const q = query.trim();
  if (q.length < 2) return [];
  return prisma.user.findMany({
    where: {
      disabledAt: null,
      isSystemUser: false,
      OR: [
        { email: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, email: true, name: true },
    take: limit,
    orderBy: { email: 'asc' },
  });
}
