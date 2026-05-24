import { api } from '@/lib/api';

export interface SystemInfo {
  name: string;
  version: string;
  buildTime: string | null;
  nodeEnv: string;
  // Int[] of weekday IDs (0=Sun..6=Sat). Days the instance treats as
  // off-days. Default [0,6]; admins can pick any subset.
  calendarWeekend: number[];
  counts: {
    users: number;
    teams: number;
    tasks: number;
  };
}

export async function fetchSystemInfo(): Promise<SystemInfo> {
  return (await api.get<SystemInfo>('/system/info')).data;
}
