import type { Prisma } from '@prisma/client';

// Materialized WBS path helpers shared by tasksService and trashService.
// Path format mirrors CostAccount: "/{id}" for root, "{parent.path}/{id}" for children.

export function buildWbsPath(parentPath: string | null, taskId: string): string {
  return parentPath ? `${parentPath}/${taskId}` : `/${taskId}`;
}

// Counts live children and updates the parent's isSummary flag. Pass null to no-op.
export async function refreshIsSummary(
  tx: Prisma.TransactionClient,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return;
  const liveChildCount = await tx.task.count({
    where: { parentId, deletedAt: null },
  });
  await tx.task.update({
    where: { id: parentId },
    data: { isSummary: liveChildCount > 0 },
  });
}

// Updates wbsPath + wbsDepth for all descendants of a moved task by replacing
// the old path prefix with the new one. Does NOT update the moved task itself.
export async function repathDescendants(
  tx: Prisma.TransactionClient,
  projectId: string,
  oldPrefix: string,
  newPrefix: string,
  depthDelta: number,
): Promise<void> {
  if (oldPrefix === newPrefix && depthDelta === 0) return;
  const descendants = await tx.task.findMany({
    where: {
      projectId,
      wbsPath: { startsWith: `${oldPrefix}/` },
    },
    select: { id: true, wbsPath: true, wbsDepth: true },
  });
  for (const d of descendants) {
    const newPath = newPrefix + (d.wbsPath ?? '').slice(oldPrefix.length);
    await tx.task.update({
      where: { id: d.id },
      data: { wbsPath: newPath, wbsDepth: (d.wbsDepth ?? 0) + depthDelta },
    });
  }
}
