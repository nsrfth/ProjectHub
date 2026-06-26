import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as recApi from './api';
import Modal from '@/features/ui/Modal';
import { useT } from '@/lib/i18n';

interface RecordsRegisterProps {
  teamId: string;
  projectId: string;
  canManage: boolean;
}

export function RecordsRegister({
  teamId,
  projectId,
  canManage,
}: RecordsRegisterProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [typeKey, setTypeKey] = useState('');
  const [creating, setCreating] = useState(false);

  const { data: types = [] } = useQuery({
    queryKey: ['record-types', teamId],
    queryFn: () => recApi.listRecordTypes(teamId),
    enabled: !!teamId,
  });

  const { data: records = [], isLoading } = useQuery({
    queryKey: ['records', teamId, projectId, typeKey],
    queryFn: () => recApi.listRecords(teamId, projectId, typeKey ? { typeKey } : {}),
    enabled: !!teamId && !!projectId,
  });

  // Map a record's type → its status workflow, so each row's status dropdown
  // only offers that type's statuses.
  const statusByTypeId = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const tp of types) m.set(tp.id, tp.statusSet);
    return m;
  }, [types]);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['records', teamId, projectId] });
  };

  const transitionMut = useMutation({
    mutationFn: ({ id, toStatus }: { id: string; toStatus: string }) =>
      recApi.transitionRecord(teamId, projectId, id, toStatus),
    onSuccess: invalidate,
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => recApi.deleteRecord(teamId, projectId, id),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={typeKey}
          onChange={(e) => setTypeKey(e.target.value)}
          className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
        >
          <option value="">{t('records.allTypes')}</option>
          {types.map((tp) => (
            <option key={tp.id} value={tp.key}>
              {tp.name}
            </option>
          ))}
        </select>
        {canManage && types.length > 0 && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="ms-auto rounded-md bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            {t('records.new')}
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : records.length === 0 ? (
        <p className="text-sm text-slate-500 italic">{t('records.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-text-muted">
              <tr>
                <Th>{t('records.col.reference')}</Th>
                <Th>{t('records.col.type')}</Th>
                <Th>{t('records.col.title')}</Th>
                <Th>{t('records.col.status')}</Th>
                <Th>{t('records.col.assignee')}</Th>
                {canManage && <Th>{''}</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {records.map((rec) => {
                const statuses = statusByTypeId.get(rec.recordTypeId) ?? [rec.status];
                return (
                  <tr key={rec.id} className="hover:bg-bg-elevated">
                    <td className="px-3 py-2 font-mono" dir="ltr">
                      {rec.reference}
                    </td>
                    <td className="px-3 py-2">{rec.recordTypeName}</td>
                    <td className="px-3 py-2 max-w-[20rem] truncate" title={rec.title}>
                      {rec.title}
                    </td>
                    <td className="px-3 py-2">
                      {canManage ? (
                        <select
                          value={rec.status}
                          disabled={transitionMut.isPending}
                          onChange={(e) =>
                            transitionMut.mutate({ id: rec.id, toStatus: e.target.value })
                          }
                          className="rounded border border-border bg-surface px-1.5 py-1 text-xs disabled:opacity-50"
                        >
                          {statuses.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-[11px] rounded-full px-2 py-0.5 bg-bg-elevated">
                          {rec.status}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 truncate">{rec.assigneeName ?? '—'}</td>
                    {canManage && (
                      <td className="px-3 py-2 text-end whitespace-nowrap">
                        <button
                          type="button"
                          disabled={deleteMut.isPending}
                          onClick={() => {
                            if (window.confirm(t('records.deleteConfirm'))) deleteMut.mutate(rec.id);
                          }}
                          className="text-xs text-rose-600 hover:underline disabled:opacity-50"
                        >
                          {t('records.delete')}
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

      {creating && (
        <RecordCreateModal
          teamId={teamId}
          projectId={projectId}
          types={types}
          initialTypeKey={typeKey}
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

interface RecordCreateModalProps {
  teamId: string;
  projectId: string;
  types: recApi.RecordType[];
  initialTypeKey: string;
  onClose: () => void;
  onCreated: () => void;
}

function RecordCreateModal({
  teamId,
  projectId,
  types,
  initialTypeKey,
  onClose,
  onCreated,
}: RecordCreateModalProps): JSX.Element {
  const t = useT();
  const initial = types.find((tp) => tp.key === initialTypeKey) ?? types[0];
  const [typeId, setTypeId] = useState(initial?.id ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const selectedType = types.find((tp) => tp.id === typeId) ?? initial;

  const createMut = useMutation({
    mutationFn: () =>
      recApi.createRecord(teamId, projectId, {
        recordTypeId: typeId,
        title: title.trim(),
        description: description.trim() || null,
      }),
    onSuccess: onCreated,
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (title.trim() && typeId) createMut.mutate();
  }

  return (
    <Modal title={t('records.new')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="text-text-muted">{t('records.form.type')}</span>
          <select
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-surface px-2 py-2 text-sm"
          >
            {types.map((tp) => (
              <option key={tp.id} value={tp.id}>
                {tp.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">{t('records.form.title')}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">{t('records.form.description')}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        {selectedType && (
          <p className="text-xs text-text-muted">
            {t('records.form.initialStatus').replace('{status}', selectedType.statusSet[0] ?? '—')}
          </p>
        )}
        {createMut.isError && <p className="text-sm text-rose-600">{t('records.createError')}</p>}
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
            disabled={!title.trim() || !typeId || createMut.isPending}
            className="rounded bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('records.form.create')}
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
