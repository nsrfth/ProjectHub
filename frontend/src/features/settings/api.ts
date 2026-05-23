import { api } from '@/lib/api';

export interface InstanceSetting {
  key: string;
  // value is intentionally untyped — per-key shape is enforced by the
  // consumer. Phase 1 has no concrete keys yet.
  value: unknown;
  updatedAt: string;
  updatedBy: string | null;
}

export async function listInstanceSettings(): Promise<{ items: InstanceSetting[] }> {
  return (await api.get<{ items: InstanceSetting[] }>('/settings/instance')).data;
}

export async function getInstanceSetting(key: string): Promise<InstanceSetting> {
  return (await api.get<InstanceSetting>(`/settings/instance/${encodeURIComponent(key)}`)).data;
}

export async function upsertInstanceSetting(
  key: string,
  value: unknown,
): Promise<InstanceSetting> {
  return (
    await api.put<InstanceSetting>(`/settings/instance/${encodeURIComponent(key)}`, {
      value,
    })
  ).data;
}

export async function deleteInstanceSetting(key: string): Promise<void> {
  await api.delete(`/settings/instance/${encodeURIComponent(key)}`);
}
