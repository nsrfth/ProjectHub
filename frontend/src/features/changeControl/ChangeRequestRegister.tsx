import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import Modal from '@/features/ui/Modal';
import * as api from './api';
import type { CRStatus, BudgetCurrency } from './api';

interface Props {
  teamId: string;
  projectId: string;
  canManage: boolean;
}

const STATUS_CLASSES: Record<CRStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  SUBMITTED: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  APPROVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  REJECTED: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100',
  APPLIED: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-100',
};

interface CreateForm {
  title: string;
  description: string;
  scheduleDeltaDays: string;
  costImpact: string;
  costCurrency: BudgetCurrency;
}
const emptyForm = (): CreateForm => ({
  title: '', description: '', scheduleDeltaDays: '', costImpact: '', costCurrency: 'IRR',
});

interface DecideForm {
  decision: 'APPROVED' | 'REJECTED';
  rejectionReason: string;
}

export function ChangeRequestRegister({ teamId, projectId, canManage }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);

  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decideForm, setDecideForm] = useState<DecideForm>({ decision: 'APPROVED', rejectionReason: '' });
  const [decideError, setDecideError] = useState<string | null>(null);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['changeRequests', teamId, projectId],
    queryFn: () => api.listChangeRequests(teamId, projectId),
  });

  const invalidate = (): Promise<void> =>
    qc.invalidateQueries({ queryKey: ['changeRequests', teamId, projectId] });

  const createMut = useMutation({
    mutationFn: (f: CreateForm) =>
      api.createChangeRequest(teamId, projectId, {
        title: f.title.trim(),
        description: f.description.trim() || null,
        scheduleDeltaDays: f.scheduleDeltaDays ? parseInt(f.scheduleDeltaDays, 10) : null,
        costImpactMinor: f.costImpact ? Math.round(parseFloat(f.costImpact)) : null,
        costCurrency: f.costImpact ? f.costCurrency : null,
      }),
    onSuccess: () => { setShowCreate(false); setForm(emptyForm()); void invalidate(); },
    onError: () => setCreateError(t('changeControl.createError')),
  });

  const submitMut = useMutation({
    mutationFn: (id: string) => api.submitChangeRequest(teamId, projectId, id),
    onSuccess: () => void invalidate(),
  });

  const decideMut = useMutation({
    mutationFn: ({ id, f }: { id: string; f: DecideForm }) =>
      api.decideChangeRequest(teamId, projectId, id, {
        decision: f.decision,
        rejectionReason: f.rejectionReason.trim() || null,
      }),
    onSuccess: () => { setDecidingId(null); void invalidate(); },
    onError: () => setDecideError(t('changeControl.decideError')),
  });

  const applyMut = useMutation({
    mutationFn: (id: string) => api.applyChangeRequest(teamId, projectId, id),
    onSuccess: () => void invalidate(),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteChangeRequest(teamId, projectId, id),
    onSuccess: () => void invalidate(),
  });

  if (isLoading) return <p className="text-sm text-text-muted">{t('common.loading')}</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">{t('changeControl.title')}</h2>
        {canManage && (
          <button
            onClick={() => { setShowCreate(true); setCreateError(null); }}
            className="text-sm px-3 py-1.5 rounded bg-primary text-primary-contrast"
          >
            {t('changeControl.new')}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-text-muted">{t('changeControl.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-border">
                <th className="py-2 pr-3">{t('changeControl.col.reference')}</th>
                <th className="py-2 pr-3">{t('changeControl.col.title')}</th>
                <th className="py-2 pr-3">{t('changeControl.col.status')}</th>
                <th className="py-2 pr-3">{t('changeControl.col.scheduleDelta')}</th>
                <th className="py-2 pr-3">{t('changeControl.col.costImpact')}</th>
                {canManage && <th className="py-2" />}
              </tr>
            </thead>
            <tbody>
              {items.map((cr) => (
                <tr key={cr.id} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs">{cr.reference}</td>
                  <td className="py-2 pr-3 max-w-xs truncate">{cr.title}</td>
                  <td className="py-2 pr-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_CLASSES[cr.status]}`}>
                      {t(`changeControl.status.${cr.status}` as never)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {cr.scheduleDeltaDays != null ? `${cr.scheduleDeltaDays > 0 ? '+' : ''}${cr.scheduleDeltaDays}d` : '—'}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {cr.costImpactMinor != null ? `${cr.costImpactMinor} ${cr.costCurrency ?? ''}` : '—'}
                  </td>
                  {canManage && (
                    <td className="py-2 text-right">
                      <span className="flex items-center justify-end gap-2">
                        {cr.status === 'DRAFT' && (
                          <button
                            onClick={() => submitMut.mutate(cr.id)}
                            disabled={submitMut.isPending}
                            className="text-xs text-primary hover:underline"
                          >
                            {t('changeControl.submit')}
                          </button>
                        )}
                        {cr.status === 'SUBMITTED' && (
                          <button
                            onClick={() => { setDecidingId(cr.id); setDecideForm({ decision: 'APPROVED', rejectionReason: '' }); setDecideError(null); }}
                            className="text-xs text-primary hover:underline"
                          >
                            {t('changeControl.decide')}
                          </button>
                        )}
                        {cr.status === 'APPROVED' && (
                          <button
                            onClick={() => { if (window.confirm(t('changeControl.applyConfirm'))) applyMut.mutate(cr.id); }}
                            disabled={applyMut.isPending}
                            className="text-xs text-indigo-600 hover:underline"
                          >
                            {t('changeControl.apply')}
                          </button>
                        )}
                        {(cr.status === 'DRAFT' || cr.status === 'REJECTED') && (
                          <button
                            onClick={() => { if (window.confirm(t('changeControl.deleteConfirm'))) deleteMut.mutate(cr.id); }}
                            disabled={deleteMut.isPending}
                            className="text-xs text-danger hover:underline"
                          >
                            {t('changeControl.delete')}
                          </button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <Modal title={t('changeControl.new')} onClose={() => setShowCreate(false)}>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); createMut.mutate(form); }}
          >
            {createError && <p className="text-sm text-danger">{createError}</p>}
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('changeControl.form.title')}</span>
              <input
                required maxLength={500}
                value={form.title}
                onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                className="rounded border px-2 py-1.5 dark:bg-slate-700"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('changeControl.form.description')}</span>
              <textarea
                rows={3} maxLength={5000}
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                className="rounded border px-2 py-1.5 dark:bg-slate-700 resize-y"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('changeControl.form.scheduleDelta')}</span>
              <input
                type="number"
                value={form.scheduleDeltaDays}
                onChange={(e) => setForm((p) => ({ ...p, scheduleDeltaDays: e.target.value }))}
                className="rounded border px-2 py-1.5 dark:bg-slate-700"
                dir="ltr"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-sm">
                <span>{t('changeControl.form.costImpact')}</span>
                <input
                  type="number" min="0"
                  value={form.costImpact}
                  onChange={(e) => setForm((p) => ({ ...p, costImpact: e.target.value }))}
                  className="rounded border px-2 py-1.5 dark:bg-slate-700"
                  dir="ltr"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>{t('changeControl.form.currency')}</span>
                <select
                  value={form.costCurrency}
                  onChange={(e) => setForm((p) => ({ ...p, costCurrency: e.target.value as BudgetCurrency }))}
                  className="rounded border px-2 py-1.5 dark:bg-slate-700"
                >
                  <option value="IRR">IRR</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-sm rounded border">
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={createMut.isPending || !form.title.trim()}
                className="px-3 py-1.5 text-sm rounded bg-primary text-primary-contrast disabled:opacity-50"
              >
                {t('changeControl.form.create')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Decide modal */}
      {decidingId && (
        <Modal title={t('changeControl.decide')} onClose={() => setDecidingId(null)}>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); decideMut.mutate({ id: decidingId, f: decideForm }); }}
          >
            {decideError && <p className="text-sm text-danger">{decideError}</p>}
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio" name="decision" value="APPROVED"
                  checked={decideForm.decision === 'APPROVED'}
                  onChange={() => setDecideForm((p) => ({ ...p, decision: 'APPROVED' }))}
                />
                {t('changeControl.approve')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio" name="decision" value="REJECTED"
                  checked={decideForm.decision === 'REJECTED'}
                  onChange={() => setDecideForm((p) => ({ ...p, decision: 'REJECTED' }))}
                />
                {t('changeControl.reject')}
              </label>
            </div>
            {decideForm.decision === 'REJECTED' && (
              <label className="flex flex-col gap-1 text-sm">
                <span>{t('changeControl.rejectReason')}</span>
                <textarea
                  rows={2}
                  value={decideForm.rejectionReason}
                  onChange={(e) => setDecideForm((p) => ({ ...p, rejectionReason: e.target.value }))}
                  className="rounded border px-2 py-1.5 dark:bg-slate-700 resize-y"
                />
              </label>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setDecidingId(null)} className="px-3 py-1.5 text-sm rounded border">
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={decideMut.isPending}
                className="px-3 py-1.5 text-sm rounded bg-primary text-primary-contrast disabled:opacity-50"
              >
                {t('changeControl.decide')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
