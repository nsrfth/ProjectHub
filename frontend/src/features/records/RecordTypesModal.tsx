import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '@/features/ui/Modal';
import { useT } from '@/lib/i18n';
import * as recApi from './api';

interface RecordTypesModalProps {
  teamId: string;
  onClose: () => void;
}

// v1.90 (PMIS R8 GUI completion): manage custom record types. Built-in types
// (teamId === null) are read-only; only CUSTOM types can be deleted. Transition
// graphs are metadata (the service enforces only status-set membership), so the
// create form collects a status set and nothing more.
export function RecordTypesModal({ teamId, onClose }: RecordTypesModalProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [statusesCsv, setStatusesCsv] = useState('OPEN, CLOSED');
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: types = [], isLoading } = useQuery({
    queryKey: ['record-types', teamId],
    queryFn: () => recApi.listRecordTypes(teamId),
    enabled: !!teamId,
  });

  const invalidate = (): Promise<void> =>
    qc.invalidateQueries({ queryKey: ['record-types', teamId] });

  const createMut = useMutation({
    mutationFn: () => {
      const statusSet = statusesCsv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return recApi.createRecordType(teamId, { key: key.trim(), name: name.trim(), statusSet });
    },
    onSuccess: () => {
      setName('');
      setKey('');
      setStatusesCsv('OPEN, CLOSED');
      setCreateError(null);
      void invalidate();
    },
    onError: () => setCreateError(t('records.types.createError')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => recApi.deleteRecordType(teamId, id),
    onSuccess: invalidate,
  });

  const statusCount = statusesCsv.split(',').map((s) => s.trim()).filter(Boolean).length;

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (name.trim() && key.trim() && statusCount > 0) createMut.mutate();
  }

  return (
    <Modal title={t('records.types.title')} onClose={onClose}>
      <div className="space-y-5">
        {isLoading ? (
          <p className="text-sm text-text-muted">{t('common.loading')}</p>
        ) : (
          <ul className="divide-y divide-border rounded border border-border">
            {types.map((tp) => (
              <li key={tp.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{tp.name}</span>
                    <span className="font-mono text-[11px] text-text-muted" dir="ltr">
                      {tp.key}
                    </span>
                    <span
                      className={`text-[10px] uppercase rounded-full px-1.5 py-0.5 ${
                        tp.kind === 'BUILTIN'
                          ? 'bg-bg-elevated text-text-muted'
                          : 'bg-primary/10 text-primary'
                      }`}
                    >
                      {tp.kind === 'BUILTIN' ? t('records.types.builtin') : t('records.types.custom')}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-text-muted" dir="ltr">
                    {tp.statusSet.join(' → ')}
                  </p>
                </div>
                {tp.kind === 'CUSTOM' && (
                  <button
                    type="button"
                    disabled={deleteMut.isPending}
                    onClick={() => {
                      if (window.confirm(t('records.types.deleteConfirm'))) deleteMut.mutate(tp.id);
                    }}
                    className="shrink-0 text-xs text-rose-600 hover:underline disabled:opacity-50"
                  >
                    {t('common.delete')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {deleteMut.isError && (
          <p className="text-sm text-rose-600">{t('records.types.deleteError')}</p>
        )}

        <form onSubmit={submit} className="space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">{t('records.types.newTitle')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="text-text-muted">{t('records.types.name')}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
                className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="text-text-muted">{t('records.types.key')}</span>
              <input
                value={key}
                onChange={(e) => setKey(e.target.value.toLowerCase())}
                required
                maxLength={50}
                dir="ltr"
                placeholder="risk_log"
                className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm font-mono"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-text-muted">{t('records.types.statuses')}</span>
            <input
              value={statusesCsv}
              onChange={(e) => setStatusesCsv(e.target.value)}
              dir="ltr"
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-text-muted">
              {t('records.types.statusesHint')}
            </span>
          </label>
          {createError && <p className="text-sm text-rose-600">{createError}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!name.trim() || !key.trim() || statusCount === 0 || createMut.isPending}
              className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
            >
              {t('records.types.create')}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
