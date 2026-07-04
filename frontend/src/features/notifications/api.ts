import { api } from '@/lib/api';

export type NotifyType =
  | 'TASK_ASSIGNED'
  | 'TASK_COMMENT'
  | 'TASK_DUE'
  | 'MENTION'
  | 'TASK_STATUS'
  // v1.89: a letter was referred (ارجاع) to this user.
  | 'CORRESPONDENCE_REFERRAL'
  // v2.5.28: a personal (standalone) task is coming due.
  | 'STANDALONE_TASK_DUE';

export interface Notification {
  id: string;
  userId: string;
  // v2.5.28: null for personal (standalone) task notifications — they have no team.
  teamId: string | null;
  type: NotifyType;
  // Shape varies per type; consumers cast based on type.
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export async function listNotifications(opts?: { unreadOnly?: boolean; limit?: number }) {
  const params: Record<string, string> = {};
  if (opts?.unreadOnly) params.unreadOnly = 'true';
  if (opts?.limit) params.limit = String(opts.limit);
  return (await api.get<Notification[]>('/notifications', { params })).data;
}

export async function unreadCount(): Promise<number> {
  return (await api.get<{ count: number }>('/notifications/unread-count')).data.count;
}

export async function markRead(notificationId: string): Promise<void> {
  await api.post(`/notifications/${notificationId}/read`);
}

export async function markAllRead(): Promise<void> {
  await api.post('/notifications/read-all');
}

// v2.5.24 (W1.3): mint a single-use ticket for the notifications WebSocket.
// The browser exchanges its (in-memory) bearer token for an opaque ticket over
// this authenticated POST, then opens the socket with `?ticket=`. Tickets expire
// in ~30s, so fetch a fresh one immediately before every connect — never cache.
export async function wsTicket(): Promise<{ ticket: string; expiresInSec: number }> {
  return (await api.post<{ ticket: string; expiresInSec: number }>('/ws/ticket')).data;
}
