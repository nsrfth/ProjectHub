import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMyTasks, type MeTask, type MeTasksQuery } from '@/features/meTasks/api';
import * as projectsApi from '@/features/projects/api';
import * as tasksApi from '@/features/tasks/api';
import GroupedBoard from '@/features/planner/GroupedBoard';
import TaskGrid from '@/features/planner/TaskGrid';
import { statusCommentRequirement } from '@/features/tasks/statusComment';
import StatusCommentDialog from '@/features/tasks/StatusCommentDialog';
import MyTasksCalendar from '@/features/planner/MyTasksCalendar';
import PersonalTasksPanel from '@/features/standaloneTasks/PersonalTasksPanel';
import {
  BOARD_GROUP_BY_LABEL,
  BOARD_GROUP_BY_ORDER,
  groupTasks,
  type BoardGroupBy,
} from '@/features/planner/grouping';
import { loadBoardGroupBy, saveBoardGroupBy } from '@/features/planner/storage';
import { useT } from '@/lib/i18n';

type SubView = 'board' | 'grid' | 'calendar' | 'personal';
type SortField = MeTasksQuery['sort'] | 'progress';

export default function MyTasksPage(): JSX.Element {
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [subView, setSubView] = useState<SubView>('board');
  const [groupBy, setGroupBy] = useState<BoardGroupBy>(() => loadBoardGroupBy());
  const [filter, setFilter] = useState<MeTasksQuery['filter'] | ''>('');
  const [projectId, setProjectId] = useState('');
  const [sortField, setSortField] = useState<SortField>('dueDate');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const useClientProgressSort = sortField === 'progress';

  const query: MeTasksQuery = {
    filter: filter || undefined,
    projectId: projectId || undefined,
    sort: useClientProgressSort ? 'dueDate' : sortField,
    order: sortOrder,
    limit: useClientProgressSort ? 200 : pageSize,
    offset: useClientProgressSort ? 0 : page * pageSize,
  };

  const { data: projects = [] } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: projectsApi.listAllProjects,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['me', 'tasks', query],
    queryFn: () => fetchMyTasks(query),
  });

  const tasks = useMemo(() => data?.items ?? [], [data]);
  const projectNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const tk of tasks) m.set(tk.projectId, tk.projectName);
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [tasks, projects]);

  const assigneeNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const tk of tasks) {
      if (tk.assigneeId && tk.assigneeName) m.set(tk.assigneeId, tk.assigneeName);
    }
    return m;
  }, [tasks]);

  const columns = useMemo(
    () => groupTasks(tasks, groupBy, [], assigneeNames),
    [tasks, groupBy, assigneeNames],
  );

  const updateMut = useMutation({
    mutationFn: (args: { task: MeTask; status: tasksApi.TaskStatus; statusComment?: string }) =>
      tasksApi.updateTask(args.task.teamId, args.task.projectId, args.task.id, {
        status: args.status,
        statusComment: args.statusComment,
      }),
    onSuccess: async (_d, vars) => {
      await qc.invalidateQueries({ queryKey: ['me', 'tasks'] });
      await qc.invalidateQueries({ queryKey: ['tasks', vars.task.teamId, vars.task.projectId] });
    },
  });

  // v2.5.58: ON_HOLD / DONE targets require a mandatory comment; the pending
  // change waits here while the dialog collects it. Mark-done is just a DONE
  // transition, so it flows through the same gate.
  const [pendingStatus, setPendingStatus] = useState<{
    task: MeTask;
    status: tasksApi.TaskStatus;
  } | null>(null);

  function requestStatusChange(task: MeTask, status: tasksApi.TaskStatus): void {
    if (statusCommentRequirement(task.status, status)) {
      setPendingStatus({ task, status });
    } else {
      updateMut.mutate({ task, status });
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-2">{t('planner.myTasks.title')}</h1>
      <p className="text-sm text-slate-500 mb-4">{t('planner.myTasks.hint')}</p>

      <div className="flex flex-wrap gap-2 mb-4">
        {(['board', 'grid', 'calendar', 'personal'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setSubView(v)}
            className={`px-3 py-1 text-sm rounded ${
              subView === v
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'border border-slate-300'
            }`}
          >
            {t(`planner.myTasks.view.${v}`)}
          </button>
        ))}
      </div>

      {subView !== 'personal' && (
      <div className="flex flex-wrap gap-2 mb-4 text-sm">
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as MeTasksQuery['filter'] | '');
            setPage(0);
          }}
          className="rounded border px-2 py-1 dark:bg-slate-800"
        >
          <option value="">{t('planner.myTasks.filter.all')}</option>
          <option value="due_today">{t('planner.myTasks.filter.dueToday')}</option>
          <option value="overdue">{t('planner.myTasks.filter.overdue')}</option>
          <option value="upcoming">{t('planner.myTasks.filter.upcoming')}</option>
          <option value="completed">{t('planner.myTasks.filter.completed')}</option>
          <option value="high_priority">{t('planner.myTasks.filter.highPriority')}</option>
        </select>
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setPage(0);
          }}
          className="rounded border px-2 py-1 dark:bg-slate-800"
        >
          <option value="">{t('planner.filter.allProjects')}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {(subView === 'board' || subView === 'grid') && (
          <>
            <select
              value={sortField}
              onChange={(e) => {
                setSortField(e.target.value as SortField);
                setPage(0);
              }}
              className="rounded border px-2 py-1 dark:bg-slate-800"
              aria-label="Sort by"
            >
              <option value="dueDate">{t('planner.myTasks.sort.dueDate')}</option>
              <option value="priority">{t('planner.myTasks.sort.priority')}</option>
              <option value="status">{t('planner.myTasks.sort.status')}</option>
              <option value="progress">{t('planner.myTasks.sort.progress')}</option>
            </select>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as 'asc' | 'desc')}
              className="rounded border px-2 py-1 dark:bg-slate-800"
              aria-label="Sort order"
            >
              <option value="asc">{t('planner.myTasks.sort.asc')}</option>
              <option value="desc">{t('planner.myTasks.sort.desc')}</option>
            </select>
          </>
        )}
        {subView === 'board' && (
          <select
            value={groupBy}
            onChange={(e) => {
              const v = e.target.value as BoardGroupBy;
              setGroupBy(v);
              saveBoardGroupBy(v);
            }}
            className="rounded border px-2 py-1 dark:bg-slate-800"
            aria-label="Group by"
          >
            {BOARD_GROUP_BY_ORDER.map((g) => (
              <option key={g} value={g}>
                {t('planner.groupBy')}: {BOARD_GROUP_BY_LABEL[g]}
              </option>
            ))}
          </select>
        )}
      </div>
      )}

      {subView === 'personal' && <PersonalTasksPanel />}

      {isLoading && subView !== 'calendar' && subView !== 'personal' && (
        <p className="text-sm text-slate-500">Loading…</p>
      )}

      {subView === 'board' && !isLoading && (
        <GroupedBoard
          columns={columns}
          onOpen={(id) => {
            const task = tasks.find((tk) => tk.id === id);
            if (task) nav(`/projects/${task.projectId}/tasks/${id}`);
          }}
          onViewProject={(task) => nav(`/projects/${task.projectId}/tasks`)}
          onStatusChange={(task, status) => requestStatusChange(task as MeTask, status)}
          onMarkDone={(task) => requestStatusChange(task as MeTask, 'DONE')}
          projectNames={projectNames}
        />
      )}

      {subView === 'grid' && !isLoading && (
        <TaskGrid
          tasks={tasks}
          showProjectColumn
          total={useClientProgressSort ? undefined : data?.total}
          page={useClientProgressSort ? undefined : page}
          pageSize={useClientProgressSort ? undefined : pageSize}
          onPageChange={useClientProgressSort ? undefined : setPage}
          defaultSort={
            sortField === 'progress'
              ? { key: 'progress', dir: sortOrder }
              : { key: sortField as 'dueDate' | 'priority' | 'status' | 'createdAt', dir: sortOrder }
          }
          onOpen={(task) => nav(`/projects/${task.projectId}/tasks/${task.id}`)}
          onViewProject={(task) => nav(`/projects/${task.projectId}/tasks`)}
          onStatusChange={(task, status) => requestStatusChange(task as MeTask, status)}
        />
      )}

      {subView === 'calendar' && <MyTasksCalendar />}

      {subView === 'board' && !isLoading && tasks.length > 0 && (
        <p className="text-xs text-slate-500 mt-4">
          {t('planner.myTasks.openFullCalendar')}{' '}
          <Link to="/planner/calendar" className="text-primary hover:underline">
            {t('planner.nav.calendar')}
          </Link>
        </p>
      )}

      {pendingStatus && (
        <StatusCommentDialog
          reason={statusCommentRequirement(pendingStatus.task.status, pendingStatus.status) ?? 'DONE'}
          taskTitle={pendingStatus.task.title}
          busy={updateMut.isPending}
          onCancel={() => setPendingStatus(null)}
          onConfirm={(comment) => {
            updateMut.mutate({
              task: pendingStatus.task,
              status: pendingStatus.status,
              statusComment: comment,
            });
            setPendingStatus(null);
          }}
        />
      )}
    </div>
  );
}
