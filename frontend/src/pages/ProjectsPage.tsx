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
import CreateProjectForm from '@/features/projects/CreateProjectForm';
import ProjectEditModal, { type ProjectFormValues } from '@/features/projects/ProjectEditModal';
import ProjectListRow from '@/features/projects/ProjectListRow';
import ProjectActionsMenu from '@/features/projects/ProjectActionsMenu';
import { toggleActionsMenuProjectId } from '@/features/projects/projectActionsLogic';
import Modal from '@/features/ui/Modal';
import { useT } from '@/lib/i18n';

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
  const t = useT();
  const isAdmin = user?.globalRole === 'ADMIN';

  const [viewMode, setViewMode] = useState<ProjectsViewMode>(() => loadProjectsViewMode());
  const [filters, setFilters] = useState<ProjectFilterState>({ owner: 'all' });
  const [createOpen, setCreateOpen] = useState(false);
  const [bucketModal, setBucketModal] = useState<
    { mode: 'create' } | { mode: 'edit'; bucket: bucketsApi.ProjectBucket } | null
  >(null);
  const [assignProjectId, setAssignProjectId] = useState<string | null>(null);
  const [actionsMenuProjectId, setActionsMenuProjectId] = useState<string | null>(null);
  const [editProjectId, setEditProjectId] = useState<string | null>(null);
  const [projectSaveError, setProjectSaveError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedBuckets());
  const bucketMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (bucketMenuRef.current && !bucketMenuRef.current.contains(e.target as Node)) {
        setAssignProjectId(null);
      }
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuProjectId(null);
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

  const updateProjectMut = useMutation({
    mutationFn: (args: {
      teamId: string;
      projectId: string;
      values: ProjectFormValues;
      nameOnly?: boolean;
    }) => {
      const { values, nameOnly } = args;
      const payload = nameOnly
        ? { name: values.name }
        : {
            name: values.name,
            description: values.description || null,
            status: values.status,
            accountableId: values.accountableId,
            plannedBudget: values.plannedBudget.trim() ? values.plannedBudget.trim() : null,
            budgetCurrency: values.budgetCurrency,
            startDate: values.startDate,
            endDate: values.endDate,
          };
      return projectsApi.updateProject(args.teamId, args.projectId, payload);
    },
    onSuccess: async (_d, vars) => {
      setProjectSaveError(null);
      setEditProjectId(null);
      await qc.invalidateQueries({ queryKey: ['projects', 'all'] });
      await qc.invalidateQueries({ queryKey: ['projects', vars.teamId] });
    },
    onError: (err) => setProjectSaveError(errorMessage(err, t('projects.edit.error'))),
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

  function canManageProject(project: projectsApi.ProjectCrossTeam): boolean {
    return project.ownerId === user?.id || isAdmin || managerTeamIds.has(project.teamId);
  }

  function isRenameOnlyProject(project: projectsApi.ProjectCrossTeam): boolean {
    return (
      !isAdmin &&
      project.ownerId !== user?.id &&
      managerTeamIds.has(project.teamId)
    );
  }

  function renderBucketAssignMenu(project: projectsApi.ProjectCrossTeam): React.ReactNode {
    return (
      <div
        className="relative shrink-0"
        ref={assignProjectId === project.id ? bucketMenuRef : undefined}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setActionsMenuProjectId(null);
            setAssignProjectId(assignProjectId === project.id ? null : project.id);
          }}
          className="text-[10px] px-1 rounded border text-slate-500"
          title={t('projects.bucketAssign')}
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

  function renderActionsMenu(project: projectsApi.ProjectCrossTeam): React.ReactNode {
    if (!canManageProject(project)) return null;
    return (
      <ProjectActionsMenu
        open={actionsMenuProjectId === project.id}
        menuRef={actionsMenuProjectId === project.id ? actionsMenuRef : undefined}
        onToggle={(e) => {
          e.stopPropagation();
          setAssignProjectId(null);
          setActionsMenuProjectId(toggleActionsMenuProjectId(actionsMenuProjectId, project.id));
        }}
        onEdit={() => {
          setActionsMenuProjectId(null);
          setProjectSaveError(null);
          setEditProjectId(project.id);
        }}
        onEditBudget={() => {
          setActionsMenuProjectId(null);
          setProjectSaveError(null);
          setEditProjectId(project.id);
        }}
        onDelete={() => {
          setActionsMenuProjectId(null);
          if (window.confirm(t('projects.delete.confirm').replace('{name}', project.name))) {
            deleteMut.mutate({ teamId: project.teamId, projectId: project.id });
          }
        }}
      />
    );
  }

  const editProject = editProjectId
    ? filteredProjects.find((p) => p.id === editProjectId) ?? projects.find((p) => p.id === editProjectId)
    : null;

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
          renderBucketMenu={renderBucketAssignMenu}
          renderActionsMenu={renderActionsMenu}
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
                canManage={canManageProject(p)}
                bucketNames={bucketNamesByProject.get(p.id) ?? []}
                actionsMenuOpen={actionsMenuProjectId === p.id}
                actionsMenuRef={actionsMenuProjectId === p.id ? actionsMenuRef : undefined}
                onToggleActionsMenu={(e) => {
                  e.stopPropagation();
                  setAssignProjectId(null);
                  setActionsMenuProjectId(toggleActionsMenuProjectId(actionsMenuProjectId, p.id));
                }}
                onCloseActionsMenu={() => setActionsMenuProjectId(null)}
                onOpen={() => nav(`/projects/${p.id}/tasks`)}
                onEditProject={() => {
                  setProjectSaveError(null);
                  setEditProjectId(p.id);
                }}
                onEditBudget={() => {
                  setProjectSaveError(null);
                  setEditProjectId(p.id);
                }}
                onDelete={() => deleteMut.mutate({ teamId: p.teamId, projectId: p.id })}
                bucketMenu={renderBucketAssignMenu(p)}
              />
            ))}
          </ul>
        </section>
      )}

      {editProject && (
        <ProjectEditModal
          project={editProject}
          nameOnly={isRenameOnlyProject(editProject)}
          pending={updateProjectMut.isPending}
          error={projectSaveError}
          onClose={() => {
            setEditProjectId(null);
            setProjectSaveError(null);
          }}
          onSave={(values) =>
            updateProjectMut.mutate({
              teamId: editProject.teamId,
              projectId: editProject.id,
              values,
              nameOnly: isRenameOnlyProject(editProject),
            })
          }
        />
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
