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
  'task.change_responsible',
  'task.change_assignee',
  // v1.29: add / remove dependency edges between tasks. Default = Manager
  // only — curating the dependency graph is a curator's job. Admins bypass.
  'task.manage_dependencies',
  // v2.6 (Phase 1C): assign work to ANYONE eligible on the project, ignoring
  // unit scope. Without it, a supervisor may only assign within their own unit
  // plus collaborators explicitly granted the project.
  //
  // This is also the escape hatch for the unresolved-unit case: a person the
  // directory sync could not place in a unit is assignable ONLY by a holder of
  // this permission, and appears on the unit-coverage exception report. The
  // system degrades to "a manager can still assign anyone" rather than to
  // "nobody can assign this person", which is what an un-escaped scope rule
  // would do to exactly the field staff this programme is for.
  'task.assign_any',

  // Comment moderation.
  'comment.delete_others',

  // Project lifecycle. Owner bypass still applies at the service layer
  // (project owners can always edit / delete their own projects regardless
  // of permission).
  'project.edit',
  'project.delete',
  'project.set_accountable',
  // v2.6 (Phase 2): grant another subject access to a project — the single
  // permission behind the unified Sharing panel.
  //
  // Deliberately separate from `project.edit`: sharing a project outward is a
  // different act from renaming it, and collapsing them would mean every
  // manager who can rename a project can also expose it to another team.
  // Whole-team sharing additionally requires the Phase 3 request-and-accept
  // flow (D-5/D-7); global ADMIN retains an imposed path.
  'project.share',
  // v1.79: WRITE access (nested scope) to EVERY project in the team — add /
  // modify tasks, comments, dependencies, etc. in any team project without
  // owning it or holding a FULL group grant. Deliberately DISTINCT from
  // `project.edit` (which stays view/rename-visibility only) so granting
  // team-wide write is an explicit choice, never a side effect of edit
  // visibility. Default ON for the Manager system role.
  'project.write_all',
  // v2.5.54: READ access (both view + nested scope) to EVERY project in the
  // team — the read-only twin of `project.write_all`. Lets an oversight role
  // (PMO) list and open any team project + its tasks without owning them and
  // WITHOUT any edit capability: resolveProjectAccess caps this at READ and it
  // can never escalate to WRITE. Distinct from `project.edit` (view/rename
  // visibility, view-scope only). Default ON for the Manager system role.
  'project.read_all',

  // v1.50: team user groups — create groups, assign members, grant projects.
  'group.manage',

  // v1.58: team-scoped custom field definitions (create/edit/delete/reorder).
  'customfield.manage',

  // v1.69: intake form builder + public-token management.
  'form.manage',

  // v1.90: correspondence (دبیرخانه) module. `correspondence.read` lets a
  // member view a project's letters register + referrals; `correspondence.manage`
  // gates create/update/delete/status/refer of letters; `contacts.manage` gates
  // the team-level contacts directory writes. The per-project enablement flag
  // (admin-controlled) is a separate gate ON TOP of these. Default Member set
  // includes `correspondence.read`; the rest are Manager-default.
  'correspondence.read',
  'correspondence.manage',
  'contacts.manage',

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
  // v1.60: no-code automation rules (triggers, conditions, actions).
  'automation.manage',

  // Trash. The `trash.emptyAllowedRoles` InstanceSetting (v1.21) gates this
  // on TOP of the permission — both layers must pass.
  'trash.purge',

  // v1.95 (PMIS R0 — plumbing): permission substrate for the PMIS waves. These
  // keys are pre-registered here so the role matrix + backfill exist before the
  // features that enforce them land (profiles in R2, portfolio in R3, baseline
  // capture in the remaining R1 slice). They gate nothing yet — adding them is
  // inert until a `requirePermission(...)` call site references one. Naming
  // follows the existing dot convention (NOT the `pmo:*` colon form the roadmap
  // sketched — TaskHub permission keys are flat dot strings, no wildcards).
  //
  // PMO / Project-Admin: manage profile definitions + assign/override them on a
  // project, and set the team/group profile defaults. Distinct from team
  // governance so "who controls project profiles" is a deliberate grant.
  'pmo.manage_profiles',
  'pmo.assign_profile',
  'pmo.override_profile',
  'pmo.set_team_defaults',
  'pmo.set_group_defaults',
  // Neutral-core: capture a formal project schedule baseline (the upcoming
  // ProjectBaseline entity). `core.set_health` is intentionally NOT added — the
  // v1.91 RAG health endpoint already gates on project WRITE (assertCanWriteProject),
  // so a separate permission would be permanently dead.
  'core.capture_baseline',
  // Portfolio / Program (OrgUnit tree): view roll-ups, manage the tree, attach
  // projects, and manage portfolio managers.
  'portfolio.view',
  'portfolio.manage',
  'portfolio.attach_project',
  'portfolio.manage_managers',
  // v2.0 (PMIS R4 — cost control + time tracking). All ADDITIVE to the profile
  // module gate (`cost_control` / `timesheets`): a role still needs these to
  // mutate, and the module must be enabled for the project. Logging your OWN
  // time is an implicit member capability (like creating a task) — no perm.
  // `cost.manage` gates the cost ledger (cost accounts, budget lines,
  // commitments, expenses, manual/reversing actuals, FX rates). `timesheet.approve`
  // gates approving/rejecting OTHERS' timesheet periods (period owners submit
  // their own). `timesheet.manage_rates` gates the team rate-card admin.
  'cost.manage',
  'timesheet.approve',
  'timesheet.manage_rates',
  // v2.2 (PMIS R6): resource catalog + assignment management.
  'resource.manage',
  // v2.4 (PMIS R8): generic record framework (Issues, RFIs, Documents, etc.).
  'record.manage',
  // v2.5 (PMIS R9): specialized lifecycle modules.
  'risk.manage',
  'change.manage',
  'change.approve',
  'procurement.manage',
  'quality.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// UI-side grouping for the matrix. Renders one section per group. Adding
// a new permission without updating this map leaves it ungrouped (would
// surface a "(other)" bucket in the UI rather than disappear).
export const PERMISSION_GROUPS: Record<string, readonly Permission[]> = {
  Tasks: [
    'task.delete',
    'task.modify_dates',
    'task.change_responsible',
    'task.change_assignee',
    'task.manage_dependencies',
    'task.assign_any',
  ],
  Comments: ['comment.delete_others'],
  Projects: [
    'project.edit',
    'project.delete',
    'project.set_accountable',
    'project.share',
    'project.write_all',
    'project.read_all',
  ],
  Groups: ['group.manage'],
  CustomFields: ['customfield.manage'],
  Forms: ['form.manage'],
  Correspondence: ['correspondence.read', 'correspondence.manage', 'contacts.manage'],
  Team: [
    'team.invite_member',
    'team.remove_member',
    'team.change_role',
    'team.manage_roles',
    'team.edit_details',
    'team.delete',
  ],
  Integrations: ['webhooks.manage', 'automation.manage'],
  Trash: ['trash.purge'],
  // v1.95 (PMIS R0): substrate groups — render the new namespaces in the matrix.
  PMO: [
    'pmo.manage_profiles',
    'pmo.assign_profile',
    'pmo.override_profile',
    'pmo.set_team_defaults',
    'pmo.set_group_defaults',
  ],
  Core: ['core.capture_baseline'],
  Portfolio: [
    'portfolio.view',
    'portfolio.manage',
    'portfolio.attach_project',
    'portfolio.manage_managers',
  ],
  // v2.0 (PMIS R4): cost + time control.
  Cost: ['cost.manage'],
  Timesheets: ['timesheet.approve', 'timesheet.manage_rates'],
  // v2.2 (PMIS R6): resource management.
  Resources: ['resource.manage'],
  // v2.4 (PMIS R8): record framework.
  Records: ['record.manage'],
  // v2.5 (PMIS R9): specialized lifecycle.
  Risk: ['risk.manage'],
  ChangeControl: ['change.manage', 'change.approve'],
  Procurement: ['procurement.manage'],
  Quality: ['quality.manage'],
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
// v2.6 (Phase 1B/1C): permission keys introduced AFTER the v1.23 RBAC
// migration. The legacy fallback path must never auto-grant these.
//
// Why this list exists at all:
//
// `hasPermission` is dual-path — it consults the custom role only when
// `TeamMembership.roleId` is non-null, and otherwise falls back to the sets
// below. Because the manager default WAS literally `PERMISSIONS`, every new
// key added anywhere in this file was instantly granted to every legacy-manager
// membership still on the fallback path, and no edit to a seeded role template
// could take it away. That is the programme's risk R-1, and it is not
// hypothetical: `task.change_assignee` has existed since v1.23 with zero
// enforcement sites, so keys and enforcement have already drifted once.
//
// The Phase 1B backfill (zero null `roleId` instance-wide) is the real fix and
// removes the fallback path entirely in Phase 6. This list is the belt to that
// braces: until the backfill is verified complete on every installation, a new
// key stays inert on the fallback path instead of silently escalating.
//
// Do NOT add pre-v2.6 keys here — that would REVOKE capabilities legacy
// managers already rely on. This is only for keys that never existed during the
// dual-path era.
const POST_RBAC_MIGRATION_PERMISSIONS: readonly string[] = [
  'task.assign_any',
  'project.share',
];

export const DEFAULT_MANAGER_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (p) => !POST_RBAC_MIGRATION_PERMISSIONS.includes(p),
);
export const DEFAULT_MEMBER_PERMISSIONS: readonly Permission[] = [
  'task.delete',
  'task.modify_dates',
  // v1.90: members can view a project's letters register by default; managing
  // letters (create/refer/…) and contacts stays Manager-default.
  'correspondence.read',
];

// v2.5.54: default permission set for the seeded PMO (Project Management
// Office) system role — the third system role alongside Manager / Member.
// Oversight-first: READ across every team project (`project.read_all`),
// profile/standards governance (`pmo.*`), baseline capture, portfolio roll-up
// visibility + project attachment, and the two governance approval gates. It
// deliberately EXCLUDES every project/task authoring write (`task.*`,
// `project.write_all`, `cost.manage`, the `*.manage` module writes,
// `portfolio.manage`) so a PMO stays read-only on project/task content. Widen
// per team via the role matrix if a given PMO also needs to author.
export const DEFAULT_PMO_PERMISSIONS: readonly Permission[] = [
  'project.read_all',
  'portfolio.view',
  'portfolio.attach_project',
  'pmo.manage_profiles',
  'pmo.assign_profile',
  'pmo.override_profile',
  'pmo.set_team_defaults',
  'pmo.set_group_defaults',
  'core.capture_baseline',
  'change.approve',
  'timesheet.approve',
];
