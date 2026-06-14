import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import * as projectsApi from '@/features/projects/api';
import * as bucketsApi from '@/features/projectBuckets/api';
import ProjectBucketBoard from '@/features/projectBuckets/ProjectBucketBoard';
import BucketFormModal from '@/features/projectBuckets/BucketFormModal';
import ProjectBucketAssignMenu from '@/features/projectBuckets/ProjectBucketAssignMenu';
import {
  applyProjectFilters,
  collectTeamOptions,
  type ProjectFilterState,
} from '@/features/projectBuckets/filters';
import {
  loadCollapsedBuckets,
  loadProjectsViewMode,
  saveCollapsedBuckets,
  saveProjectsViewMode,
  type ProjectsViewMode,
} from '@/features/projectBuckets/storage';
import { formatShamsiTimestampDate } from '@/lib/shamsi';
import CreateProjectForm from '@/features/projects/CreateProjectForm';
import Modal from '@/features/ui/Modal';
import CurrencySelector from '@/features/budget/CurrencySelector';
import type { BudgetCurrency } from '@/lib/formatBudget';
import { budgetLocaleFromLanguage, formatBudget } from '@/lib/formatBudget';
import { getLanguage, useT } from '@/lib/i18n';

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
  const isAdmin = user?.globalRole === 'ADMIN';

  const [viewMode, setViewMode] = useState<ProjectsViewMode>(() => loadProjectsViewMode());
  const [filters, setFilters] = useState<ProjectFilterState>({ owner: 'all' });
  const [createOpen, setCreateOpen] = useState(false);
  const [bucketModal, setBucketModal] = useState<
    { mode: 'create' } | { mode: 'edit'; bucket: bucketsApi.ProjectBucket } | null
  >(null);
  const [assignProjectId, setAssignProjectId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedBuckets());
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setAssignProjectId(null);
      }
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const { data: projects = [], isLoading, isError } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => projectsApi.listAllProjects(),
  });

  const { data: buckets = [], isLoading: bucketsLoading } = useQuery({
    queryKey: ['me', 'project-buckets'],
    queryFn: bucketsApi.fetchProjectBuckets,
  });

  const bucketNamesByProject = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const b of buckets) {
      for (const pid of b.projectIds) {
        const arr = m.get(pid) ?? [];
        arr.push(b.name);
        m.set(pid, arr);
      }
    }
    return m;
  }, [buckets]);

  const filteredProjects = useMemo(
    () => applyProjectFilters(projects, filters, user?.id, bucketNamesByProject),
    [projects, filters, user?.id, bucketNamesByProject],
  );

  const projectsById = useMemo(
    () => new Map(filteredProjects.map((p) => [p.id, p])),
    [filteredProjects],
  );

  const teamOptions = useMemo(() => collectTeamOptions(projects), [projects]);

  const assignedBucketIds = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const b of buckets) {
      for (const pid of b.projectIds) {
        const s = m.get(pid) ?? new Set<string>();
        s.add(b.id);
        m.set(pid, s);
      }
    }
    return m;
  }, [buckets]);

  const invalidateBuckets = (): Promise<void> =>
    qc.invalidateQueries({ queryKey: ['me', 'project-buckets'] });

  const createBucketMut = useMutation({
    mutationFn: bucketsApi.createProjectBucket,
    onSuccess: invalidateBuckets,
    onError: (err) => window.alert(errorMessage(err, 'Could not create bucket')),
  });

  const updateBucketMut = useMutation({
    mutationFn: (args: { id: string; body: Parameters<typeof bucketsApi.updateProjectBucket>[1] }) =>
      bucketsApi.updateProjectBucket(args.id, args.body),
    onSuccess: invalidateBuckets,
    onError: (err) => window.alert(errorMessage(err, 'Could not update bucket')),
  });

  const deleteBucketMut = useMutation({
    mutationFn: bucketsApi.deleteProjectBucket,
    onSuccess: invalidateBuckets,
  });

  const reorderBucketsMut = useMutation({
    mutationFn: bucketsApi.reorderProjectBuckets,
    onMutate: async (bucketIds) => {
      await qc.cancelQueries({ queryKey: ['me', 'project-buckets'] });
      const prev = qc.getQueryData<bucketsApi.ProjectBucket[]>(['me', 'project-buckets']);
      if (prev) {
        const byId = new Map(prev.map((b) => [b.id, b]));
        qc.setQueryData(
          ['me', 'project-buckets'],
          bucketIds.map((id, i) => ({ ...byId.get(id)!, position: i })),
        );
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['me', 'project-buckets'], ctx.prev);
    },
    onSettled: invalidateBuckets,
  });

  const addToBucketMut = useMutation({
    mutationFn: (args: { bucketId: string; projectId: string }) =>
      bucketsApi.addProjectToBucket(args.bucketId, args.projectId),
    onSuccess: invalidateBuckets,
  });

  const reorderInBucketMut = useMutation({
    mutationFn: (args: { bucketId: string; projectIds: string[] }) =>
      bucketsApi.reorderBucketProjects(args.bucketId, args.projectIds),
    onSuccess: invalidateBuckets,
  });

  const setBucketsMut = useMutation({
    mutationFn: (args: { projectId: string; bucketIds: string[] }) =>
      bucketsApi.setProjectBuckets(args.projectId, args.bucketIds),
    onSuccess: invalidateBuckets,
  });

  const managerTeamIds = useMemo(
    () => new Set(teams.filter((t) => t.myRole === 'MANAGER').map((t) => t.id)),
    [teams],
  );

  const updateNameMut = useMutation({
    mutationFn: (args: { teamId: string; projectId: string; name: string }) =>
      projectsApi.updateProject(args.teamId, args.projectId, { name: args.name }),
    onSuccess: async (_d, vars) => {
      await qc.invalidateQueries({ queryKey: ['projects', 'all'] });
      await qc.invalidateQueries({ queryKey: ['projects', vars.teamId] });
    },
    onError: (err) => window.alert(errorMessage(err, 'Could not rename project')),
  });

  const updateBudgetMut = useMutation({
    mutationFn: (args: {
      teamId: string;
      projectId: string;
      plannedBudget: string | null;
      actualSpent: string | null;
      budgetCurrency?: BudgetCurrency;
    }) =>
      projectsApi.updateProject(args.teamId, args.projectId, {
        plannedBudget: args.plannedBudget,
        actualSpent: args.actualSpent,
        ...(args.budgetCurrency !== undefined && { budgetCurrency: args.budgetCurrency }),
      }),
    onSuccess: async (_d, vars) => {
      await qc.invalidateQueries({ queryKey: ['projects', 'all'] });
      await qc.invalidateQueries({ queryKey: ['projects', vars.teamId] });
    },
    onError: (err) => window.alert(errorMessage(err, 'Could not save budget')),
  });

  const deleteMut = useMutation({
    mutationFn: (args: { teamId: string; projectId: string }) =>
      projectsApi.deleteProject(args.teamId, args.projectId),
    onSuccess: async (_d, vars) => {
      await qc.invalidateQueries({ queryKey: ['projects', 'all'] });
      await qc.invalidateQueries({ queryKey: ['projects', vars.teamId] });
      await invalidateBuckets();
    },
  });

  function changeViewMode(mode: ProjectsViewMode): void {
    setViewMode(mode);
    saveProjectsViewMode(mode);
  }

  function toggleCollapse(bucketId: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(bucketId)) next.delete(bucketId);
      else next.add(bucketId);
      saveCollapsedBuckets(next);
      return next;
    });
  }

  function toggleProjectBucket(projectId: string, bucketId: string, add: boolean): void {
    const current = assignedBucketIds.get(projectId) ?? new Set<string>();
    const next = new Set(current);
    if (add) next.add(bucketId);
    else next.delete(bucketId);
    setBucketsMut.mutate({ projectId, bucketIds: [...next] });
  }

  function renderProjectMenu(project: projectsApi.ProjectCrossTeam): React.ReactNode {
    return (
      <div className="relative shrink-0" ref={assignProjectId === project.id ? menuRef : undefined}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setAssignProjectId(assignProjectId === project.id ? null : project.id);
          }}
          className="text-[10px] px-1 rounded border text-slate-500"
          title="Assign to buckets"
        >
          ☰
        </button>
        {assignProjectId === project.id && (
          <ProjectBucketAssignMenu
            buckets={buckets}
            assignedIds={assignedBucketIds.get(project.id) ?? new Set()}
            onToggle={(bucketId, add) => toggleProjectBucket(project.id, bucketId, add)}
            onClose={() => setAssignProjectId(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <div className="flex flex-wrap gap-2">
          {viewMode === 'buckets' && (
            <button
              type="button"
              onClick={() => setBucketModal({ mode: 'create' })}
              className="inline-flex items-center gap-1 rounded-md border border-indigo-500 text-indigo-600 dark:text-indigo-400 text-sm font-medium px-3 py-1.5"
            >
              + New bucket
            </button>
          )}
          {teams.length > 0 && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-1 rounded-md bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium px-3 py-1.5"
            >
              + New project
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {(['all', 'buckets'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => changeViewMode(mode)}
            className={`px-3 py-1 text-sm rounded ${
              viewMode === mode
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'border border-slate-300 dark:border-slate-600'
            }`}
          >
            {mode === 'all' ? 'All projects' : 'Personal buckets'}
          </button>
        ))}
      </div>

      <ProjectFilterBar
        filters={filters}
        onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
        teams={teamOptions}
        showOwnerFilter={isAdmin}
      />

      {teams.length === 0 && (
        <section className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded p-4 mb-6 text-sm text-amber-900 dark:text-amber-100">
          You are not a member of any team yet, so you cannot create projects here.{' '}
          <Link to="/teams" className="underline font-medium">
            Join or create a team
          </Link>
          {isAdmin && ' As an admin, projects you already own still appear below.'}
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

      {bucketModal?.mode === 'create' && (
        <BucketFormModal
          title="New personal bucket"
          onClose={() => setBucketModal(null)}
          pending={createBucketMut.isPending}
          onSubmit={(v) => {
            createBucketMut.mutate(
              { name: v.name, description: v.description || null, color: v.color },
              { onSuccess: () => setBucketModal(null) },
            );
          }}
        />
      )}

      {bucketModal?.mode === 'edit' && (
        <BucketFormModal
          title="Edit bucket"
          initial={{
            name: bucketModal.bucket.name,
            description: bucketModal.bucket.description ?? '',
            color: bucketModal.bucket.color ?? '#6366f1',
          }}
          onClose={() => setBucketModal(null)}
          pending={updateBucketMut.isPending}
          onSubmit={(v) => {
            updateBucketMut.mutate(
              {
                id: bucketModal.bucket.id,
                body: { name: v.name, description: v.description || null, color: v.color },
              },
              { onSuccess: () => setBucketModal(null) },
            );
          }}
        />
      )}

      {(isLoading || (viewMode === 'buckets' && bucketsLoading)) && (
        <p className="text-sm text-slate-500">Loading…</p>
      )}
      {isError && (
        <p className="text-sm text-red-600">Could not load projects. Refresh the page.</p>
      )}

      {!isLoading && viewMode === 'buckets' && !bucketsLoading && (
        <ProjectBucketBoard
          buckets={buckets}
          projectsById={projectsById}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          onOpenProject={(id) => nav(`/projects/${id}/tasks`)}
          onEditBucket={(b) => setBucketModal({ mode: 'edit', bucket: b })}
          onDeleteBucket={(b) => {
            if (window.confirm(`Delete bucket "${b.name}"? Projects will not be deleted.`)) {
              deleteBucketMut.mutate(b.id);
            }
          }}
          onReorderBuckets={(ids) => reorderBucketsMut.mutate(ids)}
          onAddToBucket={(bucketId, projectId) => addToBucketMut.mutate({ bucketId, projectId })}
          onReorderInBucket={(bucketId, projectIds) =>
            reorderInBucketMut.mutate({ bucketId, projectIds })
          }
          renderProjectMenu={renderProjectMenu}
        />
      )}

      {!isLoading && viewMode === 'all' && (
        <section className="bg-white dark:bg-slate-800 rounded shadow p-4">
          <h2 className="text-sm font-medium mb-2">
            All projects ({filteredProjects.length})
          </h2>
          {filteredProjects.length === 0 && (
            <p className="text-sm text-slate-500">No projects match your filters.</p>
          )}
          <ul className="divide-y dark:divide-slate-700">
            {filteredProjects.map((p) => (
              <ProjectListRow
                key={p.id}
                project={p}
                userId={user?.id}
                isAdmin={!!isAdmin}
                canRename={
                  p.ownerId === user?.id
                  || isAdmin
                  || managerTeamIds.has(p.teamId)
                }
                bucketNames={bucketNamesByProject.get(p.id) ?? []}
                onOpen={() => nav(`/projects/${p.id}/tasks`)}
                onRename={(name) =>
                  updateNameMut.mutate({ teamId: p.teamId, projectId: p.id, name })
                }
                renamePending={updateNameMut.isPending}
                onDelete={() => {
                  if (window.confirm(`Delete project "${p.name}"?`)) {
                    deleteMut.mutate({ teamId: p.teamId, projectId: p.id });
                  }
                }}
                deletePending={deleteMut.isPending}
                onSaveBudget={(planned, actual, currency) =>
                  updateBudgetMut.mutate({
                    teamId: p.teamId,
                    projectId: p.id,
                    plannedBudget: planned,
                    actualSpent: actual,
                    budgetCurrency: currency,
                  })
                }
                budgetPending={updateBudgetMut.isPending}
                bucketMenu={renderProjectMenu(p)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ProjectFilterBar({
  filters,
  onChange,
  teams,
  showOwnerFilter,
}: {
  filters: ProjectFilterState;
  onChange: (patch: Partial<ProjectFilterState>) => void;
  teams: { id: string; name: string }[];
  showOwnerFilter: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2 mb-4 text-sm items-end">
      <label className="flex flex-col gap-0.5 flex-1 min-w-[160px]">
        <span className="text-slate-500 text-xs">Search</span>
        <input
          type="search"
          value={filters.search ?? ''}
          onChange={(e) => onChange({ search: e.target.value })}
          placeholder="Project or bucket name…"
          className="rounded border px-2 py-1 dark:bg-slate-800"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-slate-500 text-xs">Status</span>
        <select
          value={filters.status ?? ''}
          onChange={(e) =>
            onChange({
              status: (e.target.value || undefined) as projectsApi.ProjectStatus | undefined,
            })
          }
          className="rounded border px-2 py-1 dark:bg-slate-800"
        >
          <option value="">All</option>
          {(['ACTIVE', 'ON_HOLD', 'ARCHIVED'] as const).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {teams.length > 1 && (
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-xs">Team</span>
          <select
            value={filters.teamId ?? ''}
            onChange={(e) => onChange({ teamId: e.target.value || undefined })}
            className="rounded border px-2 py-1 dark:bg-slate-800"
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {showOwnerFilter && (
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-xs">Owner</span>
          <select
            value={filters.owner ?? 'all'}
            onChange={(e) => onChange({ owner: e.target.value as 'all' | 'mine' })}
            className="rounded border px-2 py-1 dark:bg-slate-800"
          >
            <option value="all">All owners</option>
            <option value="mine">Owned by me</option>
          </select>
        </label>
      )}
      <label className="flex flex-col gap-0.5">
        <span className="text-slate-500 text-xs">Created from</span>
        <input
          type="date"
          value={filters.dateFrom?.slice(0, 10) ?? ''}
          onChange={(e) =>
            onChange({
              dateFrom: e.target.value ? `${e.target.value}T00:00:00.000Z` : undefined,
            })
          }
          className="rounded border px-2 py-1 dark:bg-slate-800"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-slate-500 text-xs">Created to</span>
        <input
          type="date"
          value={filters.dateTo?.slice(0, 10) ?? ''}
          onChange={(e) =>
            onChange({
              dateTo: e.target.value ? `${e.target.value}T23:59:59.000Z` : undefined,
            })
          }
          className="rounded border px-2 py-1 dark:bg-slate-800"
        />
      </label>
    </div>
  );
}

function ProjectListRow({
  project,
  userId,
  isAdmin,
  canRename,
  bucketNames,
  onOpen,
  onRename,
  renamePending,
  onDelete,
  deletePending,
  onSaveBudget,
  budgetPending,
  bucketMenu,
}: {
  project: projectsApi.ProjectCrossTeam;
  userId?: string;
  isAdmin: boolean;
  canRename: boolean;
  bucketNames: string[];
  onOpen: () => void;
  onRename: (name: string) => void;
  renamePending: boolean;
  onDelete: () => void;
  deletePending: boolean;
  onSaveBudget: (planned: string | null, actual: string | null, currency?: BudgetCurrency) => void;
  budgetPending: boolean;
  bucketMenu: React.ReactNode;
}): JSX.Element {
  const canEdit = project.ownerId === userId || isAdmin;
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(project.name);

  useEffect(() => {
    if (!editingName) setDraftName(project.name);
  }, [project.name, editingName]);

  function commitRename(): void {
    const trimmed = draftName.trim();
    setEditingName(false);
    if (!trimmed || trimmed === project.name) return;
    onRename(trimmed);
  }

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="text-left min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {editingName ? (
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') {
                    setDraftName(project.name);
                    setEditingName(false);
                  }
                }}
                disabled={renamePending}
                autoFocus
                maxLength={120}
                className="font-medium rounded border px-2 py-0.5 text-sm dark:bg-slate-700 min-w-[8rem] flex-1"
              />
            ) : (
              <button type="button" onClick={onOpen} className="font-medium truncate hover:underline">
                {project.name}
              </button>
            )}
            {canRename && !editingName && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingName(true);
                }}
                className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
                title="Rename project"
              >
                Rename
              </button>
            )}
            <span className="text-xs uppercase tracking-wide text-slate-500 shrink-0">
              {STATUS_LABEL[project.status]}
            </span>
          </div>
          {project.description && (
            <button type="button" onClick={onOpen} className="text-sm text-slate-600 dark:text-slate-300 mt-0.5 truncate block hover:underline w-full text-left">
              {project.description}
            </button>
          )}
          {bucketNames.length > 0 && (
            <p className="text-[11px] text-indigo-600 dark:text-indigo-400 mt-0.5 truncate">
              {bucketNames.join(' · ')}
            </p>
          )}
          <p className="text-xs text-slate-400 mt-1">
            Owned by {project.ownerId === userId ? 'you' : project.ownerId?.slice(0, 8) ?? '—'}
            {' · '}
            <span dir="rtl">ایجاد {formatShamsiTimestampDate(project.createdAt)}</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          {bucketMenu}
          <span className="text-[11px] uppercase rounded-full bg-slate-100 dark:bg-slate-700 px-2 py-0.5">
            {project.teamName}
          </span>
          <Link
            to={`/projects/${project.id}/reports/gantt`}
            className="text-xs text-indigo-600 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Gantt
          </Link>
          {canEdit && (
            <button
              onClick={onDelete}
              disabled={deletePending}
              className="text-xs text-red-600 hover:underline disabled:opacity-50"
            >
              Delete
            </button>
          )}
        </div>
      </div>
      <BudgetRow
        project={project}
        canEdit={canEdit}
        pending={budgetPending}
        onSave={onSaveBudget}
      />
    </li>
  );
}

function BudgetRow({
  project,
  canEdit,
  pending,
  onSave,
}: {
  project: projectsApi.Project;
  canEdit: boolean;
  pending: boolean;
  onSave: (plannedBudget: string | null, actualSpent: string | null, budgetCurrency?: BudgetCurrency) => void;
}): JSX.Element | null {
  const t = useT();
  const locale = budgetLocaleFromLanguage(getLanguage());
  const [editing, setEditing] = useState(false);
  const [planned, setPlanned] = useState(project.plannedBudget ?? '');
  const [actual, setActual] = useState(project.actualSpent ?? '');
  const [currency, setCurrency] = useState<BudgetCurrency>(project.budgetCurrency);

  useEffect(() => {
    if (editing) {
      setPlanned(project.plannedBudget ?? '');
      setActual(project.actualSpent ?? '');
      setCurrency(project.budgetCurrency);
    }
  }, [editing, project.plannedBudget, project.actualSpent, project.budgetCurrency]);

  const hasBudget = !!(project.plannedBudget || project.actualSpent);
  if (!hasBudget && !canEdit) return null;

  const utilization =
    project.plannedBudget && project.actualSpent && Number(project.plannedBudget) > 0
      ? (Number(project.actualSpent) / Number(project.plannedBudget)) * 100
      : null;

  const fmt = (s: string | null): string =>
    formatBudget(s, project.budgetCurrency, locale);

  const validNumber = (v: string): boolean =>
    v.trim().length === 0 || (/^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) >= 0);

  function saveBudget(): void {
    const currencyChanged = currency !== project.budgetCurrency;
    if (currencyChanged && !window.confirm(t('budget.currencyChangeNote'))) {
      return;
    }
    onSave(planned.trim() || null, actual.trim() || null, currency);
    setEditing(false);
  }

  return (
    <div className="mt-2 ml-7 text-xs">
      {!editing ? (
        <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300 flex-wrap">
          <span className="font-medium">Budget:</span>
          <span dir="ltr" className="inline-block">
            Planned <code>{fmt(project.plannedBudget)}</code> · Spent{' '}
            <code>{fmt(project.actualSpent)}</code>
            {utilization !== null && <span className="ml-2">({utilization.toFixed(1)}%)</span>}
          </span>
          {canEdit && (
            <button type="button" onClick={() => setEditing(true)} className="ml-auto hover:underline">
              Edit
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            <span className="text-slate-500">{t('budget.currency')}</span>
            <CurrencySelector value={currency} onChange={setCurrency} className="rounded border px-1 py-0.5 dark:bg-slate-700 text-xs" />
          </label>
          <input type="number" min="0" step="0.01" value={planned} onChange={(e) => setPlanned(e.target.value)} className="w-28 rounded border px-1 py-0.5 dark:bg-slate-700" />
          <input type="number" min="0" step="0.01" value={actual} onChange={(e) => setActual(e.target.value)} className="w-28 rounded border px-1 py-0.5 dark:bg-slate-700" />
          <button
            type="button"
            disabled={pending || !validNumber(planned) || !validNumber(actual)}
            onClick={saveBudget}
            className="bg-slate-900 text-white rounded px-2 py-0.5 disabled:opacity-50"
          >
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className="hover:underline">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
