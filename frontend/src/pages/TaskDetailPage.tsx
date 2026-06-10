import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { useProjectTeam } from '@/features/projects/useProjectTeam';
import { getTeam } from '@/features/teams/api';
import { visibleTeamMembers } from '@/lib/systemUser';
import * as tasksApi from '@/features/tasks/api';
import * as commentsApi from '@/features/comments/api';
import * as activityApi from '@/features/activity/api';
import { LabelPicker } from '@/features/labels/LabelPicker';
import { SubtaskList } from '@/features/subtasks/SubtaskList';
import { AttachmentsSection } from '@/features/attachments/AttachmentsSection';
import RecurrenceSection from '@/features/recurrence/RecurrenceSection';
import DependenciesSection from '@/features/dependencies/DependenciesSection';
import {
  formatRelativeTime,
  formatShamsiCalendarLong,
  formatShamsiTimestamp,
} from '@/lib/shamsi';
import { ShamsiDatePicker } from '@/lib/ShamsiDatePicker';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

interface DatePickerFieldProps {
  label: string;
  helper: string;
  value: string | null;
  storedValue: string | null;
  pending: boolean;
  onSave: () => void;
  onClear: () => void;
  onChange: (v: string | null) => void;
}

function DatePickerField({
  label,
  helper,
  value,
  storedValue,
  pending,
  onSave,
  onClear,
  onChange,
}: DatePickerFieldProps): JSX.Element {
  const dirty = value !== storedValue;
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-slate-700">{label}</label>
      <ShamsiDatePicker value={value} onChange={onChange} />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={pending || !dirty}
          className="bg-slate-900 text-white rounded px-2 py-0.5 text-xs font-medium disabled:opacity-40"
        >
          Save
        </button>
        {storedValue && (
          <button
            type="button"
            onClick={onClear}
            disabled={pending}
            className="text-xs text-red-600 hover:underline disabled:opacity-40"
          >
            Clear
          </button>
        )}
      </div>
      <p className="text-[11px] text-slate-400">{helper}</p>
    </div>
  );
}

function describeActivity(a: activityApi.ActivityEntry): string {
  const meta = (a.meta ?? {}) as Record<string, unknown>;
  switch (a.action) {
    case 'task.created':
      return `created the task "${meta.title ?? ''}"`;
    case 'task.status_changed':
      return `moved the task from ${meta.from} to ${meta.to}`;
    case 'task.updated':
      return `updated ${(meta.fields as string[] | undefined)?.join(', ') ?? 'the task'}`;
    case 'comment.added':
      return `added a comment: "${(meta.excerpt as string | undefined) ?? ''}"`;
    case 'comment.edited':
      return `edited a comment`;
    case 'comment.deleted':
      return `deleted a comment`;
    default:
      return a.action;
  }
}

export default function TaskDetailPage(): JSX.Element {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const { user } = useAuth();
  const { teamId, project, projectTeam } = useProjectTeam(projectId);
  const qc = useQueryClient();

  const isManager = projectTeam?.myRole === 'MANAGER';

  const { data: task, isLoading: taskLoading } = useQuery({
    queryKey: ['task', teamId, projectId, taskId],
    queryFn: async () => {
      if (!teamId || !projectId) return null;
      const list = await tasksApi.listTasks(teamId, projectId);
      return list.find((t) => t.id === taskId) ?? null;
    },
    enabled: !!teamId && !!projectId && !!taskId,
  });

  // v1.19: team members feed the Technician dropdown for managers/admins.
  // Fetched lazily — only when the viewer can actually change Technician.
  const canChangeTechnician = isManager || user?.globalRole === 'ADMIN';
  const { data: teamDetail } = useQuery({
    queryKey: ['teams', 'detail', teamId],
    queryFn: () => getTeam(teamId!),
    enabled: !!teamId && canChangeTechnician,
    staleTime: 30_000,
  });
  const teamMembers = visibleTeamMembers(teamDetail?.members ?? []);

  const { data: comments = [], isLoading: commentsLoading } = useQuery({
    queryKey: ['comments', taskId],
    queryFn: () => commentsApi.listComments(teamId!, projectId!, taskId!),
    enabled: !!teamId && !!projectId && !!taskId,
  });

  const { data: activity = [], isLoading: activityLoading } = useQuery({
    queryKey: ['activity', taskId],
    queryFn: () => activityApi.listActivity(teamId!, projectId!, taskId!),
    enabled: !!teamId && !!projectId && !!taskId,
  });

  const [newComment, setNewComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);

  // Three date inputs are tracked as ISO strings (or null). The picker takes
  // ISO + emits ISO so equality checks against the stored values are direct.
  // v1.37: startDate joins the local-input state for the date pickers.
  const [startDateInput, setStartDateInput] = useState<string | null>(null);
  const [dueDateInput, setDueDateInput] = useState<string | null>(null);
  const [plannedDateInput, setPlannedDateInput] = useState<string | null>(null);
  const [completedAtInput, setCompletedAtInput] = useState<string | null>(null);
  useEffect(() => {
    setStartDateInput(task?.startDate ?? null);
    setDueDateInput(task?.dueDate ?? null);
    setPlannedDateInput(task?.plannedDate ?? null);
    setCompletedAtInput(task?.completedAt ?? null);
  }, [task?.startDate, task?.dueDate, task?.plannedDate, task?.completedAt]);

  const updateTaskMut = useMutation({
    mutationFn: (patch: Partial<tasksApi.Task>) =>
      tasksApi.updateTask(teamId!, projectId!, taskId!, patch as Parameters<typeof tasksApi.updateTask>[3]),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['task', teamId, projectId, taskId] }),
        qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] }),
        qc.invalidateQueries({ queryKey: ['activity', taskId] }),
      ]);
    },
  });

  const createCommentMut = useMutation({
    mutationFn: (body: string) =>
      commentsApi.createComment(teamId!, projectId!, taskId!, body),
    onSuccess: async () => {
      setNewComment('');
      setCommentError(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['comments', taskId] }),
        qc.invalidateQueries({ queryKey: ['activity', taskId] }),
      ]);
    },
    onError: (err) => setCommentError(errorMessage(err, 'Could not post comment')),
  });

  const deleteCommentMut = useMutation({
    mutationFn: (commentId: string) =>
      commentsApi.deleteComment(teamId!, projectId!, taskId!, commentId),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['comments', taskId] }),
        qc.invalidateQueries({ queryKey: ['activity', taskId] }),
      ]);
    },
  });

  if (!teamId || !project) {
    return (
      <div className="min-h-screen p-8 max-w-3xl mx-auto">
        <p className="text-sm text-slate-500">
          {projectId ? (
            <>
              Project not found or you don&apos;t have access.{' '}
              <Link to="/projects" className="underline">
                Back to projects
              </Link>
            </>
          ) : (
            <>
              Select or{' '}
              <Link to="/teams" className="underline">
                create a team
              </Link>{' '}
              first.
            </>
          )}
        </p>
      </div>
    );
  }

  function submitComment(e: FormEvent): void {
    e.preventDefault();
    createCommentMut.mutate(newComment);
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Contextual back-link to the parent board. The global TopNav handles
          dashboard / projects / etc. — this just hops up one level in the
          team → project → task hierarchy. */}
      <div className="mb-6">
        <Link to={`/projects/${projectId}/tasks`} className="text-sm underline">
          ← Back to board
        </Link>
      </div>

      {taskLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {!taskLoading && !task && (
        <p className="text-sm text-slate-500">Task not found in this team.</p>
      )}

      {task && (
        <>
          <section className="bg-white rounded shadow p-6 mb-6">
            <h1 className="text-2xl font-semibold mb-2">{task.title}</h1>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 mb-3">
              <span className="uppercase tracking-wide">Status: {task.status}</span>
              <span className="uppercase tracking-wide">Priority: {task.priority}</span>
              {/* v1.19: Technician — distinct from creator/assignee. Always
                  visible to everyone for context; only managers/admins can
                  reassign (the dropdown below). */}
              <span className="uppercase tracking-wide">
                Technician:{' '}
                {task.technicianName ?? <span className="italic">unassigned</span>}
              </span>
              {task.startDate && (
                <span>
                  Started <span dir="rtl">{formatShamsiCalendarLong(task.startDate)}</span>
                </span>
              )}
              {task.dueDate && (
                <span>
                  Due by <span dir="rtl">{formatShamsiCalendarLong(task.dueDate)}</span>
                </span>
              )}
              {task.plannedDate && (
                <span className="text-sky-700">
                  Planned <span dir="rtl">{formatShamsiCalendarLong(task.plannedDate)}</span>
                </span>
              )}
              {task.completedAt && (
                <span className="text-emerald-700">
                  Completed <span dir="rtl">{formatShamsiCalendarLong(task.completedAt)}</span>
                </span>
              )}
              <span>
                Created <span dir="rtl">{formatShamsiTimestamp(task.createdAt)}</span>
              </span>
            </div>
            {task.description ? (
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{task.description}</p>
            ) : (
              <p className="text-sm text-slate-400 italic">No description.</p>
            )}

            {/* v1.19: Technician reassignment — managers/admins only. The
                backend gates this independently; the dropdown is here only
                as a discoverability affordance. */}
            {canChangeTechnician && (
              <div className="mt-5 pt-4 border-t">
                <h3 className="text-xs font-medium text-slate-600 mb-2">Technician</h3>
                <select
                  value={task.technicianId ?? ''}
                  onChange={(e) =>
                    updateTaskMut.mutate({
                      technicianId: e.target.value || null,
                    } as Partial<tasksApi.Task>)
                  }
                  disabled={updateTaskMut.isPending}
                  className="text-sm rounded border border-slate-300 dark:border-slate-600 px-2 py-1 max-w-sm"
                >
                  <option value="">— Unassigned —</option>
                  {teamMembers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name} ({m.role})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="mt-5 pt-4 border-t">
              <h3 className="text-xs font-medium text-slate-600 mb-2">Labels</h3>
              <LabelPicker
                teamId={teamId!}
                projectId={projectId!}
                taskId={taskId!}
                attached={task.labels}
                onChange={async () => {
                  await Promise.all([
                    qc.invalidateQueries({ queryKey: ['task', teamId, projectId, taskId] }),
                    qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] }),
                  ]);
                }}
              />
            </div>

            <div className="mt-5 pt-4 border-t">
              <SubtaskList
                teamId={teamId!}
                projectId={projectId!}
                taskId={taskId!}
                subtasks={task.subtasks}
                // v1.42: pass team members so the per-row assignee dropdown
                // can render without a second team-detail fetch.
                teamMembers={teamMembers.map((m) => ({ userId: m.userId, name: m.name }))}
                onChange={async () => {
                  await Promise.all([
                    qc.invalidateQueries({ queryKey: ['task', teamId, projectId, taskId] }),
                    qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] }),
                  ]);
                }}
              />
            </div>

            <div className="mt-5 pt-4 border-t">
              <AttachmentsSection
                teamId={teamId!}
                projectId={projectId!}
                taskId={taskId!}
              />
            </div>

            <RecurrenceSection
              teamId={teamId!}
              projectId={projectId!}
              taskId={taskId!}
            />

            <DependenciesSection
              teamId={teamId!}
              projectId={projectId!}
              taskId={taskId!}
            />

            <div className="mt-5 pt-4 border-t">
              <h3 className="text-xs font-medium text-slate-600 mb-2">Dates</h3>
              {/* v1.37: 4-column grid to fit the new "Started on" picker
                  alongside Due / Planned / Completed. */}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                {/* Started on — informational. Subject to the v1.18
                    date-edit restriction like its siblings. */}
                <DatePickerField
                  label="Started on"
                  helper="When work actually began."
                  value={startDateInput}
                  storedValue={task.startDate}
                  pending={updateTaskMut.isPending}
                  onSave={() => updateTaskMut.mutate({ startDate: startDateInput })}
                  onClear={() => updateTaskMut.mutate({ startDate: null })}
                  onChange={setStartDateInput}
                />
                {/* Due by — the hard deadline. Powers TASK_DUE notifications. */}
                <DatePickerField
                  label="Due by"
                  helper="Hard deadline. Triggers reminders."
                  value={dueDateInput}
                  storedValue={task.dueDate}
                  pending={updateTaskMut.isPending}
                  onSave={() => updateTaskMut.mutate({ dueDate: dueDateInput })}
                  onClear={() => updateTaskMut.mutate({ dueDate: null })}
                  onChange={setDueDateInput}
                />
                {/* Planned on — team's target completion. Powers Timeliness. */}
                <DatePickerField
                  label="Planned on"
                  helper="When we aim to be done."
                  value={plannedDateInput}
                  storedValue={task.plannedDate}
                  pending={updateTaskMut.isPending}
                  onSave={() => updateTaskMut.mutate({ plannedDate: plannedDateInput })}
                  onClear={() => updateTaskMut.mutate({ plannedDate: null })}
                  onChange={setPlannedDateInput}
                />
                {/* Completed on — actual finish. Auto-fills on status→DONE. */}
                <DatePickerField
                  label="Completed on"
                  helper="Auto-fills on status→DONE. Backdate freely."
                  value={completedAtInput}
                  storedValue={task.completedAt}
                  pending={updateTaskMut.isPending}
                  onSave={() => updateTaskMut.mutate({ completedAt: completedAtInput })}
                  onClear={() => updateTaskMut.mutate({ completedAt: null })}
                  onChange={setCompletedAtInput}
                />
              </div>
            </div>
          </section>

          {/* v1.42: task-level budget. Mirrors the v1.41 project budget UI
              shape — read-only display when set + inline editor. Anyone with
              project access can edit (no permission gate). */}
          <section className="bg-white rounded shadow p-6 mb-6">
            <h2 className="font-medium mb-3">Budget</h2>
            <TaskBudgetSection
              plannedBudget={task.plannedBudget}
              actualSpent={task.actualSpent}
              pending={updateTaskMut.isPending}
              onSave={(planned, actual) =>
                updateTaskMut.mutate({ plannedBudget: planned, actualSpent: actual })
              }
            />
          </section>

          <section className="bg-white rounded shadow p-6 mb-6">
            <h2 className="font-medium mb-3">Comments</h2>

            {commentsLoading && <p className="text-sm text-slate-500">Loading…</p>}
            {!commentsLoading && comments.length === 0 && (
              <p className="text-sm text-slate-400 italic mb-3">No comments yet.</p>
            )}
            <ul className="space-y-3 mb-4">
              {comments.map((c) => {
                const canDelete = c.authorId === user?.id || isManager;
                return (
                  <li key={c.id} className="border-l-2 border-slate-200 pl-3">
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>
                        <span className="font-medium text-slate-700">{c.authorName}</span>
                        <span className="ml-2" dir="rtl" title={formatShamsiTimestamp(c.createdAt) ?? ''}>
                          {formatRelativeTime(c.createdAt)}
                        </span>
                        {c.updatedAt !== c.createdAt && (
                          <span className="ml-2 italic">(edited)</span>
                        )}
                      </span>
                      {canDelete && (
                        <button
                          onClick={() => {
                            if (window.confirm('Delete this comment?')) deleteCommentMut.mutate(c.id);
                          }}
                          className="text-xs text-red-600 hover:underline"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                    <p className="text-sm whitespace-pre-wrap mt-1">{c.body}</p>
                  </li>
                );
              })}
            </ul>

            <form onSubmit={submitComment} className="space-y-2">
              <textarea
                placeholder="Write a comment…"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                className="w-full rounded border-slate-300 px-2 py-1 border text-sm"
                rows={2}
              />
              {commentError && <p className="text-xs text-red-600">{commentError}</p>}
              <button
                type="submit"
                disabled={createCommentMut.isPending || !newComment.trim()}
                className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
              >
                {createCommentMut.isPending ? 'Posting…' : 'Post comment'}
              </button>
            </form>
          </section>

          <section className="bg-white rounded shadow p-6">
            <h2 className="font-medium mb-3">Activity</h2>
            {activityLoading && <p className="text-sm text-slate-500">Loading…</p>}
            {!activityLoading && activity.length === 0 && (
              <p className="text-sm text-slate-400 italic">No activity yet.</p>
            )}
            <ul className="space-y-2">
              {activity.map((a) => (
                <li key={a.id} className="text-sm text-slate-600 flex gap-2">
                  <span
                    className="text-xs text-slate-400 whitespace-nowrap mt-0.5"
                    dir="rtl"
                    title={formatShamsiTimestamp(a.createdAt) ?? ''}
                  >
                    {formatRelativeTime(a.createdAt)}
                  </span>
                  <span>
                    <span className="font-medium text-slate-700">{a.actorName}</span>{' '}
                    {describeActivity(a)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

// v1.42: task-level budget editor. Read-only display when set
// ("Planned 1,000.00 · Spent 750.00 (75.0%)") with a green/amber/red
// utilisation chip; inline editor with two number inputs + save/clear.
// Client-side mirror of the server's rule disables Save when malformed.
function TaskBudgetSection({
  plannedBudget,
  actualSpent,
  pending,
  onSave,
}: {
  plannedBudget: string | null;
  actualSpent: string | null;
  pending: boolean;
  onSave: (plannedBudget: string | null, actualSpent: string | null) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [planned, setPlanned] = useState(plannedBudget ?? '');
  const [actual, setActual] = useState(actualSpent ?? '');
  // Re-sync only when the editor opens, so a background refetch can't
  // stomp the user's in-progress edits.
  useEffect(() => {
    if (editing) {
      setPlanned(plannedBudget ?? '');
      setActual(actualSpent ?? '');
    }
  }, [editing, plannedBudget, actualSpent]);

  const utilization =
    plannedBudget && actualSpent && Number(plannedBudget) > 0
      ? (Number(actualSpent) / Number(plannedBudget)) * 100
      : null;

  const fmt = (s: string | null): string =>
    s === null
      ? '—'
      : Number(s).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

  const validNumber = (v: string): boolean =>
    v.trim().length === 0 || (/^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) >= 0);
  const plannedInvalid = !validNumber(planned);
  const actualInvalid = !validNumber(actual);

  if (!editing) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-700">
        <span>
          Planned <code>{fmt(plannedBudget)}</code> · Spent <code>{fmt(actualSpent)}</code>
          {utilization !== null && (
            <span
              className={
                ' ml-2 ' +
                (utilization > 100
                  ? 'text-red-600'
                  : utilization > 80
                    ? 'text-amber-600'
                    : 'text-emerald-600')
              }
              title="Actual ÷ Planned"
            >
              ({utilization.toFixed(1)}%)
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="ml-auto text-xs text-slate-500 hover:underline"
        >
          {plannedBudget || actualSpent ? 'Edit' : 'Add budget'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-1">
        <span className="text-slate-500">Planned</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={planned}
          onChange={(e) => setPlanned(e.target.value)}
          className="w-32 rounded border-slate-300 px-1 py-0.5 border"
        />
      </label>
      <label className="flex items-center gap-1">
        <span className="text-slate-500">Actual Spent</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={actual}
          onChange={(e) => setActual(e.target.value)}
          className="w-32 rounded border-slate-300 px-1 py-0.5 border"
        />
      </label>
      {(plannedInvalid || actualInvalid) && (
        <span className="text-xs text-red-600">
          Use a non-negative number with up to 2 decimals.
        </span>
      )}
      <div className="flex gap-2 ml-auto">
        <button
          type="button"
          disabled={pending || plannedInvalid || actualInvalid}
          onClick={() => {
            onSave(planned.trim() ? planned.trim() : null, actual.trim() ? actual.trim() : null);
            setEditing(false);
          }}
          className="bg-slate-900 text-white rounded px-3 py-1 text-xs disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setPlanned('');
            setActual('');
            onSave(null, null);
            setEditing(false);
          }}
          className="text-xs text-slate-500 hover:underline"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="text-xs text-slate-500 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
