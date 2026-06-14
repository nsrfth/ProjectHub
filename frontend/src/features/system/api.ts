import { api } from '@/lib/api';

export interface SystemInfo {
  name: string;
  version: string;
  buildTime: string | null;
  nodeEnv: string;
  // Int[] of weekday IDs (0=Sun..6=Sat). Days the instance treats as
  // off-days. Default [0,6]; admins can pick any subset.
  calendarWeekend: number[];
  calendarHolidays: Array<{
    id: string;
    date: string;
    name: string;
    recurring: boolean;
  }>;
  // v1.18: instance-wide rule for who can MODIFY (vs add when null) the
  // dueDate / plannedDate / completedAt fields. "open" preserves the
  // pre-v1.18 behaviour; "manager-only" lets members add but not change.
  dateEditRestriction: 'open' | 'manager-only';
  schedulingRollOffdayDueDates: boolean;
  schedulingWorkingDaysOnly: boolean;
  counts: {
    users: number;
    teams: number;
    tasks: number;
  };
}

export async function fetchSystemInfo(): Promise<SystemInfo> {
  return (await api.get<SystemInfo>('/system/info')).data;
}

// v1.16 "update available" check. Admin-only on the backend; the SPA
// gates the call by role so non-admins never trigger a 403.
export interface UpdateCheck {
  currentVersion: string;
  // False when the operator hasn't set UPDATE_CHECK_ENABLED. UI hides the
  // whole badge in that case (the check is opt-in, not a missing feature).
  enabled: boolean;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
}

export async function fetchUpdateCheck(): Promise<UpdateCheck> {
  return (await api.get<UpdateCheck>('/admin/update-check')).data;
}

// v1.22: trigger an in-app self-upgrade via the updater sidecar. Returns 503
// if the sidecar isn't configured; the SPA surfaces a friendly hint then.
export async function triggerUpgrade(): Promise<{ status: string; startedAt: string }> {
  return (await api.post<{ status: string; startedAt: string }>('/admin/upgrade')).data;
}
