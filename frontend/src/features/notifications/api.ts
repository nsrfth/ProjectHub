import { api } from '@/lib/api';

export type NotifyType =
  | 'TASK_ASSIGNED'
  | 'TASK_COMMENT'
  | 'TASK_DUE'
  | 'MENTION'
  | 'TASK_STATUS';

export interface Notification {
  id: string;
  userId: string;
  teamId: string;
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
