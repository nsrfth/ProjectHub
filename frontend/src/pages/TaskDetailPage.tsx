import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import * as tasksApi from '@/features/tasks/api';
import * as commentsApi from '@/features/comments/api';
import * as activityApi from '@/features/activity/api';
import { LabelPicker } from '@/features/labels/LabelPicker';
import { SubtaskList } from '@/features/subtasks/SubtaskList';
import { AttachmentsSection } from '@/features/attachments/AttachmentsSection';
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

  // doneAt is tracked as an ISO string (or null). The ShamsiDatePicker takes
  // ISO + emits ISO so we can compare equality without a conversion dance.
  const [doneAtInput, setDoneAtInput] = useState<string | null>(null);
  useEffect(() => {
    setDoneAtInput(task?.doneAt ?? null);
  }, [task?.doneAt]);

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
    <div className="min-h-screen p-8 max-w-4xl mx-auto">
      <header className="mb-6">
        <Link to={`/projects/${projectId}/tasks`} className="text-sm underline">
          ← Back to board
        </Link>
      </header>

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
              {task.dueDate && (
                <span>
                  Due <span dir="rtl">{formatShamsiCalendarLong(task.dueDate)}</span>
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

            <div className="mt-5 pt-4 border-t flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Done date</span>
                <div className="mt-1">
                  <ShamsiDatePicker value={doneAtInput} onChange={setDoneAtInput} />
                </div>
                {doneAtInput && (
                  <span className="block mt-1 text-xs text-slate-500" dir="rtl">
                    {formatShamsiCalendarLong(doneAtInput)}
                  </span>
                )}
              </label>
              <button
                type="button"
                disabled={updateTaskMut.isPending || doneAtInput === task.doneAt}
                onClick={() => updateTaskMut.mutate({ doneAt: doneAtInput })}
                className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
              >
                {updateTaskMut.isPending ? 'Saving…' : 'Save done date'}
              </button>
              {task.doneAt && (
                <button
                  type="button"
                  disabled={updateTaskMut.isPending}
                  onClick={() => updateTaskMut.mutate({ doneAt: null })}
                  className="text-xs underline disabled:opacity-50"
                >
                  Clear
                </button>
              )}
              <p className="basis-full text-xs text-slate-400">
                Auto-filled when status moves to DONE; pick any date to backdate.
              </p>
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
