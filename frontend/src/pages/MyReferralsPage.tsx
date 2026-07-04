import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import * as corrApi from '@/features/correspondence/api';
import { formatShamsiDate, formatShamsiTimestamp } from '@/lib/shamsi';
import { useT } from '@/lib/i18n';

// v2.5.26 (W2.2): cross-project "My referrals" inbox — every letter referred to
// the current user across all their teams, with overdue filtering.
export default function MyReferralsPage(): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [due, setDue] = useState<'all' | 'overdue' | 'week'>('all');
  const [status, setStatus] = useState<'' | 'PENDING' | 'HANDLED'>('PENDING');

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['me', 'referrals', due, status],
    queryFn: () =>
      corrApi.listMyReferrals({ due, status: status || undefined }),
  });

  const handleMut = useMutation({
    mutationFn: (r: corrApi.MyReferral) =>
      corrApi.handleReferral(r.teamId, r.projectId, r.correspondenceId, r.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me', 'referrals'] });
    },
  });

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold mb-1">{t('myReferrals.title')}</h1>
      <p className="text-sm text-text-muted mb-6">{t('myReferrals.subtitle')}</p>

      <div className="flex flex-wrap gap-2 mb-4 text-sm">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | 'PENDING' | 'HANDLED')}
          className="rounded border px-2 py-1 dark:bg-slate-800"
        >
          <option value="">{t('myReferrals.filter.allStatus')}</option>
          <option value="PENDING">{t('correspondence.referral.status.PENDING')}</option>
          <option value="HANDLED">{t('correspondence.referral.status.HANDLED')}</option>
        </select>
        <select
          value={due}
          onChange={(e) => setDue(e.target.value as 'all' | 'overdue' | 'week')}
          className="rounded border px-2 py-1 dark:bg-slate-800"
        >
          <option value="all">{t('myReferrals.filter.allDue')}</option>
          <option value="overdue">{t('myReferrals.filter.overdue')}</option>
          <option value="week">{t('myReferrals.filter.week')}</option>
        </select>
      </div>

      {isLoading && <p className="text-sm text-text-muted">{t('common.loading')}</p>}
      {!isLoading && items.length === 0 && (
        <p className="text-sm text-text-muted">{t('myReferrals.empty')}</p>
      )}

      <ul className="space-y-2">
        {items.map((r) => {
          const overdue = r.status !== 'HANDLED' && !!r.dueAt && new Date(r.dueAt).getTime() < Date.now();
          return (
            <li key={r.id} className="rounded border border-border p-3 bg-surface">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    to={`/projects/${r.projectId}/correspondence`}
                    className="text-primary hover:underline font-medium"
                  >
                    {r.subject}
                  </Link>
                  <p className="text-xs text-text-muted mt-0.5">
                    <span dir="ltr" className="font-mono">{r.referenceNumber}</span>
                    {' · '}
                    {t(`correspondence.direction.${r.direction}`)}
                    {' · '}
                    {formatShamsiDate(r.letterDate)}
                  </p>
                  {r.note && <p className="text-xs text-slate-500 mt-1">{r.note}</p>}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span
                    className={`text-[11px] rounded-full px-2 py-0.5 ${
                      r.kind === 'ACTION'
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
                        : 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200'
                    }`}
                  >
                    {t(`correspondence.referral.kind.${r.kind}`)}
                  </span>
                  {r.dueAt && (
                    <span className={`text-[11px] ${overdue ? 'text-danger font-medium' : 'text-text-muted'}`}>
                      {t('correspondence.referral.due')}: {formatShamsiTimestamp(r.dueAt)}
                    </span>
                  )}
                  {r.status === 'PENDING' ? (
                    <button
                      type="button"
                      onClick={() => handleMut.mutate(r)}
                      disabled={handleMut.isPending}
                      className="text-xs text-primary hover:underline disabled:opacity-50"
                    >
                      {t('correspondence.referral.markHandled')}
                    </button>
                  ) : (
                    <span className="text-[11px] text-emerald-600">
                      {t('correspondence.referral.status.HANDLED')}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
