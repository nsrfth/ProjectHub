import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import * as automationsApi from '@/features/automations/api';
import * as teamsApi from '@/features/teams/api';
import * as labelsApi from '@/features/labels/api';
import * as customFieldsApi from '@/features/customFields/api';

const TRIGGERS: automationsApi.AutomationTrigger[] = [
  'task.created',
  'task.status_changed',
  'task.updated',
  'task.assigned',
  'task.custom_field_changed',
];

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function AutomationsPage(): JSX.Element {
  const { currentTeam } = useTeams();
  const t = useT();
  const qc = useQueryClient();
  const teamId = currentTeam?.id ?? null;

  const { data: teamDetail } = useQuery({
    queryKey: ['teams', teamId, 'detail'],
    queryFn: () => teamsApi.getTeam(teamId!),
    enabled: !!teamId,
  });
  const canManage = teamDetail?.capabilities.manageAutomations ?? false;

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['automations', teamId],
    queryFn: () => automationsApi.listRules(teamId!),
    enabled: !!teamId && canManage,
  });

  const { data: labels = [] } = useQuery({
    queryKey: ['labels', teamId],
    queryFn: () => labelsApi.listLabels(teamId!),
    enabled: !!teamId && canManage,
  });

  const { data: fields = [] } = useQuery({
    queryKey: ['customFields', teamId],
    queryFn: () => customFieldsApi.listCustomFields(teamId!),
    enabled: !!teamId && canManage,
  });

  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState<automationsApi.AutomationTrigger>('task.status_changed');
  const [conditionMatch, setConditionMatch] = useState<automationsApi.ConditionMatch>('ALL');
  const [condStatus, setCondStatus] = useState('DONE');
  const [actionType, setActionType] = useState('set_priority');
  const [actionPriority, setActionPriority] = useState('LOW');

  const { data: runsPage } = useQuery({
    queryKey: ['automations', teamId, selectedRuleId, 'runs'],
    queryFn: () => automationsApi.listRuns(teamId!, selectedRuleId!),
    enabled: !!teamId && !!selectedRuleId && canManage,
  });

  const createMut = useMutation({
    mutationFn: () =>
      automationsApi.createRule(teamId!, {
        name: name.trim(),
        triggerType,
        conditionMatch,
        conditions:
          triggerType === 'task.status_changed'
            ? [{ factType: 'status', operator: 'is', valueJson: { status: condStatus } }]
            : [],
        actions: [
          actionType === 'set_priority'
            ? { actionType: 'set_priority', valueJson: { priority: actionPriority } }
            : actionType === 'set_status'
              ? { actionType: 'set_status', valueJson: { status: condStatus } }
              : { actionType, valueJson: {} },
        ],
      }),
    onSuccess: async () => {
      setName('');
      await qc.invalidateQueries({ queryKey: ['automations', teamId] });
    },
  });

  const toggleMut = useMutation({
    mutationFn: (args: { ruleId: string; enabled: boolean }) =>
      automationsApi.updateRule(teamId!, args.ruleId, { enabled: args.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations', teamId] }),
  });

  const deleteMut = useMutation({
    mutationFn: (ruleId: string) => automationsApi.deleteRule(teamId!, ruleId),
    onSuccess: () => {
      setSelectedRuleId(null);
      qc.invalidateQueries({ queryKey: ['automations', teamId] });
    },
  });

  function onCreate(e: FormEvent): void {
    e.preventDefault();
    createMut.mutate();
  }

  if (!teamId) {
    return <p className="text-sm text-slate-500">{t('automations.selectTeam')}</p>;
  }
  if (!canManage) {
    return <p className="text-sm text-slate-500">{t('automations.noAccess')}</p>;
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-semibold mb-1">{t('automations.title')}</h1>
      <p className="text-sm text-slate-500 mb-6">
        {t('automations.subtitle').replace('{team}', currentTeam?.name ?? '')}
      </p>

      <form onSubmit={onCreate} className="bg-white dark:bg-slate-800 rounded shadow p-4 mb-6 space-y-3">
        <h2 className="font-medium text-sm">{t('automations.create')}</h2>
        <label className="block">
          <span className="text-xs text-slate-500">{t('automations.name')}</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-500">{t('automation.title')}</span>
          <select
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value as automationsApi.AutomationTrigger)}
            className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
          >
            {TRIGGERS.map((tr) => (
              <option key={tr} value={tr}>
                {t(`automation.trigger.${tr.replace(/\./g, '_')}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-slate-500">{t('automation.match.all')} / {t('automation.match.any')}</span>
          <select
            value={conditionMatch}
            onChange={(e) => setConditionMatch(e.target.value as automationsApi.ConditionMatch)}
            className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
          >
            <option value="ALL">{t('automation.match.all')}</option>
            <option value="ANY">{t('automation.match.any')}</option>
          </select>
        </label>
        {triggerType === 'task.status_changed' && (
          <label className="block">
            <span className="text-xs text-slate-500">{t('automation.condition.status')}</span>
            <select
              value={condStatus}
              onChange={(e) => setCondStatus(e.target.value)}
              className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
            >
              {['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="text-xs text-slate-500">{t('automation.action.set_priority')}</span>
          <select
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
          >
            <option value="set_priority">{t('automation.action.set_priority')}</option>
            <option value="set_status">{t('automation.action.set_status')}</option>
            <option value="add_comment">{t('automation.action.add_comment')}</option>
          </select>
        </label>
        {actionType === 'set_priority' && (
          <select
            value={actionPriority}
            onChange={(e) => setActionPriority(e.target.value)}
            className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
          >
            {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}
        <button
          type="submit"
          disabled={createMut.isPending}
          className="text-sm rounded bg-slate-900 text-white px-3 py-1.5 disabled:opacity-50"
        >
          {t('automations.create')}
        </button>
        {createMut.isError && (
          <p className="text-xs text-red-600">{errorMessage(createMut.error, 'Failed')}</p>
        )}
      </form>

      {isLoading && <p className="text-sm">{t('automations.loading')}</p>}
      {!isLoading && rules.length === 0 && (
        <p className="text-sm text-slate-500">{t('automations.empty')}</p>
      )}

      <ul className="divide-y dark:divide-slate-700 bg-white dark:bg-slate-800 rounded shadow">
        {rules.map((rule) => (
          <li key={rule.id} className="p-4 flex flex-wrap items-start gap-3">
            <div className="flex-1 min-w-0">
              <button
                type="button"
                onClick={() => setSelectedRuleId(rule.id)}
                className="font-medium hover:underline text-left"
              >
                {rule.name}
              </button>
              <p className="text-xs text-slate-500 mt-0.5">
                {t(`automation.trigger.${rule.triggerType.replace(/\./g, '_')}`)}
                {' · '}
                {rule.conditionMatch === 'ALL' ? t('automation.match.all') : t('automation.match.any')}
                {rule.lastRunStatus && (
                  <>
                    {' · '}
                    {t(`automation.runs.${rule.lastRunStatus.toLowerCase()}`)}
                  </>
                )}
              </p>
            </div>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => toggleMut.mutate({ ruleId: rule.id, enabled: e.target.checked })}
              />
              {t('automation.enabled')}
            </label>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(t('automations.deleteConfirm').replace('{name}', rule.name))) {
                  deleteMut.mutate(rule.id);
                }
              }}
              className="text-xs text-red-600 hover:underline"
            >
              {t('automations.delete')}
            </button>
          </li>
        ))}
      </ul>

      {selectedRuleId && runsPage && (
        <section className="mt-6 bg-white dark:bg-slate-800 rounded shadow p-4">
          <h3 className="font-medium text-sm mb-2">{t('automation.runs.title')}</h3>
          {runsPage.items.length === 0 && (
            <p className="text-xs text-slate-500">{t('automation.runs.empty')}</p>
          )}
          <ul className="text-xs space-y-1">
            {runsPage.items.map((run) => (
              <li key={run.id} className="font-mono">
                {run.status} · {run.triggerType} · {run.detail ?? '—'}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(labels.length > 0 || fields.length > 0) && (
        <p className="text-[11px] text-slate-400 mt-4">
          {labels.length} labels · {fields.length} custom fields available for conditions/actions
        </p>
      )}
    </div>
  );
}
