import { prisma } from '../data/prisma.js';

export interface DoneTaskRow {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  doneAt: Date;
}

export class ReportsService {
  // Returns every task in this team whose doneAt is within the trailing N
  // days. Sorted newest-first so the typical "what happened this week" view
  // reads naturally. Caller (route layer) already enforces team membership;
  // we just trust the teamId here.
  async listDoneTasks(teamId: string, days: number): Promise<DoneTaskRow[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await prisma.task.findMany({
      where: { teamId, doneAt: { gte: since } },
      include: {
        project: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
      },
      orderBy: { doneAt: 'desc' },
    });
    return rows
      // doneAt is guaranteed non-null by the filter, but TypeScript can't
      // narrow through Prisma's where clause — assert via filter+map.
      .filter((r): r is typeof r & { doneAt: Date } => r.doneAt !== null)
      .map((r) => ({
        taskId: r.id,
        taskTitle: r.title,
        projectId: r.project.id,
        projectName: r.project.name,
        assigneeId: r.assignee?.id ?? null,
        assigneeName: r.assignee?.name ?? null,
        doneAt: r.doneAt,
      }));
  }
}
