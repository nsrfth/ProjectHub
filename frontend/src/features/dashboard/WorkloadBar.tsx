import type { WorkloadRow } from '@/features/reports/api';

// v1.25: per-person workload bars. Top assignees by open-task count, each
// row a horizontal stacked bar split by status. Reuses /reports/workload —
// no new endpoint.
//
// Sort: total desc. Cap at 6 rows + a "+N more" summary line so the
// widget stays roughly card-height on smaller dashboards.

interface Props {
  rows: WorkloadRow[];
}

const COLORS = {
  TODO: '#94a3b8', // slate-400
  IN_PROGRESS: '#3b82f6', // blue-500
  REVIEW: '#f59e0b', // amber-500
};

const MAX_ROWS = 6;

export default function WorkloadBar({ rows }: Props): JSX.Element {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const top = sorted.slice(0, MAX_ROWS);
  const rest = sorted.slice(MAX_ROWS);
  const restTotal = rest.reduce((s, r) => s + r.total, 0);

  // Scale: longest bar fills the row. Avoid divide-by-zero with a 1-floor.
  const max = Math.max(1, ...sorted.map((r) => r.total));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-[10px] text-slate-500 dark:text-slate-400">
        <Legend color={COLORS.TODO} label="To do" />
        <Legend color={COLORS.IN_PROGRESS} label="In progress" />
        <Legend color={COLORS.REVIEW} label="Review" />
      </div>

      {top.length === 0 && (
        <p className="text-sm text-slate-500 italic">No open work right now.</p>
      )}

      <ul className="space-y-1.5">
        {top.map((r) => (
          <li key={r.assigneeId ?? '__u__'} className="text-xs">
            <div className="flex items-baseline justify-between mb-0.5">
              <span className="truncate text-slate-700 dark:text-slate-300">
                {r.assigneeName ?? <span className="italic text-slate-500">unassigned</span>}
              </span>
              <span className="tabular-nums text-slate-500 dark:text-slate-400">
                {r.total}
              </span>
            </div>
            <div
              className="flex h-2 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-700"
              style={{ width: `${Math.max(8, (r.total / max) * 100)}%` }}
              title={`To do ${r.byStatus.TODO} · In progress ${r.byStatus.IN_PROGRESS} · Review ${r.byStatus.REVIEW}`}
            >
              <Segment value={r.byStatus.TODO} total={r.total} color={COLORS.TODO} />
              <Segment value={r.byStatus.IN_PROGRESS} total={r.total} color={COLORS.IN_PROGRESS} />
              <Segment value={r.byStatus.REVIEW} total={r.total} color={COLORS.REVIEW} />
            </div>
          </li>
        ))}
      </ul>

      {restTotal > 0 && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500">
          + {restTotal} open task{restTotal === 1 ? '' : 's'} across {rest.length} other
          assignee{rest.length === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-block w-2 h-2 rounded-sm"
        style={{ background: color }}
        aria-hidden
      />
      {label}
    </span>
  );
}

function Segment({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  color: string;
}): JSX.Element | null {
  if (value <= 0 || total <= 0) return null;
  return <span style={{ background: color, flex: value }} />;
}
