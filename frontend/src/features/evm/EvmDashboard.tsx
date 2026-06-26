import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { useT } from '@/lib/i18n';
import { isModuleDisabled, ModuleDisabledBanner } from '@/features/ui/ModuleDisabledBanner';
import * as api from './api';
import type { EacMethod } from './api';

interface Props {
  teamId: string;
  projectId: string;
  canManage: boolean;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}
function indexClass(v: number): string {
  if (v >= 1) return 'text-emerald-600 dark:text-emerald-400';
  if (v >= 0.9) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

export function EvmDashboard({ teamId, projectId, canManage }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [eacMethod, setEacMethod] = useState<EacMethod>('CPI_BASED');
  const [snapshotMsg, setSnapshotMsg] = useState<string | null>(null);

  const metricsQ = useQuery({
    queryKey: ['evm', teamId, projectId, 'metrics', eacMethod],
    queryFn: () => api.getEvmMetrics(teamId, projectId, { eacMethod }),
    retry: false,
  });

  const seriesQ = useQuery({
    queryKey: ['evm', teamId, projectId, 'series'],
    queryFn: () => api.getEvmSeries(teamId, projectId, 'month'),
    retry: false,
  });

  const snapshotMut = useMutation({
    mutationFn: () => api.saveEvmSnapshot(teamId, projectId, { eacMethod }),
    onSuccess: () => {
      setSnapshotMsg(t('evm.snapshotSuccess'));
      void qc.invalidateQueries({ queryKey: ['evm', teamId, projectId] });
      setTimeout(() => setSnapshotMsg(null), 3000);
    },
  });

  const m = metricsQ.data;

  if (metricsQ.isError && isModuleDisabled(metricsQ.error)) return <ModuleDisabledBanner />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-semibold">{t('evm.title')}</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span>{t('evm.method')}</span>
            <select
              value={eacMethod}
              onChange={(e) => setEacMethod(e.target.value as EacMethod)}
              className="rounded border px-2 py-1 text-sm dark:bg-slate-700"
            >
              {(['CPI_BASED', 'SPI_BASED', 'TCPI_BASED'] as EacMethod[]).map((m2) => (
                <option key={m2} value={m2}>{t(`evm.method.${m2}` as never)}</option>
              ))}
            </select>
          </label>
          {canManage && (
            <button
              onClick={() => snapshotMut.mutate()}
              disabled={snapshotMut.isPending}
              className="text-sm px-3 py-1.5 rounded bg-primary text-primary-contrast disabled:opacity-50"
            >
              {t('evm.snapshot')}
            </button>
          )}
          {snapshotMsg && <span className="text-xs text-emerald-600">{snapshotMsg}</span>}
        </div>
      </div>

      {metricsQ.isError ? (
        <p className="text-sm text-text-muted">{t('evm.noData')}</p>
      ) : !m ? (
        <p className="text-sm text-text-muted">{t('common.loading')}</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { key: 'bac', value: fmt(m.bac) },
            { key: 'pv', value: fmt(m.pv) },
            { key: 'ev', value: fmt(m.ev) },
            { key: 'ac', value: fmt(m.ac) },
            { key: 'cv', value: fmt(m.cv), colored: true, raw: m.cv },
            { key: 'sv', value: fmt(m.sv), colored: true, raw: m.sv },
            { key: 'cpi', value: m.cpi.toFixed(3), index: true, raw: m.cpi },
            { key: 'spi', value: m.spi.toFixed(3), index: true, raw: m.spi },
            { key: 'eac', value: fmt(m.eac) },
            { key: 'vac', value: fmt(m.vac), colored: true, raw: m.vac },
            { key: 'tcpi', value: m.tcpi.toFixed(3), index: true, raw: m.tcpi },
          ].map(({ key, value, colored, index, raw }) => (
            <div key={key} className="rounded border border-border p-3 bg-surface">
              <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                {t(`evm.metric.${key}` as never)}
              </div>
              <div
                className={`text-lg font-semibold font-mono ${
                  index && raw != null ? indexClass(raw) :
                  colored && raw != null ? (raw >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400') :
                  ''
                }`}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
      )}

      {(seriesQ.data?.length ?? 0) > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-3">{t('evm.series.title')}</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={seriesQ.data}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} />
              <Tooltip formatter={(v: number) => fmt(v)} />
              <Legend />
              <Line type="monotone" dataKey="pv" stroke="#94a3b8" dot={false} name={t('evm.metric.pv' as never)} />
              <Line type="monotone" dataKey="ev" stroke="#22c55e" dot={false} name={t('evm.metric.ev' as never)} />
              <Line type="monotone" dataKey="ac" stroke="#ef4444" dot={false} name={t('evm.metric.ac' as never)} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
