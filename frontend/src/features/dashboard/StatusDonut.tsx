// v1.25: pure-SVG donut chart of task status. Reads `byStatus` from the
// existing /reports/summary endpoint. No chart library — the math fits
// in ~30 lines.
//
// Slice colours match the kanban column accents to keep the visual
// vocabulary consistent across the app.

const COLORS: Record<string, string> = {
  TODO: '#94a3b8', // slate-400
  IN_PROGRESS: '#3b82f6', // blue-500
  REVIEW: '#f59e0b', // amber-500
  DONE: '#10b981', // emerald-500
};

const LABEL: Record<string, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Review',
  DONE: 'Done',
};

interface Props {
  byStatus: { TODO: number; IN_PROGRESS: number; REVIEW: number; DONE: number };
}

// Helper: convert a slice (startAngle, endAngle in radians) into the SVG
// path commands for that arc. Centre at (0,0); inner radius r1, outer r2.
function arcPath(r1: number, r2: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0o = Math.cos(a0) * r2;
  const y0o = Math.sin(a0) * r2;
  const x1o = Math.cos(a1) * r2;
  const y1o = Math.sin(a1) * r2;
  const x0i = Math.cos(a1) * r1;
  const y0i = Math.sin(a1) * r1;
  const x1i = Math.cos(a0) * r1;
  const y1i = Math.sin(a0) * r1;
  return [
    `M ${x0o} ${y0o}`,
    `A ${r2} ${r2} 0 ${large} 1 ${x1o} ${y1o}`,
    `L ${x0i} ${y0i}`,
    `A ${r1} ${r1} 0 ${large} 0 ${x1i} ${y1i}`,
    'Z',
  ].join(' ');
}

export default function StatusDonut({ byStatus }: Props): JSX.Element {
  const order = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const;
  const total = order.reduce((sum, k) => sum + byStatus[k], 0);

  // Open / Done split for the centre label — the most common question is
  // "how much is still open?", not "how much is done?".
  const open = byStatus.TODO + byStatus.IN_PROGRESS + byStatus.REVIEW;

  // Compute slice angles. Start at 12 o'clock (-PI/2), sweep clockwise.
  let a = -Math.PI / 2;
  const slices = order.map((k) => {
    const frac = total === 0 ? 0 : byStatus[k] / total;
    const a0 = a;
    const a1 = a + frac * Math.PI * 2;
    a = a1;
    return { key: k, a0, a1, value: byStatus[k] };
  });

  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const r2 = 78;
  const r1 = 50;

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label="Task status breakdown">
        <g transform={`translate(${cx} ${cy})`}>
          {total === 0 ? (
            // Hollow ring when there's nothing to display, so the widget
            // still has visual weight.
            <circle r={(r1 + r2) / 2} fill="none" stroke="currentColor" strokeWidth={r2 - r1} className="text-slate-200 dark:text-slate-700" />
          ) : (
            slices
              .filter((s) => s.value > 0)
              .map((s) => (
                <path key={s.key} d={arcPath(r1, r2, s.a0, s.a1)} fill={COLORS[s.key]} />
              ))
          )}
          <text
            textAnchor="middle"
            dy="-0.2em"
            className="fill-slate-900 dark:fill-slate-100 text-2xl font-semibold"
          >
            {open}
          </text>
          <text
            textAnchor="middle"
            dy="1.2em"
            className="fill-slate-500 dark:fill-slate-400 text-[10px] uppercase tracking-wide"
          >
            Open
          </text>
        </g>
      </svg>
      <ul className="text-xs space-y-1">
        {order.map((k) => (
          <li key={k} className="flex items-center gap-2">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ background: COLORS[k] }}
              aria-hidden
            />
            <span className="text-slate-700 dark:text-slate-300 min-w-[5.5rem]">{LABEL[k]}</span>
            <span className="tabular-nums text-slate-500 dark:text-slate-400">
              {byStatus[k]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
