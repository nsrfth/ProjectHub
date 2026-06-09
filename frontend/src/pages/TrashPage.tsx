import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import * as trashApi from '@/features/trash/api';
import { formatRelativeTime } from '@/lib/shamsi';

// v1.21 trash page. Lists soft-deleted Tasks + Comments in the current team.
// Anyone in the team can restore an item; permanent deletion (purge / empty)
// is gated by the admin-configurable `trash.emptyAllowedRoles` instance
// setting. The server is the source of truth for the gate — this UI uses the
// setting echo from the list response to grey out the unavailable buttons.

export default function TrashPage(): JSX.Element {
  const { user } = useAuth();
  const { currentTeam } = useTeams();
  const qc = useQueryClient();
  const teamId = currentTeam?.id ?? null;

  const { data, isLoading, error } = useQuery({
    queryKey: ['trash', teamId],
    queryFn: () => trashApi.listTrash(teamId!),
    enabled: !!teamId,
  });

  const isManager = currentTeam?.myRole === 'MANAGER';
  const isAdmin = user?.globalRole === 'ADMIN';
  const canPurge = data
    ? isAdmin || (data.emptyAllowedRoles === 'admin-and-manager' && isManager)
    : false;

  const restoreTaskMut = useMutation({
    mutationFn: (taskId: string) => trashApi.restoreTask(teamId!, taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trash', teamId] }),
  });
  const restoreCommentMut = useMutation({
    mutationFn: (commentId: string) => trashApi.restoreComment(teamId!, commentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trash', teamId] }),
  });
  const purgeTaskMut = useMutation({
    mutationFn: (taskId: string) => trashApi.purgeTask(teamId!, taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trash', teamId] }),
  });
  const purgeCommentMut = useMutation({
    mutationFn: (commentId: string) => trashApi.purgeComment(teamId!, commentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trash', teamId] }),
  });
  const emptyMut = useMutation({
    mutationFn: () => trashApi.emptyTrash(teamId!),
    onSuccess: (counts) => {
      qc.invalidateQueries({ queryKey: ['trash', teamId] });
      window.alert(
        `Emptied: ${counts.tasksPurged} task(s) + ${counts.commentsPurged} comment(s) permanently deleted.`,
      );
    },
  });

  if (!currentTeam) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-slate-500">
          Select or <Link to="/teams" className="underline">create a team</Link> first.
        </p>
      </div>
    );
  }

  const totalItems = (data?.tasks.length ?? 0) + (data?.comments.length ?? 0);

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Trash</h1>
          <p className="text-sm text-slate-500">
            Soft-deleted items in <span className="font-medium">{currentTeam.name}</span>.
            {' '}Restore returns them as-was; permanent deletion is{' '}
            {data?.emptyAllowedRoles === 'admin-and-manager'
              ? 'available to team managers and global admins.'
              : 'admin-only on this instance.'}
          </p>
        </div>
        {totalItems > 0 && (
          <button
            type="button"
            disabled={!canPurge || emptyMut.isPending}
            onClick={() => {
              if (window.confirm(
                `Permanently delete ALL ${totalItems} item(s) in trash? This cannot be undone.`,
              )) {
                emptyMut.mutate();
              }
            }}
            className="text-sm rounded px-3 py-1.5 bg-red-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            title={canPurge ? 'Empty the trash' : 'Your role cannot permanently delete'}
          >
            {emptyMut.isPending ? 'Emptying…' : 'Empty trash'}
          </button>
        )}
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">Could not load trash.</p>}

      {data && totalItems === 0 && (
        <p className="text-sm text-slate-500 italic">Trash is empty.</p>
      )}

      {data && data.tasks.length > 0 && (
        <section className="bg-white dark:bg-slate-800 rounded shadow p-4 mb-6">
          <h2 className="text-sm font-medium mb-2">
            Tasks ({data.tasks.length})
          </h2>
          <ul className="divide-y dark:divide-slate-700">
            {data.tasks.map((t) => (
              <li key={t.id} className="py-3 flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{t.title}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Deleted {formatRelativeTime(t.deletedAt)}
                    {t.deletedByName && <> by {t.deletedByName}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={restoreTaskMut.isPending}
                    onClick={() => restoreTaskMut.mutate(t.id)}
                    className="text-xs rounded px-2 py-1 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    disabled={!canPurge || purgeTaskMut.isPending}
                    onClick={() => {
                      if (window.confirm(`Permanently delete "${t.title}"?`)) {
                        purgeTaskMut.mutate(t.id);
                      }
                    }}
                    className="text-xs rounded px-2 py-1 text-red-600 dark:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed"
                    title={canPurge ? 'Delete forever' : 'Your role cannot permanently delete'}
                  >
                    Delete forever
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && data.comments.length > 0 && (
        <section className="bg-white dark:bg-slate-800 rounded shadow p-4">
          <h2 className="text-sm font-medium mb-2">
            Comments ({data.comments.length})
          </h2>
          <ul className="divide-y dark:divide-slate-700">
            {data.comments.map((c) => (
              <li key={c.id} className="py-3 flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{c.bodyExcerpt || <span className="italic">(empty)</span>}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Deleted {formatRelativeTime(c.deletedAt)}
                    {c.deletedByName && <> by {c.deletedByName}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={restoreCommentMut.isPending}
                    onClick={() => restoreCommentMut.mutate(c.id)}
                    className="text-xs rounded px-2 py-1 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    disabled={!canPurge || purgeCommentMut.isPending}
                    onClick={() => {
                      if (window.confirm('Permanently delete this comment?')) {
                        purgeCommentMut.mutate(c.id);
                      }
                    }}
                    className="text-xs rounded px-2 py-1 text-red-600 dark:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Delete forever
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
