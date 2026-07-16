import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as corrApi from './api';
import { listTeamMembersForAssignees } from '@/features/teams/api';
import { visibleTeamMembers } from '@/lib/systemUser';
import { useAuth } from '@/features/auth/AuthContext';
import { formatRelativeTime, formatShamsiTimestamp } from '@/lib/shamsi';
import { useT } from '@/lib/i18n';

interface ReferralPanelProps {
  teamId: string;
  projectId: string;
  letterId: string;
  canManage: boolean;
}

// Refer (ارجاع) a letter to team members with a kind (ACTION / INFO) + optional
// note. Lists existing referrals; a user can mark their own referral handled.
export function ReferralPanel({
  teamId,
  projectId,
  letterId,
  canManage,
}: ReferralPanelProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [kind, setKind] = useState<corrApi.ReferralKind>('ACTION');
  const [note, setNote] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [referError, setReferError] = useState<string | null>(null);

  const key = ['correspondence', 'referrals', letterId];

  const { data: referrals = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => corrApi.listReferrals(teamId, projectId, letterId),
  });

  const { data: members = [] } = useQuery({
    queryKey: ['teams', teamId, 'assignees'],
    queryFn: () => listTeamMembersForAssignees(teamId),
    enabled: !!teamId && canManage,
  });
  const pickableMembers = visibleTeamMembers(members);

  const referMut = useMutation({
    mutationFn: () =>
      corrApi.referLetter(
        teamId,
        projectId,
        letterId,
        selectedIds.map((userId) => ({
          userId,
          kind,
          note: note.trim() || undefined,
          dueAt: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : null,
        })),
      ),
    onSuccess: async () => {
      setReferError(null);
      setSelectedIds([]);
      setNote('');
      setKind('ACTION');
      setDueDate('');
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ['correspondence', 'letter', letterId] });
    },
    onError: (err) => setReferError(corrApi.errorMessage(err, t('correspondence.referral.error'))),
  });

  const handleMut = useMutation({
    mutationFn: (referralId: string) =>
      corrApi.handleReferral(teamId, projectId, letterId, referralId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key });
    },
  });

  function toggle(id: string): void {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-slate-600">{t('correspondence.referral.title')}</h3>

      {isLoading ? (
        <p className="text-xs text-slate-500">{t('common.loading')}</p>
      ) : referrals.length === 0 ? (
        <p className="text-xs text-slate-400 italic">{t('correspondence.referral.none')}</p>
      ) : (
        <ul className="space-y-2">
          {referrals.map((r) => (
            <li
              key={r.id}
              className="flex items-start justify-between gap-2 text-sm rounded border border-border px-2 py-1.5"
            >
              <div className="min-w-0">
                <p className="font-medium truncate">
                  {r.userName}
                  <span
                    className={`ms-2 text-[11px] rounded-full px-2 py-0.5 ${
                      r.kind === 'ACTION'
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
                        : 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200'
                    }`}
                  >
                    {t(`correspondence.referral.kind.${r.kind}`)}
                  </span>
                  <span
                    className={`ms-2 text-[11px] rounded-full px-2 py-0.5 ${
                      r.status === 'HANDLED'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
                        : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {t(`correspondence.referral.status.${r.status}`)}
                  </span>
                </p>
                {r.note && <p className="text-xs text-slate-500 mt-0.5">{r.note}</p>}
                {r.dueAt && (
                  <p
                    className={`text-[11px] mt-0.5 ${
                      r.status !== 'HANDLED' && new Date(r.dueAt).getTime() < Date.now()
                        ? 'text-danger font-medium'
                        : 'text-slate-500'
                    }`}
                  >
                    {t('correspondence.referral.due')}: {formatShamsiTimestamp(r.dueAt)}
                  </p>
                )}
                <p className="text-[11px] text-slate-400 mt-0.5" dir="rtl" title={formatShamsiTimestamp(r.createdAt) ?? ''}>
                  {formatRelativeTime(r.createdAt)}
                </p>
              </div>
              {r.status === 'PENDING' && r.userId === user?.id && (
                <button
                  type="button"
                  onClick={() => handleMut.mutate(r.id)}
                  disabled={handleMut.isPending}
                  className="text-xs text-primary hover:underline shrink-0 disabled:opacity-50"
                >
                  {t('correspondence.referral.markHandled')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="rounded border border-border p-2 space-y-2 bg-bg-elevated">
          <p className="text-xs font-medium text-text-muted">{t('correspondence.referral.refer')}</p>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {pickableMembers.length === 0 ? (
              <p className="text-xs text-slate-400 italic">{t('correspondence.referral.noMembers')}</p>
            ) : (
              pickableMembers.map((m) => (
                <label key={m.userId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(m.userId)}
                    onChange={() => toggle(m.userId)}
                  />
                  <span className="truncate">{m.name || m.email}</span>
                </label>
              ))
            )}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as corrApi.ReferralKind)}
              className="rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
            >
              <option value="ACTION">{t('correspondence.referral.kind.ACTION')}</option>
              <option value="INFO">{t('correspondence.referral.kind.INFO')}</option>
            </select>
            <input
              type="text"
              placeholder={t('correspondence.referral.notePlaceholder')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="flex-1 rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            {t('correspondence.referral.due')}:
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
            />
          </label>
          {referError && <p className="text-xs text-danger" role="alert">{referError}</p>}
          <button
            type="button"
            onClick={() => referMut.mutate()}
            disabled={selectedIds.length === 0 || referMut.isPending}
            className="text-xs rounded bg-primary text-primary-contrast px-3 py-1.5 disabled:opacity-50"
          >
            {t('correspondence.referral.submit')}
          </button>
        </div>
      )}
    </div>
  );
}
