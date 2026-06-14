// v1.64: instance scheduling flags from GET /api/system/info bootstrap.

let _rollOffdayDueDates = false;
let _workingDaysOnly = false;

export function adoptServerScheduling(
  prefs:
    | {
        schedulingRollOffdayDueDates?: boolean;
        schedulingWorkingDaysOnly?: boolean;
      }
    | null
    | undefined,
): void {
  if (!prefs) return;
  _rollOffdayDueDates = prefs.schedulingRollOffdayDueDates === true;
  _workingDaysOnly = prefs.schedulingWorkingDaysOnly === true;
}

export function isRollOffdayDueDatesEnabled(): boolean {
  return _rollOffdayDueDates;
}

export function isSchedulingWorkingDaysOnly(): boolean {
  return _workingDaysOnly;
}
