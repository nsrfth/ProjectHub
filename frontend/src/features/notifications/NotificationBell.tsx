import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as notifApi from './api';
import { getAccessToken, onTokenChange } from '@/lib/api';
import { formatRelativeTime, formatShamsiTimestamp } from '@/lib/shamsi';

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

  // Live WS feed. When the server pushes `notification:new`, invalidate the
  // count + list queries so TanStack re-fetches. Reconnects whenever the
  // access token changes (sign-in, refresh). On token=null (signed out) we
  // tear down the socket without reconnecting.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let cancelled = false;
    let backoffMs = 1000; // exponential backoff up to 30s for reconnects

    function connect(token: string): void {
      if (cancelled) return;
      // SPA + Caddy are same-origin in prod; pick ws:// vs wss:// based on the
      // page protocol so HTTPS deployments don't downgrade to plaintext WS.
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/api/ws/notifications?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(url);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { type?: string };
          if (msg.type === 'notification:new') {
            void qc.invalidateQueries({ queryKey: ['notifications', 'count'] });
            void qc.invalidateQueries({ queryKey: ['notifications', 'list'] });
          }
        } catch {
          // Ignore non-JSON frames.
        }
      };
      ws.onopen = () => {
        backoffMs = 1000; // reset on a successful connection
      };
      ws.onclose = () => {
        if (cancelled) return;
        // Reconnect with backoff while a token is still present.
        const t = getAccessToken();
        if (!t) return;
        setTimeout(() => connect(t), backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      };
    }

    const initial = getAccessToken();
    if (initial) connect(initial);

    // Subscribe to token changes — reconnect with the new token, or tear down
    // if signed out.
    const unsub = onTokenChange((t) => {
      if (ws) {
        ws.onclose = null; // suppress reconnect-on-close for this teardown
        ws.close();
        ws = null;
      }
      if (t) connect(t);
    });

    return () => {
      cancelled = true;
      unsub();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [qc]);

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
        return `You were mentioned on "${p.taskTitle ?? 'a task'}": ${p.excerpt ?? ''}`;
      default:
        return n.type;
    }
  }

  function openNotification(n: notifApi.Notification): void {
    if (!n.readAt) markReadMut.mutate(n.id);
    setOpen(false);
    // Payload may carry taskId + projectId (set since v1.1) so we deep-link
    // straight to the task. Older notifications without projectId fall back
    // to the dashboard.
    const p = n.payload as { taskId?: string; projectId?: string };
    if (p.projectId && p.taskId) {
      void nav(`/projects/${p.projectId}/tasks/${p.taskId}`);
    } else {
      void nav('/dashboard');
    }
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
                  <p
                    className="text-xs text-slate-400 mt-1"
                    dir="rtl"
                    title={formatShamsiTimestamp(n.createdAt) ?? ''}
                  >
                    {formatRelativeTime(n.createdAt)}
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
