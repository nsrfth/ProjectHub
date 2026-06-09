import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import * as projectsApi from '@/features/projects/api';
import { formatShamsiTimestampDate } from '@/lib/shamsi';
import CreateProjectForm from '@/features/projects/CreateProjectForm';
import Modal from '@/features/ui/Modal';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

const STATUS_LABEL: Record<projectsApi.ProjectStatus, string> = {
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  ARCHIVED: 'Archived',
};

export default function ProjectsPage(): JSX.Element {
  const { user } = useAuth();
  const { teams, currentTeam } = useTeams();
  const qc = useQueryClient();
  const nav = useNavigate();

  // v1.40: page-level team scope dropped. The list endpoint is now
  // cross-team — the SPA shows every project the caller can see across
  // every team they belong to, with a team chip per row.
  // v1.39 (BREAKING): only the project owner OR a global ADMIN can edit.
  const isAdmin = user?.globalRole === 'ADMIN';

  const { data: projects = [], isLoading, isError } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => projectsApi.listAllProjects(),
  });

  const [createOpen, setCreateOpen] = useState(false);

  // v1.41: PATCH budget on an existing row. Takes the row's teamId so it
  // works across the cross-team list.
  const updateBudgetMut = useMutation({
    mutationFn: (args: {
      teamId: string;
      projectId: string;
      plannedBudget: string | null;
      actualSpent: string | null;
    }) =>
      projectsApi.updateProject(args.teamId, args.projectId, {
        plannedBudget: args.plannedBudget,
        actualSpent: args.actualSpent,
      }),
    onSuccess: async (_d, vars) => {
      await qc.invalidateQueries({ queryKey: ['projects', 'all'] });
      await qc.invalidateQueries({ queryKey: ['projects', vars.teamId] });
    },
    onError: (err) => {
      window.alert(errorMessage(err, 'Could not save budget'));
    },
  });

  // v1.40: per-row delete takes the project's own teamId (each row may
  // belong to a different team in the cross-team list).
  const deleteMut = useMutation({
    mutationFn: (args: { teamId: string; projectId: string }) =>
      projectsApi.deleteProject(args.teamId, args.projectId),
    onSuccess: async (_d, vars) => {
      await qc.invalidateQueries({ queryKey: ['projects', 'all'] });
      await qc.invalidateQueries({ queryKey: ['projects', vars.teamId] });
    },
  });

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold">Projects</h1>
        {teams.length > 0 && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1 rounded-md bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium px-3 py-1.5"
          >
            <span aria-hidden className="text-base leading-none">
              +
            </span>
            New project
          </button>
        )}
      </div>

      {teams.length === 0 && (
        <section className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded p-4 mb-6 text-sm text-amber-900 dark:text-amber-100">
          You are not a member of any team yet, so you cannot create projects here.{' '}
          <Link to="/teams" className="underline font-medium">
            Join or create a team
          </Link>{' '}
          to add one.{' '}
          {isAdmin && 'As an admin, projects you already own (or any project on the instance) still appear below.'}
        </section>
      )}

      {createOpen && (
        <Modal title="Create new project" onClose={() => setCreateOpen(false)}>
          <CreateProjectForm
            teams={teams}
            currentTeamId={currentTeam?.id ?? null}
            onSuccess={() => setCreateOpen(false)}
            onCancel={() => setCreateOpen(false)}
          />
        </Modal>
      )}

      <section className="bg-white dark:bg-slate-800 rounded shadow p-4">
        <h2 className="text-sm font-medium mb-2">All projects</h2>
        {isLoading && <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>}
        {isError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Could not load projects. Refresh the page — if this persists, the server may need an update.
          </p>
        )}
        {!isLoading && !isError && projects.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {isAdmin
              ? 'No projects on this instance yet.'
              : teams.length === 0
                ? 'Join a team first, then create a project you own.'
                : 'No projects you own yet. Since v1.39, each member only sees projects they created (project owner). Team managers no longer see teammates\' projects — ask an admin to transfer ownership or create your own.'}
          </p>
        )}
        <ul className="divide-y dark:divide-slate-700">
          {projects.map((p) => {
            const canEdit = p.ownerId === user?.id || isAdmin;
            return (
              <li key={p.id} className="py-3">
                <div className="flex items-start justify-between gap-4">
                  <button
                    type="button"
                    onClick={() => nav(`/projects/${p.id}/tasks`)}
                    className="text-left min-w-0 flex-1 hover:underline"
                  >
                    <div className="flex items-center gap-2">
                      <p className="font-medium truncate">{p.name}</p>
                      <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 shrink-0">
                        {STATUS_LABEL[p.status]}
                      </span>
                    </div>
                    {p.description && (
                      <p className="text-sm text-slate-600 dark:text-slate-300 mt-0.5 truncate">{p.description}</p>
                    )}
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                      Owned by{' '}
                      {p.ownerId === user?.id
                        ? 'you'
                        : p.ownerId
                          ? p.ownerId.slice(0, 8) + '…'
                          : '(deleted user)'}
                      {' · Accountable: '}
                      {p.accountableName ?? <span className="italic">unassigned</span>}
                      {' · '}
                      <span dir="rtl">ایجاد {formatShamsiTimestampDate(p.createdAt)}</span>
                    </p>
                  </button>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    {/* v1.40: per-row team chip — rows can belong to
                        different teams in the cross-team list. */}
                    <span
                      className="text-[11px] uppercase tracking-wide rounded-full bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 px-2 py-0.5"
                      title={`Team: ${p.teamName}`}
                    >
                      {p.teamName}
                    </span>
                    {/* v1.42: Gantt report link — visible to all viewers
                        of the row (read-only report). */}
                    <Link
                      to={`/projects/${p.id}/reports/gantt`}
                      className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      Gantt
                    </Link>
                    {canEdit && (
                      <button
                        onClick={() => {
                          if (window.confirm(`Delete project "${p.name}"?`))
                            deleteMut.mutate({ teamId: p.teamId, projectId: p.id });
                        }}
                        disabled={deleteMut.isPending}
                        className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
                {/* v1.41: budget row — read-only display + inline editor
                    for owners / admins. Hidden entirely when no budget
                    is set and the caller can't edit (keeps the row clean). */}
                <BudgetRow
                  project={p}
                  canEdit={canEdit}
                  pending={updateBudgetMut.isPending}
                  onSave={(planned, actual) =>
                    updateBudgetMut.mutate({
                      teamId: p.teamId,
                      projectId: p.id,
                      plannedBudget: planned,
                      actualSpent: actual,
                    })
                  }
                />
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

// v1.41: per-row budget display + inline editor. Read-only mode shows
// "Budget: planned / spent (xx%)" or "Budget: spent" when only spent is
// set. Edit mode opens two number inputs + save/clear/cancel. Hidden
// entirely when no budget is set AND the caller can't edit, so non-owners
// without an admin role don't see noise on every row.
function BudgetRow({
  project,
  canEdit,
  pending,
  onSave,
}: {
  project: projectsApi.Project;
  canEdit: boolean;
  pending: boolean;
  onSave: (plannedBudget: string | null, actualSpent: string | null) => void;
}): JSX.Element | null {
  const [editing, setEditing] = useState(false);
  const [planned, setPlanned] = useState(project.plannedBudget ?? '');
  const [actual, setActual] = useState(project.actualSpent ?? '');
  // Re-sync local edit state when the row's server state changes (e.g.
  // after the parent invalidates the list and a new row instance arrives).
  // We deliberately do NOT compare to current state to avoid races where
  // the user opens edit, types, and a background refetch stomps inputs.
  // The simplest correct rule: sync ONLY when entering edit mode.
  useEffect(() => {
    if (editing) {
      setPlanned(project.plannedBudget ?? '');
      setActual(project.actualSpent ?? '');
    }
  }, [editing, project.plannedBudget, project.actualSpent]);

  const hasBudget = !!(project.plannedBudget || project.actualSpent);
  if (!hasBudget && !canEdit) return null;

  // Utilization % only when both fields are present AND planned > 0.
  // Locale-formatted to one decimal for readability.
  const utilization =
    project.plannedBudget && project.actualSpent && Number(project.plannedBudget) > 0
      ? (Number(project.actualSpent) / Number(project.plannedBudget)) * 100
      : null;

  const fmt = (s: string | null): string =>
    s === null
      ? '—'
      : Number(s).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

  // Client-side mirror of the server rule for the Save button.
  const validNumber = (v: string): boolean =>
    v.trim().length === 0 ||
    (/^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) >= 0);
  const plannedInvalid = !validNumber(planned);
  const actualInvalid = !validNumber(actual);

  return (
    <div className="mt-2 ml-7 text-xs">
      {!editing ? (
        <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
          <span className="font-medium">Budget:</span>
          <span>
            Planned <code>{fmt(project.plannedBudget)}</code> · Spent{' '}
            <code>{fmt(project.actualSpent)}</code>
            {utilization !== null && (
              <span
                className={
                  ' ml-2 ' +
                  (utilization > 100
                    ? 'text-red-600 dark:text-red-400'
                    : utilization > 80
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-emerald-600 dark:text-emerald-400')
                }
                title="Actual ÷ Planned"
              >
                ({utilization.toFixed(1)}%)
              </span>
            )}
          </span>
          {canEdit && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="ml-auto text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              Edit
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            <span className="text-slate-500 dark:text-slate-400">Planned</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={planned}
              onChange={(e) => setPlanned(e.target.value)}
              className="w-28 rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-1 py-0.5 border"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-slate-500 dark:text-slate-400">Actual Spent</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={actual}
              onChange={(e) => setActual(e.target.value)}
              className="w-28 rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-1 py-0.5 border"
            />
          </label>
          {(plannedInvalid || actualInvalid) && (
            <span className="text-red-600 dark:text-red-400">
              Use a non-negative number with up to 2 decimals.
            </span>
          )}
          <div className="flex gap-1 ml-auto">
            <button
              type="button"
              disabled={pending || plannedInvalid || actualInvalid}
              onClick={() => {
                onSave(planned.trim() ? planned.trim() : null, actual.trim() ? actual.trim() : null);
                setEditing(false);
              }}
              className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded px-2 py-0.5 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setPlanned('');
                setActual('');
                onSave(null, null);
                setEditing(false);
              }}
              className="text-slate-500 dark:text-slate-400 hover:underline"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-slate-500 dark:text-slate-400 hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
