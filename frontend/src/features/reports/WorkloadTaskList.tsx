import { Link } from 'react-router-dom';
import type { WorkloadDrillRow } from './api';
import { useT } from '@/lib/i18n';

const PRIORITY_CLASS: Record<WorkloadDrillRow['priority'], string> = {
  LOW: 'text-slate-500',
  MEDIUM: 'text-slate-700 dark:text-slate-300',
  HIGH: 'text-warning font-medium',
  URGENT: 'text-danger font-semibold',
};

const STATUS_LABEL: Record<WorkloadDrillRow['status'], string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  ON_HOLD: 'On Hold',
  REVIEW: 'Review',
  PENDING_APPROVAL: 'Pending',
};

function formatDue(dueDate: string | null): string {
  if (!dueDate) return '—';
  return new Date(dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface Props {
  tasks: WorkloadDrillRow[];
  isLoading: boolean;
}

export default function WorkloadTaskList({ tasks, isLoading }: Props): JSX.Element {
  const t = useT();

  if (isLoading) {
    return (
      <ul className="space-y-3">
        {[1, 2, 3].map((i) => (
          <li key={i} className="h-14 rounded bg-bg-elevated animate-pulse" />
        ))}
      </ul>
    );
  }

  if (tasks.length === 0) {
    return (
      <p className="text-sm text-text-muted italic">{t('workload.drill.empty')}</p>
    );
  }

  return (
    <ul className="space-y-2">
      {tasks.map((task) => (
        <li
          key={task.id}
          className="rounded border border-border p-3 hover:bg-bg-elevated transition-colors"
        >
          <Link
            to={`/projects/${task.projectId}/tasks/${task.id}`}
            className="text-sm font-medium text-text hover:text-primary line-clamp-2"
          >
            {task.title}
          </Link>
          <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
            <span className="truncate">{task.projectName}</span>
            <span className={PRIORITY_CLASS[task.priority]}>{task.priority}</span>
            <span>{STATUS_LABEL[task.status]}</span>
            <span className="ms-auto shrink-0">{formatDue(task.dueDate)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
