import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import { listTeamMembersForAssignees } from '@/features/teams/api';
import * as ts from './api';

interface Props {
  teamId: string;
  canManage: boolean;
}

type Currency = 'IRR' | 'USD' | 'EUR';
const CURRENCIES: Currency[] = ['IRR', 'USD', 'EUR'];
const DECIMALS: Record<string, number> = { IRR: 0, USD: 2, EUR: 2 };
function toMinor(amount: string, currency: string): string {
  const dec = DECIMALS[currency] ?? 2;
  return String(Math.round((parseFloat(amount) || 0) * 10 ** dec));
}

// v1.91 (PMIS R4 GUI completion): rate-card management. Cost/bill rates per user
// or per team role drive the labour cost posted when a timesheet is approved, so
// without this UI the cost flow had no rates to snapshot. Managers only
// (timesheet.manage_rates; the create call 403s if the role check fails).
export function RateCardsSection({ teamId, canManage }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();

  const { data: cards = [] } = useQuery({
    queryKey: ['ts', 'rate-cards', teamId],
    queryFn: () => ts.listRateCards(teamId),
    enabled: !!teamId,
  });
  const { data: members = [] } = useQuery({
    queryKey: ['team-members-assignees', teamId],
    queryFn: () => listTeamMembersForAssignees(teamId),
    enabled: canManage && !!teamId,
  });

  const [scope, setScope] = useState<'USER' | 'ROLE'>('ROLE');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'MANAGER' | 'MEMBER'>('MEMBER');
  const [currency, setCurrency] = useState<Currency>('IRR');
  const [costRate, setCostRate] = useState('');
  const [billRate, setBillRate] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const invalidate = (): Promise<void> => qc.invalidateQueries({ queryKey: ['ts', 'rate-cards', teamId] });

  const createMut = useMutation({
    mutationFn: () =>
      ts.createRateCard(teamId, {
        scope,
        userId: scope === 'USER' ? userId : undefined,
        role: scope === 'ROLE' ? role : undefined,
        currency,
        costRateMinor: toMinor(costRate, currency),
        billRateMinor: billRate ? toMinor(billRate, currency) : undefined,
        effectiveFrom,
        effectiveTo: effectiveTo || undefined,
      }),
    onSuccess: () => { setCostRate(''); setBillRate(''); setErr(null); void invalidate(); },
    onError: () => setErr(t('timesheets.rates.error')),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => ts.deleteRateCard(teamId, id),
    onSuccess: invalidate,
  });

  const valid = costRate.trim() !== '' && effectiveFrom !== '' && (scope === 'ROLE' || !!userId);

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (valid) createMut.mutate();
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-2 text-sm font-medium">{t('timesheets.rates.title')}</h2>

      {cards.length === 0 ? (
        <p className="text-xs text-text-muted">{t('timesheets.rates.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted">
              <th className="py-1">{t('timesheets.rates.subject')}</th>
              <th>{t('timesheets.rates.cost')}</th>
              <th>{t('timesheets.rates.bill')}</th>
              <th>{t('timesheets.rates.effective')}</th>
              {canManage && <th />}
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="py-1">
                  {c.scope === 'USER'
                    ? (c.userName ?? c.userId ?? '—')
                    : t(`timesheets.rates.role.${c.role}`)}
                </td>
                <td dir="ltr">{c.costRate} {c.currency}</td>
                <td dir="ltr">{c.billRate ? `${c.billRate} ${c.currency}` : '—'}</td>
                <td className="text-xs" dir="ltr">
                  {c.effectiveFrom.slice(0, 10)} → {c.effectiveTo ? c.effectiveTo.slice(0, 10) : '…'}
                </td>
                {canManage && (
                  <td className="text-right">
                    <button
                      type="button"
                      className="text-xs text-danger hover:underline"
                      onClick={() => { if (window.confirm(t('timesheets.rates.deleteConfirm'))) deleteMut.mutate(c.id); }}
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canManage && (
        <form onSubmit={submit} className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            {t('timesheets.rates.scope')}
            <select className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm"
              value={scope} onChange={(e) => setScope(e.target.value as 'USER' | 'ROLE')}>
              <option value="ROLE">{t('timesheets.rates.scope.role')}</option>
              <option value="USER">{t('timesheets.rates.scope.user')}</option>
            </select>
          </label>
          {scope === 'USER' ? (
            <label className="text-xs text-text-muted">
              {t('timesheets.rates.user')}
              <select className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm"
                value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">—</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
              </select>
            </label>
          ) : (
            <label className="text-xs text-text-muted">
              {t('timesheets.rates.roleLabel')}
              <select className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm"
                value={role} onChange={(e) => setRole(e.target.value as 'MANAGER' | 'MEMBER')}>
                <option value="MEMBER">{t('timesheets.rates.role.MEMBER')}</option>
                <option value="MANAGER">{t('timesheets.rates.role.MANAGER')}</option>
              </select>
            </label>
          )}
          <label className="text-xs text-text-muted">
            {t('timesheets.rates.currency')}
            <select className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm"
              value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            {t('timesheets.rates.cost')}
            <input type="number" min="0" step="0.01" dir="ltr"
              className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm"
              value={costRate} onChange={(e) => setCostRate(e.target.value)} />
          </label>
          <label className="text-xs text-text-muted">
            {t('timesheets.rates.bill')}
            <input type="number" min="0" step="0.01" dir="ltr"
              className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm"
              value={billRate} onChange={(e) => setBillRate(e.target.value)} />
          </label>
          <label className="text-xs text-text-muted">
            {t('timesheets.rates.from')}
            <input type="date" className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm"
              value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </label>
          <label className="text-xs text-text-muted">
            {t('timesheets.rates.to')}
            <input type="date" className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm"
              value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
          </label>
          {err && <p className="text-xs text-danger sm:col-span-2">{err}</p>}
          <div className="sm:col-span-2">
            <button type="submit" disabled={!valid || createMut.isPending}
              className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-contrast disabled:opacity-50">
              {t('timesheets.rates.add')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
