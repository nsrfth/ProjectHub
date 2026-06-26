import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import Modal from '@/features/ui/Modal';
import * as api from './api';
import type { ResourceType, BudgetCurrency } from './api';

interface Props {
  teamId: string;
  canManage: boolean;
}

const TYPE_LABELS: Record<ResourceType, string> = {
  HUMAN: 'resources.type.HUMAN',
  EQUIPMENT: 'resources.type.EQUIPMENT',
  MATERIAL: 'resources.type.MATERIAL',
};

interface CreateForm {
  name: string;
  type: ResourceType;
  maxUnits: string;
  costRateMinor: string;
  currency: BudgetCurrency;
  notes: string;
}
const emptyForm = (): CreateForm => ({ name: '', type: 'HUMAN', maxUnits: '1', costRateMinor: '', currency: 'IRR', notes: '' });

export function ResourceCatalog({ teamId, canManage }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: resources = [], isLoading } = useQuery({
    queryKey: ['resources', teamId],
    queryFn: () => api.listResources(teamId),
  });

  const { data: workload = [] } = useQuery({
    queryKey: ['resources', teamId, 'workload'],
    queryFn: () => api.getWorkload(teamId),
  });

  const inv = (): Promise<void> => qc.invalidateQueries({ queryKey: ['resources', teamId] });

  const createMut = useMutation({
    mutationFn: (f: CreateForm) =>
      api.createResource(teamId, {
        name: f.name.trim(),
        type: f.type,
        maxUnits: parseFloat(f.maxUnits) || 1,
        costRateMinor: f.costRateMinor ? Math.round(parseFloat(f.costRateMinor)) : null,
        currency: f.costRateMinor ? f.currency : null,
        notes: f.notes.trim() || null,
      }),
    onSuccess: () => { setShowCreate(false); setForm(emptyForm()); void inv(); },
    onError: () => setCreateError(t('resources.createError')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteResource(teamId, id),
    onSuccess: inv,
  });

  if (isLoading) return <p className="text-sm text-text-muted">{t('common.loading')}</p>;

  const workloadMap = new Map(workload.map((w) => [w.resourceId, w]));

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">{t('resources.catalog.title')}</h3>
          {canManage && (
            <button
              onClick={() => { setShowCreate(true); setCreateError(null); }}
              className="text-sm px-3 py-1.5 rounded bg-primary text-primary-contrast"
            >
              {t('resources.new')}
            </button>
          )}
        </div>

        {resources.length === 0 ? (
          <p className="text-sm text-text-muted">{t('resources.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-border">
                  <th className="py-2 pr-3">{t('resources.col.name')}</th>
                  <th className="py-2 pr-3">{t('resources.col.type')}</th>
                  <th className="py-2 pr-3">{t('resources.col.maxUnits')}</th>
                  <th className="py-2 pr-3">{t('resources.workload.planned')}</th>
                  <th className="py-2 pr-3">{t('resources.workload.actual')}</th>
                  {canManage && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {resources.map((r) => {
                  const wl = workloadMap.get(r.id);
                  return (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3">{r.name}</td>
                      <td className="py-2 pr-3 text-xs">{t(TYPE_LABELS[r.type] as never)}</td>
                      <td className="py-2 pr-3 text-xs">{r.maxUnits}</td>
                      <td className="py-2 pr-3 text-xs">{wl ? `${wl.totalPlannedHours}h` : '—'}</td>
                      <td className="py-2 pr-3 text-xs">{wl ? `${wl.totalActualHours}h` : '—'}</td>
                      {canManage && (
                        <td className="py-2 text-right">
                          <button
                            onClick={() => { if (window.confirm(t('resources.deleteConfirm'))) deleteMut.mutate(r.id); }}
                            className="text-xs text-danger hover:underline"
                          >
                            {t('resources.delete')}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <Modal title={t('resources.new')} onClose={() => setShowCreate(false)}>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); createMut.mutate(form); }}
          >
            {createError && <p className="text-sm text-danger">{createError}</p>}
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('resources.form.name')}</span>
              <input
                required maxLength={200}
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                className="rounded border px-2 py-1.5 dark:bg-slate-700"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('resources.form.type')}</span>
              <select
                value={form.type}
                onChange={(e) => setForm((p) => ({ ...p, type: e.target.value as ResourceType }))}
                className="rounded border px-2 py-1.5 dark:bg-slate-700"
              >
                {(['HUMAN', 'EQUIPMENT', 'MATERIAL'] as ResourceType[]).map((t2) => (
                  <option key={t2} value={t2}>{t(TYPE_LABELS[t2] as never)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('resources.form.maxUnits')}</span>
              <input
                type="number" min="0.01" max="99" step="0.01"
                value={form.maxUnits}
                onChange={(e) => setForm((p) => ({ ...p, maxUnits: e.target.value }))}
                className="rounded border px-2 py-1.5 dark:bg-slate-700"
                dir="ltr"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-sm">
                <span>{t('resources.form.costRate')}</span>
                <input
                  type="number" min="0"
                  value={form.costRateMinor}
                  onChange={(e) => setForm((p) => ({ ...p, costRateMinor: e.target.value }))}
                  className="rounded border px-2 py-1.5 dark:bg-slate-700"
                  dir="ltr"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>{t('resources.form.currency')}</span>
                <select
                  value={form.currency}
                  onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value as BudgetCurrency }))}
                  className="rounded border px-2 py-1.5 dark:bg-slate-700"
                >
                  <option value="IRR">IRR</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('resources.form.notes')}</span>
              <textarea
                rows={2} maxLength={2000}
                value={form.notes}
                onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                className="rounded border px-2 py-1.5 dark:bg-slate-700 resize-y"
              />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-sm rounded border">
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={createMut.isPending || !form.name.trim()}
                className="px-3 py-1.5 text-sm rounded bg-primary text-primary-contrast disabled:opacity-50"
              >
                {t('resources.form.create')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
