import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import * as api from './api';

interface Props {
  teamId: string;
  projectId: string;
  taskId: string;
  canManage: boolean;
}

// v1.90 (PMIS R6 GUI completion): per-task resource assignments. Create/list are
// task-scoped; units/planned/actual hours are editable inline (PATCH on blur).
// These rows feed the team workload report on the Resources page.
export function TaskResourceAssignments({ teamId, projectId, taskId, canManage }: Props): JSX.Element | null {
  const t = useT();
  const qc = useQueryClient();
  const [resourceId, setResourceId] = useState('');
  const [units, setUnits] = useState('1');
  const [planned, setPlanned] = useState('');

  const { data: assignments = [], isError } = useQuery({
    queryKey: ['assignments', teamId, projectId, taskId],
    queryFn: () => api.listAssignments(teamId, projectId, taskId),
    enabled: !!taskId,
    retry: false,
  });

  const { data: resources = [] } = useQuery({
    queryKey: ['resources', teamId],
    queryFn: () => api.listResources(teamId),
    enabled: canManage && !!teamId,
  });

  const invalidate = (): Promise<void> =>
    qc.invalidateQueries({ queryKey: ['assignments', teamId, projectId, taskId] });

  const createMut = useMutation({
    mutationFn: () =>
      api.createAssignment(teamId, projectId, taskId, {
        resourceId,
        units: parseFloat(units) || 1,
        plannedHours: planned ? parseFloat(planned) : null,
      }),
    onSuccess: () => { setResourceId(''); setUnits('1'); setPlanned(''); void invalidate(); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { units?: number; plannedHours?: number | null; actualHours?: number | null } }) =>
      api.updateAssignment(teamId, id, patch),
    onSuccess: invalidate,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteAssignment(teamId, id),
    onSuccess: invalidate,
  });

  // The assignment routes aren't module-gated, but if project access fails we
  // simply render nothing rather than an error block.
  if (isError) return null;

  const unassigned = resources.filter((r) => !assignments.some((a) => a.resourceId === r.id));

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (resourceId) createMut.mutate();
  }

  function numOnBlur(id: string, field: 'units' | 'plannedHours' | 'actualHours', value: string): void {
    const n = value === '' ? null : parseFloat(value);
    if (field === 'units') {
      if (n != null && n > 0) updateMut.mutate({ id, patch: { units: n } });
    } else {
      updateMut.mutate({ id, patch: { [field]: n } as { plannedHours?: number | null; actualHours?: number | null } });
    }
  }

  return (
    <section className="rounded border border-border p-3">
      <h3 className="mb-2 text-sm font-semibold">{t('resources.assign.title')}</h3>

      {assignments.length === 0 ? (
        <p className="text-sm text-text-muted">{t('resources.assign.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-border">
                <th className="py-1 pr-3">{t('resources.assign.resource')}</th>
                <th className="py-1 pr-3">{t('resources.assign.units')}</th>
                <th className="py-1 pr-3">{t('resources.assign.planned')}</th>
                <th className="py-1 pr-3">{t('resources.assign.actual')}</th>
                {canManage && <th className="py-1" />}
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className="py-1 pr-3">{a.resourceName}</td>
                  <td className="py-1 pr-3">
                    <NumCell value={a.units} disabled={!canManage} onCommit={(v) => numOnBlur(a.id, 'units', v)} />
                  </td>
                  <td className="py-1 pr-3">
                    <NumCell value={a.plannedHours} disabled={!canManage} onCommit={(v) => numOnBlur(a.id, 'plannedHours', v)} />
                  </td>
                  <td className="py-1 pr-3">
                    <NumCell value={a.actualHours} disabled={!canManage} onCommit={(v) => numOnBlur(a.id, 'actualHours', v)} />
                  </td>
                  {canManage && (
                    <td className="py-1 text-right">
                      <button
                        onClick={() => { if (window.confirm(t('resources.assign.removeConfirm'))) deleteMut.mutate(a.id); }}
                        className="text-xs text-danger hover:underline"
                      >
                        {t('resources.assign.remove')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(updateMut.isError || deleteMut.isError || createMut.isError) && (
        <p className="mt-2 text-sm text-rose-600">{t('resources.assign.error')}</p>
      )}

      {canManage && (
        resources.length === 0 ? (
          <p className="mt-3 text-xs text-text-muted">{t('resources.assign.noResources')}</p>
        ) : (
          <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs text-text-muted">
              {t('resources.assign.resource')}
              <select
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
                className="ms-1 rounded border border-border bg-surface px-2 py-1 text-sm"
              >
                <option value="">—</option>
                {unassigned.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-text-muted">
              {t('resources.assign.units')}
              <input
                type="number" min="0.01" max="99" step="0.01" dir="ltr"
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                className="ms-1 w-20 rounded border border-border bg-surface px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-text-muted">
              {t('resources.assign.planned')}
              <input
                type="number" min="0" step="0.5" dir="ltr"
                value={planned}
                onChange={(e) => setPlanned(e.target.value)}
                className="ms-1 w-20 rounded border border-border bg-surface px-2 py-1 text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={!resourceId || createMut.isPending}
              className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
            >
              {t('resources.assign.add')}
            </button>
          </form>
        )
      )}
    </section>
  );
}

function NumCell({
  value,
  disabled,
  onCommit,
}: {
  value: number | null;
  disabled: boolean;
  onCommit: (v: string) => void;
}): JSX.Element {
  const [v, setV] = useState(value != null ? String(value) : '');
  if (disabled) return <span className="text-xs">{value ?? '—'}</span>;
  return (
    <input
      type="number" min="0" step="0.5" dir="ltr"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (value != null ? String(value) : '')) onCommit(v); }}
      className="w-20 rounded border border-border bg-surface px-2 py-1 text-xs"
    />
  );
}
