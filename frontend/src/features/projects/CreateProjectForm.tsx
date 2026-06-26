import { useState, useEffect, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import type { Team } from '@/features/teams/api';
import { listTeamMembersForAssignees } from '@/features/teams/api';
import { visibleTeamMembers } from '@/lib/systemUser';
import * as projectsApi from '@/features/projects/api';
import * as profilesApi from '@/features/profiles/api';
import { useAuth } from '@/features/auth/AuthContext';
import { useT } from '@/lib/i18n';
import ProjectFormFields, {
  validateProjectDateRange,
  type ProjectFormValues,
} from '@/features/projects/ProjectFormFields';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export interface CreateProjectFormProps {
  teams: Team[];
  currentTeamId: string | null;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function CreateProjectForm({
  teams,
  currentTeamId,
  onSuccess,
  onCancel,
}: CreateProjectFormProps): JSX.Element {
  const qc = useQueryClient();
  const { user } = useAuth();
  const t = useT();

  const [formTeamId, setFormTeamId] = useState<string>(() => currentTeamId ?? '');
  const effectiveFormTeamId = formTeamId || currentTeamId || '';
  const { data: formMembersRaw = [] } = useQuery({
    queryKey: ['teams', effectiveFormTeamId, 'assignees'],
    queryFn: () => listTeamMembersForAssignees(effectiveFormTeamId),
    enabled: !!effectiveFormTeamId,
    staleTime: 30_000,
  });
  const formMembers = visibleTeamMembers(formMembersRaw);

  const selectedTeam = teams.find((tm) => tm.id === effectiveFormTeamId);
  const [values, setValues] = useState<ProjectFormValues>({
    name: '',
    description: '',
    status: 'ACTIVE',
    ownerId: user?.id ?? null,
    accountableId: null,
    plannedBudget: '',
    budgetCurrency: selectedTeam?.defaultCurrency ?? 'IRR',
    startDate: null,
    endDate: null,
    labelIds: [],
    code: '',
  });
  const [dateError, setDateError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  // v1.98 (PMIS R2): optional profile pick. Empty = let the server resolve the
  // group/team default → system NEUTRAL.
  const [profileId, setProfileId] = useState<string>('');
  const { data: systemProfiles = [] } = useQuery({
    queryKey: ['profiles', 'system'],
    queryFn: profilesApi.listSystemProfiles,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (selectedTeam?.defaultCurrency) {
      setValues((v) => ({ ...v, budgetCurrency: selectedTeam.defaultCurrency }));
    }
  }, [selectedTeam?.id, selectedTeam?.defaultCurrency]);

  const createMut = useMutation({
    mutationFn: (input: ProjectFormValues) =>
      projectsApi.createProject(effectiveFormTeamId, {
        name: input.name,
        description: input.description || undefined,
        status: input.status,
        ownerId: input.ownerId || undefined,
        accountableId: input.accountableId,
        plannedBudget: input.plannedBudget.trim() ? input.plannedBudget.trim() : undefined,
        budgetCurrency: input.budgetCurrency,
        startDate: input.startDate,
        endDate: input.endDate,
        labelIds: input.labelIds.length > 0 ? input.labelIds : undefined,
        profileId: profileId || undefined,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects', 'all'] });
      await qc.invalidateQueries({ queryKey: ['projects', effectiveFormTeamId] });
      onSuccess();
    },
    onError: (err) => setCreateError(errorMessage(err, 'Could not create project')),
  });

  function patch(patch: Partial<ProjectFormValues>): void {
    setValues((prev) => {
      const next = { ...prev, ...patch };
      setDateError(validateProjectDateRange(next.startDate, next.endDate));
      return next;
    });
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const trimmed = values.name.trim();
    if (!trimmed) return;
    const rangeErr = validateProjectDateRange(values.startDate, values.endDate);
    if (rangeErr) {
      setDateError(rangeErr);
      return;
    }
    createMut.mutate({ ...values, name: trimmed });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {teams.length > 1 && (
        <label className="block">
          <span className="block text-xs text-text-muted mb-1">Team</span>
          <select
            value={effectiveFormTeamId}
            onChange={(e) => {
              setFormTeamId(e.target.value);
              patch({ accountableId: null, ownerId: user?.id ?? null });
            }}
            className="w-full rounded border-border dark:bg-slate-700 dark:text-slate-100 px-2 py-1.5 border text-sm"
          >
            {teams.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name} ({tm.myRole.toLowerCase()})
              </option>
            ))}
          </select>
        </label>
      )}

      <ProjectFormFields
        teamId={effectiveFormTeamId}
        values={values}
        onChange={patch}
        members={formMembers}
        dateError={dateError}
      />

      <label className="block">
        <span className="block text-xs text-text-muted mb-1">{t('profiles.projectProfile')}</span>
        <select
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          className="w-full rounded border-border dark:bg-slate-700 dark:text-slate-100 px-2 py-1.5 border text-sm"
        >
          <option value="">{t('profiles.useDefault')}</option>
          {systemProfiles
            .filter((p) => p.status === 'PUBLISHED')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>

      {createError && <p role="alert" className="text-xs text-danger">{createError}</p>}

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={createMut.isPending}
          className="text-sm rounded border border-border px-3 py-1.5 text-text hover:bg-bg disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={createMut.isPending || !effectiveFormTeamId || !!dateError || !values.name.trim()}
          className="text-sm rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 font-medium disabled:opacity-50"
        >
          {createMut.isPending ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </form>
  );
}
