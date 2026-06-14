import { useState, useEffect, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import type { Team } from '@/features/teams/api';
import { listTeamMembersForAssignees } from '@/features/teams/api';
import { visibleTeamMembers } from '@/lib/systemUser';
import * as projectsApi from '@/features/projects/api';
import CurrencySelector from '@/features/budget/CurrencySelector';
import type { BudgetCurrency } from '@/lib/formatBudget';
import { useT } from '@/lib/i18n';

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

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [accountableId, setAccountableId] = useState<string>('');
  const [plannedBudget, setPlannedBudget] = useState('');
  const [actualSpent, setActualSpent] = useState('');
  const selectedTeam = teams.find((tm) => tm.id === effectiveFormTeamId);
  const [budgetCurrency, setBudgetCurrency] = useState<BudgetCurrency>(
    () => selectedTeam?.defaultCurrency ?? 'IRR',
  );
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedTeam?.defaultCurrency) {
      setBudgetCurrency(selectedTeam.defaultCurrency);
    }
  }, [selectedTeam?.id, selectedTeam?.defaultCurrency]);

  const createMut = useMutation({
    mutationFn: (input: {
      name: string;
      description?: string;
      accountableId?: string | null;
      plannedBudget?: string;
      actualSpent?: string;
      budgetCurrency?: BudgetCurrency;
    }) => projectsApi.createProject(effectiveFormTeamId, input),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects', 'all'] });
      await qc.invalidateQueries({ queryKey: ['projects', effectiveFormTeamId] });
      onSuccess();
    },
    onError: (err) => setCreateError(errorMessage(err, 'Could not create project')),
  });

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    createMut.mutate({
      name,
      description: description || undefined,
      accountableId: accountableId || null,
      plannedBudget: plannedBudget.trim() ? plannedBudget.trim() : undefined,
      actualSpent: actualSpent.trim() ? actualSpent.trim() : undefined,
      budgetCurrency,
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {teams.length > 1 && (
        <label className="block">
          <span className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Team</span>
          <select
            value={effectiveFormTeamId}
            onChange={(e) => {
              setFormTeamId(e.target.value);
              setAccountableId('');
            }}
            className="w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1.5 border text-sm"
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.myRole.toLowerCase()})
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block">
        <span className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Project name</span>
        <input
          type="text"
          required
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1.5 border text-sm"
        />
      </label>
      <label className="block">
        <span className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Description</span>
        <textarea
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1.5 border text-sm"
          rows={3}
        />
      </label>
      <label className="block">
        <span className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Accountable</span>
        <select
          value={accountableId}
          onChange={(e) => setAccountableId(e.target.value)}
          className="w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1.5 border text-sm"
          title="Accountable (RACI) — the person on the hook for this project's outcomes"
        >
          <option value="">Accountable (optional) — none</option>
          {formMembers.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name} ({m.role})
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block sm:col-span-2">
          <span className="block text-xs text-slate-500 dark:text-slate-400 mb-1">{t('budget.currency')}</span>
          <CurrencySelector value={budgetCurrency} onChange={setBudgetCurrency} />
        </label>
        <label className="block">
          <span className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Planned budget</span>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Optional"
            value={plannedBudget}
            onChange={(e) => setPlannedBudget(e.target.value)}
            className="w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1.5 border text-sm"
          />
        </label>
        <label className="block">
          <span className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Actual spent</span>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Optional"
            value={actualSpent}
            onChange={(e) => setActualSpent(e.target.value)}
            className="w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1.5 border text-sm"
          />
        </label>
      </div>
      {createError && <p className="text-xs text-red-600 dark:text-red-400">{createError}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={createMut.isPending}
          className="text-sm rounded border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={createMut.isPending || !effectiveFormTeamId}
          className="text-sm rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 font-medium disabled:opacity-50"
        >
          {createMut.isPending ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </form>
  );
}
