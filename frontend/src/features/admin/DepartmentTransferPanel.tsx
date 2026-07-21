import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import * as adminApi from '@/features/admin/api';
import { useT } from '@/lib/i18n';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

// v2.19: Settings → Admin tool to move a project between departments. A
// project's "department" is its GROUP-subject access grant to a UNIT group; the
// backend creates the target grant and revokes the prior one (tenancy unchanged).
export default function DepartmentTransferPanel(): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState('');
  const [toGroupId, setToGroupId] = useState('');
  const [done, setDone] = useState<adminApi.TransferDepartmentResult | null>(null);

  const projectsQ = useQuery({
    queryKey: ['admin', 'project-departments'],
    queryFn: adminApi.listProjectDepartments,
  });
  const deptsQ = useQuery({
    queryKey: ['admin', 'departments'],
    queryFn: adminApi.listDepartments,
  });

  const selected = useMemo(
    () => projectsQ.data?.find((p) => p.projectId === projectId) ?? null,
    [projectsQ.data, projectId],
  );

  const transferMut = useMutation({
    mutationFn: () => adminApi.transferProjectDepartment(projectId, toGroupId),
    onSuccess: (res) => {
      setDone(res);
      setToGroupId('');
      void qc.invalidateQueries({ queryKey: ['admin', 'project-departments'] });
    },
  });

  const currentDeptId = selected?.department?.id ?? null;
  const canSubmit = !!projectId && !!toGroupId && toGroupId !== currentDeptId && !transferMut.isPending;

  return (
    <section className="bg-surface rounded shadow p-4 mb-6">
      <h2 className="font-medium mb-1">{t('admin.transfer.title')}</h2>
      <p className="text-sm text-slate-500 mb-3">{t('admin.transfer.subtitle')}</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setDone(null);
          transferMut.mutate();
        }}
        className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">{t('admin.transfer.project')}</span>
          <select
            required
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setToGroupId('');
              setDone(null);
            }}
            className="rounded border border-border bg-surface text-text px-2 py-1 text-sm"
          >
            <option value="">{t('admin.transfer.selectProject')}</option>
            {(projectsQ.data ?? []).map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.teamName} / {p.projectName}
                {` — ${p.department?.name ?? t('admin.transfer.none')}`}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">{t('admin.transfer.currentDept')}</span>
          <input
            readOnly
            value={selected ? selected.department?.name ?? t('admin.transfer.none') : ''}
            className="rounded border border-border bg-elevated text-text px-2 py-1 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">{t('admin.transfer.targetDept')}</span>
          <select
            required
            value={toGroupId}
            onChange={(e) => setToGroupId(e.target.value)}
            className="rounded border border-border bg-surface text-text px-2 py-1 text-sm"
          >
            <option value="">{t('admin.transfer.selectDept')}</option>
            {(deptsQ.data ?? [])
              .filter((d) => d.id !== currentDeptId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.teamName} / {d.name} ({d.memberCount})
                </option>
              ))}
          </select>
        </label>

        <div className="md:col-span-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {transferMut.isPending ? t('admin.transfer.transferring') : t('admin.transfer.transfer')}
          </button>
        </div>
      </form>

      {done && (
        <p className="mt-3 text-sm text-emerald-600">
          {t('admin.transfer.done')
            .replace('{project}', done.projectName)
            .replace('{from}', done.from?.name ?? t('admin.transfer.none'))
            .replace('{to}', done.to.name)}
        </p>
      )}
      {transferMut.isError && (
        <p className="mt-3 text-sm text-red-600">
          {errorMessage(transferMut.error, t('admin.transfer.error'))}
        </p>
      )}
    </section>
  );
}
