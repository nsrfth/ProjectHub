import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as notifApi from './api';
import { getAccessToken, onTokenChange } from '@/lib/api';
import { formatRelativeTime, formatShamsiTimestamp } from '@/lib/shamsi';
import { IconBell } from '@/features/nav/icons';
import GroupInvitesPanel from '@/features/groups/GroupInvitesPanel';
import PendingGrantApprovalsPanel from '@/features/projects/PendingGrantApprovalsPanel';
import { useT } from '@/lib/i18n';

// v1.24: bell now lives INSIDE the TopNav flex container (no longer
// fixed-position). Renders as a regular icon button next to the user menu.
// Same dropdown behaviour; same WS feed.
export default function NotificationBell(): JSX.Element {
  const t = useT();
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

    function scheduleReconnect(): void {
      if (cancelled || !getAccessToken()) return;
      setTimeout(() => void connect(), backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }

    // v2.5.24 (W1.3): mint a fresh single-use ticket (authenticated POST) right
    // before opening the socket — tickets expire in ~30s so we never cache one.
    async function connect(): Promise<void> {
      if (cancelled || !getAccessToken()) return;
      let ticket: string;
      try {
        ticket = (await notifApi.wsTicket()).ticket;
      } catch {
        // Couldn't mint a ticket (e.g. a transient 401 mid token-refresh) —
        // back off and retry while still signed in.
        scheduleReconnect();
        return;
      }
      if (cancelled) return;
      // SPA + Caddy are same-origin in prod; pick ws:// vs wss:// based on the
      // page protocol so HTTPS deployments don't downgrade to plaintext WS.
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/api/ws/notifications?ticket=${encodeURIComponent(ticket)}`;
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
        scheduleReconnect();
      };
    }

    if (getAccessToken()) void connect();

    // Subscribe to token changes — reconnect (with a fresh ticket) on the new
    // token, or tear down if signed out.
    const unsub = onTokenChange((t) => {
      if (ws) {
        ws.onclose = null; // suppress reconnect-on-close for this teardown
        ws.close();
        ws = null;
      }
      backoffMs = 1000;
      if (t) void connect();
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
      case 'STANDALONE_TASK_DUE':
        return `${t('standaloneTasks.notify.due')}: "${p.taskTitle ?? ''}"`;
      case 'MENTION':
        return `You were mentioned on "${p.taskTitle ?? 'a task'}": ${p.excerpt ?? ''}`;
      case 'CORRESPONDENCE_REFERRAL':
        return t('correspondence.notify.referred').replace(
          '{ref}',
          String(p.referenceNumber ?? p.subject ?? ''),
        );
      case 'GRANT_PENDING':
        return t('grants.notify.pending').replace('{project}', String(p.projectName ?? ''));
      case 'GRANT_DECIDED':
        return t('grants.notify.decided')
          .replace('{project}', String(p.projectName ?? ''))
          .replace('{decision}', String(p.decision ?? ''));
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
    if (n.type === 'STANDALONE_TASK_DUE') {
      void nav('/planner/my-tasks');
    } else if (n.type === 'CORRESPONDENCE_REFERRAL' && p.projectId) {
      void nav(`/projects/${p.projectId}/correspondence`);
    } else if (p.projectId && p.taskId) {
      void nav(`/projects/${p.projectId}/tasks/${p.taskId}`);
    } else {
      void nav('/dashboard');
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void refetchList();
        }}
        aria-label="Notifications"
        className="relative p-2 rounded-full text-text-muted hover:bg-bg-elevated"
      >
        <IconBell size={20} />
        {count > 0 && (
          <span className="absolute top-0.5 end-0.5 bg-danger text-white text-[10px] rounded-full min-w-4 h-4 px-1 flex items-center justify-center">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 mt-2 w-80 max-h-96 overflow-auto bg-surface border border-border rounded shadow-lg z-50">
          <div className="flex items-center justify-between p-2 border-b border-border">
            <span className="text-sm font-medium">{t('corner.notifications')}</span>
            <button
              type="button"
              onClick={() => markAllMut.mutate()}
              disabled={markAllMut.isPending || count === 0}
              className="text-xs underline disabled:opacity-50"
            >
              {t('notifications.markAllRead')}
            </button>
          </div>

          <GroupInvitesPanel />
          <PendingGrantApprovalsPanel />

          {items.length === 0 && (
            <p className="text-sm text-text-muted italic p-3">{t('notifications.empty')}</p>
          )}

          <ul>
            {items.map((n) => (
              <li
                key={n.id}
                className={`border-b border-border last:border-0 ${n.readAt ? '' : 'bg-blue-50 dark:bg-blue-900/20'}`}
              >
                <button
                  type="button"
                  onClick={() => openNotification(n)}
                  className="w-full text-start p-2 hover:bg-bg-elevated"
                >
                  <p className="text-sm">{describe(n)}</p>
                  <p
                    className="text-xs text-text-muted mt-1"
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
