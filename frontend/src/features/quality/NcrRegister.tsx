import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import Modal from '@/features/ui/Modal';
import { isModuleDisabled, ModuleDisabledBanner } from '@/features/ui/ModuleDisabledBanner';
import * as api from './api';
import type { NcrSeverity, NcrDisposition } from './api';

interface Props {
  teamId: string;
  projectId: string;
  canManage: boolean;
}

const SEVERITY_CLASSES: Record<NcrSeverity, string> = {
  MINOR: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-100',
  MAJOR: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100',
  CRITICAL: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100',
};

interface CreateForm { title: string; description: string; severity: NcrSeverity; }
const emptyForm = (): CreateForm => ({ title: '', description: '', severity: 'MINOR' });

export function NcrRegister({ teamId, projectId, canManage }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: items = [], isLoading, isError, error } = useQuery({
    queryKey: ['ncrs', teamId, projectId],
    queryFn: () => api.listNcrs(teamId, projectId),
    retry: false,
  });

  const inv = (): Promise<void> => qc.invalidateQueries({ queryKey: ['ncrs', teamId, projectId] });

  const createMut = useMutation({
    mutationFn: (f: CreateForm) =>
      api.createNcr(teamId, projectId, {
        title: f.title.trim(),
        description: f.description.trim() || null,
        severity: f.severity,
      }),
    onSuccess: () => { setShowCreate(false); setForm(emptyForm()); void inv(); },
    onError: () => setCreateError(t('ncr.createError')),
  });

  const closeMut = useMutation({
    mutationFn: (id: string) => api.closeNcr(teamId, projectId, id),
    onSuccess: inv,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteNcr(teamId, projectId, id),
    onSuccess: inv,
  });

  const setDispositionMut = useMutation({
    mutationFn: ({ id, disposition }: { id: string; disposition: NcrDisposition }) =>
      api.updateNcr(teamId, projectId, id, { disposition }),
    onSuccess: inv,
  });

  if (isLoading) return <p className="text-sm text-text-muted">{t('common.loading')}</p>;
  if (isError) return isModuleDisabled(error) ? <ModuleDisabledBanner /> : <></>;

  const DISPOSITIONS: NcrDisposition[] = ['USE_AS_IS', 'REWORK', 'REJECT', 'CONCESSION'];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">{t('ncr.title')}</h2>
        {canManage && (
          <button
            onClick={() => { setShowCreate(true); setCreateError(null); }}
            className="text-sm px-3 py-1.5 rounded bg-primary text-primary-contrast"
          >
            {t('ncr.new')}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-text-muted">{t('ncr.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-border">
                <th className="py-2 pr-3">{t('ncr.col.reference')}</th>
                <th className="py-2 pr-3">{t('ncr.col.title')}</th>
                <th className="py-2 pr-3">{t('ncr.col.severity')}</th>
                <th className="py-2 pr-3">{t('ncr.col.disposition')}</th>
                <th className="py-2 pr-3">{t('ncr.col.status')}</th>
                {canManage && <th className="py-2" />}
              </tr>
            </thead>
            <tbody>
              {items.map((ncr) => (
                <tr key={ncr.id} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs">{ncr.reference}</td>
                  <td className="py-2 pr-3 max-w-xs truncate">{ncr.title}</td>
                  <td className="py-2 pr-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${SEVERITY_CLASSES[ncr.severity]}`}>
                      {t(`ncr.severity.${ncr.severity}` as never)}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    {canManage && !ncr.closedAt ? (
                      <select
                        value={ncr.disposition ?? ''}
                        onChange={(e) => {
                          if (e.target.value) setDispositionMut.mutate({ id: ncr.id, disposition: e.target.value as NcrDisposition });
                        }}
                        className="text-xs rounded border px-1 py-0.5 dark:bg-slate-700"
                      >
                        <option value="">— {t('ncr.noDisposition')} —</option>
                        {DISPOSITIONS.map((d) => (
                          <option key={d} value={d}>{t(`ncr.disposition.${d}` as never)}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs">{ncr.disposition ? t(`ncr.disposition.${ncr.disposition}` as never) : '—'}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {ncr.closedAt ? t('ncr.status.closed') : t('ncr.status.open')}
                  </td>
                  {canManage && (
                    <td className="py-2 text-right">
                      <span className="flex items-center justify-end gap-2">
                        {!ncr.closedAt && (
                          <button
                            onClick={() => { if (window.confirm(t('ncr.closeConfirm'))) closeMut.mutate(ncr.id); }}
                            className="text-xs text-text-muted hover:underline"
                          >
                            {t('ncr.close')}
                          </button>
                        )}
                        <button
                          onClick={() => { if (window.confirm(t('ncr.deleteConfirm'))) deleteMut.mutate(ncr.id); }}
                          className="text-xs text-danger hover:underline"
                        >
                          {t('ncr.delete')}
                        </button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <Modal title={t('ncr.new')} onClose={() => setShowCreate(false)}>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); createMut.mutate(form); }}
          >
            {createError && <p className="text-sm text-danger">{createError}</p>}
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('ncr.form.title')}</span>
              <input
                required maxLength={500}
                value={form.title}
                onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                className="rounded border px-2 py-1.5 dark:bg-slate-700"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('ncr.form.description')}</span>
              <textarea
                rows={3} maxLength={5000}
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                className="rounded border px-2 py-1.5 dark:bg-slate-700 resize-y"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('ncr.form.severity')}</span>
              <select
                value={form.severity}
                onChange={(e) => setForm((p) => ({ ...p, severity: e.target.value as NcrSeverity }))}
                className="rounded border px-2 py-1.5 dark:bg-slate-700"
              >
                {(['MINOR', 'MAJOR', 'CRITICAL'] as NcrSeverity[]).map((s) => (
                  <option key={s} value={s}>{t(`ncr.severity.${s}` as never)}</option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-sm rounded border">
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={createMut.isPending || !form.title.trim()}
                className="px-3 py-1.5 text-sm rounded bg-primary text-primary-contrast disabled:opacity-50"
              >
                {t('ncr.form.create')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
