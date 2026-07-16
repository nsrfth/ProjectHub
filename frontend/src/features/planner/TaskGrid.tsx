import { useEffect, useMemo, useState } from 'react';
import type { Task, TaskPriority, TaskStatus } from '@/features/tasks/api';
import { LabelChip } from '@/features/labels/LabelChip';
import { formatShamsiDate, formatShamsiTimestampDate } from '@/lib/shamsi';
import { useT } from '@/lib/i18n';
import { applyTaskFilters, sortTasks, type TaskFilterState, type TaskSortKey } from './filters';
import { taskProgressPercent } from './progress';
import {
  DEFAULT_GRID_COLUMNS,
  loadGridColumns,
  loadGridPageSize,
  saveGridColumns,
  saveGridPageSize,
  type GridColumnId,
} from './storage';

const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  REVIEW: 'Review',
  PENDING_APPROVAL: 'Pending approval',
  DONE: 'Done',
};
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

const COLUMN_LABEL: Record<GridColumnId, string> = {
  title: 'Task Name',
  project: 'Project',
  parentTask: 'Parent Task',
  assignee: 'Assignee',
  status: 'Status',
  priority: 'Priority',
  progress: 'Progress',
  startDate: 'Start Date',
  dueDate: 'Due Date',
  budget: 'Budget',
  labels: 'Labels',
  createdAt: 'Created',
};

export interface TaskGridRow extends Task {
  projectName?: string;
  assigneeName?: string | null;
}

export interface TaskGridProps {
  tasks: TaskGridRow[];
  filters?: TaskFilterState;
  onOpen: (task: TaskGridRow) => void;
  onStatusChange?: (task: TaskGridRow, status: TaskStatus) => void;
  onViewProject?: (task: TaskGridRow) => void;
  showProjectColumn?: boolean;
  /** Server-side pagination — when set, client slice is skipped. */
  total?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  defaultSort?: { key: TaskSortKey; dir: SortDir };
}

type SortDir = 'asc' | 'desc';

export default function TaskGrid({
  tasks,
  filters = {},
  onOpen,
  onStatusChange,
  onViewProject,
  showProjectColumn = true,
  total,
  page: controlledPage,
  pageSize: controlledPageSize,
  onPageChange,
  defaultSort,
}: TaskGridProps): JSX.Element {
  const t = useT();
  const [search, setSearch] = useState(filters.search ?? '');
  const [sort, setSort] = useState<{ key: TaskSortKey; dir: SortDir } | null>(
    defaultSort ?? { key: 'dueDate', dir: 'asc' },
  );
  const [visibleCols, setVisibleCols] = useState<GridColumnId[]>(() => loadGridColumns());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(() => loadGridPageSize());
  const [showColPicker, setShowColPicker] = useState(false);

  useEffect(() => {
    if (defaultSort) setSort(defaultSort);
    // Intentionally keyed on the primitive sort fields, not the defaultSort
    // object identity, so a new object from the parent each render doesn't
    // re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultSort?.key, defaultSort?.dir]);

  const activePage = controlledPage ?? page;
  const activePageSize = controlledPageSize ?? pageSize;

  const projectNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) {
      if (t.projectName) m.set(t.projectId, t.projectName);
    }
    return m;
  }, [tasks]);

  const filtered = useMemo(
    () => applyTaskFilters(tasks, { ...filters, search }),
    [tasks, filters, search],
  );

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const assigneeNameMap = new Map<string, string>();
    for (const row of tasks) {
      if (row.assigneeId && row.assigneeName) {
        assigneeNameMap.set(row.assigneeId, row.assigneeName);
      }
    }
    return sortTasks(filtered, sort.key, sort.dir, projectNames, assigneeNameMap);
  }, [filtered, sort, projectNames, tasks]);

  const isServerPaged = total !== undefined && onPageChange !== undefined;
  const pageCount = isServerPaged
    ? Math.max(1, Math.ceil((total ?? 0) / activePageSize))
    : Math.max(1, Math.ceil(sorted.length / activePageSize));

  const pageRows = useMemo(() => {
    if (isServerPaged) return sorted;
    const start = activePage * activePageSize;
    return sorted.slice(start, start + activePageSize);
  }, [sorted, activePage, activePageSize, isServerPaged]);

  function onHeader(key: TaskSortKey): void {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  }

  function toggleCol(id: GridColumnId): void {
    setVisibleCols((prev) => {
      const next = prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id];
      saveGridColumns(next);
      return next;
    });
  }

  const cols = visibleCols.filter((c) => (c === 'project' ? showProjectColumn : true));

  if (tasks.length === 0) {
    return (
      <p className="text-sm text-slate-500 italic py-8 text-center">
        {t('planner.grid.empty')}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('planner.grid.search')}
          className="rounded border border-border px-2 py-1 text-sm flex-1 min-w-[180px] dark:bg-slate-800"
        />
        <button
          type="button"
          onClick={() => setShowColPicker((v) => !v)}
          className="text-xs px-2 py-1 rounded border border-border"
        >
          {t('planner.grid.columns')}
        </button>
        <select
          value={activePageSize}
          onChange={(e) => {
            const n = Number(e.target.value);
            setPageSize(n);
            saveGridPageSize(n);
            setPage(0);
            onPageChange?.(0);
          }}
          className="text-xs rounded border border-slate-300 px-2 py-1 dark:bg-slate-800"
          aria-label="Page size"
        >
          {[10, 25, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      </div>

      {showColPicker && (
        <div className="flex flex-wrap gap-2 text-xs p-2 bg-bg rounded">
          {[...DEFAULT_GRID_COLUMNS, 'startDate' as const, 'budget' as const, 'parentTask' as const].map((id) => (
            <label key={id} className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={visibleCols.includes(id)}
                onChange={() => toggleCol(id)}
              />
              {COLUMN_LABEL[id]}
            </label>
          ))}
        </div>
      )}

      <div className="bg-surface rounded shadow overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="bg-bg text-start text-xs text-slate-500 uppercase">
            <tr>
              {cols.map((col) => (
                <th
                  key={col}
                  className="px-3 py-2 font-medium resize-x overflow-hidden min-w-[80px]"
                  style={{ maxWidth: 320 }}
                >
                  {[
                    'title',
                    'status',
                    'priority',
                    'dueDate',
                    'progress',
                    'createdAt',
                    'project',
                    'assignee',
                  ].includes(col) ? (
                    <button
                      type="button"
                      onClick={() =>
                        onHeader(
                          col === 'title'
                            ? 'title'
                            : col === 'project'
                              ? 'project'
                              : (col as TaskSortKey),
                        )
                      }
                      className="hover:text-slate-700"
                    >
                      {COLUMN_LABEL[col]}
                      {sort?.key === col && (sort.dir === 'asc' ? ' ▲' : ' ▼')}
                    </button>
                  ) : (
                    COLUMN_LABEL[col]
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onOpen(row)}
                className="border-t border-border hover:bg-bg cursor-pointer"
              >
                {cols.map((col) => (
                  <td key={col} className="px-3 py-2" onClick={(e) => col === 'status' && e.stopPropagation()}>
                    {renderCell(row, col, onStatusChange, onViewProject)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {isServerPaged
            ? `${total} tasks`
            : `${sorted.length} tasks`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={activePage <= 0}
            onClick={() => {
              const p = activePage - 1;
              setPage(p);
              onPageChange?.(p);
            }}
            className="px-2 py-1 rounded border disabled:opacity-40"
          >
            ←
          </button>
          <span>
            {activePage + 1} / {pageCount}
          </span>
          <button
            type="button"
            disabled={activePage >= pageCount - 1}
            onClick={() => {
              const p = activePage + 1;
              setPage(p);
              onPageChange?.(p);
            }}
            className="px-2 py-1 rounded border disabled:opacity-40"
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
}

function renderCell(
  row: TaskGridRow,
  col: GridColumnId,
  onStatusChange?: (task: TaskGridRow, status: TaskStatus) => void,
  onViewProject?: (task: TaskGridRow) => void,
): React.ReactNode {
  switch (col) {
    case 'title':
      return <span className="font-medium">{row.title}</span>;
    case 'project':
      return onViewProject ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onViewProject(row);
          }}
          className="text-primary hover:underline text-start"
        >
          {row.projectName ?? '—'}
        </button>
      ) : (
        row.projectName ?? '—'
      );
    case 'parentTask':
      return '—';
    case 'assignee':
      return row.assigneeName ?? (row.assigneeId ? '—' : 'Unassigned');
    case 'status':
      return onStatusChange ? (
        <select
          value={row.status}
          onChange={(e) => onStatusChange(row, e.target.value as TaskStatus)}
          className="rounded px-1 py-0.5 text-xs border dark:bg-slate-700"
          onClick={(e) => e.stopPropagation()}
        >
          {(['TODO', 'IN_PROGRESS', 'ON_HOLD', 'REVIEW', 'DONE'] as TaskStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      ) : (
        STATUS_LABEL[row.status]
      );
    case 'priority':
      return PRIORITY_LABEL[row.priority];
    case 'progress':
      return `${taskProgressPercent(row)}%`;
    case 'startDate':
      return row.startDate ? formatShamsiDate(row.startDate) : '';
    case 'dueDate':
      return row.dueDate ? formatShamsiDate(row.dueDate) : '';
    case 'budget':
      return row.plannedBudget ? `${row.plannedBudget}` : '—';
    case 'labels':
      return (
        // Presentational wrapper: only stops the row click from firing when the
        // user interacts with labels — not an interactive control itself.
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          {row.labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      );
    case 'createdAt':
      return formatShamsiTimestampDate(row.createdAt);
  }
}
