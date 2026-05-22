import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as notifApi from './api';

// Renders the user-facing notification fragment, including a bell button, an
// unread badge, and a click-to-open dropdown listing recent notifications.
// Fixed top-right so it appears on every authenticated route via ProtectedRoute.
export default function NotificationBell(): JSX.Element {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Cheap count query — refetch on a slow interval so the badge stays roughly
  // current without polling-storm. The dropdown opening also re-fetches the
  // full list.
  const { data: count = 0 } = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: notifApi.unreadCount,
    refetchInterval: 30_000,
  });

  const { data: items = [], refetch: refetchList } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => notifApi.listNotifications({ limit: 20 }),
    enabled: open,
  });

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handler(ev: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const markReadMut = useMutation({
    mutationFn: (id: string) => notifApi.markRead(id),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['notifications', 'count'] }),
        qc.invalidateQueries({ queryKey: ['notifications', 'list'] }),
      ]);
    },
  });

  const markAllMut = useMutation({
    mutationFn: () => notifApi.markAllRead(),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['notifications', 'count'] }),
        qc.invalidateQueries({ queryKey: ['notifications', 'list'] }),
      ]);
    },
  });

  function describe(n: notifApi.Notification): string {
    const p = n.payload as Record<string, unknown>;
    switch (n.type) {
      case 'TASK_ASSIGNED':
        return `You were assigned to "${p.taskTitle ?? 'a task'}"`;
      case 'TASK_COMMENT':
        return `New comment on "${p.taskTitle ?? 'a task'}": ${p.excerpt ?? ''}`;
      case 'TASK_STATUS':
        return `"${p.taskTitle ?? 'A task'}" moved from ${p.from} to ${p.to}`;
      case 'TASK_DUE':
        return `"${p.taskTitle ?? 'A task'}" is due soon`;
      case 'MENTION':
        return `You were mentioned on "${p.taskTitle ?? 'a task'}"`;
      default:
        return n.type;
    }
  }

  function openNotification(n: notifApi.Notification): void {
    // Mark as read, then navigate to the related task. The /projects/:projectId
    // segment isn't in the payload yet, so we'd need to look it up — for now
    // route to the dashboard and let the user click through. (Cheap iteration.)
    if (!n.readAt) markReadMut.mutate(n.id);
    setOpen(false);
    // If we had projectId in payload we could nav directly to the task page.
    // Leave the destination general until payloads carry it.
    void nav('/dashboard');
  }

  return (
    <div ref={wrapRef} className="fixed top-3 right-3 z-50">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void refetchList();
        }}
        aria-label="Notifications"
        className="relative bg-white border border-slate-300 rounded-full w-9 h-9 flex items-center justify-center shadow hover:bg-slate-100"
      >
        <span aria-hidden>🔔</span>
        {count > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[10px] rounded-full min-w-4 h-4 px-1 flex items-center justify-center">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-auto bg-white border border-slate-200 rounded shadow-lg">
          <div className="flex items-center justify-between p-2 border-b">
            <span className="text-sm font-medium">Notifications</span>
            <button
              onClick={() => markAllMut.mutate()}
              disabled={markAllMut.isPending || count === 0}
              className="text-xs underline disabled:opacity-50"
            >
              Mark all read
            </button>
          </div>

          {items.length === 0 && (
            <p className="text-sm text-slate-500 italic p-3">Nothing here yet.</p>
          )}

          <ul>
            {items.map((n) => (
              <li
                key={n.id}
                className={`border-b last:border-0 ${n.readAt ? 'bg-white' : 'bg-blue-50'}`}
              >
                <button
                  type="button"
                  onClick={() => openNotification(n)}
                  className="w-full text-left p-2 hover:bg-slate-50"
                >
                  <p className="text-sm">{describe(n)}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    {new Date(n.createdAt).toLocaleString()}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
