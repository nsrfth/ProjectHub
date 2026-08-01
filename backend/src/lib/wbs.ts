import type { Prisma } from '@prisma/client';

// Materialized WBS path helpers shared by tasksService and trashService.
// Path format mirrors CostAccount: "/{id}" for root, "{parent.path}/{id}" for children.

export interface WbsCodeRow {
  id: string;
  parentId: string | null;
  wbsOrder: number;
  createdAt: Date;
}

/**
 * Derives the outline code ("1", "1.2", "1.2.3") for every live task in a
 * project. The code is NOT stored — materializing it would force a sibling
 * resequence on every insert or delete (see the Task.wbsOrder comment in
 * schema.prisma) — so it is computed on read.
 *
 * v2.23.0: extracted from tasksService.projectWbs so the CPM Schedule Analysis
 * report numbers its activities identically to the WBS view. Two independent
 * DFS walks would drift the moment sibling ordering changed, and a schedule
 * report whose WBS codes disagree with the WBS screen is worse than one with
 * no codes at all.
 *
 * A task whose parent is soft-deleted surfaces as a root — the same
 * orphan-self-healing rule the read layer applies everywhere else.
 */
export function deriveWbsCodes(rows: readonly WbsCodeRow[]): Map<string, string> {
  const liveIds = new Set(rows.map((r) => r.id));
  const childrenOf = new Map<string | null, WbsCodeRow[]>();
  for (const r of rows) {
    const key = r.parentId && liveIds.has(r.parentId) ? r.parentId : null;
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(r);
    else childrenOf.set(key, [r]);
  }
  const sortSibs = (arr: WbsCodeRow[]): WbsCodeRow[] =>
    [...arr].sort((a, b) => a.wbsOrder - b.wbsOrder || a.createdAt.getTime() - b.createdAt.getTime());

  const codes = new Map<string, string>();
  const visited = new Set<string>(); // defensive cycle guard (move() prevents cycles)
  const walk = (row: WbsCodeRow, code: string): void => {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    codes.set(row.id, code);
    sortSibs(childrenOf.get(row.id) ?? []).forEach((kid, i) => walk(kid, `${code}.${i + 1}`));
  };
  sortSibs(childrenOf.get(null) ?? []).forEach((r, i) => walk(r, `${i + 1}`));
  return codes;
}

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
