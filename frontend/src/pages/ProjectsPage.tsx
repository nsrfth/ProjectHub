import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import * as projectsApi from '@/features/projects/api';
import { getTeam } from '@/features/teams/api';
import { formatShamsiTimestampDate } from '@/lib/shamsi';

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
  const { teams, currentTeam, setCurrentTeamId } = useTeams();
  const qc = useQueryClient();
  const nav = useNavigate();

  const teamId = currentTeam?.id ?? null;
  const isManager = currentTeam?.myRole === 'MANAGER';

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects', teamId],
    queryFn: () => projectsApi.listProjects(teamId!),
    enabled: !!teamId,
  });

  // v1.17: team members feed the inline (per-project-row) Accountable
  // dropdowns. Re-uses the team detail endpoint; cached 30 s by React
  // Query so re-renders don't re-fetch. Always queries the currentTeam
  // because those rows are the current team's projects.
  const { data: teamDetail } = useQuery({
    queryKey: ['teams', 'detail', teamId],
    queryFn: () => getTeam(teamId!),
    enabled: !!teamId,
    staleTime: 30_000,
  });
  const members = teamDetail?.members ?? [];

  // v1.33: the New-project form gets its OWN team picker independent of
  // the page-level currentTeam. The accountable dropdown there reads
  // members from the selected team — switching the picker re-fetches
  // automatically via React Query's cache key. Defaults to currentTeam
  // on first render.
  const [formTeamId, setFormTeamId] = useState<string>(() => currentTeam?.id ?? '');
  const effectiveFormTeamId = formTeamId || currentTeam?.id || '';
  const { data: formTeamDetail } = useQuery({
    queryKey: ['teams', 'detail', effectiveFormTeamId],
    queryFn: () => getTeam(effectiveFormTeamId),
    enabled: !!effectiveFormTeamId,
    staleTime: 30_000,
  });
  const formMembers = formTeamDetail?.members ?? [];

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [accountableId, setAccountableId] = useState<string>('');
  const [createError, setCreateError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: (input: { name: string; description?: string; accountableId?: string | null }) =>
      projectsApi.createProject(effectiveFormTeamId, input),
    onSuccess: async () => {
      setName('');
      setDescription('');
      setAccountableId('');
      setCreateError(null);
      // If the new project landed in a team other than the one whose
      // list this page is showing, switch the page context to that team
      // so the freshly-created project is visible without a separate
      // click. Both queries get invalidated so the list refreshes either
      // way.
      if (effectiveFormTeamId !== teamId) {
        setCurrentTeamId(effectiveFormTeamId);
      }
      await qc.invalidateQueries({ queryKey: ['projects', effectiveFormTeamId] });
      if (teamId && teamId !== effectiveFormTeamId) {
        await qc.invalidateQueries({ queryKey: ['projects', teamId] });
      }
    },
    onError: (err) => setCreateError(errorMessage(err, 'Could not create project')),
  });

  // PATCH the accountable field on an existing project. Optimistic invalidate;
  // React Query will refetch the list when the mutation resolves.
  const updateAccountableMut = useMutation({
    mutationFn: (args: { projectId: string; accountableId: string | null }) =>
      projectsApi.updateProject(teamId!, args.projectId, { accountableId: args.accountableId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects', teamId] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (projectId: string) => projectsApi.deleteProject(teamId!, projectId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects', teamId] });
    },
  });

  async function onCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    createMut.mutate({
      name,
      description: description || undefined,
      accountableId: accountableId || null,
    });
  }

  if (!currentTeam) {
    return (
      <div className="min-h-screen p-8 max-w-3xl mx-auto">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Select or{' '}
          <Link to="/teams" className="underline">
            create a team
          </Link>{' '}
          first.
        </p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          in <span className="font-medium">{currentTeam.name}</span>
        </p>
      </div>

      <section className="bg-white dark:bg-slate-800 rounded shadow p-4 mb-6">
        <h2 className="text-sm font-medium mb-2">New project</h2>
        <form onSubmit={onCreate} className="space-y-2">
          {/* v1.33: team picker. Only rendered when the user belongs to
              more than one team — single-team users would just see a
              read-only field that adds no information. Changing the team
              clears the accountable selection because the previously-picked
              user almost certainly isn't a member of the new team. */}
          {teams.length > 1 && (
            <label className="block">
              <span className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Team</span>
              <select
                value={effectiveFormTeamId}
                onChange={(e) => {
                  setFormTeamId(e.target.value);
                  setAccountableId('');
                }}
                className="w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 border text-sm"
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.myRole.toLowerCase()})
                  </option>
                ))}
              </select>
            </label>
          )}
          <input
            type="text"
            required
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 border text-sm"
          />
          <textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 border text-sm"
            rows={2}
          />
          <select
            value={accountableId}
            onChange={(e) => setAccountableId(e.target.value)}
            className="w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 border text-sm"
            title="Accountable (RACI) — the person on the hook for this project's outcomes"
          >
            <option value="">Accountable (optional) — none</option>
            {formMembers.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name} ({m.role})
              </option>
            ))}
          </select>
          {createError && <p className="text-xs text-red-600 dark:text-red-400">{createError}</p>}
          <button
            type="submit"
            disabled={createMut.isPending || !effectiveFormTeamId}
            className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
          >
            {createMut.isPending ? 'Creating…' : 'Create project'}
          </button>
        </form>
      </section>

      <section className="bg-white dark:bg-slate-800 rounded shadow p-4">
        <h2 className="text-sm font-medium mb-2">All projects</h2>
        {isLoading && <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>}
        {!isLoading && projects.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">No projects yet.</p>
        )}
        <ul className="divide-y dark:divide-slate-700">
          {projects.map((p) => {
            const canEdit = p.ownerId === user?.id || isManager;
            return (
              <li key={p.id} className="py-3 flex items-start justify-between gap-4">
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
                  {/* Accountable change inline only for editors — same gate
                      as Delete. Members see the read-only label above. */}
                  {canEdit && (
                    <select
                      value={p.accountableId ?? ''}
                      onChange={(e) =>
                        updateAccountableMut.mutate({
                          projectId: p.id,
                          accountableId: e.target.value || null,
                        })
                      }
                      disabled={updateAccountableMut.isPending}
                      className="text-xs rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-1 py-0.5 max-w-[12rem]"
                      title="Change accountable"
                    >
                      <option value="">— Accountable —</option>
                      {members.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {canEdit && (
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete project "${p.name}"?`)) deleteMut.mutate(p.id);
                      }}
                      disabled={deleteMut.isPending}
                      className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
