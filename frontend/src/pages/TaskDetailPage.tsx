import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import { getTeam } from '@/features/teams/api';
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
  const { currentTeam } = useTeams();
  const qc = useQueryClient();

  const teamId = currentTeam?.id ?? null;
  const isManager = currentTeam?.myRole === 'MANAGER';

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
  const teamMembers = teamDetail?.members ?? [];

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
  const [dueDateInput, setDueDateInput] = useState<string | null>(null);
  const [plannedDateInput, setPlannedDateInput] = useState<string | null>(null);
  const [completedAtInput, setCompletedAtInput] = useState<string | null>(null);
  useEffect(() => {
    setDueDateInput(task?.dueDate ?? null);
    setPlannedDateInput(task?.plannedDate ?? null);
    setCompletedAtInput(task?.completedAt ?? null);
  }, [task?.dueDate, task?.plannedDate, task?.completedAt]);

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

  if (!currentTeam) {
    return (
      <div className="min-h-screen p-8 max-w-3xl mx-auto">
        <p className="text-sm text-slate-500">
          Select or{' '}
          <Link to="/teams" className="underline">
            create a team
          </Link>{' '}
          first.
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
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
