import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as riskApi from './api';
import Modal from '@/features/ui/Modal';
import { useT } from '@/lib/i18n';

interface RiskRegisterProps {
  teamId: string;
  projectId: string;
  canManage: boolean;
}

const RESPONSES: riskApi.RiskResponseStrategy[] = ['ACCEPT', 'AVOID', 'MITIGATE', 'TRANSFER'];

// 5×5 matrix → 1..25. Bucket the colour the same way most PM tools do.
function scoreBadge(score: number): string {
  if (score <= 5) return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200';
  if (score <= 12) return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
  return 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200';
}

export function RiskRegister({ teamId, projectId, canManage }: RiskRegisterProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data: risks = [], isLoading } = useQuery({
    queryKey: ['risks', teamId, projectId],
    queryFn: () => riskApi.listRisks(teamId, projectId),
    enabled: !!teamId && !!projectId,
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['risks', teamId, projectId] });
  };

  const closeMut = useMutation({
    mutationFn: (id: string) => riskApi.closeRisk(teamId, projectId, id),
    onSuccess: invalidate,
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => riskApi.deleteRisk(teamId, projectId, id),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-text-muted">{t('risk.scoreHint')}</p>
        {canManage && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="ms-auto rounded-md bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            {t('risk.new')}
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : risks.length === 0 ? (
        <p className="text-sm text-slate-500 italic">{t('risk.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-text-muted">
              <tr>
                <Th>{t('risk.col.reference')}</Th>
                <Th>{t('risk.col.title')}</Th>
                <Th>{t('risk.col.probability')}</Th>
                <Th>{t('risk.col.impact')}</Th>
                <Th>{t('risk.col.score')}</Th>
                <Th>{t('risk.col.response')}</Th>
                <Th>{t('risk.col.owner')}</Th>
                <Th>{t('risk.col.status')}</Th>
                {canManage && <Th>{''}</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {risks.map((r) => (
                <tr key={r.id} className="hover:bg-bg-elevated">
                  <td className="px-3 py-2 font-mono" dir="ltr">
                    {r.reference}
                  </td>
                  <td className="px-3 py-2 max-w-[20rem] truncate" title={r.title}>
                    {r.title}
                  </td>
                  <td className="px-3 py-2 text-center">{r.probability}</td>
                  <td className="px-3 py-2 text-center">{r.impact}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-[11px] rounded-full px-2 py-0.5 ${scoreBadge(r.score)}`}>
                      {r.score}
                    </span>
                  </td>
                  <td className="px-3 py-2">{t(`risk.response.${r.response}`)}</td>
                  <td className="px-3 py-2 truncate">{r.ownerName ?? '—'}</td>
                  <td className="px-3 py-2">
                    {r.closedAt ? (
                      <span className="text-[11px] rounded-full px-2 py-0.5 bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                        {t('risk.status.closed')}
                      </span>
                    ) : (
                      <span className="text-[11px] rounded-full px-2 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                        {t('risk.status.open')}
                      </span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-3 py-2 text-end whitespace-nowrap">
                      {!r.closedAt && (
                        <button
                          type="button"
                          disabled={closeMut.isPending}
                          onClick={() => {
                            if (window.confirm(t('risk.closeConfirm'))) closeMut.mutate(r.id);
                          }}
                          className="text-xs text-primary hover:underline me-3 disabled:opacity-50"
                        >
                          {t('risk.close')}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={deleteMut.isPending}
                        onClick={() => {
                          if (window.confirm(t('risk.deleteConfirm'))) deleteMut.mutate(r.id);
                        }}
                        className="text-xs text-rose-600 hover:underline disabled:opacity-50"
                      >
                        {t('risk.delete')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <RiskCreateModal
          teamId={teamId}
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

interface RiskCreateModalProps {
  teamId: string;
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}

function RiskCreateModal({
  teamId,
  projectId,
  onClose,
  onCreated,
}: RiskCreateModalProps): JSX.Element {
  const t = useT();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [probability, setProbability] = useState(3);
  const [impact, setImpact] = useState(3);
  const [response, setResponse] = useState<riskApi.RiskResponseStrategy>('MITIGATE');
  const [mitigationPlan, setMitigationPlan] = useState('');

  const createMut = useMutation({
    mutationFn: () =>
      riskApi.createRisk(teamId, projectId, {
        title: title.trim(),
        description: description.trim() || null,
        probability,
        impact,
        response,
        mitigationPlan: mitigationPlan.trim() || null,
      }),
    onSuccess: onCreated,
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (title.trim()) createMut.mutate();
  }

  return (
    <Modal title={t('risk.new')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="text-text-muted">{t('risk.form.title')}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">{t('risk.form.description')}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="block text-sm flex-1 min-w-[6rem]">
            <span className="text-text-muted">{t('risk.form.probability')}</span>
            <select
              value={probability}
              onChange={(e) => setProbability(Number(e.target.value))}
              className="mt-1 w-full rounded border border-border bg-surface px-2 py-2 text-sm"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm flex-1 min-w-[6rem]">
            <span className="text-text-muted">{t('risk.form.impact')}</span>
            <select
              value={impact}
              onChange={(e) => setImpact(Number(e.target.value))}
              className="mt-1 w-full rounded border border-border bg-surface px-2 py-2 text-sm"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm flex-1 min-w-[8rem]">
            <span className="text-text-muted">{t('risk.form.response')}</span>
            <select
              value={response}
              onChange={(e) => setResponse(e.target.value as riskApi.RiskResponseStrategy)}
              className="mt-1 w-full rounded border border-border bg-surface px-2 py-2 text-sm"
            >
              {RESPONSES.map((rp) => (
                <option key={rp} value={rp}>
                  {t(`risk.response.${rp}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-text-muted">
          {t('risk.form.scorePreview').replace('{score}', String(probability * impact))}
        </p>
        <label className="block text-sm">
          <span className="text-text-muted">{t('risk.form.mitigation')}</span>
          <textarea
            value={mitigationPlan}
            onChange={(e) => setMitigationPlan(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        {createMut.isError && <p className="text-sm text-rose-600">{t('risk.createError')}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-2 text-sm text-text-muted hover:bg-bg-elevated"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!title.trim() || createMut.isPending}
            className="rounded bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('risk.form.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Th({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <th className="px-3 py-2 text-start font-medium uppercase tracking-wide text-[11px]">
      {children}
    </th>
  );
}
