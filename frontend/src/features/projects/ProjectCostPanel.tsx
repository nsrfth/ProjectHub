import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useT } from '@/lib/i18n';
import * as costApi from '@/features/cost/api';

interface ProjectCostPanelProps {
  teamId: string;
  projectId: string;
  canManage: boolean;
}

const DECIMALS: Record<string, number> = { IRR: 0, EUR: 2, USD: 2 };
function toMinor(amount: string, currency: string): string {
  const dec = DECIMALS[currency] ?? 2;
  const n = parseFloat(amount || '0');
  return String(Math.round(n * 10 ** dec));
}
function isModuleDisabled(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.data?.error?.code === 'module_disabled';
}

// v2.0 (PMIS R4): per-project cost summary + budget lines + actual ledger.
// Renders only when the cost_control module is enabled (the summary 403s
// otherwise). Mutations require team Manager (proxy for the cost.manage perm).
export default function ProjectCostPanel({ teamId, projectId, canManage }: ProjectCostPanelProps): JSX.Element | null {
  const t = useT();
  const qc = useQueryClient();

  const summaryQ = useQuery({
    queryKey: ['cost', teamId, projectId, 'summary'],
    queryFn: () => costApi.getCostSummary(teamId, projectId),
    retry: false,
  });
  const { data: budgetLines = [] } = useQuery({
    queryKey: ['cost', teamId, projectId, 'budget-lines'],
    queryFn: () => costApi.listBudgetLines(teamId, projectId),
    enabled: !summaryQ.isError,
    retry: false,
  });
  const { data: actuals = [] } = useQuery({
    queryKey: ['cost', teamId, projectId, 'actuals'],
    queryFn: () => costApi.listActuals(teamId, projectId),
    enabled: !summaryQ.isError,
    retry: false,
  });

  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('IRR');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['cost', teamId, projectId] });

  const addBudget = useMutation({
    mutationFn: () => costApi.createBudgetLine(teamId, projectId, { amountMinor: toMinor(amount, currency), currency }),
    onSuccess: () => {
      setAmount('');
      void invalidate();
    },
  });

  if (summaryQ.isError) {
    // Module disabled (or no access) → render nothing to keep the modal clean.
    return isModuleDisabled(summaryQ.error) ? null : null;
  }
  const summary = summaryQ.data;

  return (
    <div className="rounded border border-border p-3">
      <h3 className="mb-1 text-sm font-medium">{t('cost.title')}</h3>
      {summary && (
        <table className="mb-3 w-full text-xs">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="py-1">{t('cost.currency')}</th>
              <th className="text-right">{t('cost.planned')}</th>
              <th className="text-right">{t('cost.committed')}</th>
              <th className="text-right">{t('cost.actual')}</th>
              <th className="text-right">{t('cost.remaining')}</th>
            </tr>
          </thead>
          <tbody>
            {summary.byCurrency.map((b) => (
              <tr key={b.currency} className="border-t border-border">
                <td className="py-1">{b.currency}</td>
                <td className="text-right">{b.planned}</td>
                <td className="text-right">{b.committed}</td>
                <td className="text-right">{b.actual}</td>
                <td className="text-right">{b.remaining}</td>
              </tr>
            ))}
            {summary.byCurrency.length === 0 && (
              <tr>
                <td colSpan={5} className="py-1 text-text-muted">
                  {t('cost.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {canManage && (
        <form
          className="mb-2 flex flex-wrap items-end gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (amount) addBudget.mutate();
          }}
        >
          <label className="text-xs text-text-muted">
            {t('cost.addBudget')}
            <input
              type="number"
              min="0"
              step="0.01"
              className="ms-2 w-32 rounded border border-border bg-surface px-2 py-1 text-sm"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <select className="rounded border border-border bg-surface px-2 py-1 text-sm" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="IRR">IRR</option>
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
          </select>
          <button type="submit" disabled={addBudget.isPending || !amount} className="rounded bg-primary px-2 py-1 text-xs text-primary-contrast disabled:opacity-50">
            {t('cost.add')}
          </button>
        </form>
      )}

      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer">{t('cost.ledger')} ({actuals.length})</summary>
        <ul className="mt-1 space-y-0.5">
          {actuals.slice(0, 20).map((a) => (
            <li key={a.id}>
              {a.incurredOn} · {t(`cost.source.${a.source}`)} · {a.amount} {a.currency}
            </li>
          ))}
          {actuals.length === 0 && <li>{t('cost.noActuals')}</li>}
        </ul>
        <p className="mt-1">{t('cost.budgetLines')}: {budgetLines.length}</p>
      </details>
    </div>
  );
}
