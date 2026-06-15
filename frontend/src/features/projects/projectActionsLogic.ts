/** Toggle which row's actions menu is open (only one at a time). */
export function toggleActionsMenuProjectId(
  current: string | null,
  projectId: string,
): string | null {
  return current === projectId ? null : projectId;
}

/** Whether the per-row actions menu should render at all. */
export function shouldShowProjectActionsMenu(canManage: boolean): boolean {
  return canManage;
}

export const PROJECT_ACTION_I18N_KEYS = [
  'projects.actions',
  'projects.action.edit',
  'projects.action.editBudget',
  'projects.action.delete',
  'projects.edit.title',
  'projects.edit.name',
  'projects.edit.description',
  'projects.edit.status',
  'projects.edit.save',
  'projects.edit.cancel',
  'projects.delete.confirm',
  'projects.status.active',
  'projects.status.onHold',
  'projects.status.archived',
  'projects.bucketAssign',
  'projects.budget.label',
  'projects.budget.planned',
  'projects.labels',
] as const;
