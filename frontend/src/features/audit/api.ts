import { api } from '@/lib/api';

export interface AuditEntry {
  id: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  teamId: string | null;
  teamName: string | null;
  meta: unknown;
  createdAt: string;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

export interface AuditFilters {
  teamId?: string;
  actorId?: string;
  action?: string;
  since?: string; // ISO timestamp
  until?: string;
  cursor?: string;
  limit?: number;
}

export async function fetchAudit(filters: AuditFilters = {}): Promise<AuditPage> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== '' && v !== null) params[k] = String(v);
  }
  return (await api.get<AuditPage>('/audit', { params })).data;
}
