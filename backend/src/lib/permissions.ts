// v1.23: permission constants. The full set of capability strings the app
// honours. Anything not on this list isn't a permission — it's either an
// implicit team-member capability (creating tasks, commenting, listing) or
// a global-admin-only operation.
//
// NEW PERMISSION CHECKLIST (read before adding):
//   1. Add the string to `PERMISSIONS` below.
//   2. Add it to `PERMISSION_GROUPS` so the matrix UI renders it under the
//      right header.
//   3. Add it to the default `Manager` system-role permission list in the
//      seed + migration so existing teams keep working.
//   4. Decide whether it should appear in the default `Member` list (be
//      conservative).
//   5. Refactor the call site to use requirePermission(...) or hasPermission(...).
//   6. Add a test that covers (a) granted, (b) revoked, (c) admin bypass.

export const PERMISSIONS = [
  // Task lifecycle.
  'task.delete',
  'task.modify_dates',
  'task.change_technician',
  'task.change_assignee',
  // v1.29: add / remove dependency edges between tasks. Default = Manager
  // only — curating the dependency graph is a curator's job. Admins bypass.
  'task.manage_dependencies',

  // Comment moderation.
  'comment.delete_others',

  // Project lifecycle. Owner bypass still applies at the service layer
  // (project owners can always edit / delete their own projects regardless
  // of permission).
  'project.edit',
  'project.delete',
  'project.set_accountable',

  // Team membership + governance.
  'team.invite_member',
  'team.remove_member',
  'team.change_role',
  'team.manage_roles', // Create / edit / delete role definitions themselves.
  // v1.30.8 (S-22): rename / re-slug / re-colour the team. Was gated
  // solely by the legacy requireTeamRole('MANAGER') enum check; that
  // bypassed the v1.23 custom-role system, so a team could not grant
  // (or withhold) team-detail edits via a custom role.
  'team.edit_details',
  // v1.48: delete an empty team (no projects / live tasks). Managers with
  // this permission; global ADMIN bypasses via hasPermission.
  'team.delete',

  // Integrations.
  'webhooks.manage',

  // Trash. The `trash.emptyAllowedRoles` InstanceSetting (v1.21) gates this
  // on TOP of the permission — both layers must pass.
  'trash.purge',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// UI-side grouping for the matrix. Renders one section per group. Adding
// a new permission without updating this map leaves it ungrouped (would
// surface a "(other)" bucket in the UI rather than disappear).
export const PERMISSION_GROUPS: Record<string, readonly Permission[]> = {
  Tasks: [
    'task.delete',
    'task.modify_dates',
    'task.change_technician',
    'task.change_assignee',
    'task.manage_dependencies',
  ],
  Comments: ['comment.delete_others'],
  Projects: ['project.edit', 'project.delete', 'project.set_accountable'],
  Team: [
    'team.invite_member',
    'team.remove_member',
    'team.change_role',
    'team.manage_roles',
    'team.edit_details',
    'team.delete',
  ],
  Integrations: ['webhooks.manage'],
  Trash: ['trash.purge'],
};

// Validate a string against the known constants. Used by the role-update
// path so admins can't sneak typo'd or unrecognised permissions into the
// junction table — even though the check is exact-match (a typo wouldn't
// grant anything), keeping the table clean of garbage matters for the UI.
const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);
export function isValidPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

// Default permission contents for the two seeded system roles per team. The
// migration uses the same defaults; keeping them here is also handy for the
// "Reset to defaults" affordance the UI might offer later.
export const DEFAULT_MANAGER_PERMISSIONS: readonly Permission[] = PERMISSIONS;
export const DEFAULT_MEMBER_PERMISSIONS: readonly Permission[] = [
  'task.delete',
  'task.modify_dates',
];
